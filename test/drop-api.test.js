'use strict';

const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// drop-api.js resolves its admin key via settings.js -> config.js, and
// config.js captures env vars into module-level constants at require time
// (same caveat as settings.test.js). Each test below gets its own throwaway
// data dir and a fresh require of config/store/settings/drop-api so env
// overrides never leak between tests, regardless of run order.

const tmpDirs = [];

function mkTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-waitlist-drop-api-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Only var this file cares about — reset to unset on every freshModules()
// call so ambient shell state can never leak into a test that expects '' or
// a specific value.
const ENV_KEYS_UNDER_TEST = ['DROP_ADMIN_API_KEY'];

// Sets env, drops the require cache for config/store/settings/drop-api, and
// re-requires them fresh. drop-api.js is required fresh too (not just at the
// top of this file) so it always sees the settings/config for the env just
// set — requiring it once at module load would anchor DATA_DIR to the real
// project data/ dir before any test env override took effect.
function freshModules(envOverrides = {}) {
  const dir = mkTmpDir();
  process.env.DROP_DATA_DIR = dir;
  for (const key of ENV_KEYS_UNDER_TEST) delete process.env[key];
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const name of ['../src/config', '../src/store', '../src/settings', '../src/drop-api']) {
    delete require.cache[require.resolve(name)];
  }
  return {
    dir,
    config: require('../src/config'),
    store: require('../src/store'),
    settings: require('../src/settings'),
    dropApi: require('../src/drop-api'),
  };
}

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonBody(opts) {
  return JSON.parse(opts.body);
}

// ── upstream error-detail redaction ─────────────────────────────────────────────

test('provisionAccount: upstream 500 body containing the key is redacted in the returned error', async () => {
  const KEY = 'SECRET-KEY-abc123';
  const { dropApi } = freshModules({ DROP_ADMIN_API_KEY: KEY });
  global.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => `Unauthorized: Bearer ${KEY} was rejected`,
  });

  const result = await dropApi.provisionAccount('redacttest@example.com');
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('[redacted]'), `expected [redacted] in: ${result.error}`);
  assert.ok(!result.error.includes(KEY), `key leaked in error: ${result.error}`);
});

// ── fetch-boundary sanitization ──────────────────────────────────────────────────

test('provisionAccount: a thrown fetch error is rethrown sanitized (no key, no original message)', async () => {
  const KEY = 'SECRET-KEY-abc123';
  const { dropApi } = freshModules({ DROP_ADMIN_API_KEY: KEY });
  global.fetch = async () => {
    // Mirrors the real failure mode: Node's fetch throws a TypeError that
    // embeds the full (invalid) header value when it contains non-ByteString
    // characters — this must never reach the caller unsanitized.
    throw new TypeError(`Header content contains invalid characters: Bearer ${KEY}`);
  };

  await assert.rejects(
    () => dropApi.provisionAccount('rethrowtest@example.com'),
    (err) => {
      assert.ok(err.message.includes('DROP API request failed'), `unexpected message: ${err.message}`);
      assert.ok(!err.message.includes(KEY), `key leaked in thrown error: ${err.message}`);
      assert.ok(
        !err.message.includes('Header content contains invalid characters'),
        `original fetch error message leaked: ${err.message}`
      );
      return true;
    }
  );
});

// ── 409 username retry ───────────────────────────────────────────────────────────

test('provisionAccount: 409 then 200 retries with a suffixed username', async () => {
  const { dropApi } = freshModules({ DROP_ADMIN_API_KEY: 'a-key' });
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, body: jsonBody(opts) });
    if (calls.length === 1) return { ok: false, status: 409, text: async () => '' };
    return { ok: true, status: 200, text: async () => '' };
  };

  const result = await dropApi.provisionAccount('retryuser@example.com');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.username, 'retryuser');
  assert.equal(calls[1].body.username, 'retryuser-2');
  assert.equal(result.username, 'retryuser-2');
  assert.equal(typeof result.password, 'string');
  assert.ok(result.password.length > 0);
});

// ── happy path ─────────────────────────────────────────────────────────────────

test('provisionAccount: happy path returns {ok:true, username, password}', async () => {
  const { dropApi } = freshModules({ DROP_ADMIN_API_KEY: 'a-key' });
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '' });

  const result = await dropApi.provisionAccount('happyuser@example.com');
  assert.equal(result.ok, true);
  assert.equal(result.username, 'happyuser');
  assert.equal(typeof result.password, 'string');
  assert.ok(result.password.length > 0);
});
