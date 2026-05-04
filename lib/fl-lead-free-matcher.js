// =============================================================================
// First Light — Lead-free ammunition matcher
//
// Pure helper for finding the closest lead-free factory loads to a user's
// current lead load, in the same calibre. Designed to support the 2029 UK
// REACH lead ammunition restriction transition.
//
// Why a separate module:
//   * fl-ammo.js is a thin layer over the JSON DB. This module needs the
//     ballistics solver too — keeping the cross-module logic isolated keeps
//     fl-ammo.js DB-only and lets this module be tested independently.
//   * The matcher is a product feature, not a primitive. Future tweaks to
//     scoring weights or sample ranges shouldn't touch the DB or the solver.
//
// Public API:
//   * findLeadFreeAlternatives(db, sourceLoad, opts) → { matches, reason }
//   * scoreCandidate(sourceTraj, candidateTraj) → { score, deltas }
//
// Design notes:
//   * Pure functions. Caller provides the DB.
//   * Sample ranges hard-coded to 100/200/300m (see CURSOR-INTEGRATION-PROMPT
//     decision history). 100m catches near-zero behaviour, 200m is typical
//     UK engagement range and where Scottish 1750 ft·lb threshold matters,
//     300m discriminates high-BC from low-BC loads.
//   * Scoring is intentionally simple: weighted sum of normalised drop and
//     energy deltas at each sample range. Lower score = closer match.
//   * "Already lead-free" returns reason='already-lead-free' with empty
//     matches — the UI should not show the matcher button in that case but
//     this is defensive.
//   * "No options in calibre" returns reason='no-alternatives' with empty
//     matches and lets the UI suggest a calibre change conversation.
// =============================================================================

import {
  solveShot,
  grainsToKg,
  joulesToFtLbs,
  ATM_STD,
} from './fl-ballistics.js';

// Sample ranges for trajectory comparison (metres).
export const MATCH_RANGES_M = Object.freeze([100, 200, 300]);

// Default zero range used when computing comparison trajectories. The user's
// own zero is irrelevant for matching purposes — what matters is the relative
// shape of the trajectory between candidates. We use 100m (a common UK zero)
// so all comparisons share the same baseline. The UI re-zero advisory makes
// it explicit that the user must zero the new load themselves.
export const COMPARISON_ZERO_M = 100;

// Default sight height used for the comparison solve. Matches the default
// in fl-ballistics-ui.js. As above — the matcher cares about relative
// trajectory shape, not absolute hold values.
export const COMPARISON_SIGHT_HEIGHT_CM = 4.5;

// Max number of candidate matches returned by default. Three is the sweet
// spot — enough to give the user real choice, few enough to scan quickly.
export const DEFAULT_MAX_MATCHES = 3;

/**
 * Compute a comparison trajectory at the matcher's standard sample ranges
 * for a single load. Atmospheric conditions are ICAO standard.
 *
 * @param {object} load  An ammo-loads.json load record
 * @returns {Array<{rangeM:number, dropCm:number, energyFtLbs:number, velocityFps:number}>|null}
 *          One entry per MATCH_RANGES_M. Returns null if the load is missing
 *          required ballistic data (MV, BC, weight).
 */
export function computeMatchTrajectory(load) {
  if (!load) return null;
  const mv = load.muzzleVelocityFps;
  const wt = load.weightGrains;
  const bcG1 = load.bcG1 || 0;
  const bcG7 = load.bcG7 || 0;
  if (!(mv > 0) || !(wt > 0) || (bcG1 <= 0 && bcG7 <= 0)) return null;

  // Convert MV fps → m/s for the solver.
  const muzzleVelocityMs = mv * 0.3048;
  const bulletMassKg = grainsToKg(wt);

  const samples = [];
  for (const rangeM of MATCH_RANGES_M) {
    const shot = solveShot({
      muzzleVelocityMs,
      bcG1, bcG7,
      bulletMassKg,
      sightHeightCm: COMPARISON_SIGHT_HEIGHT_CM,
      zeroRangeM: COMPARISON_ZERO_M,
      targetRangeM: rangeM,
      tempC: ATM_STD.temperatureC,
      pressureHpa: ATM_STD.pressureHpa,
      humidityPct: ATM_STD.humidityPct,
      windMs: 0,
      shotAngleDeg: 0,
    });
    if (!shot) return null;
    samples.push({
      rangeM,
      dropCm: shot.dropCm,
      energyFtLbs: shot.energyFtLbs,
      velocityFps: shot.velocityFps,
    });
  }
  return samples;
}

/**
 * Score a candidate load against a source load. Lower = closer match.
 *
 * Scoring components (per sample range):
 *   * Drop delta:    |Δdrop_cm|        — equal weight at all ranges
 *   * Energy delta:  |Δenergy_ftlbs|   — normalised by source energy
 *
 * The score is the sum across all sample ranges of:
 *   (drop delta in cm) + (relative energy delta × 100)
 *
 * The relative-energy weighting makes a 10% energy difference equivalent to
 * a 10cm drop difference — calibrated so neither dimension dominates for
 * typical lead vs copper deltas. Tune in tests if the matcher's top picks
 * disagree with hand-curated expectations.
 *
 * @param {Array} sourceTraj    From computeMatchTrajectory(sourceLoad)
 * @param {Array} candidateTraj From computeMatchTrajectory(candidateLoad)
 * @returns {{score:number, deltas:Array<{rangeM:number, dropDeltaCm:number, energyDeltaFtLbs:number, energyDeltaPct:number}>}}
 */
export function scoreCandidate(sourceTraj, candidateTraj) {
  if (!sourceTraj || !candidateTraj) {
    return { score: Infinity, deltas: [] };
  }
  if (sourceTraj.length !== candidateTraj.length) {
    return { score: Infinity, deltas: [] };
  }

  const deltas = [];
  let score = 0;

  for (let i = 0; i < sourceTraj.length; i++) {
    const s = sourceTraj[i];
    const c = candidateTraj[i];
    const dropDeltaCm = c.dropCm - s.dropCm;
    const energyDeltaFtLbs = c.energyFtLbs - s.energyFtLbs;
    const energyDeltaPct = s.energyFtLbs > 0
      ? (energyDeltaFtLbs / s.energyFtLbs) * 100
      : 0;
    deltas.push({
      rangeM: s.rangeM,
      dropDeltaCm,
      energyDeltaFtLbs,
      energyDeltaPct,
    });
    score += Math.abs(dropDeltaCm) + Math.abs(energyDeltaPct);
  }

  return { score, deltas };
}

/**
 * Find the closest lead-free alternatives to a source load.
 *
 * @param {object} db          The full ammo-loads JSON DB
 * @param {object} sourceLoad  The user's current load (must be in db.loads)
 * @param {object} [opts]
 * @param {number} [opts.maxMatches=3]
 * @returns {{
 *   reason: 'ok' | 'already-lead-free' | 'no-alternatives' | 'invalid-source',
 *   matches: Array<{
 *     load: object,
 *     score: number,
 *     deltas: Array,
 *     trajectory: Array
 *   }>,
 *   sourceTrajectory: Array|null
 * }}
 */
export function findLeadFreeAlternatives(db, sourceLoad, opts = {}) {
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES;

  if (!sourceLoad || !sourceLoad.calibre) {
    return { reason: 'invalid-source', matches: [], sourceTrajectory: null };
  }

  if (sourceLoad.leadFree === true) {
    return { reason: 'already-lead-free', matches: [], sourceTrajectory: null };
  }

  const sourceTraj = computeMatchTrajectory(sourceLoad);
  if (!sourceTraj) {
    return { reason: 'invalid-source', matches: [], sourceTrajectory: null };
  }

  // Find lead-free candidates in the same calibre, excluding the source.
  const candidates = (db.loads || []).filter(l =>
    l.calibre === sourceLoad.calibre &&
    l.leadFree === true &&
    l.id !== sourceLoad.id
  );

  if (candidates.length === 0) {
    return {
      reason: 'no-alternatives',
      matches: [],
      sourceTrajectory: sourceTraj,
    };
  }

  // Score each candidate and sort ascending (lower = closer).
  const scored = [];
  for (const c of candidates) {
    const traj = computeMatchTrajectory(c);
    if (!traj) continue; // skip candidates with incomplete data
    const { score, deltas } = scoreCandidate(sourceTraj, traj);
    scored.push({ load: c, score, deltas, trajectory: traj });
  }
  scored.sort((a, b) => a.score - b.score);

  return {
    reason: 'ok',
    matches: scored.slice(0, maxMatches),
    sourceTrajectory: sourceTraj,
  };
}
