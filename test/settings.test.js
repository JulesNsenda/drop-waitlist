'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// settings.js + store.js are effectively singletons keyed by env
// (DROP_DATA_DIR, RESEND_API_KEY, ...) read once at require time. Each test
// below gets its own throwaway temp data dir and a fresh require of
// config/store/settings so tests are fully isolated and order-independent —
// no shared mutable state between tests, regardless of run order.

const tmpDirs = [];

function mkTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-waitlist-settings-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// Env vars whose value this file cares about — reset to a clean/unset
// baseline on every freshModules() call (below) so one test's override (e.g.
// RESEND_API_KEY: 'test-key') can never leak into a later test that doesn't
// ask for it, regardless of execution order.
const ENV_KEYS_UNDER_TEST = ['RESEND_API_KEY', 'WAITLIST_INVITES_ENABLED'];

// Sets env, drops the require cache for config/store/settings, and re-requires
// them fresh. `seed`, if given, is written as waitlist.json before requiring
// so loadStore() picks it up (used for the normalization tests).
function freshModules(envOverrides = {}, seed) {
  const dir = mkTmpDir();
  if (seed !== undefined) {
    fs.writeFileSync(path.join(dir, 'waitlist.json'), JSON.stringify(seed));
  }
  process.env.DROP_DATA_DIR = dir;
  for (const key of ENV_KEYS_UNDER_TEST) delete process.env[key];
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const name of ['../src/config', '../src/store', '../src/settings']) {
    delete require.cache[require.resolve(name)];
  }
  return {
    dir,
    config: require('../src/config'),
    store: require('../src/store'),
    settings: require('../src/settings'),
  };
}

const SMTP_OK = { host: 'smtp.hostinger.com', username: 'hello@drop.dev', password: 'sekrit' };

// ── effective getters ────────────────────────────────────────────────────────

test('getEffectiveEmailSettings: none + empty smtp when nothing saved and no RESEND_API_KEY', async () => {
  const { store, settings } = freshModules({ RESEND_API_KEY: undefined });
  await store.loadStore();
  const eff = settings.getEffectiveEmailSettings();
  assert.equal(eff.provider, 'none');
  assert.deepEqual(eff.smtp, { host: '', port: 465, security: 'tls', username: '', password: '' });
});

test('getEffectiveEmailSettings: defaults to resend when RESEND_API_KEY set and nothing saved', async () => {
  const { store, settings } = freshModules({ RESEND_API_KEY: 'test-key' });
  await store.loadStore();
  assert.equal(settings.getEffectiveEmailSettings().provider, 'resend');
});

test('getEffectiveEmailSettings: stored section wins over env default', async () => {
  const { store, settings } = freshModules({ RESEND_API_KEY: 'test-key' });
  await store.loadStore();
  const saved = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: SMTP_OK });
  assert.ok(saved.ok, saved.error);
  await store.setSettingsSection('email', saved.value);
  assert.equal(settings.getEffectiveEmailSettings().provider, 'smtp');
});

test('isInvitesEnabled: env fallback (false) used when nothing saved', async () => {
  const { store, settings } = freshModules({ WAITLIST_INVITES_ENABLED: undefined });
  await store.loadStore();
  assert.equal(settings.isInvitesEnabled(), false);
});

test('isInvitesEnabled: env fallback (true) used when nothing saved', async () => {
  const { store, settings } = freshModules({ WAITLIST_INVITES_ENABLED: 'true' });
  await store.loadStore();
  assert.equal(settings.isInvitesEnabled(), true);
});

test('isInvitesEnabled: stored value overrides env fallback', async () => {
  const { store, settings } = freshModules({ WAITLIST_INVITES_ENABLED: undefined });
  await store.loadStore();
  await store.setSettingsSection('invitesEnabled', true);
  assert.equal(settings.isInvitesEnabled(), true);
});

// ── validateEmailSection: shape / provider / port / security ──────────────────

test('validateEmailSection: rejects unknown provider', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  assert.equal(settings.validateEmailSection({ provider: 'sendgrid' }).ok, false);
});

test('validateEmailSection: provider none needs no from', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({ provider: 'none' });
  assert.equal(result.ok, true);
  assert.equal(result.value.provider, 'none');
});

test('validateEmailSection: CRLF/control chars in from are rejected even for provider none', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({ provider: 'none', from: 'x\r\ny' });
  assert.equal(result.ok, false);
});

test('validateEmailSection: from required for resend', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  assert.equal(settings.validateEmailSection({ provider: 'resend' }).ok, false);
});

test('validateEmailSection: accepts "Name <addr>" and bare-address from', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  assert.equal(settings.validateEmailSection({ provider: 'resend', from: 'DROP <hello@drop.dev>' }).ok, true);
  assert.equal(settings.validateEmailSection({ provider: 'resend', from: 'hello@drop.dev' }).ok, true);
});

test('validateEmailSection: rejects from with an invalid address', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  assert.equal(settings.validateEmailSection({ provider: 'resend', from: 'DROP <not-an-email>' }).ok, false);
});

test('validateEmailSection: rejects from exceeding the length cap', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const longFrom = 'DROP <' + 'a'.repeat(320) + '@b.com>';
  assert.equal(settings.validateEmailSection({ provider: 'resend', from: longFrom }).ok, false);
});

test('validateEmailSection: smtp requires host and username', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  assert.equal(settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: {} }).ok, false);
  assert.equal(
    settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: { host: 'h.example.com' } }).ok,
    false
  );
});

test('validateEmailSection: rejects invalid hostname characters', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({
    provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, host: 'smtp host!' },
  });
  assert.equal(result.ok, false);
});

test('validateEmailSection: rejects host exceeding the length cap', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const longHost = 'a'.repeat(260) + '.com';
  const result = settings.validateEmailSection({
    provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, host: longHost },
  });
  assert.equal(result.ok, false);
});

test('validateEmailSection: defaults port to 465 when omitted', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: SMTP_OK });
  assert.equal(result.ok, true);
  assert.equal(result.value.smtp.port, 465);
});

test('validateEmailSection: rejects out-of-range and non-integer ports', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  assert.equal(
    settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, port: 70000 } }).ok,
    false
  );
  assert.equal(
    settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, port: 465.5 } }).ok,
    false
  );
  assert.equal(
    settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, port: 0 } }).ok,
    false
  );
});

test('validateEmailSection: rejects STARTTLS — only "tls" is accepted', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({
    provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, security: 'starttls' },
  });
  assert.equal(result.ok, false);
});

test('validateEmailSection: accepts explicit security "tls"', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({
    provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, security: 'tls' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.smtp.security, 'tls');
});

// ── CRLF / control-char rejection ───────────────────────────────────────────────

test('validateEmailSection: rejects CRLF in from', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({ provider: 'resend', from: 'DROP\r\n <hello@drop.dev>' });
  assert.equal(result.ok, false);
});

test('validateEmailSection: rejects control chars in the from display name', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({ provider: 'resend', from: 'DR\x07OP <hello@drop.dev>' });
  assert.equal(result.ok, false);
});

test('validateEmailSection: rejects CRLF in smtp host', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({
    provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, host: 'smtp.host.com\r\nEvil: 1' },
  });
  assert.equal(result.ok, false);
});

test('validateEmailSection: rejects control chars in smtp username', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({
    provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, username: 'a@b.com\r\nEvil: 1' },
  });
  assert.equal(result.ok, false);
});

test('hasControlChars: subject-guard helper — detects CRLF/control chars, allows normal text', async () => {
  const { settings } = freshModules();
  assert.equal(settings.hasControlChars('Hi\r\nBcc: evil@attacker.example'), true);
  assert.equal(settings.hasControlChars('Hi\x07there'), true);
  assert.equal(settings.hasControlChars('A perfectly normal subject line'), false);
});

// ── password three-state ────────────────────────────────────────────────────────

test('password three-state: explicit value sets it', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, password: 'first-secret' } });
  assert.equal(result.ok, true);
  assert.equal(result.value.smtp.password, 'first-secret');
});

test('password three-state: absent password keeps the existing stored one', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const first = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, password: 'kept-secret' } });
  await store.setSettingsSection('email', first.value);

  const { password, ...smtpWithoutPassword } = SMTP_OK;
  const second = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: smtpWithoutPassword });
  assert.equal(second.ok, true);
  assert.equal(second.value.smtp.password, 'kept-secret');
});

test('password three-state: empty-string password keeps the existing stored one', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const first = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, password: 'kept-secret-2' } });
  await store.setSettingsSection('email', first.value);

  const second = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, password: '' } });
  assert.equal(second.ok, true);
  assert.equal(second.value.smtp.password, 'kept-secret-2');
});

test('password three-state: clearPassword:true clears it regardless of an existing value', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const first = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, password: 'to-be-cleared' } });
  await store.setSettingsSection('email', first.value);

  const second = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, password: undefined, clearPassword: true } });
  assert.equal(second.ok, true);
  assert.equal(second.value.smtp.password, '');
});

test('password three-state: rejects control characters in a new password', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const result = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: { ...SMTP_OK, password: 'bad\r\npass' } });
  assert.equal(result.ok, false);
});

// ── validateInvitesEnabled ───────────────────────────────────────────────────────

test('validateInvitesEnabled: accepts booleans, rejects everything else', async () => {
  const { settings } = freshModules();
  assert.equal(settings.validateInvitesEnabled(true).ok, true);
  assert.equal(settings.validateInvitesEnabled(false).ok, true);
  assert.equal(settings.validateInvitesEnabled('true').ok, false);
  assert.equal(settings.validateInvitesEnabled(1).ok, false);
  assert.equal(settings.validateInvitesEnabled(null).ok, false);
});

// ── isEmailConfigured (provider-aware "usable" check) ────────────────────────────

test('isEmailConfigured: false for provider none', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  assert.equal(settings.isEmailConfigured(), false);
});

test('isEmailConfigured: true for smtp only once host+username+password all present', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();

  const { password, ...noPassword } = SMTP_OK;
  const incomplete = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: noPassword });
  await store.setSettingsSection('email', incomplete.value);
  assert.equal(settings.isEmailConfigured(), false);

  const complete = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: SMTP_OK });
  await store.setSettingsSection('email', complete.value);
  assert.equal(settings.isEmailConfigured(), true);
});

test('isEmailConfigured: resend true only when RESEND_API_KEY is set', async () => {
  const withoutKey = freshModules({ RESEND_API_KEY: undefined });
  await withoutKey.store.loadStore();
  await withoutKey.store.setSettingsSection('email', { provider: 'resend', from: 'DROP <hello@drop.dev>', smtp: { host: '', port: 465, security: 'tls', username: '', password: '' } });
  assert.equal(withoutKey.settings.isEmailConfigured(), false);

  const withKey = freshModules({ RESEND_API_KEY: 'test-key' });
  await withKey.store.loadStore();
  await withKey.store.setSettingsSection('email', { provider: 'resend', from: 'DROP <hello@drop.dev>', smtp: { host: '', port: 465, security: 'tls', username: '', password: '' } });
  assert.equal(withKey.settings.isEmailConfigured(), true);
});

// ── no-leak: the password must never surface in a view/response object ──────────

test('no-leak: password never appears in any view or simulated API response', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();

  const SECRET = 'sUp3r-Leaky-Secret!!';
  const saved = settings.validateEmailSection({
    provider: 'smtp', from: 'DROP <hello@drop.dev>',
    smtp: { host: 'smtp.hostinger.com', username: 'hello@drop.dev', password: SECRET },
  });
  assert.equal(saved.ok, true);
  await store.setSettingsSection('email', saved.value);
  await store.setSettingsSection('invitesEnabled', true);

  const emailView = settings.buildEmailView();
  const invitesView = settings.buildInvitesView();

  assert.ok(!JSON.stringify(emailView).includes(SECRET), 'emailView leaked the password');
  assert.ok(!JSON.stringify(invitesView).includes(SECRET), 'invitesView leaked the password');
  assert.equal(emailView.smtp.hasPassword, true);
  assert.equal(emailView.smtp.password, undefined);

  // The effective getter is internal (used only to actually send mail) and is
  // expected to carry the real password — it must never be spread into a view.
  const effective = settings.getEffectiveEmailSettings();
  assert.equal(effective.smtp.password, SECRET);

  // Simulate the full GET /api/admin/settings payload shape and re-check there.
  const fullResponse = {
    ok: true,
    emailConfigured: settings.isEmailConfigured(),
    emailFrom: settings.getEffectiveEmailSettings().from,
    invitesEnabled: settings.isInvitesEnabled(),
    templates: {
      confirmation: { subject: 'x', html: '<p>x</p>', savedAt: null },
      invite: { subject: 'x', html: '<p>x</p>', savedAt: null },
    },
    email: emailView,
    invites: invitesView,
    resendKeyConfigured: false,
  };
  assert.ok(!JSON.stringify(fullResponse).includes(SECRET), 'full settings response leaked the password');
});

// ── store.js: settings persistence, normalization, at-rest permissions ──────────

test('store: setSettingsSection persists email with savedAt', async () => {
  const { store } = freshModules();
  await store.loadStore();
  await store.setSettingsSection('email', { provider: 'none', from: '', smtp: { host: '', port: 465, security: 'tls', username: '', password: '' } });
  const stored = store.getSettings().email;
  assert.equal(stored.provider, 'none');
  assert.equal(typeof stored.savedAt, 'string');
});

test('store: setSettingsSection wraps invitesEnabled as {value, savedAt}', async () => {
  const { store } = freshModules();
  await store.loadStore();
  await store.setSettingsSection('invitesEnabled', true);
  const stored = store.getSettings().invitesEnabled;
  assert.equal(stored.value, true);
  assert.equal(typeof stored.savedAt, 'string');
});

test('store: resetSettingsSection removes the section entirely', async () => {
  const { store, settings } = freshModules();
  await store.loadStore();
  const value = settings.validateEmailSection({ provider: 'smtp', from: 'a@b.com', smtp: SMTP_OK });
  await store.setSettingsSection('email', value.value);
  assert.equal(settings.getEffectiveEmailSettings().provider, 'smtp');

  await store.resetSettingsSection('email');
  assert.equal(store.getSettings().email, undefined);
  assert.equal(settings.getEffectiveEmailSettings().provider, 'none'); // no RESEND_API_KEY in this env
});

test('store: setSettingsSection rejects an unknown key', async () => {
  const { store } = freshModules();
  await store.loadStore();
  assert.throws(() => store.setSettingsSection('bogus', {}));
});

test('store: loadStore normalizes a non-object settings field to {} (templates pattern)', async () => {
  const { store } = freshModules({}, { entries: [], templates: {}, settings: 'garbage' });
  await store.loadStore();
  assert.deepEqual(store.getSettings(), {});
});

test('store: loadStore normalizes a missing settings field to {}', async () => {
  const { store } = freshModules({}, { entries: [], templates: {} });
  await store.loadStore();
  assert.deepEqual(store.getSettings(), {});
});

test('store: loadStore normalizes an array settings field to {}', async () => {
  const { store } = freshModules({}, { entries: [], templates: {}, settings: [] });
  await store.loadStore();
  assert.deepEqual(store.getSettings(), {});
});

test('store: save() writes waitlist.json with 0600 perms (checked on POSIX only)', async () => {
  const { store, config } = freshModules();
  await store.loadStore();
  await store.setSettingsSection('email', { provider: 'smtp', from: 'a@b.com', smtp: SMTP_OK });
  const stat = fs.statSync(config.STORE_PATH);
  assert.ok(stat.isFile());
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
  }
});
