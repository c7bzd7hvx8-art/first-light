// First Light — Service Worker
//
// Single version source: bump SW_VERSION and both cache names + header log
// line update automatically. Previously the comment (`v7.33`) drifted from
// the cache strings (`v7.34`) because they were three separate literals.
// Bumping triggers the `activate` step to sweep old caches and reload clients
// via the `controllerchange` path in diary.js.
const SW_VERSION = '8.45';
const STATIC_CACHE  = 'first-light-static-v'  + SW_VERSION;
const RUNTIME_CACHE = 'first-light-runtime-v' + SW_VERSION;

// Same-origin app shell — every file a diary/app/deerschool/privacy route
// needs to boot offline, plus the Leaflet vendor bundle (self-hosted because
// Edge Tracking Prevention blocks unpkg Leaflet on third-party contexts).
// Keep this list exhaustive: if a file isn't here, the very first offline
// session on a fresh device will 404 it.
const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './diary.html',
  './diary.css',
  './diary.js',
  // ES modules extracted from diary.js under the modularisation plan
  // (MODULARISATION-PLAN.md). Every module must be precached — a missing
  // entry here means the very first offline session on a fresh device
  // 404s the import and the app is non-functional.
  './modules/clock.mjs',
  './modules/sw-bridge.mjs',
  './modules/svg-icons.mjs',
  './modules/supabase.mjs',
  './modules/error-logger.mjs',
  './modules/profile.mjs',
  './modules/weather.mjs',
  './modules/photos.mjs',
  './modules/stats.mjs',
  './modules/pdf.mjs',
  './privacy.html',
  './terms.html',
  './manifest.json',
  './manifest-diary.json',
  './icon-152.png',
  './icon-167.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './deerschool.html',
  './deerschool.css',
  './deerschool.js',
  './questions.js',
  './diary-guide.html',
  'https://firstlightdeer.co.uk/species/UKDTR_logo.JPG',
  'https://firstlightdeer.co.uk/species/bds_logo.jpg',
  'https://firstlightdeer.co.uk/species/basc_logo.png',
  './vendor/leaflet/leaflet.min.css',
  './vendor/leaflet/leaflet.min.js',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png'
];

// Third-party CDN libraries we precache for offline use. Leaflet itself is
// self-hosted (see PRECACHE_URLS) to dodge Edge Tracking Prevention; these
// three happen to work cross-origin so we leave them on their CDN.
const CDN_URLS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css'
];

// Domains the fetch handler is allowed to cache opportunistically
// (stale-while-revalidate). Must be a superset of the hosts in CDN_URLS
// plus the Google fonts pair — otherwise those requests get passed through
// to the network unchanged, breaking offline.
const CACHEABLE_ORIGINS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

function isNavigationRequest(request) {
  return request.mode === 'navigate' || (request.destination === 'document');
}

function isStaticAsset(request, url) {
  if (request.destination === 'style' || request.destination === 'script' || request.destination === 'font' || request.destination === 'image') return true;
  if (url.pathname.endsWith('.css') || url.pathname.endsWith('.js') || url.pathname.endsWith('.png') || url.pathname.endsWith('.json') || url.pathname.endsWith('.html')) return true;
  return false;
}

function shouldBypassCaching(url) {
  if (url.pathname.includes('/v1/forecast')) return true; // weather API
  if (url.hostname.endsWith('.supabase.co')) return true; // auth/db/storage APIs
  if (url.hostname === 'nominatim.openstreetmap.org') return true; // search API
  if (url.hostname === 'api.os.uk') return true; // map API
  return false;
}

function isDeerSchoolAsset(url) {
  return (
    url.pathname.endsWith('/deerschool.html') ||
    url.pathname.endsWith('/deerschool.css') ||
    url.pathname.endsWith('/deerschool.js') ||
    url.pathname.endsWith('/questions.js')
  );
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  let networkResponse;
  try {
    networkResponse = await fetch(request);
  } catch (e) {
    networkResponse = undefined;
  }
  if (networkResponse && networkResponse.ok) {
    try {
      await cache.put(request, networkResponse.clone());
    } catch (e) { /* quota / opaque — still serve networkResponse */ }
  }
  const out = cached || networkResponse;
  return out instanceof Response ? out : new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const url = new URL(request.url);
  try {
    const network = await fetch(request);
    if (network && network.ok) {
      try {
        await cache.put(request, network.clone());
      } catch (putErr) { /* ignore */ }
    }
    return network instanceof Response ? network : new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    let fallback = await caches.match('./index.html');
    if (!fallback && isNavigationRequest(request)) {
      const lastSeg = url.pathname.replace(/\/$/, '').split('/').pop() || '';
      if (lastSeg.endsWith('.html') && lastSeg !== 'index.html') {
        fallback = await caches.match('./' + lastSeg);
      }
    }
    const out = fallback || new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    return out instanceof Response ? out : new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

// Install: precache app shell + CDN libraries
self.addEventListener('install', async event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
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
        keys.filter(k => k !== STATIC_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))
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
  // No favicon on disk — let the browser handle it (avoids SW handling missing /favicon.ico).
  if (url.pathname === '/favicon.ico') return;

  const isSameOrigin = url.origin === self.location.origin;
  const isCacheableCDN = CACHEABLE_ORIGINS.some(d => url.hostname === d || url.hostname.endsWith('.' + d));

  if (!isSameOrigin && !isCacheableCDN) return;
  if (shouldBypassCaching(url)) return;

  event.respondWith(
    (async () => {
      try {
        let res;
        if (isNavigationRequest(request)) {
          res = await networkFirst(request, RUNTIME_CACHE);
        } else if (isSameOrigin && isDeerSchoolAsset(url)) {
          // Keep Deer School UI assets in sync on first load after updates.
          res = await networkFirst(request, STATIC_CACHE);
        } else if (isStaticAsset(request, url) || isCacheableCDN) {
          res = await staleWhileRevalidate(request, isSameOrigin ? STATIC_CACHE : RUNTIME_CACHE);
        } else {
          res = await networkFirst(request, RUNTIME_CACHE);
        }
        return res instanceof Response ? res : new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      } catch (err) {
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      }
    })()
  );
});
