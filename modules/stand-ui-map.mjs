// First Light — modules/stand-ui-map.mjs
//
// Owns the third Leaflet map on diary.html (alongside pinMap and
// cullMap inside diary.js). Renders a marker per stand plus a wind
// scent-cone for the active slot. The cone polygon is repainted on
// slot scrub.
//
// Tile sources are kept independent of diary.js's variables (which
// are module-scope inside diary.js, not exported) — we use the same
// OS UK key in the leaflet meta-tag pattern, falling back to public
// Esri imagery for satellite. CSP for api.os.uk and arcgisonline.com
// is already in diary.html.

import { destinationPoint, bearingTo } from './stand-rank.mjs';

const OS_KEY = 'IRnioue2Sizx0EOCvtix6EJ8BxdlNoNd'; // matches diary.js:5578
const TILE_OS_STD   = 'https://api.os.uk/maps/raster/v1/zxy/Road_3857/{z}/{x}/{y}.png?key=' + OS_KEY;
const TILE_SAT_ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

let standMap     = null;
let standMapStd  = null;
let standMapSat  = null;
let markerGroup  = null;
let coneLayer    = null;
let onMarkerTap  = null;

/** Init or return existing map. Pass containerId once. */
export function ensureMap(containerId, { initialCenter, onTap } = {}) {
  if (standMap) return standMap;
  const el = document.getElementById(containerId);
  if (!el) return null;
  if (typeof L === 'undefined') {
    console.warn('[stand-ui-map] Leaflet (L) not loaded yet');
    return null;
  }
  const center = initialCenter || [54.5, -2.3];
  standMap = L.map(el, {
    center,
    zoom: 13,
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true
  });
  standMapStd = L.tileLayer(TILE_OS_STD, {
    maxZoom: 19,
    attribution: '© Crown copyright and database rights ' + new Date().getFullYear() + ' OS'
  }).addTo(standMap);
  standMapSat = L.tileLayer(TILE_SAT_ESRI, {
    maxZoom: 19,
    attribution: 'Imagery © Esri'
  });
  markerGroup = (typeof L.markerClusterGroup === 'function')
    ? L.markerClusterGroup({ disableClusteringAtZoom: 14 })
    : L.layerGroup();
  markerGroup.addTo(standMap);
  coneLayer = L.featureGroup().addTo(standMap);
  onMarkerTap = onTap || null;

  // Fix Leaflet sizing inside a flex/hidden parent that just became visible
  setTimeout(() => standMap && standMap.invalidateSize(), 50);
  return standMap;
}

export function setLayerMode(mode) {
  if (!standMap) return;
  if (mode === 'sat') {
    if (standMap.hasLayer(standMapStd)) standMap.removeLayer(standMapStd);
    if (!standMap.hasLayer(standMapSat)) standMapSat.addTo(standMap);
  } else {
    if (standMap.hasLayer(standMapSat)) standMap.removeLayer(standMapSat);
    if (!standMap.hasLayer(standMapStd)) standMapStd.addTo(standMap);
  }
}

/** Force a size recalc — call after the view container becomes visible. */
export function refreshSize() {
  if (standMap) standMap.invalidateSize();
}

/**
 * Re-draw all stand markers. Replaces previous markers.
 *   stands: Stand[]
 *   activeId: id of currently-selected stand (highlighted)
 */
export function setStands(stands, activeId) {
  if (!markerGroup) return;
  markerGroup.clearLayers();
  if (!stands || !stands.length) return;
  const bounds = [];
  for (const s of stands) {
    if (s.lat == null || s.lng == null) continue;
    const isActive = s.id === activeId;
    const icon = L.divIcon({
      className: 'stand-marker',
      html: '<div style="width:' + (isActive ? 28 : 22) + 'px;height:' + (isActive ? 28 : 22) + 'px;border-radius:50%;background:'
        + (isActive ? '#c8a84b' : 'rgba(200,168,75,0.55)')
        + ';border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-weight:700;color:#1a1a1a;font-size:11px;">'
        + ((s.name || '?').charAt(0).toUpperCase()) + '</div>',
      iconSize: [isActive ? 28 : 22, isActive ? 28 : 22],
      iconAnchor: [isActive ? 14 : 11, isActive ? 14 : 11]
    });
    const marker = L.marker([s.lat, s.lng], { icon, title: s.name || 'Stand' });
    marker.on('click', () => onMarkerTap && onMarkerTap(s));
    markerGroup.addLayer(marker);
    bounds.push([s.lat, s.lng]);
  }
  if (bounds.length === 1) standMap.setView(bounds[0], 14);
  else if (bounds.length > 1) standMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
}

/**
 * Repaint the wind cone for one stand at one slot. Cleared first to
 * avoid the per-marker leak pattern documented at diary.js:1995.
 *   stand: { lat, lng, preferred_approach_deg }
 *   slot:  { windDeg, windMph }
 *   score: 0..100 — colours the cone fill.
 */
export function setActiveCone(stand, slot, score) {
  if (!coneLayer) return;
  coneLayer.clearLayers();
  if (!stand || slot == null || slot.windDeg == null) return;

  const windMph = slot.windMph || 5;
  const R = clamp(150 + windMph * 25, 200, 800);                  // metres
  const HALF_ANGLE = clamp(45 - windMph, 15, 45);                 // degrees
  const scentDeg = (slot.windDeg + 180) % 360;                    // wind blows TO

  const tip   = [stand.lat, stand.lng];
  const left  = destinationPoint(stand.lat, stand.lng, scentDeg - HALF_ANGLE, R);
  const right = destinationPoint(stand.lat, stand.lng, scentDeg + HALF_ANGLE, R);
  const fill = scoreToColour(score);

  L.polygon([tip, left, right], {
    color: '#c8a84b',
    weight: 1,
    fillColor: fill,
    fillOpacity: 0.35
  }).addTo(coneLayer);

  // Axis arrow — thin black line in the centre of the cone for clarity at low zoom
  const axisEnd = destinationPoint(stand.lat, stand.lng, scentDeg, R);
  L.polyline([tip, axisEnd], {
    color: '#222',
    weight: 1.5,
    opacity: 0.7,
    dashArray: '4 4'
  }).addTo(coneLayer);

  // Approach indicator — hollow circle on the side deer come FROM
  if (stand.preferred_approach_deg != null) {
    const approachEnd = destinationPoint(stand.lat, stand.lng, stand.preferred_approach_deg, R * 0.4);
    L.circleMarker(approachEnd, {
      radius: 6,
      color: '#fff',
      fillColor: 'transparent',
      weight: 2,
      opacity: 0.85
    }).bindTooltip('Deer approach', { permanent: false, direction: 'top' }).addTo(coneLayer);
  }
}

function scoreToColour(score) {
  if (score == null) return '#888';
  if (score >= 70) return '#3fae5e';
  if (score >= 50) return '#c8a84b';
  if (score >= 35) return '#d97a2c';
  return '#c62828';
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// Re-export for callers that want geometry without pulling in stand-rank
export { destinationPoint, bearingTo };
