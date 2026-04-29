/**
 * dev-server.js — test harness server
 *
 * Starts two servers:
 *   - Static HTTP server on port 3000 — serves index.html for Playwright.
 *   - WebSocket relay on port 8080 — server.js required here so both share
 *     the same process and die together when Playwright kills it.
 *
 * NOTE ON CSP: index.html contains a meta-tag CSP with connect-src limited to
 * wss://app.keylay.org. This header attempts to add ws://localhost:8080, but
 * because both the HTTP header and the meta-tag CSP are enforced simultaneously
 * (the browser applies both policies), the meta tag's stricter connect-src wins
 * and the localhost WS connection is blocked. The app then falls back to the
 * cloud relay at wss://app.keylay.org, which is what the tests actually use.
 *
 * To force tests to use the local relay instead, the meta-tag CSP in index.html
 * would need to be updated to include ws://localhost:8080. The local relay is
 * still started here so it is available if that change is made.
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
