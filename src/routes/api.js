import { Router } from 'express';
import { getAgentSteering, updateAgentSteering } from '../lib/steering.js';
import { listWorkspaceTree, getDriveOverview, readDriveFile, resolvePathToId, writeDriveFile, deleteDriveFile } from '../lib/drive.js';
import { ensureSkylightCalendars, listUserCalendars, listCalendarEvents, createCalendarEvent, searchGmailMessages, createOrSendGmail } from '../lib/extensions.js';
import { syncDriveRag, searchDriveRag } from '../lib/rag.js';
import { getMetadata, getRagIndexStats } from '../lib/db.js';
import { getAuthStatus } from '../lib/oauth.js';
import { requireAuthIfConfigured } from '../lib/auth-guard.js';
import { sanitizeWorkspacePath } from '../lib/path-utils.js';
import { getNexusConfig, getPdftotextPath } from '../lib/pdf.js';
import config from '../config.js';

import { oauthCallbackHandler } from './auth.js';

const router = Router();

export function logRouteError(req, err, cfg = config, execArgv = process.execArgv) {
  if (!cfg.nodeTestContext && !execArgv.includes('--test')) {
    console.error(`[G-Krusch API Error] ${req?.method} ${req?.originalUrl}:`, err?.stack || err?.message || err);
  }
}

// Support Google OAuth redirect URI configured at /api/google/callback
router.get('/google/callback', oauthCallbackHandler);

// ── Health & Diagnostics ─────────────────────────────────────────

router.get('/status', (req, res) => {
  try {
    const authStatus = getAuthStatus();
    const { documentsIndexed, totalChunks, cachedSteering } = getRagIndexStats();

    res.json({
      status: authStatus.authenticated ? 'connected' : 'disconnected',
      authenticated: authStatus.authenticated,
      account: authStatus.email,
      email: authStatus.email,
      updatedAt: authStatus.updatedAt,
      folderName: config.google.workspaceFolderName,
      documentsIndexed,
      totalChunks,
      steeringCached: Boolean(cachedSteering),
      steeringVersionHash: cachedSteering?.version_hash || null,
      authUrl: `${config.baseUrl}/auth/google`
    });
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ status: 'error', authenticated: false, error: err.message });
  }
});

router.get('/health', (req, res) => {
  try {
    const { isDbOk, documentsIndexed, totalChunks } = getRagIndexStats();
    const authStatus = getAuthStatus();
    const nexus = getNexusConfig();
    const pdftotext = getPdftotextPath();

    res.json({
      status: 'healthy',
      version: '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      db: isDbOk ? 'connected' : 'error',
      auth: {
        authenticated: authStatus.authenticated,
        email: authStatus.email
      },
      pdf: {
        engine: nexus.isAvailable ? 'nexus' : (pdftotext ? 'pdftotext' : 'native-js'),
        nexusPath: nexus.nexusDir
      },
      workspace: {
        folderName: config.google.workspaceFolderName,
        cachedRootId: getMetadata('workspace_root_id')
      },
      rag: {
        documentsIndexed,
        totalChunks
      },
      extensions: ['drive', 'docs', 'sheets', 'slides', 'calendar', 'gmail']
    });
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// ── Steering (agent.md) ──────────────────────────────────────────

router.get('/steering', requireAuthIfConfigured, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const steering = await getAgentSteering({ forceRefresh });
    res.json(steering);
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/steering', requireAuthIfConfigured, async (req, res) => {
  try {
    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Missing content string in body.' });
    }
    if (content.includes('\0')) {
      return res.status(400).json({ error: 'Steering content contains invalid null bytes.' });
    }
    if (Buffer.byteLength(content, 'utf-8') > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Steering content exceeds maximum allowed size of 2MB.' });
    }
    const result = await updateAgentSteering(content);
    res.json(result);
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ error: err.message });
  }
});

// ── Workspace Hierarchy & File Ops ──────────────────────────────

router.get('/workspace/tree', requireAuthIfConfigured, async (req, res) => {
  try {
    const tree = await listWorkspaceTree();
    res.json(tree);
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/drive/read', requireAuthIfConfigured, async (req, res) => {
  try {
    let targetId = req.query.fileId;
    const rawPath = req.query.path;
    let resolvedFromPath = false;
    if (!targetId && rawPath) {
      targetId = await resolvePathToId(String(rawPath));
      resolvedFromPath = true;
      if (!targetId) {
        return res.status(404).json({ error: `File not found in workspace at path: "${rawPath}"` });
      }
    }
    if (!targetId) {
      return res.status(400).json({ error: 'Must provide fileId or path query parameter.' });
    }
    const data = await readDriveFile(targetId, { enforceWorkspace: !resolvedFromPath });
    res.json({
      id: data.meta.id,
      name: data.meta.name,
      mimeType: data.meta.mimeType,
      webViewLink: data.meta.webViewLink,
      content: data.content
    });
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/drive/write', requireAuthIfConfigured, async (req, res) => {
  try {
    const { path: rawPath, content, mimeType } = req.body || {};
    if (!rawPath) return res.status(400).json({ error: 'Path is required.' });
    const bodyStr = String(content ?? '');
    if (Buffer.byteLength(bodyStr, 'utf-8') > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Document content exceeds maximum allowed size of 2MB.' });
    }

    const cleanPath = sanitizeWorkspacePath(rawPath);
    const result = await writeDriveFile({ path: cleanPath, content: bodyStr, mimeType });
    res.json(result);
  } catch (err) {
    logRouteError(req, err);
    res.status(400).json({ error: err.message });
  }
});

router.delete('/drive/file', requireAuthIfConfigured, async (req, res) => {
  try {
    const fileId = req.body?.fileId || req.query?.fileId;
    const rawPath = req.body?.path || req.query?.path;
    if (!fileId && !rawPath) {
      return res.status(400).json({ error: 'Must provide fileId or path.' });
    }
    const result = await deleteDriveFile({ fileId, path: rawPath });
    res.json(result);
  } catch (err) {
    logRouteError(req, err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/drive/overview', requireAuthIfConfigured, async (req, res) => {
  try {
    const overview = await getDriveOverview();
    res.json(overview);
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ error: err.message });
  }
});

// ── Google Calendar & Gmail Extension Endpoints ─────────────────

router.get('/calendar/calendars', requireAuthIfConfigured, async (req, res) => {
  try {
    const data = await listUserCalendars();
    res.json(data);
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/calendar/provision-skylight', requireAuthIfConfigured, async (req, res) => {
  try {
    const result = await ensureSkylightCalendars();
    res.json(result);
  } catch (err) {
    logRouteError(req, err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/calendar/events', requireAuthIfConfigured, async (req, res) => {
  try {
    const maxResults = parseInt(req.query.limit || '10', 10);
    const timeMin = req.query.timeMin || null;
    const query = req.query.q || '';
    const calendarId = req.query.calendarId || req.query.calendar || 'primary';
    const events = await listCalendarEvents({ maxResults, timeMin, query, calendarId });
    res.json({ calendarId, events });
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/calendar/events', requireAuthIfConfigured, async (req, res) => {
  try {
    const { summary, startTime, endTime, description, location, calendarId, calendar } = req.body || {};
    const event = await createCalendarEvent({
      summary,
      startTime,
      endTime,
      description,
      location,
      calendarId: calendarId || calendar || 'primary'
    });
    res.json({ event });
  } catch (err) {
    logRouteError(req, err);
    res.status(400).json({ error: err.message });
  }
});

router.get('/gmail/messages', requireAuthIfConfigured, async (req, res) => {
  try {
    const query = req.query.q || 'is:inbox';
    const maxResults = parseInt(req.query.limit || '5', 10);
    const messages = await searchGmailMessages({ query, maxResults });
    res.json({ messages });
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/gmail/drafts', requireAuthIfConfigured, async (req, res) => {
  try {
    const { to, subject, body, sendImmediately = false } = req.body || {};
    const result = await createOrSendGmail({ to, subject, body, sendImmediately });
    res.json(result);
  } catch (err) {
    logRouteError(req, err);
    res.status(400).json({ error: err.message });
  }
});

router.post('/gmail/send', requireAuthIfConfigured, async (req, res) => {
  try {
    const { to, subject, body } = req.body || {};
    const result = await createOrSendGmail({ to, subject, body, sendImmediately: true });
    res.json(result);
  } catch (err) {
    logRouteError(req, err);
    res.status(400).json({ error: err.message });
  }
});

// ── RAG Indexing & Search ───────────────────────────────────────

router.post('/rag/sync', requireAuthIfConfigured, async (req, res) => {
  try {
    const syncResult = await syncDriveRag();
    res.json(syncResult);
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/rag/search', requireAuthIfConfigured, async (req, res) => {
  try {
    const rawQuery = String(req.query.q || '').slice(0, 300);
    if (!rawQuery.trim()) {
      return res.status(400).json({ error: 'Query parameter q is required.' });
    }
    const limit = Math.min(Math.max(1, parseInt(req.query.limit || '5', 10)), 30);
    const results = await searchDriveRag(rawQuery, { limit });
    res.json({ query: rawQuery, results });
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/rag/stats', requireAuthIfConfigured, (req, res) => {
  try {
    const { documentsIndexed, totalChunks, lastSync } = getRagIndexStats();

    res.json({
      documentsIndexed,
      totalChunks,
      lastSync
    });
  } catch (err) {
    logRouteError(req, err);
    res.status(500).json({ error: err.message });
  }
});

// ── MCP Config Info ─────────────────────────────────────────────

router.get('/mcp/info', (req, res) => {
  const sseUrl = `${config.baseUrl}/mcp/sse`;
  res.json({
    name: 'g-krusch',
    version: '1.0.0',
    description: 'Google Drive, Calendar & Gmail Extension Hub for AI Agents',
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
      'get_workspace_status',
      'list_calendar_events',
      'create_calendar_event',
      'search_gmail_messages',
      'compose_gmail_message'
    ]
  });
});

export default router;

