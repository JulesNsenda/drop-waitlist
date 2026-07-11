'use strict';

const { EMAIL_RE, RESEND_API_KEY, WAITLIST_JOIN_LIMIT, WAITLIST_JOIN_WINDOW_MS } = require('./config');
const { normEmail, getEntries, findByEmail, findById, addEntry, save, getTemplates, setTemplate, resetTemplate, setSettingsSection, resetSettingsSection } = require('./store');
const { sendConfirmationEmail, sendInviteEmail, sendEmail, getEffectiveTemplate, DEFAULT_TEMPLATES, escapeHtml } = require('./email');
const {
  getEffectiveEmailSettings, isInvitesEnabled, getEffectiveDropAdminKey,
  validateEmailSection, validateInvitesEnabled, validateDropAdminKey, validateDashboardUrl,
  buildEmailView, buildInvitesView, isEmailConfigured, hasControlChars,
} = require('./settings');
const { provisionAccount, reprovisionAccount } = require('./drop-api');
const { sendJson, readJsonBody } = require('./http');
const { getClientIp, makeRateLimiter, allowEmailSend } = require('./throttle');
const { entriesToCsv } = require('./csv');

// Per-IP rate limiter for POST /api/join — created once at module load.
const joinLimiter = makeRateLimiter(WAITLIST_JOIN_LIMIT, WAITLIST_JOIN_WINDOW_MS);

// Dedicated, tighter limiter for the test-email endpoint — a leaked admin
// token must not turn a configured mail server into a spam relay.
const testEmailLimiter = makeRateLimiter(5, 60_000);

async function handleJoin(req, res) {
  // 1. Per-IP rate limit.
  const ip = getClientIp(req);
  if (!joinLimiter.allow(ip)) {
    const retry = joinLimiter.retryAfter(ip);
    res.setHeader('Retry-After', String(retry));
    return sendJson(res, 429, { ok: false, error: 'Too many requests. Please try again later.' });
  }

  const body = await readJsonBody(req);

  // 2. Honeypot — filled means a bot; return 200 silently (don't teach bots the
  //    field name). Logged so a false positive (e.g. browser autofill) is
  //    diagnosable instead of a silent drop.
  if (body && body.company) {
    console.error('[waitlist] honeypot triggered, dropping join for', String(body.email || '').slice(0, 200));
    return sendJson(res, 200, { ok: true });
  }

  // 3. Validate email.
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
    // 4. Gate confirmation email on the global hourly budget (protects Resend
    //    quota under a distributed flood; signup is still stored regardless).
    if (allowEmailSend()) {
      sendConfirmationEmail(findByEmail(email)).catch((err) =>
        console.error('[waitlist] confirmation email error', err)
      );
    }
  }
  return sendJson(res, 200, { ok: true });
}

function listEntries(res) {
  const safe = getEntries().map((e) => ({
    id: e.id, email: e.email, name: e.name || null, status: e.status,
    createdAt: e.createdAt, invitedAt: e.invitedAt || null, username: e.username || null,
  }));
  return sendJson(res, 200, { ok: true, invitesEnabled: isInvitesEnabled(), entries: safe });
}

async function handleApprove(req, res) {
  const body = await readJsonBody(req);
  const entry = body && body.id ? findById(body.id) : null;
  if (!entry) return sendJson(res, 404, { ok: false, error: 'Entry not found.' });
  if (entry.status === 'invited') return sendJson(res, 409, { ok: false, error: 'Already invited.' });

  if (!isInvitesEnabled()) {
    entry.status = 'approved';
    entry.updatedAt = new Date().toISOString();
    await save();
    return sendJson(res, 200, {
      ok: true, created: false,
      message: 'Marked approved. Invites are disabled — enable them in Settings once Docker isolation is on.',
    });
  }

  if (!getEffectiveDropAdminKey()) {
    return sendJson(res, 500, { ok: false, error: 'No DROP admin key configured. Save one in Settings or set DROP_ADMIN_API_KEY.' });
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

// Re-invites an entry already at status 'invited' (recipient never got the
// email, lost it, or never logged in). The temp password is never persisted
// (only entry.username is), so this can't resend the original credentials —
// it resets the DROP account's password to a fresh one and emails that.
async function handleReinvite(req, res) {
  const body = await readJsonBody(req);
  const entry = body && body.id ? findById(body.id) : null;
  if (!entry) return sendJson(res, 404, { ok: false, error: 'Entry not found.' });
  if (entry.status !== 'invited') {
    return sendJson(res, 409, { ok: false, error: 'Use Approve for entries that haven\'t been invited yet.' });
  }

  if (!getEffectiveDropAdminKey()) {
    return sendJson(res, 500, { ok: false, error: 'No DROP admin key configured. Save one in Settings or set DROP_ADMIN_API_KEY.' });
  }

  const result = await reprovisionAccount(entry.username);

  if (result.code === 'not_found') {
    // Escape hatch: the DROP-side account is gone, and re-invite can never
    // succeed again for it. Flip back to 'approved' so the admin can
    // re-approve (which provisions a fresh account) instead of being stuck —
    // 'invited' entries are blocked from Approve's first-invite-only path.
    entry.status = 'approved';
    entry.username = null;
    entry.invitedAt = null;
    entry.updatedAt = new Date().toISOString();
    await save();
    return sendJson(res, 409, {
      ok: false,
      error: 'DROP account no longer exists — entry reset to Approved; approve again to create a fresh account.',
    });
  }
  if (result.code === 'disabled') {
    return sendJson(res, 409, { ok: false, error: 'DROP account is suspended — re-enable it in DROP first.' });
  }
  if (!result.ok) return sendJson(res, 502, { ok: false, error: result.error });

  const emailResult = await sendInviteEmail(entry, { username: result.username, tempPassword: result.password });

  entry.invitedAt = new Date().toISOString();
  entry.updatedAt = entry.invitedAt;
  await save();

  return sendJson(res, 200, {
    ok: true, username: result.username,
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
    emailConfigured: isEmailConfigured(),
    emailFrom: getEffectiveEmailSettings().from,
    invitesEnabled: isInvitesEnabled(),
    templates: {
      confirmation: toView('confirmation'),
      invite: toView('invite'),
    },
    email: buildEmailView(),
    invites: buildInvitesView(),
    resendKeyConfigured: !!RESEND_API_KEY,
  });
}

// Partial save: `{ email?, invitesEnabled?, dropAdminKey?, dashboardUrl? }`.
// One validator per present key. All present sections are validated first
// and only then persisted, so an invalid later section can't leave an
// earlier one half-saved; fresh views are built after the persist phase.
async function handleSaveSettings(req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'Invalid JSON.' });

  const hasEmail = Object.prototype.hasOwnProperty.call(body, 'email');
  const hasInvites = Object.prototype.hasOwnProperty.call(body, 'invitesEnabled');
  const hasDropKey = Object.prototype.hasOwnProperty.call(body, 'dropAdminKey');
  const hasDashboardUrl = Object.prototype.hasOwnProperty.call(body, 'dashboardUrl');
  if (!hasEmail && !hasInvites && !hasDropKey && !hasDashboardUrl) {
    return sendJson(res, 400, { ok: false, error: 'No settings provided.' });
  }

  let emailValue, invitesValue, dropKeyValue, dashboardUrlValue;

  if (hasEmail) {
    const result = validateEmailSection(body.email);
    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
    emailValue = result.value;
  }

  if (hasInvites) {
    const result = validateInvitesEnabled(body.invitesEnabled);
    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
    invitesValue = result.value;
  }

  if (hasDropKey) {
    const result = validateDropAdminKey(body.dropAdminKey);
    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
    dropKeyValue = result.value;
  }

  if (hasDashboardUrl) {
    const result = validateDashboardUrl(body.dashboardUrl);
    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
    dashboardUrlValue = result.value;
  }

  const response = { ok: true };

  if (hasEmail) {
    await setSettingsSection('email', emailValue);
    response.email = buildEmailView();
  }

  if (hasInvites) {
    await setSettingsSection('invitesEnabled', invitesValue);
  }

  if (hasDropKey) {
    await setSettingsSection('dropAdminKey', dropKeyValue);
  }

  if (hasDashboardUrl) {
    await setSettingsSection('dashboardUrl', dashboardUrlValue);
  }

  if (hasInvites || hasDropKey || hasDashboardUrl) {
    response.invites = buildInvitesView();
  }

  return sendJson(res, 200, response);
}

// Deletes a settings section so env/defaults apply again (templates-reset
// pattern). 'email' and 'dropAdminKey' are resettable — invitesEnabled is a
// plain toggle.
async function handleResetSettings(req, res) {
  const body = await readJsonBody(req);
  const section = body && body.section;
  if (section !== 'email' && section !== 'dropAdminKey') {
    return sendJson(res, 400, { ok: false, error: 'section must be "email" or "dropAdminKey".' });
  }
  if (section === 'dropAdminKey') {
    await resetSettingsSection('dropAdminKey');
    return sendJson(res, 200, { ok: true, invites: buildInvitesView() });
  }
  await resetSettingsSection('email');
  return sendJson(res, 200, { ok: true, email: buildEmailView() });
}

// Sends a fixed, non-caller-supplied test message through the currently
// SAVED settings. Gate order: address format -> dedicated 5/min IP limiter
// -> hourly email budget -> send. Never accepts caller-supplied host/creds.
async function handleTestEmail(req, res) {
  const body = await readJsonBody(req);
  const to = body && typeof body.to === 'string' ? body.to.trim() : '';
  if (!EMAIL_RE.test(to)) {
    return sendJson(res, 400, { ok: false, error: 'A valid email is required.' });
  }

  const ip = getClientIp(req);
  if (!testEmailLimiter.allow(ip)) {
    const retry = testEmailLimiter.retryAfter(ip);
    res.setHeader('Retry-After', String(retry));
    return sendJson(res, 429, { ok: false, error: 'Too many test emails. Please try again later.' });
  }

  if (!allowEmailSend()) {
    return sendJson(res, 429, { ok: false, error: 'Hourly email budget exhausted. Try again later.' });
  }

  const effective = getEffectiveEmailSettings();
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111">
  <h2>DROP waitlist — test email</h2>
  <p>This confirms your <b>${escapeHtml(effective.provider)}</b> email settings are working.</p>
  <p style="color:#999;font-size:12px">Sent ${escapeHtml(new Date().toISOString())}</p>
</div>`;

  const result = await sendEmail({ to, subject: 'DROP waitlist — test email', html });
  return sendJson(res, 200, { ok: true, sent: result.sent, error: result.error, phase: result.phase });
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
  if (hasControlChars(subject)) {
    return sendJson(res, 400, { ok: false, error: 'subject contains invalid control characters.' });
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

function handleExportCsv(res) {
  const csv = entriesToCsv(getEntries());
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="waitlist.csv"',
  });
  res.end(csv);
}

module.exports = {
  handleJoin, listEntries, handleApprove, handleReinvite,
  handleGetSettings, handleSaveSettings, handleResetSettings, handleTestEmail,
  handleSaveTemplate, handleResetTemplate, handleExportCsv,
};
