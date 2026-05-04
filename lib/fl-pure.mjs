// =============================================================================
// First Light — pure helpers (ES module)
//
// This file is the canonical, side-effect-free subset of diary.js. It's the
// behavioural spec the test suite in `tests/fl-pure.test.mjs` pins down. Every
// function in here MUST be:
//   * pure (no DOM, no network, no globals, no `new Date()` without explicit
//     input, no reads from `window` / `document` / `navigator`);
//   * identical to the copy currently inlined in diary.js (paste-copied so
//     the classic-script bundle keeps working unchanged).
//
// Ordering plan:
//   1. Today — tests exercise *this* file. diary.js still carries its own
//      copies; drift is caught when someone updates one side without the
//      other (the test suite will fail or at least look wrong).
//   2. When diary.js gets modularised (P3 code-quality #1), the inline copies
//      in diary.js will be deleted and diary.js will import from here. At
//      that point the tests become a real runtime guard, not just a spec.
//
// DO NOT add DOM-touching helpers here. If a helper needs a `document` ref,
// it belongs in diary.js. Keep this file testable in Node with zero deps.
// =============================================================================

// ── Data tables (must match diary.js) ─────────────────────────────────────
export const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Abnormality options — closed list, ordered the same as the on-screen grid.
// Keep this in lock-step with diary.js `ABNORMALITY_OPTIONS`. The `code`
// values are persisted in the Supabase `abnormalities` TEXT[] column, so
// renaming or reordering `code` values is a breaking data migration.
export const ABNORMALITY_OPTIONS = [
  { code: 'poor-condition',  label: 'Poor body condition / emaciated' },
  { code: 'lymph-enlarged',  label: 'Enlarged / abnormal lymph nodes' },
  { code: 'abscess',         label: 'Abscess or pus' },
  { code: 'cysts',           label: 'Cysts in organs' },
  { code: 'fluke',           label: 'Liver fluke visible' },
  { code: 'tb-lesions',      label: 'Lung lesions (possible TB)' },
  { code: 'tumour',          label: 'Tumour / unusual growth' },
  { code: 'parasites-heavy', label: 'Heavy ecto-parasite burden' },
  { code: 'joints-swollen',  label: 'Swollen / arthritic joints' },
  { code: 'oedema-general',  label: 'Generalised oedema / swelling (not joint-only)' },
  { code: 'organ-colour',    label: 'Abnormal organ colour or smell' },
  { code: 'jaundice',        label: 'Jaundice (yellow discolouration)' },
  { code: 'behaviour',       label: 'Abnormal behaviour before shot' },
  { code: 'bruising',        label: 'Bruising beyond shot path' },
  { code: 'pre-existing-injury', label: 'Pre-existing wounds / injuries / fractures' },
  { code: 'gralloch-contamination', label: 'Gralloch contamination (rumen spill, faecal)' }
];

export const ABNORMALITY_LABEL_BY_CODE = (function() {
  const m = {};
  ABNORMALITY_OPTIONS.forEach(function(o) { m[o.code] = o.label; });
  return m;
})();

// ── Season maths ──────────────────────────────────────────────────────────
// UK deer season year runs Aug→Jul — "2025-26" means "started Aug 2025".

/**
 * Format a compact season key (e.g. "2025-26") as a long label
 * ("2025–2026 Season"). Accepts both 2-digit and 4-digit end years; always
 * returns an en-dash between years.
 */
export function seasonLabel(s) {
  if (s == null || s === '') return '—';
  const raw = String(s).trim();
  if (raw === '__all__') return 'All seasons';
  const parts = raw.split('-');
  if (parts.length < 2 || parts[1] === undefined || parts[1] === '') {
    return raw;
  }
  const y1 = parts[0];
  const y2 = parts[1].length === 2 ? '20' + parts[1] : parts[1];
  return y1 + '–' + y2 + ' Season';
}

/**
 * Compute the season key for an entry's date (YYYY-MM-DD). Any month >= Aug
 * rolls the entry into that year's season; Jan-Jul rolls into the *previous*
 * year. Invalid / empty input returns null (the browser fallback to
 * getCurrentSeason() is deliberately NOT ported here so this stays pure —
 * callers must handle null themselves).
 */
export function buildSeasonFromEntry(dateStr) {
  if (dateStr == null || dateStr === '') return null;
  const raw = String(dateStr).trim();
  if (!raw) return null;
  const parts = raw.split('-');
  if (parts.length < 2) return null;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  const startYear = m >= 8 ? y : y - 1;
  if (!Number.isFinite(startYear)) return null;
  return startYear + '-' + String(startYear + 1).slice(-2);
}

/**
 * Build a list of season keys from `current` going back as far as
 * `earliestSeason` (inclusive), capped at 10 years so the dropdown stays
 * sane. Both args are season keys like "2025-26"; `earliestSeason` null
 * returns a single-element list (just the current season).
 *
 * Separated from diary.js's `buildSeasonList` which pulls `getCurrentSeason()`
 * implicitly — we take `current` as a parameter so the function is pure.
 */
export function buildSeasonList(current, earliestSeason) {
  const seasons = [];
  const startYear = parseInt(current.split('-')[0], 10);
  const endYear   = earliestSeason ? parseInt(earliestSeason.split('-')[0], 10) : startYear;
  for (let y = startYear; y >= Math.max(endYear, startYear - 9); y--) {
    seasons.push(y + '-' + String(y + 1).slice(-2));
  }
  return seasons;
}

// ── Species / sex labels ─────────────────────────────────────────────────

/**
 * Label a sex code ('m' | 'f') appropriate to the species. Buck/Doe for
 * small-to-medium deer (Roe, Fallow, Muntjac, CWD); Stag/Hind for larger
 * deer (Red, Sika). Unknown species default to Stag/Hind.
 */
export function sexLabel(sex, species) {
  const isBuck = ['Roe Deer','Fallow','Muntjac','CWD'].indexOf(species) >= 0;
  if (sex === 'm') return isBuck ? 'Buck' : 'Stag';
  return isBuck ? 'Doe' : 'Hind';
}

export function sexBadgeClass(sex, species) {
  if (sex === 'm') return (species === 'Roe Deer' || species === 'Fallow' || species === 'Muntjac' || species === 'CWD') ? 'sx-bu' : 'sx-st';
  return (species === 'Roe Deer' || species === 'Fallow' || species === 'Muntjac' || species === 'CWD') ? 'sx-do' : 'sx-hi';
}

// ── Date parsing ─────────────────────────────────────────────────────────

/**
 * Parse a YYYY-MM-DD string into `{ y, m, day }` without going through the
 * Date constructor (which would apply a UTC shift). Returns null for blank
 * input or any segment that isn't a sane integer.
 */
export function parseEntryDateParts(d) {
  if (d == null || d === '') return null;
  const raw = String(d).trim();
  if (!raw) return null;
  const parts = raw.split('-');
  if (parts.length < 3) return null;
  const y = parseInt(parts[0], 10);
  const mo = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(day)) return null;
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  return { y: y, m: mo, day: day };
}

// ── CSV field quoting ────────────────────────────────────────────────────

/**
 * RFC-4180-ish CSV cell: always double-quoted, internal `"` doubled, any
 * CR/LF squashed to a space so Excel never splits a row mid-value. Null /
 * undefined serialise as empty string (two consecutive quotes).
 *
 * Formula-injection defence: if the raw value begins with a character
 * Excel / Google Sheets / LibreOffice treats as a formula trigger (`=`,
 * `+`, `-`, `@`, TAB, or CR), we prepend a single quote inside the
 * quoted cell so the cell is interpreted as plain text. This is the
 * OWASP-recommended mitigation; the apostrophe is visible only if the
 * cell is edited (spreadsheets hide it in display). See
 * https://owasp.org/www-community/attacks/CSV_Injection.
 */
export function csvField(v) {
  const raw = v === null || v === undefined ? '' : String(v);
  const first = raw.charAt(0);
  const needsGuard =
    first === '=' || first === '+' || first === '-' || first === '@' ||
    first === '\t' || first === '\r';
  const guarded = needsGuard ? "'" + raw : raw;
  return '"' + guarded.replace(/"/g, '""').replace(/\r\n|\r|\n/g, ' ') + '"';
}

// ── HTML escape ──────────────────────────────────────────────────────────

/**
 * Escape user-supplied text for safe interpolation into HTML. Covers the
 * five entities enough for attribute *and* text contexts. Null/undefined
 * return empty string.
 */
export function esc(s) {
  return (s === null || s === undefined) ? '' :
    String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
             .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
             .replace(/'/g,'&#x27;');
}

// ── Abnormality summary ──────────────────────────────────────────────────

/**
 * Human-readable summary of a gralloch inspection. Three shapes:
 *   ['none']          → "No abnormalities observed at gralloch"
 *   ['fluke','tb-lesions'] → "Liver fluke visible; Lung lesions (possible TB)"
 *   null / [] + other  → the `other` free-text alone, or null if nothing.
 * `other` is appended with "plus:" when specific codes are also present, or
 * parenthesised as an "additional note" alongside the "none" path.
 */
export function abnormalitySummaryText(codes, other) {
  const hasCodes = Array.isArray(codes) && codes.length > 0;
  const isNone = hasCodes && codes.length === 1 && codes[0] === 'none';
  const otherStr = (other && typeof other === 'string') ? other.trim() : '';
  if (isNone) {
    return otherStr
      ? 'No structural abnormalities observed (additional note: ' + otherStr + ')'
      : 'No abnormalities observed at gralloch';
  }
  if (hasCodes) {
    const labels = codes
      .filter(function(c) { return c !== 'none'; })
      .map(function(c) { return ABNORMALITY_LABEL_BY_CODE[c] || c; });
    const joined = labels.join('; ');
    return otherStr ? joined + '; plus: ' + otherStr : joined;
  }
  return otherStr || null;
}

// ── Relative time labels ──────────────────────────────────────────────────
// Used by the syndicate messages thread (and any future feed UI). Pure: takes
// `now` and `then` as Date-like inputs and a London wall-clock formatter, no
// reads of `new Date()` or globals. Returns a short, human label.
//
// Bucketing:
//   < 60s            → "just now"
//   < 60min          → "N min ago"
//   same calendar day (London) → "HH:MM" (24h)
//   yesterday (London)         → "Yesterday HH:MM"
//   within last 6 days         → "Mon HH:MM" (short weekday)
//   older                       → "11 Apr · HH:MM" (no year unless different)
//   older + different year     → "11 Apr 2024"
//
// `londonParts(date)` is a callback that returns
//   { y, m, d, h, mi, dow }
// where `dow` is 0..6 (Sun..Sat) — same shape Intl.DateTimeFormat exposes via
// formatToParts. Diary.js threads in a real London-TZ implementation; tests
// pass a deterministic UTC stub so the suite is timezone-independent.

const DOW_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export function formatRelativeTime(then, now, londonParts) {
  const t = then instanceof Date ? then : new Date(then);
  const n = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(t.getTime()) || !Number.isFinite(n.getTime())) return '';
  const deltaMs = n.getTime() - t.getTime();
  if (deltaMs < 0) return ''; // future timestamps: caller decides what to do
  if (deltaMs < 60_000) return 'just now';
  if (deltaMs < 60 * 60_000) {
    const m = Math.floor(deltaMs / 60_000);
    return m + ' min ago';
  }
  const a = londonParts(t);
  const b = londonParts(n);
  if (!a || !b) return '';
  const hhmm = String(a.h).padStart(2, '0') + ':' + String(a.mi).padStart(2, '0');
  if (a.y === b.y && a.m === b.m && a.d === b.d) return hhmm;
  // Yesterday: subtract one day from `now`'s calendar in London. We compare
  // by feeding (n - 86400000) through the same formatter — robust across
  // BST/GMT transitions because the caller resolves the offset.
  const yest = londonParts(new Date(n.getTime() - 86400000));
  if (yest && yest.y === a.y && yest.m === a.m && yest.d === a.d) {
    return 'Yesterday ' + hhmm;
  }
  // Within the last ~6 days: show short weekday + time.
  if (deltaMs < 7 * 24 * 60 * 60_000) {
    return DOW_SHORT[a.dow] + ' ' + hhmm;
  }
  if (a.y === b.y) {
    return a.d + ' ' + MONTH_NAMES[a.m - 1] + ' · ' + hhmm;
  }
  return a.d + ' ' + MONTH_NAMES[a.m - 1] + ' ' + a.y;
}

// ── Blank day (outing, no shot) ───────────────────────────────────────────

/**
 * True when the entry is a blank-day log (no deer culled). Legacy rows
 * without `is_blank` are treated as culls.
 */
export function isBlankDayEntry(entry) {
  return !!(entry && entry.is_blank === true);
}

/**
 * Short single-line summary for list cards (no species).
 */
export function blankDaySummaryText(entry) {
  if (!entry || !isBlankDayEntry(entry)) return '';
  const g = (entry.ground && String(entry.ground).trim()) || 'Outing';
  return 'Blank day at ' + g;
}
