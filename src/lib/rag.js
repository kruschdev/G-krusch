import config from '../config.js';
import { getDb } from './db.js';
import { getDrive, getOrCreateWorkspaceFolder, readDriveFile } from './drive.js';

/**
 * Clean chunking of text into overlapping semantic blocks.
 */
export function chunkText(text, chunkSize = 800, overlap = 150) {
  if (!text || text.trim().length === 0) return [];

  const chunks = [];
  const paragraphs = text.split(/\n\s*\n/);
  let currentChunk = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (currentChunk.length + trimmed.length <= chunkSize) {
      currentChunk += (currentChunk ? '\n\n' : '') + trimmed;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
        // keep overlap from end of currentChunk
        const words = currentChunk.split(/\s+/);
        const overlapWords = words.slice(-Math.floor(overlap / 6)).join(' ');
        currentChunk = overlapWords + '\n\n' + trimmed;
      } else {
        // Paragraph itself exceeds chunkSize, break by words
        const words = trimmed.split(/\s+/);
        let temp = '';
        for (const w of words) {
          if (temp.length + w.length + 1 > chunkSize) {
            chunks.push(temp);
            temp = w;
          } else {
            temp += (temp ? ' ' : '') + w;
          }
        }
        if (temp) currentChunk = temp;
      }
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Generate vector embedding for a string.
 * Supports Gemini API, Ollama, and lightweight TF-IDF fallback.
 */
export async function generateEmbedding(text) {
  const clean = text.replace(/\n+/g, ' ').slice(0, 2048);

  // 1. Try Gemini text-embedding-004 if key is provided
  if (config.ai.geminiApiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${config.ai.geminiApiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: { parts: [{ text: clean }] }
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.embedding?.values) {
          return data.embedding.values;
        }
      }
    } catch (e) {
      console.warn('[RAG] Gemini embedding fallback:', e.message);
    }
  }

  // 2. Try Ollama if configured
  if (config.ai.ollamaUrl) {
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
        if (data.embedding) return data.embedding;
      }
    } catch {
      // Ollama not reachable, fall to deterministic fallback
    }
  }

  // 3. Fallback: Deterministic 64-dimensional feature vector
  return createDeterministicVector(clean, 64);
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
  // Normalize
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
 * Synchronize Google Drive workspace files into local vector store.
 */
export async function syncDriveRag() {
  const drive = await getDrive();
  const rootId = await getOrCreateWorkspaceFolder();
  const db = getDb();

  // Find all indexable documents in the workspace
  // Supported: Google Docs, Markdown, Plain Text, PDFs, Code, JSON
  const q = `'${rootId}' in parents and trashed = false`;
  const listRes = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)'
  });

  const files = listRes.data.files || [];
  let updatedCount = 0;
  let skippedCount = 0;
  let totalChunks = 0;

  for (const file of files) {
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      // Index subfolder contents (e.g. context, memory, output)
      const subRes = await drive.files.list({
        q: `'${file.id}' in parents and trashed = false`,
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink)'
      });
      for (const subFile of subRes.data.files || []) {
        const res = await indexSingleFile(subFile, `${file.name}/${subFile.name}`);
        if (res.updated) updatedCount++;
        else skippedCount++;
        totalChunks += res.chunks;
      }
    } else {
      const res = await indexSingleFile(file, file.name);
      if (res.updated) updatedCount++;
      else skippedCount++;
      totalChunks += res.chunks;
    }
  }

  return {
    updatedFiles: updatedCount,
    skippedFiles: skippedCount,
    totalChunks,
    syncedAt: new Date().toISOString()
  };
}

async function indexSingleFile(file, relativePath) {
  const db = getDb();
  const existing = db.prepare('SELECT modified_time FROM rag_documents WHERE file_id = ?').get(file.id);

  if (existing && existing.modified_time === file.modifiedTime) {
    const chunkCount = db.prepare('SELECT COUNT(*) as count FROM rag_chunks WHERE file_id = ?').get(file.id);
    return { updated: false, chunks: chunkCount?.count || 0 };
  }

  // File is new or updated
  try {
    const { content } = await readDriveFile(file.id);
    if (!content || !content.trim()) {
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

    // Clear old chunks
    db.prepare('DELETE FROM rag_chunks WHERE file_id = ?').run(file.id);

    // Insert new chunks with embeddings
    const insertChunkStmt = db.prepare(`
      INSERT INTO rag_chunks (file_id, chunk_index, content, embedding, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const emb = await generateEmbedding(chunk);
      insertChunkStmt.run(file.id, i, chunk, JSON.stringify(emb));
    }

    return { updated: true, chunks: chunks.length };
  } catch (err) {
    console.error(`[RAG] Error indexing ${relativePath}:`, err.message);
    return { updated: false, chunks: 0 };
  }
}

/**
 * Semantic vector + full-text search across the Google Drive workspace.
 */
export async function searchDriveRag(query, { limit = 5, minScore = 0.25 } = {}) {
  const db = getDb();
  const queryEmbedding = await generateEmbedding(query);

  const chunks = db.prepare(`
    SELECT c.id, c.file_id, c.chunk_index, c.content, c.embedding, d.name, d.mime_type, d.web_view_link
    FROM rag_chunks c
    JOIN rag_documents d ON c.file_id = d.file_id
  `).all();

  const scored = [];

  for (const row of chunks) {
    if (!row.embedding) continue;
    const emb = JSON.parse(row.embedding);
    const score = cosineSimilarity(queryEmbedding, emb);

    if (score >= minScore) {
      scored.push({
        score: Math.round(score * 1000) / 1000,
        content: row.content,
        fileId: row.file_id,
        fileName: row.name,
        mimeType: row.mime_type,
        chunkIndex: row.chunk_index,
        webViewLink: row.web_view_link
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
