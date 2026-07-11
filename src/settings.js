'use strict';

const { RESEND_API_KEY, EMAIL_FROM, INVITES_ENABLED, DROP_ADMIN_API_KEY, DASHBOARD_URL_BASE, DROP_API_URL, EMAIL_RE } = require('./config');
const { getSettings } = require('./store');

// Owns: settings validation, the "stored || env-derived default" effective
// getters (templates pattern — no boot-time seeding, no provenance
// tracking), and allowlisted API view builders.
//
// INVARIANT: the settings object (and anything holding a real secret, e.g.
// getEffectiveEmailSettings()'s return value or getEffectiveDropAdminKey()'s
// return value) must NEVER be spread or serialized into an API response, a
// log line, or a CSV. View builders below construct their output
// field-by-field from an explicit allowlist for exactly this reason —
// `hasPassword` is a boolean, never the password; the DROP admin key never
// appears in a view at all.

const MAX_ADDR_LEN = 320; // email / username-as-address fields
const MAX_HOST_LEN = 253;
const MAX_FROM_LEN = 200;
const MAX_PASSWORD_LEN = 500;
const MAX_URL_LEN = 2048;

// Reject bare CR/LF (header injection) and other C0/DEL control characters.
// Reused here for from/host/username and by routes.js for template subjects.
function hasControlChars(s) {
  return /[\r\n\x00-\x1f\x7f]/.test(String(s == null ? '' : s));
}

const HOSTNAME_RE = /^[a-zA-Z0-9.-]+$/;
const FROM_ADDR_RE = /^(.*)<([^<>]+)>\s*$/;

// Printable ASCII, no spaces — the DROP admin key goes raw into an
// Authorization header, and Node's fetch embeds the full header value in a
// thrown TypeError on any non-ByteString character.
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;

// Extracts the bare address out of "Name <addr>" or a bare address string —
// deliberately simple (no RFC 5322 parser), matching smtp.js's own parsing.
function extractFromAddr(from) {
  const m = String(from).match(FROM_ADDR_RE);
  return (m ? m[2] : from).trim();
}

// ── effective getters ("stored || env-derived default", read at call time) ────

function getEffectiveEmailSettings() {
  const stored = getSettings().email;
  if (stored && typeof stored === 'object') {
    const smtp = stored.smtp || {};
    return {
      provider: stored.provider || 'none',
      from: stored.from || EMAIL_FROM,
      smtp: {
        host: smtp.host || '',
        port: smtp.port || 465,
        security: smtp.security === 'starttls' ? 'starttls' : 'tls',
        username: smtp.username || '',
        password: smtp.password || '',
      },
    };
  }
  return {
    provider: RESEND_API_KEY ? 'resend' : 'none',
    from: EMAIL_FROM,
    smtp: { host: '', port: 465, security: 'tls', username: '', password: '' },
  };
}

function isInvitesEnabled() {
  const stored = getSettings().invitesEnabled;
  if (stored && typeof stored === 'object' && typeof stored.value === 'boolean') {
    return stored.value;
  }
  return INVITES_ENABLED;
}

function getEffectiveDropAdminKey() {
  const stored = getSettings().dropAdminKey;
  if (stored && typeof stored === 'object' && typeof stored.value === 'string' && stored.value) {
    return stored.value;
  }
  return DROP_ADMIN_API_KEY;
}

// Read at call time so a UI save takes effect immediately (no restart, no
// frozen-constant trap). Single canonical `/dashboard` append site — whoever
// wins (stored base | env base | DROP_API_URL) gets suffixed exactly once.
function getEffectiveDashboardUrl() {
  const stored = getSettings().dashboardUrl;
  const storedBase = (stored && typeof stored === 'object' && typeof stored.value === 'string' && stored.value)
    ? stored.value
    : '';
  return (storedBase || DASHBOARD_URL_BASE || DROP_API_URL).replace(/\/$/, '') + '/dashboard';
}

// Internal-only helper for buildInvitesView's warning flag. Keyed off the
// *effective* host, independent of source — an env var pointed at an
// internal host is equally dead as a stored one. An unparseable effective
// URL is treated as internal too (equally unreachable from a browser).
const INTERNAL_HOSTS = new Set(['drop-host', '127.0.0.1', 'localhost', '::1', '0.0.0.0']);
function isDashboardUrlInternal() {
  try {
    const url = new URL(getEffectiveDashboardUrl());
    let host = url.hostname.toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    return INTERNAL_HOSTS.has(host);
  } catch {
    return true;
  }
}

// ── validation ──────────────────────────────────────────────────────────────

// Validates a POST /api/admin/settings `email` section. Returns
// {ok:true, value} where `value` is the exact shape store.setSettingsSection
// persists, or {ok:false, error}.
function validateEmailSection(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'email must be an object' };
  const { provider } = body;
  if (!['none', 'resend', 'smtp'].includes(provider)) {
    return { ok: false, error: 'email.provider must be "none", "resend", or "smtp"' };
  }

  let from = '';
  if (provider === 'resend' || provider === 'smtp') {
    if (typeof body.from !== 'string' || !body.from.trim()) {
      return { ok: false, error: 'email.from is required for resend/smtp' };
    }
    from = body.from.trim();
    if (from.length > MAX_FROM_LEN) return { ok: false, error: `email.from must be ${MAX_FROM_LEN} characters or fewer` };
    if (hasControlChars(from)) return { ok: false, error: 'email.from contains invalid control characters' };
    if (!EMAIL_RE.test(extractFromAddr(from))) {
      return { ok: false, error: 'email.from must contain a valid email address' };
    }
  } else if (typeof body.from === 'string') {
    from = body.from.trim().slice(0, MAX_FROM_LEN);
    if (hasControlChars(from)) return { ok: false, error: 'email.from contains invalid control characters' };
  }

  const value = { provider, from, smtp: { host: '', port: 465, security: 'tls', username: '', password: '' } };
  if (provider !== 'smtp') return { ok: true, value };

  const smtpBody = body.smtp || {};

  const host = typeof smtpBody.host === 'string' ? smtpBody.host.trim() : '';
  if (!host) return { ok: false, error: 'email.smtp.host is required' };
  if (host.length > MAX_HOST_LEN) return { ok: false, error: `email.smtp.host must be ${MAX_HOST_LEN} characters or fewer` };
  if (hasControlChars(host) || !HOSTNAME_RE.test(host)) {
    return { ok: false, error: 'email.smtp.host contains invalid characters' };
  }

  // Security: 'tls' (implicit, default) or 'starttls'. Validated before the
  // port default below so an omitted port can default per-mode (465 / 587).
  let security = 'tls';
  if (smtpBody.security !== undefined) {
    if (smtpBody.security !== 'tls' && smtpBody.security !== 'starttls') {
      return { ok: false, error: 'email.smtp.security must be "tls" or "starttls"' };
    }
    security = smtpBody.security;
  }

  let port = security === 'starttls' ? 587 : 465;
  if (smtpBody.port !== undefined && smtpBody.port !== null && smtpBody.port !== '') {
    port = Number(smtpBody.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: 'email.smtp.port must be an integer between 1 and 65535' };
    }
  }

  const username = typeof smtpBody.username === 'string' ? smtpBody.username.trim() : '';
  if (!username) return { ok: false, error: 'email.smtp.username is required' };
  if (username.length > MAX_ADDR_LEN) return { ok: false, error: `email.smtp.username must be ${MAX_ADDR_LEN} characters or fewer` };
  if (hasControlChars(username)) return { ok: false, error: 'email.smtp.username contains invalid control characters' };

  // Password is write-only and three-state: absent/'' keeps whatever is
  // already stored; clearPassword:true clears it; a non-empty string sets it.
  const existing = getSettings().email;
  const existingPassword = (existing && existing.smtp && existing.smtp.password) || '';
  let password;
  if (smtpBody.clearPassword === true) {
    password = '';
  } else if (smtpBody.password === undefined || smtpBody.password === '') {
    password = existingPassword;
  } else if (typeof smtpBody.password === 'string') {
    if (hasControlChars(smtpBody.password)) return { ok: false, error: 'email.smtp.password contains invalid control characters' };
    if (smtpBody.password.length > MAX_PASSWORD_LEN) return { ok: false, error: 'email.smtp.password is too long' };
    password = smtpBody.password;
  } else {
    return { ok: false, error: 'email.smtp.password must be a string' };
  }

  value.smtp = { host, port, security, username, password };
  return { ok: true, value };
}

function validateInvitesEnabled(value) {
  if (typeof value !== 'boolean') return { ok: false, error: 'invitesEnabled must be a boolean' };
  return { ok: true, value };
}

function validateDropAdminKey(value) {
  if (typeof value !== 'string') return { ok: false, error: 'dropAdminKey must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: 'dropAdminKey must not be empty' };
  if (trimmed.length > MAX_PASSWORD_LEN) return { ok: false, error: `dropAdminKey must be ${MAX_PASSWORD_LEN} characters or fewer` };
  if (!PRINTABLE_ASCII_RE.test(trimmed)) {
    return { ok: false, error: 'dropAdminKey must contain only printable ASCII characters (no spaces)' };
  }
  return { ok: true, value: trimmed };
}

// Validates a POST /api/admin/settings `dashboardUrl` value (Option A: base +
// append `/dashboard`, locked by docs/plans/2026-07-11-dashboard-url-ui-setting.md).
// Stores a normalized BASE (no trailing slash, no trailing /dashboard segment)
// — never the full suffixed URL — so getEffectiveDashboardUrl has a single
// canonical append site. Does not auto-prepend a scheme: a scheme-less input
// like "dropkit.sh" is rejected with an actionable message instead of guessed.
function validateDashboardUrl(value) {
  if (typeof value !== 'string') return { ok: false, error: 'dashboardUrl must be a string' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: 'dashboardUrl must not be empty' };
  if (trimmed.length > MAX_URL_LEN) return { ok: false, error: `dashboardUrl must be ${MAX_URL_LEN} characters or fewer` };
  if (hasControlChars(trimmed)) return { ok: false, error: 'dashboardUrl contains invalid control characters' };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'dashboardUrl must be a valid URL including http:// or https://' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'dashboardUrl must use http:// or https://' };
  }
  if (url.username) {
    return { ok: false, error: 'dashboardUrl must not contain a username/password' };
  }

  // Normalize on the parsed pathname (never the raw string): strip one
  // trailing slash, then strip a trailing `/dashboard` segment — leading-slash
  // anchored + case-insensitive so a host like `mydashboard` or a segment like
  // `dashboard-foo` is left untouched. `search`/`hash` are dropped by
  // construction (we rebuild from `origin` + pathname only).
  let pathname = url.pathname.replace(/\/$/, '');
  pathname = pathname.replace(/\/dashboard\/?$/i, '');

  return { ok: true, value: url.origin + pathname };
}

// ── allowlisted API views — never spread the settings object (see INVARIANT) ──

function buildEmailView() {
  const effective = getEffectiveEmailSettings();
  const stored = getSettings().email;
  return {
    provider: effective.provider,
    from: effective.from,
    smtp: {
      host: effective.smtp.host,
      port: effective.smtp.port,
      security: effective.smtp.security,
      username: effective.smtp.username,
      hasPassword: !!effective.smtp.password,
    },
    savedAt: (stored && stored.savedAt) || null,
  };
}

function buildInvitesView() {
  const stored = getSettings().invitesEnabled;
  const storedKey = getSettings().dropAdminKey;
  const dropKeySaved = storedKey && typeof storedKey === 'object' && typeof storedKey.value === 'string' && storedKey.value;
  const storedDashboardUrl = getSettings().dashboardUrl;
  const dashboardUrlSaved = storedDashboardUrl && typeof storedDashboardUrl === 'object'
    && typeof storedDashboardUrl.value === 'string' && storedDashboardUrl.value;
  return {
    enabled: isInvitesEnabled(),
    savedAt: (stored && typeof stored === 'object' && stored.savedAt) || null,
    dropKeySavedAt: (dropKeySaved && storedKey.savedAt) || null,
    dropKeyEnvSet: !!DROP_ADMIN_API_KEY,
    dashboardUrl: getEffectiveDashboardUrl(),
    dashboardUrlSavedAt: (dashboardUrlSaved && storedDashboardUrl.savedAt) || null,
    dashboardUrlEnvSet: !!DASHBOARD_URL_BASE,
    dashboardUrlInternal: isDashboardUrlInternal(),
  };
}

// Provider-aware "usable" check for the top-level emailConfigured flag.
function isEmailConfigured() {
  const effective = getEffectiveEmailSettings();
  if (effective.provider === 'resend') return !!RESEND_API_KEY;
  if (effective.provider === 'smtp') {
    return !!(effective.smtp.host && effective.smtp.username && effective.smtp.password);
  }
  return false;
}

module.exports = {
  getEffectiveEmailSettings,
  isInvitesEnabled,
  getEffectiveDropAdminKey,
  getEffectiveDashboardUrl,
  validateEmailSection,
  validateInvitesEnabled,
  validateDropAdminKey,
  validateDashboardUrl,
  buildEmailView,
  buildInvitesView,
  isEmailConfigured,
  hasControlChars,
};
