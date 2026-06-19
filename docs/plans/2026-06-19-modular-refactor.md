# Modular refactor of the DROP beta waitlist

**Date:** 2026-06-19
**Status:** Awaiting approval

## Goal

Reorganize the project so it reads as a professional, conventional Node service —
without losing the product's defining property: **zero runtime dependencies, no
build step, "drop the folder in and it runs."** Today everything lives in one
~415-line `server.js`. We split it into focused, single-concern CommonJS modules
under `src/`, keep the HTML out of the logic, and fix a couple of pre-existing
rough edges (a dangling docs link, a tmp-file gitignore gap).

Scope is the **modular refactor** the user chose — *not* tests/CI (deferred) and
*not* a behavioral change. The externally observable behavior of every endpoint
must be byte-for-byte identical after the refactor.

## Approach

- Stay **CommonJS**, **Node 18+ built-ins only**, **no `type` field** — zero churn
  to the runtime contract.
- The repo-root entry point **stays `server.js`** as a one-line shim
  (`require('./src/server')`). DROP's launch convention is undocumented in this
  repo; keeping a root `server.js` and leaving `package.json` `main`/`start`
  unchanged makes the refactor safe whether DROP runs `npm start`, `node server.js`
  by convention, or `node <main>`. The internal `src/` layout is invisible to the
  launcher.
- One concern per file. Each module reads top-to-bottom as a single idea and is
  understandable without opening the others.
- HTML moves out of the logic file but stays as **exported template strings**
  (`src/views.js`), loaded into the JS module graph — **not** `readFileSync`'d
  `.html` files. This gets 130 lines of markup out of the request-handling code
  while preserving the "can't go missing at runtime" property.

### Target layout

```
drop-waitlist/
  server.js            # 1-line shim → require('./src/server')  (entry stays at root)
  package.json         # main/start UNCHANGED ("server.js" / "node server.js")
  README.md            # dangling docs link fixed
  .gitignore           # + *.tmp
  .env.example         # NEW — documents the env contract (optional, see below)
  docs/
    plans/2026-06-19-modular-refactor.md
  src/
    config.js          # env-derived config (single source); DATA_DIR root-anchored
    store.js           # persistence + entry API (owns mutable state)
    email.js           # sendEmail + welcomeEmailHtml + escapeHtml
    drop-api.js        # createDropUser, deriveUsername, provisionAccount
    http.js            # send, sendJson, readJsonBody, adminAuthorized
    views.js           # LANDING_HTML, ADMIN_HTML (exported strings)
    routes.js          # handleJoin, listEntries, handleApprove
    server.js          # boot: loadStore() → createServer + dispatch → listen
```

### Module dependency graph (a DAG — no cycles)

```
config  ← store, email, drop-api, routes, server
store   ← routes, server
views   ← routes
http    ← routes
email   ← routes        (email owns escapeHtml; nothing requires email back)
drop-api← routes
routes  ← server
```

`config.js` requires only `path`. No project-local module requires `routes`/`server`,
so the graph is acyclic.

## File-level changes

### New files
- **`src/config.js`** — moves lines 19–34. Exports `PORT`, `DATA_DIR`, `STORE_PATH`,
  `ADMIN_TOKEN`, `INVITES_ENABLED`, `RESEND_API_KEY`, `EMAIL_FROM`, `DROP_API_URL`,
  `DROP_ADMIN_API_KEY`, `DASHBOARD_URL`, `EMAIL_RE`.
  **Critical fix:** `DATA_DIR` default becomes
  `process.env.DROP_DATA_DIR || path.join(__dirname, '..', 'data')` with a comment
  noting it must resolve to the repo root, not `src/`.
- **`src/store.js`** — moves lines 36–61 **plus** the entry mutations currently
  inline in the route handlers. Owns the module-level `store`/`writeChain`.
  Exports a **function API only** — `loadStore()`, `save()`, `getEntries()`,
  `findByEmail(email)`, `findById(id)`, `addEntry({email,name})`, `normEmail()`.
  Routes never receive or cache the `store` object (CommonJS binding-staleness trap).
- **`src/email.js`** — moves lines 63–94 **plus** `escapeHtml` (157–161), since
  `escapeHtml` is only used server-side by `welcomeEmailHtml`. Requires `config`.
- **`src/drop-api.js`** — moves lines 96–128. Requires `config` + `crypto`.
- **`src/http.js`** — moves `send`, `sendJson`, `readJsonBody`, `adminAuthorized`
  (131–155, 163–170). Requires `config` + `crypto`. (`sendJson` kept — it reads
  clearly at call sites and is harmless.)
- **`src/views.js`** — moves `LANDING_HTML` (284–341) and `ADMIN_HTML` (343–415)
  verbatim as exported strings. Confirmed no server-side `${}` interpolation in
  either page, so the move is byte-preserving.
- **`src/routes.js`** — moves `handleJoin`, `listEntries`, `handleApprove`
  (173–247), rewired to call `store`/`email`/`drop-api`/`http` modules.
- **`src/server.js`** — moves the `createServer` dispatcher + boot (250–281),
  requiring `routes`, `views`, `http`, `config`. Keeps `loadStore().then(listen)`
  order so the store is loaded before traffic is accepted.
- **`server.js` (root)** — replaced with `'use strict'; require('./src/server');`
- **`.env.example`** — documents the env contract from the README table
  (no secrets). Low-risk professional polish.

### Edited files
- **`package.json`** — `main`/`start` **unchanged**. Add professional metadata:
  `author`, `repository`, `keywords`, `license`. (See open question on license.)
- **`README.md`** — fix the dangling `docs/HETZNER-DEPLOY.md` link (line ~24–26):
  inline the one relevant sentence about the apex Caddy route and drop the broken
  link, rather than create a docs file that may be gitignored. Add a short
  "Project layout" note reflecting `src/`.
- **`.gitignore`** — add `*.tmp` (the atomic-write temp files are
  `.waitlist.<pid>.tmp`, which `waitlist.json` does not match).

### Deleted
- Nothing. The root `server.js` is repurposed as the shim, not deleted.

## Acceptance criteria

1. `node server.js` boots with no thrown error (catches require/load-order/circular
   bugs the single-file version couldn't have).
2. `GET /health` → 200 `{ok:true}`; `GET /` → 200 HTML; `GET /admin` → 200 HTML.
3. `POST /api/join` with a valid email persists an entry; admin endpoints still
   fail closed (403) with no/invalid token.
4. Default `DATA_DIR` (with `DROP_DATA_DIR` unset) resolves to `<root>/data`, not
   `<root>/src/data` — verified by logging the resolved `STORE_PATH`.
5. `git ls-files` after the change shows `src/**`, `views.js`, and `.env.example`
   tracked; no `*.tmp`/`waitlist.json` tracked.

## Risks & open questions

- **DROP launch convention (residual):** mitigated by the root shim + unchanged
  `main`/`start`. Residual risk only if DROP does something exotic (e.g. bundles or
  rewrites the entry) — not observed and not worth designing around.
- **License (open):** adding `"license"` + a `LICENSE` file needs a choice. Propose
  **MIT**, but I'll only add it on your say-so. Default if unsure: omit the file,
  set `"license": "UNLICENSED"` to be explicit about "not yet decided."
- **`.env.example` (confirm):** included as low-risk polish; say the word if you'd
  rather keep the surface area to just the refactor.
- **No tests/CI:** deliberately out of scope per the chosen "modular refactor"
  option. The acceptance smoke check is manual.

## Agent critiques considered

- **Correctness/edge-case auditor:**
  - `DATA_DIR` `__dirname` default silently relocates data → **adopted** the
    `'..','data'` anchor + comment.
  - Exporting `store`/`writeChain` by value captures a stale reference after
    `loadStore` reassigns → **adopted** a function-only store API; routes never
    cache the object.
  - `escapeHtml` placement → resolved by noticing it's email-only; lives in
    `email.js` (no util module, no cycle), which is cleaner than the auditor's
    util.js suggestion and achieves the same acyclic graph.
  - Each module must re-`require('crypto')` where used → noted in the per-file plan.
- **Simplicity/over-engineering critic:** argued for 3 files and against
  `readFileSync` HTML.
  - **Adopted** the anti-`readFileSync` point fully (exported strings instead).
  - **Adopted** collapsing the thinnest seams (escapeHtml→email; no util.js).
  - **Consciously rejected** the 3-file merge: the user explicitly chose *modular*
    over the lighter single-file-ish option, and a one-concern-per-file split is
    the conventional professional shape. Each file here maps to a distinct concern
    (config / persistence / email / DROP API / HTTP plumbing / views / routes /
    boot) and is independently readable — this is not 25-line fragments glued by
    imports. `config.js` is kept despite being thin because it's the single source
    of the env contract (consumed by 5 modules) and the home of the `DATA_DIR` fix.
- **Integration/deployment reviewer:**
  - Keep entry at root as a shim; leave `main`/`start` unchanged → **adopted**
    (this overrode the draft's plan to move the entry to `src/server.js`).
  - Default-data-dir regression → **adopted** (same fix as the correctness point).
  - `*.tmp` gitignore gap → **adopted**.
  - Don't create a `docs/` file for the dangling link (likely gitignored per the
    user's conventions); inline/remove instead → **adopted**.
  - Add a boot + `/health` + `/` + `/admin` smoke check → **adopted** into
    acceptance criteria.
