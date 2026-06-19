'use strict';

const fsp = require('fs/promises');
const path = require('path');

const UI_DIR = path.join(__dirname, 'ui');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js':  'application/javascript; charset=utf-8',
};

async function serveStatic(res, pathname) {
  // Strip the /ui/ prefix to get the bare filename.
  const filename = pathname.replace(/^\/ui\//, '');

  // Block any path traversal — only flat files under UI_DIR are allowed.
  if (!filename || filename.includes('/') || filename.includes('..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  const ext = path.extname(filename);
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  try {
    const content = await fsp.readFile(path.join(UI_DIR, filename), 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

module.exports = { serveStatic };
