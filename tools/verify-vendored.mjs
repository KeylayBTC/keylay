#!/usr/bin/env node
// verify-vendored.mjs — confirm each inlined third-party library in index.html is
// byte-identical to its published upstream release. See PROVENANCE.md for sources.
// Usage:  node tools/verify-vendored.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'));

// Expected upstream SHA-256 (must equal the file at each source URL — re-download and hash to confirm).
const EXPECT = [
  { name: 'jsQR',   ver: '1.4.0', sha: 'bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859' },
  { name: 'qrcode', ver: '1.5.1', sha: 'ba588dfaf738bf8980e5da3b680ab1ce3f205af7577454c16f9c0506fe744df4' },
  { name: 'pako',   ver: '2.1.0', sha: 'ede2693a4a6a5126b9d35669062b358ecab6ae7b9b86a1cf302feb45a8514907' },
];

function innerAfter(labelSub) {
  const i = html.indexOf(Buffer.from(labelSub));
  if (i === -1) return null;
  const s = html.indexOf(Buffer.from('<script'), i);
  const oe = html.indexOf(Buffer.from('>'), s) + 1;
  const c = html.indexOf(Buffer.from('</script>'), oe);
  return html.subarray(oe, c);
}

let ok = true;
for (const { name, ver, sha } of EXPECT) {
  const inner = innerAfter(`${name} ${ver} — vendored verbatim`);
  if (!inner) { console.log(`FAIL ${name} ${ver}: vendored block not found`); ok = false; continue; }
  const got = createHash('sha256').update(inner).digest('hex');
  const pass = got === sha;
  ok = ok && pass;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${ver}  ${got}`);
}
console.log(ok ? '\nAll vendored libraries match their published upstream.' : '\nMISMATCH — a vendored library does not match its recorded hash.');
process.exit(ok ? 0 : 1);
