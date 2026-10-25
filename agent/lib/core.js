// The part of the agent that actually does things on your Mac:
//   - one long-lived terminal (zsh) that keeps running when your phone disconnects
//   - one-off commands ("jobs") that run on their own and report their output
// Transports (direct P2P, or the optional relay) plug in as "clients" of a terminal session.

const os = require('os');
const { spawn } = require('child_process');
const pty = require('node-pty');

const BUFFER_LIMIT = 256 * 1024;
const JOB_TIMEOUT_MS = 10 * 60e3;
const JOB_OUTPUT_LIMIT = 64 * 1024;
const WIN = process.platform === 'win32';
// Terminal: zsh/bash on Mac/Linux, PowerShell on Windows (set POCKET_SHELL to change, e.g. pwsh.exe or cmd.exe).
const SHELL = process.env.POCKET_SHELL || (WIN ? 'powershell.exe' : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'));
const SHELL_ARGS = WIN ? ['-NoLogo'] : ['-l'];
// One-off commands: run through the same shell so they behave like typing them.
const jobArgs = (cmd) => WIN
  ? (/cmd(\.exe)?$/i.test(SHELL) ? ['/d', '/s', '/c', cmd] : ['-NoProfile', '-NonInteractive', '-Command', cmd])
  : ['-lc', cmd];

function createCore({ log, power }) {
  const ran = new Set();
  let running = 0;

  // Terminal sessions. Each phone app launch has its own session id: come back to the app and you
  // continue where you left off; kill the app and open it again and you get a fresh terminal.
  // Sessions live on even while no phone is connected (a long build keeps running).
  const sessions = new Map(); // key -> { term, buffer, clients:Set, last }
  const MAX_SESSIONS = 4;

  function getSession(key) {
    let s = sessions.get(key);
    if (!s) { s = { key, term: null, buffer: '', clients: new Set(), last: Date.now() }; sessions.set(key, s); trim(); }
    s.last = Date.now();
    return s;
  }
  function kill(s) { try { s.term && s.term.kill(); } catch {} s.term = null; sessions.delete(s.key); }
  function trim() { // too many? close the oldest one nobody is looking at
    while (sessions.size > MAX_SESSIONS) {
      const idle = [...sessions.values()].filter((s) => !s.clients.size).sort((a, b) => a.last - b.last)[0];
      if (!idle) break; kill(idle);
    }
  }
  function startShell(s, cols = 80, rows = 24) {
    s.buffer = '';
    const t = pty.spawn(SHELL, SHELL_ARGS, {
      name: 'xterm-256color', cols, rows, cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', POCKET_TERMINAL: '1', PROMPT_EOL_MARK: '' }, // no stray '%' after a screen replay
    });
    s.term = t;
    const send = (msg) => { for (const c of s.clients) { try { c(msg); } catch {} } };
    t.onData((d) => {
      s.buffer += d; if (s.buffer.length > BUFFER_LIMIT) s.buffer = s.buffer.slice(-BUFFER_LIMIT);
      send({ t: 'o', d });
    });
    t.onExit(() => { if (s.term === t) { s.term = null; send({ t: 'o', d: '\r\n\x1b[33m[shell exited, press Enter for a new one]\x1b[0m\r\n' }); } });
  }
  function session(key) {
    const s = getSession(key);
    return {
      clients: s.clients,
      input: (d) => { power && power.activity(); s.last = Date.now(); if (!s.term) startShell(s); else s.term.write(d); },
      resize: (cols, rows) => {
        if (!(cols > 0 && rows > 0 && cols < 1000 && rows < 1000)) return;
        if (!s.term) startShell(s, cols, rows); else s.term.resize(cols, rows);
      },
      screen: () => s.buffer,
      hasShell: () => !!s.term,
    };
  }
  // A phone started a new session: close its older sessions that nobody is looking at.
  function dropOthers(prefix, keepKey) {
    for (const s of [...sessions.values()]) if (s.key !== keepKey && s.key.startsWith(prefix) && !s.clients.size) kill(s);
  }

  // The relay transport and older phones use one shared session.
  const legacy = session('shared');

  // Run one command by itself. Never runs the same id twice.
  function runJob(id, cmd, onDone) {
    if (ran.has(id) || typeof cmd !== 'string' || !cmd.trim() || cmd.length > 4000) return false;
    ran.add(id); if (ran.size > 2000) ran.delete(ran.values().next().value);
    log(`command ${id} started`); // the command text itself is never logged
    running++; power && power.setJobs(running);
    let out = '';
    const child = spawn(SHELL, jobArgs(cmd), { cwd: os.homedir(), env: process.env, windowsHide: true });
    const add = (d) => { out += d; if (out.length > JOB_OUTPUT_LIMIT) out = out.slice(-JOB_OUTPUT_LIMIT); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { add('\n[stopped after 10 minutes]\n'); child.kill('SIGKILL'); }, JOB_TIMEOUT_MS);
    let done = false;
    const finish = (code, extra = '') => {
      if (done) return; done = true;
      clearTimeout(timer);
      running--; power && power.setJobs(running);
      onDone({ id, code, out: out + extra });
    };
    child.on('close', (code) => finish(code));
    child.on('error', (e) => finish(-1, String(e)));
    return true;
  }

  return {
    session, dropOthers, runJob,
    clients: legacy.clients, input: legacy.input, resize: legacy.resize, screen: legacy.screen, hasShell: legacy.hasShell,
    stop: () => { for (const s of [...sessions.values()]) kill(s); },
  };
}

module.exports = { createCore };
