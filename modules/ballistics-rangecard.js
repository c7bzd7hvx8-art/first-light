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
// =============================================================================

export const RANGE_CARD_RANGES_M = Object.freeze([100, 150, 200, 250, 300, 350, 400, 450]);

export function renderRangeCard(profile, deps) {
  if (!profile) return '';
  const { state, solveProfileAt } = deps;
  const showWind = state.conditions.windMps > 0;
  // Compute solver outputs for each sample range. If any fails (transonic
  // edge, etc), show '—' for that cell.
  const rows = RANGE_CARD_RANGES_M.map(r => {
    const sol = solveProfileAt(profile, r);
    return { rangeM: r, sol };
  });
  const headerCells = RANGE_CARD_RANGES_M.map(r => `<th>${r}m</th>`).join('');

  const dropRow = rows.map(({ sol }) => {
    if (!sol) return '<td>—</td>';
    // Display sign convention: positive = dial UP (matches Hold widget + dope card)
    const cm = -sol.dropCm;
    const sign = cm >= 0 ? '+' : '';
    return `<td>${sign}${cm.toFixed(0)} cm</td>`;
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
    return `<td>${sol.windDriftCm.toFixed(0)} cm</td>`;
  }).join('') : '';

  return `
    <details class="bx-output-section bx-rc-section">
      <summary class="bx-output-label bx-rc-summary">Range card · current conditions</summary>
      <div class="bx-rc-tablewrap">
        <table class="bx-rc-table">
          <thead><tr><th></th>${headerCells}</tr></thead>
          <tbody>
            <tr><th>Drop</th>${dropRow}</tr>
            <tr><th>MOA</th>${moaRow}</tr>
            <tr><th>Energy</th>${energyRow}</tr>
            <tr><th>Velocity</th>${velRow}</tr>
            ${showWind ? `<tr><th>Wind</th>${windRow}</tr>` : ''}
          </tbody>
        </table>
      </div>
      <div class="bx-rc-foot">
        Drop is dial-up (positive = scope dials up). Energy in ft-lb, velocity in fps.
        Solved at ${state.conditions.tempC.toFixed(0)}°C, ${state.conditions.pressureHpa.toFixed(0)} hPa,
        ${profile.zeroRangeM}m zero.
        ${showWind ? `Wind ${state.conditions.windMps.toFixed(1)} m/s full crosswind.` : 'No wind.'}
        Velocity gold = transonic, orange = subsonic.
      </div>
    </details>
  `;
}
