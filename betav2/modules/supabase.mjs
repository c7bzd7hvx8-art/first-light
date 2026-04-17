// First Light — modules/supabase.mjs
//
// Thin wrapper over the `@supabase/supabase-js` UMD bundle loaded as a
// classic <script> in diary.html. Exposes the project URL / anon key,
// a configured-flag, the lazily-created client (`sb`), and an `initSupabase`
// that creates the client idempotently.
//
// Why a module: the URL / key and the `sb` client were file-level globals
// in diary.js, which meant every future module that wanted to hit the
// database had to reach back into that file. Moving them here lets
// ./clock.mjs, ./auth.mjs, ./data.mjs etc. import directly — the right
// dependency direction.
//
// Public API
//   SUPABASE_URL          — project URL (compile-time constant).
//   SUPABASE_KEY          — anon key (safe to ship; RLS enforces access).
//   SUPABASE_CONFIGURED   — boolean; false if the placeholder values are
//                           still in the file.
//   sb                    — the Supabase client, `null` until initSupabase()
//                           succeeds. Imported as a live binding — callers
//                           see the post-init value after diary.js has
//                           called initSupabase() during DOM-ready setup.
//   initSupabase()        — create the client. Returns a result object so
//                           diary.js can decide whether to toast or render
//                           a setup notice into the DOM (keeps this module
//                           free of DOM / app-specific UI).
//
// Vendor dep: reads `window.supabase.createClient`. The caller (diary.html)
// loads `@supabase/supabase-js@2` as a classic script before this module
// runs, so `window.supabase` is defined by the time initSupabase() fires.

// ── Project configuration ──────────────────────────────────────
// Anon key is safe to ship (RLS on every table, policies reviewed in
// scripts/supabase-audit-rls-snapshot.json). Rotate via Supabase dashboard
// → Settings → API. A rotation updates both lines here in one commit.
export const SUPABASE_URL = 'https://sjaasuqeknvvmdpydfsz.supabase.co';
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNqYWFzdXFla252dm1kcHlkZnN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NjMzMzIsImV4cCI6MjA5MDIzOTMzMn0.aiJaKoLCI3jUkOgifqMLuhp8NnAFK0T24Va6r2CLzgw';

// Set to `false` if the placeholders haven't been replaced; diary.js uses
// this to decide between "show setup notice" and "try to connect".
export const SUPABASE_CONFIGURED = (
  SUPABASE_URL !== 'YOUR_SUPABASE_URL' &&
  SUPABASE_KEY !== 'YOUR_SUPABASE_ANON_KEY'
);

// The client instance. Declared with `let` and re-assigned inside
// initSupabase() — because this is an ES module, consumers who
// `import { sb }` see the *live binding* and will observe the post-init
// value automatically after initSupabase() resolves.
export let sb = null;

/**
 * Idempotent client bootstrap. Subsequent calls return `{ ok: true }`
 * immediately if a client already exists.
 *
 * @returns {{ ok: true } | { ok: false, reason: 'not-configured' }
 *                        | { ok: false, reason: 'error', error: Error }}
 *     diary.js inspects `reason` to pick between the two existing failure
 *     UIs (auth-card setup notice vs the transient error toast).
 */
export function initSupabase() {
  if (sb) return { ok: true };
  if (!SUPABASE_CONFIGURED) return { ok: false, reason: 'not-configured' };
  try {
    // window.supabase is the UMD global from supabase-js@2 loaded as a
    // classic script in diary.html. Must exist by the time this runs.
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'error', error: e };
  }
}
