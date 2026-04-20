// First Light — modules/clock.mjs
//
// Trusted UK clock. The Cull Diary uses British deer-season boundaries, so the
// difference between "local device clock" (untrustworthy — users can set it
// to any date) and "real UK time" matters. This module holds the device-to-UK
// offset (in milliseconds), refreshes it from two public time APIs plus an
// optional Supabase `Date` header fallback, and exposes `diaryNow()` as a
// `new Date()` that's offset to the trusted time.
//
// Public API
//   diaryNow()                            → Date corrected by the offset.
//   syncDiaryTrustedUkClock({ supabaseUrl, supabaseKey } | undefined)
//                                         → Promise<boolean> — true if synced.
//   isDiaryUkClockReady()                 → boolean — offset is "fresh enough"
//                                           (either a persisted <24h offset
//                                           at load time or a just-synced one).
//
// Extracted from diary.js 2026-04-16 as the first Tier 1 module in the
// modularisation plan. Behaviour is byte-for-byte identical to the inline
// version — the only intentional change is that the Supabase fallback now
// receives its URL / anon key as a function argument instead of reading
// globals. diary.js wraps this with a zero-arg shim so call sites are
// unchanged.

// ── Endpoint list ──────────────────────────────────────────────
// Ordered by observed reliability. timeapi.io is tried first because
// worldtimeapi.org has been intermittently returning ERR_CONNECTION_RESET
// (noisy red console errors). worldtimeapi is kept as a secondary fallback,
// then Supabase Date header (added later, optional).
const DIARY_UK_CLOCK_ENDPOINTS = [
  'https://timeapi.io/api/Time/current/zone?timeZone=Europe%2FLondon',
  'https://worldtimeapi.org/api/timezone/Europe/London'
];

// ── Persistence keys (localStorage) ────────────────────────────
// Unchanged from the classic-script version — a user upgrading will keep
// their cached offset and avoid an unnecessary sync on first module load.
const DIARY_UK_CLOCK_OFFSET_KEY    = 'fl_uk_clock_offset_ms';
const DIARY_UK_CLOCK_SYNCED_AT_KEY = 'fl_uk_clock_synced_at_ms';

// A persisted offset counts as "fresh" for 24 hours. Beyond that we refuse
// to trust it for writes until a live sync succeeds.
const DIARY_UK_CLOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ── Module state ───────────────────────────────────────────────
// All internal to this module; no other file can mutate these.
let offsetMs = 0;
let ready = false;
let syncInFlight = null;

// ── Hydrate from localStorage at module init ───────────────────
// Synchronous top-level. Any caller that happens to run before their first
// sync (e.g. opening the diary offline) sees the last-known offset if it's
// less than 24 hours old. Wrapped in try/catch because localStorage can
// throw in private-mode Safari.
(function loadPersistedOffset() {
  try {
    const off = parseInt(localStorage.getItem(DIARY_UK_CLOCK_OFFSET_KEY) || '', 10);
    const syncedAt = parseInt(localStorage.getItem(DIARY_UK_CLOCK_SYNCED_AT_KEY) || '', 10);
    if (Number.isFinite(off) && Number.isFinite(syncedAt) && (Date.now() - syncedAt) < DIARY_UK_CLOCK_MAX_AGE_MS) {
      offsetMs = off;
      ready = true;
    }
  } catch (_) {}
})();

// ── Public API ─────────────────────────────────────────────────

/**
 * Return a Date object representing "trusted UK now".
 * When no sync has ever succeeded, `offsetMs` is 0 and this degrades to
 * `new Date()` — the caller can check `isDiaryUkClockReady()` first if the
 * data being written is season-boundary sensitive.
 */
export function diaryNow() {
  return new Date(Date.now() + offsetMs);
}

/** True if we have a trusted offset (persisted <24h or just-synced). */
export function isDiaryUkClockReady() {
  return ready;
}

/**
 * Refresh the offset from a remote source.
 *
 * @param {object} [supabaseFallback]
 *     Optional third-tier source. Pass `{ supabaseUrl, supabaseKey }` (the
 *     project's public anon config) to enable the Supabase Date-header
 *     fallback if both public time APIs fail. Omit to skip that fallback.
 * @returns {Promise<boolean>} `true` if any source succeeded, otherwise the
 *     previous `ready` flag (a persisted offset still counts as success).
 *
 * Concurrent callers share one in-flight promise so a spike of simultaneous
 * "do I need to sync?" checks in the UI only issues one network fetch.
 */
export async function syncDiaryTrustedUkClock(supabaseFallback) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async function() {
    try {
      for (let i = 0; i < DIARY_UK_CLOCK_ENDPOINTS.length; i++) {
        try {
          const r = await fetch(DIARY_UK_CLOCK_ENDPOINTS[i], { cache: 'no-store' });
          if (!r.ok) continue;
          const d = await r.json();
          const iso = d && (d.utc_datetime || d.datetime || d.dateTime);
          const serverMs = Date.parse(String(iso || ''));
          if (!Number.isFinite(serverMs)) continue;
          offsetMs = serverMs - Date.now();
          ready = true;
          try {
            localStorage.setItem(DIARY_UK_CLOCK_OFFSET_KEY, String(offsetMs));
            localStorage.setItem(DIARY_UK_CLOCK_SYNCED_AT_KEY, String(Date.now()));
          } catch (_) {}
          return true;
        } catch (_) {}
      }
      // Third fallback: Supabase edge Date header (UTC). Only used if the
      // caller opted in by passing config — this keeps the module portable
      // for any future reuse.
      const supaUrl = supabaseFallback && supabaseFallback.supabaseUrl;
      const supaKey = supabaseFallback && supabaseFallback.supabaseKey;
      if (supaUrl && supaKey) {
        try {
          const sr = await fetch(supaUrl.replace(/\/+$/, '') + '/rest/v1/', {
            cache: 'no-store',
            headers: {
              apikey: supaKey,
              Authorization: 'Bearer ' + supaKey
            }
          });
          const hDate = sr && sr.headers && sr.headers.get ? sr.headers.get('date') : '';
          const supaMs = Date.parse(String(hDate || ''));
          if (Number.isFinite(supaMs)) {
            offsetMs = supaMs - Date.now();
            ready = true;
            try {
              localStorage.setItem(DIARY_UK_CLOCK_OFFSET_KEY, String(offsetMs));
              localStorage.setItem(DIARY_UK_CLOCK_SYNCED_AT_KEY, String(Date.now()));
            } catch (_) {}
            return true;
          }
        } catch (_) {}
      }
      return !!ready;
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}
