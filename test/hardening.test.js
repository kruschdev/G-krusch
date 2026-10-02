import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncKeyedMutex } from '../src/lib/mutex.js';
import { sanitizeWorkspacePath, isValidFileName, isForbiddenSegment } from '../src/lib/path-utils.js';
import { isBinaryMimeType } from '../src/lib/drive.js';
import { generateEmbedding, cosineSimilarity } from '../src/lib/rag.js';
import { getDb, getCachedEmbedding, saveCachedEmbedding } from '../src/lib/db.js';
import { invalidateSteeringCache } from '../src/lib/steering.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools } from '../src/mcp/tools.js';

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
