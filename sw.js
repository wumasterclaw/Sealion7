// Offline cache for the app shell. Data always comes live from the adapter.
const CACHE = 'sealion7-v3';
const FILES = ['./', 'index.html', 'css/styles.css', 'js/app.js', 'js/sources.js', 'js/elm.js', 'js/obd.js',
  'js/profile.js', 'js/features.js', 'js/planner.js', 'js/trip.js', 'js/sample-trip.js', 'js/safety.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
// Network first so updates arrive straight away, cache as fallback when offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // only the app itself and its pinned map library are cached; map tiles and APIs go straight to the network
  const u = new URL(e.request.url);
  if (u.origin !== location.origin && !u.href.startsWith('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/')) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});
