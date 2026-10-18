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

  // If no secret configured, only allow loopback requests (127.0.0.1 / ::1)
  if (!secret) {
    const remoteIp = String(req.socket?.remoteAddress || req.ip || '').replace(/^::ffff:/, '');
    if (!remoteIp || remoteIp === '127.0.0.1' || remoteIp === '::1') {
      return next();
    }
    return res.status(401).json({
      error: 'Unauthorized: G-Krusch requires API_KEY or GCRUSH_SECRET for non-loopback requests.'
    });
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

/**
 * Sets standard HTTP security headers to prevent MIME sniffing, clickjacking, and referrer leakage.
 */
export function securityHeadersMiddleware(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
}

/**
 * Lightweight in-memory sliding-window rate limiter per client IP.
 */
export function createRateLimiter({ windowMs = 60000, maxRequests = 120 } = {}) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const clientIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    let entry = buckets.get(clientIp);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(clientIp, entry);
    }

    entry.count += 1;

    if (buckets.size > 1000) {
      for (const [k, v] of buckets) {
        if (now >= v.resetAt) buckets.delete(k);
      }
    }

    if (entry.count > maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'Rate limit exceeded. Please slow down workspace requests.',
        retryAfterSeconds: retryAfterSec
      });
    }

    next();
  };
}

