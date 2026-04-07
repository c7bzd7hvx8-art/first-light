/* First Light — App v2.0 */

// ── block ──

// ─────────────────────────────────────────────────────────────
// FIRST LIGHT — Core JS  (refactored)
// Items addressed: 1,2,3,4,5,6,7,8,9,10,11,12
// ─────────────────────────────────────────────────────────────

// ── 10: UI namespace ─────────────────────────────────────────
window.ui = window.ui || {};

// ── 4: Centralised banner state ──────────────────────────────
window.bannerState = {
  sunriseMin:      null,
  sunsetMin:       null,
  legalStartMin:   null,
  legalEndMin:     null,
  isLegal:         false,
  isTwilight:      false,
  nextLegalStartMin: null,
  lat:             null,
  lng:             null,
  locationName:    ''
};

// ── 9: SVG constants (extracted from inline strings) ─────────
var HUNTER_SVG = (function() {
  var tmpl = document.getElementById('tpl-hunter'); // legacy ref
  return tmpl ? { awake: tmpl.dataset.awake, asleep: tmpl.dataset.asleep } : { awake: '', asleep: '' };
}());

// ── 11: Persist/restore user state ───────────────────────────
ui.saveState = function() {
  try {
    var s = { tab: window._activeTab || 'species' };
    if (bannerState.lat !== null) {
      s.lat  = bannerState.lat;
      s.lng  = bannerState.lng;
      s.name = bannerState.locationName;
    }
    localStorage.setItem('fl_state', JSON.stringify(s));
  } catch(e) {}
};

ui.loadState = function() {
  try {
    var raw = localStorage.getItem('fl_state');
    if (!raw) return null;
    var s = JSON.parse(raw);
    // Validate saved state has required fields
    if (!s || typeof s.lat !== 'number' || typeof s.lng !== 'number') {
      localStorage.removeItem('fl_state');
      return null;
    }
    return s;
  } catch(e) { return null; }
};

// ── 8: Offline indicator ─────────────────────────────────────
ui.updateOfflineBanner = function() {
  var el = document.getElementById('offline-banner');
  if (!el) return;
  el.style.display = navigator.onLine ? 'none' : 'block';
};
window.addEventListener('online',  ui.updateOfflineBanner);
window.addEventListener('offline', ui.updateOfflineBanner);

// Clock (top-right)

// Season helper
function inSeason(month, day, startMonth, startDay, endMonth, endDay) {
  var cur   = month * 100 + day;
  var start = startMonth * 100 + startDay;
  var end   = endMonth   * 100 + endDay;
  return start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
}

function setStatus(elId, open) {
  var el = document.getElementById(elId);
  if (!el) return;
  el.textContent = '';
  el.className   = 'season-status ' + (open ? 'status-open' : 'status-closed');
}

// ── Solar calculation ─────────────────────────────────────────
function calcSunTime(date, lat, lng, isSunrise) {
  var rad = Math.PI / 180;
  var lngHour = lng / 15;
  var dayOfYear = (function() {
    var start = new Date(date.getFullYear(), 0, 0);
    var diff  = date - start;
    return Math.floor(diff / 86400000);
  }());
  var t = isSunrise ? dayOfYear + (6  - lngHour) / 24
                    : dayOfYear + (18 - lngHour) / 24;
  var M = (0.9856 * t) - 3.289;
  var L = M + (1.916 * Math.sin(M * rad)) + (0.020 * Math.sin(2 * M * rad)) + 282.634;
  L = ((L % 360) + 360) % 360;
  var RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
  RA = ((RA % 360) + 360) % 360;
  var Lquad  = Math.floor(L  / 90) * 90;
  var RAquad = Math.floor(RA / 90) * 90;
  RA = (RA + Lquad - RAquad) / 15;
  var sinDec = 0.39782 * Math.sin(L * rad);
  var cosDec = Math.cos(Math.asin(sinDec));
  var cosH   = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return null;
  var H = isSunrise ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad;
  H /= 15;
  var T = H + RA - (0.06571 * t) - 6.622;
  var UT = ((T - lngHour) % 24 + 24) % 24;
  // UT is in UTC — convert to local time using the date's actual UTC offset
  // This correctly handles BST/GMT and any DST transition
  var utcMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
            + UT * 3600000;
  var result = new Date(utcMs);
  return result;
}

// ── 2: Midnight-safe window helper ───────────────────────────
function inWindow(cur, start, end) {
  // All values in minutes-since-midnight (0–1439)
  // Handles windows that cross midnight (end < start)
  if (start <= end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;           // crosses midnight
}

// Always extract hours/minutes in Europe/London time, regardless of device timezone
// This ensures all sunrise/sunset/legal times display correctly for users outside the UK
function ukHourMin(dateObj) {
  var parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(dateObj);
  return {
    h: parseInt(parts.find(function(p) { return p.type === 'hour';   }).value, 10),
    m: parseInt(parts.find(function(p) { return p.type === 'minute'; }).value, 10)
  };
}

function toMinutes(dateObj) {
  var hm = ukHourMin(dateObj);
  return hm.h * 60 + hm.m;
}

// UK current time in minutes-since-midnight
function ukNowMin() {
  var hm = ukHourMin(new Date());
  return hm.h * 60 + hm.m;
}

// UK current hour (for weather API array indexing — API uses timezone=auto=Europe/London)
function ukNowHour() {
  return ukHourMin(new Date()).h;
}

function fmtTime(h, m) {
  return h.toString().padStart(2,'0') + ':' + m.toString().padStart(2,'0');
}

function fmtMinutes(totalMin) {
  var m = ((totalMin % 1440) + 1440) % 1440;
  return fmtTime(Math.floor(m / 60), m % 60);
}

function addMins(dateObj, mins) {
  return new Date(dateObj.getTime() + mins * 60000);
}

// ── 4 + 12: Update centralised bannerState ────────────────────
function computeBannerState(lat, lng, locationName) {
  var now       = new Date();
  var sunrise   = calcSunTime(now, lat, lng, true);
  var sunset    = calcSunTime(now, lat, lng, false);
  if (!sunrise || !sunset) return false;

  var legalStart = addMins(sunrise, -60);
  var legalEnd   = addMins(sunset,   60);

  var lsMin = toMinutes(legalStart);
  var leMin = toMinutes(legalEnd);
  var srMin = toMinutes(sunrise);
  var ssMin = toMinutes(sunset);
  var curMin = ukNowMin();

  var isLegal    = inWindow(curMin, lsMin, leMin);
  var isTwilight = isLegal && (!inWindow(curMin, srMin, ssMin));

  // Next legal start: tomorrow's legal start if we're past today's end
  var tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  var srTom = calcSunTime(tomorrow, lat, lng, true);
  var nextLegalStartMin = srTom ? toMinutes(addMins(srTom, -60)) : lsMin;
  // Express tomorrow's minutes as >1440 for countdown arithmetic when needed
  var nextLsAbsolute = (inWindow(curMin, lsMin, leMin) || curMin < lsMin)
    ? lsMin
    : nextLegalStartMin + 1440;  // next calendar day

  // Store
  bannerState.sunriseMin      = srMin;
  bannerState.sunsetMin       = ssMin;
  bannerState.legalStartMin   = lsMin;
  bannerState.legalEndMin     = leMin;
  bannerState.isLegal         = isLegal;
  bannerState.isTwilight      = isTwilight;
  bannerState.nextLegalStartMin = nextLsAbsolute;
  bannerState.lat             = lat;
  bannerState.lng             = lng;
  bannerState.locationName    = locationName;
  bannerState._sunrise        = sunrise;
  bannerState._sunset         = sunset;
  bannerState._legalStart     = legalStart;
  bannerState._legalEnd       = legalEnd;

  return true;
}

// ── 6: Per-minute recalculation ───────────────────────────────
var _lastSolarMinute = -1;
var _lastDateStr = '';

function maybeRecalcSolar() {
  var nowMin = ukNowMin();
  if (nowMin === _lastSolarMinute) return;
  _lastSolarMinute = nowMin;

  // Check if date has changed (midnight rollover)
  var now = new Date();
  var todayStr = now.getFullYear() + '-' + (now.getMonth()+1) + '-' + now.getDate();
  if (_lastDateStr && todayStr !== _lastDateStr) {
    // Date changed — refresh date display, seasons, calendar
    var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var bday   = document.getElementById('banner-date-day');
    var bnum   = document.getElementById('banner-date-num');
    var bmonth = document.getElementById('banner-date-month');
    var byear  = document.getElementById('banner-date-year');
    if (bday)   bday.textContent   = dayNames[now.getDay()];
    if (bnum)   bnum.textContent   = now.getDate();
    if (bmonth) bmonth.textContent = monthNames[now.getMonth()];
    if (byear)  byear.textContent  = now.getFullYear();
    updateSeasonStatuses();
    highlightTodayMonth();
    initCalendar();
  }
  _lastDateStr = todayStr;

  if (bannerState.lat !== null) {
    computeBannerState(bannerState.lat, bannerState.lng, bannerState.locationName);
    renderBanner();
    updateForecastIfVisible();
  }
}

// ── Banner rendering ─────────────────────────────────────────
function renderBanner() {
  var bs = bannerState;
  if (!bs._sunrise) return;

  var isLegal    = bs.isLegal;
  var isTwilight = bs.isTwilight;

  // Update banner background class
  var banner = document.getElementById('legal-banner');
  if (banner) {
    banner.className = 'legal-banner ' + (isLegal ? (isTwilight ? 'twilight' : 'legal') : 'illegal');
  }

  // Status label
  var lbl = document.getElementById('banner-label');
  if (lbl) {
    lbl.textContent = isLegal ? (isTwilight ? 'Twilight' : 'Legal to Shoot') : 'Illegal to Shoot';
    lbl.className   = 'status-label ' + (isLegal ? (isTwilight ? 'status-twilight' : 'status-legal') : 'status-illegal');
  }
  var sub = document.getElementById('banner-sublabel');
  if (sub) sub.textContent = isLegal ? 'Within legal hours' : 'Outside legal hours';

  // Remove tap hint — location is set, status block not tappable
  var sb = document.getElementById('banner-status-block');
  if (sb) sb.style.cursor = 'default';

  // Times — use actual IDs from HTML
  var srEl = document.getElementById('sunrise-time');
  var ssEl = document.getElementById('sunset-time');
  var lsEl = document.getElementById('legal-start-time');
  var leEl = document.getElementById('legal-end-time');
  if (srEl) srEl.textContent = fmtMinutes(bs.sunriseMin);
  if (ssEl) ssEl.textContent = fmtMinutes(bs.sunsetMin);
  if (lsEl) lsEl.textContent = 'Legal: ' + fmtMinutes(bs.legalStartMin);
  if (leEl) leEl.textContent = 'Legal: ' + fmtMinutes(bs.legalEndMin);

  // Hunter icon (item 9: stored in template)
  var iconEl = document.getElementById('banner-icon');
  if (iconEl) {
    var awakeEl = document.getElementById('hunter-awake');
    var asleepEl = document.getElementById('hunter-asleep');
    if (awakeEl && asleepEl) iconEl.innerHTML = isLegal ? awakeEl.innerHTML : asleepEl.innerHTML;
  }

  // Countdown visibility
  var cdEl = document.getElementById('banner-countdown');
  if (cdEl) cdEl.style.display = 'inline';

  // Sun arc
  drawSunArc(bs.sunriseMin, bs.sunsetMin, bs.legalStartMin, bs.legalEndMin);

  // Location label
  var locEl = document.getElementById('banner-location-text');
  if (locEl && bs.locationName) locEl.textContent = '📍 ' + bs.locationName;

  // Today at a glance
  renderTodayGlance();
}

// ── Sun arc ───────────────────────────────────────────────────
function drawSunArc(srMin, ssMin, lsMin, leMin) {
  var svg = document.getElementById('sun-arc-svg');
  if (!svg) return;
  var now    = new Date();
  var curMin = ukNowMin();

  // Map minute (0-1439) to position along the arc path
  // Arc goes from x=10 (left) to x=190 (right) across viewBox 0 0 200 50
  // Parametric: t = min/1440, point on quadratic bezier M10,45 Q100,-10 190,45
  function arcPoint(min) {
    var t  = min / 1440;
    var t1 = 1 - t;
    // Quadratic bezier: P = (1-t)^2 * P0 + 2(1-t)t * P1 + t^2 * P2
    var x = t1*t1*10  + 2*t1*t*100 + t*t*190;
    var y = t1*t1*45  + 2*t1*t*(-10) + t*t*45;
    return { x: x, y: y };
  }

  var sunPt = arcPoint(curMin);
  var lsPt  = arcPoint(lsMin);
  var lePt  = arcPoint(leMin);

  // Update sun dot position
  var sunDot = document.getElementById('sun-dot');
  if (sunDot) {
    sunDot.setAttribute('cx', sunPt.x.toFixed(1));
    sunDot.setAttribute('cy', sunPt.y.toFixed(1));
    sunDot.setAttribute('fill', bannerState.isLegal ? '#f5c842' : '#888888');
  }

  // Update legal window highlight arc (simplified as a straight path between endpoints)
  var arcLegal = document.getElementById('arc-legal');
  if (arcLegal) {
    arcLegal.setAttribute('d', 'M ' + lsPt.x.toFixed(1) + ' ' + lsPt.y.toFixed(1) +
                               ' Q 100 -10 ' + lePt.x.toFixed(1) + ' ' + lePt.y.toFixed(1));
    arcLegal.setAttribute('stroke', 'rgba(100,220,80,0.45)');
    arcLegal.setAttribute('stroke-width', '3');
  }
}

// ── 5: Per-second countdown (only update DOM when value changes) ──
var _lastCountdownText = '';
var _lastCountdownClass = '';

function updateBannerClock() {
  var bs = bannerState;
  if (bs.legalStartMin === null) return;

  var now    = new Date();
  var curMin = ukNowMin();
  var curSec = now.getSeconds();
  var curTotalSec = curMin * 60 + curSec;
  var el     = document.getElementById('banner-countdown');
  if (!el) return;

  var isLegal = bs.isLegal;

  var totalSec, label, diffMin;
  if (isLegal) {
    label = 'Time remaining';
    var legalEndTotalSec = bs.legalEndMin * 60;
    // If legal end is past midnight and current time is before midnight, add 86400
    totalSec = legalEndTotalSec - curTotalSec;
    if (totalSec < 0) totalSec += 86400;
    diffMin = Math.floor(totalSec / 60);
  } else {
    var rawTarget = bs.nextLegalStartMin;
    var nowTotalMin = curMin;
    var diffMin, totalSec;
    if (rawTarget > 1440) {
      diffMin = rawTarget - nowTotalMin;
    } else {
      diffMin = rawTarget > nowTotalMin ? rawTarget - nowTotalMin : (1440 - nowTotalMin + rawTarget);
    }
    // Use total seconds for precision — avoids minute-boundary wraparound
    var targetTotalSec = diffMin * 60;
    totalSec = targetTotalSec - curSec;
    if (totalSec < 0) totalSec += 86400;
    label = 'Legal window opens in';
  }

  var hh = Math.floor(totalSec / 3600);
  var mm = Math.floor((totalSec % 3600) / 60);
  var ss = totalSec % 60;
  var txt = label + ': ' + hh.toString().padStart(2,'0') + ':' + mm.toString().padStart(2,'0') + ':' + ss.toString().padStart(2,'0');

  // Colour thresholds
  var cls = isLegal
    ? (diffMin < 15  ? 'countdown-red'
     : diffMin < 60  ? 'countdown-amber'
     :                  'countdown-green')
    : 'countdown-dim';

  // ── 5: only write DOM if changed ──
  if (txt !== _lastCountdownText) {
    el.textContent = txt;
    _lastCountdownText = txt;
  }
  if (cls !== _lastCountdownClass) {
    el.className = cls;
    _lastCountdownClass = cls;
  }
}

// ── Moon ─────────────────────────────────────────────────────
function getMoonPhase(date) {
  var known = new Date(2000, 0, 6, 18, 14, 0);
  var synodicMonth = 29.530588853;
  var diff = (date - known) / 86400000;
  var age  = ((diff % synodicMonth) + synodicMonth) % synodicMonth;
  var pct  = age / synodicMonth;
  var name = age < 1.85   ? 'New Moon'
           : age < 7.38   ? 'Waxing Crescent'
           : age < 9.22   ? 'First Quarter'
           : age < 14.77  ? 'Waxing Gibbous'
           : age < 16.61  ? 'Full Moon'
           : age < 22.15  ? 'Waning Gibbous'
           : age < 23.99  ? 'Last Quarter'
           : age < 29.53  ? 'Waning Crescent'
           :                'New Moon';
  var icon = age < 1.85   ? '🌑'
           : age < 7.38   ? '🌒'
           : age < 9.22   ? '🌓'
           : age < 14.77  ? '🌔'
           : age < 16.61  ? '🌕'
           : age < 22.15  ? '🌖'
           : age < 23.99  ? '🌗'
           : age < 29.53  ? '🌘'
           :                '🌑';
  return { age: age, pct: pct, name: name, icon: icon, illumination: Math.round((1 - Math.cos(age / synodicMonth * 2 * Math.PI)) / 2 * 100) };
}

function drawMoonSVG(age) {
  var svg = document.getElementById('moon-svg');
  if (!svg) return;
  var cycle = 29.530588853;
  var phase = age / cycle;          // 0 = new, 0.5 = full, 1 = new
  var r = 11, cx = 13, cy = 13;
  var dark = '#1a1a2e', lit = '#fffacd';

  // Always start with the dark disc
  var html = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + dark + '"/>';

  if (phase >= 0.02 && phase <= 0.98) {
    // x-radius of the terminator ellipse:
    //   at new/full moon → r (fully lit or fully dark half)
    //   at quarters → 0 (straight edge)
    var tx = Math.abs(Math.cos(phase * 2 * Math.PI)) * r;
    var top = cx + ',' + (cy - r);
    var bot = cx + ',' + (cy + r);

    var litPath, darkPath;
    if (phase < 0.5) {
      // Waxing: right side lit
      if (phase < 0.25) {
        // Crescent: thin right sliver
        litPath  = 'M' + top + ' A' + r + ',' + r + ' 0 0,1 ' + bot + ' A' + tx + ',' + r + ' 0 0,0 ' + top + ' Z';
      } else {
        // Gibbous: most lit, thin dark left sliver
        litPath  = 'M' + top + ' A' + r + ',' + r + ' 0 0,1 ' + bot + ' A' + tx + ',' + r + ' 0 0,1 ' + top + ' Z';
      }
    } else {
      // Waning: left side lit
      if (phase < 0.75) {
        // Gibbous: most lit, thin dark right sliver
        litPath  = 'M' + top + ' A' + r + ',' + r + ' 0 0,0 ' + bot + ' A' + tx + ',' + r + ' 0 0,0 ' + top + ' Z';
      } else {
        // Crescent: thin left sliver
        litPath  = 'M' + top + ' A' + r + ',' + r + ' 0 0,0 ' + bot + ' A' + tx + ',' + r + ' 0 0,1 ' + top + ' Z';
      }
    }
    html += '<path d="' + litPath + '" fill="' + lit + '"/>';
  }

  // Rim
  html += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="rgba(255,255,200,0.2)" stroke-width="0.8"/>';
  svg.innerHTML = html;
}

function updateMoon() {
  var moon = getMoonPhase(new Date());
  drawMoonSVG(moon.age);
  var nameEl = document.getElementById('moon-phase-name');
  var illEl  = document.getElementById('moon-illumination');
  if (nameEl) nameEl.textContent = moon.name;
  if (illEl)  illEl.textContent  = moon.illumination + '% lit';

  // Show quick activity score on badge — with or without weather
  var badge = document.getElementById('activity-score-badge');
  if (badge && bannerState.lat !== null) {
    var cachedWx = (_weatherCache && _weatherCache.data && _weatherCache.lat === bannerState.lat) ? _weatherCache.data : null;
    var quick = getDeerActivityScore(cachedWx);
    badge.textContent = '🦌 ' + quick.score + '%';
    badge.style.display = 'block';
  }
}

// ── Calendar highlight ────────────────────────────────────────
function highlightTodayMonth() {
  var m = new Date().getMonth() + 1;
  document.querySelectorAll('.month-cell[data-month="' + m + '"]').forEach(function(el) {
    el.classList.add('month-today');
  });
}

// ── Calendar tab rendering ────────────────────────────────────
function buildCalendarCards(selector, isScotland) {
  var months = ['J','F','M','A','M','J','J','A','S','O','N','D'];
  var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var now = new Date();
  var curMonth = now.getMonth() + 1;

  var badgeSpan = document.getElementById(isScotland ? 'cal-month-label-sc' : 'cal-month-label-ew');
  if (badgeSpan) badgeSpan.textContent = monthNames[curMonth-1] + ' ' + now.getFullYear() + ' — highlighted gold';

  document.querySelectorAll(selector).forEach(function(card) {
    var openMonths = card.dataset.open.split(',').map(Number);
    var sex = card.dataset.sex;
    var name = card.dataset.name;
    var dates = card.dataset.dates;
    var isOpen = openMonths.indexOf(curMonth) !== -1;
    var sexBadge = {
      stag: {bg:'rgba(139,90,43,0.25)',color:'#d4a870',label:'&#9794; Stag'},
      hind: {bg:'rgba(180,100,140,0.25)',color:'#e4a0c0',label:'&#9792; Hind'},
      buck: {bg:'rgba(100,140,80,0.25)',color:'#90c870',label:'&#9794; Buck'},
      doe:  {bg:'rgba(140,100,180,0.25)',color:'#c090e0',label:'&#9792; Doe'}
    }[sex] || {bg:'rgba(100,100,100,0.25)',color:'#aaa',label:'Both'};

    var html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;">';
    html += '<div style="display:flex;align-items:center;gap:8px;">';
    html += '<div style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;background:' + sexBadge.bg + ';color:' + sexBadge.color + ';">' + sexBadge.label + '</div>';
    html += '<div><div style="font-size:12px;font-weight:700;color:#ffffff;">' + name + '</div>';
    html += '<div style="font-size:10px;color:rgba(255,255,255,0.65);">' + dates + '</div></div></div>';
    html += '<div style="font-size:11px;font-weight:800;white-space:nowrap;color:' + (isOpen ? '#5aff5a' : '#ff6060') + ';">' + (isOpen ? '&#9679; OPEN' : '&#9679; CLOSED') + '</div></div>';

    html += '<div style="display:grid;grid-template-columns:repeat(12,1fr);gap:2px;margin-bottom:4px;">';
    for (var i = 1; i <= 12; i++) {
      var isOpenM = openMonths.indexOf(i) !== -1;
      var isToday = i === curMonth;
      var bg = isOpenM ? (isToday ? '#f0c040' : 'linear-gradient(90deg,#3abf3a,#7aef7a)') : 'rgba(255,255,255,0.14)';
      var outline = isToday ? 'outline:2.5px solid #f0c040;outline-offset:0;' : '';
      html += '<div style="height:10px;border-radius:3px;background:' + bg + ';' + outline + '"></div>';
    }
    html += '</div>';

    html += '<div style="display:grid;grid-template-columns:repeat(12,1fr);gap:2px;">';
    for (var j = 1; j <= 12; j++) {
      var col = j === curMonth ? '#f0c040' : 'rgba(255,255,255,0.6)';
      var fw = j === curMonth ? '800' : '600';
      html += '<div style="font-size:8px;color:' + col + ';text-align:center;font-weight:' + fw + ';">' + months[j-1] + '</div>';
    }
    html += '</div>';

    card.innerHTML = html;
  });

  var chipsEl = document.getElementById(isScotland ? 'cal-chips-sc' : 'cal-chips-ew');
  if (chipsEl) {
    chipsEl.textContent = '';
    document.querySelectorAll(selector).forEach(function(card) {
      var openMonths = card.dataset.open.split(',').map(Number);
      if (openMonths.indexOf(new Date().getMonth() + 1) !== -1) {
        var chip = document.createElement('div');
        var bgC = isScotland ? 'rgba(90,130,220,0.18)' : 'rgba(90,220,90,0.18)';
        var bdrC = isScotland ? 'rgba(90,130,220,0.35)' : 'rgba(90,220,90,0.35)';
        var txtC = isScotland ? '#9ab8ef' : '#7aff7a';
        chip.style.cssText = 'background:' + bgC + ';border:1px solid ' + bdrC + ';border-radius:20px;padding:4px 10px;font-size:11px;font-weight:700;color:' + txtC + ';';
        var sexLabel = {stag:'Stag',hind:'Hind',buck:'Buck',doe:'Doe'}[card.dataset.sex] || '';
        var chipName = card.dataset.name;
        // Only append sex label if name doesn't already end with it
        if (sexLabel && !chipName.endsWith(sexLabel)) chipName += ' ' + sexLabel;
        chip.textContent = chipName;
        chipsEl.appendChild(chip);
      }
    });
  }
}

function initCalendar() {
  buildCalendarCards('.cal-species-card', false);
  buildCalendarCards('.cal-species-card-sc', true);
}

// ── Public updateBanner (called by location picker, presets, GPS) ─
function updateBanner(lat, lng, locationName) {
  // ── 7: Accuracy warning shown by caller; store state ──
  var ok = computeBannerState(lat, lng, locationName);
  if (!ok) return;

  // Invalidate weather caches if location changed
  if (_weatherCache.lat !== null && (_weatherCache.lat !== lat || _weatherCache.lng !== lng)) {
    _weatherCache = { data: null, ts: 0, lat: null, lng: null };
  }
  if (_wfWeatherCache.lat !== null && (_wfWeatherCache.lat !== lat || _wfWeatherCache.lng !== lng)) {
    _wfWeatherCache = { data: null, ts: 0, lat: null, lng: null };
  }

  // Persist
  ui.saveState();

  renderBanner();

  // Refresh forecast if visible
  updateForecastIfVisible();

  // Update season statuses
  updateSeasonStatuses();
}

function updateForecastIfVisible() {
  var tbl = document.getElementById('forecast-table');
  if (tbl) buildForecast();
}

// ── Season statuses ───────────────────────────────────────────
function updateSeasonStatuses() {
  var now = new Date(), m = now.getMonth() + 1, d = now.getDate();
  var checks = [
    ['red-stag-en',    inSeason(m,d,8,1,4,30)],
    ['red-hind-en',    inSeason(m,d,11,1,3,31)],
    ['red-hind-sc',    inSeason(m,d,10,21,2,15)],
    ['fallow-buck-en', inSeason(m,d,8,1,4,30)],
    ['fallow-doe-en',  inSeason(m,d,11,1,3,31)],
    ['fallow-doe-sc',  inSeason(m,d,10,21,2,15)],
    ['roe-buck-en',    inSeason(m,d,4,1,10,31)],
    ['roe-buck-sc',    inSeason(m,d,4,1,10,20)],
    ['roe-doe-en',     inSeason(m,d,11,1,3,31)],
    ['roe-doe-sc',     inSeason(m,d,10,21,3,31)],
    ['sika-stag-en',   inSeason(m,d,8,1,4,30)],
    ['sika-hind-en',   inSeason(m,d,11,1,3,31)],
    ['sika-hind-sc',   inSeason(m,d,10,21,2,15)],
    ['muntjac-en',     true],
    ['cwd-buck-en',    inSeason(m,d,11,1,3,31)],
    ['cwd-doe-en',     inSeason(m,d,11,1,3,31)],
  ];
  checks.forEach(function(c) { setStatus(c[0], c[1]); });

  // Season badges on species cards
  var now2 = new Date();
  var m2 = now2.getMonth()+1, d2 = now2.getDate();
  // [badgeId, maleOpen, femaleOpen]
  var badgeData = [
    ['red-badge',     inSeason(m2,d2,8,1,4,30),  inSeason(m2,d2,11,1,3,31)],
    ['fallow-badge',  inSeason(m2,d2,8,1,4,30),  inSeason(m2,d2,11,1,3,31)],
    ['roe-badge',     inSeason(m2,d2,4,1,10,31),  inSeason(m2,d2,11,1,3,31)],
    ['sika-badge',    inSeason(m2,d2,8,1,4,30),  inSeason(m2,d2,11,1,3,31)],
    ['muntjac-badge', true,                        true],
    ['cwd-badge',     inSeason(m2,d2,11,1,3,31),  inSeason(m2,d2,11,1,3,31)],
  ];
  badgeData.forEach(function(b) {
    var el = document.getElementById(b[0]);
    if (!el) return;
    var mOpen = b[1], fOpen = b[2];
    var both = mOpen && fOpen;
    var none = !mOpen && !fOpen;
    var partial = (mOpen || fOpen) && !both;
    if (both)    { el.textContent = '✓ Open';    el.className = 'season-badge badge-open'; }
    else if (none)   { el.textContent = '✕ Closed';  el.className = 'season-badge badge-closed'; }
    else         { el.textContent = '~ In Part'; el.className = 'season-badge badge-partial'; }
  });
}

// ── 12: Today at a Glance (derives from bannerState only) ─────
function renderTodayGlance() { /* removed */ }

// ── 7: Accuracy warning ───────────────────────────────────────
ui.showLocationPrompt = function(msg) {
  // Update location text
  var el = document.getElementById('banner-location-text');
  if (el) el.textContent = msg;

  // Clear times to --:--
  ['sunrise-time','sunset-time'].forEach(function(id) {
    var e = document.getElementById(id); if (e) e.textContent = 'Unavailable';
  });
  ['legal-start-time','legal-end-time'].forEach(function(id) {
    var e = document.getElementById(id); if (e) e.textContent = 'Legal: Unavailable';
  });

  // Hide countdown
  var cd = document.getElementById('banner-countdown');
  if (cd) cd.style.display = 'none';

  // Reset banner to neutral state (not legal, not illegal)
  var banner = document.getElementById('legal-banner');
  if (banner) banner.className = 'legal-banner illegal';

  // Clear status label
  var lbl = document.getElementById('banner-label');
  if (lbl) { lbl.textContent = 'Location Required'; lbl.className = 'status-label status-illegal'; }
  var sub = document.getElementById('banner-sublabel');
  if (sub) sub.textContent = 'Tap to set your location';

  // Add tap hint cursor on status block
  var sb = document.getElementById('banner-status-block');
  if (sb) sb.style.cursor = 'pointer';

  // Grey out sun dot
  var sunDot = document.getElementById('sun-dot');
  if (sunDot) sunDot.setAttribute('fill', 'transparent');

  // Show asleep hunter (no location = not legal)
  var iconEl = document.getElementById('banner-icon');
  var asleepEl = document.getElementById('hunter-asleep');
  if (iconEl && asleepEl) iconEl.innerHTML = asleepEl.innerHTML;
};

ui.showAccuracyWarning = function(accuracy) {
  var el = document.getElementById('accuracy-warning');
  if (!el) return;
  el.style.display = (accuracy > 500) ? 'block' : 'none';
};

// ── GPS init (no auto-retry) ──────────────────────────────────
// ── UK bounds check ──────────────────────────────────────────
// Bounding box: mainland UK + Northern Ireland + Isle of Man + Channel Islands
var UK_BOUNDS = { latMin: 49.8, latMax: 60.9, lngMin: -8.7, lngMax: 1.9 };

function isInUK(lat, lng) {
  return lat >= UK_BOUNDS.latMin && lat <= UK_BOUNDS.latMax
      && lng >= UK_BOUNDS.lngMin && lng <= UK_BOUNDS.lngMax;
}

function showOutsideUKMessage() {
  ui.showLocationPrompt('🇬🇧 First Light covers UK locations only');
  // Show a brief toast
  var toast = document.createElement('div');
  toast.textContent = 'First Light is designed for UK deer stalking only. Please select a UK location.';
  toast.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:rgba(40,10,10,0.95);color:#ff9090;font-size:12px;font-weight:600;padding:10px 16px;border-radius:12px;border:1px solid rgba(255,100,100,0.3);z-index:9999;max-width:300px;text-align:center;line-height:1.4;';
  document.body.appendChild(toast);
  setTimeout(function() {
    toast.style.transition = 'opacity 0.5s';
    toast.style.opacity = '0';
    setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 500);
  }, 3500);
}

function initBanner() {
  // ── Restore last saved location ──────────────────────────────
  var saved = ui.loadState();
  if (saved && saved.lat !== undefined) {
    updateBanner(saved.lat, saved.lng, (saved.name || 'Saved location').replace(' (default)', '').replace(', England', ''));
    if (saved.tab) {
      var tabMap = { species: 0, times: 1, calendar: 2, shots: 3 };
      var navTabs = document.querySelectorAll('.nav-tab');
      if (navTabs[tabMap[saved.tab]]) {
        switchMainTab(saved.tab, null);
        navTabs[tabMap[saved.tab]].classList.add('active');
      }
    }
    return;
  }

  // Show locating state while GPS resolves
  ui.showLocationPrompt('Locating…');

  if (!navigator.geolocation) {
    ui.showLocationPrompt('📍 Set location to see legal times');
    return;
  }

  if (!navigator.onLine) {
    ui.showLocationPrompt('Offline — set location manually');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function(pos) {
      var lat = pos.coords.latitude;
      var lng = pos.coords.longitude;
      var acc = pos.coords.accuracy;
      if (!isInUK(lat, lng)) {
        showOutsideUKMessage();
        return;
      }
      ui.showAccuracyWarning(acc);
      fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json', {
        headers: { 'Accept-Language': 'en', 'User-Agent': 'FirstLightApp/1.0' }
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var addr = data.address || {};
          var raw = addr.town || addr.city || addr.village || addr.suburb || addr.hamlet || addr.county || 'Your Location';
          var name = raw.replace(/^(Metropolitan Borough of |London Borough of |Royal Borough of |City of |County of |District of )/i, '');
          updateBanner(lat, lng, name);
        })
        .catch(function() { updateBanner(lat, lng, 'Your Location'); });
    },
    function() {
      // GPS denied or failed — prompt user to set manually
      ui.showLocationPrompt('Location unavailable');
    },
    { timeout: 8000, maximumAge: 15000 }
  );
}

// ── Card expand/collapse ──────────────────────────────────────
function toggleCard(card) {
  var body    = card.querySelector('.card-body');
  var isOpen  = body.classList.contains('expanded');
  body.classList.toggle('expanded', !isOpen);
  card.classList.toggle('expanded-card', !isOpen);
  var header = card.querySelector('.card-header');
  if (header) header.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
}

function toggleFgCategory(header) {
  var isOpen = header.classList.toggle('open');
  header.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  var body = header.parentElement.querySelector('.fg-cat-body');
  if (body) body.classList.toggle('open', isOpen);
}

// ── Tab switching ─────────────────────────────────────────────
function switchTab(tab, el) {
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  if (el) el.classList.add('active');
  switchMainTab(tab, null);
}

function switchMainTab(tab, el) {
  document.querySelectorAll('.species-section, .info-section').forEach(function(s) { s.classList.remove('active'); });
  document.querySelectorAll('.tab-item').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });

  var target = document.getElementById('tab-' + tab);
  if (target) target.classList.add('active');
  if (el) el.classList.add('active');

  var navTabs = document.querySelectorAll('.nav-tab');
  var tabMap  = { species: 0, times: 1, calendar: 2, shots: 3 };
  if (navTabs[tabMap[tab]]) navTabs[tabMap[tab]].classList.add('active');

  window._activeTab = tab;
  ui.saveState();

  if (tab === 'times') {
    var ft = document.getElementById('forecast-table');
    // Rebuild if table is empty or location changed since last build
    if (!ft || !ft._builtForLat || ft._builtForLat !== bannerState.lat || ft._builtForLng !== bannerState.lng) {
      buildForecast();
    }
  }
}

// ── 7-day forecast (Option 9) ─────────────────────────────────
function buildForecast() {
  var table = document.getElementById('forecast-table');
  if (!table) return;

  // Guard against double-render from async weather callback
  var buildId = Date.now();
  table._buildId = buildId;

  var bs = bannerState;

  // Location label
  var locLabel = document.getElementById('forecast-location-label');
  if (locLabel) {
    locLabel.textContent = bs.locationName
      ? 'Legal = 1hr before sunrise · 1hr after sunset · Calculated for ' + bs.locationName
      : 'Legal = 1hr before sunrise · 1hr after sunset';
  }

  function fmtD(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) return 'Unavailable';
    var hm = ukHourMin(dateObj); return fmtTime(hm.h, hm.m);
  }

  function windowDuration(lsDate, leDate) {
    if (!lsDate || !leDate) return '--';
    var mins = Math.round((leDate - lsDate) / 60000);
    var h = Math.floor(mins / 60); var m = mins % 60;
    return h + 'h ' + (m > 0 ? m + 'm' : '');
  }

  if (bs.lat === null) {
    // Hero placeholders
    ['hero-sunrise','hero-sunset','hero-legal-start-big','hero-legal-end-big'].forEach(function(id) {
      var el = document.getElementById(id); if (el) el.textContent = '--:--';
    });
    var dur = document.getElementById('hero-window-duration'); if (dur) dur.textContent = '--';
    var hs = document.getElementById('hero-legal-start'); if (hs) hs.textContent = 'Legal from --:--';
    var he = document.getElementById('hero-legal-end'); if (he) he.textContent = 'Legal until --:--';
    table.textContent = '';
    var msg = document.createElement('div');
    msg.style.cssText = 'text-align:center;color:#888;font-size:13px;padding:16px;';
    msg.textContent = 'Set your location to see legal times.';
    table.appendChild(msg);
    return;
  }

  var today = new Date();
  var days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ── Build today hero ─────────────────────────────────────────
  var sr0, ss0;
  try { sr0 = calcSunTime(today, bs.lat, bs.lng, true);  } catch(e) { sr0 = null; }
  try { ss0 = calcSunTime(today, bs.lat, bs.lng, false); } catch(e) { ss0 = null; }
  var ls0 = sr0 ? addMins(sr0, -60) : null;
  var le0 = ss0 ? addMins(ss0,  60) : null;

  var heroLabel = document.getElementById('forecast-hero-label');
  if (heroLabel) {
    var dayName = days[today.getDay()];
    heroLabel.textContent = '📅 Today — ' + dayName + ' ' + today.getDate() + ' ' + months[today.getMonth()];
  }

  var hSR  = document.getElementById('hero-sunrise-label');
  var hSS  = document.getElementById('hero-sunset-label');
  var hLSB = document.getElementById('hero-legal-start-big'); if (hLSB) hLSB.textContent = fmtD(ls0);
  var hLEB = document.getElementById('hero-legal-end-big');   if (hLEB) hLEB.textContent = fmtD(le0);
  var hDur = document.getElementById('hero-window-duration'); if (hDur) hDur.textContent = windowDuration(ls0, le0);
  if (hSR) hSR.textContent = 'Sunrise ' + fmtD(sr0);
  if (hSS) hSS.textContent = 'Sunset ' + fmtD(ss0);

  // ── Build rows days 1–6 (today is day 0 in hero) ─────────────
  // Table is cleared inside the fetch callback to prevent double-render

  var GRID = '2.2fr 1fr 1fr 1.3fr 1.3fr 1.3fr 1fr 1fr 1fr';

  function flColor(fl, temp) { return (temp - fl) >= 2 ? '#a0d0ff' : 'rgba(255,255,255,0.5)'; }
  function gustColor(gust, wind) {
    var d = gust - wind;
    return d >= 15 ? '#e07020' : d >= 8 ? '#f0c040' : 'rgba(255,255,255,0.45)';
  }
  function rainPctColor(p) { return p >= 50 ? '#e07020' : p >= 25 ? '#f0c040' : 'rgba(255,255,255,0.3)'; }
  function rainMmColor(m)  { return m >= 3  ? '#e07020' : m >= 1  ? '#f0c040' : 'rgba(255,255,255,0.3)'; }
  function feelsLike(t, windMph) {
    var wk = windMph * 1.609;
    if (wk < 4.8 || t > 10) return t;
    var v = Math.pow(wk, 0.16);
    return Math.round(13.12 + 0.6215*t - 11.37*v + 0.3965*t*v);
  }
  function dirSpan(deg) {
    var cards = ['N','NE','E','SE','S','SW','W','NW'];
    var idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
    var disp = (idx * 45 + 180) % 360;
    return '<span style="display:inline-block;transform:rotate(' + disp + 'deg);line-height:1;">\u2191\uFE0E</span>\u00a0' + cards[idx];
  }
  function skyCellHtml(code, precip) {
    var emoji = wxCodeToEmoji(code, precip);
    if (emoji === '🌫') return '<div style="font-size:9px;font-weight:600;text-align:center;color:rgba(255,255,255,0.5);">Fog</div>';
    return '<div style="font-size:13px;text-align:center;">' + emoji + '</div>';
  }
  function buildLegalHourlyPanel(dayIdx, date, wxData, lsMin, leMin, srMin, ssMin) {
    var dawnStart = srMin - 60, dawnEnd = srMin + 120;
    var duskStart = ssMin - 90, duskEnd = ssMin + 45;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var isToday = dayIdx === 0;
    var dateLabel = (isToday ? 'Today' : dayNames[date.getDay()]) + ' ' + date.getDate() + ' ' + months[date.getMonth()];
    var lsLabel = fmtMins(lsMin) + ' \u2013 ' + fmtMins(leMin);

    var colLabels = ['Time','Temp','Feels','Wind','Dir','Gust','Sky','Rain','mm'];
    var hdr = '<div style="display:grid;grid-template-columns:' + GRID + ';gap:3px;padding:0 0 5px;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:2px;">';
    colLabels.forEach(function(l, i) {
      hdr += '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.22);text-align:' + (i===0?'left':'center') + ';">' + l + '</div>';
    });
    hdr += '</div>';

    var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      + '<span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:rgba(200,168,75,0.65);">Hourly weather</span>'
      + '<span style="font-size:8px;background:rgba(200,168,75,0.1);border:1px solid rgba(200,168,75,0.2);border-radius:10px;padding:2px 7px;color:#c8a84b;">' + lsLabel + '</span>'
      + '</div>' + hdr;

    var startH = Math.floor(lsMin / 60);
    var endH   = Math.ceil(leMin  / 60);
    for (var h = startH; h <= endH; h++) {
      var hMin = h * 60;
      if (hMin > leMin + 59) break;
      if (h === endH) {
        html += '<div style="display:flex;gap:8px;align-items:center;padding:6px 0 2px;border-top:1px solid rgba(200,168,75,0.18);margin-top:3px;">'
          + '<div style="font-size:9px;color:rgba(255,255,255,0.28);font-variant-numeric:tabular-nums;">' + fmtMins(leMin) + '</div>'
          + '<div style="font-size:9px;font-weight:600;color:#c8a84b;">Legal window closes</div></div>';
        break;
      }
      var hIdx = dayIdx * 24 + h;
      var wxH = null;
      if (wxData && wxData.hourly) {
        var T = wxData.hourly.temperature_2m;
        var W = wxData.hourly.wind_speed_10m;
        var G = wxData.hourly.windgusts_10m;
        var D = wxData.hourly.wind_direction_10m;
        var P = wxData.hourly.precipitation_probability;
        var PR = wxData.hourly.precipitation;
        var C = wxData.hourly.weather_code;
        if (T && hIdx < T.length) {
          wxH = {
            temp: Math.round(T[hIdx]),
            wind: W ? Math.round(W[hIdx] * 0.621) : null,
            gust: G ? Math.round(G[hIdx] * 0.621) : null,
            dir:  D ? D[hIdx] : null,
            precipP: P ? P[hIdx] : null,
            precipMm: PR ? PR[hIdx] : null,
            code: C ? C[hIdx] : null
          };
        }
      }
      var tStr = (h < 10 ? '0' : '') + h + ':00';
      var tempStr  = wxH ? wxH.temp + '\u00b0' : '\u2013';
      var windStr  = wxH && wxH.wind  !== null ? wxH.wind  + ' mph' : '\u2013';
      var gustStr  = wxH && wxH.gust  !== null ? wxH.gust  + ' mph' : '\u2013';
      var dirStr   = wxH && wxH.dir   !== null ? dirSpan(wxH.dir)   : '\u2013';
      var skyStr   = wxH ? skyCellHtml(wxH.code, wxH.precipMm || 0)     : '<div style="text-align:center;">\u2013</div>';
      var pctStr   = wxH && wxH.precipP  !== null ? (wxH.precipP > 0 ? wxH.precipP + '%' : '\u2013') : '\u2013';
      var mmStr    = wxH && wxH.precipMm !== null ? (wxH.precipMm > 0 ? wxH.precipMm.toFixed(1) : '\u2013') : '\u2013';
      var fl       = wxH ? feelsLike(wxH.temp, wxH.wind || 0) : null;
      var flStr    = fl !== null ? fl + '\u00b0' : '\u2013';
      var flClr    = fl !== null ? flColor(fl, wxH.temp) : 'rgba(255,255,255,0.5)';
      var gClr     = wxH && wxH.gust !== null ? gustColor(wxH.gust, wxH.wind || 0) : 'rgba(255,255,255,0.45)';
      var pClr     = wxH && wxH.precipP  !== null ? rainPctColor(wxH.precipP)  : 'rgba(255,255,255,0.3)';
      var mClr     = wxH && wxH.precipMm !== null ? rainMmColor(wxH.precipMm)  : 'rgba(255,255,255,0.3)';

      html += '<div style="display:grid;grid-template-columns:' + GRID + ';gap:3px;padding:5px 3px;border-bottom:1px solid rgba(255,255,255,0.035);align-items:center;margin:1px 0;">'
        + '<div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.75);font-variant-numeric:tabular-nums;">' + tStr + '</div>'
        + '<div style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.78);text-align:center;">' + tempStr + '</div>'
        + '<div style="font-size:11px;font-weight:600;text-align:center;color:' + flClr + ';">' + flStr + '</div>'
        + '<div style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.78);text-align:center;white-space:nowrap;">' + windStr + '</div>'
        + '<div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.6);text-align:center;white-space:nowrap;">' + dirStr + '</div>'
        + '<div style="font-size:10px;font-weight:600;text-align:center;white-space:nowrap;color:' + gClr + ';">' + gustStr + '</div>'
        + skyStr
        + '<div style="font-size:10px;font-weight:600;text-align:center;color:' + pClr + ';">' + pctStr + '</div>'
        + '<div style="font-size:10px;font-weight:600;text-align:center;color:' + mClr + ';">' + mmStr + '</div>'
        + '</div>';
    }

    html += '<div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap;">'
      + '<div style="font-size:8px;color:rgba(255,255,255,0.25);display:flex;align-items:center;gap:3px;"><span style="color:#a0d0ff;">■</span> Wind chill</div>'
      + '<div style="font-size:8px;color:rgba(255,255,255,0.25);display:flex;align-items:center;gap:3px;"><span style="color:#f0c040;">■</span> Gusty</div>'
      + '<div style="font-size:8px;color:rgba(255,255,255,0.25);display:flex;align-items:center;gap:3px;"><span style="color:#e07020;">■</span> Strong gusts</div>'
      + '</div>'
      + '<div style="font-size:9px;color:rgba(255,255,255,0.18);text-align:center;margin-top:6px;">Hourly weather \u00b7 Open-Meteo</div>';
    return html;
  }

  var SVG_SR_SM = '<svg width="16" height="13" viewBox="0 0 28 22" xmlns="http://www.w3.org/2000/svg" style="display:inline;vertical-align:middle;flex-shrink:0;"><path d="M0,22 Q4,14 8,16 Q11,18 14,13 Q17,8 20,12 Q23,15 28,11 L28,22 Z" fill="#3a5a2a" opacity="0.85"/><path d="M0,22 Q5,17 9,19 Q13,21 16,17 Q19,14 24,18 Q26,19 28,17 L28,22 Z" fill="#2a4a1a" opacity="0.9"/><circle cx="14" cy="13" r="5" fill="#f5b830" opacity="0.95"/></svg>';
  var SVG_SS_SM = '<svg width="16" height="13" viewBox="0 0 28 22" xmlns="http://www.w3.org/2000/svg" style="display:inline;vertical-align:middle;flex-shrink:0;"><ellipse cx="14" cy="16" rx="12" ry="4" fill="#e06010" opacity="0.3"/><circle cx="14" cy="16" r="5" fill="#e87820" opacity="0.95"/><path d="M0,22 Q4,13 8,15 Q11,17 14,12 Q17,7 20,11 Q23,14 28,10 L28,22 Z" fill="#2a3a1a" opacity="0.9"/><path d="M0,22 Q5,16 9,18 Q13,20 16,16 Q19,13 24,17 Q26,18 28,16 L28,22 Z" fill="#1a2a0f" opacity="0.95"/></svg>';

  // Fetch weather then build rows
  var lat = bs.lat, lng = bs.lng;
  fetch7DayWeather(lat, lng, function(err, wxData) {
    // If buildForecast was called again while we were fetching, abort this render
    if (table._buildId !== buildId) return;
    table.textContent = '';
    var heroWx = document.getElementById('hero-wx-summary');
    if (heroWx && wxData && wxData.daily) {
      var code0 = wxData.daily.weather_code ? wxData.daily.weather_code[0] : null;
      var t0max = wxData.daily.temperature_2m_max ? wxData.daily.temperature_2m_max[0] : null;
      var t0min = wxData.daily.temperature_2m_min ? wxData.daily.temperature_2m_min[0] : null;
      var w0    = wxData.daily.wind_speed_10m_max  ? Math.round(wxData.daily.wind_speed_10m_max[0] * 0.621) : null;
      var emoji0 = code0 !== null ? wxCodeToEmoji(code0, 0) : '';
      var temp0  = (t0max !== null && t0min !== null) ? Math.round((t0max + t0min) / 2) + '\u00b0C' : '';
      var wind0  = w0 !== null ? w0 + ' mph' : '';
      heroWx.textContent = [emoji0, temp0, wind0 ? '\u00b7 ' + wind0 : ''].filter(Boolean).join(' ');
    }

    for (var i = 0; i < 7; i++) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      var sr, ss;
      try { sr = calcSunTime(d, lat, lng, true);  } catch(e) { sr = null; }
      try { ss = calcSunTime(d, lat, lng, false); } catch(e) { ss = null; }
      var legalStart = sr ? addMins(sr, -60) : null;
      var legalEnd   = ss ? addMins(ss,  60) : null;
      var lsMin2 = legalStart ? toMinutes(legalStart) : 5 * 60;
      var leMin2 = legalEnd   ? toMinutes(legalEnd)   : 19 * 60;
      var srMin2 = sr ? toMinutes(sr) : 6 * 60;
      var ssMin2 = ss ? toMinutes(ss) : 18 * 60;

      var wxDay = null;
      if (wxData && wxData.daily) {
        wxDay = {
          tempMax:  wxData.daily.temperature_2m_max  ? wxData.daily.temperature_2m_max[i]  : null,
          tempMin:  wxData.daily.temperature_2m_min  ? wxData.daily.temperature_2m_min[i]  : null,
          windMax:  wxData.daily.wind_speed_10m_max  ? wxData.daily.wind_speed_10m_max[i]  : null,
          gustMax:  wxData.daily.wind_gusts_10m_max  ? wxData.daily.wind_gusts_10m_max[i]  : null,
          precip:   wxData.daily.precipitation_sum   ? wxData.daily.precipitation_sum[i]   : null,
          wcode:    wxData.daily.weather_code        ? wxData.daily.weather_code[i]        : null
        };
      }

      var isToday = i === 0;
      var isBST = (function(date) {
        var lastSunMar = new Date(date.getFullYear(), 2, 31);
        lastSunMar.setDate(31 - lastSunMar.getDay());
        var lastSunOct = new Date(date.getFullYear(), 9, 31);
        lastSunOct.setDate(31 - lastSunOct.getDay());
        return date >= lastSunMar && date < lastSunOct;
      }(d));
      var prevIsBST = i === 0 ? isBST : (function(date) {
        var lastSunMar = new Date(date.getFullYear(), 2, 31);
        lastSunMar.setDate(31 - lastSunMar.getDay());
        var lastSunOct = new Date(date.getFullYear(), 9, 31);
        lastSunOct.setDate(31 - lastSunOct.getDay());
        return date >= lastSunMar && date < lastSunOct;
      }(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i - 1)));
      var clockChange = i > 0 && isBST !== prevIsBST;

      // Day label
      var dayLabel = isToday ? 'Today' : days[d.getDay()];
      var dayColor = isToday ? '#f0c870' : 'rgba(255,255,255,0.4)';

      // Weather summary for row
      var wxSky = '', wxTemp = '', wxWind = '', wxCond = '';
      if (wxDay) {
        wxSky  = wxCodeToEmoji(wxDay.wcode, wxDay.precip || 0);
        wxTemp = wxDay.tempMax !== null ? Math.round((wxDay.tempMax + wxDay.tempMin) / 2) + '\u00b0C' : '';
        wxWind = wxDay.windMax !== null ? Math.round(wxDay.windMax * 0.621) + ' mph' : '';
        wxCond = conditionLabel(wxDay.wcode, wxDay.precip || 0);
      }

      // Build row
      var row = document.createElement('div');
      row.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;';

      var bstBadge = clockChange ? '<span style="font-size:8px;font-weight:700;color:#f0c040;background:rgba(240,192,64,0.12);border-radius:4px;padding:1px 5px;margin:0 2px;">BST</span>' : '';

      row.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;padding:11px 16px 8px;">'
          + '<div style="width:44px;flex-shrink:0;">'
            + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;color:' + dayColor + ';">' + dayLabel + '</div>'
            + '<div style="font-size:15px;font-weight:700;color:rgba(255,255,255,0.85);">' + d.getDate() + '</div>'
          + '</div>'
          + '<div style="flex:1;min-width:0;">'
            + '<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px;flex-wrap:wrap;">'
              + '<span style="font-size:20px;font-weight:700;color:#f0c870;font-variant-numeric:tabular-nums;line-height:1;">' + fmtD(legalStart) + '</span>'
              + bstBadge
              + '<span style="font-size:13px;color:rgba(255,255,255,0.25);">\u2192</span>'
              + '<span style="font-size:20px;font-weight:700;color:#f09850;font-variant-numeric:tabular-nums;line-height:1;">' + fmtD(legalEnd) + '</span>'
            + '</div>'
            + '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">'
              + SVG_SR_SM + '<span style="font-size:10px;color:rgba(255,255,255,0.4);font-variant-numeric:tabular-nums;">' + fmtD(sr) + '</span>'
              + SVG_SS_SM + '<span style="font-size:10px;color:rgba(255,255,255,0.4);font-variant-numeric:tabular-nums;">' + fmtD(ss) + '</span>'
              + '<span style="font-size:10px;color:rgba(255,255,255,0.22);">' + windowDuration(legalStart, legalEnd) + '</span>'
            + '</div>'
          + '</div>'
          + '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0;">'
            + '<div style="display:flex;align-items:center;gap:4px;"><span style="font-size:18px;">' + (wxSky || '') + '</span><span style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.75);">' + wxTemp + '</span></div>'
            + '<div style="font-size:10px;color:rgba(255,255,255,0.35);text-align:right;">' + wxWind + (wxCond ? ' \u00b7 ' + wxCond : '') + '</div>'
            + '<div style="font-size:10px;color:rgba(255,255,255,0.2);margin-top:2px;transition:transform 0.2s;" class="lt-chev">\u25be</div>'
          + '</div>'
        + '</div>'
        + '<div class="lt-hourly" style="display:none;background:rgba(0,0,0,0.22);border-top:1px solid rgba(255,255,255,0.05);padding:10px 14px;overflow:hidden;">'
          + buildLegalHourlyPanel(i, d, wxData, lsMin2, leMin2, srMin2, ssMin2)
        + '</div>';

      // Toggle hourly
      (function(r) {
        r.addEventListener('click', function() {
          var h = r.querySelector('.lt-hourly');
          var c = r.querySelector('.lt-chev');
          var open = h.style.display !== 'none';
          h.style.display = open ? 'none' : 'block';
          if (c) c.style.transform = open ? '' : 'rotate(180deg)';
        });
      }(row));

      table.appendChild(row);
    }
    if (table.lastChild) table.lastChild.style.borderBottom = 'none';
    table._builtForLat = lat;
    table._builtForLng = lng;
  });
}


// ════════════════════════════════════════════════════════════════
// FEATURE: 7-DAY ACTIVITY FORECAST
// ════════════════════════════════════════════════════════════════

var _wfWeatherCache = { data: null, ts: 0, lat: null, lng: null };

function fetch7DayWeather(lat, lng, cb) {
  var now = Date.now();
  if (_wfWeatherCache.data && (now - _wfWeatherCache.ts < 20*60*1000)
      && _wfWeatherCache.lat === lat && _wfWeatherCache.lng === lng) {
    return cb(null, _wfWeatherCache.data);
  }
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat
    + '&longitude=' + lng
    + '&daily=temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,precipitation_sum,weather_code,surface_pressure_mean'
    + '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,windgusts_10m,precipitation_probability,precipitation,weather_code,cloud_cover,surface_pressure'
    + '&forecast_days=7&timezone=auto';
  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      _wfWeatherCache = { data: d, ts: Date.now(), lat: lat, lng: lng };
      cb(null, d);
    })
    .catch(function(e) { cb(e, null); });
}

function scoreDay(date, wxDay) {
  // Score dawn and dusk windows for a given date
  var bs = bannerState;
  var lat = bs.lat || 52, lng = bs.lng || 0;
  var sr, ss;
  try { sr = calcSunTime(date, lat, lng, true);  } catch(e) { sr = null; }
  try { ss = calcSunTime(date, lat, lng, false); } catch(e) { ss = null; }
  if (!sr || !ss) return null;

  var srMin = toMinutes(sr);
  var ssMin = toMinutes(ss);
  var dawnStart = srMin - 60;
  var dawnEnd   = srMin + 120;
  var duskStart = ssMin - 90;
  var duskEnd   = ssMin + 45;  // 45 mins after sunset

  var moon = getMoonPhase(date);
  var month = date.getMonth() + 1;

  // Moon boost — reduced from 15/11/8/4/1 (phase effect on daytime movement overstated)
  var mb = moon.illumination < 15 ? 8
         : moon.illumination < 40 ? 6
         : moon.illumination < 60 ? 4
         : moon.illumination < 85 ? 2 : 1;

  // Rut
  var rutMonths = RUT_CALENDAR[month] || [0,0,0,0,0];
  var maxRut = Math.max.apply(null, rutMonths);
  var rutScore = maxRut >= 25 ? 15 : maxRut >= 10 ? 8 : maxRut > 0 ? 3 : 0;

  // Seasonal
  var sb = month === 2 ? 5 : month === 3 ? 3
         : (month === 9 || month === 10) ? 4
         : month === 11 ? 2
         : (month >= 6 && month <= 8) ? -3 : 0;

  // Weather for this day
  var wxScore = 0;
  if (wxDay) {
    var avgTemp = (wxDay.tempMax + wxDay.tempMin) / 2;
    var baseTemp = avgTemp <= 0 ? 4 : avgTemp <= 8 ? 6 : avgTemp <= 14 ? 3 : avgTemp <= 18 ? 0 : -3;
    // Frost bonus: overnight low below zero = deer must feed hard next dawn
    var frostBonusD = wxDay.tempMin < -1 ? 4 : wxDay.tempMin <= 0 ? 2 : 0;
    wxScore += baseTemp + frostBonusD;
    var windMaxMph1 = wxDay.windMax * 0.621;
    wxScore += windMaxMph1 < 8 ? 6 : windMaxMph1 < 20 ? 3 : windMaxMph1 < 35 ? -2 : -5;
    // Gust consistency: daily gust max vs wind max ratio
    if (wxDay.gustMax && wxDay.windMax > 2) {
      var dailyGustRatio = (wxDay.gustMax - wxDay.windMax) / wxDay.windMax;
      wxScore += dailyGustRatio > 0.8 ? -4
              : dailyGustRatio > 0.5  ? -2
              : dailyGustRatio > 0.3  ? -1
              : dailyGustRatio <= 0.15 ? 1 : 0;
    }
    wxScore += wxDay.precip > 5 ? -4 : wxDay.precip > 0.5 ? 2 : 1;
    // Pressure proxy: day-over-day delta from surface_pressure_mean
    // (falling pressure = pre-front feeding surge; rising = settled, less urgency)
    if (wxDay.pressure !== null && wxDay.pressure !== undefined) {
      var prevPressure = (wxDay.prevPressure !== undefined) ? wxDay.prevPressure : wxDay.pressure;
      var pressureDelta = wxDay.pressure - prevPressure;
      wxScore += pressureDelta < -1 ? 4 : pressureDelta < 0 ? 2 : pressureDelta > 1 ? 0 : 1;
    }
  }

  var dawnScore = Math.min(100, Math.max(0, 40 + mb + rutScore + sb + wxScore));
  var duskScore = Math.min(100, Math.max(0, 40 + mb + rutScore + sb + wxScore));
  // Dusk variance: calmer evenings boost dusk slightly
  duskScore = Math.min(100, Math.max(0, duskScore + (wxDay && (wxDay.windMax * 0.621) > 20 ? -3 : 2)));

  return {
    dawnScore: dawnScore,
    duskScore: duskScore,
    bestScore: Math.max(dawnScore, duskScore),
    bestWindow: dawnScore >= duskScore ? 'Dawn' : 'Dusk',
    dawnTime: fmtMins(dawnStart),
    duskTime: fmtMins(duskStart),
    moon: moon,
    wxDay: wxDay
  };
}

// ── Weather helpers ───────────────────────────────────────────
function conditionLabel(code, precip) {
  if (code === null || code === undefined) return 'Cloud';
  if (code === 0)  return 'Clear';
  if (code <= 2)   return 'Partly cloudy';
  if (code === 3)  return 'Overcast';
  if (code <= 49)  return 'Fog';
  if (code <= 57)  return 'Drizzle';
  if (code <= 65)  return precip > 4 ? 'Heavy rain' : 'Rain';
  if (code <= 77)  return 'Snow';
  if (code <= 82)  return precip > 4 ? 'Heavy rain' : 'Showers';
  if (code <= 86)  return 'Snow showers';
  if (code <= 99)  return 'Thunderstorm';
  return 'Cloudy';
}

function wxCodeToEmoji(code, precip) {
  if (code === null || code === undefined) return '☁️';
  if (code === 0)  return '☀️';
  if (code <= 2)   return '⛅';
  if (code === 3)  return '☁️';
  if (code <= 49)  return '🌫';
  if (code <= 57)  return '🌦';
  if (code <= 65)  return precip > 4 ? '🌧' : '🌦';
  if (code <= 77)  return '❄️';
  if (code <= 82)  return precip > 4 ? '🌧' : '🌦';
  if (code <= 86)  return '❄️';
  if (code <= 99)  return '⛈';
  return '☁️';
}

function precipEmoji(mm) {
  if (mm <= 0)   return '🌤';
  if (mm < 2)    return '🌦';
  if (mm < 5)    return '🌧';
  return '🌧';
}

function windDirArrow(deg) {
  // Returns rotated ↑ arrow + cardinal — using text variation selector to prevent emoji rendering
  var cardinals = ['N','NE','E','SE','S','SW','W','NW'];
  var idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  var cardinal = cardinals[idx];
  var rotDeg = idx * 45;
  // Wind direction = where wind comes FROM — arrow points where wind goes TO
  var displayDeg = (rotDeg + 180) % 360;
  return '<span style="display:inline-block;transform:rotate(' + displayDeg + 'deg);line-height:1;font-style:normal;">\u2191\uFE0E</span>\u00a0' + cardinal;
}

function hourlyActivityScore(hour, date, wxHour) {
  // Simplified per-hour score using same model as getDeerActivityScore
  var bs = bannerState;
  var lat = bs.lat || 52, lng = bs.lng || 0;
  // Compute sunrise/sunset for this specific day, not today
  var sr = calcSunTime(date, lat, lng, true);
  var ss = calcSunTime(date, lat, lng, false);
  var srMin = sr ? toMinutes(sr) : 6*60;
  var ssMin = ss ? toMinutes(ss) : 20*60;
  var dawnStart = srMin - 60, dawnEnd = srMin + 120;
  var duskStart = ssMin - 90, duskEnd = ssMin + 45;
  var moon = getMoonPhase(date);
  var month = date.getMonth() + 1;
  var score = 0;

  // Time window
  if (hour >= dawnStart/60 && hour <= dawnEnd/60)       score += 40;
  else if (hour >= duskStart/60 && hour <= duskEnd/60)  score += 40;
  else if (hour >= dawnEnd/60 && hour <= duskStart/60)  score += 8;
  else score += 8;

  // Moon — reduced weights (daytime phase effect overstated in literature)
  var mb = moon.illumination < 15 ? 8 : moon.illumination < 40 ? 6
         : moon.illumination < 60 ? 4 : moon.illumination < 85 ? 2 : 1;
  var isNight = !(hour >= dawnStart/60 && hour <= duskEnd/60);
  score += isNight ? Math.round(mb * 0.3) : mb;

  // Rut
  var rutM = RUT_CALENDAR[month] || [0,0,0,0,0];
  var maxRut = Math.max.apply(null, rutM);
  score += maxRut >= 25 ? 15 : maxRut >= 10 ? 8 : maxRut > 0 ? 3 : 0;

  // Season
  score += month === 2 ? 5 : month === 3 ? 3
         : (month === 9||month===10) ? 4 : month===11 ? 2
         : (month>=6&&month<=8) ? -3 : 0;

  // Solunar — reduced (contested in peer-reviewed literature; major +3, minor +1)
  var sol = getSolunar(date, lat, lng);
  var hourMin = hour * 60;
  var inMajorH = inWindow(hourMin, sol.major1.start, sol.major1.end) ||
                 inWindow(hourMin, sol.major2.start, sol.major2.end);
  var inMinorH = inWindow(hourMin, sol.minor1.start, sol.minor1.end) ||
                 inWindow(hourMin, sol.minor2.start, sol.minor2.end);
  if (inMajorH)      score += 3;
  else if (inMinorH) score += 1;

  // Weather
  if (wxHour) {
    var t = wxHour.temp;
    var tBase = t<=0 ? 4 : t<=8 ? 6 : t<=14 ? 3 : t<=18 ? 0 : -3;
    // Frost bonus in hourly: if at/below freezing add extra push
    var tFrost = (t <= 0) ? 3 : (t <= 1) ? 1 : 0;
    score += tBase + tFrost;
    var wkm = wxHour.wind * 0.621; // convert km/h → mph before scoring
    score += wkm<=8 ? 6 : wkm<=20 ? 3 : wkm<=35 ? -2 : -5;
    // Wind consistency: gusty = scent unreliable (only if sustained wind > 5mph)
    if (wxHour.gustRatio !== undefined && wkm > 5) {
      score += wxHour.gustRatio > 0.8 ? -4
             : wxHour.gustRatio > 0.5 ? -2
             : wxHour.gustRatio > 0.3 ? -1
             : wxHour.gustRatio <= 0.15 ? 1 : 0;
    }
    // Post-rain: deer move freely once rain stops (+4). During rain: light +2, heavy -4
    if (wxHour.postRain)          score += 4;
    else if (wxHour.precip > 5)   score += -4;
    else if (wxHour.precip > 0.5) score += 2;
    else                          score += 1;
  }

  return Math.min(100, Math.max(0, score));
}

function buildHourlyPanel(dayIdx, date, wxData, legalStartMin, legalEndMin) {
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var isToday = dayIdx === 0;
  var dateLabel = (isToday ? 'Today' : dayNames[date.getDay()]) + ' ' + date.getDate() + ' ' + months[date.getMonth()];
  var lsLabel = fmtMins(legalStartMin) + ' \u2013 ' + fmtMins(legalEndMin);

  var html = '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:rgba(200,168,75,0.6);margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">'
    + '<span>Legal shooting window \u00b7 ' + dateLabel + '</span>'
    + '<span style="font-size:8px;background:rgba(200,168,75,0.12);border:1px solid rgba(200,168,75,0.2);border-radius:10px;padding:2px 8px;color:#c8a84b;">' + lsLabel + '</span>'
    + '</div>';

  // Column headers
  html += '<div style="display:grid;grid-template-columns:40px 1fr 40px 58px 40px 30px 34px;gap:4px;padding:0 0 6px;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:4px;">'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);">Time</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">\uD83E\uDD8C Activity</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">\uD83C\uDF21</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">\uD83C\uDF43 Wind</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">Dir</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">\u2601\uFE0E</div>'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.25);text-align:center;">\uD83C\uDF27</div>'
    + '</div>';

  // Build hour rows within legal window
  var startHour = Math.floor(legalStartMin / 60);
  var endHour   = Math.ceil(legalEndMin / 60);
  var srMin = bannerState.sunriseMin !== null ? bannerState.sunriseMin : 6*60;
  var ssMin = bannerState.sunsetMin  !== null ? bannerState.sunsetMin  : 20*60;
  var dawnStart = srMin - 60, dawnEnd = srMin + 120;
  var duskStart = ssMin - 90, duskEnd = ssMin + 45;

  for (var h = startHour; h <= endHour; h++) {
    var hourMin = h * 60;
    // Skip if outside legal window
    if (hourMin > legalEndMin + 59) break;

    var isDawn = (hourMin >= dawnStart && hourMin <= dawnEnd);
    var isDusk = (hourMin >= duskStart && hourMin <= duskEnd);
    var isLegal = (hourMin >= legalStartMin && hourMin <= legalEndMin);

    // Get hourly wx data
    var wxHour = null;
    if (wxData && wxData.hourly) {
      // Open-Meteo hourly index: dayIdx*24 + hour
      var hIdx = dayIdx * 24 + h;
      var temps  = wxData.hourly.temperature_2m;
      var winds  = wxData.hourly.wind_speed_10m;
      var dirs   = wxData.hourly.wind_direction_10m;
      var precips= wxData.hourly.precipitation_probability;
      var codes  = wxData.hourly.weather_code;
      if (temps && hIdx < temps.length) {
        var hPrecipArr = wxData.hourly.precipitation;
        var gusts      = wxData.hourly.windgusts_10m;
        var hPrecipNow  = hPrecipArr ? (hPrecipArr[hIdx] || 0) : 0;
        var hPrecip1ago = hPrecipArr ? (hPrecipArr[Math.max(0, hIdx-1)] || 0) : 0;
        var hPrecip2ago = hPrecipArr ? (hPrecipArr[Math.max(0, hIdx-2)] || 0) : 0;
        var hWind       = winds ? winds[hIdx] : null;
        var hGust       = gusts ? gusts[hIdx] : null;
        var hGustRatio  = (hWind > 2 && hGust) ? (hGust - hWind) / hWind : 0;
        wxHour = {
          temp:      Math.round(temps[hIdx]),
          wind:      hWind,
          gust:      hGust,
          gustRatio: hGustRatio,
          dir:       dirs  ? dirs[hIdx]  : null,
          precipP:   precips ? precips[hIdx] : null,
          precip:    hPrecipNow,
          postRain:  (hPrecipNow < 0.1) && (Math.max(hPrecip1ago, hPrecip2ago) > 0.5),
          code:      codes ? codes[hIdx] : null
        };
      }
    }

    var actScore = hourlyActivityScore(h, date, wxHour);
    var barClr = actScore >= 65 ? 'linear-gradient(90deg,#3abf3a,#7aef7a)'
               : actScore >= 45 ? 'linear-gradient(90deg,#c8a84b,#e0c050)'
               : 'linear-gradient(90deg,#e07020,#e09040)';
    var timeColor = isLegal
      ? (isDawn ? '#f0c870' : isDusk ? '#f09850' : 'rgba(255,255,255,0.7)')
      : 'rgba(255,255,255,0.35)';
    var rowBg = isDawn ? 'rgba(240,192,64,0.07)' : isDusk ? 'rgba(240,144,32,0.07)' : 'transparent';
    var borderLeft = isDawn ? '3px solid rgba(240,192,64,0.5)' : isDusk ? '3px solid rgba(240,144,32,0.5)' : '3px solid transparent';

    var tempStr = wxHour ? wxHour.temp + '\u00b0C' : '\u2013';
    var windStr = wxHour && wxHour.wind !== null ? Math.round(wxHour.wind * 0.621) + ' mph' : '\u2013';
    var dirStr  = wxHour && wxHour.dir  !== null ? windDirArrow(wxHour.dir) : '\u2013';
    var skyStr  = wxHour ? wxCodeToEmoji(wxHour.code, 0) : '\u2013';
    var precipStr = wxHour && wxHour.precipP !== null
      ? (wxHour.precipP === 0 ? '<span style="color:rgba(255,255,255,0.25);">Dry</span>'
        : '<span style="color:' + (wxHour.precipP >= 60 ? '#e07020' : wxHour.precipP >= 30 ? '#f0c040' : 'rgba(255,255,255,0.5)') + ';">' + wxHour.precipP + '%</span>')
      : '\u2013';

    // Special row for legal window close
    if (h === endHour) {
      html += '<div style="display:grid;grid-template-columns:40px 1fr;gap:4px;padding:6px 0;">'
        + '<div style="font-size:9px;color:rgba(255,255,255,0.3);font-variant-numeric:tabular-nums;">' + fmtMins(legalEndMin) + '</div>'
        + '<div style="font-size:9px;font-weight:600;color:#c8a84b;border-top:1px solid rgba(200,168,75,0.25);padding-top:4px;">Legal window closes</div>'
        + '</div>';
      break;
    }

    html += '<div style="display:grid;grid-template-columns:40px 1fr 40px 58px 40px 30px 34px;gap:4px;padding:6px 0 6px 4px;border-bottom:1px solid rgba(255,255,255,0.04);background:' + rowBg + ';border-left:' + borderLeft + ';border-radius:4px;margin:0 -4px;">'
      + '<div style="font-size:12px;font-weight:700;color:' + timeColor + ';font-variant-numeric:tabular-nums;">' + (h < 10 ? '0'+h : h) + ':00</div>'
      + '<div style="display:flex;flex-direction:column;gap:2px;padding-right:4px;">'
        + '<div style="height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">'
          + '<div style="height:100%;border-radius:3px;background:' + barClr + ';width:' + actScore + '%;"></div>'
        + '</div>'
        + '<div style="font-size:8px;color:rgba(255,255,255,0.4);font-variant-numeric:tabular-nums;">' + actScore + '%</div>'
      + '</div>'
      + '<div style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.75);text-align:center;">' + tempStr + '</div>'
      + '<div style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.75);text-align:center;">' + windStr + '</div>'
      + '<div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.6);text-align:center;">' + dirStr + '</div>'
      + '<div style="font-size:13px;text-align:center;">' + skyStr + '</div>'
      + '<div style="font-size:10px;font-weight:600;text-align:center;">' + precipStr + '</div>'
      + '</div>';
  }

  html += '<div style="font-size:9px;color:rgba(255,255,255,0.2);margin-top:8px;text-align:center;">Hourly weather \u00b7 Open-Meteo \u00b7 Activity score per hour</div>';
  return html;
}

function buildWeekForecast(wxData) {
  var panel = document.getElementById('week-forecast-panel');
  var rowsEl = document.getElementById('wf-rows');
  var heroDay = document.getElementById('wf-hero-day');
  var heroWindow = document.getElementById('wf-hero-window');
  var heroScore = document.getElementById('wf-hero-score');
  var heroLabel = document.getElementById('wf-hero-label');
  var heroPills = document.getElementById('wf-hero-pills');
  if (!panel || !rowsEl) return;

  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var today = new Date();
  var results = [];

  for (var i = 0; i < 7; i++) {
    var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    var wxDay = null;
    if (wxData && wxData.daily) {
      var _pArr  = wxData.daily.surface_pressure_mean;
      var _gArr  = wxData.daily.wind_gusts_10m_max;
      wxDay = {
        tempMax:      wxData.daily.temperature_2m_max[i],
        tempMin:      wxData.daily.temperature_2m_min[i],
        windMax:      wxData.daily.wind_speed_10m_max[i],
        gustMax:      _gArr ? _gArr[i] : null,
        precip:       wxData.daily.precipitation_sum[i],
        wcode:        wxData.daily.weather_code[i],
        pressure:     _pArr ? _pArr[i]         : null,
        prevPressure: _pArr && i > 0 ? _pArr[i-1] : (_pArr ? _pArr[0] : null)
      };
    }
    var s = scoreDay(d, wxDay);
    if (s) results.push({ date: d, day: i, s: s });
  }

  if (!results.length) return;

  // Find best day — skip today if both windows already passed
  var nowMin = ukNowMin();
  var bestIdx = -1;
  var bestScore = -1;
  results.forEach(function(r, i) {
    var effectiveScore = r.s.bestScore;
    if (i === 0) {
      var ss2 = bannerState.sunsetMin !== null ? bannerState.sunsetMin : 20 * 60;
      if (nowMin > ss2 + 45) effectiveScore = 0; // dusk window passed
    }
    if (effectiveScore > bestScore) {
      bestScore = effectiveScore;
      bestIdx = i;
    }
  });
  if (bestIdx < 0) bestIdx = 0;
  var best = results[bestIdx];

  // ── Hero ──────────────────────────────────────────────────
  if (heroDay) heroDay.textContent = days[best.date.getDay()] + ' ' + best.date.getDate() + ' ' + months[best.date.getMonth()];
  if (heroWindow) heroWindow.textContent = best.s.bestWindow + ' · ' +
    (best.s.bestWindow === 'Dawn' ? best.s.dawnTime : best.s.duskTime) + ' peak';
  if (heroScore) heroScore.textContent = best.s.bestScore + '%';
  if (heroLabel) {
    heroLabel.textContent = best.s.bestScore >= 65 ? 'High Activity'
      : best.s.bestScore >= 45 ? 'Moderate'
      : best.s.bestScore >= 20 ? 'Low Activity' : 'Minimal Activity';
  }

  // Hero pills
  if (heroPills) {
    heroPills.innerHTML = '';
    var pillData = [
      { label: best.s.moon.name, bg: 'rgba(255,255,200,0.1)', color: 'rgba(255,255,200,0.8)', border: 'rgba(255,255,200,0.15)' },
    ];
    if (best.s.wxDay) {
      var avgT = Math.round((best.s.wxDay.tempMax + best.s.wxDay.tempMin) / 2);
      var tMaxH = Math.round(best.s.wxDay.tempMax);
      var tMinH = Math.round(best.s.wxDay.tempMin);
      pillData.push({ label: '🌡 ' + tMinH + '–' + tMaxH + '°C', bg: avgT <= 10 ? 'rgba(90,180,255,0.12)' : 'rgba(255,140,60,0.1)', color: avgT <= 10 ? 'rgba(150,210,255,0.85)' : 'rgba(255,180,100,0.85)', border: 'rgba(90,180,255,0.15)' });
      var windMph = Math.round(best.s.wxDay.windMax * 0.621);
      pillData.push({ label: '🍃 ' + windMph + ' mph', bg: windMph < 10 ? 'rgba(90,220,90,0.1)' : 'rgba(255,200,60,0.1)', color: windMph < 10 ? 'rgba(122,223,122,0.85)' : 'rgba(255,220,100,0.85)', border: 'rgba(90,220,90,0.15)' });
    }
    var rutM = RUT_CALENDAR[best.date.getMonth()+1] || [0,0,0,0,0];
    if (Math.max.apply(null,rutM) >= 10) {
      var rutNames = RUT_SPECIES.filter(function(_,i){ return rutM[i]>=10; });
      pillData.push({ label: '🦌 ' + rutNames[0] + ' rut', bg: 'rgba(200,100,50,0.1)', color: 'rgba(240,160,100,0.9)', border: 'rgba(200,100,50,0.2)' });
    }
    pillData.forEach(function(p) {
      var pill = document.createElement('div');
      pill.style.cssText = 'font-size:10px;font-weight:600;padding:4px 10px;border-radius:20px;background:' + p.bg + ';color:' + p.color + ';border:1px solid ' + p.border + ';';
      pill.textContent = p.label;
      heroPills.appendChild(pill);
    });
  }

  // ── Rows ──────────────────────────────────────────────────
  rowsEl.innerHTML = '';
  var lsMin = bannerState.legalStartMin !== null ? bannerState.legalStartMin : 5*60;
  var leMin = bannerState.legalEndMin   !== null ? bannerState.legalEndMin   : 19*60;

  results.forEach(function(r, i) {
    var isToday = i === 0;
    var isBest  = i === bestIdx;
    var row = document.createElement('div');
    row.style.cssText = 'border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;';

    var scoreColor = r.s.bestScore >= 65 ? '#7adf7a' : r.s.bestScore >= 45 ? '#f0c040' : '#e07020';
    var barColor   = r.s.bestScore >= 65 ? 'linear-gradient(90deg,#3abf3a,#7aef7a)'
                   : r.s.bestScore >= 45 ? 'linear-gradient(90deg,#c8a84b,#e0c050)'
                   : 'linear-gradient(90deg,#e07020,#e09040)';
    var dayLabel = isToday ? 'Today' : days[r.date.getDay()];
    var dayColor = isToday ? '#f0c870' : isBest ? '#7adf7a' : 'rgba(255,255,255,0.45)';
    var rowBg    = isBest ? 'rgba(90,220,90,0.05)' : isToday ? 'rgba(200,168,75,0.05)' : 'transparent';

    // Weather summary line — show min/max range, not average
    var wxSummary = '';
    if (r.s.wxDay) {
      var tMax = Math.round(r.s.wxDay.tempMax);
      var tMin = Math.round(r.s.wxDay.tempMin);
      var wMph  = Math.round(r.s.wxDay.windMax * 0.621);
      var precip2 = r.s.wxDay.precip || 0;
      var skyEmoji = wxCodeToEmoji(r.s.wxDay.wcode, precip2);
      var pEmoji   = precipEmoji(precip2);
      var pLabel   = precip2 <= 0 ? '0.0 mm' : precip2.toFixed(1) + ' mm';
      wxSummary = '<div style="display:flex;gap:10px;padding:0 16px 10px 56px;flex-wrap:wrap;">'
        + '<span style="display:flex;align-items:center;gap:3px;font-size:10px;color:rgba(255,255,255,0.45);"><span>🌡</span><span style="font-weight:600;color:rgba(255,255,255,0.7);">' + tMin + '–' + tMax + '°C</span></span>'
        + '<span style="display:flex;align-items:center;gap:3px;font-size:10px;color:rgba(255,255,255,0.45);"><span>🍃</span><span style="font-weight:600;color:rgba(255,255,255,0.7);">' + wMph + ' mph max</span></span>'
        + '<span style="display:flex;align-items:center;gap:3px;font-size:10px;color:rgba(255,255,255,0.45);"><span>' + skyEmoji + '</span><span style="font-weight:600;color:rgba(255,255,255,0.7);">' + conditionLabel(r.s.wxDay.wcode, precip2) + '</span></span>'
        + '<span style="display:flex;align-items:center;gap:3px;font-size:10px;color:rgba(255,255,255,0.45);"><span>' + pEmoji + '</span><span style="font-weight:600;color:rgba(255,255,255,0.7);">' + pLabel + ' total</span></span>'
        + '</div>';
    }

    // Compute legal times for this future day
    var dayLsMin = lsMin, dayLeMin = leMin;
    try {
      var sr2 = calcSunTime(r.date, bannerState.lat || 52, bannerState.lng || 0, true);
      var ss2 = calcSunTime(r.date, bannerState.lat || 52, bannerState.lng || 0, false);
      if (sr2 && ss2) {
        dayLsMin = toMinutes(sr2) - 60;
        dayLeMin = toMinutes(ss2) + 60;
      }
    } catch(e) {}

    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:10px 16px 6px;background:' + rowBg + ';">' +
        '<div style="width:36px;flex-shrink:0;">' +
          '<div style="font-size:10px;font-weight:700;color:' + dayColor + ';text-transform:uppercase;">' + dayLabel + '</div>' +
          '<div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.8);">' + r.date.getDate() + '</div>' +
        '</div>' +
        '<div style="width:18px;flex-shrink:0;font-size:14px;text-align:center;">' + r.s.moon.icon + '</div>' +
        '<div style="flex:1;display:flex;flex-direction:column;gap:3px;">' +
          '<div style="display:flex;align-items:center;gap:5px;">' +
            '<div style="font-size:8px;color:rgba(255,255,255,0.25);width:28px;flex-shrink:0;">Dawn</div>' +
            '<div style="flex:1;height:5px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">' +
              '<div style="height:100%;border-radius:3px;background:' + barColor + ';width:' + r.s.dawnScore + '%;"></div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:5px;">' +
            '<div style="font-size:8px;color:rgba(255,255,255,0.25);width:28px;flex-shrink:0;">Dusk</div>' +
            '<div style="flex:1;height:5px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">' +
              '<div style="height:100%;border-radius:3px;background:' + barColor + ';opacity:0.7;width:' + r.s.duskScore + '%;"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="width:34px;flex-shrink:0;text-align:right;font-size:13px;font-weight:700;color:' + scoreColor + ';font-variant-numeric:tabular-nums;">' + r.s.bestScore + '%</div>' +
        '<div style="width:16px;flex-shrink:0;text-align:center;font-size:10px;color:rgba(255,255,255,0.2);transition:transform 0.2s;" class="wf-chevron">\u25be</div>' +
      '</div>' +
      wxSummary +
      '<div class="wf-hourly" style="display:none;background:rgba(0,0,0,0.25);border-top:1px solid rgba(255,255,255,0.06);padding:12px 16px;">' +
        buildHourlyPanel(i, r.date, wxData, dayLsMin, dayLeMin) +
      '</div>';

    // Toggle hourly on tap
    (function(rowEl, chevronIdx) {
      rowEl.addEventListener('click', function() {
        var hourlyEl = rowEl.querySelector('.wf-hourly');
        var chevEl   = rowEl.querySelector('.wf-chevron');
        var isOpen   = hourlyEl.style.display !== 'none';
        hourlyEl.style.display = isOpen ? 'none' : 'block';
        if (chevEl) chevEl.style.transform = isOpen ? '' : 'rotate(180deg)';
      });
    })(row, i);

    rowsEl.appendChild(row);
  });
  if (rowsEl.lastChild) rowsEl.lastChild.style.borderBottom = 'none';
}

function toggleWeekForecast() {
  var panel = document.getElementById('week-forecast-panel');
  if (!panel) return;
  var isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    var bs = bannerState;
    if (bs.lat === null) return;
    buildWeekForecast(null);
    fetch7DayWeather(bs.lat, bs.lng, function(err, d) {
      if (!err && d) buildWeekForecast(d);
    });
  }
}
var _tickCount = 0;
function tick() {
  _tickCount++;
  updateBannerClock();
  if (_tickCount % 60 === 0) {   // every 60 seconds
    maybeRecalcSolar();
    updateMoon();
    renderTodayGlance();
    // Refresh activity panel if open
    var ap = document.getElementById('activity-panel');
    if (ap && ap.style.display !== 'none') updateActivityPanel();
  }
}

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  ui.updateOfflineBanner();
  updateMoon();
  highlightTodayMonth();
  updateSeasonStatuses();
  initBanner();
  initCalendar();
  setInterval(tick, 1000);

  // ── Header date ──────────────────────────────────────────────
  (function() {
    var now = new Date();
    var dayNames   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var dn = document.getElementById('header-dayname');
    var dd = document.getElementById('header-datenum');
    var dm = document.getElementById('header-month');
    if (dn) dn.textContent = dayNames[now.getDay()];
    if (dd) dd.textContent = now.getDate();
    if (dm) dm.textContent = monthNames[now.getMonth()] + ' ' + now.getFullYear();
    // Banner date
    var bday   = document.getElementById('banner-date-day');
    var bnum   = document.getElementById('banner-date-num');
    var bmonth = document.getElementById('banner-date-month');
    var byear  = document.getElementById('banner-date-year');
    if (bday)   bday.textContent   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()];
    if (bnum)   bnum.textContent   = now.getDate();
    if (bmonth) bmonth.textContent = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][now.getMonth()];
    if (byear)  byear.textContent  = now.getFullYear();
  }());

  // First-launch disclaimer
  try {
    if (!localStorage.getItem('firstlight_disclaimer_seen')) {
      var fm = document.getElementById('first-launch-modal');
      if (fm) fm.style.display = 'flex';
    }
  } catch(e) {}

  var acceptBtn = document.getElementById('first-launch-accept');
  if (acceptBtn) {
    acceptBtn.addEventListener('click', function() {
      try { localStorage.setItem('firstlight_disclaimer_seen', 'true'); } catch(e) {}
      var fm = document.getElementById('first-launch-modal');
      if (fm) fm.style.display = 'none';
    });
  }

  // Keyboard support for deer cards
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      var header = e.target.closest('.card-header');
      if (header) { e.preventDefault(); toggleCard(header.closest('.deer-card')); }
    }
  });
});

// ════════════════════════════════════════════════════════════════
// FEATURE 1: DEER ACTIVITY FORECAST
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// FEATURE 1: DEER ACTIVITY FORECAST — enhanced multi-factor model
// Factors: time of day, moon phase, solunar, rut calendar,
//          temperature, barometric pressure, wind speed,
//          seasonal body condition
// ════════════════════════════════════════════════════════════════

// Rut calendar: peak activity boost per species per month (0=none, 30=peak)
// Species: [Red, Fallow, Sika, Roe, CWD]
// Sources: BDS, BASC, Deer Initiative
var RUT_SPECIES = ['Red', 'Fallow', 'Sika', 'Roe', 'CWD'];
var RUT_CALENDAR = {
  1:  [0,  0,  0,  0,  15],
  2:  [0,  0,  0,  0,  5 ],
  3:  [0,  0,  0,  0,  0 ],
  4:  [0,  0,  0,  0,  0 ],
  5:  [0,  0,  0,  5,  0 ],
  6:  [0,  0,  0,  15, 0 ],
  7:  [0,  0,  0,  30, 0 ],
  8:  [5,  0,  0,  20, 0 ],
  9:  [20, 5,  5,  0,  0 ],
  10: [30, 30, 15, 0,  0 ],
  11: [15, 20, 30, 0,  20],
  12: [0,  5,  15, 0,  30],
};

// Cached weather data
var _weatherCache = { data: null, ts: 0, lat: null, lng: null };

// Fetch weather from Open-Meteo (free, no API key)
function fetchWeather(lat, lng, cb) {
  var now = Date.now();
  // Cache for 20 minutes or same location
  if (_weatherCache.data && (now - _weatherCache.ts < 20*60*1000)
      && _weatherCache.lat === lat && _weatherCache.lng === lng) {
    return cb(null, _weatherCache.data);
  }
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat
    + '&longitude=' + lng
    + '&current=temperature_2m,wind_speed_10m,wind_direction_10m,windgusts_10m,surface_pressure,cloud_cover,weather_code,precipitation'
    + '&hourly=surface_pressure,precipitation,temperature_2m&past_hours=6&forecast_days=1&timezone=auto';
  fetch(url)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var c = d.current;
      // Get pressure 3 hours ago from hourly to compute trend
      var pressures = (d.hourly && d.hourly.surface_pressure) ? d.hourly.surface_pressure : [];
      var curHour = ukNowHour(); // UK time — matches Open-Meteo timezone=auto=Europe/London
      // With past_hours=6, array index = past_hours_offset + hour_of_day
      // Index 0..5 = yesterday's last 6hrs, index 6 = today 00:00, index 6+curHour = now
      var PAST = 6; // must match past_hours in URL
      var pNow  = pressures[PAST + curHour] || pressures[curHour] || c.surface_pressure;
      var p3ago = pressures[PAST + curHour - 3] || pressures[Math.max(0, curHour - 3)] || pNow;
      var pressureTrend = pNow - p3ago; // positive = rising, negative = falling
      // Post-rain detection: was it raining 1-2 hrs ago but not now?
      var precipHourly = (d.hourly && d.hourly.precipitation) ? d.hourly.precipitation : [];
      var precip1hAgo  = precipHourly[PAST + curHour - 1] || 0;
      var precip2hAgo  = precipHourly[PAST + curHour - 2] || 0;
      var recentRain   = Math.max(precip1hAgo, precip2hAgo);
      var postRain     = (c.precipitation < 0.1) && (recentRain > 0.5);
      // Temperature drop: compare now vs 6 hours ago using past_hours offset
      var temps6h       = (d.hourly && d.hourly.temperature_2m) ? d.hourly.temperature_2m : [];
      var tempNow       = c.temperature_2m;
      // PAST offset: index PAST+curHour = now, index PAST+curHour-6 = 6hrs ago (always valid ≥0)
      var temp6hAgo     = temps6h[PAST + curHour - 6] !== undefined ? temps6h[PAST + curHour - 6] : tempNow;
      var tempDrop6h    = temp6hAgo - tempNow; // positive = temp has fallen
      // Frost: sub-zero in last 6hrs (past_hours window gives full 6hr history)
      var tempMin6h     = temps6h.slice(PAST + curHour - 6, PAST + curHour + 1).reduce(function(a,b){ return Math.min(a, b !== undefined ? b : 99); }, 99);
      var isFrost       = tempNow <= 1; // near-freezing or below (tempMin6h used only for wx object completeness)
      // Wind consistency: gust vs sustained ratio — swirling wind disrupts scent control
      var windSustained = c.wind_speed_10m || 0;
      var windGust      = c.windgusts_10m  || windSustained;
      var gustRatio     = windSustained > 2 ? (windGust - windSustained) / windSustained : 0;
      // gustRatio: 0 = perfectly steady, 1.0 = gusts double sustained (very gusty)
      var wx = {
        temp:          c.temperature_2m,
        tempDrop6h:    tempDrop6h,
        isFrost:       isFrost,
        windSpeed:     c.wind_speed_10m,   // km/h
        windGust:      windGust,           // km/h
        windDir:       c.wind_direction_10m,
        gustRatio:     gustRatio,
        pressure:      c.surface_pressure,
        pressureTrend: pressureTrend,
        cloudCover:    c.cloud_cover,
        weatherCode:   c.weather_code,
        precipitation: c.precipitation,
        postRain:      postRain,
        recentRainMm:  recentRain
      };
      _weatherCache = { data: wx, ts: Date.now(), lat: lat, lng: lng };
      cb(null, wx);
    })
    .catch(function(e) { cb(e, null); });
}

// Solunar calculation — moon overhead/underfoot periods
// Based on gravitational pull theory (Knight 1936, supported by Demarais et al)
function getSolunar(date, lat, lng) {
  var moon = getMoonPhase(date);
  // Moon transit time: shifts ~50 min later each day from solar noon at new moon
  // Each lunar day = 24h 50min = 1490 min, so transit moves 50 min/day
  var SHIFT_PER_DAY = 50; // minutes per day
  var transitMin    = (12 * 60 + moon.age * SHIFT_PER_DAY) % (24 * 60);
  var underfootMin  = (transitMin + 12 * 60 + 25) % (24 * 60);
  // Major periods: ±60 min around transit and underfoot (2hr window each)
  // Minor periods: midpoints between majors (±30 min = 1hr window each)
  var minor1 = (transitMin   + 6 * 60 + 12) % (24 * 60);
  var minor2 = (underfootMin + 6 * 60 + 12) % (24 * 60);
  return {
    major1: { start: (transitMin   - 60 + 1440) % 1440, peak: transitMin,   end: (transitMin   + 60) % 1440 },
    major2: { start: (underfootMin - 60 + 1440) % 1440, peak: underfootMin, end: (underfootMin + 60) % 1440 },
    minor1: { start: (minor1 - 30 + 1440) % 1440, peak: minor1, end: (minor1 + 30) % 1440 },
    minor2: { start: (minor2 - 30 + 1440) % 1440, peak: minor2, end: (minor2 + 30) % 1440 }
  };
}

function fmtMins(m) {
  if (m === null || m === undefined) return '--:--';
  var mm = ((Math.round(m) % 1440) + 1440) % 1440;
  var h = Math.floor(mm / 60), mn = mm % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mn < 10 ? '0' : '') + mn;
}

function getDeerActivityScore(wx) {
  var now = new Date();
  var month = now.getMonth() + 1;
  var moon = getMoonPhase(now);
  var bs = bannerState;
  var score = 0;
  var factors = [];
  var wxFactors = []; // weather factors shown in strip separately

  // ── Time of day (max 40pts) ──────────────────────────────
  var curMin = ukNowMin();
  var srMin = bs.sunriseMin !== null ? bs.sunriseMin : (6 * 60);
  var ssMin = bs.sunsetMin  !== null ? bs.sunsetMin  : (20 * 60);

  var dawnStart = srMin - 60;
  var dawnEnd   = srMin + 120;
  var duskStart = ssMin - 90;
  var duskEnd   = ssMin + 45;  // 45 mins after sunset

  var SVG_DAWN = '<svg width="18" height="14" viewBox="0 0 28 22" xmlns="http://www.w3.org/2000/svg" style="display:inline;vertical-align:middle;"><path d="M0,22 Q4,14 8,16 Q11,18 14,13 Q17,8 20,12 Q23,15 28,11 L28,22 Z" fill="#3a5a2a" opacity="0.85"/><path d="M0,22 Q5,17 9,19 Q13,21 16,17 Q19,14 24,18 Q26,19 28,17 L28,22 Z" fill="#2a4a1a" opacity="0.9"/><circle cx="14" cy="13" r="5" fill="#f5b830" opacity="0.95"/><g stroke="#f5b830" stroke-width="1.2" stroke-linecap="round" opacity="0.7"><line x1="14" y1="6" x2="14" y2="4"/><line x1="18.5" y1="7.5" x2="19.8" y2="6.2"/><line x1="9.5" y1="7.5" x2="8.2" y2="6.2"/></g></svg>';
  var SVG_DUSK = '<svg width="18" height="14" viewBox="0 0 28 22" xmlns="http://www.w3.org/2000/svg" style="display:inline;vertical-align:middle;"><ellipse cx="14" cy="16" rx="12" ry="4" fill="#e06010" opacity="0.3"/><circle cx="14" cy="16" r="5" fill="#e87820" opacity="0.95"/><path d="M0,22 Q4,13 8,15 Q11,17 14,12 Q17,7 20,11 Q23,14 28,10 L28,22 Z" fill="#2a3a1a" opacity="0.9"/><path d="M0,22 Q5,16 9,18 Q13,20 16,16 Q19,13 24,17 Q26,18 28,16 L28,22 Z" fill="#1a2a0f" opacity="0.95"/></svg>';

  if (inWindow(curMin, dawnStart, dawnEnd)) {
    score += 40;
    factors.push({ icon: SVG_DAWN, text: 'Dawn window — peak deer movement', good: true });
  } else if (inWindow(curMin, duskStart, duskEnd)) {
    score += 40;
    factors.push({ icon: SVG_DUSK, text: 'Dusk window — peak deer movement', good: true });
  } else if (inWindow(curMin, dawnEnd, duskStart)) {
    score += 8;
    factors.push({ icon: '☀️', text: 'Midday — deer movement reduced', good: false });
  } else {
    score += 8; // Night: new moon / rut / weather can still push score meaningfully
    factors.push({ icon: '🌙', text: 'Night — deer resting, minimal movement', good: false });
  }
  var isNight = !inWindow(curMin, dawnStart, duskEnd);

  // ── Moon phase (max 15pts) ───────────────────────────────
  // Moon phase — reduced weights (peer-reviewed studies show modest daytime effect)
  var moonBoost, moonIcon, moonText, moonGood;
  if (moon.illumination < 15) {
    moonBoost = 8; moonIcon = '🌑'; moonGood = true;
    moonText = 'New moon (' + moon.illumination + '% lit) — low overnight feeding, deer keener at dawn & dusk';
  } else if (moon.illumination < 40) {
    moonBoost = 6; moonIcon = '🌒'; moonGood = true;
    moonText = 'Crescent moon (' + moon.illumination + '% lit) — favourable conditions';
  } else if (moon.illumination < 60) {
    moonBoost = 4; moonIcon = '🌓'; moonGood = null;
    moonText = 'Quarter moon (' + moon.illumination + '% lit) — average movement';
  } else if (moon.illumination < 85) {
    moonBoost = 2; moonIcon = '🌔'; moonGood = null;
    moonText = 'Gibbous moon (' + moon.illumination + '% lit) — some nocturnal feeding likely';
  } else {
    moonBoost = 1; moonIcon = '🌕'; moonGood = false;
    moonText = 'Full moon (' + moon.illumination + '% lit) — deer may have fed overnight, daytime movement reduced';
  }
  score += isNight ? Math.round(moonBoost * 0.3) : moonBoost;
  factors.push({ icon: moonIcon, text: moonText, good: moonGood });

  // ── Solunar (max 8pts) ───────────────────────────────────
  var sol = getSolunar(now, bs.lat || 52, bs.lng || 0);
  var inMajor = inWindow(curMin, sol.major1.start, sol.major1.end) ||
                inWindow(curMin, sol.major2.start, sol.major2.end);
  var inMinor = inWindow(curMin, sol.minor1.start, sol.minor1.end) ||
                inWindow(curMin, sol.minor2.start, sol.minor2.end);
  // Solunar — reduced (major +3, minor +1; gravitational effect on deer contested)
  if (inMajor) {
    score += 3;
    factors.push({ icon: '🌕', text: 'Solunar peak — moon overhead or underfoot (some evidence of elevated movement)', good: null });
  } else if (inMinor) {
    score += 1;
    factors.push({ icon: '🌗', text: 'Solunar minor period — moon at 90°, modest activity indicator', good: null });
  }

  // ── Rut calendar (max 15pts) ─────────────────────────────
  var rutMonths = RUT_CALENDAR[month] || [0,0,0,0,0];
  var maxRut = Math.max.apply(null, rutMonths);
  if (maxRut >= 25) {
    var peakNames = RUT_SPECIES.filter(function(_, i) { return rutMonths[i] >= 25; });
    score += 15;
    factors.push({ icon: '🦌', text: peakNames.join(' & ') + ' rut — heightened daytime activity', good: true });
  } else if (maxRut >= 10) {
    var activeNames = RUT_SPECIES.filter(function(_, i) { return rutMonths[i] >= 10; });
    score += 8;
    factors.push({ icon: '🦌', text: activeNames.join(' & ') + ' rut building — elevated movement', good: true });
  } else if (maxRut > 0) {
    score += 3;
    factors.push({ icon: '🦌', text: 'Pre/post rut — residual activity', good: null });
  }

  // ── Seasonal body condition modifier (max 5pts) ──────────
  // Sources: Clutton-Brock et al, BDS seasonal behaviour notes
  var seasonBoost = 0;
  if (month === 2) {
    seasonBoost = 5; // Late winter nutritional stress — deer feed aggressively
  } else if (month === 3) {
    seasonBoost = 3; // Early spring recovery — some residual winter stress
  } else if (month === 9 || month === 10) {
    seasonBoost = 4; // Pre-rut energy build
  } else if (month === 11) {
    seasonBoost = 2; // Post-rut recovery — deer tired but still feeding
  } else if (month === 6 || month === 7 || month === 8) {
    seasonBoost = -3; // Summer heat suppresses movement
  }
  score += seasonBoost;
  if (seasonBoost > 0 && month === 2) {
    factors.push({ icon: '❄️', text: 'Late winter — deer feeding intensively to survive, movement elevated', good: true });
  } else if (seasonBoost > 0 && month === 3) {
    factors.push({ icon: '🌱', text: 'Early spring — residual winter stress, deer actively feeding', good: true });
  } else if (seasonBoost > 0 && month === 11) {
    factors.push({ icon: '🍂', text: 'Post-rut — deer exhausted but feeding to recover condition', good: null });
  } else if (seasonBoost > 0) {
    factors.push({ icon: '🍂', text: 'Pre-rut season — bucks building energy, increased movement', good: true });
  } else if (seasonBoost < 0) {
    factors.push({ icon: '☀️', text: 'Summer heat — movement concentrated at dawn & dusk only', good: null });
  }

  // ── Weather factors (max 22pts total) ───────────────────
  if (wx) {
    // Temperature (max 6pts)
    // Optimal: 4–12°C. Cold snap bonus. Heat penalty.
    var tempScore = 0, tempText = '', tempGood = null;
    var t = wx.temp;
    if (t <= 0) {
      tempScore = 4; tempText = 'Freezing (' + t + '°C) — deer feeding to maintain warmth';
      tempGood = true;
    } else if (t <= 8) {
      tempScore = 6; tempText = 'Cool (' + t + '°C) — ideal temperature for deer movement';
      tempGood = true;
    } else if (t <= 14) {
      tempScore = 3; tempText = 'Mild (' + t + '°C) — moderate deer movement';
      tempGood = null;
    } else if (t <= 18) {
      tempScore = 0; tempText = 'Warm (' + t + '°C) — movement somewhat suppressed';
      tempGood = false;
    } else {
      tempScore = -3; tempText = 'Hot (' + t + '°C) — deer sheltering, movement suppressed';
      tempGood = false;
    }
    // Frost bonus: hard frost = deer must feed aggressively to maintain warmth
    // t <= 1°C triggers bonus (near-freezing consistent with hourly layer)
    if (wx.temp <= 1) {
      var frostBonus = wx.temp < -1 ? 4 : wx.temp <= 0 ? 2 : 1; // hard / freezing / near-frost
      tempScore += frostBonus;
      tempText += wx.temp < -1
        ? ' — hard frost, deer feeding intensively to stay warm'
        : wx.temp <= 0
          ? ' — frost conditions, deer actively feeding at first light'
          : ' — near-freezing, cool conditions favour movement';
      tempGood = true;
    }

    score += tempScore;
    wxFactors.push({ icon: '🌡️', text: tempText, good: tempGood,
      wxLabel: 'Temp', wxVal: t + '°C',
      wxSub: tempGood === true ? 'Favourable' : tempGood === false ? 'Suppressing' : 'Neutral',
      wxClass: tempGood === true ? 'good' : tempGood === false ? 'bad' : 'mid' });

    // Temperature drop trigger (+3 for sharp drop, +1 for moderate drop)
    // Research: Kammermeyer & Marchinton 1976 — temp drop triggers pre-frontal feeding
    if (wx.tempDrop6h !== undefined) {
      var dropScore = 0, dropText = '';
      if (wx.tempDrop6h >= 5) {
        dropScore = 3;
        dropText = 'Temperature falling sharply (' + wx.tempDrop6h.toFixed(1) + '°C drop in 6hrs) — deer feeding ahead of cold front';
      } else if (wx.tempDrop6h >= 3) {
        dropScore = 1;
        dropText = 'Temperature dropping (' + wx.tempDrop6h.toFixed(1) + '°C in 6hrs) — slight uptick in movement';
      }
      if (dropScore > 0) {
        score += dropScore;
        factors.push({ icon: '❄️', text: dropText, good: true });
      }
    }

    // Barometric pressure trend (max 8pts — strongest predictor)
    var pressScore = 0, pressText = '', pressGood = null;
    var pt = wx.pressureTrend; // change over 3hrs in hPa
    if (pt < -2) {
      pressScore = 8; pressText = 'Pressure falling sharply (' + wx.pressure.toFixed(0) + ' hPa) — pre-front feeding surge';
      pressGood = true;
    } else if (pt < -0.5) {
      pressScore = 5; pressText = 'Pressure falling (' + wx.pressure.toFixed(0) + ' hPa) — increased deer movement';
      pressGood = true;
    } else if (pt > 2) {
      pressScore = -2; pressText = 'Pressure rising sharply (' + wx.pressure.toFixed(0) + ' hPa) — settled conditions, less urgency';
      pressGood = false;
    } else if (pt > 0.5) {
      pressScore = 0; pressText = 'Pressure steady/rising (' + wx.pressure.toFixed(0) + ' hPa) — normal conditions';
      pressGood = null;
    } else {
      pressScore = 1; pressText = 'Pressure stable (' + wx.pressure.toFixed(0) + ' hPa) — routine movement expected';
      pressGood = null;
    }
    score += pressScore;
    var trendStr = pt < -0.5 ? '↓ ' : pt > 0.5 ? '↑ ' : '→ ';
    wxFactors.push({ icon: '📉', text: pressText, good: pressGood,
      wxLabel: 'Pressure', wxVal: trendStr + wx.pressure.toFixed(0),
      wxSub: pressGood === true ? 'Falling ✓' : pressGood === false ? 'Rising ✗' : 'Stable',
      wxClass: pressGood === true ? 'good' : pressGood === false ? 'bad' : 'mid' });

    // Wind speed (max 6pts)
    var windKmh = wx.windSpeed;
    var windMph = Math.round(windKmh * 0.621);
    var windScore = 0, windText = '', windGood = null;
    if (windMph <= 8) {
      windScore = 6; windText = 'Calm wind (' + windMph + ' mph) — deer moving freely';
      windGood = true;
    } else if (windMph < 20) {
      windScore = 3; windText = 'Light breeze (' + windMph + ' mph) — minimal impact on movement';
      windGood = null;
    } else if (windMph < 35) {
      windScore = -2; windText = 'Moderate wind (' + windMph + ' mph) — deer more cautious';
      windGood = false;
    } else {
      windScore = -5; windText = 'Strong wind (' + windMph + ' mph) — deer hunkered down, poor conditions';
      windGood = false;
    }
    score += windScore;
    // Wind consistency: append gust info to wind label if available
    var gustMph = wx.windGust ? Math.round(wx.windGust * 0.621) : null;
    var windVal = windMph + ' mph' + (gustMph && gustMph > windMph ? ' (gusts ' + gustMph + ')' : '');
    wxFactors.push({ icon: '🍃', text: windText, good: windGood,
      wxLabel: 'Wind', wxVal: windVal,
      wxSub: windGood === true ? 'Calm ✓' : windGood === false ? 'High ✗' : 'Moderate',
      wxClass: windGood === true ? 'good' : windGood === false ? 'bad' : 'mid' });

    // Wind consistency (gust ratio) — swirling/gusty wind disrupts scent control
    // Only score if wind is at least light (>5mph sustained) — calm wind has no consistency issue
    if (wx.gustRatio !== undefined && windMph > 5) {
      var gustScore = 0, gustText = '';
      if (wx.gustRatio > 0.8) {
        gustScore = -4;
        gustText = 'Very gusty — wind swirling (' + windMph + ' sustained, ' + gustMph + ' gusts), scent control unreliable';
      } else if (wx.gustRatio > 0.5) {
        gustScore = -2;
        gustText = 'Gusty wind — direction inconsistent, approach planning difficult';
      } else if (wx.gustRatio > 0.3) {
        gustScore = -1;
        gustText = 'Some wind variation — scent cone less predictable than ideal';
      } else if (wx.gustRatio <= 0.15 && windMph > 5) {
        gustScore = 1;
        gustText = 'Wind holding steady — scent cone predictable, good for approach planning';
      }
      if (gustScore !== 0) {
        score += gustScore;
        factors.push({ icon: '🌬️', text: gustText, good: gustScore > 0 ? true : false });
      }
    }

    // Precipitation (cloud/rain)
    var rainScore = 0, rainText = '', rainGood = null;
    var wc = wx.weatherCode;
    var precip = wx.precipitation || 0;
    if (wx.postRain) {
      rainScore = 4; rainText = 'Post-rain — ' + wx.recentRainMm.toFixed(1) + 'mm in last 2hrs, deer moving freely now rain has stopped';
      rainGood = true;
    } else if (precip > 5 || (wc >= 61 && wc <= 67) || (wc >= 80 && wc <= 82)) {
      rainScore = -4; rainText = 'Heavy rain — deer sheltering, movement suppressed';
      rainGood = false;
    } else if (precip > 0.5 || (wc >= 51 && wc <= 57)) {
      rainScore = 2; rainText = 'Light rain/drizzle — deer often more active in light rain';
      rainGood = true;
    } else if (wx.cloudCover > 70) {
      rainScore = 2; rainText = 'Overcast (' + wx.cloudCover + '% cloud) — diffuse light, deer more active';
      rainGood = true;
    } else if (wx.cloudCover < 20) {
      rainScore = 0; rainText = 'Clear sky (' + wx.cloudCover + '% cloud) — bright conditions';
      rainGood = null;
    } else {
      rainScore = 1; rainText = 'Partly cloudy (' + wx.cloudCover + '%) — good conditions';
      rainGood = null;
    }
    score += rainScore;
    var rainLabel = wx.postRain ? 'Post-rain ✓' : precip > 5 ? 'Heavy rain' : precip > 0.5 ? 'Light rain' : wx.cloudCover > 70 ? 'Overcast' : wx.cloudCover < 20 ? 'Clear' : 'Partly cloudy';
    wxFactors.push({ icon: '☁️', text: rainText, good: rainGood,
      wxLabel: 'Sky', wxVal: rainLabel,
      wxSub: rainGood === true ? 'Good ✓' : rainGood === false ? 'Poor ✗' : 'Neutral',
      wxClass: rainGood === true ? 'good' : rainGood === false ? 'bad' : 'mid' });

    // Add weather factors to main factors list
    wxFactors.forEach(function(wf) { factors.push(wf); });
  }

  // Max without weather: 40+8+3+15+5 = 71
  // Max with weather: 71+6+8+6+2 = 93, capped at 100
  // (moon reduced from 15→8, solunar from 8→3 based on evidence weighting)
  score = Math.min(100, Math.max(0, score));

  return {
    score: score, factors: factors, moon: moon,
    wx: wx, wxFactors: wxFactors,
    sol: getSolunar(now, bs.lat || 52, bs.lng || 0),
    srMin: srMin, ssMin: ssMin,
    dawnStart: dawnStart, dawnEnd: dawnEnd,
    duskStart: duskStart, duskEnd: duskEnd,
    curMin: curMin
  };
}

function updateActivityPanel(wx) {
  var result = getDeerActivityScore(wx || null);
  var bar = document.getElementById('activity-bar');
  var scoreEl = document.getElementById('activity-score');
  var labelEl = document.getElementById('activity-label');
  var factorsEl = document.getElementById('activity-factors');
  var pip = document.getElementById('activity-pip');
  if (!bar) return;

  bar.style.width = result.score + '%';
  if (result.score >= 65) {
    bar.style.background = 'linear-gradient(90deg,#5adf5a,#c8e050)';
    if (pip) { pip.style.background='#5adf5a'; pip.style.boxShadow='0 0 6px #5adf5a'; }
  } else if (result.score >= 45) {
    bar.style.background = 'linear-gradient(90deg,#c8a84b,#e0c050)';
    if (pip) { pip.style.background='#c8a84b'; pip.style.boxShadow='0 0 6px #c8a84b'; }
  } else if (result.score >= 20) {
    bar.style.background = 'linear-gradient(90deg,#e07020,#e09040)';
    if (pip) { pip.style.background='#e07020'; pip.style.boxShadow='0 0 6px #e07020'; }
  } else {
    bar.style.background = 'linear-gradient(90deg,#666,#888)';
    if (pip) { pip.style.background='#666'; pip.style.boxShadow='none'; }
  }

  scoreEl.textContent = result.score + '%';

  // Update badge on moon widget
  var badge = document.getElementById('activity-score-badge');
  if (badge) {
    badge.textContent = '🦌 ' + result.score + '%';
    badge.style.display = 'block';
  }
  var isNightNow = result.curMin !== undefined &&
    !inWindow(result.curMin, result.dawnStart, result.duskEnd);

  var label;
  if (isNightNow) {
    // Night: max possible ~35% so use different scale
    label = result.score >= 28 ? '🟢 Excellent dawn forecast'
          : result.score >= 20 ? '🟡 Good dawn forecast'
          : result.score >= 12 ? '🟠 Average dawn forecast'
          :                      '⚫ Poor dawn forecast';
  } else {
    label = result.score >= 65 ? '🟢 High Activity Expected'
          : result.score >= 45 ? '🟡 Moderate Activity'
          : result.score >= 20 ? '🟠 Low Activity'
          :                      '⚫ Minimal Activity';
  }
  labelEl.textContent = label;

  // ── Weather strip ──────────────────────────────────────────
  var wxStripEl = document.getElementById('activity-wx-strip');
  var wxLabelEl = document.getElementById('activity-wx-label');
  if (wxStripEl) {
    if (result.wx) {
      if (wxLabelEl) wxLabelEl.style.display = 'block';
      wxStripEl.style.display = 'grid';
      wxStripEl.innerHTML = '';
      result.wxFactors.forEach(function(wf) {
        var cell = document.createElement('div');
        var clsMap = { good:'rgba(90,220,90,0.08);border:1px solid rgba(90,220,90,0.2);',
                       bad: 'rgba(255,100,100,0.07);border:1px solid rgba(255,100,100,0.15);',
                       mid: 'rgba(200,168,75,0.08);border:1px solid rgba(200,168,75,0.2);',
                       '': 'rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);' };
        var bg = clsMap[wf.wxClass] || clsMap[''];
        cell.style.cssText = 'background:' + bg + 'border-radius:10px;padding:7px 8px;display:flex;flex-direction:column;gap:2px;';
        var subColor = wf.wxClass === 'good' ? '#7adf7a' : wf.wxClass === 'bad' ? '#ff8080' : '#f0c870';
        cell.innerHTML = '<div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:rgba(255,255,255,0.35);">' + wf.wxLabel + '</div>'
          + '<div style="font-size:14px;font-weight:700;color:white;">' + wf.wxVal + '</div>'
          + '<div style="font-size:9px;color:' + subColor + ';">' + wf.wxSub + '</div>';
        wxStripEl.appendChild(cell);
      });
    } else {
      wxStripEl.style.display = 'none';
      if (wxLabelEl) wxLabelEl.style.display = 'none';
    }
  }

  // ── Factors ────────────────────────────────────────────────
  factorsEl.innerHTML = '';
  // Only show non-weather factors here (weather shown in strip)
  var mainFactors = result.factors.filter(function(f) { return !f.wxLabel; });
  mainFactors.forEach(function(f) {
    var div = document.createElement('div');
    div.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:12px;padding:4px 0;border-top:1px solid rgba(255,255,255,0.08);';
    var ico = document.createElement('span');
    ico.style.cssText = 'display:inline-flex;align-items:center;flex-shrink:0;';
    if (f.icon && f.icon.startsWith('<')) ico.innerHTML = f.icon;
    else ico.textContent = f.icon;
    var txt = document.createElement('span');
    txt.textContent = f.text;
    txt.style.color = f.good === true ? 'rgba(180,240,160,0.9)'
                    : f.good === false ? 'rgba(255,180,160,0.8)'
                    : 'rgba(255,255,255,0.6)';
    div.appendChild(ico);
    div.appendChild(txt);
    factorsEl.appendChild(div);
  });

  // ── Timeline ──────────────────────────────────────────────
  var curMin2    = result.curMin    || ukNowMin();
  var dawnStart2 = result.dawnStart !== undefined ? result.dawnStart : (5 * 60 + 17);
  var dawnEnd2   = result.dawnEnd   !== undefined ? result.dawnEnd   : (8 * 60 + 17);
  var duskStart2 = result.duskStart !== undefined ? result.duskStart : (17 * 60);
  var duskEnd2   = result.duskEnd   !== undefined ? result.duskEnd   : (19 * 60);
  var MINS_DAY = 1440;

  function pct(min) {
    var v = ((Math.round(min) % MINS_DAY) + MINS_DAY) % MINS_DAY;
    return (v / MINS_DAY * 100).toFixed(2) + '%';
  }
  function wPct(start, end) {
    var s = ((Math.round(start) % MINS_DAY) + MINS_DAY) % MINS_DAY;
    var e = ((Math.round(end)   % MINS_DAY) + MINS_DAY) % MINS_DAY;
    var w = e > s ? e - s : (MINS_DAY - s + e); // handle midnight wrap
    return (w / MINS_DAY * 100).toFixed(2) + '%';
  }
  function inWin(cur, s, e) { return cur >= s && cur <= e; }

  var dawnSeg = document.getElementById('tl-dawn-seg');
  var duskSeg = document.getElementById('tl-dusk-seg');
  var nowLine = document.getElementById('tl-now-line');
  var sol1Seg = document.getElementById('tl-sol1-seg');
  var sol2Seg = document.getElementById('tl-sol2-seg');

  if (dawnSeg) { dawnSeg.style.left = pct(dawnStart2); dawnSeg.style.width = wPct(dawnStart2, dawnEnd2); }
  if (duskSeg) { duskSeg.style.left = pct(duskStart2); duskSeg.style.width = wPct(duskStart2, duskEnd2); }
  if (nowLine) { nowLine.style.left = pct(curMin2); }

  // Solunar markers on timeline
  var sol = result.sol;
  if (sol && sol1Seg) { sol1Seg.style.left = pct(sol.major1.start); sol1Seg.style.width = wPct(sol.major1.start, sol.major1.end); }
  if (sol && sol2Seg) { sol2Seg.style.left = pct(sol.major2.start); sol2Seg.style.width = wPct(sol.major2.start, sol.major2.end); }

  // Dawn chip
  var dawnLabel = document.getElementById('tl-dawn-chip-label');
  var dawnTime  = document.getElementById('tl-dawn-chip-time');
  var dawnChip  = document.getElementById('tl-dawn-chip');
  var dawnActive = inWin(curMin2, dawnStart2, dawnEnd2);
  if (dawnChip) { dawnChip.style.background = dawnActive ? 'rgba(240,192,64,0.15)' : 'rgba(255,255,255,0.05)'; dawnChip.style.border = dawnActive ? '1px solid rgba(240,192,64,0.3)' : '1px solid rgba(255,255,255,0.08)'; }
  if (dawnLabel) dawnLabel.textContent = 'Dawn peak' + (dawnActive ? ' ● Now' : '');
  if (dawnTime)  dawnTime.textContent  = fmtMins(dawnStart2) + ' – ' + fmtMins(dawnEnd2);

  // Dusk chip
  var duskLabel = document.getElementById('tl-dusk-chip-label');
  var duskTime  = document.getElementById('tl-dusk-chip-time');
  var duskChip  = document.getElementById('tl-dusk-chip');
  var duskActive = inWin(curMin2, duskStart2, duskEnd2);
  if (duskChip) { duskChip.style.background = duskActive ? 'rgba(240,144,32,0.15)' : 'rgba(255,255,255,0.05)'; duskChip.style.border = duskActive ? '1px solid rgba(240,144,32,0.3)' : '1px solid rgba(255,255,255,0.08)'; }
  if (duskLabel) duskLabel.textContent = 'Dusk peak' + (duskActive ? ' ● Now' : '');
  if (duskTime)  duskTime.textContent  = fmtMins(duskStart2) + ' – ' + fmtMins(duskEnd2);

  // Solunar chips
  var sol1Label = document.getElementById('tl-sol1-label');
  var sol1Time  = document.getElementById('tl-sol1-time');
  var sol2Label = document.getElementById('tl-sol2-label');
  var sol2Time  = document.getElementById('tl-sol2-time');
  if (sol1Label) sol1Label.textContent = 'Solunar peak · Moon overhead';
  if (sol1Time)  sol1Time.textContent  = fmtMins(sol.major1.peak);
  if (sol2Label) sol2Label.textContent = 'Solunar peak · Moon underfoot';
  if (sol2Time)  sol2Time.textContent  = fmtMins(sol.major2.peak);
}


function toggleActivityPanel() {
  var panel = document.getElementById('activity-panel');
  var wfPanel = document.getElementById('week-forecast-panel');
  if (!panel) return;
  var isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  if (wfPanel) wfPanel.style.display = isHidden ? 'block' : 'none';
  if (isHidden) {
    // Show loading state in wx strip
    var wxStrip = document.getElementById('activity-wx-strip');
    var wxLabel = document.getElementById('activity-wx-label');
    if (wxStrip && bannerState.lat !== null) {
      if (wxLabel) { wxLabel.style.display = 'block'; wxLabel.textContent = 'Live weather · Loading…'; }
      wxStrip.style.display = 'grid';
      wxStrip.innerHTML = '<div style="grid-column:1/-1;font-size:11px;color:rgba(255,255,255,0.3);padding:6px 0;">Fetching weather data…</div>';
    }
    if (bannerState.lat !== null) {
      // Fetch current weather for live panel
      fetchWeather(bannerState.lat, bannerState.lng, function(err, wx) {
        if (!err && wx) {
          if (wxLabel) wxLabel.textContent = 'Live weather · Open-Meteo';
          updateActivityPanel(wx);
          // Sync badge with weather-enhanced score
          var badge = document.getElementById('activity-score-badge');
          var result = getDeerActivityScore(wx);
          if (badge) badge.textContent = '🦌 ' + result.score + '%';
        } else {
          if (wxLabel) { wxLabel.style.display = 'block'; wxLabel.textContent = 'Weather unavailable · score based on moon, rut & season'; }
          if (wxStrip) wxStrip.style.display = 'none';
          // Still show score from non-weather factors
          updateActivityPanel(null);
        }
      });
      // Fetch 7-day weather forecast
      buildWeekForecast(null);
      fetch7DayWeather(bannerState.lat, bannerState.lng, function(err, d) {
        if (!err && d) buildWeekForecast(d);
      });
    }
  }
}


// ── block ──

// ── Location picker (item 1, 3, 6, 7, 8, 10) ─────────────────

ui._modalTrigger = null;

ui.openLocationPicker = function() {
  ui._modalTrigger = document.activeElement;
  var modal = document.getElementById('location-modal');
  modal.style.display = 'flex';
  document.getElementById('loc-search').value = '';
  document.getElementById('loc-results').style.display = 'none';
  document.getElementById('loc-status').textContent = '';
  document.querySelectorAll('.loc-preset').forEach(function(b) { b.classList.remove('selected'); });
  setTimeout(function() { document.getElementById('loc-search').focus(); }, 100);
};
// Keep legacy global name for onclick= in HTML
function openLocationPicker() { ui.openLocationPicker(); }

ui.closeLocationPicker = function() {
  document.getElementById('location-modal').style.display = 'none';
  document.querySelectorAll('.loc-preset').forEach(function(b) { b.classList.remove('selected'); });
  if (ui._modalTrigger && ui._modalTrigger.focus) {
    try { ui._modalTrigger.focus(); } catch(e) {}
    ui._modalTrigger = null;
  }
};
function closeLocationPicker() { ui.closeLocationPicker(); }

// Presets use data attrs to avoid innerHTML injection
function selectPreset(lat, lng, name, btn) {
  document.querySelectorAll('.loc-preset').forEach(function(b) { b.classList.remove('selected'); });
  if (btn) btn.classList.add('selected');
  ui.closeLocationPicker();
  updateBanner(lat, lng, name);
}

// ── 1: Nominatim search (replaces LLM API call) ──────────────
// ── Debounce ≥1100 ms (item 1) ───────────────────────────────
var _searchTimer = null;

function debounceSearch() {
  clearTimeout(_searchTimer);
  var q = document.getElementById('loc-search').value.trim();
  if (q.length < 3) {
    document.getElementById('loc-results').style.display = 'none';
    document.getElementById('loc-status').textContent = '';
    return;
  }
  document.getElementById('loc-status').textContent = 'Typing…';
  _searchTimer = setTimeout(ui._doSearch, 1100);   // ≥1100 ms
}

ui._doSearch = function() {
  var query = document.getElementById('loc-search').value.trim();
  if (query.length < 2) return;

  var status  = document.getElementById('loc-status');
  var results = document.getElementById('loc-results');

  status.textContent      = 'Searching…';
  results.style.display   = 'none';
  results.textContent     = '';   // ── 3: no innerHTML ──

  // ── 8: Offline guard ──
  if (!navigator.onLine) {
    status.textContent = 'Offline — search unavailable.';
    return;
  }

  var url = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=gb&limit=5&addressdetails=1&q=' + encodeURIComponent(query);

  fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'FirstLightApp/1.0' } })
    .then(function(r) {
      if (r.status === 429) throw new Error('RATE_LIMIT');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(items) {
      if (!Array.isArray(items) || items.length === 0) {
        status.textContent = 'No UK locations found.';
        return;
      }
      status.textContent = '';
      ui._showResults(items);
    })
    .catch(function(err) {
      if (err.message === 'RATE_LIMIT') {
        status.textContent = 'Too many searches — wait a moment and try again.';
      } else {
        status.textContent = navigator.onLine
          ? 'Search failed — please try again.'
          : 'Offline — search unavailable.';
      }
    });
};

// ── 3: Build results with createElement (no innerHTML) ───────
ui._showResults = function(items) {
  var results = document.getElementById('loc-results');
  results.textContent  = '';   // clear safely
  results.style.display = 'block';

  // Filter to UK bounds as a safety net (countrycodes=gb should already do this)
  var ukItems = items.filter(function(item) {
    return isInUK(parseFloat(item.lat), parseFloat(item.lon));
  });

  if (ukItems.length === 0) {
    var msg = document.createElement('div');
    msg.style.cssText = 'font-size:12px;color:#888;padding:8px 0;text-align:center;';
    msg.textContent = 'No UK locations found. First Light covers UK locations only.';
    results.appendChild(msg);
    return;
  }

  ukItems.forEach(function(item) {
    var lat  = parseFloat(item.lat);
    var lng  = parseFloat(item.lon);
    var addr = item.address || {};
    // Build a readable name from address components
    var parts = [];
    var primary = addr.town || addr.city || addr.village || addr.suburb || addr.hamlet || item.display_name.split(',')[0];
    var county  = addr.county || addr.state_district || '';
    var country = addr.country || '';
    parts.push(primary);
    if (county) parts.push(county);
    if (country && country !== 'United Kingdom') parts.push(country);
    var name = parts.join(', ');

    // ── 3: DOM creation, no onclick= string ──
    var row = document.createElement('div');
    row.className = 'loc-result-item';

    var nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-size:13px;font-weight:600;color:#2d3a1f;line-height:1.3;';
    nameEl.textContent = name;

    var coordEl = document.createElement('div');
    coordEl.style.cssText = 'font-size:11px;color:#aaa;margin-top:2px;';
    coordEl.textContent = lat.toFixed(4) + '°N, ' + Math.abs(lng).toFixed(4) + '°' + (lng < 0 ? 'W' : 'E');

    row.appendChild(nameEl);
    row.appendChild(coordEl);

    // ── 3: addEventListener not inline onclick ──
    row.addEventListener('click', (function(la, lo, n) {
      return function() {
        ui.closeLocationPicker();
        updateBanner(la, lo, n);
      };
    }(lat, lng, name)));

    results.appendChild(row);
  });
};

// Legacy name kept for HTML button
function searchLocation() { ui._doSearch(); }

function useMyLocation() {
  ui.closeLocationPicker();
  document.getElementById('banner-location-text').textContent = '';

  if (!navigator.geolocation) {
    ui.showLocationPrompt('Location unavailable');
    return;
  }
  if (!navigator.onLine) {
    ui.showLocationPrompt('Offline — set location manually');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function(pos) {
      var lat = pos.coords.latitude;
      var lng = pos.coords.longitude;
      var acc = pos.coords.accuracy;
      if (!isInUK(lat, lng)) {
        ui.closeLocationPicker();
        showOutsideUKMessage();
        return;
      }
      ui.showAccuracyWarning(acc);

      fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json', {
        headers: { 'Accept-Language': 'en', 'User-Agent': 'FirstLightApp/1.0' }
      })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var addr = data.address || {};
          var raw = addr.town || addr.city || addr.village || addr.suburb || addr.hamlet || addr.county || 'Your Location';
          // Trim verbose UK admin names: "Metropolitan Borough of Solihull" → "Solihull"
          var name = raw.replace(/^(Metropolitan Borough of |London Borough of |Royal Borough of |City of |County of |District of )/i, '');
          updateBanner(lat, lng, name);
        })
        .catch(function() { updateBanner(lat, lng, 'Your Location'); });
    },
    function() { ui.showLocationPrompt('Location unavailable'); },
    { timeout: 8000, maximumAge: 0 } // always fresh — user explicitly requested location
  );
}

// Backdrop click
document.addEventListener('DOMContentLoaded', function() {
  var modal = document.getElementById('location-modal');
  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) ui.closeLocationPicker();
    });
  }
});


// ── block ──
function openHoursDisclaimer() {
  const m = document.getElementById('hours-disclaimer-modal');
  m.style.display = 'flex';
}
function closeHoursDisclaimer() {
  document.getElementById('hours-disclaimer-modal').style.display = 'none';
}
document.getElementById('hours-disclaimer-modal').addEventListener('click', function(e) {
  if (e.target === this) closeHoursDisclaimer();
});

// ── block ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('./sw.js').then(function(reg) {
      // Check for updates
      reg.addEventListener('updatefound', function() {
        var newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', function() {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available — show refresh prompt
            var toast = document.createElement('div');
            toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(30,50,20,0.96);color:white;font-size:13px;font-weight:600;padding:12px 18px;border-radius:14px;border:1px solid rgba(200,168,75,0.3);z-index:9999;display:flex;align-items:center;gap:10px;box-shadow:0 6px 24px rgba(0,0,0,0.4);max-width:320px;';
            toast.innerHTML = '<span>New version available</span><button onclick="location.reload()" style="background:rgba(200,168,75,0.2);border:1px solid rgba(200,168,75,0.4);color:#f0c870;padding:6px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">Refresh</button>';
            document.body.appendChild(toast);
          }
        });
      });
    }).catch(function() {
      // Silent fail on non-installed domains
    });
  });
}

// ── block ──
(function() {
  function onReady(fn) {
    if (document.readyState !== 'loading') { fn(); }
    else { document.addEventListener('DOMContentLoaded', fn); }
  }

  onReady(function() {

    // ── Pull to refresh ────────────────────────────────────
    (function() {
      var PTR_THRESHOLD = 72;   // px to pull before triggering
      var PTR_RESIST   = 0.4;   // resistance factor
      var startY = 0;
      var pulling = false;
      var refreshing = false;
      var indicator = document.getElementById('ptr-indicator');
      var arrow = document.getElementById('ptr-arrow');
      var label = document.getElementById('ptr-label');

      function showIndicator(dist) {
        if (!indicator) return;
        var progress = Math.min(dist / PTR_THRESHOLD, 1);
        indicator.style.display = 'flex';
        arrow.style.transform = progress >= 1 ? 'rotate(180deg)' : 'rotate(0deg)';
        label.textContent = progress >= 1 ? 'Release to refresh' : 'Pull to refresh';
        indicator.style.opacity = Math.min(progress * 1.5, 1);
      }

      function hideIndicator() {
        if (!indicator) return;
        indicator.style.display = 'none';
        indicator.style.opacity = '0';
      }

      function doRefresh() {
        if (refreshing) return;
        refreshing = true;
        if (indicator) {
          arrow.style.transform = 'rotate(0deg)';
          label.textContent = 'Refreshing…';
        }
        // Re-run GPS and solar calc
        ui.showLocationPrompt('Locating…');
        initBanner();
        updateMoon();
        // Hide after 1.5s
        setTimeout(function() {
          hideIndicator();
          refreshing = false;
        }, 1500);
      }

      document.addEventListener('touchstart', function(e) {
        // Only trigger if at top of page
        if (window.scrollY === 0) {
          startY = e.touches[0].clientY;
          pulling = true;
        }
      }, { passive: true });

      document.addEventListener('touchmove', function(e) {
        if (!pulling || refreshing) return;
        var dist = (e.touches[0].clientY - startY) * PTR_RESIST;
        if (dist > 0) showIndicator(dist);
        else hideIndicator();
      }, { passive: true });

      document.addEventListener('touchend', function(e) {
        if (!pulling || refreshing) return;
        pulling = false;
        var dist = (e.changedTouches[0].clientY - startY) * PTR_RESIST;
        if (dist >= PTR_THRESHOLD) {
          doRefresh();
        } else {
          hideIndicator();
        }
      }, { passive: true });
    }());


    var calBtnEW = document.getElementById('cal-btn-ew');
    var calBtnSC = document.getElementById('cal-btn-sc');
    var calViewEW = document.getElementById('cal-view-ew');
    var calViewSC = document.getElementById('cal-view-sc');
    var ewActiveStyle = 'flex:1;padding:10px 0;border-radius:20px;border:1px solid rgba(200,168,75,0.3);cursor:pointer;font-family:\'DM Sans\',sans-serif;font-size:13px;font-weight:600;background:linear-gradient(135deg,#2a5a18,#1a3a0e);color:#f5e6c8;';
    var scActiveStyle = 'flex:1;padding:10px 0;border-radius:20px;border:1px solid rgba(120,160,240,0.3);cursor:pointer;font-family:\'DM Sans\',sans-serif;font-size:13px;font-weight:600;background:linear-gradient(135deg,#1a2a5a,#0e1a3a);color:#c8d8f8;';
    var inactiveStyle = 'flex:1;padding:10px 0;border-radius:20px;border:1px solid rgba(255,255,255,0.1);cursor:pointer;font-family:\'DM Sans\',sans-serif;font-size:13px;font-weight:600;background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.45);';
    if (calBtnEW) {
      calBtnEW.addEventListener('click', function() {
        calBtnEW.style.cssText = ewActiveStyle;
        calBtnSC.style.cssText = inactiveStyle;
        calViewEW.style.display = 'block';
        calViewSC.style.display = 'none';
      });
    }
    if (calBtnSC) {
      calBtnSC.addEventListener('click', function() {
        calBtnSC.style.cssText = scActiveStyle;
        calBtnEW.style.cssText = inactiveStyle;
        calViewSC.style.display = 'block';
        calViewEW.style.display = 'none';
      });
    }


    var skipLink = document.getElementById('skip-link');
    if (skipLink) {
      skipLink.addEventListener('focus', function() { this.style.top = '0'; });
      skipLink.addEventListener('blur',  function() { this.style.top = '-40px'; });
    }

    // ── Info button (hours disclaimer) ────────────────────
    var infoBtn = document.getElementById('info-btn');
    if (infoBtn) {
      infoBtn.addEventListener('click', openHoursDisclaimer);
      infoBtn.addEventListener('mouseover', function() { this.style.background = 'rgba(255,255,255,0.28)'; });
      infoBtn.addEventListener('mouseout',  function() { this.style.background = 'rgba(255,255,255,0.15)'; });
    }

    // ── Edit location button ───────────────────────────────
    var editBtn = document.getElementById('edit-location-btn');
    if (editBtn) {
      editBtn.addEventListener('click', openLocationPicker);
      editBtn.addEventListener('mouseover', function() { this.style.opacity = '1'; });
      editBtn.addEventListener('mouseout',  function() { this.style.opacity = '0.55'; });
    }

    // ── Moon / activity widget ─────────────────────────────
    var moonWidget = document.getElementById('moon-widget');
    if (moonWidget) {
      moonWidget.addEventListener('click', toggleActivityPanel);
      moonWidget.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleActivityPanel(); }
      });
    }

    // ── Nav tabs (top) ─────────────────────────────────────
    document.querySelectorAll('.nav-tab[data-tab]').forEach(function(tab) {
      tab.addEventListener('click', function() { switchTab(this.dataset.tab, this); });
      tab.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTab(this.dataset.tab, this); }
      });
    });

    // ── Bottom tab bar ─────────────────────────────────────
    document.querySelectorAll('.tab-item[data-maintab]').forEach(function(item) {
      item.addEventListener('click', function() { switchMainTab(this.dataset.maintab, this); });
      item.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchMainTab(this.dataset.maintab, this); }
      });
    });

    // ── Deer cards ─────────────────────────────────────────
    document.querySelectorAll('.deer-card').forEach(function(card) {
      card.addEventListener('click', function() { toggleCard(this); });
    });

    // ── Field guide accordion headers ──────────────────────
    document.querySelectorAll('.fg-cat-header').forEach(function(header) {
      header.addEventListener('click', function() { toggleFgCategory(this); });
      header.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFgCategory(this); }
      });
    });

    // ── Location preset buttons ────────────────────────────
    document.querySelectorAll('.loc-preset[data-lat]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        selectPreset(
          parseFloat(this.dataset.lat),
          parseFloat(this.dataset.lng),
          this.dataset.name,
          this
        );
      });
    });

    // ── Location search input ──────────────────────────────
    var locSearch = document.getElementById('loc-search');
    if (locSearch) {
      locSearch.addEventListener('input', debounceSearch);
      locSearch.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); searchLocation(); }
      });
    }

    // ── Search Go button ───────────────────────────────────
    var goBtn = document.getElementById('search-go-btn');
    if (goBtn) { goBtn.addEventListener('click', searchLocation); }

    // ── Location cancel button ─────────────────────────────
    var cancelBtn = document.getElementById('location-cancel-btn');
    if (cancelBtn) { cancelBtn.addEventListener('click', closeLocationPicker); }

    // ── GPS location button ────────────────────────────────
    var gpsBtn = document.getElementById('use-gps-btn');
    if (gpsBtn) { gpsBtn.addEventListener('click', useMyLocation); }

    // ── Hours disclaimer close button ──────────────────────
    var disclaimerCloseBtn = document.getElementById('hours-disclaimer-close');
    if (disclaimerCloseBtn) { disclaimerCloseBtn.addEventListener('click', closeHoursDisclaimer); }

    // ── BDS link ───────────────────────────────────────────
    var bdsLink = document.getElementById('bds-link');
    if (bdsLink) {
      bdsLink.addEventListener('click', function(e) {
        e.preventDefault();
        window.open('https://www.bds.org.uk', '_blank', 'noopener,noreferrer');
      });
    }

    // ── BASC link ──────────────────────────────────────────
    var bascLink = document.getElementById('basc-link');
    if (bascLink) {
      bascLink.addEventListener('click', function(e) {
        e.preventDefault();
        window.open('https://www.basc.org.uk/deer/', '_blank', 'noopener,noreferrer');
      });
    }


    ['coffee-header-link', 'coffee-footer-link'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', function(e) {
          e.preventDefault();
          window.open('https://buymeacoffee.com/firstlight', '_blank', 'noopener,noreferrer');
        });
      }
    });

  });
}());

// ── block ──
(function() {
  var DIARY_URL = 'https://sjaasuqeknvvmdpydfsz.supabase.co';
  var DIARY_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNqYWFzdXFla252dm1kcHlkZnN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NjMzMzIsImV4cCI6MjA5MDIzOTMzMn0.aiJaKoLCI3jUkOgifqMLuhp8NnAFK0T24Va6r2CLzgw';

  function getSeasonDates() {
    var now = new Date();
    var m = now.getMonth() + 1; // 1-12
    var y = now.getFullYear();
    var seasonStart = m >= 8 ? y + '-08-01' : (y-1) + '-08-01';
    var seasonEnd   = m >= 8 ? (y+1) + '-07-31' : y + '-07-31';
    return { start: seasonStart, end: seasonEnd };
  }

  function updateCard(total, kg, spp) {
    var t = document.getElementById('diary-card-total');
    var k = document.getElementById('diary-card-kg');
    var s = document.getElementById('diary-card-spp');
    if (t) t.textContent = total;
    if (k) k.textContent = kg;
    if (s) s.textContent = spp;
  }

  async function syncDiaryCard() {
    try {
      var db = supabase.createClient(DIARY_URL, DIARY_KEY);
      var session = await db.auth.getSession();
      if (!session.data.session) return; // not logged in — leave dashes

      var user = session.data.session.user;
      var d = getSeasonDates();
      var r = await db.from('cull_entries')
        .select('weight_gralloch, species')
        .eq('user_id', user.id)
        .gte('date', d.start)
        .lte('date', d.end);

      if (r.error || !r.data) return;
      var entries = r.data;
      var total = entries.length;
      var kg = Math.round(entries.reduce(function(s,e){ return s + (parseFloat(e.weight_gralloch)||0); }, 0));
      var spp = new Set(entries.map(function(e){ return e.species; })).size;
      updateCard(total, kg || '–', spp || '–');
    } catch(e) {
      // Silently fail — dashes remain
    }
  }

  // Run after page loads
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncDiaryCard);
  } else {
    syncDiaryCard();
  }
})();

// ── block ──
// ── Photo Gallery Lightbox ──────────────────────────────────
var _lb = {
  data: {
    Red:             ['Red_1.PNG','Red_2.JPG','Red_3.jpg','Red_4.jpg'],
    Fallow:          ['Fallow_1.jpg','Fallow_2.jpg','Fallow_3.jpg','Fallow_4.jpg'],
    Roe:             ['Roe_1.jpg','Roe_2.jpg','Roe_3.jpg','Roe_4.jpg'],
    Sika:            ['Sika_1.jpg','Sika_2.jpg','Sika_3.jpg','Sika_4.jpg'],
    Muntjac:         ['Muntjac_1.jpg','Muntjac_2.jpg','Muntjac_3.jpg','Muntjac_4.jpg'],
    ChineseWaterDeer:['ChineseWaterDeer_1.jpg','ChineseWaterDeer_2.jpg','ChineseWaterDeer_3.jpg','ChineseWaterDeer_4.jpg'],
  },
  base: 'https://firstlightdeer.co.uk/species/gallery/',
  key: null, idx: 0
};

var _lbTrigger = null;

function openLightbox(key, idx) {
  _lbTrigger = document.activeElement;
  _lb.key = key; _lb.idx = idx;
  _lbRender();
  document.getElementById('gallery-lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('gallery-lightbox').classList.remove('open');
  document.body.style.overflow = '';
  if (_lbTrigger && _lbTrigger.focus) {
    try { _lbTrigger.focus(); } catch(e) {}
    _lbTrigger = null;
  }
}

function lightboxNav(dir) {
  var files = _lb.data[_lb.key];
  _lb.idx = (_lb.idx + dir + files.length) % files.length;
  _lbRender();
}

function _lbRender() {
  var files = _lb.data[_lb.key];
  var f = files[_lb.idx];
  document.getElementById('lightbox-img').src = _lb.base + f;
  document.getElementById('lightbox-img').alt = _lb.key + ' photo ' + (_lb.idx + 1);
  document.getElementById('lightbox-caption').textContent = _lb.key.replace(/([A-Z])/g, ' $1').trim();
  document.getElementById('lightbox-counter').textContent = (_lb.idx + 1) + ' / ' + files.length;
}

// Close on backdrop click
document.getElementById('gallery-lightbox').addEventListener('click', function(e) {
  if (e.target === this) closeLightbox();
});

// Swipe support
(function() {
  var lb = document.getElementById('gallery-lightbox');
  var sx = 0, sy = 0, pinching = false, maxTouches = 0;
  lb.addEventListener('touchstart', function(e){
    maxTouches = Math.max(maxTouches, e.touches.length);
    pinching = e.touches.length > 1;
    if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
  }, {passive:true});
  lb.addEventListener('touchmove', function(e){
    if (e.touches.length > 1) { pinching = true; maxTouches = Math.max(maxTouches, e.touches.length); }
  }, {passive:true});
  lb.addEventListener('touchend', function(e){
    // If at any point more than 1 finger was involved, ignore
    if (maxTouches > 1) { if (e.touches.length === 0) { pinching = false; maxTouches = 0; } return; }
    if (pinching) { pinching = false; maxTouches = 0; return; }
    maxTouches = 0;
    var dx = e.changedTouches[0].clientX - sx;
    var dy = Math.abs(e.changedTouches[0].clientY - sy);
    if (Math.abs(dx) > 50 && dy < 60) lightboxNav(dx < 0 ? 1 : -1);
  }, {passive:true});
})();
