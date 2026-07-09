# UI-configurable settings + zero-dep SMTP (Hostinger)

**Date:** 2026-07-08
**Status:** implemented & verified 2026-07-08 (clean first verification pass: 134/134 tests, 16/16 runtime smoke checks; real SMTP-over-TLS delivery deliberately left to the manual test-email button as the live-fire gate)

## Goal

All day-to-day admin configuration moves into the admin UI: mail server (the founder
uses Hostinger mailboxes → SMTP), from name/address, invites toggle. Env vars remain
only for critical secrets and deployment plumbing (admin token, DROP admin API key,
Resend API key, port, data dir, rate-limit knobs). Zero-dependency constraint holds —
SMTP is a hand-rolled minimal client over `node:tls`.

## Approach

### Settings model — the templates pattern, verbatim

`store.settings` in the existing waitlist.json, resolved exactly like templates
(`stored || env-derived default`): section-granular, read-time effective getters, **no
boot-time seeding, no writeback, no per-field provenance**. UI shows one meta line per
section ("Using server env/defaults" vs "Last saved <time>"); Reset deletes the section
so env/defaults apply again. Existing deployments behave byte-identically until the
founder presses Save.

```
settings: {
  email: {
    provider: 'none' | 'resend' | 'smtp',
    from: 'DROP <hello@domain>',              // one field drives envelope AND header From
    smtp: { host, port, security: 'tls', username, password },
    savedAt
  },
  invitesEnabled: boolean                      // set on first toggle; env fallback until then
}
```

Scope boundary (per config-critic audit):

| Setting | Surface | Storage |
|---|---|---|
| WAITLIST_ADMIN_TOKEN, DROP_ADMIN_API_KEY, RESEND_API_KEY | env only — tokens | env |
| provider, from, SMTP host/port/username/password | UI | store (**no SMTP_* env twins**; EMAIL_FROM env = fallback for `from`) |
| invitesEnabled | UI toggle + confirm dialog | store (WAITLIST_INVITES_ENABLED env fallback until first save) |
| DASHBOARD_URL, DROP_API_URL, PORT, DROP_DATA_DIR, rate/budget knobs, TRUSTED_PROXY_IPS | env only | env |

Narrow getter refactor only: new `src/settings.js` owns `getEffectiveEmailSettings()`,
`isInvitesEnabled()`, validation, and API view-building. Only their consumers change
(routes.js, email.js, server.js boot log). `config.js` stays dumb env parsing; PORT,
DATA_DIR, throttle knobs keep their destructured constants. Effective-provider default
when nothing saved: `resend` if RESEND_API_KEY set, else `none` — zero change for the
current deployment. Resend stays as a provider (the working fallback; its cost is one
branch in `sendEmail`, not a plugin system).

### SMTP client — `src/smtp.js` (minimal spec from the feasibility review)

- **465 implicit TLS only** (v1). `tls.connect({host, port, servername: host})`,
  certificate verification hard-on — **no rejectUnauthorized escape hatch, ever**; AUTH
  only after TLS. The `security` field exists for forward-compat but validation accepts
  only `'tls'` (STARTTLS/587 deferred; documented casualty: Office365). Hostinger preset
  hint under the host field: "Hostinger: smtp.hostinger.com · port 465 · SSL/TLS ·
  username = full mailbox address".
- **Lockstep dialogue** (no pipelining): read 220 greeting → EHLO (hostname sanitized
  `[^a-zA-Z0-9.-]` → '' fallback 'localhost') → AUTH **selected** from the advertised
  list (PLAIN with initial-response preferred, LOGIN otherwise), **never retry after
  535** (a retry loop under fire-and-forget sends trips hosting brute-force bans) →
  MAIL FROM → RCPT TO (single recipient) → DATA → `\r\n.\r\n` → **250 after DATA =
  success**; QUIT is fire-and-forget with errors swallowed (some servers close early —
  don't misreport delivered mail as failed).
- **Reply reader**: buffered, multiline-aware (`250-…`/`250 ` continuation), survives
  TCP fragmentation/coalescing, rejects the pending promise on error/close. Ignores
  ENHANCEDSTATUSCODES/PIPELINING/SIZE/8BITMIME/DSN/CHUNKING. Per-phase idle timeouts:
  15 s for commands, 60 s for the post-DATA reply (MailChannels content scanning sits in
  Hostinger's path).
- **Message builder**: headers From/To/Subject/Date(RFC 5322 `+0000`, not
  `toUTCString()`)/Message-ID/MIME-Version; multipart/alternative with the existing
  `htmlToText()` text part; **both parts base64** (76-char wrapped) — **no
  quoted-printable** (the feasibility review's #1 bug source; base64 also moots
  line-length and bare-LF traps). Dot-stuffing kept (one replace). Subject/from-name:
  ASCII passes through; non-ASCII → RFC 2047 `=?UTF-8?B?…?=` encoded-words chunked in
  ≤45-byte UTF-8 groups folded at ≤75 chars (never split mid-character). `from` parsed
  strictly as `Name <addr>` or bare address — no RFC 5322 parser.
- **Errors carry `{phase, code, text}`**, phase ∈ dns/connect/tls/greeting/ehlo/auth/
  mail/rcpt/data/dataResult, mapped to ~9 human messages: "host not found"; "could not
  connect" (refused and timeout collapsed into one — no port-scan error oracle, detail
  logged server-side only); "TLS/port mismatch — port 465 requires SSL/TLS" (covers the
  plaintext-greeting-on-587 hang); "auth failed — username is the full email address"
  (535); "From must match the mailbox you sign in with" (553/550 at MAIL FROM);
  recipient rejected; message rejected (dataResult — may be MailChannels filtering);
  "server busy / rate-limited" (421/45x).
- **Serialized send queue** in the SMTP path (~10-line promise chain) — one connection
  at a time; existing MAX_IN_FLIGHT stays as the outer cap for the Resend path. Return
  contract `{sent, error}` preserved; never throws.
- Transport injectable for tests (internal-only plain-socket mode, **not reachable via
  settings validation** — the API accepts only `'tls'`).

### Security requirements (from the security review)

1. **CRLF/header-injection guards** — reject `\r`, `\n`, and control chars in from,
   from-name, subject, host, username at the settings POST **and** at the send path;
   same control-char rejection added to template-subject validation in
   `handleSaveTemplate` (stored templates can carry CRLF today; Resend's JSON API
   neutralized it, raw SMTP would not). From-address validated against `EMAIL_RE`.
2. **Password is write-only, three-state**: POST with `password` absent **or** `""` →
   keep existing; explicit `clearPassword: true` (or section reset) → clear. GET
   responses are **allowlist-constructed** field-by-field, never spread/omit from the
   live object; they carry `hasPassword: true/false` only. Invariant stated for
   implementers: the settings object is never spread into any response, log line, or
   CSV. Test asserts the password string never appears in any API response.
3. **At-rest**: store tmp file written with `mode: 0o600` + chmod after rename
   (no-op on Windows dev, real on the Linux deploy). No encryption-at-rest — theater
   without a separate key store; the box already holds secrets in env.
4. **Test-email endpoint** (`POST /api/admin/test-email {to}`): adminAuthorized +
   existing `allowEmailSend()` hourly budget + a dedicated `makeRateLimiter(5, 60_000)`
   — a leaked admin token must not turn Hostinger into a spam relay. `to` validated
   against EMAIL_RE. Fixed message content (no caller-supplied body). Tests **saved**
   settings only — the Test button is disabled while the email section is dirty (no
   endpoint accepting arbitrary host/creds).
5. **Invites toggle**: saving is allowed regardless of DROP_ADMIN_API_KEY presence
   (approve already fails loudly), but enabling runs `confirmDialog` with an explicit
   "approvals will provision real DROP accounts and email credentials" warning, and the
   Settings view shows a persistent warning row when `dropKeyConfigured` is false. The
   hard interlock stays env-side: without DROP_ADMIN_API_KEY, approve returns its
   existing 500.
6. `provider: 'none'` → `sendEmail` returns `{sent:false, error:'email disabled'}`;
   join flow stays fire-and-forget; the Settings UI shows the disabled state plainly.
7. Admin token and DROP/Resend keys are **not part of the settings mechanism at all**
   (not readable, not writable, no store fallback) — `adminAuthorized` keeps reading
   env only.

### API

- `GET /api/admin/settings` — extended (allowlist-built): existing fields stay;
  `emailConfigured` becomes provider-aware (usable = resend+key, or smtp with
  host/username/password present); adds
  `email: { provider, from, smtp: {host, port, username, hasPassword}, savedAt|null }`,
  `invites: { enabled, savedAt|null, dropKeyConfigured }`, `resendKeyConfigured`.
- `POST /api/admin/settings` — partial body `{ email?, invitesEnabled? }`, one
  validator per present key, saves via store, returns the fresh view. Client patches
  `state.settings` in place (same pattern as template save; the stale "settings don't
  change at runtime" comment in admin.js dies).
- `POST /api/admin/settings/reset` — `{ section: 'email' }` deletes the section
  (templates-reset pattern). No reset for the invites boolean (it's a toggle).
- `POST /api/admin/test-email` — `{ to }`, gated as above, returns
  `{ ok, sent, error?, phase? }` so the UI can show the mapped failure.

### UI — System view becomes **Settings**

- **Email delivery card**: provider select (None / Resend / SMTP; conditional field
  groups). Resend group: read-only "API key: configured/not set — set via env
  RESEND_API_KEY". SMTP group: host, port (default 465), username, password
  (`type=password`, placeholder "unchanged" when `hasPassword`), security shown as
  static "SSL/TLS (465)" text, Hostinger hint line. Shared: from name + from address
  (defaulting the address to the SMTP username with a warning when they differ — "must
  be your Hostinger mailbox or an alias"; hint that SPF/DKIM are automatic on Hostinger
  nameservers). Save / Reset-to-env + meta line. **Test email row**: recipient input +
  Send button (disabled while dirty), result inline with the mapped error.
- **Invites card**: toggle + description + confirm-on-enable + dropKeyConfigured
  warning row.
- **Environment card** (read-only): admin token / DROP_ADMIN_API_KEY / RESEND_API_KEY
  presence, "set via env" rows.
- **Provider-aware copy sweep** (stale-copy list from the config review): the
  Resend-specific banner on Emails, the two invites-disabled banners, the System hint,
  and the approve response message in routes.js all currently hardcode
  "set WAITLIST_INVITES_ENABLED=true" / "set RESEND_API_KEY" — every one becomes
  provider-/settings-aware ("enable invites in Settings", "configure email in
  Settings").

## File-level changes

| File | Change |
|---|---|
| `src/smtp.js` | **New.** Minimal SMTP client + message builder per spec (~300–340 lines) |
| `src/settings.js` | **New.** Validation, effective getters, allowlisted API views (~120–150) |
| `src/store.js` | Normalize `settings` on load (templates pattern); `getSettings`/`setSettingsSection`/`resetSettingsSection`; 0o600 on tmp write + chmod after rename (~+45) |
| `src/email.js` | `sendEmail` routes by effective provider (resend fetch / smtp / none); from + header guards; SMTP send queue lives here or in smtp.js (~+60/−15) |
| `src/routes.js` | `handleSaveSettings`, `handleResetSettings`, `handleTestEmail` (+limiter); extend `handleGetSettings`; approve message + `isInvitesEnabled()`; template-subject control-char guard (~+100) |
| `src/server.js` | 3 new admin routes; boot log uses effective values (~+12) |
| `src/ui/admin.html` | System section → Settings (email card, invites card, env card) (~+85/−20) |
| `src/ui/admin.js` | Settings view logic: conditional provider groups, dirty tracking for the email card, save/reset/test handlers, toggle confirm, provider-aware banners (~+260/−40) |
| `src/ui/admin.css` | Settings form layout, toggle, warning rows (~+45) |
| `test/smtp.test.js` | **New.** Builder pure-function tests (encoded-word chunking incl. multibyte boundaries, base64 wrap, boundary structure, dot-stuffing, date format) + plain-TCP mock SMTP server: happy path, 535, 553, mid-session disconnect (~220–250) |
| `test/settings.test.js` | **New.** Validation incl. CRLF rejection; password three-state semantics; response-never-contains-password (~100) |
| `test/email.test.js` | Provider routing + `none` behavior additions (~+30) |
| `README.md`, `.env.example` | Config table rewritten: env = fallback, admin UI overrides once saved; SMTP has no env vars (~both files) |
| `src/http.js`, `src/csv.js`, `src/throttle.js`, landing files | **No changes** (throttle's `makeRateLimiter` reused as-is) |

Estimated ~950–1100 lines production, ~380 tests.

## Risks & open questions

- **Hand-rolled SMTP is the risk center.** Mitigations: the minimal spec (no QP, no
  STARTTLS, no retries, lockstep only), mock-server protocol tests, and the test-email
  button as the live-fire check. First real send should be a test email to the founder.
- **465-only**: Office365/587-only providers unsupported in v1; `security` field
  future-proofs the store shape. Hostinger, Gmail, cPanel hosts all serve 465.
- **SMTP password plaintext in waitlist.json**, 0600-chmod'd, on the founder's own
  box — consciously accepted; contradicts a strict reading of "credentials stay env"
  but the user's explicit ask (mail config in UI) wins. Named here so it's a decision,
  not an accident.
- **Deliverability**: from-address must be the authenticated Hostinger mailbox (or
  alias); the UI warns on mismatch. DKIM/SPF handled by Hostinger when nameservers are
  theirs.
- **Node 18 floor**: everything used (tls.connect servername, setTimeout,
  replaceAll, Buffer base64) is Node 18-clean (verified by the feasibility review).

## Addendum 2026-07-08: STARTTLS/587 (v1 cut reversed)

Live-fire testing found the founder's VPS provider blocks outbound 465 upstream (no
local firewall rules; 587 and 443 open from host and container — verified by SSH
diagnostics). The deferred STARTTLS support is therefore implemented, per the
feasibility review's own §5 requirements:

- Validation accepts `security: 'tls' | 'starttls'`. STARTTLS flow: plain `net.connect`
  → 220 → EHLO → **fail closed if STARTTLS not advertised** (no plaintext AUTH, ever) →
  `STARTTLS` → 220 → `tls.connect({socket, servername: host})` (SNI explicit — not
  auto-derived when wrapping a socket; cert verification stays mandatory) → **re-EHLO on
  the upgraded socket** → AUTH → unchanged. Reply reader re-binds to the upgraded
  socket with a fresh buffer.
- Error map: STARTTLS-not-offered gets its own message; the port-mismatch hint becomes
  mode-aware ("SSL/TLS ↔ port 465, STARTTLS ↔ port 587").
- UI: the static "SSL/TLS (465)" row becomes a select (SSL/TLS 465 / STARTTLS 587);
  choosing a mode auto-fills the matching default port if the port still holds the other
  default. GET/POST smtp view gains `security`.
- Tests (no TLS cert fixtures, per the feasibility review): fail-closed when STARTTLS
  not advertised (assert no AUTH sent); STARTTLS advertised → client sends the command
  and, after 220, emits a TLS ClientHello (first byte 0x16) on the wire. The real
  upgrade path is covered by the live test-email against Hostinger.

## Agent critiques considered

Three adversarial reviews ran in parallel (security/credentials, SMTP feasibility,
simplicity/config-design).

**Security auditor** — adopted: CRLF/header-injection validation at both POST and send
paths incl. retrofitting template subjects (#4, its top item); test-email behind the
email budget + 5/min limiter + EMAIL_RE (#5); allowlist-constructed GET views +
never-spread invariant + leak test (#1/#2); 0600 store perms (#3, its "single most
worthwhile at-rest mitigation" — encryption explicitly rejected as theater); mandatory
TLS with no escape hatch, AUTH only over TLS (#9); password three-state write-only
semantics with test (#10); settings mechanism structurally excludes admin/DROP/Resend
tokens (#11); provider-none explicit no-send (#8); store normalization on load (#14);
connect-error collapsing to kill the port-scan oracle (#7). **Modified:** its
typed-"ENABLE" confirmation for the invites toggle is softened to `confirmDialog` with
an explicit provisions-real-accounts warning — the hard interlock (DROP_ADMIN_API_KEY)
stays env-side, and typed confirmation is disproportionate for a single-founder tool.

**SMTP feasibility reviewer** — adopted wholesale as the v1 spec: base64-everything /
no quoted-printable (#1/#2), chunked encoded-words (#3), multipart/alternative kept
(#4), 465-only with STARTTLS deferred (#5), AUTH selection-not-retry (#6), phase-aware
error map incl. the two port-mismatch cases (#7), buffered multiline reply reader with
reject-on-close (#8), 250-after-DATA-is-success + fire-and-forget QUIT + 60 s post-DATA
timeout (#9), single from field driving envelope+header with UI mismatch warning (#10),
sanitized EHLO (#11), serialized SMTP queue (#12), hand-formatted Date + Message-ID
(#13), plain-TCP mock-server tests with injectable transport and no TLS fixtures (#15).
Its LOC verdict (~300–340 only with QP and STARTTLS cut) is what made the zero-dep
client defensible.

**Config-design critic** — adopted: templates-pattern precedence with no provenance
machinery and no env seeding (#1, overruling my draft's three-source provenance
design); narrow getter refactor via settings.js instead of a wholesale config.js
conversion (#2); the full env-var scope table incl. cutting dashboardUrl from the UI
(#3); Resend kept with `resend-if-key-else-none` migration default (#4); invites toggle
allow-and-warn rather than disabled (#5); the stale-copy sweep as explicit deliverables
(#6); single partial POST + client-side state patch (#7); settings in waitlist.json
with load normalization (#8); save-then-test only (#9); static Hostinger hint over a
provider dropdown (#10); README/.env.example rewrites in the file list (#11).
