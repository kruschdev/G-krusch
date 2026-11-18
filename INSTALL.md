# Install `G-krusch`

These are instructions for a coding agent (Claude Code, Codex, Cursor, Windsurf, or Antigravity) that a person asked to install and configure `G-krusch` on their machine.

`G-krusch` is a Node.js `>= 22.0.0` Sovereign Google Workspace Hub and MCP Bridge exposing both a hardened local HTTP REST server (`http://localhost:5446`) and a 12-tool MCP server (stdio and SSE) for cloud-synced `agent.md` steering, hybrid Vector + SQLite `FTS5` `BM25` Google Drive RAG, page-faithful PDF extraction, native Google Docs/Sheets/Slides creation, Calendar scheduling, and RFC-2822/RFC-2047 sanitized Gmail search and composition, backed by an AES-256-GCM encrypted token vault in SQLite WAL (`./data/gcrush.db`).

## 1. Check Prerequisites First (All at Once)

Run one read-only check before making any changes:

```bash
id -u
node -v 2>/dev/null || echo "MISSING: node"
npm -v 2>/dev/null || echo "MISSING: npm"
git --version 2>/dev/null || echo "MISSING: git"
pdftotext -v 2>/dev/null || echo "OPTIONAL_MISSING: poppler-pdftotext"
ollama --version 2>/dev/null || echo "OPTIONAL_MISSING: ollama"
ss -ltn 2>/dev/null | grep -E ':5446\b' || true
```

Evaluate the results:
1. **User check**: If `id -u` prints `0` (root), stop and ask the person to run you under a normal non-root user account.
2. **Node.js `>= 22.0.0` (Required)**: If `node -v` is missing or older than `v22.0.0`, ask the person before installing or switching to Node 22 (`nvm install 22` or `fnm use 22`).
3. **Poppler `pdftotext` & Ollama (Strictly Optional)**: `G-krusch` includes a pure-JavaScript PDF fallback (`extractPdfTextNative`) and a 3-tier embedding fallback (Ollama -> Gemini -> offline deterministic `FTS5` BM25), so neither binary is required to install or pass verification.
4. **Port `5446` check**: Only needed if starting the HTTP daemon in Mode B; if `:5446` is already bound, inspect what owns it before starting `npm start`.

## 2. Choose the Right Setup Mode

- **Mode A: Zero-Credential Hermetic Verification & MCP Wiring (Recommended First Step)**: Installs dependencies, initializes `.env` from `.env.example` without overwriting existing files, runs the production diagnostic `doctor`, and executes all hermetic unit and security hardening tests (`npm test`) with zero Google credentials required.
- **Mode B: Live Google Workspace OAuth 2.0 Connection (`http://localhost:5446`)**: Guides the person to add their own `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` directly into `.env` (never through chat), launches `G-krusch` on `http://localhost:5446`, and lets the person complete Google OAuth sign-in in their own browser.

## 3. Install & Verify

### Mode A: Zero-Credential Hermetic Verification (Always Run First)

Clone into the current directory (or `~/src/G-krusch` if the current directory is `$HOME` or another unrelated repo; check `pwd` first):

```bash
git clone https://github.com/kruschdev/G-krusch.git
cd G-krusch
npm install
[ -f .env ] || cp .env.example .env
```

Run the production diagnostic check and the hermetic test suite:

```bash
# Verifies Node 22+, SQLite WAL + busy_timeout, FTS5 sync, 12-byte AES-256-GCM roundtrip, MCP tools, and MIME encoding
npm run doctor

# Runs all hermetic unit and hardening tests (39 tests, exceeding the 32-test baseline badge) against an isolated per-PID temp SQLite DB
npm test
```

*(Note: Before Mode B is completed, `npm run doctor` will report `[WARN]` on unconfigured Google OAuth placeholders while passing all runtime, SQLite WAL, `FTS5`, crypto, and MCP checks.)*

### Mode B: Google Workspace OAuth 2.0 Setup (Person-Completed Credentials & Browser Sign-In)

Do **not** invent OAuth values and do **not** ask the person to paste `GOOGLE_CLIENT_SECRET` or API keys into chat. Instead, guide the person through these exact steps:

1. **Google Cloud Console OAuth Client**: Ensure they have an OAuth 2.0 Web Application client (with Google Drive, Google Docs, Google Sheets, Google Slides, Google Calendar, and Gmail APIs enabled) configured with Authorized Redirect URI:
   ```text
   http://localhost:5446/auth/google/callback
   ```
2. **Edit `.env` Locally**: Ask the person to open `.env` in their local editor and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (plus optional `GEMINI_API_KEY` or `GCRUSH_SECRET` / `API_KEY` if desired).
3. **Start the Hub on `:5446`**: Once the person confirms `.env` is saved and port `5446` is free:
   ```bash
   npm start
   ```
   Verify health in a separate check:
   ```bash
   curl -fsS http://127.0.0.1:5446/api/health
   ```
4. **Browser OAuth Sign-In**: Ask the person to open `http://localhost:5446/auth/google` (or `http://localhost:5446`) in their browser and finish Google sign-in. `G-krusch` validates the 32-byte CSRF `state` token and seals the OAuth tokens at rest in `./data/gcrush.db` using AES-256-GCM.
5. **Confirm Readiness**: Re-run `npm run doctor` to confirm OAuth status reports connected.

## 4. Connect to the Person's Coding Agent / IDE

Resolve the checkout's absolute path with `pwd`, then merge the `g-krusch` entry non-destructively into the person's active MCP client configuration (preserving all existing MCP servers):

- **Claude Code CLI (Stdio)**:
  ```bash
  claude mcp add g-krusch -- node /absolute/path/to/G-krusch/src/index.js --stdio
  ```
- **Cursor (`~/.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), or Antigravity (`~/.gemini/antigravity/mcp_config.json`) via Stdio**:
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
  *(Alternatively, if the person runs `npm start` continuously as a background service on port `5446`, they can register `"url": "http://localhost:5446/mcp/sse"` instead.)*
- **Codex (`~/.codex/config.toml`)**:
  ```toml
  [mcp_servers.g-krusch]
  command = "node"
  args = ["/absolute/path/to/G-krusch/src/index.js", "--stdio"]
  ```

*(Replace `/absolute/path/to/G-krusch` with the real path returned by `pwd`.)*

## Never

- **Never run `npm` or `node` with `sudo` or as `root`**.
- **Never ask for or accept `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`, `GCRUSH_SECRET`, or `API_KEY` in chat**, and never write fake credentials into `.env`.
- **Never overwrite an existing `.env` or wipe existing entries in an IDE MCP config file**; always read, parse, merge only the `g-krusch` key, and write back cleanly.
- **Never complete OAuth flows on the person's behalf**; the person always signs in directly via their own browser at `http://localhost:5446/auth/google`.

## Tell the Person After

Share a concise status report:
1. **Install & vault path**: Where `G-krusch` is installed and where the encrypted SQLite WAL vault lives (`./data/gcrush.db`).
2. **Verification status**: Confirm `npm run doctor` and `npm test` (`39/39` hermetic tests) passed.
3. **OAuth next step (if Mode A only)**: Point the person to `.env` (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`), `npm start`, and `http://localhost:5446/auth/google` to link their Google Workspace when ready.
4. **Configured IDEs & first-turn test prompt**: List updated MCP config files and suggest testing with: `"Run get_workspace_status and get_agent_steering to verify G-krusch is connected."`
