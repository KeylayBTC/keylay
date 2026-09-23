# Keylay Development Plan

This is the detailed public plan for Keylay. The README's Roadmap section and the status section on [keylay.org](https://keylay.org) are summaries of this file; if they ever disagree, tell us — consistency between them is a stated goal, not an accident.

Keylay is alpha software built by a small team. Items here are intentions with reasoning attached, not commitments with dates. Where a design has a known hard problem, the problem is written down here before the feature ships — if you spot a flaw in the reasoning, [we want to hear it](mailto:contact@keylay.org).

---

## Near-term

**Challenge/response pairing.** Out-of-band verification between peers before any transfer, reducing reliance on channel-code secrecy alone.

**Timed capture mode for fountain-coded QR sequences.** BC-UR2 fountain codes emit more frames than the minimum needed for reconstruction. Today Keylay stops at the minimum; a capture-all-frames mode (time-boxed, with a manual stop) will support exact reproduction workflows.

**Wallet guides.** Step-by-step setup and signing flows for major wallet and coordinator combinations, starting from the existing Sparrow + Coldcard guide.

**Connection quality indicator and receiver count.** Surface latency and how many peers are connected to a channel.

## Security hardening

**CSP hash-pinning for inline scripts.** The app ships as a single file with inline `<script>` blocks, so the Content-Security-Policy currently includes `script-src 'unsafe-inline'` — meaning the CSP restricts where an injected script could exfiltrate data, but does not stop one from executing. The fix is replacing `'unsafe-inline'` with per-block `sha256-` hash entries. This is deliberately deferred: every edit to an inline script invalidates its hash, so pinning before the code stabilizes (or before a build step automates rehashing) would make each release error-prone. Until it lands, this is an acknowledged, disclosed gap — see `security.md` and the [security page](https://keylay.org/security.html).

**Memory-hard KDF.** PBKDF2-HMAC-SHA512 (300,000 iterations) is deliberately conservative but not memory-hard; Argon2id or scrypt would raise the cost of GPU-accelerated offline guessing of the session code. **This is blocked on browser support, not scheduled.** The browser's native crypto API (Web Crypto) provides PBKDF2 and nothing memory-hard, and Keylay will not ship a hand-rolled or third-party implementation of a KDF — the audit-equals-runtime guarantee depends on every cryptographic primitive coming from the browser. If browsers add Argon2id natively, this becomes a breaking protocol change that ships with a migration plan, not as a silent swap. Note that it would not remove the fixed-salt amortization disclosed as S11 on the security page; that is inherent to deriving a rendezvous identifier from a shared code.

**Formal third-party audit.** The current security review is internal and AI-assisted, published in full. An external audit is planned before Keylay exits alpha.

## Phase 2 — Nostr transport and what it unlocks

**Nostr as primary transport.** Nostr relays replace the single WebSocket relay as the default channel, with WebSocket retained as fallback. This removes the last trusted operator: no single party can take the coordination layer down or observe its traffic patterns from a privileged position.

*Design constraint, stated up front:* NIP-04 is deprecated, and NIP-44's standard key exchange uses persistent Nostr identity keys. Adopting either as-is would silently break Keylay's forward-secrecy model, which depends on ephemeral per-session X25519 keys. The Nostr transport will therefore carry Keylay's own ephemeral handshake inside event payloads, using Nostr only as a dumb transport — not adopt NIP-44 key exchange.

**Persistent / resumable sessions (store-and-forward).** Named sessions where encrypted messages persist on relays until participants reconnect, enabling asynchronous coordination — co-signers act hours apart. The DH handshake completes asynchronously too (it's two messages; simultaneity isn't required).

*Security consequence, stated up front:* persistence moves the forward-secrecy boundary. Ciphertext accumulates on relays while the session key lives on-device, so a mid-session device compromise would expose that session's stored traffic. The design answer is a symmetric ratchet within the session — per-message keys derived from a hash chain seeded by the X25519 session key, with chain state deleted as messages are processed, so stored ciphertext ages out of reach. The existing replay counters double as ratchet indices. A ratchet gives forward secrecy within a session but not post-compromise security; a fresh ephemeral re-handshake restores that. These limits will be documented, not glossed.

*Reliability caveat:* public relays prune events on their own schedules; delivery guarantees require retention-selected or dedicated relays.

**Multi-party sessions.** Sessions with a declared signer count and numbered slots — each participant submits cosigner data to a slot, enabling in-browser descriptor assembly without separate per-signer sessions.

**PWA support.** Installable mobile use without an app store.

## Under consideration

Smaller items, unscheduled: adjustable QR animation speed; sharing a channel via QR code; inline help explaining each save format (Raw UR, plain-text descriptor, BSMS/BIP-129, base64 PSBT, JSON) and which wallets accept it.

## Recently completed

- End-to-end encryption: AES-256-GCM, ephemeral X25519, HKDF, HMAC-authenticated handshake
- Protocol v2 (v0.9.0): channel identifier derived from the stretched code, authenticated per-message header, session key bound to channel and both public keys, PBKDF2-HMAC-SHA512
- Native UR (BC-UR) encode and decode, no library dependency (v0.9.0); received PSBTs, transactions, and output descriptors decode to real files, with base64 PSBT and plain-text descriptor save formats
- BBQR encode/decode (Coldcard)
- Hosted relay at `wss://app.keylay.org/ws` — rate limiting, session lifetime enforcement, truncated-IP logging
- Auto-reconnect with exponential backoff and a fresh handshake per reconnect (v0.7.1)
- Cloud-relay fallback indicator — an amber status state visibly flags when a localhost relay attempt failed and the app rolled over to the hosted relay (v0.7.1)
- Save dialog with context-aware format options

---

*Last updated: 2026-07-26*
