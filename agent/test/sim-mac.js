// A fake Mac for testing the power brain end to end on any computer.
// State lives in a JSON file the test edits: {percent, onCharger, lid}.
// "Sleeping" freezes this process (SIGSTOP); the test un-freezes it (SIGCONT),
// which is exactly what a real sleep looks like to a program: time jumps forward.
const fs = require('fs');
const { exec } = require('child_process');
const FILE = process.env.SIM_STATE;
const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const note = (line) => fs.appendFileSync(FILE + '.log', line + '\n');
module.exports = {
  battery: async () => { const s = read(); return { percent: s.percent, onCharger: s.onCharger, state: 'sim' }; },
  lidClosed: async () => read().lid,
  setNoSleep: async (on) => { note(`nosleep ${on ? 1 : 0}`); return { ok: true }; },
  scheduleWake: async (d) => { note(`alarm ${d.toISOString()}`); return { ok: true }; },
  cancelWake: async () => ({ ok: true }),
  sleepNow: async () => { note('SLEEP'); exec(`sleep 0.3; kill -STOP ${process.pid}`); return { ok: true }; },
};
