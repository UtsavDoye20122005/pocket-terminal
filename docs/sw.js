// Offline cache for the app's own files, so it opens instantly from the home screen.
// Bump VERSION on every release so phones pick up the new code.
const VERSION = 'pt-v6.1.0';
const FILES = ['./', 'index.html', 'js/app.js', 'js/crypto.js', 'js/board.js', 'js/helper.js', 'vendor/xterm.js', 'vendor/xterm.css', 'vendor/addon-fit.js', 'vendor/jsQR.js', 'manifest.json', 'icon.svg', 'icon.png', 'css/app.css', 'fonts/ibm-plex-sans-latin-400-normal.woff2', 'fonts/ibm-plex-sans-latin-500-normal.woff2', 'fonts/ibm-plex-sans-latin-600-normal.woff2', 'fonts/jetbrains-mono-latin-400-normal.woff2', 'fonts/jetbrains-mono-latin-700-normal.woff2'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // never touch board traffic
  // Network first (fresh code when online), cache when offline.
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
