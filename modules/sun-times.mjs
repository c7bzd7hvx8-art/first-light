// First Light — modules/sun-times.mjs
//
// UK-locked sun-time helpers consumed by modules/activity-engine.mjs and
// modules/stand-planner.mjs. The implementations are byte-for-byte copies
// of the originals in app.js (calcSunTime ~L343, toMinutes ~L398, addMins
// ~L472, fmtMinutes ~L467) so the planner's day/dawn/dusk maths matches
// what the home page banner badge already shows.
//
// Why a copy instead of importing from app.js: app.js is loaded only on
// index.html as a classic <script>. diary.html (where the planner lives)
// never loads app.js, so its top-level function declarations aren't on
// `window` from the planner's perspective. A future cleanup pass can
// invert the dependency — see PLAN §3 — but that requires converting
// app.js to a module and is gated on a manual parity test that can only
// be run in a browser.

/**
 * Calendar Y/M/D (month 1–12) for an instant in Europe/London. Single
 * source for "which day" solar + legal calcs use, regardless of the
 * device timezone.
 */
export function ukCalendarYmdLondon(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  let y, m, d;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type === 'year') y = parseInt(parts[i].value, 10);
    else if (parts[i].type === 'month') m = parseInt(parts[i].value, 10);
    else if (parts[i].type === 'day') d = parseInt(parts[i].value, 10);
  }
  return { y, m, d };
}

/** Wall-clock {h, m} in Europe/London for the given Date. */
export function ukHourMin(dateObj) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(dateObj);
  return {
    h: parseInt(parts.find(p => p.type === 'hour').value, 10),
    m: parseInt(parts.find(p => p.type === 'minute').value, 10)
  };
}

/**
 * Sunrise / sunset for `date` at (lat,lng), anchored on the Europe/London
 * civil day. Returns a Date or null if the sun never rises/sets at that
 * latitude on that date.
 */
export function calcSunTime(date, lat, lng, isSunrise) {
  const ymd = ukCalendarYmdLondon(date);
  const y = ymd.y, mo = ymd.m, d = ymd.d;
  if (y == null || mo == null || d == null || isNaN(y)) return null;

  const rad = Math.PI / 180;
  const lngHour = lng / 15;
  const jan1 = Date.UTC(y, 0, 1);
  const cur = Date.UTC(y, mo - 1, d);
  const dayOfYear = Math.round((cur - jan1) / 86400000) + 1;

  const t = isSunrise ? dayOfYear + (6  - lngHour) / 24
                      : dayOfYear + (18 - lngHour) / 24;
  const M = (0.9856 * t) - 3.289;
  let L = M + (1.916 * Math.sin(M * rad)) + (0.020 * Math.sin(2 * M * rad)) + 282.634;
  L = ((L % 360) + 360) % 360;
  let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
  RA = ((RA % 360) + 360) % 360;
  const Lquad  = Math.floor(L  / 90) * 90;
  const RAquad = Math.floor(RA / 90) * 90;
  RA = (RA + Lquad - RAquad) / 15;
  const sinDec = 0.39782 * Math.sin(L * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH   = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return null;
  let H = isSunrise ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad;
  H /= 15;
  const T = H + RA - (0.06571 * t) - 6.622;
  const UT = ((T - lngHour) % 24 + 24) % 24;
  const utcMs = Date.UTC(y, mo - 1, d) + UT * 3600000;
  return new Date(utcMs);
}

/** Date → minutes since UK midnight (0–1439). */
export function toMinutes(dateObj) {
  const hm = ukHourMin(dateObj);
  return hm.h * 60 + hm.m;
}

/** Returns a new Date `mins` minutes after `dateObj`. */
export function addMins(dateObj, mins) {
  return new Date(dateObj.getTime() + mins * 60000);
}

/** Format minutes-since-midnight as "HH:MM" (wraps over 1440). */
export function fmtMinutes(totalMin) {
  const m = ((totalMin % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mn = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mn < 10 ? '0' : '') + mn;
}

/**
 * Activity-engine variant of fmtMinutes (matches app.js fmtMins ~L2831):
 * tolerant of null/undefined, rounds the input first.
 */
export function fmtMins(m) {
  if (m === null || m === undefined) return '--:--';
  const mm = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(mm / 60), mn = mm % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mn < 10 ? '0' : '') + mn;
}

/**
 * Midnight-safe interval check. All inputs in minutes-since-midnight.
 * Handles windows that cross midnight (end < start).
 */
export function inWindow(cur, start, end) {
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;
}
