// Browser twin of agent/lib/crypto.js — must produce exactly the same format.
//   topic / notifyTopic / key  ← HKDF-SHA256(secret, salt "pocket-terminal/v1", info)
//   note = "pt1." + base64url( iv | AES-256-GCM( deflate-raw(JSON) ) | tag ),  AAD = "pt1:" + topic
// Also: the PIN "vault" that keeps the pairing secret encrypted on the phone.

const enc = new TextEncoder(), dec = new TextDecoder();
const SALT = enc.encode('pocket-terminal/v1');

export const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0));
export const randomId = () => b64u(crypto.getRandomValues(new Uint8Array(9)));

async function hkdf(ikm, info, len) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) }, base, len * 8));
}

export async function derive(secret) {
  const ikm = fromB64u(secret);
  if (ikm.length !== 32) throw new Error('bad pairing secret');
  const rawKey = await hkdf(ikm, 'key', 32);
  return {
    topic: 'pt-' + b64u(await hkdf(ikm, 'topic', 18)),
    notifyTopic: 'ptn-' + b64u(await hkdf(ikm, 'notify', 18)),
    key: await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']), // not extractable
  };
}

async function pipe(bytes, stream) {
  const s = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function seal(keys, obj) {
  const plain = await pipe(enc.encode(JSON.stringify(obj)), new CompressionStream('deflate-raw'));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('pt1:' + keys.topic) }, keys.key, plain));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return 'pt1.' + b64u(out);
}

export async function open(keys, str) {
  try {
    if (typeof str !== 'string' || !str.startsWith('pt1.')) return null;
    const raw = fromB64u(str.slice(4));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: enc.encode('pt1:' + keys.topic) }, keys.key, raw.subarray(12));
    return JSON.parse(dec.decode(await pipe(new Uint8Array(plain), new DecompressionStream('deflate-raw'))));
  } catch { return null; }
}

// ----- PIN vault: the pairing secret never sits on the phone in plain form -----
const PBKDF2_ROUNDS = 310000;
async function pinKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ROUNDS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function lockSecret(secret, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pinKey(pin, salt), enc.encode(secret));
  return { salt: b64u(salt), iv: b64u(iv), ct: b64u(ct) };
}
export async function unlockSecret(vault, pin) {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(vault.iv) }, await pinKey(pin, fromB64u(vault.salt)), fromB64u(vault.ct));
    return dec.decode(plain);
  } catch { return null; }
}
