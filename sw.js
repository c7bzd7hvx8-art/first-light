// First Light — Service Worker
//
// Single version source: bump SW_VERSION and both cache names + header log
// line update automatically. Previously the comment (`v7.33`) drifted from
// the cache strings (`v7.34`) because they were three separate literals.
// Bumping triggers the `activate` step to sweep old caches and reload clients
// via the `controllerchange` path in diary.js.
const SW_VERSION = '13.99';
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
  './fl-icons.css',
  // Self-hosted brand fonts (SIL OFL) — precached so the brand renders on the
  // first offline launch on a fresh device (were Google Fonts, runtime-cached
  // only, so a cold offline first-launch fell back to system fonts).
  './fonts/fonts.css',
  './fonts/playfair-400.woff2',
  './fonts/playfair-600.woff2',
  './fonts/playfair-700.woff2',
  './fonts/playfair-400i.woff2',
  './fonts/playfair-700i.woff2',
  './fonts/dmsans-300.woff2',
  './fonts/dmsans-400.woff2',
  './fonts/dmsans-500.woff2',
  './fonts/dmsans-600.woff2',
  './fonts/dmsans-700.woff2',
  './fonts/dmmono-400.woff2',
  './fonts/dmmono-500.woff2',
  './fonts/outfit-400.woff2',
  './fonts/outfit-500.woff2',
  './fonts/outfit-600.woff2',
  './fonts/outfit-700.woff2',
  './standalone-boot.js',
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
  './modules/stands.mjs',
  './modules/sightings.mjs',
  './modules/photos.mjs',
  './modules/stats.mjs',
  './modules/pdf.mjs',
  // Grounds boundaries (GROUNDS-PLAN.md G2) — statically imported by diary.js,
  // so the import-abort rule applies: a miss here bricks first offline launch.
  './modules/grounds.mjs',
  './modules/shared-grounds.mjs',
  // Pure lib statically imported by diary.js (isBlankDayEntry, blankDaySummaryText,
  // formatRelativeTime). A failed ES-module import aborts the whole diary module
  // graph, so this MUST be precached alongside the diary modules above — a miss
  // here 404s the import on a fresh device's first offline launch.
  './lib/fl-pure.mjs',
  './lib/fl-forecast.mjs',
  './lib/fl-sightings.mjs',
  // Grounds boundary geometry (GROUNDS-PLAN.md G1) — precached ahead of the
  // G2 client that imports it, exactly like fl-forecast was at Stands S2.
  './lib/fl-geo.mjs',
  // Satellite-PDF map maths (statically imported by diary.js for the
  // "Export ground as PDF" feature) — must be precached or an offline diary
  // load fails at the import.
  './lib/fl-mapexport.mjs',
  // Photo EXIF reader — statically imported by modules/photos.mjs, which is
  // in diary.js's module graph, so the same import-abort rule applies.
  './lib/fl-exif.mjs',
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
  // Per-species deer illustrations for the calculator's anatomy panel.
  // Add additional species SVGs here as they land in species/aimthedeer/.
  // Muntjac and CWD SVGs exist on disk but are intentionally NOT precached
  // (and not referenced from lib/fl-anatomy.js SPECIES_IMAGE) because both
  // species are excluded from SPECIES_BODY — the anatomy dropdown never
  // offers them. See PROJECT-LOG.md 2026-06-03 for the rationale.
  './species/aimthedeer/reddeer.svg',
  './species/aimthedeer/roedeer.svg',
  './species/aimthedeer/fallow.svg',
  './species/aimthedeer/sika.svg',
  // Ballistic calculator. Standalone — no dependency on diary state
  // or auth, but every file the calculator needs at boot must be
  // precached so the calculator is fully usable offline like the
  // rest of the app.
  './ballistics.html',
  './ballistics.css',
  './lib/fl-ballistics.js',
  './lib/fl-ammo.js',
  './lib/fl-deer-law.js',
  './lib/fl-deer-seasons.js',
  './lib/fl-deer-seasons-bridge.js',
  './lib/fl-anatomy.js',
  './lib/fl-lead-free-matcher.js',
  './data/ammo-loads.json',
  './modules/ballistics-ui.js',
  './modules/ballistics-compliance.js',
  './modules/ballistics-rangecard.js',
  './modules/ballistics-init.js',
  './modules/dope-card.js',
  'https://firstlightdeer.co.uk/species/UKDTR_logo.JPG',
  'https://firstlightdeer.co.uk/species/bds_logo.jpg',
  'https://firstlightdeer.co.uk/species/basc_logo.png',
  'https://firstlightdeer.co.uk/species/broadsideshot.jpeg',
  'https://firstlightdeer.co.uk/species/quarteringtowardsshot.jpeg',
  'https://firstlightdeer.co.uk/species/headonshot.jpeg',
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
  // Pinned + SRI-verified in diary.html/index.html (audit A3, SW 9.48). The
  // URL here must stay byte-identical to the <script src> or offline breaks.
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.106.2/dist/umd/supabase.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css'
];

// Domains the fetch handler is allowed to cache opportunistically
// (stale-while-revalidate). Must be a superset of the hosts in CDN_URLS
// otherwise those requests get passed through
// to the network unchanged, breaking offline.
const CACHEABLE_ORIGINS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com'
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

async function staleWhileRevalidate(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  // Refresh runs regardless; failures are swallowed (offline is normal here).
  const revalidate = (async () => {
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
    return networkResponse;
  })();
  if (cached) {
    // Audit A7 (fixed SW 9.50): serve the cached copy IMMEDIATELY. The old
    // code awaited the network before responding and then returned the
    // cached copy anyway — every "cached" asset load was network-latency
    // bound for zero benefit (painful on rural signal). The refresh now
    // continues in the background; event.waitUntil keeps the SW alive
    // until the cache.put lands. Offline behaviour is unchanged.
    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(revalidate.catch(function() {}));
    }
    return cached;
  }
  const out = await revalidate;
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
    // Offline path. Order matters (audit A1, fixed SW 9.47):
    // 1. The cache we were handed (RUNTIME_CACHE for navigations) may hold a
    //    fresher copy than the install-time precache — check it first.
    // 2. Then ALL caches via caches.match — the precached app shell lives in
    //    STATIC_CACHE, which this function never consulted before 9.47. The
    //    old code looked up './index.html' *before* the page-specific
    //    fallback, and since index.html is always precached that lookup
    //    always won: a fresh install (or first offline launch after any SW
    //    bump — RUNTIME_CACHE is version-named, so it starts empty)
    //    navigating offline to diary.html / ballistics.html /
    //    deerschool.html got the Field Guide instead of the requested app.
    // 3. Navigations only: retry ignoring query strings (?utm=… launches),
    //    then by trailing path segment, then index.html as the last-resort
    //    shell (still needed: manifest.json start_url './' resolves to '/',
    //    which no precache key matches directly). Non-navigation misses now
    //    503 instead of receiving index.html with the wrong MIME (audit A8).
    const cached = await cache.match(request);
    if (cached) return cached;
    const anyCached = await caches.match(request);
    if (anyCached) return anyCached;
    if (isNavigationRequest(request)) {
      const ignoringSearch = await caches.match(request, { ignoreSearch: true });
      if (ignoringSearch) return ignoringSearch;
      const lastSeg = url.pathname.replace(/\/$/, '').split('/').pop() || '';
      if (lastSeg.endsWith('.html') && lastSeg !== 'index.html') {
        const bySegment = await caches.match('./' + lastSeg);
        if (bySegment) return bySegment;
      }
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

// ── Precache integrity ─────────────────────────────────────────────────────
//
// The install below used to be one line — every URL added in parallel with a
// per-URL `.catch(warn)` — and nothing checked the result. So a first install
// on rural signal could drop half the app shell and still report success. The
// browser then marks the worker installed and activated, and because the cache
// is version-named nothing ever looks at it again: online the holes are
// invisible (networkFirst and stale-while-revalidate simply fetch the file),
// offline they are a plain-text 503 for a file diary.js statically imports —
// and a failed ES-module import aborts the entire module graph, so one missing
// .mjs is a blank app, not a degraded one. The hole then lasts until the next
// version bump, which is to say for as long as the owner leaves the app alone.
//
// So same-origin entries are REQUIRED and the install refuses to finish
// without them, while remote entries — the six firstlightdeer.co.uk photos and
// the three CDN libraries — stay best-effort, because a third party having a
// bad afternoon must not cost the user their offline app shell.
//
// Refusing is the right failure here. A rejected install leaves the previous
// worker serving, or on a first visit leaves no worker at all, and the browser
// retries on the next navigation. A page with no service worker still works
// perfectly online and installs properly later; a page with a holed one is
// broken in the field, which is the one place this app has to work, and it
// never heals itself.
const REQUIRED_PRECACHE_URLS = PRECACHE_URLS.filter(u => u.indexOf('./') === 0);

/** Add every URL to the cache; resolves to the list that did not make it. */
async function cacheAddAll(cache, urls) {
  const failed = [];
  await Promise.all(urls.map(async url => {
    try {
      // cache: 'reload' (2026-07-27): plain cache.add() fetches THROUGH the
      // HTTP cache, and GitHub Pages' CDN serves stale files for up to ten
      // minutes after an upload. The SW update check always fetches sw.js
      // itself fresh (per spec), so a quick update after a deploy produced a
      // new cache VERSION wrapping old file BYTES - five launch-day patches
      // "arrived" on the owner's phone as a fresh SW number over stale code.
      // Forcing network here makes the versioned precache mean what it says.
      await cache.add(new Request(url, { cache: 'reload' }));
    } catch (e) {
      failed.push(url);
      console.warn('[SW] Failed to cache:', url, e);
    }
  }));
  return failed;
}

/** Which of `urls` cannot be read back out of `cache`. Verified by lookup
 *  rather than by trusting that cache.add() resolved: what matters at 6am on a
 *  hill with no signal is whether the file comes back, not whether a promise
 *  settled an hour ago. */
async function missingFromCache(cache, urls) {
  const out = [];
  await Promise.all(urls.map(async url => {
    let hit = null;
    try { hit = await cache.match(url); } catch (e) { hit = null; }
    if (!hit) out.push(url);
  }));
  return out;
}

// Install: precache app shell + CDN libraries
self.addEventListener('install', async event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await cacheAddAll(cache, PRECACHE_URLS.concat(CDN_URLS));

      // One retry for anything required that missed. The failure this exists
      // for is a dropped packet, not a missing file, and a second attempt
      // clears most of those without troubling anyone.
      let missing = await missingFromCache(cache, REQUIRED_PRECACHE_URLS);
      if (missing.length) {
        console.warn('[SW] Retrying ' + missing.length + ' required file(s)');
        await cacheAddAll(cache, missing);
        missing = await missingFromCache(cache, REQUIRED_PRECACHE_URLS);
      }
      if (missing.length) {
        // Throwing rejects the install: nothing activates, nothing is claimed,
        // and the browser comes back to it. If this ever fires on a good
        // connection it means a required file is genuinely absent from the
        // deploy — which tests/service-worker.test.mjs exists to catch first.
        throw new Error('[SW] Install incomplete — ' + missing.length +
          ' required file(s) missing, first: ' + missing[0]);
      }
      await self.skipWaiting();
    })()
  );
});

// Activate: delete old caches, then repair anything the shell has lost
self.addEventListener('activate', async event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(k => k !== STATIC_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))
      );
      // Browsers evict cache entries under storage pressure and do not always
      // take the whole cache with them, so a worker that installed cleanly in
      // March can still be holed in July. Best-effort on purpose: by the time
      // activate runs the old worker is already gone, so refusing here would
      // leave the page with no controller at all — worse than a hole the fetch
      // handler will refill the next time that file is asked for online.
      try {
        const cache = await caches.open(STATIC_CACHE);
        const missing = await missingFromCache(cache, REQUIRED_PRECACHE_URLS);
        if (missing.length) {
          console.warn('[SW] Repairing ' + missing.length + ' evicted file(s)');
          await cacheAddAll(cache, missing);
        }
      } catch (e) { /* offline at activate time — nothing to be done about it */ }
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
          res = await staleWhileRevalidate(request, isSameOrigin ? STATIC_CACHE : RUNTIME_CACHE, event);
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

// ── Web Push (13.85) ────────────────────────────────────────────────────────
// The push-fanout edge function sends {title, body, tag, url}. Show it even
// when parsing fails — iOS revokes subscriptions that swallow pushes silently.
self.addEventListener('push', (event) => {
  let n = {};
  try { n = event.data ? event.data.json() : {}; } catch (_) { n = {}; }
  event.waitUntil(self.registration.showNotification(n.title || 'First Light', {
    body: n.body || '',
    tag: n.tag || 'fl',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: n.url || './diary.html' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './diary.html';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if ('focus' in c) { try { await c.focus(); return; } catch (_) { /* fall through */ } }
    }
    try { await self.clients.openWindow(url); } catch (_) { /* no window API */ }
  })());
});

// Version query (2026-07-27): lets the page ask the SW that is actually
// CONTROLLING it which build it is — cache-name sniffing can briefly see two
// static caches around an update, but the controller answers for itself.
self.addEventListener('message', (event) => {
  if (event.data === 'fl-sw-version' && event.ports && event.ports[0]) {
    event.ports[0].postMessage(SW_VERSION);
  }
});
