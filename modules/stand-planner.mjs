// First Light — modules/stand-planner.mjs
//
// Top-level controller for the Wind & Stand Planner view in diary.html.
// Owns:
//   * sub-tab state (Tonight / Map / My stands)
//   * GPS handshake + stand-list load
//   * Open-Meteo forecast fetch and 14-slot construction
//   * orchestration of stand-rank scoring + stand-ui-card rendering +
//     stand-ui-map cone repaint
//
// Public API
//   initStandPlanner(rootEl, opts) — call once, after the v-stand block
//                                    is in the DOM and Leaflet has loaded.
//   refreshStandPlanner()          — manual refresh (forecast bypass cache).
//
// `opts` shape:
//   {
//     tonightCardId:  'stand-card',
//     scrubberId:     'stand-scrubber',
//     listId:         'stand-list',
//     mapId:          'stand-map',
//     tabsId:         'stand-tabs',
//     onAddStand:     fn (opens add-stand UI — see diary.js pin-drop)
//   }

import { calcSunTime, toMinutes, fmtMins } from './sun-times.mjs';
import { fetch7DayForecast, unpackHourly, unpackDaily } from './activity-engine.mjs';
import {
  loadStands, loadStandsCache, deleteStand, loadCullEntriesNear
} from './stand-data.mjs';
import { score, bestStandForSlot } from './stand-rank.mjs';
import {
  renderCard, renderScrubber, renderEmpty, renderStandsList, formatSlotLabel
} from './stand-ui-card.mjs';
import {
  ensureMap, setStands as mapSetStands, setActiveCone, refreshSize, setLayerMode
} from './stand-ui-map.mjs';

const FORECAST_CACHE_KEY = 'fl_stand_forecast_v1';
const FALLBACK_CENTER = [54.5, -2.3]; // central UK

const state = {
  opts: null,
  rootEl: null,
  initialised: false,
  activeTab: 'tonight',                 // tonight | map | list
  stands: [],
  forecast: null,
  forecastFetchedAt: 0,
  slots: [],                            // 14 slots
  activeSlotIdx: 0,
  cullEntries: [],
  position: null,                       // { lat, lng }
};

/** Boot the planner. Idempotent — safe to call after the user toggles back. */
export function initStandPlanner(rootEl, opts = {}) {
  state.rootEl = rootEl;
  state.opts = {
    tonightCardId: opts.tonightCardId || 'stand-card',
    scrubberId:    opts.scrubberId    || 'stand-scrubber',
    listId:        opts.listId        || 'stand-list',
    mapId:         opts.mapId         || 'stand-map',
    tabsId:        opts.tabsId        || 'stand-tabs',
    onAddStand:    opts.onAddStand    || null
  };

  if (!state.initialised) {
    state.initialised = true;
    wireTabs();
    state.stands = loadStandsCache();
    paintForActiveTab();
    void refreshStandPlanner();
  } else {
    paintForActiveTab();
  }
}

/** Force a full refresh: GPS, stands, forecast, cull entries, repaint. */
export async function refreshStandPlanner() {
  await ensurePosition();
  state.stands = await loadStands();
  if (!state.stands.length) {
    paintForActiveTab();
    return;
  }
  // Use first stand's coords as the forecast anchor — Open-Meteo cache
  // keyed by 3dp coords means nearby stands will share the cache.
  const anchor = state.position || { lat: state.stands[0].lat, lng: state.stands[0].lng };
  await fetchForecast(anchor.lat, anchor.lng);
  await loadHistoryForStands();
  buildSlots();
  paintForActiveTab();
}

// ── Tabs ──────────────────────────────────────────────────────
function wireTabs() {
  const tabs = document.getElementById(state.opts.tabsId);
  if (!tabs) return;
  tabs.querySelectorAll('[data-stand-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.getAttribute('data-stand-tab');
      if (!next || next === state.activeTab) return;
      state.activeTab = next;
      tabs.querySelectorAll('[data-stand-tab]').forEach(b => {
        b.classList.toggle('on', b.getAttribute('data-stand-tab') === next);
      });
      paintForActiveTab();
    });
  });
}

function paintForActiveTab() {
  const tonightEl = document.getElementById(state.opts.tonightCardId);
  const scrubEl   = document.getElementById(state.opts.scrubberId);
  const listEl    = document.getElementById(state.opts.listId);

  // Section visibility
  const tonightSection = document.getElementById('stand-tonight-section');
  const mapSection     = document.getElementById('stand-map-section');
  const listSection    = document.getElementById('stand-list-section');
  if (tonightSection) tonightSection.style.display = state.activeTab === 'tonight' ? '' : 'none';
  if (mapSection)     mapSection.style.display     = state.activeTab === 'map'     ? '' : 'none';
  if (listSection)    listSection.style.display    = state.activeTab === 'list'    ? '' : 'none';

  if (state.activeTab === 'tonight') paintTonight(tonightEl, scrubEl);
  else if (state.activeTab === 'map') paintMap();
  else if (state.activeTab === 'list') paintList(listEl);
}

function paintTonight(cardEl, scrubEl) {
  if (!state.stands.length) {
    if (cardEl) renderEmpty(cardEl, () => state.opts.onAddStand && state.opts.onAddStand());
    if (scrubEl) scrubEl.innerHTML = '';
    return;
  }
  if (!state.slots.length) {
    if (cardEl) cardEl.innerHTML = '<div style="padding:24px;text-align:center;color:rgba(255,255,255,0.5);font-size:13px;">Loading forecast…</div>';
    return;
  }
  const slot = state.slots[state.activeSlotIdx];
  const result = bestStandForSlot(state.stands, slot, { entries: state.cullEntries });
  if (!result) return;
  renderCard(cardEl, { stand: result.stand, score: result.score, slot });
  renderScrubber(scrubEl, state.slots, state.activeSlotIdx, idx => {
    state.activeSlotIdx = idx;
    paintTonight(cardEl, scrubEl);
    if (state.activeTab === 'map') paintMap();
  });
}

function paintMap() {
  const map = ensureMap(state.opts.mapId, {
    initialCenter: state.position
      ? [state.position.lat, state.position.lng]
      : FALLBACK_CENTER,
    onTap: (s) => {
      // Tapping a marker focuses that stand for the active slot
      const slot = state.slots[state.activeSlotIdx];
      if (!slot) return;
      const r = score(s, slot, { entries: state.cullEntries });
      setActiveCone(s, slot, r.total);
      const cardEl = document.getElementById(state.opts.tonightCardId);
      if (cardEl) renderCard(cardEl, { stand: s, score: r, slot });
    }
  });
  if (!map) return;
  refreshSize();
  mapSetStands(state.stands);
  if (state.slots.length && state.stands.length) {
    const slot = state.slots[state.activeSlotIdx];
    const result = bestStandForSlot(state.stands, slot, { entries: state.cullEntries });
    if (result) setActiveCone(result.stand, slot, result.score.total);
  }
}

function paintList(listEl) {
  renderStandsList(listEl, state.stands, {
    onAdd:    () => state.opts.onAddStand && state.opts.onAddStand(),
    onEdit:   (s) => state.opts.onAddStand && state.opts.onAddStand(s),
    onDelete: async (s) => {
      try {
        await deleteStand(s.id);
        state.stands = state.stands.filter(x => x.id !== s.id);
        paintForActiveTab();
      } catch (e) {
        alert('Could not delete: ' + (e.message || e));
      }
    }
  });
}

// ── GPS + forecast ────────────────────────────────────────────
function ensurePosition() {
  if (state.position) return Promise.resolve(state.position);
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => {
        state.position = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        resolve(state.position);
      },
      _err => resolve(null),
      { maximumAge: 600000, timeout: 10000 }
    );
  });
}

async function fetchForecast(lat, lng) {
  // Try in-memory cache first via fetch7DayForecast (20 min). On failure
  // fall back to localStorage cache (per 3-decimal-place key).
  try {
    const f = await fetch7DayForecast(lat, lng);
    state.forecast = f;
    state.forecastFetchedAt = Date.now();
    saveForecastToLocal(lat, lng, f);
  } catch (e) {
    state.forecast = loadForecastFromLocal(lat, lng);
  }
}

function saveForecastToLocal(lat, lng, forecast) {
  try {
    const k = key3dp(lat, lng);
    const raw = localStorage.getItem(FORECAST_CACHE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[k] = { fetched_at: Date.now(), forecast };
    // Cap at 30 keys — drop oldest by fetched_at when over.
    const keys = Object.keys(map);
    if (keys.length > 30) {
      keys.sort((a, b) => (map[a].fetched_at || 0) - (map[b].fetched_at || 0));
      while (keys.length > 30) delete map[keys.shift()];
    }
    localStorage.setItem(FORECAST_CACHE_KEY, JSON.stringify(map));
  } catch (e) { /* quota — fine */ }
}

function loadForecastFromLocal(lat, lng) {
  try {
    const raw = localStorage.getItem(FORECAST_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    const entry = map[key3dp(lat, lng)];
    return entry ? entry.forecast : null;
  } catch (e) { return null; }
}

function key3dp(lat, lng) {
  return lat.toFixed(3) + ',' + lng.toFixed(3);
}

async function loadHistoryForStands() {
  if (!state.stands.length) { state.cullEntries = []; return; }
  // Single bbox-ish call: load entries near the centroid of all stands.
  const cx = state.stands.reduce((a, s) => a + s.lat, 0) / state.stands.length;
  const cy = state.stands.reduce((a, s) => a + s.lng, 0) / state.stands.length;
  // Spread radius wide enough to cover all stands plus the 300 m
  // history-match radius the rank module applies per-stand.
  state.cullEntries = await loadCullEntriesNear(cx, cy, 5000);
}

// ── Slot construction ─────────────────────────────────────────
// Builds the next 14 slots: today's dawn (if not passed), today's dusk,
// then dawn+dusk for each of the next 6 days. Trimmed to <= 14 entries.
function buildSlots() {
  if (!state.forecast || !state.stands.length) { state.slots = []; return; }
  const anchor = state.position
    || { lat: state.stands[0].lat, lng: state.stands[0].lng };
  const slots = [];
  const now = new Date();
  for (let dayIdx = 0; dayIdx < 7 && slots.length < 14; dayIdx++) {
    const date = new Date(now);
    date.setDate(date.getDate() + dayIdx);
    const sr = calcSunTime(date, anchor.lat, anchor.lng, true);
    const ss = calcSunTime(date, anchor.lat, anchor.lng, false);
    if (sr) {
      const srMin = toMinutes(sr);
      // Mid-dawn: 30 min after sunrise
      const dawnMin = srMin + 30;
      const dawnHour = Math.floor(dawnMin / 60);
      maybePush(slots, date, dawnHour, dawnMin, 'dawn', dayIdx, now);
    }
    if (ss) {
      const ssMin = toMinutes(ss);
      // Mid-dusk: 30 min before sunset
      const duskMin = ssMin - 30;
      const duskHour = Math.floor(duskMin / 60);
      maybePush(slots, date, duskHour, duskMin, 'dusk', dayIdx, now);
    }
  }
  state.slots = slots;
  if (state.activeSlotIdx >= slots.length) state.activeSlotIdx = 0;
}

function maybePush(slots, date, hour, minutesSinceMidnight, kind, dayIdx, now) {
  // Skip past slots on day 0
  if (dayIdx === 0) {
    const slotMs = new Date(date);
    slotMs.setHours(hour, minutesSinceMidnight % 60, 0, 0);
    if (slotMs.getTime() < now.getTime()) return;
  }
  const wxHour = unpackHourly(state.forecast, dayIdx, hour);
  if (!wxHour) return;
  // Convert km/h → mph for the planner UI; activity-engine still gets km/h.
  const windMph = wxHour.wind != null ? wxHour.wind * 0.621 : null;
  slots.push({
    date: new Date(date),
    dayIdx,
    hour,
    minutesSinceMidnight,
    kind,
    windDeg: wxHour.windDeg,
    windMph,
    wxHour
  });
}

// Re-export for any caller that wants the formatter
export { formatSlotLabel };
