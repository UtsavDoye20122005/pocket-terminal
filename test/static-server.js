// Serves docs/ on http://localhost:PORT for tests (localhost counts as a secure origin).
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'docs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
module.exports.startStatic = (port = 0) => new Promise((res) => {
  const s = http.createServer((req, r) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, path.normalize(p)); if (!f.startsWith(ROOT)) { r.writeHead(403); return r.end(); }
    fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
  });
  s.listen(port, '127.0.0.1', () => res({ server: s, port: s.address().port }));
});
