'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeEqual } = require('../src/http');

test('safeEqual: equal strings return true', () => {
  assert.ok(safeEqual('correct-token', 'correct-token'));
});

test('safeEqual: wrong value returns false', () => {
  assert.ok(!safeEqual('wrong', 'correct'));
});

test('safeEqual: same length wrong value returns false', () => {
  assert.ok(!safeEqual('aaaaaa', 'bbbbbb'));
});

test('safeEqual: different lengths return false (no length leak)', () => {
  assert.ok(!safeEqual('short', 'much-longer-string'));
});

test('safeEqual: empty strings match', () => {
  assert.ok(safeEqual('', ''));
});

test('safeEqual: empty vs non-empty returns false', () => {
  assert.ok(!safeEqual('', 'something'));
});
