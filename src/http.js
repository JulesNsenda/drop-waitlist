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

function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-admin-token'] || '');
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { send, sendJson, readJsonBody, adminAuthorized };
