// First Light — modules/activity-engine.mjs
//
// Deer-activity scoring engine: moon phase, rut calendar, seasonal
// weighting, weather scoring, solunar windows, and 7-day Open-Meteo
// forecast fetcher. The implementations are byte-for-byte copies of
// the originals in app.js (getMoonPhase ~L1069, fetch7DayWeather ~L2086,
// scoreDay ~L2106, hourlyActivityScore ~L2236, RUT_CALENDAR ~L2725,
// getSolunar ~L2812, windDirArrow ~L2225) so the planner's per-slot
// scores match the home page banner badge for any (date, lat, lng).
//
// One intentional change vs app.js: scoreDay() and hourlyActivityScore()
// take (lat, lng) as explicit args rather than reading bannerState.
// app.js retains its bannerState-using copies; the planner has no banner
// state of its own. A future cleanup PR can collapse the duplication —
// see PLAN §3 — but that needs a browser-side parity test we can't run
// here.

import { calcSunTime, toMinutes, fmtMins, inWindow } from './sun-times.mjs';

// ── Rut calendar ──────────────────────────────────────────────
// Peak activity boost per species per month (0=none, 30=peak)
// Species columns: [Red, Fallow, Sika, Roe, CWD]
// Sources: BDS, BASC, Deer Initiative; Sika Oct/Nov shaped to Scotland
// Wild Deer BPG (peak rutting mid Sep–end Oct) + BDS regional late-rut
// notes (activity into Nov).
export const RUT_SPECIES = ['Red', 'Fallow', 'Sika', 'Roe', 'CWD'];
export const RUT_CALENDAR = {
  1:  [0,  0,  0,  0,  15],
  2:  [0,  0,  0,  0,  5 ],
  3:  [0,  0,  0,  0,  0 ],
  4:  [0,  0,  0,  0,  0 ],
  5:  [0,  0,  0,  5,  0 ],
  6:  [0,  0,  0,  15, 0 ],
  7:  [0,  0,  0,  30, 0 ],
  8:  [5,  0,  0,  20, 0 ],
  9:  [20, 5,  5,  0,  0 ],
  10: [30, 30, 30, 0,  0 ],
  11: [15, 20, 15, 0,  20],
  12: [0,  5,  15, 0,  30],
};

// ── Moon phase ────────────────────────────────────────────────
export function getMoonPhase(date) {
  const known = new Date(2000, 0, 6, 18, 14, 0);
  const synodicMonth = 29.530588853;
  const diff = (date - known) / 86400000;
  const age  = ((diff % synodicMonth) + synodicMonth) % synodicMonth;
  const pct  = age / synodicMonth;
  const name = age < 1.85   ? 'New Moon'
             : age < 7.38   ? 'Waxing Crescent'
             : age < 9.22   ? 'First Quarter'
             : age < 14.77  ? 'Waxing Gibbous'
             : age < 16.61  ? 'Full Moon'
             : age < 22.15  ? 'Waning Gibbous'
             : age < 23.99  ? 'Last Quarter'
             : age < 29.53  ? 'Waning Crescent'
             :                'New Moon';
  const icon = age < 1.85   ? '🌑'
             : age < 7.38   ? '🌒'
             : age < 9.22   ? '🌓'
             : age < 14.77  ? '🌔'
             : age < 16.61  ? '🌕'
             : age < 22.15  ? '🌖'
             : age < 23.99  ? '🌗'
             : age < 29.53  ? '🌘'
             :                '🌑';
  return {
    age,
    pct,
    name,
    icon,
    illumination: Math.round((1 - Math.cos(age / synodicMonth * 2 * Math.PI)) / 2 * 100)
  };
}

// ── Solunar windows ───────────────────────────────────────────
// Based on gravitational pull theory (Knight 1936, supported by
// Demarais et al). Returns four ranges in minutes-since-UK-midnight.
export function getSolunar(date, lat, lng) {
  const moon = getMoonPhase(date);
  const SHIFT_PER_DAY = 50; // minutes per day
  const transitMin    = (12 * 60 + moon.age * SHIFT_PER_DAY) % (24 * 60);
  const underfootMin  = (transitMin + 12 * 60 + 25) % (24 * 60);
  const minor1 = (transitMin   + 6 * 60 + 12) % (24 * 60);
  const minor2 = (underfootMin + 6 * 60 + 12) % (24 * 60);
  return {
    major1: { start: (transitMin   - 60 + 1440) % 1440, peak: transitMin,   end: (transitMin   + 60) % 1440 },
    major2: { start: (underfootMin - 60 + 1440) % 1440, peak: underfootMin, end: (underfootMin + 60) % 1440 },
    minor1: { start: (minor1 - 30 + 1440) % 1440, peak: minor1, end: (minor1 + 30) % 1440 },
    minor2: { start: (minor2 - 30 + 1440) % 1440, peak: minor2, end: (minor2 + 30) % 1440 }
  };
}

// ── Wind direction display ────────────────────────────────────
export function windDirArrow(deg) {
  const cardinals = ['N','NE','E','SE','S','SW','W','NW'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  const cardinal = cardinals[idx];
  const rotDeg = idx * 45;
  // Wind direction = where wind comes FROM — arrow points where wind goes TO
  const displayDeg = (rotDeg + 180) % 360;
  return '<span style="display:inline-block;transform:rotate(' + displayDeg + 'deg);line-height:1;font-style:normal;">↑︎</span> ' + cardinal;
}

// ── 7-day forecast fetch (Promise + 20-min cache) ──────────────
// Same Open-Meteo URL as app.js fetch7DayWeather; the cache is
// per-module so a stand-planner fetch won't pollute the app.js
// home-page cache and vice versa. Diary and home page can both
// be open at once without race.
const _wfCache = { data: null, ts: 0, lat: null, lng: null };

export function fetch7DayForecast(lat, lng) {
  const now = Date.now();
  if (_wfCache.data
      && (now - _wfCache.ts < 20 * 60 * 1000)
      && _wfCache.lat === lat
      && _wfCache.lng === lng) {
    return Promise.resolve(_wfCache.data);
  }
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat
    + '&longitude=' + lng
    + '&daily=temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,precipitation_sum,weather_code,surface_pressure_mean'
    + '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,windgusts_10m,precipitation_probability,precipitation,weather_code,cloud_cover,surface_pressure'
    + '&forecast_days=7&timezone=auto';
  return fetch(url)
    .then(r => r.json())
    .then(d => {
      _wfCache.data = d;
      _wfCache.ts = Date.now();
      _wfCache.lat = lat;
      _wfCache.lng = lng;
      return d;
    });
}

// ── Per-day score (dawn + dusk) ───────────────────────────────
// `wxDay` shape (matches the unpacking app.js does after fetch7DayWeather):
//   { tempMax, tempMin, windMax (km/h), gustMax (km/h), precip (mm),
//     pressure (hPa), prevPressure (hPa optional) }
export function scoreDay(date, lat, lng, wxDay) {
  let sr, ss;
  try { sr = calcSunTime(date, lat, lng, true);  } catch(e) { sr = null; }
  try { ss = calcSunTime(date, lat, lng, false); } catch(e) { ss = null; }
  if (!sr || !ss) return null;

  const srMin = toMinutes(sr);
  const ssMin = toMinutes(ss);
  const dawnStart = srMin - 60;
  const duskStart = ssMin - 90;

  const moon = getMoonPhase(date);
  const month = date.getMonth() + 1;

  const mb = moon.illumination < 15 ? 8
           : moon.illumination < 40 ? 6
           : moon.illumination < 60 ? 4
           : moon.illumination < 85 ? 2 : 1;

  const rutMonths = RUT_CALENDAR[month] || [0,0,0,0,0];
  const maxRut = Math.max.apply(null, rutMonths);
  const rutScore = maxRut >= 25 ? 15 : maxRut >= 10 ? 8 : maxRut > 0 ? 3 : 0;

  const sb = month === 2 ? 5 : month === 3 ? 3
           : (month === 9 || month === 10) ? 4
           : month === 11 ? 2
           : (month >= 6 && month <= 8) ? -3 : 0;

  let wxScore = 0;
  if (wxDay) {
    const avgTemp = (wxDay.tempMax + wxDay.tempMin) / 2;
    const baseTemp = avgTemp <= 0 ? 4 : avgTemp <= 8 ? 6 : avgTemp <= 14 ? 3 : avgTemp <= 18 ? 0 : -3;
    const frostBonusD = wxDay.tempMin < -1 ? 4 : wxDay.tempMin <= 0 ? 2 : 0;
    wxScore += baseTemp + frostBonusD;
    const windMaxMph1 = wxDay.windMax * 0.621;
    wxScore += windMaxMph1 < 8 ? 6 : windMaxMph1 < 20 ? 3 : windMaxMph1 < 35 ? -2 : -5;
    if (wxDay.gustMax && wxDay.windMax > 2) {
      const dailyGustRatio = (wxDay.gustMax - wxDay.windMax) / wxDay.windMax;
      wxScore += dailyGustRatio > 0.8 ? -4
              : dailyGustRatio > 0.5  ? -2
              : dailyGustRatio > 0.3  ? -1
              : dailyGustRatio <= 0.15 ? 1 : 0;
    }
    wxScore += wxDay.precip > 5 ? -4 : wxDay.precip > 0.5 ? 2 : 1;
    if (wxDay.pressure !== null && wxDay.pressure !== undefined) {
      const prevPressure = (wxDay.prevPressure !== undefined) ? wxDay.prevPressure : wxDay.pressure;
      const pressureDelta = wxDay.pressure - prevPressure;
      wxScore += pressureDelta < -1 ? 4 : pressureDelta < 0 ? 2 : pressureDelta > 1 ? 0 : 1;
    }
  }

  const dawnScore = Math.min(100, Math.max(0, 40 + mb + rutScore + sb + wxScore));
  let duskScore   = Math.min(100, Math.max(0, 40 + mb + rutScore + sb + wxScore));
  duskScore = Math.min(100, Math.max(0, duskScore + (wxDay && (wxDay.windMax * 0.621) > 20 ? -3 : 2)));

  return {
    dawnScore,
    duskScore,
    bestScore: Math.max(dawnScore, duskScore),
    bestWindow: dawnScore >= duskScore ? 'Dawn' : 'Dusk',
    dawnTime: fmtMins(dawnStart),
    duskTime: fmtMins(duskStart),
    moon,
    wxDay
  };
}

// ── Per-hour score ────────────────────────────────────────────
// `wxHour` shape (matches what app.js buildHourlyPanel unpacks):
//   { temp, wind (km/h), gustRatio, postRain, precip (mm) }
export function hourlyActivityScore(hour, date, lat, lng, wxHour) {
  const sr = calcSunTime(date, lat, lng, true);
  const ss = calcSunTime(date, lat, lng, false);
  const srMin = sr ? toMinutes(sr) : 6 * 60;
  const ssMin = ss ? toMinutes(ss) : 20 * 60;
  const dawnStart = srMin - 60, dawnEnd = srMin + 120;
  const duskStart = ssMin - 90, duskEnd = ssMin + 45;
  const moon = getMoonPhase(date);
  const month = date.getMonth() + 1;
  let score = 0;

  if (hour >= dawnStart/60 && hour <= dawnEnd/60)       score += 40;
  else if (hour >= duskStart/60 && hour <= duskEnd/60)  score += 40;
  else if (hour >= dawnEnd/60 && hour <= duskStart/60)  score += 8;
  else score += 8;

  const mb = moon.illumination < 15 ? 8 : moon.illumination < 40 ? 6
           : moon.illumination < 60 ? 4 : moon.illumination < 85 ? 2 : 1;
  const isNight = !(hour >= dawnStart/60 && hour <= duskEnd/60);
  score += isNight ? Math.round(mb * 0.3) : mb;

  const rutM = RUT_CALENDAR[month] || [0,0,0,0,0];
  const maxRut = Math.max.apply(null, rutM);
  score += maxRut >= 25 ? 15 : maxRut >= 10 ? 8 : maxRut > 0 ? 3 : 0;

  score += month === 2 ? 5 : month === 3 ? 3
         : (month === 9 || month === 10) ? 4 : month === 11 ? 2
         : (month >= 6 && month <= 8) ? -3 : 0;

  const sol = getSolunar(date, lat, lng);
  const hourMin = hour * 60;
  const inMajorH = inWindow(hourMin, sol.major1.start, sol.major1.end) ||
                   inWindow(hourMin, sol.major2.start, sol.major2.end);
  const inMinorH = inWindow(hourMin, sol.minor1.start, sol.minor1.end) ||
                   inWindow(hourMin, sol.minor2.start, sol.minor2.end);
  if (inMajorH)      score += 3;
  else if (inMinorH) score += 1;

  if (wxHour) {
    const t = wxHour.temp;
    const tBase = t<=0 ? 4 : t<=8 ? 6 : t<=14 ? 3 : t<=18 ? 0 : -3;
    const tFrost = (t <= 0) ? 3 : (t <= 1) ? 1 : 0;
    score += tBase + tFrost;
    const wkm = wxHour.wind * 0.621;
    score += wkm<=8 ? 6 : wkm<=20 ? 3 : wkm<=35 ? -2 : -5;
    if (wxHour.gustRatio !== undefined && wkm > 5) {
      score += wxHour.gustRatio > 0.8 ? -4
             : wxHour.gustRatio > 0.5 ? -2
             : wxHour.gustRatio > 0.3 ? -1
             : wxHour.gustRatio <= 0.15 ? 1 : 0;
    }
    if (wxHour.postRain)          score += 4;
    else if (wxHour.precip > 5)   score += -4;
    else if (wxHour.precip > 0.5) score += 2;
    else                          score += 1;
  }

  return Math.min(100, Math.max(0, score));
}

// ── Open-Meteo unpacker for a specific (dayIdx, hour) ─────────
// Convenience helper — converts the raw API JSON to the wxHour
// shape hourlyActivityScore() expects. dayIdx 0-6, hour 0-23.
export function unpackHourly(forecast, dayIdx, hour) {
  if (!forecast || !forecast.hourly) return null;
  const hIdx = dayIdx * 24 + hour;
  const h = forecast.hourly;
  if (!h.temperature_2m || hIdx >= h.temperature_2m.length) return null;
  const wind = h.wind_speed_10m ? h.wind_speed_10m[hIdx] : null;
  const gust = h.windgusts_10m  ? h.windgusts_10m[hIdx]  : null;
  const gustRatio = (wind > 2 && gust) ? (gust - wind) / wind : 0;
  const precipNow  = h.precipitation ? (h.precipitation[hIdx] || 0) : 0;
  const precip1ago = h.precipitation ? (h.precipitation[Math.max(0, hIdx - 1)] || 0) : 0;
  const precip2ago = h.precipitation ? (h.precipitation[Math.max(0, hIdx - 2)] || 0) : 0;
  const recentRain = Math.max(precip1ago, precip2ago);
  const postRain = (precipNow < 0.1) && (recentRain > 0.5);
  return {
    temp: h.temperature_2m[hIdx],
    wind,                                   // km/h (raw Open-Meteo)
    windDeg: h.wind_direction_10m ? h.wind_direction_10m[hIdx] : null,
    gust,
    gustRatio,
    precip: precipNow,
    postRain,
    cloudCover: h.cloud_cover ? h.cloud_cover[hIdx] : null,
    weatherCode: h.weather_code ? h.weather_code[hIdx] : null
  };
}

// ── Open-Meteo unpacker for a specific dayIdx ─────────────────
export function unpackDaily(forecast, dayIdx) {
  if (!forecast || !forecast.daily) return null;
  const d = forecast.daily;
  if (!d.temperature_2m_max || dayIdx >= d.temperature_2m_max.length) return null;
  return {
    tempMax:  d.temperature_2m_max[dayIdx],
    tempMin:  d.temperature_2m_min[dayIdx],
    windMax:  d.wind_speed_10m_max  ? d.wind_speed_10m_max[dayIdx]  : null,
    gustMax:  d.wind_gusts_10m_max  ? d.wind_gusts_10m_max[dayIdx]  : null,
    precip:   d.precipitation_sum   ? d.precipitation_sum[dayIdx]   : 0,
    pressure: d.surface_pressure_mean ? d.surface_pressure_mean[dayIdx] : null,
    prevPressure: (dayIdx > 0 && d.surface_pressure_mean)
      ? d.surface_pressure_mean[dayIdx - 1]
      : null,
    weatherCode: d.weather_code ? d.weather_code[dayIdx] : null
  };
}
