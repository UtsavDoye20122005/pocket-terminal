// Pocket Terminal phone app. Static files only (GitHub Pages); no server of its own.
//
// Flow: pair (QR link → PIN) → unlock → read your private mailbox on the board →
//       post encrypted "hello" + "offer" → Mac answers → direct WebRTC link → live terminal.
// If the direct link can't open, commands go as encrypted notes through the board instead.

import { derive, seal, open, randomId, lockSecret, unlockSecret } from './crypto.js';
import { Board, MAX_NOTE } from './board.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_BOARDS = ['https://ntfy.sh'];
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('pt_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pt_' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('pt_' + k); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ago = (t) => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
let toastT; const toast = (m) => { const t = $('toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => (t.style.display = 'none'), 2600); };
const show = (id) => { for (const g of ['gate-pair', 'gate-lock', 'gate-none', 'app']) $(g).hidden = g !== id; };

// ---------- unlocked-session cache (IndexedDB keeps the key non-extractable) ----------
function idb() { return new Promise((res, rej) => { const r = indexedDB.open('pocket-terminal', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbGet(k) { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch { return null; } }
async function idbSet(k, v) { try { const db = await idb(); await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); } catch {} }
async function idbDel(k) { try { const db = await idb(); await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = res; }); } catch {} }

// ---------- boot: pair / lock / not paired ----------
let pendingPair = null;
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('pair')) {
    const boards = (h.get('boards') || '').split(',').filter((u) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u));
    pendingPair = { secret: h.get('pair'), name: (h.get('name') || 'your Mac').slice(0, 40), boards: boards.length ? boards : DEFAULT_BOARDS };
    history.replaceState(null, '', location.pathname + location.search); // remove the secret from the address bar
    $('pairName').textContent = pendingPair.name;
    show('gate-pair'); return;
  }
  const vault = store.get('vault');
  if (!vault) return show('gate-none');
  const s = await idbGet('session');
  if (s && s.expires > Date.now() && s.topic === vault.topic) return start(s);
  $('lockName').textContent = vault.name;
  show('gate-lock'); setTimeout(() => $('pin').focus(), 50);
}

$('pairForm').onsubmit = async (e) => {
  e.preventDefault();
  const a = $('pin1').value, b = $('pin2').value;
  if (a.length < 6) return ($('pairErr').textContent = 'Use at least 6 digits.');
  if (a !== b) return ($('pairErr').textContent = "PINs don't match.");
  let keys; try { keys = await derive(pendingPair.secret); } catch { return ($('pairErr').textContent = 'This pairing link is broken. Make a new QR on your Mac.'); }
  const locked = await lockSecret(pendingPair.secret, a);
  store.set('vault', { ...locked, name: pendingPair.name, boards: pendingPair.boards, topic: keys.topic });
  store.set('fails', 0); store.del('jobs');
  const s = { key: keys.key, topic: keys.topic, notifyTopic: keys.notifyTopic, boards: pendingPair.boards, name: pendingPair.name, expires: Date.now() + 12 * 3600e3 };
  await idbSet('session', s);
  pendingPair = null; start(s);
};

$('lockForm').onsubmit = async (e) => {
  e.preventDefault();
  const vault = store.get('vault');
  const secret = await unlockSecret(vault, $('pin').value);
  $('pin').value = '';
  if (!secret) {
    const f = store.get('fails', 0) + 1; store.set('fails', f);
    if (f >= 10) { store.del('vault'); await idbDel('session'); show('gate-none'); toast('Too many wrong PINs: this phone was unpaired.'); return; }
    $('lockErr').textContent = `Wrong PIN. ${10 - f} tries left before this phone is unpaired.`; return;
  }
  store.set('fails', 0);
  const keys = await derive(secret);
  const s = { key: keys.key, topic: keys.topic, notifyTopic: keys.notifyTopic, boards: vault.boards || DEFAULT_BOARDS, name: vault.name, expires: Date.now() + ($('remember').checked ? 12 * 3600e3 : 0) };
  if ($('remember').checked) await idbSet('session', s); else await idbDel('session');
  start(s);
};

// ---------- main ----------
let S, keys, board, term, fit;
let pc = null, dc = null, linkState = 'idle', lastAttempt = 0, offerAt = 0, answerTimer = null, openTimer = null;
const seen = new Set();
const mac = { state: null, ts: 0, nextWake: null, checkIn: null, power: null, name: '' };
let livePower = null;

async function post(type, extra = {}) {
  const text = await seal(keys, { id: randomId(), ts: Date.now(), from: 'phone', type, ...extra });
  if (text.length > MAX_NOTE) throw new Error('Too long to send');
  await board.publish(text);
}

function start(session) {
  S = session; keys = { key: S.key, topic: S.topic, notifyTopic: S.notifyTopic };
  mac.name = S.name;
  show('app');
  $('notifyTopic').textContent = S.notifyTopic;
  setupTerminal(); setupUi();
  board = new Board(S.boards, S.topic, onNoteText, () => paint());
  board.start('12h'); // read the last 12 h: Mac status, answers to old commands
  setTimeout(() => connect(), 400);
  setInterval(paint, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    board.restart(); // phones kill background connections
    if (!dc || dc.readyState !== 'open') connect();
  });
}

async function onNoteText(text) {
  const m = await open(keys, text);
  if (!m || m.from !== 'mac' || typeof m.id !== 'string' || seen.has(m.id)) return;
  seen.add(m.id);
  if (localStorage.getItem('pt_debug')) console.log('note', m.type, m.state || '', new Date(m.ts).toISOString());
  if (m.type === 'status') {
    if (m.ts < mac.ts) return;
    Object.assign(mac, { state: m.state, ts: m.ts, nextWake: m.nextWake, checkIn: m.checkIn, power: m.power, name: m.name || mac.name });
    // The Mac just woke up and saw our hello: open the direct link now.
    // (If an offer is still waiting, the Mac answers that one; don't start another.)
    if (m.state === 'online' && Date.now() - m.ts < 3 * 60e3 && (!dc || dc.readyState !== 'open') && Date.now() - offerAt > 80e3) connect({ hello: false });
  } else if (m.type === 'answer') {
    if (localStorage.getItem('pt_debug')) console.log('answer', m.oid, 'mine', pc && pc.oid, pc && pc.signalingState);
  }
  if (m.type === 'answer' && pc && m.oid === pc.oid && pc.signalingState === 'have-local-offer') {
    clearTimeout(answerTimer);
    try { await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); } catch { return; }
    clearTimeout(openTimer);
    openTimer = setTimeout(() => { if (!dc || dc.readyState !== 'open') { linkState = 'backup'; paint(); } }, 20e3);
  } else if (m.type === 'result') {
    gotResult(m.cid, m.code, m.out);
  }
  paint();
}

// ---------- direct link ----------
function gatherDone(p, ms) {
  return new Promise((res) => {
    if (p.iceGatheringState === 'complete') return res();
    const t = setTimeout(res, ms);
    p.addEventListener('icegatheringstatechange', () => { if (p.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
}
async function connect({ hello = true } = {}) {
  if (dc && dc.readyState === 'open') return;
  if (Date.now() - lastAttempt < 5000) return;
  lastAttempt = Date.now();
  try { pc && pc.close(); } catch {}
  linkState = 'connecting'; paint();
  pc = new RTCPeerConnection({ iceServers: ICE });
  pc.oid = randomId(); // each attempt has its own id; only its own answer is accepted
  const ch = pc.createDataChannel('pt', { ordered: true });
  wire(ch);
  pc.onconnectionstatechange = () => { if (pc && pc.connectionState === 'failed' && (!dc || dc.readyState !== 'open')) { linkState = 'backup'; paint(); } };
  await pc.setLocalDescription(await pc.createOffer());
  await gatherDone(pc, 4000);
  const mine = pc;
  try {
    if (hello) await post('hello');
    if (pc !== mine) return; // a newer attempt replaced this one
    await post('offer', { oid: mine.oid, sdp: mine.localDescription.sdp });
    offerAt = Date.now();
  } catch (e) { linkState = 'noboard'; toast(e.message); paint(); return; }
  clearTimeout(answerTimer);
  answerTimer = setTimeout(() => { if (!dc || dc.readyState !== 'open') { linkState = 'waiting'; paint(); } }, 15e3);
}

function wire(ch) {
  ch.onopen = () => {
    dc = ch; linkState = 'direct'; clearTimeout(answerTimer); clearTimeout(openTimer);
    mac.state = 'online'; mac.ts = Date.now();
    fit.fit(); sendTerm({ t: 'r', cols: term.cols, rows: term.rows });
    paint(); toast('Connected directly 🔒');
  };
  ch.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'o') term.write(m.d);
    else if (m.t === 'reset') { term.reset(); if (m.d) term.write(m.d); }
    else if (m.t === 'power') { livePower = m; paint(); }
    else if (m.t === 'result') gotResult(m.id, m.code, m.out);
  };
  ch.onclose = () => {
    if (dc !== ch) return;
    dc = null; linkState = 'waiting'; paint();
    // The Mac probably went to sleep. It will tell the board; we reconnect when it's back.
    setTimeout(() => { if (document.visibilityState === 'visible') connect(); }, 2000);
  };
}
const sendTerm = (m) => { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(m)); };

// ---------- status bar + banner ----------
function nextCheckIn() {
  if (mac.state !== 'sleeping' || !mac.nextWake) return null;
  let t = mac.nextWake; const step = (mac.checkIn || 5) * 60e3;
  while (t < Date.now() - 30e3 && step > 0) t += step;
  return t;
}
function until(t) { const s = Math.round((t - Date.now()) / 1000); if (s <= 0) return 'any moment'; const m = Math.floor(s / 60); return m ? `~${m + 1} min` : `${s}s`; }

function paint() {
  if (!term) return;
  const name = mac.name || 'your Mac';
  const p = livePower || mac.power;
  const nci = nextCheckIn();
  let dot = 'off', status = '', banner = null;
  if (linkState === 'direct') { dot = 'on'; status = `${name} · direct 🔒`; }
  else if (linkState === 'connecting') { dot = 'slow'; status = `Connecting to ${name}…`; }
  else if (linkState === 'noboard' || board.up.size === 0) {
    status = 'No internet / message board unreachable';
    banner = ['Can\'t reach the message board', 'Check your internet. It retries by itself.', []];
  } else if (linkState === 'backup') {
    dot = 'slow'; status = `${name} · backup route`;
    banner = ['Direct link blocked on this network', 'Commands still work through the encrypted backup route (a few seconds slower). The live terminal needs the direct link.', [['Run a command', () => openSheet('queue')], ['Try direct again', () => { lastAttempt = 0; connect(); }]]];
  } else if (mac.state === 'sleeping' && nci) {
    status = `${name} asleep · check-in ${until(nci)}`;
    banner = [`${name} is asleep to save battery`, `It wakes by itself to check in (next: ${until(nci)}). Keep this open and it connects on its own, or send a command and it runs at the check-in.`, [['Run a command', () => openSheet('queue')]]];
  } else {
    status = `Waiting for ${name}…`;
    banner = [`Waiting for ${name}`, `Last seen ${ago(mac.ts)}. If it's asleep it will connect at its next check-in. If it's off or offline, commands you send run when it's back.`, [['Run a command', () => openSheet('queue')]]];
  }
  $('dot').className = dot; $('status').textContent = status;
  if (banner) {
    $('banner').hidden = false; $('bannerTitle').textContent = banner[0]; $('bannerText').textContent = banner[1];
    const row = $('bannerRow');
    if (row.dataset.key !== banner[0]) {
      row.dataset.key = banner[0]; row.innerHTML = '';
      banner[2].forEach(([label, fn], i) => { const b = document.createElement('button'); b.className = 'btn small' + (i ? ' ghost' : ''); b.textContent = label; b.onclick = fn; row.appendChild(b); });
    }
  } else $('banner').hidden = true;
  if (p && p.percent != null) {
    $('batt').hidden = false; $('batt').textContent = `${p.onCharger ? '⚡' : '🔋'} ${p.percent}%`;
    $('batt').className = 'chip' + (!p.onCharger && p.percent < 20 ? ' low' : '');
  }
  $('connInfo').textContent = linkState === 'direct' ? 'Direct, end-to-end encrypted (WebRTC/DTLS)' : linkState === 'backup' ? 'Backup route: encrypted notes via the message board' : 'Not connected right now';
  paintPower(p, nci);
}

// ---------- terminal ----------
const KEYS = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~', cc: '\x03', cd: '\x04', cz: '\x1a', cl: '\x0c', cr: '\x12' };
const mods = { ctrl: false, alt: false }, modBtn = {};
function applyMods(d) {
  if (!mods.ctrl && !mods.alt) return d;
  let o = d;
  if (mods.ctrl && d.length === 1) { const c = d.toLowerCase().charCodeAt(0); o = c >= 97 && c <= 122 ? String.fromCharCode(c - 96) : ({ ' ': '\x00', '[': '\x1b', '\\': '\x1c', ']': '\x1d' })[d] ?? d; }
  if (mods.alt) o = '\x1b' + o;
  clearMods();
  return o;
}
function clearMods() { for (const k in mods) { mods[k] = false; modBtn[k] && modBtn[k].classList.remove('on'); } }
function input(d) {
  if (dc && dc.readyState === 'open') sendTerm({ t: 'i', d });
  else toast('No live link yet: use ★ or Commands to send a command');
}
function setupTerminal() {
  let size = store.get('font', matchMedia('(max-width:700px)').matches ? 13 : 15);
  term = new Terminal({ fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: size, cursorBlink: true, scrollback: 5000,
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#2f81f7', selectionBackground: '#264f78' } });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($('term'));
  term.onData((d) => input(applyMods(d)));
  term.onResize(() => sendTerm({ t: 'r', cols: term.cols, rows: term.rows }));
  const setFont = (n) => { size = Math.max(9, Math.min(24, n)); term.options.fontSize = size; store.set('font', size); fit.fit(); };
  $('smaller').onclick = () => setFont(size - 1); $('bigger').onclick = () => setFont(size + 1);
  const app = $('app');
  const layout = () => { const vv = window.visualViewport; app.style.height = (vv ? vv.height : innerHeight) + 'px'; if (vv) app.style.top = vv.offsetTop + 'px'; fit.fit(); };
  if (window.visualViewport) { visualViewport.addEventListener('resize', layout); visualViewport.addEventListener('scroll', layout); }
  addEventListener('resize', layout); layout();
}

// ---------- commands (jobs) ----------
let jobs = store.get('jobs', []);
const saveJobs = () => { jobs = jobs.slice(0, 50); store.set('jobs', jobs); renderJobs(); };
async function runCommand(cmd) {
  cmd = cmd.trim(); if (!cmd) return;
  const j = { cid: randomId(), cmd, created: Date.now(), status: 'sending' };
  jobs.unshift(j); saveJobs();
  try {
    if (dc && dc.readyState === 'open') { sendTerm({ t: 'cmd', id: j.cid, cmd }); j.status = 'running'; }
    else { await post('cmd', { cid: j.cid, cmd }); j.status = 'waiting'; if (linkState !== 'backup' && linkState !== 'connecting') connect(); }
  } catch (e) { j.status = 'error'; j.out = e.message; }
  saveJobs();
}
function gotResult(cid, code, out) {
  const j = jobs.find((x) => x.cid === cid); if (!j || j.status === 'done') return;
  Object.assign(j, { status: 'done', code, out, finished: Date.now() }); saveJobs();
  toast(code === 0 ? `✅ ${j.cmd.slice(0, 40)}` : `❌ ${j.cmd.slice(0, 40)} (exit ${code})`);
}
function renderJobs() {
  $('qn').textContent = jobs.filter((j) => j.status === 'waiting' || j.status === 'running').length || '';
  $('jobs').innerHTML = jobs.length ? jobs.map((j) => {
    const tag = j.status === 'done' ? (j.code === 0 ? '<span class="tag done">done</span>' : `<span class="tag fail">exit ${esc(j.code)}</span>`)
      : j.status === 'running' ? '<span class="tag running">running</span>' : j.status === 'error' ? '<span class="tag fail">not sent</span>' : '<span class="tag">waiting for Mac</span>';
    const out = j.status === 'done' || j.status === 'error' ? `<pre>${esc(j.out) || '(no output)'}</pre>` : '';
    return `<div class="card"><div class="top"><code>${esc(j.cmd)}</code>${tag}</div>${out}<div class="meta"><span>sent ${ago(j.created)}${j.finished ? ' · finished ' + ago(j.finished) : ''}</span><button class="x" data-del="${esc(j.cid)}">remove</button></div></div>`;
  }).join('') : '<div class="empty">No commands yet.</div>';
}

// ---------- snippets (stored on this phone) ----------
let snippets = store.get('snippets', [
  { id: 's1', name: 'Disk space', cmd: 'df -h /' }, { id: 's2', name: 'Battery', cmd: 'pmset -g batt' },
  { id: 's3', name: 'Top processes', cmd: 'ps -Ao pid,%cpu,%mem,comm -r | head -8' }]);
function renderSnips() {
  store.set('snippets', snippets);
  $('snips').innerHTML = snippets.length ? snippets.map((s) => `<div class="card snip"><button class="run" data-run="${esc(s.id)}"><b>${esc(s.name)}</b><code>${esc(s.cmd)}</code></button><button class="x" data-sdel="${esc(s.id)}">✕</button></div>`).join('') : '<div class="empty">Add your common commands below.</div>';
}

// ---------- power ----------
const reasonText = { 'on charger': "it's charging", 'phone connected': 'your phone is connected', 'job running': 'a command is running', 'recent typing': 'you typed recently', 'checking in': "it's checking in", 'instant mode': 'Instant mode is on' };
function paintPower(p, nci) {
  const s = (p && p.settings) || {};
  $('pBatt').textContent = p && p.percent != null ? `${p.percent}%${p.onCharger ? ' ⚡' : ''}` : '–';
  $('pState').textContent = linkState === 'direct' ? 'Awake' : mac.state === 'sleeping' ? 'Asleep' : '–';
  $('pNext').textContent = linkState === 'direct' ? '–' : nci ? until(nci) : '–';
  $('pWhy').textContent = livePower && linkState === 'direct' ? (livePower.reasons?.length ? 'Staying awake because ' + livePower.reasons.map((r) => reasonText[r] || r).join(', ') + '.' : 'Free to sleep when idle.') : p ? 'Settings you change here reach the Mac at its next check-in.' : 'Power info appears after the Mac connects once.';
  document.querySelectorAll('[data-set]').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(s[seg.dataset.set]))));
}

// ---------- UI wiring ----------
function openSheet(tab) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + tab));
  $('sheet').classList.add('show'); store.set('tab', tab);
  if (tab === 'queue') setTimeout(() => $('qcmd').focus(), 50);
}
function setupUi() {
  document.querySelectorAll('[data-mod]').forEach((b) => { modBtn[b.dataset.mod] = b;
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.onclick = () => { mods[b.dataset.mod] = !mods[b.dataset.mod]; b.classList.toggle('on'); term.focus(); }; });
  document.querySelectorAll('#keys [data-k], #keys [data-t]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.onclick = async () => {
      const k = b.dataset.k;
      if (k === 'paste') { try { const t = await navigator.clipboard.readText(); if (t) input(t); } catch { const t = prompt('Paste here:'); if (t) input(t); } }
      else if (k) { const pre = mods.alt ? '\x1b' : ''; clearMods(); input(pre + KEYS[k]); }
      else input(applyMods(b.dataset.t));
      term.focus();
    };
  });
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => openSheet(b.dataset.tab)));
  $('menuBtn').onclick = () => openSheet(store.get('tab', 'snippets'));
  $('starKey').addEventListener('pointerdown', (e) => e.preventDefault());
  $('starKey').onclick = () => openSheet('snippets');
  $('sheet').onclick = (e) => { if (e.target.id === 'sheet') { $('sheet').classList.remove('show'); term.focus(); } };

  $('qform').onsubmit = (e) => { e.preventDefault(); runCommand($('qcmd').value); $('qcmd').value = ''; };
  $('jobs').onclick = (e) => { const id = e.target.dataset.del; if (id) { jobs = jobs.filter((j) => j.cid !== id); saveJobs(); } };
  $('clearDone').onclick = () => { jobs = jobs.filter((j) => j.status !== 'done'); saveJobs(); };

  $('sform').onsubmit = (e) => { e.preventDefault(); const name = $('sname').value.trim(), cmd = $('scmd').value.trim(); if (!name || !cmd) return toast('Give it a name and a command');
    snippets.push({ id: randomId(), name: name.slice(0, 40), cmd }); $('sname').value = $('scmd').value = ''; renderSnips(); };
  $('snips').onclick = (e) => {
    const del = e.target.closest('[data-sdel]'), run = e.target.closest('[data-run]');
    if (del) { snippets = snippets.filter((s) => s.id !== del.dataset.sdel); return renderSnips(); }
    if (!run) return;
    const s = snippets.find((x) => x.id === run.dataset.run); if (!s) return;
    if (dc && dc.readyState === 'open') { input(s.cmd + '\r'); $('sheet').classList.remove('show'); }
    else { runCommand(s.cmd); openSheet('queue'); }
  };

  document.querySelectorAll('[data-set] button').forEach((b) => (b.onclick = async () => {
    const key = b.parentElement.dataset.set; let v = b.dataset.v;
    v = v === 'true' ? true : v === 'false' ? false : isNaN(v) ? v : Number(v);
    const target = livePower || mac.power; if (target) target.settings = { ...(target.settings || {}), [key]: v };
    paint();
    try {
      if (dc && dc.readyState === 'open') { sendTerm({ t: 'settings', power: { [key]: v } }); $('pNote').textContent = 'Saved.'; }
      else { await post('settings', { power: { [key]: v } }); $('pNote').textContent = 'Saved. The Mac picks it up at its next check-in.'; }
    } catch (e) { $('pNote').textContent = e.message; }
  }));

  $('retryDirect').onclick = () => { lastAttempt = 0; connect(); $('sheet').classList.remove('show'); };
  $('copyTopic').onclick = async () => { try { await navigator.clipboard.writeText(S.notifyTopic); toast('Copied. Paste it in the ntfy app → Subscribe.'); } catch { toast(S.notifyTopic); } };
  $('lockNow').onclick = async () => { await idbDel('session'); location.reload(); };
  $('unpair').onclick = async () => { if (!confirm('Remove the pairing key from this phone?')) return; store.del('vault'); store.del('jobs'); await idbDel('session'); location.reload(); };
  renderJobs(); renderSnips();
}

boot();
