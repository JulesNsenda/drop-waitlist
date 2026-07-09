# UI beautification — landing page + admin, to industry standard

**Date:** 2026-07-09
**Status:** implemented & verified 2026-07-09 — diff verified item-by-item, 161/161
tests pass, server round-trip verified (signup, honeypot rejection, admin auth, woff2
serving), visual pass done via headless Chrome/CDP (landing desktop + emulated 390px
mobile, admin gate + all three authenticated views, <720px collapsed layout).
Fix-loop: one iteration — the base button inset highlight leaked onto the transparent
nav-logout button; fixed with a scoped `box-shadow: none` on `.nav-item`.

## Goal

"Beautify the app using industry standards." Bring the landing page and admin SPA up to
the visual/accessibility bar of modern dark dev-tool UIs (Linear/Vercel/Stripe tier)
while preserving the project's identity: zero runtime dependencies, no CDN fetches,
dark-only, all existing JS behavior intact.

Three adversarial reviews (compatibility, simplicity, design-quality) converged on the
same headline: the current CSS is well-organized and close — the real wins are
**contrast/a11y fixes, head metadata, and restrained polish**, not decorative effects.
The delta is ~150 additive lines, not a rewrite.

## Approach

Additive-only changes. Every existing CSS token name, element ID, and JS-queried class
is frozen. Decoration is deliberately restrained: one static ambient glow, type doing
the work, flat buttons with crisp states — not orbs/dot-grids/gradient buttons.

### 1. Foundations — `shared.css` (additive)

- **Contrast fixes (token *values* change, names don't):**
  - `--text-muted` #6b7280 fails AA (4.09:1 on bg, 3.89:1 on surface) → raise to pass
    ≥4.5:1 against the lightest surface it sits on (~#9ca3af tier).
  - `--text-dim` #374151 is 1.92:1 (the `.foot` marketing line is near-invisible) →
    raise to ≥4.5:1.
- **New tokens (extend, never rename):** `--surface-2` (hover/raised layer), `--radius`
  (10, matches everything today), `--focus` (focus-ring color = `--brand-hover` #6366f1;
  bare `--brand` fails 3:1 non-text contrast). No shadow/transition token scales —
  two pages don't need a design system; inline values where used, never `transition: all`.
- **Global `:focus-visible` ring** moves here from admin.css (landing currently has
  `outline: none` and no visible keyboard focus — delete that).
- **Input boundaries:** border #1f2937 on surface is 1.28:1 — inputs are barely findable.
  Give inputs a distinct fill (`--surface-2`) and/or ≥3:1 border, plus a `:hover` border
  state (none exists today).
- `::placeholder` color that passes 4.5:1; background on `html` (kills white overscroll
  flash); `::selection` in brand; keep `color-scheme: dark`.
- Global `prefers-reduced-motion` rule covering both pages.
- Per-element `font-variant-numeric: tabular-nums` (stat numbers, Joined column) — no
  global `font-feature-settings`/`text-rendering` (no-ops on system fonts / perf
  anti-pattern).

### 2. Typography — self-hosted Inter Variable **(decision point, recommended: yes)**

The target aesthetic is defined by Inter-family faces; `system-ui` on Windows is Segoe
UI, which has no 800 weight — the current `font-weight: 800` headings render as 700 for
most visitors (including the author). Self-hosting is consistent with the self-hosted
ethos (no CDN fetch) and is an asset, not a runtime dependency.

- Vendor one Latin-subset Inter Variable woff2 (~45KB) at `src/ui/inter-var.woff2`.
- `@font-face` in shared.css with `font-display: swap`; system stack stays as fallback.
- `static.js`: add `.woff2` to `CONTENT_TYPES` **and stop reading as utf-8** for it
  (current `readFile(…, 'utf-8')` would corrupt the binary — serve a Buffer).

Simplicity critic dissents (binary in a zero-dep repo, system stack "good enough").
Overruled with reasoning: the user asked to *beautify*; on Windows this is the single
highest-visibility typographic lever, and the cost is one asset + a 3-line static.js
change. **If vetoed:** cap headings at `font-weight: 700` and skip the static.js change.

### 3. Landing page — `landing.html`, `landing.css`, `landing.js`

- **Head metadata (highest leverage per line, was missing from draft entirely):**
  inline-SVG `data:` favicon, `meta description`, `og:title/description/type` +
  `twitter:card`, `meta theme-color #0a0a0f`. No `og:image` (would need image serving —
  consciously skipped).
- **Hero:** fluid `h1` (`clamp(34px, 8vw, 46px)`); kicker letter-spacing .3em → ~.14em
  with centering compensation (also `.foot`); subtle two-stop gradient on the word
  "dropping" only, darkest stop ≥4.5:1 (simplicity critic would keep solid accent —
  kept because it's scoped to one word; drop on request).
- **Ambient:** keep the ONE existing static glow, retuned. No second orb, no animation,
  no dot grid, no staggered entrances. One fade-up of `.wrap` as a unit — start state
  inside `@keyframes` with `animation-fill-mode: backwards` so reduced-motion never
  strands content at opacity 0.
- **Form:** flat brand button with 1px inner top highlight
  (`inset 0 1px 0 rgba(255,255,255,.15)`), background lighten on hover, active press —
  no gradient, no hover-lift, no spinner (request completes in ms; instead
  `btn.textContent = 'Joining…'` — 2 lines in landing.js). Success message keyed on
  `.msg.ok` with a small check glyph + fade.
- **A11y:** `aria-label` on `#email`/`#name` (placeholder-only today),
  `role="status" aria-live="polite"` on `#m` (outcomes are currently silent to screen
  readers), `autocapitalize="none" spellcheck="false"` on email, `min-height: 100dvh`
  (with `100vh` fallback) and dvh-aware footer for iOS Safari.
- **Honeypot `#contact_pref_x` — untouchable, three-part chain:** input stays a direct
  unwrapped child of `#f`, byte-identical; every new input/animation selector targets
  `#email, #name` explicitly (never bare `input`); it gets **no** label/aria in the
  a11y pass; `landing.js` keeps the `company` JSON key mapping exactly.

### 4. Admin — `admin.html`, `admin.css`, small named `admin.js` exception

- **Sidebar:** active nav item gets a brand accent bar (the 3-line Linear idiom).
  **No SVG icons** — 3-item nav for a single admin user doesn't earn 30–60 lines of
  markup plus mobile-row alignment work (simplicity critic; design critic ranked icons
  mid-list — cut wins).
- **Stat cards:** hover uses `--surface-2` (current hover is a no-op — hover bg equals
  base bg), `tabular-nums` on numbers, refined active-filter ring.
- **Table:** row hover; `scope="col"` on headers; visually-hidden "Actions" text in the
  empty `<th>`; `aria-label` on the table; status pills get a `::before` dot keyed on
  the exact classes admin.js renders (`.pill.pending/.approved/.invited`); the 5-column
  structure is load-bearing (`tr.lastChild` is the action cell) — unchanged.
  `td button { min-width }` so the Approve→"…" swap stops causing layout shift.
- **Forms/editors:** chips padded to ≥24px target size (WCAG 2.2 §2.5.8 — currently
  ~20px); invalid `<label>Preview</label>` (labels can't target iframes) → styled
  `<span>`; `.preview-frame` gets a slim header-chrome treatment so the white email
  canvas reads intentional in the dark UI.
- **Empty state:** dashed-border card container (text itself comes from admin.js —
  CSS-only).
- **Toast/dialog motion — entry only, this is a hard constraint:** admin.js toggles
  `hidden` and admin.css has `[hidden]{display:none!important}`; exit animations are
  impossible without JS changes. Toast entry is a `@keyframes` on `.toast` itself
  (admin.js hard-overwrites `className`, so a JS-added `.show` class can never work);
  dialog entry via `@starting-style` (safe degradation). No backdrop blur — the
  existing dim backdrop stays. No new rule may set `display` with `!important`.
- **A11y:** `aria-label` on `#gate-tok` and `#search-input` (placeholder-only),
  `aria-label="Primary"` on the sidebar nav, favicon + `theme-color` in admin.html
  head, `100dvh` on `.gate`/`.sidebar`.
- **The one `admin.js` exception (named, ~2 lines):** date formatting — `7/9/2026` →
  `Jul 9, 2026` via `toLocaleDateString(undefined, {month:'short', day:'numeric',
  year:'numeric'})` + full timestamp in `title`. Everything else in admin.js is frozen.

### Hard compatibility constraints (from the audit — binding on implementation)

1. Never rename an existing CSS custom property — a removed token makes every `var()`
   reference invalid-at-computed-value and silently un-styles both pages.
2. No inner markup (SVG/spans) in any button admin.js `textContent`-overwrites:
   gate-submit, row action buttons, export-csv, all save/reset/test buttons, creds-copy.
3. Elements whose `className` admin.js hard-overwrites (toast, save-msgs,
   test-email-result, key-status spans, env spans) are styled via ID/ancestor context
   only; bare `.ok/.err/.warn` classes must keep working alone.
4. Hooks stay byte-exact: `.nav-item[data-route]`, `.stat-card[data-filter]` (the
   "Last 7 days" card must NOT gain `data-filter`), `.chip` + `.chips[data-target]`.
5. `.gate`/`.shell` display values must come from class rules (admin.js restores with
   `style.display = ''`).
6. HTML is cached at server startup; CSS/JS re-read per request — **restart the server
   before any manual verification.**

## File-level changes

| File | Change |
|---|---|
| `src/ui/shared.css` | Token value fixes + new tokens, global focus ring, input base states, placeholder/selection/html-bg, reduced-motion, @font-face (if Inter approved) |
| `src/ui/landing.html` | Head metadata block, aria/labels, role=status on `#m`, dvh — honeypot byte-identical |
| `src/ui/landing.css` | Fluid h1, kicker tracking, gradient word, glow retune, button/input states, fade-up keyframe, success animation, foot contrast, dvh |
| `src/ui/landing.js` | "Joining…" button text during submit (nothing else; `company` mapping untouched) |
| `src/ui/admin.html` | Favicon/theme-color, table semantics, aria-labels, Preview label→span |
| `src/ui/admin.css` | Nav accent bar, stat-card hover/tabular-nums, row hover, pill dots, td-button min-width, chip sizing, empty-state card, preview chrome, toast/dialog entry animations, dvh |
| `src/ui/admin.js` | Date formatting only (~2 lines) |
| `src/static.js` | Only if Inter approved: `.woff2` content type + binary (non-utf8) read |
| `src/ui/inter-var.woff2` | Only if Inter approved: vendored Latin-subset variable font |

## Verification

- `node --test` as a regression gate only — **no test covers HTML/CSS/static serving**,
  so it proves nothing about this change.
- Real gate: restart the server, drive both pages manually — landing signup round-trip
  (including a honeypot-filled POST rejecting), admin login → all three views → approve
  flow → toast → dialogs, at desktop and <720px widths, keyboard-only pass for focus
  rings.

## Risks & open questions

- **Inter yes/no** is the one open decision (recommended yes, see §2).
- Token *value* changes ripple everywhere those tokens are used — each usage gets
  eyeballed during verification (that's the point: contrast fixes should ripple).
- Honeypot regression is the highest-severity possible bug (silently drops real
  signups); mitigated by the byte-identical rule + explicit selector targeting + a
  manual bot-style POST test.
- Entry animations vs `[hidden]`: constrained to the known-safe patterns above; if
  `@starting-style` proves flaky in the user's browser matrix, dialogs simply appear
  instantly (graceful degradation, no fix needed).
- **Consciously deferred** (flagged by critics, cut with reasons): toast dismiss
  button + live-region announce fix (needs real JS work; single-admin tool), skeleton/
  load states (needs JS), light mode (dark-only is legitimate for dev-tool surfaces),
  `og:image` (needs image serving), SVG nav icons, login-gate glow, second glow orb /
  dot grid / staggered entrances / gradient buttons (template-kit tells).

## Agent critiques considered

- **Compatibility auditor** (14 findings): token renames silently un-style both pages
  (→ names frozen); admin.js `className`/`textContent` overwrites destroy added
  markup/classes (→ constraints 2–3); honeypot is a 3-part chain vulnerable to generic
  selectors and animations overriding inline styles (→ explicit-target rule); exit
  animations impossible without JS (→ entry-only); `node --test` covers no UI (→ manual
  gate); HTML cached at startup (→ restart before verify). All adopted.
- **Simplicity critic** (14 findings): decorative layer was template-kit bloat (→ cut
  orbs/dot-grid/stagger/gradient-buttons/spinner/gate-glow/SVG icons); token system
  oversized (→ 3 new tokens, no scales); rewrite risk (→ additive-only, existing
  comments preserved); the 25-line a11y core is the real value (→ promoted to §1).
  Adopted except: Inter (overruled, §2) and the one-word gradient (kept, scoped down).
- **Design-quality reviewer** (25 findings + computed contrast table): head metadata
  gap (→ §3, top priority); focus ring must be `--brand-hover` for 3:1 (→ adopted);
  input boundaries at 1.28:1 (→ adopted); aria-live on landing msg, table semantics,
  chip target size, dvh units, fluid h1, kicker tracking, stat-hover no-op, approve
  layout shift, preview-frame chrome, date formatting exception — all adopted. Inter
  promoted from optional to recommended on its argument. Toast live-region fix,
  skeletons, light mode consciously deferred (see above).

Where critics disagreed — Inter font (simplicity: cut / design: ship) and nav icons
(design: keep / simplicity: cut) — the calls above pick a side with reasoning rather
than split the difference: Inter in (it's the visible half of "beautify" on Windows),
icons out (3 links, one user, no discoverability problem to solve).
