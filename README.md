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

1. Both parties open the app (hosted at `app.keylay.org` or self-hosted)
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
- The relay sees only ciphertext — never plaintext, the raw channel code, or message metadata
- No accounts, no databases. The hosted relay at `app.keylay.org` writes operational logs limited to truncated IP prefixes (first two octets for IPv4, first two hextets for IPv6) for rate-limit triage and country-level aggregation; logs rotate on a 7-day window. Channel codes, channel hashes, session content, and message counters are never logged
- Encryption: AES-256-GCM session keys derived from X25519 key exchange (HKDF); PBKDF2-SHA256 (300,000 iterations) derives the HMAC key used to authenticate the handshake

## Technology

- Single self-contained HTML file — no build step, no framework, no external dependencies
- WebSocket relay (`server.js`) — Node.js, ~120 lines
- QR scanning: [jsQR v1.4.0](https://github.com/cozmo/jsQR) (inlined)
- QR generation: [qrcode v1.5.1](https://github.com/soldair/node-qrcode) (inlined)
- BBQR encode/decode: implemented natively per the [BBQr spec](https://github.com/coinkite/BBQr)
- Zlib compression (BBQr 'Z' encoding): [pako v2.1.0](https://github.com/nodeca/pako) (inlined) — required because `CompressionStream('deflate')` produces RFC 1950 output (78 9C header) that Coldcard Q rejects; pako's `deflateRaw` with `windowBits: 10` produces the raw DEFLATE format the spec requires

## Running Locally

```bash
node server.js
python3 -m http.server 8081   # or any static file server
# Open http://localhost:8081/index.html in your browser
```

**You must serve the file over `localhost` — do not open it as a `file://` URL.** Browsers restrict the Web Crypto API (`crypto.subtle`) to [secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts): HTTPS origins and `localhost`. A `file://` URL does not qualify, so the page will load but encryption will be unavailable.

`localhost` is explicitly treated as a secure context by all major browsers, so the simple Python server above is sufficient for local use — no self-signed certificate needed. Note that Chrome on desktop is more permissive and will allow `crypto.subtle` on `file://` URLs, but Safari and all browsers on iOS will not — so serving via `localhost` is the safe universal approach.

The app connects to `ws://localhost:8080` for the relay automatically and falls back to `wss://app.keylay.org/ws` if no local server is running. To point at a different relay, edit `WS_LOCAL_URL` / `WS_CLOUD_URL` in `index.html` and add the new origin to the `connect-src` entry in the `Content-Security-Policy` meta tag.

## Self-Hosting

The relay is a single stateless Node.js file. It stores nothing and has no database. Any server capable of running Node.js works. The frontend is a single HTML file — serve it statically alongside the relay or from any web server.

See `DEPLOYMENT.md` for a complete setup guide including SSL and process management.

## Roadmap

- [ ] Peer-to-peer connections via Nostr — eliminates the need to trust any relay operator; users who prefer the convenience of a hosted relay can continue using it alongside the Nostr option
- [ ] Challenge/response pairing for out-of-band verification before transfer
- [ ] BC-UR2 encoding for output to Keystone/Passport (currently decodes only)
- [ ] UR decoding to alternate save formats (base64 PSBT, plain text descriptor, BSMS)
- [ ] Connection quality indicator and receiver count display

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
