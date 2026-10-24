// Power brain: decides when the Mac stays awake and when it sleeps.
//
// The goal: lid closed but still reachable, using as little battery as possible.
//
//   On charger            → stay awake (lid closed is fine). Instant access. No battery used.
//   On battery, you're    → stay awake while your phone is connected, a queued job is
//   using it                running, or you typed something in the last few minutes.
//   On battery, idle      → really sleep. Set an alarm to wake up every few minutes,
//                           check in with the relay, run queued jobs, sleep again.
//   Battery very low      → sleep and stop the alarms, so the battery never dies.
//
// macOS tools used (all built in):
//   pmset -g batt                 read battery level and charger state
//   ioreg AppleClamshellState     is the lid closed?
//   pmset -a disablesleep 0|1     1 = closing the lid does NOT sleep the Mac (needs sudo)
//   pmset schedule wake "<date>"  alarm clock that wakes a sleeping Mac (needs sudo)
//   pmset sleepnow                go to sleep right now

const { execFile } = require('child_process');

const DEFAULTS = {
  enabled: true,
  awakeOnCharger: true,   // on charger: always reachable, even with the lid closed
  batteryMode: 'saver',   // 'saver' = sleep when idle and check in; 'instant' = stay awake on battery too
  checkInMinutes: 5,      // on battery: how often a sleeping Mac wakes to check for work
  smartCheckIn: true,     // check in faster right after you used it: 1 min for 30 min, 2 min for 2 h
  idleMinutes: 5,         // on battery: stay awake this long after your last keystroke
  minBattery: 20,         // below this %: never stay awake on battery
  stopAlarmsBelow: 10,    // below this %: stop waking up at all
};

function run(cmd, args, timeout = 10e3) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err || '') }));
  });
}

function parseBattery(text) {
  const onCharger = /'AC Power'/.test(text);
  const m = text.match(/(\d+)%;\s*([a-zA-Z ]+?);/);
  return { percent: m ? parseInt(m[1], 10) : null, onCharger, state: m ? m[2].trim() : (onCharger ? 'AC' : 'unknown') };
}

function pmsetDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class PowerBrain {
  // hooks: { log, onStatus(status), onWake() }
  // sys:   swap in fake commands for testing
  constructor(settings, hooks, sys = {}) {
    this.s = { ...DEFAULTS, ...(settings || {}) };
    this.hooks = hooks;
    this.sys = {
      battery: async () => parseBattery((await run('/usr/bin/pmset', ['-g', 'batt'])).out),
      lidClosed: async () => /"AppleClamshellState" = Yes/.test((await run('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'])).out),
      setNoSleep: async (on) => run('/usr/bin/sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', on ? '1' : '0']),
      scheduleWake: async (date) => run('/usr/bin/sudo', ['-n', '/usr/bin/pmset', 'schedule', 'wake', pmsetDate(date)]),
      cancelWake: async (date) => run('/usr/bin/sudo', ['-n', '/usr/bin/pmset', 'schedule', 'cancel', 'wake', pmsetDate(date)]),
      sleepNow: async () => run('/usr/bin/pmset', ['sleepnow']),
      now: () => Date.now(),
      ...sys,
    };
    this.noSleep = null;        // what we last told pmset
    this.wantedByPhone = false; // a phone has the terminal open
    this.jobsRunning = 0;
    this.lastActivity = 0;
    this.wokeAt = this.sys.now();
    this.connected = false;
    this.alarm = null;          // Date of the wake alarm we set
    this.battery = { percent: null, onCharger: true, state: 'unknown' };
    this.lastTick = this.sys.now();
    this.sleeping = false;
  }

  update(settings) { this.s = { ...this.s, ...settings }; this.tick(); }
  activity() { this.lastActivity = this.sys.now(); }
  setPhoneWanting(v) {
    if (v && !this.wantedByPhone) this.phoneSince = this.sys.now();
    if (!v && this.wantedByPhone) this.phoneLeft = this.sys.now();
    this.wantedByPhone = !!v; this.tick();
  }
  setJobs(n) { this.jobsRunning = n; this.tick(); }
  setConnected(v) {
    this.connected = !!v;
    if (v) { this.firstContact = true; this.connectedAt = this.sys.now(); setTimeout(() => this.tick(), 5500); }
  }

  // How long to sleep before the next check-in.
  // Right after you used it you'll likely need it again soon, so check in more often.
  nextCheckInMinutes() {
    const base = this.s.checkInMinutes;
    if (!this.s.smartCheckIn) return base;
    const sinceUse = this.sys.now() - Math.max(this.lastActivity, this.phoneLeft || 0, this.phoneSince || 0);
    if (sinceUse < 30 * 60e3) return Math.min(base, 1);
    if (sinceUse < 120 * 60e3) return Math.min(base, 2);
    return base;
  }

  // Why the Mac must stay awake right now (empty list = it may sleep).
  reasons() {
    const s = this.s, b = this.battery, now = this.sys.now();
    if (!s.enabled) return ['power brain off'];
    if (b.onCharger) return s.awakeOnCharger ? ['on charger'] : [];
    const r = [];
    if (b.percent !== null && b.percent < s.minBattery) return r; // protect the battery first
    if (s.batteryMode === 'instant') r.push('instant mode');
    // A phone left open on a table shouldn't drain the battery forever:
    // it only counts for 15 minutes after it connected or you last typed.
    if (this.wantedByPhone && now - Math.max(this.phoneSince || 0, this.lastActivity) < 15 * 60e3) r.push('phone connected');
    if (this.jobsRunning > 0) r.push('job running');
    if (now - this.lastActivity < s.idleMinutes * 60e3) r.push('recent typing');
    // After waking up: up to 60 s to get Wi-Fi and reach the relay. Once connected,
    // 5 s is enough to receive any queued job. Nothing to do? Straight back to sleep.
    const checking = this.firstContact ? now - (this.connectedAt || 0) < 5e3 : now - this.wokeAt < 60e3;
    if (checking) r.push('checking in');
    return r;
  }

  status() {
    const r = this.reasons();
    return {
      percent: this.battery.percent, onCharger: this.battery.onCharger,
      mode: this.s.batteryMode, checkInMinutes: this.s.checkInMinutes, nextCheckInMinutes: this.nextCheckInMinutes(),
      awake: r.length > 0, reasons: r,
      nextWake: this.alarm ? this.alarm.getTime() : null,
      settings: this.s,
    };
  }

  async tick() {
    if (this.busy || this.sleeping) return;
    this.busy = true;
    try {
      // A big gap between ticks means the Mac was asleep and just woke up.
      const now = this.sys.now();
      if (now - this.lastTick > 30e3) {
        this.wokeAt = now;
        // The connection may already be back (it can win the race against this tick).
        if (!(this.connected && now - (this.connectedAt || 0) < 10e3)) this.firstContact = false;
        this.hooks.log('woke up'); this.hooks.onWake && this.hooks.onWake();
      }
      this.lastTick = now;

      this.battery = await this.sys.battery();
      const reasons = this.reasons();
      const stayAwake = reasons.length > 0;

      if (stayAwake !== this.noSleep) {
        await this.sys.setNoSleep(stayAwake);
        this.noSleep = stayAwake;
        this.hooks.log(stayAwake ? `staying awake (${reasons.join(', ')})` : 'allowed to sleep');
      }
      this.hooks.onStatus && this.hooks.onStatus(this.status());

      // Idle on battery with the lid closed: set the alarm and go to sleep.
      if (!stayAwake && this.s.enabled && !this.battery.onCharger && await this.sys.lidClosed()) {
        await this.goToSleep();
      }
    } catch (e) {
      this.hooks.log('power error: ' + e.message);
    } finally {
      this.busy = false;
    }
  }

  async goToSleep() {
    const b = this.battery;
    if (this.alarm) { await this.sys.cancelWake(this.alarm); this.alarm = null; }
    if (b.percent === null || b.percent >= this.s.stopAlarmsBelow) {
      this.alarm = new Date(this.sys.now() + this.nextCheckInMinutes() * 60e3);
      const r = await this.sys.scheduleWake(this.alarm);
      if (!r.ok) this.hooks.log('could not set wake alarm (sudo rule missing?): ' + r.err.trim());
    } else {
      this.hooks.log(`battery ${b.percent}%: no more wake-ups until you charge`);
    }
    this.hooks.onStatus && this.hooks.onStatus(this.status());
    this.hooks.onSleep && await this.hooks.onSleep(this.status());
    this.hooks.log(`sleeping, next check-in ${this.alarm ? this.alarm.toLocaleTimeString() : 'none'}`);
    this.sleeping = true;
    this.lastTick = this.sys.now();
    await this.sys.sleepNow();
    // sleepnow returns right away; the Mac falls asleep a moment later. Ticks resume on wake.
    setTimeout(() => { this.sleeping = false; }, 20e3);
  }

  start() {
    this.timer = setInterval(() => this.tick(), 3e3);
    this.tick();
  }

  // Put macOS back to normal when the agent stops.
  async stop() {
    clearInterval(this.timer);
    if (this.noSleep) await this.sys.setNoSleep(false);
  }
}

module.exports = { PowerBrain, parseBattery, pmsetDate, DEFAULTS };
