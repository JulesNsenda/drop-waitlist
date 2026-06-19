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

const DROP_API_URL = (process.env.DROP_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const DROP_ADMIN_API_KEY = process.env.DROP_ADMIN_API_KEY || '';
const DASHBOARD_URL = (process.env.DASHBOARD_URL || DROP_API_URL).replace(/\/$/, '') + '/dashboard';

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
  EMAIL_RE,
};
