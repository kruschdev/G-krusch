/**
 * AES-256-GCM Encryption / Decryption Utility
 * Used for securing stored OAuth tokens and credentials at rest.
 */

import crypto from 'crypto';
import config from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Derives a consistent 32-byte key from the configured secret or a fallback.
 */
function getDerivedKey() {
  const secret = process.env.ENCRYPTION_KEY || config.google.clientSecret || 'g-krusch-homelab-secure-fallback-key-2026';
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Output format: <hex_iv>:<hex_tag>:<hex_ciphertext>
 */
export function encrypt(text) {
  if (!text) return '';
  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted string.
 * Supports transparent fallback for legacy plaintext JSON.
 */
export function decrypt(encryptedText) {
  if (!encryptedText) return '';

  // Transparent backwards compatibility for unencrypted JSON
  if (encryptedText.trim().startsWith('{') || encryptedText.trim().startsWith('[')) {
    return encryptedText;
  }

  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    // Unknown format, return as is
    return encryptedText;
  }

  const [ivHex, tagHex, cipherHex] = parts;
  const key = getDerivedKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
