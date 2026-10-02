/**
 * G-Krusch Client Application
 * Dynamic Google Drive agent dashboard & MCP controller
 */

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupAuth();
  loadDashboardData();
  setupEventListeners();
});

// ── Tab Management ────────────────────────────────────────────────

function setupTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      tabBtns.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPanel = document.getElementById(`panel-${targetTab}`);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }

      // Refresh specific tab data on switch
      if (targetTab === 'workspace') loadWorkspaceTree();
      if (targetTab === 'rag') loadRagStats();
    });
  });
}

// ── Auth Handling ─────────────────────────────────────────────────

async function setupAuth() {
  const badge = document.getElementById('drive-status-badge');
  const text = document.getElementById('drive-status-text');
  const authBtn = document.getElementById('auth-action-btn');
  const authLabel = document.getElementById('auth-btn-label');

  try {
    const res = await fetch('/auth/status');
    const data = await res.json();

    if (data.authenticated) {
      badge.className = 'status-badge connected';
      text.textContent = data.email ? `Drive: ${data.email}` : 'Drive Connected';
      authLabel.textContent = 'Account Linked';
      authBtn.onclick = () => {
        if (confirm(`Connected as ${data.email || 'user'}. Disconnect Google Drive?`)) {
          fetch('/auth/disconnect', { method: 'POST' }).then(() => location.reload());
        }
      };
    } else {
      badge.className = 'status-badge disconnected';
      text.textContent = 'Drive Not Connected';
      authLabel.textContent = 'Connect Google Drive';
      authBtn.onclick = () => {
        window.location.href = '/auth/google';
      };
    }
  } catch (err) {
    badge.className = 'status-badge disconnected';
    text.textContent = 'Auth Check Failed';
  }
}

// ── Load All Data ─────────────────────────────────────────────────

async function loadDashboardData() {
  loadSteering();
  loadWorkspaceTree();
  loadRagStats();
  loadDriveOverview();
}

// ── Steering (agent.md) ──────────────────────────────────────────

async function loadSteering(refresh = false) {
  const editor = document.getElementById('steering-editor');
  const sourceTag = document.getElementById('steering-source-tag');
  const openLink = document.getElementById('open-drive-doc-link');
  const statStatus = document.getElementById('stat-steering-status');
  const statMeta = document.getElementById('stat-steering-meta');

  try {
    const url = refresh ? '/api/steering?refresh=true' : '/api/steering';
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      editor.value = `# Google Drive Connection Required\n\n${data.error}\n\nPlease click "Connect Google Drive" in the top bar.`;
      sourceTag.textContent = 'Status: Disconnected';
      return;
    }

    editor.value = data.content || '';
    sourceTag.textContent = `Source: Google Drive (${data.source || 'synced'})`;
    statStatus.textContent = 'agent.md Active';
    statMeta.textContent = `Hash: ${data.versionHash ? data.versionHash.slice(0, 8) : 'clean'}`;

    if (data.webViewLink) {
      openLink.href = data.webViewLink;
      openLink.style.display = 'inline-flex';
    }
  } catch (err) {
    editor.value = `Error loading steering: ${err.message}`;
  }
}

async function saveSteering() {
  const editor = document.getElementById('steering-editor');
  const saveBtn = document.getElementById('save-steering-btn');
  const originalText = saveBtn.innerHTML;

  saveBtn.disabled = true;
  saveBtn.textContent = 'Pushing to Drive...';

  try {
    const res = await fetch('/api/steering', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editor.value })
    });
    const data = await res.json();

    if (data.error) {
      alert(`Save failed: ${data.error}`);
    } else {
      saveBtn.textContent = 'Saved to Drive!';
      setTimeout(() => {
        saveBtn.innerHTML = originalText;
        saveBtn.disabled = false;
      }, 1800);
      loadRagStats();
    }
  } catch (err) {
    alert(`Save error: ${err.message}`);
    saveBtn.innerHTML = originalText;
    saveBtn.disabled = false;
  }
}

// ── Workspace Files Explorer ──────────────────────────────────────

async function loadWorkspaceTree() {
  const container = document.getElementById('workspace-tree');

  try {
    const res = await fetch('/api/workspace/tree');
    const data = await res.json();

    if (data.error) {
      container.innerHTML = `<div class="empty-state"><p>${data.error}</p></div>`;
      return;
    }

    const items = data.items || [];
    if (items.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>Workspace folder is empty. Create a file to begin.</p></div>';
      return;
    }

    let html = '';
    for (const item of items) {
      if (item.mimeType === 'application/vnd.google-apps.folder') {
        const children = item.children || [];
        html += `
          <div class="tree-node">
            <div class="tree-node-title">
              <span class="tree-folder-icon">📁</span>
              <strong>${escapeHtml(item.name)}/</strong>
              <span class="file-meta-link">${children.length} item(s)</span>
            </div>
            <div class="tree-node-children">
              ${children.map(c => `
                <div class="tree-node-title">
                  <span class="tree-file-icon">📄</span>
                  <span>${escapeHtml(c.name)}</span>
                  ${c.webViewLink ? `<a href="${c.webViewLink}" target="_blank" class="file-meta-link">Open in Drive ↗</a>` : ''}
                </div>
              `).join('')}
              ${children.length === 0 ? '<div style="color:var(--text-muted);font-size:0.8rem;padding:0.25rem 0;">(empty folder)</div>' : ''}
            </div>
          </div>
        `;
      } else {
        html += `
          <div class="tree-node">
            <div class="tree-node-title">
              <span class="tree-file-icon">📄</span>
              <span>${escapeHtml(item.name)}</span>
              ${item.webViewLink ? `<a href="${item.webViewLink}" target="_blank" class="file-meta-link">Open in Drive ↗</a>` : ''}
            </div>
          </div>
        `;
      }
    }

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>Error loading files: ${err.message}</p></div>`;
  }
}

// ── RAG Search & Indexing ────────────────────────────────────────

async function loadRagStats() {
  const statCount = document.getElementById('stat-rag-count');
  const statMeta = document.getElementById('stat-rag-meta');

  try {
    const res = await fetch('/api/rag/stats');
    const data = await res.json();
    statCount.textContent = `${data.totalChunks || 0} chunks`;
    statMeta.textContent = `${data.documentsIndexed || 0} documents indexed`;
  } catch {}
}

async function runRagSearch() {
  const query = document.getElementById('rag-query-input').value.trim();
  const resultsContainer = document.getElementById('rag-results-container');
  const searchBtn = document.getElementById('rag-search-btn');

  if (!query) return;

  searchBtn.disabled = true;
  resultsContainer.innerHTML = '<div class="loading-state">Searching vector embeddings &amp; Google Drive...</div>';

  try {
    const res = await fetch(`/api/rag/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (data.error) {
      resultsContainer.innerHTML = `<div class="empty-state"><p>${data.error}</p></div>`;
      searchBtn.disabled = false;
      return;
    }

    const list = data.results || [];
    if (list.length === 0) {
      resultsContainer.innerHTML = `<div class="empty-state"><p>No relevant context found in Drive for: "<strong>${escapeHtml(query)}</strong>"</p></div>`;
      searchBtn.disabled = false;
      return;
    }

    resultsContainer.innerHTML = list.map(item => `
      <div class="rag-result-card glass">
        <div class="rag-result-header">
          <span class="rag-doc-name">📄 ${escapeHtml(item.fileName)} (Chunk #${item.chunkIndex})</span>
          <div style="display:flex;gap:0.75rem;align-items:center;">
            <span class="rag-score-pill">Match: ${Math.round(item.score * 100)}%</span>
            ${item.webViewLink ? `<a href="${item.webViewLink}" target="_blank" class="file-meta-link">Open ↗</a>` : ''}
          </div>
        </div>
        <div class="rag-excerpt">${escapeHtml(item.content)}</div>
      </div>
    `).join('');
  } catch (err) {
    resultsContainer.innerHTML = `<div class="empty-state"><p>Search error: ${err.message}</p></div>`;
  } finally {
    searchBtn.disabled = false;
  }
}

async function triggerRagSync() {
  const syncBtn = document.getElementById('sync-rag-btn');
  const syncLabel = document.getElementById('sync-rag-label');
  const original = syncLabel.textContent;

  syncBtn.disabled = true;
  syncLabel.textContent = 'Indexing Drive Files...';

  try {
    const res = await fetch('/api/rag/sync', { method: 'POST' });
    const data = await res.json();

    if (data.error) {
      alert(`Sync failed: ${data.error}`);
    } else {
      alert(`RAG Sync Complete!\nUpdated Files: ${data.updatedFiles}\nSkipped (Up to date): ${data.skippedFiles}\nTotal Chunks: ${data.totalChunks}`);
      loadRagStats();
    }
  } catch (err) {
    alert(`Sync error: ${err.message}`);
  } finally {
    syncBtn.disabled = false;
    syncLabel.textContent = original;
  }
}

// ── Drive Overview ───────────────────────────────────────────────

async function loadDriveOverview() {
  const statStorage = document.getElementById('stat-storage-quota');
  const statMeta = document.getElementById('stat-storage-meta');

  try {
    const res = await fetch('/api/drive/overview');
    const data = await res.json();

    if (data.storage && data.storage.limit) {
      const usedGB = (parseInt(data.storage.usage, 10) / (1024 ** 3)).toFixed(1);
      const limitGB = (parseInt(data.storage.limit, 10) / (1024 ** 3)).toFixed(0);
      statStorage.textContent = `${usedGB} / ${limitGB} GB`;
      statMeta.textContent = `${data.user?.displayName || 'Google Drive'} Space`;
    }
  } catch {}
}

// ── Modal & Event Listeners ──────────────────────────────────────

function setupEventListeners() {
  // Steering
  document.getElementById('refresh-steering-btn')?.addEventListener('click', () => loadSteering(true));
  document.getElementById('save-steering-btn')?.addEventListener('click', saveSteering);

  // Files
  document.getElementById('refresh-tree-btn')?.addEventListener('click', loadWorkspaceTree);

  // RAG
  document.getElementById('rag-search-btn')?.addEventListener('click', runRagSearch);
  document.getElementById('rag-query-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runRagSearch();
  });
  document.getElementById('sync-rag-btn')?.addEventListener('click', triggerRagSync);

  // New file modal
  const modal = document.getElementById('new-file-modal');
  document.getElementById('new-file-btn')?.addEventListener('click', () => {
    modal.style.display = 'flex';
  });
  document.getElementById('modal-close-btn')?.addEventListener('click', () => {
    modal.style.display = 'none';
  });
  document.getElementById('modal-cancel-btn')?.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  document.getElementById('modal-save-btn')?.addEventListener('click', async () => {
    const path = document.getElementById('new-file-path').value.trim();
    const content = document.getElementById('new-file-content').value;

    if (!path) {
      alert('Please specify a file path (e.g. context/spec.md)');
      return;
    }

    try {
      const res = await fetch('/api/drive/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content })
      });
      modal.style.display = 'none';
      document.getElementById('new-file-path').value = '';
      document.getElementById('new-file-content').value = '';
      loadWorkspaceTree();
    } catch (err) {
      alert(`Error creating file: ${err.message}`);
    }
  });

  // Copy buttons
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if (el) {
        navigator.clipboard.writeText(el.innerText).then(() => {
          const original = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = original; }, 1500);
        });
      }
    });
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}
