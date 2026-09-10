// =============================================================================
// First Light — Range card renderer for the ballistic calculator.
//
// Extracted from modules/ballistics-ui.js. Tabular drop / MOA / energy /
// velocity / wind drift at fixed sample ranges (100m through 450m). Unlike
// the dope card PDF (printed reference, generated once), the range card is
// recomputed on every render so it reflects current conditions — useful in
// the field when temperature, pressure, or wind have changed since the last
// shot.
//
// Velocity column colour-codes transonic (gold) and subsonic (orange) cells —
// these are accuracy hints, not legal alarms; deliberately muted, see
// ballistics.css `.bx-rc-table tbody td.bx-rc-{transonic,subsonic}`.
//
// Dependencies are passed in via the deps argument so this module has no
// closure over ballistics-ui.js's module-level state. Required deps:
//
//   state           — uses .conditions.{windMps, tempC, pressureHpa}
//   solveProfileAt  — (profile, rangeM) → solution row | null
//   wind            — describeWind() result for the current conditions. Its
//                     .long is the footer's wind sentence. Required: without
//                     it the footer cannot name the crosswind actually solved.
// =============================================================================

export const RANGE_CARD_RANGES_M = Object.freeze([100, 150, 200, 250, 300, 350, 400, 450]);

export function renderRangeCard(profile, deps) {
  if (!profile) return '';
  const { state, solveProfileAt, wind } = deps;
  const showWind = state.conditions.windMps > 0;
  // 14.01: imperial mode samples at round YARD marks (100yd…450yd), solved at
  // their true metre equivalents — a converted 100 m column reading "109yd"
  // would be a table nobody's reticle thinks in. Drop/wind cells follow in
  // inches; MOA is angular and fps/ft-lb are already the trade's units.
  const imp = state.settings && state.settings.units === 'imperial';
  const YD_M = 0.9144; // 1 yd exactly
  const samples = RANGE_CARD_RANGES_M.map(r => imp
    ? { solveM: r * YD_M, label: r + 'yd' }
    : { solveM: r, label: r + 'm' });
  // Compute solver outputs for each sample range. If any fails (transonic
  // edge, etc), show '—' for that cell.
  const rows = samples.map(s => {
    const sol = solveProfileAt(profile, s.solveM);
    return { rangeM: s.solveM, sol };
  });
  const headerCells = samples.map(s => `<th scope="col">${s.label}</th>`).join('');
  const small = (cm) => imp ? (cm / 2.54).toFixed(1) + ' in' : cm.toFixed(0) + ' cm';

  const dropRow = rows.map(({ sol }) => {
    if (!sol) return '<td>—</td>';
    // Display sign convention (ammo-box): the number is the bullet's position
    // relative to zero — negative = below zero (dial UP), positive = above (dial DOWN).
    const cm = -sol.dropCm;
    const sign = cm >= 0 ? '+' : '-';
    return `<td>${sign}${small(Math.abs(cm))}</td>`;
  }).join('');

  const moaRow = rows.map(({ sol }) => {
    if (!sol) return '<td>—</td>';
    const moa = -sol.dropMoa;
    const sign = moa >= 0 ? '+' : '';
    return `<td>${sign}${moa.toFixed(1)}</td>`;
  }).join('');

  const energyRow = rows.map(({ sol }) => {
    if (!sol) return '<td>—</td>';
    return `<td>${Math.round(sol.energyFtLbs)}</td>`;
  }).join('');

  const velRow = rows.map(({ sol }) => {
    if (!sol) return '<td>—</td>';
    const cls = sol.isSubsonic ? 'bx-rc-subsonic' : (sol.isTransonic ? 'bx-rc-transonic' : '');
    return `<td class="${cls}">${Math.round(sol.velocityFps)}</td>`;
  }).join('');

  const windRow = showWind ? rows.map(({ sol }) => {
    if (!sol) return '<td>—</td>';
    // Magnitude + explicit drift direction, matching the HOLD card's left/right.
    // windDriftCm > 0 = drift right, < 0 = left.
    const dir = sol.windDriftCm > 0.5 ? ' R' : (sol.windDriftCm < -0.5 ? ' L' : '');
    return `<td>${small(Math.abs(sol.windDriftCm))}${dir}</td>`;
  }).join('') : '';

  // The Wind row is solved with the crosswind COMPONENT, not the entered wind
  // speed, so the footer must name the component (audit 2026-07-25, B7). deps
  // supplies it pre-computed rather than this module importing back into
  // ballistics-ui.js; the fallback keeps a missing dep from printing a wrong
  // number rather than no number.
  const windText = wind ? wind.long
    : (showWind ? 'Wind is applied — see the conditions strip.' : 'No wind.');

  return `
    <details class="bx-rc-section" id="bx-rc-details"${deps.open ? ' open' : ''}>
      <summary class="bx-rc-summary"><span class="bx-rc-status" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="2.5" y="3.2" width="11" height="9.6" rx="1.6"/><line x1="2.5" y1="6.6" x2="13.5" y2="6.6"/><line x1="2.5" y1="9.6" x2="13.5" y2="9.6"/><line x1="6.4" y1="3.2" x2="6.4" y2="12.8"/></svg></span><span class="bx-rc-summary-title">Range card · current conditions</span></summary>
      <div class="bx-rc-body">
        <div class="bx-rc-tablewrap">
          <table class="bx-rc-table">
            <caption class="bx-visually-hidden">Range card: drop, come-up in MOA, retained energy, velocity${showWind ? ' and wind drift' : ''} at each listed range.</caption>
            <thead><tr><th></th>${headerCells}</tr></thead>
            <tbody>
              <tr><th scope="row">Drop</th>${dropRow}</tr>
              <tr><th scope="row">MOA</th>${moaRow}</tr>
              <tr><th scope="row">Energy</th>${energyRow}</tr>
              <tr><th scope="row">Velocity</th>${velRow}</tr>
              ${showWind ? `<tr><th scope="row">Wind</th>${windRow}</tr>` : ''}
            </tbody>
          </table>
        </div>
        <div class="bx-rc-foot">
          Drop is relative to zero — negative = below (dial up), positive = above (dial down). Energy in ft-lb, velocity in fps.
          Solved at ${state.conditions.tempC.toFixed(0)}°C, ${state.conditions.pressureHpa.toFixed(0)} hPa,
          ${imp ? Math.round(profile.zeroRangeM / YD_M) + 'yd' : profile.zeroRangeM + 'm'} zero.
          ${windText}
          Velocity gold = transonic, orange = subsonic.
        </div>
      </div>
    </details>
  `;
}
