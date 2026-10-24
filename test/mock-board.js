// A tiny stand-in for ntfy.sh, for offline tests. Implements just what Pocket Terminal uses:
//   POST /:topic                     store a note
//   GET  /:topic/json?since=…        stream notes (newline JSON), or ?poll=1 to return at once
// usage: node test/mock-board.js [port]
const http = require('http');
const crypto = require('crypto');

function startBoard(port = 0) {
  const topics = new Map(); // topic -> [{id,time,event,topic,message}]
  const watchers = new Map(); // topic -> Set(res)
  const stats = { posts: 0 };

  function after(list, since) {
    if (!since || since === 'all') return list;
    const dur = /^(\d+)([smh])$/.exec(since);
    if (dur) { const ms = dur[1] * { s: 1e3, m: 60e3, h: 3600e3 }[dur[2]]; return list.filter((m) => m.time * 1000 >= Date.now() - ms); }
    if (/^\d+$/.test(since)) return list.filter((m) => m.time >= Number(since));
    const i = list.findIndex((m) => m.id === since);
    return i >= 0 ? list.slice(i + 1) : list;
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    const topic = parts[0];
    if (!topic || !/^[-_A-Za-z0-9]{1,64}$/.test(topic)) { res.writeHead(404); return res.end(); }
    if (req.method === 'POST' && parts.length === 1) {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (body.length > 4096) { res.writeHead(413); return res.end(); }
        const m = { id: crypto.randomBytes(6).toString('hex'), time: Math.floor(Date.now() / 1000), event: 'message', topic, message: body };
        if (!topics.has(topic)) topics.set(topic, []);
        topics.get(topic).push(m); stats.posts++;
        for (const w of watchers.get(topic) || []) w.write(JSON.stringify(m) + '\n');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(m));
      });
      return;
    }
    if (req.method === 'GET' && parts[1] === 'json') {
      const list = after(topics.get(topic) || [], url.searchParams.get('since'));
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      if (url.searchParams.get('poll')) { for (const m of list) res.write(JSON.stringify(m) + '\n'); return res.end(); }
      res.write(JSON.stringify({ id: 'open', time: Math.floor(Date.now() / 1000), event: 'open', topic }) + '\n');
      for (const m of list) res.write(JSON.stringify(m) + '\n');
      if (!watchers.has(topic)) watchers.set(topic, new Set());
      watchers.get(topic).add(res);
      const ka = setInterval(() => res.write(JSON.stringify({ event: 'keepalive' }) + '\n'), 25e3);
      req.on('close', () => { clearInterval(ka); watchers.get(topic).delete(res); });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, topics, stats })));
}

if (require.main === module) startBoard(Number(process.argv[2] || 8790)).then(({ port }) => console.log(`mock board on http://127.0.0.1:${port}`));
module.exports = { startBoard };
