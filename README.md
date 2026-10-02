# G-Krusch (G-Crush) — Google Drive for AI Agents & Agentic Workspaces

<p align="center">
  <img src="https://via.placeholder.com/800x380/070B14/38BDF8?text=G-KRUSCH+%7C+Google+Drive+for+AI+Agents" alt="G-Krusch Banner" width="100%">
</p>

A sovereign **Google Drive Agent Hub and MCP Server** that turns Google Drive into a dynamic, cloud-synced brain for AI agents. Run your multi-agent workflows out of a single Google Drive folder with live `agent.md` steering, hybrid vector RAG, and two-way agentic file storage.

[![Node](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-1.12+-blue.svg)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🧠 Why G-Krusch?

Most AI agents are trapped either in ephemeral context windows or isolated local folders that you can't easily access when away from your workstation. G-Krusch bridges the physical gap between humans and autonomous agents using Google Drive:

1. **`agent.md` Cloud-Synced Steering**: Edit your agent rules, project priorities, and personas from your phone, tablet, or web browser directly in Google Drive. When an agent boots, it dynamically pulls the latest instructions via `get_agent_steering`.
2. **Hybrid Vector & Full-Text Drive RAG**: Queries your Google Docs, PDFs, notes, and specs using semantic embeddings (Gemini/Ollama) combined with Google Drive's native full-text search index.
3. **Two-Way Agent Filesystem**: Agents can read project briefs from `context/`, check decision logs in `memory/`, and write final deliverables and reports directly into `output/` on Google Drive for you to review.
4. **Native Google Doc Markdown Conversion**: Automatic on-the-fly export of Google Docs (`application/vnd.google-apps.document`) into clean, consumable Markdown.

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

## ⚡ Quick Start

### 1. Installation
```bash
git clone https://github.com/kruschdev/g-krusch.git # or cd /home/krusch/homelab/projects/g-krusch
cd g-krusch
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` and provide your Google OAuth credentials and Gemini API Key:
```bash
cp .env.example .env
```

### 3. Launch G-Krusch
```bash
npm start
```
The server will boot:
- **Web Dashboard**: `http://localhost:5446`
- **MCP SSE Transport**: `http://localhost:5446/mcp/sse`
- **Google OAuth Flow**: `http://localhost:5446/auth/google`

### 4. Connect Your Google Account
1. Open `http://localhost:5446` in your browser.
2. Click **Connect Google Drive** in the header.
3. Complete the Google OAuth consent flow.
4. G-Krusch will automatically provision the `G-Krusch` workspace folder and seed `agent.md`.

---

## 🛠️ MCP Integration (Cursor, Antigravity, Claude Code)

### SSE Transport (Antigravity IDE & Cursor)
Add to your `mcp_config.json`:
```json
{
  "mcpServers": {
    "g-krusch": {
      "url": "http://localhost:5446/mcp/sse"
    }
  }
}
```

### Stdio Transport (Claude Code & Terminal Agents)
```json
{
  "mcpServers": {
    "g-krusch": {
      "command": "node",
      "args": ["/home/krusch/homelab/projects/g-krusch/src/index.js", "--stdio"]
    }
  }
}
```

---

## 🧰 Exposed MCP Tools

| Tool | Description |
|------|-------------|
| `get_agent_steering` | Retrieves active `agent.md` steering directives directly from Google Drive. |
| `search_drive_rag` | Semantic vector and keyword search across all indexed files in Google Drive. |
| `read_drive_file` | Reads any document from Drive (exports Google Docs cleanly to markdown). |
| `write_drive_file` | Writes or updates a file in the workspace (saves reports, notes, artifacts). |
| `list_drive_workspace`| Lists all folders and files in the G-Krusch Drive hierarchy. |
| `sync_drive_rag` | Triggers an incremental scan and embedding sync of Google Drive files. |

---

## 📄 License
MIT License. Created by [kruschdev](https://github.com/kruschdev).
