// Direct mode: your phone connects straight to your Mac (WebRTC, the same tech
// video calls use). No server of yours in between.
//
// How a connection is born:
//   1. Phone posts an encrypted "hello" + "offer" (its addresses) to your private mailbox
//      on a free public message board (ntfy.sh by default).
//   2. Mac reads it, posts an encrypted "answer" (its addresses).
//   3. Both "knock" on each other at the same time (hole punching) → direct, encrypted link.
//   4. From then on: keystrokes and output flow phone ⇄ Mac directly. The board sees nothing.
//
// If a network blocks direct links entirely, commands still work through the board as
// encrypted notes (slower, but works anywhere normal web browsing works).
// While the Mac sleeps, notes wait on the board (12 h) and run at the next check-in.

const fs = require('fs');
const path = require('path');
const os = require('os');
const ndc = require('node-datachannel');
const { derive, seal, open, msgId } = require('./lib/crypto');
const { Board, MAX_NOTE } = require('./lib/board');

const DEFAULT_ICE = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
const FRESH = { hello: 3 * 60e3, offer: 90e3, settings: 24 * 3600e3 };

function startDirect({ cfg, core, power, log, dir }) {
  const keys = derive(cfg.secret);
  const STATE = path.join(dir, 'direct-state.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  const seen = new Set(state.seen || []);
  const board = new Board(cfg.boards || ['https://ntfy.sh'], keys.topic, { log, since: state.since || {} });
  const maxCmdAge = (cfg.maxCommandAgeMinutes || 60) * 60e3;
  const peers = new Set();
  let lastStatus = { state: null, at: 0, checkIn: null };
  let phoneWaitingTimer = null;

  let saveT;
  const saveState = () => { clearTimeout(saveT); saveT = setTimeout(() => {
    fs.writeFile(STATE, JSON.stringify({ since: board.since, seen: [...seen].slice(-500) }), { mode: 0o600 }, () => {});
  }, 500); };

  async function post(type, extra = {}) {
    const note = { id: msgId(), ts: Date.now(), from: 'mac', type, ...extra };
    try { await board.publish(seal(keys, note)); } catch (e) { log(`could not post ${type}: ${e.message}`); }
  }

  // --- status: posted rarely, to stay well inside the board's free daily limit ---
  function statusBody(st) {
    const p = power ? power.status() : null;
    return { state: st, name: cfg.name || os.hostname(), nextWake: p && st === 'sleeping' ? p.nextWake : null,
      checkIn: p ? p.nextCheckInMinutes : null, power: p ? { percent: p.percent, onCharger: p.onCharger, settings: p.settings } : null };
  }
  async function postStatus(st, { force = false } = {}) {
    const b = statusBody(st);
    const same = lastStatus.state === st && lastStatus.checkIn === b.checkIn && Date.now() - lastStatus.at < 60 * 60e3;
    if (same && !force) return;
    lastStatus = { state: st, at: Date.now(), checkIn: b.checkIn };
    await post('status', b);
  }

  // --- the direct link ---
  function answerOffer(m) {
    const pc = new ndc.PeerConnection('mac', { iceServers: cfg.iceServers || DEFAULT_ICE });
    let answered = false, linked = false;
    const sendAnswer = () => {
      if (answered) return; answered = true;
      const d = pc.localDescription();
      if (d) { post('answer', { oid: m.oid, sdp: d.sdp }); log(`answered offer ${m.oid}`); }
    };
    pc.onGatheringStateChange((s) => { if (s === 'complete') sendAnswer(); });
    pc.onLocalDescription(() => setTimeout(sendAnswer, 4000)); // don't wait forever for slow STUN
    pc.onDataChannel((dc) => { linked = true; attach(pc, dc); });
    pc.onStateChange((s) => { if (s === 'failed' || s === 'closed') { try { pc.close(); } catch {} } });
    setTimeout(() => { if (!linked) { log('direct link did not open (phone may use the backup route)'); try { pc.close(); } catch {} } }, 45e3);
    try { pc.setRemoteDescription(m.sdp, 'offer'); } catch (e) { log('bad offer: ' + e.message); }
  }

  function attach(pc, dc) {
    const max = Math.max(16e3, Math.min(dc.maxMessageSize?.() || 65536, 200e3)) - 1024;
    const send = (msg) => {
      if (!dc.isOpen()) return;
      let s = JSON.stringify(msg);
      if (s.length <= max) { dc.sendMessage(s); return; }
      // Big screen replays are split into pieces that fit.
      if (msg.t === 'reset' || msg.t === 'o') {
        const d = msg.d; const step = Math.floor(max / 2);
        for (let i = 0; i < d.length; i += step) dc.sendMessage(JSON.stringify({ t: i === 0 && msg.t === 'reset' ? 'reset' : 'o', d: d.slice(i, i + step) }));
      } else if (msg.t === 'result') {
        dc.sendMessage(JSON.stringify({ ...msg, out: msg.out.slice(-Math.floor(max / 2)) }));
      }
    };
    const onOpen = () => {
      peers.add(send); core.clients.add(send);
      power && power.setPhoneWanting(true);
      log(`phone connected directly (${peers.size} open)`);
      send({ t: 'reset', d: core.screen() });
      if (power) send({ t: 'power', ...power.status() });
    };
    if (dc.isOpen()) onOpen(); else dc.onOpen(onOpen);
    dc.onMessage((raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.t === 'i' && typeof m.d === 'string') core.input(m.d);
      else if (m.t === 'r') core.resize(m.cols | 0, m.rows | 0);
      else if (m.t === 'cmd') core.runJob(String(m.id), m.cmd, (r) => deliver(r));
      else if (m.t === 'settings') applySettings(m.power);
      else if (m.t === 'ping') send({ t: 'pong' });
    });
    dc.onClosed(() => {
      peers.delete(send); core.clients.delete(send);
      power && power.setPhoneWanting(peers.size > 0);
      log(`phone disconnected (${peers.size} open)`);
      try { pc.close(); } catch {}
    });
  }

  // --- results: over the direct link if open, otherwise as an encrypted note ---
  async function deliver(r) {
    if (peers.size) { for (const s of peers) s({ t: 'result', ...r }); return; }
    let out = r.out;
    for (;;) { // shrink the output until the note fits on the board
      const sealed = seal(keys, { id: msgId(), ts: Date.now(), from: 'mac', type: 'result', cid: r.id, code: r.code, out });
      if (sealed.length <= MAX_NOTE || out.length < 50) { await board.publish(sealed).catch((e) => log('result post failed: ' + e.message)); break; }
      out = '…(start cut)…\n' + out.slice(Math.floor(out.length * 0.4));
    }
    if (cfg.notify !== false) {
      board.publish(r.code === 0 ? 'Command finished ✅' : `Command failed ❌ (exit ${r.code})`, keys.notifyTopic, { Title: 'Pocket Terminal' }).catch(() => {});
    }
  }

  function applySettings(p) {
    if (!power || !p || typeof p !== 'object') return;
    const allowed = ['enabled', 'awakeOnCharger', 'batteryMode', 'checkInMinutes', 'smartCheckIn', 'idleMinutes', 'minBattery', 'stopAlarmsBelow'];
    const next = {}; for (const k of allowed) if (k in p) next[k] = p[k];
    if ('checkInMinutes' in next) next.checkInMinutes = Math.min(120, Math.max(1, Number(next.checkInMinutes) || 5));
    if ('minBattery' in next) next.minBattery = Math.min(90, Math.max(5, Number(next.minBattery) || 20));
    if ('batteryMode' in next && !['saver', 'instant'].includes(next.batteryMode)) delete next.batteryMode;
    power.update(next);
    try { fs.writeFileSync(path.join(dir, 'power.json'), JSON.stringify(power.s, null, 2), { mode: 0o600 }); } catch {}
    log('power settings updated ' + JSON.stringify(next));
    for (const s of peers) s({ t: 'power', ...power.status() });
  }

  // --- reading the mailbox ---
  function onNote(text) {
    const m = open(keys, text);
    if (!m || m.from !== 'phone' || typeof m.id !== 'string' || seen.has(m.id)) return;
    seen.add(m.id); saveState();
    const age = Date.now() - Number(m.ts);
    if (!(age > -2 * 60e3)) return; // clocks wildly off: ignore
    if (m.type === 'hello' && age < FRESH.hello) {
      // Phone opened the app: stay awake ~2 min so it can connect.
      power && power.setPhoneWanting(true);
      clearTimeout(phoneWaitingTimer);
      phoneWaitingTimer = setTimeout(() => power && power.setPhoneWanting(peers.size > 0), 2 * 60e3);
      log('phone said hello: staying awake for it');
      postStatus('online', { force: true });
    } else if (m.type === 'offer' && age < FRESH.offer && typeof m.sdp === 'string') {
      if (process.env.POCKET_NO_DIRECT) return log('ignoring offer (POCKET_NO_DIRECT test switch)');
      answerOffer(m);
    } else if (m.type === 'cmd' && age < maxCmdAge) {
      core.runJob(String(m.cid), m.cmd, (r) => deliver(r));
    } else if (m.type === 'settings' && age < FRESH.settings) {
      applySettings(m.power);
    }
  }

  const onOpenStream = () => { power && power.setConnected(true); };
  board.stream(onNote, onOpenStream);
  postStatus('online', { force: true });
  log(`direct mode: mailbox ready on ${board.urls.join(', ')}`);

  return {
    onWake: () => board.restart(onNote, onOpenStream), // pick up notes that arrived while asleep
    onSleep: async () => {
      await postStatus('sleeping');
      board.stop(); power && power.setConnected(false); saveState();
    },
    onPower: (s) => { for (const p of peers) p({ t: 'power', ...s }); },
    stop: () => { board.stop(); saveState(); },
  };
}

module.exports = { startDirect, DEFAULT_ICE };
