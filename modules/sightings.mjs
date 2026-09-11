// First Light — modules/sightings.mjs
// =============================================================================
// Sightings data layer (SIGHTINGS-PLAN.md S2): Supabase CRUD against
// public.sightings (owner-only RLS — scripts/migrate-sightings.sql). A sighting
// is a live-deer observation: species + buck/doe/young/unknown composition +
// optional stand link, GPS pin, behaviour, notes, photo.
//
// Split contract (the stands.mjs precedent): this module owns the data layer;
// diary.js owns views, capture UI and dispatcher wiring. Pure composition /
// label / trend maths live in lib/fl-sightings.mjs.
//
// Side effects allowed here (modules/ rule): Supabase network only. Offline
// capture is wired at S3 through the diary's existing fl_offline_queue (the
// same path cull entries use) rather than a private outbox here.
// =============================================================================

var SIGHTING_COLS =
  'id, seen_at, species, n_male, n_female, n_young, n_unknown, ' +
  'behaviour, ground, stand_id, marker_ref, lat, lng, notes, photo_url, created_at';

/** All of a user's sightings, newest first (matches the sightings_user_seen_idx). */
export async function fetchSightings(sb, userId) {
  var r = await sb.from('sightings')
    .select(SIGHTING_COLS)
    .eq('user_id', userId)
    .order('seen_at', { ascending: false });
  if (r.error) throw r.error;
  return r.data || [];
}

/**
 * Insert (no id) or update (id set). Returns the saved row.
 * Counters are coerced to non-negative integers; empty text → null. The DB
 * CHECK enforces ≥ 1 animal — callers should validate first
 * (lib/fl-sightings.mjs validateSightingCounts) for a friendly message.
 */
export async function saveSighting(sb, userId, s) {
  var row = {
    user_id:   userId,
    seen_at:   s.seen_at || new Date().toISOString(),
    species:   s.species,
    n_male:    Math.max(0, s.n_male | 0),
    n_female:  Math.max(0, s.n_female | 0),
    n_young:   Math.max(0, s.n_young | 0),
    n_unknown: Math.max(0, s.n_unknown | 0),
    behaviour: s.behaviour || null,
    ground:    (s.ground && s.ground.trim()) ? s.ground.trim() : null,
    stand_id:  s.stand_id || null,
    // 14.07: camera/feed-site link (ground_features.id). Requires
    // migrate-camera-sightings.sql to have run — run it BEFORE publishing.
    marker_ref: s.marker_ref || null,
    lat:       (s.lat != null) ? s.lat : null,
    lng:       (s.lng != null) ? s.lng : null,
    notes:     (s.notes && s.notes.trim()) ? s.notes.trim() : null,
    photo_url: s.photo_url || null
  };
  // Offline-replay idempotency: a queued sighting carries a client_uuid
  // stamped at enqueue time, and inserting it as an upsert on
  // (user_id, client_uuid) makes a lost-acknowledgement replay collapse into
  // the committed row instead of duplicating it (migrate-client-uuid.sql).
  // Updates never touch the column — a row's replay identity is permanent.
  // Callers pass client_uuid only when the column is known live; diary.js
  // owns the pre-migration column-absent tolerance.
  if (!s.id && s.client_uuid) row.client_uuid = s.client_uuid;
  var r;
  if (s.id) {
    r = await sb.from('sightings').update(row).eq('id', s.id).select().single();
  } else if (row.client_uuid) {
    r = await sb.from('sightings').upsert(row, { onConflict: 'user_id,client_uuid' }).select().single();
  } else {
    r = await sb.from('sightings').insert(row).select().single();
  }
  if (r.error) throw r.error;
  return r.data;
}

export async function deleteSighting(sb, id) {
  var r = await sb.from('sightings').delete().eq('id', id);
  if (r.error) throw r.error;
}

/**
 * id → weather_data for all of a user's sightings (SG5). Kept OUT of the
 * list fetch on purpose (JSONB can be large — the R13 cull lesson); callers
 * hydrate on demand. Throws on error — diary.js interprets a 42703
 * (column absent pre-migration) and quietly disables weather for the session.
 */
export async function fetchSightingWeatherMap(sb, userId) {
  var r = await sb.from('sightings')
    .select('id, weather_data')
    .eq('user_id', userId);
  if (r.error) throw r.error;
  var map = {};
  (r.data || []).forEach(function (row) {
    map[row.id] = ('weather_data' in row) ? row.weather_data : null;
  });
  return map;
}
