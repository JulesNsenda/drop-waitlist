'use strict';

const {
  WAITLIST_JOIN_LIMIT,
  WAITLIST_JOIN_WINDOW_MS,
  WAITLIST_EMAIL_BUDGET_PER_HOUR,
  TRUSTED_PROXY_IPS,
} = require('./config');

// ── trusted-proxy detection ────────────────────────────────────────────────────

// Returns true when the IP is loopback or RFC-1918/ULA private — i.e. could be
// a local reverse proxy (Caddy, Docker bridge) rather than a real client.
function isTrustedProxy(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^f[cd]/i.test(ip)) return true; // IPv6 ULA fc00::/7
  if (TRUSTED_PROXY_IPS.includes(ip)) return true;
  return false;
}

// Masks IPv6 to /64 (first 4 hextets) so a single /64 block can't rotate
// around the rate limit. IPv4 (and IPv4-mapped) returned unchanged.
function normalizeIp(ip) {
  if (!ip) return null;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const parts = ip.replace(/^\[/, '').replace(/\]$/, '').split(':');
  return parts.slice(0, 4).join(':') + '::';
}

// Extracts the real client IP from an incoming request.
// Caddy APPENDS to X-Forwarded-For, so the rightmost entry is what Caddy saw.
// Leftmost is attacker-controlled — never trust it.
// If the direct peer is not a trusted proxy, use it directly (dev / direct hit).
// Returns null when the IP can't be determined → caller should fail open.
function getClientIp(req) {
  const peer = req.socket && req.socket.remoteAddress;
  if (isTrustedProxy(peer)) {
    const xff = req.headers['x-forwarded-for'];
    if (!xff) return null; // through proxy but no XFF → fail open
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    return normalizeIp(parts[parts.length - 1]); // rightmost = real client
  }
  return normalizeIp(peer || null);
}

// ── fixed-window rate limiter factory ─────────────────────────────────────────

function makeRateLimiter(limit, windowMs, mapCap = 10_000) {
  const windows = new Map(); // key → { count, windowStart }

  // Sweep expired entries periodically. .unref() so the timer doesn't keep
  // the process alive when used in tests or at shutdown.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of windows) {
      if (now - v.windowStart >= windowMs) windows.delete(k);
    }
  }, windowMs).unref();

  function allow(key, now = Date.now()) {
    if (!key) return true; // fail open on unknown IP
    const entry = windows.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      if (windows.size >= mapCap) windows.clear(); // bounded memory
      windows.set(key, { count: 1, windowStart: now });
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  }

  // Returns seconds until the window resets (for Retry-After header).
  function retryAfter(key, now = Date.now()) {
    const entry = windows.get(key);
    if (!entry) return 0;
    return Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
  }

  return { allow, retryAfter };
}

// ── email-send budget factory (IP-independent anti-relay control) ──────────────

// Creates an hourly budget counter. Exported as a factory so tests can create
// small-budget instances without relying on the module-level default.
function makeEmailBudget(perHour) {
  let count = 0;
  let windowStart = 0;

  function allow(now = Date.now()) {
    if (now - windowStart >= 3_600_000) {
      count = 0;
      windowStart = now;
    }
    if (count >= perHour) return false;
    count++;
    return true;
  }

  return { allow };
}

// Module-level singleton used by routes.js. Created once with the configured
// budget; the factory is exported for tests.
const _emailBudget = makeEmailBudget(WAITLIST_EMAIL_BUDGET_PER_HOUR);

module.exports = {
  isTrustedProxy,
  normalizeIp,
  getClientIp,
  makeRateLimiter,
  makeEmailBudget,
  allowEmailSend: _emailBudget.allow,
};
