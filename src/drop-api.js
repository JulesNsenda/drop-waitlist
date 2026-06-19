'use strict';

const crypto = require('crypto');
const { DROP_API_URL, DROP_ADMIN_API_KEY } = require('./config');

function deriveUsername(email) {
  let base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (base.length < 3) base = `user${base}`;
  return base.slice(0, 24);
}

async function createDropUser(username, password) {
  return fetch(`${DROP_API_URL}/api/v1/auth/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DROP_ADMIN_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password, role: 'user' }),
  });
}

// Retries with a numeric suffix on username conflict.
async function provisionAccount(email) {
  const base = deriveUsername(email);
  const password = crypto.randomBytes(12).toString('base64url');
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const res = await createDropUser(username, password);
    if (res.ok) return { ok: true, username, password };
    if (res.status === 409) continue;
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `DROP API ${res.status}: ${detail.slice(0, 200)}` };
  }
  return { ok: false, error: 'could not find an available username' };
}

module.exports = { provisionAccount };
