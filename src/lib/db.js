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
  `);

  dbInstance = db;
  return db;
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
