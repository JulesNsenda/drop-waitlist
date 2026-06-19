'use strict';

const { EMAIL_RE, INVITES_ENABLED, DROP_ADMIN_API_KEY, RESEND_API_KEY, EMAIL_FROM } = require('./config');
const { normEmail, getEntries, findByEmail, findById, addEntry, save, getTemplates, setTemplate, resetTemplate } = require('./store');
const { sendConfirmationEmail, sendInviteEmail, getEffectiveTemplate, DEFAULT_TEMPLATES } = require('./email');
const { provisionAccount } = require('./drop-api');
const { sendJson, readJsonBody } = require('./http');

async function handleJoin(req, res) {
  const body = await readJsonBody(req);
  if (!body || !EMAIL_RE.test(String(body.email || ''))) {
    return sendJson(res, 400, { ok: false, error: 'A valid email is required.' });
  }
  const email = normEmail(body.email);
  const name = body.name ? String(body.name).trim().slice(0, 120) : undefined;
  const now = new Date().toISOString();

  const existing = findByEmail(email);
  if (existing) {
    if (name && !existing.name) { existing.name = name; existing.updatedAt = now; await save(); }
  } else {
    addEntry({ email, name });
    await save();
    // Fire-and-forget: email failure never blocks the signup response.
    sendConfirmationEmail(findByEmail(email)).catch((err) =>
      console.error('[waitlist] confirmation email error', err)
    );
  }
  return sendJson(res, 200, { ok: true });
}

function listEntries(res) {
  const safe = getEntries().map((e) => ({
    id: e.id, email: e.email, name: e.name || null, status: e.status,
    createdAt: e.createdAt, invitedAt: e.invitedAt || null, username: e.username || null,
  }));
  return sendJson(res, 200, { ok: true, invitesEnabled: INVITES_ENABLED, entries: safe });
}

async function handleApprove(req, res) {
  const body = await readJsonBody(req);
  const entry = body && body.id ? findById(body.id) : null;
  if (!entry) return sendJson(res, 404, { ok: false, error: 'Entry not found.' });
  if (entry.status === 'invited') return sendJson(res, 409, { ok: false, error: 'Already invited.' });

  if (!INVITES_ENABLED) {
    entry.status = 'approved';
    entry.updatedAt = new Date().toISOString();
    await save();
    return sendJson(res, 200, {
      ok: true, created: false,
      message: 'Marked approved. Invites are disabled (set WAITLIST_INVITES_ENABLED=true once Docker isolation is on).',
    });
  }

  if (!DROP_ADMIN_API_KEY) {
    return sendJson(res, 500, { ok: false, error: 'DROP_ADMIN_API_KEY not configured.' });
  }

  const result = await provisionAccount(entry.email);
  if (!result.ok) return sendJson(res, 502, { ok: false, error: result.error });

  const emailResult = await sendInviteEmail(entry, { username: result.username, tempPassword: result.password });

  entry.status = 'invited';
  entry.username = result.username;
  entry.invitedAt = new Date().toISOString();
  entry.updatedAt = entry.invitedAt;
  await save();

  return sendJson(res, 200, {
    ok: true, created: true, username: result.username,
    emailSent: emailResult.sent, emailError: emailResult.error || null,
    tempPassword: emailResult.sent ? undefined : result.password,
  });
}

function handleGetSettings(res) {
  const templates = getTemplates();
  const toView = (type) => {
    const effective = getEffectiveTemplate(type);
    const saved = templates[type];
    return { subject: effective.subject, html: effective.html, savedAt: saved ? saved.savedAt : null };
  };
  return sendJson(res, 200, {
    ok: true,
    emailConfigured: !!RESEND_API_KEY,
    emailFrom: EMAIL_FROM,
    invitesEnabled: INVITES_ENABLED,
    templates: {
      confirmation: toView('confirmation'),
      invite: toView('invite'),
    },
  });
}

async function handleSaveTemplate(req, res) {
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'Invalid JSON.' });

  const { type, subject, html } = body;
  if (!['confirmation', 'invite'].includes(type)) {
    return sendJson(res, 400, { ok: false, error: 'type must be "confirmation" or "invite".' });
  }
  if (typeof subject !== 'string' || !subject.trim()) {
    return sendJson(res, 400, { ok: false, error: 'subject is required.' });
  }
  if (subject.length > 200) {
    return sendJson(res, 400, { ok: false, error: 'subject must be 200 characters or fewer.' });
  }
  if (typeof html !== 'string' || !html.trim()) {
    return sendJson(res, 400, { ok: false, error: 'html is required.' });
  }
  if (html.length > 50000) {
    return sendJson(res, 400, { ok: false, error: 'html must be 50,000 characters or fewer.' });
  }

  await setTemplate(type, { subject: subject.trim(), html });
  const saved = getTemplates()[type];
  return sendJson(res, 200, { ok: true, savedAt: saved.savedAt });
}

async function handleResetTemplate(req, res) {
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'Invalid JSON.' });

  const { type } = body;
  if (!['confirmation', 'invite'].includes(type)) {
    return sendJson(res, 400, { ok: false, error: 'type must be "confirmation" or "invite".' });
  }

  await resetTemplate(type);
  const def = DEFAULT_TEMPLATES[type];
  return sendJson(res, 200, { ok: true, subject: def.subject, html: def.html });
}

module.exports = { handleJoin, listEntries, handleApprove, handleGetSettings, handleSaveTemplate, handleResetTemplate };
