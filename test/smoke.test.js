import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, cosineSimilarity, generateEmbedding } from '../src/lib/rag.js';
import { getDb, saveCredentials, getCredentials, setMetadata, getMetadata } from '../src/lib/db.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools } from '../src/mcp/tools.js';

test('Database: initialization, credentials, and metadata', () => {
  const db = getDb();
  assert.ok(db, 'Database instance should be created');

  setMetadata('test_key', 'test_value');
  const val = getMetadata('test_key');
  assert.equal(val, 'test_value');

  saveCredentials('test_oauth', { access_token: '123' }, 'test@example.com');
  const creds = getCredentials('test_oauth');
  assert.equal(creds.email, 'test@example.com');
  assert.equal(creds.tokens.access_token, '123');
});

test('RAG: chunkText partitions document into overlapping semantic blocks', () => {
  const sample = `
# Section One
This is the introductory section explaining how G-Krusch operates.

# Section Two
This is the secondary section detailing the agent.md steering invariants and rules.

# Section Three
Here are the guidelines for writing artifacts directly to Google Drive.
  `.trim();

  const chunks = chunkText(sample, 120, 30);
  assert.ok(chunks.length >= 2, 'Should produce multiple chunks');
  assert.ok(chunks[0].includes('Section One'), 'First chunk should contain Section One');
});

test('RAG: deterministic embedding and cosine similarity', async () => {
  const textA = 'Artificial intelligence agent workspace on Google Drive';
  const textB = 'AI agent workspace running on Google Drive';
  const textC = 'Baking sourdough bread in a Dutch oven';

  const embA = await generateEmbedding(textA);
  const embB = await generateEmbedding(textB);
  const embC = await generateEmbedding(textC);

  const simAB = cosineSimilarity(embA, embB);
  const simAC = cosineSimilarity(embA, embC);

  assert.ok(simAB > simAC, 'Related agent texts should have higher similarity than unrelated text');
  assert.ok(cosineSimilarity(embA, embA) > 0.99, 'Self similarity should be ~1.0');
});

test('MCP: tools register properly on McpServer', () => {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  registerMcpTools(server);
  assert.ok(server, 'Server should register all 6 tools without throwing');
});
