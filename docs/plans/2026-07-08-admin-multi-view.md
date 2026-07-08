# Admin front restructure — from one cluttered page to a proper multi-view admin

**Date:** 2026-07-08
**Status:** implemented & verified 2026-07-08 (one fix round: dirty-guard mechanism amended in §3 after verification disproved the original `history.back()` revert; §8 gained two robustness items)

## Goal

The current `/admin` is a single page stacking token input, email config, two template
editors, and the waitlist table with no hierarchy — "confusing and not professional".
Replace it with a small, zero-dependency admin app: a real login gate, an app shell with
navigation, and purpose-grouped views, while keeping the server and API untouched.

## Approach

Single HTML shell at `/admin` (no new server routes, no API changes) with client-side
hash navigation. Three views plus a login gate:

- **`#/waitlist` (default view)** — the work surface. Stat cards on top (Total, Pending,
  Approved, Invited, Last 7 days); the first four double as filter controls (clicking
  "Pending" filters the table — one mechanism, no duplicate filter tabs). A small text
  search (filter-only, **no highlighting** — avoids an XSS class entirely). Table with
  status pills, per-row action labeled by actual behavior (`pending`+invites off →
  "Approve"; `pending`+on → "Approve & invite"; `approved`+on → "Send invite"; `invited` →
  username + date, no button). "Export all (CSV)" button (labeled honestly — the endpoint
  ignores filters). Invites-disabled banner when relevant. Pending-count badge on the nav
  item. Empty states: "No signups yet", "No matches for 'x'", "Nothing pending".
- **`#/emails`** — both template editors. Monospace textarea, variable chips that insert
  at the cursor, and a live preview `<iframe sandbox srcdoc>` with sample values
  substituted (makes a missing `{{tempPassword}}` visible instead of hypothetical).
  Invite editor stays **fully editable** when invites are disabled (editing is safe, only
  sending is gated) with a notice banner instead of the current dimming. Inline save/reset
  messages stay next to the buttons (current pattern is right). Resend-unconfigured
  warning banner lives here.
- **`#/system`** — read-only status: Resend configured, sender address, invites flag,
  each with env-var remediation hints. Small on purpose; gives config a meaningful home.
- **Login gate** — full-screen centered card, `<form>` with `autocomplete="current-password"`,
  autofocus, submit button with loading state. Validates via existing
  `GET /api/admin/settings`. Distinguishes error states: 403 → "Invalid token" (with hint
  that an unset server-side ADMIN token 403s everything), network/500 → "Server
  unreachable/error". Token is trimmed, stored in **localStorage** (`drop-admin-tok`) —
  founder-only tool, same threat model as sessionStorage, avoids retyping per tab/phone
  visit; explicit Logout clears it.

**Shell:** left sidebar — DROP logo mark + wordmark (reusing the landing page identity),
nav (Waitlist / Emails / System), Logout at the bottom. Below ~720px the sidebar becomes
a top tab row via CSS only (3 items need no hamburger); the table gets `overflow-x: auto`.

### Mechanics the reviewers forced to be concrete

1. **Central `api()` wrapper** used by *every* call including the CSV blob fetch: on 403 →
   clear token, remember intended hash, show gate with "Session invalid — re-enter token",
   throw a sentinel all callers treat as "stop silently". No scattered 403 handling.
2. **Data model: load-once, patch in place.** One `loadAll()` (settings + entries in
   parallel) on login; views render from in-memory state. After approve, patch the entry
   locally from the response (status/username/invitedAt) and re-render — filter, search,
   and scroll survive. Refetch entries on `visibilitychange` → visible and on navigating
   into Waitlist, with an "Updated HH:MM" note. A render-generation counter makes stale
   async responses no-op instead of clobbering fresh renders.
3. **Dirty-guard mechanism** (`hashchange` is not cancellable). *Amended 2026-07-08:
   verification proved the original `suppressNext + history.back()` revert wrong for the
   browser-Back direction (back() compounds the move instead of reverting it, and at the
   history boundary it strands the suppress flag).* Two-path mechanism instead, with no
   history surgery: (a) nav-link clicks are intercepted with `preventDefault` and the
   guard runs **before** `location.hash` is touched — Cancel means the URL never changed;
   Discard sets the hash normally. (b) `hashchange` events that still arrive while dirty
   (browser back/forward, manual hash edits) show the dialog; Cancel restores the URL via
   `history.replaceState('#/emails')` (fires no hashchange — no loops, no direction
   detection; one rewritten history entry on this rare path is the accepted wart);
   Discard navigates to the target directly. Logout routes through the same guard.
   `beforeunload` prompts only while dirty. Re-entering Emails always repopulates from
   state and resets dirty flags (leaving = consented discard, and the confirm text says
   so).
4. **No native `alert()`/`confirm()` anywhere** — browser chrome dialogs are the amateur
   tell the user is complaining about. One reusable `<dialog>`-based async
   `confirmDialog()` helper (~25 lines, native backdrop/Esc/focus handling for free)
   serves 4 call sites: template reset, missing-vars save warning, dirty navigation,
   dirty logout. One singleton toast (textContent only, `aria-live="polite"`) for approve
   outcomes; inline messages for template save/reset.
5. **Temp password is sacred.** `handleApprove` returns it exactly once and the server
   never stores it. It renders in a blocking `<dialog>` mounted at body level (outside
   any re-rendered view), monospace, with username, the `emailError` the API already
   returns (currently dropped), a Copy button, and dismissal **only** via an explicit
   "I've saved this password" button — no Esc, no backdrop click, never auto-dismissed.
6. **XSS discipline:** all user-controlled content (email, name, username from the DROP
   API, error strings) rendered via `textContent`/DOM nodes or the existing `esc()`;
   toast and dialog bodies are textContent-only. No search highlighting (see above).
7. **Deep links & history:** visiting `/admin#/emails` logged out shows the gate and
   navigates there after login. Unknown/empty hash → `history.replaceState` to
   `#/waitlist` + manual render (replaceState fires no hashchange). Router no-ops while
   the gate is shown. Nav clicks use the guard before touching `location.hash`.
8. **Small hardening while rewriting:** `createdAt` guarded with `Number.isFinite(new
   Date(...).getTime())` → renders "—" if a hand-edited store has a bad date;
   `:focus-visible` rings in `--brand` (currently `outline: none` with border-only
   focus); minimum 12px text (11px micro-text fails readability); drop `--text-dim` /
   `#4b5563` for meaningful text (contrast failures on `#0a0a0f`). *Added after
   verification:* template save/reset buttons re-enable on every exit path including the
   403-sentinel abort (otherwise a mid-save token invalidation leaves "Saving…" stuck
   after re-login); `loadAll()` checks `ok` on both responses and shows an error instead
   of entering the shell with an error body as state.

**Visual cohesion:** admin adopts the landing page's identity pieces — logo mark, kicker
treatment for sidebar section labels, 10px radii, landing's input padding scale — but all
inside `admin.css`. `shared.css` and the landing page are untouched (zero blast radius).

## File-level changes

| File | Change |
|---|---|
| `src/ui/admin.html` | Rewrite: login gate, sidebar shell, 3 view sections, body-level dialogs (confirm + credentials), toast/live region. (~180 lines) |
| `src/ui/admin.js` | Rewrite: state + `api()` wrapper, hash navigation + guards, view renderers, dialog helper, toast, preview iframe wiring. Single file, section comments, same IIFE style. (~450 lines) |
| `src/ui/admin.css` | Rewrite: shell/sidebar + responsive collapse, login card, stat cards, table, editors + preview, dialogs, toast. (~280 lines) |
| `src/server.js`, `src/routes.js`, API | **No changes.** |
| `test/*` | **No changes needed** — all tests are pure server-module unit tests with zero UI coverage (verified). |

Estimated total ~910 lines vs current 566 (~1.6×). The growth is the visible polish:
login gate, app shell, preview iframes, dialog/toast infrastructure replacing `alert()`.

## Risks & open questions

- **`<dialog>` support** — universal in evergreen browsers since 2022; this is a
  founder-only internal tool, acceptable.
- **Preview iframe fidelity** — `srcdoc` preview renders in a browser, not an email
  client; it previews structure, not client quirks. Acceptable and labeled as such.
- **localStorage token** — slightly longer-lived exposure than sessionStorage if the
  browser profile is compromised; accepted consciously for founder ergonomics (explicit
  Logout exists). Existing sessionStorage key is simply abandoned — one-time re-login.
- **No pagination** — table renders all entries; fine at waitlist scale (hundreds). If
  DROP's beta goes viral, add it then.
- **Redundancy question** — stat cards doubling as filters is one mechanism, but if it
  feels unclear in practice, fall back to plain cards + separate filter tabs.

## Agent critiques considered

Three adversarial reviews ran in parallel (correctness/edge-cases, simplicity/over-engineering, UX/IA).

**Correctness auditor** — all four headline items adopted: central 403 wrapper incl. CSV
(§1), concrete hash-revert dirty-guard (§3), body-level non-dismissable credentials
dialog + surfacing `emailError` (§5), XSS discipline with highlighting dropped (§6).
Also adopted: render-generation counter, deep-link/post-login handling, gate error-state
branching + token trim, logout through the guard, conditional `beforeunload`, invalid-date
guard, filter state in variables (survives re-render). Its `inert`-for-dimmed-card point
became moot — the invite editor is no longer dimmed at all.

**Simplicity critic** — adopted: Dashboard route cut (stats live on Waitlist; default
route is the work surface), no router abstraction (hashchange show/hide), load-once data
model instead of per-view fetching, one singleton toast instead of a toast system, native
`<dialog>` instead of hand-rolled modal, single `admin.js`, empty/loading states as
high-value polish, login gate kept. **Consciously rejected/overruled:** (a) top nav
instead of sidebar — the UX reviewer's sidebar-collapsing-to-tabs answers the responsive
objection in pure CSS, and the sidebar is the strongest "proper admin" signal, which is
the actual complaint; (b) cutting text search — kept in filter-only form (~10 lines,
no-highlight kills the XSS cost) because filtered tables defeat Ctrl+F; (c) keeping
native `confirm()` — overruled by the UX argument that OS dialog chrome re-imports the
amateur feel, and the dialog helper amortizes across 4 call sites; (d) the ~700-line
target — landed ~910, the delta being the System view (+~30), preview iframes (+~30),
and the dialog helper — each argued for above.

**UX/IA reviewer** — adopted: Waitlist as landing view, triage defaults (newest-first,
patch-in-place after approve, pending badge on nav), invite editor editable-not-dimmed,
credentials-dialog spec, no native dialogs, honest per-row action labels, `<form>`-wrapped
login with autocomplete + localStorage, responsive collapse + table overflow, empty
states, monospace + live preview + chips-insert-at-cursor (send-test-email skipped as
poor effort/value, per both reviewers), refresh on visibility + "Updated HH:MM", visual
cohesion specifics, inline-not-toast for save feedback + aria-live, "Export all (CSV)"
label. **Modified:** its stat-strip + filter-tabs-with-counts proposal collapsed into
stat-cards-as-filters (one mechanism instead of two showing the same numbers — the
simplicity reviewer's redundancy objection applied); its "System" third view kept over
the simplicity reviewer's objection because the invites flag affects Waitlist as much as
Emails, so parking status on the Emails view is arbitrary — banners still duplicate the
actionable bits contextually.
