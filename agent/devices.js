// Every paired phone has its own key and its own private mailbox (see pair.js).
// This runs one direct-mode connection per phone and follows direct.json: pair or remove
// a phone and the agent picks it up within a few seconds, no restart needed.

const fs = require('fs');
const path = require('path');
const { startDirect } = require('./direct');

function startDevices({ core, power, log, dir }) {
  const FILE = path.join(dir, 'direct.json');
  const running = new Map(); // device id -> { t, secret }
  const want = new Map(), conn = new Map();
  const any = (m) => [...m.values()].some(Boolean);

  // Each phone's connection gets a view of the power brain; "a phone wants me awake"
  // is true if ANY phone wants it.
  const powerFor = (id) => power && new Proxy(power, {
    get(t, k) {
      if (k === 'setPhoneWanting') return (v) => { want.set(id, !!v); t.setPhoneWanting(any(want)); };
      if (k === 'setConnected') return (v) => { conn.set(id, !!v); t.setConnected(any(conn)); };
      const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
    },
  });

  let warned = false;
  function sync() {
    let cfg; try { cfg = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return; }
    const devices = Array.isArray(cfg.devices) ? cfg.devices : [];
    if (cfg.secret && !warned) { warned = true; log('the old reusable pairing code is no longer accepted. Pair again: node pair.js'); }
    for (const [id, r] of running) {
      const d = devices.find((x) => x.id === id);
      if (!d || d.secret !== r.secret) {
        if (!d) Promise.resolve(r.t.revoke && r.t.revoke()).catch(() => {}).finally(() => r.t.stop()); else r.t.stop();
        running.delete(id); want.delete(id); conn.delete(id);
        if (power) { power.setPhoneWanting(any(want)); power.setConnected(any(conn)); }
        log(`phone removed: ${r.name}`);
      }
    }
    for (const d of devices) {
      if (running.has(d.id) || typeof d.secret !== 'string') continue;
      const plog = (...a) => log(`[${d.name}]`, ...a);
      try {
        const t = startDirect({ cfg: { ...cfg, secret: d.secret, stateFile: `state-${d.id}.json` }, core, power: powerFor(d.id), log: plog, dir });
        running.set(d.id, { t, secret: d.secret, name: d.name });
        log(`phone ready: ${d.name}`);
      } catch (e) { log(`could not start ${d.name}: ${e.message}`); }
    }
    if (!running.size) log('no phones paired yet. Run: node pair.js');
  }

  sync();
  fs.watchFile(FILE, { interval: 1500 }, sync);
  const each = (fn) => Promise.all([...running.values()].map((r) => Promise.resolve().then(() => fn(r.t)).catch(() => {})));
  return {
    onWake: () => each((t) => t.onWake()),
    onSleep: (s) => each((t) => t.onSleep(s)),
    onPower: (s) => { for (const r of running.values()) r.t.onPower(s); },
    stop: () => { fs.unwatchFile(FILE); for (const r of running.values()) r.t.stop(); },
  };
}

module.exports = { startDevices };
