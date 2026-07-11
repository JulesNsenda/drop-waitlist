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

// Shared fetch-with-scrub for reprovisionAccount's two sequential calls.
// Mirrors createDropUser's key-scrub try/catch (never surface err.message —
// it may embed the raw header value) so a bad-header TypeError can't leak
// the key through either call site.
async function dropFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (err) {
    const detail = (err && err.cause && err.cause.code) || (err && err.name) || 'Error';
    throw new Error('DROP API request failed: ' + detail);
  }
}

// Scrubs the presented key from any upstream echo before it reaches the
// admin client — DROP is not guaranteed to redact it on auth failures.
// Mirrors provisionAccount's scrub at the 409-body site above.
async function scrubbedError(res, key) {
  let detail = await res.text().catch(() => '');
  if (key) detail = detail.split(key).join('[redacted]');
  return `DROP API ${res.status}: ${detail.slice(0, 200)}`;
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

// Resets an already-provisioned DROP account's password (re-invite path).
// The temp password is never persisted, so re-inviting an already-invited
// entry can't resend the original credentials — it must mint a fresh one.
// The key is resolved once so both calls (and any error) use the same key.
async function reprovisionAccount(username) {
  const key = getEffectiveDropAdminKey();

  let listRes;
  try {
    listRes = await dropFetch(`${DROP_API_URL}/api/v1/auth/users`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (err) {
    // dropFetch already scrubs the key from its message — surface it as the
    // {ok:false} contract so the caller gets a definite outcome, not a
    // thrown error.
    return { ok: false, error: err.message };
  }
  if (!listRes.ok) return { ok: false, error: await scrubbedError(listRes, key) };

  let body;
  try {
    body = JSON.parse(await listRes.text());
  } catch {
    return { ok: false, error: 'DROP API returned an invalid user list response' };
  }
  const users = (body && Array.isArray(body.data)) ? body.data : [];
  const user = users.find((u) => u.username === username);
  if (!user) return { ok: false, code: 'not_found' };
  if (user.enabled === false) return { ok: false, code: 'disabled' };

  const password = crypto.randomBytes(12).toString('base64url');

  let resetRes;
  try {
    resetRes = await dropFetch(`${DROP_API_URL}/api/v1/auth/users/${user.id}/reset-password`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ newPassword: password }),
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!resetRes.ok) return { ok: false, error: await scrubbedError(resetRes, key) };

  return { ok: true, username, password };
}

module.exports = { provisionAccount, reprovisionAccount };
