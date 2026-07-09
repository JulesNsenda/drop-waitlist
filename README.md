# DROP beta waitlist

A tiny, **zero-dependency** app that runs **on DROP** and powers the beta
waitlist for DROP itself. Drop the folder in, get a URL — that's the whole pitch,
dogfooded.

- Public landing page with a join form → `GET /`
- Admin view (token-gated) → `GET /admin`
- On approve, it creates a real DROP account via DROP's admin API and emails the
  person their login. First dashboard login forces a password change.

No `npm install` needed — Node 18+ built-ins only.

## Deploy on DROP

Copy the folder into the watched webapps directory (or git-deploy it):

```bash
scp -r ./waitlist-app drop@<server>:/var/drop/data/webapps/dropkit   # name = subdomain
# → served at https://dropkit.<your-domain> within seconds
```

To make it the **apex** site (e.g. `dropkit.sh`) with the dashboard on a
subdomain, point the apex Caddy route at this app instead of the dashboard and
move the dashboard route to e.g. `app.dropkit.sh`.

## Configuration (set as DROP per-app secrets — injected as env)

Day-to-day settings — email provider (None / Resend / SMTP), the SMTP mailbox
(host/port/username/password), the from name/address, and the invites toggle —
live in the **admin UI → Settings** and are stored in `waitlist.json`. Most env
vars below are only the **fallback/seed** used until the founder saves a value
in Settings; a few are hard secrets that stay env-only forever.

| Env | Required | Purpose |
|---|---|---|
| `PORT` | auto | Injected by DROP. |
| `DROP_DATA_DIR` | auto | Injected by DROP; `waitlist.json` (entries, templates, settings) is stored here (survives upgrades). |
| `WAITLIST_ADMIN_TOKEN` | **yes** | Gate for `/admin`. Admin endpoints fail closed (403) if unset. Env-only — never readable or writable via Settings. |
| `DROP_ADMIN_API_KEY` | for invites | A DROP **admin** API key (create one in the dashboard) used to create beta accounts. Env-only. |
| `DROP_API_URL` | no | DROP API base (default `http://127.0.0.1:3000`). Use the host gateway under Docker isolation. |
| `DASHBOARD_URL` | no | Base for the dashboard link in the welcome email (defaults to `DROP_API_URL`). |
| `RESEND_API_KEY` | for Resend | [Resend](https://resend.com) API key. Env-only — set it, then pick "Resend" as the provider in Settings. |
| `EMAIL_FROM` | no | **Seed only.** Fallback from address used until a from is saved in Settings, e.g. `DROP <noreply@dropkit.sh>`. |
| `WAITLIST_INVITES_ENABLED` | no | **Seed only, default off.** Fallback used until the invites toggle is saved once in Settings. While off, approving only marks entries `approved` and creates **no** accounts. |

Email delivery has **no `SMTP_*` env vars at all** — the Hostinger (or any)
mailbox host, port, encryption mode, username, and password are entered in
Settings and stored only in `waitlist.json` (written with `0600` permissions
on Linux). Both submission modes are supported: **SSL/TLS on port 465**
(implicit TLS, the default) and **STARTTLS on port 587** — use the latter when
your host or VPS provider blocks outbound 465. Certificate verification is
always on in both modes.
Use the Settings page's built-in test-email button to confirm delivery before
relying on it. Resetting the email section in Settings deletes the saved
section so `EMAIL_FROM`/`RESEND_API_KEY` apply again.

Set env secrets via the dashboard (Settings → Secrets) or the CLI, then restart the app.

## ⚠️ Before you enable invites

Approving creates a `user`-role DROP account that can **deploy code**. Running
user code without container isolation is host code execution. **Stand up Docker
isolation (`DROP_ISOLATION=docker`) on the server first**, then enable invites
(admin UI → Settings, or set `WAITLIST_INVITES_ENABLED=true` before the first
save touches that toggle). Until then, leave invites off — you can still
collect signups and approve (mark) people; no accounts are minted. Settings
also shows a persistent warning if `DROP_ADMIN_API_KEY` isn't configured yet.

## Endpoints
- `GET /` — landing page
- `POST /api/join` `{email, name?}` — public, idempotent
- `GET /admin` — admin UI
- `GET /api/admin/entries` — token-gated list
- `POST /api/admin/approve` `{id}` — token-gated approve/invite
- `GET /api/admin/settings` — token-gated settings + template view
- `POST /api/admin/settings` `{email?, invitesEnabled?}` — token-gated partial save
- `POST /api/admin/settings/reset` `{section: "email"}` — token-gated reset-to-env
- `POST /api/admin/test-email` `{to}` — token-gated, rate-limited (5/min) test send
- `POST /api/admin/templates` `{type, subject, html}` — token-gated template save
- `POST /api/admin/templates/reset` `{type}` — token-gated reset-to-default
- `GET /api/admin/export.csv` — token-gated CSV export
- `GET /health` — `{ok:true}`

## Project layout

```
server.js          # entry point (thin shim → src/server.js)
src/
  config.js        # env-derived config
  store.js         # persistence + waitlist entry API
  settings.js      # settings validation, effective getters, allowlisted API views
  email.js         # provider-routed send (Resend / SMTP / none) + templates
  smtp.js          # zero-dependency SMTP client (465 SSL/TLS + 587 STARTTLS) + MIME message builder
  drop-api.js      # DROP account provisioning
  http.js          # request/response helpers
  views.js         # loads HTML pages from src/ui/ at startup
  ui/
    landing.html   # public join page
    admin.html     # token-gated admin UI (entries, Settings, templates)
  routes.js        # request handlers
  server.js        # HTTP server + boot
.env.example       # env contract reference
```
