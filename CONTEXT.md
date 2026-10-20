# G-Krusch — Technical Context & Invariant Registry

> **Repository**: `projects/g-krusch` (symlinked at `projects/g-crush`, remote `github.com/kruschdev/G-krusch`)
> **Runtime**: Node.js $\ge 22.0.0$ (ESM), Express 4, `better-sqlite3` (WAL + FTS5), `@modelcontextprotocol/sdk`
> **Port / Service**: `127.0.0.1:5446` (`g-krusch.service`)

---

## 1. Architectural Overview

G-Krusch is the sovereign Google Workspace Hub and Model Context Protocol (MCP) server for the Krusch homelab ecosystem. It exposes:
1. **12 MCP Tools** over both **SSE** (`/mcp/sse` + `/mcp/messages`) and **Stdio** (`node src/index.js --stdio`) transports.
2. **REST Extension APIs** on `:5446/api/*` consumed by **Krusch Companion** (`:3004`) and its `<holodata>` Agentic Proxy + Sentinel Watchdog daemon.
3. **Hybrid Semantic + BM25 Drive RAG**: Indexes Google Docs, Markdown, TXT, JSON, CSV, and PDFs inside the `G-Krusch` Google Drive folder into local SQLite (`rag_documents`, `rag_chunks`, `rag_chunks_fts`, `rag_embeddings_cache`).

---

## 2. Hardening Invariant Registry (`INV-01` – `INV-14`)

| ID | Invariant | Authoritative Implementation |
|----|-----------|------------------------------|
| `INV-01` | **Hermetic Test DB Isolation & Startup FTS5 Self-Healing** | [`src/config.js`](src/config.js) routes `node --test` to `os.tmpdir()/gcrush-test-<pid>.db`; [`ensureFtsSync`](src/lib/db.js) rebuilds `rag_chunks_fts` transactionally whenever chunk counts drift. |
| `INV-02` | **OAuth2 CSRF `state` Parameter & Zero Identity Leakage** | [`generateOAuthState`](src/lib/oauth.js) issues 32-byte one-time tokens with 10m TTL validated in constant time by [`verifyOAuthState`](src/lib/oauth.js) on `/auth/google/callback`. |
| `INV-03` | **Loopback Binding, CORS Allowlist & Read/Write Auth Guard** | Server binds to `127.0.0.1` by default; [`isAllowedOrigin`](src/lib/auth-guard.js) restricts CORS to loopback, RFC1918 LAN, Tailscale CGNAT (`100.64.0.0/10`), and `CORS_ORIGINS`; [`requireAuthIfConfigured`](src/lib/auth-guard.js) guards all read/write data endpoints. |
| `INV-04` | **Drive Query Escaping & Workspace Boundary Enforcement** | [`escapeDriveQueryLiteral`](src/lib/path-utils.js) escapes `\` before `'`; [`isValidDriveId`](src/lib/path-utils.js) and [`isFileInWorkspace`](src/lib/drive.js) prevent trashing files outside the `G-Krusch` workspace root. |
| `INV-05` | **NIST 96-Bit AES-256-GCM IV Standard** | [`encrypt`](src/lib/crypto.js) generates 12-byte (96-bit) IVs per NIST SP 800-38D while [`decrypt`](src/lib/crypto.js) transparently supports both 12-byte and legacy 16-byte IV ciphertexts. |
| `INV-06` | **Transactional RAG Sync & Sovereign 1,024-Dim Embeddings** | [`saveIndexedDocumentTransactional`](src/lib/rag.js) commits document + chunks + FTS5 atomically; [`embedText`](src/lib/rag.js) cascades Tier 1 local GPU `bge-large:latest` (1,024-dim) $\rightarrow$ Tier 2 Gemini `models/gemini-embedding-001` (`outputDimensionality: 1024`) $\rightarrow$ Tier 3 uncached 64-dim fallback. |
| `INV-07` | **DOM XSS & Reverse-Tabnabbing Remediation** | [`client/main.js`](client/main.js) escapes all untrusted error/attribute strings via `escapeHtml` and validates external links via `sanitizeSafeUrl` + `rel="noopener noreferrer"`. |
| `INV-08` | **SQLite Multi-Process Concurrency Pragmas** | [`getDb`](src/lib/db.js) sets `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 5000`, `PRAGMA synchronous = NORMAL`, and `PRAGMA foreign_keys = ON`. |
| `INV-09` | **PDF Pre-Spool Magic-Byte Gate & 3-Tier Extraction** | [`validatePdfMagicBytes`](src/lib/pdf.js) rejects PE/ELF/HTML payloads before spooling to `/tmp`; [`sanitizePdfTempName`](src/lib/pdf.js) strips leading dashes; [`extractPdfTextNative`](src/lib/pdf.js) provides a pure-JS Tier 3 fallback. |
| `INV-10` | **Dynamic Dashboard MCP Config Hydration** | [`loadMcpInfo`](client/main.js) fetches `/api/mcp/info` to populate `#mcp-json-sse` and `#mcp-json-stdio` dynamically. |
| `INV-11` | **Security Headers & Sliding-Window Rate Limiter** | [`securityHeadersMiddleware`](src/lib/auth-guard.js) and [`createRateLimiter`](src/lib/auth-guard.js) enforce 120 req/min per IP and defensive HTTP headers. |
| `INV-12` | **Multi-Client MCP SSE, Unified Steering Mutex & Portable CI** | [`createMcpServer`](src/mcp/tools.js) creates an isolated `McpServer` per SSE session; `getAgentSteering` and `updateAgentSteering` share `'agent_md_steering'` mutex key; zero hardcoded host paths. |
| `INV-13` | **Embedding Cache Poisoning Guard** | [`generateEmbedding`](src/lib/rag.js) never caches 64-dim offline fallback vectors during transient outages and bypasses `<256`-dim cached entries when real providers are configured. |
| `INV-14` | **Zero-Dependency Native Google Docs, Sheets & Slides Builders & MIME Disambiguation** | [`prepareWorkspaceWritePayload`](src/lib/slides.js) converts Markdown (`<h1>`–`<h6>`, `<ul>`, `<ol>`, `<blockquote>`, `<pre><code>`, `<table>`) to semantic HTML (`application/vnd.google-apps.document`), Markdown pipe tables/CSV to RFC-4180 CSV (`application/vnd.google-apps.spreadsheet`), and `---`-separated Markdown decks (with `Notes:` speaker notes) to 16:9 OpenXML `.pptx` archives (`application/vnd.google-apps.presentation`), while [`writeDriveFile`](src/lib/drive.js) and [`resolvePathToId`](src/lib/drive.js) disambiguate same-named files by `mimeType`. |
