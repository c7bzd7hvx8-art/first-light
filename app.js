/* First Light — App v2.1 */

// ── block ──

// Field mode: set before first paint when possible (script is at end of body; respects CSP — no inline script)
(function fieldModeEarly() {
  try {
    if (localStorage.getItem('fl_field_mode') === '1') {
      document.documentElement.setAttribute('data-field-mode', 'on');
    }
  } catch (e) { /* private mode / no storage */ }
})();

// ─────────────────────────────────────────────────────────────
// FIRST LIGHT — Core JS  (refactored)
// Items addressed: 1,2,3,4,5,6,7,8,9,10,11,12
// ─────────────────────────────────────────────────────────────

// ── 10: UI namespace ─────────────────────────────────────────
window.ui = window.ui || {};

// ── 4: Centralised banner state ──────────────────────────────
window.bannerState = {
  sunriseMin:      null,
  sunsetMin:       null,
  legalStartMin:   null,
  legalEndMin:     null,
  isLegal:         false,
  isTwilight:      false,
  nextLegalStartMin: null,
  lat:             null,
  lng:             null,
  locationName:    '',
  /** Full Nominatim line (or same as name) for banner `title` when label is shortened */
  locationTooltip: ''
};

// ── Trusted UK clock (server-synced) ──────────────────────────
// 13.02 (owner's second screenshot, one day after 13.01): the countdown was
// STILL ~18 minutes behind — and this time the fault was not on the phone.
// timeapi.io's own server clock had drifted 17.8 minutes slow (measured live
// on 2 Aug 2026: two probes, RTT < 250 ms, both −17.81 min against this
// site's CDN Date header, which matched the device clock to 0.3 s) while
// worldtimeapi.org was unreachable — so the old first-success-wins chain
// trusted a lying server with no second opinion. A clock only one source can
// vouch for is not a trusted clock. Sync now samples several independent
// sources in parallel and takes the consensus:
//   1. this site's own CDN response Date header (HEAD sw.js — the service
//      worker ignores non-GET requests, so this can never come from cache)
//   2. jsdelivr's CDN Date header (already in connect-src; it CORS-exposes
//      Date. Supabase does NOT — its Date header is invisible cross-origin,
//      so the old third-tier Supabase fallback was dead code that could
//      never have worked in a browser. Measured live, then removed.)
//   3. timeapi.io (asked for UTC now — the old Europe/London form returned
//      a zoneless string that Date.parse read as device-LOCAL time, a latent
//      bug whenever the phone was set to any non-UK timezone)
//   4. worldtimeapi.org
// The largest cluster of samples agreeing within 90 s wins; sources are
// listed in trust order, so a 1-vs-1 split resolves to the site's own CDN.
// Every sample keeps the 13.01 protections: round-trip guard (an OS
// suspension hides inside a slow sample) and NTP-style midpoint anchoring.
var FL_UK_CLOCK_TOL_MS = 90 * 1000;
var FL_UK_CLOCK_OFFSET_KEY = 'fl_uk_clock_offset_ms';
var FL_UK_CLOCK_SYNCED_AT_KEY = 'fl_uk_clock_synced_at_ms';
var flUkClockOffsetMs = 0;
var flUkClockReady = false;
var flUkClockSyncInFlight = null;

(function loadUkClockOffset() {
  try {
    var off = parseInt(localStorage.getItem(FL_UK_CLOCK_OFFSET_KEY) || '', 10);
    var syncedAt = parseInt(localStorage.getItem(FL_UK_CLOCK_SYNCED_AT_KEY) || '', 10);
    if (Number.isFinite(off) && Number.isFinite(syncedAt) && (Date.now() - syncedAt) < (24 * 60 * 60 * 1000)) {
      flUkClockOffsetMs = off;
      flUkClockReady = true;
    }
  } catch (_) {}
})();

function flNow() {
  return new Date(Date.now() + flUkClockOffsetMs);
}

// One JSON time-API sample → offset vs the request midpoint, or null.
async function flClockSampleJson(url) {
  var t0 = Date.now();
  var r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return null;
  var d = await r.json();
  var t1 = Date.now();
  if (t1 - t0 > 8000) return null; // 13.01: a suspension hid inside this sample
  var iso = String((d && (d.utc_datetime || d.datetime || d.dateTime)) || '');
  // timeapi.io returns a bare "2026-08-02T08:00:27.97" with no zone marker.
  // We ask it for UTC, so pin the parse to UTC rather than device-local.
  if (iso && !/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(iso)) iso += 'Z';
  var serverMs = Date.parse(iso);
  if (!Number.isFinite(serverMs)) return null;
  return serverMs - Math.round((t0 + t1) / 2); // 13.01: NTP midpoint
}

// One response-Date-header sample. Any response carries a Date header (even
// a 404), so no r.ok check. Headers are whole-second; +500 ms centres the
// truncation error.
async function flClockSampleDateHeader(url, opts) {
  var t0 = Date.now();
  var r = await fetch(url, opts);
  var t1 = Date.now();
  if (t1 - t0 > 8000) return null; // 13.01
  var h = r && r.headers && r.headers.get ? r.headers.get('date') : '';
  var serverMs = Date.parse(String(h || ''));
  if (!Number.isFinite(serverMs)) return null;
  return serverMs + 500 - Math.round((t0 + t1) / 2);
}

// Race a probe against a 7 s timer (just under the 8 s per-sample guard) so
// one hung endpoint cannot stall the whole consensus. Errors become null.
function flClockProbe(p) {
  var tid = null;
  return Promise.race([
    p.then(function(v) { return v; }, function() { return null; }),
    new Promise(function(res) { tid = setTimeout(function() { res(null); }, 7000); })
  ]).then(function(v) { if (tid !== null) clearTimeout(tid); return v; });
}

async function syncTrustedUkClock() {
  if (flUkClockSyncInFlight) return flUkClockSyncInFlight;
  flUkClockSyncInFlight = (async function() {
    try {
      // All probes launch in parallel. Trust order matters: on a 1-vs-1
      // split the earlier source's cluster wins.
      var probes = [
        flClockProbe(flClockSampleDateHeader('sw.js', { method: 'HEAD', cache: 'no-store' })),
        flClockProbe(flClockSampleDateHeader('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/package.json', { method: 'HEAD', cache: 'no-store' })),
        flClockProbe(flClockSampleJson('https://timeapi.io/api/Time/current/zone?timeZone=UTC')),
        flClockProbe(flClockSampleJson('https://worldtimeapi.org/api/timezone/Etc/UTC'))
      ];
      var samples = [];
      for (var i = 0; i < probes.length; i++) {
        var v = await probes[i];
        if (v !== null && Number.isFinite(v)) samples.push(v);
      }
      if (!samples.length) return !!flUkClockReady;
      // Largest cluster of samples agreeing within the tolerance wins.
      var best = null;
      for (var j = 0; j < samples.length; j++) {
        var anchor = samples[j];
        var mates = samples.filter(function(x) { return Math.abs(x - anchor) <= FL_UK_CLOCK_TOL_MS; });
        if (!best || mates.length > best.length) best = mates;
      }
      var sum = 0;
      for (var k = 0; k < best.length; k++) sum += best[k];
      flUkClockOffsetMs = Math.round(sum / best.length);
      flUkClockReady = true;
      try {
        localStorage.setItem(FL_UK_CLOCK_OFFSET_KEY, String(flUkClockOffsetMs));
        localStorage.setItem(FL_UK_CLOCK_SYNCED_AT_KEY, String(Date.now()));
      } catch (_) {}
      return true;
    } finally {
      flUkClockSyncInFlight = null;
    }
  })();
  return flUkClockSyncInFlight;
}

// ── 11: Persist/restore user state ───────────────────────────
ui.saveState = function() {
  try {
    var s = { tab: window._activeTab || 'species' };
    if (bannerState.lat !== null) {
      s.lat  = bannerState.lat;
      s.lng  = bannerState.lng;
      s.name = bannerState.locationName;
    }
    localStorage.setItem('fl_state', JSON.stringify(s));
  } catch(e) {}
};

ui.loadState = function() {
  try {
    var raw = localStorage.getItem('fl_state');
    if (!raw) return null;
    var s = JSON.parse(raw);
    // Validate saved state has required fields
    if (!s || typeof s.lat !== 'number' || typeof s.lng !== 'number') {
      localStorage.removeItem('fl_state');
      return null;
    }
    return s;
  } catch(e) { return null; }
};

// ── Field mode (dim UI for low light) ─────────────────────────
var FL_FIELD_MODE_KEY = 'fl_field_mode';

function isFieldModeOn() {
  return document.documentElement.getAttribute('data-field-mode') === 'on';
}

function applyFieldMode(on) {
  if (on) {
    document.documentElement.setAttribute('data-field-mode', 'on');
  } else {
    document.documentElement.removeAttribute('data-field-mode');
  }
  try {
    localStorage.setItem(FL_FIELD_MODE_KEY, on ? '1' : '0');
  } catch (e) { /* ignore */ }
  var btn = document.getElementById('field-mode-btn');
  if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  var slimFm = document.getElementById('fl-slim-fieldmode');
  if (slimFm) slimFm.setAttribute('aria-pressed', on ? 'true' : 'false');
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', on ? '#0a0f0a' : '#1a2e1a');
}

function initFieldMode() {
  var btn = document.getElementById('field-mode-btn');
  if (!btn) return;
  var on = false;
  try {
    on = localStorage.getItem(FL_FIELD_MODE_KEY) === '1';
  } catch (e) { /* ignore */ }
  applyFieldMode(on);
  btn.addEventListener('click', function() {
    applyFieldMode(!isFieldModeOn());
  });
}

// ── 8: Offline indicator ─────────────────────────────────────
ui.updateOfflineBanner = function() {
  var el = document.getElementById('offline-banner');
  if (!el) return;
  el.style.display = navigator.onLine ? 'none' : 'block';
};

ui.ensurePwaStatusChip = function() {
  // The header PWA status chip was removed from the homepage — a live online/
  // offline readout belongs inside the Cull Diary (where offline queueing
  // matters), not on the marketing header. No-op keeps updatePwaStatus() safe.
  return;
};

ui.updatePwaStatus = function() {
  ui.ensurePwaStatusChip();
  var txt = document.getElementById('pwa-status-text');
  var dot = document.getElementById('pwa-status-dot');
  if (!txt || !dot) return;
  if (!navigator.onLine) {
    txt.textContent = 'Offline mode';
    dot.style.background = '#f0c870';
    return;
  }
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    txt.textContent = 'Online · offline-ready';
    dot.style.background = '#7adf7a';
  } else {
    txt.textContent = 'Online';
    dot.style.background = '#7adf7a';
  }
};
window.addEventListener('online',  ui.updateOfflineBanner);
window.addEventListener('offline', ui.updateOfflineBanner);
window.addEventListener('online',  ui.updatePwaStatus);
window.addEventListener('offline', ui.updatePwaStatus);
window.addEventListener('online', function() {
  syncTrustedUkClock().then(function(ok) {
    if (ok && bannerState.lat !== null) {
      computeBannerState(bannerState.lat, bannerState.lng, bannerState.locationName);
      renderBanner();
    }
  });
});

// Improve keyboard accessibility for click-only elements that use inline onclick.
function enhanceKeyboardClickables(root) {
  var scope = root || document;
  var nodes = scope.querySelectorAll('[onclick]');
  nodes.forEach(function(el) {
    var tag = (el.tagName || '').toLowerCase();
    var nativeInteractive = /^(button|a|input|select|textarea|summary)$/.test(tag);
    if (nativeInteractive) return;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    if (el.dataset.kbBound === '1') return;
    el.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });
    el.dataset.kbBound = '1';
  });
}

// ── Native PWA install (beforeinstallprompt) ──────────────────
// Chromium (Android Chrome/Edge, desktop Chrome/Edge) fires this when the app
// is installable; we stash the event so the Install button can open the real
// OS install dialog in one tap. iOS Safari never fires it — those users fall
// back to the manual "Add to Home Screen" card (see scroll-to-install below).
var flDeferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();             // suppress Chrome's own mini-infobar; we drive it
  flDeferredInstallPrompt = e;    // reused on the Install tap (needs a user gesture)
});
window.addEventListener('appinstalled', function() {
  flDeferredInstallPrompt = null;
  var ib = document.getElementById('install-btn');
  if (ib) ib.style.display = 'none';   // installed — nothing left to prompt
});
// Fires the stored native prompt. Returns false when there's nothing to fire
// (iOS / already installed / unsupported) so the caller can fall back.
function flTriggerInstall() {
  var dp = flDeferredInstallPrompt;
  if (!dp) return false;
  flDeferredInstallPrompt = null;  // a captured prompt can only be used once
  try {
    dp.prompt();                   // synchronous within the click gesture
    if (dp.userChoice && typeof dp.userChoice.then === 'function') {
      dp.userChoice.catch(function() {});   // swallow — outcome not needed
    }
  } catch (err) { /* already consumed / not allowed — ignore */ }
  return true;
}

// ── Returning/installed home: hoist the "legal now" banner to the top ─────────
// Cold visitors keep the full marketing header (it explains what First Light is).
// Once someone installs the app or sets a location, they open First Light to answer
// one question at 04:30 — "can I shoot right now?" — so the tall header collapses to
// a slim bar and the legal banner leads. The original .app-header is hidden (not
// removed), so its existing wiring stays intact.
function flCloseHeaderMenu() {
  var menu = document.getElementById('fl-hdr-menu');
  var btn = document.getElementById('fl-hdr-menu-btn');
  if (menu) menu.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
function flToggleHeaderMenu() {
  var menu = document.getElementById('fl-hdr-menu');
  var btn = document.getElementById('fl-hdr-menu-btn');
  if (!menu || !btn) return;
  var open = !menu.classList.contains('open');
  menu.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function flHoistHeader() {
  // Gate: installed PWA, or a returning user who already set a location.
  var installed = document.documentElement.classList.contains('fl-standalone');
  var returning = typeof ui !== 'undefined' && ui.loadState && ui.loadState() != null;
  if (!installed && !returning) return;

  var legal = document.getElementById('legal-banner');
  if (!legal || !legal.parentNode) return;
  if (document.querySelector('.fl-slim-hdr')) return;   // already hoisted

  var moon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="rgba(240,204,116,0.10)"/></svg>';
  var diary = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="2" width="13" height="20" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><line x1="4" y1="2" x2="4" y2="22" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/><line x1="8" y1="7" x2="14" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.7"/><line x1="8" y1="10" x2="14" y2="10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.7"/><line x1="8" y1="13" x2="11" y2="13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.7"/></svg>';
  var calc = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/><line x1="12" y1="2" x2="12" y2="5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="12" y1="18.5" x2="12" y2="22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="2" y1="12" x2="5.5" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="18.5" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>';
  var dots = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1.7" fill="currentColor"/><circle cx="10" cy="10" r="1.7" fill="currentColor"/><circle cx="16" cy="10" r="1.7" fill="currentColor"/></svg>';

  var bar = document.createElement('div');
  bar.className = 'fl-slim-hdr';
  bar.setAttribute('role', 'banner');
  bar.innerHTML =
    '<div class="fl-slim-brand">' +
      '<img src="icon-180.png" width="30" height="30" alt="">' +
      '<span>First Light</span>' +
    '</div>' +
    '<div class="fl-slim-tools">' +
      '<button type="button" id="fl-slim-fieldmode" class="fl-slim-ic" data-fl-action="toggle-field-mode" aria-pressed="false" aria-label="Field mode — dim UI for low light" title="Field mode">' + moon + '</button>' +
      '<a class="fl-slim-ic" href="diary.html" aria-label="Cull Diary">' + diary + '</a>' +
      '<a class="fl-slim-ic" href="ballistics.html" aria-label="Ballistic Calculator">' + calc + '</a>' +
      '<span class="fl-hdr-menu-wrap">' +
        '<button type="button" id="fl-hdr-menu-btn" class="fl-slim-ic" data-fl-action="toggle-header-menu" aria-haspopup="true" aria-expanded="false" aria-controls="fl-hdr-menu" aria-label="More options">' + dots + '</button>' +
        '<div id="fl-hdr-menu" class="fl-hdr-menu" role="menu" aria-label="More options">' +
          '<a class="fl-hdr-menu-item" role="menuitem" href="deerschool.html"><span class="fl-mi-ic" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 6.5C9.7 5.4 6.8 5.4 4.5 6.4V18.2C6.8 17.2 9.7 17.2 12 18.3V6.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 6.5C14.3 5.4 17.2 5.4 19.5 6.4V18.2C17.2 17.2 14.3 17.2 12 18.3V6.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></span>Deer School</a>' +
          '<button type="button" class="fl-hdr-menu-item" role="menuitem" data-fl-action="open-changelog"><span class="fl-mi-star" aria-hidden="true">✦</span>What’s new</button>' +
          '<a class="fl-hdr-menu-item" role="menuitem" href="mailto:firstlightdeer@gmail.com?subject=First%20Light%20feedback"><span class="fl-mi-ic" aria-hidden="true"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="3" y="5.5" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M4 7.5l8 5.5 8-5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Send feedback</a>' +
          '<button type="button" class="fl-hdr-menu-item fl-mi-install" role="menuitem" data-fl-action="scroll-to-install"><span class="fl-ic fl-install" aria-hidden="true"></span>Install app</button>' +
        '</div>' +
      '</span>' +
    '</div>';

  legal.parentNode.insertBefore(bar, legal);
  document.documentElement.classList.add('fl-hoist');

  var slimBtn = document.getElementById('fl-slim-fieldmode');
  if (slimBtn) slimBtn.setAttribute('aria-pressed', isFieldModeOn() ? 'true' : 'false');

  // Close the ⋯ menu on outside-click and Escape (the toggle button handles itself).
  document.addEventListener('click', function(e) {
    var menu = document.getElementById('fl-hdr-menu');
    if (!menu || !menu.classList.contains('open')) return;
    if (e.target.closest('[data-fl-action="toggle-header-menu"]')) return;
    flCloseHeaderMenu();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') flCloseHeaderMenu();
  });
}

function initIndexFlActions() {
  document.body.addEventListener('click', function(e) {
    var el = e.target.closest('[data-fl-action]');
    if (!el) return;
    var act = el.getAttribute('data-fl-action');
    switch (act) {
      case 'open-changelog':
        var cm = document.getElementById('changelog-modal');
        if (cm) cm.style.display = 'flex';
        break;
      case 'scroll-to-install': {
        // Chromium (Android/desktop): open the native one-tap install dialog.
        // iOS Safari / unsupported browsers: fall through to the A2HS card.
        if (flTriggerInstall()) break;
        // Card lives under Field Guide (`#tab-shots`); that panel is display:none until active,
        // so scrollIntoView does nothing in Chrome/Edge until we switch tabs first.
        if (typeof switchMainTab === 'function') {
          switchMainTab('shots');
        }
        var ins = document.getElementById('install-instructions');
        if (ins) {
          var reduceMotion = typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          var runScroll = function() {
            ins.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
            ins.classList.add('install-pulse');
            setTimeout(function() { ins.classList.remove('install-pulse'); }, 1600);
          };
          requestAnimationFrame(function() {
            requestAnimationFrame(runScroll);
          });
        }
        break;
      }
      case 'close-changelog':
        var cmClose = document.getElementById('changelog-modal');
        if (cmClose) cmClose.style.display = 'none';
        break;
      case 'open-species-picker': openSpeciesPicker(); break;
      case 'close-species-picker': closeSpeciesPicker(); break;
      case 'save-species-picker': saveSpeciesPicker(); break;
      case 'dismiss-species-nudge': flDismissSpeciesNudge(); break;
      case 'banner-status-open-location':
        if (typeof bannerState !== 'undefined' && bannerState.lat === null) ui.openLocationPicker();
        break;
      case 'open-location-picker':
        ui.openLocationPicker();
        break;
      case 'open-lightbox':
        openLightbox(el.getAttribute('data-lb-key'), parseInt(el.getAttribute('data-lb-idx'), 10));
        break;
      case 'close-lightbox':
        closeLightbox();
        break;
      case 'lightbox-prev':
        lightboxNav(-1);
        break;
      case 'lightbox-next':
        lightboxNav(1);
        break;
      case 'toggle-field-mode':
        applyFieldMode(!isFieldModeOn());
        break;
      case 'toggle-header-menu':
        flToggleHeaderMenu();
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  document.body.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var el = e.target.closest('[data-fl-action]');
    if (!el) return;
    if (el.matches('button,a,input,textarea,select')) return;
    e.preventDefault();
    el.click();
  });

  flRenderSpeciesChip(); // reflect the saved species on the chip at load
}

// Clock (top-right)

function setStatus(elId, open) {
  var el = document.getElementById(elId);
  if (!el) return;
  el.textContent = '';
  el.className   = 'season-status ' + (open ? 'status-open' : 'status-closed');
}

// -- Statutory season source ------------------------------------------------
// lib/fl-deer-seasons.js holds every UK close season once. This page used to
// hold the same dates in three places - a day-exact literal per status row, a
// month list per species card, and an England-only pair per card badge - and
// they disagreed. On 5 October the Scottish hind card read OPEN because
// October is in its month list while the status row three inches above it read
// Closed because the season does not start until the 21st. Everything below
// now derives from the module, so there is one answer per animal per day.
//
// The module is ESM and this file is a classic script, so index.html bridges
// it onto the global before app.js boots.
var FL_REGION_JURISDICTION = { ew: 'england-wales', sc: 'scotland', ni: 'northern-ireland' };

function flSeasons() {
  var S = window.FL_DEER_SEASONS;
  return (S && typeof S.isOpenOn === 'function') ? S : null;
}

/** Date each statutory data set was last read at primary source, stamped at the
 *  foot of the tab that states it. Every law-reference publisher this app sits
 *  beside dates its pages; an app that encodes the same statutes and shows no
 *  date is asking to be trusted further than it has earned. Injected from the
 *  modules rather than typed into the markup, so a shown date cannot drift from
 *  the data it describes. Idempotent — boot and fl-deer-seasons-ready both call
 *  it, and the second call rewrites the same node instead of adding another. */
function flStampDataCurrency() {
  var L = window.FL_DEER_LAW, S = window.FL_DEER_SEASONS;
  var fmt = (L && typeof L.verifiedOnLabel === 'function') ? L.verifiedOnLabel : null;
  if (!fmt) return;   // bridge absent: no date is better than a wrong one
  var rows = [
    ['tab-times', 'fl-currency-times', fmt(L.LAW_VERIFIED_ON),
     'Firearms minima and legal-hours rules on this tab were last read at primary source on '],
    ['tab-calendar', 'fl-currency-calendar', S ? fmt(S.SEASONS_VERIFIED_ON) : '',
     'Every season date on this tab was last read at primary source on ']
  ];
  for (var i = 0; i < rows.length; i++) {
    var panel = document.getElementById(rows[i][0]);
    if (!panel || !rows[i][2]) continue;
    var el = document.getElementById(rows[i][1]);
    if (!el) {
      el = document.createElement('div');
      el.id = rows[i][1];
      el.style.cssText = 'font-size:var(--fs-micro);color:rgba(255,255,255,0.45);'
        + 'text-align:center;line-height:1.55;margin-top:18px;padding-top:12px;'
        + 'border-top:1px solid rgba(255,255,255,0.08);';
      panel.appendChild(el);
    }
    el.textContent = rows[i][3] + rows[i][2]
      + '. Statute changes; check the current text before relying on a borderline call.';
  }
}

/** Twelve-cell strip: which months contain at least one open day. */
/**
 * B9: the human-readable window under a calendar card's name — "1 Aug –
 * 30 Apr", "No close season" — derived from lib/fl-deer-seasons.js rather
 * than read off the markup.
 *
 * The two agree today; I checked all 26 cards across the three jurisdictions
 * before changing this and found no drift. That is the point. The open-month
 * BARS have been derived since flOpenMonthsForCard landed, so a correction to
 * the statutory data already repaints the bars — and would have left the
 * sentence beneath them saying the old dates, in a hand-typed attribute
 * nobody would think to grep. A card whose bars and words disagree is worse
 * than one that is merely out of date, because it looks authoritative twice.
 *
 * data-dates stays in the markup as the fallback, for the same reason
 * data-open does: if the module fails to load the card degrades to the last
 * known-good text instead of going blank.
 */
function flSeasonLabelForCard(card, jurisdiction) {
  var S = flSeasons();
  var key = card.dataset.venisonKey;
  if (S && typeof S.seasonLabel === 'function' && jurisdiction && key && S.isSeasonKey(key)) {
    var derived = S.seasonLabel(jurisdiction, key);
    if (derived && derived !== 'Unknown') return derived;
  }
  return card.dataset.dates || '';
}

function flOpenMonthsForCard(card, jurisdiction) {
  var S = flSeasons();
  var key = card.dataset.venisonKey;
  if (S && jurisdiction && key && S.isSeasonKey(key)) {
    var derived = S.openMonthsFor(jurisdiction, key);
    if (derived.length) return derived;
  }
  // The markup still carries data-open, so a module that failed to load
  // degrades to the old month-granular reading rather than a blank calendar.
  return (card.dataset.open || '').split(',').map(Number)
    .filter(function(n) { return n >= 1 && n <= 12; });
}

/**
 * The soonest season start among a region's cards, and who it belongs to.
 * Returns null when the module is absent or the region has no dated windows —
 * Scotland's males have no start date to give, and NI lists no muntjac at all.
 */
function flNextOpening(selector, jurisdiction, curMonth, curDay) {
  var S = flSeasons();
  if (!S || !jurisdiction) return null;
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var best = null, names = [], label = '';
  document.querySelectorAll(selector).forEach(function(card) {
    var key = card.dataset.venisonKey;
    if (!key || !S.isSeasonKey(key)) return;
    var rec = S.seasonFor(jurisdiction, key);
    if (!rec || rec.status !== 'window') return;
    // Month-major ordinal: months are 31 apart and days never span that, so
    // this orders any two (month, day) pairs correctly without a Date.
    var delta = (rec.startMonth - curMonth) * 31 + (rec.startDay - curDay);
    if (delta <= 0) delta += 372;   // already begun this year, so next year's
    if (best === null || delta < best) {
      best = delta;
      names = [];
      label = rec.startDay + ' ' + MON[rec.startMonth - 1];
    }
    if (delta === best) {
      var sexLabel = {stag:'Stag',hind:'Hind',buck:'Buck',doe:'Doe'}[card.dataset.sex] || '';
      var nm = card.dataset.name;
      if (sexLabel && !nm.endsWith(sexLabel)) nm += ' ' + sexLabel;
      if (names.indexOf(nm) === -1) names.push(nm);
    }
  });
  return names.length ? { names: names, label: label } : null;
}

/** The OPEN/CLOSED verdict on the card, day-exact where the module can say. */
function flCardOpenNow(card, jurisdiction, curMonth, curDay, openMonths) {
  var S = flSeasons();
  var key = card.dataset.venisonKey;
  if (S && jurisdiction && key && S.isSeasonKey(key)) {
    var exact = S.isOpenOn(jurisdiction, key, curMonth, curDay);
    if (exact !== null) return exact;
  }
  return openMonths.indexOf(curMonth) !== -1;
}

// ── Solar calculation ─────────────────────────────────────────
// Uses the Europe/London calendar date for `date` (not the device’s local date). Day-of-year + UTC anchor
// match that civil day so BST/GMT and “today” agree with ukNowMin() / banner copy.
function calcSunTime(date, lat, lng, isSunrise) {
  var ymd = ukCalendarYmdLondon(date);
  var y = ymd.y, mo = ymd.m, d = ymd.d;
  if (y == null || mo == null || d == null || isNaN(y)) return null;

  var rad = Math.PI / 180;
  var lngHour = lng / 15;
  var jan1 = Date.UTC(y, 0, 1);
  var cur = Date.UTC(y, mo - 1, d);
  var dayOfYear = Math.round((cur - jan1) / 86400000) + 1;

  var t = isSunrise ? dayOfYear + (6  - lngHour) / 24
                    : dayOfYear + (18 - lngHour) / 24;
  var M = (0.9856 * t) - 3.289;
  var L = M + (1.916 * Math.sin(M * rad)) + (0.020 * Math.sin(2 * M * rad)) + 282.634;
  L = ((L % 360) + 360) % 360;
  var RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
  RA = ((RA % 360) + 360) % 360;
  var Lquad  = Math.floor(L  / 90) * 90;
  var RAquad = Math.floor(RA / 90) * 90;
  RA = (RA + Lquad - RAquad) / 15;
  var sinDec = 0.39782 * Math.sin(L * rad);
  var cosDec = Math.cos(Math.asin(sinDec));
  var cosH   = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return null;
  var H = isSunrise ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad;
  H /= 15;
  var T = H + RA - (0.06571 * t) - 6.622;
  var UT = ((T - lngHour) % 24 + 24) % 24;
  // UT ≈ hours from UTC midnight on this Gregorian y-mo-d; display still via ukHourMin → Europe/London
  var utcMs = Date.UTC(y, mo - 1, d) + UT * 3600000;
  return new Date(utcMs);
}

// ── 2: Midnight-safe window helper ───────────────────────────
function inWindow(cur, start, end) {
  // All values in minutes-since-midnight (0–1439)
  // Handles windows that cross midnight (end < start)
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;           // crosses midnight
}

// Cached Intl formatters (2026-07-17 perf round — SPEC pair with
// lib/fl-forecast.mjs): construction is ~70× the cost of formatToParts on a
// cached instance, and these helpers sit under every solar/legal-time call.
var _ukYmdFmt = null;
var _ukHmFmt = null;

// Always extract hours/minutes in Europe/London time, regardless of device timezone
// This ensures all sunrise/sunset/legal times display correctly for users outside the UK
function ukHourMin(dateObj) {
  if (!_ukHmFmt) {
    _ukHmFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
  }
  var parts = _ukHmFmt.formatToParts(dateObj);
  return {
    h: parseInt(parts.find(function(p) { return p.type === 'hour';   }).value, 10),
    m: parseInt(parts.find(function(p) { return p.type === 'minute'; }).value, 10)
  };
}

function toMinutes(dateObj) {
  var hm = ukHourMin(dateObj);
  return hm.h * 60 + hm.m;
}

/** Calendar Y/M/D (month 1–12) for an instant in Europe/London — single source for “which day” solar + legal calcs use. */
function ukCalendarYmdLondon(date) {
  if (!_ukYmdFmt) {
    _ukYmdFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
  }
  var parts = _ukYmdFmt.formatToParts(date);
  var y, m, d;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].type === 'year') y = parseInt(parts[i].value, 10);
    else if (parts[i].type === 'month') m = parseInt(parts[i].value, 10);
    else if (parts[i].type === 'day') d = parseInt(parts[i].value, 10);
  }
  return { y: y, m: m, d: d };
}

function ymdAddCalendarDays(y, m, d, delta) {
  var ms = Date.UTC(y, m - 1, d + delta);
  var dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Find the JS Date for a given wall time on a London calendar day (stable anchor for “tomorrow” solar). */
function londonWallClockToDate(y, mo, d, hh, mm) {
  var lo = Date.UTC(y, mo - 1, d - 1);
  var hi = Date.UTC(y, mo - 1, d + 2);
  for (var ms = lo; ms <= hi; ms += 60000) {
    var p = ukCalendarYmdLondon(new Date(ms));
    var hm = ukHourMin(new Date(ms));
    if (p.y === y && p.m === mo && p.d === d && hm.h === hh && hm.m === mm) return new Date(ms);
  }
  return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
}

// UK current time in minutes-since-midnight
function ukNowMin() {
  var hm = ukHourMin(flNow());
  return hm.h * 60 + hm.m;
}

/** Seconds since midnight in Europe/London (matches ukNowMin; use for countdown + timeline, not local getSeconds()). */
function ukNowTotalSecFromMidnight() {
  var parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(flNow());
  var h = 0, mi = 0, s = 0;
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.type === 'hour') h = parseInt(p.value, 10);
    else if (p.type === 'minute') mi = parseInt(p.value, 10);
    else if (p.type === 'second') s = parseInt(p.value, 10);
  }
  return h * 3600 + mi * 60 + s;
}

// UK current hour (for weather API array indexing — API uses timezone=auto=Europe/London)
function ukNowHour() {
  return ukHourMin(flNow()).h;
}

function fmtTime(h, m) {
  return h.toString().padStart(2,'0') + ':' + m.toString().padStart(2,'0');
}

function fmtMinutes(totalMin) {
  var m = ((totalMin % 1440) + 1440) % 1440;
  return fmtTime(Math.floor(m / 60), m % 60);
}

function addMins(dateObj, mins) {
  return new Date(dateObj.getTime() + mins * 60000);
}

/** YYYY-MM-DD for "today" in Europe/London (for legal date picker bounds). */
function ukTodayYmdLondon() {
  var parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(flNow());
  var y = '', m = '', d = '';
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
  }
  if (y && m && d) return y + '-' + m + '-' + d;
  return flNow().toISOString().slice(0, 10);
}

var _legalPickerBoundsDay = '';

/** Set min/max once per UK calendar day; only normalise value when out of range (not on every input tick). */
function syncLegalDatePickerBounds() {
  var el = document.getElementById('legal-date-picker');
  if (!el) return;
  var ukToday = ukTodayYmdLondon();
  if (_legalPickerBoundsDay === ukToday && el.getAttribute('min')) return;
  _legalPickerBoundsDay = ukToday;
  var minD = addCalendarDaysToYmd(ukToday, 1);
  var maxD = addCalendarDaysToYmd(ukToday, 730);
  el.min = minD;
  el.max = maxD;
  if (!el.value || el.value < minD || el.value > maxD) el.value = minD;
}

/** Add signed whole days to a YYYY-MM-DD string (UTC calendar math). */
function addCalendarDaysToYmd(ymd, delta) {
  var p = ymd.split('-');
  if (p.length !== 3) return ymd;
  var t = Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10) + delta);
  var x = new Date(t);
  return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') + '-' + String(x.getUTCDate()).padStart(2, '0');
}

function formatLegalWindowDurationHours(lsDate, leDate) {
  if (!lsDate || !leDate) return '—';
  var mins = Math.round((leDate.getTime() - lsDate.getTime()) / 60000);
  if (mins < 0) mins += 1440;
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  return h + 'h' + (m > 0 ? ' ' + m + 'm' : '');
}

function refreshLegalDatePicker() {
  var pick = document.getElementById('legal-date-picker');
  var noLoc = document.getElementById('legal-picker-no-location');
  var noSun = document.getElementById('legal-picker-no-sun');
  var res = document.getElementById('legal-picker-results');
  if (!pick) return;

  syncLegalDatePickerBounds();

  var bs = bannerState;
  if (bs.lat === null || bs.lng === null) {
    if (noLoc) noLoc.style.display = 'block';
    if (noSun) { noSun.style.display = 'none'; noSun.textContent = ''; }
    if (res) res.style.display = 'none';
    return;
  }
  if (noLoc) noLoc.style.display = 'none';

  var v = pick.value;
  if (!v) {
    if (noSun) { noSun.style.display = 'none'; noSun.textContent = ''; }
    if (res) res.style.display = 'none';
    return;
  }
  if (v < pick.min) {
    v = pick.min;
    pick.value = v;
  }
  if (v > pick.max) {
    v = pick.max;
    pick.value = v;
  }

  var parts = v.split('-');
  var y = parseInt(parts[0], 10), mo = parseInt(parts[1], 10), day = parseInt(parts[2], 10);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(day)) return;

  var d = new Date(y, mo - 1, day);
  var sr, ss;
  try { sr = calcSunTime(d, bs.lat, bs.lng, true); } catch (e) { sr = null; }
  try { ss = calcSunTime(d, bs.lat, bs.lng, false); } catch (e) { ss = null; }

  if (!sr || !ss) {
    if (noSun) {
      noSun.style.display = 'block';
      noSun.textContent = 'Sunrise or sunset cannot be calculated for this location on that date (e.g. far north in midsummer or midwinter). Try another date or location.';
    }
    if (res) res.style.display = 'none';
    return;
  }
  if (noSun) { noSun.style.display = 'none'; noSun.textContent = ''; }

  var legalStart = addMins(sr, -60);
  var legalEnd = addMins(ss, 60);

  var elSr = document.getElementById('legal-pick-sunrise');
  var elSs = document.getElementById('legal-pick-sunset');
  var elLs = document.getElementById('legal-pick-legal-start');
  var elLe = document.getElementById('legal-pick-legal-end');
  var elWd = document.getElementById('legal-pick-window');
  if (elSr) elSr.textContent = fmtMinutes(toMinutes(sr));
  if (elSs) elSs.textContent = fmtMinutes(toMinutes(ss));
  if (elLs) elLs.textContent = fmtMinutes(toMinutes(legalStart));
  if (elLe) elLe.textContent = fmtMinutes(toMinutes(legalEnd));
  if (elWd) elWd.textContent = formatLegalWindowDurationHours(legalStart, legalEnd);

  if (res) res.style.display = 'block';
}

/** Open native date picker — icon taps don’t focus the date input on many browsers. */
function openLegalDatePickerUI() {
  var el = document.getElementById('legal-date-picker');
  if (!el) return;
  var ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
  // Chromium Edge often exposes showPicker() but it no-ops for type=date; we’d return early and never click().
  var isEdge = /Edg\//.test(ua);
  el.focus();
  if (!isEdge) {
    try {
      if (typeof el.showPicker === 'function') {
        el.showPicker();
        return;
      }
    } catch (e) { /* not allowed or unsupported */ }
  }
  try {
    el.click();
  } catch (e2) { /* ignore */ }
}

function initLegalDatePickerUi() {
  var ldp = document.getElementById('legal-date-picker');
  var openBtn = document.getElementById('legal-date-open-btn');
  var row = document.querySelector('#legal-picker-section .legal-picker-input-row');
  if (!ldp) return;
  if (openBtn) {
    openBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      openLegalDatePickerUI();
    });
  }
  if (row) {
    row.addEventListener('click', function(e) {
      if (e.target === ldp) return;
      if (openBtn && (e.target === openBtn || openBtn.contains(e.target))) return;
      openLegalDatePickerUI();
    });
  }
}

// ── UK place labels: Nominatim often returns admin names like "Metropolitan Borough of Solihull"
function normalizeUkPlaceName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  var s = raw.trim();
  s = s.replace(
    /^(Metropolitan Borough of |London Borough of |Royal Borough of |Borough of |City of |County of |District of |Unitary Authority of )/i,
    ''
  );
  return s.trim();
}

/**
 * True when Nominatim's `town`/`city` looks like a merged UK council or wide district name,
 * not a single settlement — then we prefer a smaller `village` / `hamlet` in the same address.
 */
function looksLikeUkMergedAdminPlaceName(s) {
  if (!s || typeof s !== 'string') return false;
  var t = s.trim();
  if (t.length >= 42) return true;
  if (/\b(and|&)\b/i.test(t) && t.length >= 16) return true;
  if (/Metropolitan Borough|Unitary Authority|Borough of|District of|County of/i.test(t)) return true;
  return false;
}

/** Nominatim reverse: `addresstype` values we treat as a named settlement / locality label. */
var NOMINATIM_PLACE_ADDRTYPES = {
  village: true, hamlet: true, town: true, city: true, suburb: true,
  neighbourhood: true, locality: true, municipality: true, quarter: true, city_district: true
};

/**
 * Short label from a Nominatim reverse result. Call with `format=jsonv2` and `zoom=15` (settlement
 * level per Nominatim docs) so the matched feature is the nearest suitable place, not default
 * zoom 18 road/building — otherwise `address.village` can be a wider parish while the road is primary.
 * Prefer `address[addresstype]` when addresstype is place-like; if that value is a merged district,
 * prefer village/hamlet when present (e.g. West Acre vs King's Lynn and West Norfolk).
 */
function labelFromNominatimReverse(data) {
  data = data || {};
  var addr = data.address || {};
  var at = data.addresstype;
  var displayFirst = (data.display_name || '').split(',')[0].trim();

  if (at && NOMINATIM_PLACE_ADDRTYPES[at]) {
    var raw = addr[at] || data.name;
    if (raw && typeof raw === 'string') {
      if (looksLikeUkMergedAdminPlaceName(raw)) {
        var alt = addr.village || addr.hamlet || addr.suburb || addr.neighbourhood;
        if (alt && String(alt).trim() !== String(raw).trim()) {
          return normalizeUkPlaceName(alt) || alt;
        }
      }
      return normalizeUkPlaceName(raw) || raw;
    }
  }

  if ((at === 'city' || at === 'town') && (addr.village || addr.hamlet)) {
    var bulk = addr[at];
    if (bulk && looksLikeUkMergedAdminPlaceName(bulk)) {
      return normalizeUkPlaceName(addr.village || addr.hamlet) || (addr.village || addr.hamlet);
    }
  }

  var fb = primaryPlaceFromAddress(addr, displayFirst);
  return normalizeUkPlaceName(fb) || fb || '';
}

function primaryPlaceFromAddress(a, displayNameFirstPart) {
  a = a || {};
  var nb =
    a.neighbourhood ||
    a.suburb ||
    a.locality ||
    '';
  if (nb) return nb;

  var townish = a.town || a.city || a.municipality || '';
  var vill = a.village || a.hamlet || '';
  var iso = a.isolated_dwelling || '';

  if (townish && vill && looksLikeUkMergedAdminPlaceName(townish)) {
    return vill || iso || townish;
  }
  if (townish) return townish;
  if (vill) return vill;
  if (iso) return iso;
  return (displayNameFirstPart || '').trim();
}

/** Short banner/search label from Nominatim `address` (+ optional first display_name segment). */
function formatUkLocationLabel(addr, displayNameFirstPart) {
  var a = addr || {};
  var rawPrimary = primaryPlaceFromAddress(a, displayNameFirstPart);
  var primary = normalizeUkPlaceName(rawPrimary);
  var county = normalizeUkPlaceName(a.county || a.state_district || '');
  var parts = [];
  if (primary) parts.push(primary);
  if (county) parts.push(county);
  return parts.join(', ') || normalizeUkPlaceName(displayNameFirstPart) || 'Your Location';
}

// ── 4 + 12: Update centralised bannerState ────────────────────
function computeBannerState(lat, lng, locationName) {
  if (!flUkClockReady) return false;
  var now       = flNow();
  var sunrise   = calcSunTime(now, lat, lng, true);
  var sunset    = calcSunTime(now, lat, lng, false);
  if (!sunrise || !sunset) return false;

  var legalStart = addMins(sunrise, -60);
  var legalEnd   = addMins(sunset,   60);

  var lsMin = toMinutes(legalStart);
  var leMin = toMinutes(legalEnd);
  var srMin = toMinutes(sunrise);
  var ssMin = toMinutes(sunset);
  var curMin = ukNowMin();

  var isLegal    = inWindow(curMin, lsMin, leMin);
  // Theme rule: morning legal hour uses day styling; only last legal hour (after sunset) is twilight.
  var isTwilight = isLegal && inWindow(curMin, ssMin, leMin);

  // Next legal start: tomorrow (London calendar), not device-local midnight + 24h
  var ymd = ukCalendarYmdLondon(now);
  var tmr = ymdAddCalendarDays(ymd.y, ymd.m, ymd.d, 1);
  var tomorrowAnchor = londonWallClockToDate(tmr.y, tmr.m, tmr.d, 12, 0);
  var srTom = calcSunTime(tomorrowAnchor, lat, lng, true);
  var nextLegalStartMin = srTom ? toMinutes(addMins(srTom, -60)) : lsMin;
  var legalStartTom = srTom ? addMins(srTom, -60) : null; // absolute instant of tomorrow's legal start
  // Express tomorrow's minutes as >1440 for countdown arithmetic when needed
  var nextLsAbsolute = (inWindow(curMin, lsMin, leMin) || curMin < lsMin)
    ? lsMin
    : nextLegalStartMin + 1440;  // next calendar day
  // Absolute Date of the next legal start — used for a DST-correct countdown
  // (wall-clock "+1440" arithmetic gains/loses an hour across the two DST nights).
  var nextLegalStartDate = (inWindow(curMin, lsMin, leMin) || curMin < lsMin) ? legalStart : legalStartTom;

  // Store
  bannerState.sunriseMin      = srMin;
  bannerState.sunsetMin       = ssMin;
  bannerState.legalStartMin   = lsMin;
  bannerState.legalEndMin     = leMin;
  bannerState.isLegal         = isLegal;
  bannerState.isTwilight      = isTwilight;
  bannerState.nextLegalStartMin = nextLsAbsolute;
  bannerState._nextLegalStartDate = nextLegalStartDate;
  bannerState.lat             = lat;
  bannerState.lng             = lng;
  bannerState.locationName    = locationName;
  bannerState._sunrise        = sunrise;
  bannerState._sunset         = sunset;
  bannerState._legalStart     = legalStart;
  bannerState._legalEnd       = legalEnd;

  return true;
}

// ── 6: Per-minute recalculation ───────────────────────────────
var _lastSolarMinute = -1;
var _lastDateStr = '';

function maybeRecalcSolar() {
  if (!flUkClockReady) return;
  var nowMin = ukNowMin();
  if (nowMin === _lastSolarMinute) return;
  _lastSolarMinute = nowMin;

  // Check if date has changed (midnight rollover in Europe/London)
  var now = flNow();
  var todayStr = ukTodayYmdLondon();
  if (_lastDateStr && todayStr !== _lastDateStr) {
    // Date changed — refresh date display, seasons, calendar
    var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var bday   = document.getElementById('banner-date-day');
    var bnum   = document.getElementById('banner-date-num');
    var bmonth = document.getElementById('banner-date-month');
    var byear  = document.getElementById('banner-date-year');
    if (bday)   bday.textContent   = dayNames[now.getDay()];
    if (bnum)   bnum.textContent   = now.getDate();
    if (bmonth) bmonth.textContent = monthNames[now.getMonth()];
    if (byear)  byear.textContent  = now.getFullYear();
    updateSeasonStatuses();
    highlightTodayMonth();
    initCalendar();
  }
  _lastDateStr = todayStr;

  if (bannerState.lat !== null) {
    computeBannerState(bannerState.lat, bannerState.lng, bannerState.locationName);
    renderBanner();
    updateForecastIfVisible();
  }
}

// ── Legal window → timeline position (minutes 0–1440, can be fractional) ──
function legalWindowSpanMinutes(ls, le) {
  if (ls <= le) return Math.max(1, le - ls);
  return (1440 - ls) + le;
}

function minutePctInLegalWindow(m, ls, le) {
  var span = legalWindowSpanMinutes(ls, le);
  if (ls <= le) {
    if (m < ls || m > le) return null;
    return ((m - ls) / (le - ls)) * 100;
  }
  if (m >= ls) return ((m - ls) / span) * 100;
  if (m <= le) return ((1440 - ls + m) / span) * 100;
  return null;
}

function clockMarkerPct(curFloat, ls, le, isLegal) {
  if (isLegal) {
    var p = minutePctInLegalWindow(curFloat, ls, le);
    return p != null ? p : 50;
  }
  if (ls <= le) {
    if (curFloat <= ls) return 0;
    if (curFloat >= le) return 100;
    return ((curFloat - ls) / (le - ls)) * 100;
  }
  var curI = Math.floor(curFloat) % 1440;
  if (inWindow(curI, ls, le)) {
    var q = minutePctInLegalWindow(curFloat, ls, le);
    return q != null ? q : 0;
  }
  if (curFloat > le && curFloat < ls)
    return ((curFloat - le) / (ls - le)) * 100;
  if (curFloat <= le) return 100;
  return 0;
}

function setTickPct(el, pct) {
  if (!el) return;
  if (pct == null || isNaN(pct)) {
    el.style.opacity = '0';
    return;
  }
  el.style.opacity = '1';
  el.style.left = pct + '%';
}

/** Dawn / core / dusk band widths match real (legal start→sunrise) and (sunset→legal end); fixed % looked “wrong” vs ticks. */
function updateTimelineZoneWidths(ls, le, sr, ss) {
  var zonesEl = document.getElementById('timeline-legal-fill');
  if (!zonesEl) return;
  var dawn = zonesEl.querySelector('.banner-tl-zone--dawn');
  var core = zonesEl.querySelector('.banner-tl-zone--core');
  var dusk = zonesEl.querySelector('.banner-tl-zone--dusk');
  if (!dawn || !core || !dusk) return;

  if (ls > le) {
    dawn.style.flex = '0 0 6%';
    core.style.flex = '0 0 88%';
    dusk.style.flex = '0 0 6%';
    return;
  }

  var span = le - ls;
  if (span <= 0) return;

  var dawnW = Math.max(0, Math.min(100, ((sr - ls) / span) * 100));
  var duskW = Math.max(0, Math.min(100, ((le - ss) / span) * 100));
  if (dawnW + duskW > 100) {
    var sum = dawnW + duskW;
    dawnW = (dawnW / sum) * 100;
    duskW = (duskW / sum) * 100;
  }
  var coreW = Math.max(0, 100 - dawnW - duskW);

  dawn.style.flex = '0 0 ' + dawnW.toFixed(2) + '%';
  core.style.flex = '0 0 ' + coreW.toFixed(2) + '%';
  dusk.style.flex = '0 0 ' + duskW.toFixed(2) + '%';
}

// ── Banner rendering ─────────────────────────────────────────
function renderBanner() {
  var bs = bannerState;
  if (!bs._sunrise) return;

  var isLegal    = bs.isLegal;
  var isTwilight = bs.isTwilight;

  var banner = document.getElementById('legal-banner');
  if (banner) {
    banner.className = 'legal-banner legal-banner--glass ' + (isLegal ? (isTwilight ? 'twilight' : 'legal') : 'illegal');
    banner.classList.remove('legal-banner--no-solar');
  }
  // Legal window "opens" once, on first render — the timeline fill scales in.
  if (!_flLegalOpened) {
    var _lf = document.getElementById('timeline-legal-fill');
    if (_lf) {
      _flLegalOpened = true;
      var _rm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!_rm) { void _lf.offsetWidth; _lf.classList.add('fl-window-open'); }
    }
  }

  var lbl = document.getElementById('banner-label');
  if (lbl) {
    lbl.textContent = isLegal ? 'Legal to Shoot' : 'Outside of Legal Hours';
    lbl.className   = 'status-label ' + (isLegal ? (isTwilight ? 'status-twilight' : 'status-legal') : 'status-illegal');
  }
  setBannerStatusPillLocationTrigger(false);

  var srEl = document.getElementById('sunrise-time');
  var ssEl = document.getElementById('sunset-time');
  var lsEl = document.getElementById('legal-start-time');
  var leEl = document.getElementById('legal-end-time');
  if (srEl) srEl.textContent = fmtMinutes(bs.sunriseMin);
  if (ssEl) ssEl.textContent = fmtMinutes(bs.sunsetMin);
  if (lsEl) lsEl.textContent = fmtMinutes(bs.legalStartMin);
  if (leEl) leEl.textContent = fmtMinutes(bs.legalEndMin);

  var stack = document.getElementById('banner-clock-stack');
  if (stack) stack.style.display = '';

  var cdEl = document.getElementById('banner-countdown');
  if (cdEl) cdEl.style.display = '';

  var locEl = document.getElementById('banner-location-text');
  if (locEl && bs.locationName) {
    locEl.textContent = ''; var _lpin = document.createElement('span'); _lpin.className = 'fl-ic fl-pin'; locEl.appendChild(_lpin); locEl.appendChild(document.createTextNode(' ' + bs.locationName));
    locEl.title = bs.locationTooltip || bs.locationName || '';
  }

  updateTimelineBar();
  // Moon + 🦌 badge (needs lat); was missing here so badge waited until tick @ 60s or forecast open
  updateMoon();
}

function updateTimelineBar() {
  var bs = bannerState;
  if (!bs._sunrise || bs.legalStartMin === null) return;

  var ls = bs.legalStartMin;
  var le = bs.legalEndMin;
  var sr = bs.sunriseMin;
  var ss = bs.sunsetMin;
  var curTotalSec = ukNowTotalSecFromMidnight();
  var curFloat = curTotalSec / 60;

  var isLegal = bs.isLegal;
  var markerPct = clockMarkerPct(curFloat, ls, le, isLegal);

  var sunEl = document.getElementById('timeline-sun-marker');
  var moonEl = document.getElementById('timeline-moon-marker');
  if (sunEl) {
    sunEl.style.display = isLegal ? '' : 'none';
    if (isLegal) sunEl.style.left = markerPct + '%';
  }
  if (moonEl) {
    moonEl.style.display = isLegal ? 'none' : '';
    if (!isLegal) moonEl.style.left = markerPct + '%';
    moonEl.hidden = !!isLegal;
  }

  var elapsed = document.getElementById('timeline-elapsed');
  if (elapsed) {
    if (isLegal) {
      var ep = minutePctInLegalWindow(curFloat, ls, le);
      elapsed.style.width = (ep != null ? ep : 0) + '%';
    } else {
      elapsed.style.width = '100%';
    }
  }

  setTickPct(document.getElementById('timeline-sunrise-tick'), minutePctInLegalWindow(sr, ls, le));
  setTickPct(document.getElementById('timeline-sunset-tick'), minutePctInLegalWindow(ss, ls, le));

  updateTimelineZoneWidths(ls, le, sr, ss);

  var t0 = document.getElementById('timeline-start-tick');
  var t1 = document.getElementById('timeline-end-tick');
  if (t0) { t0.style.left = '0%'; t0.style.opacity = '1'; }
  if (t1) { t1.style.left = '100%'; t1.style.opacity = '1'; }
}

// ── 5: Per-second countdown (only update DOM when value changes) ──
var _lastCountdownText = '';
var _lastCountdownClass = '';
var _lastSublabelText = '';

function updateBannerClock() {
  var bs = bannerState;
  if (bs.legalStartMin === null) return;

  var nowSec = ukNowTotalSecFromMidnight();
  var curMin = ukNowMin();
  var el     = document.getElementById('banner-countdown');
  var subEl  = document.getElementById('banner-sublabel');
  if (!el) return;

  var isLegal = bs.isLegal;

  var totalSec, diffMin;
  if (isLegal) {
    var legalEndTotalSec = bs.legalEndMin * 60;
    totalSec = legalEndTotalSec - nowSec;
    // A large negative means the window ends after midnight (add a day). A small
    // negative is just the final legal minute ticking past the boundary — clamp
    // to 0 rather than wrapping the countdown to ~23:59.
    if (totalSec < -60) totalSec += 86400;
    if (totalSec < 0) totalSec = 0;
    diffMin = Math.floor(totalSec / 60);
  } else if (bs._nextLegalStartDate) {
    // DST-correct: diff the actual next-legal-start instant against now, so the
    // overnight "Until legal" countdown doesn't gain/lose an hour on the two
    // DST-change nights (the old wall-clock "+1440" assumed every day is 24 h).
    totalSec = Math.round((bs._nextLegalStartDate.getTime() - flNow().getTime()) / 1000);
    if (totalSec < 0) totalSec = 0;
    diffMin = Math.floor(totalSec / 60);
  } else {
    var rawTarget = bs.nextLegalStartMin;
    var nowTotalMin = curMin;
    if (rawTarget > 1440) {
      diffMin = rawTarget - nowTotalMin;
    } else {
      diffMin = rawTarget > nowTotalMin ? rawTarget - nowTotalMin : (1440 - nowTotalMin + rawTarget);
    }
    var targetTotalSec = diffMin * 60;
    totalSec = targetTotalSec - (nowSec % 60);
    if (totalSec < 0) totalSec += 86400;
  }

  var hh = Math.floor(totalSec / 3600);
  var mm = Math.floor((totalSec % 3600) / 60);
  var ss = totalSec % 60;
  var timeTxt = hh.toString().padStart(2,'0') + ':' + mm.toString().padStart(2,'0') + ':' + ss.toString().padStart(2,'0');

  var subTxt = isLegal ? 'Remaining in window' : 'Until legal';

  var cls = isLegal
    ? (diffMin < 15  ? 'countdown-red banner-countdown-display'
     : diffMin < 60  ? 'countdown-amber banner-countdown-display'
     :                  'countdown-green banner-countdown-display')
    : 'countdown-dim banner-countdown-display';

  if (timeTxt !== _lastCountdownText) {
    el.textContent = timeTxt;
    _lastCountdownText = timeTxt;
  }
  if (cls !== _lastCountdownClass) {
    el.className = cls;
    _lastCountdownClass = cls;
  }
  if (subEl && subTxt !== _lastSublabelText) {
    subEl.textContent = subTxt;
    _lastSublabelText = subTxt;
  }

  updateTimelineBar();
}

// ── Moon ─────────────────────────────────────────────────────
function getMoonPhase(date) {
  var known = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));
  var synodicMonth = 29.530588853;
  var diff = (date - known) / 86400000;
  var age  = ((diff % synodicMonth) + synodicMonth) % synodicMonth;
  var pct  = age / synodicMonth;
  var name = age < 1.85   ? 'New Moon'
           : age < 7.38   ? 'Waxing Crescent'
           : age < 9.22   ? 'First Quarter'
           : age < 14.77  ? 'Waxing Gibbous'
           : age < 16.61  ? 'Full Moon'
           : age < 22.15  ? 'Waning Gibbous'
           : age < 23.99  ? 'Last Quarter'
           : age < 29.53  ? 'Waning Crescent'
           :                'New Moon';
  var icon = age < 1.85   ? '<span class="fl-ic fl-moon-new"></span>'
           : age < 7.38   ? '<span class="fl-ic fl-moon-waxcres"></span>'
           : age < 9.22   ? '<span class="fl-ic fl-moon-firstq"></span>'
           : age < 14.77  ? '<span class="fl-ic fl-moon-waxgibb"></span>'
           : age < 16.61  ? '<span class="fl-ic fl-moon-full"></span>'
           : age < 22.15  ? '<span class="fl-ic fl-moon-wangibb"></span>'
           : age < 23.99  ? '<span class="fl-ic fl-moon-lastq"></span>'
           : age < 29.53  ? '<span class="fl-ic fl-moon-wancres"></span>'
           :                '<span class="fl-ic fl-moon-new"></span>';
  return { age: age, pct: pct, name: name, icon: icon, illumination: Math.round((1 - Math.cos(age / synodicMonth * 2 * Math.PI)) / 2 * 100) };
}

// Builds the inner SVG markup (dark disc + lit terminator + rim) for a moon at
// the given age, sized to a circle of radius r about (cx,cy). Shared by the
// banner moon SVG and the outlook card's inline crescent so they always match.
function moonSVGInner(age, r, cx, cy) {
  var cycle = 29.530588853;
  var phase = age / cycle;          // 0 = new, 0.5 = full, 1 = new
  var dark = '#1a1a2e', lit = '#fffacd';

  // Always start with the dark disc
  var html = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + dark + '"/>';

  if (phase >= 0.02 && phase <= 0.98) {
    // x-radius of the terminator ellipse:
    //   at new/full moon → r (fully lit or fully dark half)
    //   at quarters → 0 (straight edge)
    var tx = Math.abs(Math.cos(phase * 2 * Math.PI)) * r;
    var top = cx + ',' + (cy - r);
    var bot = cx + ',' + (cy + r);

    var litPath;
    if (phase < 0.5) {
      // Waxing: right side lit
      if (phase < 0.25) {
        // Crescent: thin right sliver
        litPath  = 'M' + top + ' A' + r + ',' + r + ' 0 0,1 ' + bot + ' A' + tx + ',' + r + ' 0 0,0 ' + top + ' Z';
      } else {
        // Gibbous: most lit, thin dark left sliver
        litPath  = 'M' + top + ' A' + r + ',' + r + ' 0 0,1 ' + bot + ' A' + tx + ',' + r + ' 0 0,1 ' + top + ' Z';
      }
    } else {
      // Waning: left side lit
      if (phase < 0.75) {
        // Gibbous: most lit, thin dark right sliver
        litPath  = 'M' + top + ' A' + r + ',' + r + ' 0 0,0 ' + bot + ' A' + tx + ',' + r + ' 0 0,0 ' + top + ' Z';
      } else {
        // Crescent: thin left sliver
        litPath  = 'M' + top + ' A' + r + ',' + r + ' 0 0,0 ' + bot + ' A' + tx + ',' + r + ' 0 0,1 ' + top + ' Z';
      }
    }
    html += '<path d="' + litPath + '" fill="' + lit + '"/>';
  }

  // Rim
  html += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="rgba(255,255,200,0.2)" stroke-width="0.8"/>';
  return html;
}

function drawMoonSVG(age) {
  var svg = document.getElementById('moon-svg');
  if (!svg) return;
  svg.innerHTML = moonSVGInner(age, 11, 13, 13);
}

// A small standalone crescent for inline use (e.g. the outlook card's moon pill).
// Returns a full <svg> element string drawn at the given phase.
function moonCrescentSVG(age, size) {
  var s = size || 14, r = (s / 2) - 1, c = s / 2;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 ' + s + ' ' + s + '" aria-hidden="true" style="display:block;flex-shrink:0;">' +
         moonSVGInner(age, r, c, c) + '</svg>';
}

// ── Tonight's outlook card ────────────────────────────────────
// Surfaces the deer-activity forecast on the home screen (previously only the
// small badge + a link). All data comes from getDeerActivityScore() and the
// banner's solar times — no new model, just exposure.
function tonightVerdict(score) {
  return score >= 65 ? { word: 'High', color: '#7ad77a' }
       : score >= 45 ? { word: 'Moderate', color: '#e0954a' }
       : score >= 20 ? { word: 'Low', color: '#c9a05a' }
       :               { word: 'Minimal', color: '#8a8f98' };
}

var TONIGHT_PILL_STYLE = {
  moon: 'background:rgba(255,255,200,0.10);color:rgba(255,255,200,0.85);border-color:rgba(255,255,200,0.18);',
  temp: 'background:rgba(255,140,60,0.10);color:rgba(255,180,100,0.90);border-color:rgba(255,140,60,0.18);',
  wind: 'background:rgba(90,220,90,0.10);color:rgba(122,223,122,0.90);border-color:rgba(90,220,90,0.18);'
};

// Count-up for the deer-activity ring number (once, on first reveal). The ring
// arc itself eases via a CSS transition on stroke-dashoffset. Reduced-motion safe.
var _flToAnimated = false, _flToRAF = null, _flLegalOpened = false;
function flSetTonightScore(el, score) {
  var pct = '<span style="font-size:14px;color:rgba(245,240,232,0.55);">%</span>';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || _flToAnimated) { el.innerHTML = score + pct; _flToAnimated = true; return; }
  _flToAnimated = true;
  var to = score, dur = 900, t0 = null;
  if (_flToRAF) cancelAnimationFrame(_flToRAF);
  function step(ts) {
    if (t0 === null) t0 = ts;
    var t = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - t, 3);
    el.innerHTML = Math.round(to * e) + pct;
    if (t < 1) _flToRAF = requestAnimationFrame(step);
  }
  _flToRAF = requestAnimationFrame(step);
}

function updateTonightOutlook() {
  var card = document.getElementById('tonight-card');
  if (!card) return;
  var cachedWx = (_weatherCache && _weatherCache.data && _weatherCache.lat === bannerState.lat) ? _weatherCache.data : null;
  var r;
  try { r = getDeerActivityScore(cachedWx); } catch (e) { return; }
  if (!r) return;

  var score = Math.max(0, Math.min(100, Math.round(r.score)));
  var v = tonightVerdict(score);

  var arc = document.getElementById('to-ring-arc');
  if (arc) {
    var C = 251.3; // 2πr, r=40
    arc.setAttribute('stroke', v.color);
    arc.setAttribute('stroke-dashoffset', String(Math.round(C * (1 - score / 100))));
  }
  var numEl = document.getElementById('to-score');
  if (numEl) flSetTonightScore(numEl, score);
  var verdEl = document.getElementById('to-verdict');
  if (verdEl) { verdEl.textContent = v.word; verdEl.style.color = v.color; }

  // Best window tonight — the next dawn/dusk peak from the solar times.
  var cur = r.curMin, srM = r.srMin, ssM = r.ssMin;
  var winLabel, peakMin;
  if (cur < srM + 120) { winLabel = 'Dawn'; peakMin = srM; }
  else if (cur <= ssM + 45) { winLabel = 'Dusk'; peakMin = ssM; }
  else { winLabel = 'Dawn tomorrow'; peakMin = srM; }
  var winEl = document.getElementById('to-window');
  var flWinDayOffset = (winLabel === 'Dawn tomorrow') ? 1 : 0;
  function flSetWindowLine(pct) {
    if (!winEl) return;
    var pctHtml = '';
    if (pct != null) {
      var pc = pct >= 65 ? '#7aef7a' : pct >= 45 ? '#e0c050' : '#e09040';
      pctHtml = ' · <b style="color:' + pc + ';">' + pct + '%</b>';
    }
    winEl.innerHTML = winLabel + ' · peak <b style="color:#d8b054;">~' + fmtMinutes(peakMin) + '</b>' + pctHtml;
  }
  flSetWindowLine(null);
  if (bannerState.lat != null) {
    var flWxFull = (_wfWeatherCache && _wfWeatherCache.data && _wfWeatherCache.lat === bannerState.lat && _wfWeatherCache.lng === bannerState.lng) ? _wfWeatherCache.data : null;
    if (flWxFull && flWxFull.hourly) {
      flSetWindowLine(flWindowActivityPct(flWxFull, peakMin, flWinDayOffset));
    } else if (!_flTonightFetching) {
      _flTonightFetching = true;
      fetch7DayWeather(bannerState.lat, bannerState.lng, function (err, wf) {
        _flTonightFetching = false;
        if (!err && wf && wf.hourly) flSetWindowLine(flWindowActivityPct(wf, peakMin, flWinDayOffset));
      });
    }
  }

  // Why — the top one or two positive drivers (falls back to whatever exists).
  var good = (r.factors || []).filter(function(f) { return f.good === true; });
  var pick = good.length ? good : (r.factors || []);
  var whyEl = document.getElementById('to-why');
  if (whyEl) whyEl.textContent = pick.slice(0, 2).map(function(f) { return f.text; }).join(' · ') || 'Conditions updating…';

  // Pills — moon always; temp + wind once weather has loaded.
  var pills = document.getElementById('to-pills');
  if (pills) {
    pills.innerHTML = '';
    var pd = [];
    if (r.moon && r.moon.name) pd.push({ t: r.moon.name + ' · ' + Math.round(r.moon.illumination) + '%', c: 'moon', moonAge: r.moon.age });
    if (cachedWx) {
      if (typeof cachedWx.temp === 'number') pd.push({ t: Math.round(cachedWx.temp) + '°C', c: 'temp', ic: 'fl-temp' });
      if (typeof cachedWx.windSpeed === 'number') pd.push({ t: Math.round(cachedWx.windSpeed * 0.621) + ' mph', c: 'wind', ic: 'fl-wind' });
    }
    pd.forEach(function(p) {
      var el = document.createElement('span');
      el.style.cssText = 'font-size:10px;font-weight:600;padding:4px 10px;border-radius:20px;border:1px solid;' + (TONIGHT_PILL_STYLE[p.c] || '');
      if (p.c === 'moon' && typeof p.moonAge === 'number') {
        // Draw the real crescent for the phase instead of the flat 🌙 glyph.
        el.style.cssText += 'display:inline-flex;align-items:center;gap:5px;';
        el.innerHTML = moonCrescentSVG(p.moonAge, 13);
        var lbl = document.createElement('span');
        lbl.textContent = p.t;
        el.appendChild(lbl);
      } else if (p.ic) {
        el.style.cssText += 'display:inline-flex;align-items:center;gap:5px;';
        var _pi2 = document.createElement('span'); _pi2.className = 'fl-ic ' + p.ic; el.appendChild(_pi2);
        var _pl2 = document.createElement('span'); _pl2.textContent = p.t; el.appendChild(_pl2);
      } else {
        el.textContent = p.t;
      }
      pills.appendChild(el);
    });
  }
}

function updateMoon() {
  var moon = getMoonPhase(flNow());
  drawMoonSVG(moon.age);
  var nameEl = document.getElementById('moon-phase-name');
  var illEl  = document.getElementById('moon-illumination');
  if (nameEl) nameEl.textContent = moon.name;
  if (illEl)  illEl.textContent  = moon.illumination + '% lit';

  // Show quick activity score on badge — with or without weather
  var badge = document.getElementById('activity-score-badge');
  if (badge && bannerState.lat !== null) {
    var cachedWx = (_weatherCache && _weatherCache.data && _weatherCache.lat === bannerState.lat) ? _weatherCache.data : null;
    var quick = getDeerActivityScore(cachedWx);
    badge.innerHTML = '<span class="fl-ic fl-deer"></span> ' + quick.score + '%';
    badge.style.display = 'block';
  }
  try { updateTonightOutlook(); } catch (_) {}
}

// ── Calendar highlight ────────────────────────────────────────
function highlightTodayMonth() {
  var m = ukCalendarYmdLondon(flNow()).m;
  document.querySelectorAll('.month-cell[data-month="' + m + '"]').forEach(function(el) {
    el.classList.add('month-today');
  });
}

// ── Calendar tab — venison eating-quality hints (general field guide, not law) ──
// Rut, fat cover, and condition vary locally; many stalkers prefer milder meat pre-rut or from does/hinds in mid-winter.
var VENISON_QUALITY_GUIDE = {
  'red-stag': 'Often excellent condition Aug–early Sep (pre-rut fat). Peak rut can be leaner with a stronger flavour — still fine slow-cooked or minced. Late winter/spring: check body condition.',
  'red-hind': 'Mid-winter in season (especially Nov–Jan) is classic table time: good fat cover. Late Feb–Mar animals are often heavy in calf — condition varies; welfare and legal sexing still come first.',
  'fallow-buck': 'Similar pattern to red stags: pre-rut (early season) often prime; rut period leaner and more pronounced. Post-rut recovery improves eating quality again.',
  'fallow-doe': 'Winter does are popular on the table — usually well-finished after summer/autumn feeding. As with all deer, young animals tend to be milder.',
  'roe-buck': 'Apr–Jun often mild and lean. Jul–Aug rut: stronger scent/flavour — some love it, some prefer casseroling. Sept–Oct can be a good compromise as bucks recover.',
  'roe-doe': 'Nov–Mar (in season) is the usual roe-doe stalking window; winter animals are often in solid condition. Good all-round venison for most dishes.',
  'sika-stag': 'Autumn rut affects condition like other stags — pre-rut and post-rut windows are often favoured for roasting joints. Rut-period meat suits bold seasoning or slow cooks.',
  'sika-hind': 'Winter hinds in season mirror red: cold-month animals typically carry useful fat. Judge each carcass on condition.',
  'muntjac-buck': 'No close season in England & Wales — quality is less about month than age (younger often milder) and clean shot placement. Small carcass, quick handling helps flavour.',
  'muntjac-doe': 'Year-round in season; mild, delicate venison when handled promptly. Many treat young animals as prime pan meat.',
  'cwd-buck': 'Short winter season — animals are often in good nick mid-winter. Delicate venison; prompt gralloch and cooling matter more than exact week.',
  'cwd-doe': 'Same window as buck: winter CWD does can be superb table deer. Light, mild meat — avoid overcooking.'
};

// Prime table-time months (1–12) — pre-rut fat / solid mid-winter hinds; general guide only.
var VENISON_PEAK_MONTHS = {
  'red-stag': [8, 9],
  'red-hind': [11, 12, 1],
  'fallow-buck': [8, 9],
  'fallow-doe': [11, 12, 1],
  'roe-buck': [4, 5, 6, 9, 10],
  'roe-doe': [11, 12, 1],
  'sika-stag': [8, 9],
  'sika-hind': [11, 12, 1],
  'muntjac-buck': [],
  'muntjac-doe': [],
  'cwd-buck': [11, 12, 1],
  'cwd-doe': [11, 12, 1]
};

// ── Calendar tab rendering ────────────────────────────────────
function buildCalendarCards(selector, region) {
  // region: 'ew' | 'sc' | 'ni'. Legacy boolean accepted (true = Scotland,
  // false = England & Wales) so any older call sites keep working.
  if (region === true) region = 'sc';
  else if (!region || region === false) region = 'ew';
  var months = ['J','F','M','A','M','J','J','A','S','O','N','D'];
  var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  // Europe/London civil date, not the device's, so the strip and the verdict
  // agree with the status rows on the same page for a phone set to another zone.
  var _cal = ukCalendarYmdLondon(flNow());
  var curMonth = _cal.m, curDay = _cal.d;
  var jurisdiction = FL_REGION_JURISDICTION[region] || null;

  var badgeSpan = document.getElementById('cal-month-label-' + region);
  if (badgeSpan) badgeSpan.textContent = monthNames[curMonth-1] + ' ' + _cal.y + ' — highlighted gold';

  document.querySelectorAll(selector).forEach(function(card) {
    var vkEarly = card.dataset.venisonKey;
    var openMonths = flOpenMonthsForCard(card, jurisdiction);
    var peakMonths = (vkEarly && VENISON_PEAK_MONTHS[vkEarly]) ? VENISON_PEAK_MONTHS[vkEarly] : [];
    var sex = card.dataset.sex;
    var name = card.dataset.name;
    var dates = flSeasonLabelForCard(card, jurisdiction);
    var isOpen = flCardOpenNow(card, jurisdiction, curMonth, curDay, openMonths);
    var sexBadge = {
      stag: {bg:'rgba(139,90,43,0.25)',color:'#d4a870',label:'&#9794; Stag'},
      hind: {bg:'rgba(180,100,140,0.25)',color:'#e4a0c0',label:'&#9792; Hind'},
      buck: {bg:'rgba(100,140,80,0.25)',color:'#90c870',label:'&#9794; Buck'},
      doe:  {bg:'rgba(140,100,180,0.25)',color:'#c090e0',label:'&#9792; Doe'}
    }[sex] || {bg:'rgba(100,100,100,0.25)',color:'#aaa',label:'Both'};

    var html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;">';
    html += '<div style="display:flex;align-items:center;gap:8px;">';
    html += '<div style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;background:' + sexBadge.bg + ';color:' + sexBadge.color + ';">' + sexBadge.label + '</div>';
    html += '<div><div style="font-size:12px;font-weight:700;color:#ffffff;">' + name + '</div>';
    html += '<div style="font-size:10px;color:rgba(255,255,255,0.65);">' + dates + '</div></div></div>';
    html += '<div style="font-size:11px;font-weight:800;white-space:nowrap;color:' + (isOpen ? '#5aff5a' : '#ff6060') + ';">' + (isOpen ? '&#9679; OPEN' : '&#9679; CLOSED') + '</div></div>';

    html += '<div style="display:grid;grid-template-columns:repeat(12,1fr);gap:2px;margin-bottom:4px;">';
    for (var i = 1; i <= 12; i++) {
      var isOpenM = openMonths.indexOf(i) !== -1;
      var isToday = i === curMonth;
      var bg = isOpenM ? (isToday ? '#f0c040' : 'linear-gradient(90deg,#3abf3a,#7aef7a)') : 'rgba(255,255,255,0.14)';
      var outline = isToday ? 'outline:2.5px solid #f0c040;outline-offset:0;' : '';
      html += '<div style="height:10px;border-radius:3px;background:' + bg + ';' + outline + '"></div>';
    }
    html += '</div>';

    if (peakMonths.length) {
      html += '<div style="display:grid;grid-template-columns:repeat(12,1fr);gap:2px;margin-bottom:3px;min-height:14px;align-items:end;">';
      for (var p = 1; p <= 12; p++) {
        var isPeakM = peakMonths.indexOf(p) !== -1;
        var sym = isPeakM ? '\u25cf' : '';
        var symColor = isPeakM ? '#e8c547' : 'transparent';
        var symTitle = isPeakM ? 'Good table month (guide)' : '';
        html += '<div style="font-size:12px;line-height:1;text-align:center;color:' + symColor + ';font-weight:800;padding-bottom:1px;" title="' + symTitle + '">' + sym + '</div>';
      }
      html += '</div>';
    }

    html += '<div style="display:grid;grid-template-columns:repeat(12,1fr);gap:2px;">';
    for (var j = 1; j <= 12; j++) {
      var col = j === curMonth ? '#f0c040' : 'rgba(255,255,255,0.6)';
      var fw = j === curMonth ? '800' : '600';
      html += '<div style="font-size:8px;color:' + col + ';text-align:center;font-weight:' + fw + ';">' + months[j-1] + '</div>';
    }
    html += '</div>';

    var vk = card.dataset.venisonKey;
    var venTxt = vk && VENISON_QUALITY_GUIDE[vk];
    if (venTxt) {
      html += '<div style="margin-top:9px;padding-top:9px;border-top:1px solid rgba(255,255,255,0.08);">';
      html += '<div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:rgba(200,168,75,0.85);margin-bottom:5px;font-family:\'DM Mono\',monospace;">Venison on the table</div>';
      if (peakMonths.length) {
        html += '<div style="font-size:9px;color:rgba(255,255,255,0.45);margin-bottom:6px;line-height:1.35;">Gold dots under the strip = typical good table months (guide).</div>';
      }
      html += '<div style="font-size:10px;color:rgba(255,255,255,0.58);line-height:1.5;">' + venTxt + '</div>';
      html += '</div>';
    }

    card.innerHTML = html;
  });

  var chipsEl = document.getElementById('cal-chips-' + region);
  if (chipsEl) {
    chipsEl.textContent = '';
    var regionLabel = { ew: 'England & Wales', sc: 'Scotland', ni: 'Northern Ireland' }[region] || '';
    // The heading is the element immediately above the chip row in the markup.
    var headingEl = chipsEl.previousElementSibling;
    // Per-region chip theme: EW green, Scotland blue, NI orange (matches the
    // chip-ni accent used on the species cards).
    var chipTheme = {
      ew: { bg: 'rgba(90,220,90,0.18)',  bdr: 'rgba(90,220,90,0.35)',  txt: '#7aff7a' },
      sc: { bg: 'rgba(90,130,220,0.18)', bdr: 'rgba(90,130,220,0.35)', txt: '#9ab8ef' },
      ni: { bg: 'rgba(240,160,60,0.18)', bdr: 'rgba(240,160,60,0.35)', txt: '#f0b060' }
    }[region];
    document.querySelectorAll(selector).forEach(function(card) {
      // Month-granular on purpose: the heading above this row says "Open this
      // month", so an animal whose season opens on the 21st still belongs here
      // on the 5th. The card below gives the day-exact verdict and the dates.
      var openMonths = flOpenMonthsForCard(card, jurisdiction);
      if (openMonths.indexOf(curMonth) !== -1) {
        var chip = document.createElement('div');
        var bgC = chipTheme.bg;
        var bdrC = chipTheme.bdr;
        var txtC = chipTheme.txt;
        chip.style.cssText = 'background:' + bgC + ';border:1px solid ' + bdrC + ';border-radius:20px;padding:4px 10px;font-size:11px;font-weight:700;color:' + txtC + ';';
        var sexLabel = {stag:'Stag',hind:'Hind',buck:'Buck',doe:'Doe'}[card.dataset.sex] || '';
        var chipName = card.dataset.name;
        // Only append sex label if name doesn't already end with it
        if (sexLabel && !chipName.endsWith(sexLabel)) chipName += ' ' + sexLabel;
        chip.textContent = chipName;
        chipsEl.appendChild(chip);
      }
    });

    if (!chipsEl.childElementCount) {
      // Nothing is open. An empty band under a heading reading "Open this
      // month" looks like the page failed to draw, so say it in words — and
      // where the dates allow, say what opens next and when. Northern Ireland
      // in July is the case that exposed this: every season there is shut.
      var msg = 'Nothing is open in ' + (regionLabel.replace(' & ', ' and ') || 'this region') + ' this month.';
      var nxt = flNextOpening(selector, jurisdiction, curMonth, curDay);
      if (nxt) msg += ' Next to open: ' + nxt.names.join(', ') + ', from ' + nxt.label + '.';
      var note = document.createElement('div');
      note.style.cssText = 'font-size:11px;line-height:1.5;color:rgba(255,255,255,0.62);';
      note.textContent = msg;
      chipsEl.appendChild(note);
      // A green tick over the words "nothing is open" is a contradiction, so
      // the heading follows the state. '✕ Closed' is the same vocabulary the
      // species badges use.
      if (headingEl) headingEl.textContent = '✕ Closed this month — ' + regionLabel;
    } else if (headingEl) {
      headingEl.textContent = '✅ Open this month — ' + regionLabel;
    }
  }
}

function buildCalendarMatrix(containerId, cardSelector) {
  var el = document.getElementById(containerId);
  if (!el) return;
  var cards = document.querySelectorAll(cardSelector);
  if (!cards.length) return;

  var months = ['J','F','M','A','M','J','J','A','S','O','N','D'];
  var curMonth = flNow().getMonth() + 1;
  var shortSex = {stag:'♂',hind:'♀',buck:'♂',doe:'♀'};

  var html = '<div class="cal-matrix-title">At a glance</div>';
  html += '<table><thead><tr><th></th>';
  for (var m = 0; m < 12; m++) {
    html += '<th' + (m + 1 === curMonth ? ' class="cm-month-now"' : '') + '>' + months[m] + '</th>';
  }
  html += '</tr></thead><tbody>';

  cards.forEach(function(card) {
    var name = card.dataset.name || '';
    var sex = card.dataset.sex || '';
    var sym = shortSex[sex] || '';
    var openMonths = card.dataset.open ? card.dataset.open.split(',').map(Number) : [];

    html += '<tr><td class="cm-lbl">' + sym + ' ' + name + '</td>';
    for (var i = 1; i <= 12; i++) {
      var isOpen = openMonths.indexOf(i) !== -1;
      var cls = 'cm-cell ' + (isOpen ? 'cm-open' : 'cm-closed') + (i === curMonth ? ' cm-now' : '');
      html += '<td><div class="' + cls + '"></div></td>';
    }
    html += '</tr>';
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

function initCalendar() {
  buildCalendarCards('.cal-species-card', 'ew');
  buildCalendarCards('.cal-species-card-sc', 'sc');
  buildCalendarCards('.cal-species-card-ni', 'ni');
}

// ── Public updateBanner (called by location picker, presets, GPS) ─
// opts.tooltip — optional full Nominatim display line for native tooltip when label is short
function updateBanner(lat, lng, locationName, opts) {
  opts = opts || {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng) || !isInUK(lat, lng)) {
    try { localStorage.removeItem('fl_state'); } catch (e) {}
    showOutsideUKMessage();
    return;
  }
  // ── 7: Accuracy warning shown by caller; store state ──
  var ok = computeBannerState(lat, lng, locationName);
  if (!ok) {
    ui.showLocationPrompt('UK time sync unavailable — connect to internet');
    return;
  }
  bannerState.locationTooltip = opts.tooltip !== undefined ? opts.tooltip : (locationName || '');

  // Invalidate weather caches if location changed
  if (_weatherCache.lat !== null && (_weatherCache.lat !== lat || _weatherCache.lng !== lng)) {
    _weatherCache = { data: null, ts: 0, lat: null, lng: null };
  }
  if (_wfWeatherCache.lat !== null && (_wfWeatherCache.lat !== lat || _wfWeatherCache.lng !== lng)) {
    _wfWeatherCache = { data: null, ts: 0, lat: null, lng: null };
  }

  // Persist
  ui.saveState();

  renderBanner();

  // Warm weather cache so the banner badge can use moon+weather score without opening the panel first
  if (bannerState.lat !== null) {
    fetchWeather(bannerState.lat, bannerState.lng, function() {
      updateMoon();
    });
  }

  // Refresh forecast if visible
  updateForecastIfVisible();

  refreshLegalDatePicker();

  // Update season statuses
  updateSeasonStatuses();
}

function updateForecastIfVisible() {
  var tbl = document.getElementById('forecast-table');
  if (tbl) buildForecast();
}

// ── Season statuses ─────────────────────────────────────────────
function updateSeasonStatuses() {
  var S = flSeasons();
  if (!S) return;   // index.html bridges lib/fl-deer-seasons.js onto the global
                    // before this runs; with no statutory source there is
                    // nothing honest to draw, so the rows are left alone.

  // Europe/London calendar, not device-local, so the open/close season shown is
  // correct across the midnight boundary on a device set to a non-UK timezone.
  var _ymd = ukCalendarYmdLondon(flNow()), m = _ymd.m, d = _ymd.d;

  // Every status row on the species cards is id="<key>-<suffix>", so walking
  // the module's own key list covers exactly the rows that exist: setStatus()
  // no-ops on an id that is not in the DOM. A null verdict means the schedule
  // does not list that animal in that jurisdiction — there is no roe season in
  // Northern Ireland — and those rows are absent by design, so nothing is
  // written rather than a misleading "Closed".
  S.SEASON_JURISDICTIONS.forEach(function(j) {
    S.SEASON_KEYS.forEach(function(key) {
      var open = S.isOpenOn(j.code, key, m, d);
      if (open === null) return;
      setStatus(key + '-' + j.domSuffix, open);
    });
  });

  // Season badges on species cards. The badge sits at the head of a card whose
  // body lists England & Wales, Scotland and Northern Ireland side by side, so
  // it rolls all three up. It used to read England only, which told a Scottish
  // stalker in June that his stags were shut when Scotland has had no close
  // season for males since October 2023. The per-jurisdiction breakdown goes in
  // the title and aria-label so the roll-up is never the whole story.
  var BADGES = [
    ['red-badge',     'red-stag',     'red-hind',    'Red deer'],
    ['fallow-badge',  'fallow-buck',  'fallow-doe',  'Fallow deer'],
    ['roe-badge',     'roe-buck',     'roe-doe',     'Roe deer'],
    ['sika-badge',    'sika-stag',    'sika-hind',   'Sika deer'],
    ['muntjac-badge', 'muntjac-buck', 'muntjac-doe', 'Muntjac'],
    ['cwd-badge',     'cwd-buck',     'cwd-doe',     'Chinese water deer'],
  ];
  BADGES.forEach(function(b) {
    var el = document.getElementById(b[0]);
    if (!el) return;
    var anyOpen = false, anyClosed = false, lines = [];
    S.SEASON_JURISDICTIONS.forEach(function(j) {
      var parts = [];
      [b[1], b[2]].forEach(function(key) {
        var open = S.isOpenOn(j.code, key, m, d);
        if (open === null) return;
        if (open) anyOpen = true; else anyClosed = true;
        var sex = key.slice(key.lastIndexOf('-') + 1);
        parts.push(sex.charAt(0).toUpperCase() + sex.slice(1) + ' ' + (open ? 'open' : 'closed'));
      });
      lines.push(j.short + ': ' + (parts.length ? parts.join(', ') : 'not listed'));
    });
    var mixed = anyOpen && anyClosed;
    el.textContent = mixed ? '~ In Part' : anyOpen ? '✓ Open' : '✕ Closed';
    el.className = 'season-badge ' + (mixed ? 'badge-partial' : anyOpen ? 'badge-open' : 'badge-closed');
    var title = b[3] + ' today — ' + lines.join('; ');
    el.title = title;
    el.setAttribute('aria-label', title);
  });
}

// ── 7: Accuracy warning ───────────────────────────────────────
function setBannerStatusPillLocationTrigger(enabled) {
  var pill = document.getElementById('banner-status-pill');
  if (!pill) return;
  if (enabled) {
    pill.setAttribute('data-fl-action', 'banner-status-open-location');
    pill.setAttribute('role', 'button');
    pill.setAttribute('tabindex', '0');
    pill.setAttribute('aria-label', 'Set location');
    pill.setAttribute('title', 'Tap to set location');
    pill.style.cursor = 'pointer';
    return;
  }
  if (pill.getAttribute('data-fl-action') === 'banner-status-open-location') {
    pill.removeAttribute('data-fl-action');
  }
  pill.removeAttribute('role');
  pill.removeAttribute('tabindex');
  pill.removeAttribute('aria-label');
  pill.removeAttribute('title');
  pill.style.cursor = '';
}

ui.showLocationPrompt = function(msg) {
  var el = document.getElementById('banner-location-text');
  if (el) el.textContent = msg;

  ['sunrise-time','sunset-time'].forEach(function(id) {
    var e = document.getElementById(id); if (e) e.textContent = '—';
  });
  ['legal-start-time','legal-end-time'].forEach(function(id) {
    var e = document.getElementById(id); if (e) e.textContent = '—';
  });

  var stack = document.getElementById('banner-clock-stack');
  if (stack) stack.style.display = 'none';

  var banner = document.getElementById('legal-banner');
  if (banner) {
    banner.className = 'legal-banner legal-banner--glass illegal legal-banner--no-solar';
  }

  var lbl = document.getElementById('banner-label');
  // 14.14 (visual pass P3-V8): the pill IS the location trigger — say so,
  // instead of shouting "Location Required" over four dead tiles.
  if (lbl) { lbl.textContent = 'Set your location \u203a'; lbl.className = 'status-label status-illegal'; }
  setBannerStatusPillLocationTrigger(true);
  var sub = document.getElementById('banner-sublabel');
  if (sub) sub.textContent = 'Legal light and sun times appear once it\u2019s set';

  _lastCountdownText = '';
  _lastCountdownClass = '';
  _lastSublabelText = '';
};

ui.showAccuracyWarning = function(accuracy) {
  var el = document.getElementById('accuracy-warning');
  if (!el) return;
  el.style.display = (accuracy > 500) ? 'block' : 'none';
};

// ── GPS init (no auto-retry) ──────────────────────────────────
// ── UK bounds check ──────────────────────────────────────────
// Bounding box: mainland UK + Northern Ireland + Isle of Man + Channel Islands
var UK_BOUNDS = { latMin: 49.8, latMax: 60.9, lngMin: -8.7, lngMax: 1.9 };

function isInUK(lat, lng) {
  return lat >= UK_BOUNDS.latMin && lat <= UK_BOUNDS.latMax
      && lng >= UK_BOUNDS.lngMin && lng <= UK_BOUNDS.lngMax;
}

/** Clear stored coords/solar so ticks and weather do not keep using a non-UK location. */
function clearBannerStateLocation() {
  bannerState.sunriseMin = null;
  bannerState.sunsetMin = null;
  bannerState.legalStartMin = null;
  bannerState.legalEndMin = null;
  bannerState.isLegal = false;
  bannerState.isTwilight = false;
  bannerState.nextLegalStartMin = null;
  bannerState.lat = null;
  bannerState.lng = null;
  bannerState.locationName = '';
  bannerState.locationTooltip = '';
  bannerState._sunrise = null;
  bannerState._sunset = null;
  bannerState._legalStart = null;
  bannerState._legalEnd = null;
  _weatherCache = { data: null, ts: 0, lat: null, lng: null };
  _wfWeatherCache = { data: null, ts: 0, lat: null, lng: null };
}

function showOutsideUKMessage() {
  clearBannerStateLocation();
  ui.showLocationPrompt('First Light covers UK locations only');
  // Show a brief toast
  var toast = document.createElement('div');
  toast.textContent = 'First Light is designed for UK deer stalking only. Please select a UK location.';
  toast.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:rgba(40,10,10,0.95);color:#ff9090;font-size:12px;font-weight:600;padding:10px 16px;border-radius:12px;border:1px solid rgba(255,100,100,0.3);z-index:9999;max-width:300px;text-align:center;line-height:1.4;';
  document.body.appendChild(toast);
  setTimeout(function() {
    toast.style.transition = 'opacity 0.5s';
    toast.style.opacity = '0';
    setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 500);
  }, 3500);
}

function initBanner() {
  // ── Restore last saved location (must be UK — fl_state can contain stale non-UK coords) ──
  var saved = ui.loadState();
  if (saved && saved.lat !== undefined) {
    if (!isInUK(saved.lat, saved.lng)) {
      try { localStorage.removeItem('fl_state'); } catch (e) {}
      clearBannerStateLocation();
    } else {
      var restored = (saved.name || 'Saved location').replace(' (default)', '').replace(', England', '');
      updateBanner(saved.lat, saved.lng, normalizeUkPlaceName(restored.trim()));
      if (saved.tab) {
        var tabMap = { species: 0, times: 1, calendar: 2, shots: 3 };
        var navTabs = document.querySelectorAll('.nav-tab');
        if (navTabs[tabMap[saved.tab]]) {
          switchMainTab(saved.tab);
          navTabs[tabMap[saved.tab]].classList.add('active');
        }
      }
      return;
    }
  }

  // Show locating state while GPS resolves
  ui.showLocationPrompt('Locating…');

  if (!navigator.geolocation) {
    ui.showLocationPrompt('Set location to see legal times');
    return;
  }

  if (!navigator.onLine) {
    ui.showLocationPrompt('Offline — set location manually');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function(pos) {
      var lat = pos.coords.latitude;
      var lng = pos.coords.longitude;
      var acc = pos.coords.accuracy;
      if (!isInUK(lat, lng)) {
        showOutsideUKMessage();
        return;
      }
      ui.showAccuracyWarning(acc);
      fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=jsonv2&addressdetails=1&zoom=15', {
        headers: { 'Accept-Language': 'en', 'User-Agent': 'FirstLightApp/1.0' }
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var name =
            labelFromNominatimReverse(data) ||
            normalizeUkPlaceName((data.address || {}).county) ||
            'Your Location';
          updateBanner(lat, lng, name, { tooltip: data.display_name || name });
        })
        .catch(function() { updateBanner(lat, lng, 'Your Location'); });
    },
    function() {
      // GPS denied or failed — prompt user to set manually
      ui.showLocationPrompt('Location unavailable');
    },
    { timeout: 8000, maximumAge: 15000 }
  );
}

// ── Card expand/collapse ──────────────────────────────────────
function toggleCard(card) {
  var body    = card.querySelector('.card-body');
  var isOpen  = body.classList.contains('expanded');
  body.classList.toggle('expanded', !isOpen);
  card.classList.toggle('expanded-card', !isOpen);
  var header = card.querySelector('.card-header');
  if (header) header.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
}

function toggleFgCategory(header) {
  var isOpen = header.classList.toggle('open');
  header.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  var body = header.parentElement.querySelector('.fg-cat-body');
  if (body) body.classList.toggle('open', isOpen);
}

/** Field Guide: filter `.fg-category` blocks by tokenized substring match on full section text. */
function initFieldGuideSearch() {
  var panel = document.getElementById('tab-shots');
  var input = document.getElementById('fg-search-input');
  if (!panel || !input) return;
  var emptyEl = document.getElementById('fg-search-empty');
  var countEl = document.getElementById('fg-search-count');
  var clearBtn = document.getElementById('fg-search-clear');
  var categories = [].slice.call(panel.querySelectorAll('.fg-category'));
  var index = categories.map(function(cat) {
    return (cat.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
  });
  function clearSearch() {
    input.value = '';
    run();
    input.focus();
  }
  /** Set when a search first runs; restored when the box is cleared so sections don’t stay all expanded. */
  var preSearchOpen = null;
  function run() {
    var q = input.value.trim().toLowerCase();
    var tokens = q ? q.split(/\s+/).filter(Boolean) : [];

    if (!tokens.length && preSearchOpen) {
      categories.forEach(function(cat, i) {
        cat.style.display = '';
        var hdr = cat.querySelector('.fg-cat-header');
        if (!hdr) return;
        var want = preSearchOpen[i];
        var isOpen = hdr.classList.contains('open');
        if (want && !isOpen) toggleFgCategory(hdr);
        if (!want && isOpen) toggleFgCategory(hdr);
      });
      preSearchOpen = null;
      if (emptyEl) emptyEl.hidden = true;
      if (countEl) countEl.textContent = '';
      if (clearBtn) clearBtn.hidden = !input.value.trim();
      return;
    }

    if (!tokens.length) {
      categories.forEach(function(cat) { cat.style.display = ''; });
      if (emptyEl) emptyEl.hidden = true;
      if (countEl) countEl.textContent = '';
      if (clearBtn) clearBtn.hidden = !input.value.trim();
      return;
    }

    if (!preSearchOpen) {
      preSearchOpen = categories.map(function(cat) {
        var h = cat.querySelector('.fg-cat-header');
        return h ? h.classList.contains('open') : false;
      });
    }

    var n = 0;
    categories.forEach(function(cat, i) {
      var show = tokens.every(function(t) { return index[i].indexOf(t) !== -1; });
      cat.style.display = show ? '' : 'none';
      if (show) {
        n++;
        var hdr = cat.querySelector('.fg-cat-header');
        if (hdr && !hdr.classList.contains('open')) toggleFgCategory(hdr);
      }
    });
    if (emptyEl) emptyEl.hidden = !(n === 0);
    if (countEl) {
      if (n === 0) countEl.textContent = '';
      else countEl.textContent = n === 1 ? '1 section matches' : n + ' sections match';
    }
    if (clearBtn) clearBtn.hidden = !input.value.trim();
  }
  input.addEventListener('input', run);
  if (clearBtn) clearBtn.addEventListener('click', clearSearch);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      clearSearch();
    }
  });
}

// ── Tab switching ─────────────────────────────────────────────
/**
 * Keep both tab strips' ARIA state and roving tabindex in step with the
 * active panel.
 *
 * The `active` class was the only thing switchMainTab() updated, so
 * aria-selected stayed frozen at whatever index.html shipped — a screen
 * reader announced "Species, selected" whichever panel was open — and the
 * roving tabindex never rove, so Tab always landed on Species. The bottom
 * bar was worse: role="tab" with no tabindex at all, which meant it could
 * not be focused and its Enter/Space handler could never fire.
 * (Audit 2026-07-25 — WCAG 2.1.1 Level A, 4.1.2 Level A.)
 */
function syncTabState(tab) {
  ['.nav-tab[data-tab]', '.tab-item[data-maintab]'].forEach(function(sel) {
    document.querySelectorAll(sel).forEach(function(t) {
      var on = (t.dataset.tab || t.dataset.maintab) === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.setAttribute('tabindex', on ? '0' : '-1');
    });
  });
}

function switchTab(tab, el) {
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  if (el) el.classList.add('active');
  switchMainTab(tab, { scroll: true });
}

function switchMainTab(tab, opts) {
  document.querySelectorAll('.species-section, .info-section').forEach(function(s) { s.classList.remove('active'); });
  document.querySelectorAll('.tab-item').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });

  var target = document.getElementById('tab-' + tab);
  if (target) target.classList.add('active');

  var bottomTab = document.querySelector('.tab-item[data-maintab="' + tab + '"]');
  if (bottomTab) bottomTab.classList.add('active');

  var navTabs = document.querySelectorAll('.nav-tab');
  var tabMap  = { species: 0, times: 1, calendar: 2, shots: 3 };
  if (navTabs[tabMap[tab]]) navTabs[tabMap[tab]].classList.add('active');

  syncTabState(tab);

  window._activeTab = tab;
  ui.saveState();

  if (tab === 'times') {
    var ft = document.getElementById('forecast-table');
    // Rebuild if table is empty or location changed since last build
    if (!ft || !ft._builtForLat || ft._builtForLat !== bannerState.lat || ft._builtForLng !== bannerState.lng) {
      buildForecast();
    }
    refreshLegalDatePicker();
  }

  // On a user tap, bring the reference tabs to the top so the newly-activated
  // panel is actually on screen. Without this the panel swaps in below the fold
  // — especially from the fixed bottom nav, or now that the tools band sits above
  // the pills — and the tap looks like it did nothing. The load-time tab restore
  // passes no opts, so the page doesn't jump on open.
  if (opts && opts.scroll) {
    var navEl = document.querySelector('.nav-tabs');
    if (navEl && navEl.scrollIntoView) {
      var reduceM = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      navEl.scrollIntoView({ behavior: reduceM ? 'auto' : 'smooth', block: 'start' });
    }
  }
}

// ── 7-day forecast (Option 9) ─────────────────────────────────
function buildForecast() {
  var table = document.getElementById('forecast-table');
  if (!table) return;

  // Guard against double-render from async weather callback
  var buildId = Date.now();
  table._buildId = buildId;

  var bs = bannerState;

  // Location label
  var locLabel = document.getElementById('forecast-location-label');
  if (locLabel) {
    locLabel.textContent = bs.locationName
      ? 'Legal = 1hr before sunrise · 1hr after sunset · Calculated for ' + bs.locationName
      : 'Legal = 1hr before sunrise · 1hr after sunset';
  }

  function fmtD(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) return 'Unavailable';
    var hm = ukHourMin(dateObj); return fmtTime(hm.h, hm.m);
  }

  function windowDuration(lsDate, leDate) {
    if (!lsDate || !leDate) return '--';
    var mins = Math.round((leDate - lsDate) / 60000);
    var h = Math.floor(mins / 60); var m = mins % 60;
    return h + 'h ' + (m > 0 ? m + 'm' : '');
  }

  if (bs.lat === null) {
    // Hero placeholders
    ['hero-sunrise','hero-sunset','hero-legal-start-big','hero-legal-end-big'].forEach(function(id) {
      var el = document.getElementById(id); if (el) el.textContent = '--:--';
    });
    var dur = document.getElementById('hero-window-duration'); if (dur) dur.textContent = '--';
    var hs = document.getElementById('hero-legal-start'); if (hs) hs.textContent = 'Legal from --:--';
    var he = document.getElementById('hero-legal-end'); if (he) he.textContent = 'Legal until --:--';
    table.textContent = '';
    var msg = document.createElement('div');
    msg.style.cssText = 'text-align:center;color:#888;font-size:13px;padding:16px;';
    msg.textContent = 'Set your location to see legal times.';
    table.appendChild(msg);
    return;
  }

  var today = flNow();
  var days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ── Build today hero (same instants as main banner — avoid recalc with different Date inputs) ──
  var sr0, ss0, ls0, le0;
  if (bs._sunrise && bs._sunset && bs._legalStart && bs._legalEnd) {
    sr0 = bs._sunrise;
    ss0 = bs._sunset;
    ls0 = bs._legalStart;
    le0 = bs._legalEnd;
  } else {
    try { sr0 = calcSunTime(today, bs.lat, bs.lng, true);  } catch(e) { sr0 = null; }
    try { ss0 = calcSunTime(today, bs.lat, bs.lng, false); } catch(e) { ss0 = null; }
    ls0 = sr0 ? addMins(sr0, -60) : null;
    le0 = ss0 ? addMins(ss0,  60) : null;
  }

  var heroLabel = document.getElementById('forecast-hero-label');
  if (heroLabel) {
    var dayName = days[today.getDay()];
    heroLabel.textContent = ''; var _cal = document.createElement('span'); _cal.className = 'fl-ic fl-calendar'; heroLabel.appendChild(_cal); heroLabel.appendChild(document.createTextNode(' Today — ' + dayName + ' ' + today.getDate() + ' ' + months[today.getMonth()]));
  }

  var hSR  = document.getElementById('hero-sunrise-label');
  var hSS  = document.getElementById('hero-sunset-label');
  var hLSB = document.getElementById('hero-legal-start-big'); if (hLSB) hLSB.textContent = fmtD(ls0);
  var hLEB = document.getElementById('hero-legal-end-big');   if (hLEB) hLEB.textContent = fmtD(le0);
  var hDur = document.getElementById('hero-window-duration'); if (hDur) hDur.textContent = windowDuration(ls0, le0);
  if (hSR) hSR.textContent = 'Sunrise ' + fmtD(sr0);
  if (hSS) hSS.textContent = 'Sunset ' + fmtD(ss0);

  // ── Build rows days 1–6 (today is day 0 in hero) ─────────────
  // Table is cleared inside the fetch callback to prevent double-render

  var GRID = '2.2fr 1fr 1fr 1.3fr 1.3fr 1.3fr 1fr 1fr 1fr';

  function flColor(fl, temp) { return (temp - fl) >= 2 ? '#a0d0ff' : 'rgba(255,255,255,0.5)'; }
  function gustColor(gust, wind) {
    var d = gust - wind;
    return d >= 15 ? '#e07020' : d >= 8 ? '#f0c040' : 'rgba(255,255,255,0.45)';
  }
  function rainPctColor(p) { return p >= 50 ? '#e07020' : p >= 25 ? '#f0c040' : 'rgba(255,255,255,0.3)'; }
  function rainMmColor(m)  { return m >= 3  ? '#e07020' : m >= 1  ? '#f0c040' : 'rgba(255,255,255,0.3)'; }
  function feelsLike(t, windMph) {
    var wk = windMph * 1.609;
    if (wk < 4.8 || t > 10) return t;
    var v = Math.pow(wk, 0.16);
    return Math.round(13.12 + 0.6215*t - 11.37*v + 0.3965*t*v);
  }
  function dirSpan(deg) {
    var cards = ['N','NE','E','SE','S','SW','W','NW'];
    var idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
    var disp = (idx * 45 + 180) % 360;
    return '<span style="display:inline-block;transform:rotate(' + disp + 'deg);line-height:1;">\u2191\uFE0E</span>\u00a0' + cards[idx];
  }
  function skyCellHtml(code, precip) {
    var emoji = wxCodeToEmoji(code, precip);
    if (emoji.indexOf('fl-wx-fog') !== -1) return '<div style="font-size:9px;font-weight:600;text-align:center;color:rgba(255,255,255,0.5);">Fog</div>';
    return '<div style="font-size:13px;text-align:center;">' + emoji + '</div>';
  }
  function buildLegalHourlyPanel(dayIdx, date, wxData, lsMin, leMin, srMin, ssMin) {
    var dawnStart = srMin - 60, dawnEnd = srMin + 120;
    var duskStart = ssMin - 90, duskEnd = ssMin + 45;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var isToday = dayIdx === 0;
    var dateLabel = (isToday ? 'Today' : dayNames[date.getDay()]) + ' ' + date.getDate() + ' ' + months[date.getMonth()];
    var lsLabel = fmtMins(lsMin) + ' \u2013 ' + fmtMins(leMin);

    var colLabels = ['Time','Temp','Feels','Wind','Dir','Gust','Sky','Rain','mm'];
    var hdr = '<div style="display:grid;grid-template-columns:' + GRID + ';gap:3px;padding:0 0 5px;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:2px;">';
    colLabels.forEach(function(l, i) {
      hdr += '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.22);text-align:' + (i===0?'left':'center') + ';">' + l + '</div>';
    });
    hdr += '</div>';

    var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      + '<span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:rgba(200,168,75,0.65);">Hourly weather</span>'
      + '<span style="font-size:8px;background:rgba(200,168,75,0.1);border:1px solid rgba(200,168,75,0.2);border-radius:10px;padding:2px 7px;color:#c8a84b;">' + lsLabel + '</span>'
      + '</div>' + hdr;

    var startH = Math.floor(lsMin / 60);
    var endH   = Math.ceil(leMin  / 60);
    for (var h = startH; h <= endH; h++) {
      var hMin = h * 60;
      if (hMin > leMin + 59) break;
      if (h === endH) {
        html += '<div style="display:flex;gap:8px;align-items:center;padding:6px 0 2px;border-top:1px solid rgba(200,168,75,0.18);margin-top:3px;">'
          + '<div style="font-size:9px;color:rgba(255,255,255,0.28);font-variant-numeric:tabular-nums;">' + fmtMins(leMin) + '</div>'
          + '<div style="font-size:9px;font-weight:600;color:#c8a84b;">Legal window closes</div></div>';
        break;
      }
      var hIdx = dayIdx * 24 + h;
      var wxH = null;
      if (wxData && wxData.hourly) {
        var T = wxData.hourly.temperature_2m;
        var W = wxData.hourly.wind_speed_10m;
        var G = wxData.hourly.windgusts_10m;
        var D = wxData.hourly.wind_direction_10m;
        var P = wxData.hourly.precipitation_probability;
        var PR = wxData.hourly.precipitation;
        var C = wxData.hourly.weather_code;
        if (T && hIdx < T.length) {
          wxH = {
            temp: Math.round(T[hIdx]),
            wind: W ? Math.round(W[hIdx] * 0.621) : null,
            gust: G ? Math.round(G[hIdx] * 0.621) : null,
            dir:  D ? D[hIdx] : null,
            precipP: P ? P[hIdx] : null,
            precipMm: PR ? PR[hIdx] : null,
            code: C ? C[hIdx] : null
          };
        }
      }
      var tStr = (h < 10 ? '0' : '') + h + ':00';
      var tempStr  = wxH ? wxH.temp + '\u00b0' : '\u2013';
      var windStr  = wxH && wxH.wind  !== null ? wxH.wind  + ' mph' : '\u2013';
      var gustStr  = wxH && wxH.gust  !== null ? wxH.gust  + ' mph' : '\u2013';
      var dirStr   = wxH && wxH.dir   !== null ? dirSpan(wxH.dir)   : '\u2013';
      var skyStr   = wxH ? skyCellHtml(wxH.code, wxH.precipMm || 0)     : '<div style="text-align:center;">\u2013</div>';
      var pctStr   = wxH && wxH.precipP  !== null ? (wxH.precipP > 0 ? wxH.precipP + '%' : '\u2013') : '\u2013';
      var mmStr    = wxH && wxH.precipMm !== null ? (wxH.precipMm > 0 ? wxH.precipMm.toFixed(1) : '\u2013') : '\u2013';
      var fl       = wxH ? feelsLike(wxH.temp, wxH.wind || 0) : null;
      var flStr    = fl !== null ? fl + '\u00b0' : '\u2013';
      var flClr    = fl !== null ? flColor(fl, wxH.temp) : 'rgba(255,255,255,0.5)';
      var gClr     = wxH && wxH.gust !== null ? gustColor(wxH.gust, wxH.wind || 0) : 'rgba(255,255,255,0.45)';
      var pClr     = wxH && wxH.precipP  !== null ? rainPctColor(wxH.precipP)  : 'rgba(255,255,255,0.3)';
      var mClr     = wxH && wxH.precipMm !== null ? rainMmColor(wxH.precipMm)  : 'rgba(255,255,255,0.3)';

      html += '<div style="display:grid;grid-template-columns:' + GRID + ';gap:3px;padding:5px 3px;border-bottom:1px solid rgba(255,255,255,0.035);align-items:center;margin:1px 0;">'
        + '<div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.75);font-variant-numeric:tabular-nums;">' + tStr + '</div>'
        + '<div style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.78);text-align:center;">' + tempStr + '</div>'
        + '<div style="font-size:11px;font-weight:600;text-align:center;color:' + flClr + ';">' + flStr + '</div>'
        + '<div style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.78);text-align:center;white-space:nowrap;">' + windStr + '</div>'
        + '<div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.6);text-align:center;white-space:nowrap;">' + dirStr + '</div>'
        + '<div style="font-size:10px;font-weight:600;text-align:center;white-space:nowrap;color:' + gClr + ';">' + gustStr + '</div>'
        + skyStr
        + '<div style="font-size:10px;font-weight:600;text-align:center;color:' + pClr + ';">' + pctStr + '</div>'
        + '<div style="font-size:10px;font-weight:600;text-align:center;color:' + mClr + ';">' + mmStr + '</div>'
        + '</div>';
    }

    html += '<div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap;">'
      + '<div style="font-size:8px;color:rgba(255,255,255,0.25);display:flex;align-items:center;gap:3px;"><span style="color:#a0d0ff;">■</span> Wind chill</div>'
      + '<div style="font-size:8px;color:rgba(255,255,255,0.25);display:flex;align-items:center;gap:3px;"><span style="color:#f0c040;">■</span> Gusty</div>'
      + '<div style="font-size:8px;color:rgba(255,255,255,0.25);display:flex;align-items:center;gap:3px;"><span style="color:#e07020;">■</span> Strong gusts</div>'
      + '</div>'
      + '<div style="font-size:9px;color:rgba(255,255,255,0.18);text-align:center;margin-top:6px;">Hourly weather \u00b7 Open-Meteo</div>';
    return html;
  }

  var SVG_SR_SM = '<svg width="16" height="13" viewBox="0 0 28 22" xmlns="http://www.w3.org/2000/svg" style="display:inline;vertical-align:middle;flex-shrink:0;"><path d="M0,22 Q4,14 8,16 Q11,18 14,13 Q17,8 20,12 Q23,15 28,11 L28,22 Z" fill="#3a5a2a" opacity="0.85"/><path d="M0,22 Q5,17 9,19 Q13,21 16,17 Q19,14 24,18 Q26,19 28,17 L28,22 Z" fill="#2a4a1a" opacity="0.9"/><circle cx="14" cy="13" r="5" fill="#f5b830" opacity="0.95"/></svg>';
  var SVG_SS_SM = '<svg width="16" height="13" viewBox="0 0 28 22" xmlns="http://www.w3.org/2000/svg" style="display:inline;vertical-align:middle;flex-shrink:0;"><ellipse cx="14" cy="16" rx="12" ry="4" fill="#e06010" opacity="0.3"/><circle cx="14" cy="16" r="5" fill="#e87820" opacity="0.95"/><path d="M0,22 Q4,13 8,15 Q11,17 14,12 Q17,7 20,11 Q23,14 28,10 L28,22 Z" fill="#2a3a1a" opacity="0.9"/><path d="M0,22 Q5,16 9,18 Q13,20 16,16 Q19,13 24,17 Q26,18 28,16 L28,22 Z" fill="#1a2a0f" opacity="0.95"/></svg>';

  // Fetch weather then build rows
  var lat = bs.lat, lng = bs.lng;
  fetch7DayWeather(lat, lng, function(err, wxData) {
    // If buildForecast was called again while we were fetching, abort this render
    if (table._buildId !== buildId) return;
    table.textContent = '';
    var heroWx = document.getElementById('hero-wx-summary');
    if (heroWx && wxData && wxData.daily) {
      var code0 = wxData.daily.weather_code ? wxData.daily.weather_code[0] : null;
      var t0max = wxData.daily.temperature_2m_max ? wxData.daily.temperature_2m_max[0] : null;
      var t0min = wxData.daily.temperature_2m_min ? wxData.daily.temperature_2m_min[0] : null;
      var w0    = wxData.daily.wind_speed_10m_max  ? Math.round(wxData.daily.wind_speed_10m_max[0] * 0.621) : null;
      var emoji0 = code0 !== null ? wxCodeToEmoji(code0, 0) : '';
      var temp0  = (t0max !== null && t0min !== null) ? Math.round((t0max + t0min) / 2) + '\u00b0C' : '';
      var wind0  = w0 !== null ? w0 + ' mph' : '';
      heroWx.innerHTML = [emoji0, temp0, wind0 ? '\u00b7 ' + wind0 : ''].filter(Boolean).join(' ');
    }

    for (var i = 0; i < 7; i++) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      var sr, ss, legalStart, legalEnd;
      if (i === 0 && bs._sunrise && bs._sunset && bs._legalStart && bs._legalEnd) {
        sr = bs._sunrise;
        ss = bs._sunset;
        legalStart = bs._legalStart;
        legalEnd = bs._legalEnd;
      } else {
        try { sr = calcSunTime(d, lat, lng, true);  } catch(e) { sr = null; }
        try { ss = calcSunTime(d, lat, lng, false); } catch(e) { ss = null; }
        legalStart = sr ? addMins(sr, -60) : null;
        legalEnd   = ss ? addMins(ss,  60) : null;
      }
      var lsMin2 = legalStart ? toMinutes(legalStart) : 5 * 60;
      var leMin2 = legalEnd   ? toMinutes(legalEnd)   : 19 * 60;
      var srMin2 = sr ? toMinutes(sr) : 6 * 60;
      var ssMin2 = ss ? toMinutes(ss) : 18 * 60;

      var wxDay = null;
      if (wxData && wxData.daily) {
        wxDay = {
          tempMax:  wxData.daily.temperature_2m_max  ? wxData.daily.temperature_2m_max[i]  : null,
          tempMin:  wxData.daily.temperature_2m_min  ? wxData.daily.temperature_2m_min[i]  : null,
          windMax:  wxData.daily.wind_speed_10m_max  ? wxData.daily.wind_speed_10m_max[i]  : null,
          gustMax:  wxData.daily.wind_gusts_10m_max  ? wxData.daily.wind_gusts_10m_max[i]  : null,
          precip:   wxData.daily.precipitation_sum   ? wxData.daily.precipitation_sum[i]   : null,
          wcode:    wxData.daily.weather_code        ? wxData.daily.weather_code[i]        : null
        };
      }

      var isToday = i === 0;
      var isBST = (function(date) {
        var lastSunMar = new Date(date.getFullYear(), 2, 31);
        lastSunMar.setDate(31 - lastSunMar.getDay());
        var lastSunOct = new Date(date.getFullYear(), 9, 31);
        lastSunOct.setDate(31 - lastSunOct.getDay());
        return date >= lastSunMar && date < lastSunOct;
      }(d));
      var prevIsBST = i === 0 ? isBST : (function(date) {
        var lastSunMar = new Date(date.getFullYear(), 2, 31);
        lastSunMar.setDate(31 - lastSunMar.getDay());
        var lastSunOct = new Date(date.getFullYear(), 9, 31);
        lastSunOct.setDate(31 - lastSunOct.getDay());
        return date >= lastSunMar && date < lastSunOct;
      }(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i - 1)));
      var clockChange = i > 0 && isBST !== prevIsBST;

      // Day label
      var dayLabel = isToday ? 'Today' : days[d.getDay()];
      var dayColor = isToday ? '#f0c870' : 'rgba(255,255,255,0.4)';

      // Weather summary for row
      var wxSky = '', wxTemp = '', wxWind = '', wxCond = '';
      if (wxDay) {
        wxSky  = wxCodeToEmoji(wxDay.wcode, wxDay.precip || 0);
        wxTemp = wxDay.tempMax !== null ? Math.round((wxDay.tempMax + wxDay.tempMin) / 2) + '\u00b0C' : '';
        wxWind = wxDay.windMax !== null ? Math.round(wxDay.windMax * 0.621) + ' mph' : '';
        wxCond = conditionLabel(wxDay.wcode, wxDay.precip || 0);
      }

      // Build row
      var row = document.createElement('div');
      row.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;';

      var bstBadge = clockChange ? '<span style="font-size:8px;font-weight:700;color:#f0c040;background:rgba(240,192,64,0.12);border-radius:4px;padding:1px 5px;margin:0 2px;">' + (isBST ? 'BST' : 'GMT') + '</span>' : '';

      row.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;padding:11px 16px 8px;">'
          + '<div style="width:44px;flex-shrink:0;">'
            + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;color:' + dayColor + ';">' + dayLabel + '</div>'
            + '<div style="font-size:15px;font-weight:700;color:rgba(255,255,255,0.85);">' + d.getDate() + '</div>'
          + '</div>'
          + '<div style="flex:1;min-width:0;">'
            + '<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px;flex-wrap:wrap;">'
              + '<span style="font-size:20px;font-weight:700;color:#f0c870;font-variant-numeric:tabular-nums;line-height:1;">' + fmtD(legalStart) + '</span>'
              + bstBadge
              + '<span style="font-size:13px;color:rgba(255,255,255,0.25);">\u2192</span>'
              + '<span style="font-size:20px;font-weight:700;color:#f09850;font-variant-numeric:tabular-nums;line-height:1;">' + fmtD(legalEnd) + '</span>'
            + '</div>'
            + '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">'
              + SVG_SR_SM + '<span style="font-size:10px;color:rgba(255,255,255,0.4);font-variant-numeric:tabular-nums;">' + fmtD(sr) + '</span>'
              + SVG_SS_SM + '<span style="font-size:10px;color:rgba(255,255,255,0.4);font-variant-numeric:tabular-nums;">' + fmtD(ss) + '</span>'
              + '<span style="font-size:10px;color:rgba(255,255,255,0.22);">' + windowDuration(legalStart, legalEnd) + '</span>'
            + '</div>'
          + '</div>'
          + '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0;">'
            + '<div style="display:flex;align-items:center;gap:4px;"><span style="font-size:18px;">' + (wxSky || '') + '</span><span style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.75);">' + wxTemp + '</span></div>'
            + '<div style="font-size:10px;color:rgba(255,255,255,0.35);text-align:right;">' + wxWind + (wxCond ? ' \u00b7 ' + wxCond : '') + '</div>'
            + '<div style="font-size:10px;color:rgba(255,255,255,0.2);margin-top:2px;transition:transform 0.2s;" class="lt-chev">\u25be</div>'
          + '</div>'
        + '</div>'
        + '<div class="lt-hourly" style="display:none;background:rgba(0,0,0,0.22);border-top:1px solid rgba(255,255,255,0.05);padding:10px 14px;overflow:hidden;">'
          + buildLegalHourlyPanel(i, d, wxData, lsMin2, leMin2, srMin2, ssMin2)
        + '</div>';

      // Toggle hourly
      (function(r) {
        r.addEventListener('click', function() {
          var h = r.querySelector('.lt-hourly');
          var c = r.querySelector('.lt-chev');
          var open = h.style.display !== 'none';
          h.style.display = open ? 'none' : 'block';
          if (c) c.style.transform = open ? '' : 'rotate(180deg)';
        });
      }(row));

      table.appendChild(row);
    }
    if (table.lastChild) table.lastChild.style.borderBottom = 'none';
    table._builtForLat = lat;
    table._builtForLng = lng;
  });
}


// ════════════════════════════════════════════════════════════════
// FEATURE: 7-DAY ACTIVITY FORECAST
// ════════════════════════════════════════════════════════════════

var _wfWeatherCache = { data: null, ts: 0, lat: null, lng: null };
var _flTonightFetching = false;

function fetch7DayWeather(lat, lng, cb) {
  var now = Date.now();
  if (_wfWeatherCache.data && (now - _wfWeatherCache.ts < 20*60*1000)
      && _wfWeatherCache.lat === lat && _wfWeatherCache.lng === lng) {
    return cb(null, _wfWeatherCache.data);
  }
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat
    + '&longitude=' + lng
    + '&daily=temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,precipitation_sum,weather_code,surface_pressure_mean'
    + '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,windgusts_10m,precipitation_probability,precipitation,weather_code,cloud_cover,surface_pressure'
    + '&forecast_days=7&timezone=auto';
  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      _wfWeatherCache = { data: d, ts: Date.now(), lat: lat, lng: lng };
      cb(null, d);
    })
    .catch(function(e) { cb(e, null); });
}

function scoreDay(date, wxDay) {
  // Score dawn and dusk windows for a given date
  var bs = bannerState;
  var lat = bs.lat || 52, lng = bs.lng || 0;
  var sr, ss;
  try { sr = calcSunTime(date, lat, lng, true);  } catch(e) { sr = null; }
  try { ss = calcSunTime(date, lat, lng, false); } catch(e) { ss = null; }
  if (!sr || !ss) return null;

  var srMin = toMinutes(sr);
  var ssMin = toMinutes(ss);
  var dawnStart = srMin - 60;
  var dawnEnd   = srMin + 120;
  var duskStart = ssMin - 90;
  var duskEnd   = ssMin + 45;  // 45 mins after sunset

  var moon = getMoonPhase(date);
  var month = date.getMonth() + 1;

  // Moon boost — reduced from 15/11/8/4/1 (phase effect on daytime movement overstated)
  var mb = moon.illumination < 15 ? 8
         : moon.illumination < 40 ? 6
         : moon.illumination < 60 ? 4
         : moon.illumination < 85 ? 2 : 1;

  // Rut — masked to the user's ground species (empty = all species)
  var rutMonths = RUT_CALENDAR[month] || [0,0,0,0,0];
  var maxRut = maxRutMasked(rutMonths, rutMaskForSpecies(flMySpecies()));
  var rutScore = maxRut >= 25 ? 15 : maxRut >= 10 ? 8 : maxRut > 0 ? 3 : 0;

  // Seasonal
  var sb = month === 2 ? 5 : month === 3 ? 3
         : (month === 9 || month === 10) ? 4
         : month === 11 ? 2
         : (month >= 6 && month <= 8) ? -3 : 0;

  // Weather for this day
  var wxScore = 0;
  if (wxDay) {
    var avgTemp = (wxDay.tempMax + wxDay.tempMin) / 2;
    var baseTemp = avgTemp <= 0 ? 4 : avgTemp <= 8 ? 6 : avgTemp <= 14 ? 3 : avgTemp <= 18 ? 0 : -3;
    // Frost bonus: overnight low below zero = deer must feed hard next dawn
    var frostBonusD = wxDay.tempMin < -1 ? 4 : wxDay.tempMin <= 0 ? 2 : 0;
    wxScore += baseTemp + frostBonusD;
    var windMaxMph1 = wxDay.windMax * 0.621;
    wxScore += windMaxMph1 < 8 ? 6 : windMaxMph1 < 20 ? 3 : windMaxMph1 < 35 ? -2 : -5;
    // Gust consistency: daily gust max vs wind max ratio
    if (wxDay.gustMax && wxDay.windMax > 2) {
      var dailyGustRatio = (wxDay.gustMax - wxDay.windMax) / wxDay.windMax;
      wxScore += dailyGustRatio > 0.8 ? -4
              : dailyGustRatio > 0.5  ? -2
              : dailyGustRatio > 0.3  ? -1
              : dailyGustRatio <= 0.15 ? 1 : 0;
    }
    wxScore += wxDay.precip > 5 ? -4 : wxDay.precip > 0.5 ? 2 : 1;
    // Pressure proxy: day-over-day delta from surface_pressure_mean
    // (falling pressure = pre-front feeding surge; rising = settled, less urgency)
    if (wxDay.pressure !== null && wxDay.pressure !== undefined) {
      var prevPressure = (wxDay.prevPressure !== undefined) ? wxDay.prevPressure : wxDay.pressure;
      var pressureDelta = wxDay.pressure - prevPressure;
      wxScore += pressureDelta < -1 ? 4 : pressureDelta < 0 ? 2 : pressureDelta > 1 ? 0 : 1;
    }
  }

  var dawnScore = Math.min(100, Math.max(0, 40 + mb + rutScore + sb + wxScore));
  var duskScore = Math.min(100, Math.max(0, 40 + mb + rutScore + sb + wxScore));
  // Dusk variance: calmer evenings boost dusk slightly
  duskScore = Math.min(100, Math.max(0, duskScore + (wxDay && (wxDay.windMax * 0.621) > 20 ? -3 : 2)));

  return {
    dawnScore: dawnScore,
    duskScore: duskScore,
    bestScore: Math.max(dawnScore, duskScore),
    bestWindow: dawnScore >= duskScore ? 'Dawn' : 'Dusk',
    dawnTime: fmtMins(dawnStart),
    duskTime: fmtMins(duskStart),
    moon: moon,
    wxDay: wxDay
  };
}

// ── Weather helpers ───────────────────────────────────────────
function conditionLabel(code, precip) {
  if (code === null || code === undefined) return 'Cloud';
  if (code === 0)  return 'Clear';
  if (code <= 2)   return 'Partly cloudy';
  if (code === 3)  return 'Overcast';
  if (code <= 49)  return 'Fog';
  if (code <= 57)  return 'Drizzle';
  if (code <= 65)  return precip > 4 ? 'Heavy rain' : 'Rain';
  if (code <= 77)  return 'Snow';
  if (code <= 82)  return precip > 4 ? 'Heavy rain' : 'Showers';
  if (code <= 86)  return 'Snow showers';
  if (code <= 99)  return 'Thunderstorm';
  return 'Cloudy';
}

function wxCodeToEmoji(code, precip) {
  if (code === null || code === undefined) return '<span class="fl-ic fl-wx-cloud"></span>';
  if (code === 0)  return '<span class="fl-ic fl-wx-sun"></span>';
  if (code <= 2)   return '<span class="fl-ic fl-wx-partcloud"></span>';
  if (code === 3)  return '<span class="fl-ic fl-wx-cloud"></span>';
  if (code <= 49)  return '<span class="fl-ic fl-wx-fog"></span>';
  if (code <= 57)  return '<span class="fl-ic fl-wx-lightrain"></span>';
  if (code <= 65)  return precip > 4 ? '<span class="fl-ic fl-wx-rain"></span>' : '<span class="fl-ic fl-wx-lightrain"></span>';
  if (code <= 77)  return '<span class="fl-ic fl-wx-snow"></span>';
  if (code <= 82)  return precip > 4 ? '<span class="fl-ic fl-wx-rain"></span>' : '<span class="fl-ic fl-wx-lightrain"></span>';
  if (code <= 86)  return '<span class="fl-ic fl-wx-snow"></span>';
  if (code <= 99)  return '<span class="fl-ic fl-wx-storm"></span>';
  return '<span class="fl-ic fl-wx-cloud"></span>';
}

function precipEmoji(mm) {
  if (mm <= 0)   return '<span class="fl-ic fl-wx-partcloud"></span>';
  if (mm < 2)    return '<span class="fl-ic fl-wx-lightrain"></span>';
  if (mm < 5)    return '<span class="fl-ic fl-wx-rain"></span>';
  return '<span class="fl-ic fl-wx-rain"></span>';
}

function windDirArrow(deg) {
  // Returns rotated ↑ arrow + cardinal — using text variation selector to prevent emoji rendering
  var cardinals = ['N','NE','E','SE','S','SW','W','NW'];
  var idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  var cardinal = cardinals[idx];
  var rotDeg = idx * 45;
  // Wind direction = where wind comes FROM — arrow points where wind goes TO
  var displayDeg = (rotDeg + 180) % 360;
  return '<span style="display:inline-block;transform:rotate(' + displayDeg + 'deg);line-height:1;font-style:normal;">\u2191\uFE0E</span>\u00a0' + cardinal;
}

function hourlyActivityScore(hour, date, wxHour) {
  // Simplified per-hour score using same model as getDeerActivityScore
  var bs = bannerState;
  var lat = bs.lat || 52, lng = bs.lng || 0;
  // Compute sunrise/sunset for this specific day, not today
  var sr = calcSunTime(date, lat, lng, true);
  var ss = calcSunTime(date, lat, lng, false);
  var srMin = sr ? toMinutes(sr) : 6*60;
  var ssMin = ss ? toMinutes(ss) : 20*60;
  var dawnStart = srMin - 60, dawnEnd = srMin + 120;
  var duskStart = ssMin - 90, duskEnd = ssMin + 45;
  var moon = getMoonPhase(date);
  var month = date.getMonth() + 1;
  var score = 0;

  // Time window
  if (hour >= dawnStart/60 && hour <= dawnEnd/60)       score += 40;
  else if (hour >= duskStart/60 && hour <= duskEnd/60)  score += 40;
  else if (hour >= dawnEnd/60 && hour <= duskStart/60)  score += 8;
  else score += 8;

  // Moon — reduced weights (daytime phase effect overstated in literature)
  var mb = moon.illumination < 15 ? 8 : moon.illumination < 40 ? 6
         : moon.illumination < 60 ? 4 : moon.illumination < 85 ? 2 : 1;
  var isNight = !(hour >= dawnStart/60 && hour <= duskEnd/60);
  score += isNight ? Math.round(mb * 0.3) : mb;

  // Rut — masked to the user's ground species (empty = all species)
  var rutM = RUT_CALENDAR[month] || [0,0,0,0,0];
  var maxRut = maxRutMasked(rutM, rutMaskForSpecies(flMySpecies()));
  score += maxRut >= 25 ? 15 : maxRut >= 10 ? 8 : maxRut > 0 ? 3 : 0;

  // Season
  score += month === 2 ? 5 : month === 3 ? 3
         : (month === 9||month===10) ? 4 : month===11 ? 2
         : (month>=6&&month<=8) ? -3 : 0;

  // Solunar — reduced (contested in peer-reviewed literature; major +3, minor +1)
  var sol = getSolunar(date, lat, lng);
  var hourMin = hour * 60;
  var inMajorH = inWindow(hourMin, sol.major1.start, sol.major1.end) ||
                 inWindow(hourMin, sol.major2.start, sol.major2.end);
  var inMinorH = inWindow(hourMin, sol.minor1.start, sol.minor1.end) ||
                 inWindow(hourMin, sol.minor2.start, sol.minor2.end);
  if (inMajorH)      score += 3;
  else if (inMinorH) score += 1;

  // Weather
  if (wxHour) {
    var t = wxHour.temp;
    var tBase = t<=0 ? 4 : t<=8 ? 6 : t<=14 ? 3 : t<=18 ? 0 : -3;
    // Frost bonus in hourly: if at/below freezing add extra push
    var tFrost = (t <= 0) ? 3 : (t <= 1) ? 1 : 0;
    score += tBase + tFrost;
    var wkm = wxHour.wind * 0.621; // convert km/h → mph before scoring
    score += wkm<=8 ? 6 : wkm<=20 ? 3 : wkm<=35 ? -2 : -5;
    // Wind consistency: gusty = scent unreliable (only if sustained wind > 5mph)
    if (wxHour.gustRatio !== undefined && wkm > 5) {
      score += wxHour.gustRatio > 0.8 ? -4
             : wxHour.gustRatio > 0.5 ? -2
             : wxHour.gustRatio > 0.3 ? -1
             : wxHour.gustRatio <= 0.15 ? 1 : 0;
    }
    // Post-rain: deer move freely once rain stops (+4). During rain: light +2, heavy -4
    if (wxHour.postRain)          score += 4;
    else if (wxHour.precip > 5)   score += -4;
    else if (wxHour.precip > 0.5) score += 2;
    else                          score += 1;
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Build one hour's weather object from the 7-day Open-Meteo payload. Factored
 * out of buildHourlyPanel so the home card's "next best window" score uses the
 * IDENTICAL inputs as the daily breakdown — the two can never disagree again.
 */
function flExtractWxHour(wxData, dayIdx, h) {
  if (!wxData || !wxData.hourly) return null;
  var hIdx = dayIdx * 24 + h;
  var temps = wxData.hourly.temperature_2m;
  if (!temps || hIdx < 0 || hIdx >= temps.length) return null;
  var winds = wxData.hourly.wind_speed_10m;
  var dirs = wxData.hourly.wind_direction_10m;
  var precips = wxData.hourly.precipitation_probability;
  var codes = wxData.hourly.weather_code;
  var hPrecipArr = wxData.hourly.precipitation;
  var gusts = wxData.hourly.windgusts_10m;
  var hPrecipNow = hPrecipArr ? (hPrecipArr[hIdx] || 0) : 0;
  var hPrecip1ago = hPrecipArr ? (hPrecipArr[Math.max(0, hIdx - 1)] || 0) : 0;
  var hPrecip2ago = hPrecipArr ? (hPrecipArr[Math.max(0, hIdx - 2)] || 0) : 0;
  var hWind = winds ? winds[hIdx] : null;
  var hGust = gusts ? gusts[hIdx] : null;
  var hGustRatio = (hWind > 2 && hGust) ? (hGust - hWind) / hWind : 0;
  return {
    temp: Math.round(temps[hIdx]),
    wind: hWind,
    gust: hGust,
    gustRatio: hGustRatio,
    dir: dirs ? dirs[hIdx] : null,
    precipP: precips ? precips[hIdx] : null,
    precip: hPrecipNow,
    postRain: (hPrecipNow < 0.1) && (Math.max(hPrecip1ago, hPrecip2ago) > 0.5),
    code: codes ? codes[hIdx] : null
  };
}

/**
 * The activity % for a dawn/dusk window's peak hour, scored EXACTLY as the
 * daily breakdown scores that hour (same hourlyActivityScore + same wx). So
 * the home card's "Next best window · 51%" always equals the breakdown row.
 * dayOffset: 0 = today, 1 = tomorrow (for "Dawn tomorrow").
 */
function flWindowActivityPct(wxData, peakMin, dayOffset) {
  var h = Math.round(peakMin / 60);
  if (h < 0) h = 0; else if (h > 23) h = 23;
  var d = new Date(flNow());
  d.setDate(d.getDate() + (dayOffset || 0));
  d.setHours(0, 0, 0, 0);
  return hourlyActivityScore(h, d, flExtractWxHour(wxData, dayOffset || 0, h));
}

function buildHourlyPanel(dayIdx, date, wxData, legalStartMin, legalEndMin) {
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var isToday = dayIdx === 0;
  var dateLabel = (isToday ? 'Today' : dayNames[date.getDay()]) + ' ' + date.getDate() + ' ' + months[date.getMonth()];
  var lsLabel = fmtMins(legalStartMin) + ' \u2013 ' + fmtMins(legalEndMin);

  var html = '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:rgba(200,168,75,0.6);margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">'
    + '<span>Legal shooting window \u00b7 ' + dateLabel + '</span>'
    + '<span style="font-size:8px;background:rgba(200,168,75,0.12);border:1px solid rgba(200,168,75,0.2);border-radius:10px;padding:2px 8px;color:#c8a84b;">' + lsLabel + '</span>'
    + '</div>';

  // Column headers
  html += '<div style="display:grid;grid-template-columns:40px 1fr 40px 58px 40px 30px 34px;gap:4px;padding:0 0 6px;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:4px;">'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);">Time</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">\uD83E\uDD8C Activity</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">\uD83C\uDF21</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">\uD83C\uDF43 Wind</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">Dir</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">\u2601\uFE0E</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">\uD83C\uDF27</div>'
    + '</div>';

  // Build hour rows within legal window
  var startHour = Math.floor(legalStartMin / 60);
  var endHour   = Math.ceil(legalEndMin / 60);
  var srMin = bannerState.sunriseMin !== null ? bannerState.sunriseMin : 6*60;
  var ssMin = bannerState.sunsetMin  !== null ? bannerState.sunsetMin  : 20*60;
  var dawnStart = srMin - 60, dawnEnd = srMin + 120;
  var duskStart = ssMin - 90, duskEnd = ssMin + 45;

  for (var h = startHour; h <= endHour; h++) {
    var hourMin = h * 60;
    // Skip if outside legal window
    if (hourMin > legalEndMin + 59) break;

    var isDawn = (hourMin >= dawnStart && hourMin <= dawnEnd);
    var isDusk = (hourMin >= duskStart && hourMin <= duskEnd);
    var isLegal = (hourMin >= legalStartMin && hourMin <= legalEndMin);

    // Get hourly wx data (shared with the home card's window score so they match)
    var wxHour = flExtractWxHour(wxData, dayIdx, h);

    var actScore = hourlyActivityScore(h, date, wxHour);
    var barClr = actScore >= 65 ? 'linear-gradient(90deg,#3abf3a,#7aef7a)'
               : actScore >= 45 ? 'linear-gradient(90deg,#c8a84b,#e0c050)'
               : 'linear-gradient(90deg,#e07020,#e09040)';
    var timeColor = isLegal
      ? (isDawn ? '#f0c870' : isDusk ? '#f09850' : 'rgba(255,255,255,0.7)')
      : 'rgba(255,255,255,0.35)';
    var rowBg = isDawn ? 'rgba(240,192,64,0.07)' : isDusk ? 'rgba(240,144,32,0.07)' : 'transparent';
    var borderLeft = isDawn ? '3px solid rgba(240,192,64,0.5)' : isDusk ? '3px solid rgba(240,144,32,0.5)' : '3px solid transparent';

    var tempStr = wxHour ? wxHour.temp + '\u00b0C' : '\u2013';
    var windStr = wxHour && wxHour.wind !== null ? Math.round(wxHour.wind * 0.621) + ' mph' : '\u2013';
    var dirStr  = wxHour && wxHour.dir  !== null ? windDirArrow(wxHour.dir) : '\u2013';
    var skyStr  = wxHour ? wxCodeToEmoji(wxHour.code, 0) : '\u2013';
    var precipStr = wxHour && wxHour.precipP !== null
      ? (wxHour.precipP === 0 ? '<span style="color:rgba(255,255,255,0.25);">Dry</span>'
        : '<span style="color:' + (wxHour.precipP >= 60 ? '#e07020' : wxHour.precipP >= 30 ? '#f0c040' : 'rgba(255,255,255,0.5)') + ';">' + wxHour.precipP + '%</span>')
      : '\u2013';

    // Special row for legal window close
    if (h === endHour) {
      html += '<div style="display:grid;grid-template-columns:40px 1fr;gap:4px;padding:6px 0;">'
        + '<div style="font-size:9px;color:rgba(255,255,255,0.3);font-variant-numeric:tabular-nums;">' + fmtMins(legalEndMin) + '</div>'
        + '<div style="font-size:9px;font-weight:600;color:#c8a84b;border-top:1px solid rgba(200,168,75,0.25);padding-top:4px;">Legal window closes</div>'
        + '</div>';
      break;
    }

    html += '<div style="display:grid;grid-template-columns:40px 1fr 40px 58px 40px 30px 34px;gap:4px;padding:6px 0 6px 4px;border-bottom:1px solid rgba(255,255,255,0.04);background:' + rowBg + ';border-left:' + borderLeft + ';border-radius:4px;margin:0 -4px;">'
      + '<div style="font-size:12px;font-weight:700;color:' + timeColor + ';font-variant-numeric:tabular-nums;">' + (h < 10 ? '0'+h : h) + ':00</div>'
      + '<div style="display:flex;flex-direction:column;gap:2px;padding-right:4px;">'
        + '<div style="height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">'
          + '<div style="height:100%;border-radius:3px;background:' + barClr + ';width:' + actScore + '%;"></div>'
        + '</div>'
        + '<div style="font-size:8px;color:rgba(255,255,255,0.4);font-variant-numeric:tabular-nums;">' + actScore + '%</div>'
      + '</div>'
      + '<div style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.75);text-align:center;">' + tempStr + '</div>'
      + '<div style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.75);text-align:center;">' + windStr + '</div>'
      + '<div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.6);text-align:center;">' + dirStr + '</div>'
      + '<div style="font-size:13px;text-align:center;">' + skyStr + '</div>'
      + '<div style="font-size:10px;font-weight:600;text-align:center;">' + precipStr + '</div>'
      + '</div>';
  }

  html += '<div style="font-size:9px;color:rgba(255,255,255,0.2);margin-top:8px;text-align:center;">Hourly weather \u00b7 Open-Meteo \u00b7 Activity score per hour</div>';
  return html;
}

function buildWeekForecast(wxData) {
  var panel = document.getElementById('week-forecast-panel');
  var rowsEl = document.getElementById('wf-rows');
  var heroDay = document.getElementById('wf-hero-day');
  var heroWindow = document.getElementById('wf-hero-window');
  var heroScore = document.getElementById('wf-hero-score');
  var heroLabel = document.getElementById('wf-hero-label');
  var heroPills = document.getElementById('wf-hero-pills');
  if (!panel || !rowsEl) return;
  if (wxData) flLast7dayWx = wxData; // cache for species-change re-render

  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var today = flNow();
  var results = [];

  for (var i = 0; i < 7; i++) {
    var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    var wxDay = null;
    if (wxData && wxData.daily) {
      var _pArr  = wxData.daily.surface_pressure_mean;
      var _gArr  = wxData.daily.wind_gusts_10m_max;
      wxDay = {
        tempMax:      wxData.daily.temperature_2m_max[i],
        tempMin:      wxData.daily.temperature_2m_min[i],
        windMax:      wxData.daily.wind_speed_10m_max[i],
        gustMax:      _gArr ? _gArr[i] : null,
        precip:       wxData.daily.precipitation_sum[i],
        wcode:        wxData.daily.weather_code[i],
        pressure:     _pArr ? _pArr[i]         : null,
        prevPressure: _pArr && i > 0 ? _pArr[i-1] : (_pArr ? _pArr[0] : null)
      };
    }
    var s = scoreDay(d, wxDay);
    if (s) results.push({ date: d, day: i, s: s });
  }

  if (!results.length) return;

  // Find best day — skip today if both windows already passed
  var nowMin = ukNowMin();
  var bestIdx = -1;
  var bestScore = -1;
  results.forEach(function(r, i) {
    var effectiveScore = r.s.bestScore;
    if (i === 0) {
      var ss2 = bannerState.sunsetMin !== null ? bannerState.sunsetMin : 20 * 60;
      if (nowMin > ss2 + 45) effectiveScore = 0; // dusk window passed
    }
    if (effectiveScore > bestScore) {
      bestScore = effectiveScore;
      bestIdx = i;
    }
  });
  if (bestIdx < 0) bestIdx = 0;
  var best = results[bestIdx];

  // ── Hero ──────────────────────────────────────────────────
  if (heroDay) heroDay.textContent = days[best.date.getDay()] + ' ' + best.date.getDate() + ' ' + months[best.date.getMonth()];
  if (heroWindow) heroWindow.textContent = best.s.bestWindow + ' · ' +
    (best.s.bestWindow === 'Dawn' ? best.s.dawnTime : best.s.duskTime) + ' peak';
  if (heroScore) heroScore.textContent = best.s.bestScore + '%';
  if (heroLabel) {
    heroLabel.textContent = best.s.bestScore >= 65 ? 'High Activity'
      : best.s.bestScore >= 45 ? 'Moderate'
      : best.s.bestScore >= 20 ? 'Low Activity' : 'Minimal Activity';
  }

  // Hero pills
  if (heroPills) {
    heroPills.innerHTML = '';
    var pillData = [
      { label: best.s.moon.name, bg: 'rgba(255,255,200,0.1)', color: 'rgba(255,255,200,0.8)', border: 'rgba(255,255,200,0.15)' },
    ];
    if (best.s.wxDay) {
      var avgT = Math.round((best.s.wxDay.tempMax + best.s.wxDay.tempMin) / 2);
      var tMaxH = Math.round(best.s.wxDay.tempMax);
      var tMinH = Math.round(best.s.wxDay.tempMin);
      pillData.push({ ic: 'fl-temp', label: tMinH + '–' + tMaxH + '°C', bg: avgT <= 10 ? 'rgba(90,180,255,0.12)' : 'rgba(255,140,60,0.1)', color: avgT <= 10 ? 'rgba(150,210,255,0.85)' : 'rgba(255,180,100,0.85)', border: 'rgba(90,180,255,0.15)' });
      var windMph = Math.round(best.s.wxDay.windMax * 0.621);
      pillData.push({ ic: 'fl-wind', label: windMph + ' mph', bg: windMph < 10 ? 'rgba(90,220,90,0.1)' : 'rgba(255,200,60,0.1)', color: windMph < 10 ? 'rgba(122,223,122,0.85)' : 'rgba(255,220,100,0.85)', border: 'rgba(90,220,90,0.15)' });
    }
    var rutM = RUT_CALENDAR[best.date.getMonth()+1] || [0,0,0,0,0];
    var _heroMask = rutMaskForSpecies(flMySpecies());
    if (maxRutMasked(rutM, _heroMask) >= 10) {
      var rutNames = RUT_SPECIES.filter(function(_,i){ return rutM[i]>=10 && _heroMask[i]; });
      if (rutNames.length) pillData.push({ ic: 'fl-deer', label: rutNames[0] + ' rut', bg: 'rgba(200,100,50,0.1)', color: 'rgba(240,160,100,0.9)', border: 'rgba(200,100,50,0.2)' });
    }
    pillData.forEach(function(p) {
      var pill = document.createElement('div');
      pill.style.cssText = 'font-size:10px;font-weight:600;padding:4px 10px;border-radius:20px;background:' + p.bg + ';color:' + p.color + ';border:1px solid ' + p.border + ';';
      if (p.ic) {
        var _pi = document.createElement('span');
        _pi.className = 'fl-ic ' + p.ic;
        pill.appendChild(_pi);
        pill.appendChild(document.createTextNode(' ' + p.label));
      } else {
        pill.textContent = p.label;
      }
      heroPills.appendChild(pill);
    });
  }

  // ── Rows ──────────────────────────────────────────────────
  rowsEl.innerHTML = '';
  var lsMin = bannerState.legalStartMin !== null ? bannerState.legalStartMin : 5*60;
  var leMin = bannerState.legalEndMin   !== null ? bannerState.legalEndMin   : 19*60;

  results.forEach(function(r, i) {
    var isToday = i === 0;
    var isBest  = i === bestIdx;
    var row = document.createElement('div');
    row.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;';

    var scoreColor = r.s.bestScore >= 65 ? '#7adf7a' : r.s.bestScore >= 45 ? '#f0c040' : '#e07020';
    var barColor   = r.s.bestScore >= 65 ? 'linear-gradient(90deg,#3abf3a,#7aef7a)'
                   : r.s.bestScore >= 45 ? 'linear-gradient(90deg,#c8a84b,#e0c050)'
                   : 'linear-gradient(90deg,#e07020,#e09040)';
    var dayLabel = isToday ? 'Today' : days[r.date.getDay()];
    var dayColor = isToday ? '#f0c870' : isBest ? '#7adf7a' : 'rgba(255,255,255,0.45)';
    var rowBg    = isBest ? 'rgba(90,220,90,0.05)' : isToday ? 'rgba(200,168,75,0.05)' : 'transparent';

    // Weather summary line — show min/max range, not average
    var wxSummary = '';
    if (r.s.wxDay) {
      var tMax = Math.round(r.s.wxDay.tempMax);
      var tMin = Math.round(r.s.wxDay.tempMin);
      var wMph  = Math.round(r.s.wxDay.windMax * 0.621);
      var precip2 = r.s.wxDay.precip || 0;
      var skyEmoji = wxCodeToEmoji(r.s.wxDay.wcode, precip2);
      var pEmoji   = precipEmoji(precip2);
      var pLabel   = precip2 <= 0 ? '0.0 mm' : precip2.toFixed(1) + ' mm';
      wxSummary = '<div style="display:flex;gap:10px;padding:0 16px 10px 56px;flex-wrap:wrap;">'
        + '<span style="display:flex;align-items:center;gap:3px;font-size:10px;color:rgba(255,255,255,0.45);"><span><span class="fl-ic fl-temp"></span></span><span style="font-weight:600;color:rgba(255,255,255,0.7);">' + tMin + '–' + tMax + '°C</span></span>'
        + '<span style="display:flex;align-items:center;gap:3px;font-size:10px;color:rgba(255,255,255,0.45);"><span><span class="fl-ic fl-wind"></span></span><span style="font-weight:600;color:rgba(255,255,255,0.7);">' + wMph + ' mph max</span></span>'
        + '<span style="display:flex;align-items:center;gap:3px;font-size:10px;color:rgba(255,255,255,0.45);"><span>' + skyEmoji + '</span><span style="font-weight:600;color:rgba(255,255,255,0.7);">' + conditionLabel(r.s.wxDay.wcode, precip2) + '</span></span>'
        + '<span style="display:flex;align-items:center;gap:3px;font-size:10px;color:rgba(255,255,255,0.45);"><span>' + pEmoji + '</span><span style="font-weight:600;color:rgba(255,255,255,0.7);">' + pLabel + ' total</span></span>'
        + '</div>';
    }

    // Legal window for hourly panel: today = bannerState (same as main banner); other days = solar calc
    var dayLsMin = lsMin, dayLeMin = leMin;
    if (i > 0) {
      try {
        var sr2 = calcSunTime(r.date, bannerState.lat || 52, bannerState.lng || 0, true);
        var ss2 = calcSunTime(r.date, bannerState.lat || 52, bannerState.lng || 0, false);
        if (sr2 && ss2) {
          dayLsMin = toMinutes(sr2) - 60;
          dayLeMin = toMinutes(ss2) + 60;
        }
      } catch(e) {}
    }

    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:10px 16px 6px;background:' + rowBg + ';">' +
        '<div style="width:36px;flex-shrink:0;">' +
          '<div style="font-size:10px;font-weight:700;color:' + dayColor + ';text-transform:uppercase;">' + dayLabel + '</div>' +
          '<div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.8);">' + r.date.getDate() + '</div>' +
        '</div>' +
        '<div style="width:18px;flex-shrink:0;font-size:14px;text-align:center;">' + r.s.moon.icon + '</div>' +
        '<div style="flex:1;display:flex;flex-direction:column;gap:3px;">' +
          '<div style="display:flex;align-items:center;gap:5px;">' +
            '<div style="font-size:8px;color:rgba(255,255,255,0.25);width:28px;flex-shrink:0;">Dawn</div>' +
            '<div style="flex:1;height:5px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">' +
              '<div style="height:100%;border-radius:3px;background:' + barColor + ';width:' + r.s.dawnScore + '%;"></div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:5px;">' +
            '<div style="font-size:8px;color:rgba(255,255,255,0.25);width:28px;flex-shrink:0;">Dusk</div>' +
            '<div style="flex:1;height:5px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">' +
              '<div style="height:100%;border-radius:3px;background:' + barColor + ';opacity:0.7;width:' + r.s.duskScore + '%;"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="width:34px;flex-shrink:0;text-align:right;font-size:13px;font-weight:700;color:' + scoreColor + ';font-variant-numeric:tabular-nums;">' + r.s.bestScore + '%</div>' +
        '<div style="width:16px;flex-shrink:0;text-align:center;font-size:10px;color:rgba(255,255,255,0.2);transition:transform 0.2s;" class="wf-chevron">\u25be</div>' +
      '</div>' +
      wxSummary +
      '<div class="wf-hourly" style="display:none;background:rgba(0,0,0,0.25);border-top:1px solid rgba(255,255,255,0.06);padding:12px 16px;">' +
        buildHourlyPanel(i, r.date, wxData, dayLsMin, dayLeMin) +
      '</div>';

    // Toggle hourly on tap
    (function(rowEl, chevronIdx) {
      rowEl.addEventListener('click', function() {
        var hourlyEl = rowEl.querySelector('.wf-hourly');
        var chevEl   = rowEl.querySelector('.wf-chevron');
        var isOpen   = hourlyEl.style.display !== 'none';
        hourlyEl.style.display = isOpen ? 'none' : 'block';
        if (chevEl) chevEl.style.transform = isOpen ? '' : 'rotate(180deg)';
      });
    })(row, i);

    rowsEl.appendChild(row);
  });
  if (rowsEl.lastChild) rowsEl.lastChild.style.borderBottom = 'none';
}

function toggleWeekForecast() {
  var panel = document.getElementById('week-forecast-panel');
  if (!panel) return;
  var isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    var bs = bannerState;
    if (bs.lat === null) return;
    buildWeekForecast(null);
    fetch7DayWeather(bs.lat, bs.lng, function(err, d) {
      if (!err && d) buildWeekForecast(d);
    });
  }
}
var _tickCount = 0;
function tick() {
  _tickCount++;
  updateBannerClock();
  // Recompute solar/legal state every tick. maybeRecalcSolar() early-returns
  // unless the Europe/London minute actually changed, so this is cheap — but it
  // now fires exactly at the minute boundary instead of an arbitrary ~60s phase
  // (M10: "Legal to shoot" no longer lingers up to ~60s past close, and the
  // post-midnight "until legal" countdown no longer briefly reads ~30h).
  maybeRecalcSolar();
  if (_tickCount % 60 === 0) {   // every 60 seconds
    updateMoon();
    // Refresh activity panel if open
    var ap = document.getElementById('activity-panel');
    if (ap && ap.style.display !== 'none') updateActivityPanel();
  }
}

// A module script is deferred, so lib/fl-deer-seasons.js is on the global
// before DOMContentLoaded fires and the boot below already sees it. This
// listener costs nothing and covers the case where it is not: the season rows,
// the card badges and the calendar all redraw the moment the source arrives.
document.addEventListener('fl-deer-seasons-ready', function() {
  if (document.readyState === 'loading') return;   // boot will do it in a moment
  updateSeasonStatuses();
  initCalendar();
  flStampDataCurrency();
});

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  (async function() {
  await syncTrustedUkClock();
  ui.updateOfflineBanner();
  updateMoon();
  highlightTodayMonth();
  updateSeasonStatuses();
  if (!flUkClockReady) {
    ui.showLocationPrompt('UK time sync unavailable — connect to internet');
  }
  initBanner();
  initCalendar();
  flStampDataCurrency();
  setInterval(tick, 1000);

  var ldp = document.getElementById('legal-date-picker');
  if (ldp) {
    ldp.addEventListener('change', refreshLegalDatePicker);
    ldp.addEventListener('input', refreshLegalDatePicker);
  }
  initLegalDatePickerUi();
  refreshLegalDatePicker();

  // ── Banner date ──────────────────────────────────────────────
  (function() {
    var now = flNow();
    var bday   = document.getElementById('banner-date-day');
    var bnum   = document.getElementById('banner-date-num');
    var bmonth = document.getElementById('banner-date-month');
    var byear  = document.getElementById('banner-date-year');
    if (bday)   bday.textContent   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()];
    if (bnum)   bnum.textContent   = now.getDate();
    if (bmonth) bmonth.textContent = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][now.getMonth()];
    if (byear)  byear.textContent  = now.getFullYear();
  }());

  // First-launch disclaimer
  try {
    if (!localStorage.getItem('firstlight_disclaimer_seen')) {
      var fm = document.getElementById('first-launch-modal');
      if (fm) fm.style.display = 'flex';
    }
  } catch(e) {}

  var acceptBtn = document.getElementById('first-launch-accept');
  if (acceptBtn) {
    acceptBtn.addEventListener('click', function() {
      try { localStorage.setItem('firstlight_disclaimer_seen', 'true'); } catch(e) {}
      var fm = document.getElementById('first-launch-modal');
      if (fm) fm.style.display = 'none';
    });
  }

  // Keyboard support for deer cards
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      var header = e.target.closest('.card-header');
      if (header) { e.preventDefault(); toggleCard(header.closest('.deer-card')); }
    }
  });
  })();
});

// ════════════════════════════════════════════════════════════════
// FEATURE 1: DEER ACTIVITY FORECAST
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// FEATURE 1: DEER ACTIVITY FORECAST — enhanced multi-factor model
// Factors: time of day, moon phase, solunar, rut calendar,
//          temperature, barometric pressure, wind speed,
//          seasonal body condition
// ════════════════════════════════════════════════════════════════

// Rut calendar: peak activity boost per species per month (0=none, 30=peak)
// Species: [Red, Fallow, Sika, Roe, CWD]
// Sources: BDS, BASC, Deer Initiative; Sika Oct/Nov shaped to Scotland Wild Deer BPG
// (peak rutting mid Sep–end Oct) + BDS regional late-rut notes (activity into Nov).
var RUT_SPECIES = ['Red', 'Fallow', 'Sika', 'Roe', 'CWD'];
var RUT_CALENDAR = {
  1:  [0,  0,  0,  0,  15],
  2:  [0,  0,  0,  0,  5 ],
  3:  [0,  0,  0,  0,  0 ],
  4:  [0,  0,  0,  0,  0 ],
  5:  [0,  0,  0,  5,  0 ],
  6:  [0,  0,  0,  15, 0 ],
  7:  [0,  0,  0,  30, 0 ],
  8:  [5,  0,  0,  20, 0 ],
  9:  [20, 5,  5,  0,  0 ],
  10: [30, 30, 30, 0,  0 ],
  11: [15, 20, 15, 0,  20],
  12: [0,  5,  15, 0,  30],
};

// Species-aware rut masking (SPEC pair with lib/fl-forecast.mjs — keep bodies identical).
// RUT_CALENDAR column order is [Red, Fallow, Sika, Roe, CWD]. Muntjac breeds year-round
// (no rut) so it is deliberately absent — a Muntjac-only ground gets no rut boost.
var RUT_INDEX_BY_SPECIES = { 'Red Deer': 0, 'Fallow': 1, 'Sika': 2, 'Roe Deer': 3, 'CWD': 4 };
function rutMaskForSpecies(present) {
  if (!present || !present.length) return [true, true, true, true, true];
  var m = [false, false, false, false, false];
  for (var i = 0; i < present.length; i++) {
    var idx = RUT_INDEX_BY_SPECIES[present[i]];
    if (idx != null) m[idx] = true;
  }
  return m;
}
function maxRutMasked(rutMonths, mask) {
  var x = 0;
  for (var i = 0; i < 5; i++) if (mask[i] && rutMonths[i] > x) x = rutMonths[i];
  return x;
}
// Homepage reads the user's ground species from localStorage (shared origin with the
// Diary, which owns the setting UI). Empty/absent = all species = current behaviour.
function flMySpecies() {
  try {
    var raw = localStorage.getItem('fl-my-species-v1');
    if (!raw) return [];
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

// Cached weather data
var _weatherCache = { data: null, ts: 0, lat: null, lng: null };

// Fetch weather from Open-Meteo (free, no API key)
function fetchWeather(lat, lng, cb) {
  var now = Date.now();
  // Cache for 20 minutes or same location
  if (_weatherCache.data && (now - _weatherCache.ts < 20*60*1000)
      && _weatherCache.lat === lat && _weatherCache.lng === lng) {
    return cb(null, _weatherCache.data);
  }
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat
    + '&longitude=' + lng
    + '&current=temperature_2m,wind_speed_10m,wind_direction_10m,windgusts_10m,surface_pressure,cloud_cover,weather_code,precipitation'
    + '&hourly=surface_pressure,precipitation,temperature_2m&past_hours=6&forecast_days=1&timezone=auto';
  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var c = d.current;
      // Get pressure 3 hours ago from hourly to compute trend
      var pressures = (d.hourly && d.hourly.surface_pressure) ? d.hourly.surface_pressure : [];
      var curHour = ukNowHour(); // UK time — matches Open-Meteo timezone=auto=Europe/London
      // With past_hours=6, array index = past_hours_offset + hour_of_day
      // Index 0..5 = yesterday's last 6hrs, index 6 = today 00:00, index 6+curHour = now
      var PAST = 6; // must match past_hours in URL
      var pNow  = pressures[PAST + curHour] || pressures[curHour] || c.surface_pressure;
      var p3ago = pressures[PAST + curHour - 3] || pressures[Math.max(0, curHour - 3)] || pNow;
      var pressureTrend = pNow - p3ago; // positive = rising, negative = falling
      // Post-rain detection: was it raining 1-2 hrs ago but not now?
      var precipHourly = (d.hourly && d.hourly.precipitation) ? d.hourly.precipitation : [];
      var precip1hAgo  = precipHourly[PAST + curHour - 1] || 0;
      var precip2hAgo  = precipHourly[PAST + curHour - 2] || 0;
      var recentRain   = Math.max(precip1hAgo, precip2hAgo);
      var postRain     = (c.precipitation < 0.1) && (recentRain > 0.5);
      // Temperature drop: compare now vs 6 hours ago using past_hours offset
      var temps6h       = (d.hourly && d.hourly.temperature_2m) ? d.hourly.temperature_2m : [];
      var tempNow       = c.temperature_2m;
      // PAST offset: index PAST+curHour = now, index PAST+curHour-6 = 6hrs ago (always valid ≥0)
      var temp6hAgo     = temps6h[PAST + curHour - 6] !== undefined ? temps6h[PAST + curHour - 6] : tempNow;
      var tempDrop6h    = temp6hAgo - tempNow; // positive = temp has fallen
      // Frost: sub-zero in last 6hrs (past_hours window gives full 6hr history)
      var tempMin6h     = temps6h.slice(PAST + curHour - 6, PAST + curHour + 1).reduce(function(a,b){ return Math.min(a, b !== undefined ? b : 99); }, 99);
      var isFrost       = tempNow <= 1; // near-freezing or below (tempMin6h used only for wx object completeness)
      // Wind consistency: gust vs sustained ratio — swirling wind disrupts scent control
      var windSustained = c.wind_speed_10m || 0;
      var windGust      = c.windgusts_10m  || windSustained;
      var gustRatio     = windSustained > 2 ? (windGust - windSustained) / windSustained : 0;
      // gustRatio: 0 = perfectly steady, 1.0 = gusts double sustained (very gusty)
      var wx = {
        temp:          c.temperature_2m,
        tempDrop6h:    tempDrop6h,
        isFrost:       isFrost,
        windSpeed:     c.wind_speed_10m,   // km/h
        windGust:      windGust,           // km/h
        windDir:       c.wind_direction_10m,
        gustRatio:     gustRatio,
        pressure:      c.surface_pressure,
        pressureTrend: pressureTrend,
        cloudCover:    c.cloud_cover,
        weatherCode:   c.weather_code,
        precipitation: c.precipitation,
        postRain:      postRain,
        recentRainMm:  recentRain
      };
      _weatherCache = { data: wx, ts: Date.now(), lat: lat, lng: lng };
      cb(null, wx);
    })
    .catch(function(e) { cb(e, null); });
}

// Solunar calculation — moon overhead/underfoot periods
// Based on gravitational pull theory (Knight 1936, supported by Demarais et al)
function getSolunar(date, lat, lng) {
  var moon = getMoonPhase(date);
  // Moon transit time: shifts ~50 min later each day from solar noon at new moon
  // Each lunar day = 24h 50min = 1490 min, so transit moves 50 min/day
  var SHIFT_PER_DAY = 50; // minutes per day
  var transitMin    = (12 * 60 + moon.age * SHIFT_PER_DAY) % (24 * 60);
  var underfootMin  = (transitMin + 12 * 60 + 25) % (24 * 60);
  // Major periods: ±60 min around transit and underfoot (2hr window each)
  // Minor periods: midpoints between majors (±30 min = 1hr window each)
  var minor1 = (transitMin   + 6 * 60 + 12) % (24 * 60);
  var minor2 = (underfootMin + 6 * 60 + 12) % (24 * 60);
  return {
    major1: { start: (transitMin   - 60 + 1440) % 1440, peak: transitMin,   end: (transitMin   + 60) % 1440 },
    major2: { start: (underfootMin - 60 + 1440) % 1440, peak: underfootMin, end: (underfootMin + 60) % 1440 },
    minor1: { start: (minor1 - 30 + 1440) % 1440, peak: minor1, end: (minor1 + 30) % 1440 },
    minor2: { start: (minor2 - 30 + 1440) % 1440, peak: minor2, end: (minor2 + 30) % 1440 }
  };
}

function fmtMins(m) {
  if (m === null || m === undefined) return '--:--';
  var mm = ((Math.round(m) % 1440) + 1440) % 1440;
  var h = Math.floor(mm / 60), mn = mm % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mn < 10 ? '0' : '') + mn;
}

function getDeerActivityScore(wx) {
  var now = flNow();
  var month = now.getMonth() + 1;
  var moon = getMoonPhase(now);
  var bs = bannerState;
  var score = 0;
  var factors = [];
  var wxFactors = []; // weather factors shown in strip separately

  // ── Time of day (max 40pts) ──────────────────────────────
  var curMin = ukNowMin();
  var srMin = bs.sunriseMin !== null ? bs.sunriseMin : (6 * 60);
  var ssMin = bs.sunsetMin  !== null ? bs.sunsetMin  : (20 * 60);

  var dawnStart = srMin - 60;
  var dawnEnd   = srMin + 120;
  var duskStart = ssMin - 90;
  var duskEnd   = ssMin + 45;  // 45 mins after sunset

  var SVG_DAWN = '<svg width="18" height="14" viewBox="0 0 28 22" xmlns="http://www.w3.org/2000/svg" style="display:inline;vertical-align:middle;"><path d="M0,22 Q4,14 8,16 Q11,18 14,13 Q17,8 20,12 Q23,15 28,11 L28,22 Z" fill="#3a5a2a" opacity="0.85"/><path d="M0,22 Q5,17 9,19 Q13,21 16,17 Q19,14 24,18 Q26,19 28,17 L28,22 Z" fill="#2a4a1a" opacity="0.9"/><circle cx="14" cy="13" r="5" fill="#f5b830" opacity="0.95"/><g stroke="#f5b830" stroke-width="1.2" stroke-linecap="round" opacity="0.7"><line x1="14" y1="6" x2="14" y2="4"/><line x1="18.5" y1="7.5" x2="19.8" y2="6.2"/><line x1="9.5" y1="7.5" x2="8.2" y2="6.2"/></g></svg>';
  var SVG_DUSK = '<svg width="18" height="14" viewBox="0 0 28 22" xmlns="http://www.w3.org/2000/svg" style="display:inline;vertical-align:middle;"><ellipse cx="14" cy="16" rx="12" ry="4" fill="#e06010" opacity="0.3"/><circle cx="14" cy="16" r="5" fill="#e87820" opacity="0.95"/><path d="M0,22 Q4,13 8,15 Q11,17 14,12 Q17,7 20,11 Q23,14 28,10 L28,22 Z" fill="#2a3a1a" opacity="0.9"/><path d="M0,22 Q5,16 9,18 Q13,20 16,16 Q19,13 24,17 Q26,18 28,16 L28,22 Z" fill="#1a2a0f" opacity="0.95"/></svg>';

  if (inWindow(curMin, dawnStart, dawnEnd)) {
    score += 40;
    factors.push({ icon: SVG_DAWN, text: 'Dawn window — peak deer movement', good: true });
  } else if (inWindow(curMin, duskStart, duskEnd)) {
    score += 40;
    factors.push({ icon: SVG_DUSK, text: 'Dusk window — peak deer movement', good: true });
  } else if (inWindow(curMin, dawnEnd, duskStart)) {
    score += 8;
    factors.push({ icon: '<span class="fl-ic fl-wx-sun"></span>', text: 'Midday — deer movement reduced', good: false });
  } else {
    score += 8; // Night: new moon / rut / weather can still push score meaningfully
    factors.push({ icon: '<span class="fl-ic fl-moon-wancres"></span>', text: 'Night — deer resting, minimal movement', good: false });
  }
  var isNight = !inWindow(curMin, dawnStart, duskEnd);

  // ── Moon phase (max 15pts) ───────────────────────────────
  // Moon phase — reduced weights (peer-reviewed studies show modest daytime effect)
  var moonBoost, moonIcon, moonText, moonGood;
  if (moon.illumination < 15) {
    moonBoost = 8; moonIcon = '<span class="fl-ic fl-moon-new"></span>'; moonGood = true;
    moonText = 'New moon (' + moon.illumination + '% lit) — low overnight feeding, deer keener at dawn & dusk';
  } else if (moon.illumination < 40) {
    moonBoost = 6; moonIcon = '<span class="fl-ic fl-moon-waxcres"></span>'; moonGood = true;
    moonText = 'Crescent moon (' + moon.illumination + '% lit) — favourable conditions';
  } else if (moon.illumination < 60) {
    moonBoost = 4; moonIcon = '<span class="fl-ic fl-moon-firstq"></span>'; moonGood = null;
    moonText = 'Quarter moon (' + moon.illumination + '% lit) — average movement';
  } else if (moon.illumination < 85) {
    moonBoost = 2; moonIcon = '<span class="fl-ic fl-moon-waxgibb"></span>'; moonGood = null;
    moonText = 'Gibbous moon (' + moon.illumination + '% lit) — some nocturnal feeding likely';
  } else {
    moonBoost = 1; moonIcon = '<span class="fl-ic fl-moon-full"></span>'; moonGood = false;
    moonText = 'Full moon (' + moon.illumination + '% lit) — deer may have fed overnight, daytime movement reduced';
  }
  score += isNight ? Math.round(moonBoost * 0.3) : moonBoost;
  factors.push({ icon: moonIcon, text: moonText, good: moonGood });

  // ── Solunar (max 8pts) ───────────────────────────────────
  var sol = getSolunar(now, bs.lat || 52, bs.lng || 0);
  var inMajor = inWindow(curMin, sol.major1.start, sol.major1.end) ||
                inWindow(curMin, sol.major2.start, sol.major2.end);
  var inMinor = inWindow(curMin, sol.minor1.start, sol.minor1.end) ||
                inWindow(curMin, sol.minor2.start, sol.minor2.end);
  // Solunar — reduced (major +3, minor +1; gravitational effect on deer contested)
  if (inMajor) {
    score += 3;
    factors.push({ icon: '<span class="fl-ic fl-moon-full"></span>', text: 'Solunar peak — moon overhead or underfoot (some evidence of elevated movement)', good: null });
  } else if (inMinor) {
    score += 1;
    factors.push({ icon: '<span class="fl-ic fl-moon-lastq"></span>', text: 'Solunar minor period — moon at 90°, modest activity indicator', good: null });
  }

  // ── Rut calendar (max 15pts) — masked to the user's ground species ───
  var rutMonths = RUT_CALENDAR[month] || [0,0,0,0,0];
  var _rutMask = rutMaskForSpecies(flMySpecies());
  var maxRut = maxRutMasked(rutMonths, _rutMask);
  if (maxRut >= 25) {
    var peakNames = RUT_SPECIES.filter(function(_, i) { return rutMonths[i] >= 25 && _rutMask[i]; });
    score += 15;
    factors.push({ icon: '<span class="fl-ic fl-deer"></span>', text: peakNames.join(' & ') + ' rut — heightened daytime activity', good: true });
  } else if (maxRut >= 10) {
    var activeNames = RUT_SPECIES.filter(function(_, i) { return rutMonths[i] >= 10 && _rutMask[i]; });
    score += 8;
    factors.push({ icon: '<span class="fl-ic fl-deer"></span>', text: activeNames.join(' & ') + ' rut building — elevated movement', good: true });
  } else if (maxRut > 0) {
    score += 3;
    factors.push({ icon: '<span class="fl-ic fl-deer"></span>', text: 'Pre/post rut — residual activity', good: null });
  }

  // ── Seasonal body condition modifier (max 5pts) ──────────
  // Sources: Clutton-Brock et al, BDS seasonal behaviour notes
  var seasonBoost = 0;
  if (month === 2) {
    seasonBoost = 5; // Late winter nutritional stress — deer feed aggressively
  } else if (month === 3) {
    seasonBoost = 3; // Early spring recovery — some residual winter stress
  } else if (month === 9 || month === 10) {
    seasonBoost = 4; // Pre-rut energy build
  } else if (month === 11) {
    seasonBoost = 2; // Post-rut recovery — deer tired but still feeding
  } else if (month === 6 || month === 7 || month === 8) {
    seasonBoost = -3; // Summer heat suppresses movement
  }
  score += seasonBoost;
  if (seasonBoost > 0 && month === 2) {
    factors.push({ icon: '<span class="fl-ic fl-wx-snow"></span>', text: 'Late winter — deer feeding intensively to survive, movement elevated', good: true });
  } else if (seasonBoost > 0 && month === 3) {
    factors.push({ icon: '🌱', text: 'Early spring — residual winter stress, deer actively feeding', good: true });
  } else if (seasonBoost > 0 && month === 11) {
    factors.push({ icon: '🍂', text: 'Post-rut — deer exhausted but feeding to recover condition', good: null });
  } else if (seasonBoost > 0) {
    factors.push({ icon: '🍂', text: 'Pre-rut season — bucks building energy, increased movement', good: true });
  } else if (seasonBoost < 0) {
    factors.push({ icon: '<span class="fl-ic fl-wx-sun"></span>', text: 'Summer heat — movement concentrated at dawn & dusk only', good: null });
  }

  // ── Weather factors (max 22pts total) ───────────────────
  if (wx) {
    // Temperature (max 6pts)
    // Optimal: 4–12°C. Cold snap bonus. Heat penalty.
    var tempScore = 0, tempText = '', tempGood = null;
    var t = wx.temp;
    if (t <= 0) {
      tempScore = 4; tempText = 'Freezing (' + t + '°C) — deer feeding to maintain warmth';
      tempGood = true;
    } else if (t <= 8) {
      tempScore = 6; tempText = 'Cool (' + t + '°C) — ideal temperature for deer movement';
      tempGood = true;
    } else if (t <= 14) {
      tempScore = 3; tempText = 'Mild (' + t + '°C) — moderate deer movement';
      tempGood = null;
    } else if (t <= 18) {
      tempScore = 0; tempText = 'Warm (' + t + '°C) — movement somewhat suppressed';
      tempGood = false;
    } else {
      tempScore = -3; tempText = 'Hot (' + t + '°C) — deer sheltering, movement suppressed';
      tempGood = false;
    }
    // Frost bonus: hard frost = deer must feed aggressively to maintain warmth
    // t <= 1°C triggers bonus (near-freezing consistent with hourly layer)
    if (wx.temp <= 1) {
      var frostBonus = wx.temp < -1 ? 4 : wx.temp <= 0 ? 2 : 1; // hard / freezing / near-frost
      tempScore += frostBonus;
      tempText += wx.temp < -1
        ? ' — hard frost, deer feeding intensively to stay warm'
        : wx.temp <= 0
          ? ' — frost conditions, deer actively feeding at first light'
          : ' — near-freezing, cool conditions favour movement';
      tempGood = true;
    }

    score += tempScore;
    wxFactors.push({ icon: '<span class="fl-ic fl-temp"></span>', text: tempText, good: tempGood,
      wxLabel: 'Temp', wxVal: t + '°C',
      wxSub: tempGood === true ? 'Favourable' : tempGood === false ? 'Suppressing' : 'Neutral',
      wxClass: tempGood === true ? 'good' : tempGood === false ? 'bad' : 'mid' });

    // Temperature drop trigger (+3 for sharp drop, +1 for moderate drop)
    // Research: Kammermeyer & Marchinton 1976 — temp drop triggers pre-frontal feeding
    if (wx.tempDrop6h !== undefined) {
      var dropScore = 0, dropText = '';
      if (wx.tempDrop6h >= 5) {
        dropScore = 3;
        dropText = 'Temperature falling sharply (' + wx.tempDrop6h.toFixed(1) + '°C drop in 6hrs) — deer feeding ahead of cold front';
      } else if (wx.tempDrop6h >= 3) {
        dropScore = 1;
        dropText = 'Temperature dropping (' + wx.tempDrop6h.toFixed(1) + '°C in 6hrs) — slight uptick in movement';
      }
      if (dropScore > 0) {
        score += dropScore;
        factors.push({ icon: '<span class="fl-ic fl-wx-snow"></span>', text: dropText, good: true });
      }
    }

    // Barometric pressure trend (max 8pts — strongest predictor)
    var pressScore = 0, pressText = '', pressGood = null;
    var pt = wx.pressureTrend; // change over 3hrs in hPa
    if (pt < -2) {
      pressScore = 8; pressText = 'Pressure falling sharply (' + wx.pressure.toFixed(0) + ' hPa) — pre-front feeding surge';
      pressGood = true;
    } else if (pt < -0.5) {
      pressScore = 5; pressText = 'Pressure falling (' + wx.pressure.toFixed(0) + ' hPa) — increased deer movement';
      pressGood = true;
    } else if (pt > 2) {
      pressScore = -2; pressText = 'Pressure rising sharply (' + wx.pressure.toFixed(0) + ' hPa) — settled conditions, less urgency';
      pressGood = false;
    } else if (pt > 0.5) {
      pressScore = 0; pressText = 'Pressure steady/rising (' + wx.pressure.toFixed(0) + ' hPa) — normal conditions';
      pressGood = null;
    } else {
      pressScore = 1; pressText = 'Pressure stable (' + wx.pressure.toFixed(0) + ' hPa) — routine movement expected';
      pressGood = null;
    }
    score += pressScore;
    var trendStr = pt < -0.5 ? '↓ ' : pt > 0.5 ? '↑ ' : '→ ';
    wxFactors.push({ icon: '<span class="fl-ic fl-prs-down"></span>', text: pressText, good: pressGood,
      wxLabel: 'Pressure', wxVal: trendStr + wx.pressure.toFixed(0),
      wxSub: pressGood === true ? 'Falling ✓' : pressGood === false ? 'Rising ✗' : 'Stable',
      wxClass: pressGood === true ? 'good' : pressGood === false ? 'bad' : 'mid' });

    // Wind speed (max 6pts)
    var windKmh = wx.windSpeed;
    var windMph = Math.round(windKmh * 0.621);
    var windScore = 0, windText = '', windGood = null;
    if (windMph <= 8) {
      windScore = 6; windText = 'Calm wind (' + windMph + ' mph) — deer moving freely';
      windGood = true;
    } else if (windMph < 20) {
      windScore = 3; windText = 'Light breeze (' + windMph + ' mph) — minimal impact on movement';
      windGood = null;
    } else if (windMph < 35) {
      windScore = -2; windText = 'Moderate wind (' + windMph + ' mph) — deer more cautious';
      windGood = false;
    } else {
      windScore = -5; windText = 'Strong wind (' + windMph + ' mph) — deer hunkered down, poor conditions';
      windGood = false;
    }
    score += windScore;
    // Wind consistency: append gust info to wind label if available
    var gustMph = wx.windGust ? Math.round(wx.windGust * 0.621) : null;
    var windVal = windMph + ' mph' + (gustMph && gustMph > windMph ? ' (gusts ' + gustMph + ')' : '');
    wxFactors.push({ icon: '<span class="fl-ic fl-wind"></span>', text: windText, good: windGood,
      wxLabel: 'Wind', wxVal: windVal,
      wxSub: windGood === true ? 'Calm ✓' : windGood === false ? 'High ✗' : 'Moderate',
      wxClass: windGood === true ? 'good' : windGood === false ? 'bad' : 'mid' });

    // Wind consistency (gust ratio) — swirling/gusty wind disrupts scent control
    // Only score if wind is at least light (>5mph sustained) — calm wind has no consistency issue
    if (wx.gustRatio !== undefined && windMph > 5) {
      var gustScore = 0, gustText = '';
      if (wx.gustRatio > 0.8) {
        gustScore = -4;
        gustText = 'Very gusty — wind swirling (' + windMph + ' sustained, ' + gustMph + ' gusts), scent control unreliable';
      } else if (wx.gustRatio > 0.5) {
        gustScore = -2;
        gustText = 'Gusty wind — direction inconsistent, approach planning difficult';
      } else if (wx.gustRatio > 0.3) {
        gustScore = -1;
        gustText = 'Some wind variation — scent cone less predictable than ideal';
      } else if (wx.gustRatio <= 0.15 && windMph > 5) {
        gustScore = 1;
        gustText = 'Wind holding steady — scent cone predictable, good for approach planning';
      }
      if (gustScore !== 0) {
        score += gustScore;
        factors.push({ icon: '<span class="fl-ic fl-wind"></span>', text: gustText, good: gustScore > 0 ? true : false });
      }
    }

    // Precipitation (cloud/rain)
    var rainScore = 0, rainText = '', rainGood = null;
    var wc = wx.weatherCode;
    var precip = wx.precipitation || 0;
    if (wx.postRain) {
      rainScore = 4; rainText = 'Post-rain — ' + wx.recentRainMm.toFixed(1) + 'mm in last 2hrs, deer moving freely now rain has stopped';
      rainGood = true;
    } else if (precip > 5 || (wc >= 61 && wc <= 67) || (wc >= 80 && wc <= 82)) {
      rainScore = -4; rainText = 'Heavy rain — deer sheltering, movement suppressed';
      rainGood = false;
    } else if (precip > 0.5 || (wc >= 51 && wc <= 57)) {
      rainScore = 2; rainText = 'Light rain/drizzle — deer often more active in light rain';
      rainGood = true;
    } else if (wx.cloudCover > 70) {
      rainScore = 2; rainText = 'Overcast (' + wx.cloudCover + '% cloud) — diffuse light, deer more active';
      rainGood = true;
    } else if (wx.cloudCover < 20) {
      rainScore = 0; rainText = 'Clear sky (' + wx.cloudCover + '% cloud) — bright conditions';
      rainGood = null;
    } else {
      rainScore = 1; rainText = 'Partly cloudy (' + wx.cloudCover + '%) — good conditions';
      rainGood = null;
    }
    score += rainScore;
    var rainLabel = wx.postRain ? 'Post-rain ✓' : precip > 5 ? 'Heavy rain' : precip > 0.5 ? 'Light rain' : wx.cloudCover > 70 ? 'Overcast' : wx.cloudCover < 20 ? 'Clear' : 'Partly cloudy';
    wxFactors.push({ icon: '<span class="fl-ic fl-wx-cloud"></span>', text: rainText, good: rainGood,
      wxLabel: 'Sky', wxVal: rainLabel,
      wxSub: rainGood === true ? 'Good ✓' : rainGood === false ? 'Poor ✗' : 'Neutral',
      wxClass: rainGood === true ? 'good' : rainGood === false ? 'bad' : 'mid' });

    // Add weather factors to main factors list
    wxFactors.forEach(function(wf) { factors.push(wf); });
  }

  // Max without weather: 40+8+3+15+5 = 71
  // Max with weather: 71+6+8+6+2 = 93, capped at 100
  // (moon reduced from 15→8, solunar from 8→3 based on evidence weighting)
  score = Math.min(100, Math.max(0, score));

  return {
    score: score, factors: factors, moon: moon,
    wx: wx, wxFactors: wxFactors,
    sol: getSolunar(now, bs.lat || 52, bs.lng || 0),
    srMin: srMin, ssMin: ssMin,
    dawnStart: dawnStart, dawnEnd: dawnEnd,
    duskStart: duskStart, duskEnd: duskEnd,
    curMin: curMin
  };
}

function updateActivityPanel(wx) {
  var result = getDeerActivityScore(wx || null);
  var bar = document.getElementById('activity-bar');
  var scoreEl = document.getElementById('activity-score');
  var labelEl = document.getElementById('activity-label');
  var factorsEl = document.getElementById('activity-factors');
  var pip = document.getElementById('activity-pip');
  if (!bar) return;

  bar.style.width = result.score + '%';
  if (result.score >= 65) {
    bar.style.background = 'linear-gradient(90deg,#5adf5a,#c8e050)';
    if (pip) { pip.style.background='#5adf5a'; pip.style.boxShadow='0 0 6px #5adf5a'; }
  } else if (result.score >= 45) {
    bar.style.background = 'linear-gradient(90deg,#c8a84b,#e0c050)';
    if (pip) { pip.style.background='#c8a84b'; pip.style.boxShadow='0 0 6px #c8a84b'; }
  } else if (result.score >= 20) {
    bar.style.background = 'linear-gradient(90deg,#e07020,#e09040)';
    if (pip) { pip.style.background='#e07020'; pip.style.boxShadow='0 0 6px #e07020'; }
  } else {
    bar.style.background = 'linear-gradient(90deg,#666,#888)';
    if (pip) { pip.style.background='#666'; pip.style.boxShadow='none'; }
  }

  scoreEl.textContent = result.score + '%';

  // Update badge on moon widget
  var badge = document.getElementById('activity-score-badge');
  if (badge) {
    badge.innerHTML = '<span class="fl-ic fl-deer"></span> ' + result.score + '%';
    badge.style.display = 'block';
  }
  var isNightNow = result.curMin !== undefined &&
    !inWindow(result.curMin, result.dawnStart, result.duskEnd);

  var label;
  if (isNightNow) {
    // Night: max possible ~35% so use different scale
    label = result.score >= 28 ? '<span class="fl-dot fl-dot-green"></span> Excellent dawn forecast'
          : result.score >= 20 ? '<span class="fl-dot fl-dot-amber"></span> Good dawn forecast'
          : result.score >= 12 ? '<span class="fl-dot fl-dot-orange"></span> Average dawn forecast'
          :                      '<span class="fl-dot fl-dot-dark"></span> Poor dawn forecast';
  } else {
    label = result.score >= 65 ? '<span class="fl-dot fl-dot-green"></span> High Activity Expected'
          : result.score >= 45 ? '<span class="fl-dot fl-dot-amber"></span> Moderate Activity'
          : result.score >= 20 ? '<span class="fl-dot fl-dot-orange"></span> Low Activity'
          :                      '<span class="fl-dot fl-dot-dark"></span> Minimal Activity';
  }
  labelEl.innerHTML = label;

  // ── Weather strip ──────────────────────────────────────────
  var wxStripEl = document.getElementById('activity-wx-strip');
  var wxLabelEl = document.getElementById('activity-wx-label');
  if (wxStripEl) {
    if (result.wx) {
      if (wxLabelEl) wxLabelEl.style.display = 'block';
      wxStripEl.style.display = 'grid';
      wxStripEl.innerHTML = '';
      result.wxFactors.forEach(function(wf) {
        var cell = document.createElement('div');
        var clsMap = { good:'rgba(90,220,90,0.08);border:1px solid rgba(90,220,90,0.2);',
                       bad: 'rgba(255,100,100,0.07);border:1px solid rgba(255,100,100,0.15);',
                       mid: 'rgba(200,168,75,0.08);border:1px solid rgba(200,168,75,0.2);',
                       '': 'rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);' };
        var bg = clsMap[wf.wxClass] || clsMap[''];
        cell.style.cssText = 'background:' + bg + 'border-radius:10px;padding:7px 8px;display:flex;flex-direction:column;gap:2px;';
        var subColor = wf.wxClass === 'good' ? '#7adf7a' : wf.wxClass === 'bad' ? '#ff8080' : '#f0c870';
        cell.innerHTML = '<div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:rgba(255,255,255,0.35);">' + wf.wxLabel + '</div>'
          + '<div style="font-size:14px;font-weight:700;color:white;">' + wf.wxVal + '</div>'
          + '<div style="font-size:9px;color:' + subColor + ';">' + wf.wxSub + '</div>';
        wxStripEl.appendChild(cell);
      });
    } else {
      wxStripEl.style.display = 'none';
      if (wxLabelEl) wxLabelEl.style.display = 'none';
    }
  }

  // ── Factors ────────────────────────────────────────────────
  factorsEl.innerHTML = '';
  // Only show non-weather factors here (weather shown in strip)
  var mainFactors = result.factors.filter(function(f) { return !f.wxLabel; });
  mainFactors.forEach(function(f) {
    var div = document.createElement('div');
    div.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:12px;padding:4px 0;border-top:1px solid rgba(255,255,255,0.08);';
    var ico = document.createElement('span');
    ico.style.cssText = 'display:inline-flex;align-items:center;flex-shrink:0;';
    if (f.icon && f.icon.startsWith('<')) ico.innerHTML = f.icon;
    else ico.textContent = f.icon;
    var txt = document.createElement('span');
    txt.textContent = f.text;
    txt.style.color = f.good === true ? 'rgba(180,240,160,0.9)'
                    : f.good === false ? 'rgba(255,180,160,0.8)'
                    : 'rgba(255,255,255,0.6)';
    div.appendChild(ico);
    div.appendChild(txt);
    factorsEl.appendChild(div);
  });

  // ── Timeline ──────────────────────────────────────────────
  var curMin2    = result.curMin    || ukNowMin();
  var dawnStart2 = result.dawnStart !== undefined ? result.dawnStart : (5 * 60 + 17);
  var dawnEnd2   = result.dawnEnd   !== undefined ? result.dawnEnd   : (8 * 60 + 17);
  var duskStart2 = result.duskStart !== undefined ? result.duskStart : (17 * 60);
  var duskEnd2   = result.duskEnd   !== undefined ? result.duskEnd   : (19 * 60);
  var MINS_DAY = 1440;

  function pct(min) {
    var v = ((Math.round(min) % MINS_DAY) + MINS_DAY) % MINS_DAY;
    return (v / MINS_DAY * 100).toFixed(2) + '%';
  }
  function wPct(start, end) {
    var s = ((Math.round(start) % MINS_DAY) + MINS_DAY) % MINS_DAY;
    var e = ((Math.round(end)   % MINS_DAY) + MINS_DAY) % MINS_DAY;
    var w = e > s ? e - s : (MINS_DAY - s + e); // handle midnight wrap
    return (w / MINS_DAY * 100).toFixed(2) + '%';
  }
  function inWin(cur, s, e) { return cur >= s && cur <= e; }

  var dawnSeg = document.getElementById('tl-dawn-seg');
  var duskSeg = document.getElementById('tl-dusk-seg');
  var nowLine = document.getElementById('tl-now-line');
  var sol1Seg = document.getElementById('tl-sol1-seg');
  var sol2Seg = document.getElementById('tl-sol2-seg');

  if (dawnSeg) { dawnSeg.style.left = pct(dawnStart2); dawnSeg.style.width = wPct(dawnStart2, dawnEnd2); }
  if (duskSeg) { duskSeg.style.left = pct(duskStart2); duskSeg.style.width = wPct(duskStart2, duskEnd2); }
  if (nowLine) { nowLine.style.left = pct(curMin2); }

  // Solunar markers on timeline
  var sol = result.sol;
  if (sol && sol1Seg) { sol1Seg.style.left = pct(sol.major1.start); sol1Seg.style.width = wPct(sol.major1.start, sol.major1.end); }
  if (sol && sol2Seg) { sol2Seg.style.left = pct(sol.major2.start); sol2Seg.style.width = wPct(sol.major2.start, sol.major2.end); }

  // Dawn chip
  var dawnLabel = document.getElementById('tl-dawn-chip-label');
  var dawnTime  = document.getElementById('tl-dawn-chip-time');
  var dawnChip  = document.getElementById('tl-dawn-chip');
  var dawnActive = inWin(curMin2, dawnStart2, dawnEnd2);
  if (dawnChip) { dawnChip.style.background = dawnActive ? 'rgba(240,192,64,0.15)' : 'rgba(255,255,255,0.05)'; dawnChip.style.border = dawnActive ? '1px solid rgba(240,192,64,0.3)' : '1px solid rgba(255,255,255,0.08)'; }
  if (dawnLabel) dawnLabel.textContent = 'Dawn peak' + (dawnActive ? ' ● Now' : '');
  if (dawnTime)  dawnTime.textContent  = fmtMins(dawnStart2) + ' – ' + fmtMins(dawnEnd2);

  // Dusk chip
  var duskLabel = document.getElementById('tl-dusk-chip-label');
  var duskTime  = document.getElementById('tl-dusk-chip-time');
  var duskChip  = document.getElementById('tl-dusk-chip');
  var duskActive = inWin(curMin2, duskStart2, duskEnd2);
  if (duskChip) { duskChip.style.background = duskActive ? 'rgba(240,144,32,0.15)' : 'rgba(255,255,255,0.05)'; duskChip.style.border = duskActive ? '1px solid rgba(240,144,32,0.3)' : '1px solid rgba(255,255,255,0.08)'; }
  if (duskLabel) duskLabel.textContent = 'Dusk peak' + (duskActive ? ' ● Now' : '');
  if (duskTime)  duskTime.textContent  = fmtMins(duskStart2) + ' – ' + fmtMins(duskEnd2);

  // Solunar chips
  var sol1Label = document.getElementById('tl-sol1-label');
  var sol1Time  = document.getElementById('tl-sol1-time');
  var sol2Label = document.getElementById('tl-sol2-label');
  var sol2Time  = document.getElementById('tl-sol2-time');
  if (sol1Label) sol1Label.textContent = 'Solunar peak · Moon overhead';
  if (sol1Time)  sol1Time.textContent  = fmtMins(sol.major1.peak);
  if (sol2Label) sol2Label.textContent = 'Solunar peak · Moon underfoot';
  if (sol2Time)  sol2Time.textContent  = fmtMins(sol.major2.peak);
}


function toggleActivityPanel() {
  var panel = document.getElementById('activity-panel');
  var wfPanel = document.getElementById('week-forecast-panel');
  if (!panel) return;
  var isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  if (wfPanel) wfPanel.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    flRenderSpeciesChip();
    flMaybeShowSpeciesNudge();
    // Populate immediately from cached weather (or non-weather factors) so the
    // panel — now docked under the Deer activity card — is never blank while the
    // live fetch is in flight (that blank stretch was the reported bug).
    var _cwx = (_weatherCache && _weatherCache.data && _weatherCache.lat === bannerState.lat) ? _weatherCache.data : null;
    try { updateActivityPanel(_cwx); } catch (_) {}
    // Show a loading state in the weather strip only when there's no cache yet.
    var wxStrip = document.getElementById('activity-wx-strip');
    var wxLabel = document.getElementById('activity-wx-label');
    if (!_cwx && wxStrip && bannerState.lat !== null) {
      if (wxLabel) { wxLabel.style.display = 'block'; wxLabel.textContent = 'Live weather · Loading…'; }
      wxStrip.style.display = 'grid';
      wxStrip.innerHTML = '<div style="grid-column:1/-1;font-size:11px;color:rgba(255,255,255,0.3);padding:6px 0;">Fetching weather data…</div>';
    }
    if (bannerState.lat !== null) {
      // Fetch current weather for live panel
      fetchWeather(bannerState.lat, bannerState.lng, function(err, wx) {
        if (!err && wx) {
          if (wxLabel) wxLabel.textContent = 'Live weather · Open-Meteo';
          updateActivityPanel(wx);
          // Sync badge with weather-enhanced score
          var badge = document.getElementById('activity-score-badge');
          var result = getDeerActivityScore(wx);
          if (badge) badge.innerHTML = '<span class="fl-ic fl-deer"></span> ' + result.score + '%';
        } else {
          if (wxLabel) { wxLabel.style.display = 'block'; wxLabel.textContent = 'Weather unavailable · score based on moon, rut & season'; }
          if (wxStrip) wxStrip.style.display = 'none';
          // Still show score from non-weather factors
          updateActivityPanel(null);
        }
      });
      // Fetch 7-day weather forecast
      buildWeekForecast(null);
      fetch7DayWeather(bannerState.lat, bannerState.lng, function(err, d) {
        if (!err && d) buildWeekForecast(d);
      });
    }
  }
}

// ── Homepage "Deer on my ground" picker (species-aware rut, login-free) ──────
// Writes the SAME localStorage key the Diary reads ('fl-my-species-v1'), so the
// deer score reflects the visitor's deer on both surfaces. Empty = all species
// (default, unchanged forecast). No account required — this is the homepage's
// own way to set the species the Diary sets behind its login.
var FL_SPECIES_ORDER = ['Red Deer', 'Roe Deer', 'Fallow', 'Sika', 'Muntjac', 'CWD'];
var FL_SPECIES_SHORT = { 'Red Deer': 'Red', 'Roe Deer': 'Roe', 'Fallow': 'Fallow', 'Sika': 'Sika', 'Muntjac': 'Muntjac', 'CWD': 'CWD' };
var FL_SPECIES_ONBOARD_KEY = 'fl-species-onboarded-v1';
var flLast7dayWx = null; // last 7-day payload, cached so a species change can re-score

function flSetMySpecies(arr) {
  try { localStorage.setItem('fl-my-species-v1', JSON.stringify(arr)); } catch (e) {}
}
function flSpeciesChipText() {
  var mine = flMySpecies();
  if (!mine.length) return 'All deer';
  return mine.map(function (s) { return FL_SPECIES_SHORT[s] || s; }).join(', ');
}
function flRenderSpeciesChip() {
  var el = document.getElementById('species-chip-label');
  if (el) el.textContent = flSpeciesChipText();
}
function flSpeciesOnboarded() {
  try { return localStorage.getItem(FL_SPECIES_ONBOARD_KEY) === '1'; } catch (e) { return true; }
}
function flMarkSpeciesOnboarded() {
  try { localStorage.setItem(FL_SPECIES_ONBOARD_KEY, '1'); } catch (e) {}
}
function flDismissSpeciesNudge() {
  var n = document.getElementById('species-nudge');
  if (n) n.style.display = 'none';
  flMarkSpeciesOnboarded();
}
function flMaybeShowSpeciesNudge() {
  var n = document.getElementById('species-nudge');
  if (n && !flSpeciesOnboarded()) n.style.display = 'flex';
}
function openSpeciesPicker() {
  var modal = document.getElementById('species-picker-modal');
  var list = document.getElementById('species-picker-list');
  if (!modal || !list) return;
  // Nothing saved yet ⇒ default to all six ticked (matches "all species" scoring).
  var mine = flMySpecies();
  var preset = mine.length ? mine : FL_SPECIES_ORDER.slice();
  var boxes = list.querySelectorAll('input[type="checkbox"]');
  for (var i = 0; i < boxes.length; i++) boxes[i].checked = preset.indexOf(boxes[i].value) !== -1;
  var err = document.getElementById('species-picker-err');
  if (err) err.style.display = 'none';
  modal.style.display = 'flex';
}
function closeSpeciesPicker() {
  var modal = document.getElementById('species-picker-modal');
  if (modal) modal.style.display = 'none';
}
function saveSpeciesPicker() {
  var list = document.getElementById('species-picker-list');
  if (!list) return;
  var boxes = list.querySelectorAll('input[type="checkbox"]'), chosen = [];
  for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) chosen.push(boxes[i].value);
  if (!chosen.length) {
    var err = document.getElementById('species-picker-err');
    if (err) err.style.display = 'block';
    return;
  }
  // Canonical order; all six ⇒ store [] so the common case stays a true no-op.
  var ordered = FL_SPECIES_ORDER.filter(function (s) { return chosen.indexOf(s) !== -1; });
  flSetMySpecies(ordered.length === FL_SPECIES_ORDER.length ? [] : ordered);
  flMarkSpeciesOnboarded();
  flRenderSpeciesChip();
  flDismissSpeciesNudge();
  closeSpeciesPicker();
  flRefreshForecastForSpecies();
}
// Re-score whatever is on screen after a species change (badge always; the live
// panel + week outlook only if open). Reuses cached weather — no refetch.
function flRefreshForecastForSpecies() {
  var cachedWx = (_weatherCache && _weatherCache.data && _weatherCache.lat === bannerState.lat) ? _weatherCache.data : null;
  var badge = document.getElementById('activity-score-badge');
  if (badge && badge.style.display !== 'none') {
    badge.innerHTML = '<span class="fl-ic fl-deer"></span> ' + getDeerActivityScore(cachedWx).score + '%';
  }
  var panel = document.getElementById('activity-panel');
  if (panel && panel.style.display !== 'none') updateActivityPanel(cachedWx);
  var wf = document.getElementById('week-forecast-panel');
  if (wf && wf.style.display !== 'none' && flLast7dayWx) buildWeekForecast(flLast7dayWx);
}


// ── block ──

// ── Location picker (item 1, 3, 6, 7, 8, 10) ─────────────────

ui._modalTrigger = null;

ui.openLocationPicker = function() {
  ui._modalTrigger = document.activeElement;
  var modal = document.getElementById('location-modal');
  modal.style.display = 'flex';
  document.getElementById('loc-search').value = '';
  document.getElementById('loc-results').style.display = 'none';
  document.getElementById('loc-status').textContent = '';
  document.querySelectorAll('.loc-preset').forEach(function(b) { b.classList.remove('selected'); });
  setTimeout(function() { document.getElementById('loc-search').focus(); }, 100);
};
// Keep legacy global name for onclick= in HTML
function openLocationPicker() { ui.openLocationPicker(); }

ui.closeLocationPicker = function() {
  document.getElementById('location-modal').style.display = 'none';
  document.querySelectorAll('.loc-preset').forEach(function(b) { b.classList.remove('selected'); });
  if (ui._modalTrigger && ui._modalTrigger.focus) {
    try { ui._modalTrigger.focus(); } catch(e) {}
    ui._modalTrigger = null;
  }
};
function closeLocationPicker() { ui.closeLocationPicker(); }

// Presets use data attrs to avoid innerHTML injection
function selectPreset(lat, lng, name, btn) {
  document.querySelectorAll('.loc-preset').forEach(function(b) { b.classList.remove('selected'); });
  if (btn) btn.classList.add('selected');
  ui.closeLocationPicker();
  if (!isInUK(lat, lng)) {
    showOutsideUKMessage();
    return;
  }
  updateBanner(lat, lng, name);
}

// ── 1: Nominatim search (replaces LLM API call) ──────────────
// ── Debounce ≥1100 ms (item 1) ───────────────────────────────
var _searchTimer = null;

function debounceSearch() {
  clearTimeout(_searchTimer);
  var q = document.getElementById('loc-search').value.trim();
  if (q.length < 3) {
    document.getElementById('loc-results').style.display = 'none';
    document.getElementById('loc-status').textContent = '';
    return;
  }
  document.getElementById('loc-status').textContent = 'Typing…';
  _searchTimer = setTimeout(ui._doSearch, 1100);   // ≥1100 ms
}

ui._doSearch = function() {
  var query = document.getElementById('loc-search').value.trim();
  if (query.length < 2) return;

  var status  = document.getElementById('loc-status');
  var results = document.getElementById('loc-results');

  status.textContent      = 'Searching…';
  results.style.display   = 'none';
  results.textContent     = '';   // ── 3: no innerHTML ──

  // ── 8: Offline guard ──
  if (!navigator.onLine) {
    status.textContent = 'Offline — search unavailable.';
    return;
  }

  var url = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=gb&limit=5&addressdetails=1&q=' + encodeURIComponent(query);

  fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'FirstLightApp/1.0' } })
    .then(function(r) {
      if (r.status === 429) throw new Error('RATE_LIMIT');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(items) {
      if (!Array.isArray(items) || items.length === 0) {
        status.textContent = 'No UK locations found.';
        return;
      }
      status.textContent = '';
      ui._showResults(items);
    })
    .catch(function(err) {
      if (err.message === 'RATE_LIMIT') {
        status.textContent = 'Too many searches — wait a moment and try again.';
      } else {
        status.textContent = navigator.onLine
          ? 'Search failed — please try again.'
          : 'Offline — search unavailable.';
      }
    });
};

// ── 3: Build results with createElement (no innerHTML) ───────
ui._showResults = function(items) {
  var results = document.getElementById('loc-results');
  results.textContent  = '';   // clear safely
  results.style.display = 'block';

  // Filter to UK bounds as a safety net (countrycodes=gb should already do this)
  var ukItems = items.filter(function(item) {
    return isInUK(parseFloat(item.lat), parseFloat(item.lon));
  });

  if (ukItems.length === 0) {
    var msg = document.createElement('div');
    msg.style.cssText = 'font-size:12px;color:#888;padding:8px 0;text-align:center;';
    msg.textContent = 'No UK locations found. First Light covers UK locations only.';
    results.appendChild(msg);
    return;
  }

  ukItems.forEach(function(item) {
    var lat  = parseFloat(item.lat);
    var lng  = parseFloat(item.lon);
    var addr = item.address || {};
    var displayFirst = (item.display_name || '').split(',')[0].trim();
    var name = formatUkLocationLabel(addr, displayFirst);
    var tip  = item.display_name || name;

    // ── 3: DOM creation, no onclick= string ──
    var row = document.createElement('div');
    row.className = 'loc-result-item';

    var nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-size:13px;font-weight:600;color:#2d3a1f;line-height:1.3;';
    nameEl.textContent = name;

    var coordEl = document.createElement('div');
    coordEl.style.cssText = 'font-size:11px;color:#aaa;margin-top:2px;';
    coordEl.textContent = lat.toFixed(4) + '°N, ' + Math.abs(lng).toFixed(4) + '°' + (lng < 0 ? 'W' : 'E');

    row.appendChild(nameEl);
    row.appendChild(coordEl);

    // ── 3: addEventListener not inline onclick ──
    row.addEventListener('click', (function(la, lo, n, fullTip) {
      return function() {
        ui.closeLocationPicker();
        updateBanner(la, lo, n, { tooltip: fullTip });
      };
    }(lat, lng, name, tip)));

    results.appendChild(row);
  });
};

// Legacy name kept for HTML button
function searchLocation() { ui._doSearch(); }

function useMyLocation() {
  ui.closeLocationPicker();
  var locTxt = document.getElementById('banner-location-text');
  if (locTxt) locTxt.textContent = '';

  if (!navigator.geolocation) {
    ui.showLocationPrompt('Location unavailable');
    return;
  }
  if (!navigator.onLine) {
    ui.showLocationPrompt('Offline — set location manually');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function(pos) {
      var lat = pos.coords.latitude;
      var lng = pos.coords.longitude;
      var acc = pos.coords.accuracy;
      if (!isInUK(lat, lng)) {
        ui.closeLocationPicker();
        showOutsideUKMessage();
        return;
      }
      ui.showAccuracyWarning(acc);

      fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=jsonv2&addressdetails=1&zoom=15', {
        headers: { 'Accept-Language': 'en', 'User-Agent': 'FirstLightApp/1.0' }
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var name =
            labelFromNominatimReverse(data) ||
            normalizeUkPlaceName((data.address || {}).county) ||
            'Your Location';
          updateBanner(lat, lng, name, { tooltip: data.display_name || name });
        })
        .catch(function() { updateBanner(lat, lng, 'Your Location'); });
    },
    function() { ui.showLocationPrompt('Location unavailable'); },
    { timeout: 8000, maximumAge: 0 } // always fresh — user explicitly requested location
  );
}

// Backdrop click
document.addEventListener('DOMContentLoaded', function() {
  var modal = document.getElementById('location-modal');
  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) ui.closeLocationPicker();
    });
  }
});


// ── block ──
function openHoursDisclaimer() {
  var m = document.getElementById('hours-disclaimer-modal');
  if (m) m.style.display = 'flex';
}
function closeHoursDisclaimer() {
  var m = document.getElementById('hours-disclaimer-modal');
  if (m) m.style.display = 'none';
}
document.addEventListener('DOMContentLoaded', function() {
  var hm = document.getElementById('hours-disclaimer-modal');
  if (hm) {
    hm.addEventListener('click', function(e) {
      if (e.target === this) closeHoursDisclaimer();
    });
  }
});

// ── block ──
// Dialog hygiene (Wave T): Escape closes whichever overlay is open — the
// lightbox first (it sits above everything), then the pickers, then the
// static info dialogs. Arrow keys page the lightbox. Escape on the species
// picker cancels (same as its Close control) — it never saves.
document.addEventListener('keydown', function (e) {
  var lb = document.getElementById('gallery-lightbox');
  var lbOpen = !!(lb && lb.classList.contains('open'));
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (lbOpen) { lightboxNav(e.key === 'ArrowLeft' ? -1 : 1); e.preventDefault(); }
    return;
  }
  if (e.key !== 'Escape') return;
  if (lbOpen) { closeLightbox(); e.preventDefault(); return; }
  var sp = document.getElementById('species-picker-modal');
  if (sp && sp.style.display === 'flex') { closeSpeciesPicker(); e.preventDefault(); return; }
  var lm = document.getElementById('location-modal');
  if (lm && lm.style.display === 'flex') { ui.closeLocationPicker(); e.preventDefault(); return; }
  var cm = document.getElementById('changelog-modal');
  if (cm && cm.style.display === 'flex') { cm.style.display = 'none'; e.preventDefault(); return; }
  var hd = document.getElementById('hours-disclaimer-modal');
  if (hd && hd.style.display === 'flex') { closeHoursDisclaimer(); e.preventDefault(); return; }
});
// Backdrop tap closes the changelog and species picker too, matching the
// hours and location dialogs which already did.
document.addEventListener('DOMContentLoaded', function () {
  var cm = document.getElementById('changelog-modal');
  if (cm) cm.addEventListener('click', function (e) { if (e.target === this) this.style.display = 'none'; });
  var sp = document.getElementById('species-picker-modal');
  if (sp) sp.addEventListener('click', function (e) { if (e.target === this) closeSpeciesPicker(); });
});

// ── block ──
if ('serviceWorker' in navigator) {
  // Foreground update check (2026-07-27): see modules/sw-bridge.mjs — resumed
  // PWAs never re-fetch sw.js on their own.
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) return;
    navigator.serviceWorker.getRegistration().then(function(reg) {
      if (reg) reg.update().catch(function() {});
    }).catch(function() {});
    // 13.01: a resumed page re-syncs the trusted clock (throttled) — even if
    // an earlier sample was poisoned by a mid-flight suspension, the display
    // heals within a tick of the fresh offset landing.
    try {
      var syncedAt = parseInt(localStorage.getItem(FL_UK_CLOCK_SYNCED_AT_KEY) || '0', 10) || 0;
      if (Date.now() - syncedAt > 5 * 60 * 1000) syncTrustedUkClock();
    } catch (_) { syncTrustedUkClock(); }
  });
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('./sw.js').then(function(reg) {
      ui.updatePwaStatus();
      // Check for updates
      reg.addEventListener('updatefound', function() {
        var newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', function() {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available — show refresh prompt (no inline onclick: CSP script-src blocks it)
            var toast = document.createElement('div');
            toast.style.cssText = 'position:fixed;bottom:calc(80px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);background:rgba(30,50,20,0.96);color:white;font-size:13px;font-weight:600;padding:12px 18px;border-radius:14px;border:1px solid rgba(200,168,75,0.3);z-index:9999;display:flex;align-items:center;gap:10px;box-shadow:0 6px 24px rgba(0,0,0,0.4);max-width:320px;';
            var toastMsg = document.createElement('span');
            toastMsg.textContent = 'New version available';
            var toastBtn = document.createElement('button');
            toastBtn.type = 'button';
            toastBtn.textContent = 'Refresh';
            toastBtn.style.cssText = 'background:rgba(200,168,75,0.2);border:1px solid rgba(200,168,75,0.4);color:#f0c870;padding:6px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;';
            toastBtn.addEventListener('click', function() { location.reload(); });
            toast.appendChild(toastMsg);
            toast.appendChild(toastBtn);
            document.body.appendChild(toast);
          }
        });
      });
    }).catch(function(err) {
      // Silent fail on non-installed domains
      ui.updatePwaStatus();
    });
  });
}

// ── block ──
(function() {
  function onReady(fn) {
    if (document.readyState !== 'loading') { fn(); }
    else { document.addEventListener('DOMContentLoaded', fn); }
  }

  onReady(function() {
    ui.updatePwaStatus();
    initIndexFlActions();
    enhanceKeyboardClickables(document);
    if ('MutationObserver' in window) {
      var kbObserver = new MutationObserver(function(muts) {
        muts.forEach(function(m) {
          if (m.type === 'childList' && m.addedNodes && m.addedNodes.length) {
            m.addedNodes.forEach(function(n) {
              if (n && n.nodeType === 1) enhanceKeyboardClickables(n);
            });
          }
        });
      });
      kbObserver.observe(document.body, { childList: true, subtree: true });
    }

    // ── Pull to refresh ────────────────────────────────────
    (function() {
      var PTR_THRESHOLD = 72;   // px to pull before triggering
      var PTR_RESIST   = 0.4;   // resistance factor
      var startY = 0;
      var pulling = false;
      var refreshing = false;
      var indicator = document.getElementById('ptr-indicator');
      var arrow = document.getElementById('ptr-arrow');
      var label = document.getElementById('ptr-label');

      function showIndicator(dist) {
        if (!indicator) return;
        var progress = Math.min(dist / PTR_THRESHOLD, 1);
        indicator.style.display = 'flex';
        arrow.style.transform = progress >= 1 ? 'rotate(180deg)' : 'rotate(0deg)';
        label.textContent = progress >= 1 ? 'Release to refresh' : 'Pull to refresh';
        indicator.style.opacity = Math.min(progress * 1.5, 1);
      }

      function hideIndicator() {
        if (!indicator) return;
        indicator.style.display = 'none';
        indicator.style.opacity = '0';
      }

      function doRefresh() {
        if (refreshing) return;
        refreshing = true;
        if (indicator) {
          arrow.style.transform = 'rotate(0deg)';
          label.textContent = 'Refreshing…';
        }
        // Re-run GPS and solar calc
        ui.showLocationPrompt('Locating…');
        initBanner();
        updateMoon();
        // Hide after 1.5s
        setTimeout(function() {
          hideIndicator();
          refreshing = false;
        }, 1500);
      }

      document.addEventListener('touchstart', function(e) {
        // Only trigger if at top of page
        if (window.scrollY === 0) {
          startY = e.touches[0].clientY;
          pulling = true;
        }
      }, { passive: true });

      document.addEventListener('touchmove', function(e) {
        if (!pulling || refreshing) return;
        var dist = (e.touches[0].clientY - startY) * PTR_RESIST;
        if (dist > 0) showIndicator(dist);
        else hideIndicator();
      }, { passive: true });

      document.addEventListener('touchend', function(e) {
        if (!pulling || refreshing) return;
        pulling = false;
        var dist = (e.changedTouches[0].clientY - startY) * PTR_RESIST;
        if (dist >= PTR_THRESHOLD) {
          doRefresh();
        } else {
          hideIndicator();
        }
      }, { passive: true });
    }());


    var calBtnEW = document.getElementById('cal-btn-ew');
    var calBtnSC = document.getElementById('cal-btn-sc');
    var calBtnNI = document.getElementById('cal-btn-ni');
    var calViewEW = document.getElementById('cal-view-ew');
    var calViewSC = document.getElementById('cal-view-sc');
    var calViewNI = document.getElementById('cal-view-ni');
    var ewActiveStyle = 'flex:1;padding:10px 0;border-radius:20px;border:1px solid rgba(200,168,75,0.3);cursor:pointer;font-family:\'DM Sans\',sans-serif;font-size:11px;font-weight:600;background:linear-gradient(135deg,#2a5a18,#1a3a0e);color:#f5e6c8;';
    var scActiveStyle = 'flex:1;padding:10px 0;border-radius:20px;border:1px solid rgba(120,160,240,0.3);cursor:pointer;font-family:\'DM Sans\',sans-serif;font-size:11px;font-weight:600;background:linear-gradient(135deg,#1a2a5a,#0e1a3a);color:#c8d8f8;';
    var niActiveStyle = 'flex:1;padding:10px 0;border-radius:20px;border:1px solid rgba(240,160,60,0.35);cursor:pointer;font-family:\'DM Sans\',sans-serif;font-size:11px;font-weight:600;background:linear-gradient(135deg,#5a3a10,#3a240a);color:#f5d8b0;';
    var inactiveStyle = 'flex:1;padding:10px 0;border-radius:20px;border:1px solid rgba(255,255,255,0.1);cursor:pointer;font-family:\'DM Sans\',sans-serif;font-size:11px;font-weight:600;background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.45);';
    function calShowRegion(region) {
      if (calBtnEW) calBtnEW.style.cssText = region === 'ew' ? ewActiveStyle : inactiveStyle;
      if (calBtnSC) calBtnSC.style.cssText = region === 'sc' ? scActiveStyle : inactiveStyle;
      if (calBtnNI) calBtnNI.style.cssText = region === 'ni' ? niActiveStyle : inactiveStyle;
      if (calViewEW) calViewEW.style.display = region === 'ew' ? 'block' : 'none';
      if (calViewSC) calViewSC.style.display = region === 'sc' ? 'block' : 'none';
      if (calViewNI) calViewNI.style.display = region === 'ni' ? 'block' : 'none';
    }
    if (calBtnEW) calBtnEW.addEventListener('click', function() { calShowRegion('ew'); });
    if (calBtnSC) calBtnSC.addEventListener('click', function() { calShowRegion('sc'); });
    if (calBtnNI) calBtnNI.addEventListener('click', function() { calShowRegion('ni'); });


    var skipLink = document.getElementById('skip-link');
    if (skipLink) {
      skipLink.addEventListener('focus', function() { this.style.top = '0'; });
      skipLink.addEventListener('blur',  function() { this.style.top = '-40px'; });
    }

    // ── Info button (hours disclaimer) ────────────────────
    var infoBtn = document.getElementById('info-btn');
    if (infoBtn) {
      infoBtn.addEventListener('click', openHoursDisclaimer);
    }

    initFieldMode();
    flHoistHeader();

    // ── Edit location button ───────────────────────────────
    var editBtn = document.getElementById('edit-location-btn');
    if (editBtn) {
      editBtn.addEventListener('click', openLocationPicker);
      editBtn.addEventListener('mouseover', function() { this.style.opacity = '1'; });
      editBtn.addEventListener('mouseout',  function() { this.style.opacity = '0.55'; });
    }

    // ── Moon / activity widget ─────────────────────────────
    var moonWidget = document.getElementById('moon-widget');
    if (moonWidget) {
      moonWidget.addEventListener('click', toggleActivityPanel);
      moonWidget.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleActivityPanel(); }
      });
    }

    // Dock the full-forecast panels directly under the Deer activity card, so
    // the card's CTA (and the moon row) open them there — not up in the old
    // status card. Toggle logic is unaffected (it finds them by id).
    (function () {
      var _dock = document.getElementById('forecast-dock');
      var _ap = document.getElementById('activity-panel');
      var _wf = document.getElementById('week-forecast-panel');
      if (_dock && _ap) _dock.appendChild(_ap);
      if (_dock && _wf) _dock.appendChild(_wf);
    })();

    // ── Tonight's outlook card → opens the full forecast panel ──
    var tonightCard = document.getElementById('tonight-card');
    if (tonightCard) {
      var openForecastFromCard = function() {
        toggleActivityPanel();
        var p = document.getElementById('activity-panel');
        if (p && p.style.display !== 'none' && p.scrollIntoView) {
          p.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      };
      tonightCard.addEventListener('click', openForecastFromCard);
      tonightCard.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openForecastFromCard(); }
      });
    }

    // ── Tab strips: top pills and bottom bar ───────────────
    // One roving-tabindex handler for both, per the ARIA "Tabs" pattern:
    // Left/Right move and activate, Home/End jump to the ends, Enter/Space
    // activate the focused tab. Focus follows selection because switching is
    // instant here — no fetch, no lazy panel build — so arrow-scrubbing the
    // strip does not feel laggy. Up/Down are deliberately left alone: both
    // strips are horizontal, and the bottom bar is fixed, so swallowing
    // ArrowDown there would break scrolling the page underneath it.
    // Focus is moved BEFORE activation so the smooth scrollIntoView inside
    // switchMainTab is the last scroll to run and wins.
    function wireTabStrip(sel, activate) {
      var tabs = Array.prototype.slice.call(document.querySelectorAll(sel));
      if (!tabs.length) return;
      tabs.forEach(function(tab, i) {
        tab.addEventListener('click', function() { activate(tab); });
        tab.addEventListener('keydown', function(e) {
          var next = null;
          if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
          else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
          else if (e.key === 'Home') next = tabs[0];
          else if (e.key === 'End') next = tabs[tabs.length - 1];
          else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(tab); return; }
          else return;
          e.preventDefault();
          next.focus();
          activate(next);
        });
      });
    }
    wireTabStrip('.nav-tab[data-tab]', function(t) { switchTab(t.dataset.tab, t); });
    wireTabStrip('.tab-item[data-maintab]', function(t) { switchMainTab(t.dataset.maintab, { scroll: true }); });

    // ── Deer cards (header only — body clicks e.g. gallery must not toggle) ──
    document.querySelectorAll('.deer-card').forEach(function(card) {
      var hdr = card.querySelector('.card-header');
      if (!hdr) return;
      hdr.addEventListener('click', function() { toggleCard(card); });
    });

    // ── Field guide accordion headers ──────────────────────
    document.querySelectorAll('.fg-cat-header').forEach(function(header) {
      header.addEventListener('click', function() { toggleFgCategory(this); });
      header.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFgCategory(this); }
      });
    });
    initFieldGuideSearch();

    // ── Location preset buttons ────────────────────────────
    document.querySelectorAll('.loc-preset[data-lat]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        selectPreset(
          parseFloat(this.dataset.lat),
          parseFloat(this.dataset.lng),
          this.dataset.name,
          this
        );
      });
    });

    // ── Location search input ──────────────────────────────
    var locSearch = document.getElementById('loc-search');
    if (locSearch) {
      locSearch.addEventListener('input', debounceSearch);
      locSearch.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); searchLocation(); }
      });
    }

    // ── Search Go button ───────────────────────────────────
    var goBtn = document.getElementById('search-go-btn');
    if (goBtn) { goBtn.addEventListener('click', searchLocation); }

    // ── Location cancel button ─────────────────────────────
    var cancelBtn = document.getElementById('location-cancel-btn');
    if (cancelBtn) { cancelBtn.addEventListener('click', closeLocationPicker); }

    // ── GPS location button ────────────────────────────────
    var gpsBtn = document.getElementById('use-gps-btn');
    if (gpsBtn) { gpsBtn.addEventListener('click', useMyLocation); }

    // ── Hours disclaimer close button ──────────────────────
    var disclaimerCloseBtn = document.getElementById('hours-disclaimer-close');
    if (disclaimerCloseBtn) { disclaimerCloseBtn.addEventListener('click', closeHoursDisclaimer); }

    // ── BDS link ───────────────────────────────────────────
    var bdsLink = document.getElementById('bds-link');
    if (bdsLink) {
      bdsLink.addEventListener('click', function(e) {
        e.preventDefault();
        window.open('https://www.bds.org.uk', '_blank', 'noopener,noreferrer');
      });
    }

    // ── BASC link ──────────────────────────────────────────
    var bascLink = document.getElementById('basc-link');
    if (bascLink) {
      bascLink.addEventListener('click', function(e) {
        e.preventDefault();
        window.open('https://www.basc.org.uk/deer/', '_blank', 'noopener,noreferrer');
      });
    }


  });
}());

// ── block ──
(function() {
  var DIARY_URL = 'https://sjaasuqeknvvmdpydfsz.supabase.co';
  var DIARY_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNqYWFzdXFla252dm1kcHlkZnN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NjMzMzIsImV4cCI6MjA5MDIzOTMzMn0.aiJaKoLCI3jUkOgifqMLuhp8NnAFK0T24Va6r2CLzgw';

  // Season-year feature (SEASON-YEAR-PLAN.md step 5): the homepage diary card
  // follows the signed-in user's "season starts in" month from auth
  // user_metadata.fl_season_start_month — the same setting the Diary uses.
  // Signed out / unset / garbage ⇒ 8 (August), so unconfigured accounts get
  // the historical Aug–Jul window byte-for-byte. Local clamp mirrors
  // lib/fl-pure.mjs#normalizeSeasonStartMonth (app.js is a classic script and
  // cannot import the ES module — keep the two in lock-step).
  function clampSeasonStartMonth(v) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    if (!Number.isFinite(n)) return 8;
    n = Math.trunc(n);
    return (n >= 1 && n <= 12) ? n : 8;
  }

  function getSeasonDates(startMonth) {
    var sm = clampSeasonStartMonth(startMonth);
    var now = flNow();
    var m = now.getMonth() + 1; // 1-12
    var y = now.getFullYear();
    var startYear = m >= sm ? y : y - 1;
    var endMonth = sm === 1 ? 12 : sm - 1;
    var endYear  = sm === 1 ? startYear : startYear + 1;
    // Last day of the end month — day 0 of the following month (leap-safe).
    var endDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return {
      start: startYear + '-' + p2(sm) + '-01',
      end: endYear + '-' + p2(endMonth) + '-' + p2(endDay)
    };
  }

  function updateCard(total, kg, spp) {
    var t = document.getElementById('diary-card-total');
    var k = document.getElementById('diary-card-kg');
    var s = document.getElementById('diary-card-spp');
    if (t) t.textContent = total;
    if (k) k.textContent = kg;
    if (s) s.textContent = spp;
  }

  // Season totals for the homepage card, with the SAME semantics as the
  // diary's own headline (diary.js: animals, not rows): blank days are
  // outings without a shot so they count zero, and a pest bag logged as one
  // row with quantity N counts N. Species ignores blanks and nulls.
  function diaryCardStats(rows) {
    var entries = (rows || []).filter(function(e){ return !e.is_blank; });
    var total = entries.reduce(function(s,e){ var q = e.quantity|0; return s + (q > 0 ? q : 1); }, 0);
    var kg = Math.round(entries.reduce(function(s,e){ return s + (parseFloat(e.weight_kg)||0); }, 0));
    var spp = new Set(entries.map(function(e){ return e.species; }).filter(Boolean)).size;
    return { total: total, kg: kg, spp: spp };
  }

  // Homepage Cull Diary card: signed-out visitors see the pitch (default in the
  // HTML); a signed-in session swaps it for the live-stats grid.
  function setDiaryCardMode(signedIn) {
    var pitch = document.getElementById('diary-card-pitch');
    var signedInBlock = document.getElementById('diary-card-signedin');
    if (pitch) pitch.style.display = signedIn ? 'none' : '';
    if (signedInBlock) signedInBlock.style.display = signedIn ? '' : 'none';
  }

  // ── Your ground card (2026-07-28) ────────────────────────────────────
  // Draws the fl-home-ground-card-v1 snapshot diary.js writes: boundary
  // parcels, seat towers/dots and the next sit - pure SVG from cached data,
  // no Leaflet, no tiles, no network. Hidden signed-out; the empty state is
  // the mapping invitation for signed-in users with nothing mapped yet.

  /** PURE (vm-extracted by tests): uniform Web-Mercator lat/lng -> px fit,
      centred. Conformal like the slippy tile pyramid, so vectors drawn with
      this fit align with satellite tiles placed by gcTileMosaic(). */
  function gcFit(pts, w, h, pad) {
    var D = Math.PI / 180;
    function mx(lng) { return lng * D; }
    function my(lat) { return Math.log(Math.tan(Math.PI / 4 + (lat * D) / 2)); }
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var X = mx(pts[i][1]), Y = my(pts[i][0]);
      if (X < minX) minX = X;
      if (X > maxX) maxX = X;
      if (Y < minY) minY = Y;
      if (Y > maxY) maxY = Y;
    }
    if (!isFinite(minX)) { minX = maxX = 0; minY = maxY = 0; }
    var cX = (minX + maxX) / 2, cY = (minY + maxY) / 2;
    // 0.0004 deg-of-lat metric floor, in mercator units at this latitude
    var cosMid = Math.max(Math.cos(2 * Math.atan(Math.exp(cY)) - Math.PI / 2), 0.01);
    var floorSpan = (0.0004 * D) / cosMid;
    var spanX = Math.max(maxX - minX, floorSpan);
    var spanY = Math.max(maxY - minY, floorSpan);
    var s = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
    var m = function (p) {
      return [w / 2 + (mx(p[1]) - cX) * s, h / 2 + (cY - my(p[0])) * s];
    };
    m.cX = cX; m.cY = cY; m.s = s;
    return m;
  }

  var GC_TOWER = '<g stroke="#fff" stroke-width="2.6" fill="none" stroke-linejoin="round">'
    + '<path d="M11 27 L7 42 M29 27 L33 42 M12 36 L28 36"/>'
    + '<path d="M3 11 L20 2 L37 11 Z"/><rect x="7" y="11" width="26" height="16" rx="3.5"/></g>'
    + '<path d="M11 27 L7 42 M29 27 L33 42 M12 36 L28 36" stroke="#2d3a1f" stroke-width="2.2" fill="none"/>'
    + '<path d="M3 11 L20 2 L37 11 Z" fill="#2d3a1f"/><rect x="7" y="11" width="26" height="16" rx="3.5" fill="#2d3a1f"/>';
  var GC_BAND = { g: '#5ab43c', a: '#d8b054', o: '#d8792e' };

  // Satellite backdrop: the same Mapbox satellite-streets imagery the diary
  // map's Satellite layer uses (Esri if Mapbox errors, dark panel offline).
  var GC_ATTR_TEXT = { mapbox: '\u00a9 Mapbox \u00a9 Maxar', esri: '\u00a9 Esri' };
  var gcTileSeq = 0;
  var gcTileState = { mosaic: null };

  function gcMapboxToken() {
    try {
      var meta = document.querySelector('meta[name="fl-mapbox-token"]');
      return meta ? String(meta.getAttribute('content') || '').trim() : '';
    } catch (e) { return ''; }
  }

  /** PURE (vm-extracted by tests): pick slippy z/x/y satellite tiles covering
      the fitted panel and place them in panel px. m is a gcFit() mapping
      (carries cX/cY/s). Capped at 8 tiles; zooms out if the cap is hit. */
  function gcTileMosaic(m, w, h) {
    if (!m || !isFinite(m.s) || m.s <= 0) return { z: 0, tiles: [] };
    var z = Math.ceil(Math.log(m.s * Math.PI / 128) / Math.LN2) - 1;
    if (z > 16) z = 16;
    if (z < 3) z = 3;
    var n, span, x0, x1, y0, y1;
    for (;;) {
      n = Math.pow(2, z);
      span = 2 * Math.PI / n;
      var mercW = w / m.s, mercH = h / m.s;
      x0 = Math.floor((m.cX - mercW / 2 + Math.PI) / span);
      x1 = Math.floor((m.cX + mercW / 2 + Math.PI) / span);
      y0 = Math.floor((Math.PI - (m.cY + mercH / 2)) / span);
      y1 = Math.floor((Math.PI - (m.cY - mercH / 2)) / span);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 8 || z <= 3) break;
      z--;
    }
    var tiles = [];
    for (var ty = Math.max(y0, 0); ty <= Math.min(y1, n - 1); ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        var west = tx * span - Math.PI;
        var north = Math.PI - ty * span;
        tiles.push({
          x: ((tx % n) + n) % n,
          y: ty,
          l: w / 2 + (west - m.cX) * m.s,
          t: h / 2 + (m.cY - north) * m.s,
          w: span * m.s,
          h: span * m.s
        });
      }
    }
    return { z: z, tiles: tiles };
  }

  function gcTileUrl(provider, z, x, y) {
    if (provider === 'mapbox') {
      return 'https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/'
        + z + '/' + x + '/' + y + '@2x?access_token=' + encodeURIComponent(gcMapboxToken());
    }
    return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/'
      + z + '/' + y + '/' + x;
  }

  function gcLoadTiles(provider) {
    var tg = document.getElementById('gc-tg');
    var attr = document.getElementById('gc-attr');
    var mos = gcTileState.mosaic;
    if (!tg || !mos || !mos.tiles.length) return;
    if (!navigator.onLine) return; // dark panel is the offline look
    if (provider === 'mapbox' && !gcMapboxToken()) provider = 'esri';
    var want = ++gcTileSeq;
    var imgs = [], failed = false, left = mos.tiles.length;
    function done() {
      if (want !== gcTileSeq) return; // a newer render superseded this load
      if (failed) {
        if (provider === 'mapbox') { gcLoadTiles('esri'); return; }
        tg.innerHTML = '';
        if (attr) attr.classList.remove('on');
        return;
      }
      var out = '';
      for (var i = 0; i < mos.tiles.length; i++) {
        var td = mos.tiles[i];
        out += '<image href="' + imgs[i].src.replace(/&/g, '&amp;')
          + '" x="' + td.l.toFixed(2) + '" y="' + td.t.toFixed(2)
          + '" width="' + (td.w + 0.5).toFixed(2) + '" height="' + (td.h + 0.5).toFixed(2)
          + '" preserveAspectRatio="none"/>';
      }
      out += '<rect x="0" y="0" width="332" height="150" fill="rgba(8,16,6,0.18)"/>';
      tg.innerHTML = out;
      if (attr) { attr.textContent = GC_ATTR_TEXT[provider]; attr.classList.add('on'); }
    }
    mos.tiles.forEach(function (td) {
      var im = new Image();
      im.onload = function () { if (--left === 0) done(); };
      im.onerror = function () { failed = true; if (--left === 0) done(); };
      im.src = gcTileUrl(provider, mos.z, td.x, td.y);
      imgs.push(im);
    });
  }

  function renderGroundCard(signedIn) {
    var card = document.getElementById('ground-card');
    if (!card) return;
    var hint = document.getElementById('gc-signup-hint');
    if (!signedIn) {
      // Signed-out visitors get the SAME mapping pitch (owner, 2026-07-29:
      // a new visitor "isn't seeing anything obvious" - the v3 flagship was
      // invisible before sign-in). Static markup, nothing personal; the
      // #stands deep link survives the auth gate, so the tap lands on the
      // Stands view right after sign-up.
      card.style.display = 'block';
      var f0 = document.getElementById('gc-full');
      var e0 = document.getElementById('gc-empty');
      if (f0) f0.style.display = 'none';
      if (e0) e0.style.display = 'block';
      if (hint) hint.style.display = 'block';
      return;
    }
    if (hint) hint.style.display = 'none';
    var snap = null;
    try { snap = JSON.parse(localStorage.getItem('fl-home-ground-card-v1') || 'null'); } catch (e) { /* fine */ }
    var seats = (snap && snap.seats) || [];
    var parcels = (snap && snap.parcels) || [];
    var full = document.getElementById('gc-full');
    var empty = document.getElementById('gc-empty');
    card.style.display = 'block';
    if (!seats.length && !parcels.length) {
      if (full) full.style.display = 'none';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (full) full.style.display = 'block';
    var sub = document.getElementById('gc-sub');
    if (sub) sub.textContent = (snap.label ? snap.label + ' · ' : '')
      + seats.length + (seats.length === 1 ? ' seat' : ' seats');
    var best = document.getElementById('gc-best');
    if (best) {
      var bn = snap.best ? String(snap.best.name || '').replace(/[<>&"]/g, '') : '';
      best.innerHTML = (snap.best && snap.best.score != null)
        ? 'Next sit \u00b7 ' + (bn ? '<span class="gc-bn">' + bn + '</span> \u00b7 ' : '')
          + String(snap.best.when || '').replace(/[<>&]/g, '') + ' \u00b7 <b>' + Math.round(snap.best.score) + '</b>'
        : '';
    }
    var svg = document.getElementById('gc-svg');
    if (!svg) return;
    var all = [];
    parcels.forEach(function (ring) { ring.forEach(function (p) { all.push(p); }); });
    seats.forEach(function (s) { all.push([s.lat, s.lng]); });
    var map = gcFit(all, 332, 150, 20);
    var out = '';
    parcels.forEach(function (ring, i) {
      var d = ring.map(function (p, j) {
        var xy = map(p);
        return (j ? 'L' : 'M') + xy[0].toFixed(1) + ' ' + xy[1].toFixed(1);
      }).join(' ') + ' Z';
      out += i === 0
        ? '<path d="' + d + '" fill="rgba(90,160,140,0.10)" stroke="#4fa08b" stroke-width="2.2" stroke-linejoin="round"/>'
        : '<path d="' + d + '" fill="rgba(216,176,84,0.08)" stroke="rgba(216,176,84,0.75)" stroke-width="1.8" stroke-linejoin="round"/>';
    });
    var ranked = seats.slice().sort(function (x, y) { return (y.score || 0) - (x.score || 0); });
    // Every seat is a tower (owner: "Highseats are dots") - the best one
    // larger and drawn last so it sits on top; 13+ fall back to dots so a
    // dense ground cannot pile towers on towers.
    ranked.slice(12, 17).forEach(function (s) {
      var xy = map([s.lat, s.lng]);
      out += '<circle cx="' + xy[0].toFixed(1) + '" cy="' + xy[1].toFixed(1)
        + '" r="4.5" fill="' + (GC_BAND[s.band] || '#9a9488') + '" stroke="#fff" stroke-width="1.6"/>';
    });
    var towers = ranked.slice(0, 12);
    for (var ti = towers.length - 1; ti >= 0; ti--) {
      var tw = towers[ti], sc = ti === 0 ? 0.55 : 0.42;
      var txy = map([tw.lat, tw.lng]);
      out += '<g transform="translate(' + (txy[0] - 20 * sc).toFixed(1) + ' ' + (txy[1] - 19 * sc).toFixed(1)
        + ') scale(' + sc + ')">' + GC_TOWER
        + '<circle cx="33" cy="9" r="7.5" fill="' + (GC_BAND[tw.band] || '#9a9488') + '" stroke="#fff" stroke-width="2"/></g>';
    }
    svg.innerHTML = '<g id="gc-tg"></g><g id="gc-vg">' + out + '</g>';
    gcTileState.mosaic = gcTileMosaic(map, 332, 150);
    gcLoadTiles('mapbox');
  }

  async function syncDiaryCard() {
    try {
      var db = supabase.createClient(DIARY_URL, DIARY_KEY);
      var session = await db.auth.getSession();
      if (!session.data.session) { setDiaryCardMode(false); renderGroundCard(false); return; } // signed out — show the pitch

      var user = session.data.session.user;
      setDiaryCardMode(true); // signed in — swap the pitch for live stats
      renderGroundCard(true);
      var meta = user.user_metadata || {};
      var d = getSeasonDates(meta.fl_season_start_month);
      var r = await db.from('cull_entries')
        .select('weight_kg, species, quantity, is_blank')
        .eq('user_id', user.id)
        .gte('date', d.start)
        .lte('date', d.end);

      if (r.error || !r.data) return;
      var stats = diaryCardStats(r.data);
      updateCard(stats.total, stats.kg || '–', stats.spp || '–');
    } catch(e) {
      // Silently fail — dashes remain
    }
  }

  // Run after page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncDiaryCard);
  } else {
    syncDiaryCard();
  }
})();

// ── block ──
// ── Photo Gallery Lightbox ──────────────────────────────────
var _lb = {
  data: {
    Red:             ['Red_3.jpg','Red_4.jpg','Red_1.PNG','Red_2.JPG'],
    Fallow:          ['Fallow_4.jpg','Fallow_3.jpg','Fallow_1.jpg','Fallow_2.jpg'],
    Roe:             ['Roe_4.jpg','Roe_3.jpg','Roe_2.jpg','Roe_1.jpg'],
    Sika:            ['Sika_4.jpg','Sika_3.jpg','Sika_2.jpg','Sika_1.jpg'],
    Muntjac:         ['Muntjac_3.jpg','Muntjac_4.jpg','Muntjac_1.jpg','Muntjac_2.jpg'],
    ChineseWaterDeer:['ChineseWaterDeer_1.jpg','ChineseWaterDeer_3.jpg','ChineseWaterDeer_2.jpg','ChineseWaterDeer_4.jpg'],
    ShotAnglePlates: ['broadsideshot.jpeg', 'quarteringtowardsshot.jpeg', 'headonshot.jpeg'],
  },
  /** Per-image captions; `data` order matches gallery left-to-right and each species' ID guide (not numeric _1…_4). */
  captions: {
    Red: [
      "Hinds & Calf — Hinds (females) and a smaller calf; note the slender, antlerless heads and social grouping.",
      "Young Stag — A juvenile stag with developing, spike-like antlers and a narrower, youthful profile.",
      "Mature Stag — A prime adult stag displaying a thick neck and a full, multi-pointed \"royal\" rack.",
      "Pair — A side-by-side of a mature stag (antlered) and a hind (antlerless), showing clear sexual dimorphism.",
    ],
    Fallow: [
      "Mature Buck — A mature buck featuring the species' signature broad, palmated (shovel-like) antlers.",
      "Melanistic Buck — A melanistic (dark) buck with fully developed palmated antlers, a common color variety.",
      "Common Buck — A buck in common coat displaying white spots and wide, flattened antlers.",
      "Doe & Fawn — An adult doe (female) with her fawn, both showing the distinctive white-spotted summer coat.",
    ],
    Roe: [
      "Summer Buck — A Roe buck in its bright foxy-red summer coat, showing typical short, upright antlers.",
      "Winter Buck — A Roe buck in its grey-brown winter coat, with characteristic large ears and a black nose bridge.",
      "Doe — An adult Roe doe, easily identified by the lack of antlers and large, expressive \"doe eyes.\"",
      "Rump — A Roe buck showcasing the prominent white rump patch used as a \"follow-me\" alarm signal.",
    ],
    Sika: [
      "Summer Hind — A Sika hind (female) in her chestnut-red summer coat, featuring distinctive white spots.",
      "Winter Hinds — A group of hinds in dark, grey-brown winter coats; note the lack of antlers and large ears.",
      "Stags — Two stags showing upright, branched antlers and the species' characteristic white-spotted flanks.",
      "Mature Stag — A mature stag displaying a white rump and the species' trademark \"grumpy\" or angry facial expression.",
    ],
    Muntjac: [
      "Buck — A mature buck displaying his small, unbranched antlers and prominent, visible canine tusks.",
      "Doe & Fawn — An adult doe with her young fawn; note the fawn's shorter snout and softer facial features.",
      "Buck Profile — A buck showcasing the unique, skin-covered \"pedicles\" from which the small antlers grow.",
      "Doe — A typical adult doe showing the hunched profile and the dark, \"V-shaped\" hair tuft on the forehead.",
    ],
    ChineseWaterDeer: [
      "Buck — A mature buck showing the species' famous trait: long, protruding canine tusks and large, rounded ears.",
      "Buck Profile — A buck in profile; this is the only deer species where males grow tusks instead of antlers.",
      "Doe — An adult doe, distinguished by her lack of tusks and a slightly more delicate facial structure.",
      "Winter Coat — A Water Deer in its thicker winter coat, standing with its characteristic level back and powerful hindquarters.",
    ],
    ShotAnglePlates: [
      'Broadside — Heart/lung “engine room” behind the foreleg; liver and paunch sit further back.',
      'Quartering towards — Shoulder and front leg are more in the path; the bullet must still reach the chest vitals.',
      'Head-on — The chest target is very narrow; vitals are easier to read on the plate than in the field.',
    ],
  },
  speciesNames: {
    Red: 'Red Deer',
    Fallow: 'Fallow Deer',
    Roe: 'Roe Deer',
    Sika: 'Sika Deer',
    Muntjac: 'Muntjac',
    ChineseWaterDeer: 'Chinese Water Deer',
    ShotAnglePlates: 'Roe (illustrative)',
  },
  base: 'https://firstlightdeer.co.uk/species/gallery/',
  baseByKey: {
    ShotAnglePlates: 'https://firstlightdeer.co.uk/species/',
  },
  key: null, idx: 0
};

function _lbCaptionShortTitle(full) {
  if (!full) return '';
  var i = full.indexOf(' — ');
  return i === -1 ? full : full.slice(0, i);
}

var _lbTrigger = null;

function openLightbox(key, idx) {
  var shell = document.getElementById('gallery-lightbox');
  if (!shell) return;
  _lbTrigger = document.activeElement;
  _lb.key = key; _lb.idx = idx;
  _lbRender();
  shell.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  var shell = document.getElementById('gallery-lightbox');
  if (shell) shell.classList.remove('open');
  document.body.style.overflow = '';
  if (_lbTrigger && _lbTrigger.focus) {
    try { _lbTrigger.focus(); } catch(e) {}
    _lbTrigger = null;
  }
}

function lightboxNav(dir) {
  var files = _lb.data[_lb.key];
  if (!files || !files.length) return;
  _lb.idx = (_lb.idx + dir + files.length) % files.length;
  _lbRender();
}

function _lbRender() {
  var files = _lb.data[_lb.key];
  if (!files || !files.length) return;
  var f = files[_lb.idx];
  var img = document.getElementById('lightbox-img');
  var cap = document.getElementById('lightbox-caption');
  var ctr = document.getElementById('lightbox-counter');
  if (!img || !cap || !ctr) return;
  var base = _lb.baseByKey && _lb.baseByKey[_lb.key] != null ? _lb.baseByKey[_lb.key] : _lb.base;
  img.src = base + f;
  var spName = _lb.speciesNames[_lb.key] || _lb.key.replace(/([A-Z])/g, ' $1').trim();
  var capLine = (_lb.captions[_lb.key] || [])[_lb.idx] || '';
  img.alt = spName + ' — ' + _lbCaptionShortTitle(capLine);
  cap.textContent = '';
  var spEl = document.createElement('div');
  spEl.className = 'lightbox-caption-species';
  spEl.textContent = spName;
  var detEl = document.createElement('div');
  detEl.className = 'lightbox-caption-detail';
  detEl.textContent = capLine;
  cap.appendChild(spEl);
  cap.appendChild(detEl);
  ctr.textContent = (_lb.idx + 1) + ' / ' + files.length;
}

// Close on backdrop click + swipe (only if lightbox exists)
document.addEventListener('DOMContentLoaded', function() {
  var lbShell = document.getElementById('gallery-lightbox');
  if (lbShell) {
    lbShell.addEventListener('click', function(e) {
      if (e.target === this) closeLightbox();
    });
  }

  var lb = document.getElementById('gallery-lightbox');
  if (!lb) return;
  var sx = 0, sy = 0, pinching = false, maxTouches = 0;
  lb.addEventListener('touchstart', function(e){
    maxTouches = Math.max(maxTouches, e.touches.length);
    pinching = e.touches.length > 1;
    if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
  }, {passive:true});
  lb.addEventListener('touchmove', function(e){
    if (e.touches.length > 1) { pinching = true; maxTouches = Math.max(maxTouches, e.touches.length); }
  }, {passive:true});
  lb.addEventListener('touchend', function(e){
    // If at any point more than 1 finger was involved, ignore
    if (maxTouches > 1) { if (e.touches.length === 0) { pinching = false; maxTouches = 0; } return; }
    if (pinching) { pinching = false; maxTouches = 0; return; }
    maxTouches = 0;
    var dx = e.changedTouches[0].clientX - sx;
    var dy = Math.abs(e.changedTouches[0].clientY - sy);
    if (Math.abs(dx) > 50 && dy < 60) lightboxNav(dx < 0 ? 1 : -1);
  }, {passive:true});
});
