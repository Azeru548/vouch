const CACHE = 'vouch-shell-v1';
const SHELL = [
  '/',
  '/styles.css',
  '/app.js',
  '/map.html',
  '/map.js',
  '/manifest.webmanifest',
  '/icons/seal.svg',
  '/icons/seal-192.png',
  '/icons/seal-512.png',
  '/icons/seal-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/verify') || url.pathname.startsWith('/report') || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (request.destination === 'document' && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match('/'));
    }),
  );
});
