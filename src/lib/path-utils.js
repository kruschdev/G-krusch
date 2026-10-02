/**
 * Strict path sanitization and validation for agentic Google Drive workspace.
 * Prevents directory traversal, illegal characters, unsafe paths, and sensitive file exfiltration.
 */

const ILLEGAL_CHARS_REGEX = /[<>:"\\|?*\x00-\x1F]/;
const MAX_PATH_LENGTH = 500;
const MAX_SEGMENT_LENGTH = 120;

const FORBIDDEN_EXACT_NAMES = new Set([
  '.env',
  '.git',
  '.gitignore',
  '.npmrc',
  '.ssh',
  'id_rsa',
  'id_ed25519',
  '.bashrc',
  '.zshrc',
  '.profile',
  'authorized_keys'
]);

export function isForbiddenSegment(segment) {
  if (!segment) return false;
  const lower = segment.toLowerCase();
  if (FORBIDDEN_EXACT_NAMES.has(lower)) return true;
  if (lower.startsWith('.env.') || lower.startsWith('.env_')) return true;
  if (lower.endsWith('.key') || lower.endsWith('.pem')) return true;
  return false;
}

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

  // Split into segments
  const rawSegments = normalized.split('/').filter(Boolean);

  if (rawSegments.length === 0) {
    throw new Error('Path must resolve to a valid non-root file or directory.');
  }

  // Filter out benign single dot '.' segments (e.g. ./context/specs.md -> context/specs.md)
  const segments = rawSegments.filter(s => s !== '.');

  if (segments.length === 0) {
    throw new Error('Path must resolve to a valid non-root file or directory.');
  }

  for (const segment of segments) {
    if (segment === '..') {
      throw new Error('Directory traversal sequence ("..") is strictly forbidden.');
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new Error(`Path segment "${segment}" exceeds maximum length of ${MAX_SEGMENT_LENGTH}.`);
    }
    if (isForbiddenSegment(segment)) {
      throw new Error(`Access to sensitive or forbidden file "${segment}" is strictly blocked.`);
    }
  }

  return segments.join('/');
}

export function isValidFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') return false;
  if (fileName === '.' || fileName === '..') return false;
  if (ILLEGAL_CHARS_REGEX.test(fileName)) return false;
  if (fileName.length > MAX_SEGMENT_LENGTH) return false;
  if (isForbiddenSegment(fileName)) return false;
  return true;
}

