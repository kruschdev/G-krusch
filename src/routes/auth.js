import { Router } from 'express';
import { getAuthorizationUrl, handleOAuthCallback, getAuthStatus } from '../lib/oauth.js';
import { deleteCredentials } from '../lib/db.js';

const router = Router();

// Initiate OAuth flow
router.get('/google', (req, res) => {
  try {
    const authUrl = getAuthorizationUrl();
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`<h3>OAuth Configuration Error</h3><p>${err.message}</p>`);
  }
});

// OAuth Callback
router.get('/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Authorization code missing.');
  }

  try {
    const result = await handleOAuthCallback(code);
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Google Drive Connected — G-Krusch</title>
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
              max-width: 480px;
            }
            h1 { color: #38bdf8; margin-top: 0; font-size: 1.6rem; }
            p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
            .btn {
              display: inline-block;
              margin-top: 1.5rem;
              padding: 0.75rem 1.75rem;
              background: #0284c7;
              color: #fff;
              text-decoration: none;
              font-weight: 600;
              border-radius: 8px;
              transition: all 0.2s ease;
            }
            .btn:hover { background: #38bdf8; transform: translateY(-2px); }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>🚀 Google Drive Connected!</h1>
            <p>Account <strong>${result.email}</strong> is now securely authenticated with G-Krusch.</p>
            <p>Your agent workspace folder, <code>agent.md</code> steering, and RAG vector store are now active.</p>
            <a href="/" class="btn">Return to Dashboard</a>
          </div>
          <script>
            setTimeout(() => {
              if (window.opener) {
                window.close();
              } else {
                window.location.href = '/';
              }
            }, 2500);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[OAuth Callback Error]:', err);
    res.status(500).send(`<h3>Authentication Failed</h3><p>${err.message}</p>`);
  }
});

// Status check
router.get('/status', (req, res) => {
  res.json(getAuthStatus());
});

// Disconnect
router.post('/disconnect', (req, res) => {
  deleteCredentials('google_oauth');
  res.json({ success: true, message: 'Google Drive disconnected.' });
});

export default router;
