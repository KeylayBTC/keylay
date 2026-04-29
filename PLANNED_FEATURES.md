# Keylay Planned Features

This file tracks potential features and enhancements for future development.

---

## High Priority

### Hash-Pin Inline Scripts in CSP
**Status:** Planned (security hardening follow-up — see `outputs/security_review_summary.md`)
**Why:** The current CSP uses `script-src 'self' 'unsafe-inline'` because the app ships as a single-file bundle with inline `<script>` blocks. `'unsafe-inline'` weakens XSS defense — an injected `<script>` tag would still execute.

**Proposed Solution:**
- Replace `'unsafe-inline'` in the CSP meta tag with explicit `'sha256-<digest>'` entries for each inline `<script>` block.
- Every edit to an inline script invalidates its hash, so either freeze the inline blocks or add a pre-commit/pre-deploy step that recomputes and injects the hashes automatically.
- Same treatment for inline `<style>` blocks if/when we want to drop `style-src 'unsafe-inline'`.

**Do not start this** until the codebase is stable enough that rehashing on every edit isn't onerous, or until a build step exists to automate it. Any agent reporting open security issues should keep this item on the list until it's done.

---

### Timed Capture Mode for Fountain-Coded QR Sequences
**Status:** Planned  
**Use Case:** BC-UR2 and other fountain-coded QR sequences generate more frames than strictly needed. Current behavior captures only the minimum required fragments (e.g., 2 frames), but some users may want to capture all displayed frames for exact reproduction.

**Proposed Solution:**
- Add a "Capture All Frames" toggle or button
- When enabled, scan for a configurable duration (e.g., 10 seconds) instead of stopping at minimum fragments
- Capture all unique frames seen during the time window
- Display frame count during capture: "Captured 5 unique frames..."

**Technical Notes:**
- Fountain codes can generate infinite frames, so time-based cutoff is necessary
- Store frames by sequence number to avoid duplicates
- Consider adding a "I've captured enough" manual stop button

---

## Medium Priority

### Hosted WebSocket Server
**Status:** Planned  
**Description:** Deploy a public WebSocket relay server so users don't need to run their own.

**Considerations:**
- Server sees only encrypted blobs (zero-knowledge)
- Need to choose hosting provider
- Add URL to fallback in `getServerConfig()`

### UR Decoding for Save Formats
**Status:** Planned  
**Description:** Decode UR data to enable additional save formats (plain text descriptors, base64 PSBT, etc.)

**Current State:**
- UR decoding libraries are installed (`@ngraveio/bc-ur`, `@keystonehq/bc-ur-registry-btc`)
- These are Node.js packages that need to be bundled for browser use

**Implementation Options:**
1. **Webpack/Rollup Bundle**: Bundle the libraries for browser use
2. **CDN Version**: Use browser-compatible CDN builds if available
3. **Server-Side Decoding**: Send UR data to server for decoding (less ideal)

**Formats to Enable:**
- `crypto-output` → Plain text descriptor, BSMS, JSON
- `crypto-psbt` → Base64 PSBT, Hex PSBT
- `crypto-hdkey` → Plain text xpub, JSON with derivation path
- `crypto-account` → JSON account export

---

### Nostr Integration
**Status:** Future  
**Description:** Replace custom WebSocket server with Nostr relays for true decentralization.

**Benefits:**
- No server to run or host
- Uses existing public Nostr relay infrastructure
- Same encryption model (NIP-04/44 compatible)
- Truly trustless architecture

**Migration Path:**
- Channel code → Nostr shared secret or pubkey
- WebSocket server → Public Nostr relays
- Same encrypt/decrypt flow

---

## Low Priority / Nice to Have

### Save Format Help/Info Links
**Status:** Planned  
**Description:** Add a help icon or "Learn more" link next to each save format option that explains:
- What the format is
- When to use it
- Which wallets/software support it

**Implementation Options:**
- Inline expandable help text (click to expand)
- Tooltip on hover (info icon)
- Pop-up modal with detailed explanations
- Link to external documentation

**Format Details to Include:**
| Format | Description |
|--------|-------------|
| Raw UR | Universal UR-encoded data, readable by any BC-UR compatible device |
| Plain Text Descriptor | Bitcoin Core-style output descriptor string |
| BSMS (BIP-129) | Bitcoin Secure Multisig Setup file for coordinating multisig |
| Base64 PSBT | Standard BIP-174 PSBT encoding |
| JSON | Structured format with metadata for programmatic use |

---

### QR Animation Speed Control
**Status:** Idea  
**Description:** Let receiver adjust animation speed (currently fixed at 2 seconds per frame).

### Share Channel via QR Code
**Status:** Idea  
**Description:** Generate a QR code containing the channel code + server URL for easy sharing.

### Connection Quality Indicator
**Status:** Idea  
**Description:** Show latency/connection quality to help troubleshoot issues.

### Multiple Receiver Support Indicator
**Status:** Idea  
**Description:** Show sender how many receivers are connected to the channel.

---

## Completed Features

- [x] End-to-end encryption (AES-256-GCM)
- [x] Channel code entry UI
- [x] Connection status indicator (Local/Cloud)
- [x] Configurable WebSocket server URL
- [x] BC-UR2 / UR sequence support
- [x] BBQR sequence support
- [x] Consistent QR error correction levels
- [x] Save dialog with format options (v5.2)

---

*Last updated: 2025-12-04*

