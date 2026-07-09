# DROP product-site landing page

Full implementation of `Landing.dc.html` from the **"DROP Platform Design"**
Claude Design project (`b2fbbdb6-c229-4d84-8ed2-e05b9b6460f3`) — the marketing
landing page for the DROP product site (hero + terminal demo, runtimes strip,
how-it-works, features grid, dashboard preview, drop.yaml escape hatch, CLI,
CTA, footer). Dark default + light theme via `data-theme`, self-hosted fonts.

This is intentionally **not** wired into the waitlist app — the waitlist's
join page stays minimal (email, name, join). Lift this folder into the DROP
product site when it ships; it is self-contained (relative paths, fonts
included) and can be previewed by opening `landing.html` directly.

Note: the waitlist-specific bits (join form CTA posting to `/api/join`,
`/admin` and `/health` footer links) should be re-pointed at product-site
equivalents when adopted.
