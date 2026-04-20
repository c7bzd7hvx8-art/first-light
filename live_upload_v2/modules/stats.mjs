// First Light — modules/stats.mjs
// =============================================================================
// Stats-tab data tables, pure aggregators, and their DOM paint wrappers.
// Extracted from diary.js across several commits; see MODULARISATION-PLAN.md.
//
// Scope of this module:
//   Data tables (pure lookups — Commit H):
//     • CAL_COLORS       — 6-colour gradient palette for the calibre chart
//     • SP_COLORS_D      — species → stats-chart colour
//     • AGE_CLASSES      — ordered age-class label list
//     • AGE_COLORS       — one colour per AGE_CLASSES index
//     • AGE_GROUPS       — { 'Juvenile'|'Adult'|'Mature': [labels] }
//
//   Pure aggregators (no DOM, no globals — Commit H):
//     • aggregateShooterStats(entries)    → { counts, sortedNames, maxCount, isAllSelf }
//     • aggregateDestinationStats(entries) → { counts, sortedNames, maxCount }
//     • aggregateTimeOfDayStats(entries)  → { buckets, counts, total, maxCount }
//     • categorizeHourToBucket(hour)      → 0..5 bucket index (or 5 for night/NaN)
//
//   DOM paint wrappers (write HTML into stats-tab cards — Commit M):
//     • buildShooterStats(entries)       — renders #shooter-card / #shooter-chart
//     • buildDestinationStats(entries)   — renders #destination-card / #destination-chart
//     • buildTimeOfDayStats(entries)     — renders #time-card / #time-chart
//
//   Larger DOM paint wrappers (Commit N):
//     • normalizeAgeClassLabel(label)    — legacy label migration (pure)
//     • buildCalibreDistanceStats(entries)       — renders #calibre-card /
//                                          #calibre-chart AND #distance-card /
//                                          #distance-chart
//     • buildAgeStats(entries)           — renders #age-card / #age-chart
//     • buildTrendsChart(entries, opts)  — renders #trends-card / #trends-chart
//                                          opts.currentSeason — the currently
//                                          selected season key; the card is
//                                          hidden unless it equals '__all__'
//     • buildGroundStats(entries)        — renders #ground-card / #ground-chart
//
//   Stats-tab body renderer (Commit O):
//     • renderStatsTabBody(entries, opts) — renders every stats-tab card
//                                          that is purely a function of
//                                          `entries`: top KPIs, weight
//                                          grid, species+sex chart, sex
//                                          chart, the seven sub-cards
//                                          above, and the monthly chart.
//                                          Does NOT schedule map init,
//                                          sync the season-pill select,
//                                          fetch targets, or refresh the
//                                          syndicate section — those are
//                                          side-effectful orchestration
//                                          concerns and stay in diary.js's
//                                          buildStats wrapper. See the
//                                          function's own doc-comment for
//                                          the full opts contract.
//
//   Every paint wrapper hides its card when there is no data worth showing.
//
// Data-table + aggregator functions are pure. The DOM paint wrappers touch
// `document` and are tested with a small in-memory DOM stub.
// =============================================================================

import { esc, seasonLabel, buildSeasonFromEntry, MONTH_NAMES } from '../lib/fl-pure.mjs';

// ── Shared palettes / age labels ──────────────────────────────────────────

/**
 * 6-colour calibre chart palette. Ordered loudest-to-softest so that the
 * chart's first-place bar draws the eye. Must have at least 6 entries
 * because we render up to the top-6 calibres (beyond that the bars get
 * unreadable on mobile).
 */
export const CAL_COLORS = [
  'linear-gradient(90deg,#5a7a30,#7adf7a)',
  'linear-gradient(90deg,#c8a84b,#f0c870)',
  'linear-gradient(90deg,#6a1b9a,#ab47bc)',
  'linear-gradient(90deg,#1565c0,#42a5f5)',
  'linear-gradient(90deg,#c62828,#ef5350)',
  'linear-gradient(90deg,#00695c,#26a69a)'
];

/**
 * Species → solid colour for stats charts (distance-by-species, trends).
 * Distinct from the hero-card species palette because stats charts print
 * small and need higher-contrast fills.
 */
export const SP_COLORS_D = {
  'Red Deer': '#c8a84b',
  'Roe Deer': '#5a7a30',
  'Fallow':   '#f57f17',
  'Muntjac':  '#6a1b9a',
  'Sika':     '#1565c0',
  'CWD':      '#00695c'
};

/** Age classes in canonical order (juvenile → mature). */
export const AGE_CLASSES = ['Calf / Kid / Fawn', 'Yearling', '2–4 years', '5–8 years', '9+ years'];

/** One colour per AGE_CLASSES index (same length + order). */
export const AGE_COLORS = ['#5a9a3a', '#5a7a30', '#c8a84b', '#f57f17', '#c62828'];

/**
 * Summary groupings for the "age pills" row under the per-class bars.
 * Values reference AGE_CLASSES labels verbatim — changing either requires
 * changing both. Kept as object so the render code can just iterate keys
 * for stable row order in all browsers that preserve insertion order (ES2015+).
 */
export const AGE_GROUPS = {
  'Juvenile': ['Calf / Kid / Fawn', 'Yearling'],
  'Adult':    ['2–4 years'],
  'Mature':   ['5–8 years', '9+ years']
};

// ── Pure aggregators ──────────────────────────────────────────────────────

/**
 * Shooter histogram. Treats blank/undefined `shooter` as the literal string
 * `'Self'` so the current user (who rarely fills the field for their own
 * culls) still appears on the chart when the user is part of a syndicate
 * that includes guest stalkers.
 *
 * Sort: 'Self' pinned first (the user's own shots are the meaningful
 * anchor point), then by count descending. Ties break by insertion order.
 *
 * @param {Array<{shooter?: string|null}>} entries
 * @returns {{
 *   counts: Record<string, number>,
 *   sortedNames: string[],
 *   maxCount: number,
 *   isAllSelf: boolean  // render caller uses this to hide the whole card
 * }}
 */
export function aggregateShooterStats(entries) {
  var counts = {};
  (entries || []).forEach(function (e) {
    var s = (e && e.shooter && e.shooter.trim()) ? e.shooter.trim() : 'Self';
    counts[s] = (counts[s] || 0) + 1;
  });
  var names = Object.keys(counts);
  names.sort(function (a, b) {
    if (a === 'Self') return -1;
    if (b === 'Self') return 1;
    return counts[b] - counts[a];
  });
  var maxCount = names.length ? Math.max.apply(null, names.map(function (s) { return counts[s]; })) : 0;
  var isAllSelf = names.length <= 1 && names[0] === 'Self';
  return { counts: counts, sortedNames: names, maxCount: maxCount, isAllSelf: isAllSelf };
}

/**
 * Destination histogram (Game dealer, Self/personal, etc.). Entries with no
 * `destination` set are skipped entirely — the caller hides the whole card
 * when sortedNames is empty, rather than rendering a confusing "not recorded"
 * slice that would dominate early-season data.
 *
 * @param {Array<{destination?: string|null}>} entries
 * @returns {{ counts: Record<string,number>, sortedNames: string[], maxCount: number }}
 */
export function aggregateDestinationStats(entries) {
  var counts = {};
  (entries || []).forEach(function (e) {
    if (e && e.destination) counts[e.destination] = (counts[e.destination] || 0) + 1;
  });
  var names = Object.keys(counts);
  names.sort(function (a, b) { return counts[b] - counts[a]; });
  var maxCount = names.length ? Math.max.apply(null, names.map(function (d) { return counts[d]; })) : 0;
  return { counts: counts, sortedNames: names, maxCount: maxCount };
}

/**
 * 6-bucket time-of-day histogram (Dawn / Morning / Midday / Afternoon / Dusk
 * / Night). Night wraps 21:00 → 04:00 so the bucket.min/max aren't a clean
 * range — we detect it via `categorizeHourToBucket` below. Buckets are in
 * render order (caller iterates index 0..5); Night is always index 5 so it
 * renders at the bottom.
 */
export const TIME_OF_DAY_BUCKETS = [
  { label: 'Dawn (05–07)',      min: 5,  max: 7,  clr: 'linear-gradient(90deg,#f57f17,#ffb74d)' },
  { label: 'Morning (08–10)',   min: 8,  max: 10, clr: 'linear-gradient(90deg,#c8a84b,#f0c870)' },
  { label: 'Midday (11–14)',    min: 11, max: 14, clr: 'linear-gradient(90deg,#5a7a30,#7adf7a)' },
  { label: 'Afternoon (15–17)', min: 15, max: 17, clr: 'linear-gradient(90deg,#1565c0,#42a5f5)' },
  { label: 'Dusk (18–20)',      min: 18, max: 20, clr: 'linear-gradient(90deg,#6a1b9a,#ab47bc)' },
  { label: 'Night (21–04)',     min: -1, max: -1, clr: 'linear-gradient(90deg,#444,#888)' }
];

/**
 * Return the time-of-day bucket index (0-5) for a given hour. NaN / out-of-
 * range input falls through to 5 (Night) — this is intentional: a stalker
 * who types "25:00" by mistake shouldn't silently drop out of the histogram
 * totals, and the Night bucket also happens to be the one that catches the
 * legitimate 21-04 wrap-around.
 */
export function categorizeHourToBucket(hour) {
  var h = typeof hour === 'number' ? hour : parseInt(hour, 10);
  if (isNaN(h)) return 5;
  for (var i = 0; i < 5; i++) {
    var b = TIME_OF_DAY_BUCKETS[i];
    if (h >= b.min && h <= b.max) return i;
  }
  return 5;
}

/**
 * Time-of-day histogram. Reads the HH from each entry's `time` string
 * ('HH:MM' or 'HH:MM:SS'). Entries with no time or unparseable time are
 * skipped entirely — unlike the hour-25 case in `categorizeHourToBucket`,
 * a *missing* time isn't a data point we want to force into Night.
 *
 * @param {Array<{time?: string|null}>} entries
 * @returns {{
 *   buckets: typeof TIME_OF_DAY_BUCKETS,
 *   counts: number[],   // length 6, parallel to buckets
 *   total: number,      // sum of counts; caller hides card when 0
 *   maxCount: number
 * }}
 */
export function aggregateTimeOfDayStats(entries) {
  var counts = [0, 0, 0, 0, 0, 0];
  (entries || []).forEach(function (e) {
    if (!e || !e.time) return;
    var h = parseInt(String(e.time).split(':')[0], 10);
    if (isNaN(h)) return;
    counts[categorizeHourToBucket(h)]++;
  });
  var total = counts.reduce(function (a, b) { return a + b; }, 0);
  var maxCount = Math.max.apply(null, counts);
  return { buckets: TIME_OF_DAY_BUCKETS, counts: counts, total: total, maxCount: maxCount };
}

// ── DOM paint wrappers ────────────────────────────────────────────────────
// The three functions below each render one card in the Stats tab's "More"
// section. They follow the same pattern: call the matching aggregator, hide
// the card entirely when the data is uninteresting (all-Self / empty set),
// otherwise build an HTML string from bar rows and assign it to the chart
// element's innerHTML in one write.
//
// The cards are styled by `.bar-row` / `.bar-lbl` / `.bar-track` /
// `.bar-fill` / `.bar-cnt` in `diary.css`; the colour choice for each row
// is inlined as a `style` attribute because each series uses a different
// palette (self=green / other=gold for shooter; a colour-coded map for
// destination; pre-baked colours from the aggregator for time-of-day).

/** Render the Shooter-breakdown card. Hides the card when every entry was
 *  shot by "Self" (no useful comparison to draw). */
export function buildShooterStats(entries) {
  var card  = document.getElementById('shooter-card');
  var chart = document.getElementById('shooter-chart');
  if (!card || !chart) return;

  var agg = aggregateShooterStats(entries);

  if (agg.isAllSelf) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  var html = '';
  agg.sortedNames.forEach(function(s) {
    var cnt = agg.counts[s];
    var pct = Math.round(cnt / agg.maxCount * 100);
    var barClr = s === 'Self'
      ? 'linear-gradient(90deg,#5a7a30,#7adf7a)'
      : 'linear-gradient(90deg,#c8a84b,#f0c870)';
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + esc(s) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+barClr+';"></div></div>'
      + '<div class="bar-cnt">'+cnt+'</div>'
      + '</div>';
  });
  chart.innerHTML = html;
}

/** Render the Destination-breakdown card. Hides the card when no entries
 *  carry a destination value. */
export function buildDestinationStats(entries) {
  var card  = document.getElementById('destination-card');
  var chart = document.getElementById('destination-chart');
  if (!card || !chart) return;

  var agg = aggregateDestinationStats(entries);

  if (agg.sortedNames.length === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  // Per-destination gradient palette. Matches the semantic colour each
  // destination carries throughout the app (Self = green, Dealer = gold,
  // Condemned = red, etc.). Falls back to the Self/green gradient so an
  // unexpected free-text destination still renders rather than crash.
  var destColors = {
    'Self / personal use': 'linear-gradient(90deg,#5a7a30,#7adf7a)',
    'Game dealer':         'linear-gradient(90deg,#c8a84b,#f0c870)',
    'Friend / family':     'linear-gradient(90deg,#1565c0,#42a5f5)',
    'Stalking client':     'linear-gradient(90deg,#6a1b9a,#ab47bc)',
    'Estate / landowner':  'linear-gradient(90deg,#00695c,#4db6ac)',
    'Left on hill':        'linear-gradient(90deg,#888,#aaa)',
    'Condemned':           'linear-gradient(90deg,#c62828,#ef5350)'
  };

  var html = '';
  agg.sortedNames.forEach(function(d) {
    var cnt = agg.counts[d];
    var pct = Math.round(cnt / agg.maxCount * 100);
    var barClr = destColors[d] || 'linear-gradient(90deg,#5a7a30,#7adf7a)';
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + esc(d) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+barClr+';"></div></div>'
      + '<div class="bar-cnt">'+cnt+'</div>'
      + '</div>';
  });
  chart.innerHTML = html;
}

/** Render the Time-of-day card. Hides the card when no entry carries a
 *  usable time value. Early-returns when either DOM element is missing
 *  (the card is conditionally present depending on feature flags). */
export function buildTimeOfDayStats(entries) {
  var card  = document.getElementById('time-card');
  var chart = document.getElementById('time-chart');
  if (!card || !chart) return;

  var agg = aggregateTimeOfDayStats(entries);
  if (agg.total === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  var html = '';
  for (var j = 0; j < agg.buckets.length; j++) {
    if (agg.counts[j] === 0) continue;
    var pct = Math.round(agg.counts[j] / agg.maxCount * 100);
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + agg.buckets[j].label + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+agg.buckets[j].clr+';"></div></div>'
      + '<div class="bar-cnt">'+agg.counts[j]+'</div>'
      + '</div>';
  }
  chart.innerHTML = html;
}

// ── normalizeAgeClassLabel ────────────────────────────────────────────────
// Historical data shim. Older entries wrote "Calf / Kid" (pre-fawn) before
// we added Roe to the species list; the stored strings are compared against
// AGE_CLASSES lookup keys, so a label that drifted from the canonical list
// silently disappears from age-breakdown buckets. Widening the canonical
// name fixes display retroactively without a data migration.
export function normalizeAgeClassLabel(ageClass) {
  if (ageClass === 'Calf / Kid') return 'Calf / Kid / Fawn';
  return ageClass;
}

// ── buildCalibreDistanceStats ─────────────────────────────────────────────
// Two cards in one function because the distance panel depends on the same
// calibre filter and reuses calibre averages. The top-6 rule on calibres
// keeps the bar chart readable on mobile; a stalker running 9 different
// rounds is rare, and when it does happen the long tail is aggregated into
// the per-species distance chart below.
export function buildCalibreDistanceStats(entries) {
  // ── Calibre chart ──
  var calCard = document.getElementById('calibre-card');
  var calChart = document.getElementById('calibre-chart');
  var calEntries = entries.filter(function(e){ return e.calibre; });

  if (calCard && calChart) {
  if (calEntries.length === 0) {
    calCard.style.display = 'none';
  } else {
    calCard.style.display = 'block';
    var calCount = {}, calDist = {};
    calEntries.forEach(function(e) {
      var c = e.calibre.trim();
      calCount[c] = (calCount[c]||0) + 1;
      if (e.distance_m) {
        if (!calDist[c]) calDist[c] = [];
        calDist[c].push(e.distance_m);
      }
    });
    var sorted = Object.keys(calCount).sort(function(a,b){ return calCount[b]-calCount[a]; });
    var maxCnt = calCount[sorted[0]] || 1;

    var html = '';
    sorted.slice(0,6).forEach(function(cal, i) {
      var cnt = calCount[cal];
      var pct = Math.round(cnt/maxCnt*100);
      var avgDist = calDist[cal] && calDist[cal].length
        ? Math.round(calDist[cal].reduce(function(s,v){return s+v;},0)/calDist[cal].length)
        : null;
      html += '<div class="cal-row">'
        + '<div class="cal-name">' + esc(cal) + '</div>'
        + '<div class="cal-bar-wrap"><div class="cal-bar" style="width:'+pct+'%;background:'+CAL_COLORS[i%CAL_COLORS.length]+';"></div></div>'
        + '<div class="cal-cnt">' + cnt + '</div>'
        + '<div class="cal-avg-lbl">' + (avgDist ? avgDist+'m' : '–') + '</div>'
        + '</div>';
    });
    calChart.innerHTML = html;
  }
  }

  // ── Distance chart ──
  var distCard = document.getElementById('distance-card');
  var distChart = document.getElementById('distance-chart');
  var distEntries = entries.filter(function(e){ return e.distance_m && e.distance_m > 0; });

  if (distCard && distChart) {
  if (distEntries.length === 0) {
    distCard.style.display = 'none';
  } else {
    distCard.style.display = 'block';

    var totalDist = distEntries.reduce(function(s,e){ return s+e.distance_m; }, 0);
    var avgDist = Math.round(totalDist / distEntries.length);

    var spDist = {};
    distEntries.forEach(function(e) {
      if (!spDist[e.species]) spDist[e.species] = [];
      spDist[e.species].push(e.distance_m);
    });
    var spAvgs = Object.keys(spDist).map(function(sp) {
      var vals = spDist[sp];
      return { sp:sp, avg: Math.round(vals.reduce(function(s,v){return s+v;},0)/vals.length) };
    }).sort(function(a,b){ return b.avg - a.avg; });
    var maxAvg = spAvgs.length ? spAvgs[0].avg : 1;

    // Range bands — chosen to align with typical UK deer-stalking ranges:
    // 0-50m covers the bulk of woodland / high-seat shots; 51-100m is open
    // ride / field margin; 101-150m is open-hill; 150m+ flags the long shots
    // that merit extra scrutiny on a course-book review. Colours go from
    // moss (safe) through gold and orange to red (long).
    var bands = [
      { label:'0 – 50m',    min:0,   max:50,  color:'var(--moss)' },
      { label:'51 – 100m',  min:51,  max:100, color:'var(--gold)' },
      { label:'101 – 150m', min:101, max:150, color:'#f57f17' },
      { label:'150m+',      min:151, max:9999,color:'#c62828' },
    ];
    var bandCounts = bands.map(function(b) {
      return distEntries.filter(function(e){ return e.distance_m>=b.min && e.distance_m<=b.max; }).length;
    });
    var totalBand = distEntries.length;

    var html = '<div class="dist-avg-box">'
      + '<div><div class="dist-avg-val">' + avgDist + '</div><div class="dist-avg-unit">metres avg</div></div>'
      + '<div><div class="dist-avg-lbl">Overall average</div>'
      + '<div class="dist-avg-sub">Based on ' + distEntries.length + ' entr' + (distEntries.length===1?'y':'ies') + ' with<br>distance recorded</div></div>'
      + '</div>';

    if (spAvgs.length > 1) {
      html += '<div class="scard-sub-t">By species</div>';
      spAvgs.forEach(function(s) {
        var clr = SP_COLORS_D[s.sp] || '#5a7a30';
        var pct = Math.round(s.avg/maxAvg*100);
        html += '<div class="dist-sp-row">'
          + '<div class="dist-sp-dot" style="background:'+clr+';"></div>'
          + '<div class="dist-sp-name">'+s.sp+'</div>'
          + '<div class="dist-bar-wrap"><div class="dist-bar" style="width:'+pct+'%;background:'+clr+';"></div></div>'
          + '<div class="dist-val">'+s.avg+'m</div>'
          + '</div>';
      });
    }

    html += '<div class="scard-sub-t" style="margin-top:14px;">Distance bands</div>'
      + '<div class="range-grid">';
    bands.forEach(function(b, i) {
      var cnt = bandCounts[i];
      var pct = totalBand ? Math.round(cnt/totalBand*100) : 0;
      html += '<div class="range-cell">'
        + '<div class="range-band">'+b.label+'</div>'
        + '<div class="range-cnt">'+cnt+'</div>'
        + '<div class="range-pct">'+pct+'% of culls</div>'
        + '<div class="range-bar"><div class="range-bar-fill" style="width:'+pct+'%;background:'+b.color+';"></div></div>'
        + '</div>';
    });
    html += '</div>';

    distChart.innerHTML = html;
  }
  }
}

// ── buildAgeStats ─────────────────────────────────────────────────────────
// Three layers in one card:
//   1. Per-age-class bars (one row per AGE_CLASSES entry, in canonical order)
//   2. Juvenile / Adult / Mature summary pills
//   3. If more than one species has age data, a mini per-species breakdown
//
// `normalizeAgeClassLabel` is applied when reading `e.age_class` so legacy
// "Calf / Kid" entries are bucketed correctly. Entries without an age_class
// are excluded from the totals used for the bars but counted separately in
// the "Not recorded" pill when non-zero.
export function buildAgeStats(entries) {
  var card  = document.getElementById('age-card');
  var chart = document.getElementById('age-chart');
  if (!card || !chart) return;

  var aged  = entries.filter(function(e){ return e.age_class; });

  if (aged.length === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  var counts = {};
  AGE_CLASSES.forEach(function(a){ counts[a] = 0; });
  aged.forEach(function(e){
    var ageKey = normalizeAgeClassLabel(e.age_class);
    if (counts[ageKey] !== undefined) counts[ageKey]++;
  });
  var total = aged.length;
  var maxCnt = Math.max.apply(null, AGE_CLASSES.map(function(a){ return counts[a]; }).concat([1]));

  var html = '';
  AGE_CLASSES.forEach(function(ac, i) {
    var cnt = counts[ac];
    var pct = total ? Math.round(cnt/total*100) : 0;
    var barPct = Math.round(cnt/maxCnt*100);
    html += '<div class="age-row">'
      + '<div class="age-lbl">' + ac + '</div>'
      + '<div class="age-bar-wrap"><div class="age-bar" style="width:'+barPct+'%;background:'+AGE_COLORS[i]+';"></div></div>'
      + '<div class="age-cnt">' + cnt + '</div>'
      + '<div class="age-pct">' + (cnt ? pct+'%' : '–') + '</div>'
      + '</div>';
  });

  var notRecorded = entries.length - aged.length;
  html += '<div class="age-summary">';
  Object.keys(AGE_GROUPS).forEach(function(grp) {
    var grpCnt = AGE_GROUPS[grp].reduce(function(s,a){ return s+(counts[a]||0); }, 0);
    var grpPct = total ? Math.round(grpCnt/total*100) : 0;
    var dotClr = grp==='Juvenile' ? '#7adf7a' : grp==='Adult' ? '#c8a84b' : '#f57f17';
    html += '<div class="age-pill">'
      + '<div class="age-pill-dot" style="background:'+dotClr+';"></div>'
      + '<div class="age-pill-txt">'+grp+'</div>'
      + '<div class="age-pill-cnt">'+grpCnt+' · '+grpPct+'%</div>'
      + '</div>';
  });
  if (notRecorded > 0) {
    html += '<div class="age-pill">'
      + '<div class="age-pill-dot" style="background:#ccc;"></div>'
      + '<div class="age-pill-txt">Not recorded</div>'
      + '<div class="age-pill-cnt">'+notRecorded+'</div>'
      + '</div>';
  }
  html += '</div>';

  var spSeen = {};
  aged.forEach(function(e){ spSeen[e.species] = true; });
  var species = Object.keys(spSeen);

  if (species.length > 1) {
    html += '<div class="scard-sub-t" style="margin-top:14px;">By species</div>';
    species.forEach(function(sp) {
      var spEntries = aged.filter(function(e){ return e.species === sp; });
      var spCounts = {};
      AGE_CLASSES.forEach(function(a){ spCounts[a] = 0; });
      spEntries.forEach(function(e){
        var ageKey = normalizeAgeClassLabel(e.age_class);
        if (spCounts[ageKey] !== undefined) spCounts[ageKey]++;
      });
      var spMax = Math.max.apply(null, AGE_CLASSES.map(function(a){ return spCounts[a]; }).concat([1]));
      var clr = SP_COLORS_D[sp] || '#5a7a30';

      html += '<div class="age-sp-section">';
      html += '<div class="age-sp-hdr"><div class="age-sp-dot" style="background:'+clr+';"></div><div class="age-sp-nm">'+esc(sp)+'</div></div>';
      AGE_CLASSES.forEach(function(ac, i) {
        var cnt = spCounts[ac];
        if (!cnt) return;
        var barPct = Math.round(cnt/spMax*100);
        html += '<div class="age-mini-row">'
          + '<div class="age-mini-lbl">'+ac+'</div>'
          + '<div class="age-mini-bw"><div class="age-mini-bf" style="width:'+barPct+'%;background:'+AGE_COLORS[i]+';"></div></div>'
          + '<div class="age-mini-cnt">'+cnt+'</div>'
          + '</div>';
      });
      html += '</div>';
    });
  }

  chart.innerHTML = html;
}

// ── buildTrendsChart ──────────────────────────────────────────────────────
// Card is only relevant when the user is looking at the whole history (the
// "__all__" season), since per-season the chart has nothing to compare.
// The caller is responsible for passing the currently selected season; we
// don't read globals here. Hides silently when there are fewer than 2
// seasons' worth of data (no useful trend yet).
//
// @param {Array} entries  Every entry the user has access to.
// @param {Object} opts
// @param {string} opts.currentSeason  e.g. '2025-26' or '__all__'.
export function buildTrendsChart(entries, opts) {
  var card  = document.getElementById('trends-card');
  var chart = document.getElementById('trends-chart');
  if (!card || !chart) return;

  var currentSeason = opts && opts.currentSeason;
  if (currentSeason !== '__all__') { card.style.display = 'none'; return; }

  var bySeason = {};
  entries.forEach(function(e) {
    var s = buildSeasonFromEntry(e.date);
    if (!bySeason[s]) bySeason[s] = { count: 0, totalWt: 0, wtN: 0, species: {} };
    bySeason[s].count++;
    if (e.weight_kg) { bySeason[s].totalWt += parseFloat(e.weight_kg); bySeason[s].wtN++; }
    bySeason[s].species[e.species] = true;
  });

  var keys = Object.keys(bySeason).sort();
  if (keys.length < 2) { card.style.display = 'none'; return; }
  // Trim to the most recent 5 seasons — a longer history turns the bar
  // chart into an illegible strip on mobile, and older seasons are less
  // actionable anyway.
  if (keys.length > 5) keys = keys.slice(keys.length - 5);

  card.style.display = 'block';

  var maxCount = Math.max.apply(null, keys.map(function(k){ return bySeason[k].count; }));

  var html = '<div style="font-size:9px;font-weight:700;color:rgba(0,0,0,0.4);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Total cull per season</div>';
  keys.forEach(function(k) {
    var d = bySeason[k];
    var pct = Math.round(d.count / maxCount * 100);
    var avgWt = d.wtN > 0 ? (d.totalWt / d.wtN).toFixed(1) : '–';
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + seasonLabel(k) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:linear-gradient(90deg,#5a7a30,#7adf7a);"></div></div>'
      + '<div class="bar-cnt">' + d.count + '</div>'
      + '</div>';
    html += '<div style="font-size:9px;color:rgba(0,0,0,0.35);margin:-2px 0 6px 0;padding-left:2px;">'
      + 'Avg weight: ' + avgWt + ' kg · ' + Object.keys(d.species).length + ' species'
      + '</div>';
  });

  chart.innerHTML = html;
}

// ── buildGroundStats ──────────────────────────────────────────────────────
// Renders the per-ground cull-count card. Entries with no ground are
// bucketed as "Untagged" and always rendered in grey at the bottom (never
// counted toward the max or sort), so they don't visually compete with
// real grounds. The card hides when zero tagged grounds are present; if
// every entry is untagged, the card is still hidden (nothing to compare).
export function buildGroundStats(entries) {
  var card  = document.getElementById('ground-card');
  var chart = document.getElementById('ground-chart');
  if (!card || !chart) return;

  var counts = {};
  entries.forEach(function(e) {
    var g = (e.ground && e.ground.trim()) ? e.ground.trim() : null;
    if (g) counts[g] = (counts[g]||0) + 1;
    else   counts['__untagged__'] = (counts['__untagged__']||0) + 1;
  });

  var grounds = Object.keys(counts).filter(function(g){ return g !== '__untagged__'; });

  if (grounds.length === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  grounds.sort(function(a,b){ return counts[b]-counts[a]; });
  var maxCnt = Math.max.apply(null, grounds.map(function(g){ return counts[g]; }).concat([1]));

  var html = '';
  grounds.forEach(function(g, i) {
    var cnt = counts[g];
    var pct = Math.round(cnt/maxCnt*100);
    // Top-1 ground gets the "winner" green gradient; everyone else gets
    // gold. Purely decorative — the count column carries the real info.
    var barClr = i === 0
      ? 'linear-gradient(90deg,#5a7a30,#7adf7a)'
      : 'linear-gradient(90deg,#c8a84b,#f0c870)';
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + esc(g) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+barClr+';"></div></div>'
      + '<div class="bar-cnt">'+cnt+'</div>'
      + '</div>';
  });

  if (counts['__untagged__']) {
    var uCnt = counts['__untagged__'];
    var uPct = Math.round(uCnt/maxCnt*100);
    html += '<div class="bar-row">'
      + '<div class="bar-lbl" style="color:var(--muted);font-style:italic;">Untagged</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+uPct+'%;background:#e0dcd6;"></div></div>'
      + '<div class="bar-cnt" style="color:var(--muted);">'+uCnt+'</div>'
      + '</div>';
  }

  chart.innerHTML = html;
}

// ── renderStatsTabBody ────────────────────────────────────────────────────
// Paints every card in the Stats tab that is a pure function of the filtered
// `entries` array: top KPIs, weight grid, species+sex chart, sex chart, the
// seven sub-cards (calibre / distance / age / shooter / destination /
// time-of-day / trends / ground), and the seasonal-month chart.
//
// What this function deliberately does NOT do:
//   • schedule map init / re-render pins
//   • sync the season-pill <select> with the list view
//   • show/hide the plan card or trigger the targets-loading async chain
//   • refresh the syndicate section or export-visibility
//   • read or write module-level mutable state in diary.js
//      (statsNeedsFullRebuild, statsLastBuildSize, cullMap, …)
//
// Those concerns remain in the `buildStats(speciesFilter)` wrapper inside
// diary.js because they need access to live diary-side globals, async
// chains, and the Leaflet map state. This function is the pure paint
// half — it fills in DOM based on the inputs it receives.
//
// @param {Array<Object>} entries
//     Already filtered entries (post species-chip filter if any). The
//     caller is responsible for filtering; this function just paints.
// @param {Object} opts
// @param {string}   opts.currentSeason
//     e.g. '2025-26' or '__all__'. Threaded into buildTrendsChart.
// @param {Function} opts.computeSeasonTargetKpi
//     (totalActual:number) → { targetPct:number|null, … }. Diary.js owns
//     the logic because it reads cullTargets / groundTargets globals.
// @param {Function} opts.formatSeasonTargetSub
//     (totalActual:number, calc) → string. Formats the "X of Y culls" line.
// @param {Function} opts.hasValue
//     (v) → bool. Truthy for anything that isn't null/undefined/''.
//     DI'd so diary.js can share its own implementation.
// @param {Function} opts.statsChartEmpty
//     (message:string) → html. Returns the "no data" placeholder HTML for
//     a chart card. Also DI'd to keep styling hook consistent.
export function renderStatsTabBody(entries, opts) {
  var currentSeason            = opts.currentSeason;
  var computeSeasonTargetKpi   = opts.computeSeasonTargetKpi;
  var formatSeasonTargetSub    = opts.formatSeasonTargetSub;
  var hasValue                 = opts.hasValue;
  var statsChartEmpty          = opts.statsChartEmpty;

  var total = entries.length;
  var kg = entries.reduce(function(s,e){ return s + (parseFloat(e.weight_kg)||0); }, 0);
  var mappedCount = entries.filter(function(e){ return e.lat != null && e.lng != null; }).length;
  var mappedPct = total ? Math.round(mappedCount * 100 / total) : 0;
  var speciesCount = new Set(entries.map(function(e){ return e.species; }).filter(Boolean)).size;
  var weightEntries = entries.filter(function(e){ return hasValue(e.weight_kg); });
  var avgWeight = weightEntries.length ? (kg / weightEntries.length) : 0;
  var distEntries = entries.filter(function(e){ return hasValue(e.distance_m) && parseFloat(e.distance_m) > 0; });
  var avgDist = distEntries.length ? Math.round(distEntries.reduce(function(s, e){ return s + parseFloat(e.distance_m); }, 0) / distEntries.length) : null;
  var maxE = weightEntries.reduce(function(m,e){
    if (!m) return e;
    return parseFloat(e.weight_kg) > parseFloat(m.weight_kg) ? e : m;
  }, null);
  var targetCalc = computeSeasonTargetKpi(total);
  var targetPct = targetCalc.targetPct;

  // Null-safe DOM writes — if the cached HTML is an older version missing any
  // of these IDs (e.g. service worker served a stale diary.html against the
  // latest diary.js), we must not throw here. Throwing would abort this
  // function before the sub-builders run, leaving the More section blank.
  function _setText(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; }
  function _setHtml(id, val) { var el = document.getElementById(id); if (el) el.innerHTML = val; }

  _setText('st-total', total);
  _setText('st-total-sub', 'Mapped ' + mappedCount + '/' + total + ' · ' + mappedPct + '%');
  _setText('st-target', targetPct == null ? '–' : (targetPct + '%'));
  _setText('st-target-sub', formatSeasonTargetSub(total, targetCalc));
  _setText('st-dist', avgDist == null ? '–' : String(avgDist) + 'm');
  _setText('st-dist-sub', distEntries.length > 0
    ? (distEntries.length + ' entr' + (distEntries.length === 1 ? 'y' : 'ies') + ' with distance')
    : 'No shot distances recorded');
  _setText('st-species', speciesCount);

  // Weight grid — four cells: total kg, average, heaviest-ever, missing-weight
  // count. Each cell is styled as a range-cell so the visual rhythm matches
  // the distance-bands grid lower down.
  var weightMeta = maxE ? (esc(maxE.species || '') + (maxE.date ? ' · ' + esc(String(maxE.date).slice(0, 7)) : '')) : 'No carcass weights recorded yet';
  _setHtml('weight-chart',
    '<div class="range-grid">'
      + '<div class="range-cell"><div class="range-band">Total kg</div><div class="range-cnt">' + Math.round(kg) + '</div><div class="range-pct">all recorded entries</div></div>'
      + '<div class="range-cell"><div class="range-band">Average kg</div><div class="range-cnt">' + (weightEntries.length ? avgWeight.toFixed(1) : '–') + '</div><div class="range-pct">' + weightEntries.length + ' weighted entr' + (weightEntries.length === 1 ? 'y' : 'ies') + '</div></div>'
      + '<div class="range-cell"><div class="range-band">Heaviest</div><div class="range-cnt">' + (maxE ? esc(String(maxE.weight_kg)) : '–') + '</div><div class="range-pct">' + weightMeta + '</div></div>'
      + '<div class="range-cell"><div class="range-band">Missing weight</div><div class="range-cnt">' + Math.max(0, total - weightEntries.length) + '</div><div class="range-pct">entries without carcass kg</div></div>'
    + '</div>');

  // Species chart with sex sub-breakdown. Each species row gets the species
  // colour; below each row the male/female sub-rows reuse the same dark-red
  // and dark-purple semitransparent fills that appear in the main Sex chart
  // below, so the two cards reinforce each other rather than competing.
  var spCount = {}, spMale = {}, spFemale = {};
  entries.forEach(function(e){
    spCount[e.species]  = (spCount[e.species]||0)+1;
    if (e.sex==='m') spMale[e.species]   = (spMale[e.species]||0)+1;
    else             spFemale[e.species] = (spFemale[e.species]||0)+1;
  });
  var spMax = Math.max.apply(null, Object.values(spCount).concat([1]));
  // Species palette is intentionally kept local (rather than lifted to the
  // top-of-module SP_COLORS_D) because these 6-hex swatches are slightly
  // darker variants intended for the species chart's main bars, while
  // SP_COLORS_D is tuned for the smaller distance/age species-dots. Keeping
  // both lets designers tweak either without accidentally changing the
  // other.
  var spColors      = {'Red Deer':'#c8a84b','Roe Deer':'#5a7a30','Fallow':'#f57f17','Sika':'#1565c0','Muntjac':'#6a1b9a','CWD':'#00695c'};
  var spMaleLabels  = {'Red Deer':'Stag','Roe Deer':'Buck','Fallow':'Buck','Sika':'Stag','Muntjac':'Buck','CWD':'Buck'};
  var spFemLabels   = {'Red Deer':'Hind','Roe Deer':'Doe','Fallow':'Doe','Sika':'Hind','Muntjac':'Doe','CWD':'Doe'};
  var spHtml = Object.keys(spCount).sort(function(a,b){ return spCount[b]-spCount[a]; }).map(function(sp) {
    var clr = spColors[sp]||'#5a7a30';
    var mCnt = spMale[sp]||0, fCnt = spFemale[sp]||0;
    var mLbl = spMaleLabels[sp]||'Male', fLbl = spFemLabels[sp]||'Female';
    var html = '<div class="bar-row" style="margin-bottom:4px;">'
      + '<div class="bar-lbl" style="font-size:12px;font-weight:700;">' + sp + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:' + (spCount[sp]/spMax*100) + '%;background:' + clr + ';"></div></div>'
      + '<div class="bar-cnt">' + spCount[sp] + '</div></div>';
    if (mCnt > 0) html += '<div class="bar-row" style="padding-left:12px;margin-bottom:3px;">'
      + '<div class="bar-lbl" style="font-size:10px;color:var(--muted);">♂ ' + mLbl + '</div>'
      + '<div class="bar-track" style="height:4px;"><div class="bar-fill" style="width:' + (mCnt/spCount[sp]*100) + '%;background:rgba(191,54,12,0.55);"></div></div>'
      + '<div class="bar-cnt" style="font-size:10px;color:var(--muted);">' + mCnt + '</div></div>';
    if (fCnt > 0) html += '<div class="bar-row" style="padding-left:12px;margin-bottom:8px;">'
      + '<div class="bar-lbl" style="font-size:10px;color:var(--muted);">♀ ' + fLbl + '</div>'
      + '<div class="bar-track" style="height:4px;"><div class="bar-fill" style="width:' + (fCnt/spCount[sp]*100) + '%;background:rgba(136,14,79,0.55);"></div></div>'
      + '<div class="bar-cnt" style="font-size:10px;color:var(--muted);">' + fCnt + '</div></div>';
    return html;
  }).join('');
  _setHtml('species-chart', spHtml || statsChartEmpty('No culls this season'));

  // Top-level Sex chart (card sits below the species one). Uses the same
  // dark-red / dark-purple palette but at full opacity — the detail-level
  // sex sub-rows above use a muted variant on purpose.
  var mCount = entries.filter(function(e){ return e.sex === 'm'; }).length;
  var fCount = entries.filter(function(e){ return e.sex === 'f'; }).length;
  var sexMax = Math.max(mCount, fCount, 1);
  _setHtml('sex-chart',
    '<div class="bar-row"><div class="bar-lbl">♂ Male</div><div class="bar-track"><div class="bar-fill" style="width:' + (mCount/sexMax*100) + '%;background:rgba(191,54,12,0.75);"></div></div><div class="bar-cnt">' + mCount + '</div></div>' +
    '<div class="bar-row"><div class="bar-lbl">♀ Female</div><div class="bar-track"><div class="bar-fill" style="width:' + (fCount/sexMax*100) + '%;background:rgba(136,14,79,0.75);"></div></div><div class="bar-cnt">' + fCount + '</div></div>');

  // Fan out to the seven sub-builders. Each one is independently self-
  // contained: it reads its own card + chart elements by id, hides the
  // card when its data is uninteresting, and writes HTML only once.
  buildCalibreDistanceStats(entries);
  buildAgeStats(entries);
  buildShooterStats(entries);
  buildDestinationStats(entries);
  buildTimeOfDayStats(entries);
  buildTrendsChart(entries, { currentSeason: currentSeason });
  buildGroundStats(entries);

  // Monthly chart — 12 columns in UK-deer-season order (Aug → Jul). A bar's
  // height is scaled to the peak month's count but capped at 60px; empty
  // months get a 3px stub with 40% opacity so every column still reads as
  // present. The peak month gets the `.pk` accent class.
  var mCount2 = {};
  entries.forEach(function(e) {
    if (!e.date) return;
    var dp = String(e.date).trim().split('-');
    var m = parseInt(dp[1], 10);
    if (!Number.isFinite(m) || m < 1 || m > 12) return;
    mCount2[m] = (mCount2[m] || 0) + 1;
  });
  var mMax = Math.max.apply(null, Object.values(mCount2).concat([1]));
  var seasonMonths = [8,9,10,11,12,1,2,3,4,5,6,7];
  var peakCount = Math.max.apply(null, Object.values(mCount2).concat([0]));
  var mHtml = seasonMonths.map(function(m) {
    var cnt = mCount2[m]||0;
    var h = cnt ? Math.max(6, Math.round(cnt/mMax*60)) : 3;
    var cls = cnt ? (cnt === peakCount ? 'mc-bar pk' : 'mc-bar on') : 'mc-bar';
    return '<div class="mc-col"><div class="' + cls + '" style="height:' + h + 'px;' + (cnt ? '' : 'opacity:0.4;') + '"></div><div class="mc-lbl">' + MONTH_NAMES[m-1] + '</div></div>';
  }).join('');
  _setHtml('month-chart', mHtml);
}
