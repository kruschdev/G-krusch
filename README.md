<p align="center">
  <h1 align="center">☁️ G-Krusch — Sovereign Google Workspace Hub & MCP Bridge</h1>
  <p align="center">
    <strong>Google Drive RAG, Cloud-Synced <code>agent.md</code> Steering, Calendar & Gmail Extensions for AI Agents</strong><br>
    <em>Powers autonomous IDE agents (via MCP) and <a href="https://github.com/kruschdev/krusch-companion">Krusch Companion</a>'s <code>&lt;holodata&gt;</code> Agentic Proxy (via REST on <code>:5446</code>).</em>
  </p>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-green.svg?style=flat-square" alt="Node.js"></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-1.12%2B-blue.svg?style=flat-square" alt="MCP"></a>
  <a href="https://github.com/kruschdev/krusch-companion"><img src="https://img.shields.io/badge/Bridge-Krusch%20Companion-cyan.svg?style=flat-square" alt="Krusch Companion Bridge"></a>
  <img src="https://img.shields.io/badge/tests-25%20passed-brightgreen.svg?style=flat-square" alt="Tests Passed">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-yellow.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://m8ven.ai/mcp/kruschdev/g-krusch?s=readme"><img src="https://m8ven.ai/badge/mcp/kruschdev/g-krusch" alt="M8ven Score"></a>
</p>
<!-- [![M8ven Score](https://m8ven.ai/badge/mcp/kruschdev/g-krusch)](https://m8ven.ai/mcp/kruschdev/g-krusch?s=readme) -->

---

## 🧠 Why G-Krusch?

Most AI agents are trapped either in ephemeral context windows or isolated local folders that you can't easily access when away from your workstation. **G-Krusch** bridges the gap between humans, coding agents, and personal assistants (`krusch-companion`) across your Google Workspace:

1. **`agent.md` Cloud-Synced Steering**: Edit your agent rules, project priorities, and personas from your phone, tablet, or web browser directly in Google Drive. When an agent boots, it dynamically pulls the latest instructions via `get_agent_steering` (`GET /api/steering`).
2. **Hybrid Vector & FTS5 BM25 Drive RAG**: Queries your Google Docs, PDFs, notes, and specs using dense semantic embeddings (Gemini `text-embedding-004` / local Ollama `bge-large:latest` / deterministic 64-dim fallback) fused with SQLite FTS5 Porter-stemmed BM25 keyword search.
3. **Page-Faithful PDF Extraction**: Integrates directly with **Krusch-Nexus** (`pdftotext -bbox-layout` + Poppler fallback) to extract multi-page PDFs with page citations (`[contract.pdf p.1]`).
4. **Two-Way Agent Filesystem**: Agents can read project briefs from `context/`, check decision logs in `memory/`, and write deliverables directly into `output/` on Google Drive.
5. **Google Calendar & Gmail Extensions**: Exposes hardened REST endpoints (`/api/calendar/events`, `/api/gmail/messages`, `/api/gmail/drafts`, `/api/gmail/send`) so **Krusch Companion** can check your schedule, book appointments, search your inbox, and compose RFC-2822 / RFC-2047 emails.

---

## 📁 Workspace Structure in Google Drive

When G-Krusch connects to your Google Drive, it manages a dedicated workspace folder (defaults to `G-Krusch`):

```
Google Drive /
  └── G-Krusch/
        ├── agent.md             # Authoritative steering & invariants (edit anywhere)
        ├── context/             # Domain knowledge, architectural specs, SOPs
        ├── memory/              # Decisions, invariants, project logs
        └── output/              # Agent-generated artifacts, reports, proposals
```

---

## 🛡️ Security & Concurrency Hardening

* **AES-256-GCM Encrypted Token Vault (`src/lib/crypto.js` & `src/lib/db.js`)**: OAuth 2.0 access and refresh tokens are encrypted at rest in SQLite WAL using AES-256-GCM with NIST SP 800-38D 12-byte (96-bit) IVs and 16-byte authentication tags (plus transparent legacy 16-byte IV decryption).
* **OAuth 2.0 CSRF State & CORS Origin Lockdown (`src/lib/oauth.js` & `src/lib/auth-guard.js`)**: Generates one-time 32-byte CSRF `state` tokens with constant-time validation on `/auth/google/callback`, and restricts browser CORS requests to trusted localhost, RFC1918 LAN, and Tailscale (`100.64.0.0/10`) origins.
* **FIFO Keyed Mutex & Atomic SQLite Transactions (`src/lib/mutex.js` & `src/lib/rag.js`)**: `AsyncKeyedMutex` serializes concurrent OAuth token refreshes, workspace provisioning, per-path writes, and RAG indexing, while `saveIndexedDocumentTransactional` commits document chunks and FTS5 indices atomically with automatic FTS5 self-healing (`ensureFtsSync`).
* **Path Traversal, Drive Query Escaping & Workspace Boundary Guard (`src/lib/path-utils.js` & `src/lib/drive.js`)**: Blocks `..`, control characters, and sensitive dotfiles (`.env`, `.git`, `id_rsa`, `.pem`), escapes backslashes and quotes in Drive API queries, and verifies workspace ancestry before trashing any file by `fileId`.
* **CRLF Header Injection Shield & RFC 2047 UTF-8 Encoder (`src/lib/extensions.js`)**: Strips CR/LF and control characters from email headers, validates recipient addresses, and encodes non-ASCII subjects using `=?UTF-8?B?...?=`.
* **Constant-Time API Key Guard (`src/lib/auth-guard.js`)**: Uses `crypto.timingSafeEqual` when `API_KEY` or `GCRUSH_SECRET` is configured to protect workspace and MCP endpoints against timing side-channel attacks, paired with HTML escaping (`escapeHtml`) on OAuth callback pages.

---

## ⚡ Quick Start & Diagnostics

### 1. Installation
```bash
git clone https://github.com/kruschdev/G-krusch.git
cd G-krusch
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` and provide your Google OAuth credentials (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) and optional `GEMINI_API_KEY`:
```bash
cp .env.example .env
```

### 3. Run Production Diagnostic Doctor & Tests
*(All 25 unit & hardening tests run hermetically against an isolated temporary SQLite database with zero external credentials required)*
```bash
# Run 9-point production diagnostic check (Node 22+, SQLite WAL, FTS5, AES-256-GCM, OAuth, Nexus PDF, MCP, Workspace Extensions)
npm run doctor

# Run all 25 unit & hardening tests
npm test
```

### 4. Launch G-Krusch (CLI or Systemd User Service)
```bash
# Start directly on http://localhost:5446
npm start

# Or manage via systemd user service on port 5446
systemctl --user status g-krusch.service
systemctl --user restart g-krusch.service
```
Endpoints:
- **Web Dashboard**: `http://localhost:5446`
- **Health & Telemetry**: `http://localhost:5446/api/health`
- **MCP SSE Transport**: `http://localhost:5446/mcp/sse`
- **Google OAuth Flow**: `http://localhost:5446/auth/google`

---

## 🛠️ MCP Integration (Antigravity, Cursor, Claude Code)

### SSE Transport (`http://localhost:5446/mcp/sse`)
```json
{
  "mcpServers": {
    "g-krusch": {
      "url": "http://localhost:5446/mcp/sse"
    }
  }
}
```

### Stdio Transport
```json
{
  "mcpServers": {
    "g-krusch": {
      "command": "node",
      "args": ["/absolute/path/to/G-krusch/src/index.js", "--stdio"]
    }
  }
}
```

---

## 🧰 Exposed MCP Tools (12 Tools)

| Tool | Description |
|------|-------------|
| `get_agent_steering` | Retrieves active `agent.md` steering directives directly from Google Drive. |
| `search_drive_rag` | Hybrid semantic vector + FTS5 BM25 keyword search across all indexed files in Google Drive. |
| `read_drive_file` | Reads any document from Drive (exports Google Docs & PDFs cleanly to Markdown). |
| `write_drive_file` | Writes or updates a file in the workspace (saves reports, notes, artifacts). |
| `delete_drive_file` | Soft-trashes a file in the G-Krusch Google Drive workspace. |
| `list_drive_workspace`| Lists all folders and files in the G-Krusch Drive hierarchy. |
| `sync_drive_rag` | Triggers an incremental scan and embedding sync of Google Drive files. |
| `get_workspace_status` | Reports OAuth connection health, indexed file count, and cached embedding statistics. |
| `list_calendar_events` | Lists upcoming events from the user's primary Google Calendar with optional query and time window. |
| `create_calendar_event` | Schedules a new event or reservation hold on the user's primary Google Calendar. |
| `search_gmail_messages` | Searches Gmail messages using standard Gmail operators (`is:unread`, `from:...`). |
| `compose_gmail_message` | Creates an RFC-2822 / RFC-2047 sanitized Gmail draft or sends an email immediately (`send_immediately: true`). |

---

## ☁️ Google Workspace Extension REST APIs (Krusch Companion Bridge)

In addition to its MCP server, G-Krusch exposes REST Extension APIs on port `5446` consumed by [`krusch-companion`](https://github.com/kruschdev/krusch-companion)'s `<holodata>` Dual-Engine Agentic Proxy:

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Reports SQLite WAL health, OAuth status, Krusch-Nexus PDF engine status, RAG counts, and active extensions. |
| `GET` | `/api/steering` | Retrieves `agent.md` cloud steering directives (`?refresh=true` to bypass cache). |
| `PUT` | `/api/steering` | Updates `agent.md` steering content in Google Drive. |
| `GET` | `/api/workspace/tree` | Returns recursive folder & file tree for the `G-Krusch` Google Drive workspace. |
| `GET` | `/api/rag/search?q=...` | Hybrid semantic + FTS5 BM25 search across indexed Google Drive documents (`gkrusch_drive`). |
| `POST`| `/api/rag/sync` | Incrementally indexes workspace documents into SQLite vector + FTS5 tables. |
| `GET` | `/api/drive/read?path=...` | Reads a Google Drive file or exports a Google Doc/PDF to Markdown (`gkrusch_drive`). |
| `POST`| `/api/drive/write` | Creates or updates a Markdown document inside the `G-Krusch` Drive workspace (`gkrusch_drive`). |
| `DELETE`| `/api/drive/file` | Soft-trashes a file by `path` or `fileId`. |
| `GET` | `/api/calendar/events` | Lists upcoming events from the user's primary Google Calendar (`gkrusch_calendar`). |
| `POST`| `/api/calendar/events` | Schedules a new Google Calendar event (`{ summary, startTime, endTime, description }`) (`gkrusch_calendar`). |
| `GET` | `/api/gmail/messages?q=...` | Searches Gmail messages and returns sender, subject, date, and snippet previews (`gkrusch_gmail`). |
| `POST`| `/api/gmail/drafts` | Encodes a CRLF-sanitized RFC-2822 / RFC-2047 MIME message and creates a Gmail draft (`sendImmediately: false`) or sends immediately (`gkrusch_gmail` / `concierge_reservation`). |
| `POST`| `/api/gmail/send` | Sends a CRLF-sanitized RFC-2822 / RFC-2047 MIME email immediately via Gmail (`sendImmediately: true`). |

---

## 📄 License
MIT © [kruschdev](https://github.com/kruschdev). Part of the Krusch Homelab Sovereign AI Ecosystem.


