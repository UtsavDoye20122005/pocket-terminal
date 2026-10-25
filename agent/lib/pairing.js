// One-time pairing (docs/js/crypto.js has the browser twin).
//
//   1. pair.js makes a one-time invite secret I and shows it as a QR code (valid 10 min, one phone).
//   2. The phone makes a fresh P-256 key pair and posts a "join" note (sealed with I) holding its public key.
//   3. The computer shows a 6-digit code made from that public key. The phone shows the same code.
//      You compare them and press y. Nobody can approve a phone without being at the computer.
//   4. The computer makes a NEW secret just for that phone and sends it wrapped with ECDH
//      (computer ephemeral key × phone key). Someone who photographed the QR code still can't read it.
//   5. The invite is dead. Scanning the same QR again later does nothing.

const crypto = require('crypto');

const SALT = Buffer.from('pocket-terminal/pair-v1');
const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

function codeFor(pubB64) {
  const h = crypto.createHash('sha256').update(fromB64u(pubB64)).digest();
  return String(h.readUInt32BE(0) % 1e6).padStart(6, '0');
}

function wrapFor(phonePubB64, nonce, payload) {
  const pub = fromB64u(phonePubB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('bad phone key');
  const e = crypto.createECDH('prime256v1'); e.generateKeys();
  const shared = e.computeSecret(pub);
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, SALT, Buffer.from('wrap'), 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('join:' + nonce));
  const ct = Buffer.concat([c.update(JSON.stringify(payload)), c.final(), c.getAuthTag()]);
  return { epub: b64u(e.getPublicKey()), iv: b64u(iv), ct: b64u(ct) };
}

// For tests: what the phone does.
function unwrapWith(ecdh, nonce, w) {
  const shared = ecdh.computeSecret(fromB64u(w.epub));
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, SALT, Buffer.from('wrap'), 32));
  const raw = fromB64u(w.ct);
  const d = crypto.createDecipheriv('aes-256-gcm', key, fromB64u(w.iv));
  d.setAAD(Buffer.from('join:' + nonce)); d.setAuthTag(raw.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(0, -16)), d.final()]).toString());
}

module.exports = { codeFor, wrapFor, unwrapWith };
