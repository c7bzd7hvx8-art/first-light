// =============================================================================
// First Light — modules/dope-card.mjs
//
// Generates the printable dope card PDF for the ballistic calculator.
// Sibling to modules/pdf.mjs (which serves the cull diary). Same convention:
//   * Reads `window.jspdf` for the jsPDF UMD bundle (loaded as a classic
//     <script> in ballistics.html).
//   * Pure-ish: all inputs come in, returns a jsPDF `doc` object. The
//     caller is responsible for triggering the download/save action.
//   * Deliberately self-contained — does not depend on diary-side modules.
//
// Public API
//   buildDopeCardPDF({ profile, ammoLoad, conditions, dropCurve,
//                      sizeName, jurisdictionLabel, speciesLabel,
//                      thresholdFtLb })
//     → jsPDF doc
//
//   Dope card sizes:
//     'A6' — 105×148mm portrait. Fits in a rifle case pouch when
//             laminated. Single page, condensed table.
//     'A4' — 210×297mm portrait. Gun-cabinet display. Roomier table,
//             larger type, includes the drop chart as a sketched curve.
//
// Design notes
// ────────────
// The card is meant to be used in the field — readable in low light, with
// gloved hands, possibly damp. Three priorities drive the layout:
//   1. The drop table is the centre of the card. Other content compresses
//      to make room.
//   2. Each row shows distance, drop (cm + MOA), velocity, energy. Energy
//      is colour-coded: a thin band along the row's right edge goes red
//      where energy falls below the species threshold.
//   3. Conditions assumed (temp, pressure, zero) are stated at the top so
//      the user can spot when the card is invalid (e.g. printed for
//      summer, used in winter).
//
// Out of scope for v1 (revisit if users ask):
//   * Wind drift columns — too dependent on assumed conditions.
//   * Multi-page tables for long-range loads.
//   * Custom paper sizes or landscape.
// =============================================================================

import {
  getAnatomicalHold, AIM_POINTS, SPECIES_BODY,
} from '../lib/fl-anatomy.js';

const A6_MM = { w: 105, h: 148 };
const A4_MM = { w: 210, h: 297 };

const COLOURS = Object.freeze({
  forestRGB: [26, 58, 14],     // --forest
  mossRGB:   [90, 122, 48],    // --moss
  goldRGB:   [200, 168, 75],   // --gold
  barkRGB:   [61, 43, 31],     // --bark
  mutedRGB:  [160, 152, 138],  // --muted
  stoneRGB:  [237, 233, 226],  // --stone (light fill)
  redRGB:    [198, 40, 40],    // --red
});

/**
 * Build the dope card PDF.
 *
 * @param {object} args
 * @param {object} args.profile           — { name, muzzleVelocityFps,
 *                                            weightGrains, bcG1, bcG7,
 *                                            sightHeightCm, zeroRangeM,
 *                                            barrelInches }
 * @param {object|null} args.ammoLoad     — display name resolved by caller
 *                                            via loadDisplayName(); pass
 *                                            null for manual-entry profiles
 * @param {object} args.conditions        — { tempC, pressureHpa,
 *                                            humidityPct }
 * @param {Array}  args.dropCurve         — [{ rangeM, dropCm, velocityFps,
 *                                              velocityMs, energyFtLbs,
 *                                              energyJ, dropMoa, dropMil }]
 *                                            Must be pre-sorted ascending
 *                                            by rangeM.
 * @param {'A6'|'A4'} args.sizeName
 * @param {string} args.jurisdictionLabel — e.g. "England & Wales"
 * @param {string} args.speciesLabel      — e.g. "Fallow"
 * @param {number|null} args.thresholdFtLb— statutory minimum at impact
 *                                            for speciesLabel; rows below
 *                                            this are visually flagged
 * @returns {object} jsPDF document
 */
export function buildDopeCardPDF(args) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error('jsPDF not loaded');
  }
  const { jsPDF } = window.jspdf;

  const size = args.sizeName === 'A4' ? A4_MM : A6_MM;
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: [size.w, size.h],
    compress: true,
  });
  const isLarge = args.sizeName === 'A4';

  // Margins differ between sizes: A6 needs to be tight (max table area on
  // a small page); A4 can breathe.
  const m = isLarge ? 14 : 7;     // page margin (mm)
  let y = m + 2;

  // ── Header ──────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...COLOURS.goldRGB);
  doc.setFontSize(isLarge ? 8 : 6);
  doc.text('FIRST LIGHT  |  BALLISTIC CALCULATOR', m, y);
  y += isLarge ? 6 : 4;

  // Rifle name
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...COLOURS.forestRGB);
  doc.setFontSize(isLarge ? 18 : 12);
  doc.text(args.profile.name || 'Rifle', m, y);
  y += isLarge ? 6 : 4;

  // Ammunition line
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...COLOURS.barkRGB);
  doc.setFontSize(isLarge ? 10 : 7);
  const ammoLine = args.ammoLoad ||
    (args.profile.muzzleVelocityFps + ' fps · ' + args.profile.weightGrains + ' gr · BC ' +
      (args.profile.bcG7 > 0 ? 'G7 ' + args.profile.bcG7.toFixed(3) : 'G1 ' + args.profile.bcG1.toFixed(3)));
  doc.text(ammoLine, m, y);
  y += isLarge ? 5 : 3.5;

  // Subline: zero, sight height, barrel (if available)
  doc.setTextColor(...COLOURS.mutedRGB);
  doc.setFontSize(isLarge ? 8 : 6);
  const setupLine = [
    'Zero ' + args.profile.zeroRangeM + 'm',
    'Sight ht ' + args.profile.sightHeightCm.toFixed(1) + ' cm',
    args.profile.barrelInches ? args.profile.barrelInches + ' in barrel' : null,
  ].filter(Boolean).join('  |  ');
  doc.text(setupLine, m, y);
  y += isLarge ? 8 : 5;

  // ── Conditions assumed ──────────────────────────────────────────────
  doc.setDrawColor(...COLOURS.stoneRGB);
  doc.setLineWidth(0.3);
  doc.line(m, y, size.w - m, y);
  y += isLarge ? 4 : 3;

  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...COLOURS.mossRGB);
  doc.setFontSize(isLarge ? 8 : 6);
  doc.text('CONDITIONS ASSUMED', m, y);
  y += isLarge ? 4.5 : 3;

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...COLOURS.barkRGB);
  doc.setFontSize(isLarge ? 9 : 7);
  const condLine = [
    args.conditions.tempC.toFixed(0) + ' C',
    args.conditions.pressureHpa.toFixed(0) + ' hPa',
    args.conditions.humidityPct.toFixed(0) + '% RH',
  ].join('  ·  ');
  doc.text(condLine, m, y);
  y += isLarge ? 8 : 5;

  // ── Threshold legend (if applicable) ────────────────────────────────
  if (args.thresholdFtLb && args.speciesLabel) {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLOURS.mutedRGB);
    doc.setFontSize(isLarge ? 8 : 6);
    doc.text(
      'Energy minimum: ' + args.thresholdFtLb + ' ft-lb (' + args.speciesLabel + ', ' +
      args.jurisdictionLabel + '). Rows below this are flagged.',
      m, y, { maxWidth: size.w - 2 * m }
    );
    y += isLarge ? 6 : 4;
  }

  // ── Drop table ──────────────────────────────────────────────────────
  // Column layout — relative weights, then computed absolute positions.
  // Range / Drop / MOA / Velocity / Energy (5 cols). Optional energy band
  // on the right.
  const tableX = m;
  const tableW = size.w - 2 * m;
  const colW = isLarge
    ? { range: 22, drop: 30, moa: 22, vel: 36, energy: 30 }
    : { range: 14, drop: 18, moa: 14, vel: 22, energy: 18 };
  // Anchor rightward — energy column gets pushed to the right.
  let cx = tableX;
  const colX = {
    range:  cx, end_range: cx += colW.range,
    drop:   cx, end_drop:  cx += colW.drop,
    moa:    cx, end_moa:   cx += colW.moa,
    vel:    cx, end_vel:   cx += colW.vel,
    energy: cx,
  };
  // Row right-anchor for the energy band:
  const tableEndX = tableX + tableW;

  // Header row
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(isLarge ? 9 : 7);
  doc.setTextColor(...COLOURS.forestRGB);
  doc.text('Range', colX.range, y);
  doc.text('Drop',  colX.drop,  y);
  doc.text('MOA',   colX.moa,   y);
  doc.text('Vel',   colX.vel,   y);
  doc.text('Energy',colX.energy,y);
  y += 2;
  doc.setDrawColor(...COLOURS.mossRGB);
  doc.setLineWidth(0.4);
  doc.line(tableX, y, tableEndX, y);
  doc.setLineWidth(0.2);
  y += isLarge ? 4 : 3;

  // Body rows
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(isLarge ? 9 : 7);
  doc.setTextColor(...COLOURS.barkRGB);
  const rowH = isLarge ? 5.5 : 3.8;

  // Decide which subset of the curve to render. The dropCurve sampling
  // produced by the UI may be denser than makes sense on the card. For
  // A6 we render every 25m; for A4 every 25m too but we may have more
  // vertical space. Either way, filter to multiples of 25m within the
  // card's printable region.
  const rows = (args.dropCurve || []).filter(r =>
    Number.isFinite(r.rangeM) && r.rangeM % 25 === 0 && r.rangeM <= 400
  );

  // How many rows fit?
  const bottomBudget = isLarge ? 32 : 18;     // leave room for footer
  const maxRows = Math.floor((size.h - m - bottomBudget - y) / rowH);
  const rowsToRender = rows.slice(0, maxRows);

  for (const r of rowsToRender) {
    // Light alternating row tint (cosmetic only on colour printers)
    if (Math.round(r.rangeM / 25) % 2 === 0) {
      doc.setFillColor(248, 245, 238);
      doc.rect(tableX, y - rowH + 1, tableW, rowH, 'F');
    }

    // Range
    doc.setTextColor(...COLOURS.forestRGB);
    doc.setFont('helvetica', 'bold');
    doc.text(r.rangeM + ' m', colX.range, y);

    // Drop — industry-standard sign convention: positive = above LoS,
    // negative = below LoS. Matches the convention printed on Hornady,
    // Federal, etc. ammo boxes (e.g. "300 yds  -6.4\"" means bullet is
    // 6.4 inches below LoS at 300 yards). Solver's internal dropCm is
    // positive-below-LoS, so we negate it here for display.
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLOURS.barkRGB);
    const dispDropCm = -r.dropCm;
    const dropSign = dispDropCm >= 0 ? '+' : '-';
    const dropStr = dropSign + Math.abs(dispDropCm).toFixed(1) + ' cm';
    doc.text(dropStr, colX.drop, y);

    // MOA — same convention as drop. Negate the solver's dropMoa so
    // positive = above LoS, negative = below.
    const moa = r.dropMoa != null ? -r.dropMoa : 0;
    const moaStr = (moa >= 0 ? '+' : '') + moa.toFixed(1);
    doc.text(moaStr, colX.moa, y);

    // Velocity (fps)
    doc.text(Math.round(r.velocityFps) + ' fps', colX.vel, y);

    // Energy (ft-lb), with red flag if below threshold
    const e = Math.round(r.energyFtLbs);
    const belowThreshold = args.thresholdFtLb && e < args.thresholdFtLb;
    if (belowThreshold) {
      doc.setTextColor(...COLOURS.redRGB);
      doc.setFont('helvetica', 'bold');
    }
    doc.text(e + ' ft-lb', colX.energy, y);
    if (belowThreshold) {
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLOURS.barkRGB);
      // Right-edge red band
      doc.setFillColor(...COLOURS.redRGB);
      doc.rect(tableEndX - 0.6, y - rowH + 1, 0.6, rowH, 'F');
    }

    y += rowH;
  }

  // ── Anatomical hold reference (if enabled) ──────────────────────────
  // Picks three useful ranges from the dope curve (closest to 100/200/300m)
  // and shows the anatomical hold for each. Compact — single line per range.
  if (args.anatomy && SPECIES_BODY[args.anatomy.speciesKey]) {
    const sp = SPECIES_BODY[args.anatomy.speciesKey];
    const aim = AIM_POINTS[args.anatomy.aimPointKey] || AIM_POINTS.heart_lung;
    const sx = sp[args.anatomy.sex] || sp.doe;

    // Pick the rows closest to the target ranges, capped to what curve has.
    const targets = [100, 200, 300];
    const picks = targets.map(t => {
      let best = null;
      let bestDist = Infinity;
      for (const r of args.dropCurve) {
        const d = Math.abs(r.rangeM - t);
        if (d < bestDist) { bestDist = d; best = r; }
      }
      return best;
    }).filter(r => r != null);

    // De-duplicate (in case the curve doesn't reach 300 etc.)
    const seen = new Set();
    const uniquePicks = picks.filter(r => {
      if (seen.has(r.rangeM)) return false;
      seen.add(r.rangeM); return true;
    });

    if (uniquePicks.length > 0) {
      const anatY = y + (isLarge ? 4 : 2);
      doc.setDrawColor(...COLOURS.stoneRGB);
      doc.line(m, anatY, size.w - m, anatY);

      let ay = anatY + (isLarge ? 6 : 4);
      doc.setFontSize(isLarge ? 8 : 6);
      doc.setTextColor(...COLOURS.forestRGB);
      doc.setFont('helvetica', 'bold');
      doc.text('AIM ON THE DEER', m, ay);

      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...COLOURS.mutedRGB);
      const sexLabel = (args.anatomy.sex === 'juvenile') ? 'juvenile'
        : (args.anatomy.sex === 'buck')
          ? ((args.anatomy.speciesKey === 'red' || args.anatomy.speciesKey === 'sika') ? 'stag' : 'buck')
          : ((args.anatomy.speciesKey === 'red' || args.anatomy.speciesKey === 'sika') ? 'hind' : 'doe');
      const subtitle = `${sp.label} ${sexLabel}  ·  ${aim.label}  ·  chest ~${sx.chestDepthCm} cm`;
      const subW = doc.getTextWidth ? doc.getTextWidth(subtitle) : subtitle.length * 1.4;
      doc.text(subtitle, size.w - m - subW, ay);

      ay += isLarge ? 5 : 3.5;
      doc.setFontSize(isLarge ? 8 : 6);
      doc.setTextColor(...COLOURS.barkRGB);
      for (const row of uniquePicks) {
        const anat = getAnatomicalHold({
          dropCm: row.dropCm,
          speciesKey: args.anatomy.speciesKey,
          sex: args.anatomy.sex,
          aimPointKey: args.anatomy.aimPointKey,
        });
        if (!anat.ok) continue;
        const line = `${row.rangeM} m   ${anat.text}`;
        doc.text(line, m + (isLarge ? 4 : 2), ay);
        ay += isLarge ? 4.5 : 3;
      }

      // Move y past the anatomy block so the footer line sits below it
      y = ay + (isLarge ? 2 : 1);
    }
  }

  // ── Footer ──────────────────────────────────────────────────────────
  const footerY = size.h - m - 2;
  doc.setDrawColor(...COLOURS.stoneRGB);
  doc.line(m, footerY - (isLarge ? 8 : 6), size.w - m, footerY - (isLarge ? 8 : 6));

  doc.setFontSize(isLarge ? 7 : 5);
  doc.setTextColor(...COLOURS.mutedRGB);
  doc.setFont('helvetica', 'normal');
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  doc.text('Generated ' + dateStr + '  |  firstlightdeer.co.uk', m, footerY);

  // Right-aligned disclaimer
  const disclaimer = 'Guidance only — verify against chronograph data';
  const w = doc.getTextWidth ? doc.getTextWidth(disclaimer) : (disclaimer.length * 1.4);
  doc.text(disclaimer, size.w - m - w, footerY);

  // For A4: leave room for a sketched drop curve at the bottom. Skip the
  // curve if there's no space (rendered table consumed everything).
  if (isLarge && rowsToRender.length < rows.length) {
    // Dropped some rows — table is dense enough. Skip the curve.
  } else if (isLarge) {
    // Sketched drop-curve sparkline beneath the table.
    const chartTop = y + 4;
    const chartBottom = footerY - 12;
    const chartH = chartBottom - chartTop;
    if (chartH > 20 && rows.length > 1) {
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...COLOURS.mossRGB);
      doc.setFontSize(7);
      doc.text('TRAJECTORY', m, chartTop - 1);

      const chartLeft = m;
      const chartRight = size.w - m;
      const chartW = chartRight - chartLeft;
      const maxR = Math.max(...rows.map(r => r.rangeM));
      const minD = Math.min(...rows.map(r => r.dropCm), 0);
      const maxD = Math.max(...rows.map(r => r.dropCm), 0);
      const dSpan = Math.max(20, maxD - minD);

      doc.setDrawColor(...COLOURS.stoneRGB);
      doc.rect(chartLeft, chartTop, chartW, chartH);

      // y=0 baseline
      const yZero = chartTop + ((maxD - 0) / dSpan) * chartH;
      doc.setDrawColor(...COLOURS.goldRGB);
      doc.setLineDashPattern([1, 1], 0);
      doc.line(chartLeft, yZero, chartRight, yZero);
      doc.setLineDashPattern([], 0);

      // Curve
      doc.setDrawColor(...COLOURS.forestRGB);
      doc.setLineWidth(0.4);
      let prev = null;
      for (const r of rows) {
        const px = chartLeft + (r.rangeM / maxR) * chartW;
        const py = chartTop + ((maxD - r.dropCm) / dSpan) * chartH;
        if (prev) doc.line(prev.x, prev.y, px, py);
        prev = { x: px, y: py };
      }
      doc.setLineWidth(0.2);
    }
  }

  return doc;
}

/**
 * Convenience: trigger a browser download for the produced PDF.
 * Splits filename by sizeName so users can see which one they printed.
 */
export function downloadDopeCardPDF(doc, profileName, sizeName) {
  const safe = String(profileName || 'rifle')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .toLowerCase() || 'rifle';
  const filename = 'first-light-dope-' + safe + '-' + (sizeName || 'A6').toLowerCase() + '.pdf';
  doc.save(filename);
}
