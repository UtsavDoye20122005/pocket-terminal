// Message-board client (ntfy protocol). The board is only a mailbox for encrypted
// notes: the "hello" that sets up the direct link, and the backup route for commands.
// You can list several boards; we post to all and read from all (no single point of failure).
//
// ntfy API used:
//   POST {board}/{topic}                       post a note (kept 12 h on ntfy.sh)
//   GET  {board}/{topic}/json?since=ID|10m     stream of notes, one JSON per line
//   GET  {board}/{topic}/json?poll=1&since=…   same, but returns right away

const MAX_NOTE = 3800; // ntfy turns bigger notes into attachments; stay under 4096

class Board {
  constructor(urls, topic, { log = () => {}, since = {} } = {}) {
    this.urls = urls.map((u) => u.replace(/\/+$/, ''));
    this.topic = topic;
    this.log = log;
    this.since = { ...since };   // last note id seen, per board
    this.streams = new Map();
    this.stopped = false;
  }

  async publish(text, topic = this.topic, headers = {}) {
    if (text.length > MAX_NOTE && topic === this.topic) throw new Error('note too big');
    const results = await Promise.allSettled(this.urls.map((u) =>
      fetch(`${u}/${topic}`, { method: 'POST', body: text, headers, signal: AbortSignal.timeout(15e3) })
        .then((r) => { if (!r.ok) throw new Error(`${u} answered ${r.status}`); return r; })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    for (const r of results) if (r.status === 'rejected') this.log('board post failed: ' + r.reason.message);
    if (!ok) throw new Error('no board accepted the note');
    return ok;
  }

  // Read everything new on every board once, then return.
  async poll(onNote) {
    await Promise.allSettled(this.urls.map(async (u) => {
      const since = this.since[u] || '10m';
      const r = await fetch(`${u}/${this.topic}/json?poll=1&since=${encodeURIComponent(since)}`, { signal: AbortSignal.timeout(15e3) });
      for (const line of (await r.text()).split('\n')) this._line(u, line, onNote);
    }));
  }

  // Keep a live stream open to every board. Reconnects by itself.
  stream(onNote, onOpen = () => {}) {
    this.stopped = false;
    for (const u of this.urls) this._streamOne(u, onNote, onOpen);
  }

  async _streamOne(u, onNote, onOpen) {
    const old = this.streams.get(u); if (old) old.abort();
    const ctl = new AbortController(); this.streams.set(u, ctl);
    try {
      const since = this.since[u] || '10m';
      const r = await fetch(`${u}/${this.topic}/json?since=${encodeURIComponent(since)}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`answered ${r.status}`);
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const ev = this._line(u, line, onNote);
          if (ev && ev.event === 'open') onOpen(u);
        }
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      this.log(`board stream ${u}: ${e.message}`);
    }
    if (!this.stopped && this.streams.get(u) === ctl) setTimeout(() => this._streamOne(u, onNote, onOpen), 3000);
  }

  _line(u, line, onNote) {
    if (!line.trim()) return null;
    let ev; try { ev = JSON.parse(line); } catch { return null; }
    if (ev.event === 'message') { this.since[u] = ev.id; onNote(ev.message, u, ev); }
    return ev;
  }

  // After the Mac wakes, old streams are dead. Start fresh from where we left off.
  restart(onNote, onOpen) { this.stop(); this.stream(onNote, onOpen); }
  stop() { this.stopped = true; for (const c of this.streams.values()) c.abort(); this.streams.clear(); }
}

module.exports = { Board, MAX_NOTE };
