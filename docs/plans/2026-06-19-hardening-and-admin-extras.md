# Hardening + admin extras

**Date:** 2026-06-19
**Status:** Implemented (commit `81c254b`) — all 9 acceptance criteria met, 63 `node --test` checks passing.

## Goal

Six additions, in priority order:

1. **Abuse protection on `POST /api/join`** — the endpoint is public and sends a Resend email per new signup, so it can be used as a spam relay / quota-burner. Defend it.
2. **Timing-safe admin auth** — remove the token-length leak in `adminAuthorized`.
3. **Smoke tests** — zero-dep `node --test` on pure logic.
4. **CSV export** — token-gated download of the waitlist.
5. **Signup stats** — counts in the admin header.
6. **Plain-text email fallback** — improve deliverability.

Constraints unchanged: zero runtime deps, no build step, Node 18+, runs on DROP behind Caddy.

## Design decisions (reconciled from three adversarial reviews)

The single most important finding: **an IP-based rate limiter is inherently weak here** — it's per-process (wiped on every DROP deploy), multiplies under any future clustering/replicas, and is dodge-able via IPv6 /64 rotation. So the limiter is a *speed bump*, and the real defenses are the **honeypot** and an **IP-independent global email-send budget**. The plan reflects that emphasis rather than over-building the limiter.

### Client IP extraction (the contested one)

Caddy **appends** the connecting peer to `X-Forwarded-For`, so the **rightmost** entry is the IP Caddy saw; the leftmost is attacker-controlled (spoofing it lets an attacker evade the limit *or* frame a victim IP). Rule:

```
getClientIp(req):
  peer = req.socket.remoteAddress
  if isTrustedProxy(peer):                 # loopback or RFC1918/ULA private — i.e. came via local Caddy
    xff = req.headers['x-forwarded-for']
    parts = xff.split(',').map(trim).filter(Boolean)
    if parts.length: return normalizeIp(parts[parts.length - 1])   # rightmost = real client
    return null                            # through proxy but no XFF → FAIL OPEN (skip limiting)
  return normalizeIp(peer)                 # public peer = direct hit on Node → use it
```

- `isTrustedProxy(ip)` = loopback (`127.0.0.1`, `::1`) or private ranges (`10.`, `172.16–31.`, `192.168.`, `fc00::/7`). Covers PM2 (loopback) and Docker (bridge/host-gateway) without hardcoding the gateway. Overridable via `TRUSTED_PROXY_IPS` env if ever needed.
- `normalizeIp(ip)` masks IPv6 to **/64** (first 4 hextets) so a single /64 can't rotate past the limit; IPv4 returned as-is.
- **Fail open** (`null` → limiter allows) when we can't identify a client, so a Caddy misconfig never locks out the whole form. The global email budget still applies, so failing open doesn't open the costly vector.

### Rate limiter

- **Fixed-window counter** (not sliding-window timestamp arrays): `Map<key, {count, windowStart}>`. Single tier, default **20 joins / hour / IP** (`WAITLIST_JOIN_LIMIT`, `WAITLIST_JOIN_WINDOW_MS`).
- **Bounded memory:** hard cap on Map size (default 10,000 keys); on overflow, flush the map wholesale (crude, correct, zero-leak). Plus a `setInterval(...).unref()` sweep dropping expired keys, and lazy prune on access.
- Scoped to `POST /api/join` **only** — `/health` (DROP health checks) and admin routes are never throttled (a 429 on `/health` could make DROP cycle the app).
- On limit: `429` with a `Retry-After` header (seconds to window reset). Honeypot trips and duplicate resubmits **still count** toward the limit so they can't be used to probe for free.

### Global email-send budget (the real anti-relay control)

- IP-independent counter: max **N confirmation emails / hour across all clients** (`WAITLIST_EMAIL_BUDGET_PER_HOUR`, default 200). When exceeded, the signup is still stored and returns `200`, but the confirmation email is **skipped**. Protects Resend quota + sender-domain reputation under a distributed flood.
- Applies to **confirmation** emails only (public-triggered). **Invite** emails (admin-triggered, low volume, important) are not budgeted.
- **Send-concurrency guard** in `sendEmail`: a module-level in-flight counter; if too many sends are in flight (default 10), skip rather than spawn unbounded `fetch`es. Prevents socket/event-loop exhaustion from the fire-and-forget path.

### Honeypot

- Hidden field named `company` in the join form, hidden **off-screen** with `aria-hidden="true"`, `tabindex="-1"`, `autocomplete="off"` (chosen to minimize false positives — for a waitlist, silently dropping a *real* signup is worse than letting one bot through).
- If the field is non-empty server-side → return the same `200 {ok:true}` as success (silent drop, no store, no email). Never a distinct status/message (would teach bots the field name).
- `landing.js` must send the field; `landing.html` must render it. (Conscious omission: no min-time-to-submit check — the HTML is static/read-once so a server-planted nonce isn't free, and a client-sent timestamp is forgeable. Honeypot + limiter + must-run-JS bar + email budget are enough for beta.)

### Timing-safe admin auth

Current code already uses `timingSafeEqual` but guards with `a.length === b.length` first, leaking token length. Fix = hash both sides to fixed 32-byte digests, removing the length branch entirely:

```js
const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
return crypto.timingSafeEqual(h(provided), h(ADMIN_TOKEN));
```

Keep the `if (!ADMIN_TOKEN) return false` fail-closed guard (it's a static config check, not a timing leak). Extract as a pure exported `safeEqual(a, b)` so it's unit-testable without the config import.

### CSV export

- Token-gated `GET /api/admin/export.csv`, placed among the admin routes with the same `adminAuthorized` gate (403 when unauthorized).
- New `src/csv.js` with a pure `entriesToCsv(entries)` + `csvCell(value)`:
  - **Formula-injection guard composed inside RFC-4180 quoting** (order matters): if a cell starts with `= + - @`, Tab, or CR, prepend `'`; *then* RFC-4180-quote (double internal `"`, wrap in `"…"` if it contains comma/quote/CR/LF). The guard `'` must be inside the quotes. Data is attacker-supplied (`name`/`email` from the public form), so both escapes are required.
  - Columns: `email, name, status, createdAt, invitedAt, username`. Prefix output with a UTF-8 BOM (`﻿`) so Excel renders non-ASCII names.
- Handler writes explicit headers (`Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="waitlist.csv"`) via `res.writeHead` directly — the shared `send()` forces `text/html` for strings.
- `admin.js` downloads via fetch (to send the bearer header) → `res.blob()` → object URL → synthetic `<a download="waitlist.csv">` click.

### Signup stats (client-side)

- In `admin.js` `load()`, compute counts from the already-loaded `entries` array: total + per-status (pending/approved/invited) + joined-last-7-days. Render in a line above the table. No backend change, no new endpoint. Tolerate an empty list (no NaN).

### Plain-text email fallback

- `htmlToText(html)` in `email.js`, run on the **already-rendered** HTML (after `renderTemplate`):
  - strip `<style>`/`<script>` blocks,
  - convert `<a href="URL">text</a>` → `text (URL)` (**must** preserve the invite dashboard link — a naive strip would drop it),
  - convert `<br>` and block-closing tags (`</p>`, `</div>`, `</h1-6>`, `</tr>`) to newlines,
  - drop remaining tags,
  - unescape the small entity set we emit (`&amp; &lt; &gt; &quot; &#39; &nbsp;`), decoding `&amp;` last,
  - collapse runs of blank lines.
- Pass the result as Resend's `text` field alongside `html`. Best-effort quality (it's a fallback for admin-authored templates); not a general HTML parser.

## File-level changes

| File | Change |
|---|---|
| `src/throttle.js` (new) | `getClientIp`, `isTrustedProxy`, `normalizeIp` (pure, exported), `makeRateLimiter()` → `allow(key, now)` (fixed-window, capped, swept), `allowEmailSend(now)` (global budget). |
| `src/csv.js` (new) | `csvCell(value)`, `entriesToCsv(entries)` (pure, exported). |
| `src/http.js` | Extract + export pure `safeEqual(a,b)`; `adminAuthorized` uses it (SHA-256 timing fix). |
| `src/email.js` | Add `htmlToText`; `sendEmail` passes `text` + has the in-flight concurrency guard. Export `htmlToText`. |
| `src/routes.js` | `handleJoin`: rate-limit (429+Retry-After) → honeypot silent-200 → existing validation → store; gate confirmation send on `allowEmailSend()`. Add `handleExportCsv`. |
| `src/server.js` | Wire limiter into the `/api/join` branch only; add token-gated `GET /api/admin/export.csv`; periodic sweep `setInterval().unref()`. |
| `src/config.js` | New env: `WAITLIST_JOIN_LIMIT` (20), `WAITLIST_JOIN_WINDOW_MS` (3600000), `WAITLIST_EMAIL_BUDGET_PER_HOUR` (200), `TRUSTED_PROXY_IPS` (optional). |
| `src/ui/landing.html` | Off-screen honeypot field. |
| `src/ui/landing.js` | Send the honeypot field in the POST body. |
| `src/ui/admin.html` | Stats line; "Download CSV" button. |
| `src/ui/admin.js` | Compute/render stats; CSV fetch→blob→download. |
| `test/*.test.js` (new) | `node --test` over pure functions only. |
| `package.json` | Add `"test": "node --test"`. No deps/devDeps. |
| `README.md`, `.env.example` | Document new env + the best-effort/single-instance limiter caveat. |

## Tests (pure functions only)

No store/singleton tests, no server boot, no network, no secrets (must run on bare Node 18):
- `getClientIp`/`normalizeIp`/`isTrustedProxy`: spoofed leftmost XFF ignored, rightmost trusted only via private peer, public peer bypasses XFF, IPv6 /64 masking, missing XFF → null (fail open).
- `allow(key, now)`: under/over limit with injectable `now`, window reset, cap flush.
- `allowEmailSend(now)`: budget exhaustion + window reset.
- `csvCell`: leading `=`/`+`/`-`/`@`/Tab/CR neutralized inside quotes; embedded comma/quote/CRLF quoted; combined.
- `renderTemplate`/`escapeHtml`: substitution, escaping, unresolved-placeholder path.
- `htmlToText`: `<a href>` → `text (url)`, `<br>`/block→newline, entity unescape order, placeholder-free output.
- `safeEqual`: equal, wrong-value-same-length, wrong-length.

## Risks & open questions

- **Limiter is best-effort:** per-process, non-persistent (reset on deploy), per-replica if DROP ever clusters this app. Documented as a conscious tradeoff; the email budget + honeypot are the durable controls. **Not** persisted to `waitlist.json` (would turn spam into disk I/O and bloat the store).
- **Shared-IP bursts:** a corporate NAT / university / CGNAT shares one public IP, so a legit launch spike from one network could share a bucket. 20/hr is sized to tolerate this for a beta; documented. Fail-open covers the misconfig case.
- **Honeypot is a weak filter** against targeted bots (they read the DOM) — kills dumb form-spam only. Acceptable; layered with the other controls.
- **`htmlToText` quality** is best-effort for the text fallback; the HTML part is what nearly everyone sees.
- **`test/` ships** to the server via scp/git-deploy (harmless, never imported). DROP runs `node server.js`/`npm start`, not `npm test`, so the test script doesn't affect launch.

## Acceptance criteria

1. `POST /api/join` past the per-IP limit → `429` with `Retry-After`; `/health` and admin routes never throttled.
2. Spoofed leftmost `X-Forwarded-For` does not change the bucket; rightmost (trusted-peer) does; missing XFF via proxy → not rate-limited (form still works).
3. Honeypot filled → `200 {ok:true}`, no entry stored, no email sent.
4. Global email budget exhausted → signups still stored (200), confirmation emails skipped.
5. `adminAuthorized` rejects wrong tokens; `safeEqual` unit tests pass; no length branch remains.
6. `GET /api/admin/export.csv` → 403 without token; with token, downloads a CSV; a name `=HYPERLINK(...)` is neutralized; embedded commas/quotes/newlines stay in-cell.
7. Admin header shows correct total + per-status counts; empty list shows zeros, no NaN.
8. Invite + confirmation emails include a non-empty `text` part; the invite text contains the dashboard URL.
9. `node --test` passes on bare Node 18 with no env set and no network.

## Agent critiques considered

- **Security auditor:** XFF rightmost + trusted-proxy gate (not leftmost/spoofable) → adopted; IPv6 /64 + Map cap + sweep → adopted; **global email budget + send-concurrency cap** as the real anti-relay control → adopted (elevated to first-class); CSV guard extended to Tab/CR and composed *inside* RFC-4180 quotes → adopted; honeypot silent-200 + accessibility attrs → adopted; SHA-256 timing fix correct → adopted; `Retry-After` + limiter scoped to `/api/join` → adopted.
- **Simplicity critic:** fixed-window single tier (not two-tier sliding arrays) → adopted; SHA-256 is the *simpler* timing fix → adopted; **pure-function tests only, no stateful-store/integration tests** → adopted; client-side stats → adopted; `htmlToText` scoped to "good enough" → adopted. Rejected its "trust leftmost XFF / accept spoofing" and "inline the limiter" — the framing-a-victim risk and the test-in-isolation benefit justify the small `throttle.js` module and correct parsing.
- **Deployment reviewer:** **fail-open on missing XFF** (never global-bucket on `remoteAddress`) → adopted; limiter documented best-effort/single-instance, not persisted to the store → adopted; honeypot must update both `landing.html` + `landing.js`, off-screen not `type=hidden` → adopted; zero devDeps, tests need no network/secrets, `test/` ships harmlessly → adopted; CSV among admin routes with explicit headers, `a.download` filename → adopted; `htmlToText` must preserve `href` → adopted; limiter scoped to `/api/join`, capped 429 logging → adopted. Corrected its XFF *direction* (it said leftmost = client; Caddy appends, so rightmost is the trustworthy peer) — surfaced explicitly rather than averaged.
