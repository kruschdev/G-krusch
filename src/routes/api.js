import { Router } from 'express';
import { getAgentSteering, updateAgentSteering } from '../lib/steering.js';
import { listWorkspaceTree, getDriveOverview, writeDriveFile, deleteDriveFile } from '../lib/drive.js';
import { syncDriveRag, searchDriveRag } from '../lib/rag.js';
import { getDb, getMetadata } from '../lib/db.js';
import { getAuthStatus } from '../lib/oauth.js';
import { requireAuthIfConfigured } from '../lib/auth-guard.js';
import { sanitizeWorkspacePath } from '../lib/path-utils.js';
import config from '../config.js';

const router = Router();

// ── Health & Diagnostics ─────────────────────────────────────────

router.get('/health', (req, res) => {
  try {
    const db = getDb();
    const isDbOk = !!db.prepare('SELECT 1').get();
    const authStatus = getAuthStatus();
    const docCount = db.prepare('SELECT COUNT(*) as count FROM rag_documents').get()?.count || 0;
    const chunkCount = db.prepare('SELECT COUNT(*) as count FROM rag_chunks').get()?.count || 0;

    res.json({
      status: 'healthy',
      version: '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      db: isDbOk ? 'connected' : 'error',
      auth: {
        authenticated: authStatus.authenticated,
        email: authStatus.email
      },
      workspace: {
        folderName: config.google.workspaceFolderName,
        cachedRootId: getMetadata('workspace_root_id')
      },
      rag: {
        documentsIndexed: docCount,
        totalChunks: chunkCount
      }
    });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// ── Steering (agent.md) ──────────────────────────────────────────

router.get('/steering', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const steering = await getAgentSteering({ forceRefresh });
    res.json(steering);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/steering', requireAuthIfConfigured, async (req, res) => {
  try {
    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Missing content string in body.' });
    }
    const result = await updateAgentSteering(content);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Workspace Hierarchy & File Ops ──────────────────────────────

router.get('/workspace/tree', async (req, res) => {
  try {
    const tree = await listWorkspaceTree();
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/drive/write', requireAuthIfConfigured, async (req, res) => {
  try {
    const { path: rawPath, content, mimeType } = req.body;
    if (!rawPath) return res.status(400).json({ error: 'Path is required.' });

    const cleanPath = sanitizeWorkspacePath(rawPath);
    const result = await writeDriveFile({ path: cleanPath, content: content || '', mimeType });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/drive/file', requireAuthIfConfigured, async (req, res) => {
  try {
    const { fileId, path: rawPath } = req.body;
    if (!fileId && !rawPath) {
      return res.status(400).json({ error: 'Must provide fileId or path.' });
    }
    const result = await deleteDriveFile({ fileId, path: rawPath });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/drive/overview', async (req, res) => {
  try {
    const overview = await getDriveOverview();
    res.json(overview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RAG Indexing & Search ───────────────────────────────────────

router.post('/rag/sync', requireAuthIfConfigured, async (req, res) => {
  try {
    const syncResult = await syncDriveRag();
    res.json(syncResult);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/rag/search', async (req, res) => {
  try {
    const rawQuery = String(req.query.q || '').slice(0, 300);
    if (!rawQuery.trim()) {
      return res.status(400).json({ error: 'Query parameter q is required.' });
    }
    const limit = Math.min(Math.max(1, parseInt(req.query.limit || '5', 10)), 25);
    const results = await searchDriveRag(rawQuery, { limit });
    res.json({ query: rawQuery, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/rag/stats', (req, res) => {
  try {
    const db = getDb();
    const docCount = db.prepare('SELECT COUNT(*) as count FROM rag_documents').get()?.count || 0;
    const chunkCount = db.prepare('SELECT COUNT(*) as count FROM rag_chunks').get()?.count || 0;
    const lastDoc = db.prepare('SELECT MAX(synced_at) as last_sync FROM rag_documents').get();

    res.json({
      documentsIndexed: docCount,
      totalChunks: chunkCount,
      lastSync: lastDoc?.last_sync || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MCP Config Info ─────────────────────────────────────────────

router.get('/mcp/info', (req, res) => {
  const sseUrl = `${config.baseUrl}/mcp/sse`;
  res.json({
    name: 'g-krusch',
    version: '1.0.0',
    description: 'Google Drive for AI Agents & Agentic Systems',
    transports: {
      sse: sseUrl,
      stdio: {
        command: 'node',
        args: [`${config.rootDir}/src/index.js`, '--stdio']
      }
    },
    tools: [
      'get_agent_steering',
      'search_drive_rag',
      'read_drive_file',
      'write_drive_file',
      'delete_drive_file',
      'list_drive_workspace',
      'sync_drive_rag',
      'get_workspace_status'
    ]
  });
});

export default router;

