// Relay mode (optional): connect OUT to a relay server you host (see ../relay).
// Kept for people who prefer a server in the middle (always-on queue, web push).

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

function startRelay({ cfg, core, power, log, dir }) {
  let ws = null, retry = 0, timer = null, connectedAt = 0;
  const send = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  core.clients.add((msg) => send(msg.t === 'result' ? { t: 'jobdone', id: msg.id, code: msg.code, out: msg.out } : msg));

  function applySettings(p) {
    if (!power || !p) return;
    const allowed = ['enabled', 'awakeOnCharger', 'batteryMode', 'checkInMinutes', 'smartCheckIn', 'idleMinutes', 'minBattery', 'stopAlarmsBelow'];
    const next = {}; for (const k of allowed) if (k in p) next[k] = p[k];
    if ('checkInMinutes' in next) next.checkInMinutes = Math.min(120, Math.max(1, Number(next.checkInMinutes) || 5));
    if ('minBattery' in next) next.minBattery = Math.min(90, Math.max(5, Number(next.minBattery) || 20));
    power.update(next);
    try { fs.writeFileSync(path.join(dir, 'power.json'), JSON.stringify(power.s, null, 2), { mode: 0o600 }); } catch {}
  }

  const open = () => {
    clearTimeout(timer);
    ws = new WebSocket(cfg.relay.replace(/^http/, 'ws') + '/agent', { headers: { Authorization: `Bearer ${cfg.token}` }, handshakeTimeout: 15e3 });
    const sock = ws; let alive = true, beat;
    sock.on('open', () => {
      retry = 0; connectedAt = Date.now(); log('connected to relay');
      power && power.setConnected(true);
      if (core.hasShell()) send({ t: 'buf', d: core.screen() });
      if (power) send({ t: 'power', ...power.status() });
      beat = setInterval(() => { if (!alive) return sock.terminate(); alive = false; sock.ping(); }, 20e3);
    });
    sock.on('pong', () => { alive = true; });
    sock.on('ping', () => { alive = true; });
    sock.on('message', (raw) => {
      alive = true;
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'i') core.input(m.d);
      else if (m.t === 'r') core.resize(m.cols, m.rows);
      else if (m.t === 'job') core.runJob(m.id, m.cmd, (r) => send({ t: 'jobdone', id: r.id, code: r.code, out: r.out }));
      else if (m.t === 'want') power && power.setPhoneWanting(m.phones > 0);
      else if (m.t === 'settings') applySettings(m.power);
    });
    sock.on('close', (code) => {
      clearInterval(beat); power && power.setConnected(false);
      if (ws !== sock) return;
      if (code === 4000) log('another agent took over');
      const wait = power && power.sleeping ? 25e3 : Math.min(30e3, 1000 * 2 ** retry++);
      log(`disconnected, retrying in ${Math.round(wait / 1000)}s`);
      timer = setTimeout(open, wait);
    });
    sock.on('error', (e) => { if (String(e.message).includes('401')) log('relay said 401: AGENT_TOKEN does not match the relay'); });
  };
  open();
  // Free hosts nap without visits; a tiny visit every 10 min keeps the relay ready.
  if (!/localhost|127\.0\.0\.1/.test(cfg.relay)) setInterval(() => fetch(cfg.relay + '/healthz').catch(() => {}), 10 * 60e3);

  return {
    onWake: () => {
      if (ws && ws.readyState === 1 && Date.now() - connectedAt < 10e3) return;
      retry = 0; try { ws && ws.terminate(); } catch {} ws = null; open();
    },
    onSleep: async (s) => {
      send({ t: 'sleeping', nextWake: s.nextWake });
      await new Promise((r) => setTimeout(r, 300));
      try { ws && ws.close(4001, 'sleeping'); } catch {}
    },
    onPower: (s) => send({ t: 'power', ...s }),
    stop: () => { try { ws && ws.close(); } catch {} },
  };
}

module.exports = { startRelay };
