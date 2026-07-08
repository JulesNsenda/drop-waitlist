'use strict';

const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

// Zero-dependency SMTP client for implicit-TLS (port 465) submission, plus a
// pure MIME message builder. No pipelining, no STARTTLS, no quoted-printable.
// See docs/plans/2026-07-08-ui-settings-smtp.md for the full spec this
// implements.

const IDLE_TIMEOUT_MS = 15000;
const FINAL_TIMEOUT_MS = 60000;

// ── error messages (single source of truth) ────────────────────────────────

// Maps every failure — socket-level (`err` set) or SMTP-reply-level (`code`/
// `text` set) — to one human-readable string. Collapsing distinct system
// errors into the same message (e.g. ECONNREFUSED vs. connect timeout) is
// deliberate — it denies a leaked admin token a port-scan oracle — so the
// real underlying detail is always logged server-side here instead.
function humanMessage(phase, { err, code, text } = {}) {
  if (err) {
    console.error(`[smtp] ${phase} failed: ${err.code || err.message}`);
    if (phase === 'dns') return 'mail server host not found';
    if (phase === 'connect') return 'could not connect to mail server';
    if (phase === 'tls') return 'TLS/port mismatch — port 465 requires SSL/TLS';
    if (phase === 'greeting') {
      return err.__smtpTimeout
        ? 'TLS/port mismatch — port 465 requires SSL/TLS'
        : 'could not connect to mail server';
    }
    return 'connection to mail server was lost — try again later';
  }
  const cleanText = String(text || '').replace(/[\r\n]/g, ' ').slice(0, 180);
  if (code === 421 || (code >= 450 && code <= 459)) {
    return 'mail server busy or rate-limiting — try again later';
  }
  if (phase === 'auth' && code === 535) {
    return 'authentication failed — check username (full email address) and password';
  }
  if (phase === 'mail' && (code === 550 || code === 553)) {
    return 'sender rejected — the From address must be the mailbox you sign in with (or its alias)';
  }
  if (phase === 'rcpt' && code >= 550 && code <= 559) {
    return `recipient rejected: ${cleanText}`;
  }
  if (phase === 'dataResult' && code >= 550 && code <= 559) {
    return `message rejected: ${cleanText}`;
  }
  return `mail server rejected the request (${phase} ${code}): ${cleanText}`;
}

// Classifies a connect/TLS-phase system error into one of dns|connect|tls.
// TLS handshake/cert errors carry no recognizable network error code, so
// "anything left over" is the catch-all — only reachable when not in the
// plain-socket test mode.
function classifyConnectError(err, usePlain) {
  const sysCode = err && err.code;
  if (sysCode === 'ENOTFOUND' || sysCode === 'EAI_AGAIN') return 'dns';
  if (sysCode === 'ECONNREFUSED' || sysCode === 'ETIMEDOUT' || (err && err.__smtpTimeout)) return 'connect';
  return usePlain ? 'connect' : 'tls';
}

// ── reply reader ─────────────────────────────────────────────────────────────

// Buffers incoming bytes and resolves one promise per complete SMTP reply.
// A reply is complete when a line matching /^\d{3} /  (space, not dash)
// arrives; `250-` lines are continuations. Handles replies split across or
// coalesced within TCP chunks, and a reply arriving before readReply() is
// called (queued). Rejects the pending (or next) wait on socket error/close
// so a dropped connection fails fast instead of hanging.
function makeReplyReader(socket) {
  let buf = '';
  let collected = [];
  const queue = [];
  let waiter = null;
  let failure = null;

  function deliver(reply) {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve(reply);
    } else {
      queue.push(reply);
    }
  }

  function fail(err) {
    failure = failure || err;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(failure);
    }
  }

  socket.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    let m;
    while ((m = buf.match(/\r\n|\n/))) {
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const lm = line.match(/^(\d{3})([ -])(.*)$/);
      collected.push(line);
      if (lm && lm[2] === ' ') {
        const code = parseInt(lm[1], 10);
        const text = collected.map((l) => l.replace(/^\d{3}[ -]?/, '')).join(' ').trim();
        const reply = { code, text, lines: collected };
        collected = [];
        deliver(reply);
      }
    }
  });
  socket.on('error', (err) => fail(err));
  socket.on('close', () => fail(new Error('connection closed')));

  function readReply() {
    if (queue.length) return Promise.resolve(queue.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject };
    });
  }

  return { readReply };
}

// ── connection ───────────────────────────────────────────────────────────────

// Opens the transport: TLS (implicit, port 465) by default, or a plain TCP
// socket when `usePlain` is set (internal test hook only — never reachable
// from settings validation). Certificate verification is never disabled.
function connectSocket(host, port, usePlain) {
  return new Promise((resolve, reject) => {
    const socket = usePlain
      ? net.connect({ host, port })
      : tls.connect({ host, port, servername: host });
    let settled = false;
    const readyEvent = usePlain ? 'connect' : 'secureConnect';

    function onReady() {
      if (settled) return;
      settled = true;
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      resolve(socket);
    }
    function onError(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }
    function onTimeout() {
      if (settled) return;
      settled = true;
      const err = new Error('connect timeout');
      err.__smtpTimeout = true;
      socket.destroy();
      reject(err);
    }

    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.once(readyEvent, onReady);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

// Sends QUIT and tears the socket down without letting anything about that
// process affect the already-decided result. Used on every exit path where a
// live socket exists (success or a protocol-level failure).
function closeQuietly(socket) {
  try {
    socket.setTimeout(0);
    socket.removeAllListeners('timeout');
    socket.removeAllListeners('error');
    socket.on('error', () => {});
    socket.end('QUIT\r\n');
  } catch (e) {
    // swallow — fire-and-forget
  }
}

function send(socket, line) {
  socket.write(line + '\r\n');
}

// ── protocol helpers ─────────────────────────────────────────────────────────

function sanitizeHostname(name) {
  const cleaned = String(name || '').replace(/[^a-zA-Z0-9.-]/g, '');
  return cleaned || 'localhost';
}

// Extracts advertised AUTH mechanisms (e.g. ['PLAIN','LOGIN']) from an EHLO
// reply's raw lines (each still carrying its "250-"/"250 " prefix).
function parseAuthMechanisms(lines) {
  for (const line of lines) {
    const m = line.match(/^\d{3}[ -]AUTH[ =](.+)$/i);
    if (m) return m[1].trim().toUpperCase().split(/\s+/).filter(Boolean);
  }
  return [];
}

// ── message builder — pure, no sockets ──────────────────────────────────────

function stripCrlf(value) {
  return String(value == null ? '' : value).replace(/[\r\n]/g, '');
}

// Parses `from` strictly as "Name <addr>" or a bare address — no RFC 5322
// parser. The parsed addr drives both MAIL FROM and the From: header.
function parseFromField(from) {
  const s = stripCrlf(from).trim();
  const m = s.match(/^(.*)<([^<>@\s]+@[^<>@\s]+)>\s*$/);
  if (m) {
    let name = m[1].trim();
    name = name.replace(/^"(.*)"$/, '$1').trim();
    return { name: name || null, addr: m[2].trim() };
  }
  return { name: null, addr: s };
}

// Splits a string into chunks whose UTF-8 byte length is <= 45, never
// splitting a multibyte character (iterates by codepoint via Array.from,
// which correctly handles surrogate pairs / astral characters).
function chunkForRfc2047(s) {
  const chars = Array.from(s);
  const chunks = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of chars) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (curBytes + b > 45 && cur) {
      chunks.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// RFC 2047 encoded-words, folded with "\r\n " between words. 45-byte UTF-8
// chunks base64-encode to <=60 chars, so each word (incl. the =?UTF-8?B??=
// wrapper) is <=72 chars — safely under the 75-char limit.
function encodeRfc2047(s) {
  return chunkForRfc2047(s)
    .map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

// Pure-ASCII header values pass through unchanged; anything else becomes
// RFC 2047 encoded-words.
function encodeHeaderValue(value) {
  const s = String(value == null ? '' : value);
  if (!/[^\x20-\x7e]/.test(s)) return s;
  return encodeRfc2047(s);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Hand-formats an RFC 5322 date with a literal "+0000" — NOT toUTCString(),
// which emits "GMT" instead of a numeric offset.
function formatRfc5322Date(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const day = DAY_NAMES[d.getUTCDay()];
  const month = MONTH_NAMES[d.getUTCMonth()];
  return `${day}, ${d.getUTCDate()} ${month} ${d.getUTCFullYear()} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

// Base64-encodes and wraps at 76 columns. Both MIME parts use this — no
// quoted-printable anywhere, which also moots line-length and bare-LF traps.
function base64Wrap(str) {
  const b64 = Buffer.from(String(str == null ? '' : str), 'utf8').toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

// Dot-stuffs a raw message for the wire: any line starting with "." gets an
// extra "." prepended (SMTP DATA transparency). Applied once over the whole
// message at write time — buildMimeMessage's output is NOT pre-stuffed.
function dotStuff(message) {
  return message.replace(/(\r\n|^)\./g, '$1..');
}

// Builds a complete, CRLF-terminated MIME message: multipart/alternative
// with base64 text/plain + text/html parts. Pure — no I/O. `date`/
// `messageId` are optional overrides so tests are deterministic.
function buildMimeMessage({ from, to, subject, html, text, date, messageId }) {
  const cleanFrom = stripCrlf(from);
  const cleanTo = stripCrlf(to);
  const cleanSubject = stripCrlf(subject);
  const parsed = parseFromField(cleanFrom);
  const domain = (parsed.addr.split('@')[1] || 'localhost').toLowerCase();
  const dateStr = date || formatRfc5322Date(new Date());
  const msgId = messageId || `<${Date.now()}.${crypto.randomBytes(8).toString('hex')}@${domain}>`;
  const boundary = '----=_drop_' + crypto.randomBytes(16).toString('hex');
  const fromHeader = parsed.name ? `${encodeHeaderValue(parsed.name)} <${parsed.addr}>` : parsed.addr;

  const headers = [
    `From: ${fromHeader}`,
    `To: ${cleanTo}`,
    `Subject: ${encodeHeaderValue(cleanSubject)}`,
    `Date: ${dateStr}`,
    `Message-ID: ${msgId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');

  const textPart = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Wrap(text),
  ].join('\r\n');

  const htmlPart = [
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Wrap(html),
  ].join('\r\n');

  return `${headers}\r\n\r\n${textPart}\r\n${htmlPart}\r\n--${boundary}--\r\n`;
}

// ── protocol driver ──────────────────────────────────────────────────────────

// Runs one full send over a fresh connection: connect -> greeting -> EHLO ->
// AUTH -> MAIL FROM -> RCPT TO -> DATA -> dataResult. Lockstep, no
// pipelining — one pending command at a time.
async function runSession(creds, msg, opts) {
  const { host, port, username, password } = creds;
  const usePlain = !!(opts && opts._plainSocket);

  let socket;
  try {
    socket = await connectSocket(host, port, usePlain);
  } catch (err) {
    const errPhase = classifyConnectError(err, usePlain);
    return { sent: false, error: humanMessage(errPhase, { err }), phase: errPhase };
  }

  // Persistent idle-timeout handler for the rest of the session (connectSocket
  // only covered the connect phase). destroy(err) emits 'error', which the
  // reply reader turns into a fast rejection of the pending wait.
  socket.on('timeout', () => {
    const err = new Error('idle timeout waiting for mail server');
    err.__smtpTimeout = true;
    socket.destroy(err);
  });

  const reader = makeReplyReader(socket);
  let phase = 'greeting';

  function fail(atPhase, reply) {
    closeQuietly(socket);
    return { sent: false, error: humanMessage(atPhase, { code: reply.code, text: reply.text }), phase: atPhase };
  }

  try {
    let reply = await reader.readReply();
    if (reply.code !== 220) return fail('greeting', reply);

    phase = 'ehlo';
    send(socket, `EHLO ${sanitizeHostname(os.hostname())}`);
    reply = await reader.readReply();
    if (reply.code !== 250) return fail('ehlo', reply);
    const mechanisms = parseAuthMechanisms(reply.lines);

    phase = 'auth';
    if (mechanisms.includes('PLAIN')) {
      const token = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
      send(socket, `AUTH PLAIN ${token}`);
      reply = await reader.readReply();
      if (reply.code !== 235) return fail('auth', reply);
    } else {
      send(socket, 'AUTH LOGIN');
      reply = await reader.readReply();
      if (reply.code !== 334) return fail('auth', reply);
      send(socket, Buffer.from(String(username), 'utf8').toString('base64'));
      reply = await reader.readReply();
      if (reply.code !== 334) return fail('auth', reply);
      send(socket, Buffer.from(String(password), 'utf8').toString('base64'));
      reply = await reader.readReply();
      if (reply.code !== 235) return fail('auth', reply);
    }

    phase = 'mail';
    const fromParsed = parseFromField(msg.from);
    send(socket, `MAIL FROM:<${fromParsed.addr}>`);
    reply = await reader.readReply();
    if (reply.code !== 250) return fail('mail', reply);

    phase = 'rcpt';
    const toAddr = stripCrlf(msg.to);
    send(socket, `RCPT TO:<${toAddr}>`);
    reply = await reader.readReply();
    if (reply.code !== 250 && reply.code !== 251) return fail('rcpt', reply);

    phase = 'data';
    send(socket, 'DATA');
    reply = await reader.readReply();
    if (reply.code !== 354) return fail('data', reply);

    phase = 'dataResult';
    const stuffed = dotStuff(buildMimeMessage(msg));
    socket.setTimeout(FINAL_TIMEOUT_MS);
    socket.write(stuffed);
    socket.write('.\r\n');
    reply = await reader.readReply();
    if (reply.code !== 250) return fail('dataResult', reply);

    closeQuietly(socket);
    return { sent: true };
  } catch (err) {
    try {
      socket.destroy();
    } catch (e) {
      // already gone
    }
    return { sent: false, error: humanMessage(phase, { err }), phase };
  }
}

// ── serialized send queue ────────────────────────────────────────────────────

// One SMTP connection at a time. Never throws/rejects — every failure inside
// runSession already resolves {sent:false,...}; this is a last-resort guard.
let _tail = Promise.resolve();

function smtpSend(creds, message, opts) {
  const attempt = () => runSession(creds, message, opts || {}).catch((err) => ({
    sent: false,
    error: err && err.message ? err.message : 'unexpected SMTP client error',
    phase: 'unknown',
  }));
  const result = _tail.then(attempt, attempt);
  _tail = result.then(() => {}, () => {});
  return result;
}

module.exports = {
  smtpSend,
  buildMimeMessage,
  parseFromField,
  encodeHeaderValue,
  base64Wrap,
  dotStuff,
  formatRfc5322Date,
};
