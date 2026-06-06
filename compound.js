'use strict';

const COMPOUND_LS_KEY = 'compoundCalc_v1';

const DEFAULTS = {
  initialBalance: 10000,
  contribution:   500,
  frequency:      12,
  contribGrowth:  3,
  annualReturn:   7,
  returnVariance: 2,
  duration:       20,
  inflationRate:  3,
  // Advanced
  expenseRatio:   0,
  managementFee:  0,
  accountType:    'taxable',
  annualTaxDrag:  0,
  // Withdrawal
  withdrawalEnabled:      false,
  withdrawalAmount:       40000,
  withdrawalType:         'fixed',
  withdrawalPercent:      4,
  continueContribs:       false,
  withdrawalInflationAdj: false,
};

const FREQ_UNIT = { 52: 'wk', 26: '2 wks', 12: 'mo', 4: 'qtr', 1: 'yr' };

const ACCT_HELPER = {
  'taxable':      'Taxable brokerage account — dividends and capital distributions are taxed annually, reducing effective return. Enter an annual tax drag estimate below.',
  'tax-deferred': 'Traditional 401(k) or IRA — contributions are pre-tax, growth is tax-deferred, and withdrawals are taxed as ordinary income. No annual tax drag during accumulation.',
  'roth':         'Roth 401(k) or IRA — contributions are after-tax, qualified withdrawals (age 59½+, 5-year hold) are entirely tax-free. No annual tax drag or withdrawal taxes.',
};

const ACCT_DETAIL = {
  'taxable':      'Annual tax drag reduces your effective return each year. The amount depends on distribution frequency, fund turnover, and your marginal rate. Diversified index equity funds typically carry 0.3–0.5% drag; high-turnover active funds can be 1–2% or more. Setting tax drag to 0 shows the pre-tax upper bound.',
  'tax-deferred': 'This projection shows your pre-withdrawal balance. All distributions will be taxed as ordinary income at your marginal rate when taken. Required minimum distributions (RMDs) begin at age 73 under current law. The advantage is that the full balance compounds without annual tax drag during accumulation.',
  'roth':         'Roth accounts grow entirely tax-free. Qualified withdrawals (after age 59½ with a 5-year holding period) are not subject to income tax or capital gains tax. There are no required minimum distributions during your lifetime. The tradeoff is that contributions are made with after-tax dollars.',
};

let state = { ...DEFAULTS };
let growthChart     = null;
let withdrawalChart = null;
let lastCalcResult  = null;
let viewState = { showOptimistic: true, showPessimistic: true };

/* ── Simulation ── */

function simulate(initial, annualContrib, contribGrowthPct, returnPct, years, periods) {
  const values = [initial];
  let balance = initial;
  for (let y = 1; y <= years; y++) {
    const yearContrib   = annualContrib * Math.pow(1 + contribGrowthPct / 100, y - 1);
    const periodContrib = yearContrib / periods;
    const periodRate    = Math.pow(1 + returnPct / 100, 1 / periods) - 1;
    for (let p = 0; p < periods; p++) {
      balance = balance * (1 + periodRate) + periodContrib;
    }
    values.push(balance);
  }
  return { values, finalValue: balance };
}

function simulateWithdrawal(startBalance, returnPct, periods, annualWithdrawal, withdrawalType, withdrawalPct, continueContribs, annualContrib, cgr, accumYear, maxYears, inflationAdj, inflationRate) {
  const values = [startBalance];
  let balance = startBalance;
  let depletionYear = null;

  for (let y = 1; y <= maxYears; y++) {
    if (continueContribs) {
      const yc = annualContrib * Math.pow(1 + cgr / 100, accumYear + y - 1);
      const pc = yc / periods;
      const pr = Math.pow(1 + returnPct / 100, 1 / periods) - 1;
      for (let p = 0; p < periods; p++) balance = balance * (1 + pr) + pc;
    } else {
      balance *= (1 + returnPct / 100);
    }
    const wd = withdrawalType === 'percent'
      ? balance * withdrawalPct / 100
      : annualWithdrawal * (inflationAdj ? Math.pow(1 + inflationRate / 100, y - 1) : 1);
    balance -= wd;
    if (balance <= 0) {
      values.push(0);
      depletionYear = y;
      break;
    }
    values.push(balance);
  }
  return { values, depletionYear };
}

function compoundsLeadsAt(values, annualContrib, cgr, retPct, years) {
  for (let y = 1; y <= years; y++) {
    const yc = annualContrib * Math.pow(1 + cgr / 100, y - 1);
    if (retPct > 0 && values[y - 1] * (retPct / 100) >= yc) return y;
  }
  return null;
}

function calculate(s) {
  const years   = Math.max(1, Math.min(50, Math.round(s.duration ?? 20)));
  const ac      = (s.contribution ?? 0) * (s.frequency ?? 12);
  const periods = s.frequency ?? 12;
  const cgr     = s.contribGrowth  ?? 0;
  const ret     = s.annualReturn   ?? 7;
  const vrn     = s.returnVariance ?? 0;
  const infl    = s.inflationRate  ?? 3;

  const expRatio  = s.expenseRatio  ?? 0;
  const mgmtFee   = s.managementFee ?? 0;
  const acctType  = s.accountType   ?? 'taxable';
  const taxDrag   = acctType === 'taxable' ? (s.annualTaxDrag ?? 0) : 0;
  const totalDrag = expRatio + mgmtFee + taxDrag;
  const netRet    = ret - totalDrag;

  const base      = simulate(s.initialBalance, ac, cgr, netRet,       years, periods);
  const hasVar    = vrn > 0;
  const optimist  = hasVar ? simulate(s.initialBalance, ac, cgr, netRet + vrn, years, periods) : null;
  const pessimist = hasVar ? simulate(s.initialBalance, ac, cgr, netRet - vrn, years, periods) : null;
  const noReturn  = simulate(s.initialBalance, ac, cgr, 0, years, periods);

  const grossBase         = totalDrag > 0 ? simulate(s.initialBalance, ac, cgr, ret, years, periods) : null;
  const grossFinalValue   = grossBase ? grossBase.finalValue : null;
  const lifetimeDragCost  = grossBase ? grossBase.finalValue - base.finalValue : null;

  const inflFactor = Math.pow(1 + infl / 100, years);
  const finalReal  = base.finalValue / inflFactor;

  let totalContrib = 0;
  for (let y = 0; y < years; y++) totalContrib += ac * Math.pow(1 + cgr / 100, y);
  const totalInvested = (s.initialBalance ?? 0) + totalContrib;
  const totalGain     = base.finalValue - totalInvested;
  const multiple      = totalInvested > 0 ? base.finalValue / totalInvested : 0;

  const yr1Annual = ac;
  const yrNAnnual = years > 1 ? ac * Math.pow(1 + cgr / 100, years - 1) : ac;

  const compoundsLeadsYear = compoundsLeadsAt(base.values, ac, cgr, netRet, years);

  const scenarioMeta = (sim, retForSim) => ({
    finalValue: sim.finalValue,
    finalReal:  sim.finalValue / inflFactor,
    totalGain:  sim.finalValue - totalInvested,
    multiple:   totalInvested > 0 ? sim.finalValue / totalInvested : 0,
    compoundsLeadsYear: compoundsLeadsAt(sim.values, ac, cgr, retForSim, years),
  });
  const optimistMeta  = hasVar ? scenarioMeta(optimist,  netRet + vrn) : null;
  const pessimistMeta = hasVar ? scenarioMeta(pessimist, netRet - vrn) : null;

  const wdEnabled = !!(s.withdrawalEnabled);
  let wdBase = null, wdOpt = null, wdPess = null;
  if (wdEnabled) {
    const WD_MAX    = 50;
    const wdAmount  = s.withdrawalAmount  ?? 40000;
    const wdType    = s.withdrawalType    ?? 'fixed';
    const wdPct     = s.withdrawalPercent ?? 4;
    const wdConts   = !!(s.continueContribs);
    const wdInflAdj = !!(s.withdrawalInflationAdj);

    const buildWd = (finalVal, retPct) => {
      const wr = simulateWithdrawal(
        finalVal, retPct, periods,
        wdAmount, wdType, wdPct,
        wdConts, ac, cgr, years, WD_MAX,
        wdInflAdj, infl
      );
      return {
        ...wr,
        wdAmount, wdType, wdPct, wdInflAdj,
        startBalance: finalVal,
        sustainableAnnual: retPct > 0 ? finalVal * retPct / 100 : 0,
        sustainableReal:   (retPct - infl) > 0 ? finalVal * (retPct - infl) / 100 : 0,
      };
    };

    wdBase = buildWd(base.finalValue, netRet);
    wdOpt  = hasVar ? buildWd(optimist.finalValue,  netRet + vrn) : null;
    wdPess = hasVar ? buildWd(pessimist.finalValue, netRet - vrn) : null;
  }

  return {
    years, base, optimist, pessimist, noReturn, hasVar,
    finalReal, inflFactor,
    totalContrib, totalInvested, totalGain, multiple,
    yr1Annual, yrNAnnual, compoundsLeadsYear,
    netRet, totalDrag, expRatio, mgmtFee, taxDrag, acctType,
    grossFinalValue, lifetimeDragCost,
    optimistMeta, pessimistMeta,
    wdEnabled, wdBase, wdOpt, wdPess,
  };
}

/* ── Formatting ── */

function fmt(n) {
  if (n == null || !isFinite(n)) return '—';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ── Growth Chart ── */

function initChart() {
  const ctx = document.getElementById('growthChart')?.getContext('2d');
  if (!ctx) return;

  growthChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Pessimistic',
          data: [],
          borderColor: 'rgba(220,38,38,0.45)',
          borderDash: [4, 3], borderWidth: 1.5,
          fill: false, tension: 0.2, pointRadius: 0, pointHoverRadius: 4,
        },
        {
          label: 'Optimistic',
          data: [],
          borderColor: 'rgba(22,163,74,0.45)',
          backgroundColor: 'rgba(8,145,178,0.09)',
          borderDash: [4, 3], borderWidth: 1.5,
          fill: '-1', tension: 0.2, pointRadius: 0, pointHoverRadius: 4,
        },
        {
          label: 'Base (expected return)',
          data: [],
          borderColor: '#0891b2',
          fill: false, tension: 0.3,
          pointRadius: 3, pointHoverRadius: 5, borderWidth: 2.5,
        },
        {
          label: 'Contributions only (no return)',
          data: [],
          borderColor: '#9ca3af',
          borderDash: [5, 4], borderWidth: 1.5,
          fill: false, tension: 0.2,
          pointRadius: 2, pointHoverRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { size: 12 }, boxWidth: 14, padding: 14 },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          filter: item => !item.dataset.hidden && item.parsed.y != null,
          itemSort: (a, b) => [2, 0, 1, 3][a.datasetIndex] - [2, 0, 1, 3][b.datasetIndex],
          callbacks: { label: ctx => ` ${ctx.dataset.label}: $${Math.round(ctx.parsed.y).toLocaleString()}` },
        },
      },
      scales: {
        y: {
          ticks: {
            callback: v => {
              if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
              if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
              return '$' + v;
            },
          },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        x: { grid: { color: 'rgba(0,0,0,0.05)' } },
      },
      interaction: { mode: 'index', intersect: false },
    },
  });
}

function updateChart(c) {
  if (!growthChart) return;

  growthChart.data.labels = Array.from({ length: c.years + 1 }, (_, i) => `Yr ${i}`);

  const showOpt  = c.hasVar && viewState.showOptimistic;
  const showPess = c.hasVar && viewState.showPessimistic;
  const showBand = showOpt && showPess;

  growthChart.data.datasets[0].hidden = !showPess;
  growthChart.data.datasets[1].hidden = !showOpt;
  growthChart.data.datasets[0].data   = c.hasVar ? c.pessimist.values : [];
  growthChart.data.datasets[1].data   = c.hasVar ? c.optimist.values  : [];
  growthChart.data.datasets[1].fill   = showBand ? '-1' : false;
  growthChart.data.datasets[2].data   = c.base.values;
  growthChart.data.datasets[3].data   = c.noReturn.values;

  growthChart.update('none');
}

/* ── Withdrawal Chart ── */

function initWithdrawalChart() {
  const ctx = document.getElementById('withdrawalChart')?.getContext('2d');
  if (!ctx) return;

  withdrawalChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Pessimistic',
          data: [],
          borderColor: 'rgba(220,38,38,0.55)',
          borderDash: [4, 3], borderWidth: 1.5,
          fill: false, tension: 0.2, pointRadius: 0, pointHoverRadius: 4,
        },
        {
          label: 'Optimistic',
          data: [],
          borderColor: 'rgba(22,163,74,0.55)',
          borderDash: [4, 3], borderWidth: 1.5,
          fill: false, tension: 0.2, pointRadius: 0, pointHoverRadius: 4,
        },
        {
          label: 'Base',
          data: [],
          borderColor: '#f59e0b',
          borderWidth: 2.5,
          fill: false, tension: 0.3,
          pointRadius: 3, pointHoverRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { size: 12 }, boxWidth: 14, padding: 14 },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          filter: item => !item.dataset.hidden && item.parsed.y != null,
          callbacks: { label: ctx => ` ${ctx.dataset.label}: $${Math.round(ctx.parsed.y).toLocaleString()}` },
        },
      },
      scales: {
        y: {
          min: 0,
          ticks: {
            callback: v => {
              if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
              if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
              return '$' + v;
            },
          },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        x: { grid: { color: 'rgba(0,0,0,0.05)' } },
      },
      interaction: { mode: 'index', intersect: false },
    },
  });
}

function updateWithdrawalChart(c) {
  const card = document.getElementById('withdrawalChartCard');
  if (!c.wdEnabled) {
    if (card) card.style.display = 'none';
    return;
  }
  if (card) card.style.display = '';
  if (!withdrawalChart) initWithdrawalChart();
  if (!withdrawalChart) return;

  const maxLen = Math.max(
    c.wdBase ? c.wdBase.values.length : 0,
    c.wdOpt  ? c.wdOpt.values.length  : 0,
    c.wdPess ? c.wdPess.values.length : 0,
  );

  withdrawalChart.data.labels = Array.from({ length: maxLen }, (_, i) => `Yr ${i}`);

  const showOpt  = c.hasVar && viewState.showOptimistic;
  const showPess = c.hasVar && viewState.showPessimistic;

  withdrawalChart.data.datasets[0].data   = c.wdPess ? c.wdPess.values : [];
  withdrawalChart.data.datasets[0].hidden = !showPess;
  withdrawalChart.data.datasets[1].data   = c.wdOpt  ? c.wdOpt.values  : [];
  withdrawalChart.data.datasets[1].hidden = !showOpt;
  withdrawalChart.data.datasets[2].data   = c.wdBase ? c.wdBase.values : [];

  withdrawalChart.update('none');
}

/* ── Scenario toggles ── */

function updateScenarioToggles(c) {
  const show = c.hasVar;
  ['scenarioToggles', 'wdScenarioToggles'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? 'flex' : 'none';
  });
  ['toggleOptimistic', 'wdToggleOptimistic'].forEach(id =>
    document.getElementById(id)?.classList.toggle('active', viewState.showOptimistic));
  ['togglePessimistic', 'wdTogglePessimistic'].forEach(id =>
    document.getElementById(id)?.classList.toggle('active', viewState.showPessimistic));
}

/* ── Active scenario ── */

function getActiveMeta(c) {
  if (c.hasVar && viewState.showOptimistic && !viewState.showPessimistic && c.optimistMeta) {
    return { ...c.optimistMeta, scenarioLabel: 'Optimistic' };
  }
  if (c.hasVar && viewState.showPessimistic && !viewState.showOptimistic && c.pessimistMeta) {
    return { ...c.pessimistMeta, scenarioLabel: 'Pessimistic' };
  }
  return {
    finalValue: c.base.finalValue,
    finalReal:  c.finalReal,
    totalGain:  c.totalGain,
    multiple:   c.multiple,
    compoundsLeadsYear: c.compoundsLeadsYear,
    scenarioLabel: null,
  };
}

function getActiveWithdrawal(c) {
  if (!c.wdEnabled) return null;
  if (c.hasVar && viewState.showOptimistic && !viewState.showPessimistic && c.wdOpt) {
    return c.wdOpt;
  }
  if (c.hasVar && viewState.showPessimistic && !viewState.showOptimistic && c.wdPess) {
    return c.wdPess;
  }
  return c.wdBase;
}

/* ── Render ── */

function render(c, s) {
  const freq = s.frequency ?? 12;
  const unit = FREQ_UNIT[freq] ?? 'mo';
  const Y    = c.years;

  document.querySelectorAll('.dynamic-yr-label').forEach(el => el.textContent = Y);

  const m = getActiveMeta(c);

  const scenLabelEl = document.getElementById('scenario-active-label');
  if (scenLabelEl) {
    if (m.scenarioLabel) {
      scenLabelEl.textContent = 'Showing ' + m.scenarioLabel + ' scenario values';
      scenLabelEl.style.color = m.scenarioLabel === 'Optimistic' ? '#16a34a' : '#dc2626';
      scenLabelEl.style.display = '';
    } else {
      scenLabelEl.style.display = 'none';
    }
  }

  setText('stat-final-value',     fmt(m.finalValue));
  setText('stat-real-value',      fmt(m.finalReal));
  setText('stat-total-invested',  fmt(c.totalInvested));
  setText('stat-total-gain',      fmt(m.totalGain));
  setText('stat-growth-multiple', m.multiple.toFixed(2) + '×');

  const gainEl = document.getElementById('stat-total-gain');
  if (gainEl) gainEl.className = 'bp-stat-value ' + (m.totalGain >= 0 ? 'green' : 'red');

  const clEl = document.getElementById('stat-compounds-leads');
  if (clEl) {
    clEl.textContent = m.compoundsLeadsYear != null ? `Year ${m.compoundsLeadsYear}` : `> ${Y} yrs`;
    clEl.style.fontSize = '18px';
    clEl.style.paddingTop = '3px';
  }

  const badgeEl = document.getElementById('stat-acct-badge');
  if (badgeEl) {
    if (c.acctType === 'tax-deferred') {
      badgeEl.textContent = '· pre-tax';
      badgeEl.style.color = '#d97706';
    } else if (c.acctType === 'roth') {
      badgeEl.textContent = '· tax-free';
      badgeEl.style.color = '#16a34a';
    } else {
      badgeEl.textContent = '';
    }
  }

  setText('infl-final',     fmt(m.finalValue));
  setText('infl-real',      fmt(m.finalReal));
  setText('infl-shortfall', fmt(m.finalValue - m.finalReal));
  setText('infl-rate',      (s.inflationRate ?? 3) + '%');
  setText('infl-years',     Y);

  setText('side-yr1-periodic', fmt(c.yr1Annual / freq) + '/' + unit);
  setText('side-yr1-annual',   fmt(c.yr1Annual) + '/yr');
  setText('side-yrN-periodic', fmt(c.yrNAnnual / freq) + '/' + unit);
  setText('side-yrN-annual',   fmt(c.yrNAnnual) + '/yr');

  const gp = c.yr1Annual > 0 ? (((c.yrNAnnual / c.yr1Annual) - 1) * 100).toFixed(0) : '0';
  setText('side-contrib-growth', '+' + gp + '% vs. Yr 1');

  setText('side-total-invested', fmt(c.totalInvested));
  setText('side-total-gain',     fmt(m.totalGain));
  setText('side-multiple',       m.multiple.toFixed(2) + '×');
  setText('side-final-real',     fmt(m.finalReal));

  setText('contrib-helper', '= ' + fmt(c.yr1Annual) + '/yr · grows ' + (s.contribGrowth ?? 0) + '% annually');

  const feeDragSection = document.getElementById('side-fee-drag-section');
  if (feeDragSection) feeDragSection.style.display = c.totalDrag > 0 ? '' : 'none';
  if (c.totalDrag > 0) {
    setText('side-annual-drag', '−' + c.totalDrag.toFixed(2) + '%/yr');
    const expRow = document.getElementById('side-exp-row');
    if (expRow) expRow.style.display = c.expRatio > 0 ? '' : 'none';
    if (c.expRatio > 0) setText('side-exp-ratio', '−' + c.expRatio.toFixed(2) + '%');
    const mgmtRow = document.getElementById('side-mgmt-row');
    if (mgmtRow) mgmtRow.style.display = c.mgmtFee > 0 ? '' : 'none';
    if (c.mgmtFee > 0) setText('side-mgmt-fee', '−' + c.mgmtFee.toFixed(2) + '%');
    const taxDragRow = document.getElementById('side-taxdrag-row');
    if (taxDragRow) taxDragRow.style.display = c.taxDrag > 0 ? '' : 'none';
    if (c.taxDrag > 0) setText('side-tax-drag', '−' + c.taxDrag.toFixed(2) + '%');
    setText('side-lifetime-drag', '−' + fmt(c.lifetimeDragCost));
    setText('side-gross-final', fmt(c.grossFinalValue));
  }

  // Withdrawal phase stats (in withdrawalChartCard)
  setText('wd-card-start-yr', c.years);
  const activeWd = getActiveWithdrawal(c);
  if (c.wdEnabled && activeWd) {
    const wr = activeWd;
    const depYear = wr.depletionYear;
    const depValEl = document.getElementById('wd-depletion-year');
    if (depValEl) {
      depValEl.textContent = depYear != null ? `Year ${c.years + depYear}` : '50+ years';
      depValEl.style.color = depYear != null ? 'var(--red)' : '#16a34a';
    }
    const depSubEl = document.getElementById('wd-depletion-sub');
    if (depSubEl) {
      depSubEl.textContent = depYear != null
        ? `depletes ${depYear} year${depYear !== 1 ? 's' : ''} after withdrawals begin`
        : 'portfolio sustains beyond 50 additional years';
    }
    const annualWdText = wr.wdType === 'percent'
      ? wr.wdPct.toFixed(1) + '% of balance/yr'
      : fmt(wr.wdAmount) + '/yr';
    setText('wd-annual-amount', annualWdText);

    const annualSubEl = document.getElementById('wd-annual-sub');
    if (annualSubEl) {
      if (wr.wdInflAdj && wr.wdType === 'fixed') {
        const inflRate = s.inflationRate ?? 3;
        const maxWdYr  = depYear != null ? depYear : 50;
        const finalWdAmt = wr.wdAmount * Math.pow(1 + inflRate / 100, maxWdYr - 1);
        annualSubEl.textContent = `grows to ${fmt(finalWdAmt)}/yr by Year ${maxWdYr} at ${inflRate}% inflation`;
      } else {
        annualSubEl.textContent = 'from portfolio each year';
      }
    }

    const sustainableVal = wr.wdInflAdj ? wr.sustainableReal : wr.sustainableAnnual;
    setText('wd-sustainable', fmt(sustainableVal) + '/yr');
    const sustainableSubEl = document.getElementById('wd-sustainable-sub');
    if (sustainableSubEl) {
      sustainableSubEl.textContent = wr.wdInflAdj
        ? 'inflation-adjusted — maintains purchasing power indefinitely'
        : 'portfolio return covers this indefinitely';
    }
    setText('wd-start-balance', fmt(wr.startBalance));

    const wdHelper = document.getElementById('withdrawal-amount-helper');
    if (wdHelper) {
      if (s.withdrawalType === 'fixed' && wr.startBalance > 0) {
        const pct = (s.withdrawalAmount / wr.startBalance * 100).toFixed(1);
        wdHelper.textContent = `Annual dollar withdrawal · ${pct}% of starting balance`;
      } else if (s.withdrawalType === 'percent') {
        wdHelper.textContent = `${s.withdrawalPercent ?? 4}% of portfolio balance each year`;
      }
    }
  }

  // Withdrawal inflation hint (below the amount input, always updated)
  const wdInflHint = document.getElementById('wd-infl-hint');
  if (wdInflHint) {
    const wdEnabled = !!(s.withdrawalEnabled);
    const wdType    = s.withdrawalType ?? 'fixed';
    const wdAmt     = s.withdrawalAmount ?? 0;
    const inflRate  = s.inflationRate ?? 3;
    const years     = c.years;
    if (wdEnabled && wdType === 'fixed' && wdAmt > 0 && inflRate > 0) {
      const realAmt = wdAmt / Math.pow(1 + inflRate / 100, years);
      if (s.withdrawalInflationAdj) {
        const annualInc = wdAmt * (inflRate / 100);
        wdInflHint.innerHTML = `At ${inflRate}% inflation, this has the purchasing power of ${fmt(realAmt)}/yr in today's dollars by Year ${years}.<br><span style="opacity:0.85">${fmt(annualInc)} increase per year at ${inflRate}% inflation</span>`;
      } else {
        wdInflHint.textContent = `At ${inflRate}% inflation, this has the purchasing power of ${fmt(realAmt)}/yr in today's dollars by Year ${years}`;
      }
      wdInflHint.style.display = '';
    } else {
      wdInflHint.style.display = 'none';
    }
  }

  const acctType = c.acctType;
  const acctHelperEl = document.getElementById('acct-type-helper');
  if (acctHelperEl) acctHelperEl.textContent = ACCT_HELPER[acctType] ?? '';
  const acctDetailEl = document.getElementById('acct-type-detail-text');
  if (acctDetailEl) acctDetailEl.textContent = ACCT_DETAIL[acctType] ?? '';
  const taxDragFieldEl = document.getElementById('annualTaxDragField');
  if (taxDragFieldEl) taxDragFieldEl.style.display = acctType === 'taxable' ? '' : 'none';

  setText('net-return-display', c.netRet.toFixed(2) + '%');
  setText('total-drag-display', c.totalDrag > 0 ? '−' + c.totalDrag.toFixed(2) + '%' : '0%');

  const advResultRow = document.getElementById('advResultRow');
  if (advResultRow) advResultRow.style.display = c.totalDrag > 0 ? '' : 'none';

  document.querySelectorAll('[data-acct]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.acct === acctType));

  updateScenarioToggles(c);
  updateChart(c);
  updateWithdrawalChart(c);
}

/* ── State & persistence ── */

function recalc() {
  lastCalcResult = calculate(state);
  render(lastCalcResult, state);
  save();
}

function save() {
  try { localStorage.setItem(COMPOUND_LS_KEY, JSON.stringify(state)); } catch (_) {}
}

function load() {
  try {
    const raw = localStorage.getItem(COMPOUND_LS_KEY);
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
      initialBalance: state.initialBalance,
      contribution:   state.contribution,
      annualReturn:   state.annualReturn,
      duration:       state.duration,
      finalBalance:   Math.round(c.base.finalValue),
      totalContrib:   Math.round(c.totalContrib),
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
  ['initialBalance', 'contribution', 'contribGrowth', 'annualReturn', 'returnVariance',
   'inflationRate', 'expenseRatio', 'managementFee', 'annualTaxDrag'].forEach(key => {
    const el = document.getElementById(key);
    if (el) el.value = state[key] ?? DEFAULTS[key];
  });
  const slider = document.getElementById('durationSlider');
  if (slider) slider.value = state.duration ?? 20;
  setText('durationDisplay', state.duration ?? 20);

  document.querySelectorAll('[data-freq]').forEach(btn =>
    btn.classList.toggle('active', parseInt(btn.dataset.freq) === (state.frequency ?? 12)));

  const acctType = state.accountType ?? 'taxable';
  document.querySelectorAll('[data-acct]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.acct === acctType));

  const taxDragFieldEl = document.getElementById('annualTaxDragField');
  if (taxDragFieldEl) taxDragFieldEl.style.display = acctType === 'taxable' ? '' : 'none';

  ['withdrawalAmount', 'withdrawalPercent'].forEach(key => {
    const el = document.getElementById(key);
    if (el) el.value = state[key] ?? DEFAULTS[key];
  });

  const wdEnabled  = !!(state.withdrawalEnabled);
  const wdType     = state.withdrawalType    ?? 'fixed';
  const wdContinue = !!(state.continueContribs);

  document.querySelectorAll('[data-wd-enable]').forEach(btn =>
    btn.classList.toggle('active', (btn.dataset.wdEnable === 'true') === wdEnabled));
  document.querySelectorAll('[data-wd-type]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.wdType === wdType));
  document.querySelectorAll('[data-wd-contribs]').forEach(btn =>
    btn.classList.toggle('active', (btn.dataset.wdContribs === 'true') === wdContinue));

  const wdInflAdj = !!(state.withdrawalInflationAdj);
  document.querySelectorAll('[data-wd-infladj]').forEach(btn =>
    btn.classList.toggle('active', (btn.dataset.wdInfladj === 'true') === wdInflAdj));

  const wdFieldsEl = document.getElementById('withdrawalFields');
  if (wdFieldsEl) wdFieldsEl.style.display = wdEnabled ? '' : 'none';
  const wdAmtWrap = document.getElementById('withdrawalAmountWrap');
  const wdPctWrap = document.getElementById('withdrawalPercentWrap');
  if (wdAmtWrap) wdAmtWrap.style.display = wdType === 'fixed'   ? '' : 'none';
  if (wdPctWrap) wdPctWrap.style.display = wdType === 'percent' ? '' : 'none';
  const wdBadge = document.getElementById('withdrawal-enabled-badge');
  if (wdBadge) wdBadge.style.display = wdEnabled ? '' : 'none';
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

  ['initialBalance', 'contribution', 'contribGrowth', 'annualReturn', 'returnVariance',
   'inflationRate', 'expenseRatio', 'managementFee', 'annualTaxDrag'].forEach(num);

  document.querySelectorAll('[data-freq]').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = parseInt(btn.dataset.freq);
      if (state.frequency === f) return;
      state.frequency = f;
      document.querySelectorAll('[data-freq]').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.freq) === f));
      recalc();
    });
  });

  document.querySelectorAll('[data-acct]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.acct;
      if (state.accountType === t) return;
      state.accountType = t;
      recalc();
    });
  });

  function bindScenarioToggle(optId, pessId) {
    document.getElementById(optId)?.addEventListener('click', () => {
      viewState.showOptimistic = !viewState.showOptimistic;
      if (lastCalcResult) render(lastCalcResult, state);
    });
    document.getElementById(pessId)?.addEventListener('click', () => {
      viewState.showPessimistic = !viewState.showPessimistic;
      if (lastCalcResult) render(lastCalcResult, state);
    });
  }
  bindScenarioToggle('toggleOptimistic',   'togglePessimistic');
  bindScenarioToggle('wdToggleOptimistic', 'wdTogglePessimistic');

  const slider = document.getElementById('durationSlider');
  if (slider) {
    slider.addEventListener('input', () => {
      state.duration = parseInt(slider.value) || 20;
      setText('durationDisplay', state.duration);
      recalc();
    });
  }

  ['withdrawalAmount', 'withdrawalPercent'].forEach(key => {
    const el = document.getElementById(key);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      state[key] = isNaN(v) ? DEFAULTS[key] : v;
      recalc();
    });
  });

  document.querySelectorAll('[data-wd-enable]').forEach(btn => {
    btn.addEventListener('click', () => {
      const enabled = btn.dataset.wdEnable === 'true';
      if (!!(state.withdrawalEnabled) === enabled) return;
      state.withdrawalEnabled = enabled;
      document.querySelectorAll('[data-wd-enable]').forEach(b =>
        b.classList.toggle('active', (b.dataset.wdEnable === 'true') === enabled));
      const wdFieldsEl = document.getElementById('withdrawalFields');
      if (wdFieldsEl) wdFieldsEl.style.display = enabled ? '' : 'none';
      const wdBadge = document.getElementById('withdrawal-enabled-badge');
      if (wdBadge) wdBadge.style.display = enabled ? '' : 'none';
      recalc();
    });
  });

  document.querySelectorAll('[data-wd-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.wdType;
      if ((state.withdrawalType ?? 'fixed') === t) return;
      state.withdrawalType = t;
      document.querySelectorAll('[data-wd-type]').forEach(b =>
        b.classList.toggle('active', b.dataset.wdType === t));
      const wdAmtWrap = document.getElementById('withdrawalAmountWrap');
      const wdPctWrap = document.getElementById('withdrawalPercentWrap');
      if (wdAmtWrap) wdAmtWrap.style.display = t === 'fixed'   ? '' : 'none';
      if (wdPctWrap) wdPctWrap.style.display = t === 'percent' ? '' : 'none';
      recalc();
    });
  });

  document.querySelectorAll('[data-wd-contribs]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.wdContribs === 'true';
      if (!!(state.continueContribs) === v) return;
      state.continueContribs = v;
      document.querySelectorAll('[data-wd-contribs]').forEach(b =>
        b.classList.toggle('active', (b.dataset.wdContribs === 'true') === v));
      recalc();
    });
  });

  document.querySelectorAll('[data-wd-infladj]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.wdInfladj === 'true';
      if (!!(state.withdrawalInflationAdj) === v) return;
      state.withdrawalInflationAdj = v;
      document.querySelectorAll('[data-wd-infladj]').forEach(b =>
        b.classList.toggle('active', (b.dataset.wdInfladj === 'true') === v));
      recalc();
    });
  });

  document.getElementById('resetBtn')?.addEventListener('click', () => {
    state = { ...DEFAULTS };
    viewState = { showOptimistic: true, showPessimistic: true };
    populateFields();
    recalc();
  });
  document.getElementById('shareBtn')?.addEventListener('click', function () {
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
  initChart();
  populateFields();
  bindInputs();
  recalc();
}

document.addEventListener('DOMContentLoaded', init);
