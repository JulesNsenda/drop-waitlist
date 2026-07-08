'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const {
  smtpSend,
  buildMimeMessage,
  parseFromField,
  encodeHeaderValue,
  base64Wrap,
  dotStuff,
  formatRfc5322Date,
} = require('../src/smtp');

// ── parseFromField ─────────────────────────────────────────────────────────────

test('parseFromField: Name <addr> form', () => {
  assert.deepEqual(parseFromField('DROP <hello@drop.dev>'), { name: 'DROP', addr: 'hello@drop.dev' });
});

test('parseFromField: bare address', () => {
  assert.deepEqual(parseFromField('hello@drop.dev'), { name: null, addr: 'hello@drop.dev' });
});

test('parseFromField: quoted display name unquoted', () => {
  assert.deepEqual(parseFromField('"The Team" <a@b.c>'), { name: 'The Team', addr: 'a@b.c' });
});

// ── encodeHeaderValue / RFC 2047 ───────────────────────────────────────────────

test('encodeHeaderValue: pure ASCII passes through unchanged', () => {
  assert.equal(encodeHeaderValue('Hello world 123!'), 'Hello world 123!');
});

function decodeWords(encoded) {
  const words = encoded.split('\r\n ');
  const decoded = words.map((w) => {
    const m = w.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
    assert.ok(m, `not a valid encoded-word: ${w}`);
    return Buffer.from(m[1], 'base64').toString('utf8');
  });
  return { words, decoded };
}

test('encodeHeaderValue: long accented subject chunks into words <=75 chars that decode losslessly', () => {
  const input = 'é'.repeat(60); // 120 UTF-8 bytes → forces multiple 45-byte chunks
  const out = encodeHeaderValue(input);
  const { words, decoded } = decodeWords(out);
  assert.ok(words.length >= 3, `expected >=3 words, got ${words.length}`);
  for (const w of words) assert.ok(w.length <= 75, `word too long (${w.length}): ${w}`);
  for (const d of decoded) assert.ok(!d.includes('�'), 'chunk split a multibyte character');
  assert.equal(decoded.join(''), input);
});

test('encodeHeaderValue: emoji (4-byte chars) never split mid-character', () => {
  const input = '🎉'.repeat(30); // 120 UTF-8 bytes
  const out = encodeHeaderValue(input);
  const { words, decoded } = decodeWords(out);
  assert.ok(words.length >= 3);
  for (const w of words) assert.ok(w.length <= 75);
  for (const d of decoded) assert.ok(!d.includes('�'), 'chunk split a surrogate pair');
  assert.equal(decoded.join(''), input);
});

// ── formatRfc5322Date ──────────────────────────────────────────────────────────

test('formatRfc5322Date: exact known value with +0000 (not GMT)', () => {
  const d = new Date(Date.UTC(2026, 6, 8, 9, 5, 3)); // Wed 8 Jul 2026
  assert.equal(formatRfc5322Date(d), 'Wed, 8 Jul 2026 09:05:03 +0000');
});

test('formatRfc5322Date: shape regex and +0000 suffix', () => {
  const out = formatRfc5322Date(new Date());
  assert.match(out, /^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
  assert.match(out, /\+0000$/);
  assert.ok(!out.includes('GMT'));
});

// ── base64Wrap ─────────────────────────────────────────────────────────────────

test('base64Wrap: wraps at 76 chars and round-trips', () => {
  const input = 'a'.repeat(100); // 136 base64 chars → 76 + 60
  const out = base64Wrap(input);
  const lines = out.split('\r\n');
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(l.length <= 76, `line too long: ${l.length}`);
  for (const l of lines.slice(0, -1)) assert.equal(l.length, 76);
  assert.equal(Buffer.from(lines.join(''), 'base64').toString('utf8'), input);
});

test('base64Wrap: utf-8 content round-trips', () => {
  const input = 'héllo 🎉 wörld';
  const out = base64Wrap(input);
  assert.equal(Buffer.from(out.replace(/\r\n/g, ''), 'base64').toString('utf8'), input);
});

// ── dotStuff ───────────────────────────────────────────────────────────────────

test('dotStuff: line-leading dots doubled, including first line', () => {
  assert.equal(dotStuff('.start\r\nmid\r\n.dot'), '..start\r\nmid\r\n..dot');
});

test('dotStuff: consecutive dot-only lines', () => {
  assert.equal(dotStuff('.\r\n.'), '..\r\n..');
});

test('dotStuff: mid-line dots untouched', () => {
  assert.equal(dotStuff('a.b\r\nc.d'), 'a.b\r\nc.d');
});

// ── buildMimeMessage ───────────────────────────────────────────────────────────

const FIXED = {
  from: 'DROP <hello@drop.dev>',
  to: 'user@example.com',
  subject: 'Hello there',
  html: '<p>Hi <b>you</b></p>',
  text: 'Hi you',
  date: 'Wed, 8 Jul 2026 09:05:03 +0000',
  messageId: '<123.abc@drop.dev>',
};

test('buildMimeMessage: multipart structure — boundary used exactly 3 times on the wire', () => {
  const msg = buildMimeMessage(FIXED);
  const bm = msg.match(/Content-Type: multipart\/alternative; boundary="([^"]+)"/);
  assert.ok(bm, 'missing multipart Content-Type header');
  const boundary = bm[1];
  assert.match(boundary, /^----=_drop_[0-9a-f]{32}$/);
  const lines = msg.split('\r\n');
  const separators = lines.filter((l) => l === `--${boundary}`);
  const terminators = lines.filter((l) => l === `--${boundary}--`);
  assert.equal(separators.length, 2, 'expected exactly 2 part separators');
  assert.equal(terminators.length, 1, 'expected exactly 1 terminator');
  // text/plain part comes before text/html
  assert.ok(msg.indexOf('text/plain') < msg.indexOf('text/html'));
  assert.ok(!/quoted-printable/i.test(msg), 'no quoted-printable anywhere');
});

test('buildMimeMessage: headers present; deterministic date and message-id honoured', () => {
  const msg = buildMimeMessage(FIXED);
  const headerBlock = msg.split('\r\n\r\n')[0];
  assert.ok(headerBlock.includes('From: DROP <hello@drop.dev>'));
  assert.ok(headerBlock.includes('To: user@example.com'));
  assert.ok(headerBlock.includes('Subject: Hello there'));
  assert.ok(headerBlock.includes(`Date: ${FIXED.date}`));
  assert.ok(headerBlock.includes(`Message-ID: ${FIXED.messageId}`));
  assert.ok(headerBlock.includes('MIME-Version: 1.0'));
});

test('buildMimeMessage: both parts are base64 and the html part decodes losslessly', () => {
  const msg = buildMimeMessage(FIXED);
  assert.equal((msg.match(/Content-Transfer-Encoding: base64/g) || []).length, 2);
  const boundary = msg.match(/boundary="([^"]+)"/)[1];
  const parts = msg.split(`--${boundary}`);
  const htmlPart = parts.find((p) => p.includes('text/html'));
  const b64 = htmlPart.split('\r\n\r\n')[1].replace(/\r\n/g, '').replace(/--$/, '');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), FIXED.html);
});

test('buildMimeMessage: non-ASCII display name is RFC 2047 encoded in From', () => {
  const msg = buildMimeMessage({ ...FIXED, from: 'Ünïcøde <a@b.c>' });
  const fromLine = msg.split('\r\n').find((l) => l.startsWith('From: '));
  assert.ok(fromLine.includes('=?UTF-8?B?'), `From not encoded: ${fromLine}`);
  assert.ok(fromLine.endsWith('<a@b.c>'));
});

test('buildMimeMessage: CRLF stripped from hostile subject — no header injection', () => {
  const msg = buildMimeMessage({ ...FIXED, subject: 'Hi\r\nBcc: evil@attacker.example' });
  const headerBlock = msg.split('\r\n\r\n')[0];
  const headerLines = headerBlock.split('\r\n');
  assert.ok(!headerLines.some((l) => l.startsWith('Bcc:')), 'injected Bcc header appeared');
  assert.ok(headerLines.includes('Subject: HiBcc: evil@attacker.example'));
});

test('buildMimeMessage: CRLF stripped from hostile to/from', () => {
  const msg = buildMimeMessage({ ...FIXED, to: 'u@e.com\r\nX-Evil: 1' });
  assert.ok(!msg.split('\r\n').some((l) => l.startsWith('X-Evil:')));
});

// ── mock SMTP server ───────────────────────────────────────────────────────────

// Plain-TCP scripted SMTP server. Replies per verb; `opts` overrides individual
// replies or destroys the socket on a given verb. Records every command line
// and the full DATA payload.
function startMockServer(opts = {}) {
  const received = { commands: [], message: null };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = '';
    let inData = false;
    socket.write('220 mock.example.com ESMTP ready\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          received.message = buf.slice(0, end + 5);
          buf = buf.slice(end + 5);
          inData = false;
          socket.write(opts.dataResultReply || '250 2.0.0 queued as 12345\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        received.commands.push(line);
        const upper = line.toUpperCase();
        if (opts.destroyOn && upper.startsWith(opts.destroyOn)) {
          socket.destroy();
          return;
        }
        if (upper.startsWith('EHLO')) {
          socket.write('250-mock.example.com greets you\r\n250-SIZE 35882577\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (upper.startsWith('AUTH')) {
          socket.write(opts.authReply || '235 2.7.0 authentication successful\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write(opts.mailReply || '250 2.1.0 sender ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          socket.write(opts.rcptReply || '250 2.1.5 recipient ok\r\n');
        } else if (upper.startsWith('DATA')) {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (upper.startsWith('QUIT')) {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('500 unrecognized\r\n');
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        stop() {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

const CREDS = (port) => ({ host: '127.0.0.1', port, username: 'hello@drop.dev', password: 's3cret!' });
const MESSAGE = {
  from: 'DROP <hello@drop.dev>',
  to: 'user@example.com',
  subject: 'Test',
  html: '<p>hi</p>',
  text: 'hi',
};

test('smtpSend: happy path — full command sequence, AUTH PLAIN creds, terminated message', async () => {
  const mock = await startMockServer();
  try {
    const result = await smtpSend(CREDS(mock.port), MESSAGE, { _plainSocket: true });
    assert.deepEqual(result, { sent: true });

    const cmds = mock.received.commands;
    assert.ok(cmds[0].startsWith('EHLO '), `expected EHLO first, got: ${cmds[0]}`);
    assert.match(cmds[0], /^EHLO [a-zA-Z0-9.-]+$/); // sanitized hostname
    assert.ok(cmds[1].startsWith('AUTH PLAIN '), `expected AUTH PLAIN, got: ${cmds[1]}`);
    assert.equal(cmds[2], 'MAIL FROM:<hello@drop.dev>');
    assert.equal(cmds[3], 'RCPT TO:<user@example.com>');
    assert.equal(cmds[4], 'DATA');

    // AUTH PLAIN initial response decodes to \0user\0pass
    const token = cmds[1].slice('AUTH PLAIN '.length);
    assert.equal(Buffer.from(token, 'base64').toString('utf8'), '\0hello@drop.dev\0s3cret!');

    // full message received, dot-terminated
    assert.ok(mock.received.message.endsWith('\r\n.\r\n'));
    assert.ok(mock.received.message.includes('Subject: Test'));
    assert.ok(mock.received.message.includes('multipart/alternative'));
  } finally {
    await mock.stop();
  }
});

test('smtpSend: 535 at AUTH — phase auth, human message, and NO auth retry', async () => {
  const mock = await startMockServer({ authReply: '535 5.7.8 authentication credentials invalid\r\n' });
  try {
    const result = await smtpSend(CREDS(mock.port), MESSAGE, { _plainSocket: true });
    assert.equal(result.sent, false);
    assert.equal(result.phase, 'auth');
    assert.equal(result.error, 'authentication failed — check username (full email address) and password');
    // give any (buggy) retry a moment to arrive before counting
    await new Promise((r) => setTimeout(r, 50));
    const authCmds = mock.received.commands.filter((c) => c.toUpperCase().startsWith('AUTH'));
    assert.equal(authCmds.length, 1, `client retried auth: ${JSON.stringify(authCmds)}`);
    assert.ok(!mock.received.commands.some((c) => c.startsWith('MAIL FROM')), 'client proceeded past failed auth');
  } finally {
    await mock.stop();
  }
});

test('smtpSend: 553 at MAIL FROM — phase mail with the sender-rejected message', async () => {
  const mock = await startMockServer({ mailReply: '553 5.7.1 sender address rejected\r\n' });
  try {
    const result = await smtpSend(CREDS(mock.port), MESSAGE, { _plainSocket: true });
    assert.equal(result.sent, false);
    assert.equal(result.phase, 'mail');
    assert.equal(result.error, 'sender rejected — the From address must be the mailbox you sign in with (or its alias)');
  } finally {
    await mock.stop();
  }
});

test('smtpSend: server destroys socket mid-session — fast failure, no hang', async () => {
  const mock = await startMockServer({ destroyOn: 'MAIL FROM' });
  try {
    const started = Date.now();
    const result = await smtpSend(CREDS(mock.port), MESSAGE, { _plainSocket: true });
    const elapsed = Date.now() - started;
    assert.equal(result.sent, false);
    assert.equal(result.phase, 'mail');
    assert.ok(result.error.length > 0);
    assert.ok(elapsed < 5000, `took ${elapsed}ms — should fail fast, not wait for a timeout`);
  } finally {
    await mock.stop();
  }
});

test('smtpSend: never rejects — resolves {sent:false} on unreachable port', async () => {
  // Grab a port that is definitely closed: listen then immediately close.
  const probe = net.createServer();
  const port = await new Promise((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const result = await smtpSend(CREDS(port), MESSAGE, { _plainSocket: true });
  assert.equal(result.sent, false);
  assert.equal(result.phase, 'connect');
  assert.equal(result.error, 'could not connect to mail server');
});
