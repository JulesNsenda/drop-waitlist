'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, STORE_PATH } = require('./config');

let store = { entries: [], templates: {}, settings: {} };
let writeChain = Promise.resolve();

async function loadStore() {
  try {
    const raw = await fsp.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) {
      store = parsed;
      store.templates = (store.templates && typeof store.templates === 'object' && !Array.isArray(store.templates))
        ? store.templates
        : {};
      store.settings = (store.settings && typeof store.settings === 'object' && !Array.isArray(store.settings))
        ? store.settings
        : {};
    }
  } catch {
    store = { entries: [], templates: {}, settings: {} };
  }
}

function save() {
  writeChain = writeChain.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.waitlist.${process.pid}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, STORE_PATH);
    // No-op on Windows dev (chmod only toggles the read-only attribute there);
    // real 0600 enforcement on the Linux deploy. Never let this reject the save.
    await fsp.chmod(STORE_PATH, 0o600).catch(() => {});
  }, () => {});
  return writeChain;
}

const normEmail = (e) => String(e || '').trim().toLowerCase();

function getEntries() {
  return store.entries;
}

function findByEmail(email) {
  return store.entries.find((e) => e.email === email);
}

function findById(id) {
  return store.entries.find((e) => e.id === id);
}

function addEntry({ email, name }) {
  const now = new Date().toISOString();
  store.entries.unshift({
    id: `wl_${crypto.randomBytes(8).toString('hex')}`,
    email,
    name,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  });
}

function getTemplates() {
  return store.templates;
}

function setTemplate(type, { subject, html }) {
  if (!['confirmation', 'invite'].includes(type)) throw new Error('invalid template type');
  store.templates[type] = { subject, html, savedAt: new Date().toISOString() };
  return save();
}

function resetTemplate(type) {
  if (!['confirmation', 'invite'].includes(type)) throw new Error('invalid template type');
  delete store.templates[type];
  return save();
}

function getSettings() {
  return store.settings;
}

// `key` is 'email', 'invitesEnabled', or 'dropAdminKey'. `value` is the
// already-validated shape (settings.js owns validation) — email is stored
// as-is plus savedAt; invitesEnabled and dropAdminKey are wrapped in
// {value, savedAt} to carry their own save time.
function setSettingsSection(key, value) {
  if (key === 'email') {
    store.settings.email = { ...value, savedAt: new Date().toISOString() };
  } else if (key === 'invitesEnabled') {
    store.settings.invitesEnabled = { value: !!value, savedAt: new Date().toISOString() };
  } else if (key === 'dropAdminKey') {
    store.settings.dropAdminKey = { value, savedAt: new Date().toISOString() };
  } else {
    throw new Error('invalid settings key');
  }
  return save();
}

function resetSettingsSection(key) {
  if (!['email', 'invitesEnabled', 'dropAdminKey'].includes(key)) throw new Error('invalid settings key');
  delete store.settings[key];
  return save();
}

module.exports = {
  loadStore, save, normEmail,
  getEntries, findByEmail, findById, addEntry,
  getTemplates, setTemplate, resetTemplate,
  getSettings, setSettingsSection, resetSettingsSection,
};
