/* Cull Diary — App v2.0 */
// ══════════════════════════════════════════════════════════════
// CULL PLAN — targets vs actuals
// ══════════════════════════════════════════════════════════════
var cullTargets = {}; // { 'Red Deer-m': 10, 'Red Deer-f': 12, ... }
var prevSeasonTargets = {}; // for copy-from-prev

var PLAN_SPECIES = [
  { name:'Red Deer',  color:'#c8a84b', key:'red',     mLbl:'Stag', fLbl:'Hind' },
  { name:'Roe Deer',  color:'#5a7a30', key:'roe',     mLbl:'Buck', fLbl:'Doe'  },
  { name:'Fallow',    color:'#f57f17', key:'fallow',  mLbl:'Buck', fLbl:'Doe'  },
  { name:'Muntjac',   color:'#6a1b9a', key:'muntjac', mLbl:'Buck', fLbl:'Doe'  },
  { name:'Sika',      color:'#1565c0', key:'sika',    mLbl:'Stag', fLbl:'Hind' },
  { name:'CWD',       color:'#00695c', key:'cwd',     mLbl:'Buck', fLbl:'Doe'  },
];

function isCurrentSeason(season) {
  var now = new Date();
  var m = now.getMonth() + 1, y = now.getFullYear();
  var startYear = m >= 8 ? y : y - 1;
  return season === startYear + '-' + String(startYear + 1).slice(-2);
}

async function loadTargets(season) {
  if (!sb || !currentUser) return;
  try {
    var r = await sb.from('cull_targets')
      .select('species, sex, target')
      .eq('user_id', currentUser.id)
      .eq('season', season);
    cullTargets = {};
    if (r.data) {
      r.data.forEach(function(row) {
        cullTargets[row.species + '-' + row.sex] = row.target;
      });
    }
  } catch(e) { console.warn('loadTargets error:', e); }
}

async function loadPrevTargets(season) {
  // Load targets from the season before current for copy functionality
  if (!sb || !currentUser) return;
  var parts = season.split('-');
  var prevStart = parseInt(parts[0]) - 1;
  var prevSeason = prevStart + '-' + String(prevStart + 1).slice(-2);
  try {
    var r = await sb.from('cull_targets')
      .select('species, sex, target')
      .eq('user_id', currentUser.id)
      .eq('season', prevSeason);
    prevSeasonTargets = {};
    if (r.data) {
      r.data.forEach(function(row) {
        prevSeasonTargets[row.species + '-' + row.sex] = row.target;
      });
    }
  } catch(e) {}
}

function renderPlanCard(entries, season) {
  var body = document.getElementById('plan-body');
  var editBtn = document.getElementById('plan-edit-btn');
  var planSub = document.getElementById('plan-sub');
  if (!body) return;

  // Hide edit button for past seasons
  var isCurrent = isCurrentSeason(season);
  if (editBtn) editBtn.style.display = isCurrent ? '' : 'none';
  if (planSub) planSub.textContent = isCurrent ? 'Cull targets vs actual' : 'Past season · read only';

  // Check if any targets set — either season or ground mode
  var hasSeasonTargets = Object.keys(cullTargets).some(function(k) { return cullTargets[k] > 0; });
  var hasGrndTargets = hasGroundTargets();
  var hasTargets = hasSeasonTargets || hasGrndTargets;
  if (!hasTargets) {
    body.innerHTML = isCurrent
      ? '<div class="plan-empty"><div class="plan-empty-icon">🎯</div><div class="plan-empty-t">No targets set</div><div class="plan-empty-s">Set cull targets to track your season plan against actual results.</div><button class="plan-set-btn" onclick="openTargetsSheet()">Set targets</button></div>'
      : '<div class="plan-empty"><div class="plan-empty-icon">🎯</div><div class="plan-empty-t">No targets were set</div><div class="plan-empty-s">No cull plan was recorded for this season.</div></div>';
    return;
  }

  // Count actuals per species/sex — filtered by ground if in ground mode
  var actuals = {};
  var filteredByGround = entries;
  if (planGroundFilter !== 'overview' && hasGroundTargets()) {
    if (planGroundFilter === '__unassigned__') {
      filteredByGround = entries.filter(function(e){ return !e.ground; });
    } else {
      filteredByGround = entries.filter(function(e){ return e.ground === planGroundFilter; });
    }
  }
  filteredByGround.forEach(function(e) {
    var k = e.species + '-' + e.sex;
    actuals[k] = (actuals[k] || 0) + 1;
  });

  // Determine which targets to use
  var activeTargets = cullTargets;
  if (hasGroundTargets()) {
    if (planGroundFilter === 'overview') {
      // Overview: use season-level targets if they exist, otherwise sum ground targets
      var hasSeasonT = Object.keys(cullTargets).some(function(k) { return cullTargets[k] > 0; });
      if (hasSeasonT) {
        activeTargets = cullTargets;
      } else {
        // No season targets — sum all ground targets as fallback
        activeTargets = {};
        Object.keys(groundTargets).forEach(function(g) {
          Object.keys(groundTargets[g]).forEach(function(k) {
            activeTargets[k] = (activeTargets[k]||0) + (groundTargets[g][k]||0);
          });
        });
      }
    } else {
      activeTargets = groundTargets[planGroundFilter] || {};
    }
  }

  var totalTarget = 0, totalActual = 0;
  var html = '';

  PLAN_SPECIES.forEach(function(sp, idx) {
    var mKey = sp.name + '-m';
    var fKey = sp.name + '-f';
    var mTarget = activeTargets[mKey] || 0;
    var fTarget = activeTargets[fKey] || 0;
    var mActual = actuals[mKey] || 0;
    var fActual = actuals[fKey] || 0;
    if (mTarget === 0 && fTarget === 0 && mActual === 0 && fActual === 0) return; // skip species with no targets and no actuals
    var spTarget = mTarget + fTarget;
    var spActual = mActual + fActual;
    totalTarget += spTarget;
    totalActual += spActual;

    if (idx > 0 && html) html += '<div class="plan-divider"></div>';

    html += '<div class="plan-sp-section">';
    html += '<div class="plan-sp-hdr">';
    html += '<div class="plan-sp-dot" style="background:' + sp.color + ';"></div>';
    html += '<div class="plan-sp-name">' + sp.name + '</div>';
    html += '<div class="plan-sp-total">' + spActual + '/' + spTarget + '</div>';
    html += '</div>';

    // Male row — show if target set OR actuals exist
    if (mTarget > 0 || mActual > 0) {
      var mPct = mTarget > 0 ? Math.min(100, Math.round(mActual / mTarget * 100)) : (mActual > 0 ? 100 : 0);
      var mDone = mTarget > 0 && mActual >= mTarget;
      var barColor = mTarget === 0 ? 'linear-gradient(90deg,#a0988a,#c0b8a8)' : mDone ? 'linear-gradient(90deg,#2d7a1a,#7adf7a)' : 'linear-gradient(90deg,#5a7a30,#7adf7a)';
      html += '<div class="plan-sex-row">';
      html += '<div class="plan-sex-icon">♂</div>';
      html += '<div class="plan-sex-lbl">' + sp.mLbl + '</div>';
      html += '<div class="plan-bar-wrap"><div class="plan-bar" style="width:' + mPct + '%;background:' + barColor + ';"></div></div>';
      html += '<div class="plan-count ' + (mDone ? 'plan-count-done' : mActual === 0 ? 'plan-count-zero' : '') + '">' + mActual + '/' + mTarget + (mDone ? ' ✓' : '') + '</div>';
      html += '</div>';
    }

    // Female row — show if target set OR actuals exist
    if (fTarget > 0 || fActual > 0) {
      var fPct = fTarget > 0 ? Math.min(100, Math.round(fActual / fTarget * 100)) : (fActual > 0 ? 100 : 0);
      var fDone = fTarget > 0 && fActual >= fTarget;
      var fBarColor = fTarget === 0 ? 'linear-gradient(90deg,#a0988a,#c0b8a8)' : fDone ? 'linear-gradient(90deg,#2d7a1a,#7adf7a)' : 'linear-gradient(90deg,#5a7a30,#7adf7a)';
      html += '<div class="plan-sex-row">';
      html += '<div class="plan-sex-icon">♀</div>';
      html += '<div class="plan-sex-lbl">' + sp.fLbl + '</div>';
      html += '<div class="plan-bar-wrap"><div class="plan-bar" style="width:' + fPct + '%;background:' + fBarColor + ';"></div></div>';
      html += '<div class="plan-count ' + (fDone ? 'plan-count-done' : fActual === 0 ? 'plan-count-zero' : '') + '">' + fActual + '/' + fTarget + (fDone ? ' ✓' : '') + '</div>';
      html += '</div>';
    }

    html += '</div>';
  });

  // Total row
  var totalPct = totalTarget > 0 ? Math.min(100, Math.round(totalActual / totalTarget * 100)) : 0;
  html += '<div class="plan-total-row">';
  html += '<div class="plan-total-lbl">Total</div>';
  html += '<div class="plan-total-bar"><div class="plan-total-fill" style="width:' + totalPct + '%;"></div></div>';
  html += '<div class="plan-total-count">' + totalActual + '/' + totalTarget + '</div>';
  html += '</div>';

  if (!isCurrent) html += '<div class="plan-past-note">Past season — read only</div>';

  body.innerHTML = html;
}

function openTargetsSheet() {
  if (!isCurrentSeason(currentSeason)) return; // only edit current season

  // Populate stepper values from current targets
  PLAN_SPECIES.forEach(function(sp) {
    var mEl = document.getElementById('tt-' + sp.key + 'm');
    var fEl = document.getElementById('tt-' + sp.key + 'f');
    if (mEl) mEl.value = cullTargets[sp.name + '-m'] || 0;
    if (fEl) fEl.value = cullTargets[sp.name + '-f'] || 0;
  });

  // Show copy-from-prev if previous season has targets and current is empty
  var hasCurrentTargets = Object.keys(cullTargets).some(function(k){ return cullTargets[k] > 0; });
  var hasPrevTargets = Object.keys(prevSeasonTargets).some(function(k){ return prevSeasonTargets[k] > 0; });
  var copyWrap = document.getElementById('copy-targets-wrap');
  if (copyWrap) copyWrap.style.display = (!hasCurrentTargets && hasPrevTargets) ? 'block' : 'none';

  // Update subtitle
  var sub = document.getElementById('tsheet-sub');
  if (sub) sub.textContent = currentSeason;

  // Set mode — use ground mode if ground targets exist
  var useGround = hasGroundTargets() && savedGrounds.length > 0;
  setTargetMode(useGround ? 'ground' : 'season');

  document.getElementById('tsheet-ov').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeTargetsSheet() {
  document.getElementById('tsheet-ov').classList.remove('open');
  document.body.style.overflow = '';
}

function tstep(id, delta) {
  var el = document.getElementById('tt-' + id);
  if (el) el.value = Math.max(0, (parseInt(el.value) || 0) + delta);
}

function copyTargetsFromPrev() {
  PLAN_SPECIES.forEach(function(sp) {
    var mEl = document.getElementById('tt-' + sp.key + 'm');
    var fEl = document.getElementById('tt-' + sp.key + 'f');
    if (mEl) mEl.value = prevSeasonTargets[sp.name + '-m'] || 0;
    if (fEl) fEl.value = prevSeasonTargets[sp.name + '-f'] || 0;
  });
  document.getElementById('copy-targets-wrap').style.display = 'none';
  showToast('📋 Targets copied from previous season');
}

async function saveTargets() {
  if (!sb || !currentUser) { showToast('⚠️ Not signed in'); return; }
  var btn = document.querySelector('.tsheet-save');
  btn.disabled = true; btn.textContent = '☁️ Saving…';

  try {
    if (targetMode === 'ground') {
      await saveGroundTargets();
      showToast('✅ Targets saved');
      closeTargetsSheet();
      renderPlanGroundFilter();
      renderPlanCard(allEntries, currentSeason);
      btn.disabled = false; btn.textContent = '☁️ Save targets';
      return;
    }

    // Season total mode — save to cull_targets as before
    var rows = [];
    PLAN_SPECIES.forEach(function(sp) {
      var mEl = document.getElementById('tt-' + sp.key + 'm');
      var fEl = document.getElementById('tt-' + sp.key + 'f');
      var mVal = parseInt(mEl ? mEl.value : 0) || 0;
      var fVal = parseInt(fEl ? fEl.value : 0) || 0;
      rows.push({ user_id: currentUser.id, season: currentSeason, species: sp.name, sex: 'm', target: mVal });
      rows.push({ user_id: currentUser.id, season: currentSeason, species: sp.name, sex: 'f', target: fVal });
    });

    // Upsert all rows (insert or update)
    var r = await sb.from('cull_targets')
      .upsert(rows, { onConflict: 'user_id,season,species,sex' });

    if (r.error) throw r.error;

    // Update local cache
    cullTargets = {};
    rows.forEach(function(row) { cullTargets[row.species + '-' + row.sex] = row.target; });

    showToast('✅ Targets saved');
    closeTargetsSheet();
    renderPlanCard(allEntries, currentSeason);
  } catch(e) {
    showToast('⚠️ Save failed: ' + (e.message || 'Unknown error'));
  }
  btn.disabled = false; btn.textContent = '☁️ Save targets';
}

// ════════════════════════════════════
// SUPABASE CONFIG — replace with your project URL and anon key
// Get these from: supabase.com → your project → Settings → API
// ════════════════════════════════════
var SUPABASE_URL  = 'https://sjaasuqeknvvmdpydfsz.supabase.co';
var SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNqYWFzdXFla252dm1kcHlkZnN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NjMzMzIsImV4cCI6MjA5MDIzOTMzMn0.aiJaKoLCI3jUkOgifqMLuhp8NnAFK0T24Va6r2CLzgw';

var sb = null;
var SUPABASE_CONFIGURED = (SUPABASE_URL !== 'YOUR_SUPABASE_URL' && SUPABASE_KEY !== 'YOUR_SUPABASE_ANON_KEY');

function initSupabase() {
  if (!SUPABASE_CONFIGURED) {
    // Show setup notice on auth card instead of crashing
    var note = document.querySelector('.auth-note');
    if (note) {
      note.innerHTML = '<span style="color:#c62828;font-weight:700;">⚠️ Supabase not configured.</span><br>Open diary.html and replace<br>YOUR_SUPABASE_URL and YOUR_SUPABASE_ANON_KEY<br>with your project credentials.';
    }
    document.getElementById('auth-btn').disabled = true;
    return false;
  }
  try {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    return true;
  } catch(e) {
    showToast('⚠️ Supabase failed to initialise');
    return false;
  }
}

// ════════════════════════════════════
// STATE
// ════════════════════════════════════
var currentUser   = null;
var allEntries    = [];
var filteredEntries = [];
var currentFilter = 'all';
var currentEntry  = null;
var editingId     = null;
var photoFile     = null;
var photoPreviewUrl = null;
var formSpecies   = '';
var formSex       = '';
// ════════════════════════════════════
// SEASON HELPERS — fully dynamic
// ════════════════════════════════════
function getCurrentSeason() {
  var now = new Date();
  var y = now.getFullYear();
  var m = now.getMonth() + 1; // 1-12
  // Season runs Aug-Jul, so Aug 2025 → Jul 2026 = "2025-26"
  var startYear = m >= 8 ? y : y - 1;
  return startYear + '-' + String(startYear + 1).slice(-2);
}

function seasonLabel(s) {
  var parts = s.split('-');
  var y1 = parts[0];
  var y2 = parts[1].length === 2 ? '20' + parts[1] : parts[1];
  return y1 + '–' + y2 + ' Season';
}

function buildSeasonFromEntry(dateStr) {
  // Given an entry date, return which season it belongs to
  if (!dateStr) return getCurrentSeason();
  // Parse manually to avoid UTC midnight timezone shift (YYYY-MM-DD parsed by new Date() = UTC)
  var parts = dateStr.split('-');
  var y = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10); // 1–12 exact, no timezone offset
  var startYear = m >= 8 ? y : y - 1;
  return startYear + '-' + String(startYear + 1).slice(-2);
}

function populateSeasonDropdown(seasons) {
  var sel = document.getElementById('season-select');
  if (!sel) return;
  sel.innerHTML = '';
  seasons.forEach(function(s) {
    var opt = document.createElement('option');
    opt.value = s;
    opt.textContent = seasonLabel(s);
    sel.appendChild(opt);
  });
  sel.value = currentSeason;
  // Sync stats season pill whenever list dropdown is populated
  var statsSel = document.getElementById('season-select-stats');
  if (statsSel) { statsSel.innerHTML = sel.innerHTML; statsSel.value = currentSeason; }
}

function buildSeasonList(earliestSeason) {
  // Build list from earliest season with entries up to current season
  var current = getCurrentSeason();
  var seasons = [];
  var startYear = parseInt(current.split('-')[0]);
  var endYear = earliestSeason ? parseInt(earliestSeason.split('-')[0]) : startYear;
  // Go from current back to earliest (or max 10 years)
  for (var y = startYear; y >= Math.max(endYear, startYear - 9); y--) {
    seasons.push(y + '-' + String(y + 1).slice(-2));
  }
  return seasons;
}

var currentSeason = getCurrentSeason();

// ════════════════════════════════════
// ROUTING
// ════════════════════════════════════
var VIEWS = ['v-auth','v-list','v-form','v-detail','v-stats'];
var NAV_MAP = {'v-list':'n-list','v-form':'n-form','v-stats':'n-stats'};
var formDirty = false;

function go(id) {
  // Warn if leaving form with unsaved changes
  if (formDirty && document.getElementById('v-form').classList.contains('active') && id !== 'v-form') {
    if (!confirm('You have unsaved changes. Leave without saving?')) return;
    formDirty = false;
  }
  VIEWS.forEach(function(v){ document.getElementById(v).classList.remove('active'); });
  document.getElementById(id).classList.add('active');
  var nav = document.getElementById('main-nav');
  nav.style.display = (id === 'v-auth') ? 'none' : 'flex';
  Object.keys(NAV_MAP).forEach(function(k){ document.getElementById(NAV_MAP[k]).classList.remove('on'); });
  if (NAV_MAP[id]) document.getElementById(NAV_MAP[id]).classList.add('on');
  window.scrollTo(0,0);
  if (id === 'v-stats') buildStats();
}

function formBack() {
  if (formDirty) {
    if (!confirm('You have unsaved changes. Leave without saving?')) return;
  }
  formDirty = false;
  go('v-list');
}

// Mark form dirty on any input change
document.addEventListener('DOMContentLoaded', function() {
  var form = document.getElementById('v-form');
  if (form) {
    form.addEventListener('input', function() { formDirty = true; });
    form.addEventListener('change', function() { formDirty = true; });
  }
});

function showToast(msg, duration) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, duration || 2500);
}

// ════════════════════════════════════
// AUTH
// ════════════════════════════════════
var authMode = 'signin';

function authTab(mode) {
  authMode = mode;
  document.getElementById('tab-signin').classList.toggle('on', mode === 'signin');
  document.getElementById('tab-signup').classList.toggle('on', mode === 'signup');
  document.getElementById('auth-btn').textContent = mode === 'signin' ? 'Sign In →' : 'Create Account →';
  document.getElementById('auth-name-field').style.display = mode === 'signup' ? 'block' : 'none';
  document.getElementById('auth-consent-field').style.display = mode === 'signup' ? 'block' : 'none';
  document.getElementById('auth-err').style.display = 'none';
  document.getElementById('auth-password').setAttribute('autocomplete', mode === 'signin' ? 'current-password' : 'new-password');
}

async function handleAuth() {
  if (!sb) { showToast('⚠️ Supabase not configured'); return; }
  var email = document.getElementById('auth-email').value.trim();
  var password = document.getElementById('auth-password').value;
  var errEl = document.getElementById('auth-err');
  var btn = document.getElementById('auth-btn');
  errEl.style.display = 'none';
  if (!email || !password) { errEl.textContent = 'Please enter email and password.'; errEl.style.display = 'block'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Please enter a valid email address.'; errEl.style.display = 'block'; return; }
  if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; errEl.style.display = 'block'; return; }
  if (authMode === 'signup' && !document.getElementById('auth-consent').checked) {
    errEl.textContent = 'Please agree to the Privacy Policy to create an account.'; errEl.style.display = 'block'; return;
  }
  btn.disabled = true;
  btn.textContent = authMode === 'signin' ? 'Signing in…' : 'Creating account…';
  try {
    var result;
    if (authMode === 'signin') {
      result = await sb.auth.signInWithPassword({ email: email, password: password });
    } else {
      var name = document.getElementById('auth-name').value.trim();
      result = await sb.auth.signUp({ email: email, password: password, options: { data: { full_name: name } } });
    }
    if (result.error) throw result.error;
    if (authMode === 'signup') {
      showToast('✅ Check your email to confirm your account', 4000);
      authTab('signin');
    } else {
      currentUser = result.data.user;
      onSignedIn();
    }
  } catch(e) {
    errEl.textContent = e.message || 'Authentication failed.';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
  btn.textContent = authMode === 'signin' ? 'Sign In →' : 'Create Account →';
}

async function signOut() {
  if (sb) await sb.auth.signOut();
  // Reset all session state so a new user starts clean
  currentUser = null;
  allEntries = [];
  filteredEntries = [];
  currentSeason = getCurrentSeason();
  currentFilter = 'all';
  cullTargets = {};
  groundTargets = {};
  savedGrounds = [];
  planGroundFilter = 'overview';
  targetMode = 'season';
  // Reset cull map so next user gets fresh pins
  if (cullMap) {
    cullMarkers.forEach(function(m){ cullMap.removeLayer(m); });
    cullMarkers = [];
    cullMap = null; cullMapLayer = null; cullSatLayer = null;
  }
  go('v-auth');
}

function onSignedIn() {
  initWeightCalc();
  updateOfflineBadge();
  var meta = currentUser.user_metadata || {};
  var name = meta.full_name || currentUser.email.split('@')[0];
  var initials = name.split(' ').map(function(w){ return w[0]; }).join('').toUpperCase().slice(0,2);
  document.getElementById('account-av').textContent = initials;
  document.getElementById('account-name').textContent = name;
  document.getElementById('account-email').textContent = currentUser.email + ' · Synced';
  // Set current season label dynamically
  currentSeason = getCurrentSeason();
  document.getElementById('season-label').textContent = seasonLabel(currentSeason);
  document.getElementById('stats-season-lbl').textContent = seasonLabel(currentSeason);
  go('v-list');
  loadGrounds();
  loadEntries();
}

// Init on DOM ready
document.addEventListener('DOMContentLoaded', function() {
  if (!initSupabase()) return;

  // Handle email confirmation redirect — Supabase puts token in URL hash
  // e.g. diary.html#access_token=...&type=signup
  (async function() {
    try {
      // Let Supabase process any hash tokens first
      var s = await sb.auth.getSession();
      if (s.data && s.data.session) {
        currentUser = s.data.session.user;
        onSignedIn();
        // Clean up the URL hash
        if (window.location.hash) history.replaceState(null, '', window.location.pathname);
        return;
      }
      // If no session yet, show auth screen (onAuthStateChange will handle token)
    } catch(e) { /* no session */ }
  })();

  sb.auth.onAuthStateChange(function(event, session) {
    if (event === 'SIGNED_IN' && session) {
      currentUser = session.user;
      onSignedIn();
      if (window.location.hash) history.replaceState(null, '', window.location.pathname);
    }
    if (event === 'SIGNED_OUT') { currentUser = null; go('v-auth'); }
  });
});

// ════════════════════════════════════
// DATA
// ════════════════════════════════════
function seasonDates(season) {
  var parts = season.split('-');
  var y1 = parseInt(parts[0]); // e.g. 2025
  var y2 = y1 + 1;             // always next year (2026)
  return { start: y1 + '-08-01', end: y2 + '-07-31' };
}

async function loadEntries() {
  if (!currentUser || !sb) return;
  try {
    // First fetch ALL entries to know which seasons exist
    var all = await sb.from('cull_entries')
      .select('date')
      .eq('user_id', currentUser.id)
      .order('date', { ascending: true });

    // Build season list from actual entry dates
    var earliest = null;
    if (all.data && all.data.length > 0) {
      earliest = buildSeasonFromEntry(all.data[0].date);
    }
    var seasons = buildSeasonList(earliest);
    populateSeasonDropdown(seasons);

    // Now load entries for the current season
    var d = seasonDates(currentSeason);
    var r = await sb.from('cull_entries')
      .select('*')
      .eq('user_id', currentUser.id)
      .gte('date', d.start)
      .lte('date', d.end)
      .order('date', { ascending: false });

    if (!r.error) { allEntries = r.data || []; renderList(); }
    else { showToast('⚠️ Could not load entries'); }
  } catch(e) {
    showToast('⚠️ Could not load entries');
    console.warn('loadEntries failed:', e);
  }
}

function changeSeason() {
  currentSeason = document.getElementById('season-select').value;
  document.getElementById('season-label').textContent = seasonLabel(currentSeason);
  loadEntries();
}

// ════════════════════════════════════
// RENDER LIST
// ════════════════════════════════════
var SPECIES_CLASS = { 'Red Deer':'sp-red','Roe Deer':'sp-roe','Fallow':'sp-fallow','Sika':'sp-sika','Muntjac':'sp-muntjac','CWD':'sp-cwd' };
var SEX_BADGE     = { 'm':'sx-st', 'f':'sx-hi' };  // overridden per species below
var SEX_LABEL     = { 'm':'Stag/Buck', 'f':'Hind/Doe' };
var MONTH_NAMES   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var FULL_MONTHS   = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function sexBadgeClass(sex, species) {
  if (sex === 'm') return (species === 'Roe Deer' || species === 'Fallow' || species === 'Muntjac' || species === 'Sika' || species === 'CWD') ? 'sx-bu' : 'sx-st';
  return (species === 'Roe Deer' || species === 'Fallow' || species === 'Muntjac' || species === 'Sika' || species === 'CWD') ? 'sx-do' : 'sx-hi';
}
function sexLabel(sex, species) {
  var isBuck = ['Roe Deer','Fallow','Muntjac','Sika','CWD'].indexOf(species) >= 0;
  if (sex === 'm') return isBuck ? 'Buck' : 'Stag';
  return isBuck ? 'Doe' : 'Hind';
}
function fmtDate(d) {
  if (!d) return '';
  var parts = d.split('-');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d).getDay()] + ' ' + parseInt(parts[2]) + ' ' + MONTH_NAMES[parseInt(parts[1])-1];
}

// Safe photo URL — only allow https URLs from trusted storage
function safeUrl(url) {
  if (!url) return null;
  return /^https:\/\//.test(url) ? url : null;
}

// ── Weight auto-calculator ──────────────────────────────────
// BDS ratios: clean ≈ gralloch × 0.82, larder ≈ gralloch × 0.75
var wtcManual = false; // true when user has manually edited clean
var wtlManual = false; // true when user has manually edited larder

function initWeightCalc() {
  var gEl = document.getElementById('f-wt-g');
  var cEl = document.getElementById('f-wt-c');
  var lEl = document.getElementById('f-wt-l');
  if (!gEl) return;

  // When gralloch changes → auto-fill clean and larder if not manually set
  gEl.addEventListener('input', function() {
    var g = parseFloat(this.value);
    if (isNaN(g) || g <= 0) {
      if (!wtcManual) { cEl.value = ''; showAutoBadge('c', false); }
      if (!wtlManual) { lEl.value = ''; showAutoBadge('l', false); }
      return;
    }
    if (!wtcManual) {
      cEl.value = (Math.round(g * 0.82 * 10) / 10).toFixed(1);
      showAutoBadge('c', true);
    }
    if (!wtlManual) {
      lEl.value = (Math.round(g * 0.75 * 10) / 10).toFixed(1);
      showAutoBadge('l', true);
    }
  });

  // When user manually edits clean → mark as manual, hide auto badge
  cEl.addEventListener('input', function() {
    if (document.activeElement === cEl) {
      wtcManual = true;
      showAutoBadge('c', false);
    }
  });

  // When user manually edits larder → mark as manual
  lEl.addEventListener('input', function() {
    if (document.activeElement === lEl) {
      wtlManual = true;
      showAutoBadge('l', false);
    }
  });
}

function showAutoBadge(field, show) {
  var badge = document.getElementById('wt-' + field + '-badge');
  if (badge) badge.style.display = show ? 'inline-flex' : 'none';
}

function resetWeightField(field) {
  // Reset a manually overridden field back to calculated value
  var g = parseFloat(document.getElementById('f-wt-g').value);
  if (isNaN(g) || g <= 0) return;
  if (field === 'c') {
    document.getElementById('f-wt-c').value = (Math.round(g * 0.82 * 10) / 10).toFixed(1);
    wtcManual = false;
    showAutoBadge('c', true);
  } else {
    document.getElementById('f-wt-l').value = (Math.round(g * 0.75 * 10) / 10).toFixed(1);
    wtlManual = false;
    showAutoBadge('l', true);
  }
}

function resetWeightAutoState() {
  // Call when opening a new or edit form to reset manual flags
  wtcManual = false;
  wtlManual = false;
  showAutoBadge('c', false);
  showAutoBadge('l', false);
}

// XSS sanitiser — escapes user data before innerHTML injection
function esc(s) {
  return (s === null || s === undefined) ? '' :
    String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
             .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
             .replace(/'/g,'&#x27;');
}

function renderList() {
  var entries = currentFilter === 'all' ? allEntries : allEntries.filter(function(e){ return e.species === currentFilter; });
  filteredEntries = entries;
  var container = document.getElementById('entries-container');

  // Stats
  var total = entries.length;
  var kg = entries.reduce(function(s,e){ return s + (parseFloat(e.weight_gralloch)||0); }, 0);
  var species_set = new Set(entries.map(function(e){ return e.species; }));
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-kg').textContent = Math.round(kg);
  document.getElementById('stat-spp').textContent = species_set.size;

  if (!total) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">No entries yet</div><div class="empty-sub">Tap + to record your first cull</div></div>';
    return;
  }

  // Group by month
  var months = {};
  entries.forEach(function(e) {
    var k = e.date.slice(0,7);
    if (!months[k]) months[k] = [];
    months[k].push(e);
  });

  var html = '';
  Object.keys(months).sort(function(a,b){ return b.localeCompare(a); }).forEach(function(ym) {
    var parts = ym.split('-');
    html += '<div class="month-lbl">' + FULL_MONTHS[parseInt(parts[1])-1] + ' ' + parts[0] + '</div>';
    html += '<div class="grid">';
    var group = months[ym];
    var i = 0;
    while (i < group.length) {
      var e = group[i];
      var spClass = SPECIES_CLASS[e.species] || 'sp-red';
      var sxClass = sexBadgeClass(e.sex, e.species);
      var sxLbl = sexLabel(e.sex, e.species);
      var safePhoto = safeUrl(e.photo_url);
      var hasPhoto = !!safePhoto;
      var imgHtml = hasPhoto
        ? '<img src="' + safePhoto + '" alt="" loading="lazy"><div class="gc-img-ov"></div>'
        : '<div class="no-photo-placeholder ' + spClass + '" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:32px;">🦌</div>';

      // Check if next entry also exists for potential wide layout (no-photo entries shown wide)
      var nextE = group[i+1];
      var showWide = !hasPhoto && (!nextE || !nextE.photo_url);
      if (showWide) {
        // Wide card
        html += '<div class="gc wide" onclick="openDetail(\'' + e.id + '\')">'
          + '<div class="gc-img ' + spClass + '" style="position:relative;">' + imgHtml
          + '<div class="gc-img-top"><span class="gc-sex ' + sxClass + '">' + sxLbl + '</span></div>'
          + '<div class="gc-img-bot"><div class="gc-species">' + e.species + '</div><div class="gc-date">' + fmtDate(e.date) + '</div></div>'
          + '</div>'
          + '<div class="gc-body"><div class="gc-meta">' + esc(e.location_name) + (e.calibre ? ' · ' + esc(e.calibre) : '') + '</div>'
          + '<div class="gc-foot"><span class="gc-kg">' + (e.weight_gralloch ? e.weight_gralloch + ' kg' : '–') + '</span></div></div></div>';
        i++;
      } else {
        // Normal card
        html += '<div class="gc" onclick="openDetail(\'' + e.id + '\')">'
          + '<div class="gc-img ' + spClass + '" style="position:relative;">' + imgHtml
          + '<div class="gc-img-top"><span class="gc-sex ' + sxClass + '">' + sxLbl + '</span>'
          + (hasPhoto ? '<div style="font-size:9px;color:rgba(255,255,255,0.7);background:rgba(0,0,0,0.35);border-radius:6px;padding:2px 6px;">📷</div>' : '')
          + '</div>'
          + '<div class="gc-img-bot"><div class="gc-species">' + e.species + '</div><div class="gc-date">' + fmtDate(e.date) + '</div></div>'
          + '</div>'
          + '<div class="gc-body"><div class="gc-meta">' + esc(e.location_name) + (e.calibre ? ' · ' + esc(e.calibre) : '') + '</div>'
          + '<div class="gc-foot"><span class="gc-kg">' + (e.weight_gralloch ? e.weight_gralloch + ' kg' : '–') + '</span>'
          + '<span class="gc-cal">' + esc(e.calibre) + '</span></div></div></div>';
        i++;
      }
    }
    html += '</div>';
  });

  container.innerHTML = html;
}

function filterEntries(filter, el) {
  currentFilter = filter;
  document.querySelectorAll('.filter-bar .fc').forEach(function(b){ b.classList.remove('on'); });
  el.classList.add('on');
  renderList();
}

// ════════════════════════════════════
// DETAIL
// ════════════════════════════════════
function openDetail(id) {
  currentEntry = allEntries.find(function(e){ return e.id === id; });
  if (!currentEntry) return;
  var e = currentEntry;
  var spClass = SPECIES_CLASS[e.species] || 'sp-red';
  var sxLbl = sexLabel(e.sex, e.species);
  var sxClass = sexBadgeClass(e.sex, e.species);

  var heroStyle = e.photo_url
    ? 'background:#0a0f07;'
    : 'background:linear-gradient(135deg,' + {'Red Deer':'#3a1a0a,#1a0a04','Roe Deer':'#0a2210,#050e04','Fallow':'#3a2208,#180e04','Sika':'#081830,#020810','Muntjac':'#1a0a2a,#0a0410','CWD':'#062018,#041010'}[e.species] + ');';

  var _safeHero = safeUrl(e.photo_url);
  var heroImg = _safeHero ? '<img src="' + _safeHero + '" alt="">' : '<div style="font-size:60px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);opacity:0.3;">🦌</div>';

  var syncTime = e.created_at ? new Date(e.created_at).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '';

  var html = '<div class="detail-hero ' + spClass + '" style="' + heroStyle + '">'
    + heroImg
    + '<div class="detail-hero-ov"></div>'
    + '<button class="detail-hero-back" onclick="go(\'v-list\')">←</button>'
    + '<div class="detail-hero-bot">'
    + '<div class="detail-species">' + e.species + ' ' + sxLbl + '</div>'
    + '<div class="detail-chips">'
    + '<span class="dchip ' + (e.sex === 'm' ? 'dc-m' : 'dc-m" style="background:rgba(136,14,79,0.3);color:#f8bbd9;border-color:rgba(136,14,79,0.4)') + '">' + (e.sex === 'm' ? '♂' : '♀') + ' ' + esc(sxLbl) + (e.age_class ? ' · ' + esc(e.age_class) : '') + '</span>'
    + (e.location_name ? '<span class="dchip dc-l">📍 ' + esc(e.location_name) + '</span>' : '')
    + (e.weight_gralloch ? '<span class="dchip dc-w">' + e.weight_gralloch + ' kg gralloch</span>' : '')
    + '</div>'
    + '<div class="sync-row"><div class="sync-dot"></div><span class="sync-txt">Synced' + (syncTime ? ' · ' + syncTime : '') + '</span></div>'
    + '</div></div>'

    // Photo section
    + '<div class="photo-sec"><div class="photo-sec-lbl">Photo</div><div class="photo-thumb-row">'
    + (safeUrl(e.photo_url)
        ? '<div style="display:flex;flex-direction:column;align-items:flex-start;gap:8px;"><div class="photo-thumb" onclick="openPhotoLightbox(\'' + safeUrl(e.photo_url) + '\')" style="cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,0.15);" title="Tap to view full size"><img src="' + safeUrl(e.photo_url) + '" alt=""></div><div style="font-size:10px;color:#a0988a;">Tap to expand</div></div>'
        : '<div class="photo-thumb no-photo-placeholder">\U0001f98c</div>')
    + '<button class="photo-change-btn" onclick="openEditEntry(\'' + e.id + '\')">\u270f\ufe0f Edit entry</button>'
    + '</div></div>'

    // Stats
    + '<div class="dstat-grid">'
    + '<div class="dstat"><div class="dstat-l">Date</div><div class="dstat-v" style="font-size:13px;">' + fmtDate(e.date) + '</div></div>'
    + '<div class="dstat"><div class="dstat-l">Time</div><div class="dstat-v">' + (e.time||'–') + '</div></div>'
    + '<div class="dstat"><div class="dstat-l">Distance</div><div class="dstat-v">' + (e.distance_m||'–') + (e.distance_m ? '<span class="dstat-u">m</span>' : '') + '</div></div>'
    + '<div class="dstat"><div class="dstat-l">Gralloch</div><div class="dstat-v">' + (e.weight_gralloch||'–') + (e.weight_gralloch ? '<span class="dstat-u">kg</span>' : '') + '</div></div>'
    + '<div class="dstat"><div class="dstat-l">Clean wt</div><div class="dstat-v">' + (e.weight_clean||'–') + (e.weight_clean ? '<span class="dstat-u">kg</span>' : '') + '</div></div>'
    + '<div class="dstat"><div class="dstat-l">Larder</div><div class="dstat-v">' + (e.weight_larder||'–') + (e.weight_larder ? '<span class="dstat-u">kg</span>' : '') + '</div></div>'
    + '</div>'

    + (e.calibre || e.shot_placement ? '<div class="dsec"><div class="dsec-l">Shot details</div><div class="dsec-t">'
      + (e.calibre ? 'Calibre: ' + esc(e.calibre) + (e.distance_m ? ' · ' + e.distance_m + 'm' : '') + '<br>' : '')
      + (e.shot_placement ? 'Placement: ' + esc(e.shot_placement) : '')
      + '</div></div>' : '')
    + (e.notes ? '<div class="dsec"><div class="dsec-l">Notes</div><div class="dsec-t">' + esc(e.notes) + '</div></div>' : '')
    + (e.shooter && e.shooter !== 'Self' ? '<div class="dsec"><div class="dsec-l">Shooter</div><div class="dsec-t">' + esc(e.shooter) + '</div></div>' : '')
    + (e.destination ? '<div class="dsec"><div class="dsec-l">Carcass destination</div><div class="dsec-t">' + esc(e.destination) + '</div></div>' : '')
    + (e.ground ? '<div class="dsec"><div class="dsec-l">Ground</div><div class="dsec-t">' + esc(e.ground) + '</div></div>' : '')
    + (e.location_name ? '<div class="dsec"><div class="dsec-l">Location</div><div class="dsec-t">' + esc(e.location_name) + '</div></div>' : '')

    + renderWeatherStrip(e)

    + '<div class="action-row">'
    + '<button class="abtn a-e" onclick="openEditEntry(\'' + e.id + '\')">✏️ Edit</button>'
    + '<button class="abtn a-x" onclick="exportSinglePDF(\'' + e.id + '\')">📄 PDF</button>'
    + '<button class="abtn a-d" onclick="deleteEntry(\'' + e.id + '\')">🗑 Delete</button>'
    + '</div>';

  document.getElementById('detail-content').innerHTML = html;
  go('v-detail');
}

// ════════════════════════════════════
// FORM
// ════════════════════════════════════
function openNewEntry() {
  formDirty = false;
  editingId = null;
  photoFile = null;
  photoPreviewUrl = null;
  formSpecies = '';
  formSex = '';
  resetPhotoSlot();
  document.querySelectorAll('.sp-btn').forEach(function(b){ b.classList.remove('on'); });
  document.getElementById('sx-m').classList.remove('on');
  document.getElementById('sx-f').classList.remove('on');
  var now = new Date();
  // Use UK time for date/time pre-fill — toISOString() returns UTC which can be wrong date/time
  var _ukParts = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Europe/London', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(now);
  var _get = function(t){ return _ukParts.find(function(p){ return p.type===t; }).value; };
  document.getElementById('f-date').value = _get('year') + '-' + _get('month') + '-' + _get('day');
  document.getElementById('f-time').value = _get('hour') + ':' + _get('minute');
  ['f-location','f-dist','f-notes'].forEach(function(id){ document.getElementById(id).value = ''; }); setCalibreValue('');
  var shooterEl = document.getElementById('f-shooter');
  if (shooterEl) { shooterEl.value = 'Self'; shooterEl.classList.add('shooter-self'); }
  var destEl = document.getElementById('f-destination');
  if (destEl) destEl.value = '';
  var groundEl = document.getElementById('f-ground');
  if (groundEl) { groundEl.value = ''; }
  var groundCustom = document.getElementById('f-ground-custom');
  if (groundCustom) { groundCustom.value = ''; groundCustom.style.display = 'none'; }
  populateGroundDropdown();
  document.getElementById('f-wt-g').value = '';
  document.getElementById('f-wt-c').value = '';
  document.getElementById('f-wt-l').value = '';
  resetWeightAutoState();
  clearPinnedLocation();
  setPlacementValue('');
  document.getElementById('f-age').value = '';
  document.getElementById('form-title').textContent = 'New Entry';
  var _days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var _ukDate = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Europe/London', weekday:'short', day:'numeric', month:'long', year:'numeric'
  }).formatToParts(now);
  var _gp = function(t){ var p=_ukDate.find(function(x){return x.type===t;}); return p?p.value:''; };
  document.getElementById('form-date-label').textContent = _gp('weekday') + ' ' + _gp('day') + ' ' + _gp('month') + ' ' + _gp('year');
  go('v-form');
}

function openEditEntry(id) {
  formDirty = false;
  var e = allEntries.find(function(x){ return x.id === id; });
  if (!e) return;
  editingId = id;
  formSpecies = e.species;
  formSex = e.sex;
  photoFile = null;
  photoPreviewUrl = safeUrl(e.photo_url) || null;
  // Set photo slot
  if (photoPreviewUrl) {
    var slot = document.getElementById('photo-slot');
    slot.className = 'photo-slot filled';
    slot.innerHTML = '<img src="' + photoPreviewUrl + '" alt=""><button class="photo-slot-rm" onclick="removePhoto()">✕</button>';
    document.getElementById('photo-rm-btn').style.display = 'block';
  } else {
    resetPhotoSlot();
  }
  // Species
  document.querySelectorAll('.sp-btn').forEach(function(b){ b.classList.toggle('on', b.querySelector('.sp-name').textContent === e.species); });
  // Sex
  document.getElementById('sx-m').classList.toggle('on', e.sex === 'm');
  document.getElementById('sx-f').classList.toggle('on', e.sex === 'f');
  document.getElementById('f-date').value = e.date || '';
  document.getElementById('f-time').value = e.time || '';
  document.getElementById('f-location').value = e.location_name || '';
  if (e.lat && e.lng) {
    formPinLat = e.lat; formPinLng = e.lng;
    showPinnedStrip(e.location_name || (e.lat.toFixed(4) + ', ' + e.lng.toFixed(4)), e.lat, e.lng);
  } else {
    clearPinnedLocation();
  }
  document.getElementById('f-wt-g').value = e.weight_gralloch || '';
  document.getElementById('f-wt-c').value = e.weight_clean || '';
  document.getElementById('f-wt-l').value = e.weight_larder || '';
  // On edit, treat existing clean/larder as manually entered (don't auto-overwrite)
  resetWeightAutoState();
  if (e.weight_gralloch && e.weight_clean)  { wtcManual = true; }
  if (e.weight_gralloch && e.weight_larder) { wtlManual = true; }
  setCalibreValue(e.calibre || '');
  document.getElementById('f-dist').value = e.distance_m || '';
  setPlacementValue(e.shot_placement || '');
  document.getElementById('f-age').value = e.age_class || '';
  document.getElementById('f-notes').value = e.notes || '';
  var sEl = document.getElementById('f-shooter');
  if (sEl) {
    sEl.value = e.shooter || 'Self';
    sEl.classList.toggle('shooter-self', !e.shooter || e.shooter === 'Self');
  }
  var destEl = document.getElementById('f-destination');
  if (destEl) destEl.value = e.destination || '';
  populateGroundDropdown();
  setGroundValue(e.ground || '');
  document.getElementById('form-title').textContent = 'Edit Entry';
  document.getElementById('form-date-label').textContent = fmtDate(e.date);
  go('v-form');
}

function pickSpecies(el, name) {
  document.querySelectorAll('.sp-btn').forEach(function(b){ b.classList.remove('on'); });
  el.classList.add('on');
  formSpecies = name;
  formDirty = true;
}
function pickSex(s) {
  formSex = s;
  document.getElementById('sx-m').classList.toggle('on', s === 'm');
  document.getElementById('sx-f').classList.toggle('on', s === 'f');
  formDirty = true;
}

function handlePhoto(input) {
  var file = input.files[0];
  if (!file) return;
  input.value = '';

  // Compress image via canvas before storing
  var reader = new FileReader();
  reader.onload = function(ev) {
    var img = new Image();
    img.onload = function() {
      // Target max 800px on longest side, JPEG quality 0.75
      var MAX = 800;
      var w = img.width;
      var h = img.height;
      if (w > h) { if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; } }
      else        { if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; } }

      var canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob(function(blob) {
        // Convert compressed blob back to file
        photoFile = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
        photoPreviewUrl = canvas.toDataURL('image/jpeg', 0.75);

        var slot = document.getElementById('photo-slot');
        slot.className = 'photo-slot filled';
        slot.innerHTML = '<img src="' + photoPreviewUrl + '" alt=""><button class="photo-slot-rm" onclick="removePhoto()">✕</button>';
        document.getElementById('photo-rm-btn').style.display = 'block';

        // Show compressed size as feedback
        var kb = Math.round(photoFile.size / 1024);
        showToast('📷 Photo ready · ' + kb + ' KB');
      }, 'image/jpeg', 0.75);
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function removePhoto() {
  photoFile = null;
  photoPreviewUrl = null;
  resetPhotoSlot();
}

function resetPhotoSlot() {
  var slot = document.getElementById('photo-slot');
  slot.className = 'photo-slot empty';
  slot.innerHTML = '<div class="photo-slot-icon">🦌</div><div class="photo-slot-lbl">No photo</div>';
  document.getElementById('photo-rm-btn').style.display = 'none';
}

var lastGpsLat = null, lastGpsLng = null;


function handleCalibreSelect(sel) {
  var custom = document.getElementById('f-calibre');
  if (sel.value === '__custom__') {
    custom.style.display = 'block';
    custom.value = '';
    custom.focus();
    sel.classList.add('has-val');
  } else {
    custom.style.display = 'none';
    custom.value = sel.value;
    sel.classList.toggle('has-val', sel.value !== '');
  }
}

function getCalibreValue() {
  var sel = document.getElementById('f-calibre-sel');
  var custom = document.getElementById('f-calibre');
  if (sel && sel.value === '__custom__') return custom.value.trim();
  if (sel && sel.value && sel.value !== '') return sel.value;
  return custom ? custom.value.trim() : '';
}

function setCalibreValue(val) {
  var sel = document.getElementById('f-calibre-sel');
  var custom = document.getElementById('f-calibre');
  if (!val) { 
    if (sel) sel.value = ''; 
    if (custom) { custom.value = ''; custom.style.display = 'none'; }
    return; 
  }
  // Check if val matches a dropdown option
  var matched = false;
  if (sel) {
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === val) { sel.value = val; matched = true; break; }
    }
  }
  if (!matched) {
    // Use custom
    if (sel) sel.value = '__custom__';
    if (custom) { custom.value = val; custom.style.display = 'block'; }
  } else {
    if (custom) { custom.value = val; custom.style.display = 'none'; }
  }
}

function handlePlacementSelect(sel) {
  var custom = document.getElementById('f-placement-custom');
  if (sel.value === '__other__') {
    custom.style.display = 'block';
    sel.classList.add('has-val');
    custom.focus();
  } else {
    custom.style.display = 'none';
    custom.value = '';
    sel.classList.toggle('has-val', !!sel.value);
  }
}

function getPlacementValue() {
  var sel = document.getElementById('f-placement');
  if (sel.value === '__other__') {
    return document.getElementById('f-placement-custom').value.trim() || '';
  }
  return sel.value;
}

function setPlacementValue(val) {
  var sel = document.getElementById('f-placement');
  var custom = document.getElementById('f-placement-custom');
  // Check if val matches a known option
  var known = ['Heart / Lung','High Shoulder','Neck','Head','Spine','Shoulder','Abdomen','Haunch'];
  if (!val) {
    sel.value = '';
    sel.classList.remove('has-val');
    custom.style.display = 'none';
    custom.value = '';
  } else if (known.indexOf(val) !== -1) {
    sel.value = val;
    sel.classList.add('has-val');
    custom.style.display = 'none';
    custom.value = '';
  } else {
    sel.value = '__other__';
    sel.classList.add('has-val');
    custom.style.display = 'block';
    custom.value = val;
  }
} // stored for weather fetch

function getGPS() {
  if (!navigator.geolocation) { showToast('GPS not available'); return; }
  showToast('📍 Getting location…');
  navigator.geolocation.getCurrentPosition(function(pos) {
    var lat = pos.coords.latitude.toFixed(4);
    var lng = pos.coords.longitude.toFixed(4);
    lastGpsLat = parseFloat(lat); lastGpsLng = parseFloat(lng);
    formPinLat = parseFloat(lat); formPinLng = parseFloat(lng);
    fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json')
      .then(function(r){ return r.json(); })
      .then(function(d) {
        var a = d.address || {};
        var name = a.village || a.town || a.city || a.county || (lat + ', ' + lng);
        document.getElementById('f-location').value = name;
        showPinnedStrip(name, parseFloat(lat), parseFloat(lng));
        showToast('📍 ' + name);
      }).catch(function() {
        document.getElementById('f-location').value = lat + ', ' + lng;
        showPinnedStrip(lat + ', ' + lng, parseFloat(lat), parseFloat(lng));
      });
  }, function() { showToast('Could not get location'); });
}

async function saveEntry() {
  if (!formSpecies) { showToast('⚠️ Please select a species'); return; }
  if (!formSex)     { showToast('⚠️ Please select sex'); return; }
  if (!sb)          { showToast('⚠️ Supabase not configured'); return; }
  var btn = document.getElementById('save-btn');
  btn.disabled = true;
  btn.textContent = '☁️ Saving…';

  // ── Offline check — queue locally if no connection ──
  if (!navigator.onLine && !editingId) {
    var offlinePayload = {
      species:         formSpecies,
      sex:             formSex,
      date:            document.getElementById('f-date').value,
      time:            document.getElementById('f-time').value,
      location_name:   document.getElementById('f-location').value,
      lat:             formPinLat || lastGpsLat || null,
      lng:             formPinLng || lastGpsLng || null,
      weight_gralloch: Math.max(0, parseFloat(document.getElementById('f-wt-g').value)) || null,
      weight_clean:    Math.max(0, parseFloat(document.getElementById('f-wt-c').value)) || null,
      weight_larder:   Math.max(0, parseFloat(document.getElementById('f-wt-l').value)) || null,
      calibre:         getCalibreValue(),
      distance_m:      Math.max(0, parseInt(document.getElementById('f-dist').value)) || null,
      shot_placement:  getPlacementValue(),
      age_class:       document.getElementById('f-age').value,
      notes:           document.getElementById('f-notes').value,
      shooter:         document.getElementById('f-shooter').value.trim() || 'Self',
      ground:          getGroundValue(),
      destination:     document.getElementById('f-destination').value || null,
      // Store photo as base64 dataURL for offline queue
      _photoDataUrl:   (photoFile && photoPreviewUrl && !photoPreviewUrl.startsWith('http')) ? photoPreviewUrl : null,
      _existingPhotoUrl: (photoPreviewUrl && photoPreviewUrl.startsWith('http')) ? photoPreviewUrl : null,
    };
    queueOfflineEntry(offlinePayload);
    formDirty = false;
    btn.disabled = false;
    btn.innerHTML = '☁️ Save to Cloud';
    return;
  }

  try {
    var payload = {
      user_id:         currentUser.id,
      species:         formSpecies,
      sex:             formSex,
      date:            document.getElementById('f-date').value,
      time:            document.getElementById('f-time').value,
      location_name:   document.getElementById('f-location').value,
      lat:             formPinLat || lastGpsLat || null,
      lng:             formPinLng || lastGpsLng || null,
      weight_gralloch: Math.max(0, parseFloat(document.getElementById('f-wt-g').value)) || null,
      weight_clean:    Math.max(0, parseFloat(document.getElementById('f-wt-c').value)) || null,
      weight_larder:   Math.max(0, parseFloat(document.getElementById('f-wt-l').value)) || null,
      calibre:         getCalibreValue(),
      distance_m:      Math.max(0, parseInt(document.getElementById('f-dist').value)) || null,
      shot_placement:  getPlacementValue(),
      age_class:       document.getElementById('f-age').value,
      notes:           document.getElementById('f-notes').value,
      shooter:         document.getElementById('f-shooter').value.trim() || 'Self',
      ground:          getGroundValue(),
      destination:     document.getElementById('f-destination').value || null,
    };
    if (photoFile) {
      try {
        var path = currentUser.id + '/' + Date.now() + '.jpg';
        var upload = await sb.storage.from('cull-photos').upload(path, photoFile, {
          upsert: true,
          contentType: 'image/jpeg'
        });
        if (upload.error) {
          console.error('Photo upload error:', upload.error);
          showToast('⚠️ Photo upload failed: ' + (upload.error.message || 'Check storage policies'));
        } else {
          var url = sb.storage.from('cull-photos').getPublicUrl(path);
          payload.photo_url = url.data.publicUrl;
          showToast('📷 Photo uploaded');
        }
      } catch(uploadErr) {
        showToast('⚠️ Photo upload error — entry saved without photo');
        console.error('Upload exception:', uploadErr);
      }
    } else if (photoPreviewUrl && /^https:\/\/[^\s]+/.test(photoPreviewUrl)) {
      payload.photo_url = photoPreviewUrl; // keep existing — validated as https URL
    } else if (!photoPreviewUrl) {
      payload.photo_url = null; // removed
    }

    var result;
    if (editingId) {
      result = await sb.from('cull_entries').update(payload).eq('id', editingId);
    } else {
      result = await sb.from('cull_entries').insert(payload);
    }
    if (result.error) throw result.error;

    showToast(editingId ? '✅ Entry updated' : '✅ Entry saved');
    formDirty = false;
    // Save new ground name if not already in list
    var gVal = getGroundValue();
    if (gVal) saveGround(gVal);
    await loadEntries();
    go('v-list');

    // Silently fetch and attach weather in background (last 7 days only)
    var savedId = editingId || (result.data && result.data[0] && result.data[0].id);
    if (!savedId && result.data) {
      // Re-fetch to get the new entry id
      var fresh = await sb.from('cull_entries')
        .select('id').eq('user_id', currentUser.id)
        .order('created_at', { ascending: false }).limit(1);
      if (fresh.data && fresh.data[0]) savedId = fresh.data[0].id;
    }
    if (savedId && payload.date) {
      // Use GPS coords if available, else try parsing from location field
      var wxLat = lastGpsLat || (qsLat ? parseFloat(qsLat) : null);
      var wxLng = lastGpsLng || (qsLng ? parseFloat(qsLng) : null);
      if (!wxLat && payload.location_name) {
        var coordMatch = payload.location_name.match(/^(-?[\d.]+),\s*(-?[\d.]+)$/);
        if (coordMatch) { wxLat = parseFloat(coordMatch[1]); wxLng = parseFloat(coordMatch[2]); }
      }
      // Use bannerState lat/lng as last resort (index.html shares none — skip)
      if (wxLat && wxLng) {
        attachWeatherToEntry(savedId, payload.date, payload.time, wxLat, wxLng);
      }
    }
  } catch(e) {
    showToast('⚠️ Save failed: ' + (e.message || 'Unknown error'));
  }
  btn.disabled = false;
  btn.innerHTML = '☁️ Save to Cloud';
}

async function deleteEntry(id) {
  if (!confirm('Delete this entry? This cannot be undone.')) return;
  var entry = allEntries.find(function(e){ return e.id === id; });

  // Delete photo from storage first if it exists
  if (entry && entry.photo_url && sb) {
    try {
      // Extract path from URL: everything after /object/public/cull-photos/
      var match = entry.photo_url.match(/cull-photos\/(.+)$/);
      if (match) {
        await sb.storage.from('cull-photos').remove([match[1]]);
      }
    } catch(e) { /* non-fatal */ }
  }

  var r = await sb.from('cull_entries').delete().eq('id', id);
  if (!r.error) {
    showToast('🗑 Entry deleted');
    await loadEntries();
    go('v-list');
  } else { showToast('⚠️ Could not delete'); }
}

// ════════════════════════════════════
// STATS
// ════════════════════════════════════
function buildStats(speciesFilter) {
  // Sync stats season pill with list season dropdown
  var statsSel = document.getElementById('season-select-stats');
  var listSel  = document.getElementById('season-select');
  if (statsSel && listSel) {
    statsSel.innerHTML = listSel.innerHTML;
    statsSel.value = currentSeason;
  }
  // Load targets for current season then render plan card
  Promise.all([loadTargets(currentSeason), loadGroundTargets(currentSeason)]).then(function() {
    loadPrevTargets(currentSeason);
    renderPlanGroundFilter();
    renderPlanCard(allEntries, currentSeason);
  });
  // Update season label to match currently selected season
  var d = seasonDates(currentSeason);
  var parts = currentSeason.split('-');
  var y1 = parts[0];
  var y2 = parts[1].length === 2 ? '20' + parts[1] : parts[1];
  var startDate = new Date(d.start);
  var endDate = new Date(d.end);
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var seasonDateStr = months[startDate.getMonth()] + ' ' + startDate.getFullYear()
    + ' – ' + months[endDate.getMonth()] + ' ' + endDate.getFullYear();
  document.getElementById('stats-season-lbl').textContent = y1 + '–' + y2 + ' · ' + seasonDateStr;

  var entries = speciesFilter ? allEntries.filter(function(e){ return e.species === speciesFilter; }) : allEntries;
  var total = entries.length;
  var kg = entries.reduce(function(s,e){ return s + (parseFloat(e.weight_gralloch)||0); }, 0);
  var avg = total ? Math.round(kg/total) : 0;
  var maxE = entries.reduce(function(m,e){ return (parseFloat(e.weight_gralloch)||0) > (parseFloat(m.weight_gralloch)||0) ? e : m; }, {});
  document.getElementById('st-total').textContent = total;
  document.getElementById('st-kg').textContent = Math.round(kg);
  document.getElementById('st-avg').textContent = avg || '–';
  document.getElementById('st-max').textContent = maxE.weight_gralloch || '–';
  document.getElementById('st-max-lbl').textContent = maxE.weight_gralloch ? 'kg · ' + maxE.species + ' ' + (maxE.date||'').slice(0,7) : 'kg';

  // Species chart with sex breakdown
  var spCount = {}, spMale = {}, spFemale = {};
  entries.forEach(function(e){
    spCount[e.species]  = (spCount[e.species]||0)+1;
    if (e.sex==='m') spMale[e.species]   = (spMale[e.species]||0)+1;
    else             spFemale[e.species] = (spFemale[e.species]||0)+1;
  });
  var spMax = Math.max.apply(null, Object.values(spCount).concat([1]));
  var spColors = {'Red Deer':'#c8a84b','Roe Deer':'#5a7a30','Fallow':'#f57f17','Sika':'#1565c0','Muntjac':'#6a1b9a','CWD':'#00695c'};
  var spMaleLabels = {'Red Deer':'Stag','Roe Deer':'Buck','Fallow':'Buck','Sika':'Stag','Muntjac':'Buck','CWD':'Buck'};
  var spFemLabels  = {'Red Deer':'Hind','Roe Deer':'Doe','Fallow':'Doe','Sika':'Hind','Muntjac':'Doe','CWD':'Doe'};
  var spHtml = Object.keys(spCount).sort(function(a,b){ return spCount[b]-spCount[a]; }).map(function(sp) {
    var clr = spColors[sp]||'#5a7a30';
    var mCnt = spMale[sp]||0, fCnt = spFemale[sp]||0;
    var mLbl = spMaleLabels[sp]||'Male', fLbl = spFemLabels[sp]||'Female';
    var html = '<div class="bar-row" style="margin-bottom:4px;">'
      + '<div class="bar-lbl" style="font-size:12px;font-weight:700;">' + sp + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:' + (spCount[sp]/spMax*100) + '%;background:' + clr + ';"></div></div>'
      + '<div class="bar-cnt">' + spCount[sp] + '</div></div>';
    // Sex sub-rows
    if (mCnt > 0) html += '<div class="bar-row" style="padding-left:12px;margin-bottom:3px;">'
      + '<div class="bar-lbl" style="font-size:10px;color:var(--muted);">♂ ' + mLbl + '</div>'
      + '<div class="bar-track" style="height:4px;"><div class="bar-fill" style="width:' + (mCnt/spCount[sp]*100) + '%;background:rgba(191,54,12,0.55);"></div></div>'
      + '<div class="bar-cnt" style="font-size:10px;color:var(--muted);">' + mCnt + '</div></div>';
    if (fCnt > 0) html += '<div class="bar-row" style="padding-left:12px;margin-bottom:8px;">'
      + '<div class="bar-lbl" style="font-size:10px;color:var(--muted);">♀ ' + fLbl + '</div>'
      + '<div class="bar-track" style="height:4px;"><div class="bar-fill" style="width:' + (fCnt/spCount[sp]*100) + '%;background:rgba(136,14,79,0.55);"></div></div>'
      + '<div class="bar-cnt" style="font-size:10px;color:var(--muted);">' + fCnt + '</div></div>';
    return html;
  }).join('');
  document.getElementById('species-chart').innerHTML = spHtml || '<div style="font-size:12px;color:#aaa;">No data</div>';

  // Sex chart
  var mCount = entries.filter(function(e){ return e.sex === 'm'; }).length;
  var fCount = entries.filter(function(e){ return e.sex === 'f'; }).length;
  var sexMax = Math.max(mCount, fCount, 1);
  document.getElementById('sex-chart').innerHTML =
    '<div class="bar-row"><div class="bar-lbl">♂ Male</div><div class="bar-track"><div class="bar-fill" style="width:' + (mCount/sexMax*100) + '%;background:rgba(191,54,12,0.75);"></div></div><div class="bar-cnt">' + mCount + '</div></div>' +
    '<div class="bar-row"><div class="bar-lbl">♀ Female</div><div class="bar-track"><div class="bar-fill" style="width:' + (fCount/sexMax*100) + '%;background:rgba(136,14,79,0.75);"></div></div><div class="bar-cnt">' + fCount + '</div></div>';

  // Calibre, distance, age & ground stats
  buildCalibreDistanceStats(entries);
  buildAgeStats(entries);
  buildShooterStats(entries);
  buildDestinationStats(entries);
  buildGroundStats(entries);

  // Cull map (after DOM paint)
  setTimeout(function() {
    initCullMap();
    renderCullMapPins();
    var sub = document.getElementById('cullmap-sub');
    if (sub) sub.textContent = 'Location history · ' + currentSeason;
  }, 150);

  // Monthly chart
  var mCount2 = {};
  entries.forEach(function(e){ if(e.date){ var m=parseInt(e.date.split('-')[1]); mCount2[m]=(mCount2[m]||0)+1; } });
  var mMax = Math.max.apply(null, Object.values(mCount2).concat([1]));
  var seasonMonths = [8,9,10,11,12,1,2,3,4,5,6,7];
  var mHtml = seasonMonths.map(function(m) {
    var cnt = mCount2[m]||0;
    var h = cnt ? Math.max(6, Math.round(cnt/mMax*60)) : 3;
    var cls = cnt ? (cnt === Math.max.apply(null, Object.values(mCount2)) ? 'mc-bar pk' : 'mc-bar on') : 'mc-bar';
    return '<div class="mc-col"><div class="' + cls + '" style="height:' + h + 'px;' + (cnt ? '' : 'opacity:0.4;') + '"></div><div class="mc-lbl">' + MONTH_NAMES[m-1] + '</div></div>';
  }).join('');
  document.getElementById('month-chart').innerHTML = mHtml;
}

// ════════════════════════════════════
// EXPORT
// ════════════════════════════════════
// ════════════════════════════════════
// DELETE ACCOUNT
// ════════════════════════════════════
function confirmDeleteAccount() {
  document.getElementById('delete-confirm-input').value = '';
  document.getElementById('delete-confirm-btn').disabled = true;
  document.getElementById('delete-confirm-btn').style.background = '#e8e8e8';
  document.getElementById('delete-confirm-btn').style.color = '#aaa';
  document.getElementById('delete-confirm-btn').style.cursor = 'not-allowed';
  document.getElementById('delete-account-modal').style.display = 'flex';
}

function closeDeleteModal() {
  document.getElementById('delete-account-modal').style.display = 'none';
}

function checkDeleteInput() {
  var val = document.getElementById('delete-confirm-input').value;
  var btn = document.getElementById('delete-confirm-btn');
  var ready = val === 'DELETE';
  btn.disabled = !ready;
  btn.style.background = ready ? '#c62828' : '#e8e8e8';
  btn.style.color = ready ? 'white' : '#aaa';
  btn.style.cursor = ready ? 'pointer' : 'not-allowed';
}

async function deleteAccount() {
  if (!sb || !currentUser) return;
  var btn = document.getElementById('delete-confirm-btn');
  btn.textContent = 'Deleting…';
  btn.disabled = true;

  try {
    // 1. Delete all photos from storage
    showToast('🗑 Deleting photos…');
    var photos = await sb.from('cull_entries')
      .select('photo_url')
      .eq('user_id', currentUser.id)
      .not('photo_url', 'is', null);

    if (photos.data && photos.data.length > 0) {
      var paths = photos.data
        .filter(function(e) { return e.photo_url; })
        .map(function(e) {
          var match = e.photo_url.match(/cull-photos\/(.+)$/);
          return match ? match[1] : null;
        })
        .filter(Boolean);
      if (paths.length > 0) {
        await sb.storage.from('cull-photos').remove(paths);
      }
    }

    // 2. Delete all entries
    showToast('🗑 Deleting records…');
    await sb.from('cull_entries').delete().eq('user_id', currentUser.id);

    // 3. Delete the auth account via custom RPC
    // Requires 'delete_user' function in Supabase (calls auth.users delete internally)
    showToast('🗑 Deleting account…');
    var rpcResult = await sb.rpc('delete_user');
    if (rpcResult.error) {
      // RPC may not exist — sign out and inform user to contact support
      await sb.auth.signOut();
      showToast('⚠️ Entries deleted. Contact support to remove auth account.');
      setTimeout(function() { go('v-auth'); }, 3000);
      return;
    }

    // 4. Sign out and redirect
    await sb.auth.signOut();
    closeDeleteModal();
    showToast('✅ Account deleted. Goodbye.');
    setTimeout(function() { go('v-auth'); }, 2000);

  } catch(e) {
    // Fallback — sign out even if delete fails
    showToast('⚠️ ' + (e.message || 'Could not fully delete. Contact support.'));
    btn.textContent = 'Delete everything';
    btn.disabled = false;
  }
}
var exportFormat = 'csv';

async function openExportModal(format) {
  exportFormat = format;
  document.getElementById('export-modal-title').textContent = format === 'csv' ? 'Export CSV' : 'Export PDF';
  document.getElementById('export-season-lbl').textContent = seasonLabel(currentSeason);
  document.getElementById('export-season-count').textContent = allEntries.length + ' entries';

  // Fetch total all-entries count
  if (sb && currentUser) {
    try {
      var all = await sb.from('cull_entries').select('id', { count: 'exact' }).eq('user_id', currentUser.id);
      var total = all.count || 0;
      document.getElementById('export-all-count').textContent = total + ' entries across all seasons';
    } catch(e) {
      document.getElementById('export-all-count').textContent = '– entries across all seasons';
    }
  }

  var modal = document.getElementById('export-modal');
  modal.style.display = 'flex';
}

function closeExportModal() {
  document.getElementById('export-modal').style.display = 'none';
}

async function doExport(scope) {
  closeExportModal();
  if (scope === 'season') {
    if (exportFormat === 'csv') exportCSV();
    else exportPDF();
  } else {
    // Fetch ALL entries across all seasons
    showToast('⏳ Fetching all entries…');
    try {
      var r = await sb.from('cull_entries')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('date', { ascending: false });
      if (r.error || !r.data.length) { showToast('⚠️ No entries found'); return; }
      var allData = r.data;
      if (exportFormat === 'csv') exportCSVData(allData, 'all-seasons');
      else exportPDFData(allData, 'All Seasons');
    } catch(e) {
      showToast('⚠️ Export failed — ' + (e.message || 'network error'));
    }
  }
}

function exportCSV() {
  if (!allEntries.length) { showToast('⚠️ No entries to export'); return; }
  exportCSVData(allEntries, currentSeason);
}

function exportCSVData(entries, label) {
  var headers = ['Date','Time','Species','Sex','Location','Ground','Gralloch(kg)','Clean(kg)','Larder(kg)','Calibre','Distance(m)','Placement','Age class','Shooter','Destination','Notes'];
  function csvField(v) {
    // Properly quote CSV fields — handles commas, newlines, and quotes
    var s = v === null || v === undefined ? '' : String(v);
    return '"' + s.replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, '') + '"';
  }
  var rows = entries.map(function(e) {
    return [
      csvField(e.date), csvField(e.time), csvField(e.species),
      csvField(e.sex === 'm' ? 'Male' : 'Female'), csvField(e.location_name), csvField(e.ground||''),
      csvField(e.weight_gralloch), csvField(e.weight_clean), csvField(e.weight_larder),
      csvField(e.calibre), csvField(e.distance_m), csvField(e.shot_placement),
      csvField(e.age_class), csvField(e.shooter||'Self'), csvField(e.destination||''), csvField(e.notes)
    ].join(',');
  });
  var csv = [headers.join(',')].concat(rows).join('\n');
  var blob = new Blob([csv], {type:'text/csv'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cull-diary-' + label + '.csv';
  a.click();
  showToast('✅ CSV downloaded — ' + entries.length + ' entries');
}

function exportPDF() {
  if (!allEntries.length) { showToast('⚠️ No entries to export'); return; }
  exportPDFData(allEntries, seasonLabel(currentSeason));
}

function exportPDFData(entries, label) {
  // Simple list export (used for all-seasons or fallback)
  var doc = new jspdf.jsPDF();
  doc.setFontSize(18);
  doc.text('Cull Diary - ' + label, 14, 20);
  doc.setFontSize(10);
  doc.text('First Light · firstlightdeer.co.uk · ' + entries.length + ' entries', 14, 28);
  var y = 38;
  entries.forEach(function(e, i) {
    if (y > 270) { doc.addPage(); y = 20; }
    doc.setFontSize(12);
    doc.text((i+1) + '. ' + e.species + ' (' + (e.sex==='m'?'Male':'Female') + ') - ' + e.date, 14, y);
    y += 6;
    doc.setFontSize(9);
    var meta = [];
    if (e.location_name) meta.push('Location: ' + e.location_name);
    if (e.weight_gralloch) meta.push('Gralloch: ' + e.weight_gralloch + 'kg');
    if (e.calibre) meta.push('Calibre: ' + e.calibre);
    if (e.distance_m) meta.push('Distance: ' + e.distance_m + 'm');
    if (e.shot_placement) meta.push('Placement: ' + e.shot_placement);
    if (e.destination) meta.push('Destination: ' + e.destination);
    if (meta.length) { doc.text(meta.join(' · '), 14, y); y += 5; }
    if (e.notes) {
      var noteLines = doc.splitTextToSize('Notes: ' + e.notes, 180);
      noteLines.forEach(function(line) {
        if (y > 270) { doc.addPage(); y = 20; }
        doc.text(line, 14, y); y += 4;
      });
      y += 1;
    }
    y += 4;
    doc.line(14, y, 196, y); y += 5;
  });
  var filename = label === 'All Seasons' ? 'cull-diary-all-seasons' : 'cull-diary-' + currentSeason;
  doc.save(filename + '.pdf');
  showToast('✅ PDF downloaded - ' + entries.length + ' entries');
}

// ── Season Summary PDF ────────────────────────────────────────
// Full formatted report: header, stats, species breakdown,
// cull plan vs actual, complete entries table with pagination
function exportSeasonSummary() {
  var entries = allEntries;
  if (!entries.length) { showToast('⚠️ No entries to export'); return; }

  var doc = new jspdf.jsPDF({ unit: 'pt', format: 'a4' });
  var PW = 595, PH = 842; // A4 in pt
  var ML = 18, MR = 18;   // left/right margins
  var UW = PW - ML - MR;  // usable width = 559pt

  // ── Colour helpers ──
  function rgb(hex) {
    var r = parseInt(hex.slice(1,3),16)/255;
    var g = parseInt(hex.slice(3,5),16)/255;
    var b = parseInt(hex.slice(5,7),16)/255;
    return [r,g,b];
  }
  var C = {
    deep:   '#0e2a08', forest: '#1a3a0e', moss:   '#5a7a30',
    gold:   '#c8a84b', bark:   '#3d2b1f', muted:  '#a0988a',
    stone:  '#ede9e2', white:  '#ffffff',
    red:    '#c8a84b', roe:    '#5a7a30', fallow: '#f57f17',
    muntjac:'#6a1b9a', sika:   '#1565c0', cwd:    '#00695c',
    male:   '#8b4513', female: '#8b1a4a', done:   '#2d7a1a',
  };
  function setFill(hex)   { var c=rgb(hex); doc.setFillColor(c[0]*255,c[1]*255,c[2]*255); }
  function setStroke(hex) { var c=rgb(hex); doc.setDrawColor(c[0]*255,c[1]*255,c[2]*255); }
  function setFont(hex)   { var c=rgb(hex); doc.setTextColor(c[0]*255,c[1]*255,c[2]*255); }

  function hrule(y, col) {
    setStroke(col||C.stone); doc.setLineWidth(0.3);
    doc.line(0, y, PW, y);
  }

  function newPageIfNeeded(y, needed) {
    if (y + needed > PH - 50) {
      doc.addPage();
      // Mini header on continuation pages
      setFill(C.deep); doc.rect(0, 0, PW, 24, 'F');
      setFont(C.gold); doc.setFontSize(7); doc.setFont(undefined,'bold');
      doc.text('FIRST LIGHT  -  CULL DIARY  -  ' + currentSeason.toUpperCase(), ML, 15);
      return 32;
    }
    return y;
  }

  // ── Stats from entries ──
  var totalKg  = entries.reduce(function(s,e){ return s+(parseFloat(e.weight_gralloch)||0); },0);
  var avgKg    = entries.length ? Math.round(totalKg/entries.length) : 0;
  var spSet    = {};
  entries.forEach(function(e){ spSet[e.species]=(spSet[e.species]||0)+1; });
  var spCount  = Object.keys(spSet).length;
  var spColors = { 'Red Deer':C.red,'Roe Deer':C.roe,'Fallow':C.fallow,
                   'Muntjac':C.muntjac,'Sika':C.sika,'CWD':C.cwd };

  // ── Generate display date ──
  function fmtEntryDate(d) {
    if (!d) return '';
    var parts = d.split('-');
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return parts[2] + ' ' + months[parseInt(parts[1])-1] + ' ' + parts[0];
  }

  // ═══════════════════════════════════════
  // PAGE 1
  // ═══════════════════════════════════════
  var y = 0;

  // Header band
  var HDR_H = 88;
  setFill(C.deep); doc.rect(0, 0, PW, HDR_H, 'F');
  setFill(C.forest); doc.rect(0, 0, PW/2, HDR_H, 'F');
  setStroke(C.gold); doc.setLineWidth(1.5);
  doc.line(0, HDR_H, PW, HDR_H);

  setFont(C.gold); doc.setFontSize(7); doc.setFont(undefined,'bold');
  doc.text('FIRST LIGHT  -  CULL DIARY', ML, 18);
  setFont(C.white); doc.setFontSize(22); doc.setFont(undefined,'bold');
  var pdfSeasonTitle = (window._summarySeasonLabel || (currentSeason + ' Season Report'));
  doc.text(pdfSeasonTitle, ML, 42);
  // Ground label if filtered
  if (window._summaryGroundOverride && window._summaryGroundOverride !== 'All Grounds') {
    setFont(C.gold); doc.setFontSize(9); doc.setFont(undefined,'bold');
    doc.text('Ground: ' + window._summaryGroundOverride, ML, 57);
    setFont('#aaaaaa'); doc.setFontSize(10); doc.setFont(undefined,'normal');
    doc.text('firstlightdeer.co.uk', ML, 69);
  } else {
    setFont('#aaaaaa'); doc.setFontSize(10); doc.setFont(undefined,'normal');
    doc.text('firstlightdeer.co.uk', ML, 57);
  }
  setFont(C.gold); doc.setFontSize(7);
  var now = new Date();
  var mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var _pdfHm = (function(d){ var p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d); return {h:parseInt(p.find(function(x){return x.type==='hour';}).value),m:parseInt(p.find(function(x){return x.type==='minute';}).value)}; }(now));
  var genDate = now.getDate()+' '+mo[now.getMonth()]+' '+now.getFullYear()+
    '  -  '+('0'+_pdfHm.h).slice(-2)+':'+('0'+_pdfHm.m).slice(-2);
  doc.text('Generated '+genDate, ML, 74);

  y = HDR_H;

  // Stats row
  var STAT_H = 46, cw = PW/4;
  var statData = [
    [String(entries.length), 'Total Cull'],
    [String(spCount),        'Species'],
    [String(Math.round(totalKg)), 'kg Gralloch'],
    [avgKg ? String(avgKg)+'kg' : '-', 'Average'],
  ];
  statData.forEach(function(s, i) {
    var x = i*cw;
    setFill(i%2===0 ? C.white : '#faf8f5'); doc.rect(x, y, cw, STAT_H, 'F');
    if (i>0) { setStroke(C.stone); doc.setLineWidth(0.5); doc.line(x,y,x,y+STAT_H); }
    setFont(C.bark); doc.setFontSize(20); doc.setFont(undefined,'bold');
    doc.text(s[0], x+cw/2, y+22, {align:'center'});
    setFont(C.muted); doc.setFontSize(7); doc.setFont(undefined,'bold');
    doc.text(s[1].toUpperCase(), x+cw/2, y+35, {align:'center'});
  });
  hrule(y+STAT_H, C.stone);
  y += STAT_H;

  // ── Section header helper ──
  function secHdr(y, title) {
    setFill('#f0ece6'); doc.rect(0, y, PW, 18, 'F');
    setStroke(C.stone); doc.setLineWidth(0.5); doc.line(0,y+18,PW,y+18);
    setFont(C.moss); doc.setFontSize(7); doc.setFont(undefined,'bold');
    doc.text(title.toUpperCase(), ML, y+11);
    return y+18;
  }

  // ── Species breakdown ──
  y = secHdr(y, 'Species Breakdown');
  var spSorted = Object.keys(spSet).sort(function(a,b){ return spSet[b]-spSet[a]; });
  var spMax = Math.max.apply(null, spSorted.map(function(k){ return spSet[k]; }));
  var totalWtBySpecies = {};
  entries.forEach(function(e){ totalWtBySpecies[e.species]=(totalWtBySpecies[e.species]||0)+(parseFloat(e.weight_gralloch)||0); });

  spSorted.forEach(function(sp) {
    y += 18;
    var clr = spColors[sp] || C.moss;
    setFill(clr); doc.circle(26, y+4, 4, 'F');
    setFont(C.bark); doc.setFontSize(10); doc.setFont(undefined,'bold');
    doc.text(sp, 36, y);
    // Bar
    var bx=130, bw=210, bh=5;
    setFill(C.stone); doc.roundedRect(bx, y+1, bw, bh, 2, 2, 'F');
    setFill(clr); doc.roundedRect(bx, y+1, bw*(spSet[sp]/spMax), bh, 2, 2, 'F');
    // Count + weight
    setFont(C.bark); doc.setFontSize(10); doc.setFont(undefined,'bold');
    doc.text(String(spSet[sp]), 355, y);
    setFont(C.muted); doc.setFontSize(9); doc.setFont(undefined,'normal');
    var wtStr = totalWtBySpecies[sp] ? Math.round(totalWtBySpecies[sp])+' kg' : '';
    doc.text(wtStr, PW-MR, y, {align:'right'});
    hrule(y+6, C.stone);
  });

  // ── Cull Plan vs Actual (if targets set) ──
  var hasTargets = Object.keys(cullTargets).some(function(k){ return cullTargets[k]>0; });
  if (hasTargets) {
    y += 10;
    y = secHdr(y, 'Cull Plan vs Actual');
    var actuals = {};
    entries.forEach(function(e){ var k=e.species+'-'+e.sex; actuals[k]=(actuals[k]||0)+1; });

    PLAN_SPECIES.forEach(function(sp) {
      var mT = cullTargets[sp.name+'-m']||0, fT = cullTargets[sp.name+'-f']||0;
      if (!mT && !fT) return;
      var mA = actuals[sp.name+'-m']||0, fA = actuals[sp.name+'-f']||0;
      [[mT,mA,'Male'],[fT,fA,'Female']].forEach(function(row) {
        var tgt=row[0], act=row[1], sex=row[2];
        if (!tgt) return;
        y += 16;
        setFont(C.bark); doc.setFontSize(9); doc.setFont(undefined,'bold');
        if (sex==='Male') doc.text(sp.name, ML, y);
        setFont(sex==='Male'?C.male:C.female); doc.setFont(undefined,'normal');
        doc.text(sex, 82, y);
        var bx=138,bw=280,bh=4,pct=Math.min(1,act/tgt),done=act>=tgt;
        setFill(C.stone); doc.roundedRect(bx,y+1,bw,bh,2,2,'F');
        setFill(done?C.done:C.moss); doc.roundedRect(bx,y+1,bw*pct,bh,2,2,'F');
        setFont(done?C.done:C.bark); doc.setFontSize(9); doc.setFont(undefined,'bold');
        doc.text(act+'/'+tgt+(done?' (done)':''), PW-MR, y, {align:'right'});
        hrule(y+4, C.stone);
      });
    });
  }

  // ── Entries table ──
  y += 10;
  y = secHdr(y, 'All Entries — ' + entries.length + ' records');

  // Column widths — spread full usable width (559pt)
  var W_DATE=62, W_SP=82, W_SEX=46, W_GRALL=48, W_PLACE=98, W_SHOOT=70;
  var W_LOC = UW - W_DATE - W_SP - W_SEX - W_GRALL - W_PLACE - W_SHOOT;
  var COL = {
    date:      ML,
    species:   ML+W_DATE,
    sex:       ML+W_DATE+W_SP,
    gralloch:  ML+W_DATE+W_SP+W_SEX,
    placement: ML+W_DATE+W_SP+W_SEX+W_GRALL,
    shooter:   ML+W_DATE+W_SP+W_SEX+W_GRALL+W_PLACE,
    location:  ML+W_DATE+W_SP+W_SEX+W_GRALL+W_PLACE+W_SHOOT,
  };

  // Table header
  y += 16;
  setFill('#f0ece6'); doc.rect(0, y-12, PW, 16, 'F');
  setFont(C.muted); doc.setFontSize(7); doc.setFont(undefined,'bold');
  [['DATE',COL.date],['SPECIES',COL.species],['SEX',COL.sex],
   ['GRALLOCH',COL.gralloch],['PLACEMENT',COL.placement],['SHOOTER',COL.shooter],['LOCATION',COL.location]
  ].forEach(function(h){ doc.text(h[0], h[1], y-2); });
  hrule(y+2, C.stone);

  // Table rows
  entries.forEach(function(e, i) {
    y = newPageIfNeeded(y, 18);
    y += 16;
    setFill(i%2===0?C.white:'#fdfcfa'); doc.rect(0, y-11, PW, 16, 'F');
    setFont(C.bark); doc.setFontSize(9); doc.setFont(undefined,'normal');
    doc.text(fmtEntryDate(e.date),                   COL.date,      y);
    doc.text(e.species||'',                           COL.species,   y);
    setFont(e.sex==='m'?C.male:C.female); doc.setFont(undefined,'bold');
    doc.text(e.sex==='m'?'Male':'Female',             COL.sex,       y);
    setFont(C.bark); doc.setFont(undefined,'normal');
    doc.text(e.weight_gralloch?(e.weight_gralloch+' kg'):'–', COL.gralloch, y);
    doc.text(e.shot_placement||'–',                   COL.placement, y);
    doc.text(e.shooter&&e.shooter!=='Self'?e.shooter:'–', COL.shooter, y);
    doc.text(e.location_name||'–',                    COL.location,  y);
    hrule(y+3, C.stone);
  });

  // Footer on each page
  var pageCount = doc.internal.getNumberOfPages();
  for (var p=1; p<=pageCount; p++) {
    doc.setPage(p);
    setStroke(C.stone); doc.setLineWidth(0.5); doc.line(0,PH-38,PW,PH-38);
    setFont(C.muted); doc.setFontSize(7); doc.setFont(undefined,'normal');
    doc.text('First Light  -  Cull Diary  -  Page '+p+' of '+pageCount, ML, PH-24);
    setFont(C.gold);
    doc.text('firstlightdeer.co.uk', PW-MR, PH-24, {align:'right'});
  }

  var summaryFilename = window._summarySeasonLabel
    ? 'first-light-all-seasons'
    : 'first-light-season-' + currentSeason;
  if (window._summaryGroundOverride && window._summaryGroundOverride !== 'All Grounds') {
    summaryFilename += '-' + window._summaryGroundOverride.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  }
  doc.save(summaryFilename + '.pdf');
  showToast('✅ Season summary downloaded');
}

function exportSinglePDF(id) {
  var e = allEntries.find(function(x){ return x.id === id; });
  if (!e) return;
  var doc = new jspdf.jsPDF();
  doc.setFontSize(16); doc.text('Cull Record — First Light', 14, 20);
  doc.setFontSize(12); doc.text(e.species + ' (' + (e.sex==='m'?'Male':'Female') + ')', 14, 32);
  doc.setFontSize(10);
  var fields = [
    ['Date', e.date], ['Time', e.time], ['Location', e.location_name],
    ['Age class', e.age_class], ['Gralloch weight', e.weight_gralloch ? e.weight_gralloch + ' kg' : ''],
    ['Clean weight', e.weight_clean ? e.weight_clean + ' kg' : ''],
    ['Larder weight', e.weight_larder ? e.weight_larder + ' kg' : ''],
    ['Calibre', e.calibre], ['Distance', e.distance_m ? e.distance_m + 'm' : ''],
    ['Shot placement', e.shot_placement], ['Destination', e.destination], ['Notes', e.notes ? e.notes.slice(0, 300) : null]
  ];
  var y = 44;
  fields.forEach(function(f) {
    if (!f[1]) return;
    doc.setFont(undefined,'bold'); doc.text(f[0] + ':', 14, y);
    doc.setFont(undefined,'normal'); doc.text(String(f[1]), 60, y);
    y += 7;
  });
  doc.save('cull-record-' + e.date + '.pdf');
  showToast('✅ PDF downloaded');
}

// ══════════════════════════════════════════════════════════════
// QUICK ENTRY
// ══════════════════════════════════════════════════════════════
var qsSpecies = null;
var qsSexVal  = null;
var qsLocation = '';
var qsLat = null, qsLng = null;

function openQuickEntry() {
  // Reset state
  qsSpecies = null; qsSexVal = null;
  document.querySelectorAll('.qs-pill').forEach(function(p){ p.classList.remove('on'); });
  document.getElementById('qs-m').classList.remove('on');
  document.getElementById('qs-f').classList.remove('on');
  document.getElementById('qs-wt').value = '';

  // Pre-fill date/time/location in meta line
  var now = new Date();
  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var _hm = (function(d){ var p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d); return {h:parseInt(p.find(function(x){return x.type==='hour';}).value),m:parseInt(p.find(function(x){return x.type==='minute';}).value)}; }(now)); var timeStr = ('0'+_hm.h).slice(-2)+':'+('0'+_hm.m).slice(-2);
  var dateStr = days[now.getDay()] + ' ' + now.getDate() + ' ' + months[now.getMonth()];
  document.getElementById('qs-meta').textContent = dateStr + ' · ' + timeStr + ' · Getting location…';

  // Show sheet
  document.getElementById('qs-overlay').classList.add('open');
  var qs = document.getElementById('quick-sheet');
  qs.style.display = 'block';
  qs.style.transform = 'translateX(-50%)';
  document.body.style.overflow = 'hidden';

  // Silently fetch GPS location
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(function(pos) {
      qsLat = pos.coords.latitude.toFixed(4);
      qsLng = pos.coords.longitude.toFixed(4);
      fetch('https://nominatim.openstreetmap.org/reverse?lat=' + qsLat + '&lon=' + qsLng + '&format=json')
        .then(function(r){ return r.json(); })
        .then(function(d) {
          var qa = d.address || {};
          qsLocation = qa.village || qa.town || qa.city || qa.county || (qsLat + ', ' + qsLng);
          document.getElementById('qs-meta').textContent = dateStr + ' · ' + timeStr + ' · ' + qsLocation;
        }).catch(function() {
          qsLocation = qsLat + ', ' + qsLng;
          document.getElementById('qs-meta').textContent = dateStr + ' · ' + timeStr + ' · ' + qsLocation;
        });
    }, function() {
      qsLocation = '';
      document.getElementById('qs-meta').textContent = dateStr + ' · ' + timeStr;
    }, { timeout: 6000, maximumAge: 60000 });
  } else {
    document.getElementById('qs-meta').textContent = dateStr + ' · ' + timeStr;
  }
}

function closeQuickEntry() {
  document.getElementById('qs-overlay').classList.remove('open');
  document.getElementById('quick-sheet').style.display = 'none';
  document.body.style.overflow = '';
  qsSpecies = null; qsSexVal = null;
}

function qsPick(el, name) {
  document.querySelectorAll('.qs-pill').forEach(function(p){ p.classList.remove('on'); });
  el.classList.add('on');
  qsSpecies = name;
}

function qsSex(s) {
  qsSexVal = s;
  document.getElementById('qs-m').classList.toggle('on', s === 'm');
  document.getElementById('qs-f').classList.toggle('on', s === 'f');
}

async function saveQuickEntry() {
  if (!qsSpecies) { showToast('⚠️ Please select a species'); return; }
  if (!qsSexVal)  { showToast('⚠️ Please select sex'); return; }
  if (!sb || !currentUser) { showToast('⚠️ Not signed in'); return; }

  var btn = document.getElementById('qs-save-btn');
  btn.disabled = true; btn.textContent = '☁️ Saving…';

  var now = new Date();
  var dateVal = now.getFullYear() + '-'
    + ('0'+(now.getMonth()+1)).slice(-2) + '-'
    + ('0'+now.getDate()).slice(-2);
  var _hm2 = (function(d){ var p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d); return {h:parseInt(p.find(function(x){return x.type==='hour';}).value),m:parseInt(p.find(function(x){return x.type==='minute';}).value)}; }(now)); var timeVal = ('0'+_hm2.h).slice(-2)+':'+('0'+_hm2.m).slice(-2);

  var gralloch = parseFloat(document.getElementById('qs-wt').value) || null;

  var payload = {
    user_id:         currentUser.id,
    species:         qsSpecies,
    sex:             qsSexVal,
    date:            dateVal,
    time:            timeVal,
    location_name:   qsLocation || null,
    weight_gralloch: gralloch ? Math.max(0, gralloch) : null,
    weight_clean:    gralloch ? Math.round(gralloch * 0.82 * 10) / 10 : null,
    weight_larder:   gralloch ? Math.round(gralloch * 0.75 * 10) / 10 : null,
    lat:             qsLat ? parseFloat(qsLat) : null,
    lng:             qsLng ? parseFloat(qsLng) : null,
  };

  // ── Offline check ──
  if (!navigator.onLine) {
    queueOfflineEntry({ species:payload.species, sex:payload.sex, date:payload.date, time:payload.time,
      location_name:payload.location_name, lat:payload.lat, lng:payload.lng,
      weight_gralloch:payload.weight_gralloch, weight_clean:payload.weight_clean, weight_larder:payload.weight_larder });
    btn.disabled = false; btn.textContent = '☁️ Save to Cloud';
    return;
  }

  try {
    var result = await sb.from('cull_entries').insert(payload);
    if (result.error) throw result.error;
    showToast('✅ ' + qsSpecies + ' saved');
    closeQuickEntry();
    await loadEntries();
  } catch(e) {
    showToast('⚠️ Save failed: ' + (e.message || 'Unknown error'));
  }
  btn.disabled = false; btn.textContent = '☁️ Save to Cloud';
}


// Open-Meteo WMO codes → emoji + label
function wxCodeLabel(code) {
  if (code === 0)               return { icon: '☀️',  label: 'Clear' };
  if (code <= 2)                return { icon: '⛅',  label: 'Partly cloudy' };
  if (code === 3)               return { icon: '☁️',  label: 'Overcast' };
  if (code <= 49)               return { icon: '🌫️', label: 'Fog' };
  if (code <= 57)               return { icon: '🌦️', label: 'Drizzle' };
  if (code <= 65)               return { icon: '🌧️', label: 'Rain' };
  if (code <= 77)               return { icon: '❄️',  label: 'Snow' };
  if (code <= 82)               return { icon: '🌧️', label: 'Showers' };
  if (code <= 86)               return { icon: '🌨️', label: 'Snow showers' };
  if (code <= 99)               return { icon: '⛈️',  label: 'Thunderstorm' };
  return { icon: '🌡️', label: 'Unknown' };
}

function windDirLabel(deg) {
  if (deg === null || deg === undefined) return '';
  var dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

// ── Weather at time of cull ──────────────────────────────────
// Fetches from Open-Meteo historical or forecast API
// Only fetches for entries within last 7 days
// Stores as JSONB in cull_entries.weather_data

async function fetchCullWeather(date, time, lat, lng) {
  // date: 'YYYY-MM-DD', time: 'HH:MM', lat/lng: numbers
  if (!date || !lat || !lng) return null;

  var entryDate = new Date(date + 'T' + (time || '12:00') + ':00');
  var now = new Date();
  var ageDays = (now - entryDate) / 86400000;

  // Skip if older than 7 days or in the future
  if (ageDays > 7 || ageDays < 0) return null;

  var hour = time ? parseInt(time.split(':')[0]) : 12;

  try {
    // Use forecast API with past_hours for recent entries
    // past_hours=168 = 7 days back
    var url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + lat + '&longitude=' + lng
      + '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,windgusts_10m,surface_pressure,cloud_cover,weather_code,precipitation'
      + '&past_days=7&forecast_days=1&timezone=auto';

    var r = await fetch(url);
    if (!r.ok) return null;
    var d = await r.json();

    // Find the index matching our date+hour
    var times = d.hourly && d.hourly.time ? d.hourly.time : [];
    var target = date + 'T' + ('0'+hour).slice(-2) + ':00';
    var idx = times.indexOf(target);
    if (idx === -1) return null;

    var h = d.hourly;
    var windKmh = h.wind_speed_10m ? h.wind_speed_10m[idx] : null;
    var gustKmh = h.windgusts_10m  ? h.windgusts_10m[idx]  : null;

    return {
      temp:       h.temperature_2m    ? Math.round(h.temperature_2m[idx] * 10) / 10 : null,
      wind_mph:   windKmh !== null     ? Math.round(windKmh * 0.621)               : null,
      gust_mph:   gustKmh !== null     ? Math.round(gustKmh * 0.621)               : null,
      wind_dir:   h.wind_direction_10m ? h.wind_direction_10m[idx]                 : null,
      pressure:   h.surface_pressure  ? Math.round(h.surface_pressure[idx])        : null,
      cloud:      h.cloud_cover        ? h.cloud_cover[idx]                         : null,
      code:       h.weather_code       ? h.weather_code[idx]                        : null,
      precip_mm:  h.precipitation     ? h.precipitation[idx]                       : null,
      fetched_at: new Date().toISOString()
    };
  } catch(e) {
    console.warn('Weather fetch failed:', e);
    return null;
  }
}

async function attachWeatherToEntry(entryId, date, time, lat, lng) {
  if (!sb || !currentUser || !entryId) return;
  var wx = await fetchCullWeather(date, time, lat, lng);
  if (!wx) return; // silently skip if outside 7-day window or fetch failed
  try {
    await sb.from('cull_entries')
      .update({ weather_data: wx })
      .eq('id', entryId)
      .eq('user_id', currentUser.id);
  } catch(e) {
    console.warn('Weather attach failed:', e);
  }
}

function renderWeatherStrip(e) {
  var wx = e.weather_data;
  if (!wx || typeof wx !== 'object') return '';

  var wc = wxCodeLabel(wx.code);
  var windDir = windDirLabel(wx.wind_dir);
  var windStr = wx.wind_mph !== null ? wx.wind_mph + ' mph' : '–';
  if (windDir) windStr += ' ' + windDir;
  var tempStr  = wx.temp    !== null ? wx.temp + '°C'   : '–';
  var pressStr = wx.pressure !== null ? wx.pressure + ' hPa' : '–';
  var cloudStr = wx.cloud   !== null ? wx.cloud + '%'   : '–';

  var html = '<div class="wx-strip-hdr">'
    + '<div class="wx-strip-title">Conditions at time of cull</div>'
    + (e.time ? '<div class="wx-strip-time">' + e.time + '</div>' : '')
    + '</div>'
    + '<div class="wx-strip">'
    + '<div class="wx-cell"><div class="wx-cell-icon">' + wc.icon + '</div><div class="wx-cell-val" style="font-size:10px;">' + wc.label + '</div><div class="wx-cell-lbl">Sky</div></div>'
    + '<div class="wx-cell"><div class="wx-cell-icon">🌡️</div><div class="wx-cell-val">' + tempStr + '</div><div class="wx-cell-lbl">Temp</div></div>'
    + '<div class="wx-cell"><div class="wx-cell-icon">🍃</div><div class="wx-cell-val" style="font-size:10px;">' + windStr + '</div><div class="wx-cell-lbl">Wind</div></div>'
    + '<div class="wx-cell"><div class="wx-cell-icon">📊</div><div class="wx-cell-val" style="font-size:10px;">' + pressStr + '</div><div class="wx-cell-lbl">Pressure</div></div>'
    + '</div>';

  return html;
}


// ══════════════════════════════════════════════════════════════
// MAP FEATURE — Pin Drop + Cull Map
// ══════════════════════════════════════════════════════════════
var OS_KEY = 'Q4CgPxeA5EHM17KPG6y78arVIekRHGsv';
var TILE_SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
// OS Maps API — Road_3857 works on free tier; Outdoor_3857 requires premium
var TILE_OS_STD = 'https://api.os.uk/maps/raster/v1/zxy/Road_3857/{z}/{x}/{y}.png?key=' + OS_KEY;

var SP_COLORS = {
  'Red Deer':'#c8a84b','Roe Deer':'#5a7a30','Fallow':'#f57f17',
  'Muntjac':'#6a1b9a','Sika':'#1565c0','CWD':'#00695c'
};

// ── PIN DROP ──────────────────────────────────────────────────
var pinMap = null, pinMapLayer = null, pinSatLayer = null;
var formPinLat = null, formPinLng = null;
var pinNominatimTimer = null;

function makeMarkerIcon(color) {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">'
    + '<filter id="ms"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.3"/></filter>'
    + '<path d="M13 2C7.5 2 3 6.5 3 12c0 8 10 20 10 20s10-12 10-20C23 6.5 18.5 2 13 2z" fill="' + color + '" stroke="white" stroke-width="1.8" filter="url(#ms)"/>'
    + '<circle cx="13" cy="12" r="4.5" fill="white" opacity="0.92"/>'
    + '</svg>';
  return L.divIcon({ html:svg, iconSize:[26,34], iconAnchor:[13,34], popupAnchor:[0,-34], className:'' });
}

function openPinDrop() {
  var overlay = document.getElementById('pinmap-overlay');
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  if (!pinMap) {
    // Default centre: UK midpoint, or last known location
    var startLat = formPinLat || lastGpsLat || 52.5;
    var startLng = formPinLng || lastGpsLng || -1.5;

    pinMap = L.map('pin-map-div', { zoomControl:true, attributionControl:false })
      .setView([startLat, startLng], 14);

    pinMapLayer = L.tileLayer(TILE_OS_STD, { maxZoom:20 }).addTo(pinMap);
    pinSatLayer = L.tileLayer(TILE_SAT,   { maxZoom:20 });

    pinMap.on('move', function() {
      var c = pinMap.getCenter();
      document.getElementById('pinmap-coords').textContent =
        Math.abs(c.lat).toFixed(5) + '°' + (c.lat>=0?'N':'S') +
        ' · ' + Math.abs(c.lng).toFixed(5) + '°' + (c.lng>=0?'E':'W');
      document.getElementById('pinmap-name').textContent = 'Locating…';
      clearTimeout(pinNominatimTimer);
    });

    pinMap.on('moveend', function() {
      var c = pinMap.getCenter();
      clearTimeout(pinNominatimTimer);
      pinNominatimTimer = setTimeout(function() {
        fetch('https://nominatim.openstreetmap.org/reverse?lat='+c.lat+'&lon='+c.lng+'&format=json')
          .then(function(r){ return r.json(); })
          .then(function(d) {
            var a = d.address || {};
            var name = a.village||a.hamlet||a.suburb||a.town||a.city||a.county||(c.lat.toFixed(4)+', '+c.lng.toFixed(4));
            document.getElementById('pinmap-name').textContent = name;
          }).catch(function() {
            var c2 = pinMap.getCenter();
            document.getElementById('pinmap-name').textContent = c2.lat.toFixed(4)+', '+c2.lng.toFixed(4);
          });
      }, 600); // debounce 600ms
      var _h = document.getElementById('pinmap-hint'); if(_h){ _h.style.opacity='0'; setTimeout(function(){ _h.style.display='none'; }, 300); }
    });
  } else {
    // Re-centre on last pin or current location
    var startLat = formPinLat || lastGpsLat || 52.5;
    var startLng = formPinLng || lastGpsLng || -1.5;
    pinMap.setView([startLat, startLng], 14);
    // Reset hint — remove inline style so CSS controls it
    var hint = document.getElementById('pinmap-hint');
    if (hint) { hint.style.display = ''; hint.style.opacity = ''; }
  }

  setTimeout(function(){ pinMap.invalidateSize(); }, 80);
}

function closePinDrop() {
  document.getElementById('pinmap-overlay').style.display = 'none';
  document.body.style.overflow = '';
  var s = document.getElementById('pinmap-search');
  var r = document.getElementById('pinmap-search-results');
  if (s) s.value = '';
  if (r) r.style.display = 'none';
}

function setPinLayer(type) {
  if (!pinMap) return;
  if (type === 'sat') {
    pinMap.removeLayer(pinMapLayer); pinSatLayer.addTo(pinMap);
    document.getElementById('plt-map').className = 'lt-b off';
    document.getElementById('plt-sat').className = 'lt-b on';
  } else {
    pinMap.removeLayer(pinSatLayer); pinMapLayer.addTo(pinMap);
    document.getElementById('plt-map').className = 'lt-b on';
    document.getElementById('plt-sat').className = 'lt-b off';
  }
}

function confirmPinDrop() {
  var c = pinMap.getCenter();
  formPinLat = c.lat; formPinLng = c.lng;
  lastGpsLat = c.lat; lastGpsLng = c.lng;
  var name = document.getElementById('pinmap-name').textContent;
  if (name === 'Locating…') name = c.lat.toFixed(4) + ', ' + c.lng.toFixed(4);
  document.getElementById('f-location').value = name;
  showPinnedStrip(name, c.lat, c.lng);
  closePinDrop();
}

function showPinnedStrip(name, lat, lng) {
  var strip = document.getElementById('loc-pinned-strip');
  document.getElementById('loc-pinned-name').textContent = name;
  document.getElementById('loc-pinned-coords').textContent =
    Math.abs(lat).toFixed(4) + '°' + (lat>=0?'N':'S') +
    ' · ' + Math.abs(lng).toFixed(4) + '°' + (lng>=0?'E':'W');
  strip.style.display = 'flex';
}

function clearPinnedLocation() {
  formPinLat = null; formPinLng = null;
  lastGpsLat = null; lastGpsLng = null;
  var strip = document.getElementById('loc-pinned-strip');
  if (strip) strip.style.display = 'none';
}

// ── CULL MAP ──────────────────────────────────────────────────
var cullMap = null, cullMapLayer = null, cullSatLayer = null;
var cullMarkers = [];
var cullFilter = 'all';

function initCullMap() {
  if (cullMap) return;
  var container = document.getElementById('cull-map-div');
  if (!container) return;

  // Set container height
  container.style.height = '300px';

  cullMap = L.map('cull-map-div', { zoomControl:true, attributionControl:false })
    .setView([54.0, -2.0], 6); // UK overview

  cullMapLayer = L.tileLayer(TILE_OS_STD, { maxZoom:20 }).addTo(cullMap);
  cullSatLayer = L.tileLayer(TILE_SAT,   { maxZoom:20 });
}

function setCullLayer(type) {
  if (!cullMap) return;
  if (type === 'sat') {
    cullMap.removeLayer(cullMapLayer); cullSatLayer.addTo(cullMap);
    document.getElementById('clt-map').className = 'lt-b off';
    document.getElementById('clt-sat').className = 'lt-b on';
  } else {
    cullMap.removeLayer(cullSatLayer); cullMapLayer.addTo(cullMap);
    document.getElementById('clt-map').className = 'lt-b on';
    document.getElementById('clt-sat').className = 'lt-b off';
  }
}

function filterCullMap(filter, el) {
  cullFilter = filter;
  document.querySelectorAll('.cmf-chip').forEach(function(c){ c.classList.remove('on'); });
  el.classList.add('on');
  renderCullMapPins();
  // Rebuild all stats below with same species filter
  buildStats(filter === 'all' ? null : filter);
}

function renderCullMapPins() {
  if (!cullMap) return;
  // Remove existing markers
  cullMarkers.forEach(function(m){ cullMap.removeLayer(m); });
  cullMarkers = [];

  var entries = allEntries.filter(function(e) {
    return e.lat && e.lng && (cullFilter === 'all' || e.species === cullFilter);
  });

  var noGps = allEntries.filter(function(e){ return !e.lat || !e.lng; }).length;
  var spSet = new Set(allEntries.filter(function(e){ return e.lat&&e.lng; }).map(function(e){ return e.species; }));

  document.getElementById('cms-pinned').textContent = entries.length;
  document.getElementById('cms-nogps').textContent = noGps;
  document.getElementById('cms-species').textContent = spSet.size;

  // Show/hide empty state overlay (never destroy the map div)
  var emptyEl = document.getElementById('cull-map-empty-state');
  var mapDiv  = document.getElementById('cull-map-div');
  if (!emptyEl) {
    // Create overlay on first use
    emptyEl = document.createElement('div');
    emptyEl.id = 'cull-map-empty-state';
    emptyEl.className = 'cull-map-empty';
    emptyEl.style.cssText = 'position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;background:white;';
    emptyEl.innerHTML = '<div class="cull-map-empty-icon">📍</div>' +
      '<div class="cull-map-empty-t">No mapped locations yet</div>' +
      '<div class="cull-map-empty-s">Use the 📍 Pin or 🎯 GPS button when logging entries to build your location history.</div>';
    document.getElementById('cull-map-container').appendChild(emptyEl);
  }

  if (entries.length === 0) {
    emptyEl.style.display = 'flex';
    document.getElementById('cull-map-stats').style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  document.getElementById('cull-map-stats').style.display = 'flex';

  var bounds = [];
  entries.forEach(function(e) {
    var clr = SP_COLORS[e.species] || '#5a7a30';
    var sex = e.sex === 'm' ? '&#9794;' : '&#9792;';
    var popup = '<div style="font-size:13px;font-weight:700;color:#3d2b1f;">' + esc(e.species) + ' ' + sex + '</div>'
      + '<div style="font-size:11px;color:#a0988a;margin-top:2px;">' + esc(e.date||'') + (e.time ? ' · ' + esc(e.time) : '') + '</div>'
      + (e.weight_gralloch ? '<div style="font-size:11px;color:#3d2b1f;margin-top:4px;">' + esc(String(e.weight_gralloch)) + ' kg gralloch</div>' : '')
      + (e.shot_placement  ? '<div style="font-size:11px;color:#3d2b1f;">' + esc(e.shot_placement) + '</div>' : '')
      + (e.location_name   ? '<div style="font-size:10px;color:#a0988a;margin-top:3px;">📍 ' + esc(e.location_name) + '</div>' : '');

    var marker = L.marker([e.lat, e.lng], { icon: makeMarkerIcon(clr) })
      .addTo(cullMap)
      .bindPopup(popup);
    cullMarkers.push(marker);
    bounds.push([e.lat, e.lng]);
  });

  if (bounds.length > 0) {
    cullMap.fitBounds(bounds, { padding:[32,32], maxZoom:14 });
  }

  setTimeout(function(){ if(cullMap) cullMap.invalidateSize(); }, 100);
}

// ── Calibre & Distance Stats ─────────────────────────────────
var CAL_COLORS = ['linear-gradient(90deg,#5a7a30,#7adf7a)','linear-gradient(90deg,#c8a84b,#f0c870)',
  'linear-gradient(90deg,#6a1b9a,#ab47bc)','linear-gradient(90deg,#1565c0,#42a5f5)',
  'linear-gradient(90deg,#c62828,#ef5350)','linear-gradient(90deg,#00695c,#26a69a)'];
var SP_COLORS_D = {'Red Deer':'#c8a84b','Roe Deer':'#5a7a30','Fallow':'#f57f17',
  'Muntjac':'#6a1b9a','Sika':'#1565c0','CWD':'#00695c'};

function buildCalibreDistanceStats(entries) {
  // ── Calibre chart ──
  var calCard = document.getElementById('calibre-card');
  var calChart = document.getElementById('calibre-chart');
  var calEntries = entries.filter(function(e){ return e.calibre; });

  if (calEntries.length === 0) {
    calCard.style.display = 'none';
  } else {
    calCard.style.display = 'block';
    // Count by calibre
    var calCount = {}, calDist = {};
    calEntries.forEach(function(e) {
      var c = e.calibre.trim();
      calCount[c] = (calCount[c]||0) + 1;
      if (e.distance_m) {
        if (!calDist[c]) calDist[c] = [];
        calDist[c].push(e.distance_m);
      }
    });
    var sorted = Object.keys(calCount).sort(function(a,b){ return calCount[b]-calCount[a]; });
    var maxCnt = calCount[sorted[0]] || 1;

    var html = '';
    sorted.slice(0,6).forEach(function(cal, i) {
      var cnt = calCount[cal];
      var pct = Math.round(cnt/maxCnt*100);
      var avgDist = calDist[cal] && calDist[cal].length
        ? Math.round(calDist[cal].reduce(function(s,v){return s+v;},0)/calDist[cal].length)
        : null;
      html += '<div class="cal-row">'
        + '<div class="cal-name">' + esc(cal) + '</div>'
        + '<div class="cal-bar-wrap"><div class="cal-bar" style="width:'+pct+'%;background:'+CAL_COLORS[i%CAL_COLORS.length]+';"></div></div>'
        + '<div class="cal-cnt">' + cnt + '</div>'
        + '<div class="cal-avg-lbl">' + (avgDist ? avgDist+'m' : '–') + '</div>'
        + '</div>';
    });
    calChart.innerHTML = html;
  }

  // ── Distance chart ──
  var distCard = document.getElementById('distance-card');
  var distChart = document.getElementById('distance-chart');
  var distEntries = entries.filter(function(e){ return e.distance_m && e.distance_m > 0; });

  if (distEntries.length === 0) {
    distCard.style.display = 'none';
  } else {
    distCard.style.display = 'block';

    // Overall average
    var totalDist = distEntries.reduce(function(s,e){ return s+e.distance_m; }, 0);
    var avgDist = Math.round(totalDist / distEntries.length);

    // Per species averages
    var spDist = {};
    distEntries.forEach(function(e) {
      if (!spDist[e.species]) spDist[e.species] = [];
      spDist[e.species].push(e.distance_m);
    });
    var spAvgs = Object.keys(spDist).map(function(sp) {
      var vals = spDist[sp];
      return { sp:sp, avg: Math.round(vals.reduce(function(s,v){return s+v;},0)/vals.length) };
    }).sort(function(a,b){ return b.avg - a.avg; });
    var maxAvg = spAvgs.length ? spAvgs[0].avg : 1;

    // Range bands
    var bands = [
      { label:'0 – 50m',    min:0,   max:50,  color:'var(--moss)' },
      { label:'51 – 100m',  min:51,  max:100, color:'var(--gold)' },
      { label:'101 – 150m', min:101, max:150, color:'#f57f17' },
      { label:'150m+',      min:151, max:9999,color:'#c62828' },
    ];
    var bandCounts = bands.map(function(b) {
      return distEntries.filter(function(e){ return e.distance_m>=b.min && e.distance_m<=b.max; }).length;
    });
    var totalBand = distEntries.length;

    var html = '<div class="dist-avg-box">'
      + '<div><div class="dist-avg-val">' + avgDist + '</div><div class="dist-avg-unit">metres avg</div></div>'
      + '<div><div class="dist-avg-lbl">Overall average</div>'
      + '<div class="dist-avg-sub">Based on ' + distEntries.length + ' entr' + (distEntries.length===1?'y':'ies') + ' with<br>distance recorded</div></div>'
      + '</div>';

    if (spAvgs.length > 1) {
      html += '<div class="scard-sub-t">By species</div>';
      spAvgs.forEach(function(s) {
        var clr = SP_COLORS_D[s.sp] || '#5a7a30';
        var pct = Math.round(s.avg/maxAvg*100);
        html += '<div class="dist-sp-row">'
          + '<div class="dist-sp-dot" style="background:'+clr+';"></div>'
          + '<div class="dist-sp-name">'+s.sp+'</div>'
          + '<div class="dist-bar-wrap"><div class="dist-bar" style="width:'+pct+'%;background:'+clr+';"></div></div>'
          + '<div class="dist-val">'+s.avg+'m</div>'
          + '</div>';
      });
    }

    html += '<div class="scard-sub-t" style="margin-top:14px;">Distance bands</div>'
      + '<div class="range-grid">';
    bands.forEach(function(b, i) {
      var cnt = bandCounts[i];
      var pct = totalBand ? Math.round(cnt/totalBand*100) : 0;
      html += '<div class="range-cell">'
        + '<div class="range-band">'+b.label+'</div>'
        + '<div class="range-cnt">'+cnt+'</div>'
        + '<div class="range-pct">'+pct+'% of culls</div>'
        + '<div class="range-bar"><div class="range-bar-fill" style="width:'+pct+'%;background:'+b.color+';"></div></div>'
        + '</div>';
    });
    html += '</div>';

    distChart.innerHTML = html;
  }
}


// ── Age Class Breakdown ───────────────────────────────────────
var AGE_CLASSES = ['Calf / Kid', 'Yearling', '2–4 years', '5–8 years', '9+ years'];
var AGE_COLORS  = ['#5a9a3a',   '#5a7a30',  '#c8a84b',   '#f57f17',   '#c62828'];
var AGE_GROUPS  = { 'Juvenile': ['Calf / Kid','Yearling'], 'Adult': ['2–4 years'], 'Mature': ['5–8 years','9+ years'] };

function buildAgeStats(entries) {
  var card  = document.getElementById('age-card');
  var chart = document.getElementById('age-chart');
  var aged  = entries.filter(function(e){ return e.age_class; });

  if (aged.length === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  // Overall counts
  var counts = {};
  AGE_CLASSES.forEach(function(a){ counts[a] = 0; });
  aged.forEach(function(e){ if (counts[e.age_class] !== undefined) counts[e.age_class]++; });
  var total = aged.length;
  var maxCnt = Math.max.apply(null, AGE_CLASSES.map(function(a){ return counts[a]; }).concat([1]));

  // Overall bars
  var html = '';
  AGE_CLASSES.forEach(function(ac, i) {
    var cnt = counts[ac];
    var pct = total ? Math.round(cnt/total*100) : 0;
    var barPct = Math.round(cnt/maxCnt*100);
    html += '<div class="age-row">'
      + '<div class="age-lbl">' + ac + '</div>'
      + '<div class="age-bar-wrap"><div class="age-bar" style="width:'+barPct+'%;background:'+AGE_COLORS[i]+';"></div></div>'
      + '<div class="age-cnt">' + cnt + '</div>'
      + '<div class="age-pct">' + (cnt ? pct+'%' : '–') + '</div>'
      + '</div>';
  });

  // Summary pills
  var notRecorded = entries.length - aged.length;
  html += '<div class="age-summary">';
  Object.keys(AGE_GROUPS).forEach(function(grp) {
    var grpCnt = AGE_GROUPS[grp].reduce(function(s,a){ return s+(counts[a]||0); }, 0);
    var grpPct = total ? Math.round(grpCnt/total*100) : 0;
    var dotClr = grp==='Juvenile' ? '#7adf7a' : grp==='Adult' ? '#c8a84b' : '#f57f17';
    html += '<div class="age-pill">'
      + '<div class="age-pill-dot" style="background:'+dotClr+';"></div>'
      + '<div class="age-pill-txt">'+grp+'</div>'
      + '<div class="age-pill-cnt">'+grpCnt+' · '+grpPct+'%</div>'
      + '</div>';
  });
  if (notRecorded > 0) {
    html += '<div class="age-pill">'
      + '<div class="age-pill-dot" style="background:#ccc;"></div>'
      + '<div class="age-pill-txt">Not recorded</div>'
      + '<div class="age-pill-cnt">'+notRecorded+'</div>'
      + '</div>';
  }
  html += '</div>';

  // Per-species breakdown
  var spSeen = {};
  aged.forEach(function(e){ spSeen[e.species] = true; });
  var species = Object.keys(spSeen);

  if (species.length > 1) {
    html += '<div class="scard-sub-t" style="margin-top:14px;">By species</div>';
    species.forEach(function(sp) {
      var spEntries = aged.filter(function(e){ return e.species === sp; });
      var spCounts = {};
      AGE_CLASSES.forEach(function(a){ spCounts[a] = 0; });
      spEntries.forEach(function(e){ if (spCounts[e.age_class] !== undefined) spCounts[e.age_class]++; });
      var spMax = Math.max.apply(null, AGE_CLASSES.map(function(a){ return spCounts[a]; }).concat([1]));
      var clr = SP_COLORS_D[sp] || '#5a7a30';

      html += '<div class="age-sp-section">';
      html += '<div class="age-sp-hdr"><div class="age-sp-dot" style="background:'+clr+';"></div><div class="age-sp-nm">'+sp+'</div></div>';
      AGE_CLASSES.forEach(function(ac, i) {
        var cnt = spCounts[ac];
        if (!cnt) return;
        var barPct = Math.round(cnt/spMax*100);
        html += '<div class="age-mini-row">'
          + '<div class="age-mini-lbl">'+ac+'</div>'
          + '<div class="age-mini-bw"><div class="age-mini-bf" style="width:'+barPct+'%;background:'+AGE_COLORS[i]+';"></div></div>'
          + '<div class="age-mini-cnt">'+cnt+'</div>'
          + '</div>';
      });
      html += '</div>';
    });
  }

  chart.innerHTML = html;
}


// ══════════════════════════════════════════════════════════════
// OFFLINE ENTRY QUEUE
// ══════════════════════════════════════════════════════════════
var OFFLINE_KEY = 'fl_offline_queue';

function getOfflineQueue() {
  try {
    var raw = localStorage.getItem(OFFLINE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}

function saveOfflineQueue(queue) {
  try {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(queue));
  } catch(e) {
    // QuotaExceededError — try again stripping photos from queued entries
    try {
      var stripped = queue.map(function(entry) {
        if (entry._photoDataUrl) {
          var copy = Object.assign({}, entry);
          delete copy._photoDataUrl;
          copy._photoStripped = true;
          return copy;
        }
        return entry;
      });
      localStorage.setItem(OFFLINE_KEY, JSON.stringify(stripped));
      showToast('⚠️ Storage full — photos removed from offline queue, entries saved');
    } catch(e2) {
      showToast('⚠️ Storage full — offline queue could not be saved');
    }
  }
}

function queueOfflineEntry(entry) {
  var queue = getOfflineQueue();
  entry._queuedAt = new Date().toISOString();
  entry._id = Date.now() + '-' + Math.random().toString(36).slice(2,7);
  queue.push(entry);
  saveOfflineQueue(queue);
  updateOfflineBadge();
  showToast('📶 Saved offline · will sync when connected');
  go('v-list');
  renderList();
}

function updateOfflineBadge() {
  var queue = getOfflineQueue();
  var cnt = queue.length;
  var badge = document.getElementById('offline-badge');
  var banner = document.getElementById('offline-banner');
  var bannerT = document.getElementById('offline-banner-t');
  var bannerS = document.getElementById('offline-banner-s');

  if (badge) {
    badge.textContent = cnt;
    badge.style.display = cnt > 0 ? 'block' : 'none';
  }
  if (banner && bannerT) {
    if (cnt > 0) {
      bannerT.textContent = cnt + ' entr' + (cnt===1?'y':'ies') + ' queued offline';
      // Estimate storage used
      var queueStr = localStorage.getItem(OFFLINE_KEY) || '';
      var kb = Math.round(queueStr.length / 1024);
      var hasPhotos = queue.some(function(e){ return e._photoDataUrl; });
      var storageNote = kb > 0 ? ' · ~' + kb + 'KB used' : '';
      var photoNote = hasPhotos ? ' · photos queued' : '';
      if (bannerS) bannerS.textContent = 'Will sync when connection returns' + storageNote + photoNote;
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
    }
  }
}

async function syncOfflineQueue() {
  if (!navigator.onLine) { showToast('⚠️ Still offline — try again when connected'); return; }
  if (!sb || !currentUser) { showToast('⚠️ Please sign in first'); return; }

  var queue = getOfflineQueue();
  if (queue.length === 0) { showToast('✅ Nothing to sync'); return; }

  showToast('☁️ Syncing ' + queue.length + ' entr' + (queue.length===1?'y':'ies') + '…');

  var synced = 0, failed = 0, photosStripped = 0;
  var remaining = [];

  for (var i = 0; i < queue.length; i++) {
    var entry = queue[i];
    try {
      var payload = {
        user_id:         currentUser.id,
        species:         entry.species,
        sex:             entry.sex,
        date:            entry.date,
        time:            entry.time,
        location_name:   entry.location_name || null,
        lat:             entry.lat || null,
        lng:             entry.lng || null,
        weight_gralloch: entry.weight_gralloch || null,
        weight_clean:    entry.weight_clean    || null,
        weight_larder:   entry.weight_larder   || null,
        calibre:         entry.calibre         || null,
        distance_m:      entry.distance_m      || null,
        shot_placement:  entry.shot_placement  || null,
        age_class:       entry.age_class       || null,
        notes:           entry.notes           || null,
        shooter:         entry.shooter          || 'Self',
        ground:          entry.ground           || null,
        destination:     entry.destination      || null,
      };

      // Upload photo if queued as base64
      if (entry._photoDataUrl) {
        try {
          // Convert dataURL back to blob
          var arr = entry._photoDataUrl.split(',');
          var mimeMatch = arr[0].match(/:(.*?);/);
          if (!mimeMatch || !arr[1]) throw new Error('Malformed photo data URL');
          var mime = mimeMatch[1];
          var bstr = atob(arr[1]);
          var u8arr = new Uint8Array(bstr.length);
          for (var j = 0; j < bstr.length; j++) u8arr[j] = bstr.charCodeAt(j);
          var blob = new Blob([u8arr], { type: mime });
          var file = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
          var path = currentUser.id + '/' + Date.now() + '.jpg';
          var upload = await sb.storage.from('cull-photos').upload(path, file, { upsert: true, contentType: 'image/jpeg' });
          if (!upload.error) {
            var url = sb.storage.from('cull-photos').getPublicUrl(path);
            payload.photo_url = url.data.publicUrl;
          }
        } catch(photoErr) { console.warn('Photo sync failed:', photoErr); }
      } else if (entry._existingPhotoUrl) {
        payload.photo_url = entry._existingPhotoUrl;
      }

      var result = await sb.from('cull_entries').insert(payload);
      if (result.error) throw result.error;
      synced++;
      if (entry._photoStripped) photosStripped++;

      // Attach weather — fetch the new entry id first
      if (payload.lat && payload.lng && payload.date) {
        (async function(p) {
          try {
            var fresh = await sb.from('cull_entries')
              .select('id').eq('user_id', currentUser.id)
              .eq('date', p.date).eq('time', p.time || '').eq('species', p.species)
              .order('created_at', { ascending: false }).limit(1);
            if (fresh.data && fresh.data[0]) {
              attachWeatherToEntry(fresh.data[0].id, p.date, p.time, p.lat, p.lng);
            }
          } catch(e) { /* non-fatal */ }
        }(payload));
      }
    } catch(e) {
      console.warn('Sync failed for entry:', e);
      failed++;
      remaining.push(entry);
    }
  }

  saveOfflineQueue(remaining);
  updateOfflineBadge();
  await loadEntries();

  if (failed === 0) {
    var msg = '✅ Synced ' + synced + ' entr' + (synced===1?'y':'ies');
    if (photosStripped > 0) {
      msg += ' · ' + photosStripped + ' without photo' + (photosStripped===1?'':'s') + ' (removed to save storage)';
    }
    showToast(msg, photosStripped > 0 ? 5000 : 2500);
  } else {
    showToast('⚠️ Synced ' + synced + ', failed ' + failed);
  }
}

// Auto-sync when connection returns
window.addEventListener('online', function() {
  var queue = getOfflineQueue();
  if (queue.length > 0 && sb && currentUser) {
    setTimeout(syncOfflineQueue, 1500); // small delay to let connection stabilise
  }
  updateOfflineBadge();
});

window.addEventListener('offline', function() {
  updateOfflineBadge();
});

// Call on sign-in to restore badge state


// ── Shooter Stats ─────────────────────────────────────────────
function buildShooterStats(entries) {
  var card  = document.getElementById('shooter-card');
  var chart = document.getElementById('shooter-chart');

  // Count by shooter — normalise blank/undefined to 'Self'
  var counts = {};
  entries.forEach(function(e) {
    var s = (e.shooter && e.shooter.trim()) ? e.shooter.trim() : 'Self';
    counts[s] = (counts[s]||0) + 1;
  });

  var shooters = Object.keys(counts);

  // Hide card if everyone is Self (no point showing it)
  if (shooters.length <= 1 && shooters[0] === 'Self') {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';

  // Sort: Self first, then by count desc
  shooters.sort(function(a,b) {
    if (a === 'Self') return -1;
    if (b === 'Self') return 1;
    return counts[b] - counts[a];
  });

  var maxCnt = Math.max.apply(null, shooters.map(function(s){ return counts[s]; }));

  var html = '';
  shooters.forEach(function(s, i) {
    var cnt = counts[s];
    var pct = Math.round(cnt/maxCnt*100);
    var barClr = s === 'Self'
      ? 'linear-gradient(90deg,#5a7a30,#7adf7a)'
      : 'linear-gradient(90deg,#c8a84b,#f0c870)';
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + esc(s) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+barClr+';"></div></div>'
      + '<div class="bar-cnt">'+cnt+'</div>'
      + '</div>';
  });

  chart.innerHTML = html;
}

function buildDestinationStats(entries) {
  var card  = document.getElementById('destination-card');
  var chart = document.getElementById('destination-chart');

  var counts = {};
  entries.forEach(function(e) {
    if (e.destination) counts[e.destination] = (counts[e.destination]||0) + 1;
  });

  var dests = Object.keys(counts);

  // Hide if no entries have a destination set
  if (dests.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';

  // Sort by count descending
  dests.sort(function(a,b) { return counts[b] - counts[a]; });

  var maxCnt = Math.max.apply(null, dests.map(function(d){ return counts[d]; }));
  var destColors = {
    'Self / personal use': 'linear-gradient(90deg,#5a7a30,#7adf7a)',
    'Game dealer': 'linear-gradient(90deg,#c8a84b,#f0c870)',
    'Friend / family': 'linear-gradient(90deg,#1565c0,#42a5f5)',
    'Stalking client': 'linear-gradient(90deg,#6a1b9a,#ab47bc)',
    'Estate / landowner': 'linear-gradient(90deg,#00695c,#4db6ac)',
    'Left on hill': 'linear-gradient(90deg,#888,#aaa)',
    'Condemned': 'linear-gradient(90deg,#c62828,#ef5350)'
  };

  var html = '';
  dests.forEach(function(d) {
    var cnt = counts[d];
    var pct = Math.round(cnt/maxCnt*100);
    var barClr = destColors[d] || 'linear-gradient(90deg,#5a7a30,#7adf7a)';
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + esc(d) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+barClr+';"></div></div>'
      + '<div class="bar-cnt">'+cnt+'</div>'
      + '</div>';
  });

  chart.innerHTML = html;
}


// ══════════════════════════════════════════════════════════════
// GROUNDS SYSTEM
// ══════════════════════════════════════════════════════════════
var savedGrounds = []; // loaded from Supabase
var targetMode = 'season'; // 'season' or 'ground'
var groundTargets = {}; // { 'Farm A': { 'Roe Deer-m': 3, 'Roe Deer-f': 2 }, '__unassigned__': {...} }
var planGroundFilter = 'overview'; // 'overview' or a ground name

// ── Grounds CRUD ──────────────────────────────────────────────
async function loadGrounds() {
  if (!sb || !currentUser) return;
  try {
    var r = await sb.from('grounds')
      .select('name')
      .eq('user_id', currentUser.id)
      .order('name', { ascending: true });
    if (r.data) savedGrounds = r.data.map(function(g){ return g.name; });
    populateGroundDropdown();
  } catch(e) { console.warn('loadGrounds error:', e); }
}

async function saveGround(name) {
  if (!name || !sb || !currentUser) return;
  name = name.trim();
  if (!name || savedGrounds.indexOf(name) !== -1) return;
  try {
    await sb.from('grounds').upsert(
      { user_id: currentUser.id, name: name },
      { onConflict: 'user_id,name' }
    );
    if (savedGrounds.indexOf(name) === -1) savedGrounds.push(name);
    savedGrounds.sort();
    populateGroundDropdown();
  } catch(e) { console.warn('saveGround error:', e); }
}

// ── Ground field UI ───────────────────────────────────────────
function populateGroundDropdown() {
  var sel = document.getElementById('f-ground');
  if (!sel) return;
  var current = sel.value;
  sel.innerHTML = '<option value="">Select ground…</option>';
  savedGrounds.forEach(function(g) {
    var opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    sel.appendChild(opt);
  });
  var custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Other / new ground…';
  sel.appendChild(custom);
  // Restore previous value if it exists
  if (current && current !== '__custom__') sel.value = current;
}

function handleGroundSelect(sel) {
  var customInput = document.getElementById('f-ground-custom');
  if (sel.value === '__custom__') {
    customInput.style.display = 'block';
    customInput.focus();
  } else {
    customInput.style.display = 'none';
    customInput.value = '';
  }
}

function getGroundValue() {
  var sel = document.getElementById('f-ground');
  if (sel.value === '__custom__') {
    return document.getElementById('f-ground-custom').value.trim() || null;
  }
  return sel.value || null;
}

function setGroundValue(val) {
  var sel = document.getElementById('f-ground');
  var customInput = document.getElementById('f-ground-custom');
  if (!sel) return;
  // Check if value exists in options
  var found = false;
  for (var i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value === val) { found = true; break; }
  }
  if (found) {
    sel.value = val;
    customInput.style.display = 'none';
  } else if (val) {
    sel.value = '__custom__';
    customInput.style.display = 'block';
    customInput.value = val;
  } else {
    sel.value = '';
    customInput.style.display = 'none';
  }
}

function renderGroundPills() {} // no-op, kept for compatibility
function showGroundPills() {}
function hideGroundPills() {}
function selectGroundPill() {}

// ── Ground Targets ────────────────────────────────────────────
async function loadGroundTargets(season) {
  if (!sb || !currentUser) return;
  try {
    var r = await sb.from('ground_targets')
      .select('ground, species, sex, target')
      .eq('user_id', currentUser.id)
      .eq('season', season);
    groundTargets = {};
    if (r.data) {
      r.data.forEach(function(row) {
        if (!groundTargets[row.ground]) groundTargets[row.ground] = {};
        groundTargets[row.ground][row.species + '-' + row.sex] = row.target;
      });
    }
  } catch(e) { console.warn('loadGroundTargets error:', e); }
}

function hasGroundTargets() {
  return Object.keys(groundTargets).some(function(g) {
    return Object.keys(groundTargets[g]).some(function(k) {
      return groundTargets[g][k] > 0;
    });
  });
}

// ── Targets sheet mode ────────────────────────────────────────
function setTargetMode(mode) {
  targetMode = mode;
  document.getElementById('tmode-season').classList.toggle('on', mode === 'season');
  document.getElementById('tmode-ground').classList.toggle('on', mode === 'ground');
  document.getElementById('tmode-season-body').style.display = mode === 'season' ? 'block' : 'none';
  document.getElementById('tmode-ground-body').style.display = mode === 'ground' ? 'block' : 'none';
  if (mode === 'ground') renderGroundSections();
}

function makeSpeciesSteppers(prefix) {
  return PLAN_SPECIES.map(function(sp) {
    var mid = prefix + '_' + sp.key + 'm';
    var fid = prefix + '_' + sp.key + 'f';
    return '<div class="tgrid-row">'
      + '<div class="tgrid-sp"><div class="tgrid-dot" style="background:' + sp.color + ';"></div>' + sp.name + '</div>'
      + '<div class="tstepper"><button class="tstep-btn" onclick="gtStep(\'' + mid + '\',-1)">−</button>'
      + '<input class="tstep-val" id="' + mid + '" type="number" value="0" min="0" onchange="updateGroundRollup()">'
      + '<button class="tstep-btn" onclick="gtStep(\'' + mid + '\',1)">+</button></div>'
      + '<div class="tstepper"><button class="tstep-btn" onclick="gtStep(\'' + fid + '\',-1)">−</button>'
      + '<input class="tstep-val" id="' + fid + '" type="number" value="0" min="0" onchange="updateGroundRollup()">'
      + '<button class="tstep-btn" onclick="gtStep(\'' + fid + '\',1)">+</button></div>'
      + '</div>';
  }).join('');
}

function gtStep(id, delta) {
  var el = document.getElementById(id);
  if (el) { el.value = Math.max(0, (parseInt(el.value)||0) + delta); updateGroundRollup(); }
}

function renderGroundSections() {
  var container = document.getElementById('tground-sections');
  if (!container) return;

  if (savedGrounds.length === 0) {
    // Update label
  var lbl = document.getElementById('ground-mgmt-lbl');
  if (lbl) lbl.textContent = 'No grounds yet';
  container.innerHTML = '<div style="padding:12px 0 8px;text-align:center;font-size:12px;color:var(--muted);">No grounds yet — add one above.</div>';
  return;
  }

  // Update ground count label
  var lbl = document.getElementById('ground-mgmt-lbl');
  if (lbl) lbl.textContent = savedGrounds.length + ' ground' + (savedGrounds.length === 1 ? '' : 's');

  var html = '';
  savedGrounds.forEach(function(g, i) {
    var gTargets = groundTargets[g] || {};
    var total = Object.values(gTargets).reduce(function(s,v){ return s+v; }, 0);
    var summary = total > 0
      ? PLAN_SPECIES.filter(function(sp){ return (gTargets[sp.name+'-m']||0)+(gTargets[sp.name+'-f']||0)>0; })
          .map(function(sp){ return sp.name.split(' ')[0]+': ♂'+(gTargets[sp.name+'-m']||0)+' ♀'+(gTargets[sp.name+'-f']||0); })
          .join(' · ')
      : 'No targets set';
    var prefix = 'gt_' + i;
    var dotColor = ['#5a7a30','#c8a84b','#f57f17','#6a1b9a','#1565c0'][i % 5];

    html += '<div class="tground-section">'
      + '<div class="tground-hdr" onclick="toggleGroundSection(\'' + prefix + '\')">'
      + '<div class="tground-hdr-l"><div class="tground-dot" style="background:' + dotColor + ';"></div>'
      + '<div><div class="tground-name">' + esc(g) + '</div>'
      + '<div class="tground-summary">' + esc(summary) + '</div></div></div>'
      + '<div style="display:flex;align-items:center;gap:4px;">'
      + '<button class="tground-del" data-gi="' + i + '" onclick="event.stopPropagation();deleteGroundByIdx(this)" title="Remove">✕</button>'
      + '<div class="tground-chev" id="' + prefix + '_chev">▾</div>'
      + '</div>'
      + '</div>'
      + '<div class="tground-body" id="' + prefix + '_body">'
      + '<div class="tgrid-hdr"><div class="tgrid-col">Species</div>'
      + '<div class="tgrid-col tgrid-hdr-col"><span class="tg-sym">♂</span>Stag / Buck</div>'
      + '<div class="tgrid-col tgrid-hdr-col"><span class="tg-sym">♀</span>Hind / Doe</div></div>'
      + makeSpeciesSteppers(prefix)
      + '</div></div>';
  });
  container.innerHTML = html;

  // Populate with existing targets
  savedGrounds.forEach(function(g, i) {
    var gTargets = groundTargets[g] || {};
    var prefix = 'gt_' + i;
    PLAN_SPECIES.forEach(function(sp) {
      var mel = document.getElementById(prefix + '_' + sp.key + 'm');
      var fel = document.getElementById(prefix + '_' + sp.key + 'f');
      if (mel) mel.value = gTargets[sp.name+'-m'] || 0;
      if (fel) fel.value = gTargets[sp.name+'-f'] || 0;
    });
  });

  // Render unassigned steppers
  var uSteppers = document.getElementById('tunassigned-steppers');
  if (uSteppers) {
    uSteppers.innerHTML = makeSpeciesSteppers('gt_u');
    var uTargets = groundTargets['__unassigned__'] || {};
    PLAN_SPECIES.forEach(function(sp) {
      var mel = document.getElementById('gt_u_' + sp.key + 'm');
      var fel = document.getElementById('gt_u_' + sp.key + 'f');
      if (mel) mel.value = uTargets[sp.name+'-m'] || 0;
      if (fel) fel.value = uTargets[sp.name+'-f'] || 0;
    });
  }

  updateGroundRollup();
}

function toggleGroundSection(prefix) {
  var body = document.getElementById(prefix + '_body');
  var chev = document.getElementById(prefix + '_chev');
  if (!body) return;
  var open = body.classList.contains('open');
  body.classList.toggle('open', !open);
  if (chev) chev.classList.toggle('open', !open);
}

function updateGroundRollup() {
  var rollup = document.getElementById('trollup');
  if (!rollup) return;
  var lines = '';
  var grandTotal = 0;
  savedGrounds.forEach(function(g, i) {
    var prefix = 'gt_' + i;
    var total = 0;
    PLAN_SPECIES.forEach(function(sp) {
      var m = parseInt((document.getElementById(prefix+'_'+sp.key+'m')||{}).value||0);
      var f = parseInt((document.getElementById(prefix+'_'+sp.key+'f')||{}).value||0);
      total += m + f;
    });
    grandTotal += total;
    lines += '<div class="trollup-row"><span class="trollup-lbl">' + esc(g) + '</span><span class="trollup-val">' + total + '</span></div>';
  });
  // Unassigned
  var uTotal = 0;
  PLAN_SPECIES.forEach(function(sp) {
    var m = parseInt((document.getElementById('gt_u_'+sp.key+'m')||{}).value||0);
    var f = parseInt((document.getElementById('gt_u_'+sp.key+'f')||{}).value||0);
    uTotal += m + f;
  });
  if (uTotal > 0) {
    grandTotal += uTotal;
    lines += '<div class="trollup-row"><span class="trollup-lbl">Unassigned</span><span class="trollup-val">' + uTotal + '</span></div>';
  }
  rollup.innerHTML = lines
    + '<div class="trollup-total"><span class="trollup-total-lbl">Season total</span><span class="trollup-total-val">' + grandTotal + ' targets</span></div>';
}

// ── Save targets (both modes) ─────────────────────────────────
async function saveGroundTargets() {
  if (!sb || !currentUser) return;
  var rows = [];

  // Per-ground targets
  savedGrounds.forEach(function(g, i) {
    var prefix = 'gt_' + i;
    PLAN_SPECIES.forEach(function(sp) {
      var m = parseInt((document.getElementById(prefix+'_'+sp.key+'m')||{}).value||0);
      var f = parseInt((document.getElementById(prefix+'_'+sp.key+'f')||{}).value||0);
      rows.push({ user_id:currentUser.id, season:currentSeason, ground:g, species:sp.name, sex:'m', target:m });
      rows.push({ user_id:currentUser.id, season:currentSeason, ground:g, species:sp.name, sex:'f', target:f });
    });
  });

  // Unassigned buffer
  PLAN_SPECIES.forEach(function(sp) {
    var m = parseInt((document.getElementById('gt_u_'+sp.key+'m')||{}).value||0);
    var f = parseInt((document.getElementById('gt_u_'+sp.key+'f')||{}).value||0);
    rows.push({ user_id:currentUser.id, season:currentSeason, ground:'__unassigned__', species:sp.name, sex:'m', target:m });
    rows.push({ user_id:currentUser.id, season:currentSeason, ground:'__unassigned__', species:sp.name, sex:'f', target:f });
  });

  var r = await sb.from('ground_targets')
    .upsert(rows, { onConflict: 'user_id,season,ground,species,sex' });
  if (r.error) throw r.error;
  await loadGroundTargets(currentSeason);
}

// ── Plan card ground filter ───────────────────────────────────
function renderPlanGroundFilter() {
  var bar = document.getElementById('plan-ground-filter');
  if (!bar) return;

  var useGrounds = hasGroundTargets();
  if (!useGrounds) { bar.style.display = 'none'; return; }

  bar.style.display = 'flex';
  var grounds = Object.keys(groundTargets).filter(function(g){ return g !== '__unassigned__'; });
  var hasUnassigned = groundTargets['__unassigned__'] &&
    Object.values(groundTargets['__unassigned__']).some(function(v){ return v > 0; });

  var chips = [{key:'overview', label:'Overview'}];
  grounds.forEach(function(g) { chips.push({key:g, label:g}); });
  if (hasUnassigned) chips.push({key:'__unassigned__', label:'Unassigned'});

  bar.innerHTML = chips.map(function(c) {
    var on = c.key === planGroundFilter;
    return '<div class="pgf-chip' + (on?' on':'') + '" onclick="setPlanGroundFilter(\'' + esc(c.key).replace(/'/g,"\'") + '\')">' + esc(c.label) + '</div>';
  }).join('');
}

function setPlanGroundFilter(key) {
  planGroundFilter = key;
  renderPlanGroundFilter();
  renderPlanCard(allEntries, currentSeason);
}


// ── Ground Stats ───────────────────────────────────────────────
function buildGroundStats(entries) {
  var card  = document.getElementById('ground-card');
  var chart = document.getElementById('ground-chart');
  if (!card || !chart) return;

  // Group by ground — blank ground = 'Untagged'
  var counts = {};
  entries.forEach(function(e) {
    var g = (e.ground && e.ground.trim()) ? e.ground.trim() : null;
    if (g) counts[g] = (counts[g]||0) + 1;
    else   counts['__untagged__'] = (counts['__untagged__']||0) + 1;
  });

  var grounds = Object.keys(counts).filter(function(g){ return g !== '__untagged__'; });

  // Hide if only one ground or no grounds at all
  if (grounds.length === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  grounds.sort(function(a,b){ return counts[b]-counts[a]; });
  var maxCnt = Math.max.apply(null, grounds.map(function(g){ return counts[g]; }).concat([1]));

  var html = '';
  grounds.forEach(function(g, i) {
    var cnt = counts[g];
    var pct = Math.round(cnt/maxCnt*100);
    var barClr = i === 0
      ? 'linear-gradient(90deg,#5a7a30,#7adf7a)'
      : 'linear-gradient(90deg,#c8a84b,#f0c870)';
    html += '<div class="bar-row">'
      + '<div class="bar-lbl">' + esc(g) + '</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+barClr+';"></div></div>'
      + '<div class="bar-cnt">'+cnt+'</div>'
      + '</div>';
  });

  // Untagged at bottom in grey if any
  if (counts['__untagged__']) {
    var uCnt = counts['__untagged__'];
    var uPct = Math.round(uCnt/maxCnt*100);
    html += '<div class="bar-row">'
      + '<div class="bar-lbl" style="color:var(--muted);font-style:italic;">Untagged</div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:'+uPct+'%;background:#e0dcd6;"></div></div>'
      + '<div class="bar-cnt" style="color:var(--muted);">'+uCnt+'</div>'
      + '</div>';
  }

  chart.innerHTML = html;
}


// ── Ground Management (add / delete from targets sheet) ───────
function showAddGroundInput() {
  var row = document.getElementById('ground-add-row');
  var inp = document.getElementById('ground-add-inp');
  if (row) { row.style.display = 'flex'; }
  if (inp) { inp.value = ''; inp.focus(); }
}

function hideAddGroundInput() {
  var row = document.getElementById('ground-add-row');
  if (row) row.style.display = 'none';
}

async function confirmAddGround() {
  var inp = document.getElementById('ground-add-inp');
  var name = inp ? inp.value.trim() : '';
  if (!name) { showToast('⚠️ Enter a ground name'); return; }
  if (savedGrounds.indexOf(name) !== -1) { showToast('⚠️ Ground already exists'); return; }

  await saveGround(name);
  hideAddGroundInput();
  renderGroundSections();
  showToast('✅ ' + name + ' added');
}

// Called from dynamically generated buttons using data-gi index attribute
function deleteGroundByIdx(btn) {
  var idx = parseInt(btn.getAttribute('data-gi'));
  if (isNaN(idx) || idx < 0 || idx >= savedGrounds.length) return;
  deleteGround(savedGrounds[idx]);
}

async function deleteGround(name) {
  if (!confirm('Remove "' + name + '"? Any targets set for this ground will also be deleted.')) return;
  if (!sb || !currentUser) return;

  try {
    // Remove from grounds table
    await sb.from('grounds')
      .delete()
      .eq('user_id', currentUser.id)
      .eq('name', name);

    // Remove ground targets for this ground
    await sb.from('ground_targets')
      .delete()
      .eq('user_id', currentUser.id)
      .eq('ground', name);

    // Remove from local array
    savedGrounds = savedGrounds.filter(function(g){ return g !== name; });
    delete groundTargets[name];

    renderGroundSections();
    showToast('🗑 ' + name + ' removed');
  } catch(e) {
    showToast('⚠️ Could not remove ground');
    console.warn('deleteGround error:', e);
  }
}


// ── Summary Filter ──────────────────────────────────────────
function openSummaryFilter() {
  var modal = document.getElementById('summary-filter-modal');
  if (!allEntries.length) { showToast('⚠️ No entries to export'); return; }

  // Populate season dropdown
  var seasonSel = document.getElementById('summary-season-sel');
  seasonSel.innerHTML = '<option value="__all__">All Seasons</option>';
  // Get all unique seasons from allEntries
  var seasonSet = {};
  allEntries.forEach(function(e) {
    var s = buildSeasonFromEntry(e.date);
    seasonSet[s] = true;
  });
  // Also add current season
  seasonSet[currentSeason] = true;
  var seasons = Object.keys(seasonSet).sort().reverse();
  seasons.forEach(function(s) {
    var opt = document.createElement('option');
    opt.value = s;
    opt.textContent = seasonLabel(s);
    if (s === currentSeason) opt.selected = true;
    seasonSel.appendChild(opt);
  });

  // Populate ground dropdown
  var groundSel = document.getElementById('summary-ground-sel');
  groundSel.innerHTML = '<option value="__all__">All grounds</option>';
  var groundSet = {};
  allEntries.forEach(function(e) {
    if (e.ground && e.ground.trim()) groundSet[e.ground.trim()] = true;
  });
  Object.keys(groundSet).sort().forEach(function(g) {
    var opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    groundSel.appendChild(opt);
  });

  // Update preview count on change
  function updateCount() {
    var sel = getFilteredSummaryEntries();
    document.getElementById('summary-count').textContent = sel.length;
  }
  seasonSel.onchange = updateCount;
  groundSel.onchange = updateCount;
  updateCount();

  modal.style.display = 'flex';
}

function getFilteredSummaryEntries() {
  var season = document.getElementById('summary-season-sel').value;
  var ground = document.getElementById('summary-ground-sel').value;
  return allEntries.filter(function(e) {
    var inSeason = season === '__all__' || buildSeasonFromEntry(e.date) === season;
    var inGround = ground === '__all__' || (e.ground && e.ground.trim() === ground);
    return inSeason && inGround;
  });
}

function doExportSummaryFiltered() {
  var entries = getFilteredSummaryEntries();
  if (!entries.length) { showToast('⚠️ No entries match selection'); return; }

  var season = document.getElementById('summary-season-sel').value;
  var ground = document.getElementById('summary-ground-sel').value;
  var groundLabel = ground === '__all__' ? 'All Grounds' : ground;
  var seasonForPdf = season === '__all__' ? currentSeason : season;

  document.getElementById('summary-filter-modal').style.display = 'none';

  // Set globals for PDF header/filename
  window._summarySeasonLabel = season === '__all__' ? 'All Seasons' : null;
  window._summaryGroundOverride = groundLabel !== 'All Grounds' ? groundLabel : null;

  // Swap allEntries and currentSeason, generate PDF, then restore
  var _allEntries = allEntries;
  var _currentSeason = currentSeason;
  allEntries = entries;
  currentSeason = seasonForPdf;

  exportSeasonSummary();

  allEntries = _allEntries;
  currentSeason = _currentSeason;
  delete window._summarySeasonLabel;
  delete window._summaryGroundOverride;
}


// ── Offline photo storage warning ──────────────────────────
function offlinePhotoWarn(callback) {
  if (navigator.onLine) { callback(); return; }
  // Estimate current offline queue size
  var queueStr = localStorage.getItem(OFFLINE_KEY) || '';
  var kb = Math.round(queueStr.length / 1024);
  var remaining = Math.max(0, 5000 - kb);
  if (remaining < 400) {
    // Under 400KB remaining — warn strongly
    if (!confirm('⚠️ Low offline storage (' + remaining + 'KB left). Adding a photo may prevent this entry from being saved offline. Continue without photo instead?')) {
      return;
    }
  } else {
    showToast('📶 Offline — photo will be stored locally (~200KB) until synced');
  }
  callback();
}


// ── Pin map location search ──────────────────────────────────
var _pinSearchTimer = null;

function pinmapSearchDebounce(val) {
  clearTimeout(_pinSearchTimer);
  if (!val.trim()) { document.getElementById('pinmap-search-results').style.display = 'none'; return; }
  _pinSearchTimer = setTimeout(function() { pinmapSearchNow(val); }, 500);
}

function pinmapSearchNow(val) {
  if (!val.trim()) return;
  var resultsEl = document.getElementById('pinmap-search-results');
  resultsEl.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:rgba(255,255,255,0.5);">Searching…</div>';
  resultsEl.style.display = 'block';
  fetch('https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(val) + '&format=json&countrycodes=gb&limit=5&addressdetails=1')
    .then(function(r) { return r.json(); })
    .then(function(results) {
      if (!results.length) {
        resultsEl.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:rgba(255,255,255,0.4);">No results found</div>';
        return;
      }
      resultsEl.innerHTML = results.map(function(r) {
        var name = r.display_name.split(',').slice(0,3).join(', ');
        var enc = encodeURIComponent(name);
        return '<div onclick="pinmapSelectResult(' + r.lat + ',' + r.lon + ',decodeURIComponent(\'' + enc + '\'))" '
          + 'style="padding:10px 14px;font-size:12px;color:white;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.08);">'
          + '<div style="font-weight:600;">' + name + '</div>'
          + '</div>';
      }).join('');
    })
    .catch(function() {
      resultsEl.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:rgba(255,255,255,0.4);">Search failed — check connection</div>';
    });
}

function pinmapSelectResult(lat, lng, name) {
  document.getElementById('pinmap-search-results').style.display = 'none';
  document.getElementById('pinmap-search').value = name;
  if (pinMap) {
    pinMap.setView([lat, lng], 14);
  }
}


function openPhotoLightbox(url) {
  var lb = document.getElementById('photo-lightbox');
  var img = document.getElementById('photo-lightbox-img');
  img.src = url;
  lb.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function closePhotoLightbox() {
  document.getElementById('photo-lightbox').style.display = 'none';
  document.getElementById('photo-lightbox-img').src = '';
  document.body.style.overflow = '';
}

