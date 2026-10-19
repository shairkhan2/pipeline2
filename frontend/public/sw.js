// Screening Room service worker.
// Rules: never intercept video streams (range requests must hit the network),
// API requests are network-only, posters/fonts are stale-while-revalidate,
// app code and navigations are network-first so redesigns reach existing installs.
const VERSION = 'sr-v9';
const SHELL = [
  '/',
  '/room.css?v=2',
  '/api.js?v=1',
  '/app.js?v=3',
  '/status.html',
  '/status.css?v=5',
  '/status-app.js?v=7',
  '/studio.html',
  '/studio.css?v=1',
  '/studio.js?v=1',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req) {
  return fetch(req).then((res) => {
    if (res.ok && !res.redirected) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req));
}

function staleWhileRevalidate(req) {
  return caches.match(req).then((hit) => {
    const fresh = fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => hit);
    return hit || fresh;
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;

  // Session-bound API data must never enter an offline cache, including audio previews.
  if (sameOrigin && url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // Video: never intercept — pass straight through to the network.
  if (sameOrigin && url.pathname.startsWith('/media/')) return;

  // Navigations: network first so UI updates land immediately, cache as backup.
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req));
    return;
  }

  // App code must update alongside the HTML, including installed PWAs.
  if (sameOrigin && ['/api.js', '/app.js', '/room.css', '/status.css', '/status-app.js', '/new-series.css', '/series-studio.css', '/new-series.js', '/studio.css', '/studio.js', '/setup.css', '/setup.js'].includes(url.pathname)) {
    e.respondWith(networkFirst(req));
    return;
  }

  // Posters and thumbnails require an authenticated session: never store in offline cache.
  if (sameOrigin && (url.pathname.startsWith('/poster/') || url.pathname.startsWith('/thumbs/'))) {
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // Webfonts: show cached copy, refresh in the background.
  if (url.origin === 'https://fonts.googleapis.com' ||
      url.origin === 'https://fonts.gstatic.com') {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Everything else same-origin (icons, manifest): cache first.
  if (sameOrigin) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
  }
});
