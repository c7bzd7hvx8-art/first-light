// First Light — modules/sw-bridge.mjs
//
// Service-worker glue for the Cull Diary page. Registers ./sw.js, wires the
// `controllerchange` + `updatefound` → `statechange` listeners, and lazily
// builds the "New version available — Reload" bottom banner so the user
// doesn't have to hunt for the refresh option after we ship an update.
//
// Extracted from diary.js L2034-2113 (80 lines) under the modularisation
// plan. Behaviour is identical — same registration path, same listener
// topology, same banner DOM. The only change is that `initSwBridge()` must
// be called from diary.js (previously the block ran as top-level side-
// effecting code).
//
// Public API
//   initSwBridge()  — call once on load. Safe to call multiple times; the
//                     inner helper is idempotent once the bar is visible.

// Module-local state (was file-global `flSwUpdateBarShown` in diary.js).
// Tracks whether the update banner has been rendered so repeated
// controllerchange / statechange fires don't stack multiple bars.
let swUpdateBarShown = false;

/**
 * Show a persistent bottom-banner telling the user a new service worker is
 * controlling the page and they should reload to pick up the latest code.
 * Safer than a transient toast — if the user taps away before reading a
 * toast they've missed the prompt entirely. The bar sticks until dismissed
 * or Reload is tapped. Builds the DOM lazily so it doesn't ship as markup.
 * Idempotent: repeated calls are no-ops once the bar is visible.
 */
function showSwUpdateBar() {
  if (swUpdateBarShown) return;
  swUpdateBarShown = true;
  const bar = document.createElement('div');
  bar.id = 'sw-update-bar';
  bar.className = 'sw-update-bar';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');

  const txt = document.createElement('div');
  txt.className = 'sw-update-bar-txt';
  txt.innerHTML = 'New version available'
    + '<span class="sw-update-bar-sub">Tap Reload to switch to the latest Cull Diary.</span>';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sw-update-bar-btn';
  btn.textContent = 'Reload';
  btn.addEventListener('click', function() { location.reload(); });

  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'sw-update-bar-x';
  x.setAttribute('aria-label', 'Dismiss update notice');
  x.textContent = '×';
  x.addEventListener('click', function() {
    if (bar.parentNode) bar.parentNode.removeChild(bar);
    // Note: NOT resetting swUpdateBarShown — if the user explicitly
    // dismisses we don't re-nag on the same page load. Next reload / next
    // controllerchange they'll get it again.
  });

  bar.appendChild(txt);
  bar.appendChild(btn);
  bar.appendChild(x);
  document.body.appendChild(bar);
}

// Guard to make init idempotent at the module level — if diary.js ever
// ends up importing + initialising twice (hot reload, dev tooling) we
// only attach one set of SW listeners.
let initialised = false;

/**
 * Register ./sw.js and hook the two signal paths that tell us "fresh code
 * is now serving this page":
 *
 *   1. `controllerchange` on navigator.serviceWorker — fires when the new
 *      SW takes over. With `skipWaiting()` + `clients.claim()` in sw.js
 *      this is the most reliable signal. We snapshot the initial
 *      controller so we don't flash the update banner on first install.
 *   2. `updatefound` → new worker `statechange === 'installed'` — belt-
 *      and-braces for the case where another tab is still holding the old
 *      controller and `controllerchange` hasn't fired yet.
 *
 * Called from diary.js once DOM ready. Safe under `file://` / browsers
 * without SW — the outer `'serviceWorker' in navigator` guard bails early.
 */
export function initSwBridge() {
  if (initialised) return;
  initialised = true;

  // Register SW when diary is opened directly (index.html also registers
  // via app.js — duplicate register is a no-op).
  if (!('serviceWorker' in navigator)) return;

  // Snapshot the controller present when the page loaded. If this page
  // never had a controller (= first install / first visit) we must NOT
  // prompt for reload on the first controllerchange — that's just the
  // initial activation, not a true update.
  const initialController = navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', function() {
    if (initialController) showSwUpdateBar();
  });

  window.addEventListener('load', function() {
    navigator.serviceWorker.register('./sw.js').then(function(reg) {
      reg.addEventListener('updatefound', function() {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', function() {
          // Belt-and-braces: if controllerchange hasn't fired yet (e.g. the
          // SW is stuck waiting because another tab is still holding the
          // old controller) we still surface the update once the new worker
          // reaches `installed`.
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showSwUpdateBar();
          }
        });
      });
    }).catch(function() { /* file:// or blocked */ });
  });
}
