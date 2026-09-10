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
//   2. Each row shows distance, drop (cm + MOA + MIL), a reference wind
//      drift, velocity, energy. Energy is colour-coded: a thin band along
//      the row's right edge goes red where energy falls below the species
//      threshold.
//   3. Conditions assumed (temp, pressure, zero) are stated at the top so
//      the user can spot when the card is invalid (e.g. printed for
//      summer, used in winter).
//
// The caller controls the ranges printed (the dropCurve rows it passes),
// so custom / user-chosen reference distances "just work" — this module
// renders whatever finite ranges it is given, sorted ascending.
//
// Out of scope for v1 (revisit if users ask):
//   * Multi-page tables for long-range loads.
//   * Custom paper sizes or landscape.
// =============================================================================

import {
  getAnatomicalHold, AIM_POINTS, SPECIES_BODY,
} from '../lib/fl-anatomy.js';

/**
 * Compact one-line rendering of a lib/fl-deer-law.js threshold record, for
 * printing the statutory minimum on the card itself.
 *
 * The card previously printed the retained-energy figure and then said it was
 * "not the legal test" without ever saying what the legal test is. This card
 * is the thing in the rifle case at the moment a marginal shot is weighed, so
 * the statutory numbers belong on it.
 *
 * Two nuances are carried through from the data rather than flattened:
 *   * A null minCalibreInches beside real thresholds is stated out loud as
 *     "no minimum calibre", because that is Scotland's actual position and
 *     the assumption that every jurisdiction sets one is the single most
 *     common misreading of UK deer law.
 *   * Northern Ireland's Sch. 11 para. 8 offers bullet weight and expanding
 *     construction as alternative limbs, flagged in the record as
 *     bulletWeightAlternative — rendered as "or any expanding bullet" rather
 *     than as a cumulative requirement.
 *
 * Returns '' when the record carries no numeric threshold at all (e.g.
 * muntjac in Scotland); the caller prints its own sentence for that case.
 */
export function formatLegalMinima(lm) {
  if (!lm) return '';
  const withCommas = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const parts = [];
  if (Number.isFinite(lm.minMuzzleEnergyFtLb)) {
    parts.push(withCommas(lm.minMuzzleEnergyFtLb) + ' ft-lb muzzle energy');
  }
  if (Number.isFinite(lm.minMuzzleVelocityFps)) {
    parts.push(withCommas(lm.minMuzzleVelocityFps) + ' fps muzzle velocity');
  }
  if (Number.isFinite(lm.minCalibreInches)) {
    parts.push(lm.minCalibreInches.toFixed(3).replace(/^0/, '') + '" calibre');
  } else if (parts.length) {
    parts.push('no minimum calibre');
  }
  // Where the weight limb is an alternative to the expanding limb rather than
  // cumulative with it, printing both as separate bullet points would read as
  // two requirements. Fold it into the construction clause instead.
  const weightAltExpanding = lm.bulletWeightAlternative === 'expanding';
  if (Number.isFinite(lm.minBulletWeightGrains) && !weightAltExpanding) {
    parts.push(lm.minBulletWeightGrains + ' gr bullet');
  }
  if (!parts.length) return '';
  if (lm.expandingBulletRequired) {
    parts.push('expanding bullet'
      + (weightAltExpanding && Number.isFinite(lm.minBulletWeightGrains)
        ? ' (satisfies the ' + lm.minBulletWeightGrains + ' gr limb)' : ''));
  }
  return parts.join('   ·   ');
}

/**
 * B8: where the conditions came from, and how long ago.
 *
 * The calculator boots on the ICAO standard atmosphere because a solver needs
 * numbers before the user has given it any. Those are placeholders, not
 * weather — and until now the on-screen strip and the printed card stated
 * them in exactly the same voice as a reading fetched from the user's own
 * location five minutes earlier. "CONDITIONS ASSUMED  15 C - 1013 hPa -
 * 50% RH" is not a false statement, but it reads as a measurement, and it is
 * the one line on the card a stalker would use to decide whether the drop
 * table still applies to the evening in front of them.
 *
 * So classify the set once, here, and let both surfaces render the same
 * verdict — the screen and the print must not be able to disagree about
 * whether the figures are real.
 *
 * Staleness is judged for 'auto' and deliberately not for 'manual'. A fetched
 * reading decays because the weather moves on underneath it; a figure a person
 * typed is a statement about what they saw, and the app has no standing to
 * tell them it has expired. Six hours is the threshold: long enough that a
 * fetch at the truck still covers the walk in, short enough that a dawn fetch
 * cannot silently underwrite an evening sit.
 *
 * nowMs is a parameter rather than an internal Date.now() so the rule is
 * testable, and so the card and the screen can be asked the same question
 * about the same instant.
 */
export function conditionsProvenance(conditions, nowMs) {
  const src = conditions && conditions.source;
  const at = (conditions && typeof conditions.fetchedAt === 'number' && conditions.fetchedAt > 0)
    ? conditions.fetchedAt : null;
  // A clock that has gone backwards (timezone change, manual set, a restored
  // backup from another device) must not produce "-3 h ago". Floor at zero and
  // let it read as just now.
  const minsSince = at == null ? null : Math.max(0, Math.round((nowMs - at) / 60000));

  if (src === 'auto') {
    if (minsSince == null) {
      return {
        kind: 'auto', stale: true,
        chip: 'Fetched - time unknown',
        sentence: 'Fetched for your location, but the time of the fetch was not recorded. Treat as unverified.',
      };
    }
    const age = describeAge(minsSince);
    const stale = minsSince >= 360;
    return {
      kind: 'auto', stale,
      chip: 'Fetched ' + age,
      sentence: 'Fetched for your location ' + age + '.'
        + (stale ? ' More than six hours old - re-check before you rely on this table.' : ''),
    };
  }
  if (src === 'manual') {
    return {
      kind: 'manual', stale: false,
      chip: minsSince == null ? 'Entered by hand' : 'Entered ' + describeAge(minsSince),
      sentence: 'Entered by hand' + (minsSince == null ? '' : ' ' + describeAge(minsSince)) + '.',
    };
  }
  return {
    kind: 'default', stale: true,
    chip: 'Standard atmosphere — not measured',
    sentence: 'Not measured - the calculator\'s standard-atmosphere defaults, not conditions at your location.',
  };
}

/**
 * Coarse relative age. Deliberately coarse: the difference between 41 and 47
 * minutes changes nothing a stalker would do, and a precise-looking figure
 * invites more trust than a cached render deserves.
 */
function describeAge(mins) {
  if (mins < 2) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.round(mins / 60);
  if (hours < 48) return hours + ' h ago';
  return Math.round(hours / 24) + ' d ago';
}

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
 *                                              energyJ, dropMoa, dropMil,
 *                                              windDriftCm }]
 *                                            Any finite ranges; sorted here.
 *                                            windDriftCm (optional) is the
 *                                            drift at args.windRefMs.
 * @param {number} [args.windRefMs]        — reference full-value crosswind
 *                                            (m/s) the Wind column assumes;
 *                                            omit / 0 to hide the column
 * @param {'A6'|'A4'} args.sizeName
 * @param {string} args.jurisdictionLabel — e.g. "England & Wales"
 * @param {string} args.speciesLabel      — e.g. "Fallow"
 * @param {number|null} args.thresholdFtLb— ethical retained-energy floor
 *                                            (the statutory MUZZLE minimum used
 *                                            as a DSC guide, NOT a legal impact
 *                                            limit); rows below are flagged
 * @param {'metric'|'imperial'} [args.units] — 14.01: 'imperial' prints ranges
 *                                            in yards and drop/wind in inches
 *                                            (caption + setup line follow).
 *                                            MOA/MIL/fps/ft-lb never change.
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
  // 14.01 unit voice — a rifle-case card the stalker acts on MUST speak the
  // units they think in, end to end. Data stays metric; only rendering turns.
  const imp = args.units === 'imperial';
  const M2YD = 1.0936133;
  const dRange = (mv) => imp ? Math.round(mv * M2YD) : Math.round(mv);
  const dSmall = (cm) => imp ? (Math.abs(cm) / 2.54).toFixed(1) : Math.abs(cm).toFixed(1);

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
    'Zero ' + (imp ? Math.round(args.profile.zeroRangeM * M2YD) + 'yd' : args.profile.zeroRangeM + 'm'),
    'Sight ht ' + (imp ? (args.profile.sightHeightCm / 2.54).toFixed(1) + ' in' : args.profile.sightHeightCm.toFixed(1) + ' cm'),
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
  y += isLarge ? 4.2 : 3;

  // B8: and where those three figures came from. The heading above says
  // ASSUMED, which was doing all the honest work on its own; a printed card
  // outlives the session that produced it, so it has to carry its own
  // provenance rather than rely on the reader remembering.
  //
  // Wrapped and measured rather than advanced by a guessed constant - the
  // stale variant of the sentence is markedly longer than the fresh one, and
  // on A6 it wraps to three lines where the fresh one takes two.
  const prov = conditionsProvenance(args.conditions, Date.now());
  doc.setFontSize(isLarge ? 7.5 : 5.4);
  doc.setTextColor(...(prov.stale ? COLOURS.redRGB : COLOURS.mutedRGB));
  const provLines = doc.splitTextToSize(prov.sentence, size.w - m * 2);
  doc.text(provLines, m, y);
  y += provLines.length * (isLarge ? 3.4 : 2.4) + (isLarge ? 5 : 3);

  // ── Energy guide, and the statutory minimum it is not ───────────────
  // This block used to end at "Ethical floor, not the legal test — deer law
  // sets a muzzle minimum", which raises the obvious question and then walks
  // away from it. The statutory figures now print underneath, with the
  // citation, so the card answers the question it asks.
  //
  // Line advance is measured rather than guessed. The old code advanced a
  // hard-coded 9mm (A4) / 7mm (A6) for a block whose wrapped height depends
  // on the species and jurisdiction names, so a long label could already
  // have overlapped the table header before anything was added here.
  const guideFs = isLarge ? 8 : 6;
  const guideLh = guideFs * 0.3528 * 1.2;      // pt → mm, 1.2 line spacing
  const guideW = size.w - 2 * m;
  const guideBlock = (text, bold, rgb) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setTextColor(...rgb);
    doc.setFontSize(guideFs);
    const lines = doc.splitTextToSize(text, guideW);
    doc.text(lines, m, y);
    y += lines.length * guideLh;
  };

  if (args.thresholdFtLb && args.speciesLabel) {
    guideBlock('Retained-energy guide: ' + args.thresholdFtLb + ' ft-lb ('
      + args.speciesLabel + ', ' + args.jurisdictionLabel
      + ') — an ethical floor for the shot, not the legal test.',
      false, COLOURS.mutedRGB);
  }

  if (args.legalMinima && args.speciesLabel) {
    const minima = formatLegalMinima(args.legalMinima);
    guideBlock('STATUTORY MINIMUM AT THE MUZZLE — ' + args.speciesLabel + ', '
      + args.jurisdictionLabel, true, COLOURS.mossRGB);
    guideBlock(minima
      || 'No statutory threshold is specified for this species in this jurisdiction.',
      false, COLOURS.barkRGB);
    if (args.legalMinima.citation) {
      guideBlock(args.legalMinima.citation, false, COLOURS.mutedRGB);
    }
  }

  if (args.thresholdFtLb || args.legalMinima) y += isLarge ? 4 : 2.5;

  // ── Drop table (data-driven columns) ────────────────────────────────
  // Columns left→right. Units live in a caption below the table so seven
  // columns still fit on A6. Drop/MOA/MIL use the industry sign convention
  // (positive = above LoS, negative = below) — the solver's dropCm is
  // positive-below-LoS, so we negate for display. Wind is the drift (cm) at
  // a fixed reference crosswind, giving the card a usable wind hold.
  const tableX = m;
  const tableW = size.w - 2 * m;
  const tableEndX = tableX + tableW;

  const hasWind = Number.isFinite(args.windRefMs) && args.windRefMs > 0
    && (args.dropCurve || []).some(r => Number.isFinite(r.windDriftCm));

  const columns = [
    { key: 'range',  head: 'Range',  wL: 20, wS: 11, bold: true, colour: COLOURS.forestRGB,
      get: r => String(dRange(r.rangeM)) },
    { key: 'drop',   head: 'Drop',   wL: 26, wS: 15,
      get: r => { const d = -r.dropCm; return (d >= 0 ? '+' : '-') + dSmall(d); } },
    { key: 'moa',    head: 'MOA',    wL: 16, wS: 10,
      get: r => { const v = r.dropMoa != null ? -r.dropMoa : 0; const t = v.toFixed(1); return t === '-0.0' ? '+0.0' : (v >= 0 ? '+' + t : t); } },
    { key: 'mil',    head: 'MIL',    wL: 16, wS: 11,
      get: r => { const v = r.dropMil != null ? -r.dropMil : 0; const t = v.toFixed(2); return t === '-0.00' ? '+0.00' : (v >= 0 ? '+' + t : t); } },
    { key: 'wind',   head: 'Wind',   wL: 22, wS: 12, show: hasWind,
      get: r => Number.isFinite(r.windDriftCm) ? (imp ? dSmall(r.windDriftCm) : String(Math.round(Math.abs(r.windDriftCm)))) : '-' },
    { key: 'vel',    head: 'Vel',    wL: 26, wS: 14,
      get: r => String(Math.round(r.velocityFps)) },
    { key: 'energy', head: 'Energy', wL: 28, wS: 13,
      get: r => String(Math.round(r.energyFtLbs)) },
  ].filter(c => c.show !== false);

  // Assign x positions from the per-size column widths.
  let cxp = tableX;
  for (const c of columns) { c.x = cxp; cxp += (isLarge ? c.wL : c.wS); }

  // Header row
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(isLarge ? 9 : 7);
  doc.setTextColor(...COLOURS.forestRGB);
  for (const c of columns) doc.text(c.head, c.x, y);
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

  // Render whatever ranges the caller supplied (this is what enables
  // custom / user-chosen reference ranges) — just drop non-finite ranges
  // and sort ascending.
  const rows = (args.dropCurve || [])
    .filter(r => Number.isFinite(r.rangeM))
    .slice()
    .sort((a, b) => a.rangeM - b.rangeM);

  // How many rows fit above the footer budget?
  const bottomBudget = isLarge ? 32 : 18;     // leave room for footer
  const maxRows = Math.floor((size.h - m - bottomBudget - y) / rowH);
  const rowsToRender = rows.slice(0, Math.max(0, maxRows));

  let ri = 0;
  for (const r of rowsToRender) {
    // Light alternating row tint (cosmetic only on colour printers)
    if (ri % 2 === 0) {
      doc.setFillColor(248, 245, 238);
      doc.rect(tableX, y - rowH + 1, tableW, rowH, 'F');
    }
    // Compare UNROUNDED energy (match the on-screen ethical check in ballistics-ui);
    // rounding first let a 1749.6 ft-lb row escape a 1750 floor on the printed card.
    const belowThreshold = args.thresholdFtLb && r.energyFtLbs < args.thresholdFtLb;
    for (const c of columns) {
      if (c.key === 'energy' && belowThreshold) {
        doc.setTextColor(...COLOURS.redRGB);
        doc.setFont('helvetica', 'bold');
      } else if (c.bold) {
        doc.setTextColor(...(c.colour || COLOURS.barkRGB));
        doc.setFont('helvetica', 'bold');
      } else {
        doc.setTextColor(...COLOURS.barkRGB);
        doc.setFont('helvetica', 'normal');
      }
      doc.text(c.get(r), c.x, y);
    }
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLOURS.barkRGB);
    if (belowThreshold) {
      // Right-edge red band
      doc.setFillColor(...COLOURS.redRGB);
      doc.rect(tableEndX - 0.6, y - rowH + 1, 0.6, rowH, 'F');
    }
    y += rowH;
    ri++;
  }

  // If the table couldn't fit every requested range, say so explicitly — a
  // field card that silently stops short looks complete but isn't (audit §2).
  const omittedRows = rows.length - rowsToRender.length;
  if (omittedRows > 0) {
    const lastRangeM = rowsToRender.length ? Math.round(rowsToRender[rowsToRender.length - 1].rangeM) : 0;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COLOURS.redRGB);
    doc.setFontSize(isLarge ? 7 : 5.5);
    doc.text(`+${omittedRows} more range${omittedRows === 1 ? '' : 's'} past ${imp ? Math.round(lastRangeM * M2YD) + ' yd' : lastRangeM + ' m'} omitted — reduce the step or print A4.`,
      tableX, y + (isLarge ? 1 : 0.5), { maxWidth: tableW });
    y += isLarge ? 5 : 3.5;
  }

  // Units + wind caption beneath the table.
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...COLOURS.mutedRGB);
  doc.setFontSize(isLarge ? 7 : 5);
  let cap = imp ? 'Range yd · Drop/Wind in · Vel fps · Energy ft-lb'
                : 'Range m · Drop/Wind cm · Vel fps · Energy ft-lb';
  if (hasWind) cap += `.  Wind = drift at ${args.windRefMs} m/s full-value crosswind — hold into it.`;
  doc.text(cap, tableX, y + (isLarge ? 1 : 0.5), { maxWidth: tableW });
  y += isLarge ? 5 : 3.5;

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
      const subtitle = `${sp.label} ${sexLabel}  ·  ${aim.label}  ·  chest ~${imp ? (sx.chestDepthCm / 2.54).toFixed(0) + ' in' : sx.chestDepthCm + ' cm'}`;
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
          units: args.units,
        });
        if (!anat.ok) continue;
        const line = `${dRange(row.rangeM)} ${imp ? 'yd' : 'm'}   ${anat.text}`;
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

      // y=0 baseline (LoS). PDF coords: Y increases downward, so larger
      // drop values must yield larger py. Formula: py grows with
      // (dropCm - minD). Same orientation as renderDropChart in
      // ballistics-ui.js after the 9.36→9.37 fix — this code path was
      // missed at that time, so until now the printed dope card showed
      // the bullet visually rising with range. (Fixed 2026-06-09.)
      const yZero = chartTop + ((0 - minD) / dSpan) * chartH;
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
        const py = chartTop + ((r.dropCm - minD) / dSpan) * chartH;
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
