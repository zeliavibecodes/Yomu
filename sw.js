// Keeps the app itself available offline. Books live in IndexedDB, not here.
const VERSION = 'yomu-v50';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'vendor/jszip.min.js', 'offline-dict.js', 'discover.js', 'webnovel.js', 'webdiscover.js', 'learn.js', 'write.js', 'manifest.webmanifest', 'bg/room.jpg', 'bg/grid.jpg', 'bg/tunnel.jpg', 'bg/haze.jpg', 'bg/room-thumb.jpg', 'bg/grid-thumb.jpg', 'bg/tunnel-thumb.jpg', 'bg/haze-thumb.jpg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && !k.startsWith('yomu-dict')).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Use the network when it's there so updates arrive; fall back to the saved copy offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/web-relay')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
