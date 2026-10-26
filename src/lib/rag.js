import crypto from 'crypto';
import config from '../config.js';
import { getDb, searchFtsChunks, getCachedEmbedding, saveCachedEmbedding, purgeIndexedDocumentTransactional } from './db.js';
import { getDrive, getOrCreateWorkspaceFolder, readDriveFile } from './drive.js';
import { mutex } from './mutex.js';
import { withRetry } from './retry.js';
import { escapeDriveQueryLiteral } from './path-utils.js';

const MAX_CHUNKS_PER_DOC = 100;
const MAX_DOC_TEXT_LENGTH = 1024 * 1024; // 1MB text limit per file
const SUPPORTED_MIME_PATTERNS = [
  'text/',
  'application/json',
  'application/pdf',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/javascript',
  'application/typescript',
  'application/xml'
];

/**
 * Checks if a file's mime type is text/indexable.
 */
export function isIndexableMimeType(mimeType) {
  if (!mimeType) return false;
  return SUPPORTED_MIME_PATTERNS.some(pat => mimeType.startsWith(pat) || mimeType.includes(pat));
}

/**
 * Clean chunking of text into overlapping semantic blocks.
 */
export function chunkText(text, chunkSize = 800, overlap = 150) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) return [];

  const safeText = text.slice(0, MAX_DOC_TEXT_LENGTH);
  const chunks = [];
  const paragraphs = safeText.split(/\n\s*\n/);
  let currentChunk = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (currentChunk.length + trimmed.length <= chunkSize) {
      currentChunk += (currentChunk ? '\n\n' : '') + trimmed;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
        if (chunks.length >= MAX_CHUNKS_PER_DOC) break;

        const words = currentChunk.split(/\s+/);
        const overlapWords = words.slice(-Math.floor(overlap / 6)).join(' ');
        currentChunk = overlapWords + '\n\n' + trimmed;
      } else {
        const words = trimmed.split(/\s+/);
        let temp = '';
        for (const w of words) {
          if (temp.length + w.length + 1 > chunkSize) {
            chunks.push(temp);
            if (chunks.length >= MAX_CHUNKS_PER_DOC) break;
            temp = w;
          } else {
            temp += (temp ? ' ' : '') + w;
          }
        }
        if (temp && chunks.length < MAX_CHUNKS_PER_DOC) currentChunk = temp;
      }
    }
  }

  if (currentChunk.trim() && chunks.length < MAX_CHUNKS_PER_DOC) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Normalize an Ollama host or legacy `/api/embeddings` URL to `/api/embed`.
 * Preserves `/api/embed` when already present.
 */
export function resolveOllamaEmbedUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.endsWith('/api/embeddings')) {
    return `${trimmed.slice(0, -'/api/embeddings'.length)}/api/embed`;
  }
  if (trimmed.endsWith('/api/embed')) {
    return trimmed;
  }
  return `${trimmed}/api/embed`;
}

function resolveOllamaLegacyEmbedUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.endsWith('/api/embeddings')) {
    return trimmed;
  }
  if (trimmed.endsWith('/api/embed')) {
    return `${trimmed.slice(0, -'/api/embed'.length)}/api/embeddings`;
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.pathname || parsed.pathname === '/') {
      return `${trimmed}/api/embeddings`;
    }
  } catch {
    // Non-standard URL string; fall back to raw trimmed URL
  }
  return trimmed;
}

const CROSS_ENCODER_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where',
  'which', 'who', 'whom', 'whose', 'why', 'how', 'are', 'was', 'were', 'been',
  'being', 'have', 'has', 'had', 'having', 'does', 'did', 'doing', 'will',
  'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'into',
  'onto', 'upon', 'about', 'above', 'below', 'under', 'over', 'again', 'further',
  'then', 'once', 'here', 'there', 'all', 'any', 'both', 'each', 'few', 'more',
  'most', 'other', 'some', 'such', 'only', 'own', 'same', 'than', 'too', 'very',
  'just', 'but', 'not', 'nor', 'our', 'your', 'their', 'his', 'her', 'its'
]);

/**
 * Formats input text with asymmetric query or document prefixes per model family,
 * matching @krusch/toolkit/embeddings without adding cross-repo runtime dependencies.
 */
export function formatEmbeddingPayloadText(cleanText, modelName = 'snowflake-arctic-embed2:latest', mode = 'document', options = {}) {
  const raw = cleanText == null ? '' : String(cleanText);
  if (!raw) return '';

  const normalizedModel = String(modelName || 'snowflake-arctic-embed2:latest')
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/:latest$/, '');

  if (mode !== 'query') {
    if (normalizedModel.startsWith('nomic-embed-text') && options?.prefixDocuments === true) {
      return `search_document: ${raw}`;
    }
    return raw;
  }

  if (normalizedModel.startsWith('snowflake-arctic-embed2') || normalizedModel.includes('arctic-embed2')) {
    return `query: ${raw}`;
  }
  if (normalizedModel.startsWith('bge-') || normalizedModel.includes('/bge-')) {
    return `Represent this sentence for searching relevant passages: ${raw}`;
  }
  if (normalizedModel.startsWith('nomic-embed-text')) {
    return `search_query: ${raw}`;
  }
  if (normalizedModel.startsWith('qwen3-embedding')) {
    const task = typeof options?.instruction === 'string' && options.instruction.trim()
      ? options.instruction.trim()
      : 'Given a search query, retrieve relevant passages that answer the query';
    return `Instruct: ${task}\nQuery:${raw}`;
  }
  return raw;
}

/**
 * Generate vector embedding for a string with SQLite caching.
 * Prioritizes local GPU Ollama (snowflake-arctic-embed2:latest, 1024-dim) via /api/embed with legacy 404 retry,
 * formats asymmetric query prefixes in query mode, isolates vector spaces so incompatible models never collide,
 * and prevents 64-dim offline fallback vectors from poisoning the persistent SQLite cache on transient errors.
 */
export async function generateEmbedding(text, options = {}) {
  const mode = options?.mode || 'document';
  const clean = String(text ?? '').replace(/\n+/g, ' ').slice(0, 2048);
  const useLiveProviders = !config.isTestRuntime || process.env.GCRUSH_TEST_LIVE_EMBEDDINGS === 'true';

  const ollamaModel = config.ai.ollamaModel || 'snowflake-arctic-embed2:latest';
  const baseSpaceId = !useLiveProviders
    ? 'offline:64'
    : config.ai.ollamaUrl
      ? `ollama:${ollamaModel}`
      : config.ai.geminiApiKey
        ? 'gemini:gemini-embedding-001:1024'
        : 'offline:64';
  const activeDims = (!useLiveProviders || (!config.ai.ollamaUrl && !config.ai.geminiApiKey)) ? 64 : 1024;
  const activeModel = !useLiveProviders
    ? 'deterministic'
    : config.ai.ollamaUrl
      ? ollamaModel
      : config.ai.geminiApiKey
        ? 'gemini-embedding-001'
        : 'deterministic';
  const spaceId = `${baseSpaceId}:model=${activeModel}:dim=${activeDims}:mode=${mode}`;
  const textHash = crypto.createHash('sha256').update(`${spaceId}::${clean}`).digest('hex');

  // Check persistent SQLite cache first (in production, bypass stale <256-dim fallback entries)
  const cached = getCachedEmbedding(textHash);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    if (!useLiveProviders || cached.length >= 256) {
      return cached;
    }
  }

  let embedding = null;
  let fromLiveProvider = false;
  let resolvedProvider = null;

  // 1. Try Sovereign Local GPU Ollama (snowflake-arctic-embed2:latest, 1024-dim) first via /api/embed
  if (useLiveProviders && config.ai.ollamaUrl) {
    try {
      const embedUrl = resolveOllamaEmbedUrl(config.ai.ollamaUrl);
      const ollamaPayloadText = formatEmbeddingPayloadText(clean, ollamaModel, mode, options);
      let res = await fetch(embedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          model: ollamaModel,
          input: ollamaPayloadText,
          prompt: ollamaPayloadText,
          truncate: true,
          keep_alive: -1,
          ...(String(ollamaModel).startsWith('qwen3-embedding') ? { dimensions: 1024 } : {})
        })
      });

      const legacyUrl = resolveOllamaLegacyEmbedUrl(config.ai.ollamaUrl);
      if (res.status === 404 && legacyUrl && legacyUrl !== embedUrl) {
        res = await fetch(legacyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({
            model: ollamaModel,
            prompt: ollamaPayloadText,
            truncate: true,
            keep_alive: -1
          })
        });
      }

      if (res.ok) {
        const data = await res.json();
        const vec = Array.isArray(data.embeddings?.[0]) ? data.embeddings[0] : data.embedding;
        if (Array.isArray(vec) && vec.length > 0) {
          embedding = vec;
          fromLiveProvider = true;
          resolvedProvider = 'ollama';
        }
      }
    } catch (err) {
      console.warn('[rag] Ollama embedding request failed, falling back:', err.message);
    }
  }

  // 2. Cloud Fallback: Gemini gemini-embedding-001 (configured to 1024-dim parity)
  // INV-05(2): Only allow cloud fallback when Ollama is unconfigured or explicitly permitted
  const allowCloudFallback = !config.ai.ollamaUrl || process.env.ALLOW_CLOUD_EMBED_FALLBACK === 'true';
  if (useLiveProviders && !embedding && config.ai.geminiApiKey && allowCloudFallback) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${config.ai.geminiApiKey}`;
      const res = await withRetry(async () => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            model: 'models/gemini-embedding-001',
            content: { parts: [{ text: clean }] },
            outputDimensionality: 1024
          })
        });
        if (!r.ok && r.status === 429) {
          const err = new Error('Gemini Rate Limit');
          err.status = 429;
          throw err;
        }
        return r;
      }, { maxRetries: 2, initialDelayMs: 500 });

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.embedding?.values) && data.embedding.values.length > 0) {
          embedding = data.embedding.values;
          fromLiveProvider = true;
          resolvedProvider = 'gemini';
        }
      }
    } catch (e) {
      console.warn('[RAG] Gemini embedding fallback:', e.message);
    }
  }

  // 3. Offline Fallback: Deterministic 64-dimensional feature vector
  if (!embedding) {
    embedding = createDeterministicVector(clean, 64);
  }

  // Only persist into SQLite cache if produced by a live provider or running in offline/test mode
  if (fromLiveProvider || !useLiveProviders || (!config.ai.ollamaUrl && !config.ai.geminiApiKey)) {
    const cacheHash = (resolvedProvider === 'gemini' && config.ai.ollamaUrl)
      ? crypto.createHash('sha256').update(`gemini:gemini-embedding-001:1024:model=gemini-embedding-001:dim=1024:mode=${mode}::${clean}`).digest('hex')
      : textHash;
    saveCachedEmbedding(cacheHash, embedding);
  }
  return embedding;
}

function createDeterministicVector(str, dims = 64) {
  const vec = new Array(dims).fill(0);
  const words = str.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    let hash = 0;
    for (let c = 0; c < word.length; c++) {
      hash = ((hash << 5) - hash + word.charCodeAt(c)) | 0;
    }
    const idx = Math.abs(hash) % dims;
    vec[idx] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Recursively list all files in a folder with pagination.
 */
async function listAllFolderFiles(drive, parentId) {
  const files = [];
  let pageToken = null;

  do {
    const res = await withRetry(() => drive.files.list({
      q: `'${escapeDriveQueryLiteral(parentId)}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, size)',
      pageSize: 100,
      pageToken: pageToken || undefined
    }));

    if (res.data.files) {
      files.push(...res.data.files);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

/**
 * Synchronize Google Drive workspace files into local vector & FTS5 store.
 * Fully recursive, paginated, and purges deleted/trashed files.
 */
export async function syncDriveRag() {
  return mutex.runExclusive('sync_rag', async () => {
    const drive = await getDrive();
    const rootId = await getOrCreateWorkspaceFolder();
    const seenFileIds = new Set();

    let updatedCount = 0;
    let skippedCount = 0;
    let totalChunks = 0;

    async function walkAndIndex(parentId, currentPath, depth = 0) {
      if (depth > 5) return;
      const files = await listAllFolderFiles(drive, parentId);

      for (const file of files) {
        const itemPath = currentPath ? `${currentPath}/${file.name}` : file.name;
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          await walkAndIndex(file.id, itemPath, depth + 1);
        } else {
          seenFileIds.add(file.id);
          const res = await indexSingleFile(file, itemPath);
          if (res.updated) updatedCount++;
          else skippedCount++;
          totalChunks += res.chunks;
        }
      }
    }

    await walkAndIndex(rootId, '');

    // Purge stale/deleted documents from SQLite inside an atomic transaction
    const db = getDb();
    const existingDocs = db.prepare('SELECT file_id FROM rag_documents').all();
    let deletedCount = 0;

    for (const doc of existingDocs) {
      if (!seenFileIds.has(doc.file_id)) {
        purgeIndexedDocumentTransactional(doc.file_id);
        deletedCount++;
      }
    }

    return {
      updatedFiles: updatedCount,
      skippedFiles: skippedCount,
      deletedFiles: deletedCount,
      totalChunks,
      syncedAt: new Date().toISOString()
    };
  });
}

/**
 * Atomically persists a document and all of its embedded chunks into rag_documents, rag_chunks, and rag_chunks_fts.
 */
export function saveIndexedDocumentTransactional({
  fileId,
  name,
  mimeType,
  webViewLink = '',
  modifiedTime,
  embeddedChunks
}) {
  const db = getDb();

  const upsertDocStmt = db.prepare(`
    INSERT INTO rag_documents (file_id, name, mime_type, web_view_link, modified_time, synced_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(file_id) DO UPDATE SET
      name = excluded.name,
      mime_type = excluded.mime_type,
      web_view_link = excluded.web_view_link,
      modified_time = excluded.modified_time,
      synced_at = datetime('now')
  `);

  const clearChunksStmt = db.prepare('DELETE FROM rag_chunks WHERE file_id = ?');
  const clearFtsStmt = db.prepare('DELETE FROM rag_chunks_fts WHERE file_id = ?');

  const insertChunkStmt = db.prepare(`
    INSERT INTO rag_chunks (file_id, chunk_index, content, embedding, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const insertFtsStmt = db.prepare(`
    INSERT INTO rag_chunks_fts (content, file_id, chunk_index)
    VALUES (?, ?, ?)
  `);

  const writeTx = db.transaction(() => {
    upsertDocStmt.run(fileId, name, mimeType, webViewLink, modifiedTime);
    clearChunksStmt.run(fileId);
    clearFtsStmt.run(fileId);

    for (let i = 0; i < embeddedChunks.length; i++) {
      const { chunk, embedding } = embeddedChunks[i];
      insertChunkStmt.run(fileId, i, chunk, JSON.stringify(embedding));
      insertFtsStmt.run(chunk, fileId, i);
    }
  });

  writeTx();
}

export async function indexSingleFile(file, relativePath) {
  // Filter out binary / media files
  if (!isIndexableMimeType(file.mimeType)) {
    return { updated: false, chunks: 0 };
  }

  const db = getDb();
  const existing = db.prepare('SELECT modified_time FROM rag_documents WHERE file_id = ?').get(file.id);

  if (existing && existing.modified_time === file.modifiedTime) {
    const chunkRows = db.prepare('SELECT embedding FROM rag_chunks WHERE file_id = ?').all(file.id);
    const useLiveProviders = !config.isTestRuntime || process.env.GCRUSH_TEST_LIVE_EMBEDDINGS === 'true';
    const hasLowDimChunks = useLiveProviders && chunkRows.some(row => {
      try {
        const parsed = JSON.parse(row.embedding || '[]');
        return !Array.isArray(parsed) || parsed.length < 256;
      } catch {
        return true;
      }
    });

    if (chunkRows.length > 0 && !hasLowDimChunks) {
      return { updated: false, chunks: chunkRows.length };
    }
  }

  try {
    const { content, isBinary, chunks: parsedChunks } = await readDriveFile(file.id, { enforceWorkspace: false });
    if (isBinary || !content || !content.trim()) {
      return { updated: false, chunks: 0 };
    }

    // Preserve page-faithful citations and chunks from Nexus/Poppler when available
    const chunks = (Array.isArray(parsedChunks) && parsedChunks.length > 0)
      ? parsedChunks.map(c => (c.citation ? `[${c.citation}]\n${c.text}` : c.text))
      : chunkText(content);

    // 1. Compute all embeddings BEFORE mutating the database
    const embeddedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await generateEmbedding(chunk);
      embeddedChunks.push({ chunk, embedding });
    }

    // 2. Atomically replace document, chunks, and FTS5 records in a single SQLite transaction
    saveIndexedDocumentTransactional({
      fileId: file.id,
      name: relativePath,
      mimeType: file.mimeType,
      webViewLink: file.webViewLink || '',
      modifiedTime: file.modifiedTime,
      embeddedChunks
    });

    return { updated: true, chunks: chunks.length };
  } catch (err) {
    console.error(`[RAG] Error indexing ${relativePath}:`, err.message);
    return { updated: false, chunks: 0 };
  }
}

/**
 * Deterministic Stage-2 cross-encoder relevance scorer for Drive chunks (arXiv:2610.30755 Table 34).
 * Combines content-word & identifier/number recall, stopword-filtered ordered bigram overlap,
 * multi-token exact phrase containment, and Stage-1 hybrid similarity.
 */
export function scoreDriveChunkCrossEncoder(query, content, fileName = '', firstStageScore = 0) {
  const qTokens = (String(query || '').toLowerCase().match(/[a-z0-9_]+/g) || [])
    .filter(tok => (tok.length >= 2 || /\d/.test(tok)) && !CROSS_ENCODER_STOPWORDS.has(tok));
  const clampedFirstStage = Math.max(0, Math.min(1, Number(firstStageScore) || 0));

  if (qTokens.length === 0) {
    return clampedFirstStage;
  }

  const docLower = `${String(fileName || '')} ${String(content || '')}`.toLowerCase();
  const docTokenList = docLower.match(/[a-z0-9_]+/g) || [];
  const docTokenSet = new Set(docTokenList);

  let weightedHits = 0;
  let totalWeight = 0;
  for (const tok of qTokens) {
    const isAnchor = /\d|_/.test(tok) || tok.length >= 7;
    const weight = isAnchor ? 1.8 : 1.0;
    totalWeight += weight;
    if (docTokenSet.has(tok)) {
      weightedHits += weight;
    }
  }
  const lexicalRecall = totalWeight > 0 ? weightedHits / totalWeight : 0;

  let bigramHits = 0;
  const totalBigrams = Math.max(0, qTokens.length - 1);
  if (totalBigrams > 0) {
    const docBigrams = new Set();
    const contentTokens = docTokenList.filter(tok => !CROSS_ENCODER_STOPWORDS.has(tok));
    for (let i = 0; i + 1 < contentTokens.length; i++) {
      docBigrams.add(`${contentTokens[i]}_${contentTokens[i + 1]}`);
    }
    for (let i = 0; i < totalBigrams; i++) {
      if (docBigrams.has(`${qTokens[i]}_${qTokens[i + 1]}`)) {
        bigramHits += 1;
      }
    }
  }
  const bigramScore = totalBigrams > 0 ? bigramHits / totalBigrams : 0;

  const normalizedDocWords = docTokenList.filter(tok => !CROSS_ENCODER_STOPWORDS.has(tok)).join(' ');
  const exactPhraseBonus = (qTokens.length >= 2 && normalizedDocWords.includes(qTokens.join(' '))) ? 1 : 0;

  const combined = (0.45 * lexicalRecall)
    + (0.20 * bigramScore)
    + (0.10 * exactPhraseBonus)
    + (0.25 * clampedFirstStage);
  return Number(Math.max(0, Math.min(1, combined)).toFixed(6));
}

/**
 * Two-Stage Hybrid Search (arXiv:2610.30755 Table 34):
 * Stage 1: Asymmetric Query Dense Vector Similarity + SQLite FTS5 BM25 Keyword Pool (Top-128).
 * Stage 2: Deterministic Cross-Encoder Reranking before slicing to final top-k limit.
 */
export async function searchDriveRag(
  query,
  { limit = 5, minScore = 0.15, candidatePoolSize = 128, rerank = true } = {}
) {
  const db = getDb();
  const safeLimit = Math.max(1, Number(limit) || 5);
  const safePoolSize = Math.max(safeLimit, Number(candidatePoolSize) || 128);
  const queryEmbedding = await generateEmbedding(query, { mode: 'query' });

  // 1. Vector similarity search across all chunks
  const chunks = db.prepare(`
    SELECT c.id, c.file_id, c.chunk_index, c.content, c.embedding, d.name, d.mime_type, d.web_view_link
    FROM rag_chunks c
    JOIN rag_documents d ON c.file_id = d.file_id
  `).all();

  const chunkMap = new Map();

  for (const row of chunks) {
    if (!row.embedding) continue;
    let emb;
    try {
      emb = JSON.parse(row.embedding);
    } catch {
      continue;
    }
    const vScore = cosineSimilarity(queryEmbedding, emb);
    const key = `${row.file_id}:${row.chunk_index}`;

    chunkMap.set(key, {
      vectorScore: vScore,
      bm25Score: 0,
      combinedScore: 0,
      rerankScore: 0,
      content: row.content,
      fileId: row.file_id,
      fileName: row.name,
      mimeType: row.mime_type,
      chunkIndex: row.chunk_index,
      webViewLink: row.web_view_link
    });
  }

  // 2. Wide FTS5 BM25 keyword matching across the Top-128 pool
  const ftsLimit = Math.max(safeLimit * 4, safePoolSize);
  const ftsHits = searchFtsChunks(query, ftsLimit);
  for (const hit of ftsHits) {
    const key = `${hit.file_id}:${hit.chunk_index}`;
    // BM25 rank is negative in SQLite, lower is better. Normalize to 0-1 scale
    const normBm25 = 1 / (1 + Math.abs(hit.rank));

    if (chunkMap.has(key)) {
      const item = chunkMap.get(key);
      item.bm25Score = normBm25;
    }
  }

  // 3. Stage-1 uniform additive hybrid fusion: 70% vector + 30% BM25 keyword,
  // with a BM25 floor so exact FTS5 keyword hits are never dropped if embeddings are offline or mixed-dimension.
  for (const item of chunkMap.values()) {
    const weightedScore = (0.7 * Math.max(0, item.vectorScore)) + (0.3 * item.bm25Score);
    const bm25Floor = item.bm25Score > 0 ? Math.max(minScore, item.bm25Score * 0.65) : 0;
    item.combinedScore = Math.max(weightedScore, bm25Floor);
  }

  const candidatePool = Array.from(chunkMap.values())
    .filter(item => item.combinedScore >= minScore)
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, safePoolSize);

  // 4. Stage-2 Cross-Encoder Reranking over the Top-128 candidate pool
  for (const item of candidatePool) {
    item.rerankScore = rerank === false
      ? item.combinedScore
      : scoreDriveChunkCrossEncoder(query, item.content, item.fileName, item.combinedScore);
  }

  if (rerank !== false) {
    candidatePool.sort((a, b) => {
      if (b.rerankScore !== a.rerankScore) return b.rerankScore - a.rerankScore;
      return b.combinedScore - a.combinedScore;
    });
  }

  const results = candidatePool
    .slice(0, safeLimit)
    .map(item => {
      const displayScore = rerank === false ? item.combinedScore : item.rerankScore;
      return {
        score: Math.round(displayScore * 1000) / 1000,
        rerankScore: Math.round(item.rerankScore * 1000) / 1000,
        firstStageScore: Math.round(item.combinedScore * 1000) / 1000,
        vectorScore: Math.round(item.vectorScore * 1000) / 1000,
        bm25Score: Math.round(item.bm25Score * 1000) / 1000,
        content: item.content,
        fileId: item.fileId,
        fileName: item.fileName,
        mimeType: item.mimeType,
        chunkIndex: item.chunkIndex,
        webViewLink: item.webViewLink
      };
    });

  return results;
}
