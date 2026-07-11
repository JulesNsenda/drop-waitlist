# UI-configurable dashboard URL for invite emails

**Date:** 2026-07-11
**Project:** drop-waitlist
**Status:** Implemented 2026-07-11 · **Decision 1 = Option A (base + append `/dashboard`), chosen by user**

> Implemented across all 9 files + tests. Opus verification passed item-by-item;
> `node --test` = 182 pass / 1 pre-existing unrelated failure
> (`drop-api.test.js` fetch-error sanitization, untouched by this change).
> Not yet committed. **Operational step to actually fix the live dead link on
> dropkit.sh:** open the waitlist admin → Settings › Invites and set the
> Dashboard base URL to `https://dropkit.sh` (until then the effective link
> stays `http://drop-host:3000/dashboard` and the new warning banner shows).

## Goal

Let the waitlist admin set the invite-email "Open the dashboard →" link from the
admin Settings UI, instead of only via the env var `DASHBOARD_URL`.

This fixes the reported bug: the button currently renders as
`http://drop-host:3000/dashboard`. Root cause (`src/config.js:22`):
`DASHBOARD_URL` was never set, so it fell back to `DROP_API_URL`, which under
Docker isolation DROP injects as `http://drop-host:3000` — an internal
container→host gateway alias (see `drop/src/managers/runtime/container-config.ts`),
unreachable from any end-user's browser.

Making the link UI-settable both closes the immediate bug and makes the broken
state **visible** (a warning + the effective URL shown in Settings) so it can't
silently regress.

## Approach

Mirror the existing `dropAdminKey` "effective settings" flow (env default →
optional override persisted in `waitlist.json` → `getEffective*` read at call
time). Concretely:

- New `dashboardUrl` section in `store.settings`, shape `{ value, savedAt }`
  (identical to `dropAdminKey`).
- `settings.js`: add `getEffectiveDashboardUrl()` (read at call time, so a UI
  save takes effect with no restart), `validateDashboardUrl()`, and **extend the
  existing `buildInvitesView()`** — no new view builder, no new admin card.
- `email.js`: `sendInviteEmail` consumes `getEffectiveDashboardUrl()` at send
  time instead of the frozen `config.DASHBOARD_URL` constant. **This is the
  load-bearing wire — without it the feature is a no-op** (Node caches the
  module, so a UI save never reaches the current import).
- UI: one field + a live effective-URL read-back + a warning banner, added
  beneath the DROP admin key in the **Invites card**.

### Decision 1 (needs your call): URL semantics — full URL vs base+append

The env var contract today is **base + append**: `DASHBOARD_URL=https://x` →
`https://x/dashboard`. Two ways to model the new UI field:

- **Option B — store the full URL verbatim (recommended).** The admin pastes the
  actual dashboard URL from their browser bar (`https://dropkit.sh/dashboard`);
  we validate it's an `http(s)` URL and store `url.href` as-is; the email uses it
  directly. **Env path is left exactly as-is (base+append), so zero back-compat
  risk** — the asymmetry is "UI = precise full URL, env = crude base seed."
  Pros: simplest validator (~10 lines, no path surgery); WYSIWYG; correctly
  supports a dashboard served at a custom path or root (which base+append gets
  wrong by forcing `/dashboard`); deletes the entire normalization edge-case
  matrix the correctness auditor enumerated.
- **Option A — base + append everywhere.** UI field = base origin; getter appends
  `/dashboard` once to whichever source wins. Pros: one consistent rule, env/UI
  parity. Cons: must normalize a pasted full URL (strip a trailing `/dashboard`
  and slash on the parsed pathname, case-insensitively, without touching hosts
  like `mydashboard` or segments like `dashboard-foo`, and dropping query/frag);
  forces `/dashboard` even for custom deployments.

Recommendation was Option B; **user chose Option A**. The rest of this plan is
locked to **Option A**:

- The UI field takes a **base origin**; the field is labelled "Dashboard base URL",
  placeholder `https://dropkit.sh  (/dashboard added automatically)`, helper text
  "Invite emails link to \<base\>/dashboard".
- `validateDashboardUrl` **stores a normalized base** (no `/dashboard`, no trailing
  slash). Normalization runs on the parsed URL, not the raw string:
  `.trim()` → `new URL()` → operate on `url.pathname`: strip a trailing slash, then
  strip a trailing full `/dashboard` segment via `/\/dashboard\/?$/i`
  (leading-slash anchored + case-insensitive, so hosts like `mydashboard` and
  segments like `dashboard-foo` are untouched) → return `url.origin + pathname`,
  **dropping `url.search` and `url.hash`**. So both `https://dropkit.sh` and
  `https://dropkit.sh/dashboard` normalize to base `https://dropkit.sh`.
- `getEffectiveDashboardUrl()` appends `/dashboard` **exactly once** to whichever
  source wins (stored base | `DASHBOARD_URL_BASE` | `DROP_API_URL`), so there is a
  single canonical append site and no double-suffix path.

### Decision 2 (accepted, noted for awareness): the dead link ships on the *success* path

Unlike a missing `dropAdminKey` (which fails Approve loudly with a 500), an
internal `dashboardUrl` lets the invite send and returns a green
"welcome email sent" toast — the dead link ships as a success. The Settings
warning makes it **discoverable** but not **unmissable** for an admin who clicks
Approve without opening Settings. Scope decision: the Settings warning +
effective-URL read-back is the right scope for "make it UI-settable." Optional
cheap follow-up (not in this plan unless you want it): degrade the Approve
success toast to a warning when the invite's dashboard link resolves internal.

## File-level changes

1. **`src/config.js`**
   - Remove the pre-baked `DASHBOARD_URL` constant (line 22) and its export
     (line 42) — it's frozen at require time and suffixed, unusable as a live
     fallback.
   - Add `DASHBOARD_URL_BASE = process.env.DASHBOARD_URL || ''` (raw, unsuffixed)
     and export it. Keep `DROP_API_URL` exported and **env-only**.
   - Update the comment at lines 16-19: clarify that **`DROP_API_URL` stays
     env-only** (it's the Bearer/provisioning destination — a UI-settable value
     there could exfiltrate the admin key), while **`DASHBOARD_URL` (the email
     link) is intentionally UI-settable** because it's only rendered as a link and
     never carries the key.

2. **`src/settings.js`**
   - `getEffectiveDashboardUrl()` (Option A): `(stored.value || DASHBOARD_URL_BASE
     || DROP_API_URL).replace(/\/$/, '') + '/dashboard'`. Single canonical append.
     Read at call time.
   - `validateDashboardUrl(value)` (Option A — stores a normalized **base**):
     trim → reject empty/whitespace → length cap (≤2048, checked before parse) →
     reject control chars (`hasControlChars`) → `new URL()` in try/catch (reject
     unparseable, e.g. scheme-less `dropkit.sh`, with an actionable message — do
     **not** auto-prepend a scheme) → require `protocol` ∈ {`http:`,`https:`}
     (reject `javascript:`/`data:`/`file:`) → (optional) reject userinfo →
     normalize on `url.pathname`: strip trailing slash, then strip a trailing
     `/dashboard` segment (`/\/dashboard\/?$/i`, leading-slash anchored) → return
     `url.origin + normalizedPathname` (drop `search`/`hash`). Never strips
     `dashboard` inside a host or a `dashboard-foo`/non-terminal segment.
   - Extend `buildInvitesView()` with, computed server-side:
     `dashboardUrl` (effective full URL string — safe to show, it's public),
     `dashboardUrlSavedAt` (ISO|null), `dashboardUrlEnvSet` (`!!DASHBOARD_URL_BASE`),
     `dashboardUrlInternal` (boolean — see below).
   - `dashboardUrlInternal`: parse the effective URL; lowercase host; strip IPv6
     brackets; `true` if host ∈ {`drop-host`,`127.0.0.1`,`localhost`,`::1`,`0.0.0.0`}
     **or the URL fails to parse**. Keyed off the effective host, **independent of
     source** (an env var set to an internal URL is equally dead).
   - Export the three new functions.

3. **`src/store.js`**
   - `setSettingsSection`: add `else if (key === 'dashboardUrl')
     store.settings.dashboardUrl = { value, savedAt: new Date().toISOString() }`.
   - **No reset arm.** (See Decision 3.)

4. **`src/routes.js`**
   - `handleGetSettings` (~113-133): include the extended invites view (automatic
     once `buildInvitesView` is extended — verify the field flows through).
   - `handleSaveSettings` (~139-190): add a `hasDashboardUrl` arm in both the
     validate phase (`validateDashboardUrl`) and the persist phase
     (`setSettingsSection('dashboardUrl', …)`), and include the refreshed invites
     view in the response. Preserve validate-all-then-persist ordering.
   - `handleResetSettings`: **unchanged** (dashboardUrl is not resettable).

5. **`src/email.js`**
   - Drop `DASHBOARD_URL` from the `./config` import (line 3).
   - Add `getEffectiveDashboardUrl` to the existing `./settings` import (line 5).
   - Line 166: `dashboardUrl: getEffectiveDashboardUrl()`.

6. **`src/ui/admin.html`** — Invites card (~288-316), beneath the DROP admin key:
   a labelled field, a `static-value` status line (shows the effective URL), a
   Save button + message span, and a warning banner (mirrors `drop-key-warning`
   at line 294) shown when the link is internal. Label per Decision 1
   (Option A: "Dashboard base URL", placeholder
   `https://dropkit.sh  (/dashboard added automatically)`, helper "Invite emails
   link to \<base\>/dashboard"). The status line shows the **effective full URL**
   (with `/dashboard`). **No "Reset to env" button.**

7. **`src/ui/admin.js`**
   - Populate the field/status from `state.settings.invites` on load.
   - Save handler → `POST /api/admin/settings { dashboardUrl }`, then
     re-render the card (mirror `handleSaveDropKey` ~1106-1107, so the warning +
     read-back refresh live).
   - Render states per the table below; the warning banner shows iff
     `invites.dashboardUrlInternal`.
   - (Nicety) add a one-line hint near the `{{dashboardUrl}}` chip (~176)
     pointing to Settings › Invites.

8. **`.env.example` + `README.md`** — note `DASHBOARD_URL` is now UI-configurable
   (env becomes a seed/fallback with base+append semantics; the UI field is the
   primary control).

9. **Tests** — `test/settings.test.js`: add `DASHBOARD_URL` and `DROP_API_URL`
   to `ENV_KEYS_UNDER_TEST` (line 33) so `freshModules` gives a known baseline;
   cover `validateDashboardUrl` (scheme allow/deny, control chars, length,
   unparseable/scheme-less, `url.href` normalization), `getEffectiveDashboardUrl`
   (stored → verbatim; env-base fallback → `+/dashboard`; `DROP_API_URL` default),
   `dashboardUrlInternal` (internal hosts + unparseable → true; public → false),
   and the save route arm. `test/email.test.js`: a `sendInviteEmail` /
   effective-URL round-trip (currently zero coverage of the URL var).

### UX states (status line always shows the effective URL)

| Source | Status line | Style + banner |
|---|---|---|
| UI-saved, public host | "Configured via UI · saved \<date\> — \<url\>" | ok, no banner |
| UI-saved, internal host | same, internal url shown | warn + banner |
| Env set, public host | "Using env var (DASHBOARD_URL) — \<url\>" | ok, no banner |
| Env set, internal host | "Using env var — \<internal url\>" | warn + banner |
| Neither (reported bug) | "Not set — using internal default \<drop-host url\>, which users can't reach" | warn + banner |

### Decision 3 (accepted): no "Reset to env" button

For `dropAdminKey`, reset restores a real working secret. For `dashboardUrl`, the
env fallback chain terminates at `DROP_API_URL` — the internal dead link this
feature exists to kill — so "Reset to env" would silently restore the bug. The
field is a single visible input; to change it, the admin overwrites it. We
therefore omit the reset button **and** the backend reset arm (fewer edits), a
conscious divergence from the dropAdminKey mirror.

## Risks & open questions

- **Decision 1 (base vs full URL)** — resolved: **Option A (base + append)** chosen
  by the user. Normalization (strip trailing slash + trailing `/dashboard` on the
  parsed pathname) is the sharp edge; covered by the validator + edge-case tests.
- **Known edge (accepted): env-path normalization is asymmetric.** The
  `validateDashboardUrl` pathname normalization applies only to the **UI-saved**
  value. The env fallback (`DASHBOARD_URL_BASE`) and `DROP_API_URL` default are
  raw-appended in `getEffectiveDashboardUrl`, so an env `DASHBOARD_URL=https://x/dashboard`
  still yields `https://x/dashboard/dashboard` (identical to the pre-existing
  `config.js` behavior). Not fixed with a naive string strip because
  `/\/dashboard$/` mis-fires on a host literally named `dashboard`
  (e.g. `http://dashboard`) — the exact footgun the correctness auditor flagged;
  a safe fix needs the env base routed through the same `new URL()` pathname
  logic (a shared helper). Left as-is because: it's pre-existing, `.env.example`
  + `README` now document the field as a **base** (`/dashboard` appended), and
  the new Settings status line renders the effective URL so a doubled path is
  self-evident. Revisit only if an operator hits it.
- **Test ceiling (accepted): the HTTP handler is not unit-tested.** This zero-dep
  codebase has no route-handler harness (`settings.test.js`/`drop-api.test.js`
  require `config`/`store`/`settings`/`drop-api`, never `routes`), so
  `handleSaveSettings`'s `dashboardUrl` arm is verified by read-review + the fact
  that it faithfully mirrors the `dropAdminKey` arm. Coverage stops at the
  store→`getEffectiveDashboardUrl`→`sendInviteEmail` round-trip (`email.test.js`).
- **email.js rewire is mandatory** — the feature is inert without it. Verified the
  only importer of `config.DASHBOARD_URL` is `email.js:3`; no test imports it, so
  the rename breaks the build in exactly one place.
- **Warning must key off effective-host-internal, server-side** — not
  `savedAt||envSet` (which green-lights an env-set-internal URL) and not
  client-side (the client never receives `DROP_API_URL`).
- **Test isolation** — without adding `DASHBOARD_URL`/`DROP_API_URL` to
  `ENV_KEYS_UNDER_TEST`, ambient `DROP_API_URL` (common in dev/CI) makes the new
  assertions order-dependent.
- **Approve-path honesty gap** (Decision 2) — accepted as out of scope; optional
  toast-degrade follow-up available if you want it.
- **Security invariant preserved** — `dashboardUrl` is never wired into
  `drop-api.js`; `DROP_API_URL` stays env-only. Confirmed clean by all reviewers.
- **Reverses a prior decision** — `docs/plans/2026-07-08-ui-settings-smtp.md:261`
  consciously cut `dashboardUrl` from the UI. That cut was bundled with the
  `DROP_API_URL` exfiltration concern (which genuinely stays env-only), not a
  concern about the link itself; reversing it is safe under the same framing.

## Agent critiques considered

- **Correctness/edge-case auditor:** caught the double-`/dashboard` bug in the
  original draft (append in two places) and the frozen-constant fallback trap;
  enumerated the normalization edge-case matrix (query/fragment/whitespace/case/
  `mydashboard`/`dashboard-foo`) — **resolved by choosing Option B (verbatim),
  which removes normalization entirely**; confirmed the sole `config.DASHBOARD_URL`
  importer, the required store/route/save arms, `renderTemplate` `&`-escaping is
  correct, and the ENV_KEYS_UNDER_TEST isolation need.
- **Simplicity/over-engineering critic:** fold into `buildInvitesView` (no new
  card/builder) — **adopted**; store the full URL verbatim — **adopted as
  recommended Option B**; drop "Reset to env" as an anti-feature — **adopted
  (Decision 3)**; unconditional effective-URL status line over a pure heuristic —
  **adopted, combined with** the server-side internal-host flag for styling.
- **Integration/UX/blast-radius reviewer:** email.js rewire is the load-bearing
  P0 — **elevated**; warning must key off effective-host-internal server-side, not
  `savedAt||envSet` — **adopted**; the dead link ships on Approve's success path —
  **surfaced as Decision 2**; exact GET response shape, live re-render on save,
  Invites-card placement, and the `{{dashboardUrl}}` chip hint — **adopted**;
  confirmed no waitlist.json migration needed and the security boundary in code.
