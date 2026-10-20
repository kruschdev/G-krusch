import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, cosineSimilarity, generateEmbedding, isIndexableMimeType } from '../src/lib/rag.js';
import { getDb, saveCredentials, getCredentials, setMetadata, getMetadata, searchFtsChunks } from '../src/lib/db.js';
import { encrypt, decrypt } from '../src/lib/crypto.js';
import { sanitizeWorkspacePath, isValidFileName } from '../src/lib/path-utils.js';
import { mutex } from '../src/lib/mutex.js';
import { withRetry } from '../src/lib/retry.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools } from '../src/mcp/tools.js';
import {
  parseMarkdownSlides,
  buildPptxBuffer,
  markdownToGoogleDocHtml,
  markdownTableOrTextToCsv,
  prepareWorkspaceWritePayload,
  inferWorkspaceMimeFromPath,
  GOOGLE_SLIDES_MIME,
  GOOGLE_DOCS_MIME,
  GOOGLE_SHEETS_MIME,
  PPTX_MIME
} from '../src/lib/slides.js';

import { oauthCallbackHandler } from '../src/routes/auth.js';

test('Crypto: AES-256-GCM encryption and decryption roundtrip', () => {
  const secretData = JSON.stringify({ access_token: 'ya29.test12345', refresh_token: '1//refresh' });
  const encrypted = encrypt(secretData);

  assert.notEqual(encrypted, secretData, 'Encrypted text must not match plaintext');
  assert.ok(encrypted.includes(':'), 'Encrypted output should contain iv:tag:cipher format');

  const decrypted = decrypt(encrypted);
  assert.equal(decrypted, secretData, 'Decrypted text must match original plaintext');

  // Backwards compatibility with unencrypted JSON
  assert.equal(decrypt('{"legacy":true}'), '{"legacy":true}', 'Should pass unencrypted JSON through cleanly');

  // Malformed ciphertext (parts.length !== 3) must throw
  assert.throws(() => decrypt('malformed:ciphertext'), /Invalid AES-256-GCM ciphertext format/);
});

test('Auth: OAuth callback rejects missing or invalid CSRF state parameter (GKR-02)', async () => {
  let statusCode = 200;
  let bodySent = '';
  const mockRes = {
    status(c) { statusCode = c; return this; },
    send(b) { bodySent = b; return this; }
  };

  await oauthCallbackHandler({ query: { code: 'auth_code_123' } }, mockRes);
  assert.equal(statusCode, 403, 'Callback without state must be rejected with 403');
  assert.ok(bodySent.includes('Invalid or expired OAuth state parameter'));
});

test('Security: sanitizeWorkspacePath prevents traversal and illegal characters', () => {
  assert.equal(sanitizeWorkspacePath('context/specs.md'), 'context/specs.md');
  assert.equal(sanitizeWorkspacePath('output//report.md'), 'output/report.md');
  assert.equal(sanitizeWorkspacePath('  agent.md  '), 'agent.md');

  // Traversal attempts must throw
  assert.throws(() => sanitizeWorkspacePath('../secret.env'), /traversal/);
  assert.throws(() => sanitizeWorkspacePath('context/../../etc/passwd'), /traversal/);
  assert.throws(() => sanitizeWorkspacePath(''), /cannot be empty/);
  assert.throws(() => sanitizeWorkspacePath('bad:name*.txt'), /illegal/);

  assert.equal(isValidFileName('clean-file.md'), true);
  assert.equal(isValidFileName('bad:name.txt'), false);
  assert.equal(isValidFileName('..'), false);
});

test('Concurrency: AsyncKeyedMutex ensures sequential execution on same key', async () => {
  const order = [];
  const p1 = mutex.runExclusive('test_key', async () => {
    await new Promise(r => setTimeout(r, 40));
    order.push(1);
  });
  const p2 = mutex.runExclusive('test_key', async () => {
    order.push(2);
  });

  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2], 'Mutex must force sequential execution');
});

test('Resilience: withRetry retries on transient errors', async () => {
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts++;
    if (attempts < 2) {
      const err = new Error('ECONNRESET');
      err.code = 'ECONNRESET';
      throw err;
    }
    return 'success';
  }, { maxRetries: 3, initialDelayMs: 10 });

  assert.equal(result, 'success');
  assert.equal(attempts, 2, 'Should succeed on second attempt');
});

test('Database & FTS5: encrypted tokens and BM25 full-text indexing', () => {
  const db = getDb();
  assert.ok(db, 'Database instance should be created');

  setMetadata('test_key', 'test_value');
  const val = getMetadata('test_key');
  assert.equal(val, 'test_value');

  // Token storage must be encrypted at rest in raw DB
  saveCredentials('test_oauth', { access_token: 'sec_123' }, 'test@example.com');
  const rawRow = db.prepare('SELECT tokens FROM credentials WHERE id = ?').get('test_oauth');
  assert.ok(!rawRow.tokens.includes('sec_123'), 'Raw tokens column must be encrypted');

  const creds = getCredentials('test_oauth');
  assert.equal(creds.email, 'test@example.com');
  assert.equal(creds.tokens.access_token, 'sec_123');

  // Test FTS5 insertion and BM25 search
  db.prepare('DELETE FROM rag_chunks_fts').run();
  db.prepare(`
    INSERT INTO rag_chunks_fts (content, file_id, chunk_index)
    VALUES (?, ?, ?)
  `).run('Autonomous Google Drive memory and agent steering rules', 'file_abc', 0);

  const results = searchFtsChunks('steering rules');
  assert.ok(results.length > 0, 'FTS5 should return matching chunk');
  assert.equal(results[0].file_id, 'file_abc');
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

test('RAG: mime filtering and deterministic embeddings', async () => {
  assert.equal(isIndexableMimeType('text/markdown'), true);
  assert.equal(isIndexableMimeType('application/vnd.google-apps.document'), true);
  assert.equal(isIndexableMimeType('image/png'), false);
  assert.equal(isIndexableMimeType('video/mp4'), false);

  const textA = 'Artificial intelligence agent workspace on Google Drive';
  const textB = 'AI agent workspace running on Google Drive';
  const textC = 'Baking sourdough bread in a Dutch oven';

  const embA = await generateEmbedding(textA);
  const embB = await generateEmbedding(textB);
  const embC = await generateEmbedding(textC);

  const simAB = cosineSimilarity(embA, embB);
  const simAC = cosineSimilarity(embA, embC);

  assert.ok(simAB > simAC, 'Related agent texts should have higher similarity than unrelated text');
});

test('MCP: tools register properly on McpServer', () => {
  const server = new McpServer({ name: 'test-server', version: '1.0.0' });
  registerMcpTools(server);
  assert.ok(server, 'Server should register all tools without throwing');
});

test('Workspace Formats: Google Slides, Docs, and Sheets payload builders', () => {
  const deckMd = `
# Q4 Architecture Review
- Zero-trust MCP boundaries
- Hybrid Vector + BM25 RAG
Notes: Highlight our 1024-dim bge-large embeddings.
---
# Fleet Topology
- krusch: Central Orchestrator
- kruschdev: 30B MoE Compute
  `.trim();

  const slides = parseMarkdownSlides(deckMd, 'Architecture');
  assert.equal(slides.length, 2);
  assert.equal(slides[0].title, 'Q4 Architecture Review');
  assert.deepEqual(slides[0].bullets, ['Zero-trust MCP boundaries', 'Hybrid Vector + BM25 RAG']);
  assert.equal(slides[0].notes, 'Highlight our 1024-dim bge-large embeddings.');

  const pptxBuf = buildPptxBuffer(slides);
  assert.equal(pptxBuf.readUInt32LE(0), 0x04034b50, 'PPTX buffer must start with PK ZIP local header signature');
  assert.ok(pptxBuf.includes(Buffer.from('ppt/notesSlides/notesSlide1.xml')), 'PPTX ZIP directory must include notesSlide1.xml when speaker notes exist');

  const slidesPayload = prepareWorkspaceWritePayload({
    fileName: 'roadmap.slides',
    content: deckMd,
    mimeType: 'text/markdown'
  });
  assert.equal(slidesPayload.targetName, 'roadmap');
  assert.equal(slidesPayload.targetMimeType, GOOGLE_SLIDES_MIME);
  assert.equal(slidesPayload.uploadMimeType, PPTX_MIME);
  assert.equal(slidesPayload.extraMeta.slidesCount, 2);

  // Verify .md source extension is stripped when mime_type='slides'
  const mdSlidesPayload = prepareWorkspaceWritePayload({
    fileName: 'pitch.md',
    content: deckMd,
    mimeType: 'slides'
  });
  assert.equal(mdSlidesPayload.targetName, 'pitch');
  assert.equal(mdSlidesPayload.targetMimeType, GOOGLE_SLIDES_MIME);

  const richDocMd = [
    '# Heading 1',
    '- Item A',
    '- **Bold Item**',
    '1. First step',
    '2. Second step',
    '> Sovereign quote',
    '```js',
    'const x = 1;',
    '```',
    '| Col 1 | Col 2 |',
    '|---|---|',
    '| Val A | Val B |'
  ].join('\n');
  const docHtml = markdownToGoogleDocHtml(richDocMd, 'My Spec');
  assert.ok(docHtml.includes('<h1>Heading 1</h1>'));
  assert.ok(docHtml.includes('<li><strong>Bold Item</strong></li>'));
  assert.ok(docHtml.includes('<ol>\n<li>First step</li>\n<li>Second step</li>\n</ol>'));
  assert.ok(docHtml.includes('<blockquote><p>Sovereign quote</p></blockquote>'));
  assert.ok(docHtml.includes('<pre><code>const x = 1;</code></pre>'));
  assert.ok(docHtml.includes('<th>Col 1</th><th>Col 2</th>'));
  assert.ok(docHtml.includes('<td>Val A</td><td>Val B</td>'));

  const docPayload = prepareWorkspaceWritePayload({
    fileName: 'spec.md',
    content: '# Spec\nHello world',
    mimeType: 'docs'
  });
  assert.equal(docPayload.targetName, 'spec');
  assert.equal(docPayload.targetMimeType, GOOGLE_DOCS_MIME);
  assert.equal(docPayload.uploadMimeType, 'text/html');

  const tableMd = `
# Fleet Inventory
| Node | Role |
|---|---|
| krusch | Orchestrator, "Primary" |
| kruschdev | Compute \\| MoE |
  `.trim();
  const csv = markdownTableOrTextToCsv(tableMd);
  assert.equal(csv, 'Node,Role\r\nkrusch,"Orchestrator, ""Primary"""\r\nkruschdev,Compute | MoE');

  const sheetPayload = prepareWorkspaceWritePayload({
    fileName: 'fleet.csv',
    content: tableMd,
    mimeType: 'sheets'
  });
  assert.equal(sheetPayload.targetName, 'fleet');
  assert.equal(sheetPayload.targetMimeType, GOOGLE_SHEETS_MIME);
  assert.equal(sheetPayload.uploadMimeType, 'text/csv');

  assert.equal(inferWorkspaceMimeFromPath('deck.slides'), GOOGLE_SLIDES_MIME);
  assert.equal(inferWorkspaceMimeFromPath('deck.pptx'), GOOGLE_SLIDES_MIME);
  assert.equal(inferWorkspaceMimeFromPath('doc.gdoc'), GOOGLE_DOCS_MIME);
  assert.equal(inferWorkspaceMimeFromPath('metrics.gsheet'), GOOGLE_SHEETS_MIME);
  assert.equal(inferWorkspaceMimeFromPath('notes.md'), null);
});


