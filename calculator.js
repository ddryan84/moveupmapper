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

/* ── Defaults ── */
const DEFAULTS = {
  // Current home
  buyerMode:           'owner',   // 'owner' | 'firstTime'
  homeValuation:       500000,
  equityMode:          'equity',  // 'equity' | 'loanBalance'
  equityValue:         120000,
  mortgageTerm:        30,
  termRemainder:       25,
  currentMortgageRate: 3.5,
  expendableCash:      50000,
  monthlyIncome:       8500,
  // Prospective home
  purchasePrice:       700000,
  interestRate:   6.875,   // updated at runtime by fetchMortgageRate()
  prospectiveTerm: 30,
  monthlyPMI:     0,
  currentHOA:     0,
  newHOA:         0,
  taxMode:        'dollar',   // 'percent' | 'dollar'
  propertyTaxDollar:  7000,
  propertyTaxPercent: 1.0,
  // Selling costs
  realtorFee:      5,
  transferTaxPct:  0,
  preSaleRepairs:  0,
  sellerTitleFees: 1500,
  // Buying costs
  lenderFees:           2500,
  buyerTitleFees:       1500,
  buyerTransferTaxPct:  0,
  repairCosts:          0,
  prepaidsAtClosing:    0,
  prepaidsManual:       false,
  prePaidEscrow:        0,
  prePaidEscrowManual:  false,
  movingExpenses:       3000,
  // Affordable range
  targetSliderPct: 28,       // 0–50% of income
  // Growth rates
  wageGrowth:      3,
  homeValGrowth:   3,
  equityGrowth:    4,
  savingsRate:     5,
  investmentGrowth: 7,
  // Cost headwinds
  propTaxGrowth:   2,
  inflationRate:   3,
  maintenanceGrowth: 2,
  // Target price assumption
  targetPriceMode:   'fixed',   // 'fixed' | 'rising'
  targetPriceGrowth: 3,
  // Recurring ownership costs
  homeownersInsurance: 150,
  hoiMode:             'dollar',
  hoiPct:              0.4,
  maintenanceRate:    1.0,   // % of purchase price per year
};

/* ── State ── */
const scenarios = { a: null, b: null };
let activeScenario = 'a';

function getState() { return scenarios[activeScenario]; }

function setState(patch) {
  scenarios[activeScenario] = { ...scenarios[activeScenario], ...patch };
  save();
  recalcAndRender();
}

/* ── Persistence ── */
// Bump the version suffix (v1 → v2, etc.) only for BREAKING schema changes:
// renaming a field, removing a field the calculation depends on, or restructuring
// the saved object. Additive changes (new fields with defaults) don't need a bump
// because load() merges saved state into DEFAULTS — new fields get their default
// value automatically. When bumping: update LS_KEY and optionally add a migration
// step below to carry forward fields that didn't change.
const LS_KEY = 'homeSwapCalc_v1';

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ a: scenarios.a, b: scenarios.b, active: activeScenario })); }
  catch (_) {}
}

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    scenarios.a = data.a ? { ...DEFAULTS, ...data.a } : null;
    scenarios.b = data.b ? { ...DEFAULTS, ...data.b } : null;
    activeScenario = data.active || 'a';
    return true;
  } catch (_) { return false; }
}

/* ── Share / URL state ── */
function encodeShareState() {
  try {
    const s = getState();
    const c = calculate(s);
    const delta = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (s[key] !== DEFAULTS[key]) delta[key] = s[key];
    }
    delta._s = {
      homeValuation: s.homeValuation,
      purchasePrice: s.purchasePrice,
      totalMonthly:  Math.round(c.totalMonthly),
      downPayment:   Math.round(c.downPayment),
      dpPct:         c.dpPct,
      cashRemaining: Math.round(c.cashRemaining),
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

/* ── Math helpers ── */
function mortgageFactor(annualRate, termMonths) {
  termMonths = termMonths || 360;
  const r = annualRate / 100 / 12;
  if (r === 0) return 1 / termMonths;
  const p = Math.pow(1 + r, termMonths);
  return r * p / (p - 1);
}

function fmt(n, opts = {}) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : (opts.showPlus && n > 0 ? '+' : '');
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + Math.round(abs).toLocaleString();
  return sign + '$' + Math.round(abs).toLocaleString();
}

function fmtPct(n, digits = 1) { return n.toFixed(digits) + '%'; }

/* ── Core Calculations ── */
function calcEquity(s) {
  if (s.equityMode === 'loanBalance') return Math.max(0, s.homeValuation - s.equityValue);
  return Math.max(0, s.equityValue);
}

function calcAnnualPropertyTax(s, price) {
  if (s.taxMode === 'percent') return price * s.propertyTaxPercent / 100;
  return s.propertyTaxDollar;
}

function calcAffordablePrice(s, targetMonthly, dpPool, hoiMonthly, hoaMonthly) {
  const K = mortgageFactor(s.interestRate, (s.prospectiveTerm || 30) * 12);
  const dp = Math.max(0, dpPool);
  const hoi = hoiMonthly !== undefined ? hoiMonthly : (s.hoiMode === 'percent' ? s.purchasePrice * s.hoiPct / 100 / 12 : s.homeownersInsurance);
  const hoa = hoaMonthly !== undefined ? hoaMonthly : s.newHOA;
  // HOI and HOA are fixed monthly costs independent of price — deduct before solving
  const budget = Math.max(0, targetMonthly - hoi - hoa);
  let price;
  if (s.taxMode === 'percent') {
    const taxMonthly = s.propertyTaxPercent / 100 / 12;
    price = (budget + dp * K) / (K + taxMonthly);
  } else {
    const fixedTaxMonthly = s.propertyTaxDollar / 12;
    const loanPayment = budget - fixedTaxMonthly;
    if (loanPayment <= 0) return dp;
    price = dp + loanPayment / K;
  }
  price = Math.max(0, price);
  // If PMI would apply, subtract it and recalculate once
  if (dp / price < 0.20) {
    const effectiveTarget = budget - s.monthlyPMI;
    if (effectiveTarget > 0) {
      if (s.taxMode === 'percent') {
        const taxMonthly = s.propertyTaxPercent / 100 / 12;
        price = Math.max(0, (effectiveTarget + dp * K) / (K + taxMonthly));
      } else {
        const fixedTaxMonthly = s.propertyTaxDollar / 12;
        const loanPayment = effectiveTarget - fixedTaxMonthly;
        price = loanPayment > 0 ? Math.max(0, dp + loanPayment / K) : dp;
      }
    }
  }
  return price;
}

function calculate(s) {
  const K = mortgageFactor(s.interestRate, (s.prospectiveTerm || 30) * 12);
  const equity = s.buyerMode === 'firstTime' ? 0 : calcEquity(s);
  const isFirst = s.buyerMode === 'firstTime';
  const realtorFees    = isFirst ? 0 : s.homeValuation * s.realtorFee / 100;
  const transferTax    = isFirst ? 0 : s.homeValuation * s.transferTaxPct / 100;
  const sellingCosts   = realtorFees + transferTax + (isFirst ? 0 : s.preSaleRepairs + s.sellerTitleFees);
  // First-time buyers have no current home — zero out rates that only apply to existing owners
  const effHomeValGrowth     = isFirst ? 0 : s.homeValGrowth;
  const effEquityGrowth      = isFirst ? 0 : s.equityGrowth;
  // Property tax and maintenance growth apply to any prospective home purchase, including first-time buyers
  const effPropTaxGrowth     = s.propTaxGrowth;
  const effMaintenanceGrowth = s.maintenanceGrowth;
  const saleProceeds = Math.max(0, equity - sellingCosts);
  const totalCash = saleProceeds + s.expendableCash;
  // Compute tax and HOI early — needed for auto-escrow calculation
  const annualTax = calcAnnualPropertyTax(s, s.purchasePrice);
  const taxMonthly = annualTax / 12;
  const hoiMonthly = s.hoiMode === 'percent' ? s.purchasePrice * s.hoiPct / 100 / 12 : s.homeownersInsurance;
  const autoEscrow = s.purchasePrice > 0 ? Math.round((taxMonthly + hoiMonthly) * 3) : 0;
  const effectiveEscrow = s.prePaidEscrowManual ? s.prePaidEscrow : autoEscrow;
  const buyerTransferTax = s.purchasePrice * (s.buyerTransferTaxPct / 100);
  const autoPrepaids = s.purchasePrice > 0
    ? Math.round(hoiMonthly * 12 + s.purchasePrice * (s.interestRate / 100) / 365 * 15)
    : 0;
  const effectivePrepaids = s.prepaidsManual ? s.prepaidsAtClosing : autoPrepaids;
  const buyingCosts = s.lenderFees + s.buyerTitleFees + s.repairCosts + effectiveEscrow + s.movingExpenses + buyerTransferTax + effectivePrepaids;
  const dpPool = Math.max(0, totalCash - buyingCosts);
  const downPayment = Math.min(dpPool, s.purchasePrice);
  const cashRemaining = Math.max(0, totalCash - downPayment - buyingCosts);
  const dpPct = s.purchasePrice > 0 ? downPayment / s.purchasePrice : 0;
  const loan = Math.max(0, s.purchasePrice - downPayment);
  const mortgagePI = loan * K;
  const pmi = dpPct < 0.20 ? s.monthlyPMI : 0;
  const totalMonthly = mortgagePI + taxMonthly + pmi + hoiMonthly + s.newHOA;
  const ratio = s.monthlyIncome > 0 ? totalMonthly / s.monthlyIncome : 0;
  const monthlyRemaining = s.monthlyIncome - totalMonthly;

  // Affordable range
  const targetMonthly = s.monthlyIncome * (s.targetSliderPct / 100);
  const ceilingMonthly = s.monthlyIncome * 0.36;
  const targetPrice   = calcAffordablePrice(s, targetMonthly,  dpPool, hoiMonthly, s.newHOA);
  const ceilingPrice  = calcAffordablePrice(s, ceilingMonthly, dpPool, hoiMonthly, s.newHOA);

  // Property tax helper text
  const taxPctOfPrice = s.purchasePrice > 0 ? annualTax / s.purchasePrice * 100 : 0;
  const taxDollarEquiv = annualTax;

  // Buying power over 10 years
  // Amortization-based equity: active when loan balance mode + rate + term are filled
  const loanBal    = s.equityMode === 'loanBalance' ? s.equityValue : 0;
  const hasAmort   = s.buyerMode !== 'firstTime' && loanBal > 0 && s.termRemainder > 0 && s.currentMortgageRate > 0;
  const amortR     = hasAmort ? s.currentMortgageRate / 100 / 12 : 0;
  const amortN     = hasAmort ? s.termRemainder * 12 : 0;
  const amortPowN  = hasAmort && amortR > 0 ? Math.pow(1 + amortR, amortN) : 0;

  const bpYears = Array.from({ length: 11 }, (_, t) => t);
  let cashPool = s.expendableCash;
  const bpData = bpYears.map(t => {
    const income_t  = s.monthlyIncome * Math.pow(1 + s.wageGrowth / 100, t);
    const homeVal_t = s.homeValuation * Math.pow(1 + effHomeValGrowth / 100, t);

    // Equity at year t: zero for first-time buyers; amortization or growth rate for owners
    let equity_t;
    if (s.buyerMode === 'firstTime') {
      equity_t = 0;
    } else if (hasAmort) {
      const pmts = t * 12;
      let bal_t;
      if (pmts >= amortN) {
        bal_t = 0; // loan fully paid off by year t
      } else if (amortR === 0) {
        bal_t = loanBal * (amortN - pmts) / amortN;
      } else {
        bal_t = loanBal * (amortPowN - Math.pow(1 + amortR, pmts)) / (amortPowN - 1);
      }
      equity_t = Math.max(0, homeVal_t - bal_t);
    } else {
      equity_t = equity * Math.pow(1 + effEquityGrowth / 100, t);
    }
    const inflFactor_t        = Math.pow(1 + s.inflationRate / 100, t);
    const sellingPctCosts_t   = (s.realtorFee + s.transferTaxPct) / 100;
    const sellingFixedCosts_t = (s.preSaleRepairs + s.sellerTitleFees) * inflFactor_t;
    const saleProceeds_t      = Math.max(0, equity_t - homeVal_t * sellingPctCosts_t - sellingFixedCosts_t);
    const buyingCosts_t       = buyingCosts * inflFactor_t;
    const baseHoi             = s.hoiMode === 'percent' ? s.purchasePrice * s.hoiPct / 100 / 12 : s.homeownersInsurance;
    const hoi_t               = baseHoi * inflFactor_t;
    const hoa_t               = s.newHOA * inflFactor_t;
    const dpPool_t = Math.max(0, saleProceeds_t + cashPool - buyingCosts_t);
    const comfort_t = calcAffordablePrice(s, income_t * 0.28, dpPool_t, hoi_t, hoa_t);
    const ceiling_t = calcAffordablePrice(s, income_t * 0.36, dpPool_t, hoi_t, hoa_t);
    const annualTax_t   = annualTax * Math.pow(1 + effPropTaxGrowth / 100, t);
    const annualMaint_t = s.purchasePrice * (s.maintenanceRate / 100) * Math.pow(1 + effMaintenanceGrowth / 100, t);
    const costBurden_t  = annualTax_t + annualMaint_t + hoi_t * 12;
    const targetPrice_t = s.targetPriceMode === 'rising'
      ? s.purchasePrice * Math.pow(1 + s.targetPriceGrowth / 100, t)
      : s.purchasePrice;
    const result = { t, income_t, dpPool_t, comfort_t, ceiling_t, costBurden_t, targetPrice_t };
    // advance cash pool for next year
    if (t < 10) {
      const annualSavings = income_t * 12 * (s.savingsRate / 100);
      cashPool = cashPool * (1 + s.investmentGrowth / 100) + annualSavings;
    }
    return result;
  });

  // Net growth vs headwinds
  const avgGrowth = (s.wageGrowth + effHomeValGrowth + effEquityGrowth + s.savingsRate + s.investmentGrowth) / 5;
  const avgHeadwind = (effPropTaxGrowth + s.inflationRate + effMaintenanceGrowth) / 3;
  const netRate = avgGrowth - avgHeadwind;

  return {
    equity, realtorFees, transferTax, sellingCosts, saleProceeds, totalCash, buyingCosts, downPayment, cashRemaining,
    dpPct, loan, mortgagePI, annualTax, taxMonthly, pmi, hoiMonthly, totalMonthly, ratio, monthlyRemaining,
    K, dpPool, taxPctOfPrice, taxDollarEquiv,
    targetMonthly, ceilingMonthly, targetPrice, ceilingPrice,
    bpData, avgGrowth, avgHeadwind, netRate,
    autoEscrow, effectiveEscrow,
    buyerTransferTax, autoPrepaids, effectivePrepaids,
  };
}

/* ── Chart Instances ── */
let bpChart = null;

function initCharts() {
  const bpCtx = document.getElementById('buyingPowerChart').getContext('2d');
  bpChart = new Chart(bpCtx, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#f3f4f6' }, ticks: { font: { size: 11 } } },
        y: {
          grid: { color: '#f3f4f6' },
          ticks: {
            font: { size: 11 },
            callback: v => v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$' + v,
          },
        },
      },
    },
  });

}

function updateBpChart(c, s) {
  const labels = c.bpData.map(d => d.t === 0 ? 'Now' : 'Yr ' + d.t);
  const tpLabel = s.targetPriceMode === 'rising'
    ? 'Target price (+' + s.targetPriceGrowth + '%/yr)'
    : 'Target price (fixed)';
  bpChart.data.labels = labels;
  bpChart.data.datasets = [
    {
      label: 'Comfort (28%)',
      data: c.bpData.map(d => Math.round(d.comfort_t)),
      borderColor: '#15803d',
      backgroundColor: '#15803d20',
      tension: .35,
      pointRadius: 3,
      fill: false,
    },
    {
      label: 'Ceiling (36%)',
      data: c.bpData.map(d => Math.round(d.ceiling_t)),
      borderColor: '#d97706',
      backgroundColor: '#d9770620',
      tension: .35,
      pointRadius: 3,
      fill: false,
    },
    {
      label: 'Down payment',
      data: c.bpData.map(d => Math.round(d.dpPool_t)),
      borderColor: '#4f46e5',
      borderDash: [5, 4],
      tension: .35,
      pointRadius: 3,
      fill: false,
    },
    {
      label: 'Annual cost burden',
      data: c.bpData.map(d => Math.round(d.costBurden_t)),
      borderColor: '#dc2626',
      tension: .35,
      pointRadius: 3,
      fill: false,
    },
    {
      label: tpLabel,
      data: c.bpData.map(d => Math.round(d.targetPrice_t)),
      borderColor: '#dc262660',
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
    },
  ];
  bpChart.update();
}


/* ── DOM Helpers ── */
const $ = id => document.getElementById(id);
function setText(id, v) { const el = $(id); if (el) el.textContent = v; }
function setHTML(id, v) { const el = $(id); if (el) el.innerHTML = v; }

/* ── Render ── */
function render(c, s) {
  // Cash Position
  setText('r-saleProceeds', fmt(c.saleProceeds));
  setText('r-expendableCash', fmt(s.expendableCash));
  const tcEl = $('r-totalCash');
  tcEl.textContent = fmt(c.totalCash);
  setText('r-dpPool', fmt(c.downPayment) + ' (' + fmtPct(c.dpPct * 100, 1) + ')');
  setText('r-dpLabel', 'Down payment');
  setText('r-downPayment', fmt(c.downPayment) + ' (' + fmtPct(c.dpPct * 100, 1) + ')');
  setText('r-lenderFees', fmt(s.lenderFees));
  setText('r-buyerTitleFees', fmt(s.buyerTitleFees));
  setText('r-buyerTransferTax', fmt(c.buyerTransferTax));
  setText('r-prepaidsAtClosing', fmt(c.effectivePrepaids));
  setText('r-repairCosts', fmt(s.repairCosts));
  setText('r-prePaidEscrow', fmt(c.effectiveEscrow));
  setText('r-movingExpenses', fmt(s.movingExpenses));

  // Auto-fill pre-paid escrow when not manually overridden
  const escrowInputEl = $('prePaidEscrow');
  if (escrowInputEl && !s.prePaidEscrowManual) {
    escrowInputEl.value = c.autoEscrow;
    if (s.prePaidEscrow !== c.autoEscrow) {
      scenarios[activeScenario].prePaidEscrow = c.autoEscrow;
      save();
    }
  }
  const escrowHelperEl = $('prePaidEscrowHelper');
  if (escrowHelperEl) {
    if (s.prePaidEscrowManual) {
      escrowHelperEl.innerHTML = 'Manual · <a href="#" class="helper-link" id="escrowAutoLink">reset to auto (' + fmt(c.autoEscrow) + ')</a>';
      const autoLink = $('escrowAutoLink');
      if (autoLink) autoLink.addEventListener('click', function(e) {
        e.preventDefault();
        setState({ prePaidEscrowManual: false });
      }, { once: true });
    } else {
      escrowHelperEl.textContent = c.autoEscrow > 0 ? 'Auto: 3 mo. taxes & insurance' : '3 mo. of taxes & insurance upfront';
    }
  }
  const prepaidsInputEl = $('prepaidsAtClosing');
  if (prepaidsInputEl && !s.prepaidsManual) {
    prepaidsInputEl.value = c.autoPrepaids;
    if (s.prepaidsAtClosing !== c.autoPrepaids) {
      scenarios[activeScenario].prepaidsAtClosing = c.autoPrepaids;
      save();
    }
  }
  const prepaidsHelperEl = $('prepaidsHelper');
  if (prepaidsHelperEl) {
    if (s.prepaidsManual) {
      prepaidsHelperEl.innerHTML = 'Manual · <a href="#" class="helper-link" id="prepaidsAutoLink">reset to auto (' + fmt(c.autoPrepaids) + ')</a>';
      const autoLink = $('prepaidsAutoLink');
      if (autoLink) autoLink.addEventListener('click', function(e) {
        e.preventDefault();
        setState({ prepaidsManual: false });
      }, { once: true });
    } else {
      prepaidsHelperEl.textContent = c.autoPrepaids > 0 ? 'Auto: 1st-yr insurance + prepaid interest' : '1st-yr insurance premium + prepaid interest';
    }
  }
  const crEl = $('r-cashRemaining');
  crEl.textContent = fmt(c.cashRemaining);
  crEl.className = c.cashRemaining > 0 ? 'green' : '';

  // Section cost hints
  setText('sellCostsSummary', s.buyerMode === 'firstTime' ? '' : '≈ ' + fmt(c.sellingCosts));
  setText('buyCostsSummary', '≈ ' + fmt(c.buyingCosts));

  // Monthly Costs
  setText('r-mortgageLabel', 'Mortgage (P&I on ' + fmt(c.loan) + ')');
  setText('r-mortgage', fmt(c.mortgagePI));
  setText('r-propTax', fmt(c.taxMonthly));
  const pmiRow = $('r-pmiRow');
  if (c.pmi > 0) { pmiRow.style.display = ''; setText('r-pmi', fmt(c.pmi)); }
  else {
    pmiRow.style.display = 'none';
    // Auto-zero the PMI input when down payment covers ≥20%
    if (c.dpPct >= 0.20 && s.monthlyPMI !== 0) {
      const pmiEl = $('monthlyPMI');
      if (pmiEl) pmiEl.value = 0;
      scenarios[activeScenario].monthlyPMI = 0;
      save();
    }
  }
  setText('r-hoi', fmt(c.hoiMonthly));

  // HOA row
  const hoaRow = $('r-hoaRow');
  if (hoaRow) {
    if (s.newHOA > 0) {
      hoaRow.style.display = '';
      const delta = s.newHOA - s.currentHOA;
      const hoaLabelEl = $('r-hoaLabel');
      if (hoaLabelEl) {
        if (s.currentHOA > 0) {
          const arrow = delta >= 0 ? '↑' : '↓';
          hoaLabelEl.textContent = 'HOA (' + arrow + fmt(Math.abs(delta)) + '/mo vs current)';
        } else {
          hoaLabelEl.textContent = 'HOA';
        }
      }
      setText('r-hoa', fmt(s.newHOA));
    } else {
      hoaRow.style.display = 'none';
    }
  }

  const hoiHelperEl = $('hoiHelper');
  if (hoiHelperEl) {
    hoiHelperEl.textContent = s.hoiMode === 'percent'
      ? '= ' + fmt(c.hoiMonthly) + '/mo (' + s.hoiPct.toFixed(2) + '% of price/yr)'
      : 'Monthly homeowners insurance premium';
  }
  setText('r-totalMonthly', fmt(c.totalMonthly));
  setText('r-income', fmt(s.monthlyIncome));

  const ratioEl = $('r-ratio');
  ratioEl.textContent = fmtPct(c.ratio * 100);
  ratioEl.className = c.ratio < 0.28 ? 'green' : c.ratio < 0.36 ? 'amber' : 'red';

  // Ratio bar
  const pct50 = Math.min(c.ratio / 0.50, 1) * 100;
  const fill = $('r-ratioFill');
  fill.style.width = pct50 + '%';
  fill.style.background = c.ratio < 0.28 ? '#16a34a' : c.ratio < 0.36 ? '#d97706' : '#dc2626';

  // Monthly remaining
  const mrEl = $('r-monthlyRemaining');
  mrEl.textContent = fmt(c.monthlyRemaining);
  mrEl.className = 'mr-value ' + (c.monthlyRemaining >= 0 ? 'green' : 'red');

  // Alert
  const alert = $('affordabilityAlert');
  if (c.ratio < 0.28) {
    alert.className = 'alert alert-green';
    alert.innerHTML = '<span class="alert-icon">✓</span><div class="alert-body"><div class="alert-title">Looks affordable</div><div class="alert-sub">Monthly housing costs are within 28% of your take-home pay.</div></div>';
  } else if (c.ratio < 0.36) {
    alert.className = 'alert alert-amber';
    alert.innerHTML = '<span class="alert-icon">⚠</span><div class="alert-body"><div class="alert-title">Comfortable — a stretch at this price</div><div class="alert-sub">Monthly housing costs are between 28%–36% of take-home pay.</div></div>';
  } else {
    alert.className = 'alert alert-red';
    alert.innerHTML = '<span class="alert-icon">✕</span><div class="alert-body"><div class="alert-title">This may be a stretch</div><div class="alert-sub">Monthly housing costs would exceed 36% of your take-home pay.</div></div>';
  }

  // Property tax helper
  if (s.taxMode === 'dollar') {
    setText('taxHelper', '≈' + fmtPct(c.taxPctOfPrice) + ' of purchase price');
  } else {
    setText('taxHelper', '≈' + fmt(c.annualTax) + '/yr on this purchase price');
  }

  // Equity toggle + loan detail fields visibility
  const equityToggle = $('equityToggle');
  const equityLabel  = $('equityLabel');
  const equityHelper = $('equityHelper');
  const loanFields   = $('loanDetailsFields');
  syncBuyerMode(s.buyerMode);
  const amortActive  = s.buyerMode !== 'firstTime' && s.equityMode === 'loanBalance' && s.termRemainder > 0 && s.currentMortgageRate > 0 && s.equityValue > 0;
  if (s.equityMode === 'equity') {
    equityToggle.textContent = 'Switch to Loan Balance';
    equityLabel.textContent  = 'EQUITY';
    equityHelper.textContent = 'How much of your home you own outright';
    if (loanFields) loanFields.style.display = 'none';
  } else {
    equityToggle.textContent = 'Switch to Equity';
    equityLabel.textContent  = 'LOAN BALANCE';
    equityHelper.textContent = 'Remaining mortgage balance owed';
    if (loanFields) loanFields.style.display = '';
  }
  setText('equityGrowthSub', amortActive
    ? 'Overridden — using amortization schedule'
    : 'Equity portion appreciation');

  // Affordable Range
  const minMonthly = s.monthlyIncome * 0.10;
  const maxMonthly = s.monthlyIncome * 0.50;
  setText('a-sliderMin', fmt(minMonthly));
  setText('a-sliderMax', fmt(maxMonthly));
  setText('a-pctLabel', fmtPct(s.targetSliderPct) + ' of income');
  setText('a-sliderValue', fmt(c.targetMonthly) + '/mo');
  setText('a-dp', fmt(c.dpPool));
  setText('a-rate', fmtPct(s.interestRate) + ' · ' + (s.prospectiveTerm || 30) + '-yr fixed');
  setText('a-targetPrice', fmt(c.targetPrice));
  setText('a-targetSub', 'Suggested max home price at ' + fmt(c.targetMonthly) + '/mo');
  setText('a-ceilingPrice', fmt(c.ceilingPrice));
  setText('a-ceilingSub', 'Maximum at ' + fmt(c.ceilingMonthly) + '/mo — leaves little room');
  setText('a-prospectivePrice', fmt(s.purchasePrice));

  const badge = $('a-prospectiveBadge');
  const pBox  = $('a-prospectiveBox');
  if (s.purchasePrice <= c.targetPrice) {
    badge.textContent = 'Within budget'; badge.className = 'pb-badge badge-green';
    pBox.style.borderColor = '#bbf7d0'; pBox.querySelector('.pb-price').style.color = 'var(--green)';
  } else if (s.purchasePrice <= c.ceilingPrice) {
    badge.textContent = 'Above target'; badge.className = 'pb-badge badge-amber';
    pBox.style.borderColor = '#fcd34d'; pBox.querySelector('.pb-price').style.color = 'var(--amber)';
  } else {
    badge.textContent = 'Over ceiling'; badge.className = 'pb-badge badge-red';
    pBox.style.borderColor = '#fca5a5'; pBox.querySelector('.pb-price').style.color = 'var(--red)';
  }

  // Sync slider position to state (convert % to slider 0-100 where 0%=10% income, 100%=50% income)
  const slider = $('targetSlider');
  slider.value = ((s.targetSliderPct - 10) / 40) * 100;

  // Buying Power summary
  const bp0 = c.bpData[0];
  const bp10 = c.bpData[10];
  setText('bp-comfortPrice', fmt(bp10.comfort_t));
  setText('bp-comfortDelta', '+' + fmt(bp10.comfort_t - bp0.comfort_t) + ' vs today');
  setText('bp-ceilingPrice', fmt(bp10.ceiling_t));
  setText('bp-ceilingDelta', '+' + fmt(bp10.ceiling_t - bp0.ceiling_t) + ' vs today');
  setText('bp-costBurden', fmt(bp10.costBurden_t));
  const costDelta = bp10.costBurden_t - bp0.costBurden_t;
  setText('bp-costDelta', '+' + fmt(costDelta) + ' vs today');

  setText('bp-avgGrowth',   fmtPct(c.avgGrowth));
  setText('bp-avgHeadwind', fmtPct(c.avgHeadwind));
  const netEl = $('bp-netRate');
  netEl.textContent = (c.netRate >= 0 ? '+' : '') + fmtPct(c.netRate);
  netEl.style.color = c.netRate >= 0 ? 'var(--green)' : 'var(--red)';

  setText('bp-footnote',
    '* Interest rate held constant at ' + fmtPct(s.interestRate) +
    '. Maintenance estimated at ' + fmtPct(s.maintenanceRate) + ' of prospective home price/yr. ' +
    'Annual cost burden includes property taxes, maintenance, and homeowners insurance. ' +
    'Homeowners insurance and buying costs (lender fees, title/escrow, repairs, pre-paid escrow, moving) inflate at the Inflation Rate each year. ' +
    'Selling costs (agent commission, transfer tax) scale with projected home value; pre-sale repairs and seller title fees inflate at the Inflation Rate. ' +
    'Buying power reflects max affordable purchase price given projected income, down payment, and inflation-adjusted carrying costs. ' +
    'Cash pool starts at your expendable cash, grows via investment returns each year, plus new annual savings equal to ' +
    'Savings % × growing monthly pay × 12.'
  );

  updateBpChart(c, s);
  syncTargetPriceMode(s.targetPriceMode);
}

/* ── Fill Estimates ── */
function fillSellingEstimates() {
  const s = getState();
  const patch = {};
  patch.realtorFee = 5;
  const realtorEl = $('realtorFee');
  if (realtorEl) realtorEl.value = 5;
  if (s.homeValuation > 0) {
    patch.sellerTitleFees = Math.round(s.homeValuation * 0.005);
    const el = $('sellerTitleFees');
    if (el) el.value = patch.sellerTitleFees;
  }
  setState(patch);
  const btn = $('fillSellEstimates');
  if (btn) { btn.textContent = 'Estimates filled!'; setTimeout(() => { btn.textContent = 'Fill in estimates'; }, 2000); }
}

function fillBuyingEstimates() {
  const s = getState();
  const c = calculate(s);
  const patch = {};
  if (c.loan > 0) {
    patch.lenderFees = Math.round(c.loan * 0.01);
    const el = $('lenderFees');
    if (el) el.value = patch.lenderFees;
  }
  if (s.purchasePrice > 0) {
    patch.buyerTitleFees = Math.round(s.purchasePrice * 0.006);
    const el = $('buyerTitleFees');
    if (el) el.value = patch.buyerTitleFees;
  }
  patch.movingExpenses = 3000;
  const movingEl = $('movingExpenses');
  if (movingEl) movingEl.value = 3000;
  if (c.loan > 0 && c.dpPct < 0.20) {
    patch.monthlyPMI = Math.round(c.loan * 0.007 / 12);
    const el = $('monthlyPMI');
    if (el) el.value = patch.monthlyPMI;
  }
  setState(patch);
  const btn = $('fillBuyEstimates');
  if (btn) { btn.textContent = 'Estimates filled!'; setTimeout(() => { btn.textContent = 'Fill in estimates'; }, 2000); }
}

/* ── Recalculate & Render ── */
function recalcAndRender() {
  const s = getState();
  const c = calculate(s);
  render(c, s);
}

/* ── Buyer mode sync ── */
function syncBuyerMode(mode) {
  const ownerBtn    = $('buyerModeOwner');
  const firstBtn    = $('buyerModeFirst');
  const ownerFields = $('homeOwnerFields');
  const ftNote      = $('firstTimeBuyerNote');
  const cashLabel   = $('expendableCashLabel');
  const cashHelper  = $('expendableCashHelper');
  if (!ownerBtn) return;

  const isFirst = mode === 'firstTime';
  ownerBtn.classList.toggle('active', !isFirst);
  firstBtn.classList.toggle('active',  isFirst);
  if (ownerFields) ownerFields.style.display = isFirst ? 'none' : '';
  if (ftNote)      ftNote.style.display      = isFirst ? ''     : 'none';
  const sellSection = $('sellCostsSection');
  if (sellSection) sellSection.style.display = isFirst ? 'none' : '';

  setText('currentHomeTitle', isFirst ? 'Your Financial Profile'            : 'Your Current Home');
  setText('currentHomeSub',   isFirst ? 'No current home — first-time buyer' : 'What you\'re working with today');
  if (cashLabel)  cashLabel.textContent  = isFirst ? 'AVAILABLE SAVINGS'                        : 'EXPENDABLE CASH';
  if (cashHelper) cashHelper.textContent = isFirst ? 'Total savings available for a down payment' : 'Savings you can put toward the purchase';

  // Grey out / restore the growth-rate inputs that only apply to current homeowners
  const ownerOnlyInputs = ['homeValGrowth', 'equityGrowth'];
  const s = getState();
  for (const id of ownerOnlyInputs) {
    const el = $(id);
    if (!el) continue;
    el.disabled = isFirst;
    el.value    = isFirst ? 0 : (s ? s[id] : el.value);
  }
}

/* ── Target price mode sync ── */
function syncTargetPriceMode(mode) {
  const fixedBtn  = $('tpModeFixed');
  const risingBtn = $('tpModeRising');
  const growthRow = $('targetPriceGrowthRow');
  const legEl     = $('leg-targetPrice');
  if (!fixedBtn) return;
  fixedBtn.classList.toggle('active',  mode === 'fixed');
  risingBtn.classList.toggle('active', mode === 'rising');
  growthRow.style.display = mode === 'rising' ? '' : 'none';
  if (legEl) {
    const s = getState();
    legEl.textContent = mode === 'rising'
      ? '– – Target price (+' + s.targetPriceGrowth + '%/yr)'
      : '– – Target price (fixed)';
  }
}

/* ── Bind Inputs ── */
function bindInputs() {
  document.addEventListener('input', function () { trackCalc('swap', 'used'); }, { once: true, capture: true });

  const s = getState();

  function num(id) {
    const el = $(id);
    if (!el) return;
    el.value = s[id] !== undefined ? s[id] : DEFAULTS[id] || 0;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value) || 0;
      setState({ [id]: v });
    });
  }

  // Current home
  num('homeValuation');
  num('mortgageTerm');
  num('termRemainder');
  num('currentMortgageRate');
  num('expendableCash');
  num('monthlyIncome');

  const evEl = $('equityValue');
  evEl.value = s.equityValue;
  evEl.addEventListener('input', () => setState({ equityValue: parseFloat(evEl.value) || 0 }));

  // Prospective home
  num('purchasePrice');
  num('interestRate');

  const ptermSel = $('prospectiveTerm');
  if (ptermSel) {
    ptermSel.value = s.prospectiveTerm || 30;
    ptermSel.addEventListener('change', () => setState({ prospectiveTerm: parseInt(ptermSel.value) }));
  }
  num('monthlyPMI');
  num('currentHOA');
  num('newHOA');
  const hoiEl = $('homeownersInsurance');
  if (hoiEl) {
    hoiEl.value = s.hoiMode === 'percent' ? s.hoiPct : s.homeownersInsurance;
    hoiEl.addEventListener('input', () => {
      const v = parseFloat(hoiEl.value) || 0;
      if (getState().hoiMode === 'percent') {
        setState({ hoiPct: v });
      } else {
        setState({ homeownersInsurance: v });
      }
    });
  }
  num('realtorFee');
  num('transferTaxPct');
  num('preSaleRepairs');
  num('sellerTitleFees');
  num('lenderFees');
  num('buyerTitleFees');
  num('buyerTransferTaxPct');
  num('repairCosts');
  const prepaidsEl = $('prepaidsAtClosing');
  if (prepaidsEl) {
    if (s.prepaidsManual) prepaidsEl.value = s.prepaidsAtClosing;
    prepaidsEl.addEventListener('input', () => {
      setState({ prepaidsAtClosing: parseFloat(prepaidsEl.value) || 0, prepaidsManual: true });
    });
  }
  const escrowEl = $('prePaidEscrow');
  if (escrowEl) {
    if (s.prePaidEscrowManual) escrowEl.value = s.prePaidEscrow;
    escrowEl.addEventListener('input', () => {
      setState({ prePaidEscrow: parseFloat(escrowEl.value) || 0, prePaidEscrowManual: true });
    });
  }
  num('movingExpenses');

  const ptEl = $('propertyTax');
  ptEl.value = s.taxMode === 'dollar' ? s.propertyTaxDollar : s.propertyTaxPercent;
  ptEl.addEventListener('input', () => {
    const v = parseFloat(ptEl.value) || 0;
    if (getState().taxMode === 'dollar') setState({ propertyTaxDollar: v });
    else setState({ propertyTaxPercent: v });
  });

  // Growth rates
  function numCtrl(id, key) {
    const el = $(id);
    if (!el) return;
    el.value = s[key];
    el.addEventListener('input', () => setState({ [key]: parseFloat(el.value) || 0 }));
  }
  numCtrl('wageGrowth',       'wageGrowth');
  numCtrl('homeValGrowth',     'homeValGrowth');
  numCtrl('equityGrowth',      'equityGrowth');
  numCtrl('savingsRate',       'savingsRate');
  numCtrl('investmentGrowth',  'investmentGrowth');
  numCtrl('propTaxGrowth',       'propTaxGrowth');
  numCtrl('inflationRate',       'inflationRate');
  numCtrl('maintenanceGrowth',   'maintenanceGrowth');
  numCtrl('maintenanceRate',     'maintenanceRate');
  numCtrl('targetPriceGrowth',   'targetPriceGrowth');

  // Slider (input only — click handlers bound once in init)
  const slider = $('targetSlider');
  slider.addEventListener('input', () => {
    const pct = 10 + (slider.value / 100) * 40;
    setState({ targetSliderPct: pct });
  });
}

function syncTaxInput(mode) {
  const s = getState();
  const ptEl = $('propertyTax');
  const affix = $('taxAffix');
  const taxWrap = $('taxInputWrap');
  if (mode === 'percent') {
    affix.textContent = '%';
    taxWrap.classList.add('suffix');
    taxWrap.classList.remove('prefix');
    ptEl.value = s.propertyTaxPercent;
  } else {
    affix.textContent = '$';
    taxWrap.classList.remove('suffix');
    taxWrap.classList.add('prefix');
    ptEl.value = s.propertyTaxDollar;
  }
  $('taxModePercent').classList.toggle('active', mode === 'percent');
  $('taxModeDollar').classList.toggle('active', mode === 'dollar');
}

function syncHoiInput(mode) {
  const s = getState();
  const el = $('homeownersInsurance');
  const affix = $('hoiAffix');
  const wrap = $('hoiInputWrap');
  if (!el) return;
  if (mode === 'percent') {
    if (affix) affix.textContent = '%';
    if (wrap) { wrap.classList.add('suffix'); wrap.classList.remove('prefix'); }
    el.step = '0.05';
    el.value = s.hoiPct;
  } else {
    if (affix) affix.textContent = '$';
    if (wrap) { wrap.classList.remove('suffix'); wrap.classList.add('prefix'); }
    el.step = '10';
    el.value = s.homeownersInsurance;
  }
  $('hoiModeDollar')?.classList.toggle('active', mode === 'dollar');
  $('hoiModePct')?.classList.toggle('active', mode === 'percent');
}

/* ── Scenario switching ── */
function switchScenario(to) {
  activeScenario = to;
  document.querySelectorAll('.scenario-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scenario === to);
  });
  // Update "copy" button label
  const other = to === 'a' ? 'b' : 'a';
  const copyBtn = $('copyScenario');
  copyBtn.textContent = 'Copy ' + to.toUpperCase() + ' → ' + other.toUpperCase();
  // Rebind inputs
  bindInputs();
  syncTaxInput(getState().taxMode);
  syncHoiInput(getState().hoiMode || 'dollar');
  recalcAndRender();
}

/* ── Live mortgage rate ── */
async function fetchMortgageRate() {
  try {
    const res = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US');
    if (!res.ok) return;
    const text = await res.text();
    const lines = text.trim().split('\n');
    // Last non-empty line with a valid number
    for (let i = lines.length - 1; i >= 1; i--) {
      const parts = lines[i].split(',');
      const val = parseFloat(parts[1]);
      if (!isNaN(val) && val > 0) {
        DEFAULTS.interestRate = val;
        // Update any scenario still using the placeholder default
        for (const key of ['a', 'b']) {
          if (scenarios[key] && scenarios[key]._rateIsDefault) {
            scenarios[key].interestRate = val;
          }
        }
        // Reflect in the active input if user hasn't touched it
        const el = document.getElementById('interestRate');
        if (el && el.dataset.rateIsDefault === 'true') {
          el.value = val;
          el.removeAttribute('data-rate-is-default');
          recalcAndRender();
        }
        return;
      }
    }
  } catch (_) { /* keep fallback */ }
}

/* ── Init ── */
function init() {
  // Start with defaults, then overlay any saved state
  scenarios.a = { ...DEFAULTS, _rateIsDefault: true };
  scenarios.b = { ...DEFAULTS, _rateIsDefault: true };
  load();
  if (!scenarios.a) scenarios.a = { ...DEFAULTS, _rateIsDefault: true };
  if (!scenarios.b) scenarios.b = { ...DEFAULTS, _rateIsDefault: true };

  // If a shared link was opened, load its state into scenario A
  const sharedState = decodeShareParam(location.search);
  if (sharedState) {
    const { _s, ...stateFields } = sharedState;
    scenarios.a = { ...DEFAULTS, ...stateFields };
    activeScenario = 'a';
    history.replaceState(null, '', location.pathname);
  }

  initCharts();
  switchScenario(activeScenario);

  // Only auto-fill the rate from FRED when the scenario is still on the placeholder default
  const rateEl = document.getElementById('interestRate');
  if (rateEl && scenarios[activeScenario]._rateIsDefault) {
    rateEl.dataset.rateIsDefault = 'true';
  }
  rateEl?.addEventListener('input', () => rateEl.removeAttribute('data-rate-is-default'), { once: true });

  fetchMortgageRate();

  // Scenario tab clicks
  document.querySelectorAll('.scenario-tab').forEach(btn => {
    btn.addEventListener('click', () => switchScenario(btn.dataset.scenario));
  });

  // Copy scenario
  $('copyScenario').addEventListener('click', () => {
    const from = activeScenario;
    const to = from === 'a' ? 'b' : 'a';
    scenarios[to] = { ...scenarios[from] };
    save();
    // brief flash on button
    $('copyScenario').textContent = 'Copied!';
    setTimeout(() => {
      $('copyScenario').textContent = 'Copy ' + from.toUpperCase() + ' → ' + to.toUpperCase();
    }, 1200);
  });

  // Reset
  $('resetScenario').addEventListener('click', () => {
    if (!confirm('Reset ' + activeScenario.toUpperCase() + ' to defaults?')) return;
    scenarios[activeScenario] = { ...DEFAULTS };
    switchScenario(activeScenario);
  });

  // Buyer mode toggle (bound once)
  $('buyerModeOwner').addEventListener('click', () => setState({ buyerMode: 'owner' }));
  $('buyerModeFirst').addEventListener('click', () => setState({ buyerMode: 'firstTime' }));

  // Target price mode toggle (bound once)
  $('tpModeFixed').addEventListener('click', () => {
    setState({ targetPriceMode: 'fixed' });
  });
  $('tpModeRising').addEventListener('click', () => {
    setState({ targetPriceMode: 'rising' });
  });

  // Slider step buttons (bound once — use getState() so safe across scenarios)
  $('sliderDown').addEventListener('click', () => {
    setState({ targetSliderPct: Math.max(10, getState().targetSliderPct - 1) });
  });
  $('sliderUp').addEventListener('click', () => {
    setState({ targetSliderPct: Math.min(50, getState().targetSliderPct + 1) });
  });

  // Equity mode toggle (bound once to prevent even-count listener cancellation)
  $('equityToggle').addEventListener('click', () => {
    const cur = getState();
    if (cur.equityMode === 'equity') {
      setState({ equityMode: 'loanBalance', equityValue: Math.max(0, cur.homeValuation - cur.equityValue) });
    } else {
      setState({ equityMode: 'equity', equityValue: Math.max(0, cur.homeValuation - cur.equityValue) });
    }
  });

  // Tax mode toggle (bound once)
  $('taxModePercent').addEventListener('click', () => {
    const cur = getState();
    if (cur.taxMode !== 'percent') {
      const pct = cur.purchasePrice > 0 ? cur.propertyTaxDollar / cur.purchasePrice * 100 : 1;
      setState({ taxMode: 'percent', propertyTaxPercent: parseFloat(pct.toFixed(2)) });
      syncTaxInput('percent');
    }
  });
  $('taxModeDollar').addEventListener('click', () => {
    const cur = getState();
    if (cur.taxMode !== 'dollar') {
      const dol = cur.purchasePrice * cur.propertyTaxPercent / 100;
      setState({ taxMode: 'dollar', propertyTaxDollar: Math.round(dol) });
      syncTaxInput('dollar');
    }
  });

  // HOI mode toggle (bound once)
  $('hoiModeDollar')?.addEventListener('click', () => {
    const cur = getState();
    if (cur.hoiMode === 'dollar') return;
    setState({ hoiMode: 'dollar' });
    syncHoiInput('dollar');
  });
  $('hoiModePct')?.addEventListener('click', () => {
    const cur = getState();
    if (cur.hoiMode === 'percent') return;
    const pct = cur.purchasePrice > 0
      ? parseFloat((cur.homeownersInsurance * 12 / cur.purchasePrice * 100).toFixed(2))
      : 0.4;
    setState({ hoiMode: 'percent', hoiPct: pct });
    syncHoiInput('percent');
  });

  // Fill estimates
  $('fillSellEstimates')?.addEventListener('click', fillSellingEstimates);
  $('fillBuyEstimates')?.addEventListener('click', fillBuyingEstimates);

  // Share
  $('shareBtn')?.addEventListener('click', () => {
    trackCalc('swap', 'share');
    const encoded = encodeShareState();
    if (!encoded) return;
    const url = location.origin + location.pathname + '?share=' + encodeURIComponent(encoded);
    const btn = $('shareBtn');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Share'; }, 2000);
      });
    } else {
      prompt('Copy this link to share your scenario:', url);
    }
  });

  // Print
  $('printBtn').addEventListener('click', () => window.print());
}

document.addEventListener('DOMContentLoaded', init);
