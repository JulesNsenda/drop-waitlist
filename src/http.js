'use strict';

const crypto = require('crypto');
const { ADMIN_TOKEN } = require('./config');

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers });
  res.end(data);
}

function sendJson(res, status, obj) {
  send(res, status, obj, {});
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let tooBig = false;
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// Timing-safe string comparison via SHA-256 — hashing to fixed-length digests
// removes the length branch that would otherwise leak token length.
function safeEqual(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-admin-token'] || '');
  return safeEqual(provided, ADMIN_TOKEN);
}

module.exports = { send, sendJson, readJsonBody, adminAuthorized, safeEqual };
