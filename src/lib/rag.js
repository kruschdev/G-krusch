import crypto from 'crypto';
import config from '../config.js';
import { getDb, searchFtsChunks, getCachedEmbedding, saveCachedEmbedding } from './db.js';
import { getDrive, getOrCreateWorkspaceFolder, readDriveFile } from './drive.js';
import { mutex } from './mutex.js';
import { withRetry } from './retry.js';

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
 * Generate vector embedding for a string with SQLite caching.
 */
export async function generateEmbedding(text) {
  const clean = text.replace(/\n+/g, ' ').slice(0, 2048);
  const textHash = crypto.createHash('sha256').update(clean).digest('hex');

  // Check persistent SQLite cache first
  const cached = getCachedEmbedding(textHash);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    return cached;
  }

  let embedding = null;

  // 1. Try Gemini text-embedding-004 if key is provided
  if (config.ai.geminiApiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${config.ai.geminiApiKey}`;
      const res = await withRetry(async () => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'models/text-embedding-004',
            content: { parts: [{ text: clean }] }
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
        if (data.embedding?.values) {
          embedding = data.embedding.values;
        }
      }
    } catch (e) {
      console.warn('[RAG] Gemini embedding fallback:', e.message);
    }
  }

  // 2. Try Ollama if configured and Gemini did not yield embedding
  if (!embedding && config.ai.ollamaUrl) {
    try {
      const res = await fetch(config.ai.ollamaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ai.ollamaModel,
          prompt: clean
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.embedding) embedding = data.embedding;
      }
    } catch {}
  }

  // 3. Fallback: Deterministic 64-dimensional feature vector
  if (!embedding) {
    embedding = createDeterministicVector(clean, 64);
  }

  // Cache generated embedding
  saveCachedEmbedding(textHash, embedding);
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
      q: `'${parentId}' in parents and trashed = false`,
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

    // Purge stale/deleted documents from SQLite
    const db = getDb();
    const existingDocs = db.prepare('SELECT file_id FROM rag_documents').all();
    let deletedCount = 0;
    const deleteDocStmt = db.prepare('DELETE FROM rag_documents WHERE file_id = ?');
    const deleteFtsStmt = db.prepare('DELETE FROM rag_chunks_fts WHERE file_id = ?');

    for (const doc of existingDocs) {
      if (!seenFileIds.has(doc.file_id)) {
        deleteDocStmt.run(doc.file_id);
        deleteFtsStmt.run(doc.file_id);
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

async function indexSingleFile(file, relativePath) {
  // Filter out binary / media files
  if (!isIndexableMimeType(file.mimeType)) {
    return { updated: false, chunks: 0 };
  }

  const db = getDb();
  const existing = db.prepare('SELECT modified_time FROM rag_documents WHERE file_id = ?').get(file.id);

  if (existing && existing.modified_time === file.modifiedTime) {
    const chunkCount = db.prepare('SELECT COUNT(*) as count FROM rag_chunks WHERE file_id = ?').get(file.id);
    return { updated: false, chunks: chunkCount?.count || 0 };
  }

  try {
    const { content, isBinary } = await readDriveFile(file.id);
    if (isBinary || !content || !content.trim()) {
      return { updated: false, chunks: 0 };
    }

    const chunks = chunkText(content);

    // Save document record
    db.prepare(`
      INSERT INTO rag_documents (file_id, name, mime_type, web_view_link, modified_time, synced_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(file_id) DO UPDATE SET
        name = excluded.name,
        mime_type = excluded.mime_type,
        web_view_link = excluded.web_view_link,
        modified_time = excluded.modified_time,
        synced_at = datetime('now')
    `).run(file.id, relativePath, file.mimeType, file.webViewLink || '', file.modifiedTime);

    // Clear old chunks and FTS5 entries
    db.prepare('DELETE FROM rag_chunks WHERE file_id = ?').run(file.id);
    db.prepare('DELETE FROM rag_chunks_fts WHERE file_id = ?').run(file.id);

    // Prepared statements for chunk + FTS5 insertion
    const insertChunkStmt = db.prepare(`
      INSERT INTO rag_chunks (file_id, chunk_index, content, embedding, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);

    const insertFtsStmt = db.prepare(`
      INSERT INTO rag_chunks_fts (content, file_id, chunk_index)
      VALUES (?, ?, ?)
    `);

    // Insert chunks with generated embeddings (uses SQLite cache)
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const emb = await generateEmbedding(chunk);
      insertChunkStmt.run(file.id, i, chunk, JSON.stringify(emb));
      insertFtsStmt.run(chunk, file.id, i);
    }

    return { updated: true, chunks: chunks.length };
  } catch (err) {
    console.error(`[RAG] Error indexing ${relativePath}:`, err.message);
    return { updated: false, chunks: 0 };
  }
}

/**
 * True Hybrid Search: Combines Dense Vector Similarity + SQLite FTS5 BM25 Keyword Search.
 * Ensures keyword matches always provide an additive boost.
 */
export async function searchDriveRag(query, { limit = 5, minScore = 0.15 } = {}) {
  const db = getDb();
  const queryEmbedding = await generateEmbedding(query);

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
      content: row.content,
      fileId: row.file_id,
      fileName: row.name,
      mimeType: row.mime_type,
      chunkIndex: row.chunk_index,
      webViewLink: row.web_view_link
    });
  }

  // 2. FTS5 BM25 keyword matching
  const ftsHits = searchFtsChunks(query, limit * 3);
  for (const hit of ftsHits) {
    const key = `${hit.file_id}:${hit.chunk_index}`;
    // BM25 rank is negative in SQLite, lower is better. Normalize to 0-1 scale
    const normBm25 = 1 / (1 + Math.abs(hit.rank));

    if (chunkMap.has(key)) {
      const item = chunkMap.get(key);
      item.bm25Score = normBm25;
    }
  }

  // 3. Compute uniform additive hybrid fusion: 70% vector + 30% BM25 keyword
  for (const item of chunkMap.values()) {
    const finalScore = (0.7 * Math.max(0, item.vectorScore)) + (0.3 * item.bm25Score);
    item.combinedScore = finalScore;
  }

  const results = Array.from(chunkMap.values())
    .filter(item => item.combinedScore >= minScore)
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit)
    .map(item => ({
      score: Math.round(item.combinedScore * 1000) / 1000,
      vectorScore: Math.round(item.vectorScore * 1000) / 1000,
      bm25Score: Math.round(item.bm25Score * 1000) / 1000,
      content: item.content,
      fileId: item.fileId,
      fileName: item.fileName,
      mimeType: item.mimeType,
      chunkIndex: item.chunkIndex,
      webViewLink: item.webViewLink
    }));

  return results;
}

