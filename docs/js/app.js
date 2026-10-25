// Pocket Terminal phone app. Static files only (GitHub Pages); no server of its own.
//
// Flow: pair (QR link → PIN) → unlock → read your private mailbox on the board →
//       post encrypted "hello" + "offer" → Mac answers → direct WebRTC link → live terminal.
// If the direct link can't open, commands go as encrypted notes through the board instead.

import { derive, seal, open, randomId, lockSecret, unlockSecret, newPairKey, pairCode, unwrapJoin } from './crypto.js';
import { Board, MAX_NOTE } from './board.js';
import { search, riskOf, needsFill, askAi, PROVIDERS } from './helper.js';

const $ = (id) => document.getElementById(id);
const APP_VERSION = '5.4';
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
  if (h.get('join') || h.get('pair')) {
    history.replaceState(null, '', location.pathname + location.search); // remove the code from the address bar
    if (!h.get('join')) { showNone(); toast('That is an old pairing code. Run  node pair.js  on your computer for a new one.'); return; }
    show('gate-pair'); joinFlow(joinFrom(h)); return;
  }
  const vault = store.get('vault');
  if (!vault) return showNone();
  const s = await idbGet('session');
  if (s && s.expires > Date.now() && s.topic === vault.topic) return start(s);
  $('lockTitle').textContent = `Unlock ${vault.name}`;
  show('gate-lock'); lockFlow(vault);
}

const okBoards = (v) => { const b = (Array.isArray(v) ? v : String(v || '').split(',')).filter((u) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)); return b.length ? b : null; };
function deviceName() {
  const ua = navigator.userAgent;
  const dev = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android phone' : /Mac/.test(ua) ? 'Mac browser' : /Windows/.test(ua) ? 'Windows browser' : 'Browser';
  const br = /CriOS|Chrome/.test(ua) && !/Edg/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Edg/.test(ua) ? 'Edge' : /Safari/.test(ua) ? 'Safari' : '';
  if (standalone) return `${dev} (app)`;
  return br ? `${dev} (${br})` : dev;
}

const joinFrom = (h) => ({ invite: h.get('join'), name: (h.get('name') || 'your computer').slice(0, 40), boards: okBoards(h.get('boards')) || DEFAULT_BOARDS });
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// ---------- not paired: scan the QR inside the app, or paste the link ----------
let noneReady = false;
function showNone() {
  show('gate-none');
  if (noneReady) return; noneReady = true;
  $('scanBtn').onclick = openScanner;
  $('pasteBtn').onclick = () => { $('pasteForm').hidden = false; $('pasteIn').focus(); };
  $('pasteForm').onsubmit = (e) => { e.preventDefault(); if (!handleLink($('pasteIn').value)) $('noneErr').textContent = "That isn't a Pocket Terminal pairing link. Run  node pair.js  on your computer and copy the link it shows."; };
  $('scanClose').onclick = closeScanner;
}
function handleLink(text) {
  let u; try { u = new URL(String(text).trim()); } catch { return false; }
  const h = new URLSearchParams(u.hash.slice(1));
  if (!h.get('join')) return false;
  $('pasteIn').value = ''; $('noneErr').textContent = '';
  show('gate-pair'); joinFlow(joinFrom(h), true);
  return true;
}
let scanStream = null, scanRAF = 0;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/jsQR.js'; s.onload = res; s.onerror = () => rej(new Error('scanner')); document.head.appendChild(s); });
}
async function openScanner() {
  $('noneErr').textContent = '';
  try {
    await loadJsQR();
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    $('noneErr').textContent = e && e.name === 'NotAllowedError'
      ? 'Camera access is blocked. Allow it (iPhone: Settings → Safari → Camera), or use Paste pairing link.'
      : 'Could not open the camera here. Use Paste pairing link instead.';
    return;
  }
  const v = $('scanVideo'); v.srcObject = scanStream; await v.play().catch(() => {});
  $('scanHint').textContent = 'Point at the QR code on your computer'; $('scanner').hidden = false;
  const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
  let last = 0;
  const tick = (t) => {
    scanRAF = requestAnimationFrame(tick);
    if (t - last < 180 || v.readyState < 2 || !v.videoWidth) return; last = t;
    const w = Math.min(720, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth);
    c.width = w; c.height = h; ctx.drawImage(v, 0, 0, w, h);
    const r = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
    if (!r || !r.data) return;
    if (handleLink(r.data)) { navigator.vibrate && navigator.vibrate(40); closeScanner(); }
    else $('scanHint').textContent = "That QR code isn't a Pocket Terminal pairing code.";
  };
  scanRAF = requestAnimationFrame(tick);
}
function closeScanner() {
  cancelAnimationFrame(scanRAF); scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null;
  $('scanVideo').srcObject = null; $('scanner').hidden = true;
}

// ---------- one-time pairing: the computer must approve this phone ----------
async function joinFlow(j, here = false) {
  // iPhone: a pairing made in Safari stays in Safari. Send people to the Home Screen app first.
  if (isIOS && !standalone && !here) {
    $('pairTitle').textContent = `Pair with ${j.name}`; $('pairHint').textContent = '';
    $('pairPad').hidden = $('pairDots').hidden = true; $('iosNote').hidden = false;
    $('iosAnyway').onclick = () => { $('iosNote').hidden = true; joinFlow(j, true); };
    return;
  }
  $('iosNote').hidden = true;
  $('pairTitle').textContent = `Pair with ${j.name}`;
  $('pairPad').hidden = $('pairDots').hidden = true; $('joinBox').hidden = false;
  const fail = (msg) => { $('joinBox').hidden = true; $('pairHint').textContent = ''; $('pairErr').textContent = msg; };
  let ik; try { ik = await derive(j.invite); } catch { return fail('This pairing link is broken. Make a new QR code on your computer.'); }
  const { kp, pub } = await newPairKey(), nonce = randomId(), code = await pairCode(pub);
  $('joinCode').textContent = code.slice(0, 3) + ' ' + code.slice(3);
  $('pairHint').textContent = 'Sending this phone\'s code to your computer…';
  let done = false, slow, timeout;
  const end = () => { done = true; b.stop(); clearTimeout(slow); clearTimeout(timeout); };
  const b = new Board(j.boards, ik.topic, async (text) => {
    const m = await open(ik, text);
    if (done || !m || m.from !== 'mac' || m.for !== nonce) return;
    if (m.type === 'denied') { end(); return fail((m.why || 'Your computer said no.') + ' Nothing was paired.'); }
    if (m.type !== 'welcome') return;
    let p; try { p = await unwrapJoin(kp, nonce, m.wrap); } catch { return; }
    end();
    pendingPair = { secret: p.secret, name: String(p.name || j.name).slice(0, 40), boards: okBoards(p.boards) || j.boards };
    $('joinBox').hidden = true; $('pairPad').hidden = $('pairDots').hidden = false;
    $('pairTitle').textContent = `Approved by ${pendingPair.name}`;
    $('pairHint').textContent = 'Now choose a PIN for this phone (6 or more digits).';
    pairFlow();
  });
  b.start('2m');
  try { await b.publish(await seal(ik, { id: randomId(), ts: Date.now(), from: 'phone', type: 'join', nonce, pub, device: deviceName() })); }
  catch (e) { end(); return fail(e.message); }
  $('pairHint').textContent = 'Check that your computer shows the same code, then type y there to allow this phone.';
  slow = setTimeout(() => { if (!done) $('pairErr').textContent = 'Still waiting. Each QR code works only once: if this one was already used or is older than 10 minutes, run  node pair.js  on your computer for a new one.'; }, 45e3);
  timeout = setTimeout(() => { if (!done) { end(); fail('No answer from your computer. Run  node pair.js  there for a new QR code.'); } }, 10 * 60e3);
}

// ---------- PIN pad (phone-style; the physical keyboard works too) ----------
function pinPad(id, { goLabel, onDone, min = 6, max = 12 }) {
  const pad = $(id + 'Pad'), dots = $(id + 'Dots');
  let v = '';
  const draw = () => {
    dots.innerHTML = Array.from({ length: Math.max(min, v.length) }, (_, i) => `<i class="${i < v.length ? 'on' : ''}"></i>`).join('');
    go.disabled = v.length < min;
  };
  const press = (k) => {
    if (k === 'del') v = v.slice(0, -1);
    else if (k === 'go') { if (v.length >= min) { const pin = v; v = ''; draw(); onDone(pin); } return; }
    else if (v.length < max) v += k;
    draw();
  };
  pad.innerHTML = '';
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'go']) {
    const b = document.createElement('button'); b.type = 'button';
    if (k === 'del') { b.className = 'fn'; b.textContent = 'Delete'; b.setAttribute('aria-label', 'Delete'); }
    else if (k === 'go') { b.className = 'go'; b.textContent = goLabel; }
    else b.textContent = k;
    b.onclick = () => press(k); pad.appendChild(b);
  }
  var go = pad.lastChild;
  const onKey = (e) => {
    if (pad.closest('.gate').hidden) return;
    if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); else if (e.key === 'Enter') press('go');
  };
  document.addEventListener('keydown', onKey);
  draw();
  return {
    setLabel(t) { go.textContent = t; },
    shake() { dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake'); navigator.vibrate && navigator.vibrate(80); },
    done() { document.removeEventListener('keydown', onKey); },
  };
}

function pairFlow() {
  let first = null;
  const p = pinPad('pair', {
    goLabel: 'Next',
    onDone: async (pin) => {
      if (!first) { first = pin; $('pairHint').textContent = 'Enter the same PIN again.'; $('pairErr').textContent = ''; p.setLabel('Pair'); return; }
      if (pin !== first) { first = null; p.shake(); p.setLabel('Next'); $('pairHint').textContent = 'Choose a PIN for this phone (6 or more digits).'; $('pairErr').textContent = "Those didn't match. Start again."; return; }
      let k; try { k = await derive(pendingPair.secret); } catch { $('pairErr').textContent = 'This pairing link is broken. Make a new QR code on your computer.'; return; }
      p.done();
      const locked = await lockSecret(pendingPair.secret, pin);
      store.set('vault', { ...locked, name: pendingPair.name, boards: pendingPair.boards, topic: k.topic });
      store.set('fails', 0); store.del('jobs');
      const s = { key: k.key, topic: k.topic, notifyTopic: k.notifyTopic, boards: pendingPair.boards, name: pendingPair.name, expires: Date.now() + 12 * 3600e3 };
      await idbSet('session', s);
      pendingPair = null; start(s);
    },
  });
}

function lockFlow(vault) {
  const p = pinPad('lock', {
    goLabel: 'Unlock',
    onDone: async (pin) => {
      $('lockErr').textContent = 'Checking…';
      const secret = await unlockSecret(vault, pin);
      if (!secret) {
        const f = store.get('fails', 0) + 1; store.set('fails', f); p.shake();
        if (f >= 10) { store.del('vault'); await idbDel('session'); p.done(); show('gate-none'); toast('Too many wrong PINs. This phone was unpaired.'); return; }
        $('lockErr').textContent = `Wrong PIN. ${10 - f} tries left before this phone is unpaired.`; return;
      }
      p.done(); store.set('fails', 0);
      const k = await derive(secret);
      const s = { key: k.key, topic: k.topic, notifyTopic: k.notifyTopic, boards: vault.boards || DEFAULT_BOARDS, name: vault.name, expires: Date.now() + ($('remember').checked ? 12 * 3600e3 : 0) };
      if ($('remember').checked) await idbSet('session', s); else await idbDel('session');
      start(s);
    },
  });
}

// ---------- main ----------
let S, keys, board, term, fit;
let lastPong = 0;
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
  setupTerminal(); setupUi(); loadAi();
  board = new Board(S.boards, S.topic, onNoteText, () => paint());
  board.start('12h'); // read the last 12 h: Mac status, answers to old commands
  setTimeout(() => connect(), 400);
  setInterval(paint, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { clearTimeout(retryTimer); return; }
    retryN = 0;
    board.restart(); // phones kill background connections
    if (!dc || dc.readyState !== 'open') return connect();
    const asked = Date.now(); sendTerm({ t: 'ping' });
    setTimeout(() => { // no answer: the link died while we were away. Rebuild it.
      if (lastPong < asked && dc) { const old = dc; dc = null; try { old.close(); pc && pc.close(); } catch {} lastAttempt = 0; connect(); }
    }, 2500);
  });
}

async function onNoteText(text) {
  const m = await open(keys, text);
  if (!m || m.from !== 'mac' || typeof m.id !== 'string' || seen.has(m.id)) return;
  seen.add(m.id);
  if (localStorage.getItem('pt_debug')) console.log('note', m.type, m.state || '', new Date(m.ts).toISOString());
  if (m.type === 'revoked') return revoked();
  if (m.type === 'status') {
    if (m.ts < mac.ts) return;
    Object.assign(mac, { state: m.state, ts: m.ts, nextWake: m.nextWake, checkIn: m.checkIn, power: m.power, name: m.name || mac.name });
    if (m.os) setOs(m.os);
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
  } catch (e) { linkState = 'noboard'; toast(e.message); paint(); scheduleRetry(); return; }
  clearTimeout(answerTimer);
  answerTimer = setTimeout(() => { if (!dc || dc.readyState !== 'open') { linkState = 'waiting'; paint(); scheduleRetry(); } }, 15e3);
}

// The computer removed this phone (node pair.js --remove). Forget the key and say so.
async function revoked() {
  store.del('vault'); store.del('jobs'); store.del('ai'); await idbDel('session');
  try { dc && dc.close(); pc && pc.close(); } catch {}
  board && board.stop(); location.hash = ''; showNone();
  $('noneErr').textContent = 'This phone was removed on your computer. To use it again, run  node pair.js  there and tap Scan QR code.';
}

// No answer? The computer may be asleep or briefly offline. Keep knocking while the app is open,
// so it connects by itself at the computer's next check-in (each knock is 2 tiny encrypted notes).
let retryN = 0, retryTimer = null;
function scheduleRetry() {
  clearTimeout(retryTimer);
  if (document.visibilityState !== 'visible') return;
  const ms = [45e3, 60e3, 90e3, 120e3][Math.min(retryN++, 3)];
  retryTimer = setTimeout(() => { if (!dc || dc.readyState !== 'open') { lastAttempt = 0; connect(); } }, ms);
}

// One terminal session per app launch: switching apps and coming back continues it; a fresh
// launch (the app was closed) gets a fresh terminal. sessionStorage ends when the app is closed.
let SID = null;
try { SID = sessionStorage.getItem('pt_sid'); if (!SID) { SID = randomId(); sessionStorage.setItem('pt_sid', SID); } } catch { SID = randomId(); }
// Typing or pasting while the link is coming back is kept and sent once it's back (if within 60 s).
let pending = [], pendingToast = 0;
function flushPending() {
  const now = Date.now(); const keep = pending.filter((p) => now - p.at < 60e3).map((p) => p.d).join('');
  pending = []; if (keep) sendTerm({ t: 'i', d: keep });
}

function wire(ch) {
  ch.onopen = () => {
    dc = ch; linkState = 'direct'; clearTimeout(answerTimer); clearTimeout(openTimer); clearTimeout(retryTimer); retryN = 0;
    mac.state = 'online'; mac.ts = Date.now(); lastPong = Date.now();
    sendTerm({ t: 'attach', sid: SID, cols: term.cols, rows: term.rows }); // first, before any resize
    fit.fit(); sendTerm({ t: 'r', cols: term.cols, rows: term.rows });
    flushPending();
    paint(); toast('Connected directly · end-to-end encrypted');
  };
  ch.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'o') term.write(m.d);
    else if (m.t === 'reset') { term.reset(); if (m.d) term.write(m.d); }
    else if (m.t === 'power') { livePower = m; paint(); }
    else if (m.t === 'pong') lastPong = Date.now();
    else if (m.t === 'hi') { if (m.os) setOs(m.os); }
    else if (m.t === 'revoked') revoked();
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
function until(t) {
  const s = Math.round((t - Date.now()) / 1000); if (s <= 0) return 'any moment';
  const m = Math.floor(s / 60); return m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

const RING = 106.8; // circumference of the presence ring
function paint() {
  if (!term) return;
  const name = mac.name || 'your computer';
  const p = livePower || mac.power;
  const nci = nextCheckIn();
  let look = 'off', ring = 0, status = '', banner = null;
  const queued = jobs.filter((j) => j.status === 'waiting').length;
  const queuedText = queued ? ` ${queued} command${queued > 1 ? 's' : ''} will run then.` : '';
  if (linkState === 'direct') { look = 'awake'; ring = 1; status = 'Awake · direct, encrypted'; }
  else if (linkState === 'connecting' && !(mac.state === 'sleeping' && nci)) { look = 'connecting'; ring = 0.25; status = 'Connecting…'; }
  else if (linkState === 'noboard' || board.up.size === 0) {
    status = 'Offline';
    banner = ["You're offline", "Can't reach the message board. Check this phone's internet; it retries by itself.", false, []];
  } else if (linkState === 'backup') {
    look = 'backup'; ring = 1; status = 'Backup route (slower)';
    banner = ['Direct link blocked on this network', "Commands still work through the encrypted backup route. They're just a few seconds slower. The live terminal needs the direct link.", true, [['Try direct again', () => { lastAttempt = 0; connect(); }]]];
  } else if (mac.state === 'sleeping' && nci) {
    look = 'asleep'; ring = Math.max(0, Math.min(1, (nci - Date.now()) / ((mac.checkIn || 2) * 60e3)));
    status = `Asleep · wakes in ${until(nci)}`;
    banner = [`${name} is asleep`, `It checks in by itself in ${until(nci)}. Keep this open and it connects on its own, or send a command now and it runs at the check-in.${queuedText}`, true, []];
  } else {
    status = mac.ts ? `Last seen ${ago(mac.ts)}` : 'Waiting…';
    const longWait = retryN >= 4 ? " Still nothing after a few minutes? Check the computer is on and online. If you removed this phone there, go to ☰ → Settings → Unpair and pair again." : '';
    banner = [`Waiting for ${name}`, `If it's asleep, it connects at its next check-in. If it's off or offline, commands you send run when it's back.${queuedText}${longWait}`, true, []];
  }
  $('macName').textContent = name;
  $('presence').className = 'presence ' + look;
  $('arc').style.strokeDashoffset = String(RING * (1 - ring));
  $('status').textContent = status;
  if (banner) {
    $('banner').hidden = false; $('bannerTitle').textContent = banner[0]; $('bannerText').textContent = banner[1];
    $('bannerForm').hidden = !banner[2];
    const row = $('bannerRow');
    if (row.dataset.key !== banner[0]) {
      row.dataset.key = banner[0]; row.innerHTML = '';
      banner[3].forEach(([label, fn]) => { const b = document.createElement('button'); b.className = 'btn small ghost'; b.textContent = label; b.onclick = fn; row.appendChild(b); });
    }
  } else $('banner').hidden = true;
  if (p && p.percent != null) {
    $('batt').hidden = false; $('batt').textContent = `${p.onCharger ? '⚡' : ''}${p.percent}%`;
    $('batt').className = 'batt' + (p.onCharger ? ' charging' : p.percent < 20 ? ' low' : '');
  }
  $('connInfo').textContent = linkState === 'direct' ? 'Direct and end-to-end encrypted' : linkState === 'backup' ? 'Backup route: encrypted notes through the message board' : 'Not connected right now';
  paintPower(p, nci);
}

// ---------- terminal ----------
const KEYS = { cx: '\x18', co: '\x0f', esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~', cc: '\x03', cd: '\x04', cz: '\x1a', cl: '\x0c', cr: '\x12' };
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
  if (dc && dc.readyState === 'open') return sendTerm({ t: 'i', d });
  if (pending.reduce((n, p) => n + p.d.length, 0) + d.length > 16e3) return toast("Not connected. Too much to hold; try again when it's back.");
  pending.push({ d, at: Date.now() });
  if (Date.now() - pendingToast > 4000) { pendingToast = Date.now(); toast('Reconnecting… what you typed is sent as soon as it’s back.'); }
  if (linkState !== 'connecting') { lastAttempt = 0; connect(); }
}
function setupTerminal() {
  let size = store.get('font', matchMedia('(max-width:700px)').matches ? 13 : 15);
  term = new Terminal({ fontFamily: '"JB Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: size, cursorBlink: true, scrollback: 5000, allowTransparency: true,
    theme: { background: '#0B0E19', foreground: '#E9E7F2', cursor: '#F4B740', cursorAccent: '#0B0E19', selectionBackground: '#3A3460',
      black: '#1E2338', red: '#FF7A7A', green: '#4FD1A1', yellow: '#F4B740', blue: '#7AA2FF', magenta: '#C79BFF', cyan: '#6FD3E6', white: '#E9E7F2',
      brightBlack: '#5D6283', brightRed: '#FF9C9C', brightGreen: '#7BE3BD', brightYellow: '#FFD07A', brightBlue: '#9DBBFF', brightMagenta: '#DAB8FF', brightCyan: '#9BE6F2', brightWhite: '#FFFFFF' } });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($('term')); setupTouchScroll();
  term.onData((d) => input(applyMods(d)));
  term.onResize(() => sendTerm({ t: 'r', cols: term.cols, rows: term.rows }));
  const setFont = (n) => { size = Math.max(9, Math.min(24, n)); term.options.fontSize = size; store.set('font', size); fit.fit(); };
  $('smaller').onclick = () => setFont(size - 1); $('bigger').onclick = () => setFont(size + 1);
  const app = $('app');
  const layout = () => { const vv = window.visualViewport; app.style.height = (vv ? vv.height : innerHeight) + 'px'; if (vv) app.style.top = vv.offsetTop + 'px'; fit.fit(); };
  if (window.visualViewport) { visualViewport.addEventListener('resize', layout); visualViewport.addEventListener('scroll', layout); }
  addEventListener('resize', layout); layout();
  if (document.fonts) document.fonts.ready.then(layout); // refit once the terminal font has loaded
  // Phones scroll the page to show a focused input; put it back when the keyboard closes.
  document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) { window.scrollTo(0, 0); layout(); } }, 50));
}

// A key on the bar: fire on touch end and cancel the tap's click, so the phone keyboard keeps its
// focus (a normal tap first blurs the terminal on iPhone, and the key can get lost). Mouse: click.
function tapKey(b, fire) {
  let x = 0, y = 0, moved = false;
  b.addEventListener('touchstart', (e) => { const t = e.touches[0]; x = t.clientX; y = t.clientY; moved = false; }, { passive: true });
  b.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (Math.abs(t.clientX - x) > 8 || Math.abs(t.clientY - y) > 8) moved = true; }, { passive: true });
  b.addEventListener('touchend', (e) => { e.preventDefault(); if (!moved) fire(); }, { passive: false });
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.onclick = fire;
}
// Paste: the clipboard if the phone allows it, else a box you can long-press and paste into.
async function pasteFlow() {
  try { const t = await navigator.clipboard.readText(); if (t) { term.paste(t); term.focus(); return; } } catch {}
  $('pasteText').value = ''; $('pasteBox').hidden = false; setTimeout(() => $('pasteText').focus(), 50);
}
function closePaste() { $('pasteBox').hidden = true; $('pasteText').blur(); term.focus(); }

// Swipe up/down on the terminal scrolls only the terminal (never the page). In full-screen
// programs (nano, less, top) a swipe sends arrow keys instead.
function setupTouchScroll() {
  const el = $('term'); let ty = null, acc = 0;
  const lineH = () => { const r = el.querySelector('.xterm-rows > div'); return (r && r.offsetHeight) || term.options.fontSize * 1.2; };
  el.addEventListener('touchstart', (e) => { ty = e.touches.length === 1 ? e.touches[0].clientY : null; acc = 0; }, { passive: true, capture: true });
  el.addEventListener('touchmove', (e) => {
    if (ty === null) return;
    e.preventDefault(); e.stopPropagation();
    const y = e.touches[0].clientY; acc += ty - y; ty = y;
    const n = Math.trunc(acc / lineH()); if (!n) return; acc -= n * lineH();
    if (term.buffer.active.type === 'alternate') input((n > 0 ? KEYS.down : KEYS.up).repeat(Math.min(Math.abs(n), 5)));
    else term.scrollLines(n);
  }, { passive: false, capture: true });
  el.addEventListener('touchend', () => { ty = null; }, { passive: true, capture: true });
  // Everywhere else: only real scroll areas may scroll; the page itself never moves.
  document.addEventListener('touchmove', (e) => {
    if (!e.target.closest('.pane, .gate, .chips, .keys, .panel, textarea, input, .scanner, .card-state')) e.preventDefault();
  }, { passive: false });
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
  toast(code === 0 ? `Done: ${j.cmd.slice(0, 40)}` : `Failed (exit ${code}): ${j.cmd.slice(0, 40)}`);
}
function renderJobs() {
  $('qn').textContent = jobs.filter((j) => j.status === 'waiting' || j.status === 'running').length || '';
  $('jobs').innerHTML = jobs.length ? jobs.map((j) => {
    const tag = j.status === 'done' ? (j.code === 0 ? '<span class="tag done">done</span>' : `<span class="tag fail">exit ${esc(j.code)}</span>`)
      : j.status === 'running' ? '<span class="tag running">running</span>' : j.status === 'error' ? '<span class="tag fail">not sent</span>' : '<span class="tag">waiting for computer</span>';
    const out = j.status === 'done' || j.status === 'error' ? `<pre>${esc(j.out) || '(no output)'}</pre>` : '';
    const fix = j.status === 'done' && j.code !== 0 ? `<button class="x fixit" data-fix="${esc(j.cid)}">✦ Fix with AI</button>` : '';
    return `<div class="item"><div class="top"><code>${esc(j.cmd)}</code>${tag}</div>${out}<div class="meta"><span>sent ${ago(j.created)}${j.finished ? ' · finished ' + ago(j.finished) : ''}</span><span>${fix}<button class="x" data-del="${esc(j.cid)}">remove</button></span></div></div>`;
  }).join('') : '<div class="empty">No commands yet. Type one above and tap Run.</div>';
}

// ---------- snippets (stored on this phone) ----------
let snippets = store.get('snippets', [
  { id: 's1', name: 'Disk space', cmd: 'df -h /' }, { id: 's2', name: 'Battery', cmd: 'pmset -g batt' },
  { id: 's3', name: 'Top processes', cmd: 'ps -Ao pid,%cpu,%mem,comm -r | head -8' }]);
function renderSnips() {
  store.set('snippets', snippets);
  renderChips();
  $('snips').innerHTML = snippets.length ? snippets.map((s) => `<div class="item snip"><button class="run" data-run="${esc(s.id)}"><b>${esc(s.name)}</b><code>${esc(s.cmd)}</code></button><button class="x" data-sdel="${esc(s.id)}">✕</button></div>`).join('') : '<div class="empty">No saved commands yet. Add one below.</div>';
}
function renderChips() {
  $('chips').innerHTML = '<button class="chip ask" id="askChip">✦ Ask</button>' + snippets.map((s) => `<button class="chip" data-run="${esc(s.id)}">${esc(s.name)}</button>`).join('') + '<button class="chip add" id="addChip">+ Save a command</button>';
}

// ---------- power ----------
const reasonText = { 'on charger': "it's charging", 'phone connected': 'your phone is connected', 'job running': 'a command is running', 'recent typing': 'you typed recently', 'checking in': "it's checking in", 'instant mode': 'Instant mode is on' };
function paintPower(p, nci) {
  const s = (p && p.settings) || {};
  $('pBatt').textContent = p && p.percent != null ? `${p.percent}%${p.onCharger ? ' ⚡' : ''}` : '–';
  $('pState').textContent = linkState === 'direct' ? 'Awake' : mac.state === 'sleeping' ? 'Asleep' : '–';
  $('pNext').textContent = linkState === 'direct' ? '–' : nci ? until(nci) : '–';
  $('pWhy').textContent = livePower && linkState === 'direct' ? (livePower.reasons?.length ? 'Staying awake because ' + livePower.reasons.map((r) => reasonText[r] || r).join(', ') + '.' : 'Free to sleep when idle.') : p ? 'Settings you change here reach the computer at its next check-in.' : 'Power info appears after the computer connects once.';
  document.querySelectorAll('[data-set]').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(s[seg.dataset.set]))));
}

// ---------- Ask: find a command, or turn plain English into one ----------
let os = store.get('os', 'darwin');
const OS_LABEL = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
function setOs(v) { if (!OS_LABEL[v] || v === os) return; os = v; store.set('os', v); }
let ai = null; // { provider, model, key } (key only in memory; stored encrypted with the pairing key)
const AI_AAD = new TextEncoder().encode('pocket-terminal/ai-key');
async function loadAi() {
  const a = store.get('ai'); if (!a) return paintAiInfo();
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(a.iv), additionalData: AI_AAD }, keys.key, fromB64(a.ct));
    ai = { provider: a.provider, model: a.model, url: a.url, key: new TextDecoder().decode(plain) };
  } catch { ai = null; }
  paintAiInfo();
}
const toB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function saveAi(cfg) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AI_AAD }, keys.key, new TextEncoder().encode(cfg.key));
  store.set('ai', { provider: cfg.provider, model: cfg.model, url: cfg.url, iv: toB64(iv), ct: toB64(ct) });
  ai = cfg; paintAiInfo();
}
function paintAiInfo() {
  $('aiInfo').textContent = ai ? `On: ${(PROVIDERS[ai.provider]?.label || ai.provider).split(':')[0]}${ai.model ? ' · ' + ai.model : ''}` : 'Off. Works with ChatGPT, Claude, Gemini or any OpenAI-compatible API, using your own key.';
  $('aiSetup').textContent = ai ? 'Change' : 'Set up';
}

let aiResults = [], aiNote = '', aiBusy = null, armed = null;
function cmdHistory() {
  const h = snippets.map((s) => ({ cmd: s.cmd, name: s.name, from: 'saved' }));
  for (const j of jobs) if (!h.some((x) => x.cmd === j.cmd)) h.push({ cmd: j.cmd, from: 'recent' });
  return h;
}
function sugCard(r, i, src) {
  const risk = riskOf(r.cmd) || (r.risk && r.risk !== 'safe' ? { level: r.risk, why: '' } : null);
  const tag = risk ? `<span class="tag ${risk.level === 'danger' ? 'fail' : 'warn'}">${risk.level === 'danger' ? 'danger' : 'careful'}</span>` : (src === 'ai' ? '<span class="tag done">safe</span>' : '');
  const why = risk && risk.why ? `<p class="why">⚠ ${esc(risk.why[0].toUpperCase() + risk.why.slice(1))}.</p>` : '';
  const live = dc && dc.readyState === 'open';
  return `<div class="item sug" data-src="${src}" data-i="${i}">
    <div class="top"><b>${esc(r.name || r.explain || 'Suggestion')}</b>${tag}</div>
    ${r.name && r.explain ? `<p class="ex">${esc(r.explain)}</p>` : ''}${why}
    <input class="field-in cmdedit" value="${esc(r.cmd)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Command">
    <div class="acts"><button class="btn small" data-act="run">Run</button>${live ? '<button class="btn small ghost" data-act="type">Put in terminal</button>' : ''}<button class="btn small ghost" data-act="save">Save</button></div>
  </div>`;
}
function paintAsk() {
  const q = $('askIn').value;
  $('askGo').textContent = aiBusy ? 'Asking…' : 'Ask AI';
  $('askGo').disabled = !!aiBusy;
  $('askAi').innerHTML = aiBusy ? '<div class="item thinking"><span></span><span></span><span></span></div>'
    : aiResults.map((r, i) => sugCard(r, i, 'ai')).join('') + (aiNote ? `<p class="hint">${esc(aiNote)}</p>` : '');
  const lib = search(q, os, cmdHistory());
  $('askLibTitle').hidden = !lib.length;
  $('askLibTitle').textContent = aiResults.length ? 'Also matching' : 'Matches';
  $('askLib').innerHTML = lib.map((r, i) => sugCard(r, i, 'lib')).join('') +
    (q.trim() && !lib.length && !aiResults.length && !aiBusy ? `<div class="empty">${ai ? 'Nothing built in. Tap <b>Ask AI</b>.' : 'Nothing built in matches. Turn on the AI helper in <b>Settings</b> to ask in plain English.'}</div>` : '');
  paintAsk.lib = lib;
  $('askHint').textContent = q.trim() ? `Commands for ${OS_LABEL[os]}. Nothing runs until you tap Run.` : 'Say what you want in plain English, or type the part of a command you remember.';
}
async function doAsk(request) {
  const q = $('askIn').value.trim(); if (!q) return;
  request = request || q;
  if (!ai) { openSheet('settings'); $('aiForm').hidden = false; fillAiForm(); return toast('Add an AI key first. Groq and Gemini keys are free.'); }
  aiBusy?.abort(); const ctl = new AbortController(); aiBusy = ctl; aiResults = []; aiNote = ''; paintAsk();
  const timer = setTimeout(() => ctl.abort(), 25e3);
  try { const r = await askAi(ai, request, os, ctl.signal); if (aiBusy !== ctl) return; aiResults = r.options; aiNote = r.note; }
  catch (e) { if (aiBusy !== ctl) return; aiNote = e.name === 'AbortError' ? 'The AI took too long. Try again.' : /fetch/i.test(e.message) ? 'Could not reach the AI. Check this phone\'s internet.' : e.message; }
  finally { clearTimeout(timer); if (aiBusy === ctl) { aiBusy = null; paintAsk(); } }
}
function fillAiForm() {
  const p = ai?.provider || 'groq';
  $('aiProvider').innerHTML = Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}"${k === p ? ' selected' : ''}>${esc(v.label)}</option>`).join('');
  $('aiKey').value = ''; $('aiKey').placeholder = ai ? 'API key (leave empty to keep)' : 'API key';
  $('aiModel').value = ai?.model || ''; $('aiUrl').value = ai?.url || ''; $('aiNote').textContent = ''; aiHelp();
}
function aiHelp() {
  const k = $('aiProvider').value, p = PROVIDERS[k];
  $('aiUrl').hidden = k !== 'custom';
  $('aiModel').placeholder = p.model ? 'model (default: ' + p.model + ')' : 'model name, e.g. llama3.1';
  $('aiKeyHelp').innerHTML = k === 'custom' ? 'Any service that speaks the OpenAI chat API: Together, Fireworks, Perplexity, Azure OpenAI, your own server… It must allow calls from a browser (CORS).'
    : `Get a key at <b>${esc(p.keyUrl)}</b>.` + (k === 'openai' ? ' A ChatGPT Plus subscription is not an API key; API use is billed separately.' : k === 'openrouter' ? ' Works with every big model, and some are free.' : '');
}
function aiFormCfg() {
  const provider = $('aiProvider').value, key = $('aiKey').value.trim() || (ai && ai.provider === provider ? ai.key : '');
  return { provider, key, model: $('aiModel').value.trim(), url: provider === 'custom' ? $('aiUrl').value.trim() : '' };
}
function setupAsk() {
  let t; $('askIn').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { aiResults = []; aiNote = ''; paintAsk(); }, 100); });
  $('askForm').onsubmit = (e) => { e.preventDefault(); doAsk(); };
  $('pane-ask').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const card = b.closest('.sug'), inp = card.querySelector('.cmdedit'), cmd = inp.value.trim();
    const src = card.dataset.src === 'ai' ? aiResults : paintAsk.lib, r = src[+card.dataset.i] || {};
    if (!cmd) return;
    if (needsFill(cmd) && b.dataset.act !== 'save') {
      const m = cmd.match(/<[^<>]+>/); inp.focus(); inp.setSelectionRange(m.index, m.index + m[0].length);
      return toast(`Fill in ${m[0]} first`);
    }
    if (b.dataset.act === 'save') { snippets.push({ id: randomId(), name: (r.name || r.explain || cmd).slice(0, 40), cmd }); renderSnips(); return toast('Saved. It shows as a chip now.'); }
    if (b.dataset.act === 'type') { $('sheet').classList.remove('show'); input(cmd); term.focus(); return; }
    const risk = riskOf(cmd);
    if (risk?.level === 'danger' && armed !== b) { armed = b; b.textContent = 'Tap again to run'; b.classList.add('danger'); setTimeout(() => { if (armed === b) { armed = null; b.textContent = 'Run'; b.classList.remove('danger'); } }, 4000); return; }
    armed = null;
    if (dc && dc.readyState === 'open') { $('sheet').classList.remove('show'); input(cmd + '\r'); term.focus(); }
    else { runCommand(cmd); openSheet('queue'); toast('Sent. It runs at the next check-in.'); }
  });
  $('aiSetup').onclick = () => { $('aiForm').hidden = !$('aiForm').hidden; if (!$('aiForm').hidden) fillAiForm(); };
  $('aiProvider').onchange = aiHelp;
  $('aiForm').onsubmit = async (e) => {
    e.preventDefault();
    const c = aiFormCfg();
    if (!c.key) return toast('Paste your API key');
    if (c.provider === 'custom' && !/^https:\/\//.test(c.url)) return toast('Enter the API address (https://…)');
    if (c.provider === 'custom' && !c.model) return toast('Enter a model name');
    await saveAi(c); $('aiForm').hidden = true; toast('AI helper is on. Try it in Ask.');
  };
  $('aiTest').onclick = async () => {
    const c = aiFormCfg(); if (!c.key) return toast('Paste your API key');
    $('aiNote').textContent = 'Testing…';
    try { const r = await askAi(c, 'show the current folder', os, AbortSignal.timeout(20e3)); $('aiNote').textContent = `Works ✓ It answered: ${r.options[0].cmd}`; }
    catch (e) { $('aiNote').textContent = /fetch/i.test(e.message) ? 'Could not reach it. Check the address, or this provider may block calls from a browser (try OpenRouter).' : e.message; }
  };
  $('aiOff').onclick = () => { store.del('ai'); ai = null; paintAiInfo(); $('aiForm').hidden = true; toast('AI helper turned off. The key was removed from this phone.'); };
}

// ---------- UI wiring ----------
function openSheet(tab) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + tab));
  $('sheet').classList.add('show'); store.set('tab', tab);
  if (tab === 'queue') setTimeout(() => $('qcmd').focus(), 50);
  if (tab === 'ask') { paintAsk(); setTimeout(() => $('askIn').focus(), 50); }
}
function setupUi() {
  document.querySelectorAll('[data-mod]').forEach((b) => { modBtn[b.dataset.mod] = b;
    tapKey(b, () => { mods[b.dataset.mod] = !mods[b.dataset.mod]; b.classList.toggle('on'); term.focus(); }); });
  document.querySelectorAll('#keys [data-k], #keys [data-t]').forEach((b) => {
    tapKey(b, async () => {
      const k = b.dataset.k;
      if (k === 'paste') return pasteFlow();
      if (k) { const pre = mods.alt ? '\x1b' : ''; clearMods(); input(pre + KEYS[k]); }
      else input(applyMods(b.dataset.t));
      term.focus();
    });
  });
  $('pasteSend').onclick = () => { const t = $('pasteText').value; closePaste(); if (t) { term.paste(t); toast('Pasted'); } };
  $('pasteCancel').onclick = closePaste;
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => openSheet(b.dataset.tab)));
  $('menuBtn').onclick = () => openSheet(store.get('tab', 'queue') === 'ask' ? 'queue' : store.get('tab', 'queue'));
  $('askBtn').onclick = () => openSheet('ask');
  setupAsk();
  $('bannerForm').onsubmit = (e) => { e.preventDefault(); const c = $('bannerCmd').value; if (!c.trim()) return; runCommand(c); $('bannerCmd').value = ''; $('bannerCmd').blur(); toast(dc && dc.readyState === 'open' ? 'Running…' : "Sent. It runs at the next check-in."); };
  $('chips').onclick = (e) => {
    if (e.target.id === 'addChip') return openSheet('snippets');
    if (e.target.id === 'askChip') return openSheet('ask');
    const c = e.target.closest('[data-run]'); if (!c) return;
    const s = snippets.find((x) => x.id === c.dataset.run); if (!s) return;
    if (dc && dc.readyState === 'open') { input(s.cmd + '\r'); term.focus(); }
    else { runCommand(s.cmd); toast(`Sent “${s.name}”. The reply shows in Commands.`); }
  };
  $('sheet').onclick = (e) => { if (e.target.id === 'sheet') { $('sheet').classList.remove('show'); term.focus(); } };

  $('qform').onsubmit = (e) => { e.preventDefault(); runCommand($('qcmd').value); $('qcmd').value = ''; };
  $('jobs').onclick = (e) => {
    const id = e.target.dataset.del; if (id) { jobs = jobs.filter((j) => j.cid !== id); saveJobs(); return; }
    const f = jobs.find((j) => j.cid === e.target.dataset.fix); if (!f) return;
    openSheet('ask'); $('askIn').value = 'Fix: ' + f.cmd;
    if (!ai) return doAsk();
    toast('Sending the command and the end of its output to your AI');
    doAsk(`This command failed with exit code ${f.code}:\n$ ${f.cmd}\n\nOutput (last part):\n${String(f.out || '').slice(-1500)}\n\nWhat went wrong, and what should I run instead?`);
  };
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
      else { await post('settings', { power: { [key]: v } }); $('pNote').textContent = 'Saved. The computer picks it up at its next check-in.'; }
    } catch (e) { $('pNote').textContent = e.message; }
  }));

  $('retryDirect').onclick = () => { lastAttempt = 0; connect(); $('sheet').classList.remove('show'); };
  $('copyTopic').onclick = async () => { try { await navigator.clipboard.writeText(S.notifyTopic); toast('Copied. Paste it in the ntfy app → Subscribe.'); } catch { toast(S.notifyTopic); } };
  $('lockNow').onclick = async () => { await idbDel('session'); location.reload(); };
  $('appVer').textContent = 'v' + APP_VERSION + ' · checks for updates when you reload';
  $('reloadApp').onclick = async () => {
    $('reloadApp').textContent = 'Updating…';
    try { const r = await navigator.serviceWorker?.getRegistration(); await r?.update(); } catch {}
    try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
    location.reload();
  };
  $('unpair').onclick = async () => { if (!confirm('Remove the pairing key from this phone?')) return; store.del('vault'); store.del('jobs'); store.del('ai'); await idbDel('session'); location.reload(); };
  renderJobs(); renderSnips();
}

boot();
