# Email features: confirmation email + admin template editor

**Date:** 2026-06-19
**Status:** Awaiting approval

## Goal

1. Send a "you're on the waitlist" confirmation email when someone signs up (new entry only).
2. Add an admin UI section where the operator can view email config status and edit the two email templates (confirmation + invite) without touching env vars or restarting the app.

## Approach

### Template storage

Extend the in-memory store from `{ entries: [] }` to `{ entries: [], templates: {} }`.
`templates` is a map of `{ confirmation: {subject, html, savedAt?}, invite: {subject, html, savedAt?} }`.
Default templates live as constants in `email.js` and are used as fallbacks whenever a key is absent from `store.templates`. Saves go through the existing atomic-write chain — no new files, no new store.

### Template rendering

Add `renderTemplate(templateHtml, vars)` to `email.js`. It does `{{key}}` substitution,
HTML-escaping every substituted value unconditionally (`escapeHtml(String(value ?? ''))`).
URL values (dashboardUrl) contain no `&` in normal use; and even if they do, `&amp;` inside
an `href` is correct HTML — browsers decode it. All vars go through the same path; no
caller pre-escapes.

`{{name}}` falls back to `{{email}}` value when name is absent (avoids "undefined" in email body).

After substitution, warn if any `{{...}}` remain unresolved:
`if (/\{\{[^}]+\}\}/.test(rendered)) console.warn('[waitlist] unresolved template vars', ...)`.

### Confirmation email on join

In `handleJoin`, inside the **`else` branch only** (new entry created), after `save()` and
before `sendJson`, fire the confirmation email:

```js
} else {
  addEntry({ email, name });
  await save();
  // fire-and-forget; the freshly-added entry is the last unshifted item
  sendConfirmationEmail(findByEmail(email)).catch(err =>
    console.error('[waitlist] confirmation email error', err)
  );
}
// ← no await on the send; user gets 200 immediately regardless of email outcome
return sendJson(res, 200, { ok: true });
```

`sendConfirmationEmail(entry)` lives in `email.js`, builds vars `{ name: entry.name || entry.email, email: entry.email }`, and calls `renderTemplate(getEffectiveTemplate('confirmation').html, vars)` + `sendEmail`.

`sendEmail` already catches all throws internally and returns `{ sent: false, error }` — it
will never propagate. The `.catch` is defensive hygiene for any future wrapper.

Re-join (existing entry branch) never triggers a confirmation email.

### Updated invite flow

`handleApprove` replaces the `welcomeEmailHtml(...)` call with a single helper in `email.js`:

```js
// in routes.js — routes never imports DASHBOARD_URL:
const email = await sendInviteEmail(entry, { username: result.username, tempPassword: result.password });

// in email.js — DASHBOARD_URL injected here, from this module's existing config import:
async function sendInviteEmail(entry, { username, tempPassword }) {
  const tmpl = getEffectiveTemplate('invite');
  const html = renderTemplate(tmpl.html, {
    name: entry.name || entry.email,
    email: entry.email,
    username,
    tempPassword,
    dashboardUrl: DASHBOARD_URL,   // ← read from config at send time, never baked into stored template
  });
  return sendEmail({ to: entry.email, subject: tmpl.subject, html });
}
```

`DASHBOARD_URL` is always read from `config` at send time, never stored in the template.
The stored (or default) template body must contain the literal `{{dashboardUrl}}` placeholder.
Encapsulating in `email.js` keeps the config dependency in one place — `routes.js` stays unaware of it.

### API: new endpoints

All three are token-gated via `adminAuthorized`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/settings` | Returns email config status + both templates (with savedAt) |
| `POST` | `/api/admin/templates` | Save one template `{ type, subject, html }` |
| `POST` | `/api/admin/templates/reset` | Reset one template to default `{ type }` |

`GET /api/admin/settings` response shape:
```json
{
  "ok": true,
  "emailConfigured": true,
  "emailFrom": "DROP <noreply@dropkit.sh>",
  "invitesEnabled": false,
  "templates": {
    "confirmation": { "subject": "...", "html": "...", "savedAt": "2026-06-19T..." },
    "invite":       { "subject": "...", "html": "...", "savedAt": null }
  }
}
```
`savedAt: null` means the default is in use. RESEND_API_KEY value is **never** included.

`POST /api/admin/templates` validation:
- `type` must be exactly `'confirmation'` or `'invite'` → 400 otherwise
- `subject`: required string, max 200 chars
- `html`: required string, max 50,000 chars (below Resend's limit; the global 64 KB body cap
  is already in `readJsonBody`, this is a tighter per-field guard)
- On success: mutate `store.templates[type] = { subject, html, savedAt: now }` then `save()`

`POST /api/admin/templates/reset`:
- `type` must be `'confirmation'` or `'invite'` → 400 otherwise
- `delete store.templates[type]` then `save()`; next render uses the code default

### Admin UI additions

Changes are all within `src/ui/admin.html`. No new HTML file.

**Layout** (top to bottom after Load):
1. Token bar (unchanged)
2. Email config status (read-only, 2–3 lines)
3. Template editor — confirmation email
4. Template editor — invite email
5. Waitlist table (unchanged)

**Behavior:**
- All sections (2–5) render only after a successful Load (same pattern as the table).
  Before Load, a placeholder: `<p>Enter your admin token above and click Load.</p>`
- Token is persisted to `sessionStorage` on successful Load and repopulated on page load.
- The Load button guards against unsaved template changes:
  `if (unsavedChanges && !confirm('You have unsaved changes. Load anyway?')) return;`
  `unsavedChanges` is a boolean set on any textarea/input `input` event, cleared on save.

**Email config section:**
```
Email config
  Resend:   ✓ configured       (or: ✗ not set — set RESEND_API_KEY in your environment)
  Sender:   DROP <noreply@...>
  Invites:  disabled            (or: enabled)
```
If invites are disabled, the invite template editor is visually dimmed
(`opacity: 0.5; pointer-events: none`) with a note:
`"Invite emails are disabled — set WAITLIST_INVITES_ENABLED=true to activate."`

**Each template editor:**
```
[Confirmation email template]    (or [Invite email template])
Using built-in default           (if savedAt is null)
Last saved: <date>               (if savedAt is set)

Subject: [_______________________]  (chars: 42/200 — live counter)
Body (HTML):
[___________________________________]
[___________________________________]   ← textarea
HTML is sent as-is. Inline CSS only — most email clients strip <style> blocks.

Available variables: {{name}} {{email}}   (confirmation)
                     {{name}} {{email}} {{username}} {{tempPassword}} {{dashboardUrl}}  (invite)

[Save]  [Reset to default…]
```

Save button behavior:
- Client-side pre-check: if invite template body is missing `{{tempPassword}}` or `{{dashboardUrl}}`,
  show `confirm('Warning: template is missing {{tempPassword}}. Users may not receive login credentials. Save anyway?')`.
- Disable + show "Saving…" during fetch.
- On 403: `<span class="save-msg err">Forbidden — check token.</span>`
- On 4xx/5xx/network error: `<span class="save-msg err">Save failed.</span>`
- On success: restore button + `<span class="save-msg ok">Saved.</span>` (fades after 3s); update `savedAt` label; clear `unsavedChanges`.

Reset to default button:
- Shows `confirm('Discard your saved template and restore the built-in default?')`
- On confirm: POST `/api/admin/templates/reset { type }`, reload settings on success.

## File-level changes

| File | Change |
|---|---|
| `src/store.js` | Initial store: `{ entries: [], templates: {} }`. In `loadStore`, normalize `store.templates = store.templates \|\| {}` after `store = parsed` **and** change the `catch` branch to reset to `{ entries: [], templates: {} }` (not `{ entries: [] }`) so a corrupt/unreadable file never leaves `templates` undefined. Add `getTemplates()`, `setTemplate(type, {subject,html})`, `resetTemplate(type)`. |
| `src/email.js` | Add `DEFAULT_TEMPLATES` constant. Add `renderTemplate(html, vars)`. Add `getEffectiveTemplate(type)` (returns stored or default). Add `sendConfirmationEmail(entry)` and `sendInviteEmail(entry, {username, tempPassword})` helpers that build vars (incl. `dashboardUrl: DASHBOARD_URL` injected here, from this module's existing config import) and call `renderTemplate` + `sendEmail`. Remove `welcomeEmailHtml` (replaced by `sendInviteEmail`). |
| `src/routes.js` | `handleJoin`: fire-and-forget `sendConfirmationEmail(...)` in `else` branch (no `await`, `.catch(console.error)`). `handleApprove`: replace `welcomeEmailHtml` call with `sendInviteEmail(entry, {username, tempPassword})` — routes never imports `DASHBOARD_URL`. Add `handleGetSettings`, `handleSaveTemplate`, `handleResetTemplate`. |
| `src/server.js` | Add three new token-gated routes. |
| `src/ui/admin.html` | Add settings section (email config + two template editors). Token sessionStorage. Unsaved-changes guard. |

## Risks & open questions

- **`welcomeEmailHtml` removal:** The existing function is replaced by `getEffectiveTemplate('invite')` +
  `renderTemplate`. Behavior is identical for fresh installs; existing deploys with no saved templates
  see the same output (the default template reproduces the current HTML).
- **savedAt timestamp:** uses `new Date().toISOString()` at save time on the server; no client-clock dependency.
- **Resend-side limit:** 50,000 char HTML cap in validation is below Resend's 100 KB limit. The global
  64 KB `readJsonBody` cap is also in play — the two don't conflict (field-level check fires first in handler code).

## Acceptance criteria

1. Fresh signup → confirmation email sent (fire-and-forget); user still gets 200 immediately even if Resend is down.
2. Re-submitting an existing email → no confirmation email.
3. Admin saves a custom confirmation template → next signup uses the custom template.
4. Admin resets to default → next signup uses the built-in default.
5. Admin approves an entry → invite email uses `renderTemplate` with `{{dashboardUrl}}` resolved from config.
6. `GET /api/admin/settings` shows `savedAt: null` for a never-customised template, a timestamp after save.
7. `POST /api/admin/templates` with an unknown `type` returns 400.
8. `POST /api/admin/templates` with `html` > 50,000 chars returns 400.
9. Boot with an existing `{ entries: [...] }` store (no `templates` key) → no crash, defaults used.
10. Boot with a corrupt/unreadable store file → `loadStore` catch branch yields `{ entries: [], templates: {} }`; settings load with defaults, no `TypeError` accessing `store.templates`.

## Agent critiques considered

**Correctness/security auditor:**
- `renderTemplate` escaping contract (escape at render, never pre-escape at caller) → adopted; documented as a contract note in the function.
- Fire-and-forget must use explicit `.catch(console.error)` → adopted.
- Confirmation only in `else` branch → adopted; specified line-level.
- `type` validation → adopted; 400 on unknown type.
- `store.templates` normalization in `loadStore` → adopted.
- `{{dashboardUrl}}` injected at render time → adopted; explicit in the route handler pseudocode.
- Warn on unresolved placeholders after render → adopted.
- `{{name}}` fallback to `entry.email` → adopted.
- Subject/html length caps → adopted (200 / 50,000).

**UX reviewer:**
- Save button inline error/success (not alert) → adopted.
- Missing required invite vars warning before save → adopted.
- `savedAt` to distinguish default vs saved → adopted.
- Config section with actionable guidance when unset → adopted.
- Settings only visible after Load → adopted.
- Invite editor dimmed when invites disabled → adopted.
- Reset to default button → adopted (via `POST /api/admin/templates/reset`).
- Token sessionStorage persistence → adopted.
- Unsaved changes guard before Load → adopted.
- Subject length counter → adopted.

**Integration/scope reviewer:**
- Template editor UI is overscoped → **consciously rejected.** User explicitly requested UI-configurable templates. The implementation is contained to one new endpoint pair + admin HTML changes, with no new dependencies.
- URL HTML-escaping breaks links → **consciously rejected.** `&amp;` inside an `href` attribute is correct HTML; browsers decode it. There is no breakage.
- `store.templates` normalization in `loadStore` → adopted (confirms correctness auditor).
- Confirmation email placement in `else` branch → adopted (confirms correctness auditor).
- Fire-and-forget pattern → adopted.
- `readJsonBody` 64 KB global cap acknowledged; field-level cap added for clarity.
- No race condition in the write chain (confirmed by reviewer) → no action needed.
