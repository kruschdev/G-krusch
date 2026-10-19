import { Router } from 'express';
import {
  getAuthorizationUrl,
  handleOAuthCallback,
  getAuthStatus,
  resetOAuthClientCache,
  hasPendingOAuthState,
  verifyOAuthState
} from '../lib/oauth.js';
import { getAgentSteering, invalidateSteeringCache } from '../lib/steering.js';
import { clearWorkspaceSessionState } from '../lib/db.js';
import { requireAuthIfConfigured } from '../lib/auth-guard.js';
import config from '../config.js';

const router = Router();

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Initiate OAuth flow
router.get('/google', (req, res) => {
  try {
    const authUrl = getAuthorizationUrl();
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`<h3>OAuth Configuration Error</h3><p>${escapeHtml(err.message)}</p>`);
  }
});

// OAuth Callback (supports /auth/google/callback and /api/google/callback)
export async function oauthCallbackHandler(req, res) {
  const code = req.query.code;
  const state = req.query.state;
  if (!code) {
    return res.status(400).send('Authorization code missing.');
  }

  // Enforce CSRF state check on all OAuth callbacks (closing missing-state CSRF gap)
  if ((hasPendingOAuthState() || state !== undefined || !config.isTestRuntime || process.env.NODE_ENV === 'production' || !state) && !verifyOAuthState(String(state || ''))) {
    return res.status(403).send('<h3>OAuth Security Error</h3><p>Invalid or expired OAuth state parameter.</p>');
  }

  try {
    const result = await handleOAuthCallback(String(code));
    // Immediately provision or pull agent.md from Google Drive on successful OAuth connect
    getAgentSteering({ forceRefresh: true }).catch((err) => {
      console.warn('[OAuth] Initial agent.md provisioning deferred:', err.message);
    });

    const safeEmail = escapeHtml(result.email);
    const hubUrl = config.baseUrl || 'http://localhost:5446';
    const companionUrl = process.env.KRUSCH_COMPANION_URL || 'http://localhost:3004';
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Google Workspace Connected — G-Krusch</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              background: #0f172a;
              color: #f8fafc;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
            }
            .card {
              background: rgba(30, 41, 59, 0.85);
              border: 1px solid rgba(56, 189, 248, 0.3);
              backdrop-filter: blur(12px);
              padding: 2.5rem;
              border-radius: 16px;
              text-align: center;
              box-shadow: 0 20px 40px rgba(0,0,0,0.5);
              max-width: 520px;
            }
            h1 { color: #38bdf8; margin-top: 0; font-size: 1.6rem; }
            p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
            .btn-row { display: flex; gap: 12px; justify-content: center; margin-top: 1.5rem; flex-wrap: wrap; }
            .btn {
              display: inline-block;
              padding: 0.75rem 1.4rem;
              background: #0284c7;
              color: #fff;
              text-decoration: none;
              font-weight: 600;
              border-radius: 8px;
              transition: all 0.2s ease;
            }
            .btn.secondary { background: #0d9488; }
            .btn:hover { background: #38bdf8; transform: translateY(-2px); }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>🚀 Google Workspace Connected!</h1>
            <p>Account <strong>${safeEmail}</strong> is now securely authenticated with G-Krusch &amp; Krusch Companion.</p>
            <p>Your Google Drive workspace folder (<code>G-Krusch/agent.md</code>), RAG vector store, Google Calendar, and Gmail extensions are now active.</p>
            <div class="btn-row">
              <a href="${escapeHtml(companionUrl)}" class="btn secondary">Open Krusch Companion (:3004)</a>
              <a href="${escapeHtml(hubUrl)}" class="btn">Open G-Krusch Hub (:5446)</a>
            </div>
          </div>
          <script>
            setTimeout(() => {
              if (window.opener) {
                window.close();
              } else {
                window.location.href = ${JSON.stringify(hubUrl)};
              }
            }, 2500);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[OAuth Callback Error]:', err);
    res.status(500).send(`<h3>Authentication Failed</h3><p>${escapeHtml(err.message)}</p>`);
  }
}

router.get('/google/callback', oauthCallbackHandler);

// Status check
router.get('/status', (req, res) => {
  res.json(getAuthStatus());
});

// Disconnect
router.post('/disconnect', requireAuthIfConfigured, (req, res) => {
  clearWorkspaceSessionState('google_oauth');
  invalidateSteeringCache();
  resetOAuthClientCache();
  res.json({ success: true, message: 'Google Workspace disconnected.' });
});

export default router;


