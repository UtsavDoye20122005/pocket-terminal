// Windows power-control parsers, tested with real-looking Windows outputs: node test/windows.test.js
const assert = require('assert');
const { parseProbe, parseLidAction, taskTime } = require('../platform/windows');

assert.deepStrictEqual(parseProbe('{"percent":64,"status":1,"idle":12}'), { percent: 64, onCharger: false, state: 'status 1', idleSeconds: 12 });
assert.strictEqual(parseProbe('{"percent":64,"status":2,"idle":12}').onCharger, true);   // plugged in
assert.strictEqual(parseProbe('{"percent":97,"status":6,"idle":0}').onCharger, true);    // charging
assert.strictEqual(parseProbe('{"percent":8,"status":5,"idle":0}').onCharger, false);    // critical, on battery
const desk = parseProbe('{"percent":null,"status":null,"idle":700}');                    // desktop PC, no battery
assert.deepStrictEqual([desk.percent, desk.onCharger, desk.idleSeconds], [null, true, 700]);
assert.strictEqual(parseProbe('').onCharger, true);                                       // PowerShell failed → safe default
console.log('✓ battery + idle parsing (laptop, charging, critical, desktop, failure)');

const q = `Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)
    GUID Alias: LIDACTION
    Possible Setting Index: 000
    Possible Setting Friendly Name: Do nothing
  Current AC Power Setting Index: 0x00000000
  Current DC Power Setting Index: 0x00000001`;
assert.deepStrictEqual(parseLidAction(q), { ac: 0, dc: 1 });
assert.deepStrictEqual(parseLidAction('garbage'), { ac: 1, dc: 1 });
console.log('✓ lid-close setting parsing');

assert.strictEqual(taskTime(new Date(2026, 9, 25, 7, 5, 9)), '2026-10-25T07:05:09');
console.log('✓ wake-alarm time format');
console.log('\nAll Windows tests passed.');
