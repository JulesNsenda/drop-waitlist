'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { csvCell } = require('../src/csv');

test('csvCell: plain string passes through unchanged', () => {
  assert.equal(csvCell('hello'), 'hello');
});

test('csvCell: null and undefined become empty string', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('csvCell: leading = is neutralized inside quotes', () => {
  const out = csvCell('=HYPERLINK("evil.com")');
  assert.ok(out.startsWith("'=") || out.startsWith('"\'='), `got: ${out}`);
  assert.ok(!out.startsWith('='));
});

test('csvCell: leading + neutralized', () => {
  assert.ok(!csvCell('+1').startsWith('+'));
});

test('csvCell: leading - neutralized', () => {
  assert.ok(!csvCell('-1 formula').startsWith('-'));
});

test('csvCell: leading @ neutralized', () => {
  assert.ok(!csvCell('@SUM').startsWith('@'));
});

test('csvCell: leading tab neutralized', () => {
  assert.ok(!csvCell('\tformula').startsWith('\t'));
});

test('csvCell: embedded comma triggers RFC-4180 quoting', () => {
  const out = csvCell('Smith, John');
  assert.equal(out, '"Smith, John"');
});

test('csvCell: embedded double-quote doubled and wrapped', () => {
  const out = csvCell('say "hello"');
  assert.equal(out, '"say ""hello"""');
});

test('csvCell: embedded newline triggers quoting', () => {
  const out = csvCell('line1\nline2');
  assert.ok(out.startsWith('"') && out.endsWith('"'));
});

test('csvCell: formula guard + embedded comma — guard inside quotes', () => {
  // =A,B starts with = (inject guard) and has a comma (RFC-4180 quote).
  // The ' guard must be inside the quotes: "'=A,B"
  const out = csvCell('=A,B');
  assert.equal(out, '"\'=A,B"');
});

test('csvCell: number converted to string', () => {
  assert.equal(csvCell(42), '42');
});
