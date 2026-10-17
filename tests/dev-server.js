/**
 * dev-server.js — test harness server
 *
 * Starts two servers:
 *   - Static HTTP server on port 3000 — serves index.html for Playwright.
 *   - WebSocket relay on port 8080 — server.js required here so both share
 *     the same process and die together when Playwright kills it.
 *
 * The page is served from localhost, so the app connects to the local relay at
 * ws://localhost:8080 (allowed by connect-src in index.html's meta-tag CSP).
 * Tests assert the "Local Server" indicator so they never fall back to the
 * hosted relay at wss://app.keylay.org unnoticed.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const STATIC_PORT = 3000;
const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const staticServer = http.createServer(function(req, res) {
  const urlPath = req.url.split('?')[0];
  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, function(err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

staticServer.listen(STATIC_PORT, '127.0.0.1', function() {
  console.log('[dev-server] Static: http://localhost:' + STATIC_PORT);
});

// Requiring server.js starts the WebSocket relay on port 8080 immediately.
require('../server.js');
console.log('[dev-server] WebSocket relay: ws://localhost:8080');
