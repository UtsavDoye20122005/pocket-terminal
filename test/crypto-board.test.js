// node test/crypto-board.test.js
const assert = require('assert');
const { newSecret, derive, seal, open } = require('../agent/lib/crypto');
const { Board } = require('../agent/lib/board');
const { startBoard } = require('./mock-board');
(async () => {
  const s = newSecret(), k = derive(s), other = derive(newSecret());
  assert.match(k.topic, /^pt-[-_A-Za-z0-9]{24}$/);
  const note = seal(k, { type: 'cmd', cmd: 'echo hi' });
  assert.deepStrictEqual(open(k, note), { type: 'cmd', cmd: 'echo hi' });
  assert.strictEqual(open(other, note), null, 'other key must fail');
  const tampered = note.slice(0, -3) + (note.at(-3) === 'A' ? 'B' : 'A') + note.slice(-2);
  assert.strictEqual(open(k, tampered), null, 'tampering must fail');
  assert.strictEqual(open({ ...k, topic: k.topic + 'x' }, note), null, 'wrong mailbox must fail');
  console.log('✓ encryption: round-trip, wrong key, tampering, wrong mailbox');

  const b1 = await startBoard(), b2 = await startBoard();
  const urls = [`http://127.0.0.1:${b1.port}`, `http://127.0.0.1:${b2.port}`];
  const a = new Board(urls, k.topic), c = new Board(urls, k.topic);
  const got = [];
  c.stream((text) => got.push(open(k, text)));
  await new Promise((r) => setTimeout(r, 300));
  await a.publish(seal(k, { n: 1 }));
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(got.length, 2, 'one copy per board'); // receiver de-dupes by inner id
  b1.server.close(); b1.server.closeAllConnections();
  await a.publish(seal(k, { n: 2 }));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(got.some((m) => m.n === 2), 'still delivered with one board down');
  console.log('✓ boards: live stream, posts to all boards, survives one board going down');
  const late = []; const d = new Board(urls.slice(1), k.topic, { since: {} });
  await d.poll((t) => late.push(open(k, t)));
  assert.ok(late.length >= 2, 'notes posted earlier are still there');
  console.log('✓ boards: a device that was asleep picks up earlier notes');
  c.stop(); b2.server.close(); b2.server.closeAllConnections(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
