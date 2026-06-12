'use strict';

/* ── Analytics ── */
function trackCalc(name, action) {
  if (action === 'used') {
    if (!window._calcTracked) window._calcTracked = {};
    if (window._calcTracked[name]) return;
    window._calcTracked[name] = true;
  }
  if (typeof gtag === 'function') gtag('event', 'calculator_' + action, { calculator: name });
}

const PAYOFF_LS_KEY = 'payoffCalc_v1';

const DEFAULTS = {
  loanBalance:    350000,
  interestRate:   6.75,
  remainingYears: 25,
  paymentType:    'monthly',   // 'monthly' | 'lumpsum'
  extraMonthly:   200,
  lumpSum:        10000,
  investReturn:   7,
};

let state = { ...DEFAULTS };
let payoffChart = null;

// ── Helpers ─────────────────────────────────────────────────────────
function fmt(n) {
  return '$' + Math.abs(Math.round(n)).toLocaleString();
}

function fmtMonths(mo) {
  if (!isFinite(mo) || mo <= 0) return '—';
  mo = Math.round(mo);
  const yrs = Math.floor(mo / 12);
  const mos = mo % 12;
  if (yrs === 0) return mo + ' mo';
  if (mos === 0) return yrs + (yrs === 1 ? ' yr' : ' yrs');
  return yrs + ' yr ' + mos + ' mo';
}

function fmtDate(d) {
  return d.toLocaleString('default', { month: 'short', year: 'numeric' });
}

function monthlyPmt(principal, annualRatePct, termMonths) {
  if (termMonths <= 0 || principal <= 0) return 0;
  if (annualRatePct === 0) return principal / termMonths;
  const r = annualRatePct / 100 / 12;
  const f = Math.pow(1 + r, termMonths);
  return principal * r * f / (f - 1);
}

// ── Amortization ─────────────────────────────────────────────────────
// Returns months to pay off, total interest paid, and monthly balance history.
// lump is applied to principal at month 0 (before first payment).
function amortize(balance, annualRate, nMonths, extraMo, lump) {
  const r = annualRate / 100 / 12;
  const P = monthlyPmt(balance, annualRate, nMonths);
  let bal = Math.max(0, balance - (lump || 0));
  let totalInterest = 0;
  const balHistory = [Math.round(bal)];
  let month = 0;

  while (bal > 0.01 && month < nMonths) {
    month++;
    const interest = bal * r;
    bal += interest;
    totalInterest += interest;
    const payment = Math.min(bal, P + (extraMo || 0));
    bal = Math.max(0, bal - payment);
    balHistory.push(Math.round(bal));
  }

  return { months: month, totalInterest, balHistory, P };
}

// ── Core calculation ─────────────────────────────────────────────────
function calculate() {
  const s = state;
  const n      = Math.round(s.remainingYears * 12);
  const r_inv  = s.investReturn / 100 / 12;
  const isLump = s.paymentType === 'lumpsum';
  const extraMo = isLump ? 0 : Math.max(0, s.extraMonthly || 0);
  const lump    = isLump ? Math.max(0, s.lumpSum || 0) : 0;

  const orig  = amortize(s.loanBalance, s.interestRate, n, 0, 0);
  const accel = amortize(s.loanBalance, s.interestRate, n, extraMo, lump);

  const monthsSaved   = orig.months - accel.months;
  const interestSaved = orig.totalInterest - accel.totalInterest;
  const nNew          = accel.months;

  // Opportunity cost: investment gain the extra dollars would have earned.
  // Both scenarios measured at the original payoff date so the comparison is fair.
  let oppCost = 0;
  if (isLump && lump > 0) {
    // Lump sum invested for the full original term
    oppCost = r_inv > 0 ? lump * (Math.pow(1 + r_inv, n) - 1) : 0;
  } else if (!isLump && extraMo > 0) {
    // Invest E/mo for nNew months, then let it grow for the remaining (n - nNew) months
    const totalInvested = extraMo * nNew;
    const fvAnnuity = r_inv > 0
      ? extraMo * (Math.pow(1 + r_inv, nNew) - 1) / r_inv
      : totalInvested;
    const fvGrown = fvAnnuity * Math.pow(1 + r_inv, Math.max(0, n - nNew));
    oppCost = Math.max(0, fvGrown - totalInvested);
  }

  // After early payoff, the freed-up standard payment can be invested for the remaining months
  const postPayoffMonths = Math.max(0, n - nNew);
  let postPayoffBenefit = 0;
  if (postPayoffMonths > 0 && orig.P > 0) {
    postPayoffBenefit = r_inv > 0
      ? orig.P * (Math.pow(1 + r_inv, postPayoffMonths) - 1) / r_inv
      : orig.P * postPayoffMonths;
  }

  const netBenefit = interestSaved + postPayoffBenefit - oppCost;

  const now        = new Date();
  const origPayoff = new Date(now.getFullYear(), now.getMonth() + orig.months);
  const newPayoff  = new Date(now.getFullYear(), now.getMonth() + accel.months);

  return {
    n, isLump, extraMo, lump,
    stdPayment: orig.P,
    origMonths: orig.months,
    newMonths:  nNew,
    monthsSaved,
    origTotalInterest: orig.totalInterest,
    newTotalInterest:  accel.totalInterest,
    interestSaved,
    oppCost,
    postPayoffBenefit,
    postPayoffMonths,
    netBenefit,
    origPayoff,
    newPayoff,
    origBalHistory: orig.balHistory,
    newBalHistory:  accel.balHistory,
  };
}

// ── Amortization table ────────────────────────────────────────────────
function renderAmortTable(r) {
  const container = document.getElementById('payoffAmortBody');
  if (!container) return;

  const noExtra = r.isLump ? r.lump === 0 : r.extraMo === 0;
  if (noExtra) {
    container.innerHTML = '<p style="font-size:13px;color:var(--text-muted)">Enter an extra payment amount above to see the side-by-side comparison.</p>';
    return;
  }

  const PREVIEW = 6;
  const SHOW = 12;
  const rMo = state.interestRate / 100 / 12;
  const stdPmt = r.stdPayment;

  function buildRows(startBal, extraMo) {
    const rows = [];
    let bal = startBal;
    for (let m = 1; m <= SHOW; m++) {
      if (bal <= 0.01) { rows.push(null); continue; }
      const interest = bal * rMo;
      const totalPmt = Math.min(bal + interest, stdPmt + extraMo);
      const principal = totalPmt - interest;
      bal = Math.max(0, bal - principal);
      rows.push({ m, pmt: totalPmt, principal, interest, balance: bal });
    }
    return rows;
  }

  const stdRows   = buildRows(state.loanBalance, 0);
  const accelBal  = r.isLump ? Math.max(0, state.loanBalance - r.lump) : state.loanBalance;
  const accelRows = buildRows(accelBal, r.isLump ? 0 : r.extraMo);

  function fc(n) { return '$' + Math.round(n).toLocaleString(); }

  let _tableIdx = 0;
  function buildTable(rows, title, accentColor) {
    const hdrs = '<tr><th>Mo</th><th>Pmt</th><th>Principal</th><th>Interest</th><th>Balance</th></tr>';
    function buildRow(row, i) {
      if (!row) return `<tr style="color:var(--text-muted)"><td>${i + 1}</td><td colspan="4" style="text-align:center;font-style:italic">Paid off</td></tr>`;
      return `<tr><td>${row.m}</td><td>${fc(row.pmt)}</td><td style="color:var(--green)">${fc(row.principal)}</td><td style="color:var(--red)">${fc(row.interest)}</td><td><strong>${fc(row.balance)}</strong></td></tr>`;
    }
    const previewTrs = rows.slice(0, PREVIEW).map((row, i) => buildRow(row, i)).join('');
    const restTrs    = rows.slice(PREVIEW).map((row, i) => buildRow(row, PREVIEW + i)).join('');
    const moreId = 'amortMore' + (_tableIdx++);
    return `<div>
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:${accentColor};text-transform:uppercase;margin-bottom:8px;padding-bottom:6px;border-bottom:2px solid ${accentColor}30">${title}</div>
      <table class="payoff-amort-table"><thead>${hdrs}</thead><tbody>${previewTrs}</tbody><tbody id="${moreId}" style="display:none">${restTrs}</tbody></table>
      <button class="payoff-amort-expand" data-target="${moreId}">Show all 12 months ↓</button>
    </div>`;
  }

  const accelLabel = r.isLump
    ? 'With ' + fmt(r.lump) + ' lump sum'
    : 'With +' + fmt(r.extraMo) + '/mo extra';

  container.innerHTML =
    '<div class="two-col" style="gap:20px;align-items:start">' +
    buildTable(stdRows, 'Standard Schedule', '#9ca3af') +
    buildTable(accelRows, accelLabel, '#16a34a') +
    '</div>';

  container.querySelectorAll('.payoff-amort-expand').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const tbody = document.getElementById(this.dataset.target);
      if (tbody) tbody.style.display = '';
      this.style.display = 'none';
    });
  });
}

// ── Chart ─────────────────────────────────────────────────────────────
function renderChart(r) {
  const ctx = document.getElementById('payoffChart');
  if (!ctx) return;

  const maxMonths = r.origMonths;
  const labels    = [];
  const origData  = [];
  const accelData = [];

  for (let m = 0; m <= maxMonths; m++) {
    labels.push(m % 12 === 0 ? 'Yr ' + (m / 12) : '');
    origData.push(r.origBalHistory[m] !== undefined ? r.origBalHistory[m] : 0);
    accelData.push(m < r.newBalHistory.length ? r.newBalHistory[m] : 0);
  }

  if (payoffChart) { payoffChart.destroy(); payoffChart = null; }

  Chart.defaults.font.family = "'Inter', sans-serif";

  payoffChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Standard payoff',
          data: origData,
          borderColor: '#9ca3af',
          borderDash: [5, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
        {
          label: 'With extra payments',
          data: accelData,
          borderColor: '#16a34a',
          backgroundColor: 'rgba(22,163,74,.08)',
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      aspectRatio: window.innerWidth <= 480 ? 2.0 : 3.5,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              const v = ctx.parsed.y;
              return ctx.dataset.label + ': $' + Math.round(v).toLocaleString();
            },
          },
        },
      },
      scales: {
        x: {
          grid: {
            color: ctx => ctx.index % 12 === 0 ? 'rgba(0,0,0,.07)' : 'transparent',
            lineWidth: 1,
          },
          ticks: {
            maxRotation: 0,
            font: { size: 11 },
            callback: function(val, i) { return labels[i] || ''; },
          },
        },
        y: {
          grid: { color: 'rgba(0,0,0,.04)' },
          ticks: {
            font: { size: 11 },
            callback: v => '$' + Math.round(v / 1000) + 'k',
          },
        },
      },
    },
  });
}

// ── Render ────────────────────────────────────────────────────────────
function render() {
  const r      = calculate();
  const noExtra = r.isLump ? r.lump === 0 : r.extraMo === 0;

  // ── Stat tiles ──
  const setTile = (id, text, colorClass) => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = text;
      el.className = 'refi-stat-value' + (colorClass ? ' ' + colorClass : '');
    }
  };

  setTile('stat-time-saved',
    noExtra ? '—' : fmtMonths(r.monthsSaved),
    (!noExtra && r.monthsSaved > 0) ? 'refi-stat-value--green' : ''
  );
  setTile('stat-interest-saved',
    noExtra ? '—' : fmt(r.interestSaved),
    (!noExtra && r.interestSaved > 0) ? 'refi-stat-value--green' : ''
  );

  const oppEl = document.getElementById('stat-opp-cost');
  const oppSub = document.getElementById('stat-opp-cost-sub');
  if (oppEl) oppEl.textContent = noExtra ? '—' : fmt(r.oppCost);
  if (oppSub) oppSub.textContent = noExtra ? 'est. investment gain' : `est. gain at ${state.investReturn}%`;

  setTile('stat-net',
    noExtra ? '—' : (r.netBenefit >= 0 ? '' : '-') + fmt(Math.abs(r.netBenefit)),
    noExtra ? '' : (r.netBenefit > 0 ? 'refi-stat-value--green' : 'refi-stat-value--red')
  );

  // ── Verdict ──
  const verdict = document.getElementById('payoffVerdict');
  if (verdict) {
    let cls, icon, heading, body;
    const rate = state.interestRate;
    const inv  = state.investReturn;

    const postPayoffStr = r.postPayoffMonths > 0 ? ` Paying off ${fmtMonths(r.monthsSaved)} early also frees up ${fmt(r.stdPayment)}/mo for ${fmtMonths(r.postPayoffMonths)} — estimated at ${fmt(r.postPayoffBenefit)} if invested (included in net benefit above).` : '';
    if (noExtra) {
      cls = 'refi-verdict--info'; icon = 'ℹ';
      heading = 'Enter an extra payment amount';
      body = 'Add a monthly extra payment or one-time lump sum above to see how it affects your payoff timeline, interest savings, and how it compares to investing the same dollars.';
    } else if (r.netBenefit > 0 && rate >= inv) {
      cls = 'refi-verdict--green'; icon = '✓';
      heading = 'Extra payments outperform investing';
      body = `Your mortgage rate (${rate}%) equals or exceeds your expected investment return (${inv}%), so every extra dollar toward principal delivers a guaranteed return that beats the market on your own assumptions. You'd save ${fmt(r.interestSaved)} in interest.${postPayoffStr}`;
    } else if (r.netBenefit > 0) {
      cls = 'refi-verdict--green'; icon = '✓';
      heading = 'Extra payments come out ahead';
      body = `Even with an expected investment return of ${inv}%, extra payments come out ${fmt(r.netBenefit)} ahead — combining ${fmt(r.interestSaved)} in interest savings and ${fmt(r.postPayoffBenefit)} in freed-up payments invested after payoff, against an estimated ${fmt(r.oppCost)} gain if the extra payments had been invested instead.`;
    } else if (Math.abs(r.netBenefit) < r.interestSaved * 0.15) {
      cls = 'refi-verdict--amber'; icon = '⚠';
      heading = 'Close call — largely a personal finance decision';
      body = `At ${inv}% expected investment return, the two paths are nearly equivalent. Extra payments offer a guaranteed ${rate}% return; investing offers a potentially higher but uncertain return. Either is reasonable.${postPayoffStr}`;
    } else {
      cls = 'refi-verdict--info'; icon = 'ℹ';
      heading = `Investing may outperform at ${inv}%`;
      body = `At your expected investment return of ${inv}%, investing the same dollars would earn an estimated ${fmt(r.oppCost)} in gains — more than the ${fmt(r.interestSaved)} in interest savings plus ${fmt(r.postPayoffBenefit)} in freed-up payment returns (net: ${fmt(Math.abs(r.netBenefit))} behind investing). That said, extra mortgage payments deliver a guaranteed ${rate}% return, while ${inv}% is an estimate and not guaranteed.`;
    }

    verdict.className = 'refi-verdict ' + cls;
    verdict.innerHTML = `<div class="refi-verdict-icon">${icon}</div><div class="refi-verdict-text"><strong>${heading}</strong><p>${body}</p></div>`;
  }

  // ── Detail section ──
  const set = (id, txt, color) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = txt;
    if (color !== undefined) el.style.color = color;
  };

  set('detail-std-payment', fmt(r.stdPayment) + '/mo');

  if (r.isLump) {
    set('detail-extra-label', 'Lump sum applied');
    set('detail-extra-value', noExtra ? '—' : fmt(r.lump) + ' to principal', noExtra ? '' : 'var(--text)');
  } else {
    set('detail-extra-label', 'Extra monthly payment');
    set('detail-extra-value', noExtra ? '—' : '+' + fmt(r.extraMo) + '/mo', noExtra ? '' : 'var(--text)');
  }

  const totalRow = document.getElementById('detail-total-row');
  if (totalRow) totalRow.style.display = (!r.isLump && !noExtra) ? '' : 'none';
  set('detail-total-payment', fmt(r.stdPayment + r.extraMo) + '/mo');

  set('detail-orig-payoff', fmtDate(r.origPayoff));
  set('detail-new-payoff',  noExtra ? '—' : fmtDate(r.newPayoff));
  set('detail-months-saved', noExtra ? '—' : fmtMonths(r.monthsSaved) + ' earlier', noExtra ? '' : 'var(--green)');

  set('detail-int-orig',  fmt(r.origTotalInterest));
  set('detail-int-new',   noExtra ? '—' : fmt(r.newTotalInterest));
  set('detail-int-saved', noExtra ? '—' : fmt(r.interestSaved),  !noExtra ? 'var(--green)' : '');

  const ppRow = document.getElementById('detail-postpayoff-row');
  if (ppRow) ppRow.style.display = (!noExtra && r.postPayoffMonths > 0) ? '' : 'none';
  set('detail-postpayoff', noExtra ? '—' : fmt(r.postPayoffBenefit), !noExtra ? 'var(--green)' : '');
  const ppLabel = document.getElementById('detail-postpayoff-label');
  if (ppLabel && !noExtra && r.postPayoffMonths > 0) {
    ppLabel.textContent = 'Freed-up payment invested (' + fmtMonths(r.postPayoffMonths) + ')';
  }

  set('detail-opp-cost',  noExtra ? '—' : '-' + fmt(r.oppCost),  !noExtra ? 'var(--red)' : '');
  set('detail-net',       noExtra ? '—' : (r.netBenefit >= 0 ? '' : '-') + fmt(Math.abs(r.netBenefit)),
                          !noExtra ? (r.netBenefit >= 0 ? 'var(--green)' : 'var(--red)') : '');

  // ── Chart ──
  if (!noExtra) {
    renderChart(r);
  } else {
    if (payoffChart) { payoffChart.destroy(); payoffChart = null; }
  }

  // ── Amortization table ──
  renderAmortTable(r);
}

// ── Payment-type sync ─────────────────────────────────────────────────
function syncPaymentType() {
  const isLump = state.paymentType === 'lumpsum';
  document.querySelectorAll('[data-paytype]').forEach(btn => {
    btn.classList.toggle('pill-btn--active', btn.dataset.paytype === state.paymentType);
  });
  const monthlyField = document.getElementById('extraMonthlyField');
  const lumpField    = document.getElementById('lumpSumField');
  if (monthlyField) monthlyField.style.display = isLump ? 'none' : '';
  if (lumpField)    lumpField.style.display    = isLump ? '' : 'none';
}

// ── State ─────────────────────────────────────────────────────────────
function setVal(key, val) { state[key] = val; saveState(); render(); }
function saveState() { try { localStorage.setItem(PAYOFF_LS_KEY, JSON.stringify(state)); } catch (_) {} }
function loadState() {
  try {
    const raw = localStorage.getItem(PAYOFF_LS_KEY);
    if (raw) state = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) { state = { ...DEFAULTS }; }
}

function encodeShareState() {
  try {
    const c = calculate();
    const delta = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (state[key] !== DEFAULTS[key]) delta[key] = state[key];
    }
    delta._s = {
      loanBalance:   state.loanBalance,
      interestRate:  state.interestRate,
      monthsSaved:   c.monthsSaved,
      interestSaved: Math.round(c.interestSaved),
      extraMonthly:  state.paymentType === 'monthly' ? state.extraMonthly : 0,
      lumpSum:       state.paymentType === 'lumpsum'  ? state.lumpSum      : 0,
    };
    return btoa(JSON.stringify(delta));
  } catch (_) { return null; }
}

function decodeShareParam(search) {
  try {
    const param = new URLSearchParams(search).get('share');
    if (!param) return null;
    return JSON.parse(atob(param));
  } catch (_) { return null; }
}
function syncInputs() {
  ['loanBalance','interestRate','remainingYears','extraMonthly','lumpSum','investReturn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = state[id];
  });
}

// ── Events ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  document.addEventListener('input', function () { trackCalc('payoff', 'used'); }, { once: true, capture: true });

  loadState();
  const shared = decodeShareParam(location.search);
  if (shared) {
    const { _s, ...fields } = shared;
    state = { ...DEFAULTS, ...fields };
    history.replaceState(null, '', location.pathname);
  }
  syncInputs();
  syncPaymentType();
  render();

  ['loanBalance','interestRate','remainingYears','extraMonthly','lumpSum','investReturn'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function () {
      const v = parseFloat(el.value);
      if (!isNaN(v) && v >= 0) setVal(id, v);
    });
    el.addEventListener('blur', function () {
      if (el.value === '' || el.value === null) { el.value = 0; setVal(id, 0); }
    });
  });

  document.querySelectorAll('[data-paytype]').forEach(btn => {
    btn.addEventListener('click', function () {
      state.paymentType = btn.dataset.paytype;
      saveState();
      syncPaymentType();
      render();
    });
  });

  const resetBtn = document.getElementById('resetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      state = { ...DEFAULTS };
      saveState();
      syncInputs();
      syncPaymentType();
      render();
    });
  }

  document.getElementById('shareBtn')?.addEventListener('click', function () {
    trackCalc('payoff', 'share');
    const encoded = encodeShareState();
    if (!encoded) return;
    const url = location.origin + location.pathname + '?share=' + encodeURIComponent(encoded);
    const btn = document.getElementById('shareBtn');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Share'; }, 2000);
      });
    } else {
      prompt('Copy this link to share your scenario:', url);
    }
  });

  document.getElementById('printBtn')?.addEventListener('click', () => window.print());

});
