'use strict';

const { RESEND_API_KEY, DASHBOARD_URL } = require('./config');
const { getTemplates } = require('./store');
const { getEffectiveEmailSettings } = require('./settings');
const { smtpSend } = require('./smtp');

// ── default templates ─────────────────────────────────────────────────────────
const DEFAULT_TEMPLATES = {
  confirmation: {
    subject: "You're on the waitlist",
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111">
  <h2>You're on the DROP beta waitlist</h2>
  <p>Hey {{name}},</p>
  <p>We've got your spot reserved. We'll reach out when a place opens up.</p>
  <p style="color:#999;font-size:12px">— The DROP team</p>
</div>`,
  },
  invite: {
    subject: "You're in the DROP beta",
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#111">
  <h2>You're in the DROP beta 🎉</h2>
  <p>Your account is ready. Sign in and you'll be prompted to set your own password.</p>
  <table style="border-collapse:collapse;margin:16px 0">
    <tr><td style="padding:4px 12px 4px 0;color:#666">Username</td><td><b>{{username}}</b></td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666">Temp password</td><td><code>{{tempPassword}}</code></td></tr>
  </table>
  <p><a href="{{dashboardUrl}}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none">Open the dashboard →</a></p>
  <p style="color:#999;font-size:12px">If you didn't request this, you can ignore the email.</p>
</div>`,
  },
};

// ── helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Returns stored template for `type` if saved, otherwise the code default.
function getEffectiveTemplate(type) {
  const stored = getTemplates()[type];
  return stored || DEFAULT_TEMPLATES[type];
}

// Substitutes {{key}} placeholders, HTML-escaping every value.
// All vars — including URL vars — are escaped; &amp; in href is valid HTML.
function renderTemplate(templateHtml, vars) {
  let out = templateHtml;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, escapeHtml(String(value ?? '')));
  }
  if (/\{\{[^}]+\}\}/.test(out)) {
    console.warn('[waitlist] template has unresolved placeholders after render');
  }
  return out;
}

// ── plain-text fallback ───────────────────────────────────────────────────────

// Best-effort HTML→plain-text converter. Preserves hrefs (strip-only would
// drop the dashboard URL in invite emails). Unescapes &amp; last to avoid
// double-converting &amp;lt; → &lt; → <.
function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const t = inner.replace(/<[^>]+>/g, '').trim();
      return href && href !== t ? `${t} (${href})` : t;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── send helpers ──────────────────────────────────────────────────────────────

let _inFlight = 0;
const MAX_IN_FLIGHT = 10; // Resend path only — the SMTP path serializes internally.

// Last-line-of-defense header-injection guard on the send path itself
// (settings.js already rejects CRLF at the settings POST; this catches
// anything reaching sendEmail some other way, e.g. template subjects).
function stripCrlf(value) {
  return String(value == null ? '' : value).replace(/[\r\n]/g, '');
}

// Routes by the effective provider: 'none' sends nothing, 'smtp' hands off to
// the zero-dep client, 'resend' keeps the existing HTTP API path.
async function sendEmail({ to, subject, html }) {
  const effective = getEffectiveEmailSettings();
  const cleanSubject = stripCrlf(subject);
  const cleanFrom = stripCrlf(effective.from);

  if (effective.provider === 'none') {
    return { sent: false, error: 'email disabled' };
  }

  if (effective.provider === 'smtp') {
    const text = htmlToText(html);
    return smtpSend(
      {
        host: effective.smtp.host,
        port: effective.smtp.port,
        username: effective.smtp.username,
        password: effective.smtp.password,
      },
      { from: cleanFrom, to, subject: cleanSubject, html, text }
    );
  }

  // provider === 'resend'
  if (!RESEND_API_KEY) return { sent: false, error: 'email not configured (RESEND_API_KEY unset)' };
  if (_inFlight >= MAX_IN_FLIGHT) return { sent: false, error: 'too many concurrent sends' };
  const text = htmlToText(html);
  _inFlight++;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cleanFrom, to: [to], subject: cleanSubject, html, text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { sent: false, error: `provider ${res.status}: ${detail.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : 'send failed' };
  } finally {
    _inFlight--;
  }
}

// Sends the waitlist-confirmation email for a newly-added entry.
// Callers must NOT await this — fire-and-forget with .catch().
function sendConfirmationEmail(entry) {
  const tmpl = getEffectiveTemplate('confirmation');
  const html = renderTemplate(tmpl.html, {
    name: entry.name || entry.email,
    email: entry.email,
  });
  return sendEmail({ to: entry.email, subject: tmpl.subject, html });
}

// Sends the beta-invite email. DASHBOARD_URL injected from config here so
// routes.js never needs to import it.
function sendInviteEmail(entry, { username, tempPassword }) {
  const tmpl = getEffectiveTemplate('invite');
  const html = renderTemplate(tmpl.html, {
    name: entry.name || entry.email,
    email: entry.email,
    username,
    tempPassword,
    dashboardUrl: DASHBOARD_URL,
  });
  return sendEmail({ to: entry.email, subject: tmpl.subject, html });
}

module.exports = {
  sendEmail,
  sendConfirmationEmail,
  sendInviteEmail,
  renderTemplate,
  getEffectiveTemplate,
  DEFAULT_TEMPLATES,
  escapeHtml,
  htmlToText,
  stripCrlf,
};
