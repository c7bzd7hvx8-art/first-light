// First Light — Service Worker v2.1
const CACHE_NAME = 'first-light-v2.1';

const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './diary.html',
  './diary.css',
  './diary.js',
  './privacy.html',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './deerschool.html',
  './deerschool.css',
  './deerschool.js',
  './questions.js',
  './diary-guide.html'
];

// CDN libraries to precache for offline use
const CDN_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

// Domains that should be served cache-first when offline
const CACHEABLE_ORIGINS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// Install: precache app shell + CDN libraries
self.addEventListener('install', async event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const allUrls = PRECACHE_URLS.concat(CDN_URLS);
      await Promise.all(
        allUrls.map(url =>
          cache.add(url).catch(e => console.warn('[SW] Failed to cache:', url, e))
        )
      );
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

// Fetch handler
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCacheableCDN = CACHEABLE_ORIGINS.some(d => url.hostname === d || url.hostname.endsWith('.' + d));

  if (!isSameOrigin && !isCacheableCDN) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);

        if (response.ok && response.status === 200) {
          const shouldCache = isSameOrigin
            ? PRECACHE_URLS.some(u => request.url.endsWith(u.replace('./', '')))
            : isCacheableCDN;

          if (shouldCache) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
          }
        }

        return response;
      } catch {
        if (request.destination === 'document') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      }
    })()
  );
});
