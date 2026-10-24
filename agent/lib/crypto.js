// End-to-end encryption shared by the Mac and the phone (docs/js/crypto.js is the browser twin).
//
// Pairing gives both devices one 32-byte secret. From it we derive, with HKDF-SHA256:
//   topic        the private "mailbox" name on the message board (unguessable)
//   notifyTopic  a second mailbox for content-free phone notifications
//   key          AES-256-GCM key; every message is encrypted AND authenticated with it
//
// Wire format of one message:  "pt1." + base64url( iv[12] | ciphertext | tag[16] )
// Plaintext = deflate-raw(JSON). Additional authenticated data = "pt1:" + topic.
// The board only ever sees random-looking text.

const crypto = require('crypto');
const zlib = require('zlib');

const SALT = Buffer.from('pocket-terminal/v1');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

function newSecret() { return b64u(crypto.randomBytes(32)); }

function derive(secret) {
  const ikm = fromB64u(secret);
  if (ikm.length !== 32) throw new Error('bad pairing secret');
  const h = (info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, SALT, Buffer.from(info), len));
  return {
    topic: 'pt-' + b64u(h('topic', 18)),
    notifyTopic: 'ptn-' + b64u(h('notify', 18)),
    key: h('key', 32),
  };
}

function seal(keys, obj) {
  const plain = zlib.deflateRawSync(Buffer.from(JSON.stringify(obj)));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys.key, iv);
  c.setAAD(Buffer.from('pt1:' + keys.topic));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return 'pt1.' + b64u(Buffer.concat([iv, ct]));
}

function open(keys, str) {
  try {
    if (typeof str !== 'string' || !str.startsWith('pt1.')) return null;
    const raw = fromB64u(str.slice(4));
    if (raw.length < 12 + 16 + 1) return null;
    const iv = raw.subarray(0, 12), tag = raw.subarray(raw.length - 16), ct = raw.subarray(12, raw.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', keys.key, iv);
    d.setAAD(Buffer.from('pt1:' + keys.topic));
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(ct), d.final()]);
    return JSON.parse(zlib.inflateRawSync(plain, { maxOutputLength: 1 << 20 }).toString());
  } catch { return null; } // wrong key, tampered, or not ours: ignore
}

const msgId = () => b64u(crypto.randomBytes(9));

module.exports = { newSecret, derive, seal, open, msgId, b64u, fromB64u };
