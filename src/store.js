'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, STORE_PATH } = require('./config');

let store = { entries: [], templates: {} };
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
    }
  } catch {
    store = { entries: [], templates: {} };
  }
}

function save() {
  writeChain = writeChain.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = path.join(DATA_DIR, `.waitlist.${process.pid}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2));
    await fsp.rename(tmp, STORE_PATH);
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

module.exports = {
  loadStore, save, normEmail,
  getEntries, findByEmail, findById, addEntry,
  getTemplates, setTemplate, resetTemplate,
};
