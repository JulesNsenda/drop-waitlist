# UI-configurable DROP admin API key

**Date:** 2026-07-09
**Status:** awaiting approval

## Goal

Approving a waitlist entry (with invites enabled) provisions an account on the DROP instance via
`provisionAccount`, authenticated with `DROP_ADMIN_API_KEY` — today env-only. The user wants to
set/replace that key from the admin UI Settings view, like the email settings, so a key rotation or
first-time setup doesn't require shelling into the box and restarting the container.

**This consciously reverses a documented decision.** `.env.example:7-9` and `README.md:40` declare
`DROP_ADMIN_API_KEY` a "hard secret: env-only, never readable or writable through Settings" (from the
2026-07-08 settings plan, security req #7). Why the reversal is acceptable:

- The key stays **write-only**: never echoed in any API response, view, log, or error. An admin-token
  holder gains key *overwrite* (integrity/DoS on provisioning), not key *read*.
- An admin-token holder can already mint DROP accounts with known passwords today (approve returns
  `tempPassword` when the invite email fails, and the same token can break email settings to force
  that failure) — so the privilege delta is small, **provided the two read-back channels found in
  review (see security fixes below) are closed in the same change**.
- At-rest posture equals the SMTP password already stored in `waitlist.json` (0600, atomic write).
- `WAITLIST_ADMIN_TOKEN` and `RESEND_API_KEY` remain env-only — the boundary moves for this one key,
  deliberately, not for the class.

## Approach

Follow the `invitesEnabled` settings pattern end-to-end (it's a single scalar, like this key):

- **Store section** `dropAdminKey` = `{ value: <key>, savedAt }` — same wrapper shape as
  `invitesEnabled`. Section saved via the existing partial-save POST; **reset deletes the section**
  (env fallback applies). No three-state `clearPassword` analogue — blank input means "don't send the
  section"; Reset is the only clear path.
- **Effective getter** `getEffectiveDropAdminKey()` = stored (defensively shape-checked:
  `typeof stored.value === 'string' && stored.value`) `||` env `DROP_ADMIN_API_KEY`. Hand-edited or
  corrupt store sections fall back to env, and the view derives provenance from the same resolution —
  never from bare section existence.
- **Validation** (`validateDropAdminKey`, bare string like `validateInvitesEnabled`'s bare boolean):
  trim → non-empty → ≤500 chars → **printable ASCII only** (`/^[\x21-\x7e]+$/`). Printable-ASCII (not
  just "no control chars") because the key goes raw into an `Authorization` header: Node's fetch
  throws a `TypeError` that **embeds the full header value** on any non-ByteString char, which would
  put the key in server logs. Trim because pasted keys carry trailing whitespace and a write-only
  field makes the resulting auth failure undiagnosable.
- **View** (`buildInvitesView`): **retire** `dropKeyConfigured` (env-truth today; re-using the name
  with effective-truth semantics is a silent flip — removing it breaks loudly instead). Add
  `dropKeySavedAt` (ISO | null) and `dropKeyEnvSet` (bool). The client derives
  `configured = savedAt || envSet` and `source = savedAt ? 'ui' : envSet ? 'env' : null`. The key
  itself appears in **no** view (settings.js INVARIANT, comment updated to name it).
- **Key consumption stays inside `drop-api.js`** — `provisionAccount(email)` signature unchanged;
  `drop-api.js` imports `getEffectiveDropAdminKey` (no require cycle; mirrors how `email.js` reads
  the SMTP password at send time instead of routes carrying secrets).

### Security fixes bundled in (blockers from review — they hold "write-only" up)

1. **Scrub upstream error echo** (`drop-api.js`): `provisionAccount` currently forwards DROP's raw
   response body into the error string shown to the admin client. If DROP ever echoes the presented
   token on 401, the key becomes readable. Redact the effective key from `detail`
   (`detail.split(key).join('[redacted]')`) before building the error.
2. **Sanitize at the fetch boundary** (`drop-api.js`): wrap the fetch in try/catch and rethrow a
   generic error (`DROP API request failed: <err.name>`) so header-value-embedding TypeErrors never
   reach the `server.js` catch-all logger. Covers the **env-key path too**, which no input validation
   can.
3. **`DROP_API_URL` must stay env-only** — add a comment at its definition in `config.js` and in
   `drop-api.js`: a UI-settable URL next to a UI-settable key is a one-click key-exfiltration oracle
   (point URL at attacker host, click Approve, receive the Bearer header).

### Admin UI (Invites card, under the existing warning banner)

- Password-type input `#drop-key-input`, `autocomplete="new-password"` (browsers ignore `off` on
  password fields and would offer to save a PaaS admin key into a cloud-synced manager; fix the
  existing `#smtp-password` input's `off` the same way in passing). Always rendered empty; static
  placeholder `(unchanged)` / `(not set)` per the SMTP-password convention.
- One status line reusing `.static-value ok/warn` badges: "Configured via UI · saved <date>" /
  "Using env var" / "Not set". No placeholder-as-state machinery.
- **Save** button (client-side no-op with message when input is empty — don't round-trip for a 400)
  and an **always-visible Reset** behind the existing `confirmDialog` (matching the email card; no
  conditional-visibility machinery). Reset when nothing is stored is a harmless no-op. Inline msg
  span for results.
- `renderInvitesCard()` **never writes `#drop-key-input.value`** — it only updates placeholder,
  status line, and banner visibility — so re-renders triggered by unrelated saves (email save/reset,
  invites toggle) can't wipe a typed key. Only the key save/reset handlers clear the input, on
  success. **Decision:** the input is exempt from dirty-guard wiring (paste-and-click flow, like the
  unguarded invites toggle) — deliberate, not inherited.
- After key save/reset: patch `state.settings.invites` from the response view, re-render **both**
  `renderInvitesCard()` and `renderEnvCard()`.
- `renderEnvCard()` keeps showing **env truth** (`dropKeyEnvSet`) but when a UI key covers a missing
  env var, render `warn` + "Not set — using key saved in Settings" instead of `err`-red on a system
  that provisions fine.

### Copy updates (stale after this feature)

- Warning banner (`admin.html`): "No DROP admin key is configured — approvals will fail while
  invites are enabled. Save a key below or set `DROP_ADMIN_API_KEY`." (visibility keys off derived
  `configured`).
- Approve 500 (`routes.js`): "No DROP admin key configured. Save one in Settings or set
  DROP_ADMIN_API_KEY."
- Env card hint + card subtitle (`admin.html`): no longer "required"/"secrets stay in the server
  environment" as absolutes.
- `README.md` (lines ~40, ~68) and `.env.example` (lines ~7-9, ~19-21): the "env-only" claims for
  this key; add a rotation note (rotating the key means updating env **and** any UI-saved value; old
  store backups contain the previous key).

### routes.js mechanics

- `handleSaveSettings`: accept optional `dropAdminKey` section; add to the "No settings provided"
  guard; **validate all present sections first, then persist** (today a valid `email` +
  invalid second section persists half the payload before the 400 — cheap reorder fixes the
  pre-existing flaw rather than tripling its surface); respond with fresh `invites` view.
- `handleResetSettings`: allow `section: 'dropAdminKey'` → returns `{ ok, invites: buildInvitesView() }`;
  update the 400 message to name both sections.
- `handleApprove`: gate on `getEffectiveDropAdminKey()` instead of the config constant.

## File-level changes

| File | Change |
|---|---|
| `src/settings.js` | `getEffectiveDropAdminKey()`, `validateDropAdminKey()`, `buildInvitesView` field changes, INVARIANT comment |
| `src/store.js` | allow `dropAdminKey` in `setSettingsSection` (as `{value, savedAt}`) / `resetSettingsSection`; comment |
| `src/routes.js` | approve gate + error copy; save/reset handlers per above; validate-all-then-persist reorder |
| `src/drop-api.js` | read effective key internally; scrub key from upstream `detail`; try/catch fetch → sanitized rethrow |
| `src/config.js` | comment: `DROP_API_URL` stays env-only (exfiltration oracle) |
| `src/ui/admin.html` | key input + Save/Reset + status line + msg span in Invites card; banner/hint/subtitle copy; `autocomplete="new-password"` on both secret inputs |
| `src/ui/admin.js` | `renderInvitesCard`/`renderEnvCard` updates, `handleSaveDropKey`, `handleResetDropKey`, listeners |
| `test/settings.test.js` | **add `DROP_ADMIN_API_KEY` to `ENV_KEYS_UNDER_TEST`** (precedence tests are nondeterministic without it); validator cases (empty, untrimmed, non-ASCII, >500, control chars); precedence UI > env > none incl. corrupt-section fallback; extend the existing no-leak test with a seeded key and the updated view shape |
| `test/drop-api.test.js` (new) | mocked global fetch: upstream detail scrubbed of key; fetch throw rethrown sanitized; 409 username-retry still works |
| `README.md`, `.env.example` | env-only claims updated; rotation note |

### Discovered during verification (added post-implementation)

End-to-end testing exposed a pre-existing crash bug that both review agents had explicitly marked
safe: `server.js` dispatched async handlers as `return handler(req, res)` inside its try/catch — a
returned promise's rejection escapes the try, so any rejecting handler (e.g. approve while the DROP
API is unreachable) killed the whole process as an unhandled rejection instead of logging and
returning 500. This invalidated the plan's assumption that the catch-all logger receives the
sanitized provisioning error. Fixed in the same change: `return await handler(req, res)` on all
seven async dispatches in `src/server.js` (file added to the change list). The key-scrubbing held
even in the crash case — the dump contained only the sanitized message.

## Risks & open questions

- **Key at rest** in `waitlist.json` — accepted (SMTP-password precedent, 0600 on Linux; Windows dev
  relies on NTFS user ACLs). DROP-level backups/copies of `DROP_DATA_DIR` now contain a PaaS admin
  key — hence the README rotation note.
- **Transport** — the app is plain HTTP behind DROP's proxy; the key rides on the proxy's TLS like
  the admin token already does. Pre-existing; documented, not changed here.
- **Admin-auth hardening** (no rate limit/lockout/failure logging on the bearer token; weak tokens
  accepted) — real, but it guards every admin endpoint equally today (including SMTP password
  writes). Deferred as a separate hardening task, not smuggled into this one.
- Store-level tests only (no HTTP harness exists; building one is out of scope — the conditional
  "route-level tests if conventions support it" wording was dropped because they don't).

## Agent critiques considered

Three adversarial reviews (correctness auditor, security reviewer, simplicity/blast-radius critic):

- **Correctness auditor** — env contamination of new tests (adopted: `ENV_KEYS_UNDER_TEST`);
  corrupt-store fallback + provenance derived from resolution not existence (adopted); typed key
  wiped by unrelated re-renders and unspecified dirty-guard stance (adopted: render never touches
  input value; dirty-guard exemption made explicit); unspecified reset response shape / no-settings
  guard / 400 copy (adopted); stale copy in banner, approve error, env hint (adopted); README /
  `.env.example` contradiction (adopted); non-atomic multi-section save (adopted: validate-then-
  persist reorder); route-level test wording guaranteed to be dropped (adopted: rescoped); trim the
  key (adopted); reset-label nit folded into always-visible-reset decision.
- **Security reviewer** — two blockers adopted verbatim: upstream error echo scrubbing and
  fetch-boundary sanitization (Node's header TypeError embeds the full key; validation alone can't
  cover the env path). Printable-ASCII validation (adopted, replaces plain control-char check).
  `DROP_API_URL` env-only comment (adopted). `autocomplete="new-password"` on both secret inputs
  (adopted). Explicit reversal-of-documented-decision framing with threat-model delta (adopted, top
  of this plan). Admin-auth throttling/lockout (**rejected for this change** — orthogonal,
  pre-existing, deserves its own task). Docker-bridge cleartext to DROP API (**accepted risk**,
  pre-existing, recorded above).
- **Simplicity critic** — 4 view fields reduced to 2 with client-side derivation, retiring
  `dropKeyConfigured` instead of silently flipping its meaning (adopted); always-visible Reset,
  no conditional button visibility (adopted); static placeholders + status line instead of
  placeholder-as-state (adopted); `{value, savedAt}` wrapper under `dropAdminKey`, exactly reusing
  the `invitesEnabled` shape (adopted); key read inside `drop-api.js` rather than a signature change
  through `routes.js` (adopted — matches `email.js`; its noted downside, `drop-api` gaining a
  settings dependency, accepted as the price of pattern consistency); env card shows env truth with
  a covered-by-UI nuance (adopted). Where it conflicted with the correctness auditor (signature
  change "contained" vs. pattern fork): sided with the simplicity critic — both are workable, one
  matches the existing secret-consumption pattern.
