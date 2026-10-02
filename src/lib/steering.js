import crypto from 'crypto';
import { getDrive, getOrCreateWorkspaceFolder, readDriveFile, writeDriveFile } from './drive.js';
import { getDb } from './db.js';
import { mutex } from './mutex.js';
import { withRetry } from './retry.js';

const MAX_STEERING_BYTES = 500 * 1024; // 500KB cap
const STEERING_CACHE_TTL_MS = 30000; // 30s in-memory TTL

let memorySteeringCache = null;
let memorySteeringCacheTime = 0;

export function invalidateSteeringCache() {
  memorySteeringCache = null;
  memorySteeringCacheTime = 0;
}

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
 * Mutex protected to eliminate concurrent provisioning races.
 * Features in-memory TTL and graceful offline cache fallback.
 */
export async function getAgentSteering(options = { forceRefresh: false }) {
  if (!options.forceRefresh && memorySteeringCache && (Date.now() - memorySteeringCacheTime < STEERING_CACHE_TTL_MS)) {
    return memorySteeringCache;
  }

  return mutex.runExclusive('agent_md_read', async () => {
    if (!options.forceRefresh && memorySteeringCache && (Date.now() - memorySteeringCacheTime < STEERING_CACHE_TTL_MS)) {
      return memorySteeringCache;
    }

    const db = getDb();
    const cached = db.prepare('SELECT * FROM agent_steering_cache WHERE id = 1').get();

    try {
      const rootId = await getOrCreateWorkspaceFolder();
      const drive = await getDrive();

      const q = `'${rootId}' in parents and (name = 'agent.md' or name = 'AGENTS.md') and trashed = false`;
      const res = await withRetry(() => drive.files.list({
        q,
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink)'
      }));

      const files = res.data.files || [];

      if (files.length === 0) {
        // Provision default agent.md in Drive
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

        const result = {
          content: DEFAULT_STARTER_AGENT_MD,
          versionHash: hash,
          modifiedTime,
          fileId,
          webViewLink: writeResult.file.webViewLink,
          source: 'provisioned'
        };
        memorySteeringCache = result;
        memorySteeringCacheTime = Date.now();
        return result;
      }

      const agentFile = files[0];

      if (!options.forceRefresh && cached && cached.drive_file_id === agentFile.id && cached.drive_modified_time === agentFile.modifiedTime) {
        const result = {
          content: cached.content,
          versionHash: cached.version_hash,
          modifiedTime: cached.drive_modified_time,
          fileId: cached.drive_file_id,
          webViewLink: agentFile.webViewLink,
          source: 'cache'
        };
        memorySteeringCache = result;
        memorySteeringCacheTime = Date.now();
        return result;
      }

      // Fetch updated content from Google Drive
      const fileData = await readDriveFile(agentFile.id);
      let content = fileData.content || DEFAULT_STARTER_AGENT_MD;
      if (content.length > MAX_STEERING_BYTES) {
        content = content.slice(0, MAX_STEERING_BYTES);
      }
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

      const result = {
        content,
        versionHash: hash,
        modifiedTime: agentFile.modifiedTime,
        fileId: agentFile.id,
        webViewLink: agentFile.webViewLink,
        source: 'drive'
      };
      memorySteeringCache = result;
      memorySteeringCacheTime = Date.now();
      return result;
    } catch (networkErr) {
      if (cached && cached.content) {
        console.warn('[Steering] Drive network error, falling back to cached agent.md:', networkErr.message);
        return {
          content: cached.content,
          versionHash: cached.version_hash,
          modifiedTime: cached.drive_modified_time,
          fileId: cached.drive_file_id,
          webViewLink: null,
          source: 'cache_offline'
        };
      }
      throw networkErr;
    }
  });
}

/**
 * Updates agent.md directly on Google Drive and refreshes local cache.
 */
export async function updateAgentSteering(newContent) {
  if (typeof newContent !== 'string') {
    throw new Error('agent.md content must be a string.');
  }

  const sanitized = newContent.slice(0, MAX_STEERING_BYTES);

  return mutex.runExclusive('agent_md_write', async () => {
    const writeResult = await writeDriveFile({
      path: 'agent.md',
      content: sanitized,
      mimeType: 'text/markdown'
    });

    const fileId = writeResult.file.id;
    const modifiedTime = writeResult.file.modifiedTime;
    const hash = crypto.createHash('sha256').update(sanitized).digest('hex');

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
    `).run(sanitized, hash, fileId, modifiedTime);

    const result = {
      fileId,
      modifiedTime,
      versionHash: hash,
      webViewLink: writeResult.file.webViewLink,
      content: sanitized,
      source: 'updated'
    };

    memorySteeringCache = result;
    memorySteeringCacheTime = Date.now();

    return result;
  });
}

