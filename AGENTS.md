# G-Krusch — Agent Operating Manual (`AGENTS.md`)

> **Sovereign Google Workspace Hub & MCP Bridge**: Standard operating manual, safety boundaries, and native Workspace format contracts for agents interacting with G-Krusch (`projects/g-krusch`).

---

## 🛑 Hazards & Protection Policy (`INV-01` – `INV-14`)

1. **Workspace Boundary Enforcement (`INV-04`)**: Never read or trash files outside the provisioned `G-Krusch` Google Drive folder hierarchy (`isFileInWorkspace`). Path traversal (`..`), control characters, and sensitive secret filenames (`.env`, `.git`, `id_rsa`, `.pem`) are strictly blocked (`sanitizeWorkspacePath`).
2. **Hermetic Test Isolation (`INV-01`)**: Running `npm test` automatically routes SQLite to an isolated temporary file (`os.tmpdir()/gcrush-test-<pid>.db`). Tests must NEVER mutate the production database (`data/gcrush.db`).
3. **Zero Hardcoded Host Paths or PII (`INV-02`, `INV-12`)**: Never hardcode personal email addresses or host home directory paths in source, tests, or client files.
4. **Native MIME-Type Disambiguation (`INV-14`)**: When updating or resolving files in Google Drive (`writeDriveFile`, `resolvePathToId`), native Google Workspace targets (`application/vnd.google-apps.{presentation|document|spreadsheet}`) must match existing files of the exact same `mimeType` so same-named Docs, Sheets, and Slides never collide.

---

## 🖥️ Hardware Map & Node Target

| Node | Service / Daemon | Bind Address & Port | Transports | Primary Storage |
|------|------------------|---------------------|------------|-----------------|
| **krusch** | `g-krusch.service` (systemd user) | `127.0.0.1:5446` (OAuth bridge `:3500`) | MCP Stdio (`--stdio`), MCP SSE (`/mcp/sse`), REST (`/api/*`) | SQLite WAL + FTS5 (`data/gcrush.db`) |

---

## ⚡ Quick Start

```bash
npm test                                    # Run all 32 hermetic unit & hardening tests
npm run doctor                              # Run 12-point production diagnostic check
systemctl --user status g-krusch.service    # Check live daemon status on :5446
systemctl --user restart g-krusch.service   # Restart daemon after code changes
curl -s http://127.0.0.1:5446/api/health    # Verify SQLite, OAuth, Nexus PDF & extensions
```

---

## 🏗️ 3-Layer Architecture & Native Workspace Builders

1. **Transport Layer**:
   - `src/index.js`: Express HTTP server (`127.0.0.1:5446`), per-session MCP SSE transport (`/mcp/sse`, `/mcp/messages`), and `--stdio` mode.
   - `src/mcp/tools.js`: Registers all 12 MCP tools with explicit read/destructive/idempotent/openWorld behavioral annotations.
   - `src/routes/api.js` & `src/routes/auth.js`: REST endpoints for Krusch Companion (`:3004`) and OAuth 2.0 CSRF-validated flow.
2. **Domain Layer**:
   - `src/lib/drive.js`: Workspace folder provisioning, `resolvePathToId`, `readDriveFile`, `writeDriveFile`, and `deleteDriveFile`.
   - `src/lib/slides.js`: Zero-dependency native Google Workspace payload builders (`prepareWorkspaceWritePayload`, `buildPptxBuffer`, `markdownToGoogleDocHtml`, `markdownTableOrTextToCsv`, `inferWorkspaceMimeFromPath`).
   - `src/lib/rag.js` & `src/lib/pdf.js`: 3-tier 1,024-dim embedding cascade (`bge-large:latest` $\rightarrow$ `gemini-embedding-001` $\rightarrow$ 64-dim offline fallback), hybrid vector + FTS5 BM25 search, and 3-tier PDF page-citation parser (Krusch-Nexus $\rightarrow$ Poppler $\rightarrow$ pure-JS native).
   - `src/lib/steering.js` & `src/lib/extensions.js`: Cloud-synced `agent.md` steering cache and Google Calendar / RFC-2822 Gmail extensions.
3. **Persistence & Security Layer**:
   - `src/lib/db.js` & `src/lib/crypto.js`: SQLite WAL (`busy_timeout = 5000`), FTS5 self-healing (`ensureFtsSync`), and NIST 12-byte IV AES-256-GCM token encryption at rest.
   - `src/lib/auth-guard.js`, `src/lib/path-utils.js`, `src/lib/mutex.js`: Constant-time API key auth, CORS origin lockdown, sliding-window rate limiter, Drive query escaping, and `AsyncKeyedMutex`.

---

## 📄 Creating Native Google Slides, Docs & Sheets (`write_drive_file`)

`write_drive_file` creates and updates native Google Workspace files via Google Drive API v3 server-side conversion with **zero extra Cloud APIs or OAuth scopes**:

| Target Format | Trigger (`path` suffix or `mime_type`) | Input Content Format | Drive Import Pipeline |
|---------------|----------------------------------------|----------------------|-----------------------|
| **Google Slides** | `.slides`, `.gslides`, `.pptx` or `mime_type: "slides"` / `"application/vnd.google-apps.presentation"` | `---`-separated Markdown slides (`# Title`, `- Bullet`, `Notes: Speaker notes`) | In-memory 16:9 OpenXML `.pptx` ZIP (`ppt/slides/slide{N}.xml` + `ppt/notesSlides/notesSlide{N}.xml`) $\rightarrow$ `application/vnd.google-apps.presentation` |
| **Google Docs** | `.gdoc` or `mime_type: "docs"` / `"application/vnd.google-apps.document"` | Rich Markdown (`#` headings, `<ul>`/`<ol>`, `<blockquote>`, ```` ``` ```` code blocks, `\| A \| B \|` tables) or HTML | Semantic HTML (`text/html`) $\rightarrow$ `application/vnd.google-apps.document` |
| **Google Sheets** | `.gsheet`, `.sheet` or `mime_type: "sheets"` / `"application/vnd.google-apps.spreadsheet"` | Markdown pipe table (`\| Col A \| Col B \|`) or RFC-4180 CSV | RFC-4180 CSV (`text/csv`) $\rightarrow$ `application/vnd.google-apps.spreadsheet` |
| **Markdown / Text** | `.md`, `.txt`, `.json` (default `mime_type: "text/markdown"`) | Raw UTF-8 text or Markdown | Stored directly with specified MIME type |

---

## 🛠️ MCP Tool Surface Area (12 Tools)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `get_agent_steering` | Fetches live `agent.md` rules from Drive | `force_refresh` (bool) |
| `search_drive_rag` | Semantic vector + FTS5 BM25 RAG across Drive docs | `query` (string), `limit` (int) |
| `read_drive_file` | Reads any Doc, Sheet, Slides deck, Markdown, or PDF from Drive | `file_id` or `path` (supports `.gdoc`, `.gsheet`, `.slides`) |
| `write_drive_file` | Creates/updates Markdown, Google Docs, Sheets, or Slides in Drive | `path`, `content`, `mime_type` |
| `delete_drive_file` | Safely trashes a file inside the Drive workspace and purges RAG | `file_id` or `path` |
| `list_drive_workspace` | Recursive tree view of workspace folders (`context/`, `memory/`, `output/`) | None |
| `sync_drive_rag` | Triggers incremental vector + FTS5 embedding sync | None |
| `get_workspace_status` | Reports OAuth health, indexed counts, and storage quota | None |
| `list_calendar_events` | Lists upcoming Google Calendar events | `max_results`, `time_min`, `query` |
| `create_calendar_event` | Schedules a new Google Calendar event | `summary`, `start_time`, `end_time`, `description`, `location` |
| `search_gmail_messages` | Searches Gmail messages using standard operators | `query`, `max_results` |
| `compose_gmail_message` | Creates an RFC-2822/RFC-2047 Gmail draft or sends email | `to`, `subject`, `body`, `send_immediately` |

---

## 🗺️ Key File Map

- `src/index.js` — Express HTTP server, MCP SSE session manager, and `--stdio` entrypoint
- `src/config.js` — Layered configuration and hermetic test DB routing
- `src/mcp/tools.js` — 12 MCP tool registrations and annotations
- `src/routes/api.js` — REST API endpoints (`/api/health`, `/api/drive/*`, `/api/rag/*`, `/api/calendar/*`, `/api/gmail/*`)
- `src/routes/auth.js` — Google OAuth 2.0 login and CSRF-verified callback handler
- `src/lib/drive.js` — Google Drive v3 client, path resolution, workspace boundary guard, and read/write/delete handlers
- `src/lib/slides.js` — Zero-dependency OpenXML `.pptx` (Slides), semantic HTML (Docs), and RFC-4180 CSV (Sheets) builders
- `src/lib/rag.js` — 1,024-dim embedding cascade, transactional SQLite/FTS5 indexer, and hybrid search
- `src/lib/pdf.js` — Magic-byte pre-spool validator and 3-tier PDF citation extractor
- `src/lib/steering.js` — `agent.md` Drive synchronization and SQLite cache
- `src/lib/extensions.js` — Google Calendar and RFC-2822 / RFC-2047 Gmail helpers
- `src/lib/db.js` — SQLite WAL initialization, FTS5 self-healing, and encrypted credential persistence
- `src/lib/crypto.js` — AES-256-GCM 12-byte NIST IV encryption and decryption
- `src/lib/auth-guard.js` — CORS allowlist, timing-safe API key middleware, security headers, and rate limiter
- `src/lib/path-utils.js` — Path traversal prevention and Drive query literal escaping
- `src/lib/mutex.js` — FIFO `AsyncKeyedMutex` concurrency lock
- `client/index.html` & `client/main.js` — Web dashboard UI
- `test/smoke.test.js` & `test/hardening.test.js` — 32 unit and security hardening tests
