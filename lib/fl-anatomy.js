// First Light — Deer Anatomy module
//
// Translates a computed bullet drop (cm relative to line of sight) into a
// concrete anatomical aim-point on a UK deer, for the user's chosen aim
// philosophy (heart, heart-lung, high-shoulder).
//
// ─── Sources ───────────────────────────────────────────────────────────
//
// Body dimensions — averages of typical adult UK deer:
//   • British Deer Society species pages
//     https://bds.org.uk/information-advice/about-deer/deer-species/
//   • Mammal Society species factsheets
//     https://mammal.org.uk/british-mammals/
//   • Wikipedia (Red deer): Scottish hill stags average 122 cm shoulder
//     height per Whitehead, "Deer of Great Britain and Ireland" (1964).
//
// Aim-point convention:
//   The Deer Initiative / BPG and BDS-aligned County Deer Stalking
//   guidance both recommend a heart/lung "cavity" shot placed at the
//   midline of the chest (halfway between brisket and top of back),
//   in line with the back of the foreleg. This gives the largest target
//   and the greatest margin for error. We adopt that as the heart_lung
//   default. Heart sits low (~25% above brisket); high-shoulder sits
//   high (~75% above brisket, just below spine) — the latter is faster
//   to anchor but smaller and risks spine miss above.
//
//   Sources:
//   • Deer Initiative Best Practice Guides (Shot Placement, 2023)
//     https://thedeerinitiative.co.uk/best-practice-guides/
//   • Best Practice Guides (Wild Deer):
//     https://bestpracticeguides.org.uk/culling/shot-placement/
//   • County Deer Stalking PDS1 placement guidance:
//     https://www.countydeerstalking.co.uk/deer-stalking/shot-placement-on-deer
//
// Sign convention for drops:
//   This module accepts the SOLVER convention: positive dropCm = bullet
//   below LoS (need to hold over). The display layer in dope-card.js uses
//   the inverted convention. Always pass the solver's raw dropCm here.

// ─── Body dimensions table ────────────────────────────────────────────
//
// chestDepthCm: typical adult, broadside, top-of-withers to brisket bone.
// Includes hide and hair. Calves/yearlings significantly smaller — use
// adult-doe figure as a conservative floor, OR refuse to provide hold.
//
// vitalZoneCm: rough diameter of the heart/lung "cavity" target. Used to
// flag when computed hold offset puts the bullet outside the vital zone.
//
// All measurements are typical mid-range averages. Real animals vary
// ±15%. The hold suggestion is approximate by design — the user is
// always responsible for their own judgement on the day.

export const SPECIES_BODY = Object.freeze({
  roe: {
    label: 'Roe',
    buck:     { chestDepthCm: 30, vitalZoneCm: 15 },
    doe:      { chestDepthCm: 28, vitalZoneCm: 14 },
    juvenile: { chestDepthCm: 22, vitalZoneCm: 11 },  // kid/yearling
    note: 'BDS: shoulder height 60–75 cm, weight 10–25 kg',
  },
  red: {
    label: 'Red',
    buck:     { chestDepthCm: 55, vitalZoneCm: 28 },  // stag
    doe:      { chestDepthCm: 48, vitalZoneCm: 24 },  // hind
    juvenile: { chestDepthCm: 36, vitalZoneCm: 18 },  // calf/yearling
    note: 'BDS / Whitehead: Scottish hill stags ~122 cm shoulder height typical',
  },
  fallow: {
    label: 'Fallow',
    buck:     { chestDepthCm: 42, vitalZoneCm: 22 },
    doe:      { chestDepthCm: 38, vitalZoneCm: 20 },
    juvenile: { chestDepthCm: 28, vitalZoneCm: 14 },  // pricket/fawn
    note: 'BDS: bucks 84–94 cm shoulder height; does 75–85 cm',
  },
  sika: {
    label: 'Sika',
    buck:     { chestDepthCm: 38, vitalZoneCm: 20 },  // stag
    doe:      { chestDepthCm: 32, vitalZoneCm: 17 },  // hind
    juvenile: { chestDepthCm: 24, vitalZoneCm: 12 },
    note: 'BDS: stags 70–95 cm shoulder height',
  },
  // Muntjac and CWD intentionally excluded — typical engagement ranges
  // are <80 m where holdover is negligible. Anatomical guidance is not
  // useful and the small body size makes any modelling error costly.
});

// ─── Aim-point definitions ────────────────────────────────────────────
//
// fractionAboveBrisket: where on the chest depth the user is aiming, as
// a fraction from the brisket (0.0) to the top of the back (1.0).
//
//   heart_lung:   50% — Deer Initiative / BDS-recommended cavity shot.
//                       The only option exposed in the UI; "heart" and
//                       "high_shoulder" entries were removed 2026-05-04 to
//                       simplify the calculator. The data structure is kept
//                       multi-entry-ready so a future stalker preference
//                       (e.g. neck shot) could be added without architecture
//                       changes.

export const AIM_POINTS = Object.freeze({
  heart_lung: {
    label: 'Heart/Lung (BDS)',
    fractionAboveBrisket: 0.50,
    description: 'Mid-chest, halfway between brisket and back',
  },
});

export const DEFAULT_AIM_POINT = 'heart_lung';

// ─── Hold-to-anatomy translation ──────────────────────────────────────

/**
 * Given a solver dropCm (positive = below LoS) at the target range, the
 * species/sex of the deer, and the chosen aim point, return a textual
 * hold reference plus a confidence assessment.
 *
 * @param {Object} args
 * @param {number} args.dropCm           — solver convention (positive = below LoS)
 * @param {string} args.speciesKey       — 'roe' | 'red' | 'fallow' | 'sika'
 * @param {string} args.sex              — 'buck' | 'doe' | 'juvenile'
 * @param {string} args.aimPointKey      — key in AIM_POINTS
 *
 * @returns {{
 *   ok: boolean,
 *   text: string,
 *   reference: string|null,
 *   warning: string|null,
 *   chestDepthCm: number|null,
 *   holdFractionFromAim: number|null,
 * }}
 */
export function getAnatomicalHold({ dropCm, speciesKey, sex, aimPointKey }) {
  const species = SPECIES_BODY[speciesKey];
  if (!species) {
    return {
      ok: false,
      text: 'Anatomical hold not available for this species',
      reference: null, warning: null,
      chestDepthCm: null, holdFractionFromAim: null,
    };
  }
  const sx = species[sex] || species.doe;  // fallback to doe (smaller)
  const chest = sx.chestDepthCm;
  const vital = sx.vitalZoneCm;

  const aim = AIM_POINTS[aimPointKey] || AIM_POINTS[DEFAULT_AIM_POINT];

  // Hold convention: positive dropCm means bullet falls below LoS, so we
  // need to aim *higher* on the deer than the desired impact point. The
  // amount higher, expressed as a fraction of chest depth, is dropCm/chest.
  // Negative dropCm (bullet rising above LoS at this range — short of
  // zero) means we need to aim *lower* than the desired impact.
  const holdFraction = dropCm / chest;
  const aimFraction = aim.fractionAboveBrisket + holdFraction;

  // Clamp to compute the textual reference, but flag if outside body.
  const onBody = aimFraction >= 0 && aimFraction <= 1;

  // ── Pick the reference phrase ───────────────────────────────────────
  // Map [0,1] aim fraction (brisket→back) onto named anatomical zones.
  // Each band is roughly an eighth of chest depth.
  let reference;
  if (aimFraction < 0) {
    reference = `Below the brisket (off the body)`;
  } else if (aimFraction < 0.10) {
    reference = `At the brisket (very low chest)`;
  } else if (aimFraction < 0.30) {
    reference = `Lower chest, behind the foreleg (heart line)`;
  } else if (aimFraction < 0.45) {
    reference = `Mid-low chest`;
  } else if (aimFraction < 0.55) {
    reference = `Centre of chest, halfway up the body`;
  } else if (aimFraction < 0.70) {
    reference = `Mid-high chest`;
  } else if (aimFraction < 0.95) {
    reference = `Upper chest, just below the spine line`;
  } else if (aimFraction <= 1.00) {
    // Tightened from 0.85 to 0.95 (2026-05-04): at 0.85, calling that "spine
    // line" was over-claiming — anatomically the spine is the top 5% of chest
    // depth, not the top 15%. Visual reticle at 0.88 sits clearly on the
    // body, but the old description said "top of the back" which contradicted
    // what the user saw.
    reference = `Top of the back (spine line)`;
  } else if (aimFraction <= 1.20) {
    reference = `Just above the back`;
  } else {
    const aboveCm = (aimFraction - 1.0) * chest;
    reference = `${aboveCm.toFixed(0)} cm above the top of the back`;
  }

  // ── Warnings ─────────────────────────────────────────────────────────
  let warning = null;

  // Off-body aim → strong cautionary
  if (!onBody) {
    if (aimFraction < 0) {
      warning = 'Aim point falls below the brisket — bullet would impact above this line. Reconsider the shot.';
    } else if (aimFraction > 1.0) {
      warning = 'Holdover exceeds the deer\'s chest depth. This is a long shot for this species — consider whether range is appropriate.';
    }
  }

  // Vital-zone size check — at long ranges, even with correct hold the
  // ranging error compounds. Flag when |drop| ≥ vital zone radius × 1.5,
  // i.e. a 15% range error would push the bullet outside the vital zone.
  if (Math.abs(dropCm) > vital * 1.5 && !warning) {
    warning = `Hold offset (${Math.abs(dropCm).toFixed(0)} cm) approaches or exceeds the vital zone — small ranging error has a large impact at this distance.`;
  }

  // Build text output
  let text;
  if (Math.abs(dropCm) < 1.0) {
    // Strip any parenthetical attribution (e.g. "Heart/Lung (BDS)" → "heart/lung")
    const cleanLabel = aim.label.replace(/\s*\([^)]*\)\s*/g, '').toLowerCase();
    text = `Aim directly at the ${cleanLabel}`;
  } else if (dropCm > 0) {
    // Bullet falls below LoS — hold high. Plain text (no arrow glyph) so
    // the dope-card PDF (Helvetica/WinAnsi, can't render Unicode arrows)
    // can print it; the on-screen calculator UI overlays an ↑ at render time.
    text = `Hold ${dropCm.toFixed(1)} cm high — ${reference.toLowerCase()}`;
  } else {
    // Bullet above LoS at this range (short of zero) — hold low. Plain text;
    // see comment above. UI overlays a ↓ at render time.
    text = `Hold ${Math.abs(dropCm).toFixed(1)} cm low — ${reference.toLowerCase()}`;
  }

  return {
    ok: true,
    text,
    reference,
    warning,
    chestDepthCm: chest,
    holdFractionFromAim: holdFraction,
  };
}

// ─── List helpers for UI ──────────────────────────────────────────────

export function listSpeciesForAnatomy() {
  return Object.entries(SPECIES_BODY).map(([key, v]) => ({
    key, label: v.label,
  }));
}

export function listAimPoints() {
  return Object.entries(AIM_POINTS).map(([key, v]) => ({
    key, label: v.label, description: v.description,
  }));
}

// ─── Silhouette renderer ──────────────────────────────────────────────
//
// Produces an inline SVG of a broadside deer silhouette with three marks:
//   • the aim point (yellow star) — where the user puts the crosshair
//   • the vital zone (red ellipse, semi-transparent) — the heart/lung target
//   • the impact point (green dot) — where the bullet actually lands
//
// At the user's current range, the bullet lands `dropCm` below where they
// aimed (solver convention). So if they aim at heart_lung centre and drop
// is +15 cm, the impact dot sits 15 cm lower than the star on the deer.
//
// The silhouette is a generic deer stylisation (legs, body, neck, head)
// rather than a species-accurate illustration. Proportions are normalised
// to the species' chest depth so the cm-scale of the dots is accurate.
//
// Returns SVG markup string suitable for direct innerHTML insertion.

const SILHOUETTE_PATH = `
  M 50 130
  L 60 130 L 60 105 L 70 105 L 75 95
  C 95 88, 130 85, 165 82
  L 175 75 L 195 60 L 215 55 L 235 55 L 245 65
  L 248 80 L 240 90 L 235 88 L 230 95 L 225 95
  L 220 92 L 215 95
  C 200 100, 180 102, 165 102
  L 165 130 L 175 130 L 175 138 L 158 138 L 155 128
  C 145 125, 130 122, 115 122
  L 115 130 L 125 130 L 125 138 L 105 138 L 100 122
  C 80 119, 65 115, 60 110
  L 55 138 L 45 138 Z
`.replace(/\s+/g, ' ').trim();

// SVG viewport: 240×110 units starting at (30, 40). Reticle and vital
// markers are positioned in this coordinate space.
const VIEW_X = 30, VIEW_Y = 40, VIEW_W = 240, VIEW_H = 110;

// Per-species raster illustrations. Each entry maps the species code to a
// PNG with anchor points expressed as fractions (0–1) of the image. The
// markers (vital ellipse, aim dot, crosshair) are positioned relative to
// these anchors so they land on the deer's actual anatomy in the image
// rather than on the hand-coded fallback path's coordinates.
//
// To add a species: place the PNG under `species/aimthedeer/`, measure
// the withers (top of shoulder hump), brisket (bottom of chest between
// front legs), and foreleg vertical centre as fractions of image height
// and width, and add an entry below. The PNG must have a transparent
// background — opaque white will render as a solid rectangle on the dark
// calculator card.
const SPECIES_IMAGE = Object.freeze({
  // All 6 species are SVGs of the same provenance — single-path silhouettes
  // recoloured #000000 → #2a3a1e and recropped to ~2.0 aspect viewBoxes
  // that fit the calculator's anatomy panel cleanly. Anchor fracs are
  // initial estimates based on typical proportions per species; visual
  // iteration is expected (nudge by ±0.02 to move the vital ellipse and
  // reticle on/off the heart). The earlier `redstag.png` is preserved on
  // disk as a backup but no longer used; remove from PRECACHE_URLS.
  red: {
    url: './species/aimthedeer/reddeer.svg',
    aspectRatio: 858 / 429,        // 2.0
    // Antlers occupy the top ~40% of the cropped viewBox — body sits lower
    // than the initial 0.30/0.65 estimates suggested. Visual iteration
    // (2026-05-04) moved the heart-lung ellipse from the deer's neck onto
    // the actual chest cavity.
    withersFrac: 0.42,
    brisketFrac: 0.72,
    // Despite the field name, this is the X anchor for ALL chest markers
    // (vital ellipse, aim dot, reticle, dashed lines), not strictly the
    // foreleg position. Heart-lung sits BEHIND the shoulder, slightly back
    // from the foreleg vertical line — so this is set a few percent left
    // of where the actual foreleg renders. Same convention applies to the
    // other species below.
    forelegFrac: 0.50,
  },
  roe: {
    url: './species/aimthedeer/roedeer.svg',
    aspectRatio: 784 / 392,        // 2.0
    withersFrac: 0.304,            // measured against rendered file
    brisketFrac: 0.694,
    forelegFrac: 0.527,
  },
  fallow: {
    url: './species/aimthedeer/fallow.svg',
    aspectRatio: 878 / 439,        // 2.0
    // Visual iteration history:
    //   pass 1: 0.32 / 0.68 — vital landed on neck, way too high
    //   pass 2: 0.48 / 0.74 — vital correct, but reticle at "spine line"
    //                         description rendered visibly below the back
    //   pass 3: 0.43 / 0.71 — moved the right direction but still not enough
    //                         (sika at hold 18.2 cm proved the back was even
    //                         higher in the rendered SVG than 0.43 suggested)
    //   pass 4: 0.38 / 0.70 — chest span 0.32 of viewport, reticle for spine-
    //                         line-band holds now lands at the actual back.
    // forelegFrac bracketed in 0.48 / 0.55 → 0.52 (mid-chest, behind shoulder).
    withersFrac: 0.38,
    brisketFrac: 0.70,
    forelegFrac: 0.52,
  },
  sika: {
    url: './species/aimthedeer/sika.svg',
    aspectRatio: 886 / 443,        // 2.0
    // Same correction trajectory as fallow — see comment above.
    withersFrac: 0.38,
    brisketFrac: 0.70,
    forelegFrac: 0.52,
  },
  muntjac: {
    url: './species/aimthedeer/muntjac.svg',
    aspectRatio: 748 / 374,        // 2.0
    // Muntjac have hindquarters higher than the withers — the "humped"
    // posture. Anchors below assume the foreleg/withers convention; if the
    // visual reticle lands oddly, this is the species to look at first.
    withersFrac: 0.25,
    brisketFrac: 0.65,
    forelegFrac: 0.50,
  },
  cwd: {
    url: './species/aimthedeer/cwd.svg',
    aspectRatio: 946 / 473,        // 2.0
    // Chinese water deer have no antlers but large rounded ears at the top.
    withersFrac: 0.20,
    brisketFrac: 0.65,
    forelegFrac: 0.55,
  },
});

// Fallback anchors for the hand-coded SVG path (when no per-species image
// exists). Withers ≈ 82, brisket ≈ 130, foreleg centre at 130. These are
// the values that have always been used by SILHOUETTE_PATH.
const FALLBACK_ANCHORS = Object.freeze({
  withersY: 82, brisketY: 130, forelegX: 130,
});

/** Compute the SVG coordinates of the deer's withers, brisket and foreleg
 *  centre for the given species. If a raster image exists, fits it inside
 *  the viewport with preserveAspectRatio='xMidYMid meet' and converts the
 *  image's fractional anchor points into viewport coordinates. Otherwise
 *  returns the fallback anchors used by the hand-coded path. */
function getDeerAnchors(speciesKey) {
  const img = SPECIES_IMAGE[speciesKey];
  if (!img) return { hasImage: false, ...FALLBACK_ANCHORS };
  // Fit image inside the viewport preserving aspect ratio.
  const viewAspect = VIEW_W / VIEW_H;
  let imgW, imgH, imgX, imgY;
  if (img.aspectRatio > viewAspect) {
    // wider than viewport — width fills, vertically letterbox
    imgW = VIEW_W;
    imgH = VIEW_W / img.aspectRatio;
    imgX = VIEW_X;
    imgY = VIEW_Y + (VIEW_H - imgH) / 2;
  } else {
    // taller than viewport — height fills, horizontally letterbox
    imgH = VIEW_H;
    imgW = VIEW_H * img.aspectRatio;
    imgX = VIEW_X + (VIEW_W - imgW) / 2;
    imgY = VIEW_Y;
  }
  return {
    hasImage: true,
    imageUrl: img.url,
    imageX: imgX, imageY: imgY, imageW: imgW, imageH: imgH,
    withersY: imgY + img.withersFrac * imgH,
    brisketY: imgY + img.brisketFrac * imgH,
    forelegX: imgX + img.forelegFrac * imgW,
  };
}

/**
 * Build an SVG silhouette of a broadside deer with aim/impact markers.
 *
 * @param {Object} args
 * @param {number} args.dropCm           — solver convention (positive = below LoS)
 * @param {string} args.speciesKey
 * @param {string} args.sex
 * @param {string} args.aimPointKey
 * @param {boolean} [args.compact]        — smaller version for inline UI
 * @returns {string} SVG markup
 */
export function renderDeerSilhouette({ dropCm, speciesKey, sex, aimPointKey, compact = false }) {
  const species = SPECIES_BODY[speciesKey];
  if (!species) return '';
  const sx = species[sex] || species.doe;
  const chest = sx.chestDepthCm;
  const vital = sx.vitalZoneCm;
  const aim = AIM_POINTS[aimPointKey] || AIM_POINTS[DEFAULT_AIM_POINT];

  const anchors = getDeerAnchors(speciesKey);
  const SVG_BRISKET_Y = anchors.brisketY;
  const SVG_WITHERS_Y = anchors.withersY;
  const SVG_CHEST_X = anchors.forelegX;
  const SVG_CHEST_SPAN = SVG_BRISKET_Y - SVG_WITHERS_Y;
  // Map cm → SVG units. Chest depth in SVG units = chest cm.
  const cmToSvg = SVG_CHEST_SPAN / chest;

  // Two points to draw on the deer:
  //   1. Desired impact point (the green dot) = where the user wants the
  //      bullet to land. That's their chosen aim point — heart, heart/lung
  //      centre, or high shoulder. This is fixed on the body, independent
  //      of range or drop.
  //   2. Crosshair hold position = where the user puts the crosshair so
  //      the bullet falls onto the desired impact point. That's the
  //      desired-impact position MINUS the drop (since positive drop means
  //      the bullet falls below where it was aimed).
  const desiredImpactY = SVG_BRISKET_Y - aim.fractionAboveBrisket * SVG_CHEST_SPAN;

  // Crosshair must sit ABOVE the impact point by `dropCm` worth of SVG
  // units (lower y value in SVG = higher on the deer). dropCm > 0 (bullet
  // falls below LoS) → hold higher → smaller y value.
  const crosshairY = desiredImpactY - dropCm * cmToSvg;
  // Show the reticle anywhere within the SVG viewport, not just near the
  // deer's body. The previous threshold was tied to the body extent
  // (withers−5 to brisket+5), which hid the reticle for any holdover
  // larger than ~half the chest depth (≈17 cm for roe) — typical at 200m+
  // for most calibres, and not a useful disappearance.
  const crosshairInViewport = crosshairY >= VIEW_Y && crosshairY <= VIEW_Y + VIEW_H;

  // Vital zone: ellipse around the heart/lung centre (50% chest height,
  // matching DI heart_lung). Always shown at heart_lung centre regardless
  // of aim point — it's the underlying anatomical target.
  const vitalCenterY = SVG_BRISKET_Y - 0.50 * SVG_CHEST_SPAN;
  const vitalRadiusY = (vital / 2) * cmToSvg;
  const vitalRadiusX = vitalRadiusY * 1.15;  // slightly wider than tall

  // No inline width/height — let CSS handle responsive sizing via the
  // viewBox's intrinsic aspect ratio. The previous hardcoded 200×110 was
  // a 1.82-aspect render target inside a 2.18-aspect viewBox, which made
  // preserveAspectRatio letterbox vertically AND clamped the deer to a
  // small fixed pixel size on mobile where there was room for ~3× more.
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="30 40 240 110" role="img" aria-label="Deer silhouette with aim point and projected impact">
  <!-- Body silhouette: per-species PNG when available, hand-coded path as fallback. -->
  ${anchors.hasImage
    ? `<image href="${anchors.imageUrl}" x="${anchors.imageX.toFixed(1)}" y="${anchors.imageY.toFixed(1)}" width="${anchors.imageW.toFixed(1)}" height="${anchors.imageH.toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>`
    : `<path d="${SILHOUETTE_PATH}" fill="#2a3a1e" stroke="#5a7a30" stroke-width="1.5" stroke-linejoin="round"/>`}

  <!-- Vital zone ellipse (red, semi-transparent) -->
  <ellipse cx="${SVG_CHEST_X}" cy="${vitalCenterY.toFixed(1)}"
           rx="${vitalRadiusX.toFixed(1)}" ry="${vitalRadiusY.toFixed(1)}"
           fill="rgba(198,40,40,0.30)" stroke="rgba(255,80,80,0.7)" stroke-width="1"/>

  <!-- Vertical reference line through foreleg -->
  <line x1="${SVG_CHEST_X}" y1="${SVG_WITHERS_Y - 4}" x2="${SVG_CHEST_X}" y2="${SVG_BRISKET_Y + 6}"
        stroke="rgba(255,255,255,0.15)" stroke-width="0.7" stroke-dasharray="2,2"/>

  <!-- Desired impact point: green dot at the user's chosen aim point
       (heart, heart/lung, or high shoulder). This is where the bullet
       should land on the deer. -->
  <circle cx="${SVG_CHEST_X}" cy="${desiredImpactY.toFixed(1)}" r="3.5"
          fill="#7adf7a" stroke="#0e1e0a" stroke-width="1"/>

  <!-- Hold crosshair: gold crosshair where the user puts the scope,
       so the bullet falls onto the desired impact point. Drawn only
       if the hold position is on the deer's body. -->
  ${crosshairInViewport ? `
  <g transform="translate(${SVG_CHEST_X},${crosshairY.toFixed(1)})">
    <circle r="5" fill="none" stroke="#c8a84b" stroke-width="1.5"/>
    <line x1="-8" y1="0" x2="8" y2="0" stroke="#c8a84b" stroke-width="1.2"/>
    <line x1="0" y1="-8" x2="0" y2="8" stroke="#c8a84b" stroke-width="1.2"/>
  </g>
  <!-- Dashed line showing bullet path from hold position down to impact -->
  <line x1="${SVG_CHEST_X}" y1="${crosshairY.toFixed(1)}"
        x2="${SVG_CHEST_X}" y2="${desiredImpactY.toFixed(1)}"
        stroke="#c8a84b" stroke-width="0.8" stroke-dasharray="1.5,1.5" opacity="0.5"/>
  ` : ''}
</svg>
  `.trim();
}
