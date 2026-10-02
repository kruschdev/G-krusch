/**
 * G-Krusch (G-Crush) — Google Drive for AI Agents & Agentic Workspaces
 * 
 * Master Orchestrator:
 * - Express REST API & Web Dashboard
 * - Model Context Protocol (MCP) Server (SSE + Stdio)
 * - Google Drive Dynamic agent.md Steering & Vector RAG Engine
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
  app.use(express.json());

  // Mount API & Auth routes
  app.use('/auth', authRoutes);
  app.use('/api', apiRoutes);

  // Serve static dashboard assets from client/dist (or client/)
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  const clientPublic = path.join(__dirname, '..', 'client');
  app.use(express.static(clientDist));
  app.use(express.static(clientPublic));

  // ── MCP SSE Transport ─────────────────────────────────────────

  /** @type {Map<string, SSEServerTransport>} */
  const transports = new Map();

  app.get('/mcp/sse', async (req, res) => {
    const transport = new SSEServerTransport('/mcp/messages', res);
    transports.set(transport.sessionId, transport);

    res.on('close', () => {
      transports.delete(transport.sessionId);
    });

    await mcpServer.connect(transport);
  });

  app.post('/mcp/messages', async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);

    if (transport) {
      await transport.handlePostMessage(req, res);
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
    console.log(`======================================================\n`);
  });

  // Graceful shutdown
  const gracefulShutdown = (signal) => {
    console.log(`\n[G-Krusch] Received ${signal}, closing server...`);
    for (const [id, transport] of transports) {
      try { transport.close?.(); } catch {}
      transports.delete(id);
    }
    server.close(() => {
      console.log('[G-Krusch] Server closed cleanly.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
