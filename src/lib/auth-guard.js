/**
 * Security, CORS & Auth Guard Middleware
 * - Protects workspace & MCP endpoints if API_KEY or GCRUSH_SECRET is configured.
 * - Uses constant-time Buffer comparison to prevent timing side-channel leaks.
 * - Restricts browser CORS requests to trusted localhost, LAN, and Tailscale origins.
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

/**
 * Validates whether a browser Origin header is from a trusted local, LAN, or Tailscale host.
 */
export function isAllowedOrigin(origin) {
  // Non-browser requests (CLI, MCP, server-to-server) omit Origin
  if (!origin) return true;

  const configured = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (configured.includes('*') || configured.includes(origin)) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();

    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      return true;
    }

    // RFC1918 LAN & Tailscale CGNAT (100.64.0.0/10)
    if (
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) ||
      host.endsWith('.ts.net') ||
      host.endsWith('.local')
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

export function createCorsOptions() {
  return {
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin "${origin}" not permitted by G-Krusch CORS policy.`));
    }
  };
}

export function requireAuthIfConfigured(req, res, next) {
  const secret = process.env.API_KEY || process.env.GCRUSH_SECRET;

  // If no secret configured, allow local homelab requests
  if (!secret) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];
  const queryKey = req.query?.apiKey;

  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (apiKeyHeader) {
    token = String(apiKeyHeader).trim();
  } else if (queryKey) {
    token = String(queryKey).trim();
  }

  if (!isTimingSafeMatch(token, secret)) {
    return res.status(401).json({
      error: 'Unauthorized: Valid API key required for G-Krusch workspace operations.',
      hint: 'Provide "Authorization: Bearer <key>" or "x-api-key" header.'
    });
  }

  next();
}

