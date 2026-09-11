// First Light — modules/stands.mjs
// =============================================================================
// Stands data layer for the v3 Stands feature (STANDS-PLAN.md §2.3,
// STANDS-CODE-MAP.md §11-S4): Supabase CRUD against public.stands
// (owner-only RLS — scripts/migrate-stands.sql) and the batched Open-Meteo
// 7-day forecast assembly, scored per stand via lib/fl-forecast.mjs.
//
// Split contract (the stats.mjs precedent): this module owns data + scoring
// orchestration; diary.js owns views, dispatcher wiring and rendering.
//
// Side effects allowed here (modules/ rule): fetch to api.open-meteo.com
// (already in diary.html connect-src) and localStorage (offline snapshot,
// keyed by FORECAST_CACHE_KEY below, plus a one-time prune of superseded
// 'fl-stands-forecast-*' snapshots left behind by earlier key versions).
//
// Multi-coordinate normalisation (STANDS-CODE-MAP §11-S2): Open-Meteo
// returns a bare object for one location and an ARRAY for several; results
// are matched to stands BY REQUEST INDEX — never by the echoed lat/lng,
// which are grid-snapped.
// =============================================================================

import { calcSunTime, ukHourMin, scoreStandDay } from '../lib/fl-forecast.mjs';
// One shared coordinate rounder (finding G) — see lib/fl-geo.mjs round6().
import { round6 } from '../lib/fl-geo.mjs';

// ── CRUD ────────────────────────────────────────────────────────────────────

// Client-side cap (the migration header confirms it is UI-enforced only, no
// DB constraint). History: 12 → 60 in round 21 (the owner runs a ground with
// 46 high seats), 60 → 150 for launch (multiple grounds can honestly total
// past 60). The forecast fetch is now CHUNKED into batches of
// FORECAST_BATCH_SIZE locations — the old single-URL call was the real
// ceiling (each location adds ~44 chars of query string; 150 in one URL
// walks into proxy 8 KB limits). At 150 seats the cached payload is
// ~1.6 MB, still comfortably inside localStorage quota, and Best-seat-this-
// week keeps scoring the whole estate in one pass.
export var STANDS_MAX = 150;

// Pre-migration tolerance (rounds 30/32): each optional column arrives via
// its own hand-run migration (scripts/migrate-stand-facing.sql and
// migrate-stand-photos.sql). Until one is run, PostgREST answers 42703
// (undefined column) naming it — so both CRUD paths drop ONLY the named
// column, remember it for the session, and retry. Per-column on purpose: a
// database that has facing but not yet photos must keep serving facing, not
// fall all the way back to the round-29 shape.
var OPTIONAL_COLS = ['facing', 'photos', 'facings']; // facings: migrate-stand-facings.sql (14.09)
var _missingCols = {};

/** Client-side photo cap per stand (UI-enforced; storage stays bounded). */
export var STAND_PHOTOS_MAX = 3;

/** The optional column a 42703 error names; '*' if unparseable; null if not a missing-column error. */
function optionalColAbsent(err) {
  if (!err) return null;
  var msg = typeof err.message === 'string' ? err.message : '';
  if (err.code !== '42703' && msg.indexOf('does not exist') === -1) return null;
  var m = /column\s+(?:[\w"]+\.)?"?([a-z_]+)"?/i.exec(msg);
  var name = m ? m[1] : null;
  if (name) return OPTIONAL_COLS.indexOf(name) !== -1 ? name : null;
  return '*';
}

function markMissing(which) {
  if (which === '*') OPTIONAL_COLS.forEach(function(c) { _missingCols[c] = true; });
  else _missingCols[which] = true;
}

var STANDS_BASE_COLS = 'id, name, lat, lng, ground, bad_winds, notes, created_at';

function standSelectCols() {
  var cols = STANDS_BASE_COLS;
  OPTIONAL_COLS.forEach(function(c) { if (!_missingCols[c]) cols += ', ' + c; });
  return cols;
}

export async function fetchStands(sb, userId) {
  var r = null;
  for (var attempt = 0; attempt <= OPTIONAL_COLS.length; attempt++) {
    r = await sb.from('stands')
      .select(standSelectCols())
      .eq('user_id', userId)
      .order('name', { ascending: true });
    if (!r.error) break;
    var miss = optionalColAbsent(r.error);
    if (!miss) break;
    markMissing(miss);
  }
  if (r.error) throw r.error;
  var list = r.data || [];
  // Snapshot the essentials so the score logger (round 12) can match an
  // entry to its stand even in a session that never opened the Stands tab.
  try {
    localStorage.setItem(STANDS_CACHE_KEY, JSON.stringify(list.map(function(s) {
      return { id: s.id, name: s.name, lat: s.lat, lng: s.lng, ground: s.ground || null, bad_winds: s.bad_winds || null };
    })));
  } catch (e) { /* quota — cache is best-effort */ }
  return list;
}

// ── Local snapshots for the save-time score logger (round 12) ───────────────
// diary.js never touches the storage keys directly; these readers keep the
// cache shapes encapsulated here. Both are null/[]-safe on absent or corrupt
// data and NEVER hit the network — save paths must stay fetch-free.

var STANDS_CACHE_KEY = 'fl-stands-cache-v1';

/** Last-fetched stands list ({id,name,lat,lng,ground,bad_winds}), [] if none. */
export function cachedStands() {
  try {
    var arr = JSON.parse(localStorage.getItem(STANDS_CACHE_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

/** Raw forecast snapshot ({ key, ts, data }) as stored, or null. */
export function cachedForecastRaw() {
  if (_memCache.data) return { key: _memCache.key, ts: _memCache.ts, data: _memCache.data };
  try {
    var snap = JSON.parse(localStorage.getItem(FORECAST_CACHE_KEY) || 'null');
    return (snap && snap.key && snap.data) ? snap : null;
  } catch (e) { return null; }
}

/**
 * The one normalisation door for a stand row (finding G: 6 dp coordinates,
 * identical to ground geometry, so a seat is always comparable with a
 * boundary vertex). Both the online save AND the offline outbox queue
 * through here — a seat saved in a dead spot lands in Postgres with exactly
 * the same shape as one saved on wifi.
 */
export function normalizeStandFields(stand) {
  var photos = Array.isArray(stand.photos)
    ? stand.photos.filter(function(p) { return typeof p === 'string' && p; }).slice(0, STAND_PHOTOS_MAX)
    : [];
  return {
    name: stand.name,
    lat: round6(stand.lat),
    lng: round6(stand.lng),
    ground: stand.ground || null,
    bad_winds: (stand.bad_winds && stand.bad_winds.length) ? stand.bad_winds : null,
    notes: (stand.notes && stand.notes.trim()) ? stand.notes.trim() : null,
    // Facing (round 30): compass degrees the seat looks towards, or null to
    // clear. Photos (round 32): bucket-relative paths in cull-photos.
    // Both are memory aids only — no scoring path reads them.
    facing: (typeof stand.facing === 'number' && isFinite(stand.facing))
      ? ((Math.round(stand.facing) % 360) + 360) % 360
      : null,
    // Facings (14.09 — CG733 on the forum: one look direction is not how a
    // seat covering three rides works): up to three EXTRA looks beyond the
    // exact primary, as degrees. Sector-dedupe against the primary happens
    // client-side (flFacingsNorm); this normalize only bounds and caps.
    // Memory aid + wedges only — no scoring path reads them.
    facings: (Array.isArray(stand.facings) && stand.facings.length)
      ? stand.facings
          .map(function(v) { return (typeof v === 'number' && isFinite(v)) ? ((Math.round(v) % 360) + 360) % 360 : null; })
          .filter(function(v, i, a) { return v != null && a.indexOf(v) === i; })
          .slice(0, 3)
      : null,
    photos: photos.length ? photos : null
  };
}

/** Insert (no id) or update (id set). Returns the saved row. */
export async function saveStand(sb, userId, stand) {
  var row = normalizeStandFields(stand);
  row.user_id = userId;
  async function run(payload) {
    if (stand.id) return sb.from('stands').update(payload).eq('id', stand.id).select().single();
    return sb.from('stands').insert(payload).select().single();
  }
  var r = null;
  for (var attempt = 0; attempt <= OPTIONAL_COLS.length; attempt++) {
    OPTIONAL_COLS.forEach(function(c) { if (_missingCols[c]) delete row[c]; });
    r = await run(row);
    if (!r.error) return r.data;
    var miss = optionalColAbsent(r.error);
    if (!miss) break;
    markMissing(miss);
  }
  throw r.error;
}

export async function deleteStand(sb, id) {
  // Fetch the stand's photo paths BEFORE deleting the row so we can purge them
  // from storage afterwards. Stand photos live under <uid>/ in the private
  // cull-photos bucket (migrate-stand-photos.sql) exactly like cull/sighting
  // photos; without this sweep they orphan when the row is deleted (audit P1).
  // Best-effort: an orphaned object is tolerable, a failed row delete is not,
  // so the row delete stays authoritative and storage cleanup is fire-and-forget.
  var photos = null;
  try {
    var sel = await sb.from('stands').select('photos').eq('id', id);
    if (sel && sel.data && sel.data[0] && Array.isArray(sel.data[0].photos)) photos = sel.data[0].photos;
  } catch (_) { /* non-fatal — proceed with the row delete */ }
  var r = await sb.from('stands').delete().eq('id', id);
  if (r.error) throw r.error;
  if (photos && photos.length) {
    var paths = photos.filter(function(p) { return typeof p === 'string' && p; });
    if (paths.length) { try { await sb.storage.from('cull-photos').remove(paths); } catch (_) { /* orphan tolerable */ } }
  }
}

// ── Offline stand outbox ────────────────────────────────────────────────────
// Stands were the last online-only write in the app. The unlock is identity:
// public.stands.id is `uuid default gen_random_uuid()`, so the CLIENT can
// mint the primary key at creation time — no schema change, no reconciliation
// pass. An offline-created seat gets its real, final id immediately; a
// sighting logged at it minutes later (sightings.stand_id is a genuine FK)
// references that id from the start, and the only ordering rule is that this
// outbox flushes BEFORE the entries queue (diary.js syncOfflineQueue does).
//
// Replay is idempotent by construction: creates upsert on the primary key
// (a lost acknowledgement re-runs into DO UPDATE on the committed row —
// the cull_entries client_uuid lesson, but the PK does the work here);
// updates are PARTIAL (.update().eq('id')) and never carry `photos`, because
// the offline cache doesn't hold photo paths and a full-row upsert would
// silently wipe a seat's photos on replay; deletes are naturally idempotent.
// Photos themselves stay online-only — an upload needs signal by definition.
//
// Coalescing keeps the queue one-op-per-stand: create+edit folds into the
// create, create+delete annihilates (nothing ever queued for the server),
// edit+edit merges, edit+delete keeps only the delete. A replayed op that
// fails keeps a per-op attempts counter and dead-letters after
// STAND_OUTBOX_MAX_ATTEMPTS — except a 23505 name clash (the per-ground
// unique index), which dead-letters immediately: retrying a taken name can
// never succeed, and the sync toast names the seat instead of looping.

var STAND_OUTBOX_KEY = 'fl-stand-outbox-v1';
var STAND_OUTBOX_DEAD_KEY = 'fl-stand-outbox-v1-deadletter';
export var STAND_OUTBOX_MAX_ATTEMPTS = 5;

/** RFC 4122 v4 — the stand's real primary key, minted on the device. */
export function mintStandId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (e) { /* fall through */ }
  var b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

function readStandOutboxAll() {
  try {
    var arr = JSON.parse(localStorage.getItem(STAND_OUTBOX_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function writeStandOutboxAll(ops) {
  try { localStorage.setItem(STAND_OUTBOX_KEY, JSON.stringify(ops)); return true; }
  catch (e) { return false; }
}

/** This user's queued ops, oldest first. */
export function standOutbox(userId) {
  return readStandOutboxAll().filter(function (o) { return o && o._user === userId; });
}

export function standOutboxCount(userId) {
  return standOutbox(userId).length;
}

/**
 * Queue an op ({op:'create',id,stand} | {op:'update',id,fields} |
 * {op:'delete',id}), coalescing against any queued op for the same stand.
 * Returns true when persisted (false = storage full — caller must not
 * pretend the save happened).
 */
export function queueStandOp(userId, op) {
  if (!userId || !op || !op.id) return false;
  var all = readStandOutboxAll();
  var mineIdx = -1;
  for (var i = 0; i < all.length; i++) {
    var o = all[i];
    if (o && o._user === userId && o.id === op.id) { mineIdx = i; break; }
  }
  if (mineIdx !== -1) {
    var prev = all[mineIdx];
    if (prev.op === 'create' && op.op === 'update') {
      for (var k in op.fields) prev.stand[k] = op.fields[k];
      return writeStandOutboxAll(all);
    }
    if (prev.op === 'create' && op.op === 'delete') {
      all.splice(mineIdx, 1); // never existed server-side — nothing to sync
      return writeStandOutboxAll(all);
    }
    if (prev.op === 'update' && op.op === 'update') {
      for (var k2 in op.fields) prev.fields[k2] = op.fields[k2];
      return writeStandOutboxAll(all);
    }
    if (prev.op === 'update' && op.op === 'delete') {
      all[mineIdx] = { op: 'delete', id: op.id, _user: userId, _queuedAt: new Date().toISOString(), _attempts: 0 };
      return writeStandOutboxAll(all);
    }
    // Anything else (delete+create etc.) falls through to a plain push —
    // minted ids make a same-id recreate impossible in practice.
  }
  var rec = { op: op.op, id: op.id, _user: userId, _queuedAt: new Date().toISOString(), _attempts: 0 };
  if (op.stand) rec.stand = op.stand;
  if (op.fields) rec.fields = op.fields;
  all.push(rec);
  return writeStandOutboxAll(all);
}

/**
 * Overlay queued ops onto a stands list so pending work is visible NOW:
 * creates appear (flagged _pending:'create'), updates merge in (flagged
 * _pending:'update'), deletes vanish. Pure and idempotent — re-applying to
 * an already-overlaid list is a no-op, so callers can overlay freely.
 */
export function applyStandOutbox(list, ops) {
  var out = (list || []).slice();
  (ops || []).forEach(function (o) {
    if (!o || !o.id) return;
    if (o.op === 'create') {
      var exists = out.some(function (s) { return s && s.id === o.id; });
      if (!exists) {
        var row = {};
        for (var k in o.stand) row[k] = o.stand[k];
        row.id = o.id;
        row._pending = 'create';
        out.push(row);
      }
    } else if (o.op === 'update') {
      out = out.map(function (s) {
        if (!s || s.id !== o.id) return s;
        var m = {};
        for (var k1 in s) m[k1] = s[k1];
        for (var k2 in o.fields) m[k2] = o.fields[k2];
        if (!m._pending) m._pending = 'update';
        return m;
      });
    } else if (o.op === 'delete') {
      out = out.filter(function (s) { return !s || s.id !== o.id; });
    }
  });
  return out;
}

/**
 * Replay this user's queued ops against the server, in queue order.
 * Returns { flushed, failed, dead } — `dead` is the array of ops set aside
 * this pass (name clashes immediately; anything else after
 * STAND_OUTBOX_MAX_ATTEMPTS), for the caller's toasts.
 */
export async function flushStandOutbox(sb, userId) {
  var ops = standOutbox(userId);
  var res = { flushed: 0, failed: 0, dead: [] };
  if (!ops.length) return res;
  var keep = [];
  for (var i = 0; i < ops.length; i++) {
    var o = ops[i];
    try {
      if (o.op === 'create') {
        var row = {};
        for (var k in o.stand) row[k] = o.stand[k];
        row.id = o.id;
        row.user_id = userId;
        OPTIONAL_COLS.forEach(function (c) { if (_missingCols[c]) delete row[c]; });
        var r = await sb.from('stands').upsert(row, { onConflict: 'id' }).select('id');
        if (r.error) throw r.error;
      } else if (o.op === 'update') {
        var fields = {};
        for (var k2 in o.fields) fields[k2] = o.fields[k2];
        delete fields.photos; // belt-and-braces: partial update never touches photos
        OPTIONAL_COLS.forEach(function (c) { if (_missingCols[c]) delete fields[c]; });
        var r2 = await sb.from('stands').update(fields).eq('id', o.id);
        if (r2.error) throw r2.error;
      } else if (o.op === 'delete') {
        await deleteStand(sb, o.id);
      }
      res.flushed++;
    } catch (e) {
      o._attempts = (o._attempts || 0) + 1;
      var clash = !!(e && e.code === '23505');
      if (clash || o._attempts >= STAND_OUTBOX_MAX_ATTEMPTS) {
        o._deadReason = clash ? 'name-clash' : String((e && e.message) || e);
        res.dead.push(o);
      } else {
        res.failed++;
        keep.push(o);
      }
    }
  }
  var others = readStandOutboxAll().filter(function (x) { return !(x && x._user === userId); });
  writeStandOutboxAll(others.concat(keep));
  if (res.dead.length) {
    try {
      var prev = JSON.parse(localStorage.getItem(STAND_OUTBOX_DEAD_KEY) || '[]');
      if (!Array.isArray(prev)) prev = [];
      localStorage.setItem(STAND_OUTBOX_DEAD_KEY, JSON.stringify(prev.concat(res.dead)));
    } catch (e) { /* best-effort */ }
  }
  return res;
}

// ── Batched 7-day forecast ──────────────────────────────────────────────────

// v2 (2026-07-17): hourly payload widened for the stand detail's hour-by-hour
// panel; v3 same day added hourly weather_code for its sky column; v4 (round
// 14) switched the model to UK Met Office Seamless — the 2 km UKV grid for
// the near term blending to their 10 km global model later in the window.
// Sharper wind direction over UK terrain (the input every stand feature
// leans on) and hourly model updates, same single batched call, free tier.
// Known trade: UKV is deterministic, so hourly precipitation_probability
// comes back all-null — the panel's Rain cell falls back to mm (and the %
// path lights up again automatically if this model choice is ever reverted).
// Each key bump retires shape-mismatched snapshots cleanly (one lost offline
// snapshot, refetched on next open — the views null-guard older shapes).
var FORECAST_CACHE_KEY = 'fl-stands-forecast-v4';

// Each key bump above orphans the previous snapshot, which can be a few hundred
// KB of forecast JSON sitting in localStorage forever on a device that never
// signs out (diary.js only prefix-sweeps 'fl-stands-forecast' at sign-out).
// Prune superseded versions once, at module load, before anything writes.
(function pruneLegacyForecastSnapshots() {
  if (typeof localStorage === 'undefined') return;
  try {
    var stale = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf('fl-stands-forecast') === 0 && k !== FORECAST_CACHE_KEY) stale.push(k);
    }
    stale.forEach(function(k) { localStorage.removeItem(k); });
  } catch (e) { /* storage disabled or partitioned - nothing to reclaim */ }
}());

/** Single source of truth for the stands weather model — the URL uses it and
 *  the score logger stamps it into 'fl-score-log-v1' records, so calibration
 *  can separate pre/post-switch predictions. */
export var FORECAST_MODEL = 'ukmo_seamless';
var FORECAST_TTL_MS = 20 * 60 * 1000; // matches app.js weather cache policy
var _memCache = { key: null, ts: 0, data: null };

function forecastUrl(stands) {
  var lats = stands.map(function(s) { return s.lat; }).join(',');
  var lngs = stands.map(function(s) { return s.lng; }).join(',');
  return 'https://api.open-meteo.com/v1/forecast?latitude=' + lats
    + '&longitude=' + lngs
    + '&daily=temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,precipitation_sum,weather_code,surface_pressure_mean'
    // Hourly: wind pair drives the window scoring; temp/gusts/precip power the
    // detail view's hour-by-hour panel (2026-07-17). Still ONE batched call.
    + '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,precipitation_probability,weather_code'
    + '&forecast_days=7&timezone=auto&models=' + FORECAST_MODEL;
}

// URL-length ceiling, not an API one: each location adds ~44 characters of
// coordinates to the query string, and enough seats in one URL walks into
// proxy/CDN 8 KB limits. 50 per request keeps every URL under ~2.5 KB.
// Results are concatenated back into STANDS ORDER, so the by-request-index
// contract downstream (and the cached snapshot shape) are untouched.
// All-or-nothing on purpose: if any batch fails, the whole fetch fails and
// the caller falls back to the snapshot — never half-score the estate.
export var FORECAST_BATCH_SIZE = 50;

export function chunkForBatches(stands, size) {
  var n = size || FORECAST_BATCH_SIZE;
  var out = [];
  for (var i = 0; i < (stands || []).length; i += n) out.push(stands.slice(i, i + n));
  return out;
}

async function fetchForecastBatches(stands) {
  var batches = chunkForBatches(stands, FORECAST_BATCH_SIZE);
  var results = await Promise.all(batches.map(async function (batch) {
    var resp = await fetch(forecastUrl(batch));
    if (!resp.ok) throw new Error('open-meteo http ' + resp.status);
    var json = await resp.json();
    // Open-Meteo returns a bare object for ONE location and an array for
    // several — and that is true PER BATCH, so a 51-seat estate whose final
    // batch holds a single seat still normalises correctly.
    return Array.isArray(json) ? json : [json];
  }));
  var flat = [];
  for (var i = 0; i < results.length; i++) flat = flat.concat(results[i]);
  return flat;
}

function coordKeyFor(stands) {
  return stands.map(function(s) {
    return Number(s.lat).toFixed(4) + ',' + Number(s.lng).toFixed(4);
  }).join('|');
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** Hourly {speedKmh,dirDeg} samples for hours [startH..endH] of one local calendar day. */
function windowHours(hourly, dateStr, startH, endH) {
  var out = [];
  if (!hourly || !hourly.time) return out;
  for (var h = Math.max(0, startH); h <= Math.min(23, endH); h++) {
    var prefix = dateStr + 'T' + pad2(h);
    for (var i = 0; i < hourly.time.length; i++) {
      if (hourly.time[i].indexOf(prefix) === 0) {
        out.push({
          speedKmh: hourly.wind_speed_10m ? hourly.wind_speed_10m[i] : null,
          dirDeg:   hourly.wind_direction_10m ? hourly.wind_direction_10m[i] : null
        });
        break;
      }
    }
  }
  return out;
}

/** Score every forecast day for one stand from its per-location API result. */
function assembleStandDays(stand, loc, species) {
  var d = loc.daily;
  var days = [];
  if (!d || !d.time) return { days: days, hourly: null };
  for (var i = 0; i < d.time.length; i++) {
    var dateStr = d.time[i]; // 'YYYY-MM-DD' in the stand's local tz (UK ⇒ London)
    var parts = dateStr.split('-');
    // Noon-UTC anchor: same London calendar day regardless of device tz.
    var date = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2], 12, 0, 0));
    var wxDay = {
      tempMax: d.temperature_2m_max ? d.temperature_2m_max[i] : null,
      tempMin: d.temperature_2m_min ? d.temperature_2m_min[i] : null,
      windMax: d.wind_speed_10m_max ? d.wind_speed_10m_max[i] : 0,
      gustMax: d.wind_gusts_10m_max ? d.wind_gusts_10m_max[i] : null,
      precip:  d.precipitation_sum ? d.precipitation_sum[i] : 0,
      pressure: d.surface_pressure_mean ? d.surface_pressure_mean[i] : null,
      prevPressure: (d.surface_pressure_mean && i > 0) ? d.surface_pressure_mean[i - 1] : undefined
    };
    var winds = { dawn: [], dusk: [] };
    var sr = calcSunTime(date, stand.lat, stand.lng, true);
    var ss = calcSunTime(date, stand.lat, stand.lng, false);
    if (sr && ss) {
      var srH = ukHourMin(sr).h, ssH = ukHourMin(ss).h;
      winds.dawn = windowHours(loc.hourly, dateStr, srH - 1, srH + 2);
      winds.dusk = windowHours(loc.hourly, dateStr, ssH - 2, ssH + 1);
    }
    var scored = scoreStandDay({
      date: date, lat: stand.lat, lng: stand.lng,
      wxDay: wxDay, windowWinds: winds, badWinds: stand.bad_winds || [],
      species: species || []
    });
    if (!scored) continue; // polar guard — cannot happen for UK stands
    scored.date = dateStr;
    scored.code = d.weather_code ? d.weather_code[i] : null;
    // Representative wind for the compass arrow: first fresh hour of the
    // best window (falls back to the other window, then null = no arrow).
    var best = scored.bestWindow === 'Dawn' ? winds.dawn : winds.dusk;
    var other = scored.bestWindow === 'Dawn' ? winds.dusk : winds.dawn;
    scored.arrowWind = best[0] || other[0] || null;
    days.push(scored);
  }
  // Raw hourly arrays ride along for the detail view's hour-by-hour panel —
  // scores stay day-level here; per-hour scoring happens at render time via
  // lib scoreStandHour (cheap, and bad-winds edits keep applying instantly).
  return { days: days, hourly: loc.hourly || null };
}

/**
 * Fetch + score 7-day forecasts for every stand — batched Open-Meteo calls
 * of FORECAST_BATCH_SIZE locations, concatenated back into stands order.
 * Returns { byStandId, asOf (ms|null), offline (bool) }.
 * Raw API payload is cached 20 min in memory and snapshotted to localStorage
 * so an offline open shows the last scores with an honest "as of" stamp.
 * Scores are recomputed from raw on every call (cheap) so a bad-winds edit
 * takes effect immediately without refetching.
 * `species` = the user's ground species (full diary names); masks the rut
 * boost per species. Empty/omitted = all species (current behaviour).
 * `force` = skip the 20-min cache (user-initiated refresh button); the
 * fresh payload still replaces the cache + snapshot as normal.
 */
export async function fetchStandForecasts(stands, species, force) {
  if (!stands || !stands.length) return { byStandId: {}, asOf: Date.now(), offline: false };
  var key = coordKeyFor(stands);
  var now = Date.now();
  var raw = null, asOf = now, offline = false;

  if (!force && _memCache.data && _memCache.key === key && (now - _memCache.ts) < FORECAST_TTL_MS) {
    raw = _memCache.data;
    asOf = _memCache.ts;
  } else {
    try {
      raw = await fetchForecastBatches(stands);
      _memCache = { key: key, ts: now, data: raw };
      try {
        localStorage.setItem(FORECAST_CACHE_KEY, JSON.stringify({ key: key, ts: now, data: raw }));
      } catch (e) { /* quota — snapshot is best-effort */ }
    } catch (e) {
      // Offline / failed: fall back to the snapshot if it covers the same stands.
      try {
        var snap = JSON.parse(localStorage.getItem(FORECAST_CACHE_KEY) || 'null');
        if (snap && snap.key === key && snap.data) {
          raw = snap.data; asOf = snap.ts; offline = true;
        }
      } catch (e2) { /* corrupt snapshot — treat as absent */ }
      if (!raw) return { byStandId: {}, asOf: null, offline: true };
    }
  }

  var byStandId = {};
  for (var i = 0; i < stands.length; i++) {
    var loc = raw[i]; // matched by request index (see header)
    if (!loc || loc.error) continue;
    byStandId[stands[i].id] = assembleStandDays(stands[i], loc, species);
  }
  return { byStandId: byStandId, asOf: asOf, offline: offline };
}
