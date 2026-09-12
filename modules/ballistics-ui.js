// =============================================================================
// First Light — ballistics.html UI module
//
// Orchestrates the calculator page. Connects:
//   * lib/fl-ballistics.mjs   — pure trajectory maths
//   * lib/fl-ammo.mjs         — factory ammo database lookups
//   * lib/fl-deer-law.mjs     — UK statutory energy thresholds
//   * data/ammo-loads.json    — the ammo data, fetched on init
//
// Persistence: rifle profiles live in localStorage under the key
// 'fl-ballistics-profiles-v1'. No Supabase, no auth. Works fully offline
// after the first page load (the SW precaches everything this module
// needs, including ammo-loads.json).
//
// Public entry point: initBallisticsUi() — call once on DOMContentLoaded.
// =============================================================================

import {
  solveShot, fpsToMs, msToFps, grainsToKg,
  inchesToCm, cmToInches, yardsToMetres, metresToYards,
  joulesToFtLbs, ftLbsToJoules,
  airDensityRatio, ATM_STD, pointBlankForZero, maxPointBlankRange,
  findZeroAngle, solveTrajectory, maxCarryRangeM,
  trueMuzzleVelocity, cmToMoa, cmToMil, speedOfSound,
  gyroscopicStability, estimateBulletLengthIn, nearestReticleMark,
} from '../lib/fl-ballistics.js';
import {
  getCalibres, getManufacturers, getCalibresWithLoads,
  getManufacturersForCalibre, getLoadsFor, getLoadById,
  getCalibreById, getManufacturerById,
  searchLoads, loadDisplayName, preferredBcFor,
} from '../lib/fl-ammo.js';
import {
  flUkDeerLawVerified, DEER_SPECIES, JURISDICTIONS, LEAD_AMMO_RESTRICTION,
  thresholdFor, minMuzzleEnergyFor, isExpandingConstruction,
  hasPublishedFigures, bulletWeightSatisfiedByExpanding,
} from '../lib/fl-deer-law.js';
import {
  getAnatomicalHold, AIM_POINTS, DEFAULT_AIM_POINT, listAimPoints,
  SPECIES_BODY, listSpeciesForAnatomy, renderDeerSilhouette,
  PRESENTATIONS, DEFAULT_PRESENTATION, getQuarteringGuidance,
} from '../lib/fl-anatomy.js';
import {
  findLeadFreeAlternatives,
} from '../lib/fl-lead-free-matcher.js';
import { buildDopeCardPDF, downloadDopeCardPDF, conditionsProvenance } from './dope-card.js';
import { renderComplianceSection } from './ballistics-compliance.js';
import { renderRangeCard } from './ballistics-rangecard.js';

// ── Calibre diameter lookup ──────────────────────────────────────────────
//
// Maps the calibre IDs in data/ammo-loads.json to their bullet diameter in
// inches. Used by the legal compliance check (E&W requires .240" minimum
// for the larger species; .220" for muntjac/CWD). Diameters are nominal
// bullet diameters (the actual projectile), not bore-groove diameters.
//
// Sources: SAAMI / CIP cartridge specifications. Values are bullet
// diameter, which is what the Deer Act means by "calibre" — see s.1 of
// the 1991 Act and the practical interpretation in BASC guidance.
const CALIBRE_DIAMETER_INCHES = Object.freeze({
  '22hornet':  0.224,
  '222rem':    0.224,
  '22250':     0.224,
  '223rem':    0.224,
  '243win':    0.243,
  '2506rem':   0.257,
  '257wbymag': 0.257,
  '65prc':     0.264,
  '65creed':   0.264,
  '65x55':     0.264,
  '270win':    0.277,
  '7mmprc':    0.284,
  '7mm08':     0.284,
  '7x57':      0.284,
  '7x64':      0.284,
  '308win':    0.308,
  '3006':      0.308,
  '3030win':   0.308,
  '300winmag': 0.308,
  '300wbymag': 0.308,
  '8x57is':    0.323,
  '8x57jrs':   0.323,
});

// ── Constants & state ────────────────────────────────────────────────────

const STORAGE_KEY = 'fl-ballistics-profiles-v1';
const SETTINGS_KEY = 'fl-ballistics-settings-v1';
// Separate key from settings: the acceptance flag should not be cleared if a
// future migration ever wipes settings, and it has different semantics
// (one-time gate vs persistent preferences).
const ACCEPTANCE_KEY = 'fl-ballistics-accepted-v1';

/**
 * Module-private state. Mutable between calls but never exported. The UI
 * is structured so that any state change goes through one of the
 * setXxx() functions which then re-renders the affected DOM regions.
 */

// B8: the standard-atmosphere starting point, held as its own frozen record.
// The settings restore has to be able to ask "are these still the defaults?"
// when it meets a saved blob from before provenance was tracked, and asking
// that against re-typed literals is how the answer eventually goes wrong.
const CONDITIONS_DEFAULT = Object.freeze({
  tempC: ATM_STD.temperatureC,
  pressureHpa: ATM_STD.pressureHpa,
  humidityPct: 50,
});

const state = {
  db: null,                 // ammo-loads.json contents
  profiles: [],             // [{id, name, ...}]
  activeProfileId: null,
  conditions: {             // can be auto-filled or manual
    tempC: CONDITIONS_DEFAULT.tempC,
    pressureHpa: CONDITIONS_DEFAULT.pressureHpa,
    humidityPct: CONDITIONS_DEFAULT.humidityPct,
    windMps: 0,
    windDirDeg: 0,          // 0 = headwind, 90 = full crosswind from R
    shotAngleDeg: 0,
    // B8: provenance rides with the numbers. 'default' means nothing has
    // overwritten the standard atmosphere above — placeholders that must
    // never reach the printed card in the same voice as a measurement.
    source: 'default',      // 'default' | 'auto' | 'manual'
    fetchedAt: null,        // epoch ms of the last fetch or hand entry
  },
  rangeM: 100,              // current target range
  settings: {
    units: 'metric',        // 'metric' | 'imperial'
    jurisdiction: 'england-wales',
    speciesFilter: ['roe', 'red', 'fallow', 'sika', 'muntjac', 'cwd'],
    // Anatomical-hold preferences (Phase 1 feature)
    anatomyEnabled: true,           // On by default — feature is calibrated and shipped (was off as a phase-1 flag)
    anatomyAimPoint: DEFAULT_AIM_POINT,  // 'heart' | 'heart_lung' | 'high_shoulder'
    anatomySpecies: 'roe',          // which species to display anatomy for (one at a time)
    anatomySex: 'buck',             // 'buck' | 'doe' | 'juvenile'
    anatomyPresentation: DEFAULT_PRESENTATION,  // 'broadside' | 'quartering_away' | 'quartering_to'
    nightMode: false,               // red low-light field mode (protects dark adaptation)
    // 12.95 (Ian, by email): a user-set vital zone for the PBR sections —
    // 5 cm for neck/brain shooters, 7 for foxes, 4 for hares. null = follow
    // the selected species, which stays the honest default.
    pbrZoneCm: null,
  },
};

// ── Storage ──────────────────────────────────────────────────────────────

// Coerce a persisted / imported profile into a safe shape. Returns null for
// anything that isn't a usable object so the caller can drop it. Only the
// STRUCTURAL fields the UI dereferences without guards are defaulted here
// (id, name, species); ballistic fields are left as-is so the solver's own
// guards surface an honest "Could not compute" rather than a fabricated
// trajectory for a genuinely broken profile (audit B4).
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const p = { ...raw };
  if (typeof p.id !== 'string' || !p.id) p.id = 'p' + Math.random().toString(36).slice(2, 10);
  if (typeof p.name !== 'string' || !p.name) p.name = 'My rifle';
  if (!Array.isArray(p.species)) {
    p.species = ['roe', 'red', 'fallow'];
  } else {
    const valid = p.species.filter(s => typeof s === 'string');
    p.species = valid.length ? valid : ['roe', 'red', 'fallow'];
  }
  return p;
}

// Clamp a numeric input to [lo, hi], falling back to `fallback` when the value
// isn't a finite number. Used for atmosphere/wind inputs (manual editor + the
// Open-Meteo auto-fill) so a real 0 °C no longer reads as "falsy" and out-of-
// range or missing values can't reach the solver (audit §2 + B1).
function clampNum(v, fallback, lo, hi) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

// ── Units voice (14.01 — Scott + Aaron, by email) ────────────────────────
// The yards toggle shipped half-wired in v1.0 and was parked behind CSS.
// This round finishes it. Doctrine: STORAGE STAYS METRIC (zeroRangeM,
// sightHeightCm and every solver input keep their names and meanings);
// imperial is a display/input voice — distances in yards, drops and drifts
// in inches. MOA/MIL are angular and never convert; fps and ft-lb are
// already the trade's units; CONDITIONS (°C, hPa, m/s wind) stay metric in
// both voices because the weather data and the conditions strip speak them.
// The choice is shared with the diary app through the 'fl-units' key, so
// one Units setting speaks for the whole product.
const FL_UNITS_KEY = 'fl-units';
function bxImp() { return state.settings.units === 'imperial'; }
function bxDist(m, dp = 0) { return bxImp() ? metresToYards(m).toFixed(dp) : Number(m).toFixed(dp); }
function bxDistU() { return bxImp() ? 'yd' : 'm'; }
function bxSmall(cm, dp = 1) { return bxImp() ? cmToInches(cm).toFixed(dp) : Number(cm).toFixed(dp); }
function bxSmallU() { return bxImp() ? 'in' : 'cm'; }
function readSharedUnits() {
  try {
    const u = JSON.parse(localStorage.getItem(FL_UNITS_KEY) || 'null');
    return u && typeof u === 'object' ? u : null;
  } catch (_) { return null; }
}
function writeSharedUnitsDist(dist) {
  try {
    const u = readSharedUnits() || {};
    u.dist = dist;
    localStorage.setItem(FL_UNITS_KEY, JSON.stringify(u));
  } catch (_) {}
}

function loadProfilesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Normalize every persisted profile: drop non-objects and guarantee the
    // structural fields init/render dereference without guards (audit B4).
    return Array.isArray(parsed) ? parsed.map(normalizeProfile).filter(Boolean) : [];
  } catch (e) {
    console.warn('[ballistics] could not read profiles from localStorage', e);
    return [];
  }
}

function saveProfilesToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.profiles));
  } catch (e) {
    console.warn('[ballistics] could not save profiles to localStorage', e);
    toast('Could not save profile (storage full?)', 'warn');
  }
}

function loadSettingsFromStorage() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function saveSettingsToStorage() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      activeProfileId: state.activeProfileId,
      units: state.settings.units,
      jurisdiction: state.settings.jurisdiction,
      speciesFilter: state.settings.speciesFilter,
      anatomyEnabled: state.settings.anatomyEnabled,
      anatomyAimPoint: state.settings.anatomyAimPoint,
      anatomySpecies: state.settings.anatomySpecies,
      anatomySex: state.settings.anatomySex,
      anatomyPresentation: state.settings.anatomyPresentation,
      nightMode: state.settings.nightMode,
      pbrZoneCm: state.settings.pbrZoneCm, // 12.95
      // Field state — persisted so the calculator survives backgrounding
      // and reloads. A stalker who has dialled in 285m, 4 m/s wind, 8 °C,
      // 980 hPa from being on a hill should not lose all that when the
      // phone goes to sleep. These are the inputs that genuinely vary
      // session-to-session.
      rangeM: state.rangeM,
      conditions: {
        tempC: state.conditions.tempC,
        pressureHpa: state.conditions.pressureHpa,
        humidityPct: state.conditions.humidityPct,
        windMps: state.conditions.windMps,
        windDirDeg: state.conditions.windDirDeg,
        shotAngleDeg: state.conditions.shotAngleDeg,
        // Provenance persists with the readings it describes. Storing the
        // figures without it would resurrect a fetch from last Tuesday as an
        // unqualified statement of today's weather on the next cold start.
        source: state.conditions.source,
        fetchedAt: state.conditions.fetchedAt,
      },
    }));
  } catch (e) { /* non-fatal */ }
}

// ── Profile model ────────────────────────────────────────────────────────

/**
 * Build a fresh profile from a load picked in the setup wizard. All
 * required fields populated; optional fields left to defaults.
 */
function makeProfileFromLoad(name, loadId, opts) {
  const o = opts || {};
  const load = getLoadById(state.db, loadId);
  if (!load) return null;
  // A factory load with no published ballistic coefficient (the schema allows
  // bcVerificationBasis:'no-published-bc') can't be solved — the manual wizard
  // requires a BC, so the factory path must too (audit B5). Backstop; the
  // wizard also blocks Next and warns in the load hint.
  if (!(load.bcG1 > 0 || load.bcG7 > 0)) return null;
  return {
    id: 'p' + Math.random().toString(36).slice(2, 10),
    name: name || 'My rifle',
    loadId,                                          // factory ammo reference
    muzzleVelocityFps: load.muzzleVelocityFps,       // editable copy
    weightGrains: load.weightGrains,
    bcG1: load.bcG1 || 0,
    bcG7: load.bcG7 || 0,
    sightHeightCm: o.sightHeightCm ?? 4.0,
    zeroRangeM: o.zeroRangeM ?? 100,
    barrelInches: o.barrelInches ?? 22,
    species: o.species ?? ['roe', 'red', 'fallow'],
    custom: false,                                   // set true when user edits MV/BC
    createdAt: Date.now(),
    // Optional chronograph correction. When present, chronoMv is used by
    // computeShot() in place of the published muzzleVelocityFps. The
    // published value is preserved so the user can see the delta and can
    // revert if they re-chrono later. chronoDateMs is the date of the
    // chrono session — if older than 12 months a UI nudge appears.
    chronoMv: null,             // null = no override, use published MV
    chronoDateMs: null,
    // Free-text note. Use case: rifle make/model, scope, last service
    // notes, range conditions where the rifle was last zeroed, etc.
    notes: '',
  };
}

/** Build a manual-entry profile — no factory load reference. */
function makeManualProfile(name, opts) {
  const o = opts || {};
  return {
    id: 'p' + Math.random().toString(36).slice(2, 10),
    name: name || 'Custom rifle',
    loadId: null,
    muzzleVelocityFps: o.muzzleVelocityFps ?? 2820,
    weightGrains: o.weightGrains ?? 150,
    bcG1: o.bcG1 ?? 0.314,
    bcG7: o.bcG7 ?? 0,
    sightHeightCm: o.sightHeightCm ?? 4.0,
    zeroRangeM: o.zeroRangeM ?? 100,
    barrelInches: o.barrelInches ?? 22,
    species: o.species ?? ['roe', 'red', 'fallow'],
    custom: true,
    createdAt: Date.now(),
    chronoMv: null,
    chronoDateMs: null,
    notes: '',
  };
}

/**
 * The MV the solver should use for a profile. Returns the chrono override
 * if one is set, otherwise the published / manually-entered MV. Centralised
 * here so every code path that solves uses the same value.
 */
function effectiveMvFps(profile) {
  // MV source priority: a drop-TRUED MV (verified against real downrange impact)
  // beats a chronograph reading, which beats the published catalogue MV. Each
  // source carries its own temperature reference for the powder-temp correction:
  // a trued MV was captured on the truing day's temperature; chrono/published are
  // taken at 15 °C.
  let mv, refTempC = 15;
  if (Number.isFinite(profile.truedMvFps) && profile.truedMvFps > 0) {
    mv = profile.truedMvFps;
    if (Number.isFinite(profile.truedAtTempC)) refTempC = profile.truedAtTempC;
  } else if (profile.chronoMv && profile.chronoMv > 0) {
    mv = profile.chronoMv;
  } else {
    mv = profile.muzzleVelocityFps;
  }
  // Optional powder-temperature sensitivity: MV drifts as the powder warms/cools.
  // Adjust from the source's reference temperature toward current conditions.
  // Off when the coefficient is unset/zero. This feeds trajectory + retained
  // energy (incl. the "still ethical at this range" band); the LEGAL muzzle-energy
  // check keeps using the published MV (cartridge capability), so it is unaffected.
  const coeff = profile.mvTempCoeffFpsPerC;
  if (coeff && Number.isFinite(coeff) && state.conditions && Number.isFinite(state.conditions.tempC)) {
    mv += (state.conditions.tempC - refTempC) * coeff;
  }
  return mv;
}

/**
 * Convert (windMps, windDirDeg) into an effective crosswind component for
 * the solver. windDirDeg is the wind's clock position relative to the
 * bullet's path:
 *   0°   = wind FROM directly ahead (headwind) — zero crosswind
 *   90°  = wind FROM the right (full crosswind from right) — push left
 *   180° = wind FROM directly behind (tailwind) — zero crosswind
 *   270° = wind FROM the left (full crosswind from left) — push right
 *
 * Drift sign convention: positive crosswind = drift to the right (matches
 * solver's positive-right convention).
 */
function effectiveCrosswindMs(windMps, windDirDeg) {
  if (!windMps) return 0;
  const dir = ((windDirDeg || 0) % 360 + 360) % 360;
  // Wind FROM 90° (right) pushes the bullet LEFT (negative drift in the
  // "drift to right" convention). Wind FROM 270° (left) pushes RIGHT.
  // sin(0) = 0 (head/tail wind), sin(90) = 1, sin(270) = -1.
  // We want sin(270) = positive (right drift), so negate.
  return -windMps * Math.sin(dir * Math.PI / 180);
}

/** Clock labels for the eight wind directions the conditions dial offers. */
const WIND_CLOCK_LABELS = Object.freeze({
  0: "12 o'clock", 45: '1:30', 90: "3 o'clock", 135: '4:30',
  180: "6 o'clock", 225: '7:30', 270: "9 o'clock", 315: '10:30',
});

/**
 * Describe the wind the solver is ACTUALLY using, for anything that captions
 * a wind-drift figure.
 *
 * Every trajectory in this app is solved with effectiveCrosswindMs() — the
 * crosswind COMPONENT — not the raw wind speed. A caption that prints
 * state.conditions.windMps and calls it "crosswind" therefore overstates the
 * wind the numbers underneath it were built from for every direction that
 * isn't a pure 3- or 9-o'clock wind: at 1:30 the solve uses 71% of the
 * entered speed, at 12 o'clock it uses none of it. (Audit 2026-07-25,
 * finding B7 — the range-card footer and the Compare header both did this.)
 *
 * Returns { crossMs, crossMag, side, clock, short, long }:
 *   crossMs  — signed component, positive = drift right (solver convention)
 *   crossMag — magnitude in m/s
 *   side     — 'left' | 'right' | '' (empty when there is no component)
 *   clock    — "1:30" / "3 o'clock", or the raw degrees if off-dial
 *   short    — table-header phrase
 *   long     — footer sentence
 */
function describeWind(windMps, windDirDeg) {
  const dir = ((windDirDeg || 0) % 360 + 360) % 360;
  const crossMs = effectiveCrosswindMs(windMps, windDirDeg);
  const crossMag = Math.abs(crossMs);
  const clock = WIND_CLOCK_LABELS[dir] || `${Math.round(dir)}°`;
  const side = crossMag < 0.05 ? '' : (crossMs > 0 ? 'right' : 'left');
  const speed = (windMps || 0).toFixed(1);
  let short, long;
  if (!windMps) {
    short = 'Wind drift';
    long = 'No wind.';
  } else if (!side) {
    short = `Wind drift — none (${speed} m/s from ${clock})`;
    long = `Wind ${speed} m/s from ${clock} relative to the shot — no crosswind component, so no drift.`;
  } else if (crossMag >= windMps - 0.05) {
    short = `Wind drift — ${crossMag.toFixed(1)} m/s full-value crosswind (from ${clock})`;
    long = `Wind ${speed} m/s from ${clock} relative to the shot — full-value crosswind, drifting ${side}.`;
  } else {
    short = `Wind drift — ${crossMag.toFixed(1)} m/s crosswind component (${speed} m/s from ${clock})`;
    long = `Wind ${speed} m/s from ${clock} relative to the shot — solved at its ${crossMag.toFixed(1)} m/s crosswind component, drifting ${side}.`;
  }
  return { crossMs, crossMag, side, clock, short, long };
}

function getActiveProfile() {
  return state.profiles.find(p => p.id === state.activeProfileId) || null;
}

// Saved zero ranges for a profile (multiple-zeros feature). The active zero is
// always profile.zeroRangeM; profile.zeroOptionsM holds any alternates the user
// saved. Returns a sorted, de-duplicated list that always includes the active
// zero, so a profile created before this feature still yields [zeroRangeM].
function getZeroOptions(profile) {
  if (!profile) return [];
  const set = new Set();
  if (profile.zeroRangeM > 0) set.add(Math.round(profile.zeroRangeM));
  if (Array.isArray(profile.zeroOptionsM)) {
    for (const z of profile.zeroOptionsM) if (Number.isFinite(z) && z > 0) set.add(Math.round(z));
  }
  return Array.from(set).sort((a, b) => a - b);
}

// ── Solver bridge ────────────────────────────────────────────────────────

/**
 * Run the ballistics solver against the current profile + conditions +
 * range. Returns either the solveShot output or null if no profile.
 */
function computeShot() {
  const p = getActiveProfile();
  if (!p) return null;
  try {
    return solveShot({
      muzzleVelocityMs: fpsToMs(effectiveMvFps(p)),
      bcG1: p.bcG1, bcG7: p.bcG7,
      bulletMassKg: grainsToKg(p.weightGrains),
      sightHeightCm: p.sightHeightCm,
      zeroRangeM: p.zeroRangeM,
      tempC: state.conditions.tempC,
      pressureHpa: state.conditions.pressureHpa,
      humidityPct: state.conditions.humidityPct,
      targetRangeM: state.rangeM,
      windMs: effectiveCrosswindMs(state.conditions.windMps, state.conditions.windDirDeg),
      shotAngleDeg: state.conditions.shotAngleDeg,
    });
  } catch (e) {
    console.error('computeShot failed:', e.message);
    return null;
  }
}

/**
 * Compute a sampled drop curve from 0 to maxRangeM in 10m steps. Used by
 * the chart and the dope card.
 */
// The curve is range-INVARIANT: a fixed 25 m -> maxRangeM grid solved with wind
// and shot angle pinned to zero, so nothing in it moves when the user drags the
// range slider. renderDropChart() nonetheless runs from renderOutput() on every
// tick and rebuilt all ~38 solves each time. One slot, same shape as
// _mpbrCache. (Audit 2026-07-25, finding B1.)
//
// The empty array returned on a solver failure is deliberately NOT cached: that
// is a transient, and caching it would freeze the chart blank until an input
// changed.
let _dropCurveCache = { key: null, val: null };

// Chart-curve range grid: 25 m to maxRangeM in 10 m steps, with the final
// point pinned to maxRangeM itself so gridline samples (100/200/300/400)
// and the chart's right edge sit on solved points, not one step past them.
function dropCurveRanges(maxRangeM) {
  const out = [];
  for (let r = 25; r <= maxRangeM; r += 10) out.push(r);
  if (out.length && out[out.length - 1] !== maxRangeM) out.push(maxRangeM);
  return out;
}

// Linear interpolation on a computed drop curve. Exact grid hits return the
// solved value; between points it interpolates; before the first point it
// clamps to that point; past the last it returns null.
function sampleDropAt(curve, rangeM) {
  let prev = null;
  for (const pt of curve) {
    if (pt.rangeM === rangeM) return pt.dropCm;
    if (pt.rangeM > rangeM) {
      if (!prev) return pt.dropCm;
      const t = (rangeM - prev.rangeM) / (pt.rangeM - prev.rangeM);
      return prev.dropCm + t * (pt.dropCm - prev.dropCm);
    }
    prev = pt;
  }
  return null;
}

// toFixed(1) with the negative-zero artefact removed: -0.04 -> "0.0", not "-0.0".
function fmtCm1(v) {
  const s = v.toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}

function computeDropCurve(maxRangeM) {
  const p = getActiveProfile();
  if (!p) return [];
  const c = state.conditions;
  const key = [
    maxRangeM, p.id, effectiveMvFps(p), p.bcG1, p.bcG7, p.weightGrains,
    p.sightHeightCm, p.zeroRangeM, c.tempC, c.pressureHpa, c.humidityPct,
  ].join('|');
  if (_dropCurveCache.key === key) return _dropCurveCache.val;
  const points = [];
  for (const r of dropCurveRanges(maxRangeM)) {
    let result;
    try {
      result = solveShot({
        muzzleVelocityMs: fpsToMs(effectiveMvFps(p)),
        bcG1: p.bcG1, bcG7: p.bcG7,
        bulletMassKg: grainsToKg(p.weightGrains),
        sightHeightCm: p.sightHeightCm,
        zeroRangeM: p.zeroRangeM,
        tempC: state.conditions.tempC,
        pressureHpa: state.conditions.pressureHpa,
        humidityPct: state.conditions.humidityPct,
        targetRangeM: r,
        windMs: 0,
        shotAngleDeg: 0,
      });
    } catch (e) {
      // One bad input point shouldn't drop the rest of the curve. Bail
      // entirely if the profile is unusable — empty curve signals to
      // the chart and dope card that there's nothing to render.
      console.error('computeDropCurve failed at range', r, ':', e.message);
      return [];
    }
    if (result) points.push({ rangeM: r, dropCm: result.dropCm, energyFtLbs: result.energyFtLbs });
  }
  _dropCurveCache = { key, val: points };
  return points;
}

// ── Auto-fill conditions from device location + Open-Meteo ───────────────

/**
 * Best-effort current-conditions fetch. Tries device geolocation, then
 * Open-Meteo's current weather endpoint. Silently no-ops on any failure
 * (calculator still works with manual entry).
 */
async function autoFillConditions() {
  try {
    const pos = await new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('no geolocation'));
      navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, maximumAge: 600000 });
    });
    const lat = pos.coords.latitude.toFixed(3);
    const lng = pos.coords.longitude.toFixed(3);
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
                `&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m` +
                `&wind_speed_unit=ms&timezone=auto`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('fetch ' + r.status);
    const data = await r.json();
    const c = data && data.current;
    if (!c) throw new Error('no current data');
    // Clamp API values to the solver's sane envelope (audit §2 "unclamped").
    state.conditions.tempC = clampNum(c.temperature_2m, state.conditions.tempC, -40, 50);
    state.conditions.pressureHpa = clampNum(c.surface_pressure, state.conditions.pressureHpa, 800, 1100);
    state.conditions.humidityPct = clampNum(c.relative_humidity_2m, state.conditions.humidityPct, 0, 100);
    state.conditions.windMps = clampNum(c.wind_speed_10m, state.conditions.windMps, 0, 20);
    // NB: wind_direction_10m is an ABSOLUTE compass bearing (0°=N). The solver
    // treats windDirDeg as the wind's clock position RELATIVE TO THE SHOT
    // (0°=headwind), and the app captures no shot heading — so an absolute
    // bearing can't be converted and must NOT be written here (audit B1). Fill
    // wind SPEED only; the stalker sets the relative direction on the dial.
    //
    // B8: stamp the set as fetched, and stamp it now — the age is the whole
    // value of the marker. Set after the clamps, so a throw on the way here
    // leaves the previous provenance standing rather than labelling the old
    // numbers as a fresh fetch.
    state.conditions.source = 'auto';
    state.conditions.fetchedAt = Date.now();
    saveSettingsToStorage();
    renderConditions();
    renderOutput();
    toast('Conditions updated. Set wind direction manually — a compass bearing can\'t be auto-applied.', 'ok');
  } catch (e) {
    toast('Could not get current conditions', 'warn');
  }
}

// ── Legal compliance helper ──────────────────────────────────────────────

/**
 * Run all four statutory checks for a (profile, jurisdiction, species)
 * triple. Returns a structured result the UI can render.
 *
 * The returned object is shaped as:
 *   {
 *     speciesCode, speciesLabel,
 *     overall: 'pass' | 'fail' | 'unknown',  // worst-case across checks
 *     checks: [
 *       { kind, label, status, detail, statutoryValue, actualValue }
 *     ],
 *     citation: string | null,
 *     citationUrl: string | null,
 *   }
 *
 * Each individual check has status:
 *   'pass'    — actual value meets or exceeds the statutory minimum
 *   'fail'    — actual value falls short
 *   'na'      — statute does not specify a minimum for this dimension
 *   'unknown' — actual value missing, or present but undecidable (e.g. no
 *               construction tag, or one this app cannot classify)
 *
 * The four checks are:
 *   muzzleEnergy   — profile MV+weight → ME (ft-lb) vs threshold
 *   muzzleVelocity — profile MV (fps) vs threshold (Scotland-only)
 *   bulletWeight   — profile bullet weight (gr) vs threshold
 *   calibre        — calibre diameter (inches) vs threshold
 *   construction   — load construction is an expanding type (allowlisted in
 *                    lib/fl-deer-law.js; unrecognised reads as 'unknown')
 *
 * The energy check uses MUZZLE energy (not impact), since that's what
 * the statutes specify. This is the lawful-equipment check, distinct
 * from the calculator's at-impact red/amber/green which is about the
 * shot itself.
 */
/**
 * The UK absolute floor for any deer species in any jurisdiction is
 * 1,000 ft-lb of muzzle energy (the muntjac/CWD threshold in E&W and NI).
 * Below this, the load is unlawful for any deer in the UK regardless of
 * jurisdiction or species. Surfaced as a separate hard warning above the
 * per-species compliance rows.
 *
 * Returns null if the profile passes the floor, or { muzzleEnergyFtLb,
 * floor } if it doesn't.
 */
function checkAbsoluteFloor(profile) {
  if (!profile.muzzleVelocityFps || !profile.weightGrains) return null;
  const ME = (profile.muzzleVelocityFps * profile.muzzleVelocityFps * profile.weightGrains) / 450400;
  const FLOOR = 1000;
  if (ME < FLOOR) {
    return { muzzleEnergyFtLb: Math.round(ME), floor: FLOOR };
  }
  return null;
}

function checkLegalCompliance(profile, jurisdictionCode, speciesCode) {
  const t = thresholdFor(jurisdictionCode, speciesCode);
  const speciesLabel = DEER_SPECIES.find(s => s.code === speciesCode)?.label || speciesCode;
  if (!t) {
    return {
      speciesCode, speciesLabel,
      overall: 'unknown',
      checks: [],
      citation: null,
      citationUrl: null,
    };
  }

  // Compute muzzle energy from profile (MV in fps, bullet in grains).
  // E_ftlb = (MV² × grains) / 450,400 — standard ballistics formula.
  const muzzleEnergyFtLb = profile.muzzleVelocityFps && profile.weightGrains
    ? (profile.muzzleVelocityFps * profile.muzzleVelocityFps * profile.weightGrains) / 450400
    : null;

  // Resolve calibre diameter from the load's calibre ID, or null for
  // manual-entry profiles (which don't carry a calibre code).
  const load = profile.loadId ? getLoadById(state.db, profile.loadId) : null;
  // A handload has no catalogue calibre code, but the stability solver stores
  // the bullet diameter the shooter typed in on the profile itself. Reading it
  // here is what lets a hand-entered .243 answer the calibre question at all;
  // without it every handload came back "cannot be checked" forever.
  const solvedDiameter = Number.isFinite(profile.bulletDiameterIn) && profile.bulletDiameterIn > 0
    ? profile.bulletDiameterIn
    : null;
  const calibreDiameter = (load ? CALIBRE_DIAMETER_INCHES[load.calibre] : null) ?? solvedDiameter;
  const calibreFromProfile = calibreDiameter != null && (!load || CALIBRE_DIAMETER_INCHES[load.calibre] == null);

  // Construction: an allowlist of expanding types rather than a denylist of
  // FMJ — isExpandingConstruction() in lib/fl-deer-law.js sets out why that
  // direction matters and what is deliberately left out of the list. Three
  // states: true, false, and null for "the tag does not tell us", which the
  // row below reports as such instead of guessing either way.
  const isExpanding = load ? isExpandingConstruction(load.construction) : null;

  const checks = [];

  // ── Muzzle energy ──
  if (t.minMuzzleEnergyFtLb != null) {
    if (muzzleEnergyFtLb == null) {
      checks.push({
        kind: 'muzzleEnergy', label: 'Muzzle energy',
        status: 'unknown',
        detail: 'Cannot compute — missing MV or bullet weight',
        statutoryValue: t.minMuzzleEnergyFtLb + ' ft-lb',
        actualValue: '—',
      });
    } else {
      checks.push({
        kind: 'muzzleEnergy', label: 'Muzzle energy',
        status: muzzleEnergyFtLb >= t.minMuzzleEnergyFtLb ? 'pass' : 'fail',
        detail: muzzleEnergyFtLb >= t.minMuzzleEnergyFtLb
          ? null
          : `Below ${t.minMuzzleEnergyFtLb} ft-lb minimum`,
        statutoryValue: t.minMuzzleEnergyFtLb + ' ft-lb',
        actualValue: Math.round(muzzleEnergyFtLb) + ' ft-lb',
      });
    }
  } else if (hasPublishedFigures(jurisdictionCode, speciesCode)) {
    // "Not specified" is only an honest thing to say when the statute has
    // specified something else. Where it has specified nothing at all, the
    // single 'Statutory figures — unknown' row added below says it once and
    // says it properly, instead of four cheerful n/a rows.
    checks.push({
      kind: 'muzzleEnergy', label: 'Muzzle energy',
      status: 'na',
      detail: 'Not specified by statute',
      statutoryValue: '—',
      actualValue: muzzleEnergyFtLb != null ? Math.round(muzzleEnergyFtLb) + ' ft-lb' : '—',
    });
  }

  // ── Muzzle velocity (Scotland's distinctive requirement) ──
  if (t.minMuzzleVelocityFps != null) {
    if (!profile.muzzleVelocityFps) {
      checks.push({
        kind: 'muzzleVelocity', label: 'Muzzle velocity',
        status: 'unknown',
        detail: 'Profile missing muzzle velocity',
        statutoryValue: t.minMuzzleVelocityFps + ' fps',
        actualValue: '—',
      });
    } else {
      checks.push({
        kind: 'muzzleVelocity', label: 'Muzzle velocity',
        status: profile.muzzleVelocityFps >= t.minMuzzleVelocityFps ? 'pass' : 'fail',
        detail: profile.muzzleVelocityFps >= t.minMuzzleVelocityFps
          ? null
          : `Below ${t.minMuzzleVelocityFps} fps minimum`,
        statutoryValue: t.minMuzzleVelocityFps + ' fps',
        actualValue: profile.muzzleVelocityFps + ' fps',
      });
    }
  }
  // Velocity not specified outside Scotland — skip the check entirely
  // rather than render an "n/a" row that adds noise.

  // ── Bullet weight ──
  if (t.minBulletWeightGrains != null) {
    if (!profile.weightGrains) {
      checks.push({
        kind: 'bulletWeight', label: 'Bullet weight',
        status: 'unknown',
        detail: 'Profile missing bullet weight',
        statutoryValue: t.minBulletWeightGrains + ' gr',
        actualValue: '—',
      });
    } else {
      const meetsWeight = profile.weightGrains >= t.minBulletWeightGrains;
      // Northern Ireland prints the weight limb and the expanding limb as
      // alternatives (Sch. 11 para. 8 (a); (b)), with no "and" joining them.
      // Encoded as a conjunction it failed a .243 90 gr expanding load that
      // the statute plainly allows.
      const altLimb = !meetsWeight
        && isExpanding === true
        && bulletWeightSatisfiedByExpanding(jurisdictionCode, speciesCode);
      checks.push({
        kind: 'bulletWeight', label: 'Bullet weight',
        status: (meetsWeight || altLimb) ? 'pass' : 'fail',
        detail: meetsWeight
          ? null
          : altLimb
            ? `Under ${t.minBulletWeightGrains} gr, but an expanding bullet satisfies the rule on its own here`
            : `Below ${t.minBulletWeightGrains} gr minimum`,
        statutoryValue: bulletWeightSatisfiedByExpanding(jurisdictionCode, speciesCode)
          ? t.minBulletWeightGrains + ' gr, or expanding'
          : t.minBulletWeightGrains + ' gr',
        actualValue: profile.weightGrains + ' gr',
      });
    }
  }

  // ── Calibre ──
  if (t.minCalibreInches != null) {
    if (calibreDiameter == null) {
      checks.push({
        kind: 'calibre', label: 'Calibre',
        status: 'unknown',
        detail: profile.loadId
          ? 'Calibre diameter not in lookup'
          : 'Manual-entry profile — calibre cannot be checked',
        statutoryValue: '.' + Math.round(t.minCalibreInches * 1000) + '"',
        actualValue: '—',
      });
    } else {
      const passes = calibreDiameter >= t.minCalibreInches - 0.0005;  // tolerance for nominal vs actual
      const belowMsg = `Below .${Math.round(t.minCalibreInches * 1000)}" minimum`;
      const sourceMsg = 'From the bullet diameter on this profile, not a catalogue calibre';
      checks.push({
        kind: 'calibre', label: 'Calibre',
        status: passes ? 'pass' : 'fail',
        detail: passes
          ? (calibreFromProfile ? sourceMsg : null)
          : (calibreFromProfile ? belowMsg + ' \u2014 ' + sourceMsg.toLowerCase() : belowMsg),
        statutoryValue: '.' + Math.round(t.minCalibreInches * 1000) + '"',
        actualValue: '.' + Math.round(calibreDiameter * 1000) + '"',
      });
    }
  }

  // ── Construction (expanding bullet) ──
  if (isExpanding === true) {
    checks.push({
      kind: 'construction', label: 'Bullet type',
      status: 'pass',
      detail: null,
      statutoryValue: 'Expanding',
      actualValue: load && load.construction ? load.construction : 'expanding',
    });
  } else if (isExpanding === false) {
    checks.push({
      kind: 'construction', label: 'Bullet type',
      status: 'fail',
      detail: 'Non-expanding (FMJ etc.) is illegal for deer in the UK',
      statutoryValue: 'Expanding',
      actualValue: load.construction,
    });
  } else {
    // Two different silences, and they have earned different sentences: no tag
    // at all (a manual-entry profile, or a record without one), versus a tag
    // that exists and simply does not answer the question — 'subsonic' names a
    // velocity, not a construction. Rendering '—' for the second would hide
    // the one piece of information the stalker could actually go and check.
    const tag = load && typeof load.construction === 'string' ? load.construction.trim() : '';
    checks.push({
      kind: 'construction', label: 'Bullet type',
      status: 'unknown',
      detail: tag
        ? '"' + tag + '" does not say whether this bullet expands — check the manufacturer\'s description'
        : 'Construction not recorded — verify your ammunition is expanding type',
      statutoryValue: 'Expanding',
      actualValue: tag || '—',
    });
  }

  // Silence is not permission. Scotland's order names red, sika, fallow and
  // roe; it says nothing about muntjac or Chinese water deer, so every numeric
  // threshold for that pair is null and every numeric check above is skipped.
  // What was left was a construction check on its own, and a rollup that
  // ignores absent checks turned that into a green "Pass" for a .22 Hornet at
  // 800 ft-lb on a Scottish muntjac. One explicit row, and the rollup below
  // carries it to 'unknown' the way it carries any other thing we don't know.
  if (!hasPublishedFigures(jurisdictionCode, speciesCode)) {
    checks.push({
      kind: 'thresholds', label: 'Statutory figures',
      status: 'unknown',
      detail: t.notes || 'No statutory calibre, energy, velocity or bullet-weight figure is published for this species in this jurisdiction. Check the current statutory text before shooting.',
      statutoryValue: 'Not published',
      actualValue: '—',
    });
  }

  // Roll up to overall status: any 'fail' → fail; any 'unknown' (and no
  // fail) → unknown; otherwise pass.
  let overall = 'pass';
  for (const c of checks) {
    if (c.status === 'fail') { overall = 'fail'; break; }
    if (c.status === 'unknown') overall = 'unknown';
  }

  return {
    speciesCode, speciesLabel,
    overall,
    checks,
    citation: t.citation || null,
    citationUrl: t.citationUrl || null,
  };
}

// ── DOM helpers ──────────────────────────────────────────────────────────

// Profile-bar "Tools" overflow open/closed state (session-scoped, not persisted).
let flToolsOpen = false;

// Results-card "Legal, ethical range & dead-hold" reference disclosure state.
// These sections are constant per rifle/zero/conditions (they don't change as
// the range slider moves), so they collapse by default to keep the live shot
// data — hold, wind, velocity, energy — at the top. Session-scoped; the flag
// is re-read on every renderOutput so the panel survives per-tick re-renders.
let flRefOpen = false;

// Range-card disclosure state (same rationale — persists across per-tick
// re-renders so it doesn't snap shut while the range slider is dragged).
let flRangeCardOpen = false;

function $(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// Species-specific sex labels. Red and sika use stag/hind; the rest
// use buck/doe. Juvenile is universal ("calf"/"kid"/"fawn"/"pricket"
// vary by species, but "juvenile" is unambiguous and DSC-acceptable).
function sexLabelFor(speciesKey, sex) {
  if (sex === 'juvenile') return 'juvenile';
  const useStag = speciesKey === 'red' || speciesKey === 'sika';
  if (sex === 'buck') return useStag ? 'stag' : 'buck';
  if (sex === 'doe')  return useStag ? 'hind' : 'doe';
  return sex;
}

let toastTimer = null;
function toast(msg, kind) {
  const el = $('bx-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'bx-toast bx-toast-' + (kind || 'info');
  el.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2400);
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderProfileBar() {
  const bar = $('bx-profile-bar');
  if (!bar) return;
  const p = getActiveProfile();
  if (!p) {
    bar.innerHTML = `<button class="bx-profile-empty" id="bx-profile-setup-btn">+ Set up rifle</button>`;
    $('bx-profile-setup-btn').addEventListener('click', openSetupWizard);
    return;
  }
  const summary = p.loadId
    ? loadDisplayName(state.db, p.loadId) + (p.custom ? ' (custom)' : '')
    : `${p.muzzleVelocityFps} fps · ${p.weightGrains}gr · BC ${p.bcG7 > 0 ? 'G7 ' + p.bcG7 : 'G1 ' + p.bcG1}`;
  // Drop-truing status — shown when the MV has been trued to an observed impact.
  // A trued MV supersedes the chrono value in effectiveMvFps, so when present it
  // takes the badge slot (the chrono badge below suppresses itself to match).
  const isTrued = Number.isFinite(p.truedMvFps) && p.truedMvFps > 0;
  const truedBadge = (() => {
    if (!isTrued) return '';
    const delta = Math.round(p.truedMvFps - p.muzzleVelocityFps);
    const sign = delta >= 0 ? '+' : '';
    const rng = p.truedAtRangeM ? ` · ${bxDist(p.truedAtRangeM)}${bxDistU()}` : '';
    return `<span class="bx-profile-trued" title="Calculations use a muzzle velocity trued to your observed drop${p.truedAtRangeM ? ' at ' + bxDist(p.truedAtRangeM) + ' ' + bxDistU() : ''} (${Math.round(p.truedMvFps)} fps vs published ${p.muzzleVelocityFps} fps). Come-ups now match your rifle, not the test barrel."><span class="fl-ic fl-target"></span> ${sign}${delta} fps${rng} · trued</span>`;
  })();
  // Chronograph status — shown next to the summary if a chrono override is set
  // (and no trued MV, which would otherwise be the value actually in use).
  const chronoBadge = (() => {
    if (isTrued) return '';
    if (!p.chronoMv || p.chronoMv <= 0) return '';
    const delta = p.chronoMv - p.muzzleVelocityFps;
    const sign = delta >= 0 ? '+' : '';
    const ageMs = p.chronoDateMs ? (Date.now() - p.chronoDateMs) : null;
    const monthsOld = ageMs != null ? Math.round(ageMs / (1000 * 60 * 60 * 24 * 30)) : null;
    const stale = monthsOld != null && monthsOld >= 12;
    return `<span class="bx-profile-chrono ${stale ? 'bx-profile-chrono-stale' : ''}" title="Calculations use your chronographed MV (${p.chronoMv} fps), not the published value (${p.muzzleVelocityFps} fps).${stale ? ' Last chrono ' + monthsOld + ' months ago — consider re-checking.' : ''}"><span class="fl-ic fl-measure"></span> ${sign}${delta} fps${stale ? ' · ⚠ stale' : ''}</span>`;
  })();
  // Lead-free matcher button shows only when the active profile is built
  // from a known lead load. Custom profiles, lead-free loads, and unknown
  // load IDs all suppress the button — there's no useful answer to give.
  const sourceLoad = p.loadId ? getLoadById(state.db, p.loadId) : null;
  const showLeadFreeBtn = sourceLoad && sourceLoad.leadFree === false && !p.custom;
  // The 2029 restriction only bites in England, Wales and Scotland — in
  // Northern Ireland the button still offers alternatives but must not
  // promise a ban that doesn't apply there (fl-deer-law owns the list).
  const leadFreeBanApplies = LEAD_AMMO_RESTRICTION.appliesToJurisdictions.includes(state.settings.jurisdiction);
  // Multiple zeros: quick-switch chips when the rifle has more than one saved
  // zero. The active zero drives every calculation (it's profile.zeroRangeM).
  const zeros = getZeroOptions(p);
  const zeroChips = zeros.length >= 2
    ? `<div class="bx-zero-bar" role="group" aria-label="Zero range">
        <span class="bx-zero-label">Zero</span>
        ${zeros.map(z => `<button class="bx-zero-chip ${z === Math.round(p.zeroRangeM) ? 'on' : ''}" data-zero="${z}" type="button" aria-pressed="${z === Math.round(p.zeroRangeM) ? 'true' : 'false'}">${bxDist(z)}${bxDistU()}</button>`).join('')}
      </div>`
    : '';
  bar.innerHTML = `
    <div class="bx-profile-head">
      <div class="bx-profile-name"><span class="bx-profile-scope" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="5"/><path d="M8 1.4v2.2M8 12.4v2.2M1.4 8h2.2M12.4 8h2.2" stroke-linecap="round"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/></svg></span>${escapeHtml(p.name)}${truedBadge ? ' ' + truedBadge : ''}${chronoBadge ? ' ' + chronoBadge : ''}</div>
      <div class="bx-profile-actions">
        <button class="bx-link" id="bx-profile-edit-btn">Edit</button>
        ${state.profiles.length > 1 ? `<button class="bx-link" id="bx-profile-switch-btn">Switch</button>` : ''}
        <button class="bx-link" id="bx-profile-add-btn">+ Add</button>
        <button class="bx-link bx-link-tools" id="bx-profile-tools-btn" aria-expanded="${flToolsOpen ? 'true' : 'false'}" aria-controls="bx-profile-tools">⚙ Tools</button>
      </div>
    </div>
    <div class="bx-profile-summary">${escapeHtml(summary)} · <span class="bx-profile-zero">${bxDist(p.zeroRangeM)}${bxDistU()} zero</span></div>
    ${p.notes ? `<div class="bx-profile-notes">${escapeHtml(p.notes)}</div>` : ''}
    ${zeroChips}
    ${showLeadFreeBtn
      ? `<button class="bx-leadfree-cta" id="bx-profile-leadfree-btn" type="button" aria-label="Find lead-free alternatives for this load">
          <span class="bx-leadfree-cta-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="23" height="23" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="9.3" stroke="currentColor" stroke-width="1.6"/>
              <text x="12" y="15.4" text-anchor="middle" font-family="'DM Mono', ui-monospace, monospace" font-size="9" font-weight="700" fill="currentColor">Pb</text>
              <line x1="5.7" y1="18.3" x2="18.3" y2="5.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
            </svg>
          </span>
          <span class="bx-leadfree-cta-body">
            <span class="bx-leadfree-cta-title">Lead-free alternatives${leadFreeBanApplies ? ' · ready for the 2029 ban' : ''}</span>
          </span>
          <span class="bx-leadfree-cta-arrow" aria-hidden="true">→</span>
        </button>` : ''}
    <div class="bx-profile-tools" id="bx-profile-tools"${flToolsOpen ? '' : ' hidden'}>
      <button class="bx-link" id="bx-profile-true-btn" title="True your come-ups to an observed impact at a known distance">${isTrued ? 'Re-true' : 'True drop'}</button>
      <button class="bx-link" id="bx-profile-zeros-btn" title="Save more than one zero range and switch between them">Zeros</button>
      <button class="bx-link" id="bx-profile-stab-btn" title="Check gyroscopic stability from your barrel twist rate">Stability</button>
      <button class="bx-link" id="bx-profile-compare-btn" title="Side-by-side comparison with another factory load">Compare</button>
      <button class="bx-link" id="bx-profile-backup-btn" title="Export or import your rifle profiles">Backup</button>
    </div>
  `;
  $('bx-profile-edit-btn').addEventListener('click', () => openProfileEditor(p.id));
  $('bx-profile-true-btn').addEventListener('click', () => openTruingModal(p.id));
  $('bx-profile-zeros-btn').addEventListener('click', () => openZerosModal(p.id));
  $('bx-profile-stab-btn').addEventListener('click', () => openStabilityModal(p.id));
  $('bx-profile-add-btn').addEventListener('click', openSetupWizard);
  $('bx-profile-backup-btn').addEventListener('click', openBackupModal);
  $('bx-profile-compare-btn').addEventListener('click', openLoadComparator);
  // Tools overflow — keeps the default toolbar to Edit · Switch · + Add and
  // tucks the occasional per-rifle tools behind one tap. flToolsOpen persists
  // the open state across profile-bar re-renders within the session.
  $('bx-profile-tools-btn').addEventListener('click', () => {
    flToolsOpen = !flToolsOpen;
    const panel = $('bx-profile-tools');
    const btn = $('bx-profile-tools-btn');
    if (panel) { if (flToolsOpen) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', ''); }
    if (btn) btn.setAttribute('aria-expanded', flToolsOpen ? 'true' : 'false');
  });
  if (state.profiles.length > 1) {
    $('bx-profile-switch-btn').addEventListener('click', openProfileSwitcher);
  }
  if (showLeadFreeBtn) {
    $('bx-profile-leadfree-btn').addEventListener('click', openLeadFreeMatcher);
  }
  // Quick zero switch — set the active zero and recompute everything.
  bar.querySelectorAll('.bx-zero-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const z = parseInt(btn.dataset.zero, 10);
      if (z > 0 && z !== Math.round(p.zeroRangeM)) {
        p.zeroRangeM = z;
        saveProfilesToStorage();
        renderAll();
        toast(`Zero set to ${bxDist(z)} ${bxDistU()}`, 'ok');
      }
    });
  });
}

// Manage a profile's saved zero ranges (multiple-zeros feature). Add a new
// zero, remove alternates, or activate one. The active zero (profile.zeroRangeM)
// can't be removed from the list — switch to another first.
function openZerosModal(pid) {
  const p = state.profiles.find(x => x.id === pid) || getActiveProfile();
  if (!p) return;
  const modal = $('bx-modal');
  if (!modal) return;
  const render = () => {
    const zeros = getZeroOptions(p);
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="bx-modal-card">
        <div class="bx-modal-title">Zero ranges</div>
        <div class="bx-modal-body">
          <div class="bx-field-hint">
            Save more than one zero for this rifle &mdash; e.g. a 100 ${bxDistU()} and a 200 ${bxDistU()} zero &mdash;
            and switch between them from the rifle bar. The active zero drives every come-up,
            dead-hold range and energy figure.
          </div>
          <div class="bx-zero-list">
            ${zeros.map(z => `
              <div class="bx-zero-row ${z === Math.round(p.zeroRangeM) ? 'on' : ''}">
                <button class="bx-zero-activate" data-act="${z}" type="button">${bxDist(z)} ${bxDistU()}${z === Math.round(p.zeroRangeM) ? ' · active' : ''}</button>
                ${z === Math.round(p.zeroRangeM) ? '' : `<button class="bx-zero-remove" data-rm="${z}" type="button" aria-label="Remove ${bxDist(z)} ${bxDistU()} zero">✕</button>`}
              </div>
            `).join('')}
          </div>
          <div class="bx-field" style="margin-top:12px;">
            <label for="bx-zero-add-input">Add a zero (${bxDistU()})</label>
            <div style="display:flex;gap:8px;">
              <input type="number" id="bx-zero-add-input" inputmode="numeric" min="10" max="600" placeholder="e.g. 200" style="flex:1;">
              <button class="bx-btn bx-btn-secondary" id="bx-zero-add-btn" type="button">Add</button>
            </div>
          </div>
        </div>
        <div class="bx-modal-actions">
          <button class="bx-btn" id="bx-zero-close" type="button">Done</button>
        </div>
      </div>
    `;
    $('bx-zero-close').addEventListener('click', closeModal);
    $('bx-zero-add-btn').addEventListener('click', () => {
      const raw = parseInt($('bx-zero-add-input').value, 10);
      const v = bxImp() ? Math.round(yardsToMetres(raw)) : raw;
      if (!(v >= 10 && v <= 600)) { toast(bxImp() ? 'Enter a zero between 11 and 656 yd' : 'Enter a zero between 10 and 600 m', 'warn'); return; }
      const opts = new Set(getZeroOptions(p));
      opts.add(v);
      p.zeroOptionsM = Array.from(opts).sort((a, b) => a - b);
      saveProfilesToStorage();
      renderProfileBar();
      render();
      toast(`Added ${bxDist(v)} ${bxDistU()} zero`, 'ok');
    });
    modal.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
      const z = parseInt(b.dataset.act, 10);
      if (z > 0) { p.zeroRangeM = z; saveProfilesToStorage(); renderAll(); render(); }
    }));
    modal.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      const z = parseInt(b.dataset.rm, 10);
      p.zeroOptionsM = getZeroOptions(p).filter(x => x !== z && x !== Math.round(p.zeroRangeM));
      // Keep the active zero in the list.
      if (!p.zeroOptionsM.includes(Math.round(p.zeroRangeM))) p.zeroOptionsM.push(Math.round(p.zeroRangeM));
      p.zeroOptionsM.sort((a, b) => a - b);
      saveProfilesToStorage();
      renderProfileBar();
      render();
    }));
  };
  render();
}

function renderRangeControl() {
  const slider = $('bx-range-slider');
  const display = $('bx-range-display');
  if (!slider || !display) return;
  slider.value = state.rangeM;
  const imperial = state.settings.units === 'imperial';
  slider.setAttribute('aria-label', imperial ? 'Target range (yards)' : 'Target range (metres)');
  const shown = imperial ? Math.round(metresToYards(state.rangeM)) : state.rangeM;
  // The big number IS the range input — tap it to type a lasered distance.
  // Created once and reused (not re-rendered each tick) so typing isn't
  // interrupted while the slider updates it. This replaces the old read-only
  // hero span AND the separate small numeric box (which duplicated the value).
  let hero = $('bx-range-hero');
  if (!hero) {
    display.innerHTML = `<input id="bx-range-hero" class="bx-range-num" type="text" inputmode="numeric" autocomplete="off" aria-label="Target range — tap to type"><span class="bx-range-unit" id="bx-range-hero-unit"></span>`;
    hero = $('bx-range-hero');
    hero.addEventListener('change', commitHeroRange);
    hero.addEventListener('focus', () => hero.select());
  }
  if (document.activeElement !== hero) hero.value = shown;
  const unit = $('bx-range-hero-unit');
  if (unit) unit.textContent = imperial ? 'yd' : 'm';
}

// Commit a typed range from the big editable number. Clamps to 25–500 m,
// converts from yards if needed, and re-renders. Shows the clamped value back
// immediately (even on Enter, where focus stays in the field).
function commitHeroRange() {
  const hero = $('bx-range-hero');
  if (!hero) return;
  const v = parseFloat(hero.value);
  if (!Number.isFinite(v)) { renderRangeControl(); return; }
  let m = state.settings.units === 'imperial' ? yardsToMetres(v) : v;
  m = Math.max(25, Math.min(500, Math.round(m)));
  state.rangeM = m;
  saveSettingsToStorage();
  hero.value = state.settings.units === 'imperial' ? Math.round(metresToYards(m)) : m;
  renderRangeControl();
  renderOutput();
}

function renderConditions() {
  const strip = $('bx-conditions-strip');
  if (!strip) return;
  const c = state.conditions;
  // B8: humidity was solved with, persisted and printed on the dope card, but
  // never shown here — so the one surface where a user could check what the
  // calculator was actually using was the one that left a value out.
  const prov = conditionsProvenance(c, Date.now());
  strip.innerHTML = `
    <span><strong>${c.tempC.toFixed(0)}°C</strong></span>
    <span class="bx-sep">·</span>
    <span><strong>${c.pressureHpa.toFixed(0)}</strong> hPa</span>
    <span class="bx-sep">·</span>
    <span><strong>${c.humidityPct.toFixed(0)}</strong>% RH</span>
    <span class="bx-sep">·</span>
    <span>${c.windMps > 0 ? `<strong>${c.windMps.toFixed(1)}</strong> m/s from ${describeWind(c.windMps, c.windDirDeg).clock}` : 'No wind'}</span>
    ${c.shotAngleDeg !== 0 ? `<span class="bx-sep">·</span><span>${c.shotAngleDeg > 0 ? '↑' : '↓'} ${Math.abs(c.shotAngleDeg)}°</span>` : ''}
    <span class="bx-prov bx-prov--${prov.kind}${prov.stale ? ' bx-prov--stale' : ''}" title="${prov.sentence}">${prov.chip}</span>
  `;
}

function renderOutput() {
  const out = $('bx-output');
  if (!out) return;
  const p = getActiveProfile();
  if (!p) {
    out.innerHTML = `<div class="bx-output-empty">Set up your rifle to see results.</div>`;
    return;
  }
  const r = computeShot();
  if (!r || !Number.isFinite(r.dropCm)) {
    // NaN/degenerate solve → honest "no solution", never a literal "NaN cm"
    // on the HOLD card (audit B5). The solver now throws on non-finite inputs;
    // this is the display-side backstop.
    out.innerHTML = `<div class="bx-output-empty">Could not compute solution.</div>`;
    return;
  }

  // Arrow indicates the user's compensating ACTION, not the bullet's deflection:
  //   bullet below LoS at target (positive dropCm) → user holds UP → ↑
  //   bullet above LoS at this range (short of zero, negative dropCm) → user holds DOWN → ↓
  //   |dropCm| < 0.5 cm → no meaningful hold → mid-dot
  const dropArrow = r.dropCm > 0.5 ? '↑' : (r.dropCm < -0.5 ? '↓' : '·');
  const dropMag = Math.abs(r.dropCm);
  // Direction word paired with the cm magnitude in the HOLD card. Mirrors
  // the anatomy text ("Hold X cm high"). Empty when the bullet is on LoS at
  // this range (arrow is mid-dot, no meaningful hold direction).
  const holdWord = r.dropCm > 0.5 ? 'high' : (r.dropCm < -0.5 ? 'low' : '');

  // Retained-energy presentation: factual only, no pass/fail framing.
  // The statutory test the user actually has to satisfy is at the *muzzle*
  // (judged in the Legal compliance section below). Reusing the same
  // threshold here against retained energy was reading as a legal failure
  // when the load is in fact lawful — the DSC1/DSC2 ethical-floor convention
  // belongs in training material, not as a red banner on the calculator.
  // We just show how much energy is left vs the muzzle so the user can see
  // it's dropping, in muted text — no traffic-light colour, no comparison
  // wording, no per-card citation.
  const mvFps = effectiveMvFps(p);
  const muzzleE = (mvFps && p.weightGrains)
    ? (mvFps * mvFps * p.weightGrains) / 450400
    : null;
  const energyDropPct = (muzzleE && muzzleE > 0)
    ? Math.round(((muzzleE - r.energyFtLbs) / muzzleE) * 100)
    : null;
  const energyDropNote = (muzzleE && energyDropPct != null && energyDropPct > 0)
    ? `−${energyDropPct}% from muzzle`
    : '';

  // MOA / MIL shown as the come-up MAGNITUDE that matches the cm hold above.
  // Direction comes from the arrow + "high"/"low" word (up = hold/dial up);
  // dropCm/dropMoa/dropMil share the solver's positive-below-LoS sign, so one
  // arrow covers all three and the angular values need no separate sign here.
  // The printed dope card (dope-card.js) deliberately keeps the signed ammo-
  // box drop convention (negative = below LoS) — it's a reference table, not a
  // live "aim now" instruction. Do NOT touch the solver; tests assert its
  // positive-down output.
  const moaStr = Math.abs(r.dropMoa).toFixed(1);
  const milStr = Math.abs(r.dropMil).toFixed(2);
  // Wind-drift direction word (bullet drifts this way; +MOA = right per the
  // solver's crosswind convention). Shown as magnitude + word like the hold
  // line, replacing the opaque signed value.
  const windDir = r.windDriftMoa > 0.05 ? 'right' : (r.windDriftMoa < -0.05 ? 'left' : '');

  // ── Anatomical hold (Phase 1 feature) ──────────────────────────────
  // Translates the cm/MOA hold into a textual reference on the deer's
  // body. Only shown if the user has enabled it. Excluded for muntjac
  // and CWD which are too small for the heuristic to be useful.
  let anatomyHtml = '';
  if (state.settings.anatomyEnabled) {
    const presentationKey = state.settings.anatomyPresentation || DEFAULT_PRESENTATION;
    const anat = getAnatomicalHold({
      dropCm: r.dropCm,
      speciesKey: state.settings.anatomySpecies,
      sex: state.settings.anatomySex,
      aimPointKey: state.settings.anatomyAimPoint,
      presentation: presentationKey,
      units: state.settings.units,
    });
    if (anat.ok) {
      const sp = SPECIES_BODY[state.settings.anatomySpecies];
      const sexLabel = sexLabelFor(state.settings.anatomySpecies, state.settings.anatomySex);
      const aim = AIM_POINTS[state.settings.anatomyAimPoint];
      const quarter = getQuarteringGuidance(presentationKey);
      const silhouetteSvg = renderDeerSilhouette({
        dropCm: r.dropCm,
        speciesKey: state.settings.anatomySpecies,
        sex: state.settings.anatomySex,
        aimPointKey: state.settings.anatomyAimPoint,
        compact: true,
      });
      // Quartering block: only when angled (broadside is the implicit default,
      // and its one-liner would just be noise on every render).
      const quarterHtml = quarter.key !== 'broadside'
        ? `<div class="bx-anatomy-quarter">
             <span class="bx-anatomy-quarter-tag">${escapeHtml(quarter.label)}</span>
             ${escapeHtml(quarter.text)}
             ${quarter.warning ? `<div class="bx-anatomy-quarter-warn">⚠ ${escapeHtml(quarter.warning)}</div>` : ''}
           </div>`
        : '';
      anatomyHtml = `
        <div class="bx-output-section bx-anatomy-section">
          <div class="bx-anatomy-header">
            <div class="bx-output-label">Aim on the deer</div>
            <button id="bx-anatomy-edit" type="button" class="bx-link" aria-label="Anatomy settings">Settings</button>
          </div>
          <div class="bx-anatomy-target">
            ${escapeHtml(sp.label)} ${escapeHtml(sexLabel)}
            <span class="bx-sep">·</span>
            ${escapeHtml(aim.label)}
            ${quarter.key !== 'broadside' ? `<span class="bx-sep">·</span>${escapeHtml(quarter.label)}` : ''}
            <span class="bx-sep">·</span>
            chest ~${bxImp() ? cmToInches(anat.chestDepthCm).toFixed(0) : anat.chestDepthCm} ${bxSmallU()}
          </div>
          <div class="bx-anatomy-silhouette">${silhouetteSvg}</div>
          ${quarter.key !== 'broadside' ? `<div class="bx-anatomy-viewnote">Silhouette shows the broadside reference — apply the ${escapeHtml(quarter.label.toLowerCase())} hold below.</div>` : ''}
          <div class="bx-anatomy-text">${escapeHtml(anat.text).replace(/^Hold /, `Hold <span class="bx-anat-arrow">${dropArrow}</span> `)}</div>
          ${(Math.abs(r.windDriftCm) >= 1 && windDir) ? `<div class="bx-anatomy-windnote">Drop hold only — the silhouette doesn't include wind. At this range the bullet also drifts ${bxSmall(Math.abs(r.windDriftCm))} ${bxSmallU()} ${windDir}; account for that on top of this hold.</div>` : ''}
          ${quarterHtml}
          ${anat.warning ? `<div class="bx-anatomy-warn">⚠ ${escapeHtml(anat.warning)}</div>` : ''}
          <div class="bx-anatomy-disclaimer">
            Approximate guide based on average body dimensions. Real animals
            vary. The stalker is responsible for the shot.
          </div>
        </div>
      `;
    }
  }

  // Reference sections (legal, ethical range, dead-hold) are constant per
  // rifle/zero/conditions — they collapse behind a disclosure so the live shot
  // data stays up top. Compute a worst-case legal status for the collapsed
  // summary so the stalker still gets an at-a-glance ✓ / ⚠ without expanding.
  // 12.99 (Ian: "something that will make beginners think about backstops").
  // The maximum carry of THIS load, computed not quoted, opening the Legal &
  // ethical panel — doctrine, deliberately NOT part of any firing solution.
  let carryM = null;
  const carryKey = [p.id, effectiveMvFps(p), p.bcG1, p.bcG7, p.weightGrains, state.conditions.tempC, state.conditions.pressureHpa, state.conditions.humidityPct].join('|');
  if (_carryCache.key === carryKey) carryM = _carryCache.val;
  else {
    try {
      carryM = maxCarryRangeM({
        muzzleVelocityMs: fpsToMs(effectiveMvFps(p)), bcG1: p.bcG1, bcG7: p.bcG7,
        bulletMassKg: grainsToKg(p.weightGrains), sightHeightCm: p.sightHeightCm,
        tempC: state.conditions.tempC, pressureHpa: state.conditions.pressureHpa,
        humidityPct: state.conditions.humidityPct,
      });
    } catch (e) { carryM = null; }
    _carryCache = { key: carryKey, val: carryM };
  }
  const carryKm = carryM ? (bxImp() ? (carryM / 1609.344).toFixed(1) : (Math.round(carryM / 100) / 10).toFixed(1)) : null;
  const backstopHtml = carryKm ? `
      <div class="bx-backstop">
        <div class="bx-backstop-head">No backstop, no shot</div>
        <div class="bx-backstop-body">With nothing to stop it, this bullet can carry roughly <strong>${carryKm} ${bxImp() ? 'miles' : 'km'}</strong> and is dangerous the whole way. The only safe backstop is solid ground you can see behind the deer — never shoot at a skylined animal.</div>
      </div>` : '';
  const refHtml = `${backstopHtml}${renderComplianceSection(p, { state, checkLegalCompliance, checkAbsoluteFloor, escapeHtml })}
      ${renderEthicalRangeSection(p)}`;
  const legalStatus = (() => {
    const filter = state.settings.speciesFilter || [];
    let worst = 'pass', any = false;
    for (const sp of filter) {
      const res = checkLegalCompliance(p, state.settings.jurisdiction, sp);
      if (!res || !res.checks || res.checks.length === 0) continue;
      any = true;
      if (res.overall === 'fail') { worst = 'fail'; break; }
      if (res.overall === 'unknown' && worst === 'pass') worst = 'unknown';
    }
    if (!any) return { icon: '•', cls: 'unk', label: 'Legal & ethical range' };
    if (worst === 'fail') return { icon: '⚠', cls: 'warn', label: 'Below legal minimum — check compliance' };
    if (worst === 'unknown') return { icon: '•', cls: 'unk', label: 'Legal (some fields unverified) & ethical range' };
    return { icon: '✓', cls: 'ok', label: 'Legal & ethical range' };
  })();

  // Concise screen-reader announcement of the live result (audit C2). #bx-output
  // is rewritten on every slider tick; a separate polite live region carries a
  // short summary so a blind stalker hears the hold/energy without the whole DOM.
  const liveRegion = $('bx-output-live');
  if (liveRegion) {
    const windSay = (r.windDriftCm && Math.abs(r.windDriftCm) >= 0.5 && windDir)
      ? `, wind ${Math.abs(r.windDriftMoa).toFixed(1)} MOA ${windDir}` : '';
    liveRegion.textContent =
      `Hold ${bxSmall(dropMag)} ${bxImp() ? 'inches' : 'centimetres'} ${holdWord || 'on zero'}, ${moaStr} MOA${windSay}. `
      + `${Math.round(r.energyFtLbs)} foot-pounds at ${bxDist(state.rangeM)} ${bxImp() ? 'yards' : 'metres'}. ${legalStatus.label}.`;
  }

  out.innerHTML = `
    <div class="bx-output-card">
      <div class="bx-output-section">
        <div class="bx-output-label">Hold</div>
        <div class="bx-output-hold">
          <span class="bx-output-arrow">${dropArrow}</span>
          <span class="bx-output-bignum">${bxSmall(dropMag)}</span>
          <span class="bx-output-bigunit">${bxSmallU()}${holdWord ? ' ' + holdWord : ''}</span>
        </div>
        <div class="bx-output-sub" title="The hold above, in scope-adjustment units — dial or hold this many MOA / MIL in the direction of the arrow. (The printed dope card lists the same figures as signed drop, e.g. -2.3, per the ammo-box convention.)">
          <span>${moaStr} MOA</span>
          <span class="bx-sep">·</span>
          <span>${milStr} MIL</span>
        </div>
      </div>

      ${anatomyHtml}

      ${r.windDriftCm !== 0
        ? `<div class="bx-output-section">
            <div class="bx-output-label">Wind drift</div>
            <div class="bx-output-sub">
              ${bxSmall(Math.abs(r.windDriftCm))} ${bxSmallU()}
              <span class="bx-sep">·</span>
              ${Math.abs(r.windDriftMoa).toFixed(1)} MOA${windDir ? ' ' + windDir : ''}
            </div>
          </div>` : ''}

      ${renderMpbrSection(p)}

      ${state.rangeM > 400
        ? `<div class="bx-output-section bx-longrange-section">
            <div class="bx-output-label">Long-range effects (not modelled)</div>
            <div class="bx-longrange-note">
              At this range, two effects the calculator does <strong>not</strong> model
              can shift impact by ${bxImp() ? 'an inch or two' : 'several centimetres'} each:
            </div>
            <ul class="bx-longrange-list">
              <li>
                <strong>Spin drift:</strong> right-twist barrels (most rifles) drift the
                bullet ~${bxSmall(Math.round((state.rangeM - 300) * 0.04 + 5))}&nbsp;${bxSmallU()} to the right at this range.
                Left-twist drifts left.
              </li>
              <li>
                <strong>Coriolis:</strong> at UK latitudes (~50–60°N), Coriolis can shift
                impact ±${bxSmall(Math.round((state.rangeM - 300) * 0.025 + 3))}&nbsp;${bxSmallU()} depending on
                shooting bearing — east-shooting shifts up, west-shooting shifts down,
                lateral shift varies with bearing.
              </li>
            </ul>
            <div class="bx-longrange-foot">
              Estimates only. Verify with live-fire at this range before relying on
              calculated drop for ethical shots.
            </div>
          </div>` : ''}

      <div class="bx-output-section bx-target-section">
        <div class="bx-output-label">Velocity at ${state.settings.units === 'imperial' ? Math.round(metresToYards(state.rangeM)) + 'yd' : state.rangeM + 'm'}</div>
        <div class="bx-target-compact"><span class="bx-target-num">${Math.round(r.velocityFps)}</span> fps<span class="bx-sep">·</span>${Math.round(r.velocityMs)} m/s</div>
        ${(() => {
          // Test-barrel caveat. If the active profile derives from a factory
          // load record, mention the published test-barrel length so the
          // stalker knows where the muzzle velocity number came from. Most
          // factory data is from 24" barrels; a typical UK stalking rifle
          // is 18-22". Each 2" reduction loses ~50 fps for a typical .308
          // load — enough to matter at range. Encourage chronographing.
          //
          // If the user HAS already chronographed (chronoMv set), show the
          // delta as confirmation instead of the generic caveat — they've
          // done the work and the calculator should reflect that.
          const sourceLoad = p.loadId ? getLoadById(state.db, p.loadId) : null;
          if (p.chronoMv && p.chronoMv > 0) {
            const delta = p.chronoMv - p.muzzleVelocityFps;
            const sign = delta >= 0 ? '+' : '';
            return `<div class="bx-output-tinynote">
              Using your chronographed MV (${p.chronoMv} fps, ${sign}${delta} fps from published).
            </div>`;
          }
          if (sourceLoad && sourceLoad.testBarrelInches && !p.custom) {
            return `<div class="bx-output-tinynote">
              From a ${sourceLoad.testBarrelInches}″ test barrel — your rifle may differ; chronograph for range work.
            </div>`;
          }
          return '';
        })()}
        ${(() => {
          // Distinguish deliberate-subsonic loads (where MV is already below
          // Mach 1, e.g. Hornady 175gr Sub-X at 1050 fps) from supersonic
          // loads that have decelerated through Mach 1 before reaching the
          // target. The latter is the one that matters: solver predictions
          // become unreliable through the transonic region (Mach 0.8-1.2)
          // because of unmodelled drag-coefficient changes and the bullet
          // may suffer accuracy-killing instability on the way down.
          //
          // A deliberate-subsonic load shoots a flatter, more predictable
          // arc within its design envelope; we don't want to alarm the
          // user about something that's working as intended.
          // Muzzle Mach from the ACTUAL muzzle velocity (chrono/trued if set)
          // and the real speed of sound at the current temperature — a 1080 fps
          // load is subsonic on a cold dawn but transonic on a warm afternoon.
          const muzzleMach = fpsToMs(effectiveMvFps(p)) / speedOfSound(state.conditions.tempC);
          const startedSupersonic = muzzleMach > 1.05;

          if (r.isSubsonic && startedSupersonic) {
            return `<div class="bx-output-warn">
              ⚠ <strong>Bullet has gone transonic.</strong> Trajectory and
              accuracy beyond this range are unreliable — drop predictions
              and group size both degrade through Mach 0.8–1.2. Stay inside
              the supersonic envelope for ethical shots.
            </div>`;
          }
          if (r.isTransonic && startedSupersonic) {
            return `<div class="bx-output-warn">
              ⚠ <strong>Approaching transonic.</strong> Drag-coefficient
              changes through Mach 0.8–1.2 make trajectory predictions less
              reliable. Verify with live-fire at this range before relying
              on the calculated drop.
            </div>`;
          }
          if (!startedSupersonic) {
            // Deliberate subsonic / moderated load — proper mode panel with a
            // "don't shoot past X" envelope, not just an informational note.
            return renderSubsonicPanel(p);
          }
          return '';
        })()}
      </div>

      <div class="bx-output-section bx-target-section">
        <div class="bx-output-label">Energy at ${state.settings.units === 'imperial' ? Math.round(metresToYards(state.rangeM)) + 'yd' : state.rangeM + 'm'}</div>
        <div class="bx-target-compact"><span class="bx-target-num">${Math.round(r.energyFtLbs)}</span> ft-lb<span class="bx-sep">·</span>${Math.round(r.energyJ)} J${energyDropNote ? '<span class="bx-sep">·</span><span class="bx-energy-drop">' + escapeHtml(energyDropNote) + '</span>' : ''}</div>
        <div class="bx-target-note">Retained energy — <strong>not</strong> the legal figure. Deer law uses <strong>muzzle</strong> energy (see Legal compliance).</div>
      </div>

      <div class="bx-ref">
        <button class="bx-ref-toggle ${flRefOpen ? 'open' : ''}" id="bx-ref-toggle" type="button" aria-expanded="${flRefOpen ? 'true' : 'false'}" aria-controls="bx-ref-panel">
          <span class="bx-ref-status bx-ref-${legalStatus.cls}">${legalStatus.icon}</span>
          <span class="bx-ref-title">${legalStatus.label}</span>
          <span class="bx-ref-more"><span class="bx-ref-more-text">${flRefOpen ? 'Hide' : 'Show'}</span><span class="bx-ref-caret">▾</span></span>
        </button>
        <div class="bx-ref-panel" id="bx-ref-panel"${flRefOpen ? '' : ' hidden'}>
          ${refHtml}
        </div>
      </div>

      ${renderRangeCard(p, { state, solveProfileAt, open: flRangeCardOpen, wind: describeWind(state.conditions.windMps, state.conditions.windDirDeg) })}
    </div>
  `;

  // Wire up the anatomy "Settings" button if it was rendered.
  const anatBtn = $('bx-anatomy-edit');
  if (anatBtn) anatBtn.addEventListener('click', openAnatomyEditor);

  // Reference disclosure toggle (legal / ethical range / dead-hold). Flips the
  // session flag and shows/hides the panel without a full re-render, so it stays
  // put while the range slider re-renders the card around it.
  const refToggle = $('bx-ref-toggle');
  if (refToggle) refToggle.addEventListener('click', () => {
    flRefOpen = !flRefOpen;
    const panel = $('bx-ref-panel');
    if (panel) { if (flRefOpen) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', ''); }
    refToggle.setAttribute('aria-expanded', flRefOpen ? 'true' : 'false');
    refToggle.classList.toggle('open', flRefOpen);
    const moreText = refToggle.querySelector('.bx-ref-more-text');
    if (moreText) moreText.textContent = flRefOpen ? 'Hide' : 'Show';
  });

  // Range-card disclosure is a native <details>; persist its open state across
  // the per-tick re-render so it survives a slider drag.
  const rcDetails = $('bx-rc-details');
  if (rcDetails) rcDetails.addEventListener('toggle', () => { flRangeCardOpen = rcDetails.open; });

  renderDropChart();
  renderReticleHold(r);
}

// ── Reticle holdover picture ───────────────────────────────────────────
//
// Draws the stalker's reticle and marks where to hold for the current shot's
// come-up (and wind), reusing the drop/wind already computed — no new
// ballistics, just a picture of the existing numbers. v1 ships the mil-dot
// reticle; RETICLES is a registry so more styles can be added without touching
// the renderer. Second-focal-plane scopes note that subtensions are only true
// at the calibrated magnification.
const RETICLES = Object.freeze({
  mildot:  { id: 'mildot',  label: 'Mil-dot',       unit: 'mil', unitLabel: 'mil', spacing: 1.0, maxMarks: 6,  style: 'dot',  major: 1, wind: false },
  miltree: { id: 'miltree', label: 'Mil-hash tree', unit: 'mil', unitLabel: 'mil', spacing: 0.5, maxMarks: 10, style: 'hash', major: 1, wind: true },
  moa:     { id: 'moa',     label: 'MOA hash',       unit: 'moa', unitLabel: 'MOA', spacing: 2.0, maxMarks: 8,  style: 'hash', major: 4, wind: false },
});
const DEFAULT_RETICLE = 'mildot';

// The persistent host is injected once (init) so the <details> open/closed state
// survives the per-tick renderOutput. renderReticleHold only swaps its inner body.
function renderReticleHold(shot) {
  const body = $('bx-reticle-body');
  if (!body) return;
  const p = getActiveProfile();
  if (!p || !shot) { body.innerHTML = ''; return; }
  const ret = RETICLES[p.reticleId] || RETICLES[DEFAULT_RETICLE];

  // Hold values in the reticle's unit. dropMil > 0 = bullet below LoS = hold a
  // LOWER mark on the target (mark sits below centre). windDriftMil: + = drift
  // right → hold left (mark left of centre) to compensate.
  const dropUnits = ret.unit === 'moa' ? shot.dropMoa : shot.dropMil;
  const windUnits = ret.unit === 'moa' ? shot.windDriftMoa : shot.windDriftMil;
  const down = dropUnits;                 // + below centre
  const side = windUnits;                 // ring goes to the DRIFT side (where the bullet lands) — the mark you place on the deer, matching how 'down' follows the drop. + = right on screen

  const near = nearestReticleMark(Math.abs(down), ret.spacing);
  const focal = p.reticleFocalPlane === 'sfp' ? 'sfp' : 'ffp';
  const mag = p.reticleCalibratedMagX;

  // Call-out naming the nearest visible mark.
  let callout;
  if (!(Math.abs(down) > 0.02)) {
    callout = 'Dead-on — hold centre.';
  } else if (near) {
    const rem = near.remainder;
    const remTxt = Math.abs(rem) < 0.05
      ? `right on the ${near.mark.toFixed(ret.spacing < 1 ? 1 : 0)} ${ret.unitLabel} mark`
      : `${Math.abs(rem).toFixed(1)} ${ret.unitLabel} ${rem > 0 ? 'below' : 'above'} the ${near.mark.toFixed(ret.spacing < 1 ? 1 : 0)} ${ret.unitLabel} mark`;
    callout = `Hold ${remTxt}${Math.abs(side) > 0.05 ? `, ${Math.abs(side).toFixed(1)} ${ret.unitLabel} ${side > 0 ? 'right' : 'left'}` : ''}.`;
  }

  const svg = buildReticleSvg(ret, down, side);
  const holdBits = [`<strong>${Math.abs(down).toFixed(1)} ${ret.unitLabel}</strong> ${down >= 0 ? 'down' : 'up'}`];
  if (Math.abs(side) > 0.05) holdBits.push(`<strong>${Math.abs(side).toFixed(1)} ${ret.unitLabel}</strong> ${side > 0 ? 'right' : 'left'}`);

  body.innerHTML = `
    <div class="bx-reticle-target">${ret.label} · ${focal.toUpperCase()}${focal === 'sfp' && mag ? ` @ ${mag}×` : ''}<button id="bx-reticle-edit" type="button" class="bx-link">Settings</button></div>
    <div class="bx-reticle-scope">${svg}</div>
    <div class="bx-reticle-hold">Hold ${holdBits.join(' · ')}</div>
    ${callout ? `<div class="bx-reticle-callout">${escapeHtml(callout)}</div>` : ''}
    <div class="bx-reticle-note">${focal === 'sfp'
      ? `Second focal plane — subtensions are only correct at ${mag ? mag + '×' : 'your calibrated magnification'}.`
      : 'First focal plane — subtensions hold at any magnification.'} Wind hold assumes the conditions you\'ve set.</div>
  `;
  const editBtn = $('bx-reticle-edit');
  if (editBtn) editBtn.addEventListener('click', () => openReticleModal(p.id));
}

// Build the reticle SVG: crosshair + marks + the gold hold ring. `down`/`side`
// are in the reticle's angular unit; marks are drawn at `spacing` intervals in
// the reticle's style (dots for mil-dot, hash ticks for the hash/tree reticles,
// with longer ticks on the whole-unit "major" marks). `wind` reticles add a
// light holdover grid of dots below centre (the "Christmas tree").
function buildReticleSvg(ret, down, side) {
  const NSc = 100, NSy = 95;          // centre in a 200×200 viewBox
  const ppu = ret.unit === 'moa' ? 5.2 : 15;   // px per unit; mil bigger than MOA
  const style = ret.style || 'dot';
  const majorEvery = ret.major || 1;
  const marks = [];
  const mark = (x, y, horiz, major) => {
    if (style === 'dot') return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.1" fill="rgba(255,255,255,0.85)"/>`;
    const h = major ? 6 : 3.4;
    return horiz
      ? `<line x1="${(x - h).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + h).toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.82)" stroke-width="1"/>`
      : `<line x1="${x.toFixed(1)}" y1="${(y - h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(y + h).toFixed(1)}" stroke="rgba(255,255,255,0.82)" stroke-width="1"/>`;
  };
  for (let i = 1; i <= ret.maxMarks; i++) {
    const off = i * ret.spacing * ppu;
    const major = Math.abs((i * ret.spacing) % majorEvery) < 1e-6;
    marks.push(mark(NSc, NSy + off, true, major));   // down
    marks.push(mark(NSc, NSy - off, true, major));   // up
    marks.push(mark(NSc + off, NSy, false, major));  // right
    marks.push(mark(NSc - off, NSy, false, major));  // left
  }
  // Wind-hold grid ("tree"): small dots at ±0.5 and ±1.0 unit either side of
  // the whole-unit elevation lines below centre — a compact holdover tree.
  if (ret.wind) {
    for (let e = 1; e <= 4; e++) {
      for (const wx of [0.5, 1.0]) {
        for (const s of [1, -1]) {
          marks.push(`<circle cx="${(NSc + s * wx * ppu).toFixed(1)}" cy="${(NSy + e * ppu).toFixed(1)}" r="1.4" fill="rgba(255,255,255,0.55)"/>`);
        }
      }
    }
  }
  // Clamp the hold ring into the visible scope so extreme holds still show.
  const hx = Math.max(16, Math.min(184, NSc + side * ppu));
  const hy = Math.max(16, Math.min(184, NSy + down * ppu));
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Reticle with hold point">
  <defs><clipPath id="bx-ret-clip"><circle cx="${NSc}" cy="${NSy}" r="88"/></clipPath></defs>
  <circle cx="${NSc}" cy="${NSy}" r="88" fill="#22301a"/>
  <g clip-path="url(#bx-ret-clip)">
    <line x1="${NSc}" y1="8" x2="${NSc}" y2="${NSy - 13}" stroke="rgba(255,255,255,0.85)" stroke-width="1.4"/>
    <line x1="${NSc}" y1="${NSy + 13}" x2="${NSc}" y2="188" stroke="rgba(255,255,255,0.85)" stroke-width="1.4"/>
    <line x1="8" y1="${NSy}" x2="${NSc - 13}" y2="${NSy}" stroke="rgba(255,255,255,0.85)" stroke-width="1.4"/>
    <line x1="${NSc + 13}" y1="${NSy}" x2="188" y2="${NSy}" stroke="rgba(255,255,255,0.85)" stroke-width="1.4"/>
    <circle cx="${NSc}" cy="${NSy}" r="2" fill="#7adf7a"/>
    ${marks.join('')}
    <line x1="${NSc}" y1="${NSy}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}" stroke="rgba(216,176,84,0.5)" stroke-width="0.8" stroke-dasharray="2,2"/>
    <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="7" fill="none" stroke="#d8b054" stroke-width="2"/>
    <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="2" fill="#d8b054"/>
  </g>
</svg>`;
}

// ── Ethical maximum range per species ──────────────────────────────────
//
// IMPORTANT FRAMING: UK statutory deer-law thresholds are MUZZLE energy
// minima, not impact-energy minima. They specify what the cartridge must
// be capable of, not the energy required at the point of impact.
//
// Many stalkers and deer-management courses (DSC1/DSC2) nonetheless use
// the statutory muzzle minimum as a useful retained-energy floor for
// ethical shot selection — the reasoning being that if the law says the
// cartridge needs to make X ft-lb at the muzzle to be safe and humane on
// this species, then a reasonable shot ought to deliver at least that
// much at the target.
//
// We compute "ethical max range" as the range at which retained energy
// crosses below the legal muzzle minimum. This is a HEURISTIC. The
// display text MUST be honest that this is an ethical guideline drawn
// from a legal threshold, not the law itself.

const ETHICAL_RANGE_SAMPLE_STEP_M = 10;
const ETHICAL_RANGE_MAX_PROBE_M = 500;

/** 12.91 (owner, live test on the dev server: "presentation wise is this the
 *  best way?"): the arc, drawn. Two flat sections asked the reader to
 *  reconcile 174 m and 250 m in prose; the diagram shows it — the parchment
 *  band is the vital zone, the gold curve is THIS load's real trajectory at
 *  the best zero (solved, not sketched), it kisses the top at the peak,
 *  falls out of the bottom at the far edge, and a dashed tick marks where
 *  the CURRENT zero's dead-hold runs out mid-band. Label discipline for
 *  phone width: 12px+ in a 640 viewBox, and the far-zero x-label yields when
 *  it would collide with the bold max label (both live in the strip anyway). */
function pbrArcSvg(opt, heldMaxM, vitalRadiusCm, traj, imp) {
  if (!opt || !traj || traj.length < 6) return '';
  // Geometry stays metric (X() maps metres); only the printed labels turn.
  const aD = (m) => imp ? Math.round(m * 1.0936133) : m;
  const aS = (cm) => imp ? +(cm / 2.54).toFixed(1) : cm;
  const W = 640, H = 150, PADL = 8, PADR = 52, PADT = 18, PADB = 28;
  const xmax = Math.max(opt.maxRangeM + 18, 120);
  let minRise = 0;
  for (const r of traj) { const rise = -r.dropCm; if (rise < minRise) minRise = rise; }
  const ymax = vitalRadiusCm * 1.35;
  const ymin = Math.min(-vitalRadiusCm * 1.35, minRise - 0.8);
  const X = (m) => PADL + (W - PADL - PADR) * m / xmax;
  const Y = (cm) => PADT + (H - PADT - PADB) * (1 - (cm - ymin) / (ymax - ymin));
  let d = '';
  for (const r of traj) {
    if (r.rangeM > xmax - 4) break;
    d += (d ? 'L' : 'M') + X(r.rangeM).toFixed(1) + ' ' + Y(-r.dropCm).toFixed(1);
  }
  const bt = Y(vitalRadiusCm), bb = Y(-vitalRadiusCm), ly = Y(0);
  const vLabN = aS(vitalRadiusCm);
  const vLab = (vLabN % 1 === 0) ? String(vLabN) : vLabN.toFixed(1);
  const farLabelFits = (X(opt.maxRangeM) - X(opt.zeroRangeM)) >= 40;
  const showYours = heldMaxM && (opt.maxRangeM - heldMaxM) >= 10;
  return `<svg class="bx-pbr-arc" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <rect x="${PADL}" y="${bt.toFixed(1)}" width="${W - PADL - PADR}" height="${(bb - bt).toFixed(1)}" fill="rgba(240,228,192,0.06)"/>
    <line x1="${PADL}" x2="${W - PADR}" y1="${bt.toFixed(1)}" y2="${bt.toFixed(1)}" stroke="rgba(216,176,84,0.45)" stroke-width="1" stroke-dasharray="4 4"/>
    <line x1="${PADL}" x2="${W - PADR}" y1="${bb.toFixed(1)}" y2="${bb.toFixed(1)}" stroke="rgba(216,176,84,0.45)" stroke-width="1" stroke-dasharray="4 4"/>
    <line x1="${PADL}" x2="${W - PADR}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="rgba(240,228,192,0.18)" stroke-width="1"/>
    <rect x="${X(0).toFixed(1)}" y="${bt.toFixed(1)}" width="${(X(opt.maxRangeM) - X(0)).toFixed(1)}" height="${(bb - bt).toFixed(1)}" fill="rgba(226,189,96,0.07)"/>
    <path d="${d}" fill="none" stroke="#e2bd60" stroke-width="2.4" stroke-linecap="round"/>
    ${opt.riseRangeM != null ? `<circle cx="${X(opt.riseRangeM).toFixed(1)}" cy="${bt.toFixed(1)}" r="3.2" fill="#e2bd60"/>` : ''}
    <line x1="${X(opt.maxRangeM).toFixed(1)}" x2="${X(opt.maxRangeM).toFixed(1)}" y1="${bt.toFixed(1)}" y2="${(bb + 6).toFixed(1)}" stroke="#e2bd60" stroke-width="1.8"/>
    ${showYours ? `<line x1="${X(heldMaxM).toFixed(1)}" x2="${X(heldMaxM).toFixed(1)}" y1="${(bb - 14).toFixed(1)}" y2="${(bb + 6).toFixed(1)}" stroke="rgba(240,228,192,0.6)" stroke-width="1.4" stroke-dasharray="3 3"/>` : ''}
    ${opt.nearZeroM != null ? `<circle cx="${X(opt.nearZeroM).toFixed(1)}" cy="${ly.toFixed(1)}" r="2.6" fill="none" stroke="#a99e7f" stroke-width="1.3"/>` : ''}
    <circle cx="${X(opt.zeroRangeM).toFixed(1)}" cy="${ly.toFixed(1)}" r="2.6" fill="none" stroke="#a99e7f" stroke-width="1.3"/>
    <g font-family="'DM Mono',monospace" font-size="12" fill="#a99e7f" letter-spacing="0.5">
      <text x="${W - PADR + 6}" y="${(bt + 4).toFixed(1)}" font-size="11">+${vLab}</text>
      <text x="${W - PADR + 6}" y="${(bb + 4).toFixed(1)}" font-size="11">\u2212${vLab}</text>
      ${opt.riseRangeM != null ? `<text x="${(X(opt.riseRangeM) - 22).toFixed(1)}" y="${(bt - 6).toFixed(1)}" fill="#e2bd60" font-size="11.5">PEAK ${aD(opt.riseRangeM)}</text>` : ''}
      <text x="${X(0).toFixed(1)}" y="${(bb + 19).toFixed(1)}">0</text>
      ${farLabelFits ? `<text x="${(X(opt.zeroRangeM) - 14).toFixed(1)}" y="${(bb + 19).toFixed(1)}">${aD(opt.zeroRangeM)}</text>` : ''}
      <text x="${(X(opt.maxRangeM) - 20).toFixed(1)}" y="${(bb + 19).toFixed(1)}" fill="#e2bd60" font-weight="600" font-size="13">${aD(opt.maxRangeM)} ${imp ? 'YD' : 'M'}</text>
      ${showYours ? `<text x="${(X(heldMaxM) - 38).toFixed(1)}" y="${(bb - 19).toFixed(1)}" fill="rgba(240,228,192,0.75)" font-size="11">YOURS ${aD(heldMaxM)}</text>` : ''}
    </g>
  </svg>`;
}

let _mpbrCache = { key: null, val: null };
let _pbrOptCache = { key: null, val: null }; // 12.88: the best-zero optimiser
let _pbrArcCache = { key: null, val: null }; // 12.91: the drawn arc
let _carryCache = { key: null, val: null }; // 12.99: max carry of the load
function renderMpbrSection(p) {
  if (!p) return '';
  const sp = SPECIES_BODY[state.settings.anatomySpecies];
  const sx = sp && sp[state.settings.anatomySex];
  const speciesVital = sx && sx.vitalZoneCm;
  // 12.95 (Ian): the zone is YOURS to set — a neck/brain shooter runs 5 cm,
  // a fox shooter 7 — with the selected species as the labelled default.
  const zoneOverride = Number.isFinite(state.settings.pbrZoneCm) ? state.settings.pbrZoneCm : null;
  const vital = zoneOverride || speciesVital;
  if (!(vital > 0)) return '';
  const vitalRadius = vital / 2;
  const c = state.conditions;
  const mv = effectiveMvFps(p);
  // Keyed on the ACTUAL zero — this is the dead-hold you get from the zero you
  // really use (100 m, 200 m…), not a theoretical optimal zero.
  const key = [p.id, mv, p.bcG1, p.bcG7, p.weightGrains, p.sightHeightCm, p.zeroRangeM, c.tempC, c.pressureHpa, c.humidityPct, vitalRadius].join('|');
  // 12.95: the zone bar — species default plus the sizes the field actually
  // uses (neck/brain 5, fox 7, hare 4). Presets that duplicate the species
  // figure are dropped rather than shown twice.
  // 12.97 (owner, second pass on the wording): plain sizes, no quarry or
  // shot-placement names — "Fox 7" and "Neck 5" read as the app endorsing
  // choices that are the stalker's own. The explainer line carries the
  // meaning instead, in plain words: the size of the target being shot to
  // kill. Label speaks Ian's tool's language (Target Size). No preset below
  // 4 cm: \u00b12 cm is already a good rifle's whole GROUP at 100 m, and a
  // tighter promise would be a lie in field conditions — that end of the
  // game belongs to the come-up card.
  const ZONE_PRESETS = [10, 7, 5, 4];
  // Chip VALUES stay canonical cm; only the printed number turns imperial.
  const zlab = (cm) => bxImp() ? String(+cmToInches(cm).toFixed(1)) : String(cm);
  const zoneChips = [['species', (sp.label || '') + ' ' + zlab(speciesVital)]]
    .concat(ZONE_PRESETS.filter(v => v !== speciesVital).map(v => [v, zlab(v)]))
    .map(([val, lab]) => {
      const on = (val === 'species') ? zoneOverride == null : zoneOverride === val;
      return `<button type="button" class="bx-pbr-zbtn${on ? ' on' : ''}" data-bx-zone="${val}">${escapeHtml(lab)}</button>`;
    }).join('');
  const zoneBar = `<div class="bx-pbr-zonewrap"><div class="bx-pbr-zonebar" role="group" aria-label="Target size"><span class="bx-pbr-zlab">TARGET SIZE</span>${zoneChips}<span class="bx-pbr-zcm">${bxSmallU()}</span></div>`
    + `<div class="bx-pbr-zhelp">The size of the target you are aiming for — your bullet must stay inside it for a dead-centre hold to work. The species figure is the deer's heart-and-lung area; pick a smaller number for a smaller mark.</div></div>`;
  const zoneNoun = zoneOverride
    ? `${bxImp() ? +cmToInches(vital).toFixed(1) : Math.round(vital)} ${bxSmallU()} zone (your setting)`
    : `${bxImp() ? +cmToInches(vital).toFixed(1) : Math.round(vital)} ${bxSmallU()} vital zone (${escapeHtml(sp.label || '')})`;
  let res;
  if (_mpbrCache.key === key) res = _mpbrCache.val;
  else {
    res = pointBlankForZero({
      muzzleVelocityMs: fpsToMs(mv),
      bcG1: p.bcG1, bcG7: p.bcG7,
      bulletMassKg: grainsToKg(p.weightGrains),
      sightHeightCm: p.sightHeightCm,
      zeroRangeM: p.zeroRangeM,
      tempC: c.tempC, pressureHpa: c.pressureHpa, humidityPct: c.humidityPct,
    }, vitalRadius);
    _mpbrCache = { key, val: res };
  }
  // 12.88 (user email: "could I suggest a metric point blank range calculator")
  // — the OPTIMISER beside the actual-zero answer. maxPointBlankRange finds
  // the zero that makes this load's arc just kiss the top of the vital zone,
  // and reports it the way a UK stalker sights in: cm high at 100 m. Metric
  // throughout — the request was a stalker converting a US inch tool by hand.
  let opt = null;
  if (_pbrOptCache.key === key) opt = _pbrOptCache.val;
  else {
    opt = maxPointBlankRange({
      muzzleVelocityMs: fpsToMs(mv),
      bcG1: p.bcG1, bcG7: p.bcG7,
      bulletMassKg: grainsToKg(p.weightGrains),
      sightHeightCm: p.sightHeightCm,
      tempC: c.tempC, pressureHpa: c.pressureHpa, humidityPct: c.humidityPct,
    }, vitalRadius);
    _pbrOptCache = { key, val: opt };
  }
  const vitalCm = Math.round(vitalRadius * 2);
  const optLabelTail = zoneOverride ? `${bxImp() ? +cmToInches(vitalCm).toFixed(1) : vitalCm} ${bxSmallU()} zone` : escapeHtml(sp.label || '');
  let optHtml = '';
  if (opt && opt.zeroRangeM && opt.sightIn100Cm != null) {
    // The sight-in anchor deliberately STAYS "at 100 m" in both voices — the
    // height converts, the anchor distance is exact and stated. Restating it
    // "at 100 yd" would quietly change the number's meaning by 8.56 m.
    const sightLine = opt.sightIn100Cm >= 0.1
      ? `<strong>${bxSmall(opt.sightIn100Cm)} ${bxSmallU()} high at 100 m</strong>`
      : '<strong>dead on at 100 m</strong>';
    // The persuasive line: what the best zero BUYS over the one in the profile.
    let deltaNote = '';
    if (res && res.maxRangeM) {
      const gain = opt.maxRangeM - res.maxRangeM;
      deltaNote = gain >= 10
        ? ` That buys you ${bxDist(gain)} ${bxDistU()} of dead-hold over your current ${bxDist(res.zeroRangeM)} ${bxDistU()} zero.`
        : ` Your current ${bxDist(res.zeroRangeM)} ${bxDistU()} zero already gets within ${bxDist(Math.max(0, gain))} ${bxDistU()} of it.`;
    }
    // 12.89 (owner: "What about the metrics") — the email asked for four
    // numbers BY NAME: near zero, far zero, minimum and maximum point blank
    // range. Print them as figures, not just prose; a shooter who lives in
    // the US tool scans for the row. Min PBR is usually the muzzle, but with
    // high mounts over a small vital zone it honestly is not — say which.
    // 12.91: the arc is the REAL trajectory at the best zero — re-solved (and
    // cached with the section) rather than sketched, so the curve, the peak
    // dot and the exit all agree with the figures by construction.
    let arc = '';
    if (_pbrArcCache.key === key) arc = _pbrArcCache.val;
    else {
      try {
        const b2 = {
          muzzleVelocityMs: fpsToMs(mv), bcG1: p.bcG1, bcG7: p.bcG7,
          bulletMassKg: grainsToKg(p.weightGrains), sightHeightCm: p.sightHeightCm,
          densityRatio: airDensityRatio(c.tempC, c.pressureHpa, c.humidityPct), tempC: c.tempC,
        };
        const ang = findZeroAngle(b2, opt.zeroRangeM);
        const traj = solveTrajectory({ ...b2, launchAngleRad: ang, maxRangeM: opt.maxRangeM + 25, stepM: 2 });
        arc = pbrArcSvg(opt, res && res.maxRangeM, vitalRadius, traj, bxImp());
      } catch (_) { arc = ''; }
      _pbrArcCache = { key, val: arc };
    }
    const holdSpan = opt.nearRangeM > 0
      ? `${bxDist(opt.nearRangeM)}–${bxDist(opt.maxRangeM)} ${bxDistU()}`
      : `0–${bxDist(opt.maxRangeM)} ${bxDistU()}`;
    const strip = `
      <div class="bx-pbr-strip">
        <span class="bx-pbr-cell"><b>${opt.nearZeroM != null ? bxDist(opt.nearZeroM) + ' ' + bxDistU() : '—'}</b>near zero</span>
        <span class="bx-pbr-cell"><b>${bxDist(opt.zeroRangeM)} ${bxDistU()}</b>far zero</span>
        <span class="bx-pbr-cell"><b>${holdSpan}</b>point blank</span>
        <span class="bx-pbr-cell"><b>${bxSmall(opt.maxRiseCm)} ${bxSmallU()}</b>peak · ${bxDist(opt.riseRangeM)} ${bxDistU()}</span>
      </div>`;
    optHtml = `
    <div class="bx-output-section">
      <div class="bx-output-label">Best zero for this load · ${optLabelTail}</div>
      <div class="bx-mpbr-main">Zero ${sightLine}</div>
      ${strip}
      ${arc}
      <div class="bx-mpbr-sub">That is a ${bxDist(opt.zeroRangeM)} ${bxDistU()} zero — the flattest this load can shoot a ${zoneNoun}: aim dead-centre ${opt.nearRangeM > 0 ? `from ${bxDist(opt.nearRangeM)} ${bxDistU()}` : 'from the muzzle'} to <strong>${bxDist(opt.maxRangeM)} ${bxDistU()}</strong>.${deltaNote} On the range: ${opt.sightIn100Cm >= 0.1 ? `set the group ${bxSmall(opt.sightIn100Cm)} ${bxSmallU()} above point of aim at 100 m` : 'zero exactly at 100 m'}, then confirm.</div>
    </div>
  `;
  }
  if (!res) return optHtml ? zoneBar + optHtml : '';
  const riseNote = res.risesAbove
    ? ` It climbs ~${bxSmall(res.maxRiseCm, 0)} ${bxSmallU()} high around ${bxDist(res.riseRangeM)}${bxDistU()} — above the vital centre, so hold a touch low there (a lower zero would flatten it).`
    : '';
  // If the mid-range arc climbs past the TOP of the vital zone (not merely above
  // the centre), "dead-hold, no hold-over needed" is an over-claim — the bullet
  // exits the vitals high at mid-range (audit §2). Tell the truth in that case.
  // 12.90 (verification round): +0.35 cm tolerance, because the OPTIMAL zero
  // puts the peak exactly ON the zone edge by construction — re-deriving that
  // zero from the profile reads a rounding hair over (5.1 vs 5.0), and the
  // card was scolding the very zero the section below recommends. A few
  // millimetres of arithmetic is not an over-claim; 4+ mm of real climb is.
  if (res.risesAbove && res.maxRiseCm > res.vitalRadiusCm + 0.35) {
    return zoneBar + `
    <div class="bx-output-section">
      <div class="bx-output-label">Dead-hold zone · ${bxDist(res.zeroRangeM)}${bxDistU()} zero</div>
      <div class="bx-mpbr-main">Not a clean dead-hold at this zero</div>
      <div class="bx-mpbr-sub">With your ${bxDist(res.zeroRangeM)}${bxDistU()} zero the bullet climbs ~${bxSmall(res.maxRiseCm, 0)} ${bxSmallU()} above your aim around ${bxDist(res.riseRangeM)}${bxDistU()} — past the top of a ${zoneNoun}, so it isn't a true dead-hold. Hold a touch low near ${bxDist(res.riseRangeM)}${bxDistU()}, or use a lower zero to flatten the arc; use the come-up above for longer shots.</div>
    </div>
  ` + optHtml;
  }
  return zoneBar + `
    <div class="bx-output-section">
      <div class="bx-output-label">Dead-hold zone · ${bxDist(res.zeroRangeM)}${bxDistU()} zero</div>
      <div class="bx-mpbr-main">Hold dead-on to <strong>${bxDist(res.maxRangeM)}${bxDistU()}</strong></div>
      <div class="bx-mpbr-sub">With your ${bxDist(res.zeroRangeM)}${bxDistU()} zero, aim at the vital centre and the bullet stays inside a ${zoneNoun} out to ${bxDist(res.maxRangeM)}${bxDistU()} — no hold-over needed. Beyond that, use the come-up above.${riseNote}</div>
    </div>
  ` + optHtml;
}

// Subsonic / moderated-load mode. Shown when the muzzle velocity is already
// below the speed of sound (a deliberate subsonic or moderated load, common
// for quiet UK culling). Gives the stalker the one number that matters — the
// "don't shoot past X" range set by the retained-energy floor for their
// selected species — plus the honest drag/stability caveats. Reuses the same
// energy-floor computation as the ethical-range section.
function renderSubsonicPanel(profile) {
  const ranges = computeEthicalMaxRanges(profile);
  const withMax = ranges.filter(r => r.maxRangeM != null);
  const neverMet = ranges.filter(r => r.thresholdFtLb != null && r.maxRangeM == null);
  const binding = withMax.length
    ? withMax.reduce((a, b) => (b.maxRangeM < a.maxRangeM ? b : a))
    : null;

  let guidance, neverNote = '';
  if (binding) {
    guidance = `<div class="bx-subsonic-main">Don't shoot past <strong>${bxDist(binding.maxRangeM)} ${bxDistU()}</strong>
      <span class="bx-subsonic-sub">— retained energy drops below the ${binding.thresholdFtLb} ft-lb floor for ${escapeHtml(binding.speciesLabel)} beyond this.</span></div>`;
    if (neverMet.length) {
      neverNote = `<div class="bx-subsonic-sub">Never reaches the energy floor for ${escapeHtml(neverMet.map(r => r.speciesLabel).join(', '))} — not an ethical choice for ${neverMet.length > 1 ? 'those species' : 'that species'}.</div>`;
    }
  } else if (neverMet.length) {
    guidance = `<div class="bx-subsonic-main bx-subsonic-danger">Below the energy floor for ${escapeHtml(neverMet.map(r => r.speciesLabel).join(', '))} at every range.
      <span class="bx-subsonic-sub">This load can't ethically take your selected species — check calibre/species legality.</span></div>`;
  } else {
    guidance = `<div class="bx-subsonic-sub">No statutory energy floor is set for your selected species here — judge range on placement and wounding energy, and keep shots close.</div>`;
  }

  return `
    <div class="bx-subsonic-panel">
      <div class="bx-subsonic-head"><span class="fl-ic fl-mute"></span> Subsonic / moderated load</div>
      ${guidance}
      ${neverNote}
      <div class="bx-subsonic-note">
        Drop is modelled with the standard G1/G7 drag curve, which is only approximate below the speed of
        sound — treat these come-ups as a starting point and confirm with live fire. A full gyroscopic-stability
        check needs your barrel twist rate; until then, keep subsonic shots short and precise.
      </div>
    </div>
  `;
}

// This ran up to six full 25 m -> 500 m probes and then, because BOTH
// renderSubsonicPanel() and renderEthicalRangeSection() call it inside the same
// renderOutput() pass, ran all of them a second time: ~96 identical trajectory
// solves per slider tick. Two pure fixes, no change to what any caller sees.
//
//   1. Probe once per DISTINCT threshold. Species share energy floors -- in
//      England & Wales the six species collapse to two values (1700 / 1000
//      ft-lb) -- and the probe only ever depended on the threshold, never on
//      which species carried it.
//   2. Memoise the whole result, one slot, exactly as _mpbrCache does above.
//      That is what kills the second call of the pair.
//
// The returned array is now shared between callers, so it must stay read-only.
// Both current callers only filter/reduce/group over it. (Audit 2026-07-25,
// finding B1 -- a ~3.4 s main-thread block on the ballistics screen.)
let _ethicalCache = { key: null, val: null };

/**
 * For each species in the user's filter that has a published muzzle energy
 * minimum in the active jurisdiction, return the furthest probed range at
 * which retained energy is still at or above that minimum.
 *
 * The probe walks a fixed grid -- 25 m, then every ETHICAL_RANGE_SAMPLE_STEP_M
 * out to ETHICAL_RANGE_MAX_PROBE_M -- so the answer is the last grid point that
 * cleared the floor, NOT the true crossing range, and the grid is offset by 5 m
 * rather than landing on round tens. (The old doc claimed "rounded down to
 * nearest 10m", which was wrong on both counts -- audit finding 7.)
 *
 * Each row is { species, speciesLabel, thresholdFtLb, maxRangeM, capped }:
 *   thresholdFtLb — null for species with no statutory minimum here (e.g.
 *                   muntjac in Scotland), in which case maxRangeM is null too.
 *   maxRangeM     — null means the load never made the floor, even at 25 m.
 *   capped        — true when the probe ran out of grid with the load still
 *                   above the floor. maxRangeM is then a FLOOR on the answer,
 *                   not the crossing: callers must not print it as a crossing.
 */
function computeEthicalMaxRanges(profile) {
  if (!profile) return [];
  const c = state.conditions;
  const filter = state.settings.speciesFilter || [];
  // Every input solveProfileAt() reads, plus the two settings that decide which
  // species and thresholds get probed. wind and shot angle are in the key
  // because solveProfileAt applies both, so retained energy at range genuinely
  // moves with them -- omitting them would hand back a stale envelope.
  const key = [
    profile.id, effectiveMvFps(profile), profile.bcG1, profile.bcG7,
    profile.weightGrains, profile.sightHeightCm, profile.zeroRangeM,
    c.tempC, c.pressureHpa, c.humidityPct,
    c.windMps, c.windDirDeg, c.shotAngleDeg,
    state.settings.jurisdiction, filter.join(','),
  ].join('|');
  if (_ethicalCache.key === key) return _ethicalCache.val;

  // Probe outward from 25m until energy drops below the threshold. Keyed on the
  // threshold so species sharing a floor share one walk.
  const byThreshold = new Map();
  function probe(minFtLb) {
    const hit = byThreshold.get(minFtLb);
    if (hit !== undefined) return hit;
    let lastValidRange = null;
    let capped = false;
    for (let r = 25; r <= ETHICAL_RANGE_MAX_PROBE_M; r += ETHICAL_RANGE_SAMPLE_STEP_M) {
      const sol = solveProfileAt(profile, r);
      if (!sol) break;
      if (sol.energyFtLbs >= minFtLb) {
        lastValidRange = r;
        // Still clearing the floor on the last grid point we will ever test.
        capped = (r + ETHICAL_RANGE_SAMPLE_STEP_M) > ETHICAL_RANGE_MAX_PROBE_M;
      } else {
        capped = false;
        break;
      }
    }
    const res = { maxRangeM: lastValidRange, capped };
    byThreshold.set(minFtLb, res);
    return res;
  }

  const out = [];
  for (const speciesCode of filter) {
    const speciesObj = DEER_SPECIES.find(s => s.code === speciesCode);
    if (!speciesObj) continue;
    const minFtLb = minMuzzleEnergyFor(state.settings.jurisdiction, speciesCode);
    if (minFtLb == null) {
      // No statutory threshold for this species in this jurisdiction.
      out.push({
        species: speciesCode,
        speciesLabel: speciesObj.label,
        thresholdFtLb: null,
        maxRangeM: null,
        capped: false,
      });
      continue;
    }
    const { maxRangeM, capped } = probe(minFtLb);
    out.push({
      species: speciesCode,
      speciesLabel: speciesObj.label,
      thresholdFtLb: minFtLb,
      maxRangeM,
      capped,
    });
  }
  _ethicalCache = { key, val: out };
  return out;
}

function renderEthicalRangeSection(profile) {
  if (!profile) return '';
  const ranges = computeEthicalMaxRanges(profile);
  if (ranges.length === 0) return '';

  const items = ((rs) => {
    // Group species sharing an identical outcome (threshold + max range),
    // mirroring the Legal compliance section — else Roe/Red/Fallow/Sika
    // render four identical rows.
    const order = [];
    const bySig = new Map();
    for (const r of rs) {
      const sig = `${r.thresholdFtLb}|${r.maxRangeM}|${r.capped}`;
      let g = bySig.get(sig);
      if (!g) { g = { r, labels: [] }; bySig.set(sig, g); order.push(g); }
      g.labels.push(r.speciesLabel);
    }
    return order.map(({ r, labels }) => {
      const species = escapeHtml(labels.join(', '));
      if (r.thresholdFtLb == null) {
        return `
        <div class="bx-eth-row">
          <span class="bx-eth-species">${species}</span>
          <span class="bx-eth-range bx-eth-na">no statutory minimum</span>
        </div>`;
      }
      if (r.maxRangeM == null) {
        return `
        <div class="bx-eth-row bx-eth-row-fail">
          <span class="bx-eth-species">${species}</span>
          <span class="bx-eth-range">below ${r.thresholdFtLb} ft-lb at all ranges</span>
        </div>`;
      }
      if (r.capped) {
        // The load was STILL above the floor at the last range we probed, so
        // maxRangeM is a floor on the answer, not a crossing. The "+" and the
        // title say so; printing it bare read as a computed crossing that was
        // never computed (audit 2026-07-25, finding 7).
        return `
        <div class="bx-eth-row">
          <span class="bx-eth-species">${species}</span>
          <span class="bx-eth-range" title="Still above the ${r.thresholdFtLb} ft-lb floor at ${bxDist(r.maxRangeM)}${bxDistU()}, the furthest this calculation probes. The real crossing is further out.">${bxDist(r.maxRangeM)}${bxDistU()}+ <span class="bx-eth-threshold">(${r.thresholdFtLb} ft-lb)</span></span>
        </div>`;
      }
      return `
      <div class="bx-eth-row">
        <span class="bx-eth-species">${species}</span>
        <span class="bx-eth-range">${bxDist(r.maxRangeM)}${bxDistU()} <span class="bx-eth-threshold">(${r.thresholdFtLb} ft-lb)</span></span>
      </div>`;
    }).join('');
  })(ranges);

  return `
    <div class="bx-output-section bx-eth-section">
      <div class="bx-output-label">Ethical maximum range</div>
      <div class="bx-eth-list">${items}</div>
      <div class="bx-eth-disclosure">
        Range at which retained energy drops below the statutory <strong>muzzle</strong> minimum
        for each species. UK deer law sets thresholds at the muzzle, not at impact —
        this is an <strong>ethical guideline</strong> commonly used in DSC training, not the law itself.
        Excludes wind drift, transonic effects, and your competence at range. The stalker decides the shot.
      </div>
    </div>
  `;
}

// The collapsed chart's summary line is static HTML — repaint it when the
// units voice changes (25–400 m ≡ 27–437 yd).
function bxPaintChartSummary() {
  const el = $('bx-chart-summary-title');
  if (el) el.textContent = bxImp() ? 'Drop curve · 27–437yd' : 'Drop curve · 25–400m';
}

function renderDropChart() {
  const canvas = $('bx-drop-chart');
  if (!canvas) return;
  const p = getActiveProfile();
  if (!p) { canvas.style.display = 'none'; return; }
  canvas.style.display = 'block';

  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const W = canvas.clientWidth;
  const H = 220;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const night = document.documentElement.classList.contains('bx-night');

  const maxRange = 400;
  const curve = computeDropCurve(maxRange);
  if (curve.length < 2) return;

  // Text equivalent for the canvas. A bare <canvas> is invisible to assistive
  // tech; sample the curve at the gridline ranges so the label describes the
  // trajectory actually plotted rather than just naming the widget.
  const dropAt = (r) => {
    const d = sampleDropAt(curve, r);
    return d == null ? null : Math.round(d);
  };
  // 14.01: imperial gridlines sit at round YARD marks (100…400 yd), solved at
  // their true metre positions — relabelling the metric gridlines "109yd"
  // would be a chart nobody lasers in.
  const imp = bxImp();
  const gridMarks = imp
    ? [100, 200, 300, 400].map(v => ({ m: yardsToMetres(v), lab: v + 'yd' }))
    : [100, 200, 300, 400].map(v => ({ m: v, lab: v + 'm' }));
  const samples = gridMarks.map(g => {
    const d = dropAt(Math.round(g.m));
    if (d == null) return null;
    const at = imp ? `${Math.round(metresToYards(g.m))} yards` : `${Math.round(g.m)} metres`;
    if (Math.abs(d) < 1) return `on the zero at ${at}`;
    return imp
      ? `${cmToInches(Math.abs(d)).toFixed(1)} inches ${d > 0 ? 'low' : 'high'} at ${at}`
      : `${Math.abs(d)} centimetres ${d > 0 ? 'low' : 'high'} at ${at}`;
  }).filter(Boolean);
  canvas.setAttribute('aria-label', imp
    ? `Bullet drop curve from 27 to 437 yards, ${Math.round(metresToYards(p.zeroRangeM))} yard zero: ${samples.join(', ')}.`
    : `Bullet drop curve from 25 to 400 metres, ${p.zeroRangeM} metre zero: ${samples.join(', ')}.`);

  const pad = { l: 40, r: 12, t: 12, b: 26 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  const maxDrop = Math.max(0, ...curve.map(p => p.dropCm)) * 1.05;
  const minDrop = Math.min(0, ...curve.map(p => p.dropCm)) * 1.05;
  const dropSpan = Math.max(20, maxDrop - minDrop);

  const xAt = r => pad.l + (r / maxRange) * cw;
  // Invert the Y axis so larger drops render LOWER on the chart — visually
  // matches a real bullet trajectory (LoS at top, bullet falling below).
  // Previously larger drops rendered higher, which read as the bullet
  // climbing as range increased — counter-intuitive.
  const yAt = d => pad.t + ((d - minDrop) / dropSpan) * ch;

  // Grid + axis labels
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.font = '10px "DM Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  for (const g of gridMarks) {
    const x = xAt(g.m);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ch); ctx.stroke();
    ctx.fillText(g.lab, x - 12, H - 8);
  }
  // y=0 line
  const y0 = yAt(0);
  ctx.strokeStyle = 'rgba(216,176,84,0.3)';
  ctx.beginPath(); ctx.moveTo(pad.l, y0); ctx.lineTo(pad.l + cw, y0); ctx.stroke();
  ctx.fillStyle = 'rgba(216,176,84,0.6)';
  ctx.fillText('0', pad.l - 14, y0 + 3);

  // Energy threshold shading: amber zone where retained energy < the ethical floor for the
  // most-restrictive species in the filter.
  let thresholdFtLb = null;
  for (const sp of state.settings.speciesFilter) {
    const min = minMuzzleEnergyFor(state.settings.jurisdiction, sp);
    if (min != null && (thresholdFtLb == null || min > thresholdFtLb)) thresholdFtLb = min;
  }
  if (thresholdFtLb != null) {
    // Find first range where energy drops below threshold.
    let belowFromR = null;
    for (const pt of curve) {
      if (pt.energyFtLbs < thresholdFtLb) { belowFromR = pt.rangeM; break; }
    }
    if (belowFromR != null) {
      const zx = xAt(belowFromR);
      const zw = xAt(maxRange) - zx;
      if (night) {
        // The red night filter flattens the 10%-amber fill to nothing, so the
        // "below ethical floor — don't shoot past here" band vanishes at dusk.
        // Mark it with a bright diagonal hatch: texture + luminance survive the
        // desaturation where hue can't.
        ctx.save();
        ctx.beginPath(); ctx.rect(zx, pad.t, zw, ch); ctx.clip();
        ctx.strokeStyle = 'rgba(255,255,255,0.40)';
        ctx.lineWidth = 1;
        for (let hx = zx - ch; hx < zx + zw; hx += 8) {
          ctx.beginPath(); ctx.moveTo(hx, pad.t + ch); ctx.lineTo(hx + ch, pad.t); ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
      } else {
        ctx.fillStyle = 'rgba(200,150,0,0.10)';
        ctx.fillRect(zx, pad.t, zw, ch);
        ctx.strokeStyle = 'rgba(200,150,0,0.5)';
        ctx.lineWidth = 1;
      }
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(zx, pad.t);
      ctx.lineTo(zx, pad.t + ch);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      // Label — dark backing at night so it reads over the hatch.
      if (night) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(zx + 2, pad.t + 3, 80, 22); }
      ctx.fillStyle = night ? 'rgba(255,255,255,0.95)' : 'rgba(240,204,116,0.9)';
      ctx.font = '9px "DM Mono", monospace';
      ctx.fillText('< ' + thresholdFtLb + ' ft-lb', zx + 4, pad.t + 12);
      ctx.fillStyle = night ? 'rgba(255,255,255,0.75)' : 'rgba(240,204,116,0.6)';
      ctx.fillText('ethical floor', zx + 4, pad.t + 23);
    }
  }

  // Trajectory curve
  ctx.strokeStyle = '#d8b054';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const pt = curve[i];
    const x = xAt(pt.rangeM);
    const y = yAt(pt.dropCm);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Current target range marker
  ctx.strokeStyle = night ? 'rgba(255,255,255,0.9)' : 'rgba(122,223,122,0.7)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(xAt(state.rangeM), pad.t);
  ctx.lineTo(xAt(state.rangeM), pad.t + ch);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ── Setup wizard ─────────────────────────────────────────────────────────

function openSetupWizard() {
  const modal = $('bx-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">Set up your rifle</div>
      <div class="bx-modal-body" id="bx-wizard-body"></div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-secondary" id="bx-wizard-cancel">Cancel</button>
        <button class="bx-btn" id="bx-wizard-next">Next</button>
      </div>
    </div>
  `;
  $('bx-wizard-cancel').addEventListener('click', closeModal);

  const wizard = { step: 1, name: '', loadId: null,
                   sightHeightCm: 4.0, zeroRangeM: 100, barrelInches: 22,
                   manual: false,
                   muzzleVelocityFps: 2820, weightGrains: 150, bcG1: 0.314, bcG7: 0,
                   species: ['roe', 'red', 'fallow'] };

  function renderStep() {
    const body = $('bx-wizard-body');
    if (wizard.step === 1) {
      body.innerHTML = `
        <div class="bx-field">
          <label for="bx-w-name">Rifle name</label>
          <input type="text" id="bx-w-name" placeholder="e.g. Tikka T3X .308" value="${escapeHtml(wizard.name)}">
        </div>
        <div class="bx-field">
          <label for="bx-w-zero">Zero distance</label>
          <select id="bx-w-zero">
            ${[100, 150, 200].map(z => {
              const cur = Math.round(bxImp() ? metresToYards(wizard.zeroRangeM) : wizard.zeroRangeM);
              return `<option value="${z}" ${cur === z ? 'selected' : ''}>${z} ${bxDistU()}</option>`;
            }).join('')}
          </select>
        </div>
        <div class="bx-field">
          <label for="bx-w-sight">Sight height above bore (${bxSmallU()})</label>
          <input type="number" id="bx-w-sight" min="${bxImp() ? 0.8 : 2}" max="${bxImp() ? 4 : 10}" step="0.1" value="${bxImp() ? +cmToInches(wizard.sightHeightCm).toFixed(1) : wizard.sightHeightCm}">
          <div class="bx-field-hint">Typical ${bxImp() ? '1.5–1.8in' : '3.8–4.5cm'} for standard scope rings</div>
        </div>
        <div class="bx-field">
          <label for="bx-w-barrel">Barrel length (inches)</label>
          <input type="number" id="bx-w-barrel" min="16" max="30" step="0.5" value="${wizard.barrelInches}">
        </div>
      `;
    } else if (wizard.step === 2) {
      const cals = getCalibresWithLoads(state.db);
      body.innerHTML = `
        <div class="bx-field">
          <label>Pick your ammunition</label>
          <div class="bx-tabs">
            <button class="bx-tab ${!wizard.manual?'on':''}" data-tab="factory" aria-pressed="${!wizard.manual?'true':'false'}">Factory load</button>
            <button class="bx-tab ${wizard.manual?'on':''}" data-tab="manual" aria-pressed="${wizard.manual?'true':'false'}">Manual entry</button>
          </div>
          ${wizard.manual ? `
            <div class="bx-row-2">
              <div class="bx-field"><label for="bx-w-mv">Muzzle velocity (fps)</label><input type="number" id="bx-w-mv" value="${wizard.muzzleVelocityFps}"></div>
              <div class="bx-field"><label for="bx-w-wt">Bullet weight (gr)</label><input type="number" id="bx-w-wt" value="${wizard.weightGrains}"></div>
            </div>
            <div class="bx-row-2">
              <div class="bx-field"><label for="bx-w-bc1">BC (G1)</label><input type="number" id="bx-w-bc1" step="0.001" value="${wizard.bcG1}"></div>
              <div class="bx-field"><label for="bx-w-bc7">BC (G7) — optional</label><input type="number" id="bx-w-bc7" step="0.001" value="${wizard.bcG7}"></div>
            </div>
          ` : `
            <div class="bx-row-2">
              <div class="bx-field">
                <label for="bx-w-cal">Calibre</label>
                <select id="bx-w-cal">
                  <option value="">— pick —</option>
                  ${cals.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
                </select>
              </div>
              <div class="bx-field">
                <label for="bx-w-mfr">Manufacturer</label>
                <select id="bx-w-mfr"><option value="">—</option></select>
              </div>
            </div>
            <div class="bx-field">
              <label for="bx-w-load">Load</label>
              <select id="bx-w-load"><option value="">—</option></select>
              <div class="bx-field-hint" id="bx-w-load-hint"></div>
            </div>
          `}
        </div>
      `;
      // Tab switching
      body.querySelectorAll('.bx-tab').forEach(t => {
        t.addEventListener('click', () => {
          wizard.manual = (t.dataset.tab === 'manual');
          captureStep(); renderStep();
        });
      });
      // Cascading select for factory mode
      if (!wizard.manual) {
        const calSel = $('bx-w-cal');
        const mfrSel = $('bx-w-mfr');
        const loadSel = $('bx-w-load');
        const hint = $('bx-w-load-hint');
        const refreshMfrs = () => {
          const calId = calSel.value;
          const mfrs = getManufacturersForCalibre(state.db, calId);
          mfrSel.innerHTML = '<option value="">—</option>' +
            mfrs.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
          loadSel.innerHTML = '<option value="">—</option>';
          hint.textContent = '';
        };
        const refreshLoads = () => {
          const calId = calSel.value, mfrId = mfrSel.value;
          const loads = getLoadsFor(state.db, calId, mfrId);
          loadSel.innerHTML = '<option value="">—</option>' +
            loads.map(l => `<option value="${l.id}">${escapeHtml(l.weightGrains + 'gr ' + l.name)}</option>`).join('');
          hint.textContent = '';
        };
        // Build a hint string for a selected load, optionally including a
        // compliance flash for the species the user has chosen so far in
        // this wizard pass. Wizard step 3 is where species are picked, so
        // at step 2 we use the wizard's current species selection (or the
        // sensible default ['roe','red','fallow']).
        const buildHint = (ld) => {
          if (!(ld.bcG1 > 0 || ld.bcG7 > 0)) {
            return '⚠ No published ballistic coefficient — First Light can\'t compute a trajectory for this load. Pick another, or use Manual entry to type in a BC.';
          }
          const base = `${ld.muzzleVelocityFps} fps · BC ${ld.bcG7 > 0 ? 'G7 ' + ld.bcG7 : 'G1 ' + ld.bcG1} · ${ld.testBarrelInches}" test barrel`;
          // Quick compliance probe: build a synthetic profile from this
          // load + the wizard's other inputs, run checks against the
          // currently-selected species under the active jurisdiction.
          const probeProfile = {
            muzzleVelocityFps: ld.muzzleVelocityFps,
            weightGrains: ld.weightGrains,
            loadId: ld.id,
          };
          const failedChecks = [];
          for (const sp of (wizard.species || [])) {
            const r = checkLegalCompliance(probeProfile, state.settings.jurisdiction, sp);
            if (r.overall === 'fail') {
              const failures = r.checks.filter(c => c.status === 'fail');
              failures.forEach(f => failedChecks.push({ species: r.speciesLabel, label: f.label, detail: f.detail }));
            }
          }
          if (failedChecks.length === 0) return base;
          // Group failures by species for readable display
          const grouped = {};
          for (const f of failedChecks) {
            grouped[f.species] = grouped[f.species] || [];
            grouped[f.species].push(f.label.toLowerCase());
          }
          const summary = Object.entries(grouped)
            .map(([sp, labels]) => `${sp}: ${labels.join(', ')}`)
            .join(' · ');
          return base + `\n⚠ Below statutory minimum for — ${summary}`;
        };
        const setHint = (ld) => {
          if (!ld) { hint.textContent = ''; hint.classList.remove('bx-field-hint-warn'); return; }
          hint.textContent = buildHint(ld);
          // Add warning style when the hint contains a fail message
          if (hint.textContent.includes('⚠')) hint.classList.add('bx-field-hint-warn');
          else hint.classList.remove('bx-field-hint-warn');
        };
        calSel.addEventListener('change', refreshMfrs);
        mfrSel.addEventListener('change', refreshLoads);
        loadSel.addEventListener('change', () => {
          setHint(getLoadById(state.db, loadSel.value));
        });
        // Restore previous selection
        if (wizard.loadId) {
          const ld = getLoadById(state.db, wizard.loadId);
          if (ld) {
            calSel.value = ld.calibre; refreshMfrs();
            mfrSel.value = ld.manufacturer; refreshLoads();
            loadSel.value = ld.id;
            setHint(ld);
          }
        }
      }
    } else if (wizard.step === 3) {
      body.innerHTML = `
        <div class="bx-field">
          <label>What deer do you stalk? <span class="bx-field-hint-inline">(used for legal energy thresholds)</span></label>
          <div class="bx-species-grid">
            ${DEER_SPECIES.map(s => `
              <label class="bx-species-chip">
                <input type="checkbox" data-sp="${s.code}" ${wizard.species.includes(s.code) ? 'checked' : ''}>
                <span>${escapeHtml(s.label)}</span>
              </label>
            `).join('')}
          </div>
        </div>
      `;
    }

    $('bx-wizard-next').textContent = wizard.step === 3 ? 'Save' : 'Next';
  }

  function captureStep() {
    if (wizard.step === 1) {
      wizard.name = $('bx-w-name')?.value || '';
      const zSel = parseInt($('bx-w-zero')?.value, 10) || 100;
      wizard.zeroRangeM = bxImp() ? +yardsToMetres(zSel).toFixed(2) : zSel;
      const shRaw = parseFloat($('bx-w-sight')?.value);
      wizard.sightHeightCm = bxImp()
        ? (shRaw > 0 ? +inchesToCm(shRaw).toFixed(2) : 4.0)
        : (shRaw || 4.0);
      wizard.barrelInches = parseFloat($('bx-w-barrel')?.value) || 22;
    } else if (wizard.step === 2) {
      if (wizard.manual) {
        wizard.muzzleVelocityFps = parseFloat($('bx-w-mv')?.value) || 0;
        wizard.weightGrains = parseFloat($('bx-w-wt')?.value) || 0;
        wizard.bcG1 = parseFloat($('bx-w-bc1')?.value) || 0;
        wizard.bcG7 = parseFloat($('bx-w-bc7')?.value) || 0;
      } else {
        wizard.loadId = $('bx-w-load')?.value || null;
      }
    } else if (wizard.step === 3) {
      const checked = Array.from(document.querySelectorAll('[data-sp]:checked')).map(el => el.dataset.sp);
      wizard.species = checked.length ? checked : ['roe'];
    }
  }

  function next() {
    captureStep();
    if (wizard.step === 1 && !wizard.name.trim()) { toast('Give your rifle a name', 'warn'); return; }
    if (wizard.step === 2) {
      if (!wizard.manual && !wizard.loadId) { toast('Pick an ammunition load', 'warn'); return; }
      if (!wizard.manual && wizard.loadId) {
        const ld = getLoadById(state.db, wizard.loadId);
        if (ld && !(ld.bcG1 > 0 || ld.bcG7 > 0)) {
          toast('This load has no published BC — pick another or use Manual entry with a BC', 'warn');
          return;
        }
      }
      if (wizard.manual && (!wizard.muzzleVelocityFps || !wizard.weightGrains)) {
        toast('Enter muzzle velocity and bullet weight', 'warn'); return;
      }
      if (wizard.manual && !(wizard.bcG1 > 0 || wizard.bcG7 > 0)) {
        toast('Enter at least one ballistic coefficient', 'warn'); return;
      }
    }
    if (wizard.step < 3) { wizard.step++; renderStep(); return; }
    // Save
    const profile = wizard.manual
      ? makeManualProfile(wizard.name, {
          sightHeightCm: wizard.sightHeightCm, zeroRangeM: wizard.zeroRangeM,
          barrelInches: wizard.barrelInches,
          muzzleVelocityFps: wizard.muzzleVelocityFps, weightGrains: wizard.weightGrains,
          bcG1: wizard.bcG1, bcG7: wizard.bcG7, species: wizard.species })
      : makeProfileFromLoad(wizard.name, wizard.loadId, {
          sightHeightCm: wizard.sightHeightCm, zeroRangeM: wizard.zeroRangeM,
          barrelInches: wizard.barrelInches, species: wizard.species });
    if (!profile) { toast('Could not build profile', 'warn'); return; }
    state.profiles.push(profile);
    state.activeProfileId = profile.id;
    state.settings.speciesFilter = profile.species.slice();
    saveProfilesToStorage();
    saveSettingsToStorage();
    closeModal();
    renderAll();
    toast('Profile saved', 'ok');
  }
  $('bx-wizard-next').addEventListener('click', next);

  renderStep();
}

// ── Profile backup (export / import) ──────────────────────────────────────
// Profiles live only in this device's localStorage (STORAGE_KEY). With no
// login, an export file is the only insurance against clearing site data,
// PWA eviction, or moving to a new phone. Import is non-destructive (append).
function exportProfiles() {
  const data = {
    app: 'first-light-ballistics',
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: state.profiles,
  };
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'first-light-rifles-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const n = state.profiles.length;
    toast('Exported ' + n + ' rifle' + (n === 1 ? '' : 's'));
  } catch (e) {
    toast('Could not create the backup file', 'warn');
  }
}

function importProfilesFromText(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { toast('Import failed — not a valid backup file', 'warn'); return; }
  const list = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.profiles) ? parsed.profiles : null);
  if (!list || list.length === 0) { toast('No rifles found in that file', 'warn'); return; }
  let added = 0;
  for (const prof of list) {
    if (!prof || typeof prof !== 'object') continue;
    if (prof.muzzleVelocityFps == null && prof.loadId == null) continue;  // not a profile
    const copy = { ...prof, id: 'p' + Math.random().toString(36).slice(2, 10) };  // fresh id, non-destructive
    if (!copy.name) copy.name = 'Imported rifle';
    state.profiles.push(copy);
    if (!state.activeProfileId) state.activeProfileId = copy.id;
    added++;
  }
  if (added === 0) { toast('No valid rifles to import', 'warn'); return; }
  saveProfilesToStorage(); saveSettingsToStorage();
  closeModal(); renderProfileBar(); renderOutput();
  toast('Imported ' + added + ' rifle' + (added === 1 ? '' : 's'));
}

// ── Drop-based truing ─────────────────────────────────────────────────────
//
// The stalker shoots a group at a known distance; if the impact isn't where
// the calculator predicted, this modal back-solves the muzzle velocity that
// reproduces the OBSERVED drop (via lib/fl-ballistics.js trueMuzzleVelocity)
// and offers to save it to the rifle. From then on effectiveMvFps uses the
// trued MV, so every come-up, MPBR and retained-energy figure is corrected to
// the user's barrel rather than the manufacturer's test barrel. Stored fields
// (all backward-compatible, absent = untrued): truedMvFps, truedAtTempC (temp
// reference for the powder-temp correction), truedAtRangeM, truedObservedDropCm.
function openTruingModal(pid) {
  const p = state.profiles.find(x => x.id === pid) || getActiveProfile();
  if (!p) return;
  const modal = $('bx-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  const units = state.settings.units;
  const distUnit = units === 'imperial' ? 'yd' : 'm';
  const prefillDist = units === 'imperial' ? Math.round(metresToYards(state.rangeM)) : state.rangeM;
  const isTrued = Number.isFinite(p.truedMvFps) && p.truedMvFps > 0;

  // Format a signed drop (cm; + = below aim) as an up/down phrase, in the
  // active units voice.
  const fmtCm = (v) => (v < 0 ? 'up ' : 'down ')
    + (units === 'imperial' ? (Math.abs(v) / 2.54).toFixed(1) + ' in' : Math.abs(v).toFixed(1) + ' cm');

  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">True your drop</div>
      <div class="bx-modal-body">
        <div class="bx-field-hint">
          Shot a group at a known distance and it didn't land where the calculator predicted?
          Enter what you actually saw and First Light corrects this rifle's muzzle velocity so every
          come-up matches your barrel &mdash; not the manufacturer's test barrel. Use your longest
          confidently-measured distance beyond your zero for the best correction, in today's conditions.
          <br><br><strong>Shoot with your zero as-is &mdash; no come-up dialled, no hold-over &mdash; and
          measure from your aim point to the centre of the group.</strong> The calculator needs the
          bullet's total fall from your line of sight, not the leftover miss after a correction.
        </div>

        ${isTrued ? `
        <div class="bx-trued-current">
          Currently trued to <strong>${Math.round(p.truedMvFps)} fps</strong>
          (${p.truedMvFps - p.muzzleVelocityFps >= 0 ? '+' : ''}${Math.round(p.truedMvFps - p.muzzleVelocityFps)} fps vs published${p.truedAtRangeM ? `, from ${units === 'imperial' ? Math.round(metresToYards(p.truedAtRangeM)) + ' yd' : p.truedAtRangeM + ' m'}` : ''}).
        </div>` : ''}

        <div class="bx-row-2" style="margin-top:12px;">
          <div class="bx-field">
            <label for="bx-true-dist">Verified distance (${distUnit})</label>
            <input type="number" id="bx-true-dist" inputmode="numeric" value="${prefillDist}">
          </div>
          <div class="bx-field">
            <label for="bx-true-dir">It hit&hellip;</label>
            <select id="bx-true-dir">
              <option value="low">low (below aim)</option>
              <option value="high">high (above aim)</option>
            </select>
          </div>
        </div>
        <div class="bx-row-2">
          <div class="bx-field">
            <label for="bx-true-amount">By how much</label>
            <input type="number" id="bx-true-amount" step="0.1" min="0" inputmode="decimal" placeholder="e.g. 6">
          </div>
          <div class="bx-field">
            <label for="bx-true-unit">Measured in</label>
            <select id="bx-true-unit">
              <option value="cm" ${units === 'imperial' ? '' : 'selected'}>cm</option>
              <option value="in" ${units === 'imperial' ? 'selected' : ''}>inch</option>
              <option value="moa">MOA</option>
              <option value="mil">MIL / MRAD</option>
            </select>
          </div>
        </div>

        <div class="bx-field-actions" style="margin-top:6px;">
          <button class="bx-btn bx-btn-secondary" id="bx-true-calc" type="button">Calculate trued MV</button>
        </div>

        <div id="bx-true-result" class="bx-true-result" style="display:none;"></div>

        <div class="bx-field-hint" style="margin-top:12px;">
          Truing uses muzzle velocity as the correction lever &mdash; the most reliable one inside stalking
          range. It can't tell a true velocity error from a BC error, and it won't fix a bad zero: if your
          rifle also prints off at your zero distance, re-zero first, then true.
        </div>
      </div>
      <div class="bx-modal-actions">
        ${isTrued ? `<button class="bx-btn bx-btn-danger" id="bx-true-clear" type="button">Remove truing</button>` : ''}
        <button class="bx-btn bx-btn-secondary" id="bx-true-cancel" type="button">Cancel</button>
        <button class="bx-btn" id="bx-true-save" type="button" disabled>Save to rifle</button>
      </div>
    </div>
  `;

  let solved = null;

  const doCalc = () => {
    const resEl = $('bx-true-result');
    const warn = (msg) => {
      resEl.style.display = 'block';
      resEl.className = 'bx-true-result bx-true-warn';
      resEl.innerHTML = msg;
      $('bx-true-save').disabled = true;
      solved = null;
    };
    const distVal = parseFloat($('bx-true-dist').value);
    const amount = parseFloat($('bx-true-amount').value);
    const dir = $('bx-true-dir').value;
    const unit = $('bx-true-unit').value;
    if (!(distVal > 0) || !Number.isFinite(amount) || amount < 0) {
      warn('Enter a distance and how far off it hit.'); return;
    }
    const rangeM = units === 'imperial' ? yardsToMetres(distVal) : distVal;
    if (!(rangeM > p.zeroRangeM)) {
      warn(`True beyond your zero range (${units === 'imperial' ? Math.round(metresToYards(p.zeroRangeM)) + ' yd' : p.zeroRangeM + ' m'}) &mdash; drop is too small to correct at or inside the zero.`); return;
    }
    // Convert the observed miss to cm at that range (cmToMoa/cmToMil are linear,
    // so the per-unit size is their value at 1 cm).
    let cm;
    if (unit === 'in') cm = inchesToCm(amount);
    else if (unit === 'moa') cm = amount / cmToMoa(1, rangeM);
    else if (unit === 'mil') cm = amount / cmToMil(1, rangeM);
    else cm = amount;
    const observedDropCm = (dir === 'high') ? -cm : cm; // + = below aim
    const c = state.conditions;
    const out = trueMuzzleVelocity({
      muzzleVelocityMs: fpsToMs(effectiveMvFps(p)),
      bcG1: p.bcG1, bcG7: p.bcG7,
      bulletMassKg: grainsToKg(p.weightGrains),
      sightHeightCm: p.sightHeightCm,
      zeroRangeM: p.zeroRangeM,
      tempC: c.tempC, pressureHpa: c.pressureHpa, humidityPct: c.humidityPct,
    }, observedDropCm, rangeM);
    if (!out) {
      warn(`Couldn't match that to a velocity. Enter the TOTAL fall from a dead-on aim &mdash; if you dialled or held for this distance, add that correction back on. Very large misses usually mean a zero error or the wrong load on record instead.`); return;
    }
    const truedFps = Math.round(msToFps(out.truedMvMs));
    const deltaFps = truedFps - Math.round(p.muzzleVelocityFps);
    // Physically impossible corrections are refused outright: no real barrel
    // sits 300+ fps off catalogue. The ±100–300 band below stays savable
    // behind the soft warning; beyond it a saved number would silently
    // corrupt every come-up.
    if (Math.abs(deltaFps) > 300) {
      warn(`Solved to ${truedFps} fps &mdash; ${deltaFps >= 0 ? '+' : ''}${deltaFps} fps against the published ${Math.round(p.muzzleVelocityFps)}. No barrel is that far from catalogue: this is almost always a zero error, the wrong distance, a dialled or held shot entered as the miss, or the wrong load on record. Fix that first &mdash; nothing saved.`);
      return;
    }
    const predCm = out.predictedDropCm;
    solved = {
      truedMvFps: truedFps,
      truedAtTempC: Number.isFinite(c.tempC) ? c.tempC : null,
      truedAtRangeM: Math.round(rangeM),
      observedDropCm,
    };
    // A very large MV correction is physically suspect: MV rarely differs from
    // catalogue by more than ~50–80 fps, so a bigger swing usually means a zero
    // error, wind, or the wrong BC/load on record — not velocity. Flag it so the
    // user sanity-checks before trusting (and before saving) the number.
    const big = Math.abs(deltaFps) > 100;
    resEl.style.display = 'block';
    resEl.className = 'bx-true-result ' + (big ? 'bx-true-warn' : 'bx-true-ok');
    resEl.innerHTML = `
      <div class="bx-true-mv">Trued muzzle velocity: <strong>${truedFps} fps</strong>
        <span class="bx-true-delta">(${deltaFps >= 0 ? '+' : ''}${deltaFps} fps vs published ${Math.round(p.muzzleVelocityFps)})</span></div>
      <div class="bx-true-detail">
        At ${units === 'imperial' ? Math.round(metresToYards(solved.truedAtRangeM)) + ' yd' : solved.truedAtRangeM + ' m'} your rifle hit ${fmtCm(observedDropCm)}; the current data predicted ${predCm != null ? fmtCm(predCm) : '&mdash;'}.
        Saving corrects every come-up, dead-hold range and retained-energy figure to match your rifle.
        ${big ? `<br><strong>That's a large correction (${deltaFps >= 0 ? '+' : ''}${deltaFps} fps).</strong> A miss this size at ${units === 'imperial' ? Math.round(metresToYards(solved.truedAtRangeM)) + ' yd' : solved.truedAtRangeM + ' m'} more often comes from a zero error, wind, or the wrong load on record than from velocity — double-check your zero and load before saving.` : ''}
      </div>
    `;
    $('bx-true-save').disabled = false;
  };

  $('bx-true-calc').addEventListener('click', doCalc);
  $('bx-true-cancel').addEventListener('click', closeModal);
  $('bx-true-save').addEventListener('click', () => {
    if (!solved) return;
    p.truedMvFps = solved.truedMvFps;
    p.truedAtTempC = solved.truedAtTempC;
    p.truedAtRangeM = solved.truedAtRangeM;
    p.truedObservedDropCm = solved.observedDropCm;
    saveProfilesToStorage();
    closeModal();
    renderAll();
    toast('Come-ups trued to your rifle', 'ok');
  });
  if (isTrued) {
    $('bx-true-clear').addEventListener('click', () => {
      p.truedMvFps = null;
      p.truedAtTempC = null;
      p.truedAtRangeM = null;
      p.truedObservedDropCm = null;
      saveProfilesToStorage();
      closeModal();
      renderAll();
      toast('Truing removed', 'ok');
    });
  }
}

// Reticle configuration for the holdover picture: which reticle, and the focal
// plane (+ calibrated magnification for SFP scopes, where subtensions are only
// true at one mag). Stored per-rifle (the scope belongs to the rifle).
function openReticleModal(pid) {
  const p = state.profiles.find(x => x.id === pid) || getActiveProfile();
  if (!p) return;
  const modal = $('bx-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  const retId = RETICLES[p.reticleId] ? p.reticleId : DEFAULT_RETICLE;
  const focal = p.reticleFocalPlane === 'sfp' ? 'sfp' : 'ffp';
  const retOpts = Object.values(RETICLES).map(r =>
    `<option value="${r.id}" ${r.id === retId ? 'selected' : ''}>${escapeHtml(r.label)} (${r.unitLabel})</option>`
  ).join('');
  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">Reticle</div>
      <div class="bx-modal-body">
        <div class="bx-field">
          <label for="bx-ret-id">Reticle</label>
          <select id="bx-ret-id">${retOpts}</select>
          <div class="bx-field-hint">More reticles coming; mil-dot is the first. The picture marks where to hold for the current range's come-up and wind.</div>
        </div>
        <div class="bx-field">
          <label for="bx-ret-focal">Focal plane</label>
          <select id="bx-ret-focal">
            <option value="ffp" ${focal === 'ffp' ? 'selected' : ''}>First focal plane (FFP)</option>
            <option value="sfp" ${focal === 'sfp' ? 'selected' : ''}>Second focal plane (SFP)</option>
          </select>
          <div class="bx-field-hint">FFP subtensions hold at any magnification; SFP only at one calibrated mag.</div>
        </div>
        <div class="bx-field" id="bx-ret-mag-field" style="${focal === 'sfp' ? '' : 'display:none;'}">
          <label for="bx-ret-mag">Calibrated magnification (×)</label>
          <input type="number" id="bx-ret-mag" step="1" min="1" max="40" inputmode="numeric" placeholder="e.g. 12" value="${p.reticleCalibratedMagX || ''}">
          <div class="bx-field-hint">The magnification at which your reticle's mil/MOA subtensions are correct (often max mag).</div>
        </div>
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-secondary" id="bx-ret-cancel" type="button">Cancel</button>
        <button class="bx-btn" id="bx-ret-save" type="button">Save</button>
      </div>
    </div>
  `;
  const focalSel = $('bx-ret-focal');
  focalSel.addEventListener('change', () => {
    $('bx-ret-mag-field').style.display = focalSel.value === 'sfp' ? '' : 'none';
  });
  $('bx-ret-cancel').addEventListener('click', closeModal);
  $('bx-ret-save').addEventListener('click', () => {
    p.reticleId = RETICLES[$('bx-ret-id').value] ? $('bx-ret-id').value : DEFAULT_RETICLE;
    p.reticleFocalPlane = focalSel.value === 'sfp' ? 'sfp' : 'ffp';
    const mag = parseInt($('bx-ret-mag').value, 10);
    p.reticleCalibratedMagX = (p.reticleFocalPlane === 'sfp' && mag > 0) ? mag : null;
    saveProfilesToStorage();
    closeModal();
    renderOutput();
    toast('Reticle saved', 'ok');
  });
}

// Bullet diameter (inches) for a profile, from its factory load's calibre.
// Manual profiles have no calibre on record, so the stability modal asks the
// user to enter the diameter in that case.
function profileDiameterIn(p) {
  if (!p || !p.loadId) return null;
  const load = getLoadById(state.db, p.loadId);
  return load ? (CALIBRE_DIAMETER_INCHES[load.calibre] || null) : null;
}

// ── Gyroscopic stability (twist rate) ─────────────────────────────────────
//
// Computes the Miller stability factor (SG) from the rifle's barrel twist and
// the load's weight/diameter/velocity, in the current conditions. The headline
// use is the lead-free transition: heavy copper monolithics are LONGER than
// lead of the same weight and need faster twist, so a barrel that stabilised
// lead may not stabilise its copper replacement. Twist + bullet length persist
// on the profile (twistRateIn, bulletLengthIn, bulletMonolithic).
function openStabilityModal(pid) {
  const p = state.profiles.find(x => x.id === pid) || getActiveProfile();
  if (!p) return;
  const modal = $('bx-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  const dia = profileDiameterIn(p);
  const monoDefault = p.bulletMonolithic === true;

  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">Stability check</div>
      <div class="bx-modal-body">
        <div class="bx-field-hint">
          Is your barrel's twist fast enough for this bullet? Enter your twist rate; First Light computes the
          Miller gyroscopic stability factor (SG) for ${p.weightGrains} gr at ${Math.round(effectiveMvFps(p))} fps
          in today's conditions. Most relevant for heavy <strong>lead-free</strong> loads — copper bullets are
          longer than lead of the same weight and need more twist.
        </div>
        <div class="bx-row-2" style="margin-top:12px;">
          <div class="bx-field">
            <label for="bx-stab-twist">Barrel twist — 1 turn in (in)</label>
            <input type="number" id="bx-stab-twist" step="0.25" min="5" max="20" inputmode="decimal" placeholder="e.g. 11" value="${p.twistRateIn || ''}">
          </div>
          <div class="bx-field">
            <label for="bx-stab-dia">Bullet diameter (in)</label>
            <input type="number" id="bx-stab-dia" step="0.001" min="0.1" max="0.5" inputmode="decimal" placeholder="e.g. 0.308" value="${dia || p.bulletDiameterIn || ''}">
          </div>
        </div>
        <div class="bx-field">
          <label for="bx-stab-len">Bullet length (in) — optional</label>
          <input type="number" id="bx-stab-len" step="0.01" min="0.3" max="2.5" inputmode="decimal" placeholder="leave blank to estimate" value="${p.bulletLengthIn || ''}">
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.8);margin-top:8px;cursor:pointer;">
            <input type="checkbox" id="bx-stab-mono" ${monoDefault ? 'checked' : ''}> Lead-free (solid copper/brass) bullet
          </label>
          <div class="bx-field-hint">If you leave length blank, it's estimated from weight, diameter and construction — enter the manufacturer's length for an accurate SG.</div>
        </div>
        <div class="bx-field-actions" style="margin-top:6px;">
          <button class="bx-btn bx-btn-secondary" id="bx-stab-calc" type="button">Calculate SG</button>
        </div>
        <div id="bx-stab-result" class="bx-stab-result" style="display:none;"></div>
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-secondary" id="bx-stab-cancel" type="button">Close</button>
        <button class="bx-btn" id="bx-stab-save" type="button" disabled>Save to rifle</button>
      </div>
    </div>
  `;

  let solved = null;

  const doCalc = () => {
    const resEl = $('bx-stab-result');
    const warn = (msg) => {
      resEl.style.display = 'block';
      resEl.className = 'bx-stab-result bx-stab-warn';
      resEl.innerHTML = msg;
      $('bx-stab-save').disabled = true;
      solved = null;
    };
    const twist = parseFloat($('bx-stab-twist').value);
    const diameter = parseFloat($('bx-stab-dia').value);
    const mono = $('bx-stab-mono').checked;
    let lengthIn = parseFloat($('bx-stab-len').value);
    if (!(twist >= 5 && twist <= 20)) { warn('Enter a twist rate (1 turn in 5–20 inches).'); return; }
    if (!(diameter > 0.1 && diameter < 0.5)) { warn('Enter the bullet diameter in inches (e.g. 0.308).'); return; }
    let lengthEstimated = false;
    if (!(lengthIn > 0)) {
      lengthIn = estimateBulletLengthIn(p.weightGrains, diameter, mono);
      lengthEstimated = true;
      if (!(lengthIn > 0)) { warn('Could not estimate bullet length — enter it manually.'); return; }
    }
    const res = gyroscopicStability({
      twistRateIn: twist,
      bulletMassGr: p.weightGrains,
      diameterIn: diameter,
      bulletLengthIn: lengthIn,
      muzzleVelocityFps: effectiveMvFps(p),
      tempC: state.conditions.tempC,
      pressureHpa: state.conditions.pressureHpa,
    });
    if (!res) { warn('Could not compute SG — check the inputs.'); return; }
    solved = { twistRateIn: twist, bulletDiameterIn: diameter, bulletLengthIn: lengthEstimated ? null : lengthIn, bulletMonolithic: mono };
    const cls = res.verdict === 'stable' ? 'bx-stab-ok' : (res.verdict === 'marginal' ? 'bx-stab-marginal' : 'bx-stab-danger');
    const verdictText = res.verdict === 'stable'
      ? 'Stable — this bullet will fly true from this barrel.'
      : (res.verdict === 'marginal'
        ? 'Marginal — it may not fully stabilise; accuracy and BC can suffer, worse in cold, dense air. Test on paper before trusting it.'
        : 'Unstable — this barrel will not stabilise this bullet (expect keyholing). Choose a lighter/shorter bullet or a faster twist.');
    resEl.style.display = 'block';
    resEl.className = 'bx-stab-result ' + cls;
    resEl.innerHTML = `
      <div class="bx-stab-sg">SG <strong>${res.sg.toFixed(2)}</strong> <span class="bx-stab-verdict">${res.verdict}</span></div>
      <div class="bx-stab-detail">${verdictText}</div>
      <div class="bx-stab-detail bx-stab-sub">${lengthEstimated ? `Bullet length estimated at ${lengthIn.toFixed(2)} in (${mono ? 'copper' : 'lead'}). ` : `Length ${lengthIn.toFixed(2)} in. `}SG ≥ 1.5 stable · 1.0–1.5 marginal · &lt; 1.0 unstable.</div>
    `;
    $('bx-stab-save').disabled = false;
  };

  $('bx-stab-calc').addEventListener('click', doCalc);
  $('bx-stab-cancel').addEventListener('click', closeModal);
  $('bx-stab-save').addEventListener('click', () => {
    if (!solved) return;
    p.twistRateIn = solved.twistRateIn;
    p.bulletDiameterIn = solved.bulletDiameterIn;
    p.bulletLengthIn = solved.bulletLengthIn;
    p.bulletMonolithic = solved.bulletMonolithic;
    saveProfilesToStorage();
    toast('Twist saved to rifle', 'ok');
    closeModal();
  });
}

function openBackupModal() {
  const modal = $('bx-modal');
  modal.style.display = 'flex';
  const n = state.profiles.length;
  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">Back up rifles</div>
      <div class="bx-modal-body">
        <div class="bx-field-hint">
          Your rifle profiles are stored only on this device. Export a backup to keep
          them safe or move them to a new phone &mdash; clearing site data or
          reinstalling will otherwise lose them.
        </div>
        <div class="bx-field bx-field-actions" style="margin-top:14px;">
          <button class="bx-btn" id="bx-backup-export">Export ${n} rifle${n === 1 ? '' : 's'}</button>
        </div>
        <div class="bx-field" style="margin-top:12px;">
          <label for="bx-backup-file">Import from a backup file</label>
          <input type="file" id="bx-backup-file" accept="application/json,.json">
          <div class="bx-field-hint">Imported rifles are added to your list &mdash; nothing is overwritten.</div>
        </div>
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-secondary" id="bx-backup-close">Close</button>
      </div>
    </div>
  `;
  $('bx-backup-close').addEventListener('click', closeModal);
  $('bx-backup-export').addEventListener('click', exportProfiles);
  $('bx-backup-file').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => importProfilesFromText(String(reader.result || ''));
    reader.onerror = () => toast('Could not read that file', 'warn');
    reader.readAsText(file);
  });
}

function openProfileSwitcher() {
  const modal = $('bx-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">Switch profile</div>
      <div class="bx-modal-body">
        ${state.profiles.map(p => `
          <button class="bx-profile-row ${p.id === state.activeProfileId ? 'on' : ''}" data-pid="${p.id}">
            <div class="bx-profile-row-name">${escapeHtml(p.name)}</div>
            <div class="bx-profile-row-summary">${escapeHtml(p.loadId ? loadDisplayName(state.db, p.loadId) : (p.muzzleVelocityFps + ' fps · ' + p.weightGrains + 'gr'))}</div>
          </button>
        `).join('')}
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-secondary" id="bx-switch-cancel">Cancel</button>
      </div>
    </div>
  `;
  modal.querySelectorAll('[data-pid]').forEach(b => {
    b.addEventListener('click', () => {
      state.activeProfileId = b.dataset.pid;
      const p = getActiveProfile();
      if (p) state.settings.speciesFilter = p.species.slice();
      saveSettingsToStorage();
      closeModal();
      renderAll();
    });
  });
  $('bx-switch-cancel').addEventListener('click', closeModal);
}

/**
 * Modal for the "Find lead-free alternative" feature. Surfaces the closest
 * lead-free factory loads to the user's current lead load in the same
 * calibre. Designed to support the 2029 UK REACH lead-ammunition transition.
 *
 * The button only appears in renderProfileBar when the active profile's
 * load has leadFree === false. This function is defensive too — it handles
 * already-lead-free, no-alternatives, and invalid-source cases gracefully
 * even though they shouldn't be reachable from the UI.
 */
function openLeadFreeMatcher() {
  const modal = $('bx-modal');
  if (!modal) return;
  const p = getActiveProfile();
  if (!p || !p.loadId) return;
  const sourceLoad = getLoadById(state.db, p.loadId);
  if (!sourceLoad) return;

  const result = findLeadFreeAlternatives(state.db, sourceLoad);
  modal.style.display = 'flex';

  // Header always shows the source load for context.
  const header = `
    <div class="bx-modal-title">Lead-free alternatives</div>
    <div class="bx-modal-body">
      <div class="bx-lf-source">
        <div class="bx-lf-source-label">Your current load</div>
        <div class="bx-lf-source-name">${escapeHtml(loadDisplayName(state.db, sourceLoad.id))}</div>
        <div class="bx-lf-source-meta">
          ${sourceLoad.weightGrains}gr ·
          ${sourceLoad.muzzleVelocityFps} fps ·
          BC ${sourceLoad.bcG7 > 0 ? 'G7 ' + sourceLoad.bcG7 : 'G1 ' + sourceLoad.bcG1}
        </div>
      </div>
  `;

  let body = '';
  if (result.reason === 'already-lead-free') {
    body = `<p class="bx-lf-msg">Your current load is already lead-free. No alternatives needed.</p>`;
  } else if (result.reason === 'invalid-source') {
    body = `<p class="bx-lf-msg">Your current load is missing the ballistic data needed to compare alternatives.</p>`;
  } else if (result.reason === 'no-alternatives') {
    const calibreName = getCalibreById(state.db, sourceLoad.calibre)?.name || sourceLoad.calibre;
    body = `
      <p class="bx-lf-msg"><strong>No lead-free factory loads in our database for ${escapeHtml(calibreName)}.</strong></p>
      <p class="bx-lf-msg">If the 2029 lead restriction will apply to where you stalk, you may need to consider switching to a different calibre. Calibres with the most lead-free options in our database are .308 Win, 6.5 Creedmoor, .30-06, .243 Win, and 6.5×55.</p>
    `;
  } else if (result.reason === 'no-weight-match') {
    const calibreName = getCalibreById(state.db, sourceLoad.calibre)?.name || sourceLoad.calibre;
    body = `
      <p class="bx-lf-msg"><strong>No like-for-like lead-free options for your ${sourceLoad.weightGrains}gr load in ${escapeHtml(calibreName)}.</strong></p>
      <p class="bx-lf-msg">Lead-free loads do exist in this calibre, but only at substantially different bullet weights. We deliberately don't suggest them as alternatives — terminal performance, recoil and twist-rate requirements diverge too far for a credible swap.</p>
      <p class="bx-lf-msg">Talk to your dealer about heavier-for-calibre copper monolithics, or consider switching to a calibre with better deer-weight lead-free coverage (.308 Win, 6.5 Creedmoor, .30-06, .243 Win, 6.5×55).</p>
    `;
  } else {
    // ok — render the matches
    const ranges = result.sourceTrajectory.map(r => r.rangeM);
    const headerCells = ranges.map(r => `<th scope="col">${r}m</th>`).join('');
    const sourceDropRow = result.sourceTrajectory.map(r => `<td>${fmtCm1(r.dropCm)} cm</td>`).join('');
    const sourceEnergyRow = result.sourceTrajectory.map(r => `<td>${Math.round(r.energyFtLbs)} ft·lb</td>`).join('');

    body = `
      <table class="bx-lf-table bx-lf-source-table">
        <caption class="bx-visually-hidden">Your current load: drop and energy by range, at a 100 metre comparison zero.</caption>
        <thead><tr><th></th>${headerCells}</tr></thead>
        <tbody>
          <tr><th scope="row">Drop (100m zero)</th>${sourceDropRow}</tr>
          <tr><th scope="row">Energy</th>${sourceEnergyRow}</tr>
        </tbody>
      </table>
      <div class="bx-field-hint bx-lf-signnote">Drop in these tables is centimetres of fall below the aim line &mdash; a bigger number means a lower impact. (The range card shows the same fall as a negative number.)</div>
      <div class="bx-lf-matches-label">Closest lead-free options</div>
    `;

    for (const m of result.matches) {
      const candDropRow = m.trajectory.map(r => `<td>${fmtCm1(r.dropCm)} cm</td>`).join('');
      const candEnergyRow = m.trajectory.map(r => `<td>${Math.round(r.energyFtLbs)} ft·lb</td>`).join('');
      const deltaDropRow = m.deltas.map(d => {
        const sign = d.dropDeltaCm > 0 ? '+' : '';
        const cls = Math.abs(d.dropDeltaCm) < 2 ? 'bx-lf-good' : (Math.abs(d.dropDeltaCm) < 6 ? 'bx-lf-mid' : 'bx-lf-poor');
        return `<td class="${cls}">${sign}${fmtCm1(d.dropDeltaCm)} cm</td>`;
      }).join('');
      const deltaEnergyRow = m.deltas.map(d => {
        const sign = d.energyDeltaPct > 0 ? '+' : '';
        const cls = Math.abs(d.energyDeltaPct) < 5 ? 'bx-lf-good' : (Math.abs(d.energyDeltaPct) < 12 ? 'bx-lf-mid' : 'bx-lf-poor');
        return `<td class="${cls}">${sign}${fmtCm1(d.energyDeltaPct)}%</td>`;
      }).join('');

      body += `
        <div class="bx-lf-match">
          <div class="bx-lf-match-header">
            <div class="bx-lf-match-name">${escapeHtml(loadDisplayName(state.db, m.load.id))}</div>
            <div class="bx-lf-match-meta">
              ${m.load.weightGrains}gr ·
              ${m.load.muzzleVelocityFps} fps ·
              BC ${m.load.bcG7 > 0 ? 'G7 ' + m.load.bcG7 : 'G1 ' + m.load.bcG1} ·
              ${escapeHtml(m.load.construction || 'monolithic-copper')}
            </div>
          </div>
          <table class="bx-lf-table">
            <caption class="bx-visually-hidden">${escapeHtml(loadDisplayName(state.db, m.load.id))}: drop, energy and the difference against your current load, by range.</caption>
            <thead><tr><th></th>${headerCells}</tr></thead>
            <tbody>
              <tr><th scope="row">Drop</th>${candDropRow}</tr>
              <tr><th scope="row">Energy</th>${candEnergyRow}</tr>
              <tr><th scope="row">Δ drop</th>${deltaDropRow}</tr>
              <tr><th scope="row">Δ energy</th>${deltaEnergyRow}</tr>
            </tbody>
          </table>
        </div>
      `;
    }

    body += `
      <div class="bx-lf-disclosure">
        <strong>This is a trajectory match, not a terminal-performance match.</strong>
        Copper bullets typically need higher impact velocities to expand reliably and
        often penetrate deeper than lead. Even a load with identical drop and energy
        on paper will likely shoot to a different point of impact —
        <strong>you must re-zero with the new load before stalking.</strong>
        Verify the load meets the legal energy and calibre requirements for your
        jurisdiction and species.
        <br><br>
        <span style="opacity:0.75">Drops and energies above are computed at ICAO standard atmosphere (15&nbsp;°C, 1013&nbsp;hPa, sea level) and a 100&nbsp;m comparison zero, so candidates are scored on equal terms. Your real-world drops will differ.</span>
      </div>
    `;
  }

  modal.innerHTML = `
    <div class="bx-modal-card bx-modal-wide">
      ${header}
      ${body}
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-secondary" id="bx-lf-close">Close</button>
      </div>
    </div>
  `;
  $('bx-lf-close').addEventListener('click', closeModal);
}

// ── Load comparator (side-by-side) ──────────────────────────────────────
//
// Shows the active profile vs a chosen factory load at fixed sample ranges,
// using the user's CURRENT atmospheric conditions and CURRENT zero range.
// This differs from the lead-free matcher (which uses a 100m comparison
// zero and ICAO atmosphere) — here the stalker is asking "what would my
// shot look like with this other load on the day I'm shooting" and the
// answer should reflect their actual day's setup.
//
// The lead-free matcher is "would this work as a switch" (terminal-data
// neutral). The comparator is "let me see this load against my current
// load right now" (terminal-data inclusive — uses actual conditions).
//
// Limitations honestly disclosed in the modal:
//   * The "candidate" load is solved as if mounted in the user's rifle
//     (same scope, same sight height, same zero range as the active
//     profile) — i.e. we're comparing trajectories of two ammunition
//     choices through one rifle setup, not two different rifles.
//   * Energy values are at the muzzle's MV from the database (no chrono).
//   * Zero is the active profile's zero range, NOT the candidate's recommended.
const COMPARE_RANGES_M = Object.freeze([100, 200, 300, 400, 500]);

function solveLoadAt(load, rangeM, refProfile) {
  // Solve the candidate `load` at `rangeM` using current conditions and
  // the reference profile's sight height + zero. Returns null if any
  // required field is missing.
  if (!load || !load.muzzleVelocityFps || !load.weightGrains) return null;
  if (!load.bcG1 && !load.bcG7) return null;
  try {
    return solveShot({
      muzzleVelocityMs: fpsToMs(load.muzzleVelocityFps),
      bcG1: load.bcG1 || null,
      bcG7: load.bcG7 || null,
      bulletMassKg: grainsToKg(load.weightGrains),
      sightHeightCm: refProfile.sightHeightCm,
      zeroRangeM: refProfile.zeroRangeM,
      tempC: state.conditions.tempC,
      pressureHpa: state.conditions.pressureHpa,
      humidityPct: state.conditions.humidityPct,
      targetRangeM: rangeM,
      windMs: effectiveCrosswindMs(state.conditions.windMps, state.conditions.windDirDeg),
      shotAngleDeg: state.conditions.shotAngleDeg,
    });
  } catch (e) {
    console.error('[ballistics] solveLoadAt failed:', e.message);
    return null;
  }
}

function solveProfileAt(profile, rangeM) {
  try {
    return solveShot({
      muzzleVelocityMs: fpsToMs(effectiveMvFps(profile)),
      bcG1: profile.bcG1, bcG7: profile.bcG7,
      bulletMassKg: grainsToKg(profile.weightGrains),
      sightHeightCm: profile.sightHeightCm,
      zeroRangeM: profile.zeroRangeM,
      tempC: state.conditions.tempC,
      pressureHpa: state.conditions.pressureHpa,
      humidityPct: state.conditions.humidityPct,
      targetRangeM: rangeM,
      windMs: effectiveCrosswindMs(state.conditions.windMps, state.conditions.windDirDeg),
      shotAngleDeg: state.conditions.shotAngleDeg,
    });
  } catch (e) {
    console.error('[ballistics] solveProfileAt failed:', e.message);
    return null;
  }
}

/**
 * Side-by-side comparator. Lets the user pick any factory load from the
 * database and see drop / energy / wind drift / velocity for both loads
 * at 100/200/300/400/500m using current atmospheric conditions.
 */
function openLoadComparator() {
  const profile = getActiveProfile();
  if (!profile) {
    toast('No active profile to compare against', 'warn');
    return;
  }

  // State for the modal — outlives renders so the user can change the
  // selection and the table re-renders without losing the picker state.
  const ui = {
    calibreId: '',
    manufacturerId: '',
    candidateId: '',
  };

  // Pre-select the active profile's calibre if its loadId resolves.
  if (profile.loadId) {
    const ld = getLoadById(state.db, profile.loadId);
    if (ld) ui.calibreId = ld.calibre;
  }

  const modal = $('bx-modal');
  modal.style.display = 'flex';

  function render() {
    const cals = getCalibresWithLoads(state.db);
    const mfrs = ui.calibreId ? getManufacturersForCalibre(state.db, ui.calibreId) : [];
    const loads = (ui.calibreId && ui.manufacturerId)
      ? getLoadsFor(state.db, ui.calibreId, ui.manufacturerId)
      : [];
    const candidate = ui.candidateId ? getLoadById(state.db, ui.candidateId) : null;

    let tableHtml = '';
    if (candidate) {
      const headerCells = COMPARE_RANGES_M.map(r => `<th scope="col">${r}m</th>`).join('');

      const rowDrop = (label, solver) => {
        const cells = COMPARE_RANGES_M.map(r => {
          const s = solver(r);
          if (!s) return '<td>—</td>';
          // Solver: positive dropCm = below LoS. Display: invert sign so
          // the table reads as scope-dial / dope-card convention
          // (positive = dial up). Same convention as the on-screen Hold widget.
          const cm = -s.dropCm;
          const sign = cm >= 0 ? '+' : '';
          return `<td>${sign}${cm.toFixed(1)} cm</td>`;
        }).join('');
        return `<tr><th scope="row">${label}</th>${cells}</tr>`;
      };

      const rowEnergy = (label, solver) => {
        const cells = COMPARE_RANGES_M.map(r => {
          const s = solver(r);
          if (!s) return '<td>—</td>';
          return `<td>${Math.round(s.energyFtLbs)} ft·lb</td>`;
        }).join('');
        return `<tr><th scope="row">${label}</th>${cells}</tr>`;
      };

      const rowVel = (label, solver) => {
        const cells = COMPARE_RANGES_M.map(r => {
          const s = solver(r);
          if (!s) return '<td>—</td>';
          return `<td>${Math.round(s.velocityFps)} fps</td>`;
        }).join('');
        return `<tr><th scope="row">${label}</th>${cells}</tr>`;
      };

      const rowWind = (label, solver) => {
        const cells = COMPARE_RANGES_M.map(r => {
          const s = solver(r);
          if (!s) return '<td>—</td>';
          // Magnitude + drift direction (R/L), matching the HOLD + range cards.
          const dir = s.windDriftCm > 0.5 ? ' R' : (s.windDriftCm < -0.5 ? ' L' : '');
          return `<td>${Math.abs(s.windDriftCm).toFixed(1)} cm${dir}</td>`;
        }).join('');
        return `<tr><th scope="row">${label}</th>${cells}</tr>`;
      };

      const rowDelta = (label, solver1, solver2, fmt, unit) => {
        const cells = COMPARE_RANGES_M.map(r => {
          const a = solver1(r), b = solver2(r);
          if (!a || !b) return '<td>—</td>';
          const delta = fmt(a, b);
          const sign = delta > 0 ? '+' : '';
          return `<td>${sign}${delta.toFixed(1)} ${unit}</td>`;
        }).join('');
        return `<tr class="bx-cmp-delta"><th scope="row">${label}</th>${cells}</tr>`;
      };

      const profSolver = (r) => solveProfileAt(profile, r);
      const candSolver = (r) => solveLoadAt(candidate, r, profile);

      // Honesty check: if the candidate solver returns null, surface it
      // before showing the table.
      const candTest = candSolver(100);
      if (!candTest) {
        tableHtml = `<p class="bx-lf-msg">This load is missing the BC or muzzle velocity data needed to solve a trajectory.</p>`;
      } else {
        const showWind = state.conditions.windMps > 0;
        tableHtml = `
          <div class="bx-cmp-loads">
            <div class="bx-cmp-load bx-cmp-load-a">
              <div class="bx-cmp-label">Your load</div>
              <div class="bx-cmp-name">${escapeHtml(profile.name)}</div>
              <div class="bx-cmp-meta">${profile.muzzleVelocityFps} fps · ${profile.weightGrains}gr · BC ${profile.bcG7 > 0 ? 'G7 ' + profile.bcG7 : 'G1 ' + profile.bcG1}</div>
            </div>
            <div class="bx-cmp-load bx-cmp-load-b">
              <div class="bx-cmp-label">Candidate</div>
              <div class="bx-cmp-name">${escapeHtml(loadDisplayName(state.db, candidate.id))}</div>
              <div class="bx-cmp-meta">${candidate.muzzleVelocityFps} fps · ${candidate.weightGrains}gr · BC ${candidate.bcG7 > 0 ? 'G7 ' + candidate.bcG7 : 'G1 ' + candidate.bcG1}${candidate.leadFree === true ? ' · lead-free' : ''}</div>
            </div>
          </div>
          <table class="bx-cmp-table">
            <caption class="bx-visually-hidden">Your load against the candidate load: drop, energy, velocity and wind drift at 100 to 500 metres.</caption>
            <thead><tr><th></th>${headerCells}</tr></thead>
            <tbody>
              <tr class="bx-cmp-section"><th scope="colgroup" colspan="${COMPARE_RANGES_M.length + 1}">Drop — negative = below zero (dial up)</th></tr>
              ${rowDrop('Your load', profSolver)}
              ${rowDrop('Candidate', candSolver)}
              ${rowDelta('Δ', profSolver, candSolver, (a, b) => -b.dropCm - (-a.dropCm), 'cm')}
              <tr class="bx-cmp-section"><th scope="colgroup" colspan="${COMPARE_RANGES_M.length + 1}">Energy</th></tr>
              ${rowEnergy('Your load', profSolver)}
              ${rowEnergy('Candidate', candSolver)}
              ${rowDelta('Δ', profSolver, candSolver, (a, b) => b.energyFtLbs - a.energyFtLbs, 'ft·lb')}
              <tr class="bx-cmp-section"><th scope="colgroup" colspan="${COMPARE_RANGES_M.length + 1}">Velocity</th></tr>
              ${rowVel('Your load', profSolver)}
              ${rowVel('Candidate', candSolver)}
              ${showWind ? `
                <tr class="bx-cmp-section"><th scope="colgroup" colspan="${COMPARE_RANGES_M.length + 1}">${describeWind(state.conditions.windMps, state.conditions.windDirDeg).short}</th></tr>
                ${rowWind('Your load', profSolver)}
                ${rowWind('Candidate', candSolver)}
              ` : ''}
            </tbody>
          </table>
          <div class="bx-cmp-disclosure">
            Solved at your current conditions (${state.conditions.tempC.toFixed(0)}°C, ${state.conditions.pressureHpa.toFixed(0)} hPa, ${state.conditions.humidityPct.toFixed(0)}% RH) and your active profile's zero (${profile.zeroRangeM}m).
            The candidate is solved as if loaded in your rifle (same sight height, same zero) — this is a comparison of ammunition through one rifle setup, not two different rifles.
            Δ rows show <strong>candidate minus your load</strong>: a positive Δ drop means the candidate shoots flatter (hits higher); a positive Δ energy means the candidate hits harder.
          </div>
        `;
      }
    }

    modal.innerHTML = `
      <div class="bx-modal-card bx-modal-wide">
        <div class="bx-modal-title">Compare loads</div>
        <div class="bx-modal-body">
          <div class="bx-row-2">
            <div class="bx-field">
              <label for="bx-cmp-cal">Calibre</label>
              <select id="bx-cmp-cal">
                <option value="">— pick —</option>
                ${cals.map(c => `<option value="${c.id}" ${c.id === ui.calibreId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>
            <div class="bx-field">
              <label for="bx-cmp-mfr">Manufacturer</label>
              <select id="bx-cmp-mfr" ${ui.calibreId ? '' : 'disabled'}>
                <option value="">— pick —</option>
                ${mfrs.map(m => `<option value="${m.id}" ${m.id === ui.manufacturerId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="bx-field">
            <label for="bx-cmp-load">Load</label>
            <select id="bx-cmp-load" ${ui.manufacturerId ? '' : 'disabled'}>
              <option value="">— pick —</option>
              ${loads.map(l => `<option value="${l.id}" ${l.id === ui.candidateId ? 'selected' : ''}>${escapeHtml(l.weightGrains + 'gr ' + l.name)}</option>`).join('')}
            </select>
          </div>
          ${tableHtml}
        </div>
        <div class="bx-modal-actions">
          <button class="bx-btn bx-btn-secondary" id="bx-cmp-close">Close</button>
        </div>
      </div>
    `;

    $('bx-cmp-cal').addEventListener('change', e => {
      ui.calibreId = e.target.value;
      ui.manufacturerId = '';
      ui.candidateId = '';
      render();
    });
    $('bx-cmp-mfr').addEventListener('change', e => {
      ui.manufacturerId = e.target.value;
      ui.candidateId = '';
      render();
    });
    $('bx-cmp-load').addEventListener('change', e => {
      ui.candidateId = e.target.value;
      render();
    });
    $('bx-cmp-close').addEventListener('click', closeModal);
  }

  render();
}

function openProfileEditor(pid) {
  const p = state.profiles.find(x => x.id === pid);
  if (!p) return;
  const modal = $('bx-modal');
  modal.style.display = 'flex';
  // Format chrono date for the date input (YYYY-MM-DD) if set
  const chronoDateStr = p.chronoDateMs
    ? new Date(p.chronoDateMs).toISOString().slice(0, 10)
    : '';
  const chronoDelta = (p.chronoMv && p.chronoMv > 0)
    ? p.chronoMv - p.muzzleVelocityFps
    : 0;
  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">Edit profile</div>
      <div class="bx-modal-body">
        <div class="bx-field"><label for="bx-e-name">Name</label><input type="text" id="bx-e-name" value="${escapeHtml(p.name)}"></div>
        <div class="bx-field">
          <label>Ammunition</label>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span style="flex:1;min-width:200px;color:rgba(255,255,255,0.85);font-size:14px;">
              ${p.loadId ? escapeHtml(loadDisplayName(state.db, p.loadId)) : 'Manual entry'}
            </span>
            <button type="button" class="bx-btn bx-btn-secondary" id="bx-e-change-ammo">${p.loadId ? 'Change' : 'Pick factory load'}</button>
          </div>
        </div>
        <div class="bx-row-2">
          <div class="bx-field"><label for="bx-e-mv">Muzzle velocity (fps)</label><input type="number" id="bx-e-mv" value="${p.muzzleVelocityFps}"></div>
          <div class="bx-field"><label for="bx-e-wt">Bullet weight (gr)</label><input type="number" id="bx-e-wt" value="${p.weightGrains}"></div>
        </div>
        <div class="bx-row-2">
          <div class="bx-field"><label for="bx-e-bc1">BC (G1)</label><input type="number" id="bx-e-bc1" step="0.001" value="${p.bcG1}"></div>
          <div class="bx-field"><label for="bx-e-bc7">BC (G7)</label><input type="number" id="bx-e-bc7" step="0.001" value="${p.bcG7}"></div>
        </div>
        <div class="bx-row-2">
          <div class="bx-field"><label for="bx-e-sh">Sight height (${bxSmallU()})</label><input type="number" id="bx-e-sh" step="0.1" value="${bxImp() ? +cmToInches(p.sightHeightCm).toFixed(2) : p.sightHeightCm}"></div>
          <div class="bx-field"><label for="bx-e-zero">Zero range (${bxDistU()})</label><input type="number" id="bx-e-zero" value="${bxImp() ? Math.round(metresToYards(p.zeroRangeM)) : p.zeroRangeM}"></div>
        </div>

        <div class="bx-field-section-label">Chronograph correction (optional)</div>
        <div class="bx-row-2">
          <div class="bx-field">
            <label for="bx-e-chrono-mv">Your measured MV (fps)</label>
            <input type="number" id="bx-e-chrono-mv" placeholder="(none)" value="${p.chronoMv || ''}">
          </div>
          <div class="bx-field">
            <label for="bx-e-chrono-date">Date measured</label>
            <input type="date" id="bx-e-chrono-date" value="${chronoDateStr}">
          </div>
        </div>
        <div class="bx-field-hint">
          If you've chronographed your rifle with this load, enter the actual measured MV here.
          Calculations will use this value while keeping the published MV (${p.muzzleVelocityFps} fps) on record for reference.
          ${chronoDelta !== 0 ? `<br><strong>Current delta: ${chronoDelta > 0 ? '+' : ''}${chronoDelta} fps from published.</strong>` : ''}
        </div>

        <div class="bx-field-section-label">Powder temperature (optional)</div>
        <div class="bx-field">
          <label for="bx-e-mvtemp">MV shift (fps per °C)</label>
          <input type="number" id="bx-e-mvtemp" step="0.1" min="0" max="5" inputmode="decimal" placeholder="0 (off)" value="${p.mvTempCoeffFpsPerC || ''}">
          <div class="bx-field-hint">
            Optional. Many powders lose ~0.5–1.5 fps of MV per °C as they cool; enter your load's sensitivity
            to correct drop and retained energy for the temperature you're shooting in (reference 15 °C). Blank = ignore.
          </div>
        </div>

        <div class="bx-field">
          <label>Stalking species (for energy thresholds)</label>
          <div class="bx-species-grid">
            ${DEER_SPECIES.map(s => `
              <label class="bx-species-chip">
                <input type="checkbox" data-sp="${s.code}" ${p.species.includes(s.code) ? 'checked' : ''}>
                <span>${escapeHtml(s.label)}</span>
              </label>
            `).join('')}
          </div>
        </div>

        <div class="bx-field">
          <label for="bx-e-notes">Notes (optional)</label>
          <textarea id="bx-e-notes" rows="3" placeholder="e.g. Sako 85, S&B 3-12×56, last zeroed Aug 2026 at 100m, 18.5″ barrel">${escapeHtml(p.notes || '')}</textarea>
        </div>

        <div class="bx-field-hint" style="margin-top:12px;color:#c62828;">
          Editing muzzle velocity / BC marks this profile as customised. Use values from your chronograph if you have one — or use the chronograph correction above to keep the published values on record.
        </div>
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-danger" id="bx-e-delete">Delete</button>
        <button class="bx-btn bx-btn-secondary" id="bx-e-cancel">Cancel</button>
        <button class="bx-btn" id="bx-e-save">Save</button>
      </div>
    </div>
  `;
  $('bx-e-cancel').addEventListener('click', closeModal);
  $('bx-e-change-ammo').addEventListener('click', () => openChangeAmmo(p.id));
  $('bx-e-delete').addEventListener('click', () => {
    // In-app confirm card in the same modal host — native confirm() blocks
    // the renderer and ignores the night theme; Cancel restores the editor.
    const host = $('bx-modal');
    host.innerHTML = `
      <div class="bx-modal-card">
        <div class="bx-modal-title">Delete this profile?</div>
        <div class="bx-modal-body">
          <div class="bx-field-hint">&ldquo;${escapeHtml(p.name)}&rdquo; and its zeros, truing and notes are removed from this device. This can't be undone.</div>
        </div>
        <div class="bx-modal-actions">
          <button class="bx-btn bx-btn-secondary" id="bx-del-cancel" type="button">Cancel</button>
          <button class="bx-btn bx-btn-danger" id="bx-del-confirm" type="button">Delete</button>
        </div>
      </div>`;
    $('bx-del-cancel').addEventListener('click', () => openProfileEditor(p.id));
    $('bx-del-confirm').addEventListener('click', () => {
      state.profiles = state.profiles.filter(x => x.id !== p.id);
      if (state.activeProfileId === p.id) state.activeProfileId = state.profiles[0]?.id || null;
      saveProfilesToStorage(); saveSettingsToStorage();
      closeModal(); renderAll();
    });
  });
  $('bx-e-save').addEventListener('click', () => {
    const newMv = parseFloat($('bx-e-mv').value);
    const newW = parseFloat($('bx-e-wt').value);
    const newBc1 = parseFloat($('bx-e-bc1').value);
    const newBc7 = parseFloat($('bx-e-bc7').value);
    if (!(newMv > 0) || !(newW > 0)) { toast('MV and weight must be > 0', 'warn'); return; }
    if (!(newBc1 > 0 || newBc7 > 0)) { toast('Need at least one BC', 'warn'); return; }
    // Reject negative / out-of-range geometry (audit §2): a negative sight height
    // silently produces wrong holds; a negative or zero zero-range makes the
    // solver throw and leaves the profile stuck on "Could not compute".
    const shRaw = parseFloat($('bx-e-sh').value);
    const newSh = bxImp() ? +inchesToCm(shRaw).toFixed(2) : shRaw;
    const zRaw = parseInt($('bx-e-zero').value, 10);
    const newZero = bxImp() ? Math.round(yardsToMetres(zRaw)) : zRaw;
    if (!(newSh > 0 && newSh <= 15)) { toast(bxImp() ? 'Sight height must be between 0 and 5.9 in' : 'Sight height must be between 0 and 15 cm', 'warn'); return; }
    if (!(newZero >= 10 && newZero <= 500)) { toast(bxImp() ? 'Zero range must be between 11 and 547 yd' : 'Zero range must be between 10 and 500 m', 'warn'); return; }
    p.name = $('bx-e-name').value || p.name;
    if (newMv !== p.muzzleVelocityFps || newBc1 !== p.bcG1 || newBc7 !== p.bcG7) p.custom = true;
    p.muzzleVelocityFps = newMv;
    p.weightGrains = newW;
    p.bcG1 = newBc1; p.bcG7 = newBc7;
    p.sightHeightCm = newSh;
    p.zeroRangeM = newZero;
    // Keep the new active zero in the saved-zeros list (multiple-zeros feature).
    if (Array.isArray(p.zeroOptionsM) && !p.zeroOptionsM.includes(Math.round(p.zeroRangeM))) {
      p.zeroOptionsM = getZeroOptions(p);
    }
    // Chrono override
    const chronoMvRaw = $('bx-e-chrono-mv').value.trim();
    p.chronoMv = chronoMvRaw ? (parseFloat(chronoMvRaw) || null) : null;
    const chronoDateRaw = $('bx-e-chrono-date').value;
    p.chronoDateMs = (p.chronoMv && chronoDateRaw) ? Date.parse(chronoDateRaw) : null;
    // Powder-temperature MV coefficient (optional)
    const mvTempRaw = parseFloat($('bx-e-mvtemp').value);
    p.mvTempCoeffFpsPerC = (Number.isFinite(mvTempRaw) && mvTempRaw > 0) ? mvTempRaw : 0;
    // Notes
    p.notes = ($('bx-e-notes').value || '').trim().slice(0, 500);
    p.species = Array.from(document.querySelectorAll('[data-sp]:checked')).map(el => el.dataset.sp);
    if (p.species.length === 0) p.species = ['roe'];
    if (state.activeProfileId === p.id) state.settings.speciesFilter = p.species.slice();
    saveProfilesToStorage(); saveSettingsToStorage();
    closeModal(); renderAll();
    toast('Profile saved', 'ok');
  });
}

// Sub-modal launched from openProfileEditor's "Change ammo" button. Lets the
// user swap the underlying factory load on an existing profile without
// rebuilding it from scratch — a UX gap the previous flow had (only "+ ADD"
// could pick an ammo, edit was numeric-fields-only). Apply preserves the
// rifle-identity fields (name, sight height, zero range, notes, species)
// and replaces only the ballistics fields tied to the chosen load. Chrono
// override is cleared because it was measured against the previous MV.
function openChangeAmmo(pid) {
  const p = state.profiles.find(x => x.id === pid);
  if (!p) return;
  const modal = $('bx-modal');
  const cals = getCalibresWithLoads(state.db);
  // Pre-select the current load if there is one, so the user lands on the
  // calibre/manufacturer/load they currently have rather than a blank form.
  const currentLoad = p.loadId ? getLoadById(state.db, p.loadId) : null;
  const initialCalId = currentLoad ? currentLoad.calibre : '';
  const initialMfrId = currentLoad ? currentLoad.manufacturer : '';
  const initialLoadId = p.loadId || '';

  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">Change ammunition</div>
      <div class="bx-modal-body">
        <div class="bx-row-2">
          <div class="bx-field">
            <label for="bx-ca-cal">Calibre</label>
            <select id="bx-ca-cal">
              <option value="">— pick —</option>
              ${cals.map(c => `<option value="${c.id}"${c.id === initialCalId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="bx-field">
            <label for="bx-ca-mfr">Manufacturer</label>
            <select id="bx-ca-mfr"><option value="">—</option></select>
          </div>
        </div>
        <div class="bx-field">
          <label for="bx-ca-load">Load</label>
          <select id="bx-ca-load"><option value="">—</option></select>
          <div class="bx-field-hint" id="bx-ca-hint"></div>
        </div>
        <div class="bx-field-hint">
          Selecting a load updates muzzle velocity, bullet weight and BC for this profile. Your name, sight height, zero range and notes are preserved. Any chronograph correction is cleared because it was measured against the previous load.
        </div>
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-secondary" id="bx-ca-cancel">Cancel</button>
        <button class="bx-btn" id="bx-ca-apply">Apply</button>
      </div>
    </div>
  `;

  const calSel = $('bx-ca-cal');
  const mfrSel = $('bx-ca-mfr');
  const loadSel = $('bx-ca-load');
  const hint = $('bx-ca-hint');

  const refreshMfrs = () => {
    const mfrs = getManufacturersForCalibre(state.db, calSel.value);
    mfrSel.innerHTML = '<option value="">—</option>' +
      mfrs.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
    loadSel.innerHTML = '<option value="">—</option>';
    hint.textContent = '';
  };
  const refreshLoads = () => {
    const loads = getLoadsFor(state.db, calSel.value, mfrSel.value);
    loadSel.innerHTML = '<option value="">—</option>' +
      loads.map(l => `<option value="${l.id}">${escapeHtml(l.weightGrains + 'gr ' + l.name)}</option>`).join('');
    hint.textContent = '';
  };
  const setHint = (ld) => {
    if (!ld) { hint.textContent = ''; return; }
    hint.textContent = `${ld.muzzleVelocityFps} fps · BC ${ld.bcG7 > 0 ? 'G7 ' + ld.bcG7 : 'G1 ' + ld.bcG1} · ${ld.testBarrelInches}" test barrel`;
  };

  calSel.addEventListener('change', refreshMfrs);
  mfrSel.addEventListener('change', refreshLoads);
  loadSel.addEventListener('change', () => setHint(getLoadById(state.db, loadSel.value)));

  // Restore current selection so the user lands where they were.
  if (initialCalId) {
    refreshMfrs();
    mfrSel.value = initialMfrId;
    refreshLoads();
    loadSel.value = initialLoadId;
    if (initialLoadId) setHint(getLoadById(state.db, initialLoadId));
  }

  $('bx-ca-cancel').addEventListener('click', () => openProfileEditor(pid));
  $('bx-ca-apply').addEventListener('click', () => {
    const newLoadId = loadSel.value;
    if (!newLoadId) { toast('Pick a load first', 'warn'); return; }
    const ld = getLoadById(state.db, newLoadId);
    if (!ld) { toast('Could not load that ammo', 'warn'); return; }
    p.loadId = newLoadId;
    p.muzzleVelocityFps = ld.muzzleVelocityFps;
    p.weightGrains = ld.weightGrains;
    p.bcG1 = ld.bcG1 || 0;
    p.bcG7 = ld.bcG7 || 0;
    p.custom = false;        // back to a factory-linked profile
    // Chrono override is tied to the previous load's MV — clear it so it
    // doesn't silently apply to the new load. User can re-chrono later.
    p.chronoMv = null;
    p.chronoDateMs = null;
    saveProfilesToStorage();
    toast('Ammo changed', 'ok');
    openProfileEditor(pid);  // back to the edit modal with the new values pre-filled
  });
}

function openReticleEstimator() {
  // Range from scope reticle subtension. The maths is the standard
  // mil-relation formula: range = target_size / angular_size, with the
  // unit conversion baked in.
  //
  //   For MIL: range_m = (target_height_cm / 100) / mils * 1000
  //   For MOA: range_m = (target_height_cm / 100) / (moa * (π/10800))
  //
  // Reference target heights are typical UK deer body depths (chest,
  // back-to-belly). The user picks a species/preset; we assume average
  // values. Actual deer vary ±20%, so this is for orientation, not
  // precision — a 220m estimate could realistically be 180–270m.
  //
  // Common reference body depths (cm), brisket-to-back, mature animal:
  //   Roe ............ 35
  //   Muntjac/CWD .... 28
  //   Fallow ......... 50
  //   Sika ........... 50
  //   Red ............ 70
  // 14.03 (units audit): this tool has NO caller today — it is parked, like
  // the units toggle once was. Its strings carry the units voice anyway, so
  // whoever wires a button to it later cannot resurrect raw metres by accident.
  const zsz = (cm) => bxImp() ? `${+cmToInches(cm).toFixed(0)}in` : `${cm}cm`;
  const presets = [
    { code: 'roe',     label: `Roe (${zsz(35)})`,         cm: 35 },
    { code: 'muntjac', label: `Muntjac/CWD (${zsz(28)})`, cm: 28 },
    { code: 'fallow',  label: `Fallow (${zsz(50)})`,      cm: 50 },
    { code: 'sika',    label: `Sika (${zsz(50)})`,        cm: 50 },
    { code: 'red',     label: `Red (${zsz(70)})`,         cm: 70 },
  ];

  const modal = $('bx-modal');
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">Estimate range from reticle</div>
      <div class="bx-modal-body">
        <p style="font-size:12px;color:rgba(255,255,255,0.6);margin-bottom:14px;line-height:1.5;">
          If you can measure how much of your reticle the deer's body fills
          (brisket to back), this gives a rough range. Accuracy is ±20% —
          treat it as guidance only.
        </p>
        <div class="bx-field">
          <label for="bx-r-species">Deer (body depth)</label>
          <select id="bx-r-species">
            ${presets.map(p => `<option value="${p.cm}">${p.label}</option>`).join('')}
          </select>
        </div>
        <div class="bx-field">
          <label for="bx-r-value">Reticle measurement</label>
          <div class="bx-tabs">
            <button class="bx-tab on" data-unit="mil" aria-pressed="true">MIL</button>
            <button class="bx-tab" data-unit="moa" aria-pressed="false">MOA</button>
          </div>
          <input type="number" id="bx-r-value" step="0.1" min="0" placeholder="e.g. 1.6" autofocus>
        </div>
        <div id="bx-r-result" style="margin-top:18px;padding:14px;background:rgba(216,176,84,0.08);border:1px solid rgba(216,176,84,0.18);border-radius:10px;text-align:center;display:none;">
          <div style="font-size:11px;color:rgba(216,176,84,0.7);text-transform:uppercase;letter-spacing:0.5px;font-family:'DM Mono',monospace;">Estimated range</div>
          <div id="bx-r-range" style="font-family:'DM Mono',monospace;font-size:32px;color:white;font-weight:500;letter-spacing:-1px;margin-top:4px;"></div>
        </div>
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-secondary" id="bx-r-cancel">Cancel</button>
        <button class="bx-btn" id="bx-r-use">Use this range</button>
      </div>
    </div>
  `;

  let unit = 'mil';
  let lastRangeM = null;

  function recalc() {
    const cm = parseFloat($('bx-r-species').value);
    const v = parseFloat($('bx-r-value').value);
    const result = $('bx-r-result');
    if (!Number.isFinite(cm) || !Number.isFinite(v) || v <= 0) {
      result.style.display = 'none';
      lastRangeM = null;
      return;
    }
    const sizeM = cm / 100;
    let rangeM;
    if (unit === 'mil') {
      rangeM = (sizeM / v) * 1000;
    } else {
      rangeM = sizeM / (v * Math.PI / 10800);
    }
    lastRangeM = Math.round(rangeM);
    if (lastRangeM < 25 || lastRangeM > 500) {
      result.style.display = 'block';
      $('bx-r-range').innerHTML = `${bxDist(lastRangeM)} ${bxDistU()} <span style="font-size:11px;color:rgba(255,255,255,0.5);">— outside slider range</span>`;
    } else {
      result.style.display = 'block';
      $('bx-r-range').textContent = bxDist(lastRangeM) + ' ' + bxDistU();
    }
  }

  modal.querySelectorAll('.bx-tab').forEach(t => {
    t.addEventListener('click', () => {
      modal.querySelectorAll('.bx-tab').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
      t.classList.add('on');
      t.setAttribute('aria-pressed', 'true');
      unit = t.dataset.unit;
      recalc();
    });
  });
  $('bx-r-species').addEventListener('change', recalc);
  $('bx-r-value').addEventListener('input', recalc);
  $('bx-r-cancel').addEventListener('click', closeModal);
  $('bx-r-use').addEventListener('click', () => {
    if (lastRangeM == null) { toast('Enter a measurement first', 'warn'); return; }
    state.rangeM = Math.max(25, Math.min(500, lastRangeM));
    saveSettingsToStorage();
    closeModal();
    renderRangeControl();
    renderOutput();
    toast('Range set to ' + bxDist(state.rangeM) + ' ' + bxDistU(), 'ok');
  });
}

function openConditionsEditor() {
  const modal = $('bx-modal');
  modal.style.display = 'flex';
  const c = state.conditions;
  // Wind direction picker — 8 clock positions, each with the corresponding
  // wind-from angle in degrees. The bullet flies "up" (towards 0°/12 o'clock).
  const dirPositions = [
    { code: '12', deg: 0,   label: '↓',  hint: 'Headwind (no drift)' },
    { code: '1.5', deg: 45, label: '↙',  hint: '½ R (drift left ~70%)' },
    { code: '3',  deg: 90,  label: '←',  hint: 'Full R (drift left)' },
    { code: '4.5', deg: 135, label: '↖', hint: '½ R behind (~70%)' },
    { code: '6',  deg: 180, label: '↑',  hint: 'Tailwind (no drift)' },
    { code: '7.5', deg: 225, label: '↗', hint: '½ L behind (~70%)' },
    { code: '9',  deg: 270, label: '→',  hint: 'Full L (drift right)' },
    { code: '10.5', deg: 315, label: '↘', hint: '½ L (drift right ~70%)' },
  ];
  const currentDir = ((c.windDirDeg || 0) % 360 + 360) % 360;
  // Pick the closest clock position to currentDir
  const activeIdx = dirPositions.reduce((best, p, i, arr) =>
    Math.abs(p.deg - currentDir) < Math.abs(arr[best].deg - currentDir) ? i : best, 0);

  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">Conditions</div>
      <div class="bx-modal-body">
        <div class="bx-row-2">
          <div class="bx-field"><label for="bx-c-t">Temperature (°C)</label><input type="number" id="bx-c-t" step="0.5" value="${c.tempC}"></div>
          <div class="bx-field"><label for="bx-c-p">Pressure &mdash; station (hPa)</label><input type="number" id="bx-c-p" value="${c.pressureHpa}"></div>
        </div>
        <div class="bx-row-2">
          <div class="bx-field"><label for="bx-c-h">Humidity (%)</label><input type="number" id="bx-c-h" min="0" max="100" value="${c.humidityPct}"></div>
          <div class="bx-field"><label for="bx-c-a">Shot angle (°, +up)</label><input type="number" id="bx-c-a" min="-60" max="60" value="${c.shotAngleDeg}"></div>
        </div>
        <div class="bx-field">
          <label for="bx-c-w">Wind speed (m/s)</label>
          <input type="number" id="bx-c-w" min="0" max="20" step="0.5" inputmode="decimal" value="${c.windMps}">
          <div class="bx-wind-presets">
            <button type="button" class="bx-wind-preset" data-w="0">Calm</button>
            <button type="button" class="bx-wind-preset" data-w="2">2</button>
            <button type="button" class="bx-wind-preset" data-w="5">5</button>
            <button type="button" class="bx-wind-preset" data-w="8">8</button>
            <button type="button" class="bx-wind-preset" data-w="12">12</button>
          </div>
        </div>
        <div class="bx-field" id="bx-c-dir-field" ${c.windMps === 0 ? 'style="opacity:0.4;pointer-events:none;"' : ''}>
          <label>Wind direction <span class="bx-field-hint-inline">(direction wind comes FROM, relative to bullet path)</span></label>
          <div class="bx-wind-compass">
            <div class="bx-wind-bullet" title="Bullet's flight direction">●</div>
            ${dirPositions.map((p, i) => `
              <button type="button" class="bx-wind-dir bx-wind-dir-${p.code.replace('.', '_')} ${i === activeIdx ? 'on' : ''}"
                      data-deg="${p.deg}" aria-pressed="${i === activeIdx ? 'true' : 'false'}"
                      aria-label="${escapeHtml(p.hint)}"
                      title="${escapeHtml(p.hint)}">${p.label}</button>
            `).join('')}
            <div class="bx-wind-center">↑</div>
          </div>
          <div class="bx-field-hint" id="bx-c-dir-hint">${escapeHtml(dirPositions[activeIdx].hint)}</div>
        </div>
        <div class="bx-field bx-field-actions">
          <button class="bx-btn bx-btn-secondary" id="bx-c-auto">Use current location</button>
        </div>
        <div class="bx-field-hint">
          Defaults are ICAO standard atmosphere (15°C, 1013 hPa, sea level).
          Enter <strong>station (absolute)</strong> pressure, not sea-level QNH &mdash; at 600 m a QNH figure over-reads
          air density by ~7%. "Use current location" fills the correct value.
          <br><br>
          <strong>Wind drift assumes a constant wind from muzzle to target.</strong>
          In real terrain wind speed and direction at the muzzle, mid-trajectory, and
          target are often different. Read conditions at the target where possible
          and treat the calculated drift as a starting point, not a final answer.
        </div>
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-secondary" id="bx-c-cancel">Cancel</button>
        <button class="bx-btn" id="bx-c-save">Save</button>
      </div>
    </div>
  `;

  // Wind direction button wiring
  let pickedDeg = dirPositions[activeIdx].deg;
  const dirField = $('bx-c-dir-field');
  const dirHint = $('bx-c-dir-hint');
  document.querySelectorAll('.bx-wind-dir').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bx-wind-dir').forEach(b => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
      btn.classList.add('on');
      btn.setAttribute('aria-pressed', 'true');
      pickedDeg = parseFloat(btn.dataset.deg);
      const p = dirPositions.find(x => x.deg === pickedDeg);
      if (p && dirHint) dirHint.textContent = p.hint;
    });
  });
  // Wind speed change toggles direction picker enabled/disabled
  $('bx-c-w').addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (dirField) {
      dirField.style.opacity = v === 0 ? '0.4' : '';
      dirField.style.pointerEvents = v === 0 ? 'none' : '';
    }
  });
  document.querySelectorAll('.bx-wind-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = $('bx-c-w');
      inp.value = btn.dataset.w;
      inp.dispatchEvent(new Event('input'));
    });
  });

  $('bx-c-cancel').addEventListener('click', closeModal);
  $('bx-c-auto').addEventListener('click', () => { closeModal(); autoFillConditions(); });
  $('bx-c-save').addEventListener('click', () => {
    // Number.isFinite + clamp (not `|| default`) so a legitimate 0 °C / 0 % RH
    // is kept instead of silently becoming 15 °C / 50 %. Envelope matches the
    // localStorage restore path (audit §2).
    state.conditions.tempC = clampNum($('bx-c-t').value, 15, -40, 50);
    state.conditions.pressureHpa = clampNum($('bx-c-p').value, 1013.25, 800, 1100);
    state.conditions.humidityPct = clampNum($('bx-c-h').value, 50, 0, 100);
    state.conditions.shotAngleDeg = clampNum($('bx-c-a').value, 0, -60, 60);
    state.conditions.windMps = clampNum($('bx-c-w').value, 0, 0, 20);
    state.conditions.windDirDeg = pickedDeg;
    // B8: hand entry, whatever it overwrote. If an auto-fill is sitting in
    // these boxes and the user presses Save, the figures have been read and
    // accepted by a person — 'manual' is the accurate claim and, unlike
    // 'auto', it never goes stale behind their back.
    state.conditions.source = 'manual';
    state.conditions.fetchedAt = Date.now();
    saveSettingsToStorage();
    closeModal(); renderConditions(); renderOutput();
  });
}
// ── Dialog accessibility ─────────────────────────────────────────────────
//
// Every tool sheet (Zeros, Stability, Compare, Backup, Lead-free, the wizard,
// the acceptance gate and the rest) is opened the same way: write innerHTML
// into #bx-modal and set display:flex. There are sixteen such call sites and
// no shared open() helper, so rather than edit all sixteen, a MutationObserver
// watches the container and, on the closed → open transition, does the four
// things a modal dialog owes a keyboard or screen-reader user:
//
//   1. name itself from the sheet's own title (was a generic aria-label="Dialog")
//   2. move focus into the dialog (focus used to stay on BODY while
//      aria-modal="true" hid the background — a screen-reader user was stranded)
//   3. trap Tab inside it
//   4. hand focus back to the trigger, and unlock body scroll, on close
//
// `inert` on the background is deliberately NOT used: aria-modal="true" already
// hides it from assistive tech and the Tab trap already covers the keyboard.
// Running both mechanisms risks them disagreeing about what is reachable.

const MODAL_FOCUSABLE_SEL = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

let _modalOpen = false;
let _modalPrevFocus = null;

function modalFocusables(modal) {
  return Array.from(modal.querySelectorAll(MODAL_FOCUSABLE_SEL))
    .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
}

// The sheets use .bx-modal-title; the first-run acceptance gate uses its own
// .bx-acceptance-title. Either is a better dialog name than "Dialog".
function syncModalLabel(modal) {
  const titleEl = modal.querySelector('.bx-modal-title, .bx-acceptance-title');
  const name = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : '';
  modal.setAttribute('aria-label', name || 'Ballistic calculator tool');
}

function onModalKeydown(e) {
  if (e.key !== 'Tab') return;
  const modal = $('bx-modal');
  if (!modal || modal.style.display !== 'flex') return;
  const items = modalFocusables(modal);
  if (!items.length) { e.preventDefault(); modal.focus(); return; }
  const first = items[0], last = items[items.length - 1];
  const active = document.activeElement;
  const inside = modal.contains(active) && active !== modal;
  if (e.shiftKey) {
    // Shift+Tab off the first control (or from the dialog container itself)
    // wraps to the last, instead of escaping to the page behind.
    if (!inside || active === first) { e.preventDefault(); last.focus(); }
  } else if (active === last || (!inside && active !== modal)) {
    e.preventDefault(); first.focus();
  }
}

function handleModalMutation() {
  const modal = $('bx-modal');
  if (!modal) return;
  const openNow = modal.style.display === 'flex';
  if (openNow && !_modalOpen) {
    _modalOpen = true;
    const prev = document.activeElement;
    _modalPrevFocus = (prev && prev !== document.body && typeof prev.focus === 'function') ? prev : null;
    syncModalLabel(modal);
    document.body.classList.add('bx-modal-open');
    document.addEventListener('keydown', onModalKeydown, true);
    // Focus the dialog container rather than its first control: it carries the
    // aria-label so the sheet announces itself, it can't fire anything by
    // accident, and it survives the in-place re-renders below.
    modal.focus();
  } else if (openNow) {
    // Re-render while still open (openZerosModal rewrites its own innerHTML
    // when a zero is added, activated or removed). Refresh the name, and
    // rescue focus only if the node that held it was destroyed.
    syncModalLabel(modal);
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) modal.focus();
  } else if (_modalOpen) {
    _modalOpen = false;
    document.body.classList.remove('bx-modal-open');
    document.removeEventListener('keydown', onModalKeydown, true);
    const back = _modalPrevFocus;
    _modalPrevFocus = null;
    if (back && document.contains(back)) { try { back.focus(); } catch (err) { /* detached */ } }
  }
}

let _modalObserver = null;
function installModalA11y() {
  const modal = $('bx-modal');
  if (!modal || _modalObserver) return;
  // No subtree: the two things that matter are the container's own inline
  // display flip and the wholesale innerHTML swap. Watching the subtree would
  // fire on every keystroke inside a live-updating field.
  _modalObserver = new MutationObserver(handleModalMutation);
  _modalObserver.observe(modal, { attributes: true, attributeFilter: ['style'], childList: true });
  handleModalMutation();
}

function closeModal() {
  const modal = $('bx-modal');
  if (!modal) return;
  modal.style.display = 'none';
  modal.innerHTML = '';
}

/**
 * Modal for the user to pick which species/sex they're stalking now and
 * which aim-point philosophy they prefer. Persists to localStorage.
 *
 * Phase 1: roe / red / fallow / sika only (muntjac and CWD too small for
 * the heuristic to be useful).
 */
function openAnatomyEditor() {
  const modal = $('bx-modal');
  modal.style.display = 'flex';
  const s = state.settings;
  const speciesOptions = Object.entries(SPECIES_BODY).map(([key, v]) => {
    const sel = key === s.anatomySpecies ? 'selected' : '';
    return `<option value="${key}" ${sel}>${escapeHtml(v.label)}</option>`;
  }).join('');
  const sexOpts = `
    <option value="buck" ${s.anatomySex === 'buck' ? 'selected' : ''}>Mature male (buck/stag)</option>
    <option value="doe" ${s.anatomySex === 'doe' ? 'selected' : ''}>Mature female (doe/hind)</option>
    <option value="juvenile" ${s.anatomySex === 'juvenile' ? 'selected' : ''}>Juvenile</option>
  `;
  const presKey = s.anatomyPresentation || DEFAULT_PRESENTATION;
  const presOpts = Object.entries(PRESENTATIONS).map(([key, v]) =>
    `<option value="${key}" ${key === presKey ? 'selected' : ''}>${escapeHtml(v.label)}</option>`
  ).join('');
  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">Aim-point settings</div>
      <div class="bx-modal-body">
        <div class="bx-field">
          <label class="bx-toggle">
            <input type="checkbox" id="bx-a-enabled" ${s.anatomyEnabled ? 'checked' : ''}>
            <span>Show aim-point on the deer</span>
          </label>
          <div class="bx-field-hint">Translates the cm/MOA hold into a reference on the deer's body.</div>
        </div>
        <div class="bx-row-2">
          <div class="bx-field">
            <label for="bx-a-species">Species</label>
            <select id="bx-a-species">${speciesOptions}</select>
          </div>
          <div class="bx-field">
            <label for="bx-a-sex">Size</label>
            <select id="bx-a-sex">${sexOpts}</select>
          </div>
        </div>
        <div class="bx-field">
          <label for="bx-a-presentation">Presentation</label>
          <select id="bx-a-presentation">${presOpts}</select>
          <div class="bx-field-hint">How the deer is angled. Quartering shifts the hold and narrows the effective vital zone.</div>
        </div>
        <div class="bx-field">
          <label>Aim point</label>
          <div class="bx-field-hint">Heart/Lung (BDS) — mid-chest, halfway between brisket and back. The standard humane shot for UK stalking.</div>
        </div>
        <div class="bx-field-hint bx-field-hint-warn">
          Body dimensions are typical-adult averages from BDS / Mammal Society
          data. Real animals vary by ±15% or more. Aim-point references are an
          approximate guide, not a substitute for the stalker's own judgement
          on the day.
        </div>
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-secondary" id="bx-a-cancel">Cancel</button>
        <button class="bx-btn" id="bx-a-save">Save</button>
      </div>
    </div>
  `;

  $('bx-a-cancel').addEventListener('click', closeModal);
  $('bx-a-save').addEventListener('click', () => {
    state.settings.anatomyEnabled = $('bx-a-enabled').checked;
    state.settings.anatomySpecies = $('bx-a-species').value;
    state.settings.anatomySex = $('bx-a-sex').value;
    const presVal = $('bx-a-presentation') ? $('bx-a-presentation').value : DEFAULT_PRESENTATION;
    state.settings.anatomyPresentation = PRESENTATIONS[presVal] ? presVal : DEFAULT_PRESENTATION;
    // anatomyAimPoint is no longer user-editable (heart_lung is the only
    // option). State stays at default; legacy 'heart' / 'high_shoulder'
    // values fall through the AIM_POINTS lookup safely.
    saveSettingsToStorage();
    closeModal();
    renderOutput();
  });
}

function renderAll() {
  renderProfileBar();
  renderRangeControl();
  renderConditions();
  renderOutput();
}

// Toggle the red low-light field theme. The `bx-night` class on <html> drives
// a CSS filter that recolours the whole page (including the deer SVG and drop
// chart) to a dimmed red, protecting dark adaptation. Persisted so it survives
// a reload during a dusk stalk.
function applyNightMode(on, persist) {
  state.settings.nightMode = !!on;
  document.documentElement.classList.toggle('bx-night', !!on);
  renderDropChart();   // canvas is a bitmap — re-draw so night hatch applies (SVG reacts via CSS)
  const btn = $('bx-night-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.innerHTML = on ? '<span class="fl-ic fl-wx-sun"></span> Day' : '<span class="fl-ic fl-moon-wancres"></span> Night';
  }
  if (persist) saveSettingsToStorage();
}

// ── Dope card export ─────────────────────────────────────────────────────

// Reference full-value crosswind (m/s) the dope card's Wind column assumes.
// 4 m/s ≈ 9 mph — a moderate, common UK hill wind. Crosswind drift scales
// linearly with speed, so the printed number doubles at 8 m/s, halves at 2.
const DOPE_WIND_REF_MS = 4;

/**
 * Solve the per-range dope rows for the card. Each range is solved with the
 * reference crosswind so the card's Wind column can be printed — a pure
 * crosswind doesn't change vertical drop, so one solve yields drop + drift.
 * Ranges are rounded to the metre, filtered to the solver's sane domain,
 * de-duplicated and sorted ascending.
 */
function buildDopeCurve(p, ranges) {
  const seen = new Set();
  const clean = (ranges || [])
    .map(r => Math.round(r))
    .filter(r => Number.isFinite(r) && r >= 10 && r <= 800)
    .filter(r => { if (seen.has(r)) return false; seen.add(r); return true; })
    .sort((a, b) => a - b);
  const curve = [];
  for (const rM of clean) {
    let result;
    try {
      result = solveShot({
        muzzleVelocityMs: fpsToMs(effectiveMvFps(p)),
        bcG1: p.bcG1, bcG7: p.bcG7,
        bulletMassKg: grainsToKg(p.weightGrains),
        sightHeightCm: p.sightHeightCm,
        zeroRangeM: p.zeroRangeM,
        tempC: state.conditions.tempC,
        pressureHpa: state.conditions.pressureHpa,
        humidityPct: state.conditions.humidityPct,
        targetRangeM: rM,
        windMs: DOPE_WIND_REF_MS,
        shotAngleDeg: 0,
      });
    } catch (e) {
      // A degenerate profile (no BC, NaN sight height) makes solveShot throw.
      // Skip the point rather than letting the throw escape buildDopeCurve and
      // kill the export button uncaught (audit B5) — the solve here sits OUTSIDE
      // generateDopeCard's try. An all-throw profile yields an empty curve,
      // which generateDopeCard already reports cleanly.
      continue;
    }
    if (result) curve.push({
      rangeM: rM,
      dropCm: result.dropCm,
      dropMoa: result.dropMoa,
      dropMil: result.dropMil,
      windDriftCm: result.windDriftCm,
      windDriftMil: result.windDriftMil,
      velocityFps: result.velocityFps,
      velocityMs: result.velocityMs,
      energyFtLbs: result.energyFtLbs,
      energyJ: result.energyJ,
    });
  }
  return curve;
}

/** Default reference grid when the user hasn't customised: 25→400 m every 25 m. */
function defaultDopeRanges() {
  const out = [];
  for (let r = 25; r <= 400; r += 25) out.push(r);
  return out;
}

/**
 * Build and trigger download of the dope card PDF for the active profile,
 * printing the given ranges (metres). Falls back to the default grid.
 */
function generateDopeCard(sizeName, ranges) {
  const p = getActiveProfile();
  if (!p) { toast('Set up a rifle first', 'warn'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    toast('PDF library not loaded — try reloading the page', 'warn');
    return;
  }
  const curve = buildDopeCurve(p, (ranges && ranges.length) ? ranges : defaultDopeRanges());
  if (!curve.length) { toast('Could not compute a trajectory — check the rifle\'s BC and inputs', 'warn'); return; }

  // Most-restrictive species in the filter drives the threshold band.
  let thresholdFtLb = null;
  let speciesUsed = null;
  for (const sp of state.settings.speciesFilter) {
    const min = minMuzzleEnergyFor(state.settings.jurisdiction, sp);
    if (min == null) continue;
    if (thresholdFtLb == null || min > thresholdFtLb) {
      thresholdFtLb = min;
      speciesUsed = sp;
    }
  }
  const speciesLabel = speciesUsed
    ? (DEER_SPECIES.find(s => s.code === speciesUsed)?.label || speciesUsed)
    : null;
  const jurLabel = JURISDICTIONS.find(j => j.code === state.settings.jurisdiction)?.label || '';

  // The card prints the retained-energy figure and then disclaims it as "not
  // the legal test". Hand it the whole threshold record so it can print what
  // the legal test actually is — calibre, bullet weight, muzzle velocity,
  // construction and citation, not just the energy number.
  //
  // minMuzzleEnergyFor() returns null where a jurisdiction specifies nothing
  // (muntjac in Scotland), which leaves speciesUsed null and would drop the
  // legal block entirely. Fall back to the first filtered species so the card
  // can still say, in terms, that no threshold is specified — silence there
  // reads as "no rules apply", which is not what the data means.
  const minimaSpecies = speciesUsed || state.settings.speciesFilter[0] || null;
  const legalMinima = minimaSpecies
    ? thresholdFor(state.settings.jurisdiction, minimaSpecies)
    : null;
  const minimaSpeciesLabel = minimaSpecies
    ? (DEER_SPECIES.find(s => s.code === minimaSpecies)?.label || minimaSpecies)
    : null;

  const ammoDisplay = p.loadId
    ? loadDisplayName(state.db, p.loadId) + (p.custom ? ' (custom MV/BC)' : '')
    : null;

  try {
    const doc = buildDopeCardPDF({
      profile: p,
      ammoLoad: ammoDisplay,
      conditions: { ...state.conditions },
      dropCurve: curve,
      windRefMs: DOPE_WIND_REF_MS,
      sizeName: sizeName === 'A4' ? 'A4' : 'A6',
      jurisdictionLabel: jurLabel,
      speciesLabel: speciesLabel || minimaSpeciesLabel,
      thresholdFtLb,
      legalMinima,
      units: state.settings.units,
      anatomy: state.settings.anatomyEnabled ? {
        speciesKey: state.settings.anatomySpecies,
        sex: state.settings.anatomySex,
        aimPointKey: state.settings.anatomyAimPoint,
      } : null,
    });
    downloadDopeCardPDF(doc, p.name, sizeName);
    toast('Dope card downloaded', 'ok');
  } catch (e) {
    console.error('[ballistics] dope-card error', e);
    toast('Could not generate PDF', 'warn');
  }
}

/**
 * Options sheet shown when the user taps an export button: choose the range
 * grid (furthest + step), add specific lasered distances, include the zero.
 * The card's range column is metric, so these inputs are in metres. Keeps a
 * one-more-tap "Generate" for the default while unlocking custom ranges.
 */
function openDopeCardOptions(sizeName) {
  const p = getActiveProfile();
  if (!p) { toast('Set up a rifle first', 'warn'); return; }
  const modal = $('bx-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="bx-modal-card">
      <div class="bx-modal-title">Dope card &middot; ${sizeName}</div>
      <div class="bx-modal-body">
        <div class="bx-row-2">
          <div class="bx-field">
            <label for="bx-dope-max">Furthest range (${bxDistU()})</label>
            <select id="bx-dope-max">
              <option value="200">200</option>
              <option value="300">300</option>
              <option value="400" selected>400</option>
              <option value="500">500</option>
            </select>
          </div>
          <div class="bx-field">
            <label for="bx-dope-step">Step (${bxDistU()})</label>
            <select id="bx-dope-step">
              <option value="25" selected>25</option>
              <option value="50">50</option>
            </select>
          </div>
        </div>
        <div class="bx-field">
          <label for="bx-dope-extra">Add specific ranges (optional)</label>
          <input type="text" id="bx-dope-extra" inputmode="numeric" placeholder="e.g. 147, 283">
          <div class="bx-field-hint">Comma-separated, in ${bxImp() ? 'yards' : 'metres'} &mdash; your lasered distances. Added as their own rows.</div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:rgba(255,255,255,0.85);margin-top:6px;cursor:pointer;">
          <input type="checkbox" id="bx-dope-zero" checked> Include a row at your ${bxDist(p.zeroRangeM)} ${bxDistU()} zero
        </label>
        <div class="bx-field-hint" style="margin-top:12px;">
          Card assumes today's conditions (${state.conditions.tempC.toFixed(0)} &deg;C, ${state.conditions.pressureHpa.toFixed(0)} hPa)
          and a ${DOPE_WIND_REF_MS} m/s reference crosswind for the Wind column. Columns: drop in ${bxImp() ? 'inches' : 'cm'}, MOA, MIL, wind drift, velocity, energy.
        </div>
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn bx-btn-secondary" id="bx-dope-cancel" type="button">Cancel</button>
        <button class="bx-btn" id="bx-dope-go" type="button">Generate ${sizeName}</button>
      </div>
    </div>
  `;
  $('bx-dope-cancel').addEventListener('click', closeModal);
  $('bx-dope-go').addEventListener('click', () => {
    const maxV = parseInt($('bx-dope-max').value, 10) || 400;
    const stepV = parseInt($('bx-dope-step').value, 10) || 25;
    // The grid is built in the DISPLAY unit (so imperial gets a 25 yd step to
    // a round 400 yd card), then converted once — the solver takes metres.
    const toM = (v) => bxImp() ? yardsToMetres(v) : v;
    const ranges = [];
    for (let r = stepV; r <= maxV; r += stepV) ranges.push(toM(r));
    const extra = ($('bx-dope-extra').value || '').split(/[,\s]+/).map(s => parseFloat(s)).filter(v => v > 0);
    for (const v of extra) ranges.push(toM(v));
    if ($('bx-dope-zero').checked && p.zeroRangeM > 0) ranges.push(p.zeroRangeM);
    closeModal();
    generateDopeCard(sizeName, ranges);
  });
}

// ── Public init ─────────────────────────────────────────────────────────

export async function initBallisticsUi() {
  // Dialog focus management must be live before anything can open a sheet —
  // the first-run acceptance gate opens at the end of this function.
  installModalA11y();

  // Load profiles + settings from localStorage.
  state.profiles = loadProfilesFromStorage();
  const settings = loadSettingsFromStorage();
  if (settings) {
    state.activeProfileId = settings.activeProfileId || null;
    // 14.01: yards are wired through everywhere (hold, wind, dead-hold, chart,
    // zeros, wizard, truing, dope card), so the launch-era force-metric guard is
    // retired and the toggle is visible again. The shared 'fl-units' key — the
    // diary's Units setting writes it too — wins over this page's own persisted
    // blob, so both surfaces speak with one voice.
    const sharedU = readSharedUnits();
    state.settings.units = (sharedU && sharedU.dist === 'yd') ? 'imperial'
      : (sharedU && sharedU.dist === 'm') ? 'metric'
      : (settings.units === 'imperial' ? 'imperial' : 'metric');
    state.settings.jurisdiction = settings.jurisdiction || 'england-wales';
    state.settings.speciesFilter = Array.isArray(settings.speciesFilter) && settings.speciesFilter.length
      ? settings.speciesFilter
      : ['roe', 'red', 'fallow', 'sika', 'muntjac', 'cwd'];
    if (typeof settings.anatomyEnabled === 'boolean') {
      state.settings.anatomyEnabled = settings.anatomyEnabled;
    }
    if (settings.anatomyAimPoint && AIM_POINTS[settings.anatomyAimPoint]) {
      state.settings.anatomyAimPoint = settings.anatomyAimPoint;
    }
    if (settings.anatomySpecies && SPECIES_BODY[settings.anatomySpecies]) {
      state.settings.anatomySpecies = settings.anatomySpecies;
    }
    if (Number.isFinite(settings.pbrZoneCm) && settings.pbrZoneCm >= 3 && settings.pbrZoneCm <= 40) {
      state.settings.pbrZoneCm = settings.pbrZoneCm; // 12.95
    }
    if (settings.anatomySex === 'buck' || settings.anatomySex === 'doe' || settings.anatomySex === 'juvenile') {
      state.settings.anatomySex = settings.anatomySex;
    }
    if (settings.anatomyPresentation && PRESENTATIONS[settings.anatomyPresentation]) {
      state.settings.anatomyPresentation = settings.anatomyPresentation;
    }
    if (typeof settings.nightMode === 'boolean') {
      state.settings.nightMode = settings.nightMode;
    }
    // Field state restore. Each value is bounds-checked so a tampered or
    // corrupted localStorage entry can't push the calculator into an
    // invalid state at startup.
    if (typeof settings.rangeM === 'number' && settings.rangeM >= 25 && settings.rangeM <= 500) {
      state.rangeM = Math.round(settings.rangeM);
    }
    if (settings.conditions && typeof settings.conditions === 'object') {
      const c = settings.conditions;
      // Temperature: -40 to +50 °C is the full envelope of plausible UK + worldwide stalking.
      if (typeof c.tempC === 'number' && c.tempC >= -40 && c.tempC <= 50) {
        state.conditions.tempC = c.tempC;
      }
      // Pressure: 800-1100 hPa covers sea level down to ~2000 m altitude.
      if (typeof c.pressureHpa === 'number' && c.pressureHpa >= 800 && c.pressureHpa <= 1100) {
        state.conditions.pressureHpa = c.pressureHpa;
      }
      if (typeof c.humidityPct === 'number' && c.humidityPct >= 0 && c.humidityPct <= 100) {
        state.conditions.humidityPct = c.humidityPct;
      }
      // Wind: cap at 20 m/s — stalkers shouldn't be shooting in stronger anyway.
      if (typeof c.windMps === 'number' && c.windMps >= 0 && c.windMps <= 20) {
        state.conditions.windMps = c.windMps;
      }
      if (typeof c.windDirDeg === 'number' && c.windDirDeg >= 0 && c.windDirDeg <= 360) {
        state.conditions.windDirDeg = c.windDirDeg;
      }
      // Shot angle: ±60° covers any realistic uphill/downhill scenario.
      if (typeof c.shotAngleDeg === 'number' && c.shotAngleDeg >= -60 && c.shotAngleDeg <= 60) {
        state.conditions.shotAngleDeg = c.shotAngleDeg;
      }
      // B8: provenance. Only the three known kinds are accepted — a corrupted
      // or hand-edited entry must not be able to make the card say 'fetched'.
      if (c.source === 'auto' || c.source === 'manual' || c.source === 'default') {
        state.conditions.source = c.source;
        if (typeof c.fetchedAt === 'number' && c.fetchedAt > 0) {
          state.conditions.fetchedAt = c.fetchedAt;
        }
      } else if (state.conditions.tempC !== CONDITIONS_DEFAULT.tempC
              || state.conditions.pressureHpa !== CONDITIONS_DEFAULT.pressureHpa
              || state.conditions.humidityPct !== CONDITIONS_DEFAULT.humidityPct) {
        // Saved before this field existed. The values are not the defaults, so
        // either a person or a fetch put them there — but which, and when, is
        // not recoverable. Claim the weaker of the two: 'manual' with no
        // timestamp asserts nothing about freshness, where guessing 'auto'
        // would assert something this code cannot know.
        state.conditions.source = 'manual';
        state.conditions.fetchedAt = null;
      }
    }
  }
  if (!state.activeProfileId && state.profiles.length > 0) {
    state.activeProfileId = state.profiles[0].id;
  }
  // Default speciesFilter from active profile if available
  const ap = getActiveProfile();
  if (ap) state.settings.speciesFilter = ap.species.slice();

  // Load ammo database.
  try {
    const res = await fetch('./data/ammo-loads.json');
    state.db = await res.json();
  } catch (e) {
    console.error('[ballistics] could not load ammo database', e);
    state.db = { calibres: [], manufacturers: [], loads: [], verified: false };
  }

  // Wire up controls.
  const slider = $('bx-range-slider');
  if (slider) {
    // Coalesce slider `input` events through requestAnimationFrame so a
    // single drag doesn't queue dozens of full recomputes per frame.
    // Each renderOutput() pass triggers computeShot() + the ethical-range
    // probe (~48 solveShot calls in 10m steps) + the range-card render +
    // compliance + renderDropChart (~38 more solveShot calls). On low-end
    // Android that's ~80-100 trajectory solves per slider tick; without
    // coalescing the UI janks badly. rAF lets the browser run at most
    // one render per frame; the latest slider.value is read at flush time
    // so we never render a stale value. (Added 2026-06-09.)
    let rafScheduled = false;
    slider.addEventListener('input', () => {
      if (rafScheduled) return;
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        state.rangeM = parseInt(slider.value, 10) || 100;
        renderRangeControl();
        renderOutput();
      });
    });
    // Persist on release (change event fires once when the user lifts
    // their finger), not on every input tick. Avoids hammering localStorage
    // while the user drags the slider.
    slider.addEventListener('change', saveSettingsToStorage);
  }
  const condBtn = $('bx-conditions-edit');
  if (condBtn) condBtn.addEventListener('click', openConditionsEditor);
  // B8: the chip states an age, so it has to be recomputed when the app comes
  // back rather than left reading "12 min ago" after an hour in a pocket.
  // visibilitychange covers the phone; focus covers a desktop tab switch.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderConditions(); });
  window.addEventListener('focus', renderConditions);

  const anatomyOpenBtn = $('bx-anatomy-open');
  if (anatomyOpenBtn) anatomyOpenBtn.addEventListener('click', openAnatomyEditor);

  // Metric / imperial (yards) toggle — the units support was built but had no UI.
  const unitBtnM = $('bx-units-m'), unitBtnYd = $('bx-units-yd');
  function syncUnitsToggle() {
    const imp = state.settings.units === 'imperial';
    if (unitBtnM) {
      unitBtnM.classList.toggle('on', !imp);
      unitBtnM.setAttribute('aria-pressed', imp ? 'false' : 'true');
    }
    if (unitBtnYd) {
      unitBtnYd.classList.toggle('on', imp);
      unitBtnYd.setAttribute('aria-pressed', imp ? 'true' : 'false');
    }
  }
  function setUnits(u) {
    state.settings.units = u; saveSettingsToStorage();
    writeSharedUnitsDist(u === 'imperial' ? 'yd' : 'm');
    // Every surface carries units now: profile bar (zero chips + summary),
    // output card, chart axis + its summary line, and the slider's aria.
    syncUnitsToggle(); renderAll(); renderDropChart(); bxPaintChartSummary();
  }
  bxPaintChartSummary();
  if (unitBtnM) unitBtnM.addEventListener('click', () => setUnits('metric'));
  if (unitBtnYd) unitBtnYd.addEventListener('click', () => setUnits('imperial'));
  // 14.03 (units audit): the diary's Units card writes the same shared key
  // from its own tab. 'storage' fires only in OTHER tabs — exactly the gap —
  // so an already-open calculator follows a diary-side flip live.
  window.addEventListener('storage', (e) => {
    if (e.key !== FL_UNITS_KEY) return;
    const u = readSharedUnits();
    const next = (u && u.dist === 'yd') ? 'imperial' : 'metric';
    if (next === state.settings.units) return;
    state.settings.units = next;
    saveSettingsToStorage();
    syncUnitsToggle(); renderAll(); renderDropChart(); bxPaintChartSummary();
  });
  syncUnitsToggle();

  const jurSelect = $('bx-jurisdiction');
  if (jurSelect) {
    jurSelect.innerHTML = JURISDICTIONS.map(j =>
      `<option value="${j.code}" ${j.code === state.settings.jurisdiction ? 'selected' : ''}>${escapeHtml(j.label)}</option>`).join('');
    jurSelect.addEventListener('change', () => {
      state.settings.jurisdiction = jurSelect.value;
      // Profile bar too: the lead-free CTA's 2029-ban claim is
      // jurisdiction-gated (BA-5), so it must not go stale on a switch.
      saveSettingsToStorage(); renderProfileBar(); renderOutput();
    });
  }

  const exportA6 = $('bx-export-a6');
  if (exportA6) exportA6.addEventListener('click', () => openDopeCardOptions('A6'));
  const exportA4 = $('bx-export-a4');
  if (exportA4) exportA4.addEventListener('click', () => openDopeCardOptions('A4'));

  // Drop curve is collapsed by default (progressive disclosure). Its canvas
  // has zero width while the <details> is closed, so redraw when it opens.
  const chartDetails = $('bx-chart-details');
  if (chartDetails) chartDetails.addEventListener('toggle', () => { if (chartDetails.open) renderDropChart(); });

  // If pre-release law data, show banner.
  if (!flUkDeerLawVerified) {
    const banner = $('bx-law-banner');
    if (banner) banner.style.display = 'block';
  }

  // Escape closes any open modal (basic dialog accessibility).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = $('bx-modal');
      if (m && m.style.display === 'flex') closeModal();
    }
  });

  // Night / low-light mode toggle — injected into the header (no HTML change,
  // so it can't collide with the stale-mount ballistics.html). A red-tinted,
  // dimmed theme protects the stalker's dark adaptation at dawn/dusk.
  const hdr = document.querySelector('.bx-hdr');
  if (hdr && !$('bx-night-toggle')) {
    const btn = document.createElement('button');
    btn.id = 'bx-night-toggle';
    btn.type = 'button';
    btn.className = 'bx-night-toggle';
    btn.title = 'Night / low-light mode — red tint protects dark adaptation';
    btn.addEventListener('click', () => applyNightMode(!state.settings.nightMode, true));
    hdr.appendChild(btn);
  }
  applyNightMode(state.settings.nightMode, false);

  // Reticle-hold section — injected once as a sibling after #bx-output so its
  // <details> open/closed state survives the per-tick renderOutput (which only
  // rewrites #bx-output's own innerHTML). renderReticleHold fills the body.
  const outEl = $('bx-output');
  // 12.95: zone chips are re-rendered with every tick — one delegated
  // listener on the container survives that, exactly why it's not per-button.
  if (outEl) {
    outEl.addEventListener('click', (e) => {
      const b = e.target && e.target.closest && e.target.closest('[data-bx-zone]');
      if (!b) return;
      const v = b.getAttribute('data-bx-zone');
      state.settings.pbrZoneCm = v === 'species' ? null : Number(v);
      saveSettingsToStorage();
      renderOutput();
    });
  }
  if (outEl && !$('bx-reticle-details')) {
    const det = document.createElement('details');
    det.id = 'bx-reticle-details';
    det.className = 'bx-reticle-details';
    det.innerHTML = `<summary class="bx-rc-summary bx-reticle-summary"><span class="bx-rc-status" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="4.6"/><path d="M8 1v2.4M8 12.6V15M1 8h2.4M12.6 8H15" stroke-linecap="round"/></svg></span><span class="bx-rc-summary-title">Reticle hold</span></summary><div id="bx-reticle-body"></div>`;
    outEl.insertAdjacentElement('afterend', det);
  }

  renderAll();

  // First-run gate: show acceptance modal if the user has never accepted.
  // This must run AFTER renderAll() so the calculator is visible behind the
  // modal — that way the user sees what they're accepting use of, not a
  // blank page. The setup wizard (if needed) opens after acceptance.
  const accepted = (() => {
    try { return localStorage.getItem(ACCEPTANCE_KEY) === '1'; } catch (e) { return false; }
  })();
  if (!accepted) {
    showAcceptanceGate(() => {
      // Once accepted, kick off the setup wizard for first-time users.
      if (state.profiles.length === 0) {
        setTimeout(openSetupWizard, 100);
      }
    });
  } else if (state.profiles.length === 0) {
    // User has accepted previously but has no profiles (e.g. cleared them).
    setTimeout(openSetupWizard, 250);
  }
}

/**
 * One-time acceptance gate shown on first launch. The user cannot dismiss
 * this without tapping "I understand" — there is no close button or
 * background-click-to-dismiss. The gate persists in localStorage under
 * ACCEPTANCE_KEY so it shows exactly once per device per browser profile.
 *
 * @param {Function} onAccepted  Callback fired once the user accepts.
 */
function showAcceptanceGate(onAccepted) {
  const modal = $('bx-modal');
  if (!modal) {
    // Defensive: if for some reason the modal element isn't in the DOM,
    // log it but don't block the user. The footer disclaimer remains.
    console.warn('[ballistics] no #bx-modal element; acceptance gate skipped');
    if (onAccepted) onAccepted();
    return;
  }
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="bx-modal-card bx-acceptance-card">
      <div class="bx-acceptance-title">Before you use this calculator</div>
      <div class="bx-acceptance-body">
        <p><strong>First Light is a planning aid for trained deer stalkers.</strong>
        Outputs are guidance only — they are not a substitute for chronographing
        your loads, zeroing your rifle, or knowing the law in your jurisdiction.</p>
        <p>The stalker is responsible for every shot. You must verify that:</p>
        <ul>
          <li>Your ammunition meets the legal calibre, bullet, and energy
              requirements for the deer species and jurisdiction you are stalking.</li>
          <li>Your rifle is correctly zeroed for the ammunition you are using.</li>
          <li>The shot is safe, ethical, and within your competence.</li>
        </ul>
        <p>Manufacturer ballistic data in this app is from published test-barrel
        measurements; your actual rifle will differ. Statutory thresholds reflect
        UK deer law as of the data version shown — the law can change. Always
        check the current statutory text for your jurisdiction before relying on
        the legal compliance section for borderline shots.</p>
      </div>
      <div class="bx-modal-actions">
        <button class="bx-btn" id="bx-acceptance-ok" type="button">I understand</button>
      </div>
    </div>
  `;
  $('bx-acceptance-ok').addEventListener('click', () => {
    try { localStorage.setItem(ACCEPTANCE_KEY, '1'); } catch (e) { /* non-fatal */ }
    closeModal();
    if (onAccepted) onAccepted();
  });
}
