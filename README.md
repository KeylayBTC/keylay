# Keylay

**Encrypted QR relay for remote multisig Bitcoin coordination**

Keylay enables geographically separated participants in a multisig wallet to set up and use their air-gapped wallets safely together — without accounts, email, phone numbers, or a trusted server. It bridges air-gapped signing devices across locations using an encrypted relay and direct BBQR display or SD card file transfer.

> **Alpha.** Keylay is functional but under active development. Features will expand and the protocol will evolve. Feedback from early users is welcome and shapes the roadmap.

## The Problem It Solves

A multisig wallet with remote co-signers requires participants to exchange xpubs, wallet descriptors, and signed PSBTs. Email or a messaging app exposes the information to third parties. Air-gapped signing devices provide high security, but their use creates a coordination problem: how do you communicate between a cold wallet in one place and a coordinator in another?

Keylay solves the coordination layer without compromising the air gap.

## Primary Workflow: Remote Multisig Setup

**Step 1 — Share xpub with coordinator**

The co-signer's cold wallet displays an xpub or key info as an animated QR sequence. The co-signer opens Keylay, clicks Start Scan, and scans it. The data is encrypted within the local browser and relayed to the coordinator's browser, which re-renders the QR frames. The coordinator scans those frames into their coordinator software on their laptop or cold wallet (or downloads and transfers via SD card) and imports the key.

**Step 2 — Send wallet descriptor back**

The coordinator's software or device collects the xpub or key info from all signers, creates the multisig wallet, and exports the full wallet descriptor as an animated QR. The coordinator claims the sender role in Keylay, scans the QR code into Keylay, and relays it back to every co-signer. The co-signer's browser renders the descriptor QR frames, which the cold wallet scans to complete multisig setup.

**Step 3 — Coordinate signing**

When a transaction needs signing, the coordinator sends a QR or uploads the `.psbt` file to Keylay. The remote co-signers' browsers receive it, click "Show as QR for Coldcard," and use their cold wallet to scan the displayed QR code. The cold wallet signs and displays the signed PSBT as BBQR. The co-signer scans it back into Keylay and the coordinator downloads the signed binary for combining and publishing.

No data touches the relay server in readable form at any point.

## Supported Workflows

| Workflow | How |
|---|---|
| Share xpub → remote coordinator | Scan cold wallet's animated QR → relayed → coordinator scans from browser |
| Receive wallet descriptor from remote coordinator | Coordinator scans descriptor QR → relayed → co-signer's cold wallet scans from browser |
| Send PSBT to remote Coldcard | Upload `.psbt` → relayed → remote clicks "Show as QR" → Coldcard scans BBQR |
| Receive signed PSBT from remote Coldcard | Scan Coldcard's BBQR → relayed → remote downloads binary `.psbt` |
| Local PSBT → Coldcard (no relay) | Upload `.psbt` → "Show as QR" → Coldcard scans directly from screen |
| Any QR → remote display | Scan any QR → relayed and re-rendered for receiver |

Supports **BC-UR2** (Keystone, Passport, Jade, Foundation) and **BBQR** (Coldcard) animated QR formats, plus raw static QR and binary file transfer.

## How It Works

### Session Setup

1. Both parties open the app (hosted at `app.keylay.org`, served locally, or fully self-hosted — see [Choosing How to Run Keylay](#choosing-how-to-run-keylay))
2. Share a secret channel code out-of-band (any method — it never touches the server)
3. Both enter the code. First to join is Sender; the other is Receiver. Roles are swapped when Receiver claims Sender role.

### Data Path

1. Sender scans a QR or uploads a file from a cold wallet
2. Payload is encrypted client-side with AES-256-GCM (session key derived from X25519 key exchange via HKDF; the channel code authenticates the handshake via HMAC)
3. Encrypted blob is relayed via WebSocket — the server sees only ciphertext
4. Receiver browser decrypts and renders the QR frames and presents the binary file for optional download
5. Receiver scans the QR code or transfers the file to coordinator software or a cold wallet

### Security Model

- The channel code is used only for key derivation and is never sent to the server
- The relay sees only ciphertext — never plaintext, the raw channel code, or any application-layer metadata (file names, file types, payload contents). Like any relay, it can necessarily observe connection-layer metadata: message timing, ciphertext sizes, and which two connections are exchanging data. This is inherent to any relayed transport and is stated here so you can weigh it; the planned Nostr transport reduces reliance on any single relay operator
- No accounts, no databases. The hosted relay at `app.keylay.org` writes operational logs limited to truncated IP prefixes (first two octets for IPv4, first two hextets for IPv6) for rate-limit triage and country-level aggregation; logs rotate on a 7-day window. Full IP addresses, channel codes, channel hashes, session content, and message counters are never logged
- Encryption: AES-256-GCM session keys derived from X25519 key exchange (HKDF); PBKDF2-SHA256 (300,000 iterations) derives the HMAC key used to authenticate the handshake
- The app hard-fails without encryption: in a browsing context where the Web Crypto API is unavailable, Keylay displays a warning banner and disables the Join button. It never falls back to sending data unencrypted — there is no code path that transmits plaintext
- An internal security review (three revisions, all findings resolved) is published at [keylay.org/security.html](https://keylay.org/security.html); the full report is `Keylay_Security_Review_v3.pdf`. This is not a formal third-party audit — see [Roadmap](#roadmap)

## Technology

- Single self-contained HTML file — no build step, no framework, no network-loaded dependencies (nothing fetched from a CDN at runtime)
- Three third-party libraries are vendored and inlined at pinned versions, so the code you audit is exactly the code that runs:
  - QR scanning: [jsQR v1.4.0](https://github.com/cozmo/jsQR)
  - QR generation: [qrcode v1.5.1](https://github.com/soldair/node-qrcode)
  - Zlib compression (BBQr 'Z' encoding): [pako v2.1.0](https://github.com/nodeca/pako) — required because `CompressionStream('deflate')` produces RFC 1950 output (78 9C header) that Coldcard Q rejects; pako's `deflateRaw` with `windowBits: 10` produces the raw DEFLATE format the spec requires
- BBQR encode/decode: implemented natively per the [BBQr spec](https://github.com/coinkite/BBQr)
- WebSocket relay (`server.js`) — a single stateless Node.js file, no database

## Choosing How to Run Keylay

There are three ways to run Keylay, in increasing order of trust removed from the operator:

**1. Hosted app (convenience tier).** Open [app.keylay.org](https://app.keylay.org). The relay only ever sees ciphertext, but the *application code* is delivered to your browser on every load — you are trusting that the served code matches the published source at that moment. This is the right tier for evaluating Keylay and for threat models where a targeted, per-load code swap by the host is not a concern.

**2. Local app + hosted relay (recommended for higher-threat use).** Serve `index.html` locally from a copy you verified, and let it use the hosted relay. This removes the code-delivery trust entirely — the relay still only sees ciphertext, and the code executing in your browser is the code you audited. No Node.js required:

```bash
python3 -m http.server 8081   # or any static file server
# Open http://localhost:8081/index.html
```

With no local relay running, the app automatically falls back to the hosted relay at `wss://app.keylay.org/ws` and **displays a visible amber status indicator showing that the cloud relay is in use** (a fallback is never silent). This is an intentional, supported mode, not a degraded one.

**3. Full self-hosting.** Run both the app and the relay yourself:

```bash
node server.js                # relay on ws://localhost:8080
python3 -m http.server 8081   # static server for index.html
# Open http://localhost:8081/index.html
```

The connection status indicator always shows which relay you are connected to: green "Local Server" for your own relay, "Cloud Relay" for the hosted one, and the amber warning state when a local relay was expected but unreachable. To point at a different relay, edit `WS_LOCAL_URL` / `WS_CLOUD_URL` in `index.html` and add the new origin to the `connect-src` entry in the `Content-Security-Policy` meta tag.

See `DEPLOYMENT.md` for a complete production setup guide including SSL and process management.

### Why `localhost` and not `file://`

Serve the file over `localhost` rather than double-clicking `index.html`. The [Secure Contexts spec](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts) treats `file://` URLs as potentially trustworthy, and current Chrome and Firefox do expose `crypto.subtle` there — but browser behavior on `file://` is not uniform (Safari and iOS differ), and camera access for QR scanning is separately restricted on `file://` in some browsers. `localhost` is treated as a secure context by all major browsers, so the one-line static server above is the reliable universal path — no self-signed certificate needed. If you do open the app in a context without Web Crypto support, it refuses to join a session and tells you why, rather than degrading.

### Verifying What You Run

For local use, run code pinned to a release, not a live download:

```bash
git clone https://github.com/keylaybtc/keylay
cd keylay
git tag -l            # list release tags
git checkout <tag>    # pin to a release
git log -1            # record the commit hash you are running
```

Git commit hashes are content-addressed, so pinning to a tag and recording its commit hash gives you a stable reference you can compare against what others report and against future releases. For the highest-threat use, review `index.html` itself — it is a single readable file and the complete client — before serving it.

## Roadmap

Near-term:

- [ ] Peer-to-peer transport via Nostr — Nostr relays become the primary channel with WebSocket as fallback; eliminates the need to trust any single relay operator
- [ ] Wallet guides — step-by-step setup and signing flows for major wallet and coordinator combinations
- [ ] Challenge/response pairing for out-of-band verification before transfer
- [ ] BC-UR2 encoding for output to Keystone/Passport (currently decodes only)
- [ ] UR decoding to alternate save formats (base64 PSBT, plain text descriptor, BSMS)
- [ ] Connection quality indicator and receiver count display

Longer-term:

- [ ] Multi-party sessions — declared signer count with slot-based key collection, enabling in-browser descriptor assembly without separate per-signer sessions
- [ ] Persistent / resumable sessions — named sessions with store-and-forward delivery over Nostr, so participants can coordinate asynchronously
- [ ] PWA support — installable mobile use without an app store
- [ ] Memory-hard KDF upgrade — replace PBKDF2 with Argon2id or scrypt for the handshake key derivation (a breaking protocol change requiring a migration plan)
- [ ] Formal third-party security audit — the current review is internal; an external audit is planned before the project exits alpha

## Disclaimer

Keylay is provided "as is" without warranty of any kind, express or implied. Use at your own risk. The authors are not liable for any loss of funds, keys, data, or privacy resulting from use of this software, including bugs, protocol weaknesses, dependency compromise, or operator error.

This software has not received a formal third-party security audit. Do not use Keylay to coordinate multisig wallets controlling more value than you are willing to lose to undiscovered bugs.

Always verify on your hardware wallet's screen what you are signing. Keylay relays data; it cannot guarantee what your co-signers' devices receive or display, and it cannot substitute for the verification step on your own signing device.

## License

[MIT](LICENSE) — Copyright (c) 2025 Stan Reeves

## Links

- Website: [keylay.org](https://keylay.org)
- App: [app.keylay.org](https://app.keylay.org)
- GitHub: [github.com/keylaybtc](https://github.com/keylaybtc)
- X: [@keylaybtc](https://x.com/keylaybtc)
- Nostr: [npub1amg…qns](https://njump.me/npub1amgnj87xwh9t9zd9u0vy3tw0fjxumt8ajx858ej6qdmm3pj4qnsskjj03e)
