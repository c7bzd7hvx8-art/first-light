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
  airDensityRatio, ATM_STD,
} from '../lib/fl-ballistics.js';
import {
  getCalibres, getManufacturers, getCalibresWithLoads,
  getManufacturersForCalibre, getLoadsFor, getLoadById,
  getCalibreById, getManufacturerById,
  searchLoads, loadDisplayName, preferredBcFor,
} from '../lib/fl-ammo.js';
import {
  flUkDeerLawVerified, DEER_SPECIES, JURISDICTIONS, LEAD_AMMO_RESTRICTION,
  thresholdFor, minMuzzleEnergyFor,
} from '../lib/fl-deer-law.js';
import {
  getAnatomicalHold, AIM_POINTS, DEFAULT_AIM_POINT, listAimPoints,
  SPECIES_BODY, listSpeciesForAnatomy, renderDeerSilhouette,
} from '../lib/fl-anatomy.js';
import {
  findLeadFreeAlternatives,
} from '../lib/fl-lead-free-matcher.js';
import { buildDopeCardPDF, downloadDopeCardPDF } from './dope-card.js';
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
const state = {
  db: null,                 // ammo-loads.json contents
  profiles: [],             // [{id, name, ...}]
  activeProfileId: null,
  conditions: {             // can be auto-filled or manual
    tempC: ATM_STD.temperatureC,
    pressureHpa: ATM_STD.pressureHpa,
    humidityPct: 50,
    windMps: 0,
    windDirDeg: 0,          // 0 = headwind, 90 = full crosswind from R
    shotAngleDeg: 0,
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
  },
};

// ── Storage ──────────────────────────────────────────────────────────────

function loadProfilesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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
  const bc = preferredBcFor(load);
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
  if (profile.chronoMv && profile.chronoMv > 0) return profile.chronoMv;
  return profile.muzzleVelocityFps;
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

function getActiveProfile() {
  return state.profiles.find(p => p.id === state.activeProfileId) || null;
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
function computeDropCurve(maxRangeM) {
  const p = getActiveProfile();
  if (!p) return [];
  const points = [];
  for (let r = 25; r <= maxRangeM; r += 10) {
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
    state.conditions.tempC = c.temperature_2m ?? state.conditions.tempC;
    state.conditions.pressureHpa = c.surface_pressure ?? state.conditions.pressureHpa;
    state.conditions.humidityPct = c.relative_humidity_2m ?? state.conditions.humidityPct;
    state.conditions.windMps = c.wind_speed_10m ?? state.conditions.windMps;
    state.conditions.windDirDeg = c.wind_direction_10m ?? state.conditions.windDirDeg;
    saveSettingsToStorage();
    renderConditions();
    renderOutput();
    toast('Conditions updated from location', 'ok');
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
 *   'unknown' — actual value missing (e.g. profile lacks construction tag)
 *
 * The four checks are:
 *   muzzleEnergy   — profile MV+weight → ME (ft-lb) vs threshold
 *   muzzleVelocity — profile MV (fps) vs threshold (Scotland-only)
 *   bulletWeight   — profile bullet weight (gr) vs threshold
 *   calibre        — calibre diameter (inches) vs threshold
 *   construction   — load construction is expanding-type
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
  const calibreDiameter = load ? CALIBRE_DIAMETER_INCHES[load.calibre] : null;

  // Construction: expanding-type means anything other than FMJ or
  // unspecified non-expanding. Subsonic loads with bonded soft-points
  // count as expanding; Federal/Remington 190gr Subsonic loads have
  // non-expanding designs by default but the verified seed marks these
  // explicitly. Treat null/missing as 'unknown' rather than fail-shut.
  const isExpanding = load
    ? (load.construction !== 'fmj' && load.construction !== 'subsonic-non-expanding')
    : null;

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
  } else {
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
      checks.push({
        kind: 'bulletWeight', label: 'Bullet weight',
        status: profile.weightGrains >= t.minBulletWeightGrains ? 'pass' : 'fail',
        detail: profile.weightGrains >= t.minBulletWeightGrains
          ? null
          : `Below ${t.minBulletWeightGrains} gr minimum`,
        statutoryValue: t.minBulletWeightGrains + ' gr',
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
      checks.push({
        kind: 'calibre', label: 'Calibre',
        status: passes ? 'pass' : 'fail',
        detail: passes ? null : `Below .${Math.round(t.minCalibreInches * 1000)}" minimum`,
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
    checks.push({
      kind: 'construction', label: 'Bullet type',
      status: 'unknown',
      detail: 'Construction not recorded — verify your ammunition is expanding type',
      statutoryValue: 'Expanding',
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
  // Chronograph status — shown next to the summary if a chrono override is set.
  const chronoBadge = (() => {
    if (!p.chronoMv || p.chronoMv <= 0) return '';
    const delta = p.chronoMv - p.muzzleVelocityFps;
    const sign = delta >= 0 ? '+' : '';
    const ageMs = p.chronoDateMs ? (Date.now() - p.chronoDateMs) : null;
    const monthsOld = ageMs != null ? Math.round(ageMs / (1000 * 60 * 60 * 24 * 30)) : null;
    const stale = monthsOld != null && monthsOld >= 12;
    return `<span class="bx-profile-chrono ${stale ? 'bx-profile-chrono-stale' : ''}" title="Calculations use your chronographed MV (${p.chronoMv} fps), not the published value (${p.muzzleVelocityFps} fps).${stale ? ' Last chrono ' + monthsOld + ' months ago — consider re-checking.' : ''}">📏 ${sign}${delta} fps${stale ? ' · ⚠ stale' : ''}</span>`;
  })();
  // Lead-free matcher button shows only when the active profile is built
  // from a known lead load. Custom profiles, lead-free loads, and unknown
  // load IDs all suppress the button — there's no useful answer to give.
  const sourceLoad = p.loadId ? getLoadById(state.db, p.loadId) : null;
  const showLeadFreeBtn = sourceLoad && sourceLoad.leadFree === false && !p.custom;
  bar.innerHTML = `
    <div class="bx-profile-name">${escapeHtml(p.name)}${chronoBadge ? ' ' + chronoBadge : ''}</div>
    <div class="bx-profile-summary">${escapeHtml(summary)} · ${p.zeroRangeM}m zero</div>
    ${p.notes ? `<div class="bx-profile-notes">${escapeHtml(p.notes)}</div>` : ''}
    <div class="bx-profile-actions">
      <button class="bx-link" id="bx-profile-edit-btn">Edit</button>
      ${state.profiles.length > 1
        ? `<button class="bx-link" id="bx-profile-switch-btn">Switch</button>` : ''}
      ${showLeadFreeBtn
        ? `<button class="bx-link" id="bx-profile-leadfree-btn" title="Find lead-free factory loads with similar trajectory">Find lead-free</button>` : ''}
      <button class="bx-link" id="bx-profile-compare-btn" title="Side-by-side comparison with another factory load">Compare</button>
      <button class="bx-link" id="bx-profile-add-btn">+ Add</button>
    </div>
  `;
  $('bx-profile-edit-btn').addEventListener('click', () => openProfileEditor(p.id));
  $('bx-profile-add-btn').addEventListener('click', openSetupWizard);
  $('bx-profile-compare-btn').addEventListener('click', openLoadComparator);
  if (state.profiles.length > 1) {
    $('bx-profile-switch-btn').addEventListener('click', openProfileSwitcher);
  }
  if (showLeadFreeBtn) {
    $('bx-profile-leadfree-btn').addEventListener('click', openLeadFreeMatcher);
  }
}

function renderRangeControl() {
  const slider = $('bx-range-slider');
  const display = $('bx-range-display');
  if (!slider || !display) return;
  slider.value = state.rangeM;
  const yd = metresToYards(state.rangeM);
  display.innerHTML = state.settings.units === 'imperial'
    ? `<span class="bx-range-num">${Math.round(yd)}</span><span class="bx-range-unit">yd</span>`
    : `<span class="bx-range-num">${state.rangeM}</span><span class="bx-range-unit">m</span>`;
}

function renderConditions() {
  const strip = $('bx-conditions-strip');
  if (!strip) return;
  const c = state.conditions;
  strip.innerHTML = `
    <span><strong>${c.tempC.toFixed(0)}°C</strong></span>
    <span class="bx-sep">·</span>
    <span><strong>${c.pressureHpa.toFixed(0)}</strong> hPa</span>
    <span class="bx-sep">·</span>
    <span>${c.windMps > 0 ? `<strong>${c.windMps.toFixed(1)}</strong> m/s wind` : 'No wind'}</span>
    ${c.shotAngleDeg !== 0 ? `<span class="bx-sep">·</span><span>${c.shotAngleDeg > 0 ? '↑' : '↓'} ${Math.abs(c.shotAngleDeg)}°</span>` : ''}
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
  if (!r) {
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
    ? `−${energyDropPct}% from muzzle (${Math.round(muzzleE)} ft-lb)`
    : '';

  // MOA / MIL displayed using the ammo-box / dope-card convention:
  //   negative = bullet below LoS at this range (the typical case past zero)
  //   positive = bullet above LoS (short of zero, or after a high arc)
  // Matches what's printed on Hornady / Federal ammo boxes ("300 yds  -6.4""
  // means 6.4" below LoS at 300 yards) and the dope-card PDF this app
  // produces (modules/dope-card.js:246-256). The solver internally uses
  // positive-down (positive dropMoa = below LoS), which is the natural
  // convention for the maths but is the inverse of the printed convention,
  // so we negate at the display boundary. Do NOT touch the solver to "fix"
  // this — many tests assert solver output in positive-down.
  // Note: the cm value above pairs an arrow with a magnitude (action-oriented:
  // ↑ = hold up); MOA/MIL stay signed to match the printed dope card the
  // stalker carries in their rifle case.
  const moaDisplay = -r.dropMoa;
  const milDisplay = -r.dropMil;
  const moaStr = (moaDisplay >= 0 ? '+' : '') + moaDisplay.toFixed(1);
  const milStr = (milDisplay >= 0 ? '+' : '') + milDisplay.toFixed(2);

  // ── Anatomical hold (Phase 1 feature) ──────────────────────────────
  // Translates the cm/MOA hold into a textual reference on the deer's
  // body. Only shown if the user has enabled it. Excluded for muntjac
  // and CWD which are too small for the heuristic to be useful.
  let anatomyHtml = '';
  if (state.settings.anatomyEnabled) {
    const anat = getAnatomicalHold({
      dropCm: r.dropCm,
      speciesKey: state.settings.anatomySpecies,
      sex: state.settings.anatomySex,
      aimPointKey: state.settings.anatomyAimPoint,
    });
    if (anat.ok) {
      const sp = SPECIES_BODY[state.settings.anatomySpecies];
      const sexLabel = sexLabelFor(state.settings.anatomySpecies, state.settings.anatomySex);
      const aim = AIM_POINTS[state.settings.anatomyAimPoint];
      const silhouetteSvg = renderDeerSilhouette({
        dropCm: r.dropCm,
        speciesKey: state.settings.anatomySpecies,
        sex: state.settings.anatomySex,
        aimPointKey: state.settings.anatomyAimPoint,
        compact: true,
      });
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
            <span class="bx-sep">·</span>
            chest ~${anat.chestDepthCm} cm
          </div>
          <div class="bx-anatomy-silhouette">${silhouetteSvg}</div>
          <div class="bx-anatomy-text">${escapeHtml(anat.text).replace(/^Hold /, `Hold <span class="bx-anat-arrow">${dropArrow}</span> `)}</div>
          ${anat.warning ? `<div class="bx-anatomy-warn">⚠ ${escapeHtml(anat.warning)}</div>` : ''}
          <div class="bx-anatomy-disclaimer">
            Approximate guide based on average body dimensions. Real animals
            vary. The stalker is responsible for the shot.
          </div>
        </div>
      `;
    }
  }

  out.innerHTML = `
    <div class="bx-output-card">
      <div class="bx-output-section">
        <div class="bx-output-label">Hold</div>
        <div class="bx-output-hold">
          <span class="bx-output-arrow">${dropArrow}</span>
          <span class="bx-output-bignum">${dropMag.toFixed(1)}</span>
          <span class="bx-output-bigunit">cm${holdWord ? ' ' + holdWord : ''}</span>
        </div>
        <div class="bx-output-sub" title="Drop in scope-adjustment units, signed: negative = bullet below LoS (dial UP that many to compensate); positive = above LoS at this range (dial DOWN). Same sign convention as your printed dope card.">
          <span>${moaStr} MOA</span>
          <span class="bx-sep">·</span>
          <span>${milStr} MIL</span>
        </div>
      </div>

      ${anatomyHtml}

      <div class="bx-output-section">
        <div class="bx-output-label">Energy at target</div>
        <div class="bx-output-energy">
          <span class="bx-output-bignum">${Math.round(r.energyFtLbs)}</span>
          <span class="bx-output-bigunit">ft-lb</span>
        </div>
        <div class="bx-output-sub">
          ${Math.round(r.energyJ)} J
          ${energyDropNote ? '<span class="bx-sep">·</span><span class="bx-energy-drop">' + escapeHtml(energyDropNote) + '</span>' : ''}
        </div>
      </div>

      <div class="bx-output-section">
        <div class="bx-output-label">Velocity at target</div>
        <div class="bx-output-vel">
          <span class="bx-output-bignum">${Math.round(r.velocityFps)}</span>
          <span class="bx-output-bigunit">fps</span>
          <span class="bx-output-secondary">${Math.round(r.velocityMs)} m/s</span>
        </div>
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
              MV from manufacturer ${sourceLoad.testBarrelInches}″ test barrel.
              Your rifle's actual MV may differ — chronograph if accuracy matters at range.
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
          const muzzleFps = p.muzzleVelocityFps;
          const muzzleMach = muzzleFps / 1125;  // approx — Mach 1 ≈ 1125 fps at 15°C
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
          if (r.isSubsonic && !startedSupersonic) {
            // Deliberate subsonic — informational only, not a warning.
            return `<div class="bx-output-note">
              Subsonic load — designed for sub-transonic flight.
              Maximum effective range is typically much shorter than supersonic
              loads of similar weight; verify with the manufacturer.
            </div>`;
          }
          return '';
        })()}
      </div>

      ${r.windDriftCm !== 0
        ? `<div class="bx-output-section">
            <div class="bx-output-label">Wind drift</div>
            <div class="bx-output-sub">
              ${Math.abs(r.windDriftCm).toFixed(1)} cm
              <span class="bx-sep">·</span>
              ${r.windDriftMoa.toFixed(1)} MOA
            </div>
          </div>` : ''}

      ${state.rangeM > 400
        ? `<div class="bx-output-section bx-longrange-section">
            <div class="bx-output-label">Long-range effects (not modelled)</div>
            <div class="bx-longrange-note">
              At this range, two effects the calculator does <strong>not</strong> model
              can shift impact by several centimetres each:
            </div>
            <ul class="bx-longrange-list">
              <li>
                <strong>Spin drift:</strong> right-twist barrels (most rifles) drift the
                bullet ~${Math.round((state.rangeM - 300) * 0.04 + 5)}&nbsp;cm to the right at this range.
                Left-twist drifts left.
              </li>
              <li>
                <strong>Coriolis:</strong> at UK latitudes (~50–60°N), Coriolis can shift
                impact ±${Math.round((state.rangeM - 300) * 0.025 + 3)}&nbsp;cm depending on
                shooting bearing — east-shooting shifts up, west-shooting shifts down,
                lateral shift varies with bearing.
              </li>
            </ul>
            <div class="bx-longrange-foot">
              Estimates only. Verify with live-fire at this range before relying on
              calculated drop for ethical shots.
            </div>
          </div>` : ''}

      ${renderComplianceSection(p, { state, checkLegalCompliance, checkAbsoluteFloor, escapeHtml })}

      ${renderEthicalRangeSection(p)}

      ${renderRangeCard(p, { state, solveProfileAt })}
    </div>
  `;

  // Wire up the anatomy "Settings" button if it was rendered.
  const anatBtn = $('bx-anatomy-edit');
  if (anatBtn) anatBtn.addEventListener('click', openAnatomyEditor);

  renderDropChart();
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

/**
 * For each species in the user's filter that has a published muzzle
 * energy minimum in the active jurisdiction, return the range (rounded
 * down to nearest 10m) at which retained energy falls below that
 * minimum. Returns null for species without a threshold (e.g. muntjac
 * in Scotland, where no muzzle-energy minimum is specified).
 */
function computeEthicalMaxRanges(profile) {
  const out = [];
  for (const speciesCode of state.settings.speciesFilter) {
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
      });
      continue;
    }
    // Probe outward from 25m until energy drops below the threshold.
    let lastValidRange = null;
    for (let r = 25; r <= ETHICAL_RANGE_MAX_PROBE_M; r += ETHICAL_RANGE_SAMPLE_STEP_M) {
      const sol = solveProfileAt(profile, r);
      if (!sol) break;
      if (sol.energyFtLbs >= minFtLb) {
        lastValidRange = r;
      } else {
        break;
      }
    }
    out.push({
      species: speciesCode,
      speciesLabel: speciesObj.label,
      thresholdFtLb: minFtLb,
      maxRangeM: lastValidRange,
    });
  }
  return out;
}

function renderEthicalRangeSection(profile) {
  if (!profile) return '';
  const ranges = computeEthicalMaxRanges(profile);
  if (ranges.length === 0) return '';

  const items = ranges.map(r => {
    if (r.thresholdFtLb == null) {
      return `
        <div class="bx-eth-row">
          <span class="bx-eth-species">${escapeHtml(r.speciesLabel)}</span>
          <span class="bx-eth-range bx-eth-na">no statutory minimum</span>
        </div>`;
    }
    if (r.maxRangeM == null) {
      // Energy is below threshold even at 25m — not legal at any range.
      return `
        <div class="bx-eth-row bx-eth-row-fail">
          <span class="bx-eth-species">${escapeHtml(r.speciesLabel)}</span>
          <span class="bx-eth-range">below ${r.thresholdFtLb} ft-lb at all ranges</span>
        </div>`;
    }
    if (r.maxRangeM >= ETHICAL_RANGE_MAX_PROBE_M) {
      return `
        <div class="bx-eth-row">
          <span class="bx-eth-species">${escapeHtml(r.speciesLabel)}</span>
          <span class="bx-eth-range">${r.maxRangeM}m+ <span class="bx-eth-threshold">(${r.thresholdFtLb} ft-lb)</span></span>
        </div>`;
    }
    return `
      <div class="bx-eth-row">
        <span class="bx-eth-species">${escapeHtml(r.speciesLabel)}</span>
        <span class="bx-eth-range">${r.maxRangeM}m <span class="bx-eth-threshold">(${r.thresholdFtLb} ft-lb)</span></span>
      </div>`;
  }).join('');

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

  const maxRange = 400;
  const curve = computeDropCurve(maxRange);
  if (curve.length < 2) return;

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
  for (let r = 100; r <= maxRange; r += 100) {
    const x = xAt(r);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ch); ctx.stroke();
    ctx.fillText(r + 'm', x - 12, H - 8);
  }
  // y=0 line
  const y0 = yAt(0);
  ctx.strokeStyle = 'rgba(200,168,75,0.3)';
  ctx.beginPath(); ctx.moveTo(pad.l, y0); ctx.lineTo(pad.l + cw, y0); ctx.stroke();
  ctx.fillStyle = 'rgba(200,168,75,0.6)';
  ctx.fillText('0', pad.l - 14, y0 + 3);

  // Energy threshold shading: red zone where energy < threshold for the
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
      ctx.fillStyle = 'rgba(198,40,40,0.10)';
      ctx.fillRect(xAt(belowFromR), pad.t, xAt(maxRange) - xAt(belowFromR), ch);
      // Vertical line at threshold
      ctx.strokeStyle = 'rgba(198,40,40,0.5)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(xAt(belowFromR), pad.t);
      ctx.lineTo(xAt(belowFromR), pad.t + ch);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(198,40,40,0.85)';
      ctx.font = '9px "DM Mono", monospace';
      ctx.fillText('< ' + thresholdFtLb + ' ft-lb', xAt(belowFromR) + 4, pad.t + 12);
    }
  }

  // Trajectory curve
  ctx.strokeStyle = '#c8a84b';
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
  ctx.strokeStyle = 'rgba(122,223,122,0.7)';
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
            <option value="100" ${wizard.zeroRangeM===100?'selected':''}>100 m</option>
            <option value="150" ${wizard.zeroRangeM===150?'selected':''}>150 m</option>
            <option value="200" ${wizard.zeroRangeM===200?'selected':''}>200 m</option>
          </select>
        </div>
        <div class="bx-field">
          <label for="bx-w-sight">Sight height above bore (cm)</label>
          <input type="number" id="bx-w-sight" min="2" max="10" step="0.1" value="${wizard.sightHeightCm}">
          <div class="bx-field-hint">Typical 3.8–4.5cm for standard scope rings</div>
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
            <button class="bx-tab ${!wizard.manual?'on':''}" data-tab="factory">Factory load</button>
            <button class="bx-tab ${wizard.manual?'on':''}" data-tab="manual">Manual entry</button>
          </div>
          ${wizard.manual ? `
            <div class="bx-row-2">
              <div class="bx-field"><label>Muzzle velocity (fps)</label><input type="number" id="bx-w-mv" value="${wizard.muzzleVelocityFps}"></div>
              <div class="bx-field"><label>Bullet weight (gr)</label><input type="number" id="bx-w-wt" value="${wizard.weightGrains}"></div>
            </div>
            <div class="bx-row-2">
              <div class="bx-field"><label>BC (G1)</label><input type="number" id="bx-w-bc1" step="0.001" value="${wizard.bcG1}"></div>
              <div class="bx-field"><label>BC (G7) — optional</label><input type="number" id="bx-w-bc7" step="0.001" value="${wizard.bcG7}"></div>
            </div>
          ` : `
            <div class="bx-row-2">
              <div class="bx-field">
                <label>Calibre</label>
                <select id="bx-w-cal">
                  <option value="">— pick —</option>
                  ${cals.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
                </select>
              </div>
              <div class="bx-field">
                <label>Manufacturer</label>
                <select id="bx-w-mfr"><option value="">—</option></select>
              </div>
            </div>
            <div class="bx-field">
              <label>Load</label>
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
      wizard.zeroRangeM = parseInt($('bx-w-zero')?.value, 10) || 100;
      wizard.sightHeightCm = parseFloat($('bx-w-sight')?.value) || 4.0;
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
  } else {
    // ok — render the matches
    const ranges = result.sourceTrajectory.map(r => r.rangeM);
    const headerCells = ranges.map(r => `<th>${r}m</th>`).join('');
    const sourceDropRow = result.sourceTrajectory.map(r => `<td>${r.dropCm.toFixed(1)} cm</td>`).join('');
    const sourceEnergyRow = result.sourceTrajectory.map(r => `<td>${Math.round(r.energyFtLbs)} ft·lb</td>`).join('');

    body = `
      <table class="bx-lf-table bx-lf-source-table">
        <thead><tr><th></th>${headerCells}</tr></thead>
        <tbody>
          <tr><th>Drop (100m zero)</th>${sourceDropRow}</tr>
          <tr><th>Energy</th>${sourceEnergyRow}</tr>
        </tbody>
      </table>
      <div class="bx-lf-matches-label">Closest lead-free options</div>
    `;

    for (const m of result.matches) {
      const candDropRow = m.trajectory.map(r => `<td>${r.dropCm.toFixed(1)} cm</td>`).join('');
      const candEnergyRow = m.trajectory.map(r => `<td>${Math.round(r.energyFtLbs)} ft·lb</td>`).join('');
      const deltaDropRow = m.deltas.map(d => {
        const sign = d.dropDeltaCm > 0 ? '+' : '';
        const cls = Math.abs(d.dropDeltaCm) < 2 ? 'bx-lf-good' : (Math.abs(d.dropDeltaCm) < 6 ? 'bx-lf-mid' : 'bx-lf-poor');
        return `<td class="${cls}">${sign}${d.dropDeltaCm.toFixed(1)} cm</td>`;
      }).join('');
      const deltaEnergyRow = m.deltas.map(d => {
        const sign = d.energyDeltaPct > 0 ? '+' : '';
        const cls = Math.abs(d.energyDeltaPct) < 5 ? 'bx-lf-good' : (Math.abs(d.energyDeltaPct) < 12 ? 'bx-lf-mid' : 'bx-lf-poor');
        return `<td class="${cls}">${sign}${d.energyDeltaPct.toFixed(1)}%</td>`;
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
            <thead><tr><th></th>${headerCells}</tr></thead>
            <tbody>
              <tr><th>Drop</th>${candDropRow}</tr>
              <tr><th>Energy</th>${candEnergyRow}</tr>
              <tr><th>Δ drop</th>${deltaDropRow}</tr>
              <tr><th>Δ energy</th>${deltaEnergyRow}</tr>
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
      const headerCells = COMPARE_RANGES_M.map(r => `<th>${r}m</th>`).join('');

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
        return `<tr><th>${label}</th>${cells}</tr>`;
      };

      const rowEnergy = (label, solver) => {
        const cells = COMPARE_RANGES_M.map(r => {
          const s = solver(r);
          if (!s) return '<td>—</td>';
          return `<td>${Math.round(s.energyFtLbs)} ft·lb</td>`;
        }).join('');
        return `<tr><th>${label}</th>${cells}</tr>`;
      };

      const rowVel = (label, solver) => {
        const cells = COMPARE_RANGES_M.map(r => {
          const s = solver(r);
          if (!s) return '<td>—</td>';
          return `<td>${Math.round(s.velocityFps)} fps</td>`;
        }).join('');
        return `<tr><th>${label}</th>${cells}</tr>`;
      };

      const rowWind = (label, solver) => {
        const cells = COMPARE_RANGES_M.map(r => {
          const s = solver(r);
          if (!s) return '<td>—</td>';
          return `<td>${s.windDriftCm.toFixed(1)} cm</td>`;
        }).join('');
        return `<tr><th>${label}</th>${cells}</tr>`;
      };

      const rowDelta = (label, solver1, solver2, fmt, unit) => {
        const cells = COMPARE_RANGES_M.map(r => {
          const a = solver1(r), b = solver2(r);
          if (!a || !b) return '<td>—</td>';
          const delta = fmt(a, b);
          const sign = delta > 0 ? '+' : '';
          return `<td>${sign}${delta.toFixed(1)} ${unit}</td>`;
        }).join('');
        return `<tr class="bx-cmp-delta"><th>${label}</th>${cells}</tr>`;
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
            <thead><tr><th></th>${headerCells}</tr></thead>
            <tbody>
              <tr class="bx-cmp-section"><th colspan="${COMPARE_RANGES_M.length + 1}">Drop (positive = dial UP)</th></tr>
              ${rowDrop('Your load', profSolver)}
              ${rowDrop('Candidate', candSolver)}
              ${rowDelta('Δ', profSolver, candSolver, (a, b) => -b.dropCm - (-a.dropCm), 'cm')}
              <tr class="bx-cmp-section"><th colspan="${COMPARE_RANGES_M.length + 1}">Energy</th></tr>
              ${rowEnergy('Your load', profSolver)}
              ${rowEnergy('Candidate', candSolver)}
              ${rowDelta('Δ', profSolver, candSolver, (a, b) => b.energyFtLbs - a.energyFtLbs, 'ft·lb')}
              <tr class="bx-cmp-section"><th colspan="${COMPARE_RANGES_M.length + 1}">Velocity</th></tr>
              ${rowVel('Your load', profSolver)}
              ${rowVel('Candidate', candSolver)}
              ${showWind ? `
                <tr class="bx-cmp-section"><th colspan="${COMPARE_RANGES_M.length + 1}">Wind drift (${state.conditions.windMps.toFixed(1)} m/s crosswind)</th></tr>
                ${rowWind('Your load', profSolver)}
                ${rowWind('Candidate', candSolver)}
              ` : ''}
            </tbody>
          </table>
          <div class="bx-cmp-disclosure">
            Solved at your current conditions (${state.conditions.tempC.toFixed(0)}°C, ${state.conditions.pressureHpa.toFixed(0)} hPa, ${state.conditions.humidityPct.toFixed(0)}% RH) and your active profile's zero (${profile.zeroRangeM}m).
            The candidate is solved as if loaded in your rifle (same sight height, same zero) — this is a comparison of ammunition through one rifle setup, not two different rifles.
            Δ rows show <strong>candidate minus your load</strong>: positive Δ drop means the candidate hits lower; positive Δ energy means the candidate hits harder.
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
              <label>Calibre</label>
              <select id="bx-cmp-cal">
                <option value="">— pick —</option>
                ${cals.map(c => `<option value="${c.id}" ${c.id === ui.calibreId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>
            <div class="bx-field">
              <label>Manufacturer</label>
              <select id="bx-cmp-mfr" ${ui.calibreId ? '' : 'disabled'}>
                <option value="">— pick —</option>
                ${mfrs.map(m => `<option value="${m.id}" ${m.id === ui.manufacturerId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="bx-field">
            <label>Load</label>
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
        <div class="bx-field"><label>Name</label><input type="text" id="bx-e-name" value="${escapeHtml(p.name)}"></div>
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
          <div class="bx-field"><label>Muzzle velocity (fps)</label><input type="number" id="bx-e-mv" value="${p.muzzleVelocityFps}"></div>
          <div class="bx-field"><label>Bullet weight (gr)</label><input type="number" id="bx-e-wt" value="${p.weightGrains}"></div>
        </div>
        <div class="bx-row-2">
          <div class="bx-field"><label>BC (G1)</label><input type="number" id="bx-e-bc1" step="0.001" value="${p.bcG1}"></div>
          <div class="bx-field"><label>BC (G7)</label><input type="number" id="bx-e-bc7" step="0.001" value="${p.bcG7}"></div>
        </div>
        <div class="bx-row-2">
          <div class="bx-field"><label>Sight height (cm)</label><input type="number" id="bx-e-sh" step="0.1" value="${p.sightHeightCm}"></div>
          <div class="bx-field"><label>Zero range (m)</label><input type="number" id="bx-e-zero" value="${p.zeroRangeM}"></div>
        </div>

        <div class="bx-field-section-label">Chronograph correction (optional)</div>
        <div class="bx-row-2">
          <div class="bx-field">
            <label>Your measured MV (fps)</label>
            <input type="number" id="bx-e-chrono-mv" placeholder="(none)" value="${p.chronoMv || ''}">
          </div>
          <div class="bx-field">
            <label>Date measured</label>
            <input type="date" id="bx-e-chrono-date" value="${chronoDateStr}">
          </div>
        </div>
        <div class="bx-field-hint">
          If you've chronographed your rifle with this load, enter the actual measured MV here.
          Calculations will use this value while keeping the published MV (${p.muzzleVelocityFps} fps) on record for reference.
          ${chronoDelta !== 0 ? `<br><strong>Current delta: ${chronoDelta > 0 ? '+' : ''}${chronoDelta} fps from published.</strong>` : ''}
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
          <label>Notes (optional)</label>
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
    if (!confirm('Delete this profile?')) return;
    state.profiles = state.profiles.filter(x => x.id !== p.id);
    if (state.activeProfileId === p.id) state.activeProfileId = state.profiles[0]?.id || null;
    saveProfilesToStorage(); saveSettingsToStorage();
    closeModal(); renderAll();
  });
  $('bx-e-save').addEventListener('click', () => {
    const newMv = parseFloat($('bx-e-mv').value);
    const newW = parseFloat($('bx-e-wt').value);
    const newBc1 = parseFloat($('bx-e-bc1').value);
    const newBc7 = parseFloat($('bx-e-bc7').value);
    if (!(newMv > 0) || !(newW > 0)) { toast('MV and weight must be > 0', 'warn'); return; }
    if (!(newBc1 > 0 || newBc7 > 0)) { toast('Need at least one BC', 'warn'); return; }
    p.name = $('bx-e-name').value || p.name;
    if (newMv !== p.muzzleVelocityFps || newBc1 !== p.bcG1 || newBc7 !== p.bcG7) p.custom = true;
    p.muzzleVelocityFps = newMv;
    p.weightGrains = newW;
    p.bcG1 = newBc1; p.bcG7 = newBc7;
    p.sightHeightCm = parseFloat($('bx-e-sh').value) || p.sightHeightCm;
    p.zeroRangeM = parseInt($('bx-e-zero').value, 10) || p.zeroRangeM;
    // Chrono override
    const chronoMvRaw = $('bx-e-chrono-mv').value.trim();
    p.chronoMv = chronoMvRaw ? (parseFloat(chronoMvRaw) || null) : null;
    const chronoDateRaw = $('bx-e-chrono-date').value;
    p.chronoDateMs = (p.chronoMv && chronoDateRaw) ? Date.parse(chronoDateRaw) : null;
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
            <label>Calibre</label>
            <select id="bx-ca-cal">
              <option value="">— pick —</option>
              ${cals.map(c => `<option value="${c.id}"${c.id === initialCalId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="bx-field">
            <label>Manufacturer</label>
            <select id="bx-ca-mfr"><option value="">—</option></select>
          </div>
        </div>
        <div class="bx-field">
          <label>Load</label>
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
  const presets = [
    { code: 'roe',     label: 'Roe (35cm)',         cm: 35 },
    { code: 'muntjac', label: 'Muntjac/CWD (28cm)', cm: 28 },
    { code: 'fallow',  label: 'Fallow (50cm)',      cm: 50 },
    { code: 'sika',    label: 'Sika (50cm)',        cm: 50 },
    { code: 'red',     label: 'Red (70cm)',         cm: 70 },
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
          treat it as orientation, not gospel.
        </p>
        <div class="bx-field">
          <label>Deer (body depth)</label>
          <select id="bx-r-species">
            ${presets.map(p => `<option value="${p.cm}">${p.label}</option>`).join('')}
          </select>
        </div>
        <div class="bx-field">
          <label>Reticle measurement</label>
          <div class="bx-tabs">
            <button class="bx-tab on" data-unit="mil">MIL</button>
            <button class="bx-tab" data-unit="moa">MOA</button>
          </div>
          <input type="number" id="bx-r-value" step="0.1" min="0" placeholder="e.g. 1.6" autofocus>
        </div>
        <div id="bx-r-result" style="margin-top:18px;padding:14px;background:rgba(200,168,75,0.08);border:1px solid rgba(200,168,75,0.18);border-radius:10px;text-align:center;display:none;">
          <div style="font-size:11px;color:rgba(200,168,75,0.7);text-transform:uppercase;letter-spacing:0.5px;font-family:'DM Mono',monospace;">Estimated range</div>
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
      $('bx-r-range').innerHTML = `${lastRangeM} m <span style="font-size:11px;color:rgba(255,255,255,0.5);">— outside slider range</span>`;
    } else {
      result.style.display = 'block';
      $('bx-r-range').textContent = lastRangeM + ' m';
    }
  }

  modal.querySelectorAll('.bx-tab').forEach(t => {
    t.addEventListener('click', () => {
      modal.querySelectorAll('.bx-tab').forEach(x => x.classList.remove('on'));
      t.classList.add('on');
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
    toast('Range set to ' + state.rangeM + ' m', 'ok');
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
          <div class="bx-field"><label>Temperature (°C)</label><input type="number" id="bx-c-t" step="0.5" value="${c.tempC}"></div>
          <div class="bx-field"><label>Pressure (hPa)</label><input type="number" id="bx-c-p" value="${c.pressureHpa}"></div>
        </div>
        <div class="bx-row-2">
          <div class="bx-field"><label>Humidity (%)</label><input type="number" id="bx-c-h" min="0" max="100" value="${c.humidityPct}"></div>
          <div class="bx-field"><label>Shot angle (°, +up)</label><input type="number" id="bx-c-a" min="-60" max="60" value="${c.shotAngleDeg}"></div>
        </div>
        <div class="bx-field">
          <label>Wind speed</label>
          <select id="bx-c-w">
            <option value="0" ${c.windMps===0?'selected':''}>None</option>
            <option value="2" ${c.windMps===2?'selected':''}>Light (2 m/s)</option>
            <option value="5" ${c.windMps===5?'selected':''}>Moderate (5 m/s)</option>
            <option value="8" ${c.windMps===8?'selected':''}>Strong (8 m/s)</option>
            <option value="12" ${c.windMps===12?'selected':''}>Very strong (12 m/s)</option>
          </select>
        </div>
        <div class="bx-field" id="bx-c-dir-field" ${c.windMps === 0 ? 'style="opacity:0.4;pointer-events:none;"' : ''}>
          <label>Wind direction <span class="bx-field-hint-inline">(direction wind comes FROM, relative to bullet path)</span></label>
          <div class="bx-wind-compass">
            <div class="bx-wind-bullet" title="Bullet's flight direction">●</div>
            ${dirPositions.map((p, i) => `
              <button type="button" class="bx-wind-dir bx-wind-dir-${p.code.replace('.', '_')} ${i === activeIdx ? 'on' : ''}"
                      data-deg="${p.deg}"
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
      document.querySelectorAll('.bx-wind-dir').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      pickedDeg = parseFloat(btn.dataset.deg);
      const p = dirPositions.find(x => x.deg === pickedDeg);
      if (p && dirHint) dirHint.textContent = p.hint;
    });
  });
  // Wind speed change toggles direction picker enabled/disabled
  $('bx-c-w').addEventListener('change', e => {
    const v = parseFloat(e.target.value);
    if (dirField) {
      dirField.style.opacity = v === 0 ? '0.4' : '';
      dirField.style.pointerEvents = v === 0 ? 'none' : '';
    }
  });

  $('bx-c-cancel').addEventListener('click', closeModal);
  $('bx-c-auto').addEventListener('click', () => { closeModal(); autoFillConditions(); });
  $('bx-c-save').addEventListener('click', () => {
    state.conditions.tempC = parseFloat($('bx-c-t').value) || 15;
    state.conditions.pressureHpa = parseFloat($('bx-c-p').value) || 1013.25;
    state.conditions.humidityPct = parseFloat($('bx-c-h').value) || 50;
    state.conditions.shotAngleDeg = parseFloat($('bx-c-a').value) || 0;
    state.conditions.windMps = parseFloat($('bx-c-w').value) || 0;
    state.conditions.windDirDeg = pickedDeg;
    saveSettingsToStorage();
    closeModal(); renderConditions(); renderOutput();
  });
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
            <label>Species</label>
            <select id="bx-a-species">${speciesOptions}</select>
          </div>
          <div class="bx-field">
            <label>Size</label>
            <select id="bx-a-sex">${sexOpts}</select>
          </div>
        </div>
        <div class="bx-field">
          <label>Aim point</label>
          <div class="bx-field-hint">Heart/Lung (BDS) — mid-chest, halfway between brisket and back. The standard humane shot for UK stalking.</div>
        </div>
        <div class="bx-field-hint bx-field-hint-warn">
          Body dimensions are typical-adult averages from BDS / Mammal Society
          data. Real animals vary by ±15% or more. Aim-point references are an
          approximate guide, not a substitute for the stalker's own judgement
          on the day. Phase 1: broadside shots only.
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

// ── Dope card export ─────────────────────────────────────────────────────

/**
 * Build and trigger download of the dope card PDF for the active profile.
 * Reuses the in-memory drop curve plus enriches it with MOA values and
 * ft-lb energy needed by the PDF table.
 */
function exportDopeCard(sizeName) {
  const p = getActiveProfile();
  if (!p) { toast('Set up a rifle first', 'warn'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    toast('PDF library not loaded — try reloading the page', 'warn');
    return;
  }

  // The chart curve only carries dropCm + energyFtLbs; we need the full
  // per-row data the dope card table prints. Recompute through solveShot
  // at exact 25m steps so MOA + velocity are also populated.
  const curve = [];
  for (let r = 25; r <= 400; r += 25) {
    const result = solveShot({
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
    if (result) curve.push({
      rangeM: r,
      dropCm: result.dropCm,
      dropMoa: result.dropMoa,
      dropMil: result.dropMil,
      velocityFps: result.velocityFps,
      velocityMs: result.velocityMs,
      energyFtLbs: result.energyFtLbs,
      energyJ: result.energyJ,
    });
  }

  // Pick the most-restrictive species in the user's filter for the
  // threshold band on the card. Same logic the output card uses.
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

  const ammoDisplay = p.loadId
    ? loadDisplayName(state.db, p.loadId) + (p.custom ? ' (custom MV/BC)' : '')
    : null;

  try {
    const doc = buildDopeCardPDF({
      profile: p,
      ammoLoad: ammoDisplay,
      conditions: { ...state.conditions },
      dropCurve: curve,
      sizeName: sizeName === 'A4' ? 'A4' : 'A6',
      jurisdictionLabel: jurLabel,
      speciesLabel,
      thresholdFtLb,
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

// ── Public init ─────────────────────────────────────────────────────────

export async function initBallisticsUi() {
  // Load profiles + settings from localStorage.
  state.profiles = loadProfilesFromStorage();
  const settings = loadSettingsFromStorage();
  if (settings) {
    state.activeProfileId = settings.activeProfileId || null;
    state.settings.units = settings.units || 'metric';
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
    if (settings.anatomySex === 'buck' || settings.anatomySex === 'doe' || settings.anatomySex === 'juvenile') {
      state.settings.anatomySex = settings.anatomySex;
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

  // Populate version strip in footer area with data freshness info so
  // the user can see at a glance how recent the underlying data is.
  const versionDataEl = $('bx-version-data');
  const versionRoundEl = $('bx-version-round');
  if (versionDataEl) {
    const lu = state.db && state.db.metadata && state.db.metadata.lastUpdated;
    versionDataEl.textContent = lu || 'unknown';
  }
  if (versionRoundEl) {
    const round = state.db && state.db.metadata && state.db.metadata.verificationRound;
    versionRoundEl.textContent = round != null ? String(round) : '—';
  }

  // Wire up controls.
  const slider = $('bx-range-slider');
  if (slider) {
    slider.addEventListener('input', () => {
      state.rangeM = parseInt(slider.value, 10) || 100;
      renderRangeControl();
      renderOutput();
    });
    // Persist on release (change event fires once when the user lifts
    // their finger), not on every input tick. Avoids hammering localStorage
    // while the user drags the slider.
    slider.addEventListener('change', saveSettingsToStorage);
  }
  const condBtn = $('bx-conditions-edit');
  if (condBtn) condBtn.addEventListener('click', openConditionsEditor);

  const anatomyOpenBtn = $('bx-anatomy-open');
  if (anatomyOpenBtn) anatomyOpenBtn.addEventListener('click', openAnatomyEditor);

  const reticleBtn = $('bx-range-from-reticle');
  if (reticleBtn) reticleBtn.addEventListener('click', openReticleEstimator);

  const jurSelect = $('bx-jurisdiction');
  if (jurSelect) {
    jurSelect.innerHTML = JURISDICTIONS.map(j =>
      `<option value="${j.code}" ${j.code === state.settings.jurisdiction ? 'selected' : ''}>${escapeHtml(j.label)}</option>`).join('');
    jurSelect.addEventListener('change', () => {
      state.settings.jurisdiction = jurSelect.value;
      saveSettingsToStorage(); renderOutput();
    });
  }

  const exportA6 = $('bx-export-a6');
  if (exportA6) exportA6.addEventListener('click', () => exportDopeCard('A6'));
  const exportA4 = $('bx-export-a4');
  if (exportA4) exportA4.addEventListener('click', () => exportDopeCard('A4'));

  // If pre-release law data, show banner.
  if (!flUkDeerLawVerified) {
    const banner = $('bx-law-banner');
    if (banner) banner.style.display = 'block';
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
      <div class="bx-acceptance-title">Before you use this calculator <span class="bx-acceptance-version">v1.0 beta</span></div>
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
