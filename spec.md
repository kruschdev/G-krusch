# G-Krusch (G-Crush) Enterprise Security & Reliability Hardening Specification

- **Project**: `g-krusch` (`/home/krusch/homelab/projects/g-krusch`)
- **Protocol**: L0 Specification-First Refactor (`/spec-first-refactor`, arXiv: 2608.12440)
- **Date**: 2026-10-18
- **STATUS**: FROZEN

---

## 1. Core Invariants

### INV-01: Hermetic Test Database Isolation & FTS5 Self-Healing
1. Running `npm test` (`process.execArgv.includes('--test')` or `process.env.NODE_ENV === 'test'`) MUST NEVER open or mutate the production SQLite database (`./data/gcrush.db`).
2. `src/config.js` MUST automatically route test runs to an isolated temporary SQLite database (`os.tmpdir()/gcrush-test-<pid>.db`) unless `process.env.GCRUSH_TEST_DB_PATH` is explicitly set.
3. `getDb()` in `src/lib/db.js` MUST detect and self-heal FTS5 desynchronization on startup: if `rag_chunks` has rows (`COUNT(*) > 0`) while `rag_chunks_fts` has `0` rows (or differs in count), it MUST automatically rebuild `rag_chunks_fts` from `rag_chunks` inside an atomic SQLite transaction.

### INV-02: OAuth 2.0 CSRF State Validation & Zero Hardcoded PII
1. `src/lib/oauth.js` MUST NOT contain any hardcoded personal email addresses (such as `'ksruschman@gmail.com'`). `getAuthorizationUrl(loginHint)` MUST only include `login_hint` if `loginHint` or `process.env.GOOGLE_LOGIN_HINT` is explicitly provided.
2. `getAuthorizationUrl()` MUST generate a cryptographically random 32-byte hex `state` token (`crypto.randomBytes(32).toString('hex')`), store it with a 10-minute expiration window, and pass `state` in `client.generateAuthUrl(...)`.
3. `oauthCallbackHandler` in `src/routes/auth.js` MUST verify the OAuth `state` parameter using constant-time comparison (`verifyOAuthState`) when an active state token has been issued via `/auth/google`, rejecting mismatched or expired `state` values with HTTP `403`.

### INV-03: CORS Origin Lockdown & Comprehensive API/MCP Auth Guard
1. `src/index.js` MUST replace unrestricted `cors()` (`Access-Control-Allow-Origin: *`) with `createCorsOptions()` that permits requests with no `Origin` header (CLI, MCP stdio/SSE clients, server-to-server `krusch-companion`) and browser origins matching `localhost`, `127.0.0.1`, `[::1]`, Tailscale CGNAT (`100.64.0.0/10`), RFC1918 LAN (`192.168.x.x`, `10.x.x.x`), or explicit `process.env.CORS_ORIGINS`.
2. `requireAuthIfConfigured` in `src/lib/auth-guard.js` MUST guard all data-reading and mutating API routes (`/api/steering`, `/api/workspace/tree`, `/api/drive/*`, `/api/calendar/*`, `/api/gmail/*`, `/api/rag/*`) and MCP SSE endpoints (`/mcp/sse`, `/mcp/messages`) whenever `API_KEY` or `GCRUSH_SECRET` is configured, while keeping diagnostic health/status endpoints (`/api/health`, `/api/status`, `/api/mcp/info`, `/auth/status`) accessible for local liveness probes.

### INV-04: Google Drive Query Injection Prevention & Workspace Deletion Boundary
1. `src/lib/path-utils.js` MUST export `escapeDriveQueryLiteral(value)` (escaping `\` to `\\` prior to escaping `'` to `\'`) and `isValidDriveId(id)` (` boolean` matching `/^[a-zA-Z0-9_-]{5,128}$/`).
2. `src/lib/drive.js` MUST use `escapeDriveQueryLiteral` and `isValidDriveId` across all `drive.files.list` query strings (`q`).
3. `deleteDriveFile({ fileId, path })` in `src/lib/drive.js` MUST verify via parent traversal (`isFileInWorkspace(drive, targetId, rootId)`) that `targetId` resides inside the `G-Krusch` workspace folder hierarchy before trashing it, throwing an error if an out-of-workspace `fileId` is supplied.

### INV-05: AES-256-GCM Standard 12-Byte IV with Legacy 16-Byte Decryption Compatibility
1. `encrypt(text)` in `src/lib/crypto.js` MUST use a 12-byte (96-bit) random IV per NIST SP 800-38D (`IV_LENGTH = 12`).
2. `decrypt(encryptedText)` MUST validate hex IVs of 12 or 16 bytes and 16-byte authentication tags so existing encrypted credentials in `data/gcrush.db` remain 100% readable without re-authentication.

### INV-06: Atomic SQLite Transactions for RAG Sync & Fleet Embedding Standard
1. `indexSingleFile` in `src/lib/rag.js` MUST compute all chunk embeddings prior to mutating SQLite, and then execute the `rag_documents` upsert, `rag_chunks` replacement, and `rag_chunks_fts` replacement inside a single atomic `db.transaction(...)`.
2. `src/config.js` and `.env.example` MUST default `OLLAMA_MODEL` to `bge-large:latest` (aligned with the Homelab Multi-Family 5-GPU Fleet Standard).

### INV-07: Complete 12-Tool & Endpoint Documentation Synchronization
1. `AGENTS.md` and `client/index.html` MUST list all 12 MCP tools (`get_agent_steering`, `search_drive_rag`, `read_drive_file`, `write_drive_file`, `delete_drive_file`, `list_drive_workspace`, `sync_drive_rag`, `get_workspace_status`, `list_calendar_events`, `create_calendar_event`, `search_gmail_messages`, `compose_gmail_message`).
2. `client/main.js` MUST check `res.ok` / `data.error` on file creation (`POST /api/drive/write`) and surface errors to the user rather than silently closing the modal on failed writes.

### INV-08: Multi-Process SQLite Lock Resilience (`busy_timeout` & `synchronous`)
1. `getDb()` in `src/lib/db.js` MUST set `db.pragma('busy_timeout = 5000')` and `db.pragma('synchronous = NORMAL')` alongside `journal_mode = WAL` so concurrent Express (`:5446`) and `--stdio` MCP processes never fail with immediate `SQLITE_BUSY` errors.

### INV-09: PDF Temp File Path Traversal & CLI Argument Injection Guard
1. `parsePdfBuffer` in `src/lib/pdf.js` MUST sanitize the temporary filename via `sanitizePdfTempName(filename)` (stripping directory components with `path.basename`, replacing non-`[a-zA-Z0-9._-]` characters, and prefixing leading `-` characters) before writing to `tempDir` or invoking `pdftotext` / `krusch_nexus.cli`.

### INV-10: Bounded Embedding Network Timeouts & Offline Hermetic Test Mode
1. `generateEmbedding` in `src/lib/rag.js` MUST attach `AbortSignal.timeout(8000)` to Gemini embedding requests and `AbortSignal.timeout(5000)` to Ollama embedding requests so stalled sockets never hang the RAG mutex.
2. When `config.isTestRuntime` is `true` and `process.env.GCRUSH_TEST_LIVE_EMBEDDINGS !== 'true'`, `generateEmbedding` MUST use the deterministic 64-dimensional vector engine so `npm test` runs 100% offline with zero external API calls or network latency.

### INV-11: HTTP Security Headers, Sliding-Window Rate Limiter & Dependency Hygiene
1. `src/lib/auth-guard.js` MUST export `securityHeadersMiddleware` (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`) and `createRateLimiter({ windowMs, maxRequests })` (returning HTTP `429` with `Retry-After` header when exceeded), mounted in `src/index.js`.
2. Unused third-party dependencies (`pg`) MUST be removed from `package.json`.

---

## 2. Target Files

1. `src/config.js` — Hermetic test DB path detection, `bge-large:latest` default Ollama model, CORS config.
2. `src/lib/crypto.js` — 12-byte NIST SP 800-38D AES-256-GCM IV + strict tag/IV validation with legacy 16-byte IV decryption support.
3. `src/lib/db.js` — FTS5 self-healing check on startup (`ensureFtsSync`) + transactional helper support.
4. `src/lib/path-utils.js` — `escapeDriveQueryLiteral` and `isValidDriveId` exports.
5. `src/lib/auth-guard.js` — `isAllowedOrigin` CORS validator and `requireAuthIfConfigured`.
6. `src/lib/oauth.js` — Remove hardcoded email, add `generateOAuthState` and `verifyOAuthState` with TTL.
7. `src/lib/drive.js` — Use `escapeDriveQueryLiteral`, `isValidDriveId`, and `isFileInWorkspace` guard in `deleteDriveFile`.
8. `src/lib/rag.js` — Generate embeddings before atomic `db.transaction` in `indexSingleFile`, plus atomic purge transaction in `syncDriveRag`.
9. `src/routes/auth.js` — Validate OAuth `state` when issued, preserve callback HTML & error escaping.
10. `src/routes/api.js` — Apply `requireAuthIfConfigured` across data routes while keeping `/status`, `/health`, and `/mcp/info` open for local health probes.
11. `src/index.js` — Configure origin-restricted CORS and `requireAuthIfConfigured` on `/mcp/sse` & `/mcp/messages`.
12. `client/index.html` & `client/main.js` — Update tool inventory to all 12 MCP tools and check write errors in modal.
13. `AGENTS.md`, `README.md`, `.env.example`, `bin/doctor.js` — Align documentation and doctor checks with all 12 tools and FTS5 sync check.
14. `test/hardening.test.js` & `test/smoke.test.js` — Expand hermetic test suite to cover all new hardening invariants.
