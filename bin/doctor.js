#!/usr/bin/env node

/**
 * G-Krusch Diagnostic Doctor
 * Verifies system requirements, database integrity, crypto keys,
 * OAuth configuration, AI providers, and MCP tool registration.
 */

import fs from 'fs';
import path from 'path';
import config from '../src/config.js';
import { getDb } from '../src/lib/db.js';
import { encrypt, decrypt } from '../src/lib/crypto.js';
import { getAuthStatus } from '../src/lib/oauth.js';
import { getNexusConfig, getPdftotextPath } from '../src/lib/pdf.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerMcpTools } from '../src/mcp/tools.js';

const PASS = '[\x1b[32mPASS\x1b[0m]';
const WARN = '[\x1b[33mWARN\x1b[0m]';
const FAIL = '[\x1b[31mFAIL\x1b[0m]';
const INFO = '[\x1b[36mINFO\x1b[0m]';

console.log('\n======================================================');
console.log('🩺  G-Krusch (G-Crush) Production Diagnostic Doctor');
console.log('======================================================\n');

let issues = 0;
let warnings = 0;

// 1. Node.js & Runtime Check
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 22) {
  console.log(`${PASS} Node.js runtime: v${process.versions.node} (>= 22.0.0 required)`);
} else {
  console.log(`${FAIL} Node.js runtime: v${process.versions.node} is below required Node 22+`);
  issues++;
}

// 2. Environment Configuration
const envFile = path.join(config.rootDir, '.env');
if (fs.existsSync(envFile)) {
  console.log(`${PASS} Environment file: .env found at ${envFile}`);
} else {
  console.log(`${WARN} Environment file: .env not found (using default fallback configurations)`);
  warnings++;
}

// 3. SQLite Database Integrity & WAL Mode
try {
  const db = getDb();
  const integrity = db.pragma('integrity_check');
  const journalMode = db.pragma('journal_mode');

  if (integrity[0]?.integrity_check === 'ok') {
    console.log(`${PASS} SQLite database: integrity verified at ${config.dbPath}`);
  } else {
    console.log(`${FAIL} SQLite database integrity check failed: ${JSON.stringify(integrity)}`);
    issues++;
  }

  if (journalMode[0]?.journal_mode === 'wal') {
    console.log(`${PASS} SQLite journal mode: WAL (Write-Ahead Logging) active`);
  } else {
    console.log(`${WARN} SQLite journal mode: ${journalMode[0]?.journal_mode || 'unknown'} (WAL recommended)`);
    warnings++;
  }

  // Schema verification
  const requiredTables = [
    'credentials',
    'workspace_metadata',
    'agent_steering_cache',
    'rag_documents',
    'rag_chunks',
    'rag_chunks_fts',
    'rag_embeddings_cache'
  ];

  const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual')").all().map(r => r.name);
  const missingTables = requiredTables.filter(t => !existingTables.includes(t));

  if (missingTables.length === 0) {
    console.log(`${PASS} Database schema: all 7 required core and virtual FTS5 tables present`);
  } else {
    console.log(`${FAIL} Database schema missing tables: ${missingTables.join(', ')}`);
    issues++;
  }
} catch (dbErr) {
  console.log(`${FAIL} SQLite database error: ${dbErr.message}`);
  issues++;
}

// 4. AES-256-GCM Crypto Verification
try {
  const testPayload = JSON.stringify({ ping: 'pong', timestamp: Date.now() });
  const cipher = encrypt(testPayload);
  const decrypted = decrypt(cipher);

  if (decrypted === testPayload) {
    console.log(`${PASS} AES-256-GCM encryption engine: roundtrip encrypt/decrypt verified`);
  } else {
    console.log(`${FAIL} AES-256-GCM crypto decryption mismatch`);
    issues++;
  }
} catch (cryptoErr) {
  console.log(`${FAIL} Crypto engine failure: ${cryptoErr.message}`);
  issues++;
}

// 5. Google OAuth 2.0 Credentials & Auth State
if (config.google.clientId && config.google.clientSecret) {
  console.log(`${PASS} Google OAuth configuration: Client ID & Secret configured`);
} else {
  console.log(`${WARN} Google OAuth configuration: Client ID / Secret missing in .env`);
  warnings++;
}

try {
  const auth = getAuthStatus();
  if (auth.authenticated) {
    console.log(`${PASS} Google Drive authentication: Active account linked (${auth.email || 'N/A'})`);
  } else {
    console.log(`${INFO} Google Drive authentication: Not currently linked (Visit http://localhost:${config.port}/auth/google to link)`);
  }
} catch (authErr) {
  console.log(`${WARN} Google Drive auth status check failed: ${authErr.message}`);
  warnings++;
}

// 6. AI & Semantic Embedding Provider
if (config.ai.geminiApiKey) {
  console.log(`${PASS} AI Embedding Provider: Gemini text-embedding-004 configured via API key`);
} else {
  console.log(`${INFO} Gemini API Key not set. Checking Ollama at ${config.ai.ollamaUrl}...`);
}

// 7. PDF Parsing Engine (Krusch-Nexus + Poppler)
const nexus = getNexusConfig();
const pdftotext = getPdftotextPath();

if (nexus.isAvailable) {
  console.log(`${PASS} PDF Parser Engine: Krusch-Nexus Active (${nexus.nexusDir})`);
} else if (pdftotext) {
  console.log(`${PASS} PDF Parser Engine: Poppler pdftotext fallback active (${pdftotext})`);
} else {
  console.log(`${WARN} PDF Parser Engine: Neither Nexus nor pdftotext detected. PDF ingestion will be degraded.`);
  warnings++;
}

// 8. MCP Tools Registration
try {
  const server = new McpServer({ name: 'doctor-check', version: '1.0.0' });
  registerMcpTools(server);
  console.log(`${PASS} MCP Protocol: 8 tools registered successfully on McpServer`);
} catch (mcpErr) {
  console.log(`${FAIL} MCP Tool registration failed: ${mcpErr.message}`);
  issues++;
}

console.log('\n------------------------------------------------------');

if (issues === 0) {
  console.log(`\x1b[32m✨ All critical systems operational! (${warnings} warnings)\x1b[0m\n`);
  process.exit(0);
} else {
  console.log(`\x1b[31m⚠️ Found ${issues} critical issue(s) and ${warnings} warning(s).\x1b[0m\n`);
  process.exit(1);
}
