import { google } from 'googleapis';
import { Readable } from 'stream';
import config from '../config.js';
import { getAuthenticatedClient } from './oauth.js';
import { getMetadata, setMetadata } from './db.js';

export async function getDrive() {
  const auth = await getAuthenticatedClient();
  return google.drive({ version: 'v3', auth });
}

/**
 * Finds or automatically provisions the root workspace folder in Google Drive.
 * Defaults to 'G-Krusch' (or config.google.workspaceFolderName).
 */
export async function getOrCreateWorkspaceFolder() {
  const cachedFolderId = getMetadata('workspace_root_id');
  const drive = await getDrive();

  if (cachedFolderId) {
    try {
      const res = await drive.files.get({
        fileId: cachedFolderId,
        fields: 'id, name, trashed'
      });
      if (res.data && !res.data.trashed) {
        return cachedFolderId;
      }
    } catch {
      // Cached ID invalid or deleted, re-discover below
    }
  }

  const folderName = config.google.workspaceFolderName;

  // Search for folder in user's Drive root
  const query = `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const listRes = await drive.files.list({
    q: query,
    spaces: 'drive',
    fields: 'files(id, name)'
  });

  if (listRes.data.files && listRes.data.files.length > 0) {
    const folderId = listRes.data.files[0].id;
    setMetadata('workspace_root_id', folderId);
    return folderId;
  }

  // Create workspace root folder
  const createRes = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder'
    },
    fields: 'id, name'
  });

  const rootId = createRes.data.id;
  setMetadata('workspace_root_id', rootId);

  // Initialize standard subdirectories: context, memory, output
  const subfolders = ['context', 'memory', 'output'];
  for (const sub of subfolders) {
    await drive.files.create({
      requestBody: {
        name: sub,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [rootId]
      }
    });
  }

  return rootId;
}

/**
 * Resolve a relative workspace path (e.g. 'context/specs.md') to a Google Drive file or folder.
 */
export async function resolvePathToId(relativePath, options = { createParents: false }) {
  const rootId = await getOrCreateWorkspaceFolder();
  if (!relativePath || relativePath === '.' || relativePath === '/' || relativePath === '') {
    return rootId;
  }

  const drive = await getDrive();
  const segments = relativePath.split('/').filter(Boolean);
  let currentParentId = rootId;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;

    const q = `'${currentParentId}' in parents and name = '${segment.replace(/'/g, "\\'")}' and trashed = false`;
    const res = await drive.files.list({
      q,
      fields: 'files(id, name, mimeType)'
    });

    if (res.data.files && res.data.files.length > 0) {
      currentParentId = res.data.files[0].id;
    } else {
      if (!isLast && options.createParents) {
        // Create intermediate folder
        const folderRes = await drive.files.create({
          requestBody: {
            name: segment,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [currentParentId]
          },
          fields: 'id'
        });
        currentParentId = folderRes.data.id;
      } else {
        return null;
      }
    }
  }

  return currentParentId;
}

/**
 * List the full recursive tree of files in the workspace folder.
 */
export async function listWorkspaceTree() {
  const rootId = await getOrCreateWorkspaceFolder();
  const drive = await getDrive();

  const res = await drive.files.list({
    q: `'${rootId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink, iconLink)',
    orderBy: 'folder, name'
  });

  const files = res.data.files || [];
  const tree = [];

  for (const item of files) {
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      const subRes = await drive.files.list({
        q: `'${item.id}' in parents and trashed = false`,
        fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink, iconLink)',
        orderBy: 'name'
      });
      tree.push({
        ...item,
        children: subRes.data.files || []
      });
    } else {
      tree.push(item);
    }
  }

  return { rootId, items: tree };
}

/**
 * Reads a document or file from Google Drive.
 * Automatically exports Google Docs to markdown/plain text.
 */
export async function readDriveFile(fileId) {
  const drive = await getDrive();

  const metaRes = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, modifiedTime, webViewLink, size'
  });

  const meta = metaRes.data;
  let content = '';

  if (meta.mimeType === 'application/vnd.google-apps.document') {
    // Export Google Doc as text/plain
    const exportRes = await drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'text' }
    );
    content = exportRes.data;
  } else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
    // Export Google Sheet as CSV
    const exportRes = await drive.files.export(
      { fileId, mimeType: 'text/csv' },
      { responseType: 'text' }
    );
    content = exportRes.data;
  } else {
    // Regular media file (markdown, txt, json, code, etc.)
    const getRes = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' }
    );
    content = typeof getRes.data === 'string' ? getRes.data : JSON.stringify(getRes.data);
  }

  return {
    meta,
    content
  };
}

/**
 * Creates or updates a file in Google Drive inside the workspace.
 * e.g. path = 'agent.md' or 'output/daily-report.md'
 */
export async function writeDriveFile({ path: relativePath, content, mimeType = 'text/markdown' }) {
  const drive = await getDrive();
  const rootId = await getOrCreateWorkspaceFolder();

  const segments = relativePath.split('/').filter(Boolean);
  const fileName = segments.pop();
  const folderPath = segments.join('/');

  let targetParentId = rootId;
  if (folderPath) {
    targetParentId = await resolvePathToId(folderPath, { createParents: true });
  }

  // Check if file already exists in target parent
  const q = `'${targetParentId}' in parents and name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`;
  const existingRes = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType)'
  });

  const media = {
    mimeType,
    body: Readable.from(Buffer.from(content, 'utf8'))
  };

  if (existingRes.data.files && existingRes.data.files.length > 0) {
    const existingFile = existingRes.data.files[0];
    const updateRes = await drive.files.update({
      fileId: existingFile.id,
      media,
      fields: 'id, name, mimeType, modifiedTime, webViewLink'
    });
    return {
      status: 'updated',
      file: updateRes.data
    };
  } else {
    const createRes = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType,
        parents: [targetParentId]
      },
      media,
      fields: 'id, name, mimeType, modifiedTime, webViewLink'
    });
    return {
      status: 'created',
      file: createRes.data
    };
  }
}

/**
 * Full-text search across the workspace folder.
 */
export async function searchWorkspaceFiles(query, { maxResults = 10 } = {}) {
  const drive = await getDrive();
  const rootId = await getOrCreateWorkspaceFolder();

  // Search files within workspace or all subfolders
  const q = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
  const res = await drive.files.list({
    q,
    pageSize: maxResults,
    fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink, parents)'
  });

  return res.data.files || [];
}

/**
 * Fetch Google Drive storage quota and user info.
 */
export async function getDriveOverview() {
  const drive = await getDrive();
  const about = await drive.about.get({
    fields: 'user, storageQuota'
  });
  return {
    user: about.data.user,
    storage: about.data.storageQuota
  };
}
