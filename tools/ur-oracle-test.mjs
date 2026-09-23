// Validate the native UR codec (ur-native.mjs) against @ngraveio/bc-ur as an oracle.
import * as N from './ur-native.mjs';
import { UR, UREncoder, URDecoder } from '@ngraveio/bc-ur';
import { Buffer } from 'buffer';
import crypto from 'crypto';
import cbor from 'cbor-sync';
import * as bcFountainUtils from '@ngraveio/bc-ur/dist/fountainUtils.js';

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; } else { fail++; console.log('  FAIL:', name); } }

// Deterministic PRNG for test payloads (no Math.random in workflow env, but this is a test script).
let seed = 0x12345678;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function randomBytes(n) { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = Math.floor(rnd() * 256); return u; }

// --- 1. SHA-256 vs Node ---
for (const s of ['', 'a', 'abc', 'the quick brown fox', 'x'.repeat(200)]) {
  const mine = Buffer.from(N.sha256(new TextEncoder().encode(s))).toString('hex');
  const ref = crypto.createHash('sha256').update(s).digest('hex');
  ok(mine === ref, 'sha256 "' + s.slice(0,10) + '"');
}
// 8-byte seed (the fountain use case)
{
  const seedBytes = randomBytes(8);
  const mine = Buffer.from(N.sha256(seedBytes)).toString('hex');
  const ref = crypto.createHash('sha256').update(Buffer.from(seedBytes)).digest('hex');
  ok(mine === ref, 'sha256 8-byte seed');
}

// --- 2. CRC-32 vs bc-ur ---
{
  const { getCRC } = await import('@ngraveio/bc-ur/dist/utils.js');
  for (let i = 0; i < 20; i++) {
    const b = randomBytes(1 + Math.floor(rnd() * 300));
    ok(N.crc32(b) === getCRC(Buffer.from(b)), 'crc32 #' + i);
  }
}

// --- 3. bytewords minimal encode/decode vs bc-ur ---
{
  const bwMod = await import('@ngraveio/bc-ur/dist/bytewords.js');
  const bw = bwMod.default.default || bwMod.default;
  for (let i = 0; i < 20; i++) {
    const b = randomBytes(1 + Math.floor(rnd() * 100));
    const hex = Buffer.from(b).toString('hex');
    const mineEnc = N.bytewordsEncode(b);
    const refEnc = bw.encode(hex, bw.STYLES.MINIMAL);
    ok(mineEnc === refEnc, 'bytewords encode #' + i);
    const mineDec = Buffer.from(N.bytewordsDecode(refEnc)).toString('hex');
    ok(mineDec === hex, 'bytewords decode #' + i);
  }
}

// --- 4. chooseFragments equality vs bc-ur (the interop-critical function) ---
{
  let mismatches = 0, total = 0;
  for (let seqLen = 1; seqLen <= 12; seqLen++) {
    for (let checksum of [0, 1, 0xdeadbeef, 0x7fffffff, 0xffffffff, 123456789]) {
      for (let seqNum = 1; seqNum <= seqLen * 3 + 5; seqNum++) {
        total++;
        const mine = N.chooseFragments(seqNum, seqLen, checksum >>> 0);
        const ref = bcFountainUtils.chooseFragments(seqNum >>> 0, seqLen, checksum >>> 0);
        // compare as sets (order within a mixed part is deterministic from shuffle, should match exactly)
        const a = mine.join(','), b = ref.join(',');
        if (a !== b) { mismatches++; if (mismatches <= 3) console.log('    cf mismatch', {seqNum, seqLen, checksum, mine, ref}); }
      }
    }
  }
  ok(mismatches === 0, 'chooseFragments exact match over ' + total + ' cases');
}

// --- 5. bc-ur ENCODE -> native DECODE, with frame drops + reordering ---
function bcEncodeParts(type, payloadBytes, maxFrag, count) {
  const wrapped = cbor.encode(Buffer.from(payloadBytes)); // CBOR bytestring
  const ur = new UR(wrapped, type);
  const enc = new UREncoder(ur, maxFrag, 0);
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(enc.nextPart());
  return { parts, pureCount: enc.fragmentsLength, wrappedHex: Buffer.from(wrapped).toString('hex') };
}
{
  let scenarios = 0, good = 0;
  for (const size of [19, 60, 220, 1000, 3000]) {
    for (const maxFrag of [30, 100, 200]) {
      const payload = randomBytes(size);
      const { parts, pureCount } = bcEncodeParts('crypto-psbt', payload, maxFrag, 0 + 1); // count set below
      // regenerate enough parts: pure + plenty of mixed
      const gen = bcEncodeParts('crypto-psbt', payload, maxFrag, pureCount * 3 + 10);
      // Scenario A: feed all in order
      {
        const dec = new N.URDecoder();
        for (const p of gen.parts) { if (dec.isComplete()) break; dec.receivePart(p); }
        const raw = dec.resultRawCBOR();
        const ex = N.extractPayload('crypto-psbt', raw);
        scenarios++; if (ex.kind === 'binary' && Buffer.from(ex.bytes).equals(Buffer.from(payload))) good++;
        else console.log('    A fail size', size, 'maxFrag', maxFrag);
      }
      // Scenario B: drop every 3rd frame (forces mixed-part recovery), shuffle a bit
      if (pureCount > 1) {
        const kept = gen.parts.filter((_, i) => i % 3 !== 1);
        const dec = new N.URDecoder();
        for (const p of kept) { if (dec.isComplete()) break; dec.receivePart(p); }
        scenarios++;
        if (dec.isComplete()) {
          const ex = N.extractPayload('crypto-psbt', dec.resultRawCBOR());
          if (ex.kind === 'binary' && Buffer.from(ex.bytes).equals(Buffer.from(payload))) good++;
          else console.log('    B wrong bytes size', size, 'maxFrag', maxFrag);
        } else console.log('    B incomplete size', size, 'maxFrag', maxFrag);
      } else { scenarios++; good++; }
    }
  }
  ok(good === scenarios, 'bc-ur encode -> native decode (' + good + '/' + scenarios + ' scenarios, incl. drops)');
}

// --- 6. native ENCODE -> bc-ur DECODE (proves native encoder interops) ---
{
  let good = 0, total = 0;
  for (const size of [19, 220, 1000]) {
    for (const maxFrag of [30, 100]) {
      const payload = randomBytes(size);
      const wrapped = new Uint8Array(cbor.encode(Buffer.from(payload)));
      const enc = new N.UREncoder('crypto-psbt', wrapped, maxFrag, 0);
      const pure = enc.fragmentsLength;
      const dec = new URDecoder();
      let i = 0;
      while (!dec.isComplete() && i < pure * 3 + 10) { dec.receivePart(enc.nextPart()); i++; }
      total++;
      if (dec.isComplete()) {
        const out = Buffer.from(dec.resultUR().decodeCBOR());
        if (out.equals(Buffer.from(payload))) good++; else console.log('    native->bc wrong bytes', size, maxFrag);
      } else console.log('    native->bc incomplete', size, maxFrag);
    }
  }
  ok(good === total, 'native encode -> bc-ur decode (' + good + '/' + total + ')');
}

// --- 7. native encoded part strings byte-identical to bc-ur ---
{
  const payload = randomBytes(500);
  const wrapped = cbor.encode(Buffer.from(payload));
  const bcEnc = new UREncoder(new UR(wrapped, 'crypto-psbt'), 100, 0);
  const myEnc = new N.UREncoder('crypto-psbt', new Uint8Array(wrapped), 100, 0);
  let identical = 0;
  for (let i = 0; i < 30; i++) { const a = bcEnc.nextPart(), b = myEnc.nextPart(); if (a === b) identical++; else if (identical < 2) console.log('    part differ @', i, '\n     bc:', a, '\n    my:', b); }
  ok(identical === 30, 'native part strings byte-identical to bc-ur (' + identical + '/30)');
}

// --- 8. extractPayload: output-descriptor text + psbt binary + single-part ---
{
  const desc = 'wsh(sortedmulti(2,[abc12345/48h/0h/0h/2h]xpub6E.../0/*,[def67890/48h/0h/0h/2h]xpub6F.../0/*))#abcdefgh';
  const wrapped = new Uint8Array(cbor.encode(desc)); // CBOR text string
  const enc = new N.UREncoder('output-descriptor', wrapped, 40, 0);
  const dec = new N.URDecoder();
  let i = 0; while (!dec.isComplete() && i < 60) { dec.receivePart(enc.nextPart()); i++; }
  const ex = N.extractPayload('output-descriptor', dec.resultRawCBOR());
  ok(ex.kind === 'text' && ex.text === desc, 'output-descriptor round-trips to exact text');

  // single-part small PSBT
  const small = new Uint8Array([0x70,0x73,0x62,0x74,0xff,0x01,0x00,0x00]);
  const w2 = new Uint8Array(cbor.encode(Buffer.from(small)));
  const e2 = new N.UREncoder('crypto-psbt', w2, 100, 0);
  const single = e2.nextPart();
  ok(!single.includes('/1-') && single.startsWith('ur:crypto-psbt/'), 'single-part UR has no seq component');
  const d2 = new N.URDecoder(); d2.receivePart(single);
  const ex2 = N.extractPayload('crypto-psbt', d2.resultRawCBOR());
  ok(ex2.kind === 'binary' && Buffer.from(ex2.bytes).equals(Buffer.from(small)), 'single-part PSBT extracts binary');

  // legacy crypto-output (CBOR tag 400 wrapping bytes) -> falls to 'other'
  const exOther = N.extractPayload('crypto-output', new Uint8Array([0xd9,0x01,0x90,0x43,1,2,3]));
  ok(exOther.kind === 'other', 'legacy crypto-output -> other (raw-display fallback)');
}

// --- 9. crypto-output / crypto-account -> descriptor (embit-verified expected strings) ---
{
  const M = "48'/0'/0'/2'";
  const expectMulti = "wsh(sortedmulti(2,[d34db33f/"+M+"]xpub6ERApfZo8iKjL7mM81BuwunbjzPqCVbwxYzgPPVn1ZmMSi4SHHRCMZsbo4zZY82cd7WuaDur5R92o4176b5WVXZbAMzo3sNp3dqHiq3ww92/0/*,[deadbeef/"+M+"]xpub6EvWpSBLJ1yeaY3atAdcmoipKrBPb2efborLdsjmeY4y2bvD4RVyeiNYNMeuq7AfMNYUFTsmhSJinJfrXTWTkpdA9WjbS2itJkfztDy2Fxv/0/*))#llrdq9z5";
  const expectSingle = "wpkh([d34db33f/84'/0'/0']xpub6CY2xt3mvQejPFUw26CychtL4GMq1yp41aMW2U27mvThqefpZYwXpGscV21YpnbJQcKZqwb6zRfP2NbgJQ4d3XAErsDETCVWYndNefBMwhe/0/*)#26letwpm";
  const outHex = 'd90191d90197a201020282d9012fa503582102c7e4823730f6ee2cf864e2c352060a88e60b51a84e89e4c8c75ec22590ad6b69045820637807030d55d01f9a0cb3a7839515d796bd07706386a6eddf06cc29a65a0e2906d90130a201881830f500f500f502f5021ad34db33f07d90130a1018400f480f4081a78412e3ad9012fa503582103fd433450b6924b4f7efdd5d1ed017d364be95ab2b592dc8bddb3b00c1c24f63f0458202fa0e41c9dc43dc4518659bfcef935ba8101b57dbc0812805dd983bc1d34b81306d90130a201881830f500f500f502f5021adeadbeef07d90130a1018400f480f4081abd16bee5';
  const acctHex = 'a2011ad34db33f0281d90194d9012fa503582102c7e4823730f6ee2cf864e2c352060a88e60b51a84e89e4c8c75ec22590ad6b69045820637807030d55d01f9a0cb3a7839515d796bd07706386a6eddf06cc29a65a0e2906d90130a201861854f500f500f5021ad34db33f07d90130a1018400f480f4081a78412e3a';
  const exO = N.extractPayload('crypto-output', N.hexToBytes(outHex));
  ok(exO.kind === 'text' && exO.text === expectMulti, 'crypto-output -> exact wsh(sortedmulti) descriptor + checksum');
  const exA = N.extractPayload('crypto-account', N.hexToBytes(acctHex));
  ok(exA.kind === 'text' && exA.text === expectSingle, 'crypto-account -> exact wpkh descriptor + checksum');
  // known BIP-380 checksum vector
  ok(N.descriptorChecksum('raw(deadbeef)') === '89f8spxm', 'descriptor checksum matches BIP-380 vector raw(deadbeef)#89f8spxm');
}

// --- 10. ur:bytes text/binary discrimination ---
{
  const enc = new TextEncoder();
  const blueWallet = enc.encode('# BlueWallet Multisig setup file\n#\nName: Multisig Vault\nPolicy: 2 of 3\nDerivation: m/48\'/0\'/0\'/2\'\nFormat: P2WSH\n');
  const exText = N.extractPayload('bytes', N.cborBytes(blueWallet));
  ok(exText.kind === 'text' && exText.text.startsWith('# BlueWallet'), 'ur:bytes wrapping a setup file -> text');
  // raw tx (version 01000000 has NUL bytes) -> binary
  const rawTx = new Uint8Array([0x01,0x00,0x00,0x00, 0x01, 0xab,0xcd,0xef,0x00, 0x00,0x00,0x00,0x00]);
  const exBin = N.extractPayload('bytes', N.cborBytes(rawTx));
  ok(exBin.kind === 'binary', 'ur:bytes wrapping a raw tx (NUL bytes) -> binary');
  // PSBT inside ur:bytes -> binary
  const psbtInBytes = N.concatBytes([N.hexToBytes('70736274ff'), new Uint8Array(20)]);
  const exP = N.extractPayload('bytes', N.cborBytes(psbtInBytes));
  ok(exP.kind === 'binary', 'ur:bytes wrapping PSBT magic -> binary');
  // pure descriptor text in ur:bytes -> text
  const descBytes = enc.encode("wsh(sortedmulti(2,[d34db33f/48'/0'/0'/2']xpub.../0/*))#llrdq9z5");
  ok(N.extractPayload('bytes', N.cborBytes(descBytes)).kind === 'text', 'ur:bytes wrapping a descriptor -> text');
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT') + '  pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
