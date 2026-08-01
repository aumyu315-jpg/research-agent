/* ─────────────────────────────────────────────
   Aurora — service worker (offline app shell)
   ───────────────────────────────────────────── */
const CACHE = 'aurora-v4';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/ui.js',
  './js/markdown.js',
  './js/storage.js',
  './js/search.js',
  './js/ai.js',
  './js/content.js',
  './js/fx.js',
  './js/tts.js',
  './js/app.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // Never cache cross-origin API calls — let them hit the network
  if (url.origin !== self.location.origin) return;

  // App shell + static assets: network-first (always fresh after deploys),
  // falling back to the cache only when offline.
  if (request.mode === 'navigate' ||
      SHELL.includes(url.pathname) ||
      /\.(css|js|webmanifest|png|svg|ico)$/.test(url.pathname)) {
    e.respondWith(
      fetch(request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return res;
      }).catch(() =>
        caches.match(request).then(cached => cached || caches.match('./index.html'))
      )
    );
  }
});
