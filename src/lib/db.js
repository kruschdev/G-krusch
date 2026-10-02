import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import config from '../config.js';

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
  `);

  dbInstance = db;
  return db;
}

export function saveCredentials(id, tokens, email = null) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO credentials (id, tokens, email, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      tokens = excluded.tokens,
      email = coalesce(excluded.email, credentials.email),
      updated_at = datetime('now')
  `);
  stmt.run(id, JSON.stringify(tokens), email);
}

export function getCredentials(id = 'google_oauth') {
  const db = getDb();
  const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    tokens: JSON.parse(row.tokens)
  };
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
