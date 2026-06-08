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

const RVB_LS_KEY = 'rvbCalc_v3';

const DEFAULTS = {
  opportunityCost: 7,
  rent: 2200,
  rentersInsurance: 15,
  rentIncrease: 4,
  inflation: 3,
  purchasePrice: 450000,
  downPayment: 90000,
  dpMode: 'dollar',
  downPaymentPct: 20,
  mortgageRate: 6.875,
  mortgageTerm: 30,
  homeGrowth: 3,
  propTaxRate: 1.0,
  propTaxGrowth: 2,
  monthlyPMI: 0,
  monthlyHOA: 0,
  monthlyHOI: 150,
  hoiMode: 'dollar',
  hoiPct: 0.4,
  closingCosts: 9000,
  maintenancePct: 1,
  horizonYears: 10,
  itemizeDeductions: false,
  taxBracket: 22,
  filingStatus: 'single',
  stateTaxRate: 0,
};

// 2025 federal tax brackets by filing status
const TAX_BRACKETS = {
  single: [
    { rate: 10, label: '10% · up to $11,925' },
    { rate: 12, label: '12% · $11,926 – $48,475' },
    { rate: 22, label: '22% · $48,476 – $103,350' },
    { rate: 24, label: '24% · $103,351 – $197,300' },
    { rate: 32, label: '32% · $197,301 – $250,525' },
    { rate: 35, label: '35% · $250,526 – $626,350' },
    { rate: 37, label: '37% · over $626,350' },
  ],
  mfj: [
    { rate: 10, label: '10% · up to $23,850' },
    { rate: 12, label: '12% · $23,851 – $96,950' },
    { rate: 22, label: '22% · $96,951 – $206,700' },
    { rate: 24, label: '24% · $206,701 – $394,600' },
    { rate: 32, label: '32% · $394,601 – $501,050' },
    { rate: 35, label: '35% · $501,051 – $751,600' },
    { rate: 37, label: '37% · over $751,600' },
  ],
  mfs: [
    { rate: 10, label: '10% · up to $11,925' },
    { rate: 12, label: '12% · $11,926 – $48,475' },
    { rate: 22, label: '22% · $48,476 – $103,350' },
    { rate: 24, label: '24% · $103,351 – $197,300' },
    { rate: 32, label: '32% · $197,301 – $250,525' },
    { rate: 35, label: '35% · $250,526 – $375,800' },
    { rate: 37, label: '37% · over $375,800' },
  ],
};

const STANDARD_DEDUCTIONS = { single: 15000, mfj: 30000, mfs: 15000 };

let state = { ...DEFAULTS };
let costChart = null;
let wealthChart = null;

function updateBracketOptions(filingStatus) {
  const el = document.getElementById('taxBracket');
  if (!el) return;
  const brackets = TAX_BRACKETS[filingStatus] || TAX_BRACKETS.single;
  const currentRate = state.taxBracket;
  el.innerHTML = brackets.map(b =>
    `<option value="${b.rate}"${b.rate === currentRate ? ' selected' : ''}>${b.label}</option>`
  ).join('');
}

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

// Month at which loan balance falls to 80% of original purchase price (standard LTV threshold).
function computePMIDropOff(loan, purchasePrice, annualRate, termYears) {
  if (purchasePrice <= 0) return 0;
  if (loan <= 0 || loan / purchasePrice <= 0.80) return 0;
  const n = termYears * 12;
  for (let m = 1; m <= n; m++) {
    const bal = loanBalance(loan, annualRate, termYears, m);
    if (bal / purchasePrice <= 0.80) return m;
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
    ? computePMIDropOff(loan, s.purchasePrice, s.mortgageRate, s.mortgageTerm)
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

  // Tax benefit: only the amount ABOVE the standard deduction is incrementally deductible.
  // Federal SALT cap: $10K single/MFJ, $5K MFS. State: no standard-deduction adjustment (varies by state).
  const propTaxAnnualYr1     = s.purchasePrice * s.propTaxRate / 100;
  const stateRate            = (s.stateTaxRate || 0) / 100;
  const saltCapYr1           = s.filingStatus === 'mfs' ? 5000 : 10000;
  const stdDedAmt            = STANDARD_DEDUCTIONS[s.filingStatus] || 15000;
  const federalItemizedYr1   = interestYr1 + Math.min(propTaxAnnualYr1, saltCapYr1);
  const federalSavingsYr1    = s.itemizeDeductions
    ? Math.max(0, federalItemizedYr1 - stdDedAmt) * (s.taxBracket / 100)
    : 0;
  const stateSavingsYr1      = s.itemizeDeductions
    ? (interestYr1 + propTaxAnnualYr1) * stateRate
    : 0;
  const taxSavingsYr1        = federalSavingsYr1 + stateSavingsYr1;
  const taxSavingsMonthlyYr1 = taxSavingsYr1 / 12;

  const propTaxMonthlyYr1    = (s.purchasePrice * s.propTaxRate / 100) / 12;
  const pmiMonthlyYr1        = pmiRequired ? s.monthlyPMI : 0;
  const maintenanceMonthlyYr1 = (s.purchasePrice * (s.maintenancePct / 100)) / 12;
  const hoaMonthlyYr1        = s.monthlyHOA;
  const hoiMonthlyYr1        = s.monthlyHOI;
  const buyMonthlyYr1        = pi + propTaxMonthlyYr1 + pmiMonthlyYr1 + maintenanceMonthlyYr1 + hoaMonthlyYr1 + hoiMonthlyYr1;

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
  let totalTaxSavings     = 0;

  // Savings pool tracks the renter's invested capital iteratively:
  // each year it compounds at the opportunity cost rate and absorbs the
  // annual cost differential (buying minus renting) — positive when buying
  // is more expensive, meaning the renter reinvests those monthly savings.
  let savingsPool = s.downPayment + s.closingCosts;

  for (let t = 0; t <= YEARS; t++) {
    const rentMonthly = s.rent * Math.pow(1 + s.rentIncrease / 100, t)
                      + s.rentersInsurance * Math.pow(1 + s.inflation / 100, t);
    rentMonthlyCosts.push(rentMonthly);

    const homeVal           = s.purchasePrice * Math.pow(1 + s.homeGrowth / 100, t);
    const propTaxMonthly    = (s.purchasePrice * s.propTaxRate / 100)
                            * Math.pow(1 + s.propTaxGrowth / 100, t) / 12;
    const pmiThisYear       = pmiRequired && (t * 12) < pmiDropOff ? s.monthlyPMI : 0;
    // Maintenance grows with home value — % of current home value each year.
    const maintenanceMonthly = homeVal * (s.maintenancePct / 100) / 12;
    const hoiMonthly        = s.monthlyHOI * Math.pow(1 + s.inflation / 100, t);
    const buyMonthly        = pi + propTaxMonthly + pmiThisYear + maintenanceMonthly + s.monthlyHOA + hoiMonthly;
    buyMonthlyCosts.push(buyMonthly);

    // Equity = down payment + principal paid to date + home appreciation above purchase price.
    // Tracks wealth built through ownership; does not deduct the outstanding loan balance.
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

    // Compute per-year tax savings and fold into effective buy cost for this year.
    // Applied after the savings pool reads buyMonthlyCosts[t-1] (previous iteration),
    // so the adjustment is picked up correctly by the pool in the next iteration.
    let yearTaxSavings = 0;
    if (s.itemizeDeductions && loan > 0) {
      const balT  = Math.max(0, loan - principalPaid);
      const balT1 = loanBalance(loan, s.mortgageRate, s.mortgageTerm, (t + 1) * 12);
      const principalThisYear = Math.max(0, balT - balT1);
      const interestThisYear  = balT > 0 ? Math.max(0, pi * 12 - principalThisYear) : 0;
      const propTaxThisYear   = propTaxMonthly * 12;
      const saltCap     = s.filingStatus === 'mfs' ? 5000 : 10000;
      const stdDed      = STANDARD_DEDUCTIONS[s.filingStatus] || 15000;
      const fedItemized = interestThisYear + Math.min(propTaxThisYear, saltCap);
      yearTaxSavings = Math.max(0, fedItemized - stdDed) * (s.taxBracket / 100)
                     + (interestThisYear + propTaxThisYear) * stateRate;
    }
    buyMonthlyCosts[t] -= yearTaxSavings / 12;

    if (equityBreakEvenYear === null && equityValues[t] >= savingsValues[t] && t > 0)
      equityBreakEvenYear = t;
    if (costCrossoverYear === null && rentMonthly >= buyMonthlyCosts[t])
      costCrossoverYear = t;

    if (t < YEARS) {
      totalTaxSavings  += yearTaxSavings;
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
    buyMonthlyYr1, propTaxMonthlyYr1, pmiMonthlyYr1, maintenanceMonthlyYr1, hoaMonthlyYr1, hoiMonthlyYr1,
    principalYr1, interestYr1,
    principalLastYr, interestLastYr,
    taxSavingsYr1, taxSavingsMonthlyYr1, totalTaxSavings,
    federalItemizedYr1, stdDedAmt,
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
  setText('stat-monthly-buy',  fmt(c.buyMonthlyCosts[0]));
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

  // Down payment helper
  const dpPctLive = s.purchasePrice > 0
    ? (s.downPayment / s.purchasePrice * 100).toFixed(1) + '% of price'
    : '—';
  setText('dp-pct-live', s.dpMode === 'percent' ? '= ' + fmt(s.downPayment) : dpPctLive);

  // HOI helper
  const hoiHelperEl = document.getElementById('hoiHelperRvb');
  if (hoiHelperEl) {
    hoiHelperEl.textContent = s.hoiMode === 'percent'
      ? '= ' + fmt(s.monthlyHOI) + '/mo · inflates with inflation rate'
      : 'Monthly premium — inflates with general inflation rate';
  }

  // Chart 1 side panel
  setText('side-pi',               fmt(c.pi));
  setText('side-proptax',          fmt(c.propTaxMonthlyYr1));
  setText('side-pmi-yr1',          c.pmiMonthlyYr1 > 0 ? fmt(c.pmiMonthlyYr1) : '—');
  setText('side-maintenance-yr1',  fmt(c.maintenanceMonthlyYr1));
  setText('side-hoa-yr1',          fmt(c.hoaMonthlyYr1));
  setText('side-hoi-yr1',          fmt(c.hoiMonthlyYr1));
  setText('side-buytotal',         fmt(c.buyMonthlyCosts[0]));
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

  // Tax benefit outputs
  const stdDedEl = document.getElementById('std-deduction-ref');
  if (stdDedEl) {
    const stdDed = STANDARD_DEDUCTIONS[s.filingStatus] || 15000;
    stdDedEl.textContent = '$' + stdDed.toLocaleString('en-US');
  }
  const taxBenefitOutputEl = document.getElementById('taxBenefitOutput');
  if (taxBenefitOutputEl) taxBenefitOutputEl.style.display = s.itemizeDeductions ? 'block' : 'none';
  const taxSavingsNoteEl = document.getElementById('taxSavingsNote');
  if (taxSavingsNoteEl) taxSavingsNoteEl.style.display = s.itemizeDeductions ? 'block' : 'none';
  const taxBracketFieldEl = document.getElementById('taxBracketField');
  if (taxBracketFieldEl) taxBracketFieldEl.style.display = s.itemizeDeductions ? 'grid' : 'none';
  if (s.itemizeDeductions) {
    setText('tax-savings-yr1',   fmt(c.taxSavingsYr1));
    setText('tax-savings-total', fmt(c.totalTaxSavings));
  }

  // Show a contextual notice when itemized deductions fall below the standard deduction
  const stdDedNoticeEl = document.getElementById('stdDedNotice');
  if (stdDedNoticeEl) {
    const showNotice = s.itemizeDeductions && c.federalItemizedYr1 < c.stdDedAmt;
    stdDedNoticeEl.style.display = showNotice ? 'block' : 'none';
    if (showNotice) {
      const itemizedEl = document.getElementById('stdDedNoticeItemized');
      const stdEl      = document.getElementById('stdDedNoticeStd');
      if (itemizedEl) itemizedEl.textContent = '$' + Math.round(c.federalItemizedYr1).toLocaleString('en-US');
      if (stdEl)      stdEl.textContent      = '$' + Math.round(c.stdDedAmt).toLocaleString('en-US');
    }
  }

  // Side panel tax savings deduction row
  const sideTaxRowEl = document.getElementById('side-tax-savings-row');
  if (sideTaxRowEl) sideTaxRowEl.style.display = s.itemizeDeductions ? 'flex' : 'none';
  if (s.itemizeDeductions) {
    setText('side-tax-savings', '−' + fmt(c.taxSavingsMonthlyYr1));
  }

  // Summary stat label suffix and chart footnote note
  const buyStatTaxLabelEl = document.getElementById('buy-stat-tax-label');
  if (buyStatTaxLabelEl) buyStatTaxLabelEl.style.display = s.itemizeDeductions ? 'inline' : 'none';
  const chartTaxNoteEl = document.getElementById('chart-tax-note');
  if (chartTaxNoteEl) chartTaxNoteEl.style.display = s.itemizeDeductions ? 'inline' : 'none';

  updateCostChart(c, s);
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
          { label: 'Buy (all ownership costs)', data: [], borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.07)',  fill: true, tension: 0.2, pointRadius: 4, pointHoverRadius: 6 },
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

function updateCostChart(c, s) {
  if (!costChart) return;
  costChart.data.labels = yearLabels();
  costChart.data.datasets[0].data = c.rentMonthlyCosts;
  costChart.data.datasets[1].data = c.buyMonthlyCosts;
  costChart.data.datasets[1].label = s && s.itemizeDeductions
    ? 'Buy (after tax savings)'
    : 'Buy (all ownership costs)';

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

function recomputeFromPct() {
  if (state.dpMode === 'percent') {
    state.downPayment = (state.downPaymentPct / 100) * state.purchasePrice;
  }
  if (state.hoiMode === 'percent') {
    state.monthlyHOI = state.purchasePrice * (state.hoiPct / 100) / 12;
  }
}

function syncDpInput(mode) {
  const el = document.getElementById('downPayment');
  const affix = document.getElementById('dpAffix');
  const wrap = document.getElementById('dpInputWrap');
  if (!el) return;
  if (mode === 'percent') {
    if (affix) affix.textContent = '%';
    if (wrap) { wrap.classList.add('suffix'); wrap.classList.remove('prefix'); }
    el.step = '0.5';
    el.value = state.downPaymentPct;
  } else {
    if (affix) affix.textContent = '$';
    if (wrap) { wrap.classList.remove('suffix'); wrap.classList.add('prefix'); }
    el.step = '1000';
    el.value = state.downPayment;
  }
  document.getElementById('dpModeDollar')?.classList.toggle('active', mode === 'dollar');
  document.getElementById('dpModePercent')?.classList.toggle('active', mode === 'percent');
}

function syncHoiInput(mode) {
  const el = document.getElementById('monthlyHOI');
  const affix = document.getElementById('hoiAffixRvb');
  const wrap = document.getElementById('hoiInputWrapRvb');
  if (!el) return;
  if (mode === 'percent') {
    if (affix) affix.textContent = '%';
    if (wrap) { wrap.classList.add('suffix'); wrap.classList.remove('prefix'); }
    el.step = '0.05';
    el.value = state.hoiPct;
  } else {
    if (affix) affix.textContent = '$';
    if (wrap) { wrap.classList.remove('suffix'); wrap.classList.add('prefix'); }
    el.step = '5';
    el.value = state.monthlyHOI;
  }
  document.getElementById('hoiModeDollarRvb')?.classList.toggle('active', mode === 'dollar');
  document.getElementById('hoiModePctRvb')?.classList.toggle('active', mode === 'percent');
}

function recalc() {
  recomputeFromPct();
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

function encodeShareState() {
  try {
    const c = calculate(state);
    const delta = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (state[key] !== DEFAULTS[key]) delta[key] = state[key];
    }
    delta._s = {
      purchasePrice:    state.purchasePrice,
      rent:             state.rent,
      buyMonthlyYr1:    Math.round(c.buyMonthlyYr1),
      rentMonthlyYr1:   Math.round(c.rentMonthlyCosts[0]),
      costCrossoverYear: c.costCrossoverYear ?? null,
      horizonYears:     state.horizonYears,
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

function populateFields() {
  const fields = [
    'opportunityCost',
    'rent', 'rentersInsurance', 'rentIncrease', 'inflation',
    'purchasePrice', 'mortgageRate', 'mortgageTerm', 'homeGrowth',
    'propTaxRate', 'propTaxGrowth', 'monthlyPMI', 'monthlyHOA', 'closingCosts', 'maintenancePct',
    'stateTaxRate',
  ];
  fields.forEach(key => {
    const el = document.getElementById(key);
    if (el) el.value = state[key] ?? DEFAULTS[key];
  });

  const slider = document.getElementById('horizonSlider');
  if (slider) slider.value = state.horizonYears ?? 10;
  setText('horizonDisplay', state.horizonYears ?? 10);

  document.getElementById('itemizeNo')?.classList.toggle('active', !state.itemizeDeductions);
  document.getElementById('itemizeYes')?.classList.toggle('active', !!state.itemizeDeductions);
  const fs = state.filingStatus ?? 'single';
  document.getElementById('filingStatusSingle')?.classList.toggle('active', fs === 'single');
  document.getElementById('filingStatusMfj')?.classList.toggle('active', fs === 'mfj');
  document.getElementById('filingStatusMfs')?.classList.toggle('active', fs === 'mfs');
  updateBracketOptions(fs);

  syncDpInput(state.dpMode ?? 'dollar');
  syncHoiInput(state.hoiMode ?? 'dollar');
}

function bindInputs() {
  document.addEventListener('input', function () { trackCalc('rvb', 'used'); }, { once: true, capture: true });

  function num(key, afterUpdate) {
    const el = document.getElementById(key);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      state[key] = isNaN(v) ? DEFAULTS[key] : v;
      if (afterUpdate) afterUpdate();
      recalc();
    });
  }

  // Auto-clear PMI when down payment reaches ≥ 20% of home price.
  function pmiAutoReset() {
    if (state.purchasePrice > 0 && state.downPayment / state.purchasePrice >= 0.20 && state.monthlyPMI > 0) {
      state.monthlyPMI = 0;
      const el = document.getElementById('monthlyPMI');
      if (el) el.value = 0;
    }
  }

  ['opportunityCost',
   'rent', 'rentersInsurance', 'rentIncrease', 'inflation',
   'mortgageRate', 'mortgageTerm', 'homeGrowth',
   'propTaxRate', 'propTaxGrowth', 'monthlyPMI', 'monthlyHOA', 'closingCosts', 'maintenancePct',
   'stateTaxRate',
  ].forEach(key => num(key));

  num('purchasePrice', pmiAutoReset);

  const dpEl = document.getElementById('downPayment');
  if (dpEl) {
    dpEl.addEventListener('input', () => {
      const v = parseFloat(dpEl.value);
      const val = isNaN(v) ? 0 : v;
      if (state.dpMode === 'percent') {
        state.downPaymentPct = val;
      } else {
        state.downPayment = val;
      }
      pmiAutoReset();
      recalc();
    });
  }

  const hoiEl = document.getElementById('monthlyHOI');
  if (hoiEl) {
    hoiEl.addEventListener('input', () => {
      const v = parseFloat(hoiEl.value);
      const val = isNaN(v) ? 0 : v;
      if (state.hoiMode === 'percent') {
        state.hoiPct = val;
      } else {
        state.monthlyHOI = val;
      }
      recalc();
    });
  }

  document.getElementById('dpModeDollar')?.addEventListener('click', () => {
    if (state.dpMode === 'dollar') return;
    state.dpMode = 'dollar';
    syncDpInput('dollar');
    recalc();
  });
  document.getElementById('dpModePercent')?.addEventListener('click', () => {
    if (state.dpMode === 'percent') return;
    state.downPaymentPct = state.purchasePrice > 0
      ? parseFloat((state.downPayment / state.purchasePrice * 100).toFixed(1))
      : 20;
    state.dpMode = 'percent';
    syncDpInput('percent');
    recalc();
  });

  document.getElementById('hoiModeDollarRvb')?.addEventListener('click', () => {
    if (state.hoiMode === 'dollar') return;
    state.hoiMode = 'dollar';
    syncHoiInput('dollar');
    recalc();
  });
  document.getElementById('hoiModePctRvb')?.addEventListener('click', () => {
    if (state.hoiMode === 'percent') return;
    state.hoiPct = state.purchasePrice > 0
      ? parseFloat((state.monthlyHOI * 12 / state.purchasePrice * 100).toFixed(2))
      : 0.4;
    state.hoiMode = 'percent';
    syncHoiInput('percent');
    recalc();
  });

  ['single', 'mfj', 'mfs'].forEach(fs => {
    const btnId = 'filingStatus' + fs.charAt(0).toUpperCase() + fs.slice(1);
    document.getElementById(btnId)?.addEventListener('click', () => {
      if (state.filingStatus === fs) return;
      state.filingStatus = fs;
      document.getElementById('filingStatusSingle')?.classList.toggle('active', fs === 'single');
      document.getElementById('filingStatusMfj')?.classList.toggle('active', fs === 'mfj');
      document.getElementById('filingStatusMfs')?.classList.toggle('active', fs === 'mfs');
      updateBracketOptions(fs);
      recalc();
    });
  });

  document.getElementById('itemizeNo')?.addEventListener('click', () => {
    if (!state.itemizeDeductions) return;
    state.itemizeDeductions = false;
    document.getElementById('itemizeNo')?.classList.add('active');
    document.getElementById('itemizeYes')?.classList.remove('active');
    recalc();
  });
  document.getElementById('itemizeYes')?.addEventListener('click', () => {
    if (state.itemizeDeductions) return;
    state.itemizeDeductions = true;
    document.getElementById('itemizeYes')?.classList.add('active');
    document.getElementById('itemizeNo')?.classList.remove('active');
    recalc();
  });
  document.getElementById('taxBracket')?.addEventListener('change', () => {
    state.taxBracket = parseInt(document.getElementById('taxBracket').value) || 22;
    recalc();
  });

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

  document.getElementById('shareBtn')?.addEventListener('click', function () {
    trackCalc('rvb', 'share');
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
}

function init() {
  load();
  const shared = decodeShareParam(location.search);
  if (shared) {
    const { _s, ...fields } = shared;
    state = { ...DEFAULTS, ...fields };
    history.replaceState(null, '', location.pathname);
  }
  initCharts();
  populateFields();
  bindInputs();
  recalc();
}

document.addEventListener('DOMContentLoaded', init);
