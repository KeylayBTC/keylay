# Native UR (BC-UR) codec — build & verification

`index.html` inlines a native, dependency-free UR codec (bytewords + fountain codes +
minimal CBOR). It is **Keylay's own code**, not a vendored dependency, so it is covered by
the `index.html` release hash rather than by `verify-vendored.mjs`.

## What it decodes / encodes
- PSBT (`ur:crypto-psbt` / `ur:psbt`) and raw tx (`ur:bytes`) — binary payloads.
- Output descriptors: `ur:output-descriptor` (plain text), and the tagged-CBOR trees
  `crypto-output` and `crypto-account` — reconstructed natively to the standard
  `wsh(sortedmulti(...))#checksum` descriptor Sparrow imports (xpubs via base58check,
  key-origin `[fp/path]`, BIP-380 checksum).
- Encode: any payload (PSBT) to an animated UR fountain sequence ("Show as UR").
- Not yet: `crypto-hdkey`, `crypto-seed` (fall back to raw UR text).

## Files
- `ur-native.mjs` — source of truth. The inlined `window.KeylayUR` block in `index.html`
  is generated from this file (wrap in an IIFE, drop the ESM `export`).
- `ur-oracle-test.mjs` — validates `ur-native.mjs` against `@ngraveio/bc-ur` (fountain/
  bytewords/CBOR) and known-good descriptor vectors: SHA-256/CRC-32 vs reference, bytewords
  byte-identical, `chooseFragments` exact over 700+ cases, bc-ur↔native decode with frame
  drops, byte-identical part strings, crypto-output/account → exact descriptor strings, and a
  BIP-380 checksum vector (`raw(deadbeef)#89f8spxm`). 77 assertions.

Descriptor strings were cross-checked against `embit` (the descriptor library used by
SeedSigner/Specter): `python3 -c "from embit.descriptor import Descriptor; Descriptor.from_string(d)"`.

## Run the test
```bash
cd tools
npm init -y                       # once, if no package.json
npm i -D @ngraveio/bc-ur cbor-sync @keystonehq/bc-ur-registry
node ur-oracle-test.mjs           # expect: ALL PASS  pass=77 fail=0
```

## Why native (not the bc-ur bundle)
Bundling `@ngraveio/bc-ur` for the browser is ~200 KB minified (67 KB gzipped) and needs
Buffer/process polyfills — a build artifact that can't get the "byte-identical to a
published file" provenance the other three vendored libs have, and it still doesn't decode
legacy `crypto-output`. The native codec is ~13 KB minified (5.6 KB gzipped), readable, and
carries the same single-file-auditable guarantee as the rest of `index.html`.
