// First Light — modules/stand-boot.mjs
//
// CSP-compliant bootstrap for the Wind & Stand Planner.
// Loaded via <script type="module" src="..."> from diary.html so it
// passes the script-src 'self' rule (an inline <script> block would
// need 'unsafe-inline' which the CSP intentionally omits).
//
// Responsibilities:
//   * Honour the URL escape hatch ?stand=1 / ?stand=0 for mobile
//     dogfooding without a JS console.
//   * Respect the persistent localStorage flag fl_stand_planner_flag.
//   * Wire the sub-tab switching IMMEDIATELY (no controller dependency)
//     so the tabs work even if the planner module fails to import.
//   * Lazily import the planner controller for the heavy work (forecast,
//     scoring, map rendering).

const URL_FLAG_KEY = 'fl_stand_planner_flag';

// URL escape hatch: ?stand=1 (or ?stand) flips the persistent flag,
// ?stand=0 clears it. Lets us toggle from mobile Safari without DevTools.
const _urlFlag = new URLSearchParams(location.search).get('stand');
if (_urlFlag === '1' || _urlFlag === '') localStorage.setItem(URL_FLAG_KEY, '1');
else if (_urlFlag === '0') localStorage.removeItem(URL_FLAG_KEY);

if (localStorage.getItem(URL_FLAG_KEY) === '1') {
  const navBtn = document.getElementById('n-stand');
  if (navBtn) navBtn.style.display = '';

  // Wire sub-tab switching synchronously — no controller required, so
  // the user gets responsive tabs even if the planner module 404s,
  // throws, or the SW serves a stale copy.
  wireBareTabs();

  // Lazily import the controller. Any failure leaves the static fallback
  // content (see diary.html #stand-card) visible to the user.
  loadController();
}

function wireBareTabs() {
  const tabs = document.getElementById('stand-tabs');
  if (!tabs) return;
  const sections = {
    tonight: document.getElementById('stand-tonight-section'),
    map:     document.getElementById('stand-map-section'),
    list:    document.getElementById('stand-list-section')
  };
  tabs.querySelectorAll('[data-stand-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-stand-tab');
      if (!next) return;
      tabs.querySelectorAll('[data-stand-tab]').forEach(b => {
        b.classList.toggle('on', b === btn);
      });
      Object.keys(sections).forEach(k => {
        if (sections[k]) sections[k].style.display = k === next ? '' : 'none';
      });
      // Notify the controller (if loaded) so it can repaint dynamic
      // content for the newly-active tab.
      window.dispatchEvent(new CustomEvent('fl-stand-tab', { detail: { tab: next } }));
    });
  });
}

async function loadController() {
  try {
    const planner = await import('./stand-planner.mjs');
    const standView = document.getElementById('v-stand');
    planner.initStandPlanner(standView, {
      // onAddStand stays a stub for now — wiring it to the diary.js
      // pin-drop overlay (#pinmap-overlay, see ~5689) is the next
      // increment. Until then, users add stands via Supabase directly.
      onAddStand: () => {
        alert('Add-stand UI lands in the next increment.\n\nFor now, insert into public.stands in the Supabase dashboard with your lat/lng and preferred_approach_deg, then refresh.');
      }
    });
    // Bridge the bare-tab event to the controller's repaint.
    window.addEventListener('fl-stand-tab', e => {
      try { planner.setActiveTab && planner.setActiveTab(e.detail.tab); } catch (_) {}
    });
    const refreshBtn = document.getElementById('stand-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => planner.refreshStandPlanner());
    const layerTog = document.getElementById('stand-layer-tog');
    if (layerTog) {
      layerTog.querySelectorAll('[data-stand-layer]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const mode = btn.getAttribute('data-stand-layer');
          layerTog.querySelectorAll('[data-stand-layer]').forEach(b => {
            b.classList.toggle('on', b === btn);
            b.classList.toggle('off', b !== btn);
          });
          try {
            const m = await import('./stand-ui-map.mjs');
            m.setLayerMode(mode);
          } catch (e) { console.warn('[stand-planner] map module failed', e); }
        });
      });
    }
  } catch (e) {
    // Surface the failure in the static card so a tethered debug session
    // can see it. Most users will just see the fallback empty state.
    console.warn('[stand-planner] failed to boot', e);
    const card = document.getElementById('stand-card');
    if (card) {
      const errTag = document.createElement('div');
      errTag.style.cssText = 'font-size:10px;color:#e57373;font-family:DM Mono,monospace;text-align:center;padding:0 20px 12px;';
      errTag.textContent = 'Controller failed: ' + (e && e.message ? e.message : String(e));
      card.appendChild(errTag);
    }
  }
}

