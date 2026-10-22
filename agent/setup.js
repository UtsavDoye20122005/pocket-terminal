#!/usr/bin/env node
// Setup helper used by install.sh. Each step is safe to run again.
//   node setup.js secrets            choose phone password, make the Mac's secret token
//   node setup.js cloud-init <repo>  write the Oracle setup script with your secrets in it
//   node setup.js relay              tell the agent where your relay lives

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.POCKET_HOME || path.join(os.homedir(), '.pocket-terminal');
const SECRETS = path.join(DIR, 'secrets.json');
const AGENT = path.join(DIR, 'agent.json');
const CLOUD_INIT = path.join(DIR, 'oracle-cloud-init.sh');
const TEMPLATE = path.join(__dirname, '..', 'relay', 'deploy', 'oracle-cloud-init.template.sh');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, d) => { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify(d, null, 2), { mode: 0o600 }); };

// Read a line. Hidden = don't show what you type (for passwords).
let pending = '';
function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(q);
    let s = '';
    const take = () => {
      while (pending.length) {
        const c = pending[0]; pending = pending.slice(1);
        if (c === '\r' || c === '\n' || c === '\u0004') {
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause(); stdin.removeListener('data', on); if (hidden) process.stdout.write('\n'); resolve(s.trim()); return true;
        }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(1); }
        if (c === '\u007f' || c === '\b') { if (s) { s = s.slice(0, -1); if (!hidden) process.stdout.write('\b \b'); } }
        else { s += c; if (!hidden && stdin.isTTY) process.stdout.write(c); }
      }
      return false;
    };
    const on = (ch) => { pending += ch; take(); };
    if (take()) return;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding('utf8'); stdin.on('data', on); stdin.resume();
  });
}

async function secrets() {
  if (readJson(SECRETS)) return console.log('Secrets already set. (Delete ~/.pocket-terminal/secrets.json to start over.)');
  const a = await ask('Choose the password you will type on your phone (12+ characters): ', true);
  if (a.length < 12) { console.error('Too short. Run the installer again.'); process.exit(1); }
  const b = await ask('Type it again: ', true);
  if (a !== b) { console.error('Did not match. Run the installer again.'); process.exit(1); }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(a, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  writeJson(SECRETS, { passwordHash: `scrypt:${salt}:${hash}`, agentToken: crypto.randomBytes(32).toString('hex') });
  console.log('Saved. Only a scrambled version of the password is stored.');
}

function cloudInit(repo) {
  const s = readJson(SECRETS);
  if (!s) { console.error('Run secrets first.'); process.exit(1); }
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?$/.test(repo)) { console.error(`That doesn't look like a GitHub repo URL: ${repo}`); process.exit(1); }
  const out = fs.readFileSync(TEMPLATE, 'utf8')
    .replace('__REPO__', repo).replace('__HASH__', s.passwordHash).replace('__TOKEN__', s.agentToken);
  fs.writeFileSync(CLOUD_INIT, out, { mode: 0o600 });
  console.log(CLOUD_INIT);
}

async function relay() {
  const s = readJson(SECRETS);
  if (!s) { console.error('Run secrets first.'); process.exit(1); }
  const cur = readJson(AGENT);
  const a = await ask(`Your Oracle server's public IP (like 140.238.1.2)${cur ? ` [Enter = keep ${cur.relay}]` : ' [Enter = skip for now]'}: `);
  process.stdout.write('\n');
  let url;
  if (!a) { if (!cur) { console.log('Skipped. Run the installer again once your server is up.'); process.exit(3); } url = cur.relay; }
  else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) url = `https://${a.replace(/\./g, '-')}.sslip.io`;
  else if (/^https?:\/\//.test(a)) url = a.replace(/\/+$/, '');
  else { console.error('Type the IP address, like 140.238.1.2'); process.exit(1); }
  writeJson(AGENT, { relay: url, token: s.agentToken });
  process.stdout.write(`Checking ${url} … `);
  try {
    const r = await fetch(url + '/healthz', { signal: AbortSignal.timeout(10e3) });
    console.log(r.ok ? 'reachable ✅' : `answered ${r.status}`);
  } catch (e) {
    console.log('not reachable yet ❌ (the server may still be setting up; it takes ~5 min). The agent will keep trying.');
  }
  console.log(`RELAY=${url}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'secrets') secrets();
else if (cmd === 'cloud-init') cloudInit(arg);
else if (cmd === 'relay') relay();
else { console.log('usage: node setup.js secrets | cloud-init <github-repo-url> | relay'); process.exit(1); }
