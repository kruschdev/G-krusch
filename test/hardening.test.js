import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AsyncKeyedMutex } from '../src/lib/mutex.js';
import {
  sanitizeWorkspacePath,
  isValidFileName,
  isForbiddenSegment,
  escapeDriveQueryLiteral,
  isValidDriveId
} from '../src/lib/path-utils.js';
import { isBinaryMimeType, isFileInWorkspace } from '../src/lib/drive.js';
import {
  generateEmbedding,
  cosineSimilarity,
  saveIndexedDocumentTransactional,
  searchDriveRag
} from '../src/lib/rag.js';
import {
  getDb,
  getCachedEmbedding,
  saveCachedEmbedding,
  ensureFtsSync,
  purgeIndexedDocumentTransactional,
  getSteeringCacheEpoch,
  clearWorkspaceSessionState,
  saveCredentials,
  getCredentials,
  setMetadata,
  getMetadata
} from '../src/lib/db.js';
import { invalidateSteeringCache } from '../src/lib/steering.js';
import {
  parsePdfFile,
  parsePdfBuffer,
  sanitizePdfTempName,
  validatePdfMagicBytes,
  extractPdfTextNative
} from '../src/lib/pdf.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools, createMcpServer } from '../src/mcp/tools.js';
import { encodeRawEmail, validateEmailAddress, encodeMimeSubject, createCalendarEvent } from '../src/lib/extensions.js';
import {
  isTimingSafeMatch,
  isAllowedOrigin,
  requireAuthIfConfigured,
  securityHeadersMiddleware,
  createRateLimiter
} from '../src/lib/auth-guard.js';
import { generateOAuthState, verifyOAuthState, hasPendingOAuthState } from '../src/lib/oauth.js';
import { encrypt, decrypt } from '../src/lib/crypto.js';
import { escapeHtml } from '../src/routes/auth.js';
import { config } from '../src/config.js';

test('Hardening: FIFO Keyed Mutex executes 5 concurrent requests in exact arrival sequence', async () => {
  const m = new AsyncKeyedMutex();
  const executionOrder = [];

  const createTask = (id, delayMs) => {
    return m.runExclusive('fifo_resource', async () => {
      await new Promise(r => setTimeout(r, delayMs));
      executionOrder.push(id);
    });
  };

  const tasks = [
    createTask(1, 30),
    createTask(2, 20),
    createTask(3, 10),
    createTask(4, 15),
    createTask(5, 5)
  ];

  await Promise.all(tasks);
  assert.deepEqual(executionOrder, [1, 2, 3, 4, 5], 'Tasks must execute strictly in FIFO arrival sequence');
});

test('Hardening: FIFO Keyed Mutex handles independent keys concurrently', async () => {
  const m = new AsyncKeyedMutex();
  const completed = [];

  const p1 = m.runExclusive('key_A', async () => {
    await new Promise(r => setTimeout(r, 40));
    completed.push('A');
  });

  const p2 = m.runExclusive('key_B', async () => {
    await new Promise(r => setTimeout(r, 10));
    completed.push('B');
  });

  await Promise.all([p1, p2]);
  assert.deepEqual(completed, ['B', 'A'], 'Different keys must not block each other');
});

test('Hardening: FIFO Keyed Mutex timeout releases lock and does not deadlock next task', async () => {
  const m = new AsyncKeyedMutex(50); // 50ms default timeout
  let task2Executed = false;

  const p1 = m.runExclusive('timeout_key', async () => {
    await new Promise(r => setTimeout(r, 150)); // Exceeds 50ms timeout
  }, { timeoutMs: 30 });

  const p2 = m.runExclusive('timeout_key', async () => {
    task2Executed = true;
    return 'recovered';
  }, { timeoutMs: 500 });

  await assert.rejects(p1, /Mutex timeout/);
  const result2 = await p2;
  assert.equal(result2, 'recovered');
  assert.equal(task2Executed, true, 'Task 2 must execute after Task 1 times out');
});

test('Hardening: Path sanitization blocks sensitive file patterns and normalizes redundant dots', () => {
  // Safe normalization
  assert.equal(sanitizeWorkspacePath('./context/specs.md'), 'context/specs.md');
  assert.equal(sanitizeWorkspacePath('output/./analysis.md'), 'output/analysis.md');
  assert.equal(sanitizeWorkspacePath('context///nested//doc.md'), 'context/nested/doc.md');

  // Security blacklists
  assert.throws(() => sanitizeWorkspacePath('.env'), /strictly blocked/);
  assert.throws(() => sanitizeWorkspacePath('context/.env.production'), /strictly blocked/);
  assert.throws(() => sanitizeWorkspacePath('.git/config'), /strictly blocked/);
  assert.throws(() => sanitizeWorkspacePath('keys/server.pem'), /strictly blocked/);
  assert.throws(() => sanitizeWorkspacePath('.ssh/id_rsa'), /strictly blocked/);

  assert.equal(isForbiddenSegment('.env'), true);
  assert.equal(isForbiddenSegment('id_rsa'), true);
  assert.equal(isForbiddenSegment('cert.key'), true);
  assert.equal(isForbiddenSegment('specs.md'), false);

  assert.equal(isValidFileName('.env'), false);
  assert.equal(isValidFileName('valid-file.txt'), true);
});

test('Hardening: RAG Embedding cache persists and retrieves embeddings', async () => {
  const db = getDb();
  const testHash = 'test_hash_abc_123';
  const dummyEmbedding = [0.1, 0.2, 0.3, 0.4];

  db.prepare('DELETE FROM rag_embeddings_cache WHERE text_hash = ?').run(testHash);
  saveCachedEmbedding(testHash, dummyEmbedding);

  const retrieved = getCachedEmbedding(testHash);
  assert.deepEqual(retrieved, dummyEmbedding, 'Retrieved embedding must match cached embedding');

  // Calling generateEmbedding on duplicate text uses the cache
  const sample = 'Hardened Google Drive agent workspace with RAG caching';
  const emb1 = await generateEmbedding(sample);
  const emb2 = await generateEmbedding(sample);
  assert.deepEqual(emb1, emb2, 'Cached embedding must return identical vector values');
});

test('Hardening: Binary MIME type detection identifies media and archives', () => {
  assert.equal(isBinaryMimeType('image/png'), true);
  assert.equal(isBinaryMimeType('image/jpeg'), true);
  assert.equal(isBinaryMimeType('audio/mp3'), true);
  assert.equal(isBinaryMimeType('video/mp4'), true);
  assert.equal(isBinaryMimeType('application/zip'), true);
  assert.equal(isBinaryMimeType('application/octet-stream'), true);

  assert.equal(isBinaryMimeType('text/plain'), false);
  assert.equal(isBinaryMimeType('text/markdown'), false);
  assert.equal(isBinaryMimeType('application/vnd.google-apps.document'), false);
  assert.equal(isBinaryMimeType('application/vnd.google-apps.spreadsheet'), false);
  assert.equal(isBinaryMimeType('application/vnd.google-apps.presentation'), false);
});

test('Hardening: Steering cache invalidation functions cleanly', () => {
  assert.doesNotThrow(() => invalidateSteeringCache());
});

test('Hardening: MCP server exposes 12 comprehensive Google Workspace tools (Drive, Calendar, Gmail) with full behavioral annotations', () => {
  const server = new McpServer({ name: 'harden-check', version: '1.0.0' });
  registerMcpTools(server);

  const registeredToolNames = Object.keys(server._registeredTools || {});
  const expectedTools = [
    'get_agent_steering',
    'search_drive_rag',
    'read_drive_file',
    'write_drive_file',
    'delete_drive_file',
    'list_drive_workspace',
    'sync_drive_rag',
    'get_workspace_status',
    'list_calendar_events',
    'create_calendar_event',
    'search_gmail_messages',
    'compose_gmail_message'
  ];

  const requiredHints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

  for (const name of expectedTools) {
    assert.ok(registeredToolNames.includes(name), `MCP server must include tool: ${name}`);
    const toolDef = server._registeredTools[name];
    assert.ok(toolDef.annotations, `Tool ${name} must declare annotations`);
    for (const hint of requiredHints) {
      assert.equal(typeof toolDef.annotations[hint], 'boolean', `Tool ${name} annotation ${hint} must be an explicit boolean`);
    }
  }
  assert.equal(registeredToolNames.length, 12, 'Must have exactly 12 registered MCP tools');
});

test('Hardening: PDF Parsing Engine parses PDF with page citations and headers', async () => {
  // Always verify native/synthetic PDF extraction so CI environments without krusch-nexus still test PDF parsing
  const syntheticPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '4 0 obj\n<< /Length 55 >>\nstream\nBT /F1 12 Tf 72 720 Td (COMMERCIAL LEASE AGREEMENT) Tj ET\nendstream\nendobj\n%%EOF',
    'latin1'
  );
  const nativeRes = extractPdfTextNative(syntheticPdf, 'synthetic_lease.pdf');
  assert.ok(nativeRes, 'Native PDF extractor must parse synthetic PDF stream');
  assert.equal(nativeRes.engine, 'native');
  assert.ok(nativeRes.chunks[0].citation.includes('synthetic_lease.pdf p.1'));
  assert.ok(nativeRes.text.includes('COMMERCIAL LEASE AGREEMENT'));

  const fixturePath = path.resolve(config.rootDir, '..', 'krusch-nexus', 'tests', 'fixtures', 'sample_contract.pdf');
  if (!fs.existsSync(fixturePath)) {
    return;
  }
  const fileResult = await parsePdfFile(fixturePath, 'sample_contract.pdf');
  assert.ok(['nexus', 'pdftotext', 'native'].includes(fileResult.engine), 'Must use valid PDF engine');
  assert.ok(fileResult.chunks.length > 0, 'Must extract at least one chunk');
  assert.ok(fileResult.chunks[0].citation.includes('sample_contract.pdf p.1'), 'Chunk must contain page citation');
  assert.ok(fileResult.text.includes('COMMERCIAL LEASE AGREEMENT'), 'Text must contain content');

  const buf = await fsp.readFile(fixturePath);
  const bufResult = await parsePdfBuffer(buf, 'sample_contract.pdf');
  assert.equal(bufResult.engine, fileResult.engine);
  assert.ok(bufResult.chunks.length > 0);
  assert.ok(bufResult.chunks[0].citation.includes('sample_contract.pdf p.1'));
});

test('Hardening: Google Workspace Extensions (Drive, Calendar, Gmail) OAuth scopes and RFC-2822 MIME encoder', async () => {
  assert.ok(config.google.scopes.some(s => s.includes('calendar.events')), 'Must include Google Calendar events scope');
  assert.ok(config.google.scopes.some(s => s.includes('gmail.compose')), 'Must include Gmail compose scope');

  const encoded = encodeRawEmail({
    to: 'team@krusch.dev',
    subject: 'Sovereign Brief',
    body: 'All systems nominal.'
  });
  const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
  assert.ok(decoded.includes('To: team@krusch.dev'));
  assert.ok(decoded.includes('Subject: Sovereign Brief'));
  assert.ok(decoded.includes('All systems nominal.'));

  // CRLF Header Injection prevention
  const crlfAttempt = encodeRawEmail({
    to: 'Krusch Team <team@krusch.dev>',
    subject: 'Urgent\r\nBcc: attacker@evil.com\r\nX-Injected: true',
    body: 'Hello'
  });
  const decodedCrlf = Buffer.from(crlfAttempt, 'base64url').toString('utf-8');
  assert.ok(!decodedCrlf.includes('\r\nBcc:'), 'Must strip CRLF injection from Subject header');
  assert.ok(!decodedCrlf.includes('\r\nX-Injected:'), 'Must strip injected headers');

  // RFC 2047 UTF-8 Subject encoding for emojis & non-ASCII
  const utf8Subj = encodeMimeSubject('Architecture Sync 📅 — Q4');
  assert.ok(utf8Subj.startsWith('=?UTF-8?B?'), 'Non-ASCII subjects must use RFC 2047 Base64 encoding');

  // Invalid recipient email rejection
  assert.throws(() => validateEmailAddress('not-an-email'), /Invalid recipient email/);
  assert.throws(() => validateEmailAddress(''), /required/);

  // Calendar validation before OAuth call
  await assert.rejects(
    () => createCalendarEvent({ summary: 'Sync', startTime: 'not-a-date' }),
    /Invalid startTime/
  );
  await assert.rejects(
    () => createCalendarEvent({
      summary: 'Sync',
      startTime: '2026-10-14T15:00:00Z',
      endTime: '2026-10-14T14:00:00Z'
    }),
    /endTime must be later than startTime/
  );
});

test('Hardening: Timing-safe API key comparison and OAuth HTML escaping', () => {
  assert.equal(isTimingSafeMatch('secret-key-123', 'secret-key-123'), true);
  assert.equal(isTimingSafeMatch('secret-key-123', 'secret-key-124'), false);
  assert.equal(isTimingSafeMatch('short', 'longer-secret'), false);
  assert.equal(isTimingSafeMatch('', 'secret'), false);

  const escaped = escapeHtml('<script>alert("xss")</script>');
  assert.equal(escaped, '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
});

test('Hardening: Hermetic test DB isolation and FTS5 self-healing (INV-01)', () => {
  const prodDbPath = path.resolve(config.rootDir, './data/gcrush.db');
  assert.equal(config.isTestRuntime, true, 'Must detect test runtime automatically');
  assert.notEqual(config.dbPath, prodDbPath, 'Test runtime must never point to live data/gcrush.db');

  const db = getDb();
  // Seed a document and chunk, then wipe rag_chunks_fts to simulate desynchronization
  saveIndexedDocumentTransactional({
    fileId: 'doc_heal_test',
    name: 'context/heal.md',
    mimeType: 'text/markdown',
    modifiedTime: '2026-10-18T00:00:00Z',
    embeddedChunks: [
      { chunk: 'Self-healing FTS5 index verification', embedding: [0.5, 0.5, 0.5, 0.5] }
    ]
  });

  db.prepare('DELETE FROM rag_chunks_fts').run();
  const ftsBefore = db.prepare('SELECT COUNT(*) as count FROM rag_chunks_fts').get().count;
  assert.equal(ftsBefore, 0);

  const healStatus = ensureFtsSync(db);
  assert.equal(healStatus.healed, true, 'ensureFtsSync must detect and heal FTS5 count mismatch');
  const ftsAfter = db.prepare('SELECT COUNT(*) as count FROM rag_chunks_fts').get().count;
  assert.ok(ftsAfter >= 1, 'rag_chunks_fts must be restored from rag_chunks');
});

test('Hardening: OAuth 2.0 CSRF state lifecycle and zero hardcoded PII (INV-02)', async () => {
  const oauthSource = await fsp.readFile(path.join(config.rootDir, 'src/lib/oauth.js'), 'utf-8');
  assert.ok(!oauthSource.includes('@gmail.com'), 'src/lib/oauth.js must not contain hardcoded personal email');

  const stateToken = generateOAuthState();
  assert.equal(stateToken.length, 64, 'OAuth CSRF state must be a 32-byte (64 hex char) token');
  assert.equal(hasPendingOAuthState(), true);

  // Wrong state must fail without consuming valid state
  assert.equal(verifyOAuthState('invalid_state_token'), false);
  assert.equal(hasPendingOAuthState(), true);

  // Matching state must succeed and consume the state token (one-time use)
  assert.equal(verifyOAuthState(stateToken), true);
  assert.equal(hasPendingOAuthState(), false);
  assert.equal(verifyOAuthState(stateToken), false, 'Replayed OAuth state token must be rejected');
});

test('Hardening: CORS origin lockdown and API key middleware (INV-03)', () => {
  // Non-browser / CLI / MCP requests without Origin
  assert.equal(isAllowedOrigin(undefined), true);
  // Localhost, LAN, and Tailscale origins
  assert.equal(isAllowedOrigin('http://localhost:5446'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:3004'), true);
  assert.equal(isAllowedOrigin('http://192.168.1.13:3004'), true);
  assert.equal(isAllowedOrigin('http://100.65.159.15:5446'), true);
  assert.equal(isAllowedOrigin('https://krusch.tailnet.ts.net'), true);

  // Untrusted external origins must be blocked
  assert.equal(isAllowedOrigin('https://evil-attacker.example.com'), false);
  assert.equal(isAllowedOrigin('http://100.128.0.1:8080'), false, 'Outside Tailscale 100.64.0.0/10 must be blocked');

  // Verify requireAuthIfConfigured blocks unauthenticated requests when API_KEY is set
  const prevKey = process.env.API_KEY;
  process.env.API_KEY = 'test-sovereign-key';
  try {
    let statusSent = null;
    let nextCalled = false;
    const mockRes = {
      status(code) { statusSent = code; return this; },
      json() { return this; }
    };

    requireAuthIfConfigured({ headers: {}, query: {} }, mockRes, () => { nextCalled = true; });
    assert.equal(statusSent, 401);
    assert.equal(nextCalled, false);

    statusSent = null;
    requireAuthIfConfigured(
      { headers: { authorization: 'Bearer test-sovereign-key' }, query: {} },
      mockRes,
      () => { nextCalled = true; }
    );
    assert.equal(statusSent, null);
    assert.equal(nextCalled, true);
  } finally {
    if (prevKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = prevKey;
  }
});

test('Hardening: Google Drive query injection escaping and workspace boundary guard (INV-04)', async () => {
  const malicious = `folder\\' or name != '`;
  const escaped = escapeDriveQueryLiteral(malicious);
  assert.equal(escaped, `folder\\\\\\' or name != \\'`, 'Must escape backslashes before single quotes');

  assert.equal(isValidDriveId('1aBcDeFgHiJkLmNoPqRsTuVwXyZ_012345'), true);
  assert.equal(isValidDriveId(`bad'id`), false);
  assert.equal(isValidDriveId('../traversal'), false);

  // Mock Google Drive client to verify workspace ancestor check
  const parentMap = {
    file_inside: ['subfolder_1'],
    subfolder_1: ['root_workspace_id'],
    file_outside: ['some_other_drive_folder'],
    some_other_drive_folder: ['my_drive_root']
  };
  const mockDrive = {
    files: {
      get: async ({ fileId }) => ({
        data: { id: fileId, parents: parentMap[fileId] || [] }
      })
    }
  };

  assert.equal(await isFileInWorkspace(mockDrive, 'file_inside', 'root_workspace_id'), true);
  assert.equal(await isFileInWorkspace(mockDrive, 'file_outside', 'root_workspace_id'), false);
});

test('Hardening: AES-256-GCM 12-byte NIST IV and legacy 16-byte IV decryption compatibility (INV-05)', () => {
  const payload = JSON.stringify({ refresh_token: '1//sovereign-token' });
  const encrypted = encrypt(payload);
  const [ivHex, tagHex] = encrypted.split(':');

  assert.equal(ivHex.length, 24, 'New ciphertexts must use 12-byte (24 hex char) IV');
  assert.equal(tagHex.length, 32, 'Auth tag must be 16 bytes (32 hex chars)');
  assert.equal(decrypt(encrypted), payload);

  // Verify legacy 16-byte IV ciphertexts still decrypt seamlessly
  const key = crypto.createHash('sha256')
    .update(process.env.ENCRYPTION_KEY || config.google.clientSecret || 'g-krusch-homelab-secure-fallback-key-2026')
    .digest();
  const legacyIv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, legacyIv);
  let enc = cipher.update(payload, 'utf8', 'hex') + cipher.final('hex');
  const legacyTag = cipher.getAuthTag();
  const legacyCiphertext = `${legacyIv.toString('hex')}:${legacyTag.toString('hex')}:${enc}`;

  assert.equal(decrypt(legacyCiphertext), payload, 'Legacy 16-byte IV ciphertexts must remain decryptable');
});

test('Hardening: Atomic transactional RAG indexing and hybrid retrieval (INV-06)', async () => {
  const sampleText = 'Krusch Sovereign Homelab Architecture uses bge-large embeddings and atomic SQLite transactions.';
  const emb = await generateEmbedding(sampleText);

  saveIndexedDocumentTransactional({
    fileId: 'doc_atomic_1',
    name: 'context/architecture.md',
    mimeType: 'text/markdown',
    webViewLink: 'https://drive.google.com/file/d/doc_atomic_1/view',
    modifiedTime: '2026-10-18T12:00:00Z',
    embeddedChunks: [{ chunk: sampleText, embedding: emb }]
  });

  const hits = await searchDriveRag('atomic SQLite transactions', { limit: 3 });
  assert.ok(hits.length > 0, 'Hybrid RAG search must retrieve transactionally indexed document');
  assert.equal(hits[0].fileId, 'doc_atomic_1');
});

test('Hardening: Multi-process SQLite busy_timeout and PDF temp filename sanitization (INV-08 & INV-09)', () => {
  const db = getDb();
  const busyTimeout = db.pragma('busy_timeout');
  assert.equal(busyTimeout[0]?.timeout, 5000, 'SQLite busy_timeout must be set to 5000ms');

  assert.equal(sanitizePdfTempName('../../etc/passwd'), 'passwd.pdf');
  assert.equal(sanitizePdfTempName('-rf.pdf'), 'doc_-rf.pdf', 'Leading hyphens must be prefixed to prevent CLI flag injection');
  assert.equal(sanitizePdfTempName('lease contract (2026).pdf'), 'lease_contract__2026_.pdf');
});

test('Hardening: HTTP Security Headers and Sliding-Window Rate Limiter (INV-11)', () => {
  const headers = {};
  let nextCalled = false;
  securityHeadersMiddleware({}, {
    setHeader(k, v) { headers[k] = v; }
  }, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');

  const limiter = createRateLimiter({ windowMs: 10000, maxRequests: 2 });
  let statusSent = null;
  const mockRes = {
    setHeader(k, v) { headers[k] = v; },
    status(c) { statusSent = c; return this; },
    json() { return this; }
  };

  limiter({ ip: '10.0.0.99' }, mockRes, () => {});
  limiter({ ip: '10.0.0.99' }, mockRes, () => {});
  assert.equal(statusSent, null);

  // 3rd request within window must trigger 429
  limiter({ ip: '10.0.0.99' }, mockRes, () => {});
  assert.equal(statusSent, 429);
  assert.ok(Number(headers['Retry-After']) >= 1);
});

test('Hardening: Pre-spool PDF magic-byte security gate, per-session MCP SSE isolation, and zero hardcoded paths (INV-09 & INV-12)', async () => {
  // 1. Pre-spool magic-byte validation rejects disguised executables and HTML
  assert.throws(
    () => validatePdfMagicBytes(Buffer.from('MZ\x90\x00\x03\x00\x00\x00')),
    /Windows PE executable/
  );
  assert.throws(
    () => validatePdfMagicBytes(Buffer.from('\x7fELF\x02\x01\x01\x00')),
    /ELF binary/
  );
  assert.throws(
    () => validatePdfMagicBytes(Buffer.from('<!DOCTYPE html><html><script>evil()</script></html>')),
    /HTML\/script payload/
  );
  assert.throws(
    () => validatePdfMagicBytes(Buffer.from('NOT_A_PDF_HEADER')),
    /missing %PDF- magic header/
  );
  assert.equal(validatePdfMagicBytes(Buffer.from('%PDF-1.7\n%%EOF')), true);

  // 2. Per-session MCP server factory creates isolated instances with all 12 tools
  const s1 = createMcpServer();
  const s2 = createMcpServer();
  assert.notEqual(s1, s2, 'Each SSE connection must receive an isolated McpServer instance');
  assert.equal(Object.keys(s1._registeredTools || {}).length, 12);
  assert.equal(Object.keys(s2._registeredTools || {}).length, 12);

  // 3. Unified steering mutex key and zero hardcoded host paths
  const steeringSrc = await fsp.readFile(path.join(config.rootDir, 'src/lib/steering.js'), 'utf-8');
  assert.ok(steeringSrc.includes("const STEERING_MUTEX_KEY = 'agent_md_steering'"), 'Steering read/write must share unified mutex key');
  assert.ok(!steeringSrc.includes('agent_md_read'), 'Legacy split read mutex key must be removed');
  assert.ok(!steeringSrc.includes('agent_md_write'), 'Legacy split write mutex key must be removed');

  const forbiddenPrefix = ['', 'home', 'krusch'].join('/');
  const filesToAudit = [
    'src/config.js',
    'src/index.js',
    'src/lib/pdf.js',
    'src/lib/steering.js',
    'src/lib/drive.js',
    'src/lib/slides.js',
    'src/lib/rag.js',
    'src/lib/oauth.js',
    'client/index.html',
    'spec.md'
  ];
  for (const rel of filesToAudit) {
    const content = await fsp.readFile(path.join(config.rootDir, rel), 'utf-8');
    assert.ok(!content.includes(forbiddenPrefix), `File ${rel} must not contain hardcoded host path`);
  }
});

test('Hardening: 1024-dim sovereign embedding pipeline, cache poisoning guard, and client DOM XSS sanitization (INV-13)', async () => {
  const ragSrc = await fsp.readFile(path.join(config.rootDir, 'src/lib/rag.js'), 'utf-8');
  assert.ok(ragSrc.includes('models/gemini-embedding-001'), 'Must use active gemini-embedding-001 model');
  assert.ok(!ragSrc.includes('models/text-embedding-004'), 'Deprecated text-embedding-004 (HTTP 404) must be removed');
  assert.ok(ragSrc.includes('outputDimensionality: 1024'), 'Gemini fallback must match 1024-dim bge-large dimensionality');
  assert.ok(ragSrc.includes('escapeDriveQueryLiteral(parentId)'), 'listAllFolderFiles must escape parentId');
  assert.ok(ragSrc.includes('cached.length >= 256'), 'Production cache lookup must bypass stale <256-dim fallback vectors');

  const clientSrc = await fsp.readFile(path.join(config.rootDir, 'client/main.js'), 'utf-8');
  assert.ok(clientSrc.includes('function sanitizeSafeUrl(url)'), 'Client must validate webViewLink URLs via sanitizeSafeUrl');
  assert.ok(clientSrc.includes('rel="noopener noreferrer"'), 'External links must include rel="noopener noreferrer"');
  assert.ok(clientSrc.includes('escapeHtml(data.error)'), 'Error states rendered via innerHTML must be HTML-escaped');
  assert.ok(clientSrc.includes('escapeHtml(err.message)'), 'Caught exceptions rendered via innerHTML must be HTML-escaped');
  assert.ok(clientSrc.includes('loadMcpInfo()'), 'Client must dynamically hydrate MCP connection snippets');
});

test('Hardening: Transactional RAG/FTS5 purge on file deletion and readDriveFile workspace boundary guard', async () => {
  const db = getDb();
  const emb = await generateEmbedding('Transient document to be purged upon deletion');

  saveIndexedDocumentTransactional({
    fileId: 'file_purge_target_1',
    name: 'output/temp-purge.md',
    mimeType: 'text/markdown',
    webViewLink: 'https://drive.google.com/file/d/file_purge_target_1/view',
    modifiedTime: '2026-10-18T16:25:00Z',
    embeddedChunks: [{ chunk: 'Transient document to be purged upon deletion', embedding: emb }]
  });

  db.prepare(`
    INSERT INTO agent_steering_cache (id, content, version_hash, drive_file_id, drive_modified_time, cached_at)
    VALUES (1, '# Steering', 'hash1', 'file_purge_target_1', '2026-10-18T16:25:00Z', datetime('now'))
    ON CONFLICT(id) DO UPDATE SET drive_file_id = excluded.drive_file_id
  `).run();

  const epochBefore = getSteeringCacheEpoch();
  const purgeRes = purgeIndexedDocumentTransactional('file_purge_target_1');
  assert.equal(purgeRes.deleted, true, 'Document row must be deleted');
  assert.equal(purgeRes.steeringCleared, true, 'Steering cache row must be cleared when matching deleted fileId');
  assert.ok(getSteeringCacheEpoch() > epochBefore, 'Steering cache epoch must increment when steering file is purged');

  const remainingChunks = db.prepare('SELECT COUNT(*) as c FROM rag_chunks WHERE file_id = ?').get('file_purge_target_1').c;
  const remainingFts = db.prepare('SELECT COUNT(*) as c FROM rag_chunks_fts WHERE file_id = ?').get('file_purge_target_1').c;
  assert.equal(remainingChunks, 0, 'All rag_chunks for deleted file must be purged');
  assert.equal(remainingFts, 0, 'All rag_chunks_fts entries for deleted file must be purged');

  const driveSrc = await fsp.readFile(path.join(config.rootDir, 'src/lib/drive.js'), 'utf-8');
  assert.ok(driveSrc.includes('Refusing to read file outside the G-Krusch workspace boundary.'), 'readDriveFile must enforce workspace boundary when enforceWorkspace is true');
  assert.ok(driveSrc.includes('purgeIndexedDocumentTransactional(targetId)'), 'deleteDriveFile must atomically purge local RAG/FTS5 index');

  // Multi-tab OAuth state verification
  const stateTab1 = generateOAuthState();
  const stateTab2 = generateOAuthState();
  assert.notEqual(stateTab1, stateTab2);
  assert.equal(verifyOAuthState(stateTab1), true, 'First tab state must remain valid even after second tab generates a state');
  assert.equal(verifyOAuthState(stateTab1), false, 'Consumed tab 1 state must not be reusable');
  assert.equal(verifyOAuthState(stateTab2), true, 'Second tab state must also verify cleanly');

  // Disconnect session cleanup
  saveCredentials('google_oauth', { access_token: 'tok_disconnect_test' }, 'user@example.com');
  setMetadata('workspace_root_id', 'folder_old_account');
  clearWorkspaceSessionState('google_oauth');
  assert.equal(getCredentials('google_oauth'), null, 'Credentials must be cleared on disconnect');
  assert.equal(getMetadata('workspace_root_id'), null, 'Cached workspace_root_id must be cleared on disconnect');

  const pdfSrc = await fsp.readFile(path.join(config.rootDir, 'src/lib/pdf.js'), 'utf-8');
  assert.ok(pdfSrc.includes("['-layout', '--', filePath, '-']"), 'pdftotext must receive -- end-of-options separator before filePath');

  // GKR-01 & GKR-07: MCP SSE rate limiting & parsed body forwarding
  const indexSrc = await fsp.readFile(path.join(config.rootDir, 'src/index.js'), 'utf-8');
  assert.ok(indexSrc.includes('handlePostMessage(req, res, req.body)'), 'POST /mcp/messages must pass req.body as 3rd argument (GKR-01)');
  assert.ok(indexSrc.includes("app.get('/mcp/sse', apiLimiter"), 'GET /mcp/sse must mount apiLimiter (GKR-07)');
  assert.ok(indexSrc.includes("app.post('/mcp/messages', apiLimiter"), 'POST /mcp/messages must mount apiLimiter (GKR-07)');

  // GKR-03: saveCachedEmbedding overwrites stale low-dim embeddings with 1024-dim vectors
  const upgradeHash = 'gkr03_upgrade_test_hash';
  saveCachedEmbedding(upgradeHash, new Array(64).fill(0.1));
  assert.equal(getCachedEmbedding(upgradeHash).length, 64);
  saveCachedEmbedding(upgradeHash, new Array(1024).fill(0.2));
  assert.equal(getCachedEmbedding(upgradeHash).length, 1024, 'saveCachedEmbedding must overwrite stale <256-dim vector on conflict (GKR-03)');

  // GKR-05: Mach-O magic bytes, <svg/<body>/<iframe> HTML tags, and start-anchored %PDF-
  assert.throws(
    () => validatePdfMagicBytes(Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0x00, 0x00])),
    /Mach-O binary/
  );
  assert.throws(
    () => validatePdfMagicBytes(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00])),
    /Mach-O binary/
  );
  assert.throws(
    () => validatePdfMagicBytes(Buffer.from('<svg onload="evil()">%PDF-1.4</svg>')),
    /HTML\/script payload/
  );
  assert.throws(
    () => validatePdfMagicBytes(Buffer.from('JUNK_PREFIX_NOT_PDF %PDF-1.4\n%%EOF')),
    /missing %PDF- magic header/
  );

  // GKR-08: Exclude folders in writeDriveFile and getAgentSteering queries
  assert.ok(
    driveSrc.includes("mimeType != 'application/vnd.google-apps.folder'"),
    'writeDriveFile lookup must exclude folders (GKR-08)'
  );

  // INV-14: Native Google Workspace MIME disambiguation in writeDriveFile and resolvePathToId
  assert.ok(
    driveSrc.includes('candidates.find(f => f.mimeType === payload.targetMimeType)'),
    'writeDriveFile must disambiguate existing native Google Workspace files by targetMimeType (INV-14)'
  );
  assert.ok(
    driveSrc.includes('inferWorkspaceMimeFromPath(segment)'),
    'resolvePathToId must prefer matching native Workspace MIME type when virtual extension is provided (INV-14)'
  );

  // GKR-09: ensureFtsSync cleans orphaned FTS rows when chunkCount === 0
  db.prepare('DELETE FROM rag_chunks').run();
  db.prepare('DELETE FROM rag_chunks_fts').run();
  db.prepare("INSERT INTO rag_chunks_fts (content, file_id, chunk_index) VALUES ('orphan chunk', 'orphan_id', 0)").run();
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM rag_chunks_fts').get().c, 1);
  const orphanHeal = ensureFtsSync(db);
  assert.equal(orphanHeal.healed, true, 'ensureFtsSync must heal orphaned FTS rows when chunkCount === 0 (GKR-09)');
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM rag_chunks_fts').get().c, 0);

  // GKR-11: client/main.js recognizes native-js PDF engine as online
  const clientSrc = await fsp.readFile(path.join(config.rootDir, 'client/main.js'), 'utf-8');
  assert.ok(clientSrc.includes("hData.pdf.engine === 'native-js'"), 'Client must recognize native-js PDF engine as online (GKR-11)');
});



