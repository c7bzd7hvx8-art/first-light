// First Light — modules/pdf.mjs
// =============================================================================
// PDF export helpers extracted from diary.js during the Phase-2 modularisation.
// See MODULARISATION-PLAN.md → Phase 2 / Commit I (scaffold + 2 smallest exports).
//
// Scope of this module (grows across Commits I → L):
//   • buildSimpleDiaryPDF(opts)   — "Simple list" all-entries PDF
//                                    (exportPDFData fallback / All-Seasons path)
//   • buildSingleEntryPDF(opts)   — per-carcass one-pager
//                                    (viewed from the entry detail modal)
//   • userProfileDisplayName(user)— legal-name resolver used by every PDF header
//
// Later commits will add:
//   • Larder book + syndicate list/larder  (Commit J)
//   • Game dealer + consignment declarations  (Commit K)
//   • Season summary + syndicate summary      (Commit L)
//
// Dependency model (why this module looks the way it does):
//   • jspdf is loaded globally via <script>, so we reach into window.jspdf here.
//     That's a deliberate choice — bundling jspdf as an ES module would force a
//     build step for the whole PWA, which is off-scope for the modularisation.
//   • All app state (current user, entries, season, syndicate…) is passed in via
//     an `opts` object. The module is therefore pure w.r.t. globals — tests can
//     import and call it without a browser DOM (apart from jspdf, which is
//     mocked in the unit tests as needed).
//   • Pure string helpers come from lib/fl-pure.mjs.  Tiny private helpers
//     (fmtDate, hasValue) are inlined here to avoid a dependency on diary.js.
// =============================================================================

import {
  sexLabel,
  parseEntryDateParts,
  MONTH_NAMES,
  seasonLabel,
  ABNORMALITY_LABEL_BY_CODE,
  isBlankDayEntry
} from '../lib/fl-pure.mjs';

// ── Private helpers (duplicated from diary.js deliberately) ─────────────────
// These are ~3 lines each and moving them into fl-pure.mjs would touch every
// caller in diary.js. They'll consolidate naturally when diary.js slims down
// enough that the duplication is visible.

const DOW_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export function fmtEntryDateShort(d) {
  if (!d) return '';
  const p = parseEntryDateParts(d);
  if (!p) return typeof d === 'string' ? d : String(d);
  const dt = new Date(p.y, p.m - 1, p.day);
  return DOW_SHORT[dt.getDay()] + ' ' + p.day + ' ' + MONTH_NAMES[p.m - 1];
}

// Long form with year — used in the simple diary PDF so multi-season exports
// don't lose which year a "29 Jan" entry actually belongs to. Kept as a
// separate helper (rather than adding an optional flag to fmtEntryDateShort)
// so the short form's existing tests and call sites stay pinned.
export function fmtEntryDateLong(d) {
  if (!d) return '';
  const p = parseEntryDateParts(d);
  if (!p) return typeof d === 'string' ? d : String(d);
  const dt = new Date(p.y, p.m - 1, p.day);
  return DOW_SHORT[dt.getDay()] + ' ' + p.day + ' ' + MONTH_NAMES[p.m - 1] + ' ' + p.y;
}

// Trim stored times ("14:30:00" / "14:30") down to the HH:MM the stalker
// actually cares about in a diary rendering context. Null-safe.
export function fmtEntryTimeShort(t) {
  if (t == null || t === '') return '';
  const s = String(t).trim();
  if (!s) return '';
  // Accept anything that starts with H:MM / HH:MM; everything after that is
  // dropped (jettisons seconds, timezone suffixes, stray whitespace).
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  return (m[1].length === 1 ? '0' + m[1] : m[1]) + ':' + m[2];
}

export function hasValue(v) {
  return !(v === null || v === undefined || v === '');
}

/**
 * Strip ephemeral / local-only URLs from text before PDF output. Browser
 * `blob:` URLs (photo previews, object URLs) are invalid outside the session
 * and show up as junk when users share exports (e.g. WhatsApp). Long `data:`
 * image payloads in pasted notes are replaced so the PDF stays small and readable.
 */
export function pdfSafeText(v) {
  if (v == null || v === '') return '';
  let s = String(v);
  // Blob URLs are never portable in exports. Allow whitespace / line breaks
  // after "blob:" (copy-paste and soft-wrap often insert space or \n before https).
  s = s.replace(/blob:\s*https?:\/\/\S+/gi, '');
  // Opaque blob:… (e.g. blob:null/…) and any remaining blob: fragment
  s = s.replace(/blob:\s*\S+/gi, '');
  s = s.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+/gi, '[image data omitted]');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

/**
 * Slug a syndicate (or any) name for use in a filename.
 * "The Quarry Estate!" → "the-quarry-estate"
 * Empty / pure-punctuation falls back to "syndicate" so we never emit
 * something like `team-larder-book--2025.pdf`.
 */
export function syndicateFileSlug(name) {
  const s = String(name || 'syndicate')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return s || 'syndicate';
}

/**
 * Resolve the hunter identity lines used on every PDF that needs a
 * trained-hunter signature block. Returns:
 *   { hunterName: string, accountEmail: string }
 * Both strings are '' when no profile data is available. Wrapped in a
 * try/catch because `user` can be a malformed Supabase user object from
 * a borked session — we'd rather emit a blank signature line than blow
 * up an export at the critical "user clicks download" moment.
 */
function resolveHunterIdentity(user) {
  let hunterName = '';
  let accountEmail = '';
  try {
    hunterName = userProfileDisplayName(user);
    accountEmail = (user && user.email) ? String(user.email).trim() : '';
  } catch (_) { /* malformed user object */ }
  return { hunterName, accountEmail };
}

/**
 * Draws a bold table header row + a hairline underline on a jspdf doc.
 * Mutates the passed `doc` and returns the new y cursor.
 *
 * Extracted from the two inner drawHeader() closures inside the larder
 * PDFs — they were byte-identical. Signature is deliberately minimal so
 * the page-break code path (which also calls it) stays a one-liner.
 */
export function drawTableHeader(doc, { headers, colX, y, pageW, fontSize = 8, filled = false }) {
  if (filled) {
    // Light beige header band. Restrained so it still prints cleanly on B&W
    // and doesn't crowd the 7.5pt body rows below.
    doc.setFillColor(233, 228, 215);
    doc.rect(14, y - 4, pageW - 28, 6.5, 'F');
  }
  doc.setFontSize(fontSize);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(0);
  for (let h = 0; h < headers.length; h++) doc.text(headers[h], colX[h], y);
  doc.setFont(undefined, 'normal');
  const ny = y + 6;
  doc.setDrawColor(180);
  doc.line(14, ny - 3, pageW - 14, ny - 3);
  return ny;
}

/**
 * English plural helper. `plural(1, 'carcass')` → '1 carcass',
 * `plural(3, 'carcass', 'carcasses')` → '3 carcasses'. Default plural rule is
 * suffix-'s', which works for shooter/entry/day but NOT for carcass — always
 * pass the explicit plural when the word doesn't inflect with just 's'.
 */
export function plural(n, singular, pluralForm) {
  return n + ' ' + (n === 1 ? singular : (pluralForm || singular + 's'));
}

/**
 * Weight formatter for a totals row. When NO row in the set carries a
 * numeric weight (every weight was NULL / '—'), the sum is mathematically
 * zero but semantically unknown — so we render '—' rather than '0 kg'
 * which would read as "I weighed them all and they came to zero".
 *
 *   formatTotalKg([1.2, 3.4])            → '4.6 kg'
 *   formatTotalKg([null, undefined, ''])  → '—'
 *   formatTotalKg([])                     → '—'
 */
export function formatTotalKg(weights) {
  let total = 0;
  let contributed = 0;
  for (const w of weights) {
    if (w === null || w === undefined || w === '') continue;
    const n = parseFloat(w);
    if (Number.isFinite(n)) { total += n; contributed += 1; }
  }
  if (!contributed) return '—';
  return (Math.round(total * 10) / 10) + ' kg';
}

/**
 * Draws the common footer used across PDFs: left-aligned brand line and
 * right-aligned page number. Call AFTER the body is fully drawn (so
 * `doc.getNumberOfPages()` is final), once per page in a retrospective loop.
 */
export function drawPdfFooter(doc, { pageW, pageH, pageNum, totalPages, scale }) {
  // `scale` = 1 for mm docs (default), ~2.83 for pt docs (consignment PDF).
  // Font sizes stay in points regardless — jspdf always measures those in pt.
  const s = (typeof scale === 'number' && scale > 0) ? scale : 1;
  const margin = 14 * s;
  const y = pageH - 8 * s;
  doc.setDrawColor(220);
  doc.line(margin, y - 4 * s, pageW - margin, y - 4 * s);
  doc.setFontSize(7); doc.setTextColor(120);
  doc.text('Produced by First Light Cull Diary — firstlightdeer.co.uk', margin, y);
  const pageLabel = 'Page ' + pageNum + ' of ' + totalPages;
  const w = doc.getTextWidth ? doc.getTextWidth(pageLabel) : (pageLabel.length * 1.8);
  doc.text(pageLabel, pageW - margin - w, y);
  doc.setTextColor(0);
}

/**
 * Draws a paired "Signature: _____  Date: _____" row with actual rules
 * rather than typewriter underscores. Cleaner print output and doesn't
 * shift when fonts change width.
 *
 *   drawSignatureBlock(doc, y, pageW, {
 *     primary: { label: 'Syndicate manager signature' },
 *     date:    { label: 'Date' }
 *   })
 */
export function drawSignatureBlock(doc, y, pageW, { primary, date, scale }) {
  // `scale` lets callers on point-unit docs reuse this; defaults to mm.
  const s = (typeof scale === 'number' && scale > 0) ? scale : 1;
  const margin = 14 * s;
  const dateRuleW = 60 * s;
  const baselineNudge = 0.5 * s;

  doc.setFontSize(9);
  doc.setTextColor(0);
  // Primary signature block — left third plus generous rule.
  const pLabel = primary.label + ':';
  doc.text(pLabel, margin, y);
  const pLabelW = doc.getTextWidth ? doc.getTextWidth(pLabel) : (pLabel.length * 2.0);
  doc.setDrawColor(80);
  doc.line(margin + pLabelW + 2 * s, y + baselineNudge, pageW * 0.55, y + baselineNudge);
  // Date — anchored to right side.
  const dLabel = (date && date.label ? date.label : 'Date') + ':';
  const dLabelW = doc.getTextWidth ? doc.getTextWidth(dLabel) : (dLabel.length * 2.0);
  const dX = pageW - margin - dateRuleW;
  doc.text(dLabel, dX, y);
  doc.line(dX + dLabelW + 2 * s, y + baselineNudge, pageW - margin, y + baselineNudge);
}

// ─── Shared brand palette & hex colour helpers ──────────────────────────────

/**
 * Brand palette used across every First Light PDF. Extracted verbatim from
 * the inline `C` object inside `exportSeasonSummary` so the visual language
 * is genuinely shared rather than accidentally-similar. Don't add colours
 * here without checking they work in both the rich (dark bands, white text)
 * and professional (thin accents, black text) families.
 *
 *   deep / forest  — primary header fill (rich family only)
 *   moss           — section label accent + compliance accent rule
 *   gold           — eyebrow ("FIRST LIGHT · CULL DIARY") across both families
 *   bark           — body text / big numbers
 *   muted          — secondary text
 *   stone          — thin rules, default row divider
 *   spColours      — species chip colours (rich family only; never used in
 *                    compliance PDFs because colour-coding species isn't the
 *                    kind of information a dealer/auditor needs)
 */
export const PDF_PALETTE = {
  deep:    '#0e2a08',
  forest:  '#1a3a0e',
  moss:    '#5a7a30',
  gold:    '#c8a84b',
  bark:    '#3d2b1f',
  muted:   '#a0988a',
  stone:   '#ede9e2',
  white:   '#ffffff',
  spColours: {
    'Red Deer': '#a33a2a',
    'Roe Deer': '#5a7a30',
    'Fallow':   '#f57f17',
    'Muntjac':  '#6a1b9a',
    'Sika':     '#1565c0',
    'CWD':      '#00695c',
  },
};

/** Parse a '#rrggbb' hex string into a [r,g,b] tuple (0-255 range). */
function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Thin convenience wrappers — spare every caller the hex→rgb parse boilerplate. */
export function setPdfFill(doc, hex)   { const c = hexToRgb(hex); doc.setFillColor(c[0], c[1], c[2]); }
export function setPdfStroke(doc, hex) { const c = hexToRgb(hex); doc.setDrawColor(c[0], c[1], c[2]); }
export function setPdfText(doc, hex)   { const c = hexToRgb(hex); doc.setTextColor(c[0], c[1], c[2]); }

// ─── Rich-family header (Season Summary / Simple Diary / Single Entry) ──────

/**
 * Full-width dark-green header band with a gold eyebrow label, white title,
 * optional subtitle line, and a muted URL / generated-on stamp. Matches the
 * Season Summary PDF that the user said they like — extracted as a shared
 * primitive so every "rich family" PDF has the same opening.
 *
 * Dimensions are expressed in jspdf default points (72pt = 1 inch). All
 * callers should have been constructed with `new jsPDF({ unit: 'pt' })`.
 *
 *   drawRichHeaderBand(doc, {
 *     pageW: 842, title: '2025-26 Season Report',
 *     eyebrow: 'FIRST LIGHT · CULL DIARY',  // defaults to this
 *     subtitle: 'Ground: Woodland Block',    // optional
 *     meta: { url: 'firstlightdeer.co.uk', generated: '17 Apr 2026 - 14:22' },
 *   })
 *
 * Returns the y-coordinate immediately below the band so the caller can
 * position the next element.
 */
export function drawRichHeaderBand(doc, { pageW, title, eyebrow, subtitle, meta, scale }) {
  const eb = eyebrow || 'FIRST LIGHT  -  CULL DIARY';
  const hasSub = Boolean(subtitle);
  // Coordinates below are written in points (matching the Season Summary
  // source); `scale=1` for pt-unit docs, `scale = 25.4/72 ≈ 0.353` for
  // mm-unit docs (Simple Diary, Single Entry). Font sizes are unscaled —
  // jspdf measures those in points regardless of the doc's unit system.
  const s = (typeof scale === 'number' && scale > 0) ? scale : 1;
  const mx = 18 * s;

  const metaUrlY = (hasSub ? 74 : 58) * s;
  const metaGenY = metaUrlY + 13 * s;
  const bandH    = metaGenY + 16 * s;

  // Duotone fill — right half `deep`, left half `forest`, gives the band a
  // subtle directional weight without looking like a plain colour block.
  setPdfFill(doc, PDF_PALETTE.deep);   doc.rect(0, 0, pageW, bandH, 'F');
  setPdfFill(doc, PDF_PALETTE.forest); doc.rect(0, 0, pageW / 2, bandH, 'F');
  setPdfStroke(doc, PDF_PALETTE.gold); doc.setLineWidth(1.5);
  doc.line(0, bandH, pageW, bandH);

  setPdfText(doc, PDF_PALETTE.gold); doc.setFontSize(7); doc.setFont(undefined, 'bold');
  doc.text(eb, mx, 18 * s);
  setPdfText(doc, PDF_PALETTE.white); doc.setFontSize(22); doc.setFont(undefined, 'bold');
  doc.text(title || '', mx, 42 * s);
  if (hasSub) {
    setPdfText(doc, PDF_PALETTE.gold); doc.setFontSize(9); doc.setFont(undefined, 'bold');
    doc.text(subtitle, mx, 58 * s);
  }
  if (meta && meta.url) {
    doc.setTextColor(170, 170, 170); doc.setFontSize(10); doc.setFont(undefined, 'normal');
    doc.text(meta.url, mx, metaUrlY);
  }
  if (meta && meta.generated) {
    setPdfText(doc, PDF_PALETTE.gold); doc.setFontSize(7); doc.setFont(undefined, 'normal');
    doc.text('Generated ' + meta.generated, mx, metaGenY);
  }
  setPdfText(doc, PDF_PALETTE.bark);
  return bandH;
}

// ─── Professional-family header (Larder books, Dealer declarations) ─────────

/**
 * Restrained compliance header: thin dark-green accent rule, small gold
 * eyebrow, black title, optional subtitle and scope line. No fill band, no
 * duotone — the paper stays white so the artefact reads as a formal
 * document a dealer / auditor would expect (think DEFRA food-business form,
 * not a marketing brochure).
 *
 * Keeps just enough First Light identity so the document is recognisable
 * without competing with the compliance content. User's phrasing was
 * "some colour but not overly colourful" — that's the calibration this
 * helper encodes.
 *
 *   drawProfessionalHeader(doc, {
 *     pageW, title: 'Larder Book', subtitle: 'West Acre · Season 2025-2026',
 *     scope: 'Ground filter: "Woodland Block"  ·  1 contributing shooter',
 *   })
 *
 * Returns the y-coordinate immediately below the header.
 */
export function drawProfessionalHeader(doc, { pageW, title, subtitle, scope, eyebrow, scale }) {
  const eb = eyebrow || 'FIRST LIGHT  ·  CULL DIARY';
  // `scale` lets callers on point-unit docs (e.g. the consignment PDF) reuse
  // this helper without hand-rolling a second implementation. 1 = mm default,
  // ~2.83 = pt (72 pt per inch / 25.4 mm per inch). Font sizes are left in
  // points because jspdf's setFontSize always measures in points regardless
  // of the doc's unit system.
  const s = (typeof scale === 'number' && scale > 0) ? scale : 1;
  const mx = 14 * s;

  // Narrow dark-green accent rule across the top edge — the single strongest
  // brand touch. ~4pt tall × full width.
  setPdfFill(doc, PDF_PALETTE.moss);
  doc.rect(0, 0, pageW, 4 * s, 'F');

  // Gold eyebrow (small caps vibe via uppercase + 7pt bold), sits just below.
  setPdfText(doc, PDF_PALETTE.gold); doc.setFontSize(7); doc.setFont(undefined, 'bold');
  doc.text(eb, mx, 16 * s);

  // Black title — the heavy-weight thing a reader actually lands on.
  setPdfText(doc, PDF_PALETTE.bark); doc.setFontSize(16); doc.setFont(undefined, 'bold');
  doc.text(title || '', mx, 27 * s);
  doc.setFont(undefined, 'normal');

  let y = 33 * s;
  if (subtitle) {
    doc.setFontSize(9); doc.setTextColor(110, 110, 110);
    doc.text(subtitle, mx, y);
    y += 5 * s;
  }
  if (scope) {
    doc.setFontSize(9); doc.setTextColor(110, 110, 110);
    doc.text(scope, mx, y);
    y += 5 * s;
  }
  doc.setTextColor(0);
  return y + 3 * s;
}

// ── User profile helpers ────────────────────────────────────────────────────

/**
 * Profile name for PDFs — not email (email is identity only, not a legal "name").
 * Falls back through the Supabase user_metadata shape the app writes.
 * Returns '' when no explicit name has been set.
 */
export function userProfileDisplayName(user) {
  if (!user) return '';
  const m = user.user_metadata || {};
  const n = String(m.full_name || m.name || m.display_name || '').trim();
  return n;
}

// ── jspdf access ────────────────────────────────────────────────────────────
// Guarded so the module can be imported in Node tests without exploding.
function getJsPDF() {
  const g = (typeof window !== 'undefined' ? window : globalThis);
  if (!g.jspdf || !g.jspdf.jsPDF) {
    throw new Error('jspdf not loaded — expected window.jspdf.jsPDF');
  }
  return g.jspdf.jsPDF;
}

// ── Simple diary list PDF ───────────────────────────────────────────────────
// Replaces diary.js's exportPDFData(entries, label).
// Caller supplies the pre-computed season label + raw season code so the
// filename matches the legacy naming convention.
//
// Returns { filename, count } on success (so the caller can toast); returns
// null when there's nothing to export (empty-guard is still the caller's job,
// but we double-check to keep the module self-defensive).
export function buildSimpleDiaryPDF({ entries, label, season, filenameSlug }) {
  if (!entries || !entries.length) return null;

  const JsPDF = getJsPDF();
  const doc = new JsPDF();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  // Rich-family header band — stalker-facing document, gets the full
  // Season-Summary treatment: dark-green duotone, gold eyebrow, white title,
  // muted brand URL. MM_SCALE converts the helper's pt-native coords to mm
  // since this doc is constructed without a unit option (jspdf default = mm).
  const MM_SCALE = 25.4 / 72;
  const generatedAt = (function() {
    const d = new Date();
    const pad = function(n) { return n < 10 ? '0' + n : String(n); };
    return pad(d.getDate()) + ' ' + MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear()
         + ' - ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  })();
  const bandH = drawRichHeaderBand(doc, {
    pageW,
    title: 'Cull Diary  ·  ' + label,
    subtitle: plural(entries.length, 'entry', 'entries'),
    meta: { url: 'firstlightdeer.co.uk', generated: generatedAt },
    scale: MM_SCALE,
  });

  let y = bandH + 8;
  entries.forEach(function(e, i) {
    if (y > pageH - 24) { doc.addPage(); y = 20; }
    doc.setFontSize(12);

    // Title line: "1. Red Deer (Stag) · …" or "1. Blank day · …"
    const dateStr = fmtEntryDateLong(e.date) || '—';
    const timeStr = fmtEntryTimeShort(e.time);
    let headerTail = dateStr;
    if (timeStr) headerTail += ' · ' + timeStr;
    if (isBlankDayEntry(e)) {
      const g = (e.ground && String(e.ground).trim()) ? pdfSafeText(e.ground) : '—';
      doc.text(
        (i + 1) + '. Blank day · ' + g + ' · ' + headerTail,
        14, y
      );
    } else {
      doc.text(
        (i + 1) + '. ' + pdfSafeText(e.species) + ' (' + sexLabel(e.sex, e.species) + ') · ' + headerTail,
        14, y
      );
    }

    y += 6;
    doc.setFontSize(9);

    const meta = [];
    // Outing window — applies to both cull entries and blank days. Both halves
    // optional; we render an em-dash placeholder for the missing side so the
    // funder reading this can still see the half that was filled.
    if (e.outing_start_time || e.outing_end_time) {
      const os = fmtEntryTimeShort(e.outing_start_time) || '—';
      const oe = fmtEntryTimeShort(e.outing_end_time) || '—';
      meta.push('Outing: ' + os + '–' + oe);
    }
    if (e.ground)        meta.push('Ground: ' + pdfSafeText(e.ground));
    if (e.location_name) meta.push('Location: ' + pdfSafeText(e.location_name));
    if (!isBlankDayEntry(e)) {
      if (e.weight_kg)     meta.push('Weight: ' + e.weight_kg + 'kg');
      if (e.tag_number)    meta.push('Tag: ' + pdfSafeText(e.tag_number));
      if (e.calibre)       meta.push('Calibre: ' + pdfSafeText(e.calibre));
      if (e.distance_m)    meta.push('Distance: ' + e.distance_m + 'm');
      if (e.shot_placement) meta.push('Placement: ' + pdfSafeText(e.shot_placement));
      if (e.age_class)     meta.push('Age: ' + pdfSafeText(e.age_class));
      if (e.shooter && String(e.shooter).trim() && String(e.shooter).trim().toLowerCase() !== 'self') {
        meta.push('Shooter: ' + pdfSafeText(String(e.shooter).trim()));
      }
      if (e.destination)   meta.push('Destination: ' + pdfSafeText(e.destination));
    }

    if (meta.length) {
      // Meta can now run long (3 extra fields), so wrap to page width instead
      // of clipping off-page.
      const metaLines = doc.splitTextToSize(meta.join(' · '), 180);
      metaLines.forEach(function(line) {
        if (y > pageH - 24) { doc.addPage(); y = 20; }
        doc.text(line, 14, y); y += 5;
      });
    }
    if (e.notes) {
      const noteLines = doc.splitTextToSize('Notes: ' + pdfSafeText(e.notes), 180);
      noteLines.forEach(function(line) {
        if (y > pageH - 24) { doc.addPage(); y = 20; }
        doc.text(line, 14, y); y += 4;
      });
      y += 1;
    }
    y += 4;
    // Soft stone-coloured divider to match the rich palette.
    setPdfStroke(doc, PDF_PALETTE.stone);
    doc.setLineWidth(0.3);
    doc.line(14, y, pageW - 14, y); y += 5;
  });

  // Retrospective page footer — brand line + Page N of M on every page.
  const totalPages = doc.getNumberOfPages ? doc.getNumberOfPages() : 1;
  for (let p = 1; p <= totalPages; p++) {
    if (doc.setPage) doc.setPage(p);
    drawPdfFooter(doc, { pageW, pageH, pageNum: p, totalPages });
  }

  // `filenameSlug` (added for the unified season+ground export modal) lets
  // the caller dictate the full filename body in one go — we prepend the
  // standard `cull-diary-` prefix. Falls back to the legacy season-vs-all
  // branching when not provided so existing call sites stay identical.
  const filename = filenameSlug
    ? 'cull-diary-' + filenameSlug
    : (label === 'All Seasons' ? 'cull-diary-all-seasons' : 'cull-diary-' + season);
  doc.save(filename + '.pdf');
  return { filename: filename + '.pdf', count: entries.length };
}

// ── Single entry one-pager PDF ──────────────────────────────────────────────
// Replaces diary.js's exportSinglePDF(id). Caller already has the resolved
// entry object (so we stay out of the allEntries lookup business).
export function buildSingleEntryPDF({ entry }) {
  if (!entry) return null;
  if (isBlankDayEntry(entry)) return null;

  const JsPDF = getJsPDF();
  const doc = new JsPDF();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  // Date shown in long form ("Sat 11 Apr 2026") so the record is
  // unambiguous in isolation; ISO form retained as a bracketed suffix so
  // the stalker can cross-reference back to the database row when needed.
  const dateLong = fmtEntryDateLong(entry.date);
  const dateCell = dateLong
    ? (dateLong + (entry.date ? ' (' + entry.date + ')' : ''))
    : (entry.date || '');
  const timeCell = fmtEntryTimeShort(entry.time) || entry.time || '';

  // Rich-family header — stalker-facing record. Species + sex in the
  // subtitle line so a reader lands on "what was shot" immediately below
  // the big title.
  const MM_SCALE = 25.4 / 72;
  const bandH = drawRichHeaderBand(doc, {
    pageW,
    title: 'Cull Record',
    subtitle: (entry.species || 'Entry') + '  ·  ' + (sexLabel(entry.sex, entry.species) || '—')
            + (dateCell ? '  ·  ' + dateCell : ''),
    meta: { url: 'firstlightdeer.co.uk' },
    scale: MM_SCALE,
  });

  doc.setFontSize(10);

  const fields = [
    ['Date', dateCell],
    ['Time', timeCell],
    ['Outing start', fmtEntryTimeShort(entry.outing_start_time)],
    ['Outing finish', fmtEntryTimeShort(entry.outing_end_time)],
    ['Location', pdfSafeText(entry.location_name)],
    ['Ground', pdfSafeText(entry.ground)],
    ['Age class', pdfSafeText(entry.age_class)],
    ['Carcass weight', hasValue(entry.weight_kg) ? entry.weight_kg + ' kg' : ''],
    ['Tag number', pdfSafeText(entry.tag_number || '')],
    ['Calibre', pdfSafeText(entry.calibre)],
    ['Distance', hasValue(entry.distance_m) ? entry.distance_m + 'm' : ''],
    ['Shot placement', pdfSafeText(entry.shot_placement)],
    ['Destination', pdfSafeText(entry.destination)],
    ['Notes', entry.notes ? pdfSafeText(entry.notes).slice(0, 300) : null],
  ];

  let y = bandH + 10;
  fields.forEach(function(f) {
    if (!f[1]) return;
    if (y > pageH - 24) { doc.addPage(); y = 20; }
    doc.setFont(undefined, 'bold');   doc.text(f[0] + ':', 14, y);
    doc.setFont(undefined, 'normal'); doc.text(String(f[1]), 60, y);
    y += 7;
  });

  // Footer — single-page record usually, but through the shared helper so
  // the brand line + "Page 1 of 1" are consistent with every other PDF.
  const totalPages = doc.getNumberOfPages ? doc.getNumberOfPages() : 1;
  for (let p = 1; p <= totalPages; p++) {
    if (doc.setPage) doc.setPage(p);
    drawPdfFooter(doc, { pageW, pageH, pageNum: p, totalPages });
  }

  // Filename: include species + time so same-day entries don't collide.
  // Pattern: cull-record-<species>-<YYYY-MM-DD>[-<HHMM>].pdf
  // Slug mirrors the one the game-dealer declaration PDF uses so both
  // per-carcass artefacts sort together in the downloads folder.
  const speciesSlug = String(entry.species || 'entry').replace(/\s+/g, '-').toLowerCase();
  const datePart = entry.date || 'na';
  const timeSlug = fmtEntryTimeShort(entry.time).replace(':', '');
  const filenameBase = 'cull-record-' + speciesSlug + '-' + datePart + (timeSlug ? '-' + timeSlug : '');
  const filename = filenameBase + '.pdf';
  doc.save(filename);
  return { filename };
}

// ── Larder book (single user) ──────────────────────────────────────────────
// Every carcass the stalker retrieved to the larder, for the current season
// (or all seasons when the caller is showing All Seasons). Not a dealer-only
// document — covers self-consumption, gifted, etc. The only legitimate
// exclusion is "Left on hill" (carcass never entered the larder).
//
// Caller passes the already-scoped list (diary.js calls this with
// `filteredEntries`). We do the "Left on hill" filter + chronological sort
// internally so tests can rely on a single deterministic output shape, and
// so the caller's array isn't mutated (legacy code did an in-place sort of
// `filteredEntries`, which was a subtle bug the UI never surfaced).
export function buildLarderBookPDF({ filteredEntries, user, season }) {
  if (!filteredEntries || !filteredEntries.length) return null;

  const entries = filteredEntries
    .filter(function(e) { return !isBlankDayEntry(e) && (e.destination || '').toLowerCase() !== 'left on hill'; })
    .slice()
    .sort(function(a, b) {
      return (a.date || '').localeCompare(b.date || '')
          || (a.time || '').localeCompare(b.time || '');
    });
  if (entries.length === 0) return null;

  const JsPDF = getJsPDF();
  const doc = new JsPDF('landscape');
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  let stalkerLine = '';
  try {
    stalkerLine = userProfileDisplayName(user) || (user && user.email) || '';
  } catch (_) { /* defensive — malformed user obj */ }

  // Prefer "Season 2025/26" over a raw first/last date so a dealer or auditor
  // instantly sees the scope. Fall back to date range for All Seasons.
  let scopeLine;
  try {
    scopeLine = (season && season !== '__all__')
      ? 'Season ' + seasonLabel(season)
      : 'All seasons · ' + entries[0].date + ' to ' + entries[entries.length - 1].date;
  } catch (_) {
    scopeLine = entries[0].date + ' to ' + entries[entries.length - 1].date;
  }

  // Professional-family header — matches the Team Larder treatment so the
  // two larder books read as the same document class.
  let y = drawProfessionalHeader(doc, {
    pageW,
    title: 'Larder Book',
    subtitle: (stalkerLine ? stalkerLine + '  ·  ' : '') + scopeLine + '  ·  ' + plural(entries.length, 'carcass', 'carcasses'),
  });

  const headers = ['#','Date','Tag','Species','Sex','Weight (kg)','Location / Ground','Destination','Abnormalities'];
  const colX    = [14,  22,   52,    78,        110,  133,           155,                210,           248];
  y = drawTableHeader(doc, { headers, colX, y, pageW });

  doc.setFontSize(7.5);
  entries.forEach(function(e, idx) {
    if (y > pageH - 28) {
      doc.addPage();
      y = drawTableHeader(doc, { headers, colX, y: 16, pageW });
      doc.setFontSize(7.5);
    }
    const locText = pdfSafeText(((e.location_name || '') + (e.ground ? ' / ' + e.ground : ''))
      .trim().replace(/^\//, '').trim());
    const row = [
      String(idx + 1),
      e.date || '—',
      pdfSafeText(e.tag_number || '—'),
      e.species || '—',
      sexLabel(e.sex, e.species) || '—',
      hasValue(e.weight_kg) ? String(e.weight_kg) : '—',
      (locText || '—').slice(0, 40),
      pdfSafeText(e.destination || '—').slice(0, 25),
      pdfSafeText(e.notes || 'None observed').slice(0, 40)
    ];
    for (let c = 0; c < row.length; c++) doc.text(row[c], colX[c], y);
    y += 5.5;
  });

  // Totals bar — thin-ruled frame (no fill), same calibration as Team Larder.
  y += 4;
  if (y > pageH - 36) { doc.addPage(); y = 20; }
  doc.setDrawColor(150); doc.setLineWidth(0.3);
  doc.rect(14, y - 4, pageW - 28, 9);
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(0);
  doc.text('Total carcasses:', 18, y + 1.8);
  doc.setFont(undefined, 'normal');
  doc.text(String(entries.length), 58, y + 1.8);
  doc.setFont(undefined, 'bold');
  doc.text('Total weight:', 110, y + 1.8);
  doc.setFont(undefined, 'normal');
  doc.text(formatTotalKg(entries.map(function(e) { return e.weight_kg; })), 143, y + 1.8);
  y += 18;

  // Signature — stalker signs the solo book (no manager layer).
  if (y > pageH - 24) { doc.addPage(); y = 20; }
  drawSignatureBlock(doc, y, pageW, {
    primary: { label: 'Stalker signature' },
    date:    { label: 'Date' }
  });

  // Retrospective page footer — stamp brand line + page N of M on every page.
  const totalPages = doc.getNumberOfPages ? doc.getNumberOfPages() : 1;
  for (let p = 1; p <= totalPages; p++) {
    if (doc.setPage) doc.setPage(p);
    drawPdfFooter(doc, { pageW, pageH, pageNum: p, totalPages });
  }

  const filename = 'larder-book-' + entries[0].date + '.pdf';
  doc.save(filename);
  return { filename, count: entries.length };
}

// ── Syndicate "list" PDF (simple culls list) ───────────────────────────────
// The lightweight "rows summary" export used by syndicate views. All inputs
// are already sliced from the RPC (no globals touched).
export function buildSyndicateListPDF({ rows, syndicateName, seasonLabelStr, filenameBase }) {
  if (!rows || !rows.length) return null;

  const JsPDF = getJsPDF();
  const doc = new JsPDF();
  doc.setFontSize(16);
  doc.text('Syndicate culls — ' + syndicateName, 14, 18);
  doc.setFontSize(10);
  doc.text(seasonLabelStr + ' · ' + rows.length + ' rows · firstlightdeer.co.uk', 14, 26);

  let y = 36;
  rows.forEach(function(r, i) {
    if (y > 275) { doc.addPage(); y = 20; }
    doc.setFontSize(10); doc.setFont(undefined, 'bold');
    doc.text((i + 1) + '. ' + (r.species || '—'), 14, y);
    doc.setFont(undefined, 'normal');
    doc.text(sexLabel(r.sex, r.species), 100, y);
    doc.text(fmtEntryDateShort(r.cull_date) || String(r.cull_date || '—'), 130, y);
    y += 5;
    doc.setFontSize(9); doc.setTextColor(100, 100, 100);
    doc.text('Culled by: ' + (r.culledBy || '—'), 14, y);
    doc.setTextColor(0, 0, 0);
    y += 8;
  });

  const filename = filenameBase + '.pdf';
  doc.save(filename);
  return { filename, count: rows.length };
}

// ── Syndicate "team larder book" PDF ───────────────────────────────────────
// Manager export: every carcass the team took across a season, with the
// SHOOTER column that single-user larder book doesn't have. Rows come
// pre-filtered server-side (RPC excludes "Left on hill" / anonymised
// retention rows) — we just sort chronologically and render.
export function buildSyndicateLarderBookPDF({ syndicate, season, rows }) {
  if (!rows || !rows.length) return null;

  const JsPDF = getJsPDF();
  const doc = new JsPDF('landscape');
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const label = seasonLabel(season);
  const synName = (syndicate && syndicate.name) || 'Syndicate';

  // Scope line — distinct-shooter count + applied ground filter.
  // Calculated here so it can be embedded in the compliance header helper
  // rather than rendered as a separate element (which pushed the table down
  // and made the header feel "stacked" in the old design).
  const gf = (syndicate && syndicate.ground_filter) ? String(syndicate.ground_filter).trim() : '';
  const shooterSet = {};
  rows.forEach(function(r) {
    const k = (r.culledBy || '').trim() || '(unnamed)';
    shooterSet[k] = true;
  });
  const shooterCount = Object.keys(shooterSet).length;
  const filterPart = gf ? 'Ground filter: "' + gf + '"' : 'Ground filter: none (all grounds)';
  const shooterPart = plural(shooterCount, 'contributing shooter');

  // --- Professional (compliance-style) header ----------------------------
  // Thin dark-green rule + gold eyebrow + black title. No fill band — this
  // is a document a dealer / auditor will read, so restraint beats
  // branding. Scope + shooter-count baked in so both are immediately
  // legible above the table without a separate stacked line.
  let y = drawProfessionalHeader(doc, {
    pageW,
    title: 'Larder Book',
    subtitle: synName + '  ·  Season ' + label + '  ·  ' + plural(rows.length, 'carcass', 'carcasses'),
    scope: filterPart + '   ·   ' + shooterPart,
  });

  // Column layout — Shooter is the new column vs the single-user export.
  // Deliberate order: numeric # first, then the identity columns (date, tag,
  // shooter, species, sex) that a dealer checks first, then weight and
  // location bundle, then inspection / destination. Location is the most
  // elastic so it goes last.
  const headers = ['#','Date','Time','Tag','Shooter','Species','Sex','Wt(kg)','Age','Destination','Location / Ground','Larder inspection'];
  const colX    = [14,  22,   42,    58,   78,       120,      148,  165,      180,  196,           227,                  261];
  y = drawTableHeader(doc, { headers, colX, y, pageW });

  function abnormCell(r) {
    // Concise inline summary: structured codes first, then free-text "other".
    // Truncated at the colX grid; full text stays readable in the diary UI.
    if (Array.isArray(r.abnormalities) && r.abnormalities.length) {
      if (r.abnormalities.length === 1 && r.abnormalities[0] === 'none') return 'None observed';
      const codes = r.abnormalities.filter(function(c) { return c !== 'none'; });
      let shown = codes.slice(0, 2).map(function(c) { return ABNORMALITY_LABEL_BY_CODE[c] || c; }).join(', ');
      if (codes.length > 2) shown += ' (+' + (codes.length - 2) + ')';
      if (r.abnormalities_other) shown += '; other: ' + pdfSafeText(r.abnormalities_other);
      return shown;
    }
    if (r.abnormalities_other) return pdfSafeText(r.abnormalities_other);
    return 'Not recorded';
  }

  doc.setFontSize(7.5);
  rows.forEach(function(r, idx) {
    if (y > pageH - 28) {
      doc.addPage();
      y = drawTableHeader(doc, { headers, colX, y: 16, pageW });
      doc.setFontSize(7.5);
    }
    const locText = pdfSafeText(((r.location_name || '') + (r.ground ? ' / ' + r.ground : ''))
      .trim().replace(/^\//, '').trim());
    const ageShort = (function(a) {
      if (!a) return '—';
      const s = String(a).trim();
      if (/^calf/i.test(s) || /kid|fawn/i.test(s)) return 'Calf';
      if (/yearling/i.test(s)) return 'Yrl';
      if (/adult/i.test(s)) return 'Adult';
      return s.slice(0, 7);
    })(r.age_class);
    const row = [
      String(idx + 1),
      r.date || '—',
      r.time || '—',
      pdfSafeText(r.tag_number || '—').slice(0, 12),
      pdfSafeText(r.culledBy || '—').slice(0, 22),
      (r.species || '—').slice(0, 14),
      sexLabel(r.sex, r.species) || '—',
      hasValue(r.weight_kg) ? String(r.weight_kg) : '—',
      ageShort,
      pdfSafeText(r.destination || '—').slice(0, 18),
      (locText || '—').slice(0, 22),
      abnormCell(r).slice(0, 28)
    ];
    for (let c = 0; c < row.length; c++) doc.text(row[c], colX[c], y);
    y += 5.5;
  });

  // --- Totals bar ---------------------------------------------------------
  // Thin-ruled frame (no fill) — consistent with the "restrained colour"
  // brief: frame reads as a formal totals summary without the beige fill
  // that was reading as decorative. `formatTotalKg` emits '—' when no row
  // contributed a weight, so partly-weighed books still make sense.
  y += 4;
  if (y > pageH - 36) { doc.addPage(); y = 20; }
  doc.setDrawColor(150); doc.setLineWidth(0.3);
  doc.rect(14, y - 4, pageW - 28, 9);
  doc.setFontSize(9); doc.setFont(undefined, 'bold'); doc.setTextColor(0);
  doc.text('Total carcasses:', 18, y + 1.8);
  doc.setFont(undefined, 'normal');
  doc.text(String(rows.length), 58, y + 1.8);
  doc.setFont(undefined, 'bold');
  doc.text('Total weight:', 110, y + 1.8);
  doc.setFont(undefined, 'normal');
  doc.text(formatTotalKg(rows.map(function(r) { return r.weight_kg; })), 143, y + 1.8);
  y += 18;

  // Manager signature — team book, so the manager signs it off. Uses the
  // shared `drawSignatureBlock` helper so the rules have consistent
  // thickness and alignment across PDFs (cleaner than typewriter `___`).
  if (y > pageH - 24) { doc.addPage(); y = 20; }
  drawSignatureBlock(doc, y, pageW, {
    primary: { label: 'Syndicate manager signature' },
    date:    { label: 'Date' }
  });

  // --- Retrospective page footer -----------------------------------------
  // Page count is only known after the body is fully drawn, so we loop
  // back through all pages now and stamp `Page N of M` + brand line on
  // each. Consistent footer positioning regardless of body length.
  const totalPages = doc.getNumberOfPages ? doc.getNumberOfPages() : 1;
  for (let p = 1; p <= totalPages; p++) {
    if (doc.setPage) doc.setPage(p);
    drawPdfFooter(doc, { pageW, pageH, pageNum: p, totalPages });
  }

  const filename = 'team-larder-book-' + syndicateFileSlug(synName) + '-' + season + '.pdf';
  doc.save(filename);
  return { filename, count: rows.length };
}

// ── Per-carcass Trained Hunter Declaration (game dealer) ───────────────────
// Assimilated Regulation (EC) No 853/2004 (GB) requires a trained hunter to declare that each
// carcass presented to a game dealer was examined at gralloch. This is the
// per-carcass version — caller passes an already-resolved entry.
//
// The declaration has three sections:
//   1. Entry facts table (species, date, location, tag, etc.)
//   2. Gralloch inspection list — structured abnormality codes with a legacy
//      fall-through to the free-text "notes" field for entries predating
//      the abnormalities columns.
//   3. Declaration statement + signature block + (optional) account email
//      reference when no explicit hunter name is set.
export function buildGameDealerDeclarationPDF({ entry, user }) {
  if (!entry) return null;
  if (isBlankDayEntry(entry)) return null;

  const { hunterName, accountEmail } = resolveHunterIdentity(user);

  const JsPDF = getJsPDF();
  const doc = new JsPDF();
  const pageW = doc.internal.pageSize.getWidth();
  const cx = pageW / 2;

  const pageH = doc.internal.pageSize.getHeight();

  // Professional-family header — thin moss rule + gold eyebrow + black title.
  // Subtitle carries the regulatory citation so a dealer immediately sees
  // what regime the declaration is made under.
  drawProfessionalHeader(doc, {
    pageW,
    title: 'Trained Hunter Declaration',
    subtitle: 'Wild Game — Assimilated Regulation (EC) No 853/2004',
  });

  // Long-form date + bracketed ISO for audit cross-reference. Matches the
  // single-entry "cull record" convention so the two per-carcass artefacts
  // read consistently.
  const dateLong = fmtEntryDateLong(entry.date);
  const dateCell = dateLong
    ? (dateLong + (entry.date ? ' (' + entry.date + ')' : ''))
    : (entry.date || '');
  const timeCell = fmtEntryTimeShort(entry.time) || entry.time || '';

  const fields = [
    ['Species', entry.species || ''],
    ['Sex', sexLabel(entry.sex, entry.species)],
    ['Date of kill', dateCell],
    ['Time', timeCell],
    ['Location', pdfSafeText(entry.location_name || '')],
    ['Tag / carcass number', pdfSafeText(entry.tag_number || '')],
    ['Carcass weight (kg)', hasValue(entry.weight_kg) ? String(entry.weight_kg) : ''],
    ['Shot placement', pdfSafeText(entry.shot_placement || '')]
  ];

  let y = 50;
  doc.setFontSize(10);
  fields.forEach(function(f) {
    doc.setFont(undefined, 'bold');   doc.text(f[0] + ':', 20, y);
    doc.setFont(undefined, 'normal'); doc.text(f[1], 80, y);
    y += 8;
  });

  y += 6;
  doc.setFontSize(10); doc.setFont(undefined, 'bold');
  doc.text('Gralloch inspection (APHA / FSA trained-hunter checklist):', 20, y);
  doc.setFont(undefined, 'normal'); y += 8;

  // Structured list — each checklist code on its own line so a dealer /
  // inspector can see at a glance what was observed. Falls back to the
  // legacy "notes as abnormalities" behaviour for entries pre-dating the
  // abnormalities columns.
  const abnormCodes = Array.isArray(entry.abnormalities) ? entry.abnormalities : null;
  const abnormOther = pdfSafeText(entry.abnormalities_other || '');
  const hasStructured = (abnormCodes && abnormCodes.length > 0) || abnormOther;

  if (hasStructured) {
    if (abnormCodes && abnormCodes.length === 1 && abnormCodes[0] === 'none') {
      doc.text('- No abnormalities observed at gralloch.', 20, y);
      y += 7;
      if (abnormOther) {
        const altLines = doc.splitTextToSize('Additional note: ' + abnormOther, pageW - 40);
        doc.text(altLines, 20, y);
        y += altLines.length * 6;
      }
    } else if (abnormCodes && abnormCodes.length) {
      abnormCodes.filter(function(c) { return c !== 'none'; }).forEach(function(code) {
        doc.text('• ' + (ABNORMALITY_LABEL_BY_CODE[code] || code), 22, y);
        y += 6;
      });
      if (abnormOther) {
        const oLines = doc.splitTextToSize('• Other: ' + abnormOther, pageW - 40);
        doc.text(oLines, 22, y);
        y += oLines.length * 6;
      }
    } else {
      // Only free-text "other" was provided.
      const soloLines = doc.splitTextToSize('• ' + abnormOther, pageW - 40);
      doc.text(soloLines, 22, y);
      y += soloLines.length * 6;
    }
    y += 6;
  } else {
    // Legacy entries: no structured data captured. Fall back to notes as a
    // pragmatic stand-in so an older declaration still reads correctly.
    const legacy = entry.notes ? pdfSafeText(entry.notes).slice(0, 500) : 'Not recorded at gralloch';
    const splitNotes = doc.splitTextToSize(legacy, pageW - 40);
    doc.text(splitNotes, 20, y);
    y += splitNotes.length * 6 + 6;
  }
  y += 6;

  doc.setDrawColor(200); doc.line(14, y, pageW - 14, y); y += 12;

  // Declaration body — wrap to usable page width instead of hard-coding
  // breaks. Old code hand-broke into three lines, but the first line
  // ("...this carcass and") ran past the right margin at 10pt on A4,
  // leaving a ragged right edge with the text overflowing the page.
  // `splitTextToSize` now flows the sentence to fit `pageW - 40` (20mm
  // gutters each side) and drops each line on a 6mm baseline.
  doc.setFontSize(10);
  const declText = 'I, the undersigned trained hunter, declare that I have examined this carcass and its viscera at the time of gralloching and found no abnormalities other than those noted above. I further declare that no abnormal behaviour was observed before the kill, and that I have no suspicion of environmental contamination affecting the kill site. (Declaration made under assimilated Regulation (EC) No 853/2004, Annex III, Section IV, Chapter II.)';
  const declLines = doc.splitTextToSize(declText, pageW - 40);
  doc.text(declLines, 20, y);
  y += declLines.length * 6 + 10;

  doc.text('Trained hunter name: ' + (hunterName || '________________________'), 20, y); y += 10;
  if (accountEmail && !hunterName) {
    doc.setFontSize(8); doc.setTextColor(120);
    doc.text('First Light account (reference): ' + accountEmail, 20, y);
    doc.setFontSize(10); doc.setTextColor(0);
    y += 8;
  }
  // Shared signature block — thin rules rather than typewriter underscores.
  drawSignatureBlock(doc, y, pageW, {
    primary: { label: 'Trained hunter signature' },
    date:    { label: 'Date' }
  });

  // Retrospective page footer — single page for this declaration, but
  // through the shared helper for consistency with the larders.
  const totalPages = doc.getNumberOfPages ? doc.getNumberOfPages() : 1;
  for (let p = 1; p <= totalPages; p++) {
    if (doc.setPage) doc.setPage(p);
    drawPdfFooter(doc, { pageW, pageH, pageNum: p, totalPages });
  }

  // Filename disambiguates same-day same-species kills by appending HHMM
  // (colons stripped for Windows-safe filenames). Mirrors the cull-record PDF
  // naming scheme so both per-carcass artefacts cluster alphabetically and
  // pair up visually in the downloads folder.
  const speciesSlug = (entry.species || 'entry').replace(/\s+/g, '-').toLowerCase();
  const datePart = entry.date || 'na';
  const timeSlug = fmtEntryTimeShort(entry.time).replace(':', '');
  const filenameBase = 'declaration-' + speciesSlug + '-' + datePart + (timeSlug ? '-' + timeSlug : '');
  const filename = filenameBase + '.pdf';
  doc.save(filename);
  return { filename };
}

// ── Per-consignment Trained Hunter Declaration ─────────────────────────────
// Assimilated Reg (EC) No 853/2004 permits a single declaration covering every carcass in
// one consignment (delivery) rather than one declaration per carcass. The
// user selects N entries from the diary list in Select mode; caller passes
// the resolved entry rows — this function does the "Left on hill" exclusion
// internally so the excluded count can appear on the PDF.
//
// Return shape (caller drives the toast & select-mode exit):
//   null                       — no entries passed
//   { status: 'all-excluded',
//     excluded: N }            — every selected entry was "Left on hill"
//   { filename, count,
//     excluded: N }            — success
//
// NOTE on the header row: the consignment PDF uses a filled-green header
// rectangle with white text (not the bold-underline style used by the
// larder books), so it does not share `drawTableHeader`. We keep the
// 14-line block as an inner closure so the initial + page-break paths
// stay in sync (previously they were duplicated and had diverged slightly).
export function buildConsignmentDealerDeclarationPDF({ entries, user }) {
  if (!entries || !entries.length) return null;

  // Left-on-hill exclusion — a carcass that never entered the larder cannot
  // be declared. Blank days (no carcass) are excluded the same way.
  const hillEx = entries.filter(function(e) {
    return (e.destination || '').toLowerCase() === 'left on hill';
  }).length;
  const blankEx = entries.filter(isBlankDayEntry).length;
  const excluded = hillEx + blankEx;
  const filtered = entries.filter(function(e) {
    return !isBlankDayEntry(e) && (e.destination || '').toLowerCase() !== 'left on hill';
  }).slice(); // clone before sorting (don't mutate caller's array)

  if (filtered.length === 0) return { status: 'all-excluded', excluded };

  // Stable order: oldest first within the consignment — reads as a delivery manifest.
  filtered.sort(function(a, b) {
    return (a.date || '').localeCompare(b.date || '') || (a.time || '').localeCompare(b.time || '');
  });

  const { hunterName, accountEmail } = resolveHunterIdentity(user);

  // Landscape A4 — the carcass table needs a notes column; portrait is too
  // narrow to avoid mid-word wraps in Species and Location.
  const JsPDF = getJsPDF();
  const doc = new JsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
  const PW = 842, PH = 595;
  const ML = 24, MR = 24;
  const UW = PW - ML - MR;
  const cx = PW / 2;

  const dateMin = filtered[0].date || '';
  const dateMax = filtered[filtered.length - 1].date || '';
  const totalKg = filtered.reduce(function(s, e) { return s + (parseFloat(e.weight_kg) || 0); }, 0);
  const weighedCount = filtered.filter(function(e) { return hasValue(e.weight_kg); }).length;

  // Professional-family header — matches the Team/Solo Larder treatment
  // except the title is "Consignment — Trained Hunter Declaration" and
  // coordinates need to be rendered in points (this PDF was built with
  // { unit: 'pt' } for tighter column control on the landscape manifest).
  // PT_SCALE ≈ 72 / 25.4 so mm values inside the helper map correctly.
  const PT_SCALE = 72 / 25.4;
  const summary = plural(filtered.length, 'carcass', 'carcasses')
    + '  ·  ' + (weighedCount === filtered.length
                 ? Math.round(totalKg) + ' kg total'
                 : Math.round(totalKg) + ' kg (' + weighedCount + ' of ' + filtered.length + ' weighed)')
    + '  ·  ' + (dateMin === dateMax ? dateMin : dateMin + ' → ' + dateMax);
  const scopeLine = excluded > 0
    ? ('(' + excluded + ' excluded — "Left on hill" or blank day)')
    : '';
  let y = drawProfessionalHeader(doc, {
    pageW: PW,
    title: 'Consignment — Trained Hunter Declaration',
    subtitle: 'Wild Game — Assimilated Regulation (EC) No 853/2004  ·  ' + summary,
    scope: scopeLine,
    scale: PT_SCALE,
  });

  // Column widths + x-offsets. Named object so the row loop stays legible.
  const W_NUM = 24, W_TAG = 54, W_DATE = 56, W_TIME = 34, W_SP = 68, W_SEX = 44;
  const W_WT = 42, W_LOC = 220;
  const W_NOTES = UW - (W_NUM + W_TAG + W_DATE + W_TIME + W_SP + W_SEX + W_WT + W_LOC);
  const C = {
    num:  ML,
    tag:  ML + W_NUM,
    date: ML + W_NUM + W_TAG,
    time: ML + W_NUM + W_TAG + W_DATE,
    sp:   ML + W_NUM + W_TAG + W_DATE + W_TIME,
    sex:  ML + W_NUM + W_TAG + W_DATE + W_TIME + W_SP,
    wt:   ML + W_NUM + W_TAG + W_DATE + W_TIME + W_SP + W_SEX,
    loc:  ML + W_NUM + W_TAG + W_DATE + W_TIME + W_SP + W_SEX + W_WT,
    notes: ML + W_NUM + W_TAG + W_DATE + W_TIME + W_SP + W_SEX + W_WT + W_LOC,
  };

  // Inner closure — both the initial header and the page-break header draw
  // the same header row. Previously this was a filled-green bar with white
  // text; dialled back to match the restrained professional calibration:
  // bold black caps on white, with a thin rule below. Single source of
  // truth for both the initial and page-break paths.
  function drawConsignmentHeader(atY) {
    doc.setFontSize(7); doc.setFont(undefined, 'bold'); doc.setTextColor(0);
    doc.text('#', C.num + 4, atY + 9);
    doc.text('TAG', C.tag + 4, atY + 9);
    doc.text('DATE', C.date + 4, atY + 9);
    doc.text('TIME', C.time + 4, atY + 9);
    doc.text('SPECIES', C.sp + 4, atY + 9);
    doc.text('SEX', C.sex + 4, atY + 9);
    doc.text('WT(kg)', C.wt + 4, atY + 9);
    doc.text('LOCATION', C.loc + 4, atY + 9);
    doc.text('GRALLOCH / NOTES (abnormalities if any)', C.notes + 4, atY + 9);
    doc.setDrawColor(180); doc.setLineWidth(0.5);
    doc.line(ML, atY + 12, ML + UW, atY + 12);
    doc.setFont(undefined, 'normal'); doc.setFontSize(7);
    return atY + 14;
  }

  y = drawConsignmentHeader(y);

  filtered.forEach(function(e, idx) {
    if (y > PH - 120) {
      doc.addPage();
      y = drawConsignmentHeader(40);
    }
    // No zebra — compliance artefacts read cleaner without it, and a
    // trained-hunter declaration is typically short enough that the
    // table's column rules suffice for eye-tracking.
    const rowY = y + 9;
    doc.text(String(idx + 1), C.num + 4, rowY);
    doc.text(pdfSafeText(e.tag_number ? String(e.tag_number) : '–').slice(0, 10), C.tag + 4, rowY);
    doc.text(e.date || '–', C.date + 4, rowY);
    doc.text(e.time || '–', C.time + 4, rowY);
    doc.text((e.species || '–').slice(0, 12), C.sp + 4, rowY);
    doc.text((sexLabel(e.sex, e.species) || '–').slice(0, 8), C.sex + 4, rowY);
    doc.text(hasValue(e.weight_kg) ? String(e.weight_kg) : '–', C.wt + 4, rowY);
    const locTxt = pdfSafeText(e.location_name || '–');
    const locLines = doc.splitTextToSize(locTxt, W_LOC - 6);
    doc.text(locLines.length > 1 ? locLines[0].slice(0, 45) + '…' : (locLines[0] || '–'), C.loc + 4, rowY);

    // Prefer structured abnormalities over free-text notes: shorter, more
    // uniform, and actually defensible as "trained hunter ticked these boxes".
    // Codes expand to short labels; long lists append "+N" so row height
    // stays fixed.
    let gText;
    if (Array.isArray(e.abnormalities) && e.abnormalities.length) {
      if (e.abnormalities.length === 1 && e.abnormalities[0] === 'none') {
        gText = 'No abnormalities observed';
      } else {
        const codes = e.abnormalities.filter(function(c) { return c !== 'none'; });
        let shown = codes.slice(0, 2).map(function(c) { return ABNORMALITY_LABEL_BY_CODE[c] || c; }).join(', ');
        if (codes.length > 2) shown += ' (+' + (codes.length - 2) + ')';
        if (e.abnormalities_other) shown += '; other: ' + pdfSafeText(e.abnormalities_other);
        gText = shown;
      }
    } else if (e.abnormalities_other) {
      gText = pdfSafeText(e.abnormalities_other);
    } else if (e.notes && e.notes.trim()) {
      gText = pdfSafeText(e.notes.trim());
    } else {
      gText = 'Not recorded';
    }
    const nLines = doc.splitTextToSize(gText, W_NOTES - 6);
    doc.text(nLines.length > 1 ? nLines[0].slice(0, 40) + '…' : (nLines[0] || '–'), C.notes + 4, rowY);
    y += 14;
  });

  // Declaration block — force to next page if we can't fit declaration +
  // signature together, so the signed page isn't orphaned from the manifest.
  // Reserve ~140pt: declaration paragraph + signature + footer.
  if (y > PH - 140) { doc.addPage(); y = 40; }
  y += 16;
  doc.setDrawColor(200); doc.line(ML, y, PW - MR, y); y += 16;
  doc.setFontSize(10); doc.setFont(undefined, 'bold');
  doc.text('Declaration', ML, y); y += 12;
  doc.setFont(undefined, 'normal'); doc.setFontSize(9);
  const declLines = doc.splitTextToSize(
    'I, the undersigned trained hunter, declare that I examined each carcass listed above ' +
    'and its viscera at the time of gralloching, and found no abnormalities other than any ' +
    'recorded in the GRALLOCH / NOTES column for the carcass concerned. I further declare ' +
    'that no abnormal behaviour was observed before the kill, and that I have no suspicion of ' +
    'environmental contamination affecting the areas where the animals were taken. The carcasses are being ' +
    'transferred to the named game dealer as a single consignment. (Declaration made under ' +
    'assimilated Regulation (EC) No 853/2004, Annex III, Section IV, Chapter II.)',
    UW
  );
  doc.text(declLines, ML, y); y += declLines.length * 12 + 10;

  doc.setFontSize(10);
  doc.text('Trained hunter name: ' + (hunterName || '________________________________'), ML, y); y += 14;
  if (accountEmail && !hunterName) {
    doc.setFontSize(8); doc.setTextColor(120);
    doc.text('First Light account (reference): ' + accountEmail, ML, y);
    doc.setFontSize(10); doc.setTextColor(0); y += 12;
  }
  // Game dealer line — inline underline rule (no helper: this label is
  // unique to the consignment form).
  const gdLabel = 'Game dealer / consignee:';
  doc.text(gdLabel, ML, y);
  const gdLabelW = doc.getTextWidth ? doc.getTextWidth(gdLabel) : gdLabel.length * 5;
  doc.setDrawColor(80);
  doc.line(ML + gdLabelW + 6, y + 1.5, PW - MR, y + 1.5);
  y += 18;

  // Shared signature block — scale up to points since this doc is pt-unit.
  drawSignatureBlock(doc, y, PW, {
    primary: { label: 'Trained hunter signature' },
    date:    { label: 'Date' },
    scale:   PT_SCALE,
  });

  // Retrospective page footer — shared helper, scaled for pt.
  const totalPages = doc.getNumberOfPages ? doc.getNumberOfPages() : 1;
  for (let p = 1; p <= totalPages; p++) {
    if (doc.setPage) doc.setPage(p);
    drawPdfFooter(doc, { pageW: PW, pageH: PH, pageNum: p, totalPages, scale: PT_SCALE });
  }

  const filename = 'consignment-declaration-' + (dateMin || 'na')
    + (dateMax && dateMax !== dateMin ? '-to-' + dateMax : '')
    + '.pdf';
  doc.save(filename);
  return { filename, count: filtered.length, excluded };
}

// ── Season Summary PDF (rich family) ───────────────────────────────────────
// End-of-season report: branded header band, KPI stats row, species
// breakdown bars, cull-plan-vs-actual progress bars, 13-column entries
// table. A4 landscape at pt units so the wide table fits without crushing
// the Notes column. This is the reference "rich" PDF that the other rich
// artefacts (Simple Diary, Single Entry) were calibrated against.
//
// Opts:
//   entries              — the scoped entry list (may be currentSeason or "all seasons")
//   season               — ISO season code for the filename and the default title
//   seasonLabelOverride  — when the caller is exporting "All Seasons" this
//                          carries a human label ("All Seasons") that replaces
//                          the default "<season> Season Report"
//   groundOverride       — optional ground filter label for the subtitle /
//                          filename ("" or "All Grounds" to hide)
//   cullTargets          — { 'Red Deer-m': 3, … } targets keyed by species-sex
//                          (pass {} for "all seasons" exports — targets are
//                          per-season so they'd be misleading otherwise)
//   planSpecies          — PLAN_SPECIES array from diary.js — the known species
//                          list with mLbl/fLbl for the Cull Plan section
//   now                  — Date instance; injected so tests can freeze time
//
// Returns { filename, count } or null for empty input.
export function buildSeasonSummaryPDF({
  entries, season, seasonLabelOverride, groundOverride, cullTargets, planSpecies, now
}) {
  if (!entries || !entries.length) return null;
  const cullRows = entries.filter(function(e) { return !isBlankDayEntry(e); });
  const blankDayCount = entries.length - cullRows.length;

  const JsPDF = getJsPDF();
  const doc = new JsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
  const PW = 842, PH = 595;
  const ML = 18, MR = 18;

  // Palette accessors — same colour vocabulary as every other rich PDF.
  const P = PDF_PALETTE;
  const spColors = P.spColours;

  function hrule(y, col) {
    setPdfStroke(doc, col || P.stone); doc.setLineWidth(0.3);
    doc.line(0, y, PW, y);
  }

  // Continuation-page mini header — just a 24pt deep band with the eyebrow
  // text, so the reader knows the artefact on page 2+ is still the same
  // document. Uses the caller's season label for consistency with the body.
  function newPageIfNeeded(y, needed) {
    if (y + needed > PH - 50) {
      doc.addPage();
      setPdfFill(doc, P.deep); doc.rect(0, 0, PW, 24, 'F');
      setPdfText(doc, P.gold); doc.setFontSize(7); doc.setFont(undefined,'bold');
      const hdrSeason = seasonLabelOverride
        ? String(seasonLabelOverride).toUpperCase()
        : String(season).toUpperCase();
      doc.text('FIRST LIGHT  -  CULL DIARY  -  ' + hdrSeason, ML, 15);
      return 32;
    }
    return y;
  }

  // ── Stats ────────────────────────────────────────────────────────────
  // Avg kg must use entries-with-recorded-weight, not total count — otherwise
  // unweighed entries drag the headline down. (Pre-fix bug: 104kg across 2
  // weighed + 3 unweighed rows previously showed 21kg instead of 52kg.)
  // Headline stats exclude blank-day rows; full entry list still appears in the table below.
  const weighedEntries = cullRows.filter(function(e) { return hasValue(e.weight_kg); });
  const totalKg = weighedEntries.reduce(function(s, e) { return s + (parseFloat(e.weight_kg) || 0); }, 0);
  const avgKg   = weighedEntries.length ? Math.round(totalKg / weighedEntries.length) : 0;
  const spSet = {};
  cullRows.forEach(function(e) { if (e.species) spSet[e.species] = (spSet[e.species] || 0) + 1; });
  const spCount = Object.keys(spSet).length;

  // ── Local date formatters ────────────────────────────────────────────
  // These are the inline versions Season Summary always had; the exported
  // `fmtEntryDateLong` from this module returns "Sat 11 Apr 2026" (with the
  // weekday), which is too wide for the 52pt DATE column. Keep the compact
  // "11 Apr 2026" form here for the table.
  function fmtEntryDate(d) {
    if (!d) return '';
    const p = parseEntryDateParts(d);
    if (!p) { const s = String(d).trim(); return s || '—'; }
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return p.day + ' ' + months[p.m - 1] + ' ' + p.y;
  }
  function fmtEntryTime(t) {
    if (t === null || t === undefined || t === '') return '–';
    const s = String(t).trim();
    return s || '–';
  }

  // ── Header band (shared rich primitive) ──────────────────────────────
  const hasGr = groundOverride && groundOverride !== 'All Grounds';
  const nowDate = now || new Date();
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const _pdfHm = (function(d) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
      return {
        h: parseInt(parts.find(function(x) { return x.type === 'hour'; }).value, 10),
        m: parseInt(parts.find(function(x) { return x.type === 'minute'; }).value, 10)
      };
    } catch (_) {
      return { h: d.getHours(), m: d.getMinutes() };
    }
  })(nowDate);
  const genDate = nowDate.getDate() + ' ' + mo[nowDate.getMonth()] + ' ' + nowDate.getFullYear()
    + '  -  ' + ('0' + _pdfHm.h).slice(-2) + ':' + ('0' + _pdfHm.m).slice(-2);

  const pdfTitle = seasonLabelOverride || (season + ' Season Report');
  const HDR_H = drawRichHeaderBand(doc, {
    pageW: PW,
    title: pdfTitle,
    subtitle: hasGr ? ('Ground: ' + groundOverride) : '',
    meta: { url: 'firstlightdeer.co.uk', generated: genDate },
  });

  let y = HDR_H;

  // ── KPI stats row ────────────────────────────────────────────────────
  const STAT_H = 46, cw = PW / 4;
  const statData = [
    [String(cullRows.length), 'Total Cull'],
    [String(spCount),        'Species'],
    [String(Math.round(totalKg)), 'Total kg'],
    [avgKg ? String(avgKg) + 'kg' : '–',
     'Avg kg' + (weighedEntries.length && weighedEntries.length < cullRows.length ? ' (of ' + weighedEntries.length + ')' : '')],
  ];
  statData.forEach(function(s, i) {
    const x = i * cw;
    setPdfFill(doc, i % 2 === 0 ? P.white : '#faf8f5'); doc.rect(x, y, cw, STAT_H, 'F');
    if (i > 0) { setPdfStroke(doc, P.stone); doc.setLineWidth(0.5); doc.line(x, y, x, y + STAT_H); }
    setPdfText(doc, P.bark); doc.setFontSize(20); doc.setFont(undefined, 'bold');
    doc.text(s[0], x + cw / 2, y + 22, { align: 'center' });
    setPdfText(doc, P.muted); doc.setFontSize(7); doc.setFont(undefined, 'bold');
    doc.text(s[1].toUpperCase(), x + cw / 2, y + 35, { align: 'center' });
  });
  hrule(y + STAT_H, P.stone);
  y += STAT_H;
  if (blankDayCount > 0) {
    setPdfText(doc, P.muted); doc.setFontSize(8); doc.setFont(undefined, 'normal');
    doc.text('Also logged: ' + blankDayCount + ' blank day' + (blankDayCount === 1 ? '' : 's') + ' (outing, no shot)', ML, y + 6);
    y += 14;
  }

  // ── Section header helper ────────────────────────────────────────────
  function secHdr(y0, title) {
    setPdfFill(doc, '#f0ece6'); doc.rect(0, y0, PW, 18, 'F');
    setPdfStroke(doc, P.stone); doc.setLineWidth(0.5); doc.line(0, y0 + 18, PW, y0 + 18);
    setPdfText(doc, P.moss); doc.setFontSize(7); doc.setFont(undefined, 'bold');
    doc.text(title.toUpperCase(), ML, y0 + 11);
    return y0 + 18;
  }

  // ── Species breakdown ────────────────────────────────────────────────
  y = secHdr(y, 'Species Breakdown');
  const spSorted = Object.keys(spSet).sort(function(a, b) { return spSet[b] - spSet[a]; });
  const spMax = Math.max.apply(null, spSorted.map(function(k) { return spSet[k]; }).concat([1]));
  const totalWtBySpecies = {};
  cullRows.forEach(function(e) { totalWtBySpecies[e.species] = (totalWtBySpecies[e.species] || 0) + (parseFloat(e.weight_kg) || 0); });

  const bxBar = 180, bwBar = 450, bhBar = 5;
  const spCountX = bxBar + bwBar + 25;
  spSorted.forEach(function(sp) {
    y += 22;
    const base = y;
    const clr = spColors[sp] || P.moss;
    setPdfFill(doc, clr); doc.circle(22, base - 3, 3.5, 'F');
    setPdfText(doc, P.bark); doc.setFontSize(10); doc.setFont(undefined, 'bold');
    doc.text(sp, 32, base);
    setPdfFill(doc, P.stone); doc.roundedRect(bxBar, base - 5, bwBar, bhBar, 2, 2, 'F');
    setPdfFill(doc, clr); doc.roundedRect(bxBar, base - 5, bwBar * (spSet[sp] / spMax), bhBar, 2, 2, 'F');
    setPdfText(doc, P.bark); doc.setFontSize(10); doc.setFont(undefined, 'bold');
    doc.text(String(spSet[sp]), spCountX, base);
    setPdfText(doc, P.muted); doc.setFontSize(9); doc.setFont(undefined, 'normal');
    const wtStr = totalWtBySpecies[sp] ? Math.round(totalWtBySpecies[sp]) + ' kg' : '';
    doc.text(wtStr, PW - MR, base, { align: 'right' });
    hrule(base + 10, P.stone);
    y = base + 10;
  });

  if (spSorted.length) {
    y += 22;
    const spTotalBase = y;
    const spGrandTotal = cullRows.length;
    const spGrandKg = Math.round(
      spSorted.reduce(function(s, k) { return s + (totalWtBySpecies[k] || 0); }, 0)
    );
    setPdfText(doc, P.bark); doc.setFontSize(9); doc.setFont(undefined, 'bold');
    doc.text('TOTAL', 32, spTotalBase);
    setPdfText(doc, P.bark); doc.setFontSize(10); doc.setFont(undefined, 'bold');
    doc.text(String(spGrandTotal), spCountX, spTotalBase);
    setPdfText(doc, P.muted); doc.setFontSize(9); doc.setFont(undefined, 'bold');
    doc.text(spGrandKg ? spGrandKg + ' kg' : '–', PW - MR, spTotalBase, { align: 'right' });
    hrule(spTotalBase + 10, P.stone);
    y = spTotalBase + 10;
  }

  // ── Cull Plan vs Actual ──────────────────────────────────────────────
  // Targets are per-season. "All Seasons" exports blank cullTargets → skip
  // the section entirely rather than render a wall of "N (no target set)".
  const isAllSeasons = seasonLabelOverride === 'All Seasons';
  const actuals = {};
  cullRows.forEach(function(e) {
    if (!e.species || !e.sex) return;
    const k = e.species + '-' + e.sex;
    actuals[k] = (actuals[k] || 0) + 1;
  });
  const planSpeciesArr = planSpecies || [];
  let planRows = 0;
  if (!isAllSeasons) {
    planSpeciesArr.forEach(function(sp) {
      const mT = (cullTargets || {})[sp.name + '-m'] || 0, fT = (cullTargets || {})[sp.name + '-f'] || 0;
      const mA = actuals[sp.name + '-m'] || 0, fA = actuals[sp.name + '-f'] || 0;
      [[mT, mA], [fT, fA]].forEach(function(row) {
        if (!row[0] && !row[1]) return;
        planRows++;
      });
    });
  }
  if (planRows > 0) {
    y += 10;
    y = secHdr(y, 'Cull Plan vs Actual');
    let planTargetSum = 0, planActualSum = 0;
    planSpeciesArr.forEach(function(sp) {
      const mT = (cullTargets || {})[sp.name + '-m'] || 0, fT = (cullTargets || {})[sp.name + '-f'] || 0;
      const mA = actuals[sp.name + '-m'] || 0, fA = actuals[sp.name + '-f'] || 0;
      let spLabelDrawn = false;
      [['m', mT, mA], ['f', fT, fA]].forEach(function(row) {
        const sx = row[0], tgt = row[1], act = row[2];
        if (!tgt && !act) return;
        planTargetSum += tgt;
        planActualSum += act;
        y += 16;
        const sexLbl = sx === 'm' ? sp.mLbl : sp.fLbl;
        setPdfText(doc, P.bark); doc.setFontSize(9); doc.setFont(undefined, 'bold');
        if (!spLabelDrawn) { doc.text(sp.name, ML, y); spLabelDrawn = true; }
        setPdfText(doc, sx === 'm' ? '#8b4513' : '#8b1a4a'); doc.setFont(undefined, 'normal');
        doc.text(sexLbl, 82, y);
        const bx = 180, bw = 520, bh = 4;
        if (tgt > 0) {
          const pct = Math.min(1, act / tgt), done = act >= tgt;
          setPdfFill(doc, P.stone); doc.roundedRect(bx, y - 3, bw, bh, 2, 2, 'F');
          setPdfFill(doc, done ? '#2d7a1a' : P.moss); doc.roundedRect(bx, y - 3, bw * pct, bh, 2, 2, 'F');
          setPdfText(doc, done ? '#2d7a1a' : P.bark); doc.setFontSize(9); doc.setFont(undefined, 'bold');
          doc.text(act + '/' + tgt + (done ? ' (done)' : ''), PW - MR, y, { align: 'right' });
        } else {
          setPdfText(doc, P.muted); doc.setFontSize(9); doc.setFont(undefined, 'normal');
          doc.text(String(act) + ' (no target set)', PW - MR, y, { align: 'right' });
        }
        hrule(y + 6, P.stone);
      });
    });

    y += 16;
    const bx = 180, bw = 520, bh = 5;
    setPdfText(doc, P.bark); doc.setFontSize(9); doc.setFont(undefined, 'bold');
    doc.text('TOTAL', ML, y);
    if (planTargetSum > 0) {
      const tPct = Math.min(1, planActualSum / planTargetSum);
      const tDone = planActualSum >= planTargetSum;
      setPdfFill(doc, P.stone); doc.roundedRect(bx, y - 3, bw, bh, 2, 2, 'F');
      setPdfFill(doc, tDone ? '#2d7a1a' : P.gold); doc.roundedRect(bx, y - 3, bw * tPct, bh, 2, 2, 'F');
      setPdfText(doc, tDone ? '#2d7a1a' : P.bark); doc.setFontSize(10); doc.setFont(undefined, 'bold');
      doc.text(planActualSum + '/' + planTargetSum + (tDone ? ' (done)' : ''), PW - MR, y, { align: 'right' });
    } else {
      setPdfText(doc, P.muted); doc.setFontSize(9); doc.setFont(undefined, 'normal');
      doc.text(String(planActualSum) + ' culls', PW - MR, y, { align: 'right' });
    }
    hrule(y + 7, P.stone);
  }

  // ── Entries table (13 columns, 806pt = UW) ───────────────────────────
  y += 10;
  y = secHdr(y, 'All Entries — ' + entries.length + ' records');

  const W_DATE = 52, W_TIME = 30, W_SP = 62, W_SEX = 40, W_TAG = 44, W_WT = 38,
        W_AGE = 52, W_GRND = 62, W_PLACE = 54, W_SHOOT = 56, W_DEST = 60,
        W_LOC = 80, W_NOTES = 176;

  const COL = {
    date: ML, time: ML + W_DATE,
    species: ML + W_DATE + W_TIME,
    sex: ML + W_DATE + W_TIME + W_SP,
    tag: ML + W_DATE + W_TIME + W_SP + W_SEX,
    weight: ML + W_DATE + W_TIME + W_SP + W_SEX + W_TAG,
    age: ML + W_DATE + W_TIME + W_SP + W_SEX + W_TAG + W_WT,
    ground: ML + W_DATE + W_TIME + W_SP + W_SEX + W_TAG + W_WT + W_AGE,
    placement: ML + W_DATE + W_TIME + W_SP + W_SEX + W_TAG + W_WT + W_AGE + W_GRND,
    shooter: ML + W_DATE + W_TIME + W_SP + W_SEX + W_TAG + W_WT + W_AGE + W_GRND + W_PLACE,
    dest: ML + W_DATE + W_TIME + W_SP + W_SEX + W_TAG + W_WT + W_AGE + W_GRND + W_PLACE + W_SHOOT,
    location: ML + W_DATE + W_TIME + W_SP + W_SEX + W_TAG + W_WT + W_AGE + W_GRND + W_PLACE + W_SHOOT + W_DEST,
    notes: ML + W_DATE + W_TIME + W_SP + W_SEX + W_TAG + W_WT + W_AGE + W_GRND + W_PLACE + W_SHOOT + W_DEST + W_LOC
  };

  function shortAge(v) {
    if (!v) return '–';
    const s = String(v).trim();
    if (!s) return '–';
    return s.split(/\s*\/\s*|\s+/)[0] || s;
  }

  const TB = 7;
  y += 18;
  setPdfFill(doc, '#f0ece6'); doc.rect(0, y - 14, PW, 18, 'F');
  setPdfText(doc, P.muted); doc.setFontSize(6.5); doc.setFont(undefined, 'bold');
  const hdrs = [
    ['DATE', COL.date], ['TIME', COL.time], ['SPECIES', COL.species], ['SEX', COL.sex],
    ['TAG', COL.tag], ['WT(kg)', COL.weight], ['AGE', COL.age],
    ['GROUND', COL.ground], ['PLACE', COL.placement], ['SHOOTER', COL.shooter],
    ['DEST', COL.dest], ['LOCATION', COL.location], ['NOTES', COL.notes]
  ];
  hdrs.forEach(function(h) { doc.text(h[0], h[1], y - 3); });
  hrule(y + 4, P.stone);

  entries.forEach(function(e, i) {
    y = newPageIfNeeded(y, 22);
    y += 18;
    setPdfFill(doc, i % 2 === 0 ? P.white : '#fdfcfa'); doc.rect(0, y - 12, PW, 18, 'F');
    doc.setFontSize(TB); setPdfText(doc, P.bark); doc.setFont(undefined, 'normal');
    doc.text(fmtEntryDate(e.date), COL.date, y);
    doc.text(fmtEntryTime(e.time), COL.time, y);
    if (isBlankDayEntry(e)) {
      doc.text('Blank day', COL.species, y);
      setPdfText(doc, P.muted); doc.setFont(undefined, 'normal');
      doc.text('—', COL.sex, y);
    } else {
      doc.text((e.species || '').slice(0, 16), COL.species, y);
      setPdfText(doc, e.sex === 'm' ? '#8b4513' : '#8b1a4a'); doc.setFont(undefined, 'bold');
      doc.text(sexLabel(e.sex, e.species), COL.sex, y);
    }
    setPdfText(doc, P.bark); doc.setFont(undefined, 'normal');
    doc.text((e.tag_number ? String(e.tag_number) : '–').slice(0, 10), COL.tag, y);
    doc.text(hasValue(e.weight_kg) ? String(e.weight_kg).slice(0, 8) : '–', COL.weight, y);
    doc.text(shortAge(e.age_class).slice(0, 10), COL.age, y);
    const gnd = (e.ground && String(e.ground).trim()) ? pdfSafeText(String(e.ground).trim()) : '–';
    const gLines = doc.splitTextToSize(gnd, W_GRND - 2);
    doc.text(gLines.length > 1 ? gLines[0] + '…' : (gLines[0] || '–'), COL.ground, y);
    doc.text((pdfSafeText(e.shot_placement) || '–').slice(0, 12), COL.placement, y);
    doc.text((e.shooter && e.shooter !== 'Self' ? pdfSafeText(e.shooter) : '–').slice(0, 14), COL.shooter, y);
    const dest = (e.destination && String(e.destination).trim()) ? pdfSafeText(String(e.destination).trim()) : '–';
    const dLines = doc.splitTextToSize(dest, W_DEST - 2);
    doc.text(dLines.length > 1 ? dLines[0] + '…' : (dLines[0] || '–'), COL.dest, y);
    const locRaw = pdfSafeText(String(e.location_name || '–'));
    const locLines = doc.splitTextToSize(locRaw, W_LOC - 2);
    doc.text(locLines.length > 1 ? locLines[0] + '…' : (locLines[0] || '–'), COL.location, y);
    const noteRaw = (e.notes && String(e.notes).trim()) ? pdfSafeText(String(e.notes).replace(/\s+/g, ' ').trim()) : '–';
    const noteLines = doc.splitTextToSize(noteRaw, W_NOTES - 2);
    doc.text(noteLines.length > 1 ? noteLines[0] + '…' : (noteLines[0] || '–'), COL.notes, y);
    hrule(y + 4, P.stone);
  });

  // Footer on every page — bespoke (not the shared `drawPdfFooter`) because
  // the Season Summary wants brand colour on the right and stone rule full
  // width. Could be unified later; low priority.
  const pageCount = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    setPdfStroke(doc, P.stone); doc.setLineWidth(0.5); doc.line(0, PH - 38, PW, PH - 38);
    setPdfText(doc, P.muted); doc.setFontSize(7); doc.setFont(undefined, 'normal');
    doc.text('First Light  -  Cull Diary  -  Page ' + p + ' of ' + pageCount, ML, PH - 24);
    setPdfText(doc, P.gold);
    doc.text('firstlightdeer.co.uk', PW - MR, PH - 24, { align: 'right' });
  }

  // Filename — legacy convention. "first-light-all-seasons" for all-seasons
  // exports, otherwise the season code; ground suffix slugged for safety.
  let summaryFilename = seasonLabelOverride
    ? 'first-light-all-seasons'
    : 'first-light-season-' + season;
  if (groundOverride && groundOverride !== 'All Grounds') {
    summaryFilename += '-' + String(groundOverride).replace(/[^a-z0-9]/gi, '-').toLowerCase();
  }
  const filename = summaryFilename + '.pdf';
  doc.save(filename);
  return { filename, count: entries.length };
}

// ── Syndicate Season Summary PDF (rich family, portrait) ───────────────────
// Manager's season-end report for the syndicate: branded header, KPI stats
// (total/species/male/female), species breakdown bars, cull-plan-vs-actual
// (from the summary RPC rows), and a 4-column entries table. Portrait A4 at
// pt units — the 4-column table doesn't need landscape.
//
// Opts:
//   syndicate       — { name } (filename slug uses this)
//   season          — ISO season code
//   entries         — RPC rows with { cull_date, species, sex, culledBy, ... }
//   summaryRows     — RPC rows with { species, sex, target_total, actual_total }
//   planSpecies     — PLAN_SPECIES array from diary.js
//   planSpeciesMeta — function(name) → { name, mLbl, fLbl } resolver
//   now             — Date for the generated-on stamp (injectable for tests)
export function buildSyndicateSeasonSummaryPDF({
  syndicate, season, entries, summaryRows, planSpecies, planSpeciesMeta, now
}) {
  const JsPDF = getJsPDF();
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });
  const PW = 595, PH = 842, ML = 18, MR = 18;

  const P = PDF_PALETTE;
  const spColors = P.spColours;

  function hrule(y, col) {
    setPdfStroke(doc, col || P.stone); doc.setLineWidth(0.3);
    doc.line(0, y, PW, y);
  }
  function newPageIfNeeded(y, needed) {
    if (y + needed > PH - 50) {
      doc.addPage();
      setPdfFill(doc, P.deep); doc.rect(0, 0, PW, 24, 'F');
      setPdfText(doc, P.gold); doc.setFontSize(7); doc.setFont(undefined, 'bold');
      doc.text('FIRST LIGHT  -  SYNDICATE  -  ' + String(season).toUpperCase(), ML, 15);
      return 32;
    }
    return y;
  }
  function secHdr(y0, title) {
    setPdfFill(doc, '#f0ece6'); doc.rect(0, y0, PW, 18, 'F');
    setPdfStroke(doc, P.stone); doc.setLineWidth(0.5); doc.line(0, y0 + 18, PW, y0 + 18);
    setPdfText(doc, P.moss); doc.setFontSize(7); doc.setFont(undefined, 'bold');
    doc.text(title.toUpperCase(), ML, y0 + 11);
    return y0 + 18;
  }
  function fmtEntryDatePdf(d) {
    if (!d) return '—';
    const p = parseEntryDateParts(d);
    if (!p) return String(d);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return p.day + ' ' + months[p.m - 1] + ' ' + p.y;
  }

  // Header band — shared rich primitive. Syndicate name is the title,
  // seasonLabel is the subtitle.
  const nowDate = now || new Date();
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const _pdfHm = (function(d) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
      return {
        h: parseInt(parts.find(function(x) { return x.type === 'hour'; }).value, 10),
        m: parseInt(parts.find(function(x) { return x.type === 'minute'; }).value, 10)
      };
    } catch (_) {
      return { h: d.getHours(), m: d.getMinutes() };
    }
  })(nowDate);
  const genDate = nowDate.getDate() + ' ' + mo[nowDate.getMonth()] + ' ' + nowDate.getFullYear()
    + '  -  ' + ('0' + _pdfHm.h).slice(-2) + ':' + ('0' + _pdfHm.m).slice(-2);

  const HDR_H = drawRichHeaderBand(doc, {
    pageW: PW,
    eyebrow: 'FIRST LIGHT  -  SYNDICATE SUMMARY',
    title: (syndicate && syndicate.name) || 'Syndicate',
    subtitle: seasonLabel(season),
    meta: { url: 'firstlightdeer.co.uk', generated: genDate },
  });

  let y = HDR_H + 12;

  const mCount = entries.filter(function(e) { return e.sex === 'm'; }).length;
  const fCount = entries.filter(function(e) { return e.sex === 'f'; }).length;
  const spSet = {};
  entries.forEach(function(e) { spSet[e.species] = (spSet[e.species] || 0) + 1; });
  const spCount = Object.keys(spSet).length;

  const STAT_H = 46, cw = PW / 4;
  const statData = [
    [String(entries.length), 'Total culls'],
    [String(spCount), 'Species'],
    [String(mCount), 'Male'],
    [String(fCount), 'Female']
  ];
  statData.forEach(function(s, i) {
    const x = i * cw;
    setPdfFill(doc, i % 2 === 0 ? P.white : '#faf8f5');
    doc.rect(x, y, cw, STAT_H, 'F');
    if (i > 0) {
      setPdfStroke(doc, P.stone); doc.setLineWidth(0.5);
      doc.line(x, y, x, y + STAT_H);
    }
    setPdfText(doc, P.bark); doc.setFontSize(20); doc.setFont(undefined, 'bold');
    doc.text(s[0], x + cw / 2, y + 22, { align: 'center' });
    setPdfText(doc, P.muted); doc.setFontSize(7); doc.setFont(undefined, 'bold');
    doc.text(s[1].toUpperCase(), x + cw / 2, y + 35, { align: 'center' });
  });
  hrule(y + STAT_H, P.stone);
  y += STAT_H;

  y = secHdr(y, 'Species breakdown');
  const spSorted = Object.keys(spSet).sort(function(a, b) { return spSet[b] - spSet[a]; });
  if (!spSorted.length) {
    y += 14;
    setPdfText(doc, P.muted); doc.setFontSize(9); doc.setFont(undefined, 'normal');
    doc.text('No culls recorded for this season.', ML, y);
    y += 8;
  }
  const spMax = Math.max.apply(null, spSorted.map(function(k) { return spSet[k]; }).concat([1]));
  const bxBar = 130, bwBar = 210, bhBar = 5;
  spSorted.forEach(function(sp) {
    y += 22;
    const base = y;
    const clr = spColors[sp] || P.moss;
    setPdfFill(doc, clr); doc.circle(22, base - 3, 3.5, 'F');
    setPdfText(doc, P.bark); doc.setFontSize(10); doc.setFont(undefined, 'bold');
    doc.text(sp, 32, base);
    setPdfFill(doc, P.stone); doc.roundedRect(bxBar, base - 5, bwBar, bhBar, 2, 2, 'F');
    setPdfFill(doc, clr); doc.roundedRect(bxBar, base - 5, bwBar * (spSet[sp] / spMax), bhBar, 2, 2, 'F');
    setPdfText(doc, P.bark); doc.setFontSize(10); doc.setFont(undefined, 'bold');
    doc.text(String(spSet[sp]), 355, base);
    hrule(base + 10, P.stone);
    y = base + 10;
  });

  // Cull plan — from RPC summaryRows rather than local targets.
  const byKey = {};
  (summaryRows || []).forEach(function(row) {
    const k = row.species + '-' + row.sex;
    byKey[k] = row;
  });
  const planSpeciesArr = planSpecies || [];
  const metaFn = planSpeciesMeta || function(name) { return { name: name, mLbl: 'Male', fLbl: 'Female' }; };
  let planRows = 0;
  planSpeciesArr.forEach(function(ps) {
    ['m', 'f'].forEach(function(sx) {
      const row = byKey[ps.name + '-' + sx];
      const tgt = row ? parseInt(row.target_total, 10) || 0 : 0;
      const act = row ? parseInt(row.actual_total, 10) || 0 : 0;
      if (tgt || act) planRows++;
    });
  });

  if (planRows > 0) {
    y += 10;
    y = secHdr(y, 'Cull plan vs actual');
    planSpeciesArr.forEach(function(ps) {
      const spMeta = metaFn(ps.name);
      let spLabelDrawn = false;
      ['m', 'f'].forEach(function(sx) {
        const row = byKey[ps.name + '-' + sx];
        const tgt = row ? parseInt(row.target_total, 10) || 0 : 0;
        const act = row ? parseInt(row.actual_total, 10) || 0 : 0;
        if (!tgt && !act) return;
        y += 16;
        const sexLbl = sx === 'm' ? (spMeta.mLbl || 'Male') : (spMeta.fLbl || 'Female');
        setPdfText(doc, P.bark); doc.setFontSize(9); doc.setFont(undefined, 'bold');
        if (!spLabelDrawn) { doc.text(ps.name, ML, y); spLabelDrawn = true; }
        setPdfText(doc, sx === 'm' ? '#8b4513' : '#8b1a4a'); doc.setFont(undefined, 'normal');
        doc.text(sexLbl, 120, y);
        const bx = 200, bw = 220, bh = 4;
        if (tgt > 0) {
          const pct = Math.min(1, act / tgt);
          const done = act >= tgt;
          setPdfFill(doc, P.stone); doc.roundedRect(bx, y - 3, bw, bh, 2, 2, 'F');
          setPdfFill(doc, done ? '#2d7a1a' : P.moss); doc.roundedRect(bx, y - 3, bw * pct, bh, 2, 2, 'F');
          setPdfText(doc, done ? '#2d7a1a' : P.bark); doc.setFontSize(9); doc.setFont(undefined, 'bold');
          doc.text(act + '/' + tgt + (done ? ' (done)' : ''), PW - MR, y, { align: 'right' });
        } else {
          setPdfText(doc, P.muted); doc.setFontSize(9); doc.setFont(undefined, 'normal');
          doc.text(String(act) + ' (no target set)', PW - MR, y, { align: 'right' });
        }
        hrule(y + 6, P.stone);
      });
    });
  }

  // Entries table — 4 columns.
  y += 10;
  y = newPageIfNeeded(y, 40);
  y = secHdr(y, 'All entries — ' + entries.length + ' records');

  const W_DATE = 78, W_SP = 100, W_SEX = 52, W_BY = PW - ML - MR - W_DATE - W_SP - W_SEX;
  const COL = {
    date: ML,
    species: ML + W_DATE,
    sex: ML + W_DATE + W_SP,
    by: ML + W_DATE + W_SP + W_SEX
  };

  y += 18;
  setPdfFill(doc, '#f0ece6'); doc.rect(0, y - 14, PW, 18, 'F');
  setPdfText(doc, P.muted); doc.setFontSize(6.5); doc.setFont(undefined, 'bold');
  doc.text('DATE', COL.date, y - 3);
  doc.text('SPECIES', COL.species, y - 3);
  doc.text('SEX', COL.sex, y - 3);
  doc.text('CULLED BY', COL.by, y - 3);
  hrule(y + 4, P.stone);

  entries.forEach(function(e, i) {
    y = newPageIfNeeded(y, 22);
    y += 18;
    setPdfFill(doc, i % 2 === 0 ? P.white : '#fdfcfa'); doc.rect(0, y - 12, PW, 18, 'F');
    doc.setFontSize(7); setPdfText(doc, P.bark); doc.setFont(undefined, 'normal');
    doc.text(fmtEntryDatePdf(e.cull_date), COL.date, y);
    doc.text(String(e.species || '').slice(0, 22), COL.species, y);
    setPdfText(doc, e.sex === 'm' ? '#8b4513' : '#8b1a4a'); doc.setFont(undefined, 'bold');
    doc.text(sexLabel(e.sex, e.species), COL.sex, y);
    setPdfText(doc, P.bark); doc.setFont(undefined, 'normal');
    const byLines = doc.splitTextToSize(pdfSafeText(String(e.culledBy || '—')), W_BY - 2);
    doc.text(byLines.length ? byLines[0] : '—', COL.by, y);
    hrule(y + 4, P.stone);
  });

  const pageCount = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    setPdfStroke(doc, P.stone); doc.setLineWidth(0.5); doc.line(0, PH - 38, PW, PH - 38);
    setPdfText(doc, P.muted); doc.setFontSize(7); doc.setFont(undefined, 'normal');
    doc.text('First Light  -  ' + ((syndicate && syndicate.name) || 'Syndicate') + '  -  Page ' + p + ' of ' + pageCount, ML, PH - 24);
    setPdfText(doc, P.gold);
    doc.text('firstlightdeer.co.uk', PW - MR, PH - 24, { align: 'right' });
  }

  const filename = 'syndicate-' + syndicateFileSlug((syndicate && syndicate.name) || 'syndicate')
    + '-summary-' + season + '.pdf';
  doc.save(filename);
  return { filename, count: entries.length };
}
