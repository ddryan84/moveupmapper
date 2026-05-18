'use strict';

const RVB_LS_KEY = 'rvbCalc_v1';

const DEFAULTS = {
  monthlyPay: 6000,
  savingsGrowthPct: 10,
  wageGrowth: 3,
  expendableCash: 80000,
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

// Closed-form amortization schedule: exact remaining balance at month m.
// Early payments are front-loaded with interest; principal paydown accelerates
// over time because the interest portion shrinks as the balance falls.
function loanBalance(principal, annualRate, termYears, months) {
  if (principal <= 0) return 0;
  const r = annualRate / 100 / 12;
  const n = termYears * 12;
  if (months >= n) return 0;
  if (r === 0) return Math.max(0, principal * (1 - months / n));
  return principal * (Math.pow(1 + r, n) - Math.pow(1 + r, months)) / (Math.pow(1 + r, n) - 1);
}

// Month at which LTV (loan / home value) drops to 80% via amortization + appreciation.
// Returns 0 if LTV is already ≤ 80% at origination; Infinity if it never drops within term.
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
  const loan  = Math.max(0, s.purchasePrice - s.downPayment);
  const pi    = mortgagePI(loan, s.mortgageRate, s.mortgageTerm);
  const dpPct = s.purchasePrice > 0 ? (s.downPayment / s.purchasePrice) * 100 : 0;

  // PMI drop-off (only relevant when user has entered a PMI amount)
  const pmiDropOff = s.monthlyPMI > 0
    ? computePMIDropOff(loan, s.purchasePrice, s.mortgageRate, s.mortgageTerm, s.homeGrowth)
    : 0;
  // pmiDropOff === 0  → PMI not required (LTV ≤ 80% from day 1)
  // pmiDropOff > 0    → PMI active until that month
  // pmiDropOff === Inf → PMI never drops within term
  const pmiRequired    = s.monthlyPMI > 0 && pmiDropOff > 0;
  const pmiDropOffYear = pmiRequired && isFinite(pmiDropOff) ? Math.ceil(pmiDropOff / 12) : null;

  /* ── Amortization breakdown for Year 1 vs Year 10 ──
     Illustrates how the interest/principal split shifts over the life of the loan.
     Year 1: balance at month 0 minus balance at month 12
     Year 10: balance at month 108 minus balance at month 120            */
  const balYr0  = loan;
  const balYr1  = loanBalance(loan, s.mortgageRate, s.mortgageTerm, 12);
  const balYr9  = loanBalance(loan, s.mortgageRate, s.mortgageTerm, 108);
  const balYr10 = loanBalance(loan, s.mortgageRate, s.mortgageTerm, 120);

  const principalYr1  = Math.max(0, balYr0 - balYr1);
  const interestYr1   = Math.max(0, pi * 12 - principalYr1);
  const principalYr10 = Math.max(0, balYr9 - balYr10);
  const interestYr10  = Math.max(0, pi * 12 - principalYr10);

  // Year 1 monthly cost breakdown
  const propTaxMonthlyYr1 = (s.purchasePrice * s.propTaxRate / 100) / 12;
  const pmiMonthlyYr1     = pmiRequired ? s.monthlyPMI : 0;
  const buyMonthlyYr1     = pi + propTaxMonthlyYr1 + pmiMonthlyYr1;

  /* ── 10-year projection ── */
  const YEARS = 10;
  const rentMonthlyCosts = [];
  const buyMonthlyCosts  = [];
  const equityValues     = [];
  const savingsValues    = [];

  let equityBreakEvenYear = null;
  let costCrossoverYear   = null;
  let totalRentPaid       = 0;
  let totalPIPaid         = 0;
  let totalPropTaxPaid    = 0;

  for (let t = 0; t <= YEARS; t++) {
    // Rent: base grows at rentIncrease; insurance grows at inflation
    const rentMonthly = s.rent * Math.pow(1 + s.rentIncrease / 100, t)
                      + s.rentersInsurance * Math.pow(1 + s.inflation / 100, t);
    rentMonthlyCosts.push(rentMonthly);

    // Buy: fixed P&I + growing property tax + PMI (until drop-off)
    const propTaxMonthly = (s.purchasePrice * s.propTaxRate / 100)
                         * Math.pow(1 + s.propTaxGrowth / 100, t) / 12;
    const pmiThisYear    = pmiRequired && (t * 12) < pmiDropOff ? s.monthlyPMI : 0;
    const buyMonthly     = pi + propTaxMonthly + pmiThisYear;
    buyMonthlyCosts.push(buyMonthly);

    // Equity = appreciated home value − remaining loan balance − closing costs (sunk at purchase)
    const homeVal = s.purchasePrice * Math.pow(1 + s.homeGrowth / 100, t);
    const bal     = loanBalance(loan, s.mortgageRate, s.mortgageTerm, t * 12);
    equityValues.push(homeVal - bal - s.closingCosts);

    // Savings alternative: invest (down payment + closing costs) at opportunity cost
    savingsValues.push((s.downPayment + s.closingCosts) * Math.pow(1 + s.opportunityCost / 100, t));

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

  return {
    loan, pi, dpPct,
    pmiRequired, pmiDropOff, pmiDropOffYear,
    rentMonthlyCosts, buyMonthlyCosts,
    equityValues, savingsValues,
    equityBreakEvenYear, costCrossoverYear,
    totalRentPaid, totalPIPaid, totalPropTaxPaid,
    equity10: equityValues[YEARS],
    savings10: savingsValues[YEARS],
    buyMonthlyYr1, propTaxMonthlyYr1, pmiMonthlyYr1,
    principalYr1, interestYr1,
    principalYr10, interestYr10,
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
  // Summary bar
  setText('stat-monthly-rent', fmt(c.rentMonthlyCosts[0]));
  setText('stat-monthly-buy',  fmt(c.buyMonthlyYr1));
  setText('stat-dp-pct',       c.dpPct.toFixed(1) + '% down · ' + fmt(c.loan) + ' loan');

  // PMI status
  const pmiEl = document.getElementById('stat-pmi-dropoff');
  if (pmiEl) {
    if (s.monthlyPMI <= 0) pmiEl.textContent = 'Not entered';
    else if (!c.pmiRequired)       pmiEl.textContent = 'N/A (≥20% down)';
    else if (!isFinite(c.pmiDropOff)) pmiEl.textContent = '> loan term';
    else pmiEl.textContent = `Year ${c.pmiDropOffYear}`;
  }

  // Cost crossover
  const ccEl = document.getElementById('stat-cost-crossover');
  if (ccEl) {
    if (c.costCrossoverYear === null) ccEl.textContent = '> 10 yrs';
    else if (c.costCrossoverYear === 0) ccEl.textContent = 'From yr 1';
    else ccEl.textContent = `Year ${c.costCrossoverYear}`;
  }

  // Break-even
  const beText = c.equityBreakEvenYear != null ? `Year ${c.equityBreakEvenYear}` : '> 10 yrs';
  setText('stat-break-even',   beText);
  setText('stat-break-even-2', beText);

  // 10-year verdict
  const diff    = c.equity10 - c.savings10;
  const diffEl  = document.getElementById('stat-equity-diff');
  if (diffEl) {
    diffEl.textContent = (diff >= 0 ? '+' : '') + fmt(diff) + ' vs. investing';
    diffEl.className   = 'bp-stat-delta ' + (diff >= 0 ? 'green' : 'red');
  }
  const winnerEl = document.getElementById('stat-winner');
  if (winnerEl) {
    const buying = c.equity10 >= c.savings10;
    winnerEl.textContent = buying ? 'Buying ahead' : 'Investing ahead';
    winnerEl.className   = 'pb-badge ' + (buying ? 'badge-green' : 'badge-amber');
  }

  // Chart 1 side panel — year 1 breakdown
  setText('side-pi',        fmt(c.pi));
  setText('side-proptax',   fmt(c.propTaxMonthlyYr1));
  setText('side-pmi-yr1',   c.pmiMonthlyYr1 > 0 ? fmt(c.pmiMonthlyYr1) : '—');
  setText('side-buytotal',  fmt(c.buyMonthlyYr1));
  setText('side-totalrent', fmt(c.totalRentPaid));
  setText('side-totalpi',   fmt(c.totalPIPaid));
  setText('side-totalptax', fmt(c.totalPropTaxPaid));

  // Chart 2 side panel — amortization breakdown + year-10 values
  setText('side-principal-yr1',  fmt(c.principalYr1));
  setText('side-interest-yr1',   fmt(c.interestYr1));
  setText('side-principal-yr10', fmt(c.principalYr10));
  setText('side-interest-yr10',  fmt(c.interestYr10));
  setText('side-equity10',       fmt(c.equity10));
  setText('side-savings10',      fmt(c.savings10));

  updateCostChart(c);
  updateWealthChart(c);
}

/* ── Charts ── */

function yearLabels() {
  return Array.from({ length: 11 }, (_, i) => `Yr ${i}`);
}

function initCharts() {
  const sharedOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { font: { size: 12 }, boxWidth: 14, padding: 14 } },
      tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: $${Math.round(ctx.parsed.y).toLocaleString()}` } },
    },
    scales: {
      y: { ticks: { callback: v => '$' + v.toLocaleString() }, grid: { color: 'rgba(0,0,0,0.05)' } },
      x: { grid: { color: 'rgba(0,0,0,0.05)' } },
    },
  };

  const costCtx = document.getElementById('costChart')?.getContext('2d');
  if (costCtx) {
    costChart = new Chart(costCtx, {
      type: 'line',
      data: {
        labels: yearLabels(),
        datasets: [
          { label: 'Rent (monthly total)', data: [], borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.07)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6 },
          { label: 'Buy (P&I + tax + PMI)', data: [], borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.07)', fill: true, tension: 0.2, pointRadius: 4, pointHoverRadius: 6 },
        ],
      },
      options: sharedOpts,
    });
  }

  const wealthCtx = document.getElementById('wealthChart')?.getContext('2d');
  if (wealthCtx) {
    wealthChart = new Chart(wealthCtx, {
      type: 'line',
      data: {
        labels: yearLabels(),
        datasets: [
          { label: 'Net home equity', data: [], borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.09)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6 },
          { label: 'Down pmt + closing invested', data: [], borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.09)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6 },
        ],
      },
      options: sharedOpts,
    });
  }
}

function updateCostChart(c) {
  if (!costChart) return;
  costChart.data.datasets[0].data = c.rentMonthlyCosts;
  costChart.data.datasets[1].data = c.buyMonthlyCosts;
  costChart.update('none');
}

function updateWealthChart(c) {
  if (!wealthChart) return;
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
    'monthlyPay', 'savingsGrowthPct', 'wageGrowth', 'expendableCash', 'opportunityCost',
    'rent', 'rentersInsurance', 'rentIncrease', 'inflation',
    'purchasePrice', 'downPayment', 'mortgageRate', 'mortgageTerm', 'homeGrowth',
    'propTaxRate', 'propTaxGrowth', 'monthlyPMI', 'closingCosts',
  ];
  fields.forEach(key => {
    const el = document.getElementById(key);
    if (el) el.value = state[key] ?? DEFAULTS[key];
  });
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

  ['monthlyPay','savingsGrowthPct','wageGrowth','expendableCash','opportunityCost',
   'rent','rentersInsurance','rentIncrease','inflation',
   'purchasePrice','downPayment','mortgageRate','mortgageTerm','homeGrowth',
   'propTaxRate','propTaxGrowth','monthlyPMI','closingCosts',
  ].forEach(num);

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
