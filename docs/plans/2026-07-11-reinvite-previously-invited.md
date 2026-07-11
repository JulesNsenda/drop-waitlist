# Re-invite a previously-invited waitlist entry

**Date:** 2026-07-11
**Project:** drop-waitlist
**Status:** Reviewed (2 adversarial agents) — awaiting approval

## Goal

Let the admin re-invite a waitlist entry that is already `status === 'invited'`
(recipient never got the email, lost it, or never logged in). Today
`handleApprove` hard-blocks this: `routes.js:79` returns `409 "Already invited."`,
with no resend path.

## Key constraint that shapes the design

The temp password is **never persisted** — only `entry.username` is stored
(`routes.js:100-101`). So a re-invite **cannot resend the original credentials**;
it must **reset the DROP account's password** to a fresh temp password and email
the new credentials.

DROP supports this: `POST /api/v1/auth/users/:id/reset-password` (admin-only,
`drop/src/api/routes/auth.ts:305`; `resetUserPassword` matches by internal **id**,
sets `mustChangePassword=true` which aligns with the invite copy). The endpoint
keys off the internal user **id**, which the waitlist does not store (only
`username`), so re-invite resolves `username → id` via `GET /api/v1/auth/users`
(admin list). Username exact-match is safe: DROP enforces username uniqueness and
usernames are immutable, and `provisionAccount`'s collision suffix (`base-2`…) is
stored verbatim as `entry.username`, so the stored value matches the DROP record
exactly. The only lookup-miss cause is deletion (handled below).

## Approach

New admin endpoint `POST /api/admin/reinvite { id }` (separate from `approve`, so
approve keeps its first-invite-only `409` guard — confirmed the right call).

### `reprovisionAccount(username)` — new, in `src/drop-api.js`

Two sequential DROP calls, **both** wrapped exactly like `createDropUser`
(`drop-api.js:26-36`) so Node's header-embedding `TypeError` never leaks the key
(surface only `err.cause?.code || err.name`), and both scrubbing the key from any
non-ok `res.text()` (mirror `drop-api.js:62`):

1. `GET /api/v1/auth/users` with the admin key. Response envelope is
   `{ success, data:[…] }` — scan **`body.data.find(u => u.username === username)`**
   (not `body.find`).
   - not found → `{ ok:false, code:'not_found' }` (account deleted in DROP).
   - `user.enabled === false` → `{ ok:false, code:'disabled' }` (suspended — a
     reset would email creds that can't log in).
2. Generate `password = crypto.randomBytes(12).toString('base64url')` (16 chars,
   ≥ DROP's 8-char min; same generator as `provisionAccount`).
3. `POST /api/v1/auth/users/${user.id}/reset-password { newPassword: password }`.
   - non-ok → `{ ok:false, error:'DROP API <status>: <scrubbed>' }`.
4. `{ ok:true, username, password }`.

**Never** `console.log`/`console.error` the generated password or the user list.
Return only `{ok, username, password}` / `{ok:false, code?, error?}`.

### `handleReinvite(req, res)` — new, in `src/routes.js`

Outcome mapping (each returns a definite status; no inconsistent state):

| Condition | Status | Action |
|---|---|---|
| entry not found | 404 | — |
| entry.status ≠ `'invited'` | 409 | "Use Approve for entries that haven't been invited." |
| no admin key (`!getEffectiveDropAdminKey()`) | 500 | same message as approve |
| reprovision `not_found` | 409 | **flip `entry.status='approved'`**, clear `entry.username`/`invitedAt`, `save()`; "DROP account no longer exists — entry reset to Approved; approve again to create a fresh account." |
| reprovision `disabled` | 409 | "DROP account is suspended — re-enable it in DROP first." |
| reprovision other `{ok:false}` (transport / 403 / 5xx) | 502 | `result.error` |
| reprovision `ok` | 200 | send email, update `invitedAt`/`updatedAt`, `save()` |

The `not_found` flip is the **escape hatch** (Finding F2): without it the entry is
permanently stuck (re-invite keeps failing AND approve 409s on `invited`). On
success the response mirrors approve: `{ ok:true, username, emailSent, emailError,
tempPassword: emailSent ? undefined : password }`.

Re-invite is admin-triggered and, like approve, **bypasses** the public
`allowEmailSend()` budget (`routes.js:98` sends directly) — consistent; not rate
limited (matches approve).

### UI — `src/ui/admin.js` + `src/ui/admin.html`

- **Shared success/failure renderer.** Approve's UI branch is keyed on
  `result.created` (`admin.js:609-627`), which re-invite has no concept of.
  Extract a small `renderProvisionOutcome(result, { successToast })` keyed on
  `emailSent` (true → toast; false → creds-dialog with the new username/password),
  and call it from both the approve `created` branch and the new re-invite handler
  (different `successToast` copy). Small dedup, prevents drift.
- **Creds-dialog title.** `#creds-dialog`'s `<h2>` hardcodes "Account created"
  (`admin.html:374`) and `openCredsDialog` never sets it. Re-invite opens this
  dialog only on **email-failure-after-reset**, where "Account created" is
  misleading. Add `id="creds-dialog-title"` and a `title` param to
  `openCredsDialog` (default `'Account created'`, `'Credentials reset'` for
  re-invite). **(This means admin.html changes — corrects the draft's file list.)**
- **Button.** For `invited` rows, add a **"Re-invite"** button in the existing
  `actionCell` beside the `invited-info` span (`admin.js:531-535`). Click →
  `confirmDialog`: *"Re-invite &lt;email&gt;? This resets their DROP password and
  emails new credentials — any password they've already set will stop working."*
  → `POST /api/admin/reinvite { id }`. **Disable the button in-flight** (mitigates
  the double-click double-reset race, F7). On resolve → `renderProvisionOutcome`.
- **Route wiring** — `src/server.js`: add
  `if (p === '/api/admin/reinvite' && req.method === 'POST') { adminAuthorized →
  handleReinvite }` (mirror `/api/admin/approve`, `server.js:45-48`) and import it.

## File-level changes

1. `src/drop-api.js` — add `reprovisionAccount(username)` (+ internal
   `findDropUser`); export it. Both fetches key-scrub wrapped; no logging of
   password/user-list.
2. `src/routes.js` — add `handleReinvite`; export it.
3. `src/server.js` — import `handleReinvite`; add the token-gated
   `/api/admin/reinvite` route.
4. `src/ui/admin.js` — `renderProvisionOutcome` helper (refactor approve to use
   it); "Re-invite" button for `invited` rows + confirm + POST + in-flight disable.
5. `src/ui/admin.html` — `id="creds-dialog-title"` on the dialog `<h2>`.
6. `test/drop-api.test.js` — cover `reprovisionAccount`: happy path (`GET` list →
   match → `reset` → returns new password), `not_found`, `disabled`
   (`enabled:false`), reset failure, and key-scrub in both fetches' errors. (No
   route-handler harness exists in this repo — coverage lives at the drop-api
   layer, consistent with existing tests. Mock `global.fetch` per the existing
   `drop-api.test.js` pattern, returning `{success:true,data:[{id,username,enabled}]}`.)

## Risks & decisions (reconciled from review)

- **Password-reset caveat (needs your OK):** re-invite necessarily resets the DROP
  password, so if the user already set their own it stops working. Inherent (we
  never store the temp password). The confirm dialog surfaces it.
- **Deleted-account escape hatch (F2, adopted):** on DROP-side deletion, flip the
  entry back to `approved` so the admin can re-approve — otherwise it's stuck.
- **Scoped-token dependency (F1, framing corrected):** re-invite's calls
  (`GET /users`, `reset-password`) are **admin-only**, unlike approve's create
  (`users:create` capability suffices). Non-blocking **today** — the waitlist holds
  a full admin key (`getEffectiveDropAdminKey`) — but if it ever migrates to a
  scoped `users:create` token (DROP-051 direction), re-invite would 403.
  `reprovisionAccount` surfaces that 403 cleanly.
- **Suspended account (F6, adopted):** reject `enabled:false` rather than emailing
  dead creds.
- **MFA not reset (F5, documented):** reset rotates only the password; a user who
  enabled MFA still needs their authenticator. Re-invite recovers a lost password,
  not a lost second factor.
- **Invites-toggle bypass (CLOSED — correct, not open):** re-invite ignores the
  invites toggle because it only rotates a password on an already-provisioned
  account (creates nothing, changes no isolation posture). Visible UI
  inconsistency accepted: with invites off, `approved` rows show no button while
  `invited` rows still offer Re-invite (I4) — documented, not a bug.
- **Concurrency (F7):** button disabled in-flight; no per-entry server guard (same
  pre-existing race as approve).
- **id resolution:** resolved via `GET /auth/users` at call time (works for
  entries invited before this change). Not storing the DROP id — deferred.

## Agent critiques considered

- **Correctness/security reviewer:** confirmed username exact-match, password
  constraints, `mustChangePassword`, and email-fail-mirrors-approve as sound.
  Raised (all adopted): F1 scoped-token framing was factually wrong (approve
  tolerates a scoped token, re-invite can't) → corrected; F2 deleted-account
  dead-end → added the `approved` flip; F3 response envelope is `{success,data}` →
  scan `body.data`; F4 both fetches must scrub + no password/list logging; F5 MFA
  not reset → documented; F6 suspended account → reject; F7 double-click race →
  in-flight disable; F8 unbudgeted email path → noted (consistent with approve).
- **Integration/UX/simplicity reviewer:** creds-dialog title hardcoded "Account
  created" → parameterize (corrects the file list); approve's `created`-keyed
  success branch doesn't fit re-invite → shared `renderProvisionOutcome` helper;
  `reprovisionAccount` is the right abstraction but both calls need scrub;
  invites-toggle UI inconsistency → document as accepted; separate endpoint, row
  placement, and confirm copy confirmed sound.
