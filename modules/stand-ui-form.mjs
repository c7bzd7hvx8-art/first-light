// First Light — modules/stand-ui-form.mjs
//
// Add / edit stand modal. Self-contained — no coupling to diary.js's
// pin-drop overlay. The form takes:
//   * Name (required)
//   * Latitude / longitude (number inputs + "Use my GPS" button)
//   * Preferred approach bearing (0-359°, compass slider)
//   * Species (multi-select chips: Red / Fallow / Sika / Roe / Muntjac / CWD)
//   * Notes (optional, ≤ 500 chars)
//
// Caller passes an existing stand to edit, or null/undefined to create.
// Returns a Promise<Stand | null>: resolves to the saved row from
// Supabase, or null if the user cancelled.

import { upsertStand } from './stand-data.mjs';

const SPECIES = ['Red', 'Fallow', 'Sika', 'Roe', 'Muntjac', 'CWD'];

let modalEl = null;        // singleton — built lazily, reused across opens
let resolveCurrent = null; // resolver for the currently-open Promise

/** Open the form. Returns Promise<Stand | null>. */
export function openStandForm(initial) {
  ensureModal();
  fillForm(initial || null);
  modalEl.style.display = 'flex';
  return new Promise(resolve => { resolveCurrent = resolve; });
}

function close(value) {
  if (modalEl) modalEl.style.display = 'none';
  const r = resolveCurrent;
  resolveCurrent = null;
  if (r) r(value);
}

function ensureModal() {
  if (modalEl) return;
  modalEl = document.createElement('div');
  modalEl.id = 'stand-form-overlay';
  modalEl.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9000;align-items:center;justify-content:center;padding:16px;';
  modalEl.innerHTML = `
    <div style="background:#1c2a18;border:1px solid rgba(200,168,75,0.3);border-radius:14px;padding:18px;max-width:420px;width:100%;max-height:90vh;overflow-y:auto;color:#fff;font-family:'DM Sans',sans-serif;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div id="stand-form-title" style="font-size:16px;font-weight:700;">Add stand</div>
        <button type="button" id="stand-form-close" style="background:transparent;border:none;color:rgba(255,255,255,0.6);font-size:20px;cursor:pointer;line-height:1;">×</button>
      </div>

      <label style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:rgba(200,168,75,0.7);font-weight:700;">Name</label>
      <input id="stand-form-name" type="text" maxlength="80" placeholder="e.g. North ride high seat" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.15);color:#fff;border-radius:8px;padding:8px 10px;margin:4px 0 12px;font-family:inherit;font-size:13px;outline:none;">

      <label style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:rgba(200,168,75,0.7);font-weight:700;">Location</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:4px 0 6px;">
        <input id="stand-form-lat" type="text" inputmode="decimal" placeholder="Latitude"  style="background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.15);color:#fff;border-radius:8px;padding:8px 10px;font-family:inherit;font-size:13px;outline:none;">
        <input id="stand-form-lng" type="text" inputmode="decimal" placeholder="Longitude" style="background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.15);color:#fff;border-radius:8px;padding:8px 10px;font-family:inherit;font-size:13px;outline:none;">
      </div>
      <button type="button" id="stand-form-gps" style="background:rgba(200,168,75,0.18);color:#c8a84b;border:1px solid rgba(200,168,75,0.3);border-radius:8px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;margin-bottom:12px;">📍 Use my GPS</button>
      <div id="stand-form-gps-msg" style="font-size:10px;color:rgba(255,255,255,0.4);margin:-8px 0 12px;min-height:12px;"></div>

      <label style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:rgba(200,168,75,0.7);font-weight:700;">Deer approach bearing — <span id="stand-form-bearing-label">N (0°)</span></label>
      <div style="font-size:10px;color:rgba(255,255,255,0.45);margin:2px 0 6px;line-height:1.4;">The direction deer typically come FROM. Wind should blow your scent away from this bearing.</div>
      <input id="stand-form-bearing" type="range" min="0" max="359" step="1" value="0" style="width:100%;margin:0 0 12px;">

      <label style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:rgba(200,168,75,0.7);font-weight:700;">Species (tap to toggle)</label>
      <div id="stand-form-species" style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 14px;"></div>

      <label style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:rgba(200,168,75,0.7);font-weight:700;">Notes (optional)</label>
      <textarea id="stand-form-notes" maxlength="500" rows="2" placeholder="Wind tendencies, access notes, anything else…" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.15);color:#fff;border-radius:8px;padding:8px 10px;margin:4px 0 14px;font-family:inherit;font-size:13px;outline:none;resize:vertical;"></textarea>

      <div id="stand-form-err" style="display:none;color:#e57373;font-size:12px;margin-bottom:10px;"></div>

      <div style="display:flex;gap:8px;">
        <button type="button" id="stand-form-cancel" style="flex:1;background:rgba(255,255,255,0.06);color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:10px;padding:10px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>
        <button type="button" id="stand-form-save" style="flex:2;background:#c8a84b;color:#1a1a1a;border:none;border-radius:10px;padding:10px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;">Save stand</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);

  // Build species chips
  const speciesEl = modalEl.querySelector('#stand-form-species');
  SPECIES.forEach(sp => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'stand-species-chip';
    chip.dataset.species = sp;
    chip.textContent = sp;
    chip.style.cssText = 'background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.15);border-radius:14px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;';
    chip.addEventListener('click', () => toggleChip(chip));
    speciesEl.appendChild(chip);
  });

  // Bearing slider live label
  const bearingEl = modalEl.querySelector('#stand-form-bearing');
  const bearingLbl = modalEl.querySelector('#stand-form-bearing-label');
  bearingEl.addEventListener('input', () => {
    bearingLbl.textContent = bearingLabel(parseInt(bearingEl.value, 10));
  });

  // GPS button
  modalEl.querySelector('#stand-form-gps').addEventListener('click', () => {
    const msg = modalEl.querySelector('#stand-form-gps-msg');
    msg.textContent = 'Locating…';
    if (!navigator.geolocation) {
      msg.textContent = 'Geolocation unavailable on this device.';
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        modalEl.querySelector('#stand-form-lat').value = pos.coords.latitude.toFixed(6);
        modalEl.querySelector('#stand-form-lng').value = pos.coords.longitude.toFixed(6);
        msg.textContent = 'Location set (±' + Math.round(pos.coords.accuracy) + ' m).';
      },
      err => { msg.textContent = 'GPS error: ' + (err.message || err.code); },
      { maximumAge: 0, timeout: 10000, enableHighAccuracy: true }
    );
  });

  // Save / cancel / close
  modalEl.querySelector('#stand-form-save').addEventListener('click', save);
  modalEl.querySelector('#stand-form-cancel').addEventListener('click', () => close(null));
  modalEl.querySelector('#stand-form-close').addEventListener('click', () => close(null));
  // Backdrop click closes (but not when clicking the card itself)
  modalEl.addEventListener('click', e => { if (e.target === modalEl) close(null); });
}

function toggleChip(chip) {
  const on = chip.dataset.on === '1';
  chip.dataset.on = on ? '0' : '1';
  if (on) {
    chip.style.background = 'rgba(255,255,255,0.06)';
    chip.style.color = 'rgba(255,255,255,0.7)';
    chip.style.borderColor = 'rgba(255,255,255,0.15)';
  } else {
    chip.style.background = 'rgba(200,168,75,0.25)';
    chip.style.color = '#c8a84b';
    chip.style.borderColor = 'rgba(200,168,75,0.5)';
  }
}

function bearingLabel(deg) {
  const cardinals = ['N','NE','E','SE','S','SW','W','NW'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return cardinals[idx] + ' (' + deg + '°)';
}

function fillForm(stand) {
  modalEl.querySelector('#stand-form-title').textContent = stand ? 'Edit stand' : 'Add stand';
  modalEl.querySelector('#stand-form-name').value = (stand && stand.name) || '';
  modalEl.querySelector('#stand-form-lat').value  = (stand && stand.lat != null) ? stand.lat : '';
  modalEl.querySelector('#stand-form-lng').value  = (stand && stand.lng != null) ? stand.lng : '';
  const bearingVal = (stand && stand.preferred_approach_deg != null) ? stand.preferred_approach_deg : 0;
  modalEl.querySelector('#stand-form-bearing').value = bearingVal;
  modalEl.querySelector('#stand-form-bearing-label').textContent = bearingLabel(bearingVal);
  modalEl.querySelector('#stand-form-notes').value = (stand && stand.notes) || '';
  modalEl.querySelector('#stand-form-err').style.display = 'none';
  modalEl.querySelector('#stand-form-gps-msg').textContent = '';
  // Species chips
  const selected = new Set((stand && Array.isArray(stand.species_pref)) ? stand.species_pref : []);
  modalEl.querySelectorAll('.stand-species-chip').forEach(chip => {
    chip.dataset.on = '0';
    chip.style.background = 'rgba(255,255,255,0.06)';
    chip.style.color = 'rgba(255,255,255,0.7)';
    chip.style.borderColor = 'rgba(255,255,255,0.15)';
    if (selected.has(chip.dataset.species)) toggleChip(chip);
  });
  // Stash the existing id (if editing) on the modal so save() can read it
  modalEl.dataset.editingId = (stand && stand.id) ? stand.id : '';
}

async function save() {
  const errEl = modalEl.querySelector('#stand-form-err');
  const showErr = msg => {
    errEl.textContent = msg;
    errEl.style.display = '';
  };
  errEl.style.display = 'none';

  const name = modalEl.querySelector('#stand-form-name').value.trim();
  const lat  = parseFloat(modalEl.querySelector('#stand-form-lat').value);
  const lng  = parseFloat(modalEl.querySelector('#stand-form-lng').value);
  const bearing = parseInt(modalEl.querySelector('#stand-form-bearing').value, 10);
  const notes = modalEl.querySelector('#stand-form-notes').value.trim();

  if (!name) return showErr('Name is required.');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return showErr('Latitude must be a number between -90 and 90.');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return showErr('Longitude must be a number between -180 and 180.');

  const speciesPref = [];
  modalEl.querySelectorAll('.stand-species-chip').forEach(chip => {
    if (chip.dataset.on === '1') speciesPref.push(chip.dataset.species);
  });

  const id = modalEl.dataset.editingId || null;
  const payload = {
    name,
    lat,
    lng,
    preferred_approach_deg: bearing,
    species_pref: speciesPref,
    notes: notes || null
  };
  if (id) payload.id = id;

  // Need the user_id for insert (RLS WITH CHECK enforces auth.uid() = user_id).
  if (!id) {
    try {
      const sbMod = await import('./supabase.mjs');
      const sb = sbMod.sb;
      if (!sb) return showErr('Not signed in. Sign in first to save stands.');
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return showErr('Not signed in. Sign in first to save stands.');
      payload.user_id = user.id;
    } catch (e) {
      return showErr('Auth check failed: ' + (e.message || e));
    }
  }

  const saveBtn = modalEl.querySelector('#stand-form-save');
  const orig = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    const saved = await upsertStand(payload);
    saveBtn.disabled = false;
    saveBtn.textContent = orig;
    close(saved);
  } catch (e) {
    saveBtn.disabled = false;
    saveBtn.textContent = orig;
    let msg = e && e.message ? e.message : String(e);
    // Friendlier copy for the most common first-run failure: SQL not run yet.
    if (/relation .*stands.* does not exist/i.test(msg) || /could not find the table/i.test(msg)) {
      msg = 'The stands table doesn\'t exist yet. Run scripts/stands.sql in Supabase first.';
    }
    showErr(msg);
  }
}
