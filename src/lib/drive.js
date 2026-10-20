import { google } from 'googleapis';
import { Readable } from 'stream';
import config from '../config.js';
import { getAuthenticatedClient } from './oauth.js';
import { getMetadata, setMetadata, purgeIndexedDocumentTransactional, bumpSteeringCacheEpoch } from './db.js';
import { withRetry } from './retry.js';
import { mutex } from './mutex.js';
import { sanitizeWorkspacePath, escapeDriveQueryLiteral, isValidDriveId } from './path-utils.js';
import { parsePdfBuffer } from './pdf.js';
import { prepareWorkspaceWritePayload, inferWorkspaceMimeFromPath } from './slides.js';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB safety cap
const MAX_WRITE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB write cap

export function isBinaryMimeType(mimeType) {
  if (!mimeType) return false;
  if (mimeType.startsWith('image/')) return true;
  if (mimeType.startsWith('audio/')) return true;
  if (mimeType.startsWith('video/')) return true;
  if ([
    'application/zip',
    'application/x-zip-compressed',
    'application/x-tar',
    'application/gzip',
    'application/octet-stream',
    'application/x-executable'
  ].includes(mimeType)) {
    return true;
  }
  return false;
}

export async function getDrive() {
  const auth = await getAuthenticatedClient();
  return google.drive({ version: 'v3', auth });
}

/**
 * Finds or automatically provisions the root workspace folder in Google Drive.
 * Protected by mutex to prevent concurrent duplicate folder creations.
 */
export async function getOrCreateWorkspaceFolder() {
  return mutex.runExclusive('workspace_root', async () => {
    const cachedFolderId = getMetadata('workspace_root_id');
    const drive = await getDrive();

    if (cachedFolderId && isValidDriveId(cachedFolderId)) {
      try {
        const res = await withRetry(() => drive.files.get({
          fileId: cachedFolderId,
          fields: 'id, name, trashed'
        }));
        if (res.data && !res.data.trashed) {
          return cachedFolderId;
        }
      } catch {
        // Cached ID invalid or deleted, re-discover below
      }
    }

    const folderName = config.google.workspaceFolderName;

    // Search for folder in user's Drive root
    const query = `name = '${escapeDriveQueryLiteral(folderName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const listRes = await withRetry(() => drive.files.list({
      q: query,
      spaces: 'drive',
      fields: 'files(id, name)'
    }));

    if (listRes.data.files && listRes.data.files.length > 0) {
      const folderId = listRes.data.files[0].id;
      setMetadata('workspace_root_id', folderId);
      return folderId;
    }

    // Create workspace root folder
    const createRes = await withRetry(() => drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder'
      },
      fields: 'id, name'
    }));

    const rootId = createRes.data.id;
    setMetadata('workspace_root_id', rootId);

    // Initialize standard subdirectories: context, memory, output
    const subfolders = ['context', 'memory', 'output'];
    for (const sub of subfolders) {
      await withRetry(() => drive.files.create({
        requestBody: {
          name: sub,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [rootId]
        }
      }));
    }

    return rootId;
  });
}

/**
 * Resolve a relative workspace path (e.g. 'context/specs.md') to a Google Drive file or folder.
 */
export async function resolvePathToId(relativePath, options = { createParents: false }) {
  if (!relativePath || relativePath === '.' || relativePath === '/' || relativePath === '') {
    return await getOrCreateWorkspaceFolder();
  }

  const cleanPath = sanitizeWorkspacePath(relativePath);
  const rootId = await getOrCreateWorkspaceFolder();
  const drive = await getDrive();
  const segments = cleanPath.split('/').filter(Boolean);
  let currentParentId = rootId;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    const stripped = isLast ? segment.replace(/\.(slides|gslides|pptx|gdoc|gsheet|sheet)$/i, '') : segment;
    const expectedMime = isLast ? inferWorkspaceMimeFromPath(segment) : null;
    const nameClause = stripped !== segment
      ? `(name = '${escapeDriveQueryLiteral(segment)}' or name = '${escapeDriveQueryLiteral(stripped)}')`
      : `name = '${escapeDriveQueryLiteral(segment)}'`;

    const q = `'${escapeDriveQueryLiteral(currentParentId)}' in parents and ${nameClause} and trashed = false`;
    const res = await withRetry(() => drive.files.list({
      q,
      fields: 'files(id, name, mimeType)'
    }));

    if (res.data.files && res.data.files.length > 0) {
      const matched = expectedMime
        ? (res.data.files.find(f => f.mimeType === expectedMime) || res.data.files[0])
        : res.data.files[0];
      currentParentId = matched.id;
    } else {
      if (!isLast && options.createParents) {
        const folderRes = await withRetry(() => drive.files.create({
          requestBody: {
            name: segment,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [currentParentId]
          },
          fields: 'id'
        }));
        currentParentId = folderRes.data.id;
      } else {
        return null;
      }
    }
  }

  return currentParentId;
}

/**
 * Fetch all files inside a parent folder with pagination support.
 */
async function listFolderFiles(drive, parentId) {
  const allFiles = [];
  let pageToken = null;

  do {
    const res = await withRetry(() => drive.files.list({
      q: `'${escapeDriveQueryLiteral(parentId)}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, iconLink)',
      orderBy: 'folder, name',
      pageSize: 100,
      pageToken: pageToken || undefined
    }));

    if (res.data.files) {
      allFiles.push(...res.data.files);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

/**
 * Recursively build folder hierarchy with depth limit.
 */
async function buildFolderTree(drive, parentId, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return [];

  const files = await listFolderFiles(drive, parentId);
  const items = [];

  for (const item of files) {
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      const children = await buildFolderTree(drive, item.id, depth + 1, maxDepth);
      items.push({
        ...item,
        children
      });
    } else {
      items.push(item);
    }
  }

  return items;
}

/**
 * List the full recursive tree of files in the workspace folder.
 */
export async function listWorkspaceTree() {
  const rootId = await getOrCreateWorkspaceFolder();
  const drive = await getDrive();
  const tree = await buildFolderTree(drive, rootId);

  return { rootId, items: tree };
}

/**
 * Reads a document or file from Google Drive with size limits, format conversion,
 * workspace boundary verification, and binary guards.
 */
export async function readDriveFile(fileId, { enforceWorkspace = true } = {}) {
  if (!fileId || !isValidDriveId(fileId)) {
    throw new Error('A valid Google Drive fileId is required to read file.');
  }
  const drive = await getDrive();

  if (enforceWorkspace) {
    const rootId = await getOrCreateWorkspaceFolder();
    const inWorkspace = await isFileInWorkspace(drive, fileId, rootId);
    if (!inWorkspace) {
      throw new Error('Refusing to read file outside the G-Krusch workspace boundary.');
    }
  }

  const metaRes = await withRetry(() => drive.files.get({
    fileId,
    fields: 'id, name, mimeType, modifiedTime, webViewLink, size'
  }));

  const meta = metaRes.data;

  // Folder guard
  if (meta.mimeType === 'application/vnd.google-apps.folder') {
    throw new Error(`Cannot read content of folder "${meta.name}". Use list_drive_workspace to inspect folder contents.`);
  }

  // Enforce size limit on large non-Google docs
  if (meta.size && parseInt(meta.size, 10) > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File "${meta.name}" exceeds maximum allowed size limit of 10MB.`);
  }

  // Binary file guard
  if (isBinaryMimeType(meta.mimeType)) {
    return {
      meta,
      isBinary: true,
      content: `[Binary File: ${meta.name} (${meta.mimeType}, ${meta.size || 0} bytes)]\nView in browser: ${meta.webViewLink || 'N/A'}`
    };
  }

  if (meta.mimeType === 'application/pdf') {
    const getRes = await withRetry(() => drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    ));
    const buffer = Buffer.from(getRes.data);
    const parsed = await parsePdfBuffer(buffer, meta.name);
    return {
      meta,
      isBinary: false,
      content: parsed.text,
      chunks: parsed.chunks,
      pdfEngine: parsed.engine
    };
  }

  let content = '';
  let chunks = null;

  if (meta.mimeType === 'application/vnd.google-apps.document') {
    const exportRes = await withRetry(() => drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'text' }
    ));
    content = exportRes.data;
  } else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
    const exportRes = await withRetry(() => drive.files.export(
      { fileId, mimeType: 'text/csv' },
      { responseType: 'text' }
    ));
    content = exportRes.data;
  } else if (meta.mimeType === 'application/vnd.google-apps.presentation') {
    const exportRes = await withRetry(() => drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'text' }
    ));
    content = exportRes.data;
  } else {
    const getRes = await withRetry(() => drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'text' }
    ));
    content = typeof getRes.data === 'string' ? getRes.data : JSON.stringify(getRes.data);
  }

  return {
    meta,
    isBinary: false,
    content: String(content || ''),
    chunks
  };
}

/**
 * Creates or updates a file in Google Drive inside the workspace.
 * Mutex protected by target path.
 */
export async function writeDriveFile({ path: relativePath, content, mimeType = 'text/markdown' }) {
  const cleanPath = sanitizeWorkspacePath(relativePath);

  if (content && typeof content === 'string' && Buffer.byteLength(content, 'utf8') > MAX_WRITE_SIZE_BYTES) {
    throw new Error(`Write content exceeds maximum allowed size limit of 10MB.`);
  }

  return mutex.runExclusive(`write:${cleanPath}`, async () => {
    const drive = await getDrive();
    const rootId = await getOrCreateWorkspaceFolder();

    const segments = cleanPath.split('/').filter(Boolean);
    const fileName = segments.pop();
    const folderPath = segments.join('/');

    let targetParentId = rootId;
    if (folderPath) {
      targetParentId = await resolvePathToId(folderPath, { createParents: true });
    }

    const payload = prepareWorkspaceWritePayload({ fileName, content, mimeType });

    // Check if file already exists in target parent (match either targetName or raw fileName)
    const nameFilter = payload.targetName !== fileName
      ? `(name = '${escapeDriveQueryLiteral(payload.targetName)}' or name = '${escapeDriveQueryLiteral(fileName)}')`
      : `name = '${escapeDriveQueryLiteral(payload.targetName)}'`;
    const q = `'${escapeDriveQueryLiteral(targetParentId)}' in parents and ${nameFilter} and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
    const existingRes = await withRetry(() => drive.files.list({
      q,
      fields: 'files(id, name, mimeType)'
    }));

    const media = {
      mimeType: payload.uploadMimeType,
      body: Readable.from(payload.uploadBuffer)
    };

    const isNativeWorkspaceTarget = String(payload.targetMimeType || '').startsWith('application/vnd.google-apps.');
    const candidates = existingRes.data.files || [];
    const existingFile = isNativeWorkspaceTarget
      ? candidates.find(f => f.mimeType === payload.targetMimeType)
      : candidates.find(f => !String(f.mimeType || '').startsWith('application/vnd.google-apps.'));

    let result;
    if (existingFile) {
      const updateRes = await withRetry(() => drive.files.update({
        fileId: existingFile.id,
        requestBody: {
          name: payload.targetName
        },
        media,
        fields: 'id, name, mimeType, modifiedTime, webViewLink'
      }));
      result = {
        status: 'updated',
        file: updateRes.data,
        ...payload.extraMeta
      };
    } else {
      const createRes = await withRetry(() => drive.files.create({
        requestBody: {
          name: payload.targetName,
          mimeType: payload.targetMimeType,
          parents: [targetParentId]
        },
        media,
        fields: 'id, name, mimeType, modifiedTime, webViewLink'
      }));
      result = {
        status: 'created',
        file: createRes.data,
        ...payload.extraMeta
      };
    }

    if (cleanPath.toLowerCase() === 'agent.md' || cleanPath.toLowerCase() === 'agents.md') {
      bumpSteeringCacheEpoch();
    }

    return result;
  });
}

/**
 * Verifies that a target file or folder is a descendant of the workspace root folder.
 */
export async function isFileInWorkspace(drive, targetId, rootId, maxDepth = 8) {
  if (!targetId || !rootId || !isValidDriveId(targetId)) return false;
  if (targetId === rootId) return true;

  let currentId = targetId;
  for (let depth = 0; depth < maxDepth; depth++) {
    const meta = await withRetry(() => drive.files.get({
      fileId: currentId,
      fields: 'id, parents'
    }));
    const parents = meta.data?.parents || [];
    if (parents.length === 0) return false;
    if (parents.includes(rootId)) return true;
    currentId = parents[0];
  }
  return false;
}

/**
 * Safely trashes a file or folder inside the workspace and purges its local RAG/FTS5 index.
 * Enforces workspace boundary verification so files outside G-Krusch cannot be trashed.
 */
export async function deleteDriveFile({ fileId, path: relativePath }) {
  let targetId = fileId;
  let resolvedFromWorkspacePath = false;

  if (!targetId && relativePath) {
    targetId = await resolvePathToId(relativePath);
    resolvedFromWorkspacePath = true;
  }
  if (!targetId) {
    throw new Error('Target file not found for deletion.');
  }
  if (!isValidDriveId(targetId)) {
    throw new Error(`Invalid Google Drive fileId: "${targetId}"`);
  }

  const rootId = await getOrCreateWorkspaceFolder();
  if (targetId === rootId) {
    throw new Error('Deleting the workspace root folder is strictly prohibited.');
  }

  return mutex.runExclusive(`delete:${targetId}`, async () => {
    const drive = await getDrive();
    if (!resolvedFromWorkspacePath) {
      const inWorkspace = await isFileInWorkspace(drive, targetId, rootId);
      if (!inWorkspace) {
        throw new Error('Refusing to delete file outside the G-Krusch workspace boundary.');
      }
    }

    await withRetry(() => drive.files.update({
      fileId: targetId,
      requestBody: { trashed: true }
    }));

    purgeIndexedDocumentTransactional(targetId);

    return { status: 'trashed', fileId: targetId };
  });
}

/**
 * Full-text search across the workspace folder.
 */
export async function searchWorkspaceFiles(query, { maxResults = 10 } = {}) {
  const drive = await getDrive();
  const safeLimit = Math.min(Math.max(1, maxResults), 50);

  const cleanQuery = escapeDriveQueryLiteral(String(query || '').slice(0, 200));
  const q = `fullText contains '${cleanQuery}' and trashed = false`;
  const res = await withRetry(() => drive.files.list({
    q,
    pageSize: safeLimit,
    fields: 'files(id, name, mimeType, size, modifiedTime, webViewLink, parents)'
  }));

  return res.data.files || [];
}

/**
 * Fetch Google Drive storage quota and user info.
 */
export async function getDriveOverview() {
  const drive = await getDrive();
  const about = await withRetry(() => drive.about.get({
    fields: 'user, storageQuota'
  }));
  return {
    user: about.data.user,
    storage: about.data.storageQuota
  };
}

