import { google } from 'googleapis';
import config from '../config.js';
import { saveCredentials, getCredentials } from './db.js';

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

export function getAuthorizationUrl() {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: config.google.scopes
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
  return { tokens, email: userEmail };
}

export async function getAuthenticatedClient() {
  const creds = getCredentials('google_oauth');
  if (!creds || !creds.tokens) {
    throw new Error('Google Drive is not authenticated. Please authenticate via the web dashboard at /auth/google.');
  }

  const client = createOAuth2Client();
  client.setCredentials(creds.tokens);

  // Listen for automatic token refreshes and persist them
  client.on('tokens', (newTokens) => {
    const merged = { ...creds.tokens, ...newTokens };
    saveCredentials('google_oauth', merged, creds.email);
  });

  return client;
}

export function getAuthStatus() {
  const creds = getCredentials('google_oauth');
  return {
    authenticated: !!(creds && creds.tokens),
    email: creds?.email || null,
    updatedAt: creds?.updated_at || null
  };
}
