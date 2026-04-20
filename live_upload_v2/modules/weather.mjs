// First Light — modules/weather.mjs
// =============================================================================
// Weather-at-time-of-cull helpers extracted from diary.js during the Phase-1
// modularisation. See MODULARISATION-PLAN.md → Commit F.
//
// Scope of this module (the pure + fetch half of the weather feature):
//   • wxCodeLabel(code)            — WMO integer → { abbrev, label, skySvg, … }
//   • windDirLabel(deg)            — 0-360° → 'N' | 'NE' | … | 'NW' | ''
//   • findOpenMeteoHourlyIndex(…)  — match entry date+hour against the API's
//                                    hourly `time` array (handles 'YYYY-MM-DDTHH'
//                                    and ':00' / ':00:00' variants)
//   • diaryLondonWallMs(date,time) — treat 'YYYY-MM-DD' + 'HH:MM' strings as
//                                    Europe/London wall-clock and return UTC
//                                    epoch-ms; survives the user travelling
//                                    abroad and the BST/GMT transition
//   • fetchCullWeather(…)          — Open-Meteo forecast+past_days=7 call,
//                                    returns the shape that gets stored as
//                                    cull_entries.weather_data JSONB
//
// Explicitly *not* in this module (still in diary.js):
//   • attachWeatherToEntry()   — touches `sb`, `currentUser`, `allEntries`
//     (application state — wait for data.mjs)
//   • renderWeatherStrip()     — depends on `esc()` which is still inline
//     (wait until the HTML-escape helper graduates to fl-pure.mjs import)
//
// We import the sky-icon SVG strings from svg-icons.mjs so `wxCodeLabel`
// returns a ready-to-inline markup blob with no further plumbing in the
// caller. All functions below are pure except fetchCullWeather (which talks
// to api.open-meteo.com and reads the trusted UK clock).
// =============================================================================

import { diaryNow } from './clock.mjs';
import {
  SVG_WX_SKY_CLR, SVG_WX_SKY_PTLY, SVG_WX_SKY_OVC, SVG_WX_SKY_FOG,
  SVG_WX_SKY_DZ, SVG_WX_SKY_RAIN, SVG_WX_SKY_SHOWERS, SVG_WX_SKY_SNOW,
  SVG_WX_SKY_SNSH, SVG_WX_SKY_TS, SVG_WX_SKY_UNK
} from './svg-icons.mjs';

// ── WMO code → label/icon/bar-gradient ────────────────────────────────────
// Buckets follow Open-Meteo's WMO weather code table. The boundaries are
// inclusive (e.g. `<= 49` covers 45–48 fog codes). Pure — safe to unit-test.
export function wxCodeLabel(code) {
  var c = code;
  if (c === 0 || c === null || c === undefined) {
    return { abbrev: 'CLR', label: 'Clear', wmoTitle: 'WMO code 0', skySvg: SVG_WX_SKY_CLR, barBg: 'linear-gradient(90deg,#5a6a4a,#c8a84b)' };
  }
  if (c <= 2) {
    return { abbrev: 'PTLY', label: 'Partly cloudy', wmoTitle: 'WMO 1–2', skySvg: SVG_WX_SKY_PTLY, barBg: 'linear-gradient(90deg,#c8a84b,#6b7280)' };
  }
  if (c === 3) {
    return { abbrev: 'OVC', label: 'Overcast', wmoTitle: 'WMO code 3', skySvg: SVG_WX_SKY_OVC, barBg: 'linear-gradient(90deg,#5c6670,#8a9399)' };
  }
  if (c <= 49) {
    return { abbrev: 'FG', label: 'Fog', wmoTitle: 'WMO ≤49', skySvg: SVG_WX_SKY_FOG, barBg: 'linear-gradient(90deg,#5c5568,#8a8299)' };
  }
  if (c <= 57) {
    return { abbrev: 'DZ', label: 'Drizzle', wmoTitle: 'WMO 51–57', skySvg: SVG_WX_SKY_DZ, barBg: 'linear-gradient(90deg,#4a5a70,#7a8aa0)' };
  }
  if (c <= 65) {
    return { abbrev: 'RA', label: 'Rain', wmoTitle: 'WMO 61–65', skySvg: SVG_WX_SKY_RAIN, barBg: 'linear-gradient(90deg,#3d5a80,#6a8ab0)' };
  }
  if (c <= 77) {
    return { abbrev: 'SN', label: 'Snow', wmoTitle: 'WMO 71–77', skySvg: SVG_WX_SKY_SNOW, barBg: 'linear-gradient(90deg,#4a6070,#8a9eaa)' };
  }
  if (c <= 82) {
    return { abbrev: 'SHRA', label: 'Showers', wmoTitle: 'WMO 80–82', skySvg: SVG_WX_SKY_SHOWERS, barBg: 'linear-gradient(90deg,#3d5a80,#5a7a98)' };
  }
  if (c <= 86) {
    return { abbrev: 'SHSN', label: 'Snow showers', wmoTitle: 'WMO 85–86', skySvg: SVG_WX_SKY_SNSH, barBg: 'linear-gradient(90deg,#5a6a78,#9aa8b0)' };
  }
  if (c <= 99) {
    return { abbrev: 'TS', label: 'Thunderstorm', wmoTitle: 'WMO 95–99', skySvg: SVG_WX_SKY_TS, barBg: 'linear-gradient(90deg,#8a6a30,#4a5560)' };
  }
  return { abbrev: '–', label: 'Unknown', wmoTitle: 'No code', skySvg: SVG_WX_SKY_UNK, barBg: '#555' };
}

// ── Compass-point from bearing ────────────────────────────────────────────
// 8-point rose, 45° buckets centred on the cardinals. null/undefined →
// empty string (caller appends conditionally).
export function windDirLabel(deg) {
  if (deg === null || deg === undefined) return '';
  var dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

// ── Open-Meteo hourly index lookup ────────────────────────────────────────
// Open-Meteo has shipped both `YYYY-MM-DDTHH:00` and `YYYY-MM-DDTHH:00:00`
// variants across API versions; matching on the exact string first and then
// the `HH:` prefix handles both without regex cost.
export function findOpenMeteoHourlyIndex(times, date, hour) {
  if (!times || !times.length) return -1;
  var hh = ('0' + hour).slice(-2);
  var exact = date + 'T' + hh + ':00';
  var idx = times.indexOf(exact);
  if (idx !== -1) return idx;
  var prefix = date + 'T' + hh + ':';
  for (var i = 0; i < times.length; i++) {
    var t = times[i];
    if (typeof t === 'string' && t.indexOf(prefix) === 0) return i;
  }
  return -1;
}

/**
 * Interpret `YYYY-MM-DD` + `HH:MM` wall-clock strings as Europe/London time and
 * return a UTC epoch-ms. Needed because `new Date("YYYY-MM-DDTHH:MM:00")` uses
 * the device's local TZ — fine at home in the UK, wrong when the user is
 * abroad (a 6.9-day-old entry logged at UK wall-clock could slip past the
 * 7-day gate by an hour when recomputed in CET/EST).
 *
 * Works across BST/GMT transitions by asking Intl for the London offset at
 * the target UTC moment and subtracting it.
 */
export function diaryLondonWallMs(dateStr, timeStr) {
  var y  = parseInt(dateStr.slice(0, 4), 10);
  var mo = parseInt(dateStr.slice(5, 7), 10) - 1;
  var d  = parseInt(dateStr.slice(8, 10), 10);
  var t  = (timeStr || '12:00').split(':');
  var h  = parseInt(t[0], 10) || 0;
  var mn = parseInt(t[1], 10) || 0;
  var utcMs = Date.UTC(y, mo, d, h, mn);
  try {
    var fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      timeZoneName: 'longOffset'
    });
    var parts = fmt.formatToParts(new Date(utcMs));
    var tz = parts.find(function (p) { return p.type === 'timeZoneName'; });
    if (tz) {
      var m = tz.value.match(/GMT([+-])(\d{2}):?(\d{2})?/);
      if (m) {
        var sign = m[1] === '+' ? 1 : -1;
        var offMs = sign * ((parseInt(m[2], 10) * 3600000) + (parseInt(m[3] || '0', 10) * 60000));
        return utcMs - offMs;
      }
    }
  } catch (_) { /* fall through to a best-effort fallback */ }
  // Fallback: assume device TZ is UK (the overwhelmingly common case).
  return new Date(dateStr + 'T' + (timeStr || '12:00') + ':00').getTime();
}

/**
 * Read one Open-Meteo hourly sample. Arrays can exist while `arr[idx]` is
 * `null` (missing sample); coercing `null` with math yields 0 — wrong for temp.
 */
export function openMeteoHourlyValue(arr, idx) {
  if (!arr || idx < 0 || idx >= arr.length) return null;
  var v = arr[idx];
  if (v == null) return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

// ── Weather at time of cull ───────────────────────────────────────────────
// Fetches from Open-Meteo forecast API with past_days=7. The "last 7 days"
// gate is enforced client-side because the forecast endpoint will happily
// quote yesterday's weather but refuses anything older than past_days allows.
// Returns null (not throws) on *any* failure — the caller is a fire-and-forget
// background job after save and must never disturb the UI.
export async function fetchCullWeather(date, time, lat, lng) {
  if (!date || !lat || !lng) return null;

  // Interpret the entry's wall-clock as Europe/London so the 7-day gate doesn't
  // drift when the user's device is on holiday in a different TZ.
  var entryMs = diaryLondonWallMs(date, time);
  var nowMs = diaryNow().getTime();
  var ageDays = (nowMs - entryMs) / 86400000;

  // Skip if older than 7 days or in the future.
  if (ageDays > 7 || ageDays < 0) return null;

  var hour = time ? parseInt(time.split(':')[0]) : 12;

  try {
    // past_days=7 → 168 hourly samples back. forecast_days=1 keeps the URL
    // minimal; we only ever index into the past part of the array.
    var url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + lat + '&longitude=' + lng
      + '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,windgusts_10m,surface_pressure,cloud_cover,weather_code,precipitation'
      + '&past_days=7&forecast_days=1&timezone=auto';

    var r = await fetch(url);
    if (!r.ok) return null;
    var d = await r.json();

    var times = d.hourly && d.hourly.time ? d.hourly.time : [];
    var idx = findOpenMeteoHourlyIndex(times, date, hour);
    if (idx === -1) return null;

    var h = d.hourly;
    var t = openMeteoHourlyValue(h.temperature_2m, idx);
    var windKmh = openMeteoHourlyValue(h.wind_speed_10m, idx);
    var gustKmh = openMeteoHourlyValue(h.windgusts_10m, idx);
    var wd = openMeteoHourlyValue(h.wind_direction_10m, idx);
    var p = openMeteoHourlyValue(h.surface_pressure, idx);
    var c = openMeteoHourlyValue(h.cloud_cover, idx);
    var wc = openMeteoHourlyValue(h.weather_code, idx);
    var pr = openMeteoHourlyValue(h.precipitation, idx);

    return {
      temp:       t != null ? Math.round(t * 10) / 10 : null,
      wind_mph:   windKmh != null ? Math.round(windKmh * 0.621) : null,
      gust_mph:   gustKmh != null ? Math.round(gustKmh * 0.621) : null,
      wind_dir:   wd,
      pressure:   p != null ? Math.round(p) : null,
      cloud:      c,
      code:       wc,
      precip_mm:  pr,
      fetched_at: diaryNow().toISOString()
    };
  } catch (e) {
    console.warn('Weather fetch failed:', e);
    return null;
  }
}
