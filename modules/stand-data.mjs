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
// Local-only test mode: when localStorage.fl_stand_local_mode === '1'
// (or the URL flag ?stand=local is used), all CRUD writes bypass Supabase
// and persist purely to localStorage. Lets you exercise the full planner
// UI on a device where scripts/stands.sql hasn't been run yet. Auto-
// activated as a fallback when an upsert fails because the table
// doesn't exist.
//
// Public API
//   loadStands()       → Promise<Stand[]> — Supabase select, with localStorage fallback.
//   loadStandsCache()  → Stand[]          — synchronous read of the cache.
//   upsertStand(s)     → Promise<Stand>   — insert or update; refreshes cache.
//   deleteStand(id)    → Promise<void>    — delete by id; refreshes cache.
//   loadCullEntriesNear(lat, lng, radiusMeters)
//                      → Promise<Entry[]> — for §4 historyMatch scoring.
//   isLocalMode()      → boolean          — true when local-only mode active.
//   setLocalMode(on)   → void             — flip the persistent flag.

import { sb } from './supabase.mjs';

const CACHE_KEY = 'fl_stands_v1';
const LOCAL_MODE_KEY = 'fl_stand_local_mode';

export function isLocalMode() {
  try { return localStorage.getItem(LOCAL_MODE_KEY) === '1'; } catch (_) { return false; }
}

export function setLocalMode(on) {
  try {
    if (on) localStorage.setItem(LOCAL_MODE_KEY, '1');
    else localStorage.removeItem(LOCAL_MODE_KEY);
  } catch (_) { /* ignore quota */ }
}

function genId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // RFC4122 v4 fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

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
  // In local mode (or when Supabase is unavailable) the cache IS the
  // source of truth.
  if (isLocalMode() || !sb) return readCache();
  try {
    const { data, error } = await sb
      .from('stands')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      // If the table doesn't exist, silently flip into local mode so
      // the planner stays usable. The form's save flow does the same.
      if (isMissingTableError(error)) {
        setLocalMode(true);
        return readCache();
      }
      throw error;
    }
    const stands = data || [];
    writeCache(stands);
    return stands;
  } catch (e) {
    return readCache();
  }
}

export async function upsertStand(stand) {
  // Local-only path: generate id+timestamps, write to cache, return.
  if (isLocalMode()) return upsertLocal(stand);

  if (!sb) throw new Error('Supabase not initialised');
  const payload = { ...stand, updated_at: new Date().toISOString() };
  if (!payload.id) delete payload.id;
  const { data, error } = await sb
    .from('stands')
    .upsert(payload, { onConflict: 'id' })
    .select()
    .single();
  if (error) {
    // Auto-fallback: if the table is missing, switch into local mode and
    // retry without Supabase so the user gets a saved row instead of an
    // error message.
    if (isMissingTableError(error)) {
      setLocalMode(true);
      return upsertLocal(stand);
    }
    throw error;
  }
  const cache = readCache();
  const idx = cache.findIndex(s => s.id === data.id);
  if (idx >= 0) cache[idx] = data; else cache.unshift(data);
  writeCache(cache);
  return data;
}

export async function deleteStand(id) {
  if (isLocalMode()) {
    writeCache(readCache().filter(s => s.id !== id));
    return;
  }
  if (!sb) throw new Error('Supabase not initialised');
  const { error } = await sb.from('stands').delete().eq('id', id);
  if (error) {
    if (isMissingTableError(error)) {
      setLocalMode(true);
      writeCache(readCache().filter(s => s.id !== id));
      return;
    }
    throw error;
  }
  writeCache(readCache().filter(s => s.id !== id));
}

function upsertLocal(stand) {
  const now = new Date().toISOString();
  const cache = readCache();
  let saved;
  if (stand.id) {
    const idx = cache.findIndex(s => s.id === stand.id);
    saved = { ...stand, updated_at: now };
    if (idx >= 0) {
      saved = { ...cache[idx], ...saved };
      cache[idx] = saved;
    } else {
      saved.created_at = saved.created_at || now;
      cache.unshift(saved);
    }
  } else {
    saved = {
      ...stand,
      id: genId(),
      user_id: 'local',
      created_at: now,
      updated_at: now,
      _local: true
    };
    cache.unshift(saved);
  }
  writeCache(cache);
  return Promise.resolve(saved);
}

function isMissingTableError(err) {
  if (!err) return false;
  const msg = (err.message || '') + ' ' + (err.details || '') + ' ' + (err.hint || '');
  // Postgres "relation does not exist" + PostgREST "schema cache" variants
  return /relation .*stands.* does not exist/i.test(msg)
      || /could not find the table/i.test(msg)
      || /schema cache/i.test(msg)
      || err.code === '42P01'
      || err.code === 'PGRST205';
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
