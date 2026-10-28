# Changelog

All notable changes to Keylay are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.9.1] — 2026-10-27

Relay-only hardening release. `server.js` changed; the client is unchanged apart from
the version number. No protocol change: 0.9.0 and 0.9.1 clients interoperate.

### Security (relay)

- **Connection error handling.** Each client connection now handles its own socket
  errors, so a malformed frame closes only that connection.
- **Session isolation.** A disconnect now updates only the session that connection
  belonged to.
- **Join validation and limits.** Session codes must match the client's 32-character
  channel format; one session per connection; connections that do not join within
  30 seconds are closed; IPv6 clients are counted per /64 for the per-address limit.

---

## [0.9.0] — 2026-09-23

Protocol **v2** — this is a **wire-breaking** release. A v2 client cannot complete a
session with a v1 client: the channel identifier, handshake authentication, session-key
derivation, and per-message authenticated header all changed. Both peers must run 0.9.0.
Because the crypto changes and the UR file-handling work are shipped together, this is a
single hash / website / Nostr cycle rather than two.

### Security (protocol v2)

- **Channel identifier is now derived from a stretched key, not from the raw code.** The
  identifier the relay sees is `SHA-256("keylay-v2-channel|" || K_code)`, where `K_code` is
  the session code run through PBKDF2-HMAC-SHA512 (300,000 iterations, fixed domain salt).
  Previously it was `SHA-256(code)`, which a relay operator could invert offline to recover
  a short code in about a day; deriving it from the stretched `K_code` removes that offline
  shortcut. [S12]
- **Handshake HMAC key and session-key salt now come from the same stretched `K_code`.** A
  single stretch feeds every code-derived value (channel id, handshake HMAC key, and the
  HKDF salt for the session key), rather than hashing the raw code separately for each. [S12]
- **The AES-GCM session key is bound to the channel and both public keys.** Session-key
  HKDF now uses `info = "keylay-v2-pair|" || channelHash || sorted(both X25519 public keys)`,
  so a key agreed for one channel/pair cannot be transplanted to another. [A3]
- **Every message carries an authenticated envelope header.** AES-GCM additional
  authenticated data is now `"keylay-v2|" || type || channelHash || format || counter`, so
  the message type, channel, payload format, and replay counter are all cryptographically
  bound to the ciphertext; a relay that alters any of them causes decryption to fail rather
  than being silently accepted. [S3]
- **Handshake KDF upgraded to PBKDF2-HMAC-SHA512.** SHA-512 raises the cost to a GPU
  attacker at no meaningful cost to a legitimate client, and the 10-character code length is
  sufficient given the stretch. [SHA-512 rider]
- **Still open, accepted by design: the PBKDF2 salt is a fixed constant (S11).** Two peers share
  nothing but the session code before they connect, so the channel identifier must be derivable from
  the code alone — which means the stretching salt must be a public constant. A relay that logs many
  channel identifiers can therefore still sweep the code space once against all of them, rather than
  once per session. What v2 changes is the price of that sweep: each candidate code now costs a full
  PBKDF2-HMAC-SHA512 stretch instead of a single SHA-256. This is inherent to the design and will not
  be "fixed"; it is why code length and alphabet matter and why the app warns on weak codes. A
  memory-hard KDF (Argon2id or scrypt) would raise the per-guess cost further but would not remove
  the amortization; it also remains blocked on browser support — the browser's native crypto API
  (Web Crypto) offers PBKDF2 only, and Keylay will not ship a hand-rolled or third-party
  implementation of a memory-hard KDF. [S11]
- **Decompression-bomb guard on BBQr 'Z' payloads.** Inflation is capped at 8 MB (far above
  any real PSBT) and aborts rather than allocating unboundedly on a malicious frame. [S4]
- **Vendored-library provenance is now verifiable.** All three inlined libraries (jsQR 1.4.0,
  qrcode 1.5.1, pako 2.1.0) are byte-identical to their published releases; the QR encoder,
  which previously did not match its published build, has been reconciled. Sources and SHA-256
  hashes are recorded in `PROVENANCE.md` and on keylay.org/verify.html, and
  `node tools/verify-vendored.mjs` checks them (it also runs as a release preflight). [S5]

### Added (UR file handling)

- **Native UR (BC-UR) codec — decode and encode, no library dependency.** Keylay now
  reassembles animated UR fountain sequences (bytewords + fountain codes + minimal CBOR) in
  original, readable code inlined in `index.html`, rather than a ~200 KB polyfilled bundle. It
  is validated against `@ngraveio/bc-ur` and `embit` as oracles (77 assertions, including
  `chooseFragments` matching bit-for-bit, byte-identical part strings, and descriptor
  checksums matching a known BIP-380 vector); see `tools/UR-CODEC.md`.
- **Received UR sequences now decode to real files, not raw UR text.** A received
  `ur:crypto-psbt` / `ur:psbt` downloads as a binary `.psbt`; `ur:bytes` (a finalized
  transaction) as `.txn`; an output descriptor (`ur:output-descriptor`, `crypto-output`, or a
  `crypto-account` wrapping one) decodes to the standard `wsh(sortedmulti(...))#checksum`
  descriptor string a coordinator like Sparrow imports — reconstructed natively from the
  tagged-CBOR tree, xpubs rebuilt via base58check, checksum per BIP-380. [TF5]
- **Decoded view for received data.** A text setup artifact (output descriptor) is shown in
  a selectable box so you can copy just the parts you need into a coordinator. A binary
  signing artifact (PSBT / raw tx) is not rendered — it shows a "Binary PSBT, N bytes"
  notice with **Download** and an optional **Copy as base64** (the paste-into-Sparrow
  bridge). PSBTs are verified on the signing device, not by eye in this app. [Phase A]
- **Show a received/uploaded item as a scannable animated QR, with a format toggle.** A PSBT
  or descriptor can be displayed for an air-gapped device to scan off the screen in two
  formats, offered as a toggle (the one you're *not* viewing appears as a button): **UR —
  loop** (a fixed set of frames looped; read by UR wallets — Nunchuk, BlueWallet, Keystone,
  Passport, Jade, SeedSigner, Sparrow; a pass-through of the arrived frames when the data came
  in as UR) and **BBQr** (read by Coldcard, BlueWallet, Sparrow; Nunchuk does not read BBQr).
  Format and payload are independent — a descriptor rides in BBQr as file-type `U`, a PSBT as
  `P`. Each is integrity-checked before display, and a long descriptor gets an animated
  sequence instead of one dense static QR. [TF2]
  - *A fountain-code (rateless) UR streaming mode was tried and removed:* BC-UR fountain parts
    were rejected by every wallet tested (Nunchuk and BlueWallet both fail on them, though
    BlueWallet reads looping UR and BBQr fine), and no wallet was found that reliably imports
    an unbounded fountain. Keylay emits only the looping pure fragments, which UR decoders
    accept.
- **Save-format dialog now offers the decoded options that were previously stubbed.** For a
  scanned PSBT: binary `.psbt` and base64. For an output descriptor (including the legacy
  `crypto-output` tree): plain text. BSMS remains intentionally out of scope — it is saved
  verbatim when received, never generated — and unsupported types fall back to raw UR.

### Fixed

- **Local QR display without a peer; send-panel controls tidied.** Uploading a file no longer
  requires a connected peer — you can load a PSBT or descriptor and show it as a QR for a
  hardware wallet sitting right next to you, no relay involved. (Start Scan still needs a peer,
  since it relays.) The sender's local UR QR now appears on the *first* click (the display
  container was staying hidden); the "Show as…" status now says to point your signing device
  at the screen rather than the ambiguous "hold your signer up until it reads them all"; the
  Clear button now hides the Show-as-… and Save buttons and wipes the display (it previously
  left them behind); and a duplicate Clear handler was removed.
- **Stale data-type label no longer lingers after leaving or swapping roles.** The scanned/
  received type label (e.g. "Output Descriptor") was only partially cleared: `lastScannedData`
  was never reset, so the label persisted next to the Start Scan / Claim Sender Role buttons
  after leaving and rejoining a channel or changing roles. Leave and role change now clear all
  scanned/received data state and hide every data-dependent control and label.
- **Receive panel clarified.** The "Received:" label now names the decoded *content* (e.g.
  "Multisig Wallet Setup", "Output Descriptor") rather than the UR container, so a text file
  in `ur:bytes` no longer reads "Transaction". The decoded box shows a single instruction
  directly above it (was two, one pointing the wrong way). The animated-QR status now reads
  "N frames cycling" and states N is the total number of frames (not how many have been read).
  The format button offers the *alternate* format from the one already on screen, removing a
  redundant control and a confusing frame-count mismatch.
- **A text file wrapped in `ur:bytes` is no longer mislabeled binary.** `ur:bytes` is a
  generic container that BlueWallet/Coldcard use for a plain-text multisig setup file and
  that others use for a raw (binary) transaction. Keylay treated all `ur:bytes` as binary, so
  a setup file showed a "binary — download only" notice instead of readable text. The decoded
  bytes are now sniffed: PSBT magic or non-text bytes stay binary (raw tx → `.txn`); valid
  printable UTF-8 (a setup file, descriptor, or BSMS) is shown as text, saved as `.txt`, and
  labeled by content (e.g. "Multisig Wallet Setup").
- **Data-type labels now name the content, consistently.** The classifier previously mixed
  content ("PSBT", "Output Descriptor") with transport ("QR Code", "BBQR", "UR Data"), so a
  plain-text descriptor even showed "QR Code". It now always names the content — PSBT, Output
  Descriptor, Wallet Descriptor, Extended Public Key, Bitcoin Address, Transaction, BSMS —
  detecting plain descriptors, base64/hex PSBTs, xpubs, and addresses, peeking the BBQr
  file-type byte, and falling back to a plain "Text" only when the content is unknowable.
- **Send-side type label moved into the "Sent" confirmation.** The standalone type label that
  sat awkwardly beside the Start Scan / Claim Sender Role buttons is gone; the content type is
  now reported in the green "Sent (encrypted): <type>" toast. The send toast names the type
  only — never a payload/address substring, which could match a poisoned look-alike. The
  receiver's type now reads as a "Received: <type>" header above its action buttons.
- **Grouped session codes now connect.** The code is displayed grouped for readability
  (`7k4m · 2xqt · b9`), but the join path only trimmed outer whitespace and lowercased — it
  did not remove the grouping separators. One participant entering the grouped form and another
  entering the plain form derived different channel identifiers and never connected, with no
  error, just an endless "connecting" spinner. `joinChannel` now treats a code's letters and
  digits as its content and removes every non-alphanumeric character before deriving anything,
  so any display grouping (or any separator a user improvises) canonicalizes to one channel and
  the app's own `·`-grouped display round-trips. Content is deliberately not restricted to the
  generator's alphabet, so user-chosen memorable codes keep working (looksLowEntropy still only
  warns); a non-ASCII look-alike letter is likewise not alphanumeric and is dropped, so a code
  carrying one fails to connect rather than silently forming a different channel. This was the
  app-side manifestation of spec defect KL-SPEC-003 (code normalization was under-specified).

### Notes

- `crypto-hdkey` and `crypto-seed` have no native decoder yet; those download as raw UR text.
  PSBTs, transactions, and output descriptors (crypto-output / crypto-account) decode natively.

---

## [0.8.0] — 2026-08-14

Security review follow-up (Phase 0 of the combined remediation plan). No wire-protocol
change — `keylay-v1` clients and these clients still interoperate.

### Security

- **Session code is no longer accepted from the URL (`?code=`).** A code placed in the query string traveled with the page request to the app host and could be recorded in its access logs, the browser's history, or the `Referer` header — which contradicts the property that the session code never reaches the server. The code is now entered manually only. Links that previously pre-filled the code via `?code=` will no longer pre-fill it. [S1]
- **Ephemeral X25519 handshake keys are now generated non-extractable.** The private key was never exported, so this is functionally invisible, but marking it non-extractable makes forward secrecy enforced by the browser itself rather than by clearing the key reference, and prevents an injected script from exporting the live private key. [S2]

### Fixed

- **UR capture progress no longer counts mixed fountain frames.** A part whose sequence number exceeds the pure-part total is no longer stored or counted, so the capture status can no longer contradict itself (e.g. showing "UR: 7/7 frames — Need: 3"). [TB2]
- **Current-generation UR type names are now recognized.** Type detection accepts both the legacy `crypto-*` names and the current names that drop the prefix — `ur:psbt`, `ur:output-descriptor`, `ur:hdkey`, `ur:account-descriptor`, `ur:address`, `ur:seed` — so a device emitting current names receives the correct label, file extension, and save-format handling instead of generic fallback. [TB3]

### Added

- **Non-blocking warning for obviously weak hand-typed session codes.** When a manually entered code has very few distinct characters or is a strictly sequential run, a soft warning suggests using "Generate Random." The random generator is unaffected, and the warning never blocks joining. [S6]

---

## [0.7.2] — 2026-07-27

### Fixed

- **Production connections mislabeled as "Local Server".** The connection logic hardcoded the `'local'` label for the first connection attempt. On a page served from `localhost` — where the first attempt genuinely targets `ws://localhost:8080` — that label was correct, but on `app.keylay.org` the first and only attempt is the cloud relay, so every production session ever made displayed "🟢 Local Server • Encrypted." The production path now labels its connection correctly ("Cloud Relay • Encrypted"), and its failure message no longer tells hosted users to start a local server. Reported by a user who noticed their phone claiming a local server.

---

## [0.7.1] — 2026-07-27

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

- **Cloud-relay fallback is now visibly flagged.** When the app is served from `localhost` and the local relay attempt fails, rolling over to the hosted relay no longer shows the standard green "Cloud Relay" pill. A distinct amber status state — "⚠️ Local relay unreachable — using cloud relay (app.keylay.org) • Encrypted" — is shown instead (light- and dark-mode styles), the connecting status says why the relay changed, and an unconditional `console.warn` records the fallback. The indicator persists across reconnects and resets on leave/rejoin. A deliberate cloud connection still shows the normal pill.

- **Footer privacy claim corrected.** "No IPs logged" → "No full IPs logged," matching the truncated-IP (/16 prefix) logging disclosed in the security review and README.

- **README rewritten for accuracy.** Corrected the secure-context explanation (`file://` is potentially trustworthy per spec; `localhost` remains the universal recommendation), replaced "no external dependencies" with "vendored and inlined at pinned versions," scoped the relay metadata claim to application-layer with connection-layer visibility conceded, documented the three run modes as explicit trust tiers with a verification section, and reconciled the roadmap with keylay.org.

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
