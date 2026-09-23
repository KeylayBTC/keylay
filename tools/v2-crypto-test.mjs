import { webcrypto as crypto } from 'node:crypto';
const enc = s => new TextEncoder().encode(s);
function v2Input(tag, kCode){ const t=enc(tag); const o=new Uint8Array(t.length+kCode.length); o.set(t); o.set(kCode,t.length); return o; }
async function deriveKCode(code){ const km=await crypto.subtle.importKey('raw',enc(code),'PBKDF2',false,['deriveBits']); const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-512',salt:enc('keylay-v2-kdf-salt'),iterations:300000},km,256); return new Uint8Array(bits); }
async function deriveChannelName(kCode){ const h=await crypto.subtle.digest('SHA-256',v2Input('keylay-v2-channel|',kCode)); return Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32); }
async function deriveHmacKey(kCode){ const mb=await crypto.subtle.digest('SHA-256',v2Input('keylay-v2-hmac|',kCode)); return crypto.subtle.importKey('raw',mb,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']); }
async function exportPub(kp){ const r=await crypto.subtle.exportKey('raw',kp.publicKey); return Buffer.from(r).toString('base64'); }
async function deriveSessionKey(myKp,myPub,theirPub,kCode,channelHash){
  const raw=Uint8Array.from(Buffer.from(theirPub,'base64'));
  const tpk=await crypto.subtle.importKey('raw',raw,{name:'X25519'},false,[]);
  const shared=await crypto.subtle.deriveBits({name:'X25519',public:tpk},myKp.privateKey,256);
  const hk=await crypto.subtle.importKey('raw',shared,'HKDF',false,['deriveKey']);
  const keys=[myPub,theirPub].sort();
  const info=enc('keylay-v2-pair|'+channelHash+'|'+keys.join('|'));
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:kCode,info},hk,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
function buildAAD(type,ch,fmt,ctr){ return enc('keylay-v2|'+type+'|'+ch+'|'+fmt+'|'+ctr); }
async function encrypt(pt,key,aad){ const iv=crypto.getRandomValues(new Uint8Array(12)); const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,enc(pt)); const c=new Uint8Array(iv.length+ct.byteLength); c.set(iv); c.set(new Uint8Array(ct),iv.length); return Buffer.from(c).toString('base64'); }
async function decrypt(b64,key,aad){ const c=Uint8Array.from(Buffer.from(b64,'base64')); const iv=c.slice(0,12); const ct=c.slice(12); const d=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad},key,ct); return new TextDecoder().decode(d); }

let pass=0, fail=0;
const ok=(n,c)=>{ if(c){pass++;console.log('PASS',n);} else {fail++;console.log('FAIL',n);} };

const CODE='v3tvmnxvq7';               // 10-char code
// 1. same code -> same channel hash (both peers)
const kA=await deriveKCode(CODE), kB=await deriveKCode(CODE);
const chA=await deriveChannelName(kA), chB=await deriveChannelName(kB);
ok('same code -> same channelHash', chA===chB);
ok('channelHash is 32 hex chars', /^[0-9a-f]{32}$/.test(chA));
// different code -> different channel hash
const chX=await deriveChannelName(await deriveKCode('differentx1'));
ok('different code -> different channelHash', chX!==chA);
// 2. HMAC key usable + verifies (hello auth)
const hmA=await deriveHmacKey(kA), hmB=await deriveHmacKey(kB);
const sig=await crypto.subtle.sign('HMAC',hmA,enc('pubkey-b64'));
ok('hmac from same code verifies across peers', await crypto.subtle.verify('HMAC',hmB,sig,enc('pubkey-b64')));
// 3. X25519 DH -> both peers derive identical session key, round-trip encrypt/decrypt
const A=await crypto.subtle.generateKey({name:'X25519'},false,['deriveBits']);
const B=await crypto.subtle.generateKey({name:'X25519'},false,['deriveBits']);
const aPub=await exportPub(A), bPub=await exportPub(B);
const skA=await deriveSessionKey(A,aPub,bPub,kA,chA);
const skB=await deriveSessionKey(B,bPub,aPub,kB,chB);
const aad=buildAAD('data',chA,'qr',1);
const ct=await encrypt('hello multisig',skA,aad);
const pt=await decrypt(ct,skB,buildAAD('data',chB,'qr',1));
ok('A->B round-trip decrypts (shared session key)', pt==='hello multisig');
// 4. S3: relay flips format qr->binary -> decrypt MUST fail
let flipped=false; try{ await decrypt(ct,skB,buildAAD('data',chB,'binary',1)); }catch{ flipped=true; }
ok('S3: flipped format in AAD fails decryption', flipped);
// 5. replay/counter mismatch in AAD -> fail
let ctrbad=false; try{ await decrypt(ct,skB,buildAAD('data',chB,'qr',2)); }catch{ ctrbad=true; }
ok('counter mismatch in AAD fails decryption', ctrbad);
// 6. wrong code -> different session key -> decrypt fails
const kW=await deriveKCode('wrongcode99'); const chW=await deriveChannelName(kW);
const skW=await deriveSessionKey(B,bPub,aPub,kW,chW);
let wrong=false; try{ await decrypt(ct,skW,buildAAD('data',chW,'qr',1)); }catch{ wrong=true; }
ok('wrong code cannot decrypt', wrong);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
