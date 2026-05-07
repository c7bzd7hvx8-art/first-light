# Wind & Stand Planner — Implementation Plan

## Context

First Light is a UK deer-stalking PWA with strong legal-hours, weather, and cull-diary plumbing but no in-field planning tool. UK competitor research (Stalking Directory threads, BASC/BDS/myForest/NatureScot apps) shows that the #1 most-praised feature in US-centric apps available in the UK (HuntStand's HuntZone, HuntWise's WindCast, onX) is a **wind/scent overlay tied to saved stand locations** — and *no* UK app ships it. myForest Deer Manager (the closest UK equivalent) appears to have stopped active development.

First Light already has every primitive needed — and crucially, an **existing 7-day Activity Forecast engine** in `app.js:2080–2280+` that combines moon, rut, season, weather, and solunar windows into per-day and per-hour scores. The Wind & Stand Planner extracts that engine into a shared module so both surfaces use the same scoring, then layers in the only two genuinely new inputs: **wind alignment vs the stand's preferred approach** and **historical similarity to your own nearby cull entries**.

Existing primitives reused (no reinvention):
- `fetch7DayWeather(lat, lng, cb)` (`app.js:2086`) — Open-Meteo 7-day forecast (daily + hourly incl. `wind_direction_10m`), 20-minute cache. Single fetch serves both home-page banner badge and planner.
- `scoreDay(date, wxDay)` (`app.js:2106`) — dawn/dusk activity score from moon + `RUT_CALENDAR` + season + weather (temp, frost, wind, gusts, precip, pressure delta).
- `hourlyActivityScore(hour, date, wxHour)` (`app.js:2236`) — per-hour score, same model plus solunar major/minor windows.
- `getMoonPhase`, `getSolunar`, `RUT_CALENDAR`, `calcSunTime`, `toMinutes`, `fmtMins`, `windDirArrow` — all in `app.js`.
- Two Leaflet maps in `diary.js` (`pinMap` line 5606, `cullMap` line 5906) with OS / Mapbox / satellite tile-layer swap, marker clustering, and Mapbox-quota fallback.
- Trusted UK clock (`modules/clock.mjs` `diaryNow()`).
- Supabase + RLS (`modules/supabase.mjs` exports live-binding `sb` and `initSupabase()`; per-user pattern on `cull_entries`, `grounds`).
- Per-cull location & weather already stored (`cull_entries.lat`, `lng`, `weather_data.wind_dir`).

The new feature combines these into a **"Best Stand Tonight" recommender** that scores each saved high seat for the next 14 legal-shooting slots (7 dawn + 7 dusk). Outcome: a UK-specific differentiator that lands a feature competitors only ship for the US market, built without new paid APIs and **without duplicating the activity-forecast logic** the home page already trusts.

---

## 1. UX flow

A new **Stands** view in `diary.html` (4th bottom-nav button between `n-form` and `n-stats`, around `diary.html:904–908`). Three sub-tabs styled like the existing `tmode-toggle`:

1. **Tonight** (default) — recommendation card: stand name, 1–5 star score, one-line rationale ("Wind WSW 11 mph carries scent NE — away from the beat"). Below it, a horizontal scrubber of the next 14 legal slots labelled `Wed dawn 04:42`. Tapping a slot rewrites the card and the cone overlay.
2. **Map** — Leaflet map with all stands + wind cones for the active slot. Tap a marker → focus + slide card up.
3. **My stands** — list with edit/delete; "+ Add stand" CTA.

**Add/edit stand** reuses the existing pin-drop overlay (`#pinmap-overlay`, `diary.html:911`, `diary.js` ~5689–5790). After confirm: name (required), `preferred_approach_deg` (compass picker — bearing from which deer come), `species_preference` (chip multi-select), optional notes. Save via `sb.from('stands').upsert(...)`.

**Edge cases.** No stands yet → onboarding empty state. No GPS → centre on most-recent `cull_entries.lat/lng`, then UK default `(54.5, -2.3)`. Offline → render from `localStorage.fl_stand_forecast_v1`; show "Forecast N days old" if cache stale. Stand outside UK lat range → quiet "Legal hours assume UK regulations" banner.

---

## 2. Data model

**New Supabase table** (`scripts/stands.sql`, mirroring the convention of `scripts/syndicate-messages.sql` referenced at `diary.js:8366`):

```sql
create table public.stands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  preferred_approach_deg integer check (preferred_approach_deg between 0 and 359),
  species_pref text[] default '{}',
  notes text check (char_length(notes) <= 500),
  ground text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index stands_user_id_idx on public.stands (user_id);
alter table public.stands enable row level security;
create policy stands_select_own on public.stands for select using (auth.uid() = user_id);
create policy stands_insert_own on public.stands for insert with check (auth.uid() = user_id);
create policy stands_update_own on public.stands for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy stands_delete_own on public.stands for delete using (auth.uid() = user_id);
```

**Client-side caches (localStorage):**
- `fl_stands_v1` — array mirror of user's stands (offline-first list render).
- `fl_stand_forecast_v1` — `{ "lat,lng" : { fetched_at, hourly: {...} } }` keyed by 3-decimal-place coords; capped at 30 keys.
- `fl_stand_planner_flag` — rollout flag.

**No schema change to `cull_entries`** — historical scoring reads existing `lat`, `lng`, `species`, `weather_data.wind_dir`, `created_at`.

---

## 3. Module architecture

All new code under `/home/user/first-light/modules/` to honour the "no growth on the 9.2 KLOC `diary.js` monolith" rule from the recent audit. The activity-forecast engine is **extracted** from `app.js` into a shared module so the home page banner badge and the new planner consume the same scoring (and share the same Open-Meteo cache, halving forecast API calls).

| New file | Responsibility |
|---|---|
| `modules/activity-engine.mjs` | **Extracted** from `app.js:2080–2280+`. Exports `RUT_CALENDAR`, `getMoonPhase(date)`, `getSolunar(date, lat, lng)`, `scoreDay(date, lat, lng, wxDay)`, `hourlyActivityScore(hour, date, lat, lng, wxHour)`, `fetch7DayForecast(lat, lng) → Promise<openMeteoJson>` (Promise version of `fetch7DayWeather`, same 20-min cache). Functions take `lat`/`lng` as args instead of reading the `bannerState` global → easier to call from the planner. `app.js` keeps `window.*` shims so the rest of the file is untouched. |
| `modules/sun-times.mjs` | **Extracted** from `app.js:343,467,472`. Exports `calcSunTime`, `addMins`, `fmtMins`, `toMinutes`. Imported by both `app.js` (via `window.*` shims) and `activity-engine.mjs`. |
| `modules/stand-planner.mjs` | Top-level controller. `initStandPlanner(rootEl)`, `refreshStandPlanner()`. Owns sub-tab state + GPS handshake. Calls `fetch7DayForecast` → builds 14 legal slots via `calcSunTime` → for each stand × slot calls `stand-rank.score(...)`. |
| `modules/stand-data.mjs` | `loadStands()`, `upsertStand()`, `deleteStand()` — wraps `sb` from `modules/supabase.mjs`. Hydrates from `localStorage.fl_stands_v1` first. |
| `modules/stand-rank.mjs` | **Pure** stand-specific scoring. See §4. Imports `hourlyActivityScore` from `activity-engine.mjs` for the moon/rut/season/weather/solunar baseline; adds two new factors (wind alignment vs `preferred_approach_deg`, historical similarity to nearby `cull_entries`). Unit-testable in isolation. |
| `modules/stand-ui-map.mjs` | Builds a 3rd Leaflet map (`standMap`, parallel to `pinMap`/`cullMap`). Draws markers + wind cones; `setActiveSlot(idx)` redraws cones on scrub. |
| `modules/stand-ui-card.mjs` | Renders recommendation card + slot scrubber; pure-DOM render-from-state. |

**Existing files needing minimal edits:**

| File | Edit |
|---|---|
| `app.js` | Replace the inline definitions of `RUT_CALENDAR`, `getMoonPhase`, `getSolunar`, `scoreDay`, `hourlyActivityScore`, `fetch7DayWeather` (lines 2080–2280+) and `calcSunTime`, `addMins`, `fmtMins`, `toMinutes` (lines 343, 467, 472) with `import { … } from './modules/activity-engine.mjs'` + `'./modules/sun-times.mjs'`, then re-expose each on `window.*` so the existing 4070-LOC code that calls them as globals continues to work unchanged. **Behaviour-preserving extraction only — no algorithm changes.** |
| `sw.js` | Bump `SW_VERSION` from `'9.40'` to `'9.41'`; append the seven new module paths to `PRECACHE_URLS` (honour the warning comment at lines 17–29). |
| `diary.html` | Insert nav button at line 906; add `<div id="v-stand" class="view">` block alongside `v-list`/`v-stats` (around line 109/506); add module bootstrap `<script type="module">` at the bottom; import `activity-engine.mjs` here too so the diary side has access to the shared cache when the user has both tabs open. |
| `modules/weather.mjs` | **No behaviour change.** `fetchCullWeather` keeps `forecast_days=1` (cull-attached semantics — different scope from the planner's 7-day forecast). |

---

## 4. Recommendation algorithm (`stand-rank.mjs`)

The stand score blends the **existing per-hour activity score** (which already handles moon, rut, season, weather, solunar) with two stand-specific factors that the home-page forecast doesn't know about: wind alignment vs `preferred_approach_deg`, and historical similarity to nearby cull entries.

```text
score(stand, slot, ctx) → { total: 0..100, breakdown: {...} }

W_BASE = 0.50   // existing activity-engine score (moon+rut+season+weather+solunar)
W_WIND = 0.30   // stand-specific: scent direction relative to deer approach
W_HIST = 0.20   // stand-specific: your past sightings here under similar conditions

import { hourlyActivityScore } from './activity-engine.mjs';

baseScore(slot, ctx):
  // Reuses the SAME function the home page banner badge calls.
  // Already incorporates moon (getMoonPhase), rut (RUT_CALENDAR), seasonal
  // weighting, weather (temp, frost, wind speed, gust ratio, precip,
  // pressure delta), and solunar major/minor windows.
  return hourlyActivityScore(slot.hour, slot.date, ctx.lat, ctx.lng, slot.wxHour) / 100

windAlignment(stand, slot):
  // Genuinely new — the activity engine cares about wind speed but not
  // direction-relative-to-stand. Wind blows FROM windDeg; scent goes opposite.
  // Ideal = 180° opposite of preferred_approach_deg (deer's source bearing).
  ideal  = (stand.preferred_approach_deg + 180) % 360
  delta  = angularDiff(slot.windDeg, ideal)          // 0..180
  base   = 1 - (delta / 180)
  spd    = slot.windMph
  spdMul = spd<3 ? 0.55 : spd<6 ? 0.85 : spd<18 ? 1.00
         : spd<25 ? 0.80 : 0.50                       // dead calm = swirl; gales = spook
  return base * spdMul

historyMatch(stand, slot, ctx):
  // ctx.entries are user's cull_entries with lat/lng/weather_data
  near = ctx.entries.filter(e => haversine(e, stand) <= 300)   // metres
  if !near.length return 0.3                                   // unknown → mildly negative
  weighted = sum(0.6*windDirSimilarity + 0.4*moonSimilarity for e in near)
  return clamp(0.3 + 0.1 * weighted, 0, 1)

total = round(100 * (W_BASE*baseScore + W_WIND*windAlignment + W_HIST*historyMatch))
```

`bestStandTonight()` evaluates all stands × tonight's dusk slot and returns the top-ranked. The card renders the breakdown — including a "From the home-page activity forecast: 62/100" line — so users see the planner's score is consistent with what they already trust on the front page, plus the stand-specific bonus/penalty.

---

## 5. Map / wind-cone rendering

**Map instance.** Build a 3rd Leaflet map `standMap` (parallel to `pinMap` and `cullMap`). Initialise with `L.tileLayer(TILE_OS_STD, legacyTileOpts())` and the existing satellite toggle (mirror `lt-b`/`plt-map`/`plt-sat` from `diary.html:920–924`). Use `L.markerClusterGroup` for markers only — **not** for cones (spiderfication misbehaves with polygons).

**Wind cone.** Open-Meteo `wind_direction_10m` is the direction wind comes *from*. Scent goes the opposite way. Don't pull in `L.semiCircle` — draw an `L.polygon` with three points:
1. stand `[lat,lng]`
2. point at radius `R` along bearing `(windDeg + 180 - HALF_ANGLE)`
3. point at radius `R` along bearing `(windDeg + 180 + HALF_ANGLE)`

`R = clamp(150 + windMph * 25, 200, 800)` metres.
`HALF_ANGLE = clamp(45 - windMph, 15, 45)` degrees (steady wind → narrower cone).

Style: `{ color:'#c8a84b', weight:1, fillColor: scoreToColor(score), fillOpacity:0.35 }` — green→amber→red gradient maps to the slot's score. Add a thin black axis arrow so direction is unambiguous at low zoom.

**Slot scrubbing.** Maintain a single `L.featureGroup coneLayer`; on slot change `coneLayer.clearLayers()` then re-add. Avoids the per-marker leak pattern `cullMap` had to clean up at `diary.js:1995–1999`.

---

## 6. Rollout

1. **Supabase**: run `scripts/stands.sql` against staging then prod. Verify with `select * from pg_policies where tablename='stands'` (mirrors `scripts/supabase-audit-rls-snapshot.json` referenced at `modules/supabase.mjs:34`).
2. **SW bump**: `SW_VERSION='9.41'`; add 8 new module paths to `PRECACHE_URLS`. Existing `controllerchange` reload path in `modules/sw-bridge.mjs` handles client refresh.
3. **Soft launch behind flag**: `localStorage.fl_stand_planner_flag === '1'` shows the nav button and view. Default off; flip after one stalking-day of dogfooding. Flag check lives in the diary.html boot script — module isn't even imported when off, so cold-start unaffected.
4. **Fallbacks** documented above (no GPS, no network, stand outside UK).

---

## 7. Verification

**Unit tests** (new test runner not required — a tiny `<script type="module">` harness page imports the pure modules):
- **Extraction parity**: with the same `(date, lat, lng, wxDay)` inputs, the new `activity-engine.scoreDay` and `hourlyActivityScore` must return byte-identical values to the pre-extraction `app.js` versions for a frozen suite of ~20 sample dates. **Non-negotiable** — extraction is behaviour-preserving or it's a regression.
- `windAlignment(approach=0, windDeg=0)` → ≈ 1.0; `windDeg=180` → ≈ 0. Speed multiplier knees at 3/6/18/25 mph.
- `historyMatch` with 0 nearby entries = 0.3; with 5 perfect matches ≥ 0.8.
- Cone destination math: bearing 90° from `(54, -2)` by 500 m matches a known reference within 1 m.
- Total `score()` for a contrived "neutral" stand (no history, generic species pref, default wind) should equal `0.5 * baseScore` — confirming the planner reduces to the home-page activity forecast when no stand-specific signal exists.

**RLS test (staging, manual):** sign in as user A → create stand. Sign in as user B → `sb.from('stands').select()` must return only B's rows; `eq('user_id', userAId)` must return `[]`.

**Offline persistence:**
- Open online → close → DevTools "Offline" → reopen. Both list and forecast render from localStorage.
- Backdate `fetched_at` by 8 days → "Cached forecast expired — connect to refresh".

**Manual map UI checklist:**
- Cone direction matches a real-world Met Office wind report (one cross-check).
- Slot scrubber redraws ≤100 ms at 5 stands.
- Equator + 60°N stands both render without projection clipping.
- Tile-error fallback (`maybeFallbackFromMapbox` at `diary.js:5656`) still triggers when `api.mapbox.com` is blocked in DevTools.
- iOS safe-area insets respected on the new nav button.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Open-Meteo rate limits (10k/day per IP) | Cache by 3dp lat/lng so nearby stands share fetches; reuse `fetched_at` for 60 min; one fetch per planner open, not per slot. |
| RLS misconfiguration | SQL paired with positive *and* negative RLS test (§7). Add `stands` to whatever audit script `scripts/supabase-audit-rls-snapshot.json` already covers. |
| Wind cone misleads users (thermals reverse near rivers/re-entrants at dawn/dusk) | Persistent disclaimer pinned to card: *"Forecast wind is open-air at 10 m. Local thermals, terrain channelling and obstacles can reverse direction — always confirm on the ground."* (Same tonal pattern as the venison-quality disclaimer at `index.html:1300`.) |
| Battery drain | Single `getCurrentPosition({maximumAge: 600000, timeout: 10000})` on view-open; no `watchPosition`. Reuse last fix between sub-tabs. |
| Stand-pin spam | RLS-bound to own user. Add a `stands_insert_rate` Postgres trigger only if a real user crosses 50 stands. |
| Forecast horizon drift | Show `fetched_at` in UI; "Refresh" button forces bypass-cache. Clamp to 6 days if d7 missing. |
| CSP | `api.open-meteo.com` already in `connect-src` whitelist (`diary.html:5`) — no change. |

---

## Critical files to touch

**New:**
- `/home/user/first-light/modules/activity-engine.mjs` *(extract from app.js — shared by home page + planner)*
- `/home/user/first-light/modules/sun-times.mjs` *(extract from app.js)*
- `/home/user/first-light/modules/stand-planner.mjs`
- `/home/user/first-light/modules/stand-data.mjs`
- `/home/user/first-light/modules/stand-rank.mjs` *(pure — most important to get right)*
- `/home/user/first-light/modules/stand-ui-map.mjs` *(Leaflet cone rendering)*
- `/home/user/first-light/modules/stand-ui-card.mjs`
- `/home/user/first-light/scripts/stands.sql`

**Edit (minimally):**
- `/home/user/first-light/app.js` — replace the inline activity-engine + sun-times definitions with imports, re-expose on `window.*` for back-compat. Behaviour-preserving extraction; no algorithm changes.
- `/home/user/first-light/sw.js` — bump `SW_VERSION` to `'9.41'`, extend `PRECACHE_URLS` with the seven new modules.
- `/home/user/first-light/diary.html` — nav button (~line 906), `v-stand` view block, module bootstrap script.

**Reuse (no edit):**
- `/home/user/first-light/modules/weather.mjs` — URL pattern reference (lines 177–181); cull-attached forecast scope is intentionally separate from the planner's 7-day forecast.
- `/home/user/first-light/modules/clock.mjs` — `diaryNow()`.
- `/home/user/first-light/modules/supabase.mjs` — `sb`, `initSupabase()`.
- `/home/user/first-light/diary.js` — pin-drop overlay flow (~5689–5790), tile-layer constants (`TILE_OS_STD`, `TILE_MB_*`, `TILE_SAT_ESRI` at 5594–5596), `windDirLabel`, `mapProvider` fallback (`maybeFallbackFromMapbox` at 5656), Mapbox-quota estimator (`bumpMapLoadEstimate` at 5635).
