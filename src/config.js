'use strict';

const path = require('path');

// __dirname is <root>/src; anchor data dir to the project root, not src/
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DROP_DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'waitlist.json');

const ADMIN_TOKEN = process.env.WAITLIST_ADMIN_TOKEN || '';
const INVITES_ENABLED = process.env.WAITLIST_INVITES_ENABLED === 'true';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'DROP <onboarding@resend.dev>';

// MUST stay env-only: the DROP admin key below is UI-configurable, and a
// UI-settable URL next to it would let an admin-token holder exfiltrate the
// key by redirecting provisioning (which sends the key as a Bearer header)
// to a host they control.
const DROP_API_URL = (process.env.DROP_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const DROP_ADMIN_API_KEY = process.env.DROP_ADMIN_API_KEY || '';
const DASHBOARD_URL = (process.env.DASHBOARD_URL || DROP_API_URL).replace(/\/$/, '') + '/dashboard';

const WAITLIST_JOIN_LIMIT = parseInt(process.env.WAITLIST_JOIN_LIMIT || '20', 10);
const WAITLIST_JOIN_WINDOW_MS = parseInt(process.env.WAITLIST_JOIN_WINDOW_MS || '3600000', 10);
const WAITLIST_EMAIL_BUDGET_PER_HOUR = parseInt(process.env.WAITLIST_EMAIL_BUDGET_PER_HOUR || '200', 10);
const TRUSTED_PROXY_IPS = (process.env.TRUSTED_PROXY_IPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = {
  PORT,
  DATA_DIR,
  STORE_PATH,
  ADMIN_TOKEN,
  INVITES_ENABLED,
  RESEND_API_KEY,
  EMAIL_FROM,
  DROP_API_URL,
  DROP_ADMIN_API_KEY,
  DASHBOARD_URL,
  WAITLIST_JOIN_LIMIT,
  WAITLIST_JOIN_WINDOW_MS,
  WAITLIST_EMAIL_BUDGET_PER_HOUR,
  TRUSTED_PROXY_IPS,
  EMAIL_RE,
};
