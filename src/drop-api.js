'use strict';

const crypto = require('crypto');
const { DROP_API_URL } = require('./config');
const { getEffectiveDropAdminKey } = require('./settings');

// DROP_API_URL stays env-only — see the comment at its definition in
// config.js (exfiltration risk if it were UI-settable alongside the key).

function deriveUsername(email) {
  let base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (base.length < 3) base = `user${base}`;
  return base.slice(0, 24);
}

async function createDropUser(username, password, key) {
  try {
    return await fetch(`${DROP_API_URL}/api/v1/auth/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password, role: 'user' }),
    });
  } catch (err) {
    // Node's fetch throws a TypeError that embeds the full header value for
    // a bad Authorization header — never surface err.message here, or the
    // key leaks into logs/error responses. err.cause?.code IS safe to show:
    // transport failures (ECONNREFUSED/ENOTFOUND/ETIMEDOUT) never carry the
    // header, and the bad-header TypeError has no .cause, so it falls back to
    // err.name and nothing leaks. That code is what distinguishes an
    // unreachable DROP from a malformed URL from a bad key.
    const detail = (err && err.cause && err.cause.code) || (err && err.name) || 'Error';
    throw new Error('DROP API request failed: ' + detail);
  }
}

// Retries with a numeric suffix on username conflict. The key is resolved
// once per call so every retry attempt (and the eventual error) uses the
// same key.
async function provisionAccount(email) {
  const key = getEffectiveDropAdminKey();
  const base = deriveUsername(email);
  const password = crypto.randomBytes(12).toString('base64url');
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = attempt === 0 ? base : `${base}-${attempt + 1}`;
    let res;
    try {
      res = await createDropUser(username, password, key);
    } catch (err) {
      // createDropUser already scrubs the key from its message — surface it as
      // the {ok:false} contract so the admin gets a 502 with the cause code,
      // not an opaque 500 from the server-level catch.
      return { ok: false, error: err.message };
    }
    if (res.ok) return { ok: true, username, password };
    if (res.status === 409) continue;
    let detail = await res.text().catch(() => '');
    // Scrub the presented key from any upstream echo before it reaches the
    // admin client — DROP is not guaranteed to redact it on auth failures.
    if (key) detail = detail.split(key).join('[redacted]');
    return { ok: false, error: `DROP API ${res.status}: ${detail.slice(0, 200)}` };
  }
  return { ok: false, error: 'could not find an available username' };
}

module.exports = { provisionAccount };
