# G-Krusch (G-Crush) — Agent Operating Manual (`AGENTS.md`)

> **Google Drive for AI Agents & Agentic Workspaces**: Standard operating manual and invariants for agents interacting with G-Krusch.

---

## ⚡ Core Invariants

1. **Drive-First Persistence**: Google Drive is the authoritative long-term memory and document storage boundary.
2. **agent.md Steering Authority**: Prioritize the dynamic directives retrieved via `get_agent_steering` over generic model defaults.
3. **Structured Storage Discipline**:
   - `agent.md`: Root steering rules, personas, project milestones.
   - `context/`: Source documents, API specs, schemas, and domain knowledge.
   - `memory/`: Invariant changes, decision records, blocker logs.
   - `output/`: Agent-created drafts, reports, analyses, and code exports.
4. **Export Safety**: Native Google Docs are automatically exported to markdown via the G-Krusch adapter (`drive.files.export`). Always inspect exported text before downstream parsing.
5. **Hermetic Test Isolation & Transactional RAG**: `npm test` executes against an isolated temporary SQLite database and never mutates live `data/gcrush.db`; all RAG chunk and FTS5 updates run inside atomic SQLite transactions.

---

## 🛠️ MCP Tool Surface Area (12 Tools)

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `get_agent_steering` | Fetches live `agent.md` rules from Drive | `force_refresh` (bool) |
| `search_drive_rag` | Semantic vector + full-text RAG across Drive docs | `query` (string), `limit` (int) |
| `read_drive_file` | Reads any Doc, Markdown, or PDF file from Drive | `file_id` or `path` |
| `write_drive_file` | Writes/updates documents in Drive workspace | `path`, `content`, `mime_type` |
| `delete_drive_file` | Safely trashes a file inside the Drive workspace | `file_id` or `path` |
| `list_drive_workspace` | Recursive tree view of agent folders | None |
| `sync_drive_rag` | Triggers incremental vector embedding sync | None |
| `get_workspace_status` | Reports OAuth health, indexed counts, and storage | None |
| `list_calendar_events` | Lists upcoming Google Calendar events | `max_results`, `time_min`, `query` |
| `create_calendar_event` | Schedules a new Google Calendar event | `summary`, `start_time`, `end_time`, `description`, `location` |
| `search_gmail_messages` | Searches Gmail messages using standard operators | `query`, `max_results` |
| `compose_gmail_message` | Creates an RFC-2822/RFC-2047 Gmail draft or sends email | `to`, `subject`, `body`, `send_immediately` |

---

## 🔄 Lifecycle Workflow

```
1. SESSION START
   └── Call get_agent_steering() to hydrate active priorities & invariants.

2. RESEARCH & RETRIEVAL
   └── Call search_drive_rag(query) to pull relevant project context from Drive.
   └── Call read_drive_file(path) to inspect full source specifications.

3. EXECUTION & DELIVERABLE
   └── Write intermediate findings or final reports to output/<name>.md via write_drive_file.
   └── Provide direct Google Drive web links for user review.
```
