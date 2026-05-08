// First Light — modules/stand-data.mjs
//
// CRUD wrappers around `public.stands` plus offline-first cache in
// `localStorage.fl_stands_v1`. All Supabase calls hit the live binding
// `sb` from modules/supabase.mjs — that means callers can import this
// module before initSupabase() resolves; the binding goes live as soon
// as the diary boot script wires it up.
//
// Data shape (mirrors scripts/stands.sql):
//   {
//     id, user_id, name,
//     lat, lng,
//     preferred_approach_deg,    // bearing deer come FROM (0-359)
//     species_pref: string[],
//     notes,
//     ground,
//     created_at, updated_at
//   }
//
// Public API
//   loadStands()       → Promise<Stand[]> — Supabase select, with localStorage fallback.
//   loadStandsCache()  → Stand[]          — synchronous read of the cache.
//   upsertStand(s)     → Promise<Stand>   — insert or update; refreshes cache.
//   deleteStand(id)    → Promise<void>    — delete by id; refreshes cache.
//   loadCullEntriesNear(lat, lng, radiusMeters)
//                      → Promise<Entry[]> — for §4 historyMatch scoring.

import { sb } from './supabase.mjs';

const CACHE_KEY = 'fl_stands_v1';

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeCache(stands) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(stands || []));
  } catch (e) { /* quota — fine, next refresh will retry */ }
}

export function loadStandsCache() {
  return readCache();
}

export async function loadStands() {
  if (!sb) return readCache();
  try {
    const { data, error } = await sb
      .from('stands')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    const stands = data || [];
    writeCache(stands);
    return stands;
  } catch (e) {
    return readCache();
  }
}

export async function upsertStand(stand) {
  if (!sb) throw new Error('Supabase not initialised');
  const payload = { ...stand, updated_at: new Date().toISOString() };
  // Strip id when it's missing/null so the DB generates a uuid.
  if (!payload.id) delete payload.id;
  const { data, error } = await sb
    .from('stands')
    .upsert(payload, { onConflict: 'id' })
    .select()
    .single();
  if (error) throw error;
  // Refresh local cache lazily — caller will usually re-list anyway.
  const cache = readCache();
  const idx = cache.findIndex(s => s.id === data.id);
  if (idx >= 0) cache[idx] = data; else cache.unshift(data);
  writeCache(cache);
  return data;
}

export async function deleteStand(id) {
  if (!sb) throw new Error('Supabase not initialised');
  const { error } = await sb.from('stands').delete().eq('id', id);
  if (error) throw error;
  writeCache(readCache().filter(s => s.id !== id));
}

// ── Cull-entry lookup for history-match scoring ───────────────
// Loads recent cull_entries within `radiusMeters` of (lat,lng). The
// rank module only needs lat/lng/species/weather_data/created_at,
// so we project to those fields. RLS on cull_entries already scopes
// to the authed user.
export async function loadCullEntriesNear(lat, lng, radiusMeters = 500) {
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from('cull_entries')
      .select('id, lat, lng, species, weather_data, created_at')
      .not('lat', 'is', null)
      .not('lng', 'is', null);
    if (error) throw error;
    if (!data) return [];
    // Filter client-side — Supabase doesn't have PostGIS in this project,
    // and a degree-bbox prefilter is not worth it for typical user volumes
    // (≤ a few hundred entries lifetime).
    return data.filter(e => haversine(e.lat, e.lng, lat, lng) <= radiusMeters);
  } catch (e) {
    return [];
  }
}

// Great-circle distance in metres. Used for the radius filter above
// and re-exported because stand-rank consumes it too.
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000; // metres
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
