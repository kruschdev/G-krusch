/**
 * Security & Auth Guard Middleware
 * Protects mutating endpoints if API_KEY or GCRUSH_SECRET is configured.
 * Uses constant-time Buffer comparison to prevent timing side-channel leaks.
 */

import crypto from 'crypto';

export function isTimingSafeMatch(candidate, secret) {
  if (!candidate || !secret || typeof candidate !== 'string' || typeof secret !== 'string') {
    return false;
  }
  const bufA = Buffer.from(candidate, 'utf-8');
  const bufB = Buffer.from(secret, 'utf-8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function requireAuthIfConfigured(req, res, next) {
  const secret = process.env.API_KEY || process.env.GCRUSH_SECRET;

  // If no secret configured, allow local homelab requests
  if (!secret) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];

  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (apiKeyHeader) {
    token = String(apiKeyHeader).trim();
  }

  if (!isTimingSafeMatch(token, secret)) {
    return res.status(401).json({
      error: 'Unauthorized: Valid API key required for mutating workspace operations.',
      hint: 'Provide "Authorization: Bearer <key>" or "x-api-key" header.'
    });
  }

  next();
}

