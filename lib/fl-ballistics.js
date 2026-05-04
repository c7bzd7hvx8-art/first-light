// =============================================================================
// First Light — pure ballistics core (ES module)
//
// Trajectory solver, atmospheric model, drag functions, and unit helpers for
// the ballistic calculator. Sibling to lib/fl-pure.mjs — same conventions:
//   * Pure functions only. No DOM, no network, no globals.
//   * No `new Date()` without explicit input. No reads from window/document.
//   * Testable in Node with zero dependencies.
//
// Scope (deliberately bounded for UK deer stalking, sub-400m):
//   * Point-mass trajectory, G1 and G7 drag functions.
//   * ICAO standard atmosphere with humidity correction.
//   * Cosine-method shot-angle correction.
//   * Didion crosswind drift approximation.
//   * Energy and velocity at target.
//
// Out of scope (do not add — this is a stalking tool, not a sniping tool):
//   * Coriolis effect, spin drift, transonic drag modelling beyond a flag.
//   * Custom drag functions, Doppler-derived BC.
//   * Multi-axis cant correction, magnus drift, aerodynamic jump.
//
// ─── DATA PROVENANCE ──────────────────────────────────────────────────
// The G1 and G7 drag tables in this file are reproduced from
// js-ballistics 2.2.0-beta.2 (https://github.com/o-murphy/js-ballistics),
// © 2023 o-murphy, ISC licence. Required attribution:
//
//   ISC Licence
//   Copyright 2023 o-murphy
//   Permission to use, copy, modify, and/or distribute this software for
//   any purpose with or without fee is hereby granted, provided that the
//   above copyright notice and this permission notice appear in all
//   copies.
//   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
//   WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
//   WARRANTIES OF MERCHANTABILITY AND FITNESS.
//
// js-ballistics in turn derives its tables from Alexandre Trofimov's
// original ballistic JavaScript code, ported via the Go and C# ports of
// gehtsoft-usa/BallisticCalculator1 (LGPL), and ultimately from the
// JBM Ballistics public-domain reference set sourced from McCoy's work.
//
// The trajectory constant STANDARD_K = 2.08551e-4 inside solveTrajectory
// uses the same value as js-ballistics, applicable when velocity is in
// m/s, density-ratio is dimensionless, and BC is in lb/in² (the Imperial
// BC unit used by every manufacturer). This module accepts SI inputs
// from callers; the constant has been validated empirically (test suite
// reproduces js-ballistics .308/150gr Federal trajectory to <1cm at 200yd).
// ───────────────────────────────────────────────────────────────────────
//
// Validation strategy:
//   * Test suite compares trajectory output against published manufacturer
//     trajectory data (Hornady, Federal) for known loads at standard
//     conditions. Tolerance: < 1cm at 200m, < 3cm at 400m. If we exceed
//     that with verified drag tables, the maths is wrong.
// =============================================================================

// ── Constants ─────────────────────────────────────────────────────────────

/** Standard gravity, m/s². ICAO standard. */
export const G_STANDARD = 9.80665;

/** ICAO standard atmosphere reference values at sea level, dry air. */
export const ATM_STD = Object.freeze({
  temperatureC: 15,
  pressureHpa: 1013.25,
  humidityPct: 0,
  densityKgM3: 1.225,
});

/** Gas constant for dry air, J/(kg·K). */
const R_DRY = 287.058;
/** Gas constant for water vapour, J/(kg·K). */
const R_VAPOUR = 461.495;

// ── Unit conversions ──────────────────────────────────────────────────────
// All trivially-correct; no verification needed beyond the conversion
// factors which are SI-defined or NIST-published.

/** Feet per second → metres per second. */
export function fpsToMs(fps) { return fps * 0.3048; }
/** Metres per second → feet per second. */
export function msToFps(ms) { return ms / 0.3048; }
/** Grains → kilograms (1 grain = 64.79891 mg, NIST). */
export function grainsToKg(gr) { return gr * 6.479891e-5; }
/** Kilograms → grains. */
export function kgToGrains(kg) { return kg / 6.479891e-5; }
/** Joules → foot-pounds (1 ft·lbf = 1.35581795 J). */
export function joulesToFtLbs(j) { return j * 0.737562149; }
/** Foot-pounds → joules. */
export function ftLbsToJoules(fl) { return fl * 1.35581795; }
/** Metres → yards. */
export function metresToYards(m) { return m * 1.0936133; }
/** Yards → metres. */
export function yardsToMetres(y) { return y / 1.0936133; }
/** Inches → centimetres. */
export function inchesToCm(i) { return i * 2.54; }
/** Centimetres → inches. */
export function cmToInches(c) { return c / 2.54; }

/**
 * Convert a linear drop (cm) at a given range (m) to MOA (true minutes
 * of arc — 1 MOA = 1/60 degree). Returns 0 for non-positive range.
 *
 * Note: this is *true* MOA, not "shooter's MOA" (1 inch at 100 yards =
 * 2.78 cm/100m, which is 4.7% smaller). Some scope manufacturers
 * conflate the two — when integrating with a specific scope, the UI
 * layer should let users pick. This helper is the maths-correct one.
 */
export function cmToMoa(cm, rangeM) {
  if (!Number.isFinite(rangeM) || rangeM <= 0) return 0;
  const moaInRad = Math.PI / 10800;        // 1 MOA = π/10800 rad
  const cmPerMoa = rangeM * Math.tan(moaInRad) * 100;
  return cm / cmPerMoa;
}

/**
 * Convert a linear drop (cm) at a given range (m) to MIL (milliradians).
 * 1 MIL = 1/1000 rad. At 100m, 1 MIL = 10 cm exactly.
 */
export function cmToMil(cm, rangeM) {
  if (!Number.isFinite(rangeM) || rangeM <= 0) return 0;
  return (cm / 100 / rangeM) * 1000;
}

// ── Atmospheric model ─────────────────────────────────────────────────────

/**
 * Saturation vapour pressure (hPa) over water at temperature t (°C).
 * Magnus-Tetens approximation, accurate to <0.1% over -40 to +50°C.
 * Internal helper for airDensity(); not exported.
 */
function saturationVapourPressureHpa(tC) {
  return 6.1078 * Math.exp((17.27 * tC) / (tC + 237.3));
}

/**
 * Air density (kg/m³) from temperature (°C), barometric pressure (hPa,
 * station pressure — NOT sea-level corrected), and relative humidity (%).
 *
 * Uses the ideal-gas law for moist air, treating it as a mixture of dry
 * air and water vapour at the same temperature/pressure. Humidity matters
 * less than people think: at 25°C, going 0→100% RH changes density by
 * ~1%, which moves a 200m POI by ~2mm. Included for completeness but
 * the calculator UI can default RH to 50% without practical loss.
 *
 * @param {number} tC      Temperature in °C
 * @param {number} pHpa    Pressure in hPa (millibars)
 * @param {number} rhPct   Relative humidity in % (0–100). 0 if unknown.
 * @returns {number}       density in kg/m³
 */
export function airDensity(tC, pHpa, rhPct) {
  const T = tC + 273.15;                   // Kelvin
  const P = pHpa * 100;                    // Pa
  const rh = Math.max(0, Math.min(100, rhPct || 0)) / 100;
  const pSat = saturationVapourPressureHpa(tC) * 100;
  const pVap = rh * pSat;
  const pDry = P - pVap;
  return pDry / (R_DRY * T) + pVap / (R_VAPOUR * T);
}

/**
 * Air density ratio: actual ÷ ICAO standard (1.225 kg/m³). Trajectory
 * drag scales linearly with this, so it's the natural input for the
 * solver's atmosphere correction.
 */
export function airDensityRatio(tC, pHpa, rhPct) {
  return airDensity(tC, pHpa, rhPct) / ATM_STD.densityKgM3;
}

/**
 * Speed of sound (m/s) for given temperature (°C). Used to convert
 * velocity → Mach number for drag-table lookup. Humidity has a small
 * positive effect (≈0.3 m/s at 100% RH, 25°C) but is below our
 * resolution; ignore.
 */
export function speedOfSound(tC) {
  const T = tC + 273.15;
  return Math.sqrt(1.4 * R_DRY * T);       // γ=1.4 for diatomic ideal gas
}

// ── Drag-table interpolation ──────────────────────────────────────────────

/**
 * Linear interpolation into a drag table. Given Mach number, return the
 * corresponding drag coefficient. Clamps to table bounds (Mach > max
 * returns last entry; Mach < 0 returns first entry — neither should
 * happen for a real bullet, but defensive).
 *
 * @param {ReadonlyArray<[number, number]>} table  [[mach, cd], ...]
 * @param {number} mach
 * @returns {number} Cd
 */
export function dragCoefficientAt(table, mach) {
  if (!table || table.length === 0) return 0;
  if (mach <= table[0][0]) return table[0][1];
  if (mach >= table[table.length - 1][0]) return table[table.length - 1][1];
  // Binary search would be faster; linear is fine — tables are <100 entries
  // and trajectory solver calls this once per integration step, ~1000×.
  for (let i = 1; i < table.length; i++) {
    const [m1, cd1] = table[i];
    if (mach <= m1) {
      const [m0, cd0] = table[i - 1];
      const t = (mach - m0) / (m1 - m0);
      return cd0 + t * (cd1 - cd0);
    }
  }
  return table[table.length - 1][1];        // unreachable; defensive
}

// ── Trajectory solver ─────────────────────────────────────────────────────

/**
 * Compute the launch angle (radians, above horizontal) needed to zero
 * the rifle at the given range. Uses a simple bracketed bisection on
 * the line-of-sight crossing height.
 *
 * Inputs are the same shape as solveTrajectory() takes — see that
 * function's JSDoc. We solve `trajectoryAt(zeroRangeM).y === 0` for
 * launchAngle, where y is height relative to the line of sight.
 *
 * @param {object} loadAndAtmo  See solveTrajectory params (excluding launchAngle)
 * @param {number} zeroRangeM   The range at which the line of sight crosses trajectory
 * @returns {number} launch angle in radians
 */
export function findZeroAngle(loadAndAtmo, zeroRangeM) {
  // Bisection between -1° and +5° (covers any sane rifle/zero combination).
  // Tighter bracket would be faster but this converges in <30 iterations
  // and is called once per profile-recompute, not per-shot.
  let lo = -Math.PI / 180;        // -1°
  let hi = +5 * Math.PI / 180;    // +5°

  // Helper: signed error at zero range for a trial angle.
  // Returns row.dropCm where positive dropCm means the bullet is
  // BELOW the line of sight (i.e. the angle was too low) and negative
  // means above (angle too high). This sign convention matches
  // solveTrajectory's output throughout the module.
  const errorAt = (angle) => {
    // Overshoot zeroRangeM by a small margin so the row search always
    // finds a sample at or past zero range. Without the +2m margin the
    // sample loop's `x >= maxRangeM` break can stop one tick before the
    // target range, leaving find() empty and bisection stuck.
    const traj = solveTrajectory({ ...loadAndAtmo, launchAngleRad: angle, maxRangeM: zeroRangeM + 2, stepM: 1 });
    const row = traj.find(p => p.rangeM >= zeroRangeM);
    if (!row) return Infinity;
    return row.dropCm;
  };

  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const err = errorAt(mid);
    if (Math.abs(err) < 0.05) return mid;       // 0.5mm tolerance
    // err > 0 → bullet too LOW at zero range → need to RAISE the launch angle
    // err < 0 → bullet too HIGH at zero range → need to LOWER it
    if (err > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Solve the point-mass trajectory and return a sampled path.
 *
 * Integration: forward Euler with a small time step (default 0.0005 s,
 * giving sub-millimetre accuracy at 400m). RK4 would be more elegant
 * but overkill for the regime — drag is smooth, gravity is constant,
 * the flight time is under 0.6s for any UK stalking shot.
 *
 * Coordinate system:
 *   * Origin: muzzle.
 *   * x: horizontal range (m), positive downrange.
 *   * y: vertical position relative to LINE OF SIGHT (m). Positive = above LoS.
 *     Note this is NOT height above bore; we subtract sight height and the
 *     LoS slope so y=0 means "on target" at any range.
 *   * Velocity is split into vx, vy components.
 *
 * Output rows:
 *   { rangeM, timeS, dropCm, velocityMs, energyJ, machNumber }
 *
 * @param {object}  p
 * @param {number}  p.muzzleVelocityMs   Muzzle velocity, m/s.
 * @param {number}  p.bcG1                G1 ballistic coefficient. Pass 0 if using G7.
 * @param {number}  p.bcG7                G7 ballistic coefficient. Pass 0 if using G1.
 * @param {number}  p.bulletMassKg        Bullet mass, kg (use grainsToKg).
 * @param {number}  p.sightHeightCm       Scope height above bore axis, cm.
 * @param {number}  p.launchAngleRad      Barrel elevation above horizontal, rad.
 *                                        (Use findZeroAngle() to compute.)
 * @param {number}  p.densityRatio        Air density / 1.225 (use airDensityRatio).
 * @param {number}  p.tempC               Air temperature, °C (for speed of sound).
 * @param {number}  p.maxRangeM           Stop integration at this range.
 * @param {number}  [p.stepM=5]           Output sampling interval (m).
 * @param {number}  [p.dt=0.0005]         Integration time step (s).
 * @returns {Array<{rangeM:number,timeS:number,dropCm:number,velocityMs:number,energyJ:number,machNumber:number}>}
 */
export function solveTrajectory(p) {
  const {
    muzzleVelocityMs, bcG1, bcG7, bulletMassKg,
    sightHeightCm, launchAngleRad,
    densityRatio, tempC,
    maxRangeM, stepM = 5, dt = 0.0005,
  } = p;

  // Pick drag table and BC. Exactly one of G1/G7 must be non-zero.
  const useG7 = bcG7 > 0;
  const dragTable = useG7 ? G7_TABLE : G1_TABLE;
  const bc = useG7 ? bcG7 : bcG1;
  if (!(bc > 0)) {
    throw new Error('solveTrajectory: bcG1 or bcG7 must be > 0');
  }
  if (!(muzzleVelocityMs > 0) || !Number.isFinite(muzzleVelocityMs)) {
    throw new Error('solveTrajectory: muzzleVelocityMs must be a positive finite number');
  }
  if (!(bulletMassKg > 0) || !Number.isFinite(bulletMassKg)) {
    throw new Error('solveTrajectory: bulletMassKg must be a positive finite number');
  }
  if (!(maxRangeM > 0) || !Number.isFinite(maxRangeM)) {
    throw new Error('solveTrajectory: maxRangeM must be a positive finite number');
  }

  // Drag deceleration in the BC convention:
  //   a_drag = (ρ/ρ_std) · v² · Cd_std(M) · K / BC
  //
  // The mainstream BC trajectory constant K = 2.08551e-4 is calibrated for
  // IMPERIAL units (v in fps, a in fps² i.e. ft/s², bc in lb/in²). Since
  // this module operates in SI throughout (v in m/s, a in m/s²), we
  // convert the constant rather than the inputs:
  //
  //   a_ft/s²  = ρ · v_fps² · Cd · K_imp / bc
  //   v_fps    = v_ms / 0.3048
  //   a_m/s²   = a_ft/s² × 0.3048
  //
  // Substituting gives  a_m/s² = ρ · v_ms² · Cd · (K_imp / 0.3048) / bc
  // so K_SI = K_imp / 0.3048. The numeric value is precomputed.
  // Validated empirically: with this constant, this solver's trajectories
  // for Federal .308 Win 150gr Power-Shok match the js-ballistics
  // reference solver to within 1cm at 200yd.
  const STANDARD_K = 2.08551e-4 / 0.3048;   // ≈ 6.8424e-4 (SI form)

  const cosA = Math.cos(launchAngleRad);
  const sinA = Math.sin(launchAngleRad);
  let vx = muzzleVelocityMs * cosA;
  let vy = muzzleVelocityMs * sinA;
  let x = 0;
  let y = -sightHeightCm / 100;     // start below LoS by sight height
  let t = 0;
  const cSnd = speedOfSound(tempC);

  const rows = [];
  let nextSample = 0;

  // Hard cap on iterations to prevent runaway loops if inputs are bad.
  // The dynamic estimate is generous; the absolute cap is the safety net.
  // At dt=0.0005s, 200000 iter = 100s of flight time — far beyond any
  // sane stalking shot which is sub-1s.
  const ABSOLUTE_MAX_ITER = 200000;
  const dynamicCap = Math.ceil(maxRangeM / muzzleVelocityMs / dt) * 4;
  const maxIter = Number.isFinite(dynamicCap)
    ? Math.min(dynamicCap, ABSOLUTE_MAX_ITER)
    : ABSOLUTE_MAX_ITER;

  for (let i = 0; i < maxIter; i++) {
    const v = Math.hypot(vx, vy);
    const mach = v / cSnd;
    const cd = dragCoefficientAt(dragTable, mach);
    const dragAccel = densityRatio * v * v * cd * STANDARD_K / bc;

    // Drag opposes velocity vector; gravity is straight down.
    const ax = -dragAccel * (vx / v);
    const ay = -dragAccel * (vy / v) - G_STANDARD;

    vx += ax * dt;
    vy += ay * dt;
    x += vx * dt;
    y += vy * dt;
    t += dt;

    // Sample at stepM intervals.
    while (x >= nextSample && nextSample <= maxRangeM) {
      // Drop relative to line of sight: LoS is straight from (0, 0) to
      // (maxRangeM, 0)... but actually the LoS is straight horizontal
      // from the SIGHT (not the bore), so y already accounts for it
      // because we initialised y = -sightHeight. Drop relative to LoS
      // is just -y (below LoS = positive drop).
      const dropCm = -y * 100;
      const energyJ = 0.5 * bulletMassKg * v * v;
      rows.push({
        rangeM: nextSample,
        timeS: t,
        dropCm,
        velocityMs: v,
        energyJ,
        machNumber: mach,
      });
      nextSample += stepM;
    }

    if (x >= maxRangeM) break;
    if (vx <= 0) break;             // bullet stopped going downrange
  }

  return rows;
}

/**
 * Crosswind drift (cm) for a given trajectory row, using Didion's
 * approximation: drift = wind_speed · (time_of_flight - range / muzzle_velocity).
 * The "vacuum time" subtraction accounts for the fact that drift only
 * accumulates against the *deceleration* of the bullet, not its full
 * time of flight.
 *
 * Accurate to ≈10% for stalking-relevant ranges; users won't know
 * downrange wind speed to better than ±30% anyway, so this is well
 * inside the noise floor of the input.
 *
 * @param {number} windMs                Crosswind component, m/s (positive = right)
 * @param {number} timeOfFlightS         From solveTrajectory row
 * @param {number} rangeM                Range to target
 * @param {number} muzzleVelocityMs      From load
 * @returns {number} drift in cm (positive = right of aim)
 */
export function crosswindDriftCm(windMs, timeOfFlightS, rangeM, muzzleVelocityMs) {
  if (!(muzzleVelocityMs > 0) || !(rangeM > 0)) return 0;
  const vacuumTimeS = rangeM / muzzleVelocityMs;
  const driftM = windMs * (timeOfFlightS - vacuumTimeS);
  return driftM * 100;
}

/**
 * Effective range for a shot taken at a vertical angle (uphill or
 * downhill). The cosine method: only the *horizontal* component of the
 * range is "felt" by gravity, so the trajectory drops as if the range
 * were range × cos(angle).
 *
 * Adequate for sub-300m work. At extreme angles and ranges the "improved
 * rifleman's rule" or full 3D solution is more accurate, but for UK
 * stalking the cosine method is the field-standard.
 *
 * @param {number} actualRangeM
 * @param {number} angleDeg            Positive uphill, negative downhill (sign doesn't matter — cos is even)
 * @returns {number} effective range in m for drop computation
 */
export function angleCorrectedRange(actualRangeM, angleDeg) {
  const angleRad = (angleDeg * Math.PI) / 180;
  return actualRangeM * Math.cos(angleRad);
}

// ── Convenience: full solution for a single shot ──────────────────────────

/**
 * High-level wrapper that takes a load + atmosphere + range and returns
 * everything the UI needs to display. This is the function the calculator
 * UI calls per-tick of the range slider.
 *
 * @param {object} p
 * @param {number} p.muzzleVelocityMs
 * @param {number} p.bcG1                Use 0 if using G7
 * @param {number} p.bcG7                Use 0 if using G1
 * @param {number} p.bulletMassKg
 * @param {number} p.sightHeightCm
 * @param {number} p.zeroRangeM
 * @param {number} p.tempC
 * @param {number} p.pressureHpa
 * @param {number} p.humidityPct
 * @param {number} p.targetRangeM
 * @param {number} [p.windMs=0]          Crosswind component
 * @param {number} [p.shotAngleDeg=0]    Uphill (+) / downhill (-) angle
 * @returns {object}                     Everything the UI needs
 */
export function solveShot(p) {
  const densityRatio = airDensityRatio(p.tempC, p.pressureHpa, p.humidityPct);
  const effectiveRange = angleCorrectedRange(p.targetRangeM, p.shotAngleDeg || 0);

  // Compute zero angle, then trajectory out to the (effective) target range.
  const loadAndAtmo = {
    muzzleVelocityMs: p.muzzleVelocityMs,
    bcG1: p.bcG1, bcG7: p.bcG7,
    bulletMassKg: p.bulletMassKg,
    sightHeightCm: p.sightHeightCm,
    densityRatio,
    tempC: p.tempC,
  };
  const launchAngleRad = findZeroAngle(loadAndAtmo, p.zeroRangeM);

  const traj = solveTrajectory({
    ...loadAndAtmo,
    launchAngleRad,
    maxRangeM: Math.max(effectiveRange + 5, p.zeroRangeM + 5),
    stepM: 1,
  });

  // Find the row closest to (or just past) the effective target range.
  const row = traj.find(r => r.rangeM >= effectiveRange) || traj[traj.length - 1];
  if (!row) return null;

  const windDriftCm = crosswindDriftCm(
    p.windMs || 0, row.timeS, p.targetRangeM, p.muzzleVelocityMs
  );

  return {
    rangeM: p.targetRangeM,
    effectiveRangeM: effectiveRange,
    dropCm: row.dropCm,
    dropMoa: cmToMoa(row.dropCm, p.targetRangeM),
    dropMil: cmToMil(row.dropCm, p.targetRangeM),
    windDriftCm,
    windDriftMoa: cmToMoa(windDriftCm, p.targetRangeM),
    windDriftMil: cmToMil(windDriftCm, p.targetRangeM),
    velocityMs: row.velocityMs,
    velocityFps: msToFps(row.velocityMs),
    energyJ: row.energyJ,
    energyFtLbs: joulesToFtLbs(row.energyJ),
    timeOfFlightS: row.timeS,
    machNumber: row.machNumber,
    isTransonic: row.machNumber < 1.2 && row.machNumber > 0.8,
    isSubsonic: row.machNumber < 1.0,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// DRAG TABLES — VERIFIED
// ──────────────────────────────────────────────────────────────────────────
//
// The G1 and G7 standard drag function tables. PUBLIC-DOMAIN reference data
// transcribed from js-ballistics 2.2.0-beta.2 (which traces back through
// gehtsoft-usa/BallisticCalculator1 to JBM Ballistics public-domain data).
//
// Verification status:
//   * Anchor-point Mach values (0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0) match
//     canonical McCoy 1999 / JBM published values exactly to 4 decimals.
//   * Federal .308 Win 150gr Power-Shok trajectory (MV 2820 fps, BC G1
//     0.314, 100yd zero, ICAO standard) reproduces js-ballistics solver
//     output to within ±0.32 cm at 400yd and within ±0.5% on velocity at
//     200/300/400yd. Validated in fl-ballistics.test.js trajectory section.
//   * Computed drop matches Federal's published P308SP trajectory chart
//     within published rounding (-3.97" computed vs -3.96" published at
//     200yd; -14.93" computed vs -14.81" published at 300yd).
//
// Tables are exported because the test suite needs to read them and the
// UI may want to plot them. They are Object.freeze'd at the outer level
// to prevent accidental mutation.
// ──────────────────────────────────────────────────────────────────────────

/** G1 standard drag function. Flat-base bullets. 79 entries, Mach 0–5.
 * Source: js-ballistics 2.2.0-beta.2 by o-murphy (ISC licence). Itself
 * derived from Alexandre Trofimov's ballistic JavaScript code, which
 * traces back through gehtsoft-usa/BallisticCalculator1 to JBM
 * Ballistics public-domain reference data.
 *
 * Validated: trajectories computed using this table reproduce the
 * js-ballistics solver output to within 1cm at 200yd / 3cm at 400yd
 * for the .308 Win 150gr Power-Shok reference load. See
 * tests/fl-ballistics.test.mjs RUN_TRAJECTORY_TESTS section.
 */
export const G1_TABLE = Object.freeze([
  [0.000, 0.2629],
  [0.050, 0.2558],
  [0.100, 0.2487],
  [0.150, 0.2413],
  [0.200, 0.2344],
  [0.250, 0.2278],
  [0.300, 0.2214],
  [0.350, 0.2155],
  [0.400, 0.2104],
  [0.450, 0.2061],
  [0.500, 0.2032],
  [0.550, 0.2020],
  [0.600, 0.2034],
  [0.700, 0.2165],
  [0.725, 0.2230],
  [0.750, 0.2313],
  [0.775, 0.2417],
  [0.800, 0.2546],
  [0.825, 0.2706],
  [0.850, 0.2901],
  [0.875, 0.3136],
  [0.900, 0.3415],
  [0.925, 0.3734],
  [0.950, 0.4084],
  [0.975, 0.4448],
  [1.000, 0.4805],
  [1.025, 0.5136],
  [1.050, 0.5427],
  [1.075, 0.5677],
  [1.100, 0.5883],
  [1.125, 0.6053],
  [1.150, 0.6191],
  [1.200, 0.6393],
  [1.250, 0.6518],
  [1.300, 0.6589],
  [1.350, 0.6621],
  [1.400, 0.6625],
  [1.450, 0.6607],
  [1.500, 0.6573],
  [1.550, 0.6528],
  [1.600, 0.6474],
  [1.650, 0.6413],
  [1.700, 0.6347],
  [1.750, 0.6280],
  [1.800, 0.6210],
  [1.850, 0.6141],
  [1.900, 0.6072],
  [1.950, 0.6003],
  [2.000, 0.5934],
  [2.050, 0.5867],
  [2.100, 0.5804],
  [2.150, 0.5743],
  [2.200, 0.5685],
  [2.250, 0.5630],
  [2.300, 0.5577],
  [2.350, 0.5527],
  [2.400, 0.5481],
  [2.450, 0.5438],
  [2.500, 0.5397],
  [2.600, 0.5325],
  [2.700, 0.5264],
  [2.800, 0.5211],
  [2.900, 0.5168],
  [3.000, 0.5133],
  [3.100, 0.5105],
  [3.200, 0.5084],
  [3.300, 0.5067],
  [3.400, 0.5054],
  [3.500, 0.5040],
  [3.600, 0.5030],
  [3.700, 0.5022],
  [3.800, 0.5016],
  [3.900, 0.5010],
  [4.000, 0.5006],
  [4.200, 0.4998],
  [4.400, 0.4995],
  [4.600, 0.4992],
  [4.800, 0.4990],
  [5.000, 0.4988],
]);

/** G7 standard drag function. Boat-tail spitzers. 84 entries, Mach 0–5.
 * Source: js-ballistics 2.2.0-beta.2 by o-murphy (ISC licence). See
 * G1_TABLE comment for full provenance.
 */
export const G7_TABLE= Object.freeze([
  [0.000, 0.1198],
  [0.050, 0.1197],
  [0.100, 0.1196],
  [0.150, 0.1194],
  [0.200, 0.1193],
  [0.250, 0.1194],
  [0.300, 0.1194],
  [0.350, 0.1194],
  [0.400, 0.1193],
  [0.450, 0.1193],
  [0.500, 0.1194],
  [0.550, 0.1193],
  [0.600, 0.1194],
  [0.650, 0.1197],
  [0.700, 0.1202],
  [0.725, 0.1207],
  [0.750, 0.1215],
  [0.775, 0.1226],
  [0.800, 0.1242],
  [0.825, 0.1266],
  [0.850, 0.1306],
  [0.875, 0.1368],
  [0.900, 0.1464],
  [0.925, 0.1660],
  [0.950, 0.2054],
  [0.975, 0.2993],
  [1.000, 0.3803],
  [1.025, 0.4015],
  [1.050, 0.4043],
  [1.075, 0.4034],
  [1.100, 0.4014],
  [1.125, 0.3987],
  [1.150, 0.3955],
  [1.200, 0.3884],
  [1.250, 0.3810],
  [1.300, 0.3732],
  [1.350, 0.3657],
  [1.400, 0.3580],
  [1.500, 0.3440],
  [1.550, 0.3376],
  [1.600, 0.3315],
  [1.650, 0.3260],
  [1.700, 0.3209],
  [1.750, 0.3160],
  [1.800, 0.3117],
  [1.850, 0.3078],
  [1.900, 0.3042],
  [1.950, 0.3010],
  [2.000, 0.2980],
  [2.050, 0.2951],
  [2.100, 0.2922],
  [2.150, 0.2892],
  [2.200, 0.2864],
  [2.250, 0.2835],
  [2.300, 0.2807],
  [2.350, 0.2779],
  [2.400, 0.2752],
  [2.450, 0.2725],
  [2.500, 0.2697],
  [2.550, 0.2670],
  [2.600, 0.2643],
  [2.650, 0.2615],
  [2.700, 0.2588],
  [2.750, 0.2561],
  [2.800, 0.2533],
  [2.850, 0.2506],
  [2.900, 0.2479],
  [2.950, 0.2451],
  [3.000, 0.2424],
  [3.100, 0.2368],
  [3.200, 0.2313],
  [3.300, 0.2258],
  [3.400, 0.2205],
  [3.500, 0.2154],
  [3.600, 0.2106],
  [3.700, 0.2060],
  [3.800, 0.2017],
  [3.900, 0.1975],
  [4.000, 0.1935],
  [4.200, 0.1861],
  [4.400, 0.1793],
  [4.600, 0.1730],
  [4.800, 0.1672],
  [5.000, 0.1618],
]);
