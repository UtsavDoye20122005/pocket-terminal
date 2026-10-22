#!/usr/bin/env node
// Pocket Terminal agent. Runs on your Mac.
// It dials OUT to your relay, so it works on any Wi-Fi (college, hotel, hotspot)
// without opening ports on a router. The power brain (power.js) keeps the Mac
// reachable with the lid closed while using as little battery as possible.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const WebSocket = require('ws');
const pty = require('node-pty');
const { PowerBrain } = require('./power');

const CONFIG_DIR = process.env.POCKET_HOME || path.join(os.homedir(), '.pocket-terminal');
const CONFIG_FILE = path.join(CONFIG_DIR, 'agent.json');
const POWER_FILE = path.join(CONFIG_DIR, 'power.json');
const BUFFER_LIMIT = 256 * 1024;
const JOB_TIMEOUT_MS = 10 * 60e3;
const JOB_OUTPUT_LIMIT = 64 * 1024;
const SHELL = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- config ----------

function loadConfig() {
  if (process.env.RELAY_URL && process.env.AGENT_TOKEN) return { relay: process.env.RELAY_URL, token: process.env.AGENT_TOKEN };
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}
function loadPower() { try { return JSON.parse(fs.readFileSync(POWER_FILE, 'utf8')); } catch { return {}; } }
function savePower(s) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(POWER_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

async function setup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));
  let relay = await ask('Relay address (e.g. https://1-2-3-4.sslip.io): ');
  const token = await ask('AGENT_TOKEN: ');
  rl.close();
  relay = relay.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(relay)) { console.error('Address must start with https://'); process.exit(1); }
  if (token.length < 32) { console.error('Token must be at least 32 characters.'); process.exit(1); }
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ relay, token }, null, 2), { mode: 0o600 });
  console.log(`Saved to ${CONFIG_FILE}`);
}

// ---------- the shell ----------
// One long-lived shell. It keeps running while your phone is away.

let term = null;
let buffer = '';
let ws = null;
let power = null;

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function startShell(cols = 80, rows = 24) {
  buffer = '';
  term = pty.spawn(SHELL, ['-l'], {
    name: 'xterm-256color', cols, rows, cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', POCKET_TERMINAL: '1' },
  });
  term.onData((d) => {
    buffer += d; if (buffer.length > BUFFER_LIMIT) buffer = buffer.slice(-BUFFER_LIMIT);
    send({ t: 'o', d });
  });
  term.onExit(() => { term = null; send({ t: 'o', d: '\r\n\x1b[33m[shell exited, press Enter for a new one]\x1b[0m\r\n' }); });
}

// ---------- queued commands ----------
// Commands you queued while the Mac was asleep. Each runs once, on its own.

const ran = new Set();
let running = 0;
function runJob(id, cmd) {
  if (ran.has(id)) return; // never run the same job twice
  ran.add(id);
  log(`job ${id}: ${cmd}`);
  running++; power && power.setJobs(running);
  let out = '';
  const child = spawn(SHELL, ['-lc', cmd], { cwd: os.homedir(), env: process.env });
  const add = (d) => { out += d; if (out.length > JOB_OUTPUT_LIMIT) out = out.slice(-JOB_OUTPUT_LIMIT); };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  const timer = setTimeout(() => { add('\n[stopped after 10 minutes]\n'); child.kill('SIGKILL'); }, JOB_TIMEOUT_MS);
  const finish = (code, extra) => {
    clearTimeout(timer);
    running--; power && power.setJobs(running);
    send({ t: 'jobdone', id, code, out: extra ? out + extra : out });
  };
  child.on('close', (code) => finish(code));
  child.on('error', (e) => finish(-1, String(e)));
}

// ---------- connection to the relay ----------

let reconnectNow = () => {};
let connectedAt = 0;

function connect(cfg) {
  let retry = 0;
  let timer = null;
  const open = () => {
    clearTimeout(timer);
    const url = cfg.relay.replace(/^http/, 'ws') + '/agent';
    ws = new WebSocket(url, { headers: { Authorization: `Bearer ${cfg.token}` }, handshakeTimeout: 15e3 });
    const sock = ws;
    let alive = true;
    let beat;
    sock.on('open', () => {
      retry = 0; connectedAt = Date.now();
      log('connected to relay');
      power && power.setConnected(true);
      if (term) send({ t: 'buf', d: buffer }); // relay may have restarted; give it our screen
      if (power) send({ t: 'power', ...power.status() });
      beat = setInterval(() => {
        if (!alive) return sock.terminate(); // relay stopped answering (e.g. Wi-Fi changed)
        alive = false; sock.ping();
      }, 20e3);
    });
    sock.on('pong', () => { alive = true; });
    sock.on('ping', () => { alive = true; });
    sock.on('message', (raw) => {
      alive = true;
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'i') { power && power.activity(); if (!term) startShell(); else term.write(m.d); }
      else if (m.t === 'r' && m.cols > 0 && m.rows > 0 && m.cols < 1000 && m.rows < 1000) {
        if (!term) startShell(m.cols, m.rows); else term.resize(m.cols, m.rows);
      } else if (m.t === 'job' && typeof m.cmd === 'string') runJob(m.id, m.cmd);
      else if (m.t === 'want') power && power.setPhoneWanting(m.phones > 0);
      else if (m.t === 'settings' && m.power && power) {
        const allowed = ['enabled', 'awakeOnCharger', 'batteryMode', 'checkInMinutes', 'idleMinutes', 'minBattery', 'stopAlarmsBelow'];
        const next = {};
        for (const k of allowed) if (k in m.power) next[k] = m.power[k];
        next.checkInMinutes = Math.min(120, Math.max(3, Number(next.checkInMinutes ?? power.s.checkInMinutes)));
        next.minBattery = Math.min(90, Math.max(5, Number(next.minBattery ?? power.s.minBattery)));
        power.update(next);
        savePower(power.s);
        log('power settings updated', JSON.stringify(next));
      }
    });
    sock.on('close', (code) => {
      clearInterval(beat);
      power && power.setConnected(false);
      if (ws !== sock) return; // replaced by a newer connection
      if (code === 4000) log('another agent took over');
      // Going to sleep on purpose: reconnect when we wake (or in 25s if sleep didn't happen).
      const wait = power && power.sleeping ? 25e3 : Math.min(30e3, 1000 * 2 ** retry++);
      log(`disconnected, retrying in ${Math.round(wait / 1000)}s`);
      timer = setTimeout(open, wait);
    });
    sock.on('error', (e) => { if (String(e.message).includes('401')) log('relay said 401: AGENT_TOKEN does not match the relay'); });
  };
  // After the Mac wakes up, the old connection is dead. Don't wait for timeouts.
  reconnectNow = () => {
    if (ws && ws.readyState === 1 && Date.now() - connectedAt < 10e3) return; // already fresh
    retry = 0; try { ws && ws.terminate(); } catch {} ws = null; open();
  };
  open();
}

// ---------- start ----------

if (require.main === module || process.env.POCKET_EMBEDDED) main();

function main() {
  if (process.argv.includes('--setup')) return setup();
  const cfg = loadConfig();
  if (!cfg) { console.error('Not set up yet. Run:  npm run setup'); process.exit(1); }

  // POWER_SIM lets tests swap in a fake Mac (see test/sim-mac.js).
  const sim = process.env.POWER_SIM ? require(path.resolve(process.env.POWER_SIM)) : null;
  if ((process.platform === 'darwin' || sim) && process.env.POWER_BRAIN !== '0') {
    power = new PowerBrain(loadPower(), {
      log,
      onStatus: (s) => send({ t: 'power', ...s }),
      onWake: () => reconnectNow(),
      onSleep: async (s) => {
        send({ t: 'sleeping', nextWake: s.nextWake });
        await new Promise((r) => setTimeout(r, 300)); // let the message go out
        try { ws && ws.close(4001, 'sleeping'); } catch {} // so your phone sees "asleep" right away
      },
    }, sim || {});
    power.start();
  }

  connect(cfg);
  const stop = async () => {
    try { term && term.kill(); } catch {}
    if (power) await power.stop(); // never leave the Mac stuck awake
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
