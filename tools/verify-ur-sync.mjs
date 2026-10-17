#!/usr/bin/env node
// verify-ur-sync.mjs — confirm the window.KeylayUR block inlined in index.html is
// the same code as tools/ur-native.mjs, the file ur-oracle-test.mjs validates.
// See UR-CODEC.md: the inlined block is ur-native.mjs wrapped in an IIFE with the
// ESM `export { ... }` replaced by a `return { ... }`. Only the shared body is compared.
// Usage:  node tools/verify-ur-sync.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const native = readFileSync(join(root, 'tools', 'ur-native.mjs'), 'utf8');

const OPEN = 'window.KeylayUR = (function () {\n';
const start = html.indexOf(OPEN);
const close = start === -1 ? -1 : html.indexOf('\n  })();', start);
const end = close === -1 ? -1 : html.lastIndexOf('\n    return {', close);
const exportAt = native.lastIndexOf('\nexport {');
if (start === -1 || end === -1 || exportAt === -1) {
  console.log('FAIL could not locate the KeylayUR block in index.html or the export in ur-native.mjs');
  process.exit(1);
}

const inlined = html.slice(start + OPEN.length, end).trimEnd();
const body = native.slice(0, exportAt).trimEnd();
if (inlined === body) {
  console.log('PASS index.html KeylayUR block matches tools/ur-native.mjs');
  process.exit(0);
}

const a = inlined.split('\n'), b = body.split('\n');
let i = 0;
while (i < a.length && i < b.length && a[i] === b[i]) i++;
console.log(`FAIL index.html KeylayUR block differs from tools/ur-native.mjs at line ${i + 1} of the block`);
console.log(`  index.html:    ${a[i] ?? '<end of block>'}`);
console.log(`  ur-native.mjs: ${b[i] ?? '<end of file>'}`);
process.exit(1);
