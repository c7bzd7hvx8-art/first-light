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
//   * When enabled, reveal the nav button and lazily import the
//     planner controller (no cold-start cost when the flag is off).
//   * Wire the refresh button and layer toggle inside the v-stand view.

const URL_FLAG_KEY = 'fl_stand_planner_flag';

// URL escape hatch: ?stand=1 (or ?stand) flips the persistent flag,
// ?stand=0 clears it. Lets us toggle from mobile Safari without DevTools.
const _urlFlag = new URLSearchParams(location.search).get('stand');
if (_urlFlag === '1' || _urlFlag === '') localStorage.setItem(URL_FLAG_KEY, '1');
else if (_urlFlag === '0') localStorage.removeItem(URL_FLAG_KEY);

if (localStorage.getItem(URL_FLAG_KEY) === '1') {
  const navBtn = document.getElementById('n-stand');
  if (navBtn) navBtn.style.display = '';
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
          const m = await import('./stand-ui-map.mjs');
          m.setLayerMode(mode);
        });
      });
    }
  } catch (e) {
    console.warn('[stand-planner] failed to boot', e);
  }
}
