#!/usr/bin/env node
// Local mode: runs the relay AND the agent on your Mac. No outside server.
// Your phone connects straight to the Mac, so they must be able to reach each other:
//   - same Wi-Fi, or
//   - the Mac joined to your phone's hotspot (works anywhere), or
//   - IPv6, if your networks allow incoming connections.
//
//   node start.js --setup   choose the phone password
//   node start.js           start everything
//   node start.js --urls    show the addresses to open on your phone

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = process.env.POCKET_HOME || path.join(os.homedir(), '.pocket-terminal');
const CONFIG_FILE = path.join(CONFIG_DIR, 'local.json');
const ROOT = path.join(__dirname, '..');

// Reads one line without showing it on screen. Extra typed-ahead lines are kept for the next ask.
let pending = '';
function askHidden(q) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(q);
    let s = '';
    const take = () => {
      while (pending.length) {
        const c = pending[0]; pending = pending.slice(1);
        if (c === '\r' || c === '\n' || c === '\u0004') {
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause(); stdin.removeListener('data', on); process.stdout.write('\n'); resolve(s); return true;
        }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(1); }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1); else s += c;
      }
      return false;
    };
    const on = (ch) => { pending += ch; take(); };
    if (take()) return;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding('utf8'); stdin.on('data', on); stdin.resume();
  });
}

async function setup() {
  const a = await askHidden('Phone password (12+ characters): ');
  if (a.length < 12) { console.error('Too short.'); process.exit(1); }
  const b = await askHidden('Type it again: ');
  if (a !== b) { console.error('Did not match.'); process.exit(1); }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(a, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  const old = load() || {};
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    port: old.port || 8080,
    passwordHash: `scrypt:${salt}:${hash}`,
    agentToken: crypto.randomBytes(32).toString('hex'), // new token also signs out old phone logins
  }, null, 2), { mode: 0o600 });
  console.log(`Saved to ${CONFIG_FILE}`);
}

function load() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}

function urls(port) {
  const out = [`http://${os.hostname().replace(/\.local$/, '')}.local:${port}   (same Wi-Fi / hotspot, easiest)`];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family === 'IPv4') out.push(`http://${a.address}:${port}   (${name}, same network)`);
      else if (a.family === 'IPv6' && !a.address.startsWith('fe80') && !a.address.startsWith('fd'))
        out.push(`http://[${a.address}]:${port}   (${name}, IPv6: may work from anywhere)`);
    }
  }
  return out;
}

function start() {
  const cfg = load();
  if (!cfg) { console.error('Not set up. Run:  node start.js --setup'); process.exit(1); }
  // relay
  process.env.PORT = String(cfg.port);
  process.env.APP_PASSWORD_HASH = cfg.passwordHash;
  process.env.AGENT_TOKEN = cfg.agentToken;
  require(path.join(ROOT, 'relay', 'server.js'));
  // agent, talking to the relay on this same Mac
  process.env.RELAY_URL = `http://127.0.0.1:${cfg.port}`;
  process.env.POCKET_EMBEDDED = '1';
  setTimeout(() => require(path.join(ROOT, 'agent', 'agent.js')), 500);
  console.log('Open one of these on your phone:\n  ' + urls(cfg.port).join('\n  '));
}

if (process.argv.includes('--setup')) setup();
else if (process.argv.includes('--urls')) { const c = load(); console.log(urls(c ? c.port : 8080).join('\n')); }
else start();
