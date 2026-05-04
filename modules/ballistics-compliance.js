// =============================================================================
// First Light — Legal compliance section renderer for the ballistic calculator.
//
// Extracted from modules/ballistics-ui.js. The dedupe + hoisted-citation
// rendering pattern is deliberately self-contained:
//
//   * groupComplianceResults — buckets per-species results by full check
//     signature so Scotland's 6-species output collapses to 1-2 cards when
//     the same statutory minima apply (red/fallow/sika all share 1,750
//     ft-lb / 2,450 fps / 80 gr post-SSI 2023/332).
//   * renderComplianceSection — builds the section, hoists the citation when
//     every group shares it, includes the absolute-floor warning above the
//     per-group rows. Statutory verification banner gates on
//     flUkDeerLawVerified.
//   * renderComplianceRow — multi-species headings render as a comma list;
//     citation is omitted per-row when hoisted to section level.
//
// Dependencies are passed in explicitly via the deps argument rather than
// closed-over from a parent module, so this file has zero coupling to
// ballistics-ui.js's module-level state. Required deps:
//
//   state                  — the shared state object (uses .settings.speciesFilter, .settings.jurisdiction)
//   checkLegalCompliance   — (profile, jurisdiction, species) → result
//   checkAbsoluteFloor     — (profile) → null | { muzzleEnergyFtLb, floor }
//   escapeHtml             — string sanitiser
// =============================================================================

import { JURISDICTIONS, flUkDeerLawVerified } from '../lib/fl-deer-law.js';

export function groupComplianceResults(results) {
  const groups = new Map();
  for (const r of results) {
    const key = JSON.stringify({
      overall: r.overall,
      checks: r.checks.map(c => ({
        status: c.status, label: c.label,
        actualValue: c.actualValue, statutoryValue: c.statutoryValue,
        detail: c.detail || null,
      })),
    });
    if (!groups.has(key)) groups.set(key, { species: [], result: r });
    groups.get(key).species.push(r.speciesLabel);
  }
  return Array.from(groups.values());
}

export function renderComplianceSection(profile, deps) {
  const { state, checkLegalCompliance, checkAbsoluteFloor, escapeHtml } = deps;
  const filter = state.settings.speciesFilter;
  if (!filter || filter.length === 0) return '';

  const results = filter
    .map(sp => checkLegalCompliance(profile, state.settings.jurisdiction, sp))
    .filter(r => r.checks.length > 0);  // skip species without statutory thresholds

  if (results.length === 0) return '';

  // Sort: failed first (most important), then unknown, then passed.
  const order = { fail: 0, unknown: 1, pass: 2 };
  results.sort((a, b) => (order[a.overall] ?? 9) - (order[b.overall] ?? 9));

  const jurLabel = JURISDICTIONS.find(j => j.code === state.settings.jurisdiction)?.label || '';

  // Pre-release banner if law data is unverified.
  const preReleaseBanner = !flUkDeerLawVerified
    ? `<div class="bx-compliance-prerelease">⚠ Statutory thresholds in this calculator have not yet been independently verified. Use as guidance only and check your equipment against the current statutory text for your jurisdiction.</div>`
    : '';

  // Absolute UK floor: any load below 1000 ft-lb at the muzzle is
  // unlawful for ANY deer in ANY jurisdiction. Worth a hard, separate
  // warning above the per-species rows.
  const floorFail = checkAbsoluteFloor(profile);
  const absoluteWarning = floorFail
    ? `<div class="bx-compliance-floor-warn">
         <strong>UNLAWFUL FOR DEER ANYWHERE IN THE UK</strong><br>
         Muzzle energy ${floorFail.muzzleEnergyFtLb} ft-lb is below the
         ${floorFail.floor} ft-lb absolute minimum (the muntjac/CWD floor
         in E&amp;W and NI). This load cannot be used lawfully on any
         deer in the UK.
       </div>`
    : '';

  // Group identical results so Scotland's 6 species don't render 6 nearly
  // identical cards. Hoist the citation to section level if all groups
  // share the same one — the per-row citation was repeating the same SSI
  // statute line up to 6 times in a row.
  const groups = groupComplianceResults(results);
  const sharedCitation = groups.length > 0
    && groups.every(g => g.result.citation === groups[0].result.citation)
    && groups[0].result.citation
    ? groups[0].result.citation
    : null;

  return `
    <div class="bx-output-section bx-compliance-section">
      <div class="bx-output-label">Legal compliance · ${escapeHtml(jurLabel)}</div>
      ${preReleaseBanner}
      ${absoluteWarning}
      <div class="bx-compliance-list">
        ${groups.map(g => renderComplianceRow(g, sharedCitation != null, escapeHtml)).join('')}
      </div>
      ${sharedCitation ? `<div class="bx-output-citation bx-compliance-shared-citation">${escapeHtml(sharedCitation)}</div>` : ''}
    </div>
  `;
}

function renderComplianceRow(group, citationHoisted, escapeHtml) {
  const r = group.result;
  // Header lists every species in this group. Multi-species groups show
  // a comma-separated list ("Red, Fallow, Sika, CWD, Muntjac") so the
  // stalker sees the same coverage as before but in 1/N the vertical
  // space.
  const heading = group.species.length === 1
    ? group.species[0]
    : group.species.join(', ');
  const overallBadge = r.overall === 'fail'
    ? '<span class="bx-compliance-badge bx-compliance-fail">Fail</span>'
    : r.overall === 'unknown'
      ? '<span class="bx-compliance-badge bx-compliance-unknown">Check</span>'
      : '<span class="bx-compliance-badge bx-compliance-pass">Pass</span>';

  const checksHtml = r.checks.map(c => {
    const statusIcon = c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : c.status === 'na' ? '–' : '?';
    const statusClass = 'bx-compliance-check-' + c.status;
    const value = c.actualValue;
    const statutory = c.statutoryValue !== '—' ? ` / min ${escapeHtml(c.statutoryValue)}` : '';
    return `
      <div class="bx-compliance-check ${statusClass}">
        <span class="bx-compliance-icon">${statusIcon}</span>
        <span class="bx-compliance-check-label">${escapeHtml(c.label)}:</span>
        <span class="bx-compliance-check-value">${escapeHtml(value)}${statutory}</span>
        ${c.detail ? `<span class="bx-compliance-check-detail">${escapeHtml(c.detail)}</span>` : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="bx-compliance-row bx-compliance-row-${r.overall}">
      <div class="bx-compliance-row-header">
        <span class="bx-compliance-species">${escapeHtml(heading)}</span>
        ${overallBadge}
      </div>
      <div class="bx-compliance-checks">${checksHtml}</div>
      ${!citationHoisted && r.citation ? `<div class="bx-output-citation">${escapeHtml(r.citation)}</div>` : ''}
    </div>
  `;
}
