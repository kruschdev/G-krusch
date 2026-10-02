/**
 * Strict path sanitization and validation for agentic Google Drive workspace.
 * Prevents directory traversal, illegal characters, and unsafe paths.
 */

import path from 'path';

const ILLEGAL_CHARS_REGEX = /[<>:"\\|?*\x00-\x1F]/;
const MAX_PATH_LENGTH = 500;
const MAX_SEGMENT_LENGTH = 120;

export function sanitizeWorkspacePath(rawPath) {
  if (typeof rawPath !== 'string') {
    throw new Error('Workspace path must be a non-empty string.');
  }

  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error('Workspace path cannot be empty.');
  }

  if (trimmed.length > MAX_PATH_LENGTH) {
    throw new Error(`Path exceeds maximum allowed length of ${MAX_PATH_LENGTH} characters.`);
  }

  // Reject null bytes or control characters
  if (ILLEGAL_CHARS_REGEX.test(trimmed)) {
    throw new Error('Path contains illegal control characters or forbidden symbols (<>:"\\|?*).');
  }

  // Normalize slashes (convert backslashes to forward slashes)
  const normalized = trimmed.replace(/\\/g, '/');

  // Split into segments and validate each
  const segments = normalized.split('/').filter(Boolean);

  if (segments.length === 0) {
    throw new Error('Path must resolve to a valid non-root file or directory.');
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error('Directory traversal sequence ("." or "..") is strictly forbidden.');
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new Error(`Path segment "${segment}" exceeds maximum length of ${MAX_SEGMENT_LENGTH}.`);
    }
  }

  return segments.join('/');
}

export function isValidFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') return false;
  if (fileName === '.' || fileName === '..') return false;
  if (ILLEGAL_CHARS_REGEX.test(fileName)) return false;
  return fileName.length <= MAX_SEGMENT_LENGTH;
}
