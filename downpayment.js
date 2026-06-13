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

const DP_LS_KEY = 'dpCalc_v1';

const DEFAULTS = {
  homePrice:    500000,
  savings:      150000,
  mortgageRate: 6.75,
  loanTerm:     30,
  horizon:      10,
  investReturn: 7.0,
  pmiRate:      0.85,
  appreciation: 3.0,
};

let state = { ...DEFAULTS };
let wealthChart = null;
let lastCalc = null;

// ── Formatting ──────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(Math.round(n));
  return (n < 0 ? '−$' : '$') + abs.toLocaleString('en-US');
}

function fmtMonths(m) {
  if (!isFinite(m) || m <= 0) return '—';
  m = Math.round(m);
  const y = Math.floor(m / 12), mo = m % 12;
  if (y === 0) return mo + ' mo';
  if (mo === 0) return y + ' yr' + (y !== 1 ? 's' : '');
  return y + ' yr ' + mo + ' mo';
}

// ── Math ────────────────────────────────────────────────────────────────────

function monthlyPmt(principal, annualRatePct, termMonths) {
  if (termMonths <= 0 || principal <= 0) return 0;
  if (annualRatePct === 0) return principal / termMonths;
  const r = annualRatePct / 100 / 12;
  const f = Math.pow(1 + r, termMonths);
  return principal * r * f / (f - 1);
}

function pmiDropoffMonth(loan, homePrice, annualRatePct, pmt) {
  const target = 0.78 * homePrice;
  if (loan <= target) return 0;
  const r = annualRatePct / 100 / 12;
  if (r === 0) return Math.ceil((loan - target) / pmt);
  const pmt_r = pmt / r;
  const num = target - pmt_r;
  const den = loan - pmt_r;
  if (den >= 0 || num / den >= 1) return Infinity;
  return Math.ceil(Math.log(num / den) / Math.log(1 + r));
}

// ── Scenarios ───────────────────────────────────────────────────────────────

const SC_COLORS = ['#64748b', '#4f46e5', '#0d9488'];

function buildScenarios(s) {
  const p   = s.homePrice;
  const sav = s.savings;

  // Minimum: 5% down (or less if savings are tight, floor at 3%)
  const minDp = Math.max(p * 0.03, Math.min(p * 0.05, sav * 0.99));

  // 20% threshold (avoids PMI)
  const dp20 = p * 0.20;

  // Maximum: all available cash (cap at 90% of price to keep some liquidity note)
  const dpMax = Math.min(sav, p * 0.90);

  const dps = [{ dp: minDp, key: 'min' }];

  // Only add 20% scenario if savings can reach it and it's meaningfully above min
  if (sav >= dp20 * 1.02 && dp20 > minDp * 1.08) {
    dps.push({ dp: dp20, key: 'twenty' });
  }

  // Only add max scenario if it's meaningfully above the last scenario
  const lastDp = dps.at(-1).dp;
  if (dpMax > lastDp * 1.08) {
    dps.push({ dp: dpMax, key: 'max' });
  }

  return dps.map(({ dp, key }, i) => {
    const pct = Math.round(dp / p * 100);
    const label = key === 'min'    ? `Min Down (${pct}%)`
                : key === 'twenty' ? 'No PMI (20%)'
                :                    `Max Down (${pct}%)`;
    return { dp, key, label, color: SC_COLORS[i] || '#0891b2' };
  });
}

// ── Simulation ───────────────────────────────────────────────────────────────
// Each scenario starts with (savings − dp) invested as a lump sum.
// The minimum-down scenario has the highest monthly burden (payment + PMI).
// Every other scenario invests the monthly savings vs. the min scenario.
// Wealth at horizon = home equity + investment portfolio.

function simulate(scenarios, s) {
  const N_mo     = s.horizon * 12;
  const r_mort   = s.mortgageRate / 100 / 12;
  const r_inv    = s.investReturn / 100 / 12;
  const termMo   = s.loanTerm * 12;
  const appMoFac = Math.pow(1 + s.appreciation / 100, 1 / 12);

  // Pre-compute per-scenario static values
  const meta = scenarios.map(({ dp }) => {
    const loan    = Math.max(0, s.homePrice - dp);
    const pmt     = monthlyPmt(loan, s.mortgageRate, termMo);
    const hasPMI  = (dp / s.homePrice) < 0.20 && loan > 0;
    const pmiMo   = hasPMI ? loan * (s.pmiRate / 100) / 12 : 0;
    const pmiStop = hasPMI ? pmiDropoffMonth(loan, s.homePrice, s.mortgageRate, pmt) : 0;
    return { loan, pmt, hasPMI, pmiMo, pmiStop, initialInvest: Math.max(0, s.savings - dp) };
  });

  const balances   = meta.map(m => m.loan);
  const portfolios = meta.map(m => m.initialInvest);
  const pmiPaid    = meta.map(() => 0);

  // Yearly wealth captures for chart
  const yearlyWealth = scenarios.map(() => []);

  let homeValue = s.homePrice;

  for (let mo = 1; mo <= N_mo; mo++) {
    homeValue *= appMoFac;

    // Grow all portfolios by one month's investment return
    for (let i = 0; i < meta.length; i++) portfolios[i] *= (1 + r_inv);

    // Monthly burden per scenario
    const burdens = meta.map((m, i) => {
      const pmi = (m.hasPMI && mo <= m.pmiStop) ? m.pmiMo : 0;
      pmiPaid[i] += pmi;
      return m.pmt + pmi;
    });

    // Min-down scenario (index 0) is the reference — highest burden.
    // Other scenarios invest the difference each month.
    const refBurden = burdens[0];
    for (let i = 1; i < meta.length; i++) {
      const saved = refBurden - burdens[i];
      if (saved > 0) portfolios[i] += saved;
    }

    // Amortize each loan
    for (let i = 0; i < meta.length; i++) {
      if (balances[i] > 0) {
        const interest = balances[i] * r_mort;
        const princ    = Math.min(meta[i].pmt - interest, balances[i]);
        balances[i]    = Math.max(0, balances[i] - princ);
      }
    }

    // Snapshot at each year-end
    if (mo % 12 === 0) {
      for (let i = 0; i < scenarios.length; i++) {
        const eq = Math.max(0, homeValue - balances[i]);
        yearlyWealth[i].push(eq + portfolios[i]);
      }
    }
  }

  const results = scenarios.map((scIn, i) => ({
    ...scIn,
    ...meta[i],
    balance:    balances[i],
    equity:     Math.max(0, homeValue - balances[i]),
    portfolio:  portfolios[i],
    totalWealth: Math.max(0, homeValue - balances[i]) + portfolios[i],
    pmiPaid:    pmiPaid[i],
    finalHomeValue: homeValue,
  }));

  return { results, yearlyWealth };
}

// ── Calculate ────────────────────────────────────────────────────────────────

function calculate() {
  const s = state;
  if (!s.homePrice || !s.savings) return null;
  if (s.savings < s.homePrice * 0.03 + 500) return null;

  const scenarios = buildScenarios(s);
  return simulate(scenarios, s);
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderScenarioCards(results) {
  const bestIdx = results.reduce((b, r, i) => r.totalWealth > results[b].totalWealth ? i : b, 0);
  const grid = document.getElementById('dpScenarioCards');
  grid.innerHTML = '';

  results.forEach((r, i) => {
    const isWinner = i === bestIdx;
    const vsMin    = i > 0 ? r.totalWealth - results[0].totalWealth : null;
    const pmiNote  = r.hasPMI ? `(drops off in ${fmtMonths(r.pmiStop)})` : '';

    const card = document.createElement('div');
    card.className = 'dp-sc-card' + (isWinner ? ' dp-sc-card--best' : '');
    card.innerHTML = `
      <div class="dp-sc-hd" style="border-top:3px solid ${r.color}">
        ${isWinner ? `<span class="dp-sc-best-tag" style="background:${r.color}18;color:${r.color}">Best at ${state.horizon} yr</span>` : ''}
        <div class="dp-sc-label" style="color:${r.color}">${r.label}</div>
        <div class="dp-sc-dp-amt">${fmt(r.dp)}</div>
      </div>
      <div class="dp-sc-body">
        <div class="dp-sc-row"><span>Loan amount</span><b>${fmt(r.loan)}</b></div>
        <div class="dp-sc-row"><span>Monthly P&amp;I</span><b>${fmt(Math.round(r.pmt))}/mo</b></div>
        <div class="dp-sc-row">
          <span>PMI</span>
          <b>${r.hasPMI
            ? `${fmt(Math.round(r.pmiMo))}/mo <span class="dp-sc-note">${pmiNote}</span>`
            : '<span style="color:var(--green)">None</span>'
          }</b>
        </div>
        <div class="dp-sc-row"><span>Cash left to invest</span><b>${fmt(r.initialInvest)}</b></div>
        <div class="dp-sc-divider"></div>
        <div class="dp-sc-section-lbl">After ${state.horizon} ${state.horizon === 1 ? 'year' : 'years'}</div>
        <div class="dp-sc-row"><span>Home equity</span><b>${fmt(r.equity)}</b></div>
        <div class="dp-sc-row"><span>Investment portfolio</span><b>${fmt(r.portfolio)}</b></div>
        <div class="dp-sc-total">
          <span>Total wealth</span>
          <b style="color:${r.color}">${fmt(r.totalWealth)}</b>
        </div>
        ${vsMin !== null ? `
        <div class="dp-sc-vs" style="color:${vsMin >= 0 ? 'var(--green)' : 'var(--red)'}">
          ${vsMin >= 0 ? '+' : ''}${fmt(vsMin)} vs. minimum
        </div>` : ''}
      </div>`;
    grid.appendChild(card);
  });

  return bestIdx;
}

function renderInsight(results, bestIdx) {
  const el     = document.getElementById('dpInsight');
  const s      = state;
  const winner = results[bestIdx];
  const minSc  = results[0];

  let cls = 'refi-verdict--info';
  let icon = '→';
  let msg  = '';

  if (results.length === 1) {
    msg = `<strong>Only one scenario to compare.</strong> Increase your available savings or adjust the home price to unlock additional down payment scenarios.`;
  } else if (bestIdx === 0) {
    const gap = results.length > 1 ? results[0].totalWealth - results[1].totalWealth : 0;
    cls = 'refi-verdict--green'; icon = '↑';
    msg = `<strong>Minimum down leaves you ahead after ${s.horizon} years.</strong> At a ${s.investReturn}% investment return, the extra cash you keep working in the market outgrows the interest savings and PMI costs — by ${fmt(gap)} vs. the 20% down scenario. This outcome is typical when your expected investment return exceeds your mortgage rate.`;
  } else if (winner.key === 'max') {
    const gap = winner.totalWealth - minSc.totalWealth;
    cls = 'refi-verdict--amber'; icon = '↓';
    msg = `<strong>Maximum down builds the most wealth after ${s.horizon} years.</strong> The interest savings and faster equity accumulation outweigh the foregone investment returns — by ${fmt(gap)} vs. the minimum. This tends to hold when your mortgage rate is close to or above your expected return, or over longer time horizons.`;
  } else {
    const gap = winner.totalWealth - minSc.totalWealth;
    cls = 'refi-verdict--info'; icon = '✓';
    const pmiCost = minSc.pmiPaid;
    msg = `<strong>20% down is the sweet spot after ${s.horizon} years.</strong> Eliminating PMI (which costs ${fmt(Math.round(pmiCost))} over the period) while keeping some capital invested beats both extremes — by ${fmt(gap)} vs. the minimum down scenario. The 20% threshold is the clearest threshold in residential mortgage math.`;
  }

  el.className = 'refi-verdict ' + cls;
  el.innerHTML = `
    <div class="refi-verdict-icon">${icon}</div>
    <div class="refi-verdict-text"><p>${msg}</p></div>`;
}

function renderChart(c) {
  const { results, yearlyWealth } = c;
  const labels = Array.from({ length: state.horizon }, (_, i) => `Yr ${i + 1}`);

  const datasets = results.map((r, i) => ({
    label: r.label,
    data: yearlyWealth[i],
    borderColor: r.color,
    borderWidth: 2.5,
    pointRadius: 0,
    pointHoverRadius: 4,
    fill: false,
    tension: 0.3,
  }));

  const ctx = document.getElementById('dpChart').getContext('2d');
  if (wealthChart) wealthChart.destroy();
  wealthChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(148,163,184,0.12)' },
          ticks: { color: '#94a3b8', font: { size: 11 } }
        },
        y: {
          grid: { color: 'rgba(148,163,184,0.12)' },
          ticks: {
            color: '#94a3b8',
            font: { size: 11 },
            callback: v => v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + Math.round(v / 1000) + 'k'
          }
        }
      }
    }
  });
}

function renderLegend(results) {
  const el = document.getElementById('dpChartLegend');
  if (!el) return;
  el.innerHTML = results.map(r =>
    `<span class="leg-item" style="color:${r.color}">● ${r.label}</span>`
  ).join('');
}

function recalc() {
  const c = calculate();
  const wrap  = document.getElementById('dpScenariosWrap');
  const empty = document.getElementById('dpEmptyState');

  if (c) {
    lastCalc = c;
    wrap.style.display  = '';
    empty.style.display = 'none';
    const bestIdx = renderScenarioCards(c.results);
    renderInsight(c.results, bestIdx);
    renderChart(c);
    renderLegend(c.results);
    updateMobileBar(c.results, bestIdx);
    trackCalc('downpayment', 'used');
  } else {
    wrap.style.display  = 'none';
    empty.style.display = '';
    updateMobileBar(null, -1);
  }
  saveState();
}

function updateMobileBar(results, bestIdx) {
  const v1 = document.getElementById('mbar-v1');
  const v2 = document.getElementById('mbar-v2');
  if (!results || bestIdx < 0) {
    if (v1) v1.textContent = '—';
    if (v2) v2.textContent = '—';
    return;
  }
  const winner = results[bestIdx];
  if (v1) v1.textContent = fmt(winner.totalWealth);
  if (v2) v2.textContent = winner.label;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function saveState() {
  try { localStorage.setItem(DP_LS_KEY, JSON.stringify(state)); } catch {}
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(DP_LS_KEY) || '{}');
    state = { ...DEFAULTS, ...saved };
  } catch { state = { ...DEFAULTS }; }
}

// ── Field population ─────────────────────────────────────────────────────────

function populateFields() {
  const s = state;
  const map = {
    homePrice: s.homePrice, savings: s.savings,
    mortgageRate: s.mortgageRate, mortgageRateSlider: s.mortgageRate,
    loanTermSelect: s.loanTerm,
    investReturn: s.investReturn, pmiRate: s.pmiRate, appreciation: s.appreciation,
  };
  Object.entries(map).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
  const hDisp = document.getElementById('horizonDisplay');
  const hSlid = document.getElementById('horizonSlider');
  if (hDisp) hDisp.textContent = s.horizon;
  if (hSlid) hSlid.value = s.horizon;
}

// ── Event wiring ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  populateFields();

  // Numeric fields
  [
    ['homePrice',    'homePrice'],
    ['savings',      'savings'],
    ['mortgageRate', 'mortgageRate', 'mortgageRateSlider'],
    ['investReturn', 'investReturn'],
    ['pmiRate',      'pmiRate'],
    ['appreciation', 'appreciation'],
  ].forEach(([id, key, sliderId]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!isNaN(v)) {
        state[key] = v;
        if (sliderId) { const sl = document.getElementById(sliderId); if (sl) sl.value = v; }
        recalc();
      }
    });
  });

  // Mortgage rate slider
  const rateSlider = document.getElementById('mortgageRateSlider');
  if (rateSlider) {
    rateSlider.addEventListener('input', () => {
      state.mortgageRate = parseFloat(rateSlider.value);
      const inp = document.getElementById('mortgageRate');
      if (inp) inp.value = state.mortgageRate;
      recalc();
    });
  }

  // Horizon slider
  const horizSlider = document.getElementById('horizonSlider');
  const horizDisp   = document.getElementById('horizonDisplay');
  if (horizSlider) {
    horizSlider.addEventListener('input', () => {
      state.horizon = parseInt(horizSlider.value);
      if (horizDisp) horizDisp.textContent = state.horizon;
      recalc();
    });
  }

  // Loan term select
  const termSel = document.getElementById('loanTermSelect');
  if (termSel) {
    termSel.addEventListener('change', () => {
      state.loanTerm = parseInt(termSel.value);
      recalc();
    });
  }

  // Advanced toggle
  const advToggle = document.getElementById('advToggle');
  const advBody   = document.getElementById('advBody');
  if (advToggle && advBody) {
    advToggle.addEventListener('click', () => {
      const isOpen = advBody.style.maxHeight && advBody.style.maxHeight !== '0px';
      if (isOpen) {
        advBody.style.maxHeight = '0';
        advToggle.setAttribute('aria-expanded', 'false');
      } else {
        advBody.style.maxHeight = advBody.scrollHeight + 'px';
        advToggle.setAttribute('aria-expanded', 'true');
      }
    });
  }

  // Reset
  document.getElementById('resetBtn')?.addEventListener('click', () => {
    state = { ...DEFAULTS };
    populateFields();
    recalc();
  });

  recalc();
});
