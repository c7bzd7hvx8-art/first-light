// First Light — modules/stand-rank.mjs
//
// Pure scoring for the Wind & Stand Planner. Blends the home-page
// activity-engine score with two stand-specific factors the engine
// doesn't know about: wind alignment vs the stand's preferred approach
// bearing, and historical similarity to nearby cull entries.
//
// All exports are pure functions — no Supabase, no DOM, no globals.
// Easy to unit-test from the parity harness page.
//
// Public API
//   score(stand, slot, ctx)         → { total, breakdown }
//   bestStandForSlot(stands, slot, ctx)  → { stand, score, breakdown }
//   windAlignment(stand, slot)      → 0..1
//   historyMatch(stand, slot, ctx)  → 0..1
//   bearingTo(lat1,lng1, lat2,lng2) → 0..360
//   destinationPoint(lat,lng, bearingDeg, distMeters) → [lat, lng]
//   angularDiff(a, b)               → 0..180

import { hourlyActivityScore, getMoonPhase } from './activity-engine.mjs';
import { haversine } from './stand-data.mjs';

const W_BASE = 0.50;   // moon+rut+season+weather+solunar (activity engine)
const W_WIND = 0.30;   // scent direction relative to deer approach
const W_HIST = 0.20;   // past sightings here under similar conditions

/** Smallest unsigned diff between two bearings in degrees, 0..180. */
export function angularDiff(a, b) {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Wind alignment factor (0..1).
 *
 * Both `slot.windDeg` and `stand.preferred_approach_deg` are wind-FROM-style
 * bearings (Open-Meteo convention; `preferred_approach_deg` = bearing deer
 * come FROM). Hunter wants scent to travel AWAY from the deer, i.e. wind to
 * blow FROM the deer-side and scent to go to the opposite side. So the
 * ideal `windDeg` equals `preferred_approach_deg` directly — when wind
 * comes from where deer are coming from, scent gets carried in the
 * opposite direction.
 *
 * NB the PLAN §4 pseudocode computes `ideal = preferred_approach + 180`
 * which is a unit mismatch (ideal-scent-direction compared with
 * wind-FROM direction). Implemented here without the +180 offset so the
 * scoring rewards favourable winds rather than penalising them.
 *
 * Speed multiplier penalises dead-calm (swirl, scent puddles) and gales
 * (deer spook).
 */
export function windAlignment(stand, slot) {
  if (stand.preferred_approach_deg == null) return 0.5;
  if (slot.windDeg == null) return 0.5;
  const ideal = stand.preferred_approach_deg;
  const delta = angularDiff(slot.windDeg, ideal);
  const base  = 1 - (delta / 180);
  const spd   = slot.windMph || 0;
  const spdMul = spd < 3  ? 0.55
               : spd < 6  ? 0.85
               : spd < 18 ? 1.00
               : spd < 25 ? 0.80
               :            0.50;
  return base * spdMul;
}

/**
 * History-match factor (0..1).
 * `ctx.entries` are cull_entries near this stand (loaded by stand-data).
 * If the user has past sightings here under similar wind direction +
 * moon phase, that's a positive signal. No nearby entries → mildly
 * negative (0.3) — unknown stand can still win on base score, but
 * known-productive stands get a deserved bump.
 */
export function historyMatch(stand, slot, ctx) {
  const entries = (ctx && ctx.entries) ? ctx.entries : [];
  const near = entries.filter(e => haversine(e.lat, e.lng, stand.lat, stand.lng) <= 300);
  if (!near.length) return 0.3;

  const slotMoonAge = slot.date ? getMoonPhase(slot.date).age : 0;
  let weightedSum = 0;
  for (const e of near) {
    const eWindDir = (e.weather_data && typeof e.weather_data.wind_dir === 'number')
      ? e.weather_data.wind_dir
      : null;
    const windSim = (eWindDir != null && slot.windDeg != null)
      ? 1 - angularDiff(eWindDir, slot.windDeg) / 180
      : 0.5;
    const eDate = e.created_at ? new Date(e.created_at) : null;
    const eMoonAge = eDate ? getMoonPhase(eDate).age : slotMoonAge;
    const moonSim = 1 - Math.min(1, Math.abs(eMoonAge - slotMoonAge) / 14.77);
    weightedSum += 0.6 * windSim + 0.4 * moonSim;
  }
  const avg = weightedSum / near.length;
  return clamp(0.3 + 0.7 * avg, 0, 1);
}

/**
 * Combined stand score for a slot.
 * `slot` shape: { date: Date, hour: number, windDeg, windMph, wxHour }
 * `ctx`  shape: { entries }   ← cull entries from stand-data.loadCullEntriesNear
 */
export function score(stand, slot, ctx) {
  const baseRaw = hourlyActivityScore(slot.hour, slot.date, stand.lat, stand.lng, slot.wxHour);
  const baseN = baseRaw / 100;
  const windN = windAlignment(stand, slot);
  const histN = historyMatch(stand, slot, ctx);
  const total = Math.round(100 * (W_BASE * baseN + W_WIND * windN + W_HIST * histN));
  return {
    total,
    breakdown: {
      base: baseRaw,            // 0..100, the home-page-style activity score
      baseWeighted: Math.round(100 * W_BASE * baseN),
      wind: Math.round(100 * windN),
      windWeighted: Math.round(100 * W_WIND * windN),
      history: Math.round(100 * histN),
      historyWeighted: Math.round(100 * W_HIST * histN),
      windDeg: slot.windDeg,
      windMph: slot.windMph
    }
  };
}

export function bestStandForSlot(stands, slot, ctx) {
  if (!stands || !stands.length) return null;
  let best = null;
  for (const s of stands) {
    const r = score(s, slot, ctx);
    if (!best || r.total > best.score.total) best = { stand: s, score: r };
  }
  return best;
}

// ── Geometry helpers used by stand-ui-map cone rendering ──────
const EARTH_R = 6371000;

/** Bearing FROM (lat1,lng1) TO (lat2,lng2), degrees 0..360. */
export function bearingTo(lat1, lng1, lat2, lng2) {
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ * 180 / Math.PI) + 360) % 360;
}

/** Walk `distMeters` from (lat,lng) along `bearingDeg`. Returns [lat, lng]. */
export function destinationPoint(lat, lng, bearingDeg, distMeters) {
  const δ = distMeters / EARTH_R;
  const θ = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180;
  const λ1 = lng * Math.PI / 180;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(θ) * Math.sin(δ) * Math.cos(φ1);
  const x = Math.cos(δ) - Math.sin(φ1) * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  return [φ2 * 180 / Math.PI, ((λ2 * 180 / Math.PI) + 540) % 360 - 180];
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
