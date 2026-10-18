import crypto from 'crypto';
import { google } from 'googleapis';
import config from '../config.js';
import { saveCredentials, getCredentials, deleteCredentials } from './db.js';
import { isTimingSafeMatch } from './auth-guard.js';
import { mutex } from './mutex.js';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PENDING_OAUTH_STATES = 32;
let cachedClient = null;
let cachedTokensHash = null;
/** @type {Map<string, number>} */
const pendingOAuthStates = new Map();

function pruneExpiredOAuthStates(now = Date.now()) {
  for (const [token, expiresAt] of pendingOAuthStates) {
    if (now > expiresAt) {
      pendingOAuthStates.delete(token);
    }
  }
}

export function resetOAuthClientCache() {
  cachedClient = null;
  cachedTokensHash = null;
}

export function generateOAuthState() {
  const now = Date.now();
  pruneExpiredOAuthStates(now);
  while (pendingOAuthStates.size >= MAX_PENDING_OAUTH_STATES) {
    const oldestKey = pendingOAuthStates.keys().next().value;
    if (!oldestKey) break;
    pendingOAuthStates.delete(oldestKey);
  }
  const state = crypto.randomBytes(32).toString('hex');
  pendingOAuthStates.set(state, now + OAUTH_STATE_TTL_MS);
  return state;
}

export function hasPendingOAuthState() {
  pruneExpiredOAuthStates();
  return pendingOAuthStates.size > 0;
}

export function verifyOAuthState(candidateState) {
  pruneExpiredOAuthStates();
  if (pendingOAuthStates.size === 0) {
    return false;
  }
  const candidate = String(candidateState || '');
  let matchedKey = null;
  for (const state of pendingOAuthStates.keys()) {
    if (isTimingSafeMatch(candidate, state)) {
      matchedKey = state;
    }
  }
  if (matchedKey) {
    pendingOAuthStates.delete(matchedKey);
    return true;
  }
  return false;
}

export function createOAuth2Client() {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new Error('Google OAuth credentials not configured in .env (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
  }

  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

export function getAuthorizationUrl(loginHint) {
  const client = createOAuth2Client();
  const hint = (loginHint || process.env.GOOGLE_LOGIN_HINT || '').trim();
  const state = generateOAuthState();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: config.google.scopes,
    state,
    ...(hint ? { login_hint: hint } : {})
  });
}

export async function handleOAuthCallback(code) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Fetch user profile email
  let userEmail = 'authenticated_user';
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const userInfo = await oauth2.userinfo.get();
    if (userInfo.data.email) {
      userEmail = userInfo.data.email;
    }
  } catch (err) {
    console.warn('[OAuth] Could not fetch user email:', err.message);
  }

  saveCredentials('google_oauth', tokens, userEmail);
  resetOAuthClientCache();
  return { tokens, email: userEmail };
}

export async function getAuthenticatedClient() {
  const creds = getCredentials('google_oauth');
  if (!creds || !creds.tokens) {
    throw new Error('Google Drive is not authenticated. Please authenticate via the web dashboard at /auth/google.');
  }

  // Token hash to detect database updates
  const tokenJson = JSON.stringify(creds.tokens);

  if (cachedClient && cachedTokensHash === tokenJson) {
    // Check if token expires within 60 seconds
    const expiry = creds.tokens.expiry_date;
    const isExpiringSoon = expiry && (expiry <= Date.now() + 60000);

    if (!isExpiringSoon) {
      return cachedClient;
    }
  }

  return mutex.runExclusive('oauth_token_refresh', async () => {
    // Re-check credentials inside lock in case another request refreshed them
    const freshCreds = getCredentials('google_oauth');
    if (!freshCreds || !freshCreds.tokens) {
      throw new Error('Google Drive is not authenticated.');
    }

    const client = createOAuth2Client();
    client.setCredentials(freshCreds.tokens);

    // Bind token refresh listener
    client.on('tokens', (newTokens) => {
      const merged = { ...freshCreds.tokens, ...newTokens };
      saveCredentials('google_oauth', merged, freshCreds.email);
      cachedTokensHash = JSON.stringify(merged);
    });

    // Proactively refresh if expired or about to expire
    const expiry = freshCreds.tokens.expiry_date;
    if (freshCreds.tokens.refresh_token && expiry && (expiry <= Date.now() + 60000)) {
      try {
        const { credentials } = await client.refreshAccessToken();
        const merged = { ...freshCreds.tokens, ...credentials };
        saveCredentials('google_oauth', merged, freshCreds.email);
        client.setCredentials(merged);
        cachedTokensHash = JSON.stringify(merged);
      } catch (refreshErr) {
        console.warn('[OAuth] Proactive token refresh failed, continuing with current tokens:', refreshErr.message);
      }
    } else {
      cachedTokensHash = JSON.stringify(freshCreds.tokens);
    }

    cachedClient = client;
    return client;
  });
}

export function getAuthStatus() {
  const creds = getCredentials('google_oauth');
  return {
    authenticated: !!(creds && creds.tokens),
    email: creds?.email || null,
    updatedAt: creds?.updated_at || null
  };
}

