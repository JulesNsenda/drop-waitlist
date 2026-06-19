'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTrustedProxy, normalizeIp, getClientIp, makeRateLimiter, makeEmailBudget } = require('../src/throttle');

// ── isTrustedProxy ─────────────────────────────────────────────────────────────

test('isTrustedProxy: loopback IPv4', () => assert.ok(isTrustedProxy('127.0.0.1')));
test('isTrustedProxy: loopback IPv6', () => assert.ok(isTrustedProxy('::1')));
test('isTrustedProxy: 10.x.x.x', () => assert.ok(isTrustedProxy('10.0.0.1')));
test('isTrustedProxy: 192.168.x.x', () => assert.ok(isTrustedProxy('192.168.1.100')));
test('isTrustedProxy: 172.16.x.x', () => assert.ok(isTrustedProxy('172.16.0.1')));
test('isTrustedProxy: 172.31.x.x', () => assert.ok(isTrustedProxy('172.31.255.255')));
test('isTrustedProxy: 172.32.x.x is NOT trusted', () => assert.ok(!isTrustedProxy('172.32.0.1')));
test('isTrustedProxy: public IP not trusted', () => assert.ok(!isTrustedProxy('8.8.8.8')));
test('isTrustedProxy: null returns false', () => assert.ok(!isTrustedProxy(null)));

// ── normalizeIp ────────────────────────────────────────────────────────────────

test('normalizeIp: IPv4 returned unchanged', () => {
  assert.equal(normalizeIp('203.0.113.1'), '203.0.113.1');
});
test('normalizeIp: IPv4-mapped IPv6 returns plain IPv4', () => {
  assert.equal(normalizeIp('::ffff:192.0.2.1'), '192.0.2.1');
});
test('normalizeIp: IPv6 masked to /64', () => {
  assert.equal(normalizeIp('2001:db8:1:2:abcd:ef01:2345:6789'), '2001:db8:1:2::');
});
test('normalizeIp: null returns null', () => {
  assert.equal(normalizeIp(null), null);
});

// ── getClientIp ────────────────────────────────────────────────────────────────

test('getClientIp: public peer ignores XFF entirely', () => {
  const req = {
    socket: { remoteAddress: '8.8.8.8' },
    headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
  };
  assert.equal(getClientIp(req), '8.8.8.8');
});

test('getClientIp: trusted peer uses rightmost XFF', () => {
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
  };
  assert.equal(getClientIp(req), '2.2.2.2');
});

test('getClientIp: spoofed leftmost XFF is ignored via trusted peer', () => {
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': 'attacker-ip, real-client' },
  };
  assert.equal(getClientIp(req), 'real-client');
});

test('getClientIp: missing XFF via trusted peer → null (fail open)', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  assert.equal(getClientIp(req), null);
});

test('getClientIp: empty XFF via trusted peer → null (fail open)', () => {
  const req = { socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': '  ' } };
  assert.equal(getClientIp(req), null);
});

// ── makeRateLimiter ────────────────────────────────────────────────────────────

test('makeRateLimiter: allows requests under limit', () => {
  const lim = makeRateLimiter(3, 60_000);
  const t = 1_000;
  assert.ok(lim.allow('ip1', t));
  assert.ok(lim.allow('ip1', t));
  assert.ok(lim.allow('ip1', t));
});

test('makeRateLimiter: blocks the request that exceeds limit', () => {
  const lim = makeRateLimiter(2, 60_000);
  const t = 1_000;
  lim.allow('ip1', t);
  lim.allow('ip1', t);
  assert.ok(!lim.allow('ip1', t));
});

test('makeRateLimiter: window reset allows again', () => {
  const lim = makeRateLimiter(2, 60_000);
  const t0 = 0;
  lim.allow('ip1', t0);
  lim.allow('ip1', t0);
  assert.ok(!lim.allow('ip1', t0)); // over limit
  assert.ok(lim.allow('ip1', t0 + 60_001)); // new window
});

test('makeRateLimiter: null key always allowed (fail open)', () => {
  const lim = makeRateLimiter(0, 60_000); // even limit=0
  assert.ok(lim.allow(null, 1_000));
});

test('makeRateLimiter: different keys have independent buckets', () => {
  const lim = makeRateLimiter(1, 60_000);
  const t = 1_000;
  assert.ok(lim.allow('a', t));
  assert.ok(!lim.allow('a', t)); // a exhausted
  assert.ok(lim.allow('b', t)); // b independent
});

test('makeRateLimiter: cap flush clears map and accepts new key', () => {
  const lim = makeRateLimiter(1_000, 60_000, 5); // cap of 5
  const t = 1_000;
  for (let i = 0; i < 5; i++) lim.allow(`fill${i}`, t);
  // 6th unique key triggers cap flush; the new key should be accepted
  assert.ok(lim.allow('post-flush', t));
});

test('makeRateLimiter: retryAfter returns seconds to window end', () => {
  const lim = makeRateLimiter(1, 60_000);
  const t0 = 0;
  lim.allow('ip', t0);
  lim.allow('ip', t0); // over
  const secs = lim.retryAfter('ip', t0 + 1_000);
  assert.ok(secs > 0 && secs <= 60);
});

// ── makeEmailBudget ────────────────────────────────────────────────────────────

test('makeEmailBudget: allows sends under budget', () => {
  const b = makeEmailBudget(3);
  assert.ok(b.allow(1_000));
  assert.ok(b.allow(1_000));
  assert.ok(b.allow(1_000));
});

test('makeEmailBudget: blocks when budget exhausted', () => {
  const b = makeEmailBudget(2);
  b.allow(1_000);
  b.allow(1_000);
  assert.ok(!b.allow(1_000));
});

test('makeEmailBudget: hourly window resets the counter', () => {
  const b = makeEmailBudget(1);
  b.allow(0); // use the budget
  assert.ok(!b.allow(0)); // exhausted
  assert.ok(b.allow(3_600_001)); // new hour
});
