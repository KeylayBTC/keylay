# Dependency provenance

Keylay ships as a single file, `index.html`, with three third-party libraries inlined verbatim. Each is
the **exact bytes** of a published release — nothing is added inside the `<script>` — so the element's
inner content hashes directly to the published file. This page lets anyone confirm that the libraries
running in the app are the audited, published versions.

| Library | Role | Version | Published source | SHA-256 |
|---|---|---|---|---|
| jsQR | QR decoder (parses scanned/relayed QR) | 1.4.0 | `https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js` | `bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859` |
| qrcode | QR encoder (renders data as QR) | 1.5.1 | `https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.js` | `ba588dfaf738bf8980e5da3b680ab1ce3f205af7577454c16f9c0506fe744df4` |
| pako | zlib/DEFLATE (BBQr compression) | 2.1.0 | `https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js` | `ede2693a4a6a5126b9d35669062b358ecab6ae7b9b86a1cf302feb45a8514907` |

## Verify it yourself

Each library sits in a `<script>` preceded by a comment naming it. The bytes between that `<script>` and
its `</script>` are the published file, unmodified. To check:

1. Download the file at the source URL and hash it (`sha256sum <file>` on Linux/macOS, or
   `Get-FileHash -Algorithm SHA256 <file>` on Windows). Confirm it equals the SHA-256 above.
2. Extract the matching `<script>` block's inner content from `index.html` and hash it. Confirm the same value.

There is no banner-stripping or reformatting step — the inlined bytes *are* the published bytes, so the
match is a direct, one-step comparison. `tools/verify-vendored.mjs` performs step 2 for all three and
exits non-zero on any mismatch:

```bash
node tools/verify-vendored.mjs
```

These hashes are also published on the release-verification page, [keylay.org/verify.html](https://keylay.org/verify.html),
next to each release's `index.html` hash, so the whole delivered artifact — the app and its dependencies —
is checkable in one place.

## Maintenance note

jsQR 1.4.0 is the QR *decoder* — the component that parses untrusted scanned and relayed input — and is
effectively unmaintained upstream. It is therefore the dependency we watch most closely and the first
candidate to replace should a defect surface. Disclosed here for transparency.
