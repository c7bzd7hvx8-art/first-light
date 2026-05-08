// First Light — modules/stand-ui-card.mjs
//
// Renders the "Tonight" recommendation card and the 14-slot scrubber.
// Pure DOM in/out: caller passes containers and state, this module
// fills them in. No Supabase, no fetch — stand-planner.mjs owns those.

import { fmtMins, windDirArrow } from './activity-engine.mjs';

const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/** Star string for a 0..100 score. */
function stars(score) {
  if (score >= 80) return '★★★★★';
  if (score >= 65) return '★★★★☆';
  if (score >= 50) return '★★★☆☆';
  if (score >= 35) return '★★☆☆☆';
  return '★☆☆☆☆';
}

/** Plain-English direction word from a bearing the wind comes FROM. */
function windFromLabel(deg) {
  const cardinals = ['N','NE','E','SE','S','SW','W','NW'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return cardinals[idx];
}

/** Plain-English direction word for where scent travels TO (opposite). */
function scentToLabel(windFromDeg) {
  return windFromLabel((windFromDeg + 180) % 360);
}

/**
 * Build the human-readable rationale line.
 *   "Wind WSW 11 mph carries scent ENE — towards the deer approach."
 */
function rationale(stand, slot, breakdown) {
  if (slot.windDeg == null || slot.windMph == null) {
    return 'Wind data unavailable for this slot.';
  }
  const fromLabel = windFromLabel(slot.windDeg);
  const toLabel   = scentToLabel(slot.windDeg);
  const mph       = Math.round(slot.windMph);
  let alignment = 'mixed';
  if (stand.preferred_approach_deg != null) {
    if (breakdown.wind >= 75)      alignment = 'away from the beat';
    else if (breakdown.wind >= 50) alignment = 'mostly favourable';
    else if (breakdown.wind >= 30) alignment = 'unfavourable';
    else                           alignment = 'blowing your scent at the deer';
  }
  return 'Wind ' + fromLabel + ' ' + mph + ' mph carries scent ' + toLabel + ' — ' + alignment + '.';
}

/**
 * Render the recommendation card into `cardEl`.
 *   state: { stand, score: { total, breakdown }, slot }
 */
export function renderCard(cardEl, state) {
  if (!cardEl) return;
  if (!state || !state.stand || !state.score) {
    cardEl.innerHTML = '<div class="stand-card-empty" style="padding:18px;text-align:center;color:rgba(255,255,255,0.5);font-size:13px;">No stands yet. Add one to see a recommendation.</div>';
    return;
  }
  const { stand, score, slot } = state;
  const b = score.breakdown;
  const r = rationale(stand, slot, b);
  const slotLabel = formatSlotLabel(slot);

  cardEl.innerHTML =
    '<div class="stand-card" style="background:rgba(0,0,0,0.35);border:1px solid rgba(200,168,75,0.25);border-radius:14px;padding:14px;margin:10px 12px;">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">'
        + '<div>'
          + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:rgba(200,168,75,0.7);">Best stand · ' + escapeHtml(slotLabel) + '</div>'
          + '<div style="font-size:18px;font-weight:700;color:#fff;margin-top:2px;">' + escapeHtml(stand.name || 'Unnamed stand') + '</div>'
        + '</div>'
        + '<div style="text-align:right;">'
          + '<div style="font-size:24px;font-weight:800;color:#c8a84b;line-height:1;">' + score.total + '</div>'
          + '<div style="font-size:13px;color:#c8a84b;margin-top:2px;">' + stars(score.total) + '</div>'
        + '</div>'
      + '</div>'
      + '<div style="font-size:13px;color:rgba(255,255,255,0.78);margin-top:10px;line-height:1.4;">' + escapeHtml(r) + '</div>'
      + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px;">'
        + breakdownTile('Activity', b.base + '/100', 'home-page forecast')
        + breakdownTile('Wind', b.wind + '/100', 'vs your approach')
        + breakdownTile('History', b.history + '/100', 'nearby culls')
      + '</div>'
      + '<div style="font-size:10px;color:rgba(255,255,255,0.32);margin-top:10px;line-height:1.45;">'
        + 'Forecast wind is open-air at 10 m. Local thermals, terrain channelling and obstacles can reverse direction — always confirm on the ground.'
      + '</div>'
    + '</div>';
}

function breakdownTile(label, value, sub) {
  return '<div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:8px 10px;text-align:center;">'
    + '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:rgba(255,255,255,0.4);">' + escapeHtml(label) + '</div>'
    + '<div style="font-size:15px;font-weight:700;color:#fff;margin-top:2px;">' + escapeHtml(value) + '</div>'
    + '<div style="font-size:9px;color:rgba(255,255,255,0.35);margin-top:1px;">' + escapeHtml(sub) + '</div>'
  + '</div>';
}

/**
 * Render the horizontal slot scrubber into `scrubberEl`.
 *   slots:        Slot[] (length 14)
 *   activeIdx:    index of currently selected slot
 *   onPick(idx):  callback when user taps a slot
 */
export function renderScrubber(scrubberEl, slots, activeIdx, onPick) {
  if (!scrubberEl) return;
  scrubberEl.innerHTML = '';
  scrubberEl.style.cssText = 'display:flex;gap:6px;overflow-x:auto;padding:8px 12px;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;';
  slots.forEach((slot, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stand-slot' + (i === activeIdx ? ' on' : '');
    btn.style.cssText = 'flex:0 0 auto;min-width:92px;padding:8px 10px;border-radius:10px;border:1px solid '
      + (i === activeIdx ? 'rgba(200,168,75,0.6)' : 'rgba(255,255,255,0.1)') + ';'
      + 'background:' + (i === activeIdx ? 'rgba(200,168,75,0.18)' : 'rgba(255,255,255,0.04)') + ';'
      + 'color:#fff;font-family:inherit;font-size:11px;text-align:center;cursor:pointer;scroll-snap-align:start;';
    btn.innerHTML =
      '<div style="font-weight:700;letter-spacing:0.4px;">' + escapeHtml(formatSlotLabel(slot)) + '</div>'
      + '<div style="font-size:9px;color:rgba(255,255,255,0.5);margin-top:2px;text-transform:uppercase;">' + (slot.kind === 'dawn' ? 'Dawn' : 'Dusk') + '</div>';
    btn.addEventListener('click', () => onPick(i));
    scrubberEl.appendChild(btn);
  });
}

export function formatSlotLabel(slot) {
  if (!slot || !slot.date) return '';
  const day = DAY_NAMES[slot.date.getDay()];
  const time = fmtMins(slot.minutesSinceMidnight || (slot.hour * 60));
  return day + ' ' + (slot.kind === 'dawn' ? 'dawn' : 'dusk') + ' ' + time;
}

/**
 * Render the empty state — shown on the Tonight tab when the user has
 * no saved stands yet. `onAdd` fires when the CTA is tapped.
 */
export function renderEmpty(cardEl, onAdd) {
  if (!cardEl) return;
  cardEl.innerHTML =
    '<div style="text-align:center;padding:40px 20px;">'
      + '<div style="font-size:32px;margin-bottom:10px;">🌬️</div>'
      + '<div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px;">No stands yet</div>'
      + '<div style="font-size:13px;color:rgba(255,255,255,0.55);margin-bottom:18px;line-height:1.5;">'
        + 'Save your high seats and we\'ll rank them for tonight\'s wind, moon and recent sightings.'
      + '</div>'
      + '<button type="button" id="stand-empty-add" style="background:#c8a84b;color:#1a1a1a;border:none;border-radius:10px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer;">+ Add your first stand</button>'
    + '</div>';
  const btn = cardEl.querySelector('#stand-empty-add');
  if (btn && onAdd) btn.addEventListener('click', onAdd);
}

/**
 * Render the "My stands" list view.
 *   stands:       Stand[]
 *   onEdit(s):    edit callback
 *   onDelete(s):  delete callback
 *   onAdd():      new-stand callback
 */
export function renderStandsList(listEl, stands, { onEdit, onDelete, onAdd } = {}) {
  if (!listEl) return;
  listEl.innerHTML = '';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.style.cssText = 'width:calc(100% - 24px);margin:10px 12px;padding:12px;border-radius:10px;border:1px dashed rgba(200,168,75,0.5);background:transparent;color:#c8a84b;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;';
  addBtn.textContent = '+ Add stand';
  if (onAdd) addBtn.addEventListener('click', onAdd);
  listEl.appendChild(addBtn);

  if (!stands || !stands.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;color:rgba(255,255,255,0.4);font-size:12px;padding:20px;';
    empty.textContent = 'No stands saved yet.';
    listEl.appendChild(empty);
    return;
  }
  stands.forEach(s => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px;margin:6px 12px;background:rgba(255,255,255,0.04);border-radius:10px;';
    const approach = (s.preferred_approach_deg != null)
      ? '· deer from ' + windFromLabel(s.preferred_approach_deg)
      : '';
    const species = (s.species_pref && s.species_pref.length)
      ? ' · ' + s.species_pref.join(', ')
      : '';
    row.innerHTML =
      '<div style="flex:1;min-width:0;">'
        + '<div style="font-weight:700;color:#fff;font-size:13px;">' + escapeHtml(s.name || 'Unnamed') + '</div>'
        + '<div style="font-size:10px;color:rgba(255,255,255,0.45);margin-top:2px;">'
          + (s.lat != null ? s.lat.toFixed(4) + ', ' + s.lng.toFixed(4) : '')
          + ' ' + approach + escapeHtml(species)
        + '</div>'
      + '</div>'
      + '<div style="display:flex;gap:6px;">'
        + '<button type="button" class="stand-edit" style="background:rgba(200,168,75,0.18);color:#c8a84b;border:none;border-radius:8px;padding:6px 10px;font-size:11px;cursor:pointer;">Edit</button>'
        + '<button type="button" class="stand-del" style="background:rgba(198,40,40,0.18);color:#e57373;border:none;border-radius:8px;padding:6px 10px;font-size:11px;cursor:pointer;">Del</button>'
      + '</div>';
    const editBtn = row.querySelector('.stand-edit');
    const delBtn  = row.querySelector('.stand-del');
    if (editBtn && onEdit) editBtn.addEventListener('click', () => onEdit(s));
    if (delBtn  && onDelete) delBtn.addEventListener('click', () => {
      if (confirm('Delete stand "' + (s.name || 'Unnamed') + '"?')) onDelete(s);
    });
    listEl.appendChild(row);
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
