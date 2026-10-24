#!/usr/bin/env node
// Pair your phone with this Mac.
//   node pair.js                 show the QR code (makes a pairing secret the first time)
//   node pair.js --new           new secret: every phone paired before is locked out
//   node pair.js --app-url URL   use your own copy of the phone app (recommended, see SECURITY.md)
//   node pair.js --board URL     add a second message board (e.g. your own ntfy server)
//
// The secret travels inside the part of the link after "#", which browsers never send
// to any server. Treat the QR code like a password: don't screenshot or share it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { newSecret, derive } = require('./lib/crypto');

const DIR = process.env.POCKET_HOME || path.join(os.homedir(), '.pocket-terminal');
const FILE = path.join(DIR, 'direct.json');
const DEFAULT_APP = 'https://utsavdoye20122005.github.io/pocket-terminal/';
const DEFAULT_BOARDS = ['https://ntfy.sh'];

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

let cfg = null; try { cfg = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const fresh = !cfg || args.includes('--new');
if (fresh) {
  cfg = { ...(cfg || {}), secret: newSecret() };
  if (args.includes('--new')) console.log('New pairing secret made. Phones paired before can no longer connect.\n');
}
cfg.name = arg('--name') || cfg.name || os.hostname().replace(/\.local$/, '');
cfg.appUrl = arg('--app-url') || cfg.appUrl || process.env.POCKET_APP_URL || DEFAULT_APP;
cfg.boards = cfg.boards || DEFAULT_BOARDS;
const extra = arg('--board'); if (extra && !cfg.boards.includes(extra)) cfg.boards.push(extra.replace(/\/+$/, ''));
cfg.notify = cfg.notify !== false;
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });

const params = new URLSearchParams({ pair: cfg.secret, name: cfg.name });
if (cfg.boards.join(',') !== DEFAULT_BOARDS.join(',')) params.set('boards', cfg.boards.join(','));
const link = cfg.appUrl.replace(/#.*$/, '') + '#' + params.toString();

if (args.includes('--link-only')) { console.log(link); process.exit(0); }

console.log('Scan this with your iPhone camera (or any QR scanner):\n');
qrcode.generate(link, { small: true });
console.log(`\nOr open this link on your phone:\n${link}\n`);
console.log('On the phone: choose an app PIN, then Share → Add to Home Screen.');
console.log(`Notifications (optional): install the "ntfy" app and subscribe to topic: ${derive(cfg.secret).notifyTopic}`);
console.log('\n⚠️  This code = full access to your Mac. Close this window when you are done.');
if (fresh || args.includes('--new')) console.log('   (If the agent is running, restart it:  launchctl kickstart -k gui/$(id -u)/com.pocketterminal.agent)');
