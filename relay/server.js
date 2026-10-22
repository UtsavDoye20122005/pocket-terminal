// Pocket Terminal relay.
// Your Mac (the agent) and your phone both connect OUT to this server.
// It checks your password, passes keystrokes and output between them, keeps a
// queue of commands for when the Mac is asleep, stores your saved commands
// (snippets), and sends phone notifications.
//
// Settings (environment variables):
//   APP_PASSWORD_HASH  "scrypt:<salt>:<hash>" made by the Mac installer   (or APP_PASSWORD, plain, 12+ chars)
//   AGENT_TOKEN        long random secret the Mac uses to prove it's your Mac (32+ chars)
//   PORT               default 8080
//   HOST               default '::' (all addresses). On Oracle we use 127.0.0.1 behind Caddy.
//   DATA_DIR           where the queue, snippets and notification keys are saved. Default ./data

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
let webpush = null;
try { webpush = require('web-push'); } catch { /* notifications off if not installed */ }

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '::';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const APP_PASSWORD_HASH = process.env.APP_PASSWORD_HASH || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if ((APP_PASSWORD.length < 12 && !APP_PASSWORD_HASH.startsWith('scrypt:')) || AGENT_TOKEN.length < 32) {
  console.error('Set APP_PASSWORD_HASH (or APP_PASSWORD, 12+ chars) and AGENT_TOKEN (32+ chars) before starting.');
  process.exit(1);
}

const COOKIE = 'pt_session';
const SESSION_DAYS = 30;
const BUFFER_LIMIT = 256 * 1024;
const MAX_JOBS = 50;
const MAX_SNIPPETS = 60;
// Changing the password or token signs out every phone.
const SECRET = crypto.createHash('sha256').update(`session|${APP_PASSWORD || APP_PASSWORD_HASH}|${AGENT_TOKEN}`).digest();

// ---------- helpers ----------

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

function passwordOk(pw) {
  if (!APP_PASSWORD_HASH) return safeEqual(pw, APP_PASSWORD);
  const [, salt, hash] = APP_PASSWORD_HASH.split(':');
  const got = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(hash, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function makeToken() {
  const payload = `${now() + SESSION_DAYS * 864e5}.${crypto.randomBytes(8).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}
function validToken(t) {
  if (!t) return false;
  const i = t.lastIndexOf('.');
  if (i < 0) return false;
  const payload = t.slice(0, i);
  return safeEqual(sign(payload), t.slice(i + 1)) && parseInt(payload, 10) > now();
}
function cookies(h = '') {
  const o = {};
  for (const p of h.split(';')) { const j = p.indexOf('='); if (j > 0) o[p.slice(0, j).trim()] = decodeURIComponent(p.slice(j + 1).trim()); }
  return o;
}
const authed = (req) => validToken(cookies(req.headers.cookie)[COOKIE]);
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { const h = new URL(o).host; return h === req.headers.host || h === req.headers['x-forwarded-host']; } catch { return false; }
}
function body(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > limit) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => resolve(b));
  });
}
async function jsonBody(req) { try { return JSON.parse(await body(req)); } catch { return null; } }
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
const id = () => crypto.randomBytes(6).toString('hex');

// ---------- saved data (survives restarts) ----------

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
function load(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return fallback; } }
const saveTimers = {};
function save(name, data) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    const f = path.join(DATA_DIR, name);
    fs.writeFile(f + '.tmp', JSON.stringify(data), { mode: 0o600 }, (e) => { if (!e) fs.rename(f + '.tmp', f, () => {}); });
  }, 200);
}

const jobs = load('jobs.json', []);            // {id, cmd, status, created, started, finished, code, out}
const snippets = load('snippets.json', [       // one-tap saved commands
  { id: id(), name: 'Disk space', cmd: 'df -h /' },
  { id: id(), name: 'Battery', cmd: 'pmset -g batt' },
  { id: id(), name: 'Top processes', cmd: 'ps -Ao pid,%cpu,%mem,comm -r | head -8' },
]);
const mac = load('mac.json', { lastSeen: 0, nextWake: null, power: null, pendingPower: null });
const pushSubs = load('push.json', []);        // phone notification subscriptions
let vapid = load('vapid.json', null);
if (webpush) {
  if (!vapid) { vapid = webpush.generateVAPIDKeys(); save('vapid.json', vapid); }
  webpush.setVapidDetails('mailto:pocket-terminal@localhost', vapid.publicKey, vapid.privateKey);
}
// Jobs that were mid-run when the relay restarted get sent again.
for (const j of jobs) if (j.status === 'running') j.status = 'queued';

// ---------- brute-force lock: 8 wrong passwords in 15 min → locked 15 min ----------
const fails = []; let lockedUntil = 0;
const locked = () => now() < lockedUntil;
function failed() {
  fails.push(now());
  while (fails.length && fails[0] < now() - 15 * 60e3) fails.shift();
  if (fails.length >= 8) { lockedUntil = now() + 15 * 60e3; fails.length = 0; }
}

// ---------- live state ----------

let agent = null;
let buffer = '';
const phones = new Set();
let notifyWhenOnline = false; // a phone asked "tell me when the Mac wakes up"

const status = () => ({ t: 's', online: !!agent, lastSeen: agent ? now() : mac.lastSeen, nextWake: agent ? null : mac.nextWake, power: mac.power, notifyWhenOnline });
function toPhones(msg) { const s = JSON.stringify(msg); for (const p of phones) if (p.readyState === 1) p.send(s); }
function toAgent(msg) { if (agent && agent.readyState === 1) { agent.send(JSON.stringify(msg)); return true; } return false; }
const publicJob = (j) => ({ id: j.id, cmd: j.cmd, status: j.status, created: j.created, started: j.started, finished: j.finished, code: j.code, out: j.out });
const jobsMsg = () => ({ t: 'jobs', jobs: jobs.map(publicJob) });
function jobsChanged() { save('jobs.json', jobs); toPhones(jobsMsg()); }
function sendPending() {
  for (const j of jobs) if (j.status === 'queued' && toAgent({ t: 'job', id: j.id, cmd: j.cmd })) { j.status = 'running'; j.started = now(); }
  jobsChanged();
}
// Tell the Mac whether a phone is watching, so it stays awake for you.
const tellWant = () => toAgent({ t: 'want', phones: phones.size });

async function notify(title, body, tag) {
  if (!webpush || !pushSubs.length) return;
  const payload = JSON.stringify({ title, body, tag });
  for (const sub of [...pushSubs]) {
    try { await webpush.sendNotification(sub, payload, { TTL: 3600 }); }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { pushSubs.splice(pushSubs.indexOf(sub), 1); save('push.json', pushSubs); }
      else log('push failed', e.statusCode || e.message);
    }
  }
}

// ---------- HTTP ----------

const PUB = path.join(__dirname, 'public');
const NM = path.join(__dirname, 'node_modules');
const STATIC = {
  '/xterm.js': [path.join(NM, '@xterm/xterm/lib/xterm.js'), 'text/javascript'],
  '/xterm.css': [path.join(NM, '@xterm/xterm/css/xterm.css'), 'text/css'],
  '/addon-fit.js': [path.join(NM, '@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript'],
  '/manifest.json': [path.join(PUB, 'manifest.json'), 'application/manifest+json'],
  '/sw.js': [path.join(PUB, 'sw.js'), 'text/javascript'],
  '/icon.svg': [path.join(PUB, 'icon.svg'), 'image/svg+xml'],
  '/icon.png': [path.join(PUB, 'icon.png'), 'image/png'],
  '/login': [path.join(PUB, 'login.html'), 'text/html; charset=utf-8'],
};
function file(res, f, type) {
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': type }); res.end(d); });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'");
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const M = req.method;

  if (p === '/healthz') return json(res, 200, { ok: true });
  if (M === 'GET' && STATIC[p]) return file(res, ...STATIC[p]);

  if (p === '/login' && M === 'POST') {
    if (!sameOrigin(req)) { res.writeHead(403); return res.end(); }
    if (locked()) { res.writeHead(302, { Location: '/login?e=locked' }); return res.end(); }
    let pw = '';
    try { pw = new URLSearchParams(await body(req)).get('password') || ''; } catch { res.writeHead(413); return res.end(); }
    if (!passwordOk(pw)) {
      failed(); log('failed login');
      res.writeHead(302, { Location: locked() ? '/login?e=locked' : '/login?e=wrong' }); return res.end();
    }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`, Location: '/' });
    log('login ok');
    return res.end();
  }
  if (p === '/logout' && M === 'POST') { res.writeHead(302, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0`, Location: '/login' }); return res.end(); }

  // ----- everything below needs a login -----
  if (!authed(req)) {
    if (p.startsWith('/api/')) return json(res, 401, { error: 'login' });
    res.writeHead(302, { Location: '/login' }); return res.end();
  }
  if (p === '/' && M === 'GET') return file(res, path.join(PUB, 'index.html'), 'text/html; charset=utf-8');
  if (M !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'origin' });

  // queue
  if (p === '/api/jobs' && M === 'GET') return json(res, 200, { jobs: jobs.map(publicJob), ...status() });
  if (p === '/api/jobs' && M === 'POST') {
    const b = await jsonBody(req); const cmd = String(b?.cmd || '').trim();
    if (!cmd || cmd.length > 4000) return json(res, 400, { error: 'Command is empty or too long' });
    const job = { id: id(), cmd, status: 'queued', created: now() };
    jobs.unshift(job); while (jobs.length > MAX_JOBS) jobs.pop();
    sendPending();
    return json(res, 200, { job: publicJob(job) });
  }
  let m = p.match(/^\/api\/jobs\/([a-f0-9]{12})$/);
  if (m && M === 'DELETE') {
    const i = jobs.findIndex((j) => j.id === m[1]);
    if (i >= 0 && jobs[i].status !== 'running') jobs.splice(i, 1);
    jobsChanged(); return json(res, 200, { ok: true });
  }
  if (p === '/api/jobs/clear' && M === 'POST') {
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].status === 'done') jobs.splice(i, 1);
    jobsChanged(); return json(res, 200, { ok: true });
  }

  // snippets
  if (p === '/api/snippets' && M === 'GET') return json(res, 200, { snippets });
  if (p === '/api/snippets' && M === 'POST') {
    const b = await jsonBody(req);
    const name = String(b?.name || '').trim().slice(0, 40); const cmd = String(b?.cmd || '').trim();
    if (!name || !cmd || cmd.length > 4000) return json(res, 400, { error: 'Give it a name and a command' });
    if (snippets.length >= MAX_SNIPPETS) return json(res, 400, { error: 'Too many snippets' });
    snippets.push({ id: id(), name, cmd }); save('snippets.json', snippets);
    toPhones({ t: 'snippets', snippets }); return json(res, 200, { snippets });
  }
  m = p.match(/^\/api\/snippets\/([a-f0-9]{12})$/);
  if (m && M === 'DELETE') {
    const i = snippets.findIndex((s) => s.id === m[1]); if (i >= 0) snippets.splice(i, 1);
    save('snippets.json', snippets); toPhones({ t: 'snippets', snippets }); return json(res, 200, { snippets });
  }

  // power settings (sent to the Mac now, or when it next checks in)
  if (p === '/api/power' && M === 'POST') {
    const b = await jsonBody(req); if (!b || typeof b !== 'object') return json(res, 400, { error: 'bad settings' });
    mac.pendingPower = { ...(mac.pendingPower || {}), ...b }; save('mac.json', mac);
    if (toAgent({ t: 'settings', power: mac.pendingPower })) { mac.pendingPower = null; save('mac.json', mac); }
    return json(res, 200, { ok: true, pending: !agent });
  }

  // notifications
  if (p === '/api/push/key' && M === 'GET') return json(res, 200, { key: webpush ? vapid.publicKey : null });
  if (p === '/api/push/subscribe' && M === 'POST') {
    const b = await jsonBody(req);
    if (!b?.endpoint || !b?.keys?.p256dh || !b?.keys?.auth) return json(res, 400, { error: 'bad subscription' });
    if (!pushSubs.some((s) => s.endpoint === b.endpoint)) { pushSubs.push({ endpoint: b.endpoint, keys: b.keys }); save('push.json', pushSubs); }
    return json(res, 200, { ok: true });
  }
  if (p === '/api/push/test' && M === 'POST') { await notify('Pocket Terminal', 'Notifications are working ✅', 'test'); return json(res, 200, { ok: true, devices: pushSubs.length }); }
  if (p === '/api/notify-online' && M === 'POST') {
    const b = await jsonBody(req); notifyWhenOnline = !!b?.on; toPhones(status()); return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end();
});

// ---------- WebSockets ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  let role = null;
  if (p === '/agent' && bearer && safeEqual(bearer, AGENT_TOKEN)) role = 'agent';
  else if (p === '/ws' && req.headers.origin && sameOrigin(req) && authed(req)) role = 'phone';
  if (!role) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => (role === 'agent' ? onAgent(ws) : onPhone(ws)));
});

function onAgent(ws) {
  if (agent) try { agent.close(4000, 'replaced'); } catch {}
  agent = ws; mac.lastSeen = now(); mac.nextWake = null; save('mac.json', mac);
  log('Mac connected');
  if (mac.pendingPower) { toAgent({ t: 'settings', power: mac.pendingPower }); mac.pendingPower = null; }
  tellWant();
  toPhones(status());
  if (notifyWhenOnline) { notifyWhenOnline = false; notify('Your Mac is awake', 'Tap to open your terminal.', 'online'); }
  for (const j of jobs) if (j.status === 'running') j.status = 'queued';
  sendPending();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; mac.lastSeen = now(); });
  ws.on('message', (raw) => {
    mac.lastSeen = now();
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'o') {
      buffer += m.d; if (buffer.length > BUFFER_LIMIT) buffer = buffer.slice(-BUFFER_LIMIT);
      toPhones({ t: 'o', d: m.d });
    } else if (m.t === 'buf') {
      buffer = String(m.d || '').slice(-BUFFER_LIMIT);
      toPhones({ t: 'reset', d: buffer });
    } else if (m.t === 'jobdone') {
      const j = jobs.find((x) => x.id === m.id);
      if (j) {
        j.status = 'done'; j.code = m.code; j.out = String(m.out || '').slice(-64 * 1024); j.finished = now();
        const lastLine = (j.out.trim().split('\n').pop() || '').slice(0, 120);
        notify(j.code === 0 ? `✅ ${j.cmd.slice(0, 60)}` : `❌ ${j.cmd.slice(0, 60)} (exit ${j.code})`, lastLine || 'Done, no output', 'job-' + j.id);
      }
      jobsChanged();
    } else if (m.t === 'power') {
      const { t, ...p } = m; mac.power = p; save('mac.json', mac); toPhones(status());
    } else if (m.t === 'sleeping') {
      mac.nextWake = m.nextWake || null; save('mac.json', mac);
      log('Mac going to sleep, next check-in', mac.nextWake ? new Date(mac.nextWake).toISOString() : 'none');
    }
  });
  ws.on('close', () => {
    if (agent === ws) { agent = null; mac.lastSeen = now(); save('mac.json', mac); log('Mac disconnected'); toPhones(status()); }
  });
}

function onPhone(ws) {
  phones.add(ws); tellWant();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify(status()));
  ws.send(JSON.stringify({ t: 'reset', d: buffer }));
  ws.send(JSON.stringify(jobsMsg()));
  ws.send(JSON.stringify({ t: 'snippets', snippets }));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'i' && typeof m.d === 'string') toAgent({ t: 'i', d: m.d });
    else if (m.t === 'r') toAgent({ t: 'r', cols: m.cols | 0, rows: m.rows | 0 });
  });
  ws.on('close', () => { phones.delete(ws); tellWant(); });
}

// Ping everyone every 20s. Drop anyone who didn't answer the last ping.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 20e3);

server.on('error', (e) => {
  if (e.code === 'EAFNOSUPPORT' && HOST === '::') return server.listen(PORT, '0.0.0.0'); // IPv6 off: use IPv4
  throw e;
});
server.listen(PORT, HOST, () => log(`Relay listening on port ${PORT}`));
