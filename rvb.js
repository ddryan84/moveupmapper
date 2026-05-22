'use strict';

const RVB_LS_KEY = 'rvbCalc_v2';

const DEFAULTS = {
  opportunityCost: 7,
  rent: 2200,
  rentersInsurance: 15,
  rentIncrease: 4,
  inflation: 3,
  purchasePrice: 450000,
  downPayment: 90000,
  mortgageRate: 6.875,
  mortgageTerm: 30,
  homeGrowth: 3,
  propTaxRate: 1.2,
  propTaxGrowth: 2,
  monthlyPMI: 0,
  closingCosts: 9000,
  horizonYears: 10,
};

let state = { ...DEFAULTS };
let costChart = null;
let wealthChart = null;

/* ── Mortgage math ── */

function mortgagePI(principal, annualRate, termYears) {
  if (principal <= 0) return 0;
  const r = annualRate / 100 / 12;
  const n = termYears * 12;
  if (r === 0) return principal / n;
  return principal * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
}

// Closed-form remaining balance at month m — front-loaded interest, accelerating principal paydown.
function loanBalance(principal, annualRate, termYears, months) {
  if (principal <= 0) return 0;
  const r = annualRate / 100 / 12;
  const n = termYears * 12;
  if (months >= n) return 0;
  if (r === 0) return Math.max(0, principal * (1 - months / n));
  return principal * (Math.pow(1 + r, n) - Math.pow(1 + r, months)) / (Math.pow(1 + r, n) - 1);
}

// Month at which LTV drops to 80% via paydown + appreciation.
function computePMIDropOff(loan, purchasePrice, annualRate, termYears, homeGrowth) {
  if (purchasePrice <= 0) return 0;
  if (loan <= 0 || loan / purchasePrice <= 0.80) return 0;
  const n = termYears * 12;
  for (let m = 1; m <= n; m++) {
    const bal = loanBalance(loan, annualRate, termYears, m);
    const hv  = purchasePrice * Math.pow(1 + homeGrowth / 100, m / 12);
    if (hv > 0 && bal / hv <= 0.80) return m;
  }
  return Infinity;
}

/* ── Core calculation ── */

function calculate(s) {
  const YEARS = Math.max(5, Math.min(30, Math.round(s.horizonYears ?? 10)));
  const loan  = Math.max(0, s.purchasePrice - s.downPayment);
  const pi    = mortgagePI(loan, s.mortgageRate, s.mortgageTerm);
  const dpPct = s.purchasePrice > 0 ? (s.downPayment / s.purchasePrice) * 100 : 0;

  const pmiDropOff     = s.monthlyPMI > 0
    ? computePMIDropOff(loan, s.purchasePrice, s.mortgageRate, s.mortgageTerm, s.homeGrowth)
    : 0;
  const pmiRequired    = s.monthlyPMI > 0 && pmiDropOff > 0;
  const pmiDropOffYear = pmiRequired && isFinite(pmiDropOff) ? Math.ceil(pmiDropOff / 12) : null;

  /* ── Amortization: Year 1 vs final year of horizon ── */
  const balYr0    = loan;
  const balYr1    = loanBalance(loan, s.mortgageRate, s.mortgageTerm, 12);
  const balYrPrev = loanBalance(loan, s.mortgageRate, s.mortgageTerm, (YEARS - 1) * 12);
  const balYrLast = loanBalance(loan, s.mortgageRate, s.mortgageTerm, YEARS * 12);

  const principalYr1    = Math.max(0, balYr0 - balYr1);
  const interestYr1     = Math.max(0, pi * 12 - principalYr1);
  // Guard against horizon extending past loan payoff: if prior-year balance is already 0,
  // the loan is paid off and both principal and interest for the final year are 0.
  const principalLastYr = Math.max(0, balYrPrev - balYrLast);
  const interestLastYr  = balYrPrev > 0 ? Math.max(0, pi * 12 - principalLastYr) : 0;

  const propTaxMonthlyYr1 = (s.purchasePrice * s.propTaxRate / 100) / 12;
  const pmiMonthlyYr1     = pmiRequired ? s.monthlyPMI : 0;
  const buyMonthlyYr1     = pi + propTaxMonthlyYr1 + pmiMonthlyYr1;

  /* ── Year-by-year projection ── */
  const rentMonthlyCosts = [];
  const buyMonthlyCosts  = [];
  const equityValues     = [];
  const savingsValues    = [];

  let equityBreakEvenYear = null;
  let costCrossoverYear   = null;
  let totalRentPaid       = 0;
  let totalPIPaid         = 0;
  let totalPropTaxPaid    = 0;

  // Savings pool tracks the renter's invested capital iteratively:
  // each year it compounds at the opportunity cost rate and absorbs the
  // annual cost differential (buying minus renting) — positive when buying
  // is more expensive, meaning the renter reinvests those monthly savings.
  let savingsPool = s.downPayment + s.closingCosts;

  for (let t = 0; t <= YEARS; t++) {
    const rentMonthly = s.rent * Math.pow(1 + s.rentIncrease / 100, t)
                      + s.rentersInsurance * Math.pow(1 + s.inflation / 100, t);
    rentMonthlyCosts.push(rentMonthly);

    const propTaxMonthly = (s.purchasePrice * s.propTaxRate / 100)
                         * Math.pow(1 + s.propTaxGrowth / 100, t) / 12;
    const pmiThisYear    = pmiRequired && (t * 12) < pmiDropOff ? s.monthlyPMI : 0;
    const buyMonthly     = pi + propTaxMonthly + pmiThisYear;
    buyMonthlyCosts.push(buyMonthly);

    // Equity = down payment + principal paid to date + home appreciation above purchase price.
    // Tracks wealth built through ownership; does not deduct the outstanding loan balance.
    const homeVal       = s.purchasePrice * Math.pow(1 + s.homeGrowth / 100, t);
    const principalPaid = Math.max(0, loan - loanBalance(loan, s.mortgageRate, s.mortgageTerm, t * 12));
    const appreciation  = Math.max(0, homeVal - s.purchasePrice);
    equityValues.push(s.downPayment + principalPaid + appreciation);

    // Savings: iterative compound + annual cost-differential reinvestment.
    // At t=0 the pool is the initial deployed capital (no compounding yet).
    // At t>0: compound the prior pool, then credit the buyer-minus-renter annual cost gap —
    // positive when buying costs more (renter invests the savings), negative otherwise.
    if (t === 0) {
      savingsValues.push(savingsPool);
    } else {
      savingsPool = savingsPool * (1 + s.opportunityCost / 100)
                  + (buyMonthlyCosts[t - 1] - rentMonthlyCosts[t - 1]) * 12;
      savingsPool = Math.max(0, savingsPool);
      savingsValues.push(savingsPool);
    }

    if (equityBreakEvenYear === null && equityValues[t] >= savingsValues[t] && t > 0)
      equityBreakEvenYear = t;
    if (costCrossoverYear === null && rentMonthly >= buyMonthly)
      costCrossoverYear = t;

    if (t < YEARS) {
      totalRentPaid    += rentMonthly * 12;
      totalPIPaid      += pi * 12;
      totalPropTaxPaid += propTaxMonthly * 12;
    }
  }

  const totalPrincipalPaid = Math.max(0, loan - loanBalance(loan, s.mortgageRate, s.mortgageTerm, YEARS * 12));
  const totalInterestPaid  = Math.max(0, totalPIPaid - totalPrincipalPaid);

  return {
    YEARS, loan, pi, dpPct,
    pmiRequired, pmiDropOff, pmiDropOffYear,
    rentMonthlyCosts, buyMonthlyCosts,
    equityValues, savingsValues,
    equityBreakEvenYear, costCrossoverYear,
    totalRentPaid, totalPIPaid, totalPropTaxPaid,
    totalPrincipalPaid, totalInterestPaid,
    equityLast:  equityValues[YEARS],
    savingsLast: savingsValues[YEARS],
    buyMonthlyYr1, propTaxMonthlyYr1, pmiMonthlyYr1,
    principalYr1, interestYr1,
    principalLastYr, interestLastYr,
  };
}

/* ── Rendering ── */

function fmt(n) {
  if (n == null || !isFinite(n)) return '—';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function render(c, s) {
  const Y = c.YEARS;

  // Stamp the horizon year into every element that displays it
  document.querySelectorAll('.dynamic-yr-label').forEach(el => el.textContent = Y);

  // Summary bar
  setText('stat-monthly-rent', fmt(c.rentMonthlyCosts[0]));
  setText('stat-monthly-buy',  fmt(c.buyMonthlyYr1));
  setText('stat-dp-pct',       c.dpPct.toFixed(1) + '% down · ' + fmt(c.loan) + ' loan');

  // PMI status
  const pmiEl = document.getElementById('stat-pmi-dropoff');
  if (pmiEl) {
    if (s.monthlyPMI <= 0)            pmiEl.textContent = 'Not entered';
    else if (!c.pmiRequired)          pmiEl.textContent = 'N/A (≥20% down)';
    else if (!isFinite(c.pmiDropOff)) pmiEl.textContent = '> loan term';
    else                              pmiEl.textContent = `Year ${c.pmiDropOffYear}`;
  }

  // Cost crossover
  const ccEl = document.getElementById('stat-cost-crossover');
  if (ccEl) {
    if (c.costCrossoverYear === null)   ccEl.textContent = `> ${Y} yrs`;
    else if (c.costCrossoverYear === 0) ccEl.textContent = 'From yr 1';
    else                               ccEl.textContent = `Year ${c.costCrossoverYear}`;
  }

  // Break-even
  const beText = c.equityBreakEvenYear != null ? `Year ${c.equityBreakEvenYear}` : `> ${Y} yrs`;
  setText('stat-break-even',   beText);
  setText('stat-break-even-2', beText);

  // Verdict
  const diff   = c.equityLast - c.savingsLast;
  const diffEl = document.getElementById('stat-equity-diff');
  if (diffEl) {
    diffEl.textContent = (diff >= 0 ? '+' : '') + fmt(diff) + ' vs. investing';
    diffEl.className   = 'bp-stat-delta ' + (diff >= 0 ? 'green' : 'red');
  }
  const winnerEl = document.getElementById('stat-winner');
  if (winnerEl) {
    const buying = c.equityLast >= c.savingsLast;
    winnerEl.textContent = buying ? 'Buying ahead' : 'Investing ahead';
    winnerEl.className   = 'pb-badge ' + (buying ? 'badge-green' : 'badge-amber');
  }

  // Chart 1 side panel
  setText('side-pi',        fmt(c.pi));
  setText('side-proptax',   fmt(c.propTaxMonthlyYr1));
  setText('side-pmi-yr1',   c.pmiMonthlyYr1 > 0 ? fmt(c.pmiMonthlyYr1) : '—');
  setText('side-buytotal',  fmt(c.buyMonthlyYr1));
  setText('side-totalrent',      fmt(c.totalRentPaid));
  setText('side-totalpi',        fmt(c.totalPIPaid));
  setText('side-total-principal', fmt(c.totalPrincipalPaid));
  setText('side-total-interest',  fmt(c.totalInterestPaid));
  setText('side-totalptax',      fmt(c.totalPropTaxPaid));

  // Chart 2 side panel
  setText('side-principal-yr1',     fmt(c.principalYr1));
  setText('side-interest-yr1',      fmt(c.interestYr1));
  setText('side-principal-yr-last', fmt(c.principalLastYr));
  setText('side-interest-yr-last',  fmt(c.interestLastYr));
  setText('side-equity-last',       fmt(c.equityLast));
  setText('side-savings-last',      fmt(c.savingsLast));

  updateCostChart(c);
  updateWealthChart(c);
}

/* ── Charts ── */

function yearLabels() {
  const years = Math.round(state.horizonYears ?? 10);
  return Array.from({ length: years + 1 }, (_, i) => `Yr ${i}`);
}

function initCharts() {
  const sharedOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { font: { size: 12 }, boxWidth: 14, padding: 14 } },
      tooltip: {
        mode: 'index',
        intersect: false,
        callbacks: { label: ctx => ` ${ctx.dataset.label}: $${Math.round(ctx.parsed.y).toLocaleString()}` },
      },
    },
    scales: {
      y: { ticks: { callback: v => '$' + v.toLocaleString() }, grid: { color: 'rgba(0,0,0,0.05)' } },
      x: { grid: { color: 'rgba(0,0,0,0.05)' } },
    },
    interaction: { mode: 'index', intersect: false },
  };

  const costCtx = document.getElementById('costChart')?.getContext('2d');
  if (costCtx) {
    costChart = new Chart(costCtx, {
      type: 'line',
      data: {
        labels: yearLabels(),
        datasets: [
          { label: 'Rent (monthly total)',  data: [], borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.07)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6 },
          { label: 'Buy (P&I + tax + PMI)', data: [], borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.07)',  fill: true, tension: 0.2, pointRadius: 4, pointHoverRadius: 6 },
        ],
      },
      options: {
        ...sharedOpts,
        plugins: {
          ...sharedOpts.plugins,
          annotation: { annotations: {} },
        },
      },
    });
  }

  const wealthCtx = document.getElementById('wealthChart')?.getContext('2d');
  if (wealthCtx) {
    wealthChart = new Chart(wealthCtx, {
      type: 'line',
      data: {
        labels: yearLabels(),
        datasets: [
          { label: 'Home equity built',           data: [], borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.09)',  fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6 },
          { label: 'Down pmt + closing invested', data: [], borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.09)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6 },
        ],
      },
      options: sharedOpts,
    });
  }
}

function updateCostChart(c) {
  if (!costChart) return;
  costChart.data.labels = yearLabels();
  costChart.data.datasets[0].data = c.rentMonthlyCosts;
  costChart.data.datasets[1].data = c.buyMonthlyCosts;

  const showPMI = c.pmiRequired && c.pmiDropOffYear != null
                  && isFinite(c.pmiDropOff) && c.pmiDropOffYear <= c.YEARS;
  costChart.options.plugins.annotation.annotations = showPMI ? {
    pmiLine: {
      type: 'line',
      xMin: c.pmiDropOffYear,
      xMax: c.pmiDropOffYear,
      borderColor: 'rgba(217,119,6,0.75)',
      borderWidth: 2,
      borderDash: [5, 4],
      label: {
        display: true,
        content: `PMI ends — Yr ${c.pmiDropOffYear}`,
        position: 'end',
        yAdjust: -6,
        backgroundColor: 'rgba(254,243,199,0.95)',
        color: '#92400e',
        font: { size: 11, weight: '600' },
        padding: { x: 7, y: 4 },
        borderRadius: 4,
        borderColor: 'rgba(217,119,6,0.4)',
        borderWidth: 1,
      },
    },
  } : {};

  costChart.update('none');
}

function updateWealthChart(c) {
  if (!wealthChart) return;
  wealthChart.data.labels = yearLabels();
  wealthChart.data.datasets[0].data = c.equityValues;
  wealthChart.data.datasets[1].data = c.savingsValues;
  wealthChart.update('none');
}

/* ── State & persistence ── */

function recalc() {
  render(calculate(state), state);
  save();
}

function save() {
  try { localStorage.setItem(RVB_LS_KEY, JSON.stringify(state)); } catch (_) {}
}

function load() {
  try {
    const raw = localStorage.getItem(RVB_LS_KEY);
    if (raw) state = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {}
}

function populateFields() {
  const fields = [
    'opportunityCost',
    'rent', 'rentersInsurance', 'rentIncrease', 'inflation',
    'purchasePrice', 'downPayment', 'mortgageRate', 'mortgageTerm', 'homeGrowth',
    'propTaxRate', 'propTaxGrowth', 'monthlyPMI', 'closingCosts',
  ];
  fields.forEach(key => {
    const el = document.getElementById(key);
    if (el) el.value = state[key] ?? DEFAULTS[key];
  });

  const slider = document.getElementById('horizonSlider');
  if (slider) slider.value = state.horizonYears ?? 10;
  setText('horizonDisplay', state.horizonYears ?? 10);
}

function bindInputs() {
  function num(key) {
    const el = document.getElementById(key);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      state[key] = isNaN(v) ? DEFAULTS[key] : v;
      recalc();
    });
  }

  ['opportunityCost',
   'rent', 'rentersInsurance', 'rentIncrease', 'inflation',
   'purchasePrice', 'downPayment', 'mortgageRate', 'mortgageTerm', 'homeGrowth',
   'propTaxRate', 'propTaxGrowth', 'monthlyPMI', 'closingCosts',
  ].forEach(num);

  const horizonSlider = document.getElementById('horizonSlider');
  if (horizonSlider) {
    horizonSlider.addEventListener('input', () => {
      state.horizonYears = parseInt(horizonSlider.value) || 10;
      setText('horizonDisplay', state.horizonYears);
      recalc();
    });
  }

  document.getElementById('resetBtn')?.addEventListener('click', () => {
    state = { ...DEFAULTS };
    populateFields();
    recalc();
  });

  document.getElementById('printBtn')?.addEventListener('click', () => window.print());
}

function init() {
  load();
  initCharts();
  populateFields();
  bindInputs();
  recalc();
}

document.addEventListener('DOMContentLoaded', init);
