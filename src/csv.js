'use strict';

// UTF-8 BOM so Excel renders non-ASCII names correctly on open.
const BOM = '﻿';

// Escapes a single CSV cell value.
// Order matters: formula-injection guard FIRST (inside the quotes), then RFC-4180.
function csvCell(value) {
  let s = value == null ? '' : String(value);
  // Guard against spreadsheet formula injection. The guard ' is written inside
  // the RFC-4180 quotes below, not outside, so CSV consumers see it as data.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  // RFC-4180: quote if the value contains a comma, double-quote, CR, or LF.
  if (/[,"\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function entriesToCsv(entries) {
  const header = 'email,name,status,createdAt,invitedAt,username';
  const rows = entries.map((e) => [
    csvCell(e.email),
    csvCell(e.name || ''),
    csvCell(e.status),
    csvCell(e.createdAt),
    csvCell(e.invitedAt || ''),
    csvCell(e.username || ''),
  ].join(','));
  return BOM + [header, ...rows].join('\r\n');
}

module.exports = { csvCell, entriesToCsv };
