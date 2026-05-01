# Changelog

All notable changes to Keylay are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.7.1] — Unreleased

### Fixed

- **False-positive compatibility warning on iOS 17.4+.** The browser-support check now distinguishes between two failure modes: a non-secure context (`http://` or `file://` URL, where `crypto.subtle` is undefined by spec) and a genuinely unsupported browser. Previously both cases showed the same "browser unsupported" banner, causing iOS 17.6 users to see the warning when accessing the app over HTTP or opening it as a local file. The banner now correctly tells HTTPS users their browser is fine and explains the HTTPS requirement instead.

- **Auto-reconnect on transient disconnects.** A network blip, server hiccup, or brief iOS background suspension no longer dumps both peers back to the join screen. The app now retries silently in the background with exponential backoff (1 s → 2 s → 4 s → 8 s → 16 s → 30 s, up to 10 attempts / ~5 minutes). Each reconnect performs a fresh X25519 handshake and derives a new session key. If all retries are exhausted the user is returned to the join screen with the session code pre-filled.

- **Session code preservation.** The session code is now kept or cleared based on the reason for leaving, not unconditionally wiped on every exit:
  - Transient disconnect or reconnect failure: code kept, reconnect attempted.
  - 60-minute hard cap: code kept — user can immediately start a new session on the same channel.
  - User clicks Leave: code kept — user may want to return or share it.
  - 15-minute idle timeout: code cleared — session was abandoned; leaving the code visible on a shared device is a security liability.

- **Idle timeout with network already down.** Previously, if the WS was already closed when the 15-minute idle timer fired (e.g. after a long iOS background suspension), `leaveChannel()` was called without the code-capture step, silently clearing the session code. The direct path now consistently matches the onclose path.

- **Receiver controls hidden for plain-address QR.** When the sender relayed a plain-text QR (e.g. a bare Bitcoin address scanned from a Coldcard), the receiver's Download and Copy buttons stayed hidden because only the BBQR, UR, and binary branches showed `#receiverControls`. The plain-QR branch now shows the controls, and a Copy button has been added alongside Download for all received text payloads.

- **Third-party join disrupting active session.** If a third party entered the session code and clicked Join Session while two peers were already active, their hello (sent in `broadcastHello()` immediately after `ws.onopen`) could reach the server before the session-full close handshake completed. The server forwarded it, and both active peers — seeing a signature-valid hello with an unknown pubkey — treated it as a peer reconnect and reset their session keys. The server now validates that hello and data messages originate from a registered session member before forwarding. The client-side reset guard is also tightened.

- **QR not square on high-DPR mobile.** Added `max-width: 100%; height: auto; aspect-ratio: 1 / 1` to `#qrCanvas` and `#qrDisplayImg`. Previously the canvas had no width constraint and could render non-square on narrow high-density screens when the browser's layout engine scaled width independently of height.

- **BBQR PSBT encoding for large files.** Replaced `btoa(String.fromCharCode(...bytes))` with a chunked encoder that avoids the JS engine spread-argument limit (~65 535). For PSBTs with many inputs the spread could silently truncate the byte array, producing a valid-but-incomplete PSBT that Coldcard rejected with "no key path information."

### Changed

- **Timeout warnings.** A non-blocking orange banner now appears 2 minutes before either timeout fires:
  - *Idle warning* (fires at 13 min): includes a "Keep session alive" button that resets the idle timer and dismisses the banner. Auto-dismisses if data activity resumes.
  - *60-minute cap warning* (fires at 58 min): informational only; the hard cap cannot be extended.

- **`leaveChannel()` no longer clears the code input.** Code preservation is now the caller's responsibility, making the policy explicit at each call site rather than buried inside a shared teardown function.

- **Session start time persists across reconnects.** The 60-minute hard cap is measured from the original `sessionStart`, not from each individual WebSocket connection. Reconnecting at minute 55 does not reset the clock.

---

## [0.7.0] — Unreleased

First public release. Pre-publication development history is internal and is not retroactively documented here.

### Features

- End-to-end encryption for all relayed data: AES-256-GCM session keys derived from X25519 key exchange via HKDF, with PBKDF2-SHA256 (300,000 iterations) deriving the HMAC key that authenticates the handshake.
- BBQR encode and decode (Coldcard format), supporting H, Z, and 2 BBQr encodings. Zlib decompression uses the browser-native `DecompressionStream` API — no external library.
- BC-UR2 decode (Keystone, Passport, Jade, Foundation animated QR formats).
- Binary PSBT relay: senders can upload a `.psbt` file; receivers download the original bytes with the correct filename and extension.
- "Show as QR for Coldcard" — receivers can render an incoming PSBT locally as animated BBQR for direct Coldcard scanning, no relay round-trip needed.
- Save-format dialog with context-aware options based on the detected QR data type (`crypto-output`, `crypto-psbt`, `crypto-hdkey`, `crypto-account`, `bbqr`).
- Configurable channel code with auto-fallback from a local relay (`ws://localhost:8080`) to the public relay (`wss://app.keylay.org/ws`).
- Single self-contained HTML file: no build step, no framework, no runtime dependencies on external CDNs. Inlined libraries: [jsQR](https://github.com/cozmo/jsQR) for scanning, [qrcode.js](https://github.com/soldair/node-qrcode) for generation.

### Security hardening

- **Content-Security-Policy** meta tag with `default-src 'none'`, narrow allowlists per resource type, and `connect-src` restricted to same-origin and `wss://app.keylay.org`. All five prior inline `onclick=` handlers migrated to `addEventListener` so the policy is tightenable later. Hash-pinning of inline `<script>` blocks remains tracked as the lone open hardening item; see `PLANNED_FEATURES.md`.
- **WebSocket frame-size cap** (`MAX_PAYLOAD_BYTES`, 256 KB) enforced at the protocol layer.
- **Per-connection rate limit** via token bucket: burst 5, sustained 1 message/second.
- **Concurrency caps**: 10 concurrent connections per IP, 100 concurrent globally, both enforced before session admission.
- **Session lifetime**: 15-minute idle timeout (bumped on every data/hello message) and a 60-minute hard maximum, both enforced server-side. The client mirrors both timeouts and wipes `sessionKey`, `ephemeralKeyPair`, `hmacKey`, and counters on expiry.
- **Pre-handshake buffer cap**: client-side message buffer bounded to 32 entries with oldest-drop-on-overflow.
- **WebSocket liveness**: ping every 30 seconds; sockets that fail to pong before the next sweep are terminated.
- **Truncated-IP logging**: `server.js` writes only /16 (IPv4) or /32-hextet (IPv6) prefixes to its log; full addresses are held in memory only for the per-IP cap and are never persisted.

### Documentation

- README's privacy claim rewritten from the imprecise "no metadata collected" to a precise enumeration of what is logged (truncated prefixes for rate-limit triage and country-level aggregation, on a 7-day window) and what is never logged (channel codes, channel hashes, session content, message counters).
- New `DEPLOYMENT.md` covering systemd unit, reverse proxy + TLS via Caddy or nginx, optional security headers, log handling, and the deploy/update loop.
- New disclaimer section in README and a footer notice in the app pointing users to it.

### Known limitations

- Alpha software. No formal third-party security audit has been performed.
- Hash-pinning of inline scripts under CSP is deferred until either a build step exists to recompute hashes per edit, or the inline blocks stabilize. See `PLANNED_FEATURES.md`.
- Meta-tag CSP cannot honor `frame-ancestors`, `report-uri`, or `sandbox`. Setting `frame-ancestors 'none'` via an HTTP header at the static-hosting layer is recommended for deployments that control that layer; see `DEPLOYMENT.md`.
