// The part of the agent that actually does things on your Mac:
//   - one long-lived terminal (zsh) that keeps running when your phone disconnects
//   - one-off commands ("jobs") that run on their own and report their output
// Transports (direct P2P, or the optional relay) plug in as "clients".

const os = require('os');
const { spawn } = require('child_process');
const pty = require('node-pty');

const BUFFER_LIMIT = 256 * 1024;
const JOB_TIMEOUT_MS = 10 * 60e3;
const JOB_OUTPUT_LIMIT = 64 * 1024;
const SHELL = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');

function createCore({ log, power }) {
  let term = null;
  let buffer = '';
  const clients = new Set(); // functions that receive {t:'o'|...} messages
  const ran = new Set();
  let running = 0;

  const broadcast = (msg) => { for (const c of clients) { try { c(msg); } catch {} } };

  function startShell(cols = 80, rows = 24) {
    buffer = '';
    term = pty.spawn(SHELL, ['-l'], {
      name: 'xterm-256color', cols, rows, cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', POCKET_TERMINAL: '1' },
    });
    term.onData((d) => {
      buffer += d; if (buffer.length > BUFFER_LIMIT) buffer = buffer.slice(-BUFFER_LIMIT);
      broadcast({ t: 'o', d });
    });
    term.onExit(() => { term = null; broadcast({ t: 'o', d: '\r\n\x1b[33m[shell exited, press Enter for a new one]\x1b[0m\r\n' }); });
  }

  function input(d) { power && power.activity(); if (!term) startShell(); else term.write(d); }
  function resize(cols, rows) {
    if (!(cols > 0 && rows > 0 && cols < 1000 && rows < 1000)) return;
    if (!term) startShell(cols, rows); else term.resize(cols, rows);
  }

  // Run one command by itself. Never runs the same id twice.
  function runJob(id, cmd, onDone) {
    if (ran.has(id) || typeof cmd !== 'string' || !cmd.trim() || cmd.length > 4000) return false;
    ran.add(id); if (ran.size > 2000) ran.delete(ran.values().next().value);
    log(`command ${id} started`); // the command text itself is never logged
    running++; power && power.setJobs(running);
    let out = '';
    const child = spawn(SHELL, ['-lc', cmd], { cwd: os.homedir(), env: process.env });
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
    clients, broadcast, input, resize, runJob,
    screen: () => buffer,
    hasShell: () => !!term,
    stop: () => { try { term && term.kill(); } catch {} },
  };
}

module.exports = { createCore };
