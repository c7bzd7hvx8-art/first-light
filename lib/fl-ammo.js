// =============================================================================
// First Light — factory ammunition database helpers
//
// Pure helpers over the static ammunition JSON database
// (data/ammo-loads.json). No DOM, no network — the caller (the calculator
// UI module) is responsible for fetching the JSON once at startup and
// passing it in.
//
// Schema of data/ammo-loads.json:
//   {
//     "version": "1.0.0",
//     "lastUpdated": "2026-04-29",
//     "verified": true,                       // top-level: db has been audited
//     "flUkAmmoVerified": true,               // top-level: UK ammo data audited
//     "flUkDeerLawVerified": true,            // top-level: deer law data audited
//     "calibres":      [{ id, name }],
//     "manufacturers": [{ id, name }],
//     "loads": [{
//       id, calibre, manufacturer,
//       name,                               // e.g. "Power-Shok"
//       bullet,                             // e.g. "150gr SP"
//       weightGrains,
//       muzzleVelocityFps,
//       bcG1, bcG7,                         // either or both
//       testBarrelInches,
//       construction,                       // 'soft-point' | 'bonded' | etc.
//       bcVerificationBasis,                // 'manufacturer-datasheet' |
//                                           // 'user-acceptance' |
//                                           // 'no-published-bc'
//       bcSource,                           // citation text for the BC
//       mvSource,                           // citation text for the MV (optional)
//       notes
//     }]
//   }
//
// NOTE: per-load `verified` boolean was REMOVED in round 11 cleanup. It carried
// no information beyond bcVerificationBasis. The top-level `verified` flag is
// the source of truth for whether the database as a whole has been audited.
//
// Design principles:
//   * Pure functions — caller passes the loaded DB to every call.
//   * Deterministic ordering — sorts are stable and explicit.
//   * Search is forgiving: case-insensitive, ignores punctuation, matches
//     across calibre + manufacturer + bullet weight + product name.
//   * Never throws on bad input; returns empty arrays / null instead.
// =============================================================================

// ── Lookups ───────────────────────────────────────────────────────────────

/** Return all calibres, in display order (as authored in the JSON). */
export function getCalibres(db) {
  return Array.isArray(db && db.calibres) ? db.calibres.slice() : [];
}

/** Return all manufacturers, in display order. */
export function getManufacturers(db) {
  return Array.isArray(db && db.manufacturers) ? db.manufacturers.slice() : [];
}

/** Return all loads, in arbitrary order (use the filter helpers below). */
export function getAllLoads(db) {
  return Array.isArray(db && db.loads) ? db.loads.slice() : [];
}

/** Look up a single load by id; null if not found.
 *
 *  Resolution order:
 *    1. Direct id match in db.loads.
 *    2. If db.metadata.loadIdAliases has the id as a key, follow the
 *       alias to a current id and return that load.
 *    3. null.
 *
 *  The alias map exists so that ids renamed for correctness (e.g. an id
 *  that originally encoded the wrong bullet weight) don't break user
 *  profiles saved against the old id. Aliases should be kept indefinitely
 *  — removing them is a breaking change for stored profiles.
 */
export function getLoadById(db, id) {
  if (!db || !Array.isArray(db.loads) || !id) return null;
  const direct = db.loads.find(l => l.id === id);
  if (direct) return direct;
  const aliasTarget = db.metadata && db.metadata.loadIdAliases
    ? db.metadata.loadIdAliases[id]
    : null;
  if (aliasTarget) {
    return db.loads.find(l => l.id === aliasTarget) || null;
  }
  return null;
}

/** Look up a calibre by id; returns the {id,name} record or null. */
export function getCalibreById(db, id) {
  if (!db || !Array.isArray(db.calibres)) return null;
  return db.calibres.find(c => c.id === id) || null;
}

/** Look up a manufacturer by id; returns the {id,name} record or null. */
export function getManufacturerById(db, id) {
  if (!db || !Array.isArray(db.manufacturers)) return null;
  return db.manufacturers.find(m => m.id === id) || null;
}

// ── Filters (for the cascading picker UI) ────────────────────────────────

/**
 * Return only the calibres for which at least one load exists. The full
 * calibres list may include exotics with no UK-relevant load yet; filter
 * to what the user can actually pick.
 */
export function getCalibresWithLoads(db) {
  const all = getCalibres(db);
  const loads = getAllLoads(db);
  const present = new Set(loads.map(l => l.calibre));
  return all.filter(c => present.has(c.id));
}

/**
 * Return manufacturers that produce at least one load in the given
 * calibre. For the cascading picker: calibre → manufacturer step.
 */
export function getManufacturersForCalibre(db, calibreId) {
  if (!calibreId) return [];
  const loads = getAllLoads(db).filter(l => l.calibre === calibreId);
  const present = new Set(loads.map(l => l.manufacturer));
  return getManufacturers(db).filter(m => present.has(m.id));
}

/**
 * Return loads in a (calibre, manufacturer) pair, sorted by bullet weight
 * ascending, then by product name. For the cascading picker's last step.
 */
export function getLoadsFor(db, calibreId, manufacturerId) {
  if (!calibreId || !manufacturerId) return [];
  const loads = getAllLoads(db).filter(
    l => l.calibre === calibreId && l.manufacturer === manufacturerId
  );
  return loads.sort((a, b) => {
    const wa = a.weightGrains || 0;
    const wb = b.weightGrains || 0;
    if (wa !== wb) return wa - wb;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

// ── Free-text search ──────────────────────────────────────────────────────

/**
 * Normalise a string for searching: lowercase, strip non-alphanumerics
 * (except dot, used in calibres like ".308"), collapse whitespace.
 * Internal helper.
 */
function normaliseForSearch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Free-text search across loads. Tokenises the query and requires every
 * token to appear in the load's combined searchable text (calibre name,
 * manufacturer name, product name, bullet description, weight). Returns
 * matches in best-match order: shorter combined text first (prefer exact
 * matches over loose ones), then alphabetical.
 *
 * The query "fed 308 150" against the database matches Federal .308 Win
 * 150gr loads. ".223 55 fmj" matches Federal .223 55gr FMJ loads.
 *
 * @param {object} db
 * @param {string} query
 * @param {number} [limit=20]
 * @returns {Array<load>}  matching load records, up to `limit`
 */
export function searchLoads(db, query, limit) {
  const cap = Number.isFinite(limit) ? limit : 20;
  const q = normaliseForSearch(query);
  if (!q) return [];
  const tokens = q.split(' ').filter(Boolean);
  if (tokens.length === 0) return [];

  const loads = getAllLoads(db);
  const calLookup = Object.fromEntries(getCalibres(db).map(c => [c.id, c.name]));
  const mfrLookup = Object.fromEntries(getManufacturers(db).map(m => [m.id, m.name]));

  const matches = [];
  for (const l of loads) {
    const calName = calLookup[l.calibre] || '';
    const mfrName = mfrLookup[l.manufacturer] || '';
    const haystack = normaliseForSearch(
      [calName, mfrName, l.name, l.bullet, l.weightGrains, l.construction].join(' ')
    );
    let allMatch = true;
    for (const t of tokens) {
      if (haystack.indexOf(t) < 0) { allMatch = false; break; }
    }
    if (allMatch) matches.push({ load: l, len: haystack.length });
  }
  matches.sort((a, b) => {
    if (a.len !== b.len) return a.len - b.len;
    return String(a.load.name || '').localeCompare(String(b.load.name || ''));
  });
  return matches.slice(0, cap).map(m => m.load);
}

// ── Display helpers ──────────────────────────────────────────────────────

/**
 * Compose a human-readable single-line summary of a load, suitable for
 * the calculator's profile bar and the dope-card PDF header.
 *
 * Example output:
 *   "Federal .308 Win 150gr Power-Shok SP"
 */
export function loadDisplayName(db, loadOrId) {
  const load = typeof loadOrId === 'string' ? getLoadById(db, loadOrId) : loadOrId;
  if (!load) return '';
  const cal = getCalibreById(db, load.calibre);
  const mfr = getManufacturerById(db, load.manufacturer);
  const parts = [];
  if (mfr) parts.push(mfr.name);
  if (cal) parts.push(cal.name);
  if (load.weightGrains != null) parts.push(load.weightGrains + 'gr');
  if (load.name) parts.push(load.name);
  if (load.bullet && !String(load.bullet).startsWith(String(load.weightGrains || ''))) {
    // bullet field often duplicates the weight (e.g. "150gr SP") — strip it
    const stripped = String(load.bullet).replace(/^\d+\s*gr\s*/i, '').trim();
    if (stripped) parts.push(stripped);
  }
  return parts.join(' ');
}

/**
 * Pick the best ballistic coefficient to use from a load. Prefers G7 when
 * present (more accurate for boat-tail bullets, which the JSON schema
 * indicates by populating bcG7), falling back to G1.
 *
 * @returns {{ bc: number, model: 'G1'|'G7' } | null}
 */
export function preferredBcFor(load) {
  if (!load) return null;
  if (load.bcG7 != null && load.bcG7 > 0) return { bc: load.bcG7, model: 'G7' };
  if (load.bcG1 != null && load.bcG1 > 0) return { bc: load.bcG1, model: 'G1' };
  return null;
}
