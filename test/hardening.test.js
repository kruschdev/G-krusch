import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { AsyncKeyedMutex } from '../src/lib/mutex.js';
import { sanitizeWorkspacePath, isValidFileName, isForbiddenSegment } from '../src/lib/path-utils.js';
import { isBinaryMimeType } from '../src/lib/drive.js';
import { generateEmbedding, cosineSimilarity } from '../src/lib/rag.js';
import { getDb, getCachedEmbedding, saveCachedEmbedding } from '../src/lib/db.js';
import { invalidateSteeringCache } from '../src/lib/steering.js';
import { parsePdfFile, parsePdfBuffer } from '../src/lib/pdf.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools } from '../src/mcp/tools.js';
import { encodeRawEmail, validateEmailAddress, encodeMimeSubject, createCalendarEvent } from '../src/lib/extensions.js';
import { isTimingSafeMatch } from '../src/lib/auth-guard.js';
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

test('Hardening: MCP server exposes 8 comprehensive tools', () => {
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
    'get_workspace_status'
  ];

  for (const name of expectedTools) {
    assert.ok(registeredToolNames.includes(name), `MCP server must include tool: ${name}`);
  }
  assert.equal(registeredToolNames.length, 8, 'Must have exactly 8 registered MCP tools');
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



