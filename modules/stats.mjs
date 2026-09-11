// First Light — modules/stats.mjs
// =============================================================================
// Stats-tab data tables, pure aggregators, and their DOM paint wrappers.
// Extracted from diary.js across several commits; see MODULARISATION-PLAN.md.
//
// Scope of this module:
//   Data tables (pure lookups — Commit H):
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

import { esc, seasonLabel, buildSeasonFromEntry, MONTH_NAMES, normalizeSeasonStartMonth } from '../lib/fl-pure.mjs';

// ── Shared palettes / age labels ──────────────────────────────────────────

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
  'CWD':      '#00695c',
  // Pest Control (v3) — matches lib/fl-pure.mjs QUARRY_SPECIES colours.
  'Fox':           '#b45f2a',
  'Rabbit':        '#c9a05a',
  'Grey Squirrel': '#8a8f98',
  'Pigeon':        '#46688a',
  'Corvid':        '#2f3237',
  'Wild Boar':     '#5c4a38'
};

/** Age classes in canonical order (juvenile → mature). */
export const AGE_CLASSES = ['Calf / Kid / Fawn', 'Yearling', '2–4 years', '5–8 years', '9+ years'];

/**
 * A11 - one colour vocabulary for the whole Stats page.
 *
 * Five cards each invented their own six-hue categorical palette out of the
 * same six hues. Inside 140px of scroll, gold meant "West Acre", "Red Deer",
 * "Game dealer", "Morning" AND "2-4 years"; purple meant "Muntjac", "Stalking
 * client" and "Dusk". A reader who learns a colour on one card is then actively
 * misled by the next one.
 *
 * Species is the only dimension here whose colour is real - it is the same
 * palette as the map pins, the diary chips, the season hero and the PDF - so it
 * keeps hue as identity. Everywhere else hue was decoration dressed as data:
 * these are ranked lists whose label and count already carry the meaning, and
 * whose bar length already carries the order. They now share one neutral bark
 * bar, so nothing on the page claims a meaning it does not have.
 *
 * Two exceptions earn their colour: "Condemned" stays red because red means
 * loss everywhere in this app, and the not-recorded / untagged ghosts stay pale
 * so absence never looks like a category.
 *
 * Genuinely ORDINAL series (age class, time of day) keep a ramp - but a
 * single-hue one, which reads as an axis rather than as a legend.
 */
export const STATS_BAR = 'linear-gradient(90deg,#5c4a38,#8a7259)';
export const STATS_BAR_GHOST = 'linear-gradient(90deg,#d8d1c6,#e6e0d6)';
export const STATS_BAR_ALERT = 'linear-gradient(90deg,#c62828,#ef5350)';

/** Single-hue ordinal ramp, pale (first) to dark (last). */
export const STATS_RAMP = ['#b8a58e', '#9c8770', '#806a54', '#67543f', '#4e3d2c'];
export function statsRampColor(i, n) {
  if (!(n > 1)) return STATS_RAMP[STATS_RAMP.length - 1];
  var idx = Math.round(i / (n - 1) * (STATS_RAMP.length - 1));
  return STATS_RAMP[Math.max(0, Math.min(STATS_RAMP.length - 1, idx))];
}

/** One colour per AGE_CLASSES index (same length + order) - now an ordinal
 *  ramp: pale = young, dark = mature. The old green-to-red ramp borrowed a
 *  good-to-bad vocabulary that age class does not have. */
export const AGE_COLORS = STATS_RAMP.slice();

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
 * Animals represented by one diary row. Deer/fox/boar rows are always 1;
 * Pest Control rows carry `quantity` (a 12-rabbit evening = one row, 12
 * animals). ST3: every cull chart counts animals so the whole stats page
 * reconciles with the headline Total cull and the species bars (PQ2b) —
 * previously six charts counted rows and their numbers disagreed with the
 * headline on any diary containing pest bags.
 */
export function entryAnimals(e) {
  var q = e ? (e.quantity | 0) : 0;
  return q > 0 ? q : 1;
}

/**
 * ST6 - one ruler for the whole page.
 *
 * Every cull chart used to scale to its OWN tallest bar. Three consequences,
 * all of them lies the user had no way to detect:
 *   - a card holding a single value ("Carcass destination: Self 1") drew a
 *     full-width bar and read as "all of them", when it was 1 of 10;
 *   - the species card stacked two rulers 4px apart (parent bars against the
 *     global max, the sex sub-bars against that species' own total), so one
 *     Red stag rendered a quarter-width bar above a full-width one;
 *   - no two cards were comparable, because each had a private denominator.
 *
 * Now every bar is a share of the SAME number the headline counts: animals in
 * scope. A 3% floor keeps one animal visible without implying more.
 */
export function statsAnimalsIn(entries) {
  return (entries || []).reduce(function(sum, e){ return sum + entryAnimals(e); }, 0);
}

export function statsBarPct(cnt, total) {
  if (!total || total <= 0 || !cnt) return 0;
  var p = cnt / total * 100;
  if (p < 3) return 3;
  return Math.round(p * 10) / 10;
}

/**
 * Coverage footnote. A card that describes part of the season must say so, in
 * the same unit as the headline. Silent at full coverage - a note that always
 * fires is a note nobody reads.
 */
export function statsCoverageNote(covered, total, verbPhrase) {
  if (!total || covered >= total) return '';
  return '<div class="stats-cov-note">' + covered + ' of ' + total + ' animal'
    + (total === 1 ? '' : 's') + ' ' + verbPhrase + ' \u00b7 ' + (total - covered) + ' not recorded</div>';
}

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
    counts[s] = (counts[s] || 0) + entryAnimals(e);
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
    if (e && e.destination) counts[e.destination] = (counts[e.destination] || 0) + entryAnimals(e);
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
  // A11: ordinal by daylight, so the ramp itself is the axis - pale at dawn,
  // darkest at night. Six unrelated hues here were the single biggest source of
  // cross-card colour collisions (purple "Dusk" vs purple "Muntjac").
  { label: 'Dawn (05–07)',      min: 5,  max: 7,  clr: 'linear-gradient(90deg,#c8b7a2,#ddd0be)' },
  { label: 'Morning (08–10)',   min: 8,  max: 10, clr: 'linear-gradient(90deg,#b8a58e,#cec0ac)' },
  { label: 'Midday (11–14)',    min: 11, max: 14, clr: 'linear-gradient(90deg,#9c8770,#b5a48d)' },
  { label: 'Afternoon (15–17)', min: 15, max: 17, clr: 'linear-gradient(90deg,#806a54,#9c8770)' },
  { label: 'Dusk (18–20)',      min: 18, max: 20, clr: 'linear-gradient(90deg,#67543f,#806a54)' },
  { label: 'Night (21–04)',     min: -1, max: -1, clr: 'linear-gradient(90deg,#3b2e22,#5c4a38)' }
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
    counts[categorizeHourToBucket(h)] += entryAnimals(e);
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
// `.bar-fill` / `.bar-cnt` in `diary.css`; the fill is inlined as a `style`
// attribute because it is data, not decoration. A11 flattened the old
// per-series palettes into three shared constants: STATS_BAR for an ordinary
// row, STATS_BAR_GHOST for a "not recorded" row, STATS_BAR_ALERT for the one
// row that is bad news (Condemned). Rank is carried by bar length; hue is
// reserved for the two states length cannot express. Time-of-day and species
// still carry meaning-bearing colour of their own.

/** Render the Shooter-breakdown card. Hides the card when every entry was
 *  shot by "Self" (no useful comparison to draw). */
export function buildShooterStats(entries) {
  var card  = document.getElementById('shooter-card');
  var chart = document.getElementById('shooter-chart');
  if (!card || !chart) return;

  var agg = aggregateShooterStats(entries);

  if (agg.isAllSelf) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  var shTot = statsAnimalsIn(entries);
  var html = '';
  agg.sortedNames.forEach(function(s) {
    var cnt = agg.counts[s];
    var pct = statsBarPct(cnt, shTot);
    // A11: rank is carried by bar length, not by hue.
    var barClr = STATS_BAR;
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

  // A11: six hues for seven destinations was a legend nobody could learn, built
  // from the same six hues the species chart uses for something else entirely.
  // The label states the destination; the bar states the share. Only Condemned
  // keeps a colour, because losing a carcass is the one row that is bad news.
  var destColors = { 'Condemned': STATS_BAR_ALERT };

  var dTot = statsAnimalsIn(entries);
  var dCovered = agg.sortedNames.reduce(function(sum, d){ return sum + agg.counts[d]; }, 0);
  var html = '';
  agg.sortedNames.forEach(function(d) {
    var cnt = agg.counts[d];
    var pct = statsBarPct(cnt, dTot);
    var barClr = destColors[d] || STATS_BAR;
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + esc(d) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+barClr+';"></div></div>'
      + '<div class="bar-cnt">'+cnt+'</div>'
      + '</div>';
  });
  // ST6: the missing nine are part of the answer. Drawn as a ghost row rather
  // than left out, so "Self 1" cannot be read as "all of them".
  if (dCovered < dTot) {
    html += '<div class="bar-row">'
      + '<div class="bar-lbl" style="color:var(--muted);font-style:italic;">Not recorded</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+statsBarPct(dTot - dCovered, dTot)+'%;background:'+STATS_BAR_GHOST+';"></div></div>'
      + '<div class="bar-cnt" style="color:var(--muted);">'+(dTot - dCovered)+'</div>'
      + '</div>';
  }
  html += statsCoverageNote(dCovered, dTot, 'have a destination');
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

  var tTot = statsAnimalsIn(entries);
  var html = '';
  for (var j = 0; j < agg.buckets.length; j++) {
    if (agg.counts[j] === 0) continue;
    var pct = statsBarPct(agg.counts[j], tTot);
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + agg.buckets[j].label + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+agg.buckets[j].clr+';"></div></div>'
      + '<div class="bar-cnt">'+agg.counts[j]+'</div>'
      + '</div>';
  }
  html += statsCoverageNote(agg.total, tTot, 'have a time');
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
      calCount[c] = (calCount[c]||0) + entryAnimals(e); // ST6: animals, like every other card
      if (e.distance_m) {
        if (!calDist[c]) calDist[c] = [];
        calDist[c].push(e.distance_m);
      }
    });
    var sorted = Object.keys(calCount).sort(function(a,b){ return calCount[b]-calCount[a]; });
    var calTot = statsAnimalsIn(entries);
    var calCovered = sorted.reduce(function(sum, c){ return sum + calCount[c]; }, 0);
    var calShown = 0;

    var html = '';
    sorted.slice(0,6).forEach(function(cal, i) {
      var cnt = calCount[cal];
      calShown += cnt;
      var pct = statsBarPct(cnt, calTot);
      var avgDist = calDist[cal] && calDist[cal].length
        ? Math.round(calDist[cal].reduce(function(s,v){return s+v;},0)/calDist[cal].length)
        : null;
      html += '<div class="cal-row">'
        + '<div class="cal-name">' + esc(cal) + '</div>'
        // ST5 then A11: rank charts speak one dialect page-wide, and that
        // dialect is length. The retired CAL_COLORS ranked rainbow was the
        // chart whose hues meant nothing; the green-leader/gold-rest split
        // that briefly replaced it went the same way, for the same reason.
        + '<div class="cal-bar-wrap"><div class="cal-bar" style="width:'+pct+'%;background:'+STATS_BAR+';"></div></div>'
        + '<div class="cal-cnt">' + cnt + '</div>'
        + '<div class="cal-avg-lbl">' + (avgDist ? avgDist+'m' : '–') + '</div>'
        + '</div>';
    });
    // Top-6 rule keeps the card readable; say so rather than silently dropping
    // the tail, and state the denominator the bars are drawn against.
    if (sorted.length > 6) {
      html += '<div class="stats-cov-note">Top 6 of ' + sorted.length + ' calibres \u00b7 ' + (calCovered - calShown) + ' animal'
        + ((calCovered - calShown) === 1 ? '' : 's') + ' in the rest</div>';
    }
    html += statsCoverageNote(calCovered, calTot, 'have a calibre');
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

    // ST4: the overall-average box is gone — it repeated the Avg distance KPI
    // word for word ("180m · 1 entry with distance", twice on one page). The
    // KPI is the average's one home; this card's own content is the
    // by-species comparison and the range bands.
    var html = '';

    if (spAvgs.length > 1) {
      html += '<div class="scard-sub-t">By species</div>';
      spAvgs.forEach(function(s) {
        var clr = SP_COLORS_D[s.sp] || '#5a7a30';
        var pct = Math.round(s.avg/maxAvg*100);
        html += '<div class="dist-sp-row">'
          + '<div class="dist-sp-dot" style="background:'+clr+';"></div>'
          + '<div class="dist-sp-name">'+esc(s.sp)+'</div>'
          + '<div class="dist-bar-wrap"><div class="dist-bar" style="width:'+pct+'%;background:'+clr+';"></div></div>'
          + '<div class="dist-val">'+s.avg+'m</div>'
          + '</div>';
      });
    }

    // ST4: skip-zero bands — only ranges you've actually shot at render
    // (matching time-of-day). Three "0 · 0% of culls" cells around one real
    // one asserted nothing.
    html += '<div class="scard-sub-t"' + (spAvgs.length > 1 ? ' style="margin-top:14px;"' : '') + '>Distance bands</div>'
      + '<div class="range-grid">';
    bands.forEach(function(b, i) {
      var cnt = bandCounts[i];
      if (!cnt) return;
      var pct = totalBand ? Math.round(cnt/totalBand*100) : 0;
      // Honest denominator: the bands only cover culls WITH a distance, so
      // "% of culls" over-claimed whenever some culls had none. Below five
      // ranged culls a percentage is noise anyway — show the plain fraction.
      var pctLine = totalBand >= 5
        ? pct + '% of culls with distance'
        : cnt + ' of ' + totalBand + ' with distance';
      html += '<div class="range-cell">'
        + '<div class="range-band">'+b.label+'</div>'
        + '<div class="range-cnt">'+cnt+'</div>'
        + '<div class="range-pct">'+pctLine+'</div>'
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
    if (counts[ageKey] !== undefined) counts[ageKey] += entryAnimals(e);
  });
  // ST6: animals, not rows. This card counted 7 while the species card two
  // cards up counted 10, on the same screen, with neither naming its unit.
  // And the percentages are now shares of the SEASON, not of the aged subset -
  // "2-4 years 100%" sitting beside "Not recorded 4" contradicted itself.
  var total = statsAnimalsIn(entries);
  var agedAnimals = statsAnimalsIn(aged);

  // ST4: skip-zero — the ladder shows the classes you've actually culled
  // (matching the time-of-day chart and the per-species minis below). Five
  // fixed rows around one real one read as four dead dashes, not structure.
  var html = '';
  AGE_CLASSES.forEach(function(ac, i) {
    var cnt = counts[ac];
    if (!cnt) return;
    var pct = total ? Math.round(cnt/total*100) : 0;
    var barPct = statsBarPct(cnt, total);
    html += '<div class="age-row">'
      + '<div class="age-lbl">' + ac + '</div>'
      + '<div class="age-bar-wrap"><div class="age-bar" style="width:'+barPct+'%;background:'+AGE_COLORS[i]+';"></div></div>'
      + '<div class="age-cnt">' + cnt + '</div>'
      + '<div class="age-pct">' + pct + '%</div>'
      + '</div>';
  });

  var notRecorded = total - agedAnimals;
  html += '<div class="age-summary">';
  Object.keys(AGE_GROUPS).forEach(function(grp) {
    var grpCnt = AGE_GROUPS[grp].reduce(function(s,a){ return s+(counts[a]||0); }, 0);
    if (!grpCnt) return; // ST4: no "Juvenile 0 · 0%" dead pills
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
        if (spCounts[ageKey] !== undefined) spCounts[ageKey] += entryAnimals(e);
      });
      var clr = SP_COLORS_D[sp] || '#5a7a30';

      html += '<div class="age-sp-section">';
      html += '<div class="age-sp-hdr"><div class="age-sp-dot" style="background:'+clr+';"></div><div class="age-sp-nm">'+esc(sp)+'</div></div>';
      AGE_CLASSES.forEach(function(ac, i) {
        var cnt = spCounts[ac];
        if (!cnt) return;
        var barPct = statsBarPct(cnt, total); // same ruler as the card above it
        html += '<div class="age-mini-row">'
          + '<div class="age-mini-lbl">'+ac+'</div>'
          + '<div class="age-mini-bw"><div class="age-mini-bf" style="width:'+barPct+'%;background:'+AGE_COLORS[i]+';"></div></div>'
          + '<div class="age-mini-cnt">'+cnt+'</div>'
          + '</div>';
      });
      html += '</div>';
    });
  }

  html += statsCoverageNote(agedAnimals, total, 'have an age class');
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
// @param {number} [opts.seasonStartMonth]  1–12 (default 8/August) — the
//     USER's "season starts in" month (Stats is a personal-only page, so
//     this is never a syndicate's month). Buckets bars and formats labels;
//     omitted ⇒ historical Aug–Jul behaviour exactly.
export function buildTrendsChart(entries, opts) {
  var card  = document.getElementById('trends-card');
  var chart = document.getElementById('trends-chart');
  if (!card || !chart) return;

  var currentSeason = opts && opts.currentSeason;
  var seasonStartMonth = opts && opts.seasonStartMonth;
  if (currentSeason !== '__all__') { card.style.display = 'none'; return; }

  var bySeason = {};
  entries.forEach(function(e) {
    var s = buildSeasonFromEntry(e.date, seasonStartMonth);
    if (!bySeason[s]) bySeason[s] = { count: 0, totalWt: 0, wtN: 0, species: {} };
    bySeason[s].count += entryAnimals(e);
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

  var html = '<div style="font-size:10px;font-weight:700;color:rgba(0,0,0,0.4);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Total cull per season</div>';
  keys.forEach(function(k) {
    var d = bySeason[k];
    var pct = Math.round(d.count / maxCount * 100);
    var avgWt = d.wtN > 0 ? (d.totalWt / d.wtN).toFixed(1) : '–';
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + seasonLabel(k, seasonStartMonth) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+STATS_BAR+';"></div></div>'
      + '<div class="bar-cnt">' + d.count + '</div>'
      + '</div>';
    html += '<div style="font-size:10px;color:rgba(0,0,0,0.35);margin:-2px 0 6px 0;padding-left:2px;">'
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
/**
 * PURE: the cull-density strip under the ground chart (G3 — GROUNDS-PLAN §5).
 * `counts` = animal-based tallies per ground (the buildGroundStats shape);
 * `areasHa` = {ground: hectares} from real drawn boundaries (lib/fl-geo via
 * diary.js groundAreasHaFrom). Only grounds with BOTH culls and a boundary
 * appear — no boundary, no number (hide-when-empty law). Density = animals
 * per 100 ha this season, the DMG dialect.
 */
export function groundDensityNoteHtml(counts, areasHa) {
  if (!counts || !areasHa) return '';
  var parts = [];
  Object.keys(counts)
    .filter(function(g) { return g !== '__untagged__' && areasHa[g] > 0; })
    .sort(function(a, b) { return counts[b] - counts[a]; })
    .forEach(function(g) {
      var d = counts[g] * 100 / areasHa[g];
      var dTxt = d >= 10 ? String(Math.round(d)) : d.toFixed(1);
      parts.push(esc(g) + ' ' + dTxt);
    });
  if (!parts.length) return '';
  return '<div class="ground-density-note">Cull density · ' + parts.join(' · ') + ' per 100 ha</div>';
}

export function buildGroundStats(entries, opts) {
  var card  = document.getElementById('ground-card');
  var chart = document.getElementById('ground-chart');
  if (!card || !chart) return;

  var counts = {};
  entries.forEach(function(e) {
    var q = entryAnimals(e);
    var g = (e.ground && e.ground.trim()) ? e.ground.trim() : null;
    if (g) counts[g] = (counts[g]||0) + q;
    else   counts['__untagged__'] = (counts['__untagged__']||0) + q;
  });

  var grounds = Object.keys(counts).filter(function(g){ return g !== '__untagged__'; });

  if (grounds.length === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  grounds.sort(function(a,b){ return counts[b]-counts[a]; });
  // ST6: shared denominator - every ground bar is a share of the season's
  // animals, so this card is comparable with the species card beside it.
  var gTot = statsAnimalsIn(entries);

  var html = '';
  grounds.forEach(function(g, i) {
    var cnt = counts[g];
    var pct = statsBarPct(cnt, gTot);
    // A11: the old green/gold split was, by its own comment, "purely
    // decorative" - and it spent gold, which the species chart 140px below
    // spends on Red Deer. The list is already sorted; length says the rest.
    var barClr = STATS_BAR;
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + esc(g) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+barClr+';"></div></div>'
      + '<div class="bar-cnt">'+cnt+'</div>'
      + '</div>';
  });

  if (counts['__untagged__']) {
    var uCnt = counts['__untagged__'];
    // ST6: on the shared ruler an untagged pile can no longer out-run the
    // track - it is a share of the same total as every other row here.
    var uPct = statsBarPct(uCnt, gTot);
    html += '<div class="bar-row">'
      + '<div class="bar-lbl" style="color:var(--muted);font-style:italic;">Untagged</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+uPct+'%;background:'+STATS_BAR_GHOST+';"></div></div>'
      + '<div class="bar-cnt" style="color:var(--muted);">'+uCnt+'</div>'
      + '</div>';
  }

  // G3: cull density per 100 ha for grounds with a drawn boundary.
  html += groundDensityNoteHtml(counts, opts && opts.groundAreasHa);

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
// @param {Function} opts.hasValue
//     (v) → bool. Truthy for anything that isn't null/undefined/''.
//     DI'd so diary.js can share its own implementation.
// @param {Function} opts.statsChartEmpty
//     (message:string) → html. Returns the "no data" placeholder HTML for
//     a chart card. Also DI'd to keep styling hook consistent.
// @param {number} [opts.outingTotal]  all diary rows in scope (culls + blank days)
// @param {number} [opts.outingBlank]  blank-day rows in scope
// @param {number} [opts.seasonStartMonth]  1–12 (default 8/August) — the
//     USER's "season starts in" month (personal-only page). Threaded into
//     buildTrendsChart (bucketing + labels) and rotates the monthly chart's
//     column order to start at this month. Omitted ⇒ Aug→Jul exactly.
export function renderStatsTabBody(entries, opts) {
  var currentSeason            = opts.currentSeason;
  var computeSeasonTargetKpi   = opts.computeSeasonTargetKpi;
  var hasValue                 = opts.hasValue;
  var statsChartEmpty          = opts.statsChartEmpty;
  var outingTotal              = opts.outingTotal != null ? opts.outingTotal : entries.length;
  var outingBlank              = opts.outingBlank != null ? opts.outingBlank : 0;
  var seasonStartMonth         = opts.seasonStartMonth;

  var total = entries.length;
  var kg = entries.reduce(function(s,e){ return s + (parseFloat(e.weight_kg)||0); }, 0);
  var speciesCount = new Set(entries.map(function(e){ return e.species; }).filter(Boolean)).size;
  var weightEntries = entries.filter(function(e){ return hasValue(e.weight_kg); });
  var avgWeight = weightEntries.length ? (kg / weightEntries.length) : 0;
  var distEntries = entries.filter(function(e){ return hasValue(e.distance_m) && parseFloat(e.distance_m) > 0; });
  var avgDist = distEntries.length ? Math.round(distEntries.reduce(function(s, e){ return s + parseFloat(e.distance_m); }, 0) / distEntries.length) : null;
  var maxE = weightEntries.reduce(function(m,e){
    if (!m) return e;
    return parseFloat(e.weight_kg) > parseFloat(m.weight_kg) ? e : m;
  }, null);
  // Season-target KPI is DEER-ONLY: fox + pest cull rows must not count toward a
  // deer target. diary.js hands the deer-row count in opts.targetRows; `total`
  // (all cull rows) stays the "across N entries" sub + no-target species split.
  var targetRows = (opts.targetRows != null) ? opts.targetRows : total;
  var targetCalc = computeSeasonTargetKpi(targetRows);
  // Missing-weight counts WEIGHABLE rows only (deer); pests never record weight.
  var weighableRows = (opts.weighableRows != null) ? opts.weighableRows : total;

  // Null-safe DOM writes — if the cached HTML is an older version missing any
  // of these IDs (e.g. service worker served a stale diary.html against the
  // latest diary.js), we must not throw here. Throwing would abort this
  // function before the sub-builders run, leaving the More section blank.
  function _setText(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; }
  function _setHtml(id, val) { var el = document.getElementById(id); if (el) el.innerHTML = val; }

  // PQ2b: the headline "Total cull" counts ANIMALS (sum of per-entry quantity, so
  // a 200-bird pigeon bag counts in full) — matching the diary list header. `total`
  // stays the cull-ROW count: it is what the deer-based Season target KPI measures
  // against (stashed on data-rows below and read by refreshSeasonTargetKpi) so a big
  // pest bag can never inflate the target %.
  var animals = entries.reduce(function(s, e){ return s + entryAnimals(e); }, 0);
  _setText('st-total', animals);
  var _sttEl = document.getElementById('st-total');
  if (_sttEl) _sttEl.setAttribute('data-rows', String(targetRows));
  // Finding 34: st-total-sub, st-target and st-target-sub were written here to
  // elements diary.html has not contained since the season-hero redesign. The hero
  // owns all three facts now - #st-total + #sh-of carry "N / target", #sh-cap the
  // percentage and the pace status, and #sh-note the A3 animals-vs-deer-rows
  // reconciliation this sub used to attempt. The writes painted nothing, and the
  // only place those ids still existed was the test stub asserting them, which is
  // exactly how four dead writes outlived the redesign that removed their cells.
  _setText('st-outing-total', String(outingTotal));
  _setText('st-outing-blank', String(outingBlank));
  // 14.14 (visual pass P3-V4): "1 Blank days" is not English — the labels
  // follow their counts, the st-dist-l pattern.
  _setText('st-outing-total-l', outingTotal === 1 ? 'Outing' : 'Outings');
  _setText('st-outing-blank-l', outingBlank === 1 ? 'Blank day' : 'Blank days');
  _setText('st-dist', avgDist == null ? '–' : String(avgDist) + 'm');
  // A4: one shot is not an average. With a single ranged cull the KPI named
  // itself "Avg dist" and presented 180m as the season's typical shot. The
  // label now carries the sample size, so the headline cannot over-claim.
  _setText('st-dist-l', distEntries.length === 1
    ? 'Shot dist (1)'
    : (distEntries.length > 1 ? 'Avg dist (' + distEntries.length + ')' : 'Avg dist'));
  // st-dist-sub removed with the others: the A4 label above already carries the
  // sample size, which is the whole of what that sub said.
  _setText('st-species', speciesCount);

  // Adaptive season hero (design pass): diary.js paints it; we just hand over the
  // numbers. `entries` here is already cull-only (blank days filtered by caller).
  if (typeof opts.renderSeasonHero === 'function') {
    var heroCounts = {};
    entries.forEach(function(e){ if (e && e.species) heroCounts[e.species] = (heroCounts[e.species] || 0) + entryAnimals(e); });
    opts.renderSeasonHero({ total: total, targetRows: targetRows, animals: animals, targetCalc: targetCalc, speciesCounts: heroCounts });
  }

  // Weight grid — four cells: total kg, average, heaviest-ever, missing-weight
  // count. Each cell is styled as a range-cell so the visual rhythm matches
  // the distance-bands grid lower down.
  // ST2: hidden until anything is weighed — with zero weights every cell was
  // a dead zero or dash ("Total kg 0 · Average – · Heaviest –"), and "Missing
  // weight" only means something once there are weights to be missing from.
  var weightCard = document.getElementById('weight-card');
  if (weightEntries.length === 0) {
    if (weightCard) weightCard.style.display = 'none';
  } else {
    if (weightCard) weightCard.style.display = 'block';
    // 14.14 (visual pass P3-V4): "2026-08" is a database's month — the tile
    // says "Aug 2026" like everything else in the app.
    var _hm = String(maxE.date || '').slice(0, 7).split('-');
    var _hmName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(+_hm[1] || 0) - 1] || '';
    var weightMeta = esc(maxE.species || '') + (maxE.date ? ' · ' + esc(_hmName ? _hmName + ' ' + _hm[0] : String(maxE.date).slice(0, 7)) : '');
    _setHtml('weight-chart',
      '<div class="range-grid">'
        + '<div class="range-cell"><div class="range-band">Total kg</div><div class="range-cnt">' + Math.round(kg) + '</div><div class="range-pct">all recorded entries</div></div>'
        + '<div class="range-cell"><div class="range-band">Average kg</div><div class="range-cnt">' + avgWeight.toFixed(1) + '</div><div class="range-pct">' + weightEntries.length + ' weighted entr' + (weightEntries.length === 1 ? 'y' : 'ies') + '</div></div>'
        + '<div class="range-cell"><div class="range-band">Heaviest</div><div class="range-cnt">' + esc(String(maxE.weight_kg)) + '</div><div class="range-pct">' + weightMeta + '</div></div>'
        + '<div class="range-cell"><div class="range-band">Missing weight</div><div class="range-cnt">' + Math.max(0, weighableRows - weightEntries.length) + '</div><div class="range-pct">entries without carcass kg</div></div>'
      + '</div>');
  }

  // Species chart with sex sub-breakdown. Each species row gets the species
  // colour; below each row the male/female sub-rows reuse the same dark-red
  // and dark-purple semitransparent fills that appear in the main Sex chart
  // below, so the two cards reinforce each other rather than competing.
  var spCount = {}, spMale = {}, spFemale = {};
  entries.forEach(function(e){
    // PQ2b: species bars count ANIMALS (per-entry quantity) so a 200-bird pigeon
    // row shows 200, matching the headline. Sexed species (deer/fox/boar) are
    // always quantity 1, so animals === rows for them and the sex sub-bar widths
    // (mCnt/spCount) stay ≤100%. Sex sub-rows count only rows that are genuinely
    // male/female — a sex-less pest row (NULL sex) must NOT be bucketed as female
    // (the old `else` did exactly that).
    var q = e ? (e.quantity | 0) : 0; if (q < 1) q = 1;
    spCount[e.species]  = (spCount[e.species]||0)+q;
    if (e.sex==='m')      spMale[e.species]   = (spMale[e.species]||0)+1;
    else if (e.sex==='f') spFemale[e.species] = (spFemale[e.species]||0)+1;
  });
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
    // ST3: pests fall back to SP_COLORS_D (all 12 species) — previously every
    // pest wore the '#5a7a30' default, indistinguishable from Roe and each other.
    var clr = spColors[sp] || SP_COLORS_D[sp] || '#5a7a30';
    var mCnt = spMale[sp]||0, fCnt = spFemale[sp]||0;
    var mLbl = spMaleLabels[sp]||'Male', fLbl = spFemLabels[sp]||'Female';
    var html = '<div class="bar-row" style="margin-bottom:4px;">'
      + '<div class="bar-lbl" style="font-size:12px;font-weight:700;">' + esc(sp) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:' + statsBarPct(spCount[sp], animals) + '%;background:' + clr + ';"></div></div>'
      + '<div class="bar-cnt">' + spCount[sp] + '</div></div>';
    if (mCnt > 0) html += '<div class="bar-row" style="padding-left:12px;margin-bottom:3px;">'
      + '<div class="bar-lbl" style="font-size:10px;color:var(--muted);">♂ ' + mLbl + '</div>'
      + '<div class="bar-track" style="height:4px;"><div class="bar-fill" style="width:' + statsBarPct(mCnt, animals) + '%;background:rgba(191,54,12,0.55);"></div></div>'
      + '<div class="bar-cnt" style="font-size:10px;color:var(--muted);">' + mCnt + '</div></div>';
    if (fCnt > 0) html += '<div class="bar-row" style="padding-left:12px;margin-bottom:8px;">'
      + '<div class="bar-lbl" style="font-size:10px;color:var(--muted);">♀ ' + fLbl + '</div>'
      + '<div class="bar-track" style="height:4px;"><div class="bar-fill" style="width:' + statsBarPct(fCnt, animals) + '%;background:rgba(136,14,79,0.55);"></div></div>'
      + '<div class="bar-cnt" style="font-size:10px;color:var(--muted);">' + fCnt + '</div></div>';
    return html;
  }).join('');
  // A1: the page's two headline numbers used to differ with nothing to
  // reconcile them - the hero counts deer rows against a deer target, the
  // charts count every animal. Name the unit here, where the gap is visible.
  var spNote = (animals !== total)
    ? '<div class="stats-cov-note">Counts animals \u00b7 ' + animals + ' from ' + total + ' entr' + (total === 1 ? 'y' : 'ies') + ' (a pest bag counts in full)</div>'
    : '';
  _setHtml('species-chart', spHtml ? (spHtml + spNote) : statsChartEmpty('No culls this season'));

  // Top-level Sex chart (card sits below the species one). Uses the same
  // dark-red / dark-purple palette but at full opacity — the detail-level
  // sex sub-rows above use a muted variant on purpose.
  // ST2: hides when no sexed culls exist (empty or pest-only season) — it was
  // the only chart with no hide rule, painting "♂ 0 / ♀ 0" ghost bars.
  var mCount = entries.reduce(function(a, e){ return a + (e.sex === 'm' ? entryAnimals(e) : 0); }, 0);
  var fCount = entries.reduce(function(a, e){ return a + (e.sex === 'f' ? entryAnimals(e) : 0); }, 0);
  var sexCard = document.getElementById('sex-card');
  if (mCount === 0 && fCount === 0) {
    if (sexCard) sexCard.style.display = 'none';
  } else {
    if (sexCard) sexCard.style.display = 'block';
    // A3: this card silently dropped every sex-less animal (pests are logged by
    // quantity with no sex), so a 10-animal season read as 6 males and nothing
    // else. Same ruler as every other card, and the remainder is stated.
    _setHtml('sex-chart',
      '<div class="bar-row"><div class="bar-lbl">♂ Male</div><div class="bar-track"><div class="bar-fill" style="width:' + statsBarPct(mCount, animals) + '%;background:rgba(191,54,12,0.75);"></div></div><div class="bar-cnt">' + mCount + '</div></div>' +
      '<div class="bar-row"><div class="bar-lbl">♀ Female</div><div class="bar-track"><div class="bar-fill" style="width:' + statsBarPct(fCount, animals) + '%;background:rgba(136,14,79,0.75);"></div></div><div class="bar-cnt">' + fCount + '</div></div>' +
      statsCoverageNote(mCount + fCount, animals, 'have a recorded sex'));
  }

  // Fan out to the seven sub-builders. Each one is independently self-
  // contained: it reads its own card + chart elements by id, hides the
  // card when its data is uninteresting, and writes HTML only once.
  buildCalibreDistanceStats(entries);
  buildAgeStats(entries);
  buildShooterStats(entries);
  buildDestinationStats(entries);
  buildTimeOfDayStats(entries);
  buildTrendsChart(entries, { currentSeason: currentSeason, seasonStartMonth: seasonStartMonth });
  buildGroundStats(entries, { groundAreasHa: opts.groundAreasHa });

  // Monthly chart — 12 columns in season order, starting at the user's
  // configured start month (default Aug → Jul). Per-month COUNTS are
  // boundary-independent (calendar months) — only the column ORDER rotates.
  // A bar's height is scaled to the peak month's count but capped at 60px;
  // empty months get a 3px stub with 40% opacity so every column still reads
  // as present. The peak month gets the `.pk` accent class.
  var mCount2 = {};
  entries.forEach(function(e) {
    if (!e.date) return;
    var dp = String(e.date).trim().split('-');
    var m = parseInt(dp[1], 10);
    if (!Number.isFinite(m) || m < 1 || m > 12) return;
    mCount2[m] = (mCount2[m] || 0) + entryAnimals(e); // ST3: animals, matching the headline
  });
  var mMax = Math.max.apply(null, Object.values(mCount2).concat([1]));
  var sm0 = normalizeSeasonStartMonth(seasonStartMonth);
  var seasonMonths = [];
  for (var smi = 0; smi < 12; smi++) seasonMonths.push(((sm0 - 1 + smi) % 12) + 1);
  var peakCount = Math.max.apply(null, Object.values(mCount2).concat([0]));
  // ST2: an empty season shows the shared empty state, not 12 ghost stubs
  // (a skeleton of a chart with no data behind it).
  if (peakCount === 0) {
    _setHtml('month-chart', '<div style="flex:1;align-self:center;">' + statsChartEmpty('No culls this season') + '</div>');
    _setHtml('month-chart-note', '');
  } else {
    // A12: this chart had no axis, no values and an unexplained two-colour
    // split, so a reader could see a shape but could not read a single number
    // off it - and the gold bar looked like a category rather than a maximum.
    // Every column now states its own count, and the note below names the unit
    // and what gold means. One bar per month is few enough to label directly,
    // which beats an axis at this size.
    var mHtml = seasonMonths.map(function(m) {
      var cnt = mCount2[m]||0;
      var h = cnt ? Math.max(6, Math.round(cnt/mMax*60)) : 3;
      var cls = cnt ? (cnt === peakCount ? 'mc-bar pk' : 'mc-bar on') : 'mc-bar';
      return '<div class="mc-col" title="' + MONTH_NAMES[m-1] + ' \u00b7 ' + cnt + ' animal' + (cnt === 1 ? '' : 's') + '">'
        + '<div class="mc-v' + (cnt ? '' : ' zero') + '">' + (cnt || '') + '</div>'
        + '<div class="' + cls + '" style="height:' + h + 'px;' + (cnt ? '' : 'opacity:0.4;') + '"></div>'
        + '<div class="mc-lbl">' + MONTH_NAMES[m-1] + '</div></div>';
    }).join('');
    _setHtml('month-chart', mHtml);
    _setHtml('month-chart-note', 'Animals culled per month \u00b7 gold = busiest ('
      + peakCount + ')');
  }

  // ST2: the collapsed "Charts & breakdowns" toggle's mini histogram is REAL
  // now — one bar per month of the season (same order + counts as the Monthly
  // chart above), peak month in gold. It was 11 bars with heights hardcoded
  // in CSS: decoration masquerading as data on the statistics page. An empty
  // season renders flat baseline stubs — honest emptiness.
  var miniEl = document.getElementById('stats-more-mini-hist');
  if (miniEl) {
    miniEl.innerHTML = seasonMonths.map(function(m) {
      var cnt = mCount2[m] || 0;
      var h = cnt ? Math.max(18, Math.round(cnt / mMax * 100)) : 0;
      var cls = (cnt && cnt === peakCount) ? ' class="pk"' : '';
      return '<span' + cls + (h ? ' style="height:' + h + '%;"' : '') + '></span>';
    }).join('');
  }
}
