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
    // key leaks into logs/error responses.
    throw new Error('DROP API request failed: ' + (err && err.name ? err.name : 'Error'));
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
    const res = await createDropUser(username, password, key);
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
