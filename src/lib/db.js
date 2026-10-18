import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import config from '../config.js';
import { encrypt, decrypt } from './crypto.js';

let dbInstance = null;

export function getDb() {
  if (dbInstance) return dbInstance;

  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      tokens TEXT NOT NULL,
      email TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspace_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_steering_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT NOT NULL,
      version_hash TEXT,
      drive_file_id TEXT,
      drive_modified_time TEXT,
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rag_documents (
      file_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime_type TEXT,
      web_view_link TEXT,
      modified_time TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(file_id) REFERENCES rag_documents(file_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_rag_chunks_file_id ON rag_chunks(file_id);

    -- FTS5 Full-Text Search Table for fast BM25 keyword matching
    CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
      content,
      file_id UNINDEXED,
      chunk_index UNINDEXED,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS rag_embeddings_cache (
      text_hash TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  ensureFtsSync(db);

  if (config.isTestRuntime && !process.env.GCRUSH_TEST_DB_PATH) {
    process.once('exit', () => {
      try { db.close(); } catch {}
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(`${config.dbPath}${suffix}`, { force: true }); } catch {}
      }
    });
  }

  dbInstance = db;
  return db;
}

/**
 * Self-heals the FTS5 virtual table if rag_chunks and rag_chunks_fts counts diverge.
 */
export function ensureFtsSync(db = getDb()) {
  try {
    const chunkCount = db.prepare('SELECT COUNT(*) as count FROM rag_chunks').get()?.count || 0;
    const ftsCount = db.prepare('SELECT COUNT(*) as count FROM rag_chunks_fts').get()?.count || 0;

    if (chunkCount > 0 && ftsCount !== chunkCount) {
      const rebuildTx = db.transaction(() => {
        db.prepare('DELETE FROM rag_chunks_fts').run();
        db.prepare(`
          INSERT INTO rag_chunks_fts (content, file_id, chunk_index)
          SELECT content, file_id, chunk_index FROM rag_chunks
        `).run();
      });
      rebuildTx();
      return { healed: true, restoredChunks: chunkCount };
    }
    return { healed: false, restoredChunks: 0 };
  } catch (err) {
    console.warn('[DB] FTS5 sync check warning:', err.message);
    return { healed: false, restoredChunks: 0 };
  }
}

export function saveCredentials(id, tokens, email = null) {
  const db = getDb();
  const serialized = JSON.stringify(tokens);
  const encrypted = encrypt(serialized);

  const stmt = db.prepare(`
    INSERT INTO credentials (id, tokens, email, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      tokens = excluded.tokens,
      email = coalesce(excluded.email, credentials.email),
      updated_at = datetime('now')
  `);
  stmt.run(id, encrypted, email);
}

export function getCredentials(id = 'google_oauth') {
  const db = getDb();
  const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
  if (!row) return null;

  try {
    const decrypted = decrypt(row.tokens);
    return {
      ...row,
      tokens: JSON.parse(decrypted)
    };
  } catch (err) {
    console.error('[DB] Failed to decrypt credentials:', err.message);
    return null;
  }
}

export function deleteCredentials(id = 'google_oauth') {
  const db = getDb();
  db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
}

export function setMetadata(key, value) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO workspace_metadata (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `);
  stmt.run(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
}

export function getMetadata(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM workspace_metadata WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Searches FTS5 index using BM25 ranking.
 */
export function searchFtsChunks(query, limit = 10) {
  const db = getDb();
  // Sanitize query for FTS5 (strip special syntax characters)
  const cleanQuery = query.replace(/[^\w\s]/g, ' ').trim();
  if (!cleanQuery) return [];

  // Match words with OR or phrase
  const terms = cleanQuery.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const ftsQuery = terms.map(t => `"${t}"`).join(' OR ');

  try {
    const stmt = db.prepare(`
      SELECT rowid, file_id, chunk_index, content, bm25(rag_chunks_fts) as rank
      FROM rag_chunks_fts
      WHERE rag_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(ftsQuery, limit);
  } catch (e) {
    console.warn('[FTS] Search error:', e.message);
    return [];
  }
}

export function getCachedEmbedding(textHash) {
  const db = getDb();
  const row = db.prepare('SELECT embedding FROM rag_embeddings_cache WHERE text_hash = ?').get(textHash);
  if (row) {
    try {
      return JSON.parse(row.embedding);
    } catch {
      return null;
    }
  }
  return null;
}

export function saveCachedEmbedding(textHash, embedding) {
  const db = getDb();
  const serialized = JSON.stringify(embedding);
  db.prepare(`
    INSERT INTO rag_embeddings_cache (text_hash, embedding, created_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(text_hash) DO NOTHING
  `).run(textHash, serialized);
}

let steeringCacheEpoch = 0;

export function getSteeringCacheEpoch() {
  return steeringCacheEpoch;
}

export function bumpSteeringCacheEpoch() {
  steeringCacheEpoch += 1;
  return steeringCacheEpoch;
}

/**
 * Atomically purges a deleted/trashed Drive file from rag_chunks, rag_chunks_fts,
 * rag_documents, and agent_steering_cache.
 */
export function purgeIndexedDocumentTransactional(fileId) {
  if (!fileId) return { deleted: false, steeringCleared: false };
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM rag_chunks WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM rag_chunks_fts WHERE file_id = ?').run(fileId);
    const docRes = db.prepare('DELETE FROM rag_documents WHERE file_id = ?').run(fileId);
    const steeringRes = db.prepare('DELETE FROM agent_steering_cache WHERE drive_file_id = ?').run(fileId);
    if (steeringRes.changes > 0) {
      bumpSteeringCacheEpoch();
    }
    return {
      deleted: docRes.changes > 0,
      steeringCleared: steeringRes.changes > 0
    };
  });
  return tx();
}

