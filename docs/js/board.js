// Browser twin of agent/lib/board.js (ntfy protocol). Posts to every board, reads
// from every board, and the app ignores duplicates by the note's inner id.
export const MAX_NOTE = 3800;

export class Board {
  constructor(urls, topic, onNote, onState = () => {}) {
    this.urls = urls.map((u) => u.replace(/\/+$/, ''));
    this.topic = topic; this.onNote = onNote; this.onState = onState;
    this.since = {}; this.ctl = new Map(); this.up = new Set(); this.stopped = false;
  }
  async publish(text) {
    if (text.length > MAX_NOTE) throw new Error('Too long to send');
    const res = await Promise.allSettled(this.urls.map((u) =>
      fetch(`${u}/${this.topic}`, { method: 'POST', body: text }).then((r) => { if (!r.ok) throw new Error(`${r.status}`); })));
    if (!res.some((r) => r.status === 'fulfilled')) {
      const why = res.map((r) => r.reason && r.reason.message).join(', ');
      throw new Error(why.includes('429') ? 'Board says: too many messages today. Try later or add your own board.' : 'Could not reach the message board');
    }
  }
  start(since = '12h') {
    this.stopped = false;
    for (const u of this.urls) { if (!this.since[u]) this.since[u] = since; this._run(u); }
  }
  async _run(u) {
    this.ctl.get(u)?.abort();
    const ctl = new AbortController(); this.ctl.set(u, ctl);
    try {
      const r = await fetch(`${u}/${this.topic}/json?since=${encodeURIComponent(this.since[u])}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(r.status);
      const reader = r.body.getReader(); const td = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += td.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.event === 'open') { this.up.add(u); this.onState(this.up.size); }
          if (ev.event === 'message') { this.since[u] = ev.id; this.onNote(ev.message); }
        }
      }
    } catch (e) { if (ctl.signal.aborted) return; }
    this.up.delete(u); this.onState(this.up.size);
    if (!this.stopped && this.ctl.get(u) === ctl) setTimeout(() => this._run(u), 3000);
  }
  restart() { for (const u of this.urls) this._run(u); }
  stop() { this.stopped = true; for (const c of this.ctl.values()) c.abort(); }
}
