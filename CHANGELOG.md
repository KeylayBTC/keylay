# Changelog

All notable changes to Keylay are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
