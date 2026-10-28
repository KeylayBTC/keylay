// server.js
//
// Keylay WebSocket relay. The relay sees only ciphertext and a derived
// channel hash — never the raw session code or plaintext.
//
// Rate, size, connection, and lifetime limits are enforced here. Numbers are
// tunable via the named constants below. If you adjust them, update
// outputs/security_review_summary.md so the thresholds stay documented.
//
// 2026-10 relay hotfix (external report, findings #1-#3):
//   #1  every client socket has an 'error' listener, so a malformed frame
//       (oversized, bad UTF-8, reserved bits) closes that one socket instead
//       of throwing and taking the whole process down.
//   #2  each socket remembers the one session it joined; on close, only that
//       session is updated and only its members get 'peer_left'.
//   #3  channel codes must be exactly 32 lowercase hex characters; a socket
//       may belong to one session only; a socket that has not joined within
//       JOIN_DEADLINE_MS is closed; IPv6 clients are counted per /64 for the
//       per-IP cap.
const WebSocket = require('ws');

// ============================================================
// Limits — tune here, not inline
// ============================================================

// Maximum WebSocket frame size. Covers a BBQR-encoded signed PSBT plus
// base64 and handshake overhead with comfortable headroom. Frames larger
// than this are rejected at the protocol layer and close the connection.
const MAX_PAYLOAD_BYTES = 256 * 1024;

// Per-connection message rate (token bucket). A complete session is ~2 hello
// + a handful of data messages + pings, so these are generous by 10x.
const RATE_BUCKET_CAPACITY = 5;          // burst
const RATE_REFILL_PER_SEC = 1;           // sustained

// Concurrency caps.
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_GLOBAL_CONNECTIONS = 100;
const MAX_RECEIVERS_PER_SESSION = 1;     // exactly two peers per session: 1 sender + 1 receiver

// Session lifetime.
const SESSION_IDLE_MS = 15 * 60 * 1000;  // no data for 15 min → close
const SESSION_MAX_MS = 60 * 60 * 1000;   // hard cap from first join → close

// A socket must send a valid 'join' (or 'claim') this soon after connecting,
// or it is closed. The client joins immediately on open, so 30 s is generous.
const JOIN_DEADLINE_MS = 30 * 1000;

// Channel codes are the client's derived channel hash: SHA-256 output
// truncated to 32 lowercase hex characters. Anything else is rejected.
const CHANNEL_CODE_RE = /^[0-9a-f]{32}$/;

// Liveness ping/pong. Independent of idle — ping is "is the socket alive",
// idle is "has real data flowed". A missed pong is enforced by the next
// sweep, so the actual deadline is roughly PING_INTERVAL_MS after the missed
// pong (the constant below is documentation, not a separate timer).
const PING_INTERVAL_MS = 30 * 1000;
const PONG_TIMEOUT_MS = 60 * 1000;       // intentionally unenforced — see comment above

// ============================================================
// State
// ============================================================

const PORT = parseInt(process.env.PORT, 10) || 8080;
const wss = new WebSocket.Server({ port: PORT, maxPayload: MAX_PAYLOAD_BYTES });

// Fail loudly and clearly instead of dumping a raw stack trace and
// crash-looping under pm2/systemd auto-restart. EADDRINUSE almost always
// means a previous instance is still bound to the port — stop it before
// restarting (`pm2 list`, `lsof -i :<port>`), or set PORT to run elsewhere.
wss.on('error', (err) => {
  const ts = new Date().toISOString();
  if (err && err.code === 'EADDRINUSE') {
    console.error(`${ts} FATAL: port ${PORT} already in use — another instance is probably still running. ` +
      `Stop it (pm2 list / lsof -i :${PORT}) or set PORT before restarting.`);
  } else {
    console.error(`${ts} FATAL: WebSocket server error: ${(err && err.stack) || err}`);
  }
  process.exit(1);
});

// Dated confirmation that the bind actually succeeded, so a healthy start is
// distinguishable from a crash-loop in the log.
wss.on('listening', () => {
  console.log(new Date().toISOString() + ` listening on port ${PORT}`);
});

// code -> { sender, receivers, createdAt, idleTimer, maxTimer }
const sessions = new Map();
// ip -> active connection count
const ipConnections = new Map();
let globalConnections = 0;

// Client IP resolution. The raw socket address is not spoofable, so it is the
// safe default. But behind a reverse proxy the socket address is the proxy's
// (e.g. ::1), which makes the per-IP cap collapse to a global one and yields
// no geographic data. Set TRUST_PROXY=1 to instead read the client IP from a
// header the proxy sets (default X-Real-IP). ONLY enable this when a proxy you
// control overwrites that header on every request — otherwise a client can
// supply its own value and spoof its IP to bypass the per-IP connection cap.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PROXY_IP_HEADER = (process.env.TRUST_PROXY_HEADER || 'x-real-ip').toLowerCase();

function remoteIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers[PROXY_IP_HEADER];
    if (fwd) {
      const ip = String(fwd).split(',')[0].trim();
      if (ip) return ip;
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

// Key used for the per-IP connection cap. IPv4 (including IPv4-mapped IPv6)
// counts per address; IPv6 counts per /64, because a single host or ISP
// customer typically controls a whole /64 and could otherwise rotate through
// addresses to evade the cap.
function ipKey(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  let a = String(ip).trim().toLowerCase();
  if (a.startsWith('::ffff:') && a.slice(7).includes('.')) return a.slice(7);
  if (!a.includes(':')) return a;                 // IPv4
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);            // drop zone id (fe80::1%eth0)
  // Expand '::' so the first four hextets can be read reliably.
  let head = a, tail = '';
  const dbl = a.indexOf('::');
  if (dbl >= 0) { head = a.slice(0, dbl); tail = a.slice(dbl + 2); }
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  if (t.length && t[t.length - 1].includes('.')) t.splice(t.length - 1, 1, '0', '0'); // embedded IPv4
  const missing = Math.max(0, 8 - h.length - t.length);
  const full = dbl >= 0 ? [...h, ...Array(missing).fill('0'), ...t] : h;
  if (full.length < 4) return a.toLowerCase();
  return full.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}

function isValidCode(code) {
  return typeof code === 'string' && CHANNEL_CODE_RE.test(code);
}

// Truncate an IP to its /16 (IPv4) or /32 (IPv6) prefix. Used for log lines
// only — the per-IP cap keys (full IPv4 address, IPv6 /64) stay in the in-memory
// ipConnections map
// and never leave the process. Truncation is what makes the public privacy
// claim ("no full IPs logged") true. See outputs/rotate-logs.js for the
// cron-side aggregation that consumes these prefixes.
function truncateIp(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  // Strip IPv4-mapped IPv6 prefix: "::ffff:192.168.1.1" -> "192.168.1.1"
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // Retain the network-identifying portion and zero the rest, keeping a
  // recognizable IP form: /16 for IPv4 (192.168.0.0), /32 for IPv6 (2001:db8::).
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.0.0`;
  const v6 = ip.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
  if (v6) return `${v6[1]}:${v6[2]}::`;
  return 'unknown';
}

// Structured timestamped log helper. Format: ISO8601 + space + message.
// Keep messages parseable: "from <prefix>" tokens are extracted by
// rotate-logs.js for geographic aggregation.
function log(msg) {
  console.log(new Date().toISOString() + ' ' + msg);
}

function closeSession(code, reason) {
  const session = sessions.get(code);
  if (!session) return;
  const notify = (peer) => {
    if (peer && peer.readyState === WebSocket.OPEN) {
      try { peer.send(JSON.stringify({ type: 'status', message: reason })); } catch {}
      try { peer.close(1000, reason); } catch {}
    }
  };
  notify(session.sender);
  session.receivers.forEach(notify);
  if (session.sender) session.sender._sessionCode = null;
  session.receivers.forEach((r) => { r._sessionCode = null; });
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.maxTimer) clearTimeout(session.maxTimer);
  sessions.delete(code);
}

function bumpIdle(code) {
  const session = sessions.get(code);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(
    () => closeSession(code, 'Session idle timeout'),
    SESSION_IDLE_MS
  );
}

function armSessionTimers(code) {
  const session = sessions.get(code);
  if (!session) return;
  session.createdAt = Date.now();
  session.maxTimer = setTimeout(
    () => closeSession(code, 'Session max lifetime reached'),
    SESSION_MAX_MS
  );
  bumpIdle(code);
}

// ============================================================
// Connection handler
// ============================================================

wss.on('connection', function connection(ws, req) {
  const ip = remoteIp(req);
  const ipk = ipKey(ip);

  const prefix = truncateIp(ip);

  // [#1] Register the error listener FIRST, before any early return. With no
  // 'error' listener, an 'error' event on this socket (oversized frame,
  // invalid UTF-8, reserved bits set) would throw and crash the process.
  // ws closes the socket itself after emitting 'error'; 'close' cleans up.
  ws.on('error', (err) => {
    log(`socket error from ${prefix}: ${(err && (err.code || err.message)) || 'unknown'}`);
  });

  // Connection admission control
  if (globalConnections >= MAX_GLOBAL_CONNECTIONS) {
    try { ws.send(JSON.stringify({ type: 'status', message: 'Server busy — try again shortly' })); } catch {}
    log(`refused capacity from ${prefix}`);
    ws.close(1013, 'Server at capacity');
    return;
  }
  const ipCount = ipConnections.get(ipk) || 0;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) {
    try { ws.send(JSON.stringify({ type: 'status', message: 'Too many connections from your address' })); } catch {}
    log(`refused per-ip from ${prefix}`);
    ws.close(1013, 'Per-IP limit');
    return;
  }
  globalConnections++;
  ipConnections.set(ipk, ipCount + 1);

  // [#2/#3] The one session this socket belongs to (set on join/claim).
  ws._sessionCode = null;

  // [#3] Join deadline: a socket that never joins is closed, so it cannot
  // hold a connection slot indefinitely by answering pings.
  ws._joinTimer = setTimeout(() => {
    if (!ws._sessionCode) {
      log(`join timeout from ${prefix}`);
      try { ws.close(1008, 'Join timeout'); } catch {}
    }
  }, JOIN_DEADLINE_MS);

  // Per-connection rate bucket
  ws._rateTokens = RATE_BUCKET_CAPACITY;
  ws._rateLastRefill = Date.now();

  // Liveness tracking
  ws._isAlive = true;
  ws.on('pong', () => { ws._isAlive = true; });

  log(`new connection from ${prefix}`);

  ws.on('message', function incoming(data) {
    // Token bucket check
    const now = Date.now();
    const refill = ((now - ws._rateLastRefill) / 1000) * RATE_REFILL_PER_SEC;
    if (refill > 0) {
      ws._rateTokens = Math.min(RATE_BUCKET_CAPACITY, ws._rateTokens + refill);
      ws._rateLastRefill = now;
    }
    if (ws._rateTokens < 1) {
      try { ws.send(JSON.stringify({ type: 'status', message: 'Rate limit exceeded' })); } catch {}
      ws.close(1008, 'Rate limit');
      return;
    }
    ws._rateTokens -= 1;

    try {
      const message = JSON.parse(data);

      if (message.type === 'join') {
        handleJoin(ws, message.code);
      } else if (message.type === 'claim') {
        handleClaimSender(ws, message.code);
      } else if (message.type === 'data') {
        handleDataTransmission(ws, message.code, message.payload, message.format, message.encrypted, message.counter);
      } else if (message.type === 'hello') {
        handleHello(ws, message.code, message.pubkey, message.sig);
      }
      // 'ping' is handled implicitly — any message refreshes the rate bucket,
      // and ws.ping/ws.pong is used for liveness separately.
    } catch (e) {
      log('invalid msg');
    }
  });

  ws.on('close', function() {
    log(`disconnected from ${prefix}`);
    if (ws._joinTimer) { clearTimeout(ws._joinTimer); ws._joinTimer = null; }
    globalConnections = Math.max(0, globalConnections - 1);
    const n = (ipConnections.get(ipk) || 1) - 1;
    if (n <= 0) ipConnections.delete(ipk); else ipConnections.set(ipk, n);

    // [#2] Update only the session this socket actually belonged to. The old
    // code walked every session and sent 'peer_left' to all of them, so one
    // anonymous connect-and-disconnect reset every pair on the relay.
    const code = ws._sessionCode;
    ws._sessionCode = null;
    if (!code) return;
    const session = sessions.get(code);
    if (!session) return;
    const wasMember = session.sender === ws || session.receivers.has(ws);
    if (!wasMember) return;
    {   // (kept as a block so the diff against v0.9.0 stays readable)
      if (session.sender === ws) {
        session.sender = null;
        // Promote a receiver to sender if available
        if (session.receivers.size > 0) {
          const newSender = session.receivers.values().next().value;
          session.receivers.delete(newSender);
          session.sender = newSender;
          // Guard the notify — newSender may already be closing, in which
          // case its own close handler will clean up shortly.
          try { newSender.send(JSON.stringify({ type: 'role', role: 'sender' })); } catch {}
        }
      } else {
        session.receivers.delete(ws);
      }

      // Notify surviving peers that their partner left so they can re-handshake
      const survivingPeers = [session.sender, ...session.receivers].filter(p => p && p !== ws);
      survivingPeers.forEach(p => {
        if (p.readyState === WebSocket.OPEN) {
          try { p.send(JSON.stringify({ type: 'peer_left' })); } catch {}
        }
      });

      // Clean up empty sessions
      if (!session.sender && session.receivers.size === 0) {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        if (session.maxTimer) clearTimeout(session.maxTimer);
        sessions.delete(code);
      }
    }
  });
});

// ============================================================
// Liveness sweep — terminate sockets that don't pong
// ============================================================

const livenessInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws._isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws._isAlive = false;
    try { ws.ping(); } catch {}
  });
}, PING_INTERVAL_MS);

wss.on('close', () => clearInterval(livenessInterval));

// Note: PONG_TIMEOUT_MS is documented but effectively enforced by the next
// sweep (max ~PING_INTERVAL_MS after a missed pong). If you need a tighter
// bound, schedule a per-socket setTimeout on ping and clear it on pong.

// ============================================================
// Message handlers
// ============================================================

// [#3] Shared admission check for join/claim. Returns true if the socket may
// act on `code`; otherwise reports and (for bad input) closes the socket.
function admitCode(ws, code, what) {
  if (!isValidCode(code)) {
    try { ws.send(JSON.stringify({ type: 'status', message: 'Invalid session code' })); } catch {}
    log(`refused ${what}: invalid code`);
    try { ws.close(1008, 'Invalid code'); } catch {}
    return false;
  }
  if (ws._sessionCode && ws._sessionCode !== code) {
    try { ws.send(JSON.stringify({ type: 'status', message: 'Already in a session on this connection' })); } catch {}
    log(`refused ${what}: second session on one socket`);
    try { ws.close(1008, 'One session per connection'); } catch {}
    return false;
  }
  return true;
}

function bindSocketToSession(ws, code) {
  ws._sessionCode = code;
  if (ws._joinTimer) { clearTimeout(ws._joinTimer); ws._joinTimer = null; }
}

function handleJoin(ws, code) {
  if (!admitCode(ws, code, 'join')) return;
  if (!sessions.has(code)) {
    sessions.set(code, { sender: ws, receivers: new Set(), idleTimer: null, maxTimer: null, createdAt: 0 });
    bindSocketToSession(ws, code);
    armSessionTimers(code);
    ws.send(JSON.stringify({ type: 'role', role: 'sender' }));
    log('role assigned: sender');
  } else {
    const session = sessions.get(code);
    if (session.sender === ws || session.receivers.has(ws)) {
      log('join noop: already a member');   // repeated join on the same socket
      return;
    }
    if (session.sender && session.receivers.size >= MAX_RECEIVERS_PER_SESSION) {
      try { ws.send(JSON.stringify({ type: 'status', message: 'Session is full — only two peers allowed' })); } catch {}
      ws.close();
      log('refused full session');
      return;
    }
    // Defensive: a session should never exist without a sender.
    if (!session.sender) {
      session.sender = ws;
      bindSocketToSession(ws, code);
      ws.send(JSON.stringify({ type: 'role', role: 'sender' }));
      log('role assigned: sender (vacant)');
      return;
    }
    session.receivers.add(ws);
    bindSocketToSession(ws, code);
    ws.send(JSON.stringify({ type: 'role', role: 'receiver' }));
    log('role assigned: receiver');
  }
}

function handleClaimSender(ws, code) {
  if (!admitCode(ws, code, 'claim')) return;
  if (!sessions.has(code)) {
    sessions.set(code, { sender: ws, receivers: new Set(), idleTimer: null, maxTimer: null, createdAt: 0 });
    bindSocketToSession(ws, code);
    armSessionTimers(code);
    ws.send(JSON.stringify({ type: 'role', role: 'sender' }));
    log('role claimed: sender (new session)');
  } else {
    const session = sessions.get(code);
    // Membership gate: only an existing sender or receiver can claim. Without
    // this check a third client could WebSocket-connect, skip 'join', and
    // send 'claim' to take over an active session — bypassing the per-session
    // peer cap that handleJoin enforces. They can't decrypt traffic (the HMAC
    // handshake protects that), but they can disrupt and observe metadata.
    const isMember = session.sender === ws || session.receivers.has(ws);
    if (!isMember) {
      try { ws.send(JSON.stringify({ type: 'status', message: 'Not a session member — join first' })); } catch {}
      log('refused claim from non-member');
      return;
    }
    if (session.sender === ws) {
      ws.send(JSON.stringify({ type: 'status', message: 'You are already the sender' }));
      log('claim noop: already sender');
    } else {
      if (session.sender) {
        session.receivers.add(session.sender);
        try { session.sender.send(JSON.stringify({ type: 'role', role: 'receiver' })); } catch {}
        log('role swap: sender demoted');
      }
      session.receivers.delete(ws);
      session.sender = ws;
      ws.send(JSON.stringify({ type: 'role', role: 'sender' }));
      log('role swap: sender claimed');
    }
  }
}

function handleDataTransmission(ws, code, payload, format, encrypted, counter) {
  if (!isValidCode(code) || ws._sessionCode !== code) return;
  const session = sessions.get(code);
  if (!session) return;
  if (session.sender !== ws && !session.receivers.has(ws)) return; // drop messages from non-members

  const message = { type: 'data', code, payload };
  if (format) message.format = format;
  if (encrypted) message.encrypted = encrypted;
  if (counter !== undefined) message.counter = counter;

  const peers = [session.sender, ...session.receivers];
  let forwarded = 0;
  peers.forEach(peer => {
    if (peer && peer !== ws && peer.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify(message));
      forwarded++;
    }
  });

  bumpIdle(code);

  log('routed to ' + forwarded + ' peer(s)');
}

function handleHello(ws, code, pubkey, sig) {
  if (!isValidCode(code) || ws._sessionCode !== code) return;
  const session = sessions.get(code);
  if (!session) return;
  if (session.sender !== ws && !session.receivers.has(ws)) return; // drop hellos from non-members
  const message = { type: 'hello', code, pubkey, sig };
  const peers = [session.sender, ...session.receivers];
  let forwarded = 0;
  peers.forEach(peer => {
    if (peer && peer !== ws && peer.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify(message));
      forwarded++;
    }
  });
  bumpIdle(code);
  log('forwarded hello to ' + forwarded + ' peer(s)');
}

console.log(`Limits: payload ${MAX_PAYLOAD_BYTES/1024}KB, rate ${RATE_REFILL_PER_SEC}/s (burst ${RATE_BUCKET_CAPACITY}), per-IP ${MAX_CONNECTIONS_PER_IP} (IPv6 per /64), global ${MAX_GLOBAL_CONNECTIONS}, idle ${SESSION_IDLE_MS/60000}m, max ${SESSION_MAX_MS/60000}m, join deadline ${JOIN_DEADLINE_MS/1000}s`);
