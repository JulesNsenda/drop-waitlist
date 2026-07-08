'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PORT, STORE_PATH } = require('./config');
const { loadStore } = require('./store');
const { send, sendJson, adminAuthorized } = require('./http');
const { serveStatic } = require('./static');
const { isInvitesEnabled } = require('./settings');
const {
  handleJoin, listEntries, handleApprove,
  handleGetSettings, handleSaveSettings, handleResetSettings, handleTestEmail,
  handleSaveTemplate, handleResetTemplate, handleExportCsv,
} = require('./routes');

// Read once at startup — fails fast if a file is missing.
const LANDING_HTML = fs.readFileSync(path.join(__dirname, 'ui', 'landing.html'), 'utf-8');
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'ui', 'admin.html'), 'utf-8');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    if (req.method === 'GET' && p.startsWith('/ui/')) return serveStatic(res, p);
    if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true });
    if (req.method === 'GET' && (p === '/' || p === '')) return send(res, 200, LANDING_HTML);
    if (req.method === 'GET' && p === '/admin') return send(res, 200, ADMIN_HTML);
    if (req.method === 'POST' && p === '/api/join') return handleJoin(req, res);

    // ── admin endpoints (all token-gated) ────────────────────────────────────
    if (p === '/api/admin/entries' && req.method === 'GET') {
      if (!adminAuthorized(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return listEntries(res);
    }
    if (p === '/api/admin/approve' && req.method === 'POST') {
      if (!adminAuthorized(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return handleApprove(req, res);
    }
    if (p === '/api/admin/settings' && req.method === 'GET') {
      if (!adminAuthorized(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return handleGetSettings(res);
    }
    if (p === '/api/admin/settings' && req.method === 'POST') {
      if (!adminAuthorized(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return handleSaveSettings(req, res);
    }
    if (p === '/api/admin/settings/reset' && req.method === 'POST') {
      if (!adminAuthorized(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return handleResetSettings(req, res);
    }
    if (p === '/api/admin/test-email' && req.method === 'POST') {
      if (!adminAuthorized(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return handleTestEmail(req, res);
    }
    if (p === '/api/admin/templates' && req.method === 'POST') {
      if (!adminAuthorized(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return handleSaveTemplate(req, res);
    }
    if (p === '/api/admin/templates/reset' && req.method === 'POST') {
      if (!adminAuthorized(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return handleResetTemplate(req, res);
    }
    if (p === '/api/admin/export.csv' && req.method === 'GET') {
      if (!adminAuthorized(req)) return sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return handleExportCsv(res);
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    console.error('[waitlist] error', err);
    return sendJson(res, 500, { ok: false, error: 'Internal error' });
  }
});

loadStore().then(() => {
  server.listen(PORT, () => {
    console.log(`[waitlist] listening on :${PORT}  (data: ${STORE_PATH}, invites: ${isInvitesEnabled() ? 'on' : 'off'})`);
  });
});
