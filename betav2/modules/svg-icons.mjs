// First Light — modules/svg-icons.mjs
//
// Every inline-SVG icon used across the Cull Diary UI, as raw string
// literals. Concatenation-style (not template-literals) is deliberate:
// these strings are fed into `element.innerHTML = '…' + SVG_X + '…'`
// patterns and the exact byte-for-byte output matters — any whitespace
// reshaping could break the rendered glyph (especially stroke icons
// sharing a `currentColor` inheritance).
//
// Extracted from diary.js L212-330 under the modularisation plan. Pure
// data, no logic. Safe to import lazily; side-effect free. Every caller
// who needs one of these icons imports only the ones it uses so unused
// blobs can one day be tree-shaken by a future bundler.
//
// If an icon is referenced only by diary.html markup (SVG already inlined
// in the HTML source), it does NOT belong here — only the ones that get
// assembled into innerHTML at runtime do.

/** Plan / stats — target reticle (matches diary.html `.plan-empty-icon` SVG). */
export const SVG_PLAN_TARGET_ICON =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<circle cx="12" cy="12" r="8" stroke="#5a7a30" stroke-width="1.5" opacity="0.55"/>' +
  '<circle cx="12" cy="12" r="3" stroke="#c8a84b" stroke-width="1.3"/>' +
  '<circle cx="12" cy="12" r="1" fill="#c8a84b"/>' +
  '<line x1="12" y1="2" x2="12" y2="5" stroke="#5a7a30" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>' +
  '<line x1="12" y1="19" x2="12" y2="22" stroke="#5a7a30" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>' +
  '<line x1="2" y1="12" x2="5" y2="12" stroke="#5a7a30" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>' +
  '<line x1="19" y1="12" x2="22" y2="12" stroke="#5a7a30" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>' +
  '</svg>';

export const SVG_CULL_MAP_EMPTY_PIN =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#5a7a30" fill-opacity="0.2" stroke="#5a7a30" stroke-width="1.2"/>' +
  '<circle cx="12" cy="9" r="2.2" fill="#c8a84b"/>' +
  '</svg>';

/** Stroke / fill icons — replaces emoji in diary UI (trusted markup only). */
export const SVG_FL_CLOUD =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M7 18h11a4 4 0 0 0 0-8h-.5A5.5 5.5 0 0 0 7 11a4 4 0 0 0 0 7z"/></svg>';
export const SVG_FL_CLIPBOARD =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M6 4h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>' +
  '<path d="M9 12h6M9 16h4"/></svg>';
export const SVG_FL_CAMERA =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3"/><path d="M8 6h2l1-2h4l1 2h2"/></svg>';
export const SVG_FL_IMAGE_GALLERY =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
export const SVG_FL_IMAGE_OFF =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
  '<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="5" y1="19" x2="19" y2="7"/></svg>';
export const SVG_FL_PIN =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 21s7-4.35 7-11a7 7 0 1 0-14 0c0 6.65 7 11 7 11z"/><circle cx="12" cy="10" r="2.2" fill="currentColor" stroke="none"/></svg>';
export const SVG_FL_GPS =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
  '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/>' +
  '<line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>';
export const SVG_FL_PENCIL =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
export const SVG_FL_FILE_PDF =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' +
  '<line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
export const SVG_FL_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
  '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
export const SVG_FL_BOOK =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' +
  '<path d="M8 7h8M8 11h6"/></svg>';
export const SVG_FL_QUICK =
  '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13 1L3 15h7l-1.5 10L21 9h-8l1-8z"/></svg>';
export const SVG_FL_SIGNAL =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
  '<path d="M2 20h20"/><path d="M6 16v-6M10 16V8M14 16v-9M18 16V5"/></svg>';
export const SVG_FL_TOAST_WARN =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
  '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
  '<line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
export const SVG_FL_TOAST_OK =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
export const SVG_FL_TOAST_INFO =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5"/><path d="M12 8h.01"/></svg>';
export const SVG_WX_TEMP =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.5">' +
  '<path d="M14 4v10.5a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z"/><circle cx="12" cy="17" r="3" fill="currentColor" fill-opacity="0.25" stroke="none"/></svg>';
export const SVG_WX_WIND =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
  '<path d="M4 10h10a2 2 0 1 0 0-4"/><path d="M4 14h14a3 3 0 1 1 0 6"/><path d="M6 18h9a2 2 0 1 0 0-4"/></svg>';
export const SVG_WX_PRESSURE =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.5">' +
  '<rect x="4" y="14" width="3" height="6" rx="0.5"/><rect x="10.5" y="10" width="3" height="10" rx="0.5"/><rect x="17" y="6" width="3" height="14" rx="0.5"/></svg>';
export const SVG_WX_SKY_CLR =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
  '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
export const SVG_WX_SKY_PTLY =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.5">' +
  '<circle cx="17.5" cy="7" r="2.5"/><path d="M4 18h12a3 3 0 0 0 0-6h-.5A4.5 4.5 0 0 0 4 11a3 3 0 0 0 0 7z"/></svg>';
export const SVG_WX_SKY_OVC =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  // Path identical to SVG_FL_CLOUD above — previously had a stray `0 `
  // between the arc's end-y (-8) and the `h` command, which made Chromium
  // reject the attribute with "Expected number" because the `a` arc command
  // takes exactly 7 params. Fixed 2026-04-16 during modularisation.
  '<path d="M7 18h11a4 4 0 0 0 0-8h-.5A5.5 5.5 0 0 0 7 11a4 4 0 0 0 0 7z"/></svg>';
export const SVG_WX_SKY_FOG =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">' +
  '<path d="M4 9h16M3 12h18M5 15h14"/></svg>';
export const SVG_WX_SKY_DZ =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.4">' +
  '<path d="M4 14h14a3 3 0 0 0 0-6h-.5A4.5 4.5 0 0 0 4 10a3 3 0 0 0 0 4z"/>' +
  '<circle cx="8" cy="19" r="1" fill="currentColor"/><circle cx="12" cy="19" r="1" fill="currentColor"/><circle cx="16" cy="19" r="1" fill="currentColor"/></svg>';
export const SVG_WX_SKY_RAIN =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.4">' +
  '<path d="M4 13h14a3 3 0 0 0 0-6h-.5A4.5 4.5 0 0 0 4 9a3 3 0 0 0 0 4z"/>' +
  '<line x1="8" y1="17" x2="7" y2="21"/><line x1="12" y1="17" x2="11" y2="21"/><line x1="16" y1="17" x2="15" y2="21"/></svg>';
export const SVG_WX_SKY_SHOWERS =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.4">' +
  '<path d="M4 13h14a3 3 0 0 0 0-6h-.5A4.5 4.5 0 0 0 4 9a3 3 0 0 0 0 4z"/>' +
  '<line x1="9" y1="16" x2="7" y2="20" stroke-width="2"/><line x1="15" y1="16" x2="13" y2="20" stroke-width="2"/></svg>';
export const SVG_WX_SKY_SNOW =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">' +
  '<path d="M4 13h14a3 3 0 0 0 0-6h-.5A4.5 4.5 0 0 0 4 9a3 3 0 0 0 0 4z"/>' +
  '<path d="M12 17v4M9.5 18.5l5 2.5M14.5 18.5l-5 2.5M10 19h4"/></svg>';
export const SVG_WX_SKY_SNSH =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">' +
  '<path d="M4 13h14a3 3 0 0 0 0-6h-.5A4.5 4.5 0 0 0 4 9a3 3 0 0 0 0 4z"/>' +
  '<path d="M9 20l1-2M12 21l1-2M15 20l1-2M9 18l1 1M12 17l1 1M15 18l1 1"/></svg>';
export const SVG_WX_SKY_TS =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.5">' +
  '<path d="M4 14h16a3 3 0 0 0 0-6h-1a5 5 0 0 0-9.9-1A4 4 0 0 0 4 10"/>' +
  '<path d="M13 17l-2 4M10 17l-2 4M16 17l-2 4" stroke-linecap="round"/></svg>';
export const SVG_WX_SKY_UNK =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke="currentColor" stroke-width="1.5">' +
  '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 2-3 4"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
