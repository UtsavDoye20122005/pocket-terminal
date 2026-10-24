// Tests the power brain with a fake Mac and a fake clock: node test/power.test.js
const assert = require('assert');
const { PowerBrain, parseBattery, pmsetDate } = require('../power');

// parsing real pmset output
const ac = parseBattery(`Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t87%; charging; 0:45 remaining present: true`);
assert.deepStrictEqual([ac.percent, ac.onCharger], [87, true]);
const bat = parseBattery(`Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t54%; discharging; 6:12 remaining present: true`);
assert.deepStrictEqual([bat.percent, bat.onCharger], [54, false]);
assert.strictEqual(pmsetDate(new Date(2026, 9, 22, 9, 5, 3)), '10/22/26 09:05:03');

let t = 100 * 3600e3; // start the fake clock far from 0 ("never used")
const calls = [];
const mac = { percent: 80, onCharger: true, lid: true };
const sys = {
  now: () => t,
  battery: async () => ({ percent: mac.percent, onCharger: mac.onCharger, state: 'x' }),
  lidClosed: async () => mac.lid,
  setNoSleep: async (on) => { calls.push(`nosleep ${on ? 1 : 0}`); return { ok: true }; },
  scheduleWake: async (d) => { calls.push(`alarm +${Math.round((d - t) / 60e3)}m`); return { ok: true }; },
  cancelWake: async () => { calls.push('cancel alarm'); return { ok: true }; },
  sleepNow: async () => { calls.push('SLEEP'); return { ok: true }; },
};
let woke = 0;
const brain = new PowerBrain({}, { log: () => {}, onWake: () => woke++, onSleep: async () => {} }, sys);
// the Mac stays awake between steps, so ticks kept running (no wake detected)
const step = async (ms = 5e3) => { t += ms; brain.lastTick = t - 5e3; brain.sleeping = false; await brain.tick(); };
const last = () => calls.slice(-3).join(' | ');

(async () => {
  // 1. On charger, lid closed → awake, never sleeps
  await step();
  assert.ok(calls.includes('nosleep 1')); assert.ok(!calls.includes('SLEEP'));
  console.log('✓ on charger: stays awake with lid closed');

  // 2. Unplug while lid closed. Still "checking in" right after start, then sleeps.
  mac.onCharger = false; brain.wokeAt = t; brain.firstContact = false;
  await step(10e3); assert.ok(!calls.includes('SLEEP'), 'should wait to reach the relay');
  brain.firstContact = true; brain.connectedAt = t; // relay reached
  await step(3e3); assert.ok(!calls.includes('SLEEP'), 'gives the relay 5 s to send work');
  await step(3e3);
  assert.strictEqual(last(), 'nosleep 0 | alarm +2m | SLEEP');
  console.log('✓ on battery + idle: quick check-in (5 s after connecting), 2 min alarm, sleeps');

  // 3. Wakes from the alarm (big clock jump) → onWake, stays awake to check in
  calls.length = 0; brain.lastTick = t; t += 2 * 60e3; brain.sleeping = false; await brain.tick();
  assert.strictEqual(woke, 1); assert.ok(calls.includes('nosleep 1'));
  console.log('✓ wake detected, stays awake to check in');

  // 4. Phone connects during check-in → stays awake past the window
  brain.setConnected(true); brain.setPhoneWanting(true);
  await step(60e3); await step(60e3);
  assert.ok(!calls.includes('SLEEP')); assert.deepStrictEqual(brain.reasons(), ['phone connected']);
  console.log('✓ phone connected: stays awake');

  // 5. Phone left open, nobody types for 15 min → sleeps anyway
  await step(15 * 60e3);
  assert.ok(calls.includes('SLEEP'));
  console.log('✓ phone left idle 15 min: sleeps to save battery');

  // 6. Typing keeps it awake
  calls.length = 0; brain.lastTick = t; t += 60e3; await brain.tick(); brain.firstContact = true;
  brain.activity(); await step(30e3); await step(60e3);
  assert.ok(brain.reasons().includes('recent typing')); assert.ok(!calls.includes('SLEEP'));
  console.log('✓ recent typing: stays awake');

  // 7. Low battery (below 20%) beats the phone → sleeps
  mac.percent = 15; await step();
  assert.ok(calls.includes('SLEEP')); assert.ok(calls.some((c) => c.startsWith('alarm')));
  console.log('✓ battery 15%: sleeps even with phone open (still checks in)');

  // 8. Critical battery: no more alarms
  calls.length = 0; mac.percent = 8; brain.lastTick = t; t += 60e3; await brain.tick(); await step(100e3);
  assert.ok(calls.includes('SLEEP')); assert.ok(!calls.some((c) => c.startsWith('alarm')));
  console.log('✓ battery 8%: sleeps with no wake-ups');

  // 9. Lid open on battery, idle → only allows sleep, never forces it
  calls.length = 0; mac.percent = 60; mac.lid = false; brain.setPhoneWanting(false);
  brain.lastTick = t; t += 60e3; await brain.tick(); await step(100e3);
  assert.strictEqual(brain.noSleep, false); assert.ok(!calls.includes('SLEEP'));
  console.log('✓ lid open: never forces sleep while you use the Mac');

  // 10. Instant mode on battery → stays awake
  calls.length = 0; mac.lid = true; brain.update({ batteryMode: 'instant' }); await step();
  assert.ok(brain.reasons().includes('instant mode')); assert.ok(!calls.includes('SLEEP'));
  console.log('✓ instant mode: stays awake on battery');

  // 11. Smart check-ins: faster right after you used it
  brain.update({ batteryMode: 'saver' });
  brain.activity();                      assert.strictEqual(brain.nextCheckInMinutes(), 1);
  t += 45 * 60e3;                        assert.strictEqual(brain.nextCheckInMinutes(), 2);
  t += 3 * 3600e3;                       assert.strictEqual(brain.nextCheckInMinutes(), 2);
  brain.update({ smartCheckIn: false }); brain.activity(); assert.strictEqual(brain.nextCheckInMinutes(), 2);
  console.log('✓ smart check-ins: 1 min after use, then 2 min, then your setting');

  // 12. stop() never leaves the Mac stuck awake
  await brain.stop(); assert.strictEqual(calls.at(-1), 'nosleep 0');
  console.log('✓ stopping the agent restores normal sleep');
  console.log('\nAll power tests passed.');
})().catch((e) => { console.error('FAIL:', e.message, '\ncalls:', calls); process.exit(1); });
