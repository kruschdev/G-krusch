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
import path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import config from './config.js';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import { registerMcpTools } from './mcp/tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isStdio = process.argv.includes('--stdio');

// ── MCP Server Instance ──────────────────────────────────────────

const mcpServer = new McpServer({
  name: 'g-krusch',
  version: '1.0.0'
});

// Register all agentic Google Drive tools
registerMcpTools(mcpServer);

if (isStdio) {
  // Stdio transport for direct CLI/IDE subprocess runner
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error('[G-Krusch] MCP Server running on Stdio transport');
} else {
  // ── Express App Setup ──────────────────────────────────────────

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Mount API & Auth routes
  app.use('/auth', authRoutes);
  app.use('/api', apiRoutes);

  // Serve static dashboard assets from client/dist (or client/)
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  const clientPublic = path.join(__dirname, '..', 'client');
  app.use(express.static(clientDist));
  app.use(express.static(clientPublic));

  // ── MCP SSE Transport with Heartbeat Guard ─────────────────────

  /** @type {Map<string, { transport: SSEServerTransport, res: express.Response }>} */
  const transports = new Map();
  const MAX_CONCURRENT_TRANSPORTS = 50;

  // 15-second heartbeat ping to prevent proxy/firewall disconnects
  const heartbeatTimer = setInterval(() => {
    for (const [id, entry] of transports) {
      try {
        if (!entry.res.writableEnded) {
          entry.res.write(':keepalive\n\n');
        } else {
          transports.delete(id);
        }
      } catch {
        transports.delete(id);
      }
    }
  }, 15000);

  app.get('/mcp/sse', async (req, res) => {
    if (transports.size >= MAX_CONCURRENT_TRANSPORTS) {
      return res.status(429).json({ error: 'Max concurrent MCP SSE connections reached.' });
    }

    const transport = new SSEServerTransport('/mcp/messages', res);
    transports.set(transport.sessionId, { transport, res });

    res.on('close', () => {
      transports.delete(transport.sessionId);
    });

    await mcpServer.connect(transport);
  });

  app.post('/mcp/messages', async (req, res) => {
    const sessionId = req.query.sessionId;
    const entry = transports.get(sessionId);

    if (entry && entry.transport) {
      await entry.transport.handlePostMessage(req, res);
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

  const server = app.listen(config.port, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 G-Krusch (G-Crush) Hub running at: http://localhost:${config.port}`);
    console.log(`📡 MCP SSE Transport active at: http://localhost:${config.port}/mcp/sse`);
    console.log(`🔐 Google OAuth Endpoint: http://localhost:${config.port}/auth/google`);
    console.log(`🛡️ Process hardening & SSE keepalives initialized`);
    console.log(`======================================================\n`);
  });

  // Graceful shutdown
  const gracefulShutdown = (signal) => {
    console.log(`\n[G-Krusch] Received ${signal}, closing server...`);
    clearInterval(heartbeatTimer);

    for (const [id, entry] of transports) {
      try { entry.transport.close?.(); } catch {}
      transports.delete(id);
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
