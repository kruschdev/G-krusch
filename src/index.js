/**
 * G-Krusch (G-Crush) — Google Drive for AI Agents & Agentic Workspaces
 * 
 * Master Orchestrator:
 * - Express REST API & Web Dashboard
 * - Model Context Protocol (MCP) Server (SSE + Stdio)
 * - Google Drive Dynamic agent.md Steering & Hybrid Vector RAG Engine
 * - Keepalive Heartbeats & Process Guardians
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import config from './config.js';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import {
  createCorsOptions,
  requireAuthIfConfigured,
  securityHeadersMiddleware,
  createRateLimiter
} from './lib/auth-guard.js';
import { createMcpServer } from './mcp/tools.js';

const toolkitStreamingUrl = new URL('../../../lib/streaming.js', import.meta.url);

function createStandaloneSseStream(res, req, options = {}) {
  const heartbeatMs = options.heartbeatMs ?? 15000;
  if (!res.headersSent) {
    res.setHeader('X-Accel-Buffering', 'no');
  }

  let closed = Boolean(res.writableEnded || res.destroyed || req?.aborted);
  let cleaned = false;
  let heartbeat = null;

  const stopHeartbeat = () => {
    closed = true;
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    req?.off?.('close', onReqClose);
    res?.off?.('close', onResClose);
  };

  const onReqClose = () => {
    if (req?.complete === true && res?.socket && !res.socket.destroyed && !res.destroyed) {
      return;
    }
    stopHeartbeat();
  };

  const onResClose = () => {
    stopHeartbeat();
  };

  const close = () => {
    stopHeartbeat();
    if (!res.writableEnded && !res.destroyed) {
      try { res.end(); } catch {}
    }
  };

  if (!closed) {
    req?.on?.('close', onReqClose);
    res?.on?.('close', onResClose);

    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        if (closed || res.writableEnded || res.destroyed) {
          stopHeartbeat();
          return;
        }
        if (res.headersSent) {
          try {
            res.write(': ping\n\n');
          } catch {
            stopHeartbeat();
          }
        }
      }, heartbeatMs);
      heartbeat.unref?.();
    }
  }

  return {
    isClosed: () => closed,
    close
  };
}

let sseResponse = createStandaloneSseStream;
try {
  if (fs.existsSync(toolkitStreamingUrl)) {
    const streamingMod = await import(toolkitStreamingUrl.href);
    if (typeof streamingMod.sseResponse === 'function') {
      sseResponse = streamingMod.sseResponse;
    }
  }
} catch {
  // Fall through to package specifier if sibling lib/ lacks dependencies
}
if (sseResponse === createStandaloneSseStream) {
  try {
    const pkgStreamingMod = await import('@krusch/toolkit/streaming');
    if (typeof pkgStreamingMod.sseResponse === 'function') {
      sseResponse = pkgStreamingMod.sseResponse;
    }
  } catch {
    // Standalone CI fallback when @krusch/toolkit/streaming is unavailable
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isStdio = process.argv.includes('--stdio');

if (isStdio) {
  // Stdio transport for direct CLI/IDE subprocess runner
  const mcpServer = createMcpServer();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error('[G-Krusch] MCP Server running on Stdio transport');
} else {
  // ── Express App Setup ──────────────────────────────────────────

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeadersMiddleware);
  app.use(cors(createCorsOptions()));
  app.use(express.json({ limit: '2mb' }));

  const apiLimiter = createRateLimiter({ windowMs: 60000, maxRequests: 120 });

  // Mount API & Auth routes
  app.use('/auth', apiLimiter, authRoutes);
  app.use('/api', apiLimiter, apiRoutes);

  // Serve static dashboard assets from client/dist (or client/)
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  const clientPublic = path.join(__dirname, '..', 'client');
  app.use(express.static(clientDist));
  app.use(express.static(clientPublic));

  // ── MCP SSE Transport with Heartbeat Guard ─────────────────────

  /** @type {Map<string, { transport: SSEServerTransport, res: express.Response, server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, sseStream: { close: () => void, isClosed?: () => boolean } }>} */
  const transports = new Map();
  const MAX_CONCURRENT_TRANSPORTS = 50;

  app.get('/mcp/sse', apiLimiter, requireAuthIfConfigured, async (req, res) => {
    for (const [id, entry] of transports) {
      if (entry.res.writableEnded || entry.res.destroyed || entry.sseStream?.isClosed?.()) {
        try { entry.sseStream?.close?.(); } catch {}
        try { entry.server?.close?.(); } catch {}
        transports.delete(id);
      }
    }

    if (transports.size >= MAX_CONCURRENT_TRANSPORTS) {
      return res.status(429).json({ error: 'Max concurrent MCP SSE connections reached.' });
    }

    const sseStream = sseResponse(res, req, { deferHeaders: true, retryMs: 0, heartbeatMs: 15000, corsOrigin: false, tool: 'g-krusch.mcp_sse' });

    const sessionServer = createMcpServer();
    const transport = new SSEServerTransport('/mcp/messages', res);
    transports.set(transport.sessionId, { transport, res, server: sessionServer, sseStream });

    res.on('close', () => {
      try { sseStream.close(); } catch {}
      try { sessionServer.close?.(); } catch (err) { console.error('SSE session close error:', err); }
      transports.delete(transport.sessionId);
    });

    try {
      await sessionServer.connect(transport);
    } catch (err) {
      console.warn('[MCP SSE Connect Error]:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to establish MCP SSE session' });
      }
      try { sseStream.close(); } catch {}
      try { sessionServer.close?.(); } catch {}
      transports.delete(transport.sessionId);
    }
  });

  app.post('/mcp/messages', apiLimiter, requireAuthIfConfigured, async (req, res) => {
    const sessionId = req.query.sessionId;
    const entry = transports.get(sessionId);

    if (entry && entry.transport) {
      try {
        await entry.transport.handlePostMessage(req, res, req.body);
      } catch (err) {
        console.error('[MCP Transport Message Error]:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to process MCP message', details: err.message });
        }
      }
    } else {
      res.status(503).json({ error: 'SSE transport not found for session' });
    }
  });


  // Fallback route for SPA dashboard
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/mcp')) {
      return next();
    }
    const htmlPath = path.join(clientPublic, 'index.html');
    res.sendFile(htmlPath);
  });

  // ── Boot Server ───────────────────────────────────────────────

  const bindHost = config.host || '127.0.0.1';
  const server = app.listen(config.port, bindHost, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 G-Krusch Hub running at: http://${bindHost}:${config.port}`);
    console.log(`📡 MCP SSE Transport active at: http://${bindHost}:${config.port}/mcp/sse`);
    console.log(`🔐 Google OAuth Endpoint: http://${bindHost}:${config.port}/auth/google`);
    console.log(`🛡️ Process hardening & SSE keepalives initialized`);
    console.log(`======================================================\n`);
  });

  // If GOOGLE_REDIRECT_URI uses a different localhost port (e.g. :3500 from Google Cloud Console),
  // bind a secondary listener on that port so the OAuth callback completes seamlessly.
  let oauthBridgeServer = null;
  try {
    const redirectParsed = new URL(config.google.redirectUri);
    const redirectPort = parseInt(redirectParsed.port, 10);
    if (redirectPort && redirectPort !== config.port && (redirectParsed.hostname === 'localhost' || redirectParsed.hostname === '127.0.0.1')) {
      oauthBridgeServer = app.listen(redirectPort, '127.0.0.1', () => {
        console.log(`🔗 Google OAuth Callback Bridge active at: ${config.google.redirectUri}`);
      });
      oauthBridgeServer.on('error', (err) => {
        console.warn(`[G-Krusch] Could not bind OAuth callback bridge on port ${redirectPort}:`, err.message);
      });
    }
  } catch {
    // Non-fatal
  }

  // Graceful shutdown
  const gracefulShutdown = (signal) => {
    console.log(`\n[G-Krusch] Received ${signal}, closing server...`);

    for (const [id, entry] of transports) {
      try { entry.sseStream?.close?.(); } catch {}
      try { entry.server?.close?.(); } catch {}
      try { entry.transport.close?.(); } catch {}
      transports.delete(id);
    }

    if (oauthBridgeServer) {
      try { oauthBridgeServer.close(); } catch {}
    }

    server.close(() => {
      console.log('[G-Krusch] Server closed cleanly.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Global uncaught handlers to prevent silent process crashes
  process.on('unhandledRejection', (reason) => {
    console.error('[G-Krusch Guardian] Unhandled Promise Rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[G-Krusch Guardian] Uncaught Exception:', err);
  });
}
