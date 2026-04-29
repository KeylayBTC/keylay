// server.js
//
// Keylay WebSocket relay. The relay sees only ciphertext and a derived
// channel hash — never the raw session code or plaintext.
//
// Rate, size, connection, and lifetime limits are enforced here. Numbers are
// tunable via the named constants below. If you adjust them, update
// outputs/security_review_summary.md so the thresholds stay documented.
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

// Liveness ping/pong. Independent of idle — ping is "is the socket alive",
// idle is "has real data flowed". A missed pong is enforced by the next
// sweep, so the actual deadline is roughly PING_INTERVAL_MS after the missed
// pong (the constant below is documentation, not a separate timer).
const PING_INTERVAL_MS = 30 * 1000;
const PONG_TIMEOUT_MS = 60 * 1000;       // intentionally unenforced — see comment above

// ============================================================
// State
// ============================================================

const wss = new WebSocket.Server({ port: 8080, maxPayload: MAX_PAYLOAD_BYTES });

// code -> { sender, receivers, createdAt, idleTimer, maxTimer }
const sessions = new Map();
// ip -> active connection count
const ipConnections = new Map();
let globalConnections = 0;

function remoteIp(req) {
  // Deliberately NOT honoring X-Forwarded-For — doing so without a trusted
  // proxy in front allows clients to spoof their IP. If you deploy behind a
  // proxy you trust, add the parsing here and gate it on a config flag.
  return req.socket.remoteAddress || 'unknown';
}

// Truncate an IP to its /16 (IPv4) or /32 (IPv6) prefix. Used for log lines
// only — full IPs stay in the in-memory ipConnections map for the per-IP cap
// and never leave the process. Truncation is what makes the public privacy
// claim ("no full IPs logged") true. See outputs/rotate-logs.js for the
// cron-side aggregation that consumes these prefixes.
function truncateIp(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  // Strip IPv4-mapped IPv6 prefix: "::ffff:192.168.1.1" -> "192.168.1.1"
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}`;
  const v6 = ip.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
  if (v6) return `${v6[1]}:${v6[2]}`;
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

  const prefix = truncateIp(ip);

  // Connection admission control
  if (globalConnections >= MAX_GLOBAL_CONNECTIONS) {
    try { ws.send(JSON.stringify({ type: 'status', message: 'Server busy — try again shortly' })); } catch {}
    log(`refused capacity from ${prefix}`);
    ws.close(1013, 'Server at capacity');
    return;
  }
  const ipCount = ipConnections.get(ip) || 0;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) {
    try { ws.send(JSON.stringify({ type: 'status', message: 'Too many connections from your address' })); } catch {}
    log(`refused per-ip from ${prefix}`);
    ws.close(1013, 'Per-IP limit');
    return;
  }
  globalConnections++;
  ipConnections.set(ip, ipCount + 1);

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
      // Sanitize message.type before logging — it is attacker-controlled.
      // Cap length and strip anything outside [a-z0-9_-] to keep logs parseable.
      const safeType = String(message.type || '').slice(0, 16).replace(/[^a-z0-9_-]/gi, '?');
      log('msg type=' + safeType);

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
    globalConnections = Math.max(0, globalConnections - 1);
    const n = (ipConnections.get(ip) || 1) - 1;
    if (n <= 0) ipConnections.delete(ip); else ipConnections.set(ip, n);

    // Remove this client from all sessions
    sessions.forEach((session, code) => {
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
    });
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

function handleJoin(ws, code) {
  if (!sessions.has(code)) {
    sessions.set(code, { sender: ws, receivers: new Set(), idleTimer: null, maxTimer: null, createdAt: 0 });
    armSessionTimers(code);
    ws.send(JSON.stringify({ type: 'role', role: 'sender' }));
    log('role assigned: sender');
  } else {
    const session = sessions.get(code);
    if (session.sender && session.receivers.size >= MAX_RECEIVERS_PER_SESSION) {
      try { ws.send(JSON.stringify({ type: 'status', message: 'Session is full — only two peers allowed' })); } catch {}
      ws.close();
      log('refused full session');
      return;
    }
    session.receivers.add(ws);
    ws.send(JSON.stringify({ type: 'role', role: 'receiver' }));
    log('role assigned: receiver');
  }
}

function handleClaimSender(ws, code) {
  if (!sessions.has(code)) {
    sessions.set(code, { sender: ws, receivers: new Set(), idleTimer: null, maxTimer: null, createdAt: 0 });
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

  log('routed ' + (format || 'data') + ' to ' + forwarded + ' peer(s)');
}

function handleHello(ws, code, pubkey, sig) {
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

console.log(`Limits: payload ${MAX_PAYLOAD_BYTES/1024}KB, rate ${RATE_REFILL_PER_SEC}/s (burst ${RATE_BUCKET_CAPACITY}), per-IP ${MAX_CONNECTIONS_PER_IP}, global ${MAX_GLOBAL_CONNECTIONS}, idle ${SESSION_IDLE_MS/60000}m, max ${SESSION_MAX_MS/60000}m`);
