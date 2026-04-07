/* Deer School — Quiz Engine v2.0 */

// ── block ──
// ══════════════════════════════════════════════════════════════
// QUESTION BANK — 300 questions across 10 batches
// ══════════════════════════════════════════════════════════════


// Tag each question with its bank index for spaced repetition tracking
(function() { for (var _bi = 0; _bi < QUESTION_BANK.length; _bi++) { QUESTION_BANK[_bi]._bankIdx = _bi; } }());

// ══════════════════════════════════════════════════════════════
// APP STATE & STORAGE
// ══════════════════════════════════════════════════════════════
var STORAGE_KEY = 'fl_groundschool';
var state = loadState();
var quizQuestions = [];
var currentQIdx = 0;
var quizAnswers = [];  // {correct: bool, category: str}
var lastMode = 'quick';
var wrongQuestions = [];

function loadState() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : defaultState();
  } catch(e) { return defaultState(); }
}

function defaultState() {
  return {
    disclaimerAccepted: false,
    recentScores: [],   // last 5 scores as percentages
    catStats: {},       // { 'Biology': {correct:0, total:0}, ... }
    qWeights: {}        // { questionIdx: weight } — spaced repetition weights
  };
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
}

// ── Routing ────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(function(v){ v.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
  window.scrollTo(0,0);
}

function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 2500);
}

// ── Disclaimer ─────────────────────────────────────────────────
function acceptDisclaimer() {
  state.disclaimerAccepted = true;
  saveState();
  showView('v-dashboard');
  refreshDashboard();
}

// ── Dashboard ──────────────────────────────────────────────────
function refreshDashboard() {
  // Refresh spaced repetition badge
  (function() {
    var badge = document.getElementById('spaced-badge');
    if (badge && state.qWeights) {
      var hasWeak = Object.keys(state.qWeights).some(function(k){ return state.qWeights[k] >= 2; });
      badge.style.display = hasWeak ? 'block' : 'none';
    }
  }());
  renderReadiness();
  renderCatStats();
  updateSpacedBtn();
}

function updateSpacedBtn() {
  var sub = document.getElementById('spaced-btn-sub');
  var btn = document.getElementById('spaced-btn');
  if (!sub || !btn) return;

  var hasWeights = state.qWeights && Object.keys(state.qWeights).length > 0;
  var weakCount = hasWeights
    ? Object.keys(state.qWeights).filter(function(k){ return state.qWeights[k] >= 2; }).length
    : 0;

  if (!hasWeights || weakCount === 0) {
    // New user or no weak areas yet — disable
    btn.disabled = true;
    btn.style.opacity = '0.45';
    btn.style.cursor = 'not-allowed';
    sub.textContent = 'Complete some quizzes first to unlock';
  } else {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    sub.textContent = weakCount + ' weak question' + (weakCount === 1 ? '' : 's') + ' to review';
  }
}

function readinessPct() {
  // Filter out any NaN or non-number values from corrupted saves
  var valid = state.recentScores.filter(function(s) { return typeof s === 'number' && !isNaN(s); });
  state.recentScores = valid; // clean up stored state
  if (!valid.length) return null;
  var sum = valid.reduce(function(a,b){ return a+b; }, 0);
  return Math.round(sum / valid.length);
}

function renderReadiness() {
  var pct = readinessPct();
  var pctEl = document.getElementById('readiness-pct');
  var barEl = document.getElementById('readiness-bar');
  var noteEl = document.getElementById('readiness-note');
  var pillsEl = document.getElementById('score-pills');

  if (pct === null) {
    pctEl.innerHTML = '–<span>%</span>';
    barEl.style.width = '0%';
    barEl.style.background = 'var(--muted)';
    noteEl.textContent = 'Complete a session to see your readiness score. Pass mark is 80%.';
    pillsEl.innerHTML = '';
    return;
  }

  var icon = pct >= 80 ? '✓' : pct >= 60 ? '~' : '✕';
  pctEl.innerHTML = '<span style="font-size:0.6em;margin-right:3px;">' + icon + '</span>' + pct + '<span>%</span>';
  barEl.style.width = pct + '%';
  barEl.style.background = pct >= 80
    ? 'linear-gradient(90deg,#2d7a1a,#7adf7a)'
    : pct >= 60
    ? 'linear-gradient(90deg,#e65100,#ff8f00)'
    : 'linear-gradient(90deg,#b71c1c,#e53935)';

  var verdict = pct >= 80 ? 'Looking good — keep it up!'
    : pct >= 60 ? 'Getting there — focus on weak areas.'
    : 'Needs work — study the explanations carefully.';
  noteEl.textContent = 'Rolling average of last ' + state.recentScores.length + ' session' + (state.recentScores.length>1?'s':'') + '. ' + verdict;

  pillsEl.innerHTML = state.recentScores.map(function(s, i) {
    var cls = s >= 80 ? 'pass' : 'fail';
    return '<span class="score-pill ' + cls + '">' + s + '%</span>';
  }).join('');
}

var CAT_COLORS = {
  'Biology': '#5a7a30',
  'Identification': '#c8a84b',
  'Legislation': '#1565c0',
  'Safety': '#c62828',
  'Fieldcraft': '#f57f17',
  'Ballistics': '#6a1b9a',
  'Meat Hygiene': '#00695c',
  'Disease & Management': '#795548'
};

function renderCatStats() {
  var el = document.getElementById('cat-stats');
  var cats = Object.keys(state.catStats);
  if (!cats.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--muted);text-align:center;padding:8px 0;">No sessions completed yet.</div>';
    return;
  }
  el.innerHTML = cats.map(function(cat) {
    var s = state.catStats[cat];
    var pct = s.total ? Math.round(s.correct / s.total * 100) : 0;
    var clr = CAT_COLORS[cat] || '#5a7a30';
    return '<div class="cat-row">'
      + '<div class="cat-name">' + cat + '</div>'
      + '<div class="cat-bar-wrap"><div class="cat-bar" style="width:'+pct+'%;background:'+clr+';"></div></div>'
      + '<div class="cat-pct">' + pct + '%</div>'
      + '</div>';
  }).join('');
}

function confirmReset() {
  if (confirm('Reset all progress? This cannot be undone.')) {
    state = defaultState();
    state.disclaimerAccepted = true;
    saveState();
    refreshDashboard();
    showToast('Progress reset');
  }
}

// ── Fisher-Yates shuffle ───────────────────────────────────────
function shuffle(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// ── Start quiz ─────────────────────────────────────────────────
// Timer state
var timerInterval = null;
var timerSeconds = 0;

function clearTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  var el = document.getElementById('quiz-timer');
  if (el) el.style.display = 'none';
}

function startTimer(totalSeconds) {
  clearTimer();
  timerSeconds = totalSeconds;
  var el = document.getElementById('quiz-timer');
  if (!el) return;
  el.style.display = 'block';
  el.classList.remove('warn');

  function tick() {
    var m = Math.floor(timerSeconds / 60);
    var s = timerSeconds % 60;
    el.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    if (timerSeconds <= 60) el.classList.add('warn');
    if (timerSeconds <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      showToast('⏱ Time is up!');
      finishQuiz();
      return;
    }
    timerSeconds--;
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

function weightedSample(pool, count) {
  // Weighted sampling without replacement — high-weight Qs appear more often
  var weights = pool.map(function(q) { return (state.qWeights && state.qWeights[q._bankIdx]) || 1; });
  var totalWeight = weights.reduce(function(a,b){ return a+b; }, 0);
  var result = [];
  var available = pool.map(function(q,i){ return { q:q, w:weights[i] }; });
  while (result.length < count && available.length > 0) {
    var r = Math.random() * available.reduce(function(a,b){ return a+b.w; }, 0);
    var cum = 0;
    for (var i = 0; i < available.length; i++) {
      cum += available[i].w;
      if (r <= cum) {
        result.push(available[i].q);
        available.splice(i, 1);
        break;
      }
    }
  }
  return result;
}

function startQuiz(mode, categoryFilter) {
  lastMode = mode;
  clearTimer();
  var pool = categoryFilter
    ? QUESTION_BANK.filter(function(q){ return q.category === categoryFilter; })
    : QUESTION_BANK;

  var count = mode === 'mock' ? 50 : 10;
  var quizQs;
  if (mode === 'spaced') {
    // Only include genuinely weak questions (weight >= 2), cap at 20, randomised
    var weakPool = pool.filter(function(q) {
      return state.qWeights && state.qWeights[q._bankIdx] >= 2;
    });
    if (weakPool.length === 0) weakPool = pool; // fallback
    quizQs = shuffle(weakPool).slice(0, Math.min(20, weakPool.length));
  } else {
    quizQs = shuffle(pool).slice(0, Math.min(count, pool.length));
  }
  quizQuestions = quizQs;
  currentQIdx = 0;
  quizAnswers = [];
  wrongQuestions = [];
  showView('v-quiz');
  renderQuestion();

  // Timer only for mock exam
  if (mode === 'mock') {
    startTimer(45 * 60); // 45 minutes
  }
}

function renderQuestion() {
  var q = quizQuestions[currentQIdx];
  var total = quizQuestions.length;
  var pct = Math.round(currentQIdx / total * 100);

  var badge = document.getElementById('quiz-cat-badge');
  badge.textContent = lastMode === 'spaced' ? '🧠 ' + q.category : q.category;
  document.getElementById('quiz-progress-bar').style.width = pct + '%';
  document.getElementById('quiz-count').textContent = 'Question ' + (currentQIdx+1) + ' of ' + total;
  document.getElementById('q-num').textContent = 'Q' + (currentQIdx+1);
  document.getElementById('q-text').textContent = q.question;

  // Options
  var wrap = document.getElementById('options-wrap');
  wrap.innerHTML = '';
  q.options.forEach(function(opt, i) {
    var btn = document.createElement('button');
    btn.className = 'opt-btn';
    btn.textContent = opt;
    btn.onclick = function() { selectAnswer(i); };
    wrap.appendChild(btn);
  });

  // In review mode — pre-highlight the previously wrong answer
  if (lastMode === 'review' && q._reviewSelectedIndex !== undefined) {
    var btns = wrap.querySelectorAll('.opt-btn');
    btns.forEach(function(b) { b.classList.add('disabled'); b.onclick = null; });
    btns[q.correctIndex].classList.add('reveal-correct');
    if (q._reviewSelectedIndex !== q.correctIndex) {
      btns[q._reviewSelectedIndex].classList.add('selected-incorrect');
    }
    document.getElementById('explanation-text').textContent = q.explanation;
    document.getElementById('explanation-card').style.display = 'block';
    document.getElementById('next-btn').classList.add('show');
    document.getElementById('next-btn').textContent = currentQIdx === quizQuestions.length - 1 ? 'Done' : 'Next →';
    return;
  }

  // Hide explanation and next
  document.getElementById('explanation-card').style.display = 'none';
  document.getElementById('next-btn').classList.remove('show');
}

function selectAnswer(idx) {
  var q = quizQuestions[currentQIdx];
  var buttons = document.querySelectorAll('.opt-btn');
  var correct = idx === q.correctIndex;

  // Record answer
  quizAnswers.push({ correct: correct, category: q.category, selectedIndex: idx, correctIndex: q.correctIndex, question: q.question, options: q.options, explanation: q.explanation, qIdx: q._bankIdx });
  if (!correct) wrongQuestions.push(currentQIdx);

  // Style buttons
  buttons.forEach(function(btn, i) {
    btn.classList.add('disabled');
    btn.onclick = null;
    if (i === q.correctIndex) btn.classList.add('reveal-correct');
    if (i === idx && !correct) btn.classList.add('selected-incorrect');
    if (i === idx && correct) btn.classList.add('selected-correct');
  });

  // Show explanation
  document.getElementById('explanation-text').textContent = q.explanation;
  document.getElementById('explanation-card').style.display = 'block';
  document.getElementById('next-btn').classList.add('show');
  document.getElementById('next-btn').textContent = currentQIdx === quizQuestions.length - 1 ? 'See Results →' : 'Next →';
}

function nextQuestion() {
  currentQIdx++;
  if (currentQIdx >= quizQuestions.length) {
    finishQuiz();
  } else {
    renderQuestion();
    // Scroll to top of quiz
    document.querySelector('#v-quiz .quiz-scroll').scrollTop = 0;
  }
}

function quitQuiz() {
  clearTimer();
  if (currentQIdx > 0) {
    if (!confirm('Quit this session? Progress will be lost.')) return;
  }
  showView('v-dashboard');
}

// ── Finish & results ───────────────────────────────────────────
function finishQuiz() {
  clearTimer();
  var correct = quizAnswers.filter(function(a){ return a.correct; }).length;
  var total = quizAnswers.length;
  var pct = Math.round(correct / total * 100);
  var pass = pct >= 80;

  // Save to state
  if (!isNaN(pct)) state.recentScores.push(pct);
  if (state.recentScores.length > 8) state.recentScores.shift();

  quizAnswers.forEach(function(a) {
    if (!state.catStats[a.category]) state.catStats[a.category] = {correct:0, total:0};
    state.catStats[a.category].total++;
    if (a.correct) state.catStats[a.category].correct++;
    // Spaced repetition: update question weight based on correctness
    if (a.qIdx !== undefined) {
      if (!state.qWeights) state.qWeights = {};
      var w = state.qWeights[a.qIdx] || 1;
      // Wrong → weight up (surfaces more); correct → weight down (surfaces less)
      state.qWeights[a.qIdx] = a.correct
        ? Math.max(1, Math.round(w * 0.6))
        : Math.min(20, Math.round(w * 2 + 1));
    }
  });
  saveState();

  // Render results
  document.getElementById('results-score').innerHTML = pct + '<span>%</span>';
  // Pass animation
  var passBanner = document.getElementById('pass-banner');
  if (passBanner) {
    if (pass) {
      passBanner.style.display = 'block';
      launchConfetti();
    } else {
      passBanner.style.display = 'none';
    }
  }
  var verdictEl = document.getElementById('results-verdict');
  verdictEl.textContent = pass ? '✅ PASS' : '❌ FAIL';
  verdictEl.className = 'results-verdict ' + (pass ? 'pass' : 'fail');
  document.getElementById('results-sub').textContent = correct + ' of ' + total + ' correct · ' + (lastMode === 'mock' ? 'Mock Exam' : 'Quick Quiz');

  // Category breakdown
  var catBreakdown = {};
  quizAnswers.forEach(function(a) {
    if (!catBreakdown[a.category]) catBreakdown[a.category] = {correct:0, total:0};
    catBreakdown[a.category].total++;
    if (a.correct) catBreakdown[a.category].correct++;
  });

  var html = '';
  Object.keys(catBreakdown).sort().forEach(function(cat) {
    var s = catBreakdown[cat];
    var p = Math.round(s.correct / s.total * 100);
    var cls = p >= 80 ? 'high' : p >= 60 ? 'mid' : 'low';
    html += '<div class="cat-result-row">'
      + '<div class="cat-result-name">' + cat + '</div>'
      + '<div class="cat-result-pct ' + cls + '">' + (cls==='high'?'✓ ':cls==='mid'?'~ ':'✕ ') + p + '% (' + s.correct + '/' + s.total + ')</div>'
      + '</div>';
  });
  document.getElementById('results-cat-breakdown').innerHTML = html;

  // Review button
  var reviewBtn = document.getElementById('review-btn');
  reviewBtn.style.display = wrongQuestions.length > 0 ? 'block' : 'none';

  showView('v-results');
}

function reviewWrong() {
  // Build review list from stored answer data
  var wrongs = quizAnswers.filter(function(a){ return !a.correct; });
  quizQuestions = wrongs.map(function(a){ return {
    category: a.category,
    question: a.question,
    options: a.options,
    correctIndex: a.correctIndex,
    explanation: a.explanation,
    _reviewSelectedIndex: a.selectedIndex
  }; });
  currentQIdx = 0;
  quizAnswers = [];
  wrongQuestions = [];
  lastMode = 'review';
  showView('v-quiz');
  renderQuestion();
}

// ── Init ───────────────────────────────────────────────────────
// ── Category Drill ────────────────────────────────────────────
var CAT_COLORS_DRILL = {
  'Biology': '#5a7a30', 'Identification': '#c8a84b', 'Legislation': '#1565c0',
  'Safety': '#c62828', 'Fieldcraft': '#f57f17', 'Ballistics': '#6a1b9a',
  'Meat Hygiene': '#00695c', 'Disease & Management': '#795548'
};

function showRefView() {
  showView('v-ref');
}

function showDrillView() {
  // Build category list with question counts
  var catCounts = {};
  QUESTION_BANK.forEach(function(q) {
    catCounts[q.category] = (catCounts[q.category] || 0) + 1;
  });
  var grid = document.getElementById('drill-grid');
  // Build buttons using DOM, not innerHTML, to avoid & encoding issues in onclick
  grid.innerHTML = '';
  Object.keys(CAT_COLORS_DRILL).forEach(function(cat) {
    var count = catCounts[cat] || 0;
    var clr = CAT_COLORS_DRILL[cat];
    var stats = state.catStats[cat];
    var pct = stats && stats.total ? Math.round(stats.correct / stats.total * 100) : null;

    var btn = document.createElement('button');
    btn.className = 'drill-cat-btn';
    btn.setAttribute('data-cat', cat);

    var dot = document.createElement('div');
    dot.className = 'drill-cat-dot';
    dot.style.background = clr;

    var info = document.createElement('div');
    info.className = 'drill-cat-info';
    info.innerHTML = '<div class="drill-cat-name">' + cat + '</div>'
      + '<div class="drill-cat-sub">' + count + ' questions available</div>';

    var pctEl = document.createElement('div');
    pctEl.className = 'drill-cat-pct';
    if (pct !== null) {
      pctEl.textContent = (pct >= 80 ? '✓ ' : pct >= 60 ? '~ ' : '✕ ') + pct + '%';
      pctEl.style.color = pct >= 80 ? '#2e7d32' : pct >= 60 ? '#f57f17' : '#c62828';
    } else {
      pctEl.textContent = '–';
      pctEl.style.color = 'var(--muted)';
    }

    btn.appendChild(dot);
    btn.appendChild(info);
    btn.appendChild(pctEl);

    btn.addEventListener('click', function() {
      startDrill(this.getAttribute('data-cat'));
    });

    grid.appendChild(btn);
  });
  showView('v-drill');
}

function startDrill(category) {
  startQuiz('drill', category);
}

// ── Pass Confetti ─────────────────────────────────────────────
function launchConfetti() {
  var container = document.getElementById('pass-banner');
  if (!container) return;
  var colors = ['#c8a84b','#5a7a30','#7adf7a','#f0c870','#1565c0','#c62828'];
  for (var i = 0; i < 18; i++) {
    (function(i) {
      setTimeout(function() {
        var el = document.createElement('div');
        el.className = 'confetti-piece';
        el.style.left = (10 + Math.random() * 80) + '%';
        el.style.top = (Math.random() * 20) + 'px';
        el.style.background = colors[Math.floor(Math.random() * colors.length)];
        el.style.animationDelay = (Math.random() * 0.4) + 's';
        el.style.animationDuration = (0.9 + Math.random() * 0.6) + 's';
        el.style.transform = 'rotate(' + (Math.random()*360) + 'deg)';
        container.appendChild(el);
        setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 2000);
      }, i * 60);
    })(i);
  }
}

// ── Quick Reference tab switching ─────────────────────────────
function switchRefTab(section) {
  document.querySelectorAll('.ref-section-block').forEach(function(el){ el.style.display = 'none'; });
  document.querySelectorAll('.ref-tab').forEach(function(el){ el.classList.remove('active'); });
  var target = document.getElementById('ref-' + section);
  if (target) target.style.display = 'block';
  document.querySelectorAll('.ref-tab[data-section="' + section + '"]').forEach(function(el){ el.classList.add('active'); });
}

document.addEventListener('DOMContentLoaded', function() {
  // Wire ref tabs
  document.querySelectorAll('.ref-tab[data-section]').forEach(function(btn) {
    btn.addEventListener('click', function() { switchRefTab(this.dataset.section); });
  });
});

// Assign bank indices to every question (used by spaced repetition)
QUESTION_BANK.forEach(function(q, i) { q._bankIdx = i; });

document.addEventListener('DOMContentLoaded', function() {
  // Show spaced badge if any question has weight >= 2
  (function() {
    var badge = document.getElementById('spaced-badge');
    if (badge && state.qWeights) {
      var hasWeak = Object.values(state.qWeights).some(function(w){ return w >= 2; });
      if (hasWeak) badge.style.display = 'block';
    }
  }());
  if (state.disclaimerAccepted) {
    showView('v-dashboard');
    refreshDashboard();
  }
  // else disclaimer view is already active
});

function showDisclaimer() {
  showView('v-disclaimer');
}
