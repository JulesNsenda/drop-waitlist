'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, renderTemplate, htmlToText } = require('../src/email');

// ── escapeHtml ─────────────────────────────────────────────────────────────────

test('escapeHtml: escapes & < > " \'', () => {
  assert.equal(escapeHtml('a & b < c > d " e \''), 'a &amp; b &lt; c &gt; d &quot; e &#39;');
});

test('escapeHtml: safe characters untouched', () => {
  assert.equal(escapeHtml('hello world'), 'hello world');
});

test('escapeHtml: coerces non-strings', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), 'null');
});

// ── renderTemplate ─────────────────────────────────────────────────────────────

test('renderTemplate: substitutes {{key}} placeholders', () => {
  const out = renderTemplate('Hello {{name}}!', { name: 'Alice' });
  assert.equal(out, 'Hello Alice!');
});

test('renderTemplate: HTML-escapes values', () => {
  const out = renderTemplate('Hi {{name}}', { name: '<b>Jules</b>' });
  assert.equal(out, 'Hi &lt;b&gt;Jules&lt;/b&gt;');
});

test('renderTemplate: missing vars leave placeholder (warned, not thrown)', () => {
  const out = renderTemplate('Hi {{name}} {{missing}}', { name: 'Alice' });
  assert.ok(out.includes('{{missing}}'));
});

test('renderTemplate: null/undefined value becomes empty string', () => {
  const out = renderTemplate('Hi {{name}}', { name: null });
  assert.equal(out, 'Hi ');
});

// ── htmlToText ─────────────────────────────────────────────────────────────────

test('htmlToText: strips plain tags', () => {
  const out = htmlToText('<p>Hello world</p>');
  assert.ok(out.includes('Hello world'));
  assert.ok(!out.includes('<p>'));
});

test('htmlToText: <a href> becomes text (url)', () => {
  const out = htmlToText('<a href="https://example.com">Click here</a>');
  assert.ok(out.includes('Click here (https://example.com)'));
});

test('htmlToText: preserves href even when link text differs', () => {
  const out = htmlToText('<a href="https://dashboard.example.com" style="color:blue">Open →</a>');
  assert.ok(out.includes('https://dashboard.example.com'), `got: ${out}`);
});

test('htmlToText: <br> becomes newline', () => {
  const out = htmlToText('line1<br>line2');
  assert.ok(out.includes('line1\nline2') || out.includes('line1\n\nline2'));
});

test('htmlToText: </p> becomes newline', () => {
  const out = htmlToText('<p>Para one</p><p>Para two</p>');
  const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
  assert.ok(lines.includes('Para one'));
  assert.ok(lines.includes('Para two'));
});

test('htmlToText: <style> blocks removed entirely', () => {
  const out = htmlToText('<style>body { color: red; }</style>Hello');
  assert.ok(!out.includes('color'));
  assert.ok(out.includes('Hello'));
});

test('htmlToText: unescapes &amp; last', () => {
  // &amp;lt; → first pass: &amp; → & → so we get &lt;
  // but normal entity unescape: &amp; → & (not confused with &lt;)
  const out = htmlToText('AT&amp;T');
  assert.equal(out.trim(), 'AT&T');
});

test('htmlToText: unescapes &lt; &gt; &quot; &#39; &nbsp;', () => {
  const out = htmlToText('&lt;b&gt; &quot;hi&quot; it&#39;s&nbsp;ok');
  assert.ok(out.includes('<b>'));
  assert.ok(out.includes('"hi"'));
  assert.ok(out.includes("it's"));
  assert.ok(out.includes('ok'));
});

test('htmlToText: collapses excessive blank lines', () => {
  const out = htmlToText('<p>a</p>\n\n\n\n<p>b</p>');
  assert.ok(!out.match(/\n{3,}/));
});

test('htmlToText: invite template preserves dashboard URL', () => {
  const html = `<p><a href="https://app.example.com/dashboard" style="color:blue">Open the dashboard</a></p>`;
  const out = htmlToText(html);
  assert.ok(out.includes('https://app.example.com/dashboard'), `got: ${out}`);
});
