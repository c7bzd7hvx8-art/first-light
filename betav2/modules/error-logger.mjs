// First Light — modules/error-logger.mjs
//
// Best-effort, one-way, never-noisy client-side error capture.
//
// Design constraints
//   * Must be installable once at startup and then forgotten — no UI, no
//     retries, no queue persistence. If Supabase is unreachable we drop
//     the row on the floor; we're not building a crash-reporting product.
//   * Must never recurse. Every call site that could throw is wrapped in a
//     bare try/catch that swallows silently. The logger is only ever as
//     loud as the underlying bug it reports.
//   * Must work before sign-in (auth-screen crashes matter). The Supabase
//     policy on public.app_errors allows anon inserts; user_id is simply
//     null when we can't resolve one.
//   * Must cap its own blast radius. A tight render loop that throws every
//     frame should produce one row, not ten thousand. Two layers: content
//     dedupe (5-minute window, keyed by message + stack prefix) and a hard
//     per-session cap (25 rows).
//
// Public API
//   installErrorLogger(sb, opts)
//     sb                  — Supabase client.
//     opts.appVersion     — string tag written to app_version column.
//     opts.getUserId()    — async or sync, returns the current user id
//                           (or null). Called once per send; errors inside
//                           are swallowed.
//
//   logErrorManually(err, extra?)
//     Fire-and-forget manual path for code that wants to report a caught
//     error. Same dedupe + cap as the window handlers.
//
//   _resetErrorLoggerForTests()
//     Test-only hook used by tests/error-logger.test.mjs to restart the
//     module between cases.
//
// Schema: scripts/fl-app-errors-table.sql — read it before changing any
// column names below.

const MAX_MESSAGE    = 500;
const MAX_STACK      = 4000;
const MAX_URL        = 500;
const MAX_USER_AGENT = 300;
const DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PER_SESSION  = 25;

let installed = false;
let sbClient  = null;
let appVersion = null;
let getUserId  = null;
const recentHashes = new Map();
let totalSent = 0;

function clip(s, n) {
  if (s == null) return null;
  s = String(s);
  return s.length > n ? s.slice(0, n) : s;
}

// djb2 hash, plenty for 5-minute dedupe buckets.
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// Periodically trim the dedupe map so long sessions don't accumulate
// stale keys forever. Cheap; called on every send attempt.
function pruneDedupe(now) {
  if (recentHashes.size < 64) return;
  for (const [k, ts] of recentHashes) {
    if (now - ts > DEDUPE_WINDOW_MS) recentHashes.delete(k);
  }
}

async function sendError(payload) {
  if (!sbClient) return;
  if (totalSent >= MAX_PER_SESSION) return;

  const now = Date.now();
  pruneDedupe(now);

  const dedupeKey = hashStr(
    (payload.message || '') + '|' +
    String(payload.stack || '').slice(0, 200)
  );
  const last = recentHashes.get(dedupeKey);
  if (last != null && now - last < DEDUPE_WINDOW_MS) return;
  recentHashes.set(dedupeKey, now);
  totalSent++;

  let uid = null;
  if (getUserId) {
    try {
      uid = await getUserId();
    } catch { /* swallow */ }
  }

  const row = {
    user_id:     uid || null,
    app_version: appVersion || null,
    url:         clip(typeof location !== 'undefined' ? location.href : null, MAX_URL),
    user_agent:  clip(typeof navigator !== 'undefined' ? navigator.userAgent : null, MAX_USER_AGENT),
    source:      payload.source || null,
    message:     clip(payload.message, MAX_MESSAGE),
    stack:       clip(payload.stack, MAX_STACK),
    lineno:      typeof payload.lineno === 'number' ? payload.lineno : null,
    colno:       typeof payload.colno === 'number' ? payload.colno : null,
    extra:       payload.extra || null,
  };

  try {
    await sbClient.from('app_errors').insert(row);
  } catch { /* swallow — never recurse */ }
}

function onError(ev) {
  try {
    const err = ev && ev.error;
    sendError({
      source:  'error',
      message: (err && err.message) || (ev && ev.message) || 'Unknown error',
      stack:   err && err.stack,
      lineno:  ev && ev.lineno,
      colno:   ev && ev.colno,
    });
  } catch { /* swallow */ }
}

function onRejection(ev) {
  try {
    const reason = ev && ev.reason;
    let message, stack;
    if (reason && typeof reason === 'object') {
      message = reason.message ? String(reason.message) : String(reason);
      stack = reason.stack;
    } else {
      message = String(reason);
    }
    sendError({ source: 'unhandledrejection', message, stack });
  } catch { /* swallow */ }
}

export function installErrorLogger(sb, opts) {
  if (installed) return;
  installed  = true;
  sbClient   = sb || null;
  appVersion = (opts && opts.appVersion) || null;
  getUserId  = (opts && typeof opts.getUserId === 'function') ? opts.getUserId : null;

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
  }
}

export function logErrorManually(err, extra) {
  try {
    if (!err) return;
    const message = (err && err.message) ? String(err.message) : String(err);
    const stack = err && err.stack ? String(err.stack) : null;
    sendError({ source: 'manual', message, stack, extra: extra || null });
  } catch { /* swallow */ }
}

// Test-only. Resets both module state and the dedupe / cap counters so each
// test starts from a clean slate. Also removes the window listeners that
// install added (if window is present), so listener leak assertions work.
export function _resetErrorLoggerForTests() {
  if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
    try { window.removeEventListener('error', onError); } catch { /* swallow */ }
    try { window.removeEventListener('unhandledrejection', onRejection); } catch { /* swallow */ }
  }
  installed  = false;
  sbClient   = null;
  appVersion = null;
  getUserId  = null;
  recentHashes.clear();
  totalSent  = 0;
}
