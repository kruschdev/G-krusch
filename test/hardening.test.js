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
import { getDb, getCachedEmbedding, saveCachedEmbedding, ensureFtsSync } from '../src/lib/db.js';
import { invalidateSteeringCache } from '../src/lib/steering.js';
import { parsePdfFile, parsePdfBuffer, sanitizePdfTempName } from '../src/lib/pdf.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools } from '../src/mcp/tools.js';
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
  const fixturePath = '/home/krusch/homelab/projects/krusch-nexus/tests/fixtures/sample_contract.pdf';
  if (!fs.existsSync(fixturePath)) {
    return;
  }
  const fileResult = await parsePdfFile(fixturePath, 'sample_contract.pdf');
  assert.ok(['nexus', 'pdftotext'].includes(fileResult.engine), 'Must use valid PDF engine');
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





