// macOS power controls (all built into macOS):
//   pmset -g batt                 battery level and charger state
//   ioreg AppleClamshellState     is the lid closed?
//   pmset -a disablesleep 0|1     1 = closing the lid does NOT sleep the Mac (sudo rule from install.sh)
//   pmset schedule wake "<date>"  alarm clock that wakes a sleeping Mac (sudo rule from install.sh)
//   pmset sleepnow                go to sleep right now
const run = require('./run');

function parseBattery(text) {
  const onCharger = /'AC Power'/.test(text);
  const m = text.match(/(\d+)%;\s*([a-zA-Z ]+?);/);
  return { percent: m ? parseInt(m[1], 10) : null, onCharger, state: m ? m[2].trim() : (onCharger ? 'AC' : 'unknown') };
}
function pmsetDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const sys = {
  name: 'macOS',
  battery: async () => parseBattery((await run('/usr/bin/pmset', ['-g', 'batt'])).out),
  lidClosed: async () => /"AppleClamshellState" = Yes/.test((await run('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'])).out),
  setNoSleep: async (on) => run('/usr/bin/sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', on ? '1' : '0']),
  scheduleWake: async (date) => run('/usr/bin/sudo', ['-n', '/usr/bin/pmset', 'schedule', 'wake', pmsetDate(date)]),
  cancelWake: async (date) => run('/usr/bin/sudo', ['-n', '/usr/bin/pmset', 'schedule', 'cancel', 'wake', pmsetDate(date)]),
  sleepNow: async () => run('/usr/bin/pmset', ['sleepnow']),
};

module.exports = { sys, parseBattery, pmsetDate };
