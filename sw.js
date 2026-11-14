// Offline cache for the AR layout page. Network first (so a re-export shows up on the next load), cache when offline.
const CACHE = 'ccdome-ar-v6';
const SHELL = ['./', './index.html', './app.js', './layout.json', './vendor/three.module.min.js', './manifest.webmanifest', './icon.svg', './driveway/', './driveway/index.html', './driveway/app.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([fetch(req, { cache: 'no-cache' }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))]);
      if (res && res.ok) { cache.put(req, res.clone()); return res; }
    } catch { /* offline or slow: fall back to the cache */ }
    return (await cache.match(req, { ignoreSearch: true })) || new Response('Offline and not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  })());
});
