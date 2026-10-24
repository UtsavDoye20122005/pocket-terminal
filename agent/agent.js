#!/usr/bin/env node
// Pocket Terminal agent. Runs on your Mac (started at login by install.sh).
//
//   Direct mode (default): phone ⇄ Mac peer-to-peer, introduced through a free public
//                          message board. Nothing for you to host. See direct.js.
//   Relay mode (optional): phone and Mac both connect to a relay server you host
//                          (relay/ folder). See README → "Advanced".
//
// The power brain (power.js) keeps the Mac reachable with the lid closed while
// using as little battery as possible.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PowerBrain } = require('./power');
const { createCore } = require('./lib/core');

const DIR = process.env.POCKET_HOME || path.join(os.homedir(), '.pocket-terminal');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } };

function main() {
  const direct = readJson('direct.json');
  const relay = process.env.RELAY_URL && process.env.AGENT_TOKEN
    ? { relay: process.env.RELAY_URL, token: process.env.AGENT_TOKEN } : readJson('agent.json');
  const mode = process.env.POCKET_MODE || (direct ? 'direct' : relay ? 'relay' : null);
  if (!mode) { console.error('Not set up yet. Run:  bash install.sh'); process.exit(1); }

  let transport = null;

  // POWER_SIM lets tests swap in a fake Mac (see test/sim-mac.js).
  const sim = process.env.POWER_SIM ? require(path.resolve(process.env.POWER_SIM)) : null;
  let power = null;
  if ((process.platform === 'darwin' || sim) && process.env.POWER_BRAIN !== '0') {
    power = new PowerBrain(readJson('power.json') || {}, {
      log,
      onStatus: (s) => transport && transport.onPower(s),
      onWake: () => transport && transport.onWake(),
      onSleep: async (s) => transport && transport.onSleep(s),
    }, sim || {});
  }

  const core = createCore({ log, power });
  if (mode === 'direct') {
    transport = require('./direct').startDirect({ cfg: direct, core, power, log, dir: DIR });
  } else {
    transport = require('./relay-transport').startRelay({ cfg: relay, core, power, log, dir: DIR });
  }
  if (power) power.start();
  log(`agent running in ${mode} mode`);

  const stop = async () => {
    core.stop();
    try { transport.stop(); } catch {}
    if (power) await power.stop(); // never leave the Mac stuck awake
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module || process.env.POCKET_EMBEDDED) main();
