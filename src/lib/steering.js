import crypto from 'crypto';
import { getDrive, getOrCreateWorkspaceFolder, readDriveFile, writeDriveFile } from './drive.js';
import { getDb } from './db.js';

const DEFAULT_STARTER_AGENT_MD = `# 🤖 G-Krusch Agent Directives & Operating Manual (\`agent.md\`)

> **Cloud-Synced Brain**: Hosted directly on Google Drive. Edit from any phone, browser, or Google Doc to steer active agents in real-time.

---

## ⚡ Global Invariants & Rules of Engagement

1. **Drive-First Persistence**: Treat Google Drive as the authoritative source of truth for long-term project context, specs, and deliverables.
2. **Deterministic Verification**: Verify code and diffs locally before committing or reporting completion.
3. **Structured Outputs**: When generating reports or artifacts, save them into the \`output/\` folder on Google Drive for user review.

---

## 🎯 Active Project Priorities

- [x] **Project Scaffolding**: Provision Google Drive workspace (\`G-Krusch\`) with \`agent.md\`, \`context/\`, \`memory/\`, and \`output/\`.
- [ ] **RAG Indexing**: Populate \`context/\` with domain specifications and architectural blueprints.
- [ ] **Multi-Agent Connectivity**: Connect Cursor, Antigravity, and Claude Code to G-Krusch MCP endpoint.

---

## 🧠 Working Memory & Notes

*Edit this document directly in Google Drive to update agent behavior, active blockers, or architectural guidelines.*
`;

/**
 * Get or provision agent.md from Google Drive.
 */
export async function getAgentSteering(options = { forceRefresh: false }) {
  const db = getDb();
  const cached = db.prepare('SELECT * FROM agent_steering_cache WHERE id = 1').get();

  // If not forcing refresh and cache exists, check quick metadata
  const rootId = await getOrCreateWorkspaceFolder();
  const drive = await getDrive();

  // Search for agent.md in workspace root
  const q = `'${rootId}' in parents and (name = 'agent.md' or name = 'AGENTS.md') and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)'
  });

  const files = res.data.files || [];

  if (files.length === 0) {
    // Provision default agent.md in Drive!
    const writeResult = await writeDriveFile({
      path: 'agent.md',
      content: DEFAULT_STARTER_AGENT_MD,
      mimeType: 'text/markdown'
    });

    const fileId = writeResult.file.id;
    const modifiedTime = writeResult.file.modifiedTime;
    const hash = crypto.createHash('sha256').update(DEFAULT_STARTER_AGENT_MD).digest('hex');

    db.prepare(`
      INSERT INTO agent_steering_cache (id, content, version_hash, drive_file_id, drive_modified_time, cached_at)
      VALUES (1, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        version_hash = excluded.version_hash,
        drive_file_id = excluded.drive_file_id,
        drive_modified_time = excluded.drive_modified_time,
        cached_at = datetime('now')
    `).run(DEFAULT_STARTER_AGENT_MD, hash, fileId, modifiedTime);

    return {
      content: DEFAULT_STARTER_AGENT_MD,
      versionHash: hash,
      modifiedTime,
      fileId,
      webViewLink: writeResult.file.webViewLink,
      source: 'provisioned'
    };
  }

  const agentFile = files[0];

  // If cached modifiedTime matches and not forcing refresh, return cached
  if (!options.forceRefresh && cached && cached.drive_file_id === agentFile.id && cached.drive_modified_time === agentFile.modifiedTime) {
    return {
      content: cached.content,
      versionHash: cached.version_hash,
      modifiedTime: cached.drive_modified_time,
      fileId: cached.drive_file_id,
      webViewLink: agentFile.webViewLink,
      source: 'cache'
    };
  }

  // Fetch updated content from Google Drive
  const fileData = await readDriveFile(agentFile.id);
  const content = fileData.content || DEFAULT_STARTER_AGENT_MD;
  const hash = crypto.createHash('sha256').update(content).digest('hex');

  db.prepare(`
    INSERT INTO agent_steering_cache (id, content, version_hash, drive_file_id, drive_modified_time, cached_at)
    VALUES (1, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      version_hash = excluded.version_hash,
      drive_file_id = excluded.drive_file_id,
      drive_modified_time = excluded.drive_modified_time,
      cached_at = datetime('now')
  `).run(content, hash, agentFile.id, agentFile.modifiedTime);

  return {
    content,
    versionHash: hash,
    modifiedTime: agentFile.modifiedTime,
    fileId: agentFile.id,
    webViewLink: agentFile.webViewLink,
    source: 'drive'
  };
}

/**
 * Updates agent.md directly on Google Drive and refreshes local cache.
 */
export async function updateAgentSteering(newContent) {
  const writeResult = await writeDriveFile({
    path: 'agent.md',
    content: newContent,
    mimeType: 'text/markdown'
  });

  const fileId = writeResult.file.id;
  const modifiedTime = writeResult.file.modifiedTime;
  const hash = crypto.createHash('sha256').update(newContent).digest('hex');

  const db = getDb();
  db.prepare(`
    INSERT INTO agent_steering_cache (id, content, version_hash, drive_file_id, drive_modified_time, cached_at)
    VALUES (1, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      version_hash = excluded.version_hash,
      drive_file_id = excluded.drive_file_id,
      drive_modified_time = excluded.drive_modified_time,
      cached_at = datetime('now')
  `).run(newContent, hash, fileId, modifiedTime);

  return {
    fileId,
    modifiedTime,
    versionHash: hash,
    webViewLink: writeResult.file.webViewLink
  };
}
