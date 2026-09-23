// ============================================================================
// Native UR (Uniform Resources / BC-UR) codec for Keylay
// ----------------------------------------------------------------------------
// A dependency-free port of the parts of @ngraveio/bc-ur that Keylay needs:
//   - bytewords (minimal style) encode/decode with CRC-32 checksum
//   - fountain-code decode (pure + mixed parts) and encode
//   - just enough CBOR for the fountain part header and for unwrapping
//     crypto-psbt / ur:bytes (byte strings) and ur:output-descriptor (text)
//
// Algorithm is ported faithfully from bc-ur so it interoperates with real
// wallets (Sparrow, Keystone, Passport, Jade, Nunchuk). Correctness is checked
// against bc-ur itself as an oracle in ur-oracle-test.mjs.
//
// Browser-target: uses Uint8Array + native BigInt only. No Node Buffer.
// ============================================================================

// ---------- byte helpers ----------
function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
  return s;
}
function hexToBytes(hex) {
  const len = hex.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
// big-endian uint32 -> 4 bytes
function intToBytes(num) {
  const u8 = new Uint8Array(4);
  new DataView(u8.buffer).setUint32(0, num >>> 0, false);
  return u8;
}

// ---------- CRC-32 (ISO-HDLC, reflected, poly 0xEDB88320) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------- SHA-256 (synchronous; used only to seed the fountain PRNG) ----------
const SHA_K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function sha256(msg) {
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const l = msg.length;
  const withOne = new Uint8Array((((l + 8) >> 6) + 1) << 6);
  withOne.set(msg);
  withOne[l] = 0x80;
  const bitLen = l * 8;
  const dv = new DataView(withOne.buffer);
  dv.setUint32(withOne.length - 4, bitLen >>> 0, false);
  dv.setUint32(withOne.length - 8, Math.floor(bitLen / 0x100000000), false);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < withOne.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3);
      const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) >>> 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+hh)>>>0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i], false);
  return out;
}

// ---------- Bytewords (minimal style) ----------
const BYTEWORDS = 'ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom';
let BW_LOOKUP = null;
function bwGetWord(index) { return BYTEWORDS.slice(index * 4, index * 4 + 4); }
function bwBuildLookup() {
  BW_LOOKUP = new Int16Array(26 * 26).fill(-1);
  for (let i = 0; i < 256; i++) {
    const w = bwGetWord(i);
    const x = w.charCodeAt(0) - 97;
    const y = w.charCodeAt(3) - 97;
    BW_LOOKUP[y * 26 + x] = i;
  }
}
// encode raw bytes -> minimal bytewords (2 chars/byte), appending a CRC-32 of the body
function bytewordsEncode(bodyBytes) {
  const crc = intToBytes(crc32(bodyBytes));
  const full = concatBytes([bodyBytes, crc]);
  let s = '';
  for (let i = 0; i < full.length; i++) {
    const w = bwGetWord(full[i]);
    s += w[0] + w[3];
  }
  return s;
}
// decode minimal bytewords -> raw bytes (verifies + strips the CRC-32 checksum)
function bytewordsDecode(str) {
  if (!BW_LOOKUP) bwBuildLookup();
  if (str.length % 2 !== 0) throw new Error('bytewords: odd length');
  const n = str.length / 2;
  const decoded = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = str.charCodeAt(i * 2) - 97;
    const y = str.charCodeAt(i * 2 + 1) - 97;
    if (x < 0 || x >= 26 || y < 0 || y >= 26) throw new Error('bytewords: invalid letters');
    const v = BW_LOOKUP[y * 26 + x];
    if (v === -1) throw new Error('bytewords: word not in table');
    decoded[i] = v;
  }
  if (decoded.length < 5) throw new Error('bytewords: too short');
  const body = decoded.slice(0, -4);
  const bodyChecksum = decoded.slice(-4);
  const computed = intToBytes(crc32(body));
  if (!bytesEqual(computed, bodyChecksum)) throw new Error('bytewords: bad checksum');
  return body;
}

// ---------- Minimal CBOR ----------
// Encode an unsigned int with the given major type (0 = uint, 2 = bytes, 3 = text).
function cborHead(major, value) {
  const mt = major << 5;
  if (value < 24) return new Uint8Array([mt | value]);
  if (value < 0x100) return new Uint8Array([mt | 24, value]);
  if (value < 0x10000) return new Uint8Array([mt | 25, value >> 8, value & 0xff]);
  return new Uint8Array([mt | 26, (value>>>24)&0xff, (value>>>16)&0xff, (value>>>8)&0xff, value&0xff]);
}
function cborUint(v) { return cborHead(0, v); }
function cborBytes(u8) { return concatBytes([cborHead(2, u8.length), u8]); }
function cborText(str) {
  const u8 = new TextEncoder().encode(str);
  return concatBytes([cborHead(3, u8.length), u8]);
}
// Encode the fountain part array [seqNum, seqLen, msgLen, checksum, fragment(bytes)]
function cborEncodePart(seqNum, seqLen, msgLen, checksum, fragment) {
  return concatBytes([
    new Uint8Array([0x85]), // array(5)
    cborUint(seqNum), cborUint(seqLen), cborUint(msgLen), cborUint(checksum),
    cborBytes(fragment),
  ]);
}
// Minimal CBOR reader. Returns {value, next}. Handles uint, bytes, text, array; tags -> {tag}.
function cborRead(bytes, pos) {
  const ib = bytes[pos];
  const major = ib >> 5;
  const info = ib & 0x1f;
  let p = pos + 1;
  let len;
  if (info < 24) len = info;
  else if (info === 24) { len = bytes[p]; p += 1; }
  else if (info === 25) { len = (bytes[p] << 8) | bytes[p+1]; p += 2; }
  else if (info === 26) { len = ((bytes[p]<<24)|(bytes[p+1]<<16)|(bytes[p+2]<<8)|bytes[p+3]) >>> 0; p += 4; }
  else throw new Error('cbor: unsupported length encoding ' + info);
  if (major === 0) return { value: len, next: p };
  if (major === 2) { const v = bytes.slice(p, p + len); return { value: v, next: p + len }; }
  if (major === 3) { const v = new TextDecoder().decode(bytes.slice(p, p + len)); return { value: v, next: p + len, isText: true }; }
  if (major === 4) {
    const arr = [];
    for (let i = 0; i < len; i++) { const r = cborRead(bytes, p); arr.push(r.value); p = r.next; }
    return { value: arr, next: p, isArray: true };
  }
  if (major === 5) { // map -> Map
    const m = new Map();
    for (let i = 0; i < len; i++) { const k = cborRead(bytes, p); const v = cborRead(bytes, k.next); m.set(k.value, v.value); p = v.next; }
    return { value: m, next: p, isMap: true };
  }
  if (major === 6) { // tag -> { tag, val } (content decoded)
    const inner = cborRead(bytes, p);
    return { value: { tag: len, val: inner.value }, next: inner.next, isTag: true };
  }
  if (major === 7) { // simple: 20=false 21=true 22=null 23=undefined
    if (info === 20) return { value: false, next: p };
    if (info === 21) return { value: true, next: p };
    if (info === 22) return { value: null, next: p };
    if (info === 23) return { value: undefined, next: p };
    throw new Error('cbor: unsupported simple value ' + info);
  }
  throw new Error('cbor: unsupported major type ' + major);
}
function cborDecodePart(bytes) {
  const r = cborRead(bytes, 0);
  if (!r.isArray || r.value.length !== 5) throw new Error('cbor: not a 5-element part array');
  const [seqNum, seqLen, msgLen, checksum, fragment] = r.value;
  if (!(fragment instanceof Uint8Array)) throw new Error('cbor: fragment not bytes');
  return { seqNum, seqLen, msgLen, checksum, fragment };
}

// ---------- xoshiro256** PRNG (seeded by sha256) ----------
const MASK64 = (1n << 64n) - 1n;
function rotl64(x, k) { return ((x << BigInt(k)) | (x >> BigInt(64 - k))) & MASK64; }
class Xoshiro {
  constructor(seed) {
    const d = sha256(seed);
    this.s = [0n, 0n, 0n, 0n];
    for (let i = 0; i < 4; i++) {
      let v = 0n;
      for (let n = 0; n < 8; n++) v = ((v << 8n) | BigInt(d[i*8+n])) & MASK64;
      this.s[i] = v;
    }
  }
  roll() {
    const s = this.s;
    const result = (rotl64((s[1] * 5n) & MASK64, 7) * 9n) & MASK64;
    const t = (s[1] << 17n) & MASK64;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t; s[3] = rotl64(s[3], 45);
    return result;
  }
  // Number(roll)/2^64 reproduces bc-ur's BigNumber(roll).div(2^64) coerced to float
  // exactly, because scaling by a power of two is lossless in IEEE-754.
  nextDouble() { return Number(this.roll()) / 18446744073709551616; }
  nextInt(low, high) { return Math.floor(this.nextDouble() * (high - low + 1) + low); }
}

// ---------- alias sampling (chooseDegree) ----------
function precomputeAlias(p, n) {
  const sum = p.reduce((a, v) => a + v, 0);
  const scaled = p.map(x => (x * n) / sum);
  const prob = new Array(n), alias = new Array(n);
  const small = [], large = [];
  for (let i = n - 1; i >= 0; i--) (scaled[i] < 1 ? small : large).push(i);
  while (small.length && large.length) {
    const less = small.pop(), more = large.pop();
    prob[less] = scaled[less]; alias[less] = more;
    scaled[more] = (scaled[more] + scaled[less]) - 1;
    (scaled[more] < 1 ? small : large).push(more);
  }
  while (large.length) prob[large.pop()] = 1;
  while (small.length) prob[small.pop()] = 1;
  return { prob, alias };
}
function aliasDraw(aliasData, rng) {
  const c = Math.floor(rng() * aliasData.prob.length);
  return (rng() < aliasData.prob[c]) ? c : aliasData.alias[c];
}
function chooseDegree(seqLength, rng) {
  const probs = [];
  for (let i = 0; i < seqLength; i++) probs.push(1 / (i + 1));
  const aliasData = precomputeAlias(probs, seqLength);
  return aliasDraw(aliasData, () => rng.nextDouble()) + 1;
}
function shuffle(items, rng) {
  const remaining = items.slice();
  const result = [];
  while (remaining.length > 0) {
    const index = rng.nextInt(0, remaining.length - 1);
    result.push(remaining[index]);
    remaining.splice(index, 1);
  }
  return result;
}
function chooseFragments(seqNum, seqLength, checksum) {
  if (seqNum <= seqLength) return [seqNum - 1];
  const seed = concatBytes([intToBytes(seqNum), intToBytes(checksum)]);
  const rng = new Xoshiro(seed);
  const degree = chooseDegree(seqLength, rng);
  const indexes = [];
  for (let i = 0; i < seqLength; i++) indexes.push(i);
  return shuffle(indexes, rng).slice(0, degree);
}

// ---------- set helpers for fountain reduction ----------
function arrayContains(outer, inner) { return inner.every(v => outer.includes(v)); }
function arraysEqualUnordered(a, b) { return a.length === b.length && a.every(x => b.includes(x)); }
function setDifference(a, b) { return a.filter(x => b.indexOf(x) < 0); }
function xorInto(a, b) {
  const len = Math.max(a.length, b.length);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (a[i] || 0) ^ (b[i] || 0);
  return out;
}

// ---------- Fountain decoder (port of bc-ur FountainDecoder) ----------
class FountainDecoder {
  constructor() {
    this.result = undefined; this.error = undefined;
    this.expectedMessageLength = 0; this.expectedChecksum = 0; this.expectedFragmentLength = 0;
    this.processedPartsCount = 0;
    this.expectedPartIndexes = []; this.queuedParts = [];
    this.receivedPartIndexes = []; this.mixedParts = []; this.simpleParts = [];
  }
  validatePart(part) {
    if (this.expectedPartIndexes.length === 0) {
      for (let i = 0; i < part.seqLen; i++) this.expectedPartIndexes.push(i);
      this.expectedMessageLength = part.msgLen;
      this.expectedChecksum = part.checksum;
      this.expectedFragmentLength = part.fragment.length;
    } else {
      if (this.expectedPartIndexes.length !== part.seqLen) return false;
      if (this.expectedMessageLength !== part.msgLen) return false;
      if (this.expectedChecksum !== part.checksum) return false;
      if (this.expectedFragmentLength !== part.fragment.length) return false;
    }
    return true;
  }
  reducePartByPart(a, b) {
    if (arrayContains(a.indexes, b.indexes)) {
      return { indexes: setDifference(a.indexes, b.indexes), fragment: xorInto(a.fragment, b.fragment) };
    }
    return a;
  }
  reduceMixedBy(part) {
    const newMixed = [];
    for (const { value: mixedPart } of this.mixedParts) {
      const reduced = this.reducePartByPart(mixedPart, part);
      if (reduced.indexes.length === 1) this.queuedParts.push(reduced);
      else newMixed.push({ key: reduced.indexes, value: reduced });
    }
    this.mixedParts = newMixed;
  }
  processSimplePart(part) {
    const fragmentIndex = part.indexes[0];
    if (this.receivedPartIndexes.includes(fragmentIndex)) return;
    this.simpleParts.push({ key: part.indexes, value: part });
    this.receivedPartIndexes.push(fragmentIndex);
    if (arraysEqualUnordered(this.receivedPartIndexes, this.expectedPartIndexes)) {
      const sorted = this.simpleParts.map(p => p.value).sort((a, b) => a.indexes[0] - b.indexes[0]);
      const message = concatBytes(sorted.map(p => p.fragment)).slice(0, this.expectedMessageLength);
      if (crc32(message) === this.expectedChecksum) this.result = message;
      else this.error = new Error('invalid checksum');
    } else {
      this.reduceMixedBy(part);
    }
  }
  processMixedPart(part) {
    if (this.mixedParts.some(({ key }) => arraysEqualUnordered(key, part.indexes))) return;
    let p2 = part;
    for (const { value: p } of this.simpleParts) p2 = this.reducePartByPart(p2, p);
    for (const { value: p } of this.mixedParts) p2 = this.reducePartByPart(p2, p);
    if (p2.indexes.length === 1) this.queuedParts.push(p2);
    else { this.reduceMixedBy(p2); this.mixedParts.push({ key: p2.indexes, value: p2 }); }
  }
  processQueuedItem() {
    const part = this.queuedParts.shift();
    if (part.indexes.length === 1) this.processSimplePart(part);
    else this.processMixedPart(part);
  }
  receivePart(part) {
    if (this.isComplete()) return false;
    if (!this.validatePart(part)) return false;
    const indexes = chooseFragments(part.seqNum, part.seqLen, part.checksum);
    this.queuedParts.push({ indexes, fragment: part.fragment });
    while (!this.isComplete() && this.queuedParts.length > 0) this.processQueuedItem();
    this.processedPartsCount += 1;
    return true;
  }
  isComplete() { return this.result !== undefined && this.result.length > 0; }
  isSuccess() { return this.error === undefined && this.isComplete(); }
  expectedPartCount() { return this.expectedPartIndexes.length; }
  getProgress() {
    const e = this.expectedPartCount();
    return this.isComplete() ? 1 : (e === 0 ? 0 : this.receivedPartIndexes.length / e);
  }
}

// ---------- UR decoder (parse ur: frames, feed the fountain decoder) ----------
class URDecoder {
  constructor() { this.fountain = new FountainDecoder(); this.type = null; this.result = undefined; this.error = undefined; }
  static parse(message) {
    const lower = message.toLowerCase();
    if (lower.slice(0, 3) !== 'ur:') throw new Error('not a ur: string');
    const components = lower.slice(3).split('/');
    const type = components[0];
    if (components.length < 2) throw new Error('ur: missing body');
    return [type, components.slice(1)];
  }
  receivePart(s) {
    if (this.result !== undefined) return false;
    const [type, components] = URDecoder.parse(s);
    if (this.type === null) this.type = type;
    else if (this.type !== type) return false;
    if (components.length === 1) {
      // single-part UR: body is the whole CBOR payload
      this.result = { type, payload: bytewordsDecode(components[0]) };
      return true;
    }
    const seq = components[0].split('-');
    const seqNum = Number(seq[0]) >>> 0;
    const seqLen = Number(seq[1]);
    if (seqNum < 1 || seqLen < 1) return false;
    const partBytes = bytewordsDecode(components[1]);
    const part = cborDecodePart(partBytes);
    if (seqNum !== part.seqNum || seqLen !== part.seqLen) return false;
    if (!this.fountain.receivePart(part)) return false;
    if (this.fountain.isSuccess()) this.result = { type, payload: this.fountain.result };
    else if (this.fountain.error) this.error = this.fountain.error;
    return true;
  }
  isComplete() { return this.result !== undefined; }
  isSuccess() { return this.error === undefined && this.isComplete(); }
  getProgress() { return this.fountain.getProgress(); }
  expectedPartCount() { return this.fountain.expectedPartCount(); }
  // The reassembled CBOR payload (the UR's `cbor`), as raw bytes.
  resultRawCBOR() { return this.result ? this.result.payload : new Uint8Array(0); }
}

// ---------- Fountain encoder (port of bc-ur FountainEncoder) ----------
function findNominalFragmentLength(messageLength, minLen, maxLen) {
  const maxCount = Math.ceil(messageLength / minLen);
  let fragmentLength = 0;
  for (let count = 1; count <= maxCount; count++) {
    fragmentLength = Math.ceil(messageLength / count);
    if (fragmentLength <= maxLen) break;
  }
  return fragmentLength;
}
function partitionMessage(message, fragmentLength) {
  const fragments = [];
  for (let i = 0; i < message.length; i += fragmentLength) {
    const frag = new Uint8Array(fragmentLength);
    frag.set(message.slice(i, i + fragmentLength));
    fragments.push(frag);
  }
  return fragments;
}
class FountainEncoder {
  constructor(message, maxFragmentLength = 100, firstSeqNum = 0, minFragmentLength = 10) {
    const fragmentLength = findNominalFragmentLength(message.length, minFragmentLength, maxFragmentLength);
    this.messageLength = message.length;
    this.fragments = partitionMessage(message, fragmentLength);
    this.fragmentLength = fragmentLength;
    this.seqNum = firstSeqNum >>> 0;
    this.checksum = crc32(message);
  }
  get fragmentsLength() { return this.fragments.length; }
  isSinglePart() { return this.fragments.length === 1; }
  mix(indexes) {
    let result = new Uint8Array(this.fragmentLength);
    for (const index of indexes) result = xorInto(this.fragments[index], result);
    return result;
  }
  nextPart() {
    this.seqNum = (this.seqNum + 1) >>> 0;
    const indexes = chooseFragments(this.seqNum, this.fragments.length, this.checksum);
    const mixed = this.mix(indexes);
    return { seqNum: this.seqNum, seqLen: this.fragments.length, messageLength: this.messageLength, checksum: this.checksum, fragment: mixed };
  }
}
class UREncoder {
  constructor(type, cborPayload, maxFragmentLength = 100, firstSeqNum = 0, minFragmentLength = 10) {
    this.type = type;
    this.cbor = cborPayload;
    this.fountain = new FountainEncoder(cborPayload, maxFragmentLength, firstSeqNum, minFragmentLength);
  }
  get fragmentsLength() { return this.fountain.fragmentsLength; }
  nextPart() {
    const part = this.fountain.nextPart();
    if (this.fountain.isSinglePart()) {
      return 'ur:' + this.type + '/' + bytewordsEncode(this.cbor);
    }
    const seq = part.seqNum + '-' + part.seqLen;
    const partCbor = cborEncodePart(part.seqNum, part.seqLen, part.messageLength, part.checksum, part.fragment);
    return 'ur:' + this.type + '/' + seq + '/' + bytewordsEncode(partCbor);
  }
}

// ---------- crypto-output / crypto-account -> BIP-380 output descriptor ----------
// Reconstructs the standard descriptor string (with [key-origin] and #checksum) that
// coordinators like Sparrow import, from the tagged-CBOR tree that Nunchuk/Keystone emit.
// Verified against @keystonehq/bc-ur-registry (structure) and embit (checksum/parse).
const _B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58encode(bytes) {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let s = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) s += _B58[digits[i]];
  return s;
}
function base58check(payload) {
  const chk = sha256(sha256(payload)).slice(0, 4);
  return base58encode(concatBytes([payload, chk]));
}
// BIP-380 descriptor checksum (64-bit polymod — BigInt is required).
const _CHK_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const _CHK_INPUT = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
function descriptorChecksum(desc) {
  const M = (1n << 40n) - 1n;
  const poly = (c, val) => {
    const c0 = c >> 35n;
    c = (((c & 0x7ffffffffn) << 5n) ^ BigInt(val)) & M;
    if (c0 & 1n) c ^= 0xf5dee51989n;
    if (c0 & 2n) c ^= 0xa9fdca3312n;
    if (c0 & 4n) c ^= 0x1bab10e32dn;
    if (c0 & 8n) c ^= 0x3706b1677an;
    if (c0 & 16n) c ^= 0x644d626ffdn;
    return c & M;
  };
  let c = 1n, cls = 0, clscount = 0;
  for (const ch of desc) {
    const pos = _CHK_INPUT.indexOf(ch);
    if (pos < 0) return null;
    c = poly(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    if (++clscount === 3) { c = poly(c, cls); cls = 0; clscount = 0; }
  }
  if (clscount > 0) c = poly(c, cls);
  for (let j = 0; j < 8; j++) c = poly(c, 0);
  c ^= 1n;
  let ret = '';
  for (let j = 0; j < 8; j++) ret += _CHK_CHARSET[Number((c >> (5n * BigInt(7 - j))) & 31n)];
  return ret;
}
const _SCRIPT_TAGS = { 400:'sh',401:'wsh',402:'pk',403:'pkh',404:'wpkh',405:'combo',406:'multi',407:'sortedmulti',408:'raw',409:'tapscript',410:'cosigner' };
const _isTag = x => x && typeof x === 'object' && !(x instanceof Map) && !Array.isArray(x) && 'tag' in x;
function _fpHex(u) { return (u >>> 0).toString(16).padStart(8, '0'); }
function _keypathToString(kpMap) {
  const comps = kpMap.get(1) || [];
  const parts = [];
  for (let i = 0; i < comps.length; i += 2) {
    const idx = comps[i], hard = comps[i + 1];
    if (idx === undefined || Array.isArray(idx)) parts.push('*' + (hard ? "'" : ''));
    else parts.push(idx + (hard ? "'" : ''));
  }
  return parts.join('/');
}
function _hdkeyToFragment(m) {
  const key = m.get(3), chainCode = m.get(4), useInfo = m.get(5);
  const originT = m.get(6), childrenT = m.get(7), parentFp = m.get(8);
  const origin = originT && originT.val, children = childrenT && childrenT.val;
  let version = hexToBytes('0488b21e'); // xpub (mainnet)
  if (useInfo && useInfo.val && useInfo.val.get && useInfo.val.get(2) === 1) version = hexToBytes('043587cf'); // tpub
  const comps = origin ? (origin.get(1) || []) : [];
  const depth = comps.length / 2;
  let childNumber = 0;
  if (depth > 0) {
    const lastIdx = comps[comps.length - 2], lastHard = comps[comps.length - 1];
    childNumber = (((lastIdx >>> 0) | (lastHard ? 0x80000000 : 0)) >>> 0);
  }
  const pfp = parentFp !== undefined ? hexToBytes(_fpHex(parentFp)) : new Uint8Array(4);
  const cnum = new Uint8Array(4); new DataView(cnum.buffer).setUint32(0, childNumber >>> 0, false);
  const xpub = base58check(concatBytes([version, new Uint8Array([depth & 0xff]), pfp, cnum, chainCode, key]));
  let originStr = '';
  if (origin) {
    const srcFp = origin.get(2), path = _keypathToString(origin);
    originStr = '[' + (srcFp !== undefined ? _fpHex(srcFp) : '00000000') + (path ? '/' + path : '') + ']';
  }
  let frag = originStr + xpub;
  if (children) { const cp = _keypathToString(children); if (cp) frag += '/' + cp; }
  return frag;
}
function _outputBody(topNode) {
  const scripts = [];
  let node = topNode;
  while (_isTag(node) && _SCRIPT_TAGS[node.tag]) { scripts.push(_SCRIPT_TAGS[node.tag]); node = node.val; }
  let body;
  if (node instanceof Map && node.has(1) && Array.isArray(node.get(2))) {
    const threshold = node.get(1);
    const frags = node.get(2).map(k => _hdkeyToFragment(_isTag(k) ? k.val : k));
    body = threshold + ',' + frags.join(',');
  } else if (_isTag(node)) body = _hdkeyToFragment(node.val);
  else if (node instanceof Map) body = _hdkeyToFragment(node);
  else throw new Error('unrecognized crypto-output body');
  return { body, scripts };
}
function _assemble(body, scripts) {
  let desc = body;
  for (let i = scripts.length - 1; i >= 0; i--) desc = scripts[i] + '(' + desc + ')';
  const chk = descriptorChecksum(desc);
  return desc + (chk ? '#' + chk : '');
}
function decodeCryptoOutput(rawCbor) {
  const { body, scripts } = _outputBody(cborRead(rawCbor, 0).value);
  return _assemble(body, scripts);
}
function decodeCryptoAccount(rawCbor) {
  const m = cborRead(rawCbor, 0).value;              // Map {1: masterFp, 2: [outputs]}
  const outputs = m.get(2) || [];
  return outputs.map(o => { const { body, scripts } = _outputBody(o); return _assemble(body, scripts); });
}

// Heuristic: are these bytes printable UTF-8 text (not a binary blob)? Used to tell a
// text payload wrapped in ur:bytes (e.g. a BlueWallet/Coldcard multisig setup file, a
// descriptor, a BSMS file) from a genuinely binary one (a raw transaction). Strict: valid
// UTF-8 with no control chars other than tab/newline/CR. A raw tx (NUL version bytes) or a
// PSBT (0xFF magic byte, invalid UTF-8) fails this and stays binary.
function looksLikeText(bytes) {
  if (!bytes || bytes.length === 0) return false;
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (e) { return false; }
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 0x7f) return false;
  }
  return true;
}

// ---------- Payload helpers (what Keylay hands to the UI / save layer) ----------
// Given a UR type and its raw CBOR payload, extract the useful value.
//   crypto-psbt / psbt                   -> { kind:'binary', bytes }  (always a PSBT)
//   bytes                                -> binary (raw tx) OR text (setup file/descriptor),
//                                           decided by sniffing the decoded bytes
//   output-descriptor / crypto-output    -> { kind:'text', text }     (descriptor string)
//   crypto-account                       -> { kind:'text', text }     (one descriptor per line)
//   anything else / decode failure       -> { kind:'other' }          (raw-display fallback)
function extractPayload(type, rawCbor) {
  const t = type.toLowerCase();
  let head;
  try { head = cborRead(rawCbor, 0); } catch (e) { return { kind: 'other', reason: 'cbor read failed' }; }
  if (t === 'crypto-psbt' || t === 'psbt') {
    if (head.value instanceof Uint8Array) return { kind: 'binary', bytes: head.value };
    return { kind: 'other', reason: 'expected byte string' };
  }
  if (t === 'bytes') {
    if (!(head.value instanceof Uint8Array)) return { kind: 'other', reason: 'expected byte string' };
    const b = head.value;
    // PSBT magic (70 73 62 74 FF) -> binary PSBT even inside ur:bytes.
    if (b.length >= 5 && b[0] === 0x70 && b[1] === 0x73 && b[2] === 0x62 && b[3] === 0x74 && b[4] === 0xff) {
      return { kind: 'binary', bytes: b };
    }
    // Text wrapped in ur:bytes (BlueWallet/Coldcard multisig setup, descriptor, BSMS).
    if (looksLikeText(b)) return { kind: 'text', text: new TextDecoder().decode(b) };
    // Otherwise a genuine binary blob (raw transaction).
    return { kind: 'binary', bytes: b };
  }
  if (t === 'output-descriptor') {
    if (head.isText) return { kind: 'text', text: head.value };
    // Some emitters wrap the descriptor in a map/tag; try the crypto-output tree decoder.
    try { return { kind: 'text', text: decodeCryptoOutput(rawCbor) }; } catch (e) {}
    return { kind: 'other', reason: 'descriptor not a plain text string' };
  }
  if (t === 'crypto-output') {
    try { return { kind: 'text', text: decodeCryptoOutput(rawCbor) }; }
    catch (e) { return { kind: 'other', reason: 'crypto-output decode failed: ' + e.message }; }
  }
  if (t === 'crypto-account' || t === 'account-descriptor') {
    try {
      const descs = decodeCryptoAccount(rawCbor);
      if (descs.length) return { kind: 'text', text: descs.join('\n') };
    } catch (e) {}
    return { kind: 'other', reason: 'crypto-account decode failed' };
  }
  // crypto-hdkey, crypto-seed, etc. — no native decoder yet.
  return { kind: 'other', reason: 'no native decoder for ' + type };
}

export {
  bytesToHex, hexToBytes, concatBytes, crc32, sha256,
  bytewordsEncode, bytewordsDecode,
  cborUint, cborBytes, cborText, cborEncodePart, cborRead, cborDecodePart,
  Xoshiro, chooseFragments, chooseDegree, shuffle,
  FountainDecoder, URDecoder, FountainEncoder, UREncoder,
  extractPayload, decodeCryptoOutput, decodeCryptoAccount, descriptorChecksum, base58check,
};
