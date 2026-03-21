// First Light — Service Worker v3
const CACHE_NAME = 'first-light-v3';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

// Install: precache app shell only
self.addEventListener('install', async event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })()
  );
});

// Activate: delete old caches
self.addEventListener('activate', async event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// Fetch: cache-first for same-origin assets, network-only for external
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache external APIs (Nominatim, fonts, etc.)
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      // Try cache first
      const cached = await caches.match(request);
      if (cached) return cached;

      // Fetch from network
      try {
        const response = await fetch(request);

        // Only cache valid same-origin responses from our whitelist
        if (
          response.ok &&
          response.status === 200 &&
          PRECACHE_URLS.some(u => request.url.endsWith(u.replace('./', '')))
        ) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
        }

        return response;
      } catch {
        // Offline fallback: return cached index.html for document requests
        if (request.destination === 'document') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      }
    })()
  );
});
