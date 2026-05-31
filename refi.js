'use strict';

const REFI_LS_KEY = 'refiCalc_v5';

const DEFAULTS = {
  loanBalance:      350000,
  currentRate:      6.75,
  remainingYears:   25,
  newRate:          5.75,
  newTermYears:     30,
  closingCosts:     4000,
  prepaidCosts:     2000,
  points:           0,
  monthlyPMI:       0,
  stayYears:        7,
  stayUnknown:      false,
  investmentReturn: 7,
  rolledMode:       'none',
  rolledCosts:      0,
};

let state = { ...DEFAULTS };
let refiChart = null;

// ── Formatting helpers ──────────────────────────────────────────────
function fmt(n) {
  const abs = Math.abs(Math.round(n));
  return '$' + abs.toLocaleString();
}

function fmtMonths(mo) {
  if (!isFinite(mo) || mo > 600) return 'Never';
  if (mo <= 0) return 'Immediately';
  mo = Math.ceil(mo);
  const yrs = Math.floor(mo / 12);
  const mos = mo % 12;
  if (yrs === 0) return mo + ' mo';
  if (mos === 0) return yrs + (yrs === 1 ? ' yr' : ' yrs');
  return yrs + ' yr ' + mos + ' mo';
}

// ── Monthly payment ─────────────────────────────────────────────────
function monthlyPmt(principal, annualRatePct, termMonths) {
  if (termMonths <= 0 || principal <= 0) return 0;
  if (annualRatePct === 0) return principal / termMonths;
  const r = annualRatePct / 100 / 12;
  const f = Math.pow(1 + r, termMonths);
  return principal * r * f / (f - 1);
}

// ── Core calculation ────────────────────────────────────────────────
function calculate() {
  const s = state;
  const n1 = Math.round(s.remainingYears * 12);
  const n2 = Math.round(s.newTermYears * 12);
  const H  = Math.round(s.stayYears * 12);

  // Points cost (always out-of-pocket; not rollable)
  const pointsCost   = (s.points || 0) * s.loanBalance / 100;

  // Rolled closing costs (only base lender fees can be rolled; points and prepaids cannot)
  const prepaidCosts = s.prepaidCosts || 0;
  const totalCosts   = s.closingCosts + pointsCost + prepaidCosts;
  const rolledAmt    = s.rolledMode === 'all'
    ? s.closingCosts
    : s.rolledMode === 'some'
      ? Math.min(Math.max(s.rolledCosts || 0, 0), s.closingCosts)
      : 0;
  const outOfPocket = totalCosts - rolledAmt;
  const newLoanBal  = s.loanBalance + rolledAmt;

  const pmi = s.monthlyPMI || 0;

  const P1 = monthlyPmt(s.loanBalance, s.currentRate, n1);
  const P2 = monthlyPmt(newLoanBal,    s.newRate,     n2);

  const monthlySavings = (P1 + pmi) - P2;

  // Break-even: months to recoup out-of-pocket costs through savings
  const breakEvenMonths = monthlySavings > 0
    ? outOfPocket / monthlySavings
    : outOfPocket <= 0 ? 0 : Infinity;

  const totalIntCurrent = P1 * n1 - s.loanBalance;
  const totalIntNew     = P2 * n2 - newLoanBal;
  const interestSaved   = totalIntCurrent - totalIntNew;

  const savingsHorizon = Math.min(H, n1);
  const grossSavings   = monthlySavings * savingsHorizon;

  const rInv    = s.investmentReturn / 100 / 12;
  const oppCost = rInv > 0 && outOfPocket > 0
    ? outOfPocket * (Math.pow(1 + rInv, H) - 1)
    : 0;

  const netBenefit    = grossSavings - outOfPocket - oppCost;
  const termExtended  = n2 > n1;
  const termShortened = n2 < n1;

  return {
    P1, P2, monthlySavings, breakEvenMonths,
    totalIntCurrent, totalIntNew, interestSaved,
    grossSavings, oppCost, netBenefit,
    termExtended, termShortened, n1, n2, H, savingsHorizon,
    rolledAmt, outOfPocket, newLoanBal, prepaidCosts, totalCosts, pointsCost,
  };
}

// ── Chart ───────────────────────────────────────────────────────────
function renderChart(r) {
  const ctx = document.getElementById('refiChart');
  if (!ctx) return;

  const unknown = state.stayUnknown;
  const stayYrs = unknown
    ? (isFinite(r.breakEvenMonths) ? Math.max(r.breakEvenMonths / 12 * 2, 5) : 15)
    : state.stayYears;

  const maxYears = Math.min(
    Math.max(stayYrs * 1.5, isFinite(r.breakEvenMonths) ? r.breakEvenMonths / 12 * 1.5 : 5, 5),
    30
  );
  const points = Math.ceil(maxYears * 12) + 1;
  const labels = [];
  const savingsData = [];
  const ccData = [];

  for (let m = 0; m < points; m++) {
    const yr = m / 12;
    labels.push(yr % 1 === 0 ? 'Yr ' + yr : '');
    savingsData.push(r.monthlySavings * Math.min(m, r.n1));
    ccData.push(r.outOfPocket);
  }

  const stayIdx = unknown ? -1 : Math.round(state.stayYears * 12);
  const stayLineData = stayIdx >= 0 && stayIdx < labels.length
    ? labels.map(function(_, i) { return i === stayIdx ? Math.max(...savingsData, r.outOfPocket) * 1.1 : null; })
    : labels.map(function() { return null; });

  if (refiChart) { refiChart.destroy(); refiChart = null; }

  refiChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Cumulative savings',
          data: savingsData,
          borderColor: '#0d9488',
          backgroundColor: 'rgba(13,148,136,.08)',
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0,
        },
        {
          label: 'Out-of-pocket costs',
          data: ccData,
          borderColor: '#9ca3af',
          borderDash: [5, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
        {
          label: 'Your stay horizon',
          data: stayLineData,
          borderColor: '#818cf8',
          borderDash: [3, 3],
          borderWidth: 1.5,
          pointRadius: 0,
          showLine: false,
          fill: false,
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
              if (ctx.datasetIndex === 2) return null;
              const v = ctx.parsed.y;
              return ctx.dataset.label + ': ' + (v >= 0 ? '$' : '-$') + Math.abs(Math.round(v)).toLocaleString();
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
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
            callback: v => (v >= 0 ? '$' : '-$') + Math.abs(Math.round(v / 1000)) + 'k',
          },
        },
      },
    },
  });
}

// ── DOM update ──────────────────────────────────────────────────────
function render() {
  const r = calculate();
  const unknown = state.stayUnknown;
  const isTermReduction = r.monthlySavings < 0 && r.termShortened;

  // For term-reduction refinances, opportunity cost is measured over the new loan's full life
  // (since the interest savings are also measured over that full horizon)
  const lifetimeOppCost = isTermReduction ? (() => {
    const rInvMo = state.investmentReturn / 100 / 12;
    return rInvMo > 0 && r.outOfPocket > 0 ? r.outOfPocket * (Math.pow(1 + rInvMo, r.n2) - 1) : 0;
  })() : 0;

  // ── Stat tiles ──
  const elMonthly      = document.getElementById('stat-monthly');
  const elMonthlyLabel = document.getElementById('stat-monthly-label');
  const elBreakEven    = document.getElementById('stat-breakevenmonths');
  const elIntSaved     = document.getElementById('stat-intsaved');
  const elNet          = document.getElementById('stat-net');
  const elNetSub       = document.getElementById('stat-net-sub');

  const elMonthlySub = document.getElementById('stat-monthly-sub');

  if (elMonthly) {
    elMonthly.textContent = fmt(Math.abs(r.monthlySavings));
    elMonthly.className = 'refi-stat-value ' + (r.monthlySavings > 0 ? 'refi-stat-value--green' : r.monthlySavings < 0 ? 'refi-stat-value--red' : '');
    if (elMonthlyLabel) elMonthlyLabel.textContent = r.monthlySavings >= 0 ? 'MONTHLY SAVINGS' : 'MONTHLY INCREASE';
    if (elMonthlySub) elMonthlySub.textContent = state.monthlyPMI > 0 ? 'P&I + PMI difference' : 'P&I difference';
  }

  if (elBreakEven) {
    if (isTermReduction) {
      // Monthly payment goes up — closing costs are never recouped through savings; N/A is correct but not alarming
      elBreakEven.textContent = 'N/A';
      elBreakEven.className = 'refi-stat-value';
    } else if (!isFinite(r.breakEvenMonths) && r.monthlySavings <= 0) {
      elBreakEven.textContent = 'N/A';
      elBreakEven.className = 'refi-stat-value';
    } else if (!isFinite(r.breakEvenMonths)) {
      elBreakEven.textContent = 'Never';
      elBreakEven.className = 'refi-stat-value refi-stat-value--red';
    } else {
      elBreakEven.textContent = fmtMonths(r.breakEvenMonths);
      const beGood = isFinite(r.breakEvenMonths) && (unknown || r.breakEvenMonths <= state.stayYears * 12);
      elBreakEven.className = 'refi-stat-value ' + (beGood ? 'refi-stat-value--green' : 'refi-stat-value--red');
    }
  }

  if (elIntSaved) {
    elIntSaved.textContent = (r.interestSaved >= 0 ? '' : '-') + fmt(Math.abs(r.interestSaved));
    elIntSaved.className = 'refi-stat-value ' + (r.interestSaved > 0 ? 'refi-stat-value--green' : r.interestSaved < 0 ? 'refi-stat-value--red' : '');
  }

  if (elNet) {
    const elNetLabel = document.getElementById('stat-net-label');
    if (isTermReduction) {
      const lifetimeNet = r.interestSaved - r.outOfPocket - lifetimeOppCost;
      elNet.textContent = (lifetimeNet >= 0 ? '' : '-') + fmt(Math.abs(lifetimeNet));
      elNet.className = 'refi-stat-value ' + (lifetimeNet > 0 ? 'refi-stat-value--green' : lifetimeNet < 0 ? 'refi-stat-value--red' : '');
      if (elNetLabel) elNetLabel.textContent = 'LIFETIME SAVINGS';
      if (elNetSub) elNetSub.textContent = 'interest saved, after closing costs';
    } else {
      if (elNetLabel) elNetLabel.textContent = 'NET BENEFIT';
      let netToShow;
      if (unknown) {
        // No stay horizon set — compute over a 10-year benchmark so the tile stays live
        const H10 = 10 * 12;
        const sg10 = r.monthlySavings * Math.min(H10, r.n1);
        const rInv = state.investmentReturn / 100 / 12;
        const opp10 = rInv > 0 && r.outOfPocket > 0 ? r.outOfPocket * (Math.pow(1 + rInv, H10) - 1) : 0;
        netToShow = sg10 - r.outOfPocket - opp10;
      } else {
        netToShow = r.netBenefit;
      }
      elNet.textContent = (netToShow >= 0 ? '' : '-') + fmt(Math.abs(netToShow));
      elNet.className = 'refi-stat-value ' + (netToShow > 0 ? 'refi-stat-value--green' : netToShow < 0 ? 'refi-stat-value--red' : '');
      if (elNetSub) elNetSub.textContent = unknown
        ? 'est. over 10 years'
        : 'over ' + state.stayYears + '-yr stay, after costs';
    }
  }

  // ── Verdict ──
  const verdict = document.getElementById('refiVerdict');
  if (verdict) {
    let cls, icon, heading, body;

    if (r.monthlySavings < 0 && r.termShortened) {
      cls = 'refi-verdict--info';
      icon = 'ℹ';
      heading = 'Term-reduction refinance';
      body = `Your monthly payment increases by ${fmt(Math.abs(r.monthlySavings))}/mo, but you'll pay off your home ${state.remainingYears - state.newTermYears} years sooner and save ${fmt(r.interestSaved)} in total interest. This makes sense if your budget can absorb the higher payment.`;
    } else if (!isFinite(r.breakEvenMonths)) {
      cls = 'refi-verdict--red';
      icon = '✕';
      heading = 'Doesn\'t pencil out';
      body = `With a higher monthly payment and no total interest savings at these rates, this refinance doesn't benefit you financially. Your new rate may be higher than your current rate.`;
    } else if (unknown) {
      const beYrs = r.breakEvenMonths / 12;
      if (beYrs <= 0) {
        cls = 'refi-verdict--green'; icon = '✓';
        heading = 'Breaks even immediately';
        body = `With all closing costs rolled into the loan, there's no upfront hurdle — any positive monthly savings are pure gain from day one.`;
      } else if (beYrs <= 5) {
        cls = 'refi-verdict--green'; icon = '✓';
        heading = `Stay ${fmtMonths(r.breakEvenMonths)} or longer`;
        body = `This refinance breaks even in ${fmtMonths(r.breakEvenMonths)} — a relatively short commitment. If there's a reasonable chance you'll stay at least that long, refinancing likely makes sense.`;
      } else {
        cls = 'refi-verdict--amber'; icon = '⚠';
        heading = `You need to stay at least ${fmtMonths(r.breakEvenMonths)}`;
        body = `The break-even point is ${fmtMonths(r.breakEvenMonths)}. If you're uncertain whether you'll stay that long, consider negotiating lower closing costs or waiting for a larger rate reduction.`;
      }
    } else if (r.breakEvenMonths <= state.stayYears * 12 && r.netBenefit >= 0) {
      cls = 'refi-verdict--green'; icon = '✓';
      heading = 'Worth refinancing at your timeline';
      body = `You'll recoup the closing costs in ${fmtMonths(r.breakEvenMonths)} and net ${fmt(r.netBenefit)} over your ${state.stayYears}-year stay after accounting for the opportunity cost of your closing costs.`;
    } else if (r.breakEvenMonths <= state.stayYears * 12) {
      cls = 'refi-verdict--amber'; icon = '⚠';
      heading = 'Marginal — opportunity cost offsets savings';
      body = `You'll recoup the nominal closing costs in ${fmtMonths(r.breakEvenMonths)}, but after factoring in what those dollars could have earned if invested, the net benefit over your ${state.stayYears}-year stay is ${fmt(Math.abs(r.netBenefit))} in the red. A larger rate reduction or lower closing costs would tip it positive.`;
    } else {
      cls = 'refi-verdict--amber'; icon = '⚠';
      heading = 'Doesn\'t recoup within your stay';
      const shortfall = fmtMonths(r.breakEvenMonths - state.stayYears * 12);
      body = `You'd break even in ${fmtMonths(r.breakEvenMonths)}, but plan to stay ${state.stayYears} years — ${shortfall} short of break-even. Consider negotiating lower closing costs, waiting for a larger rate drop, or staying longer.`;
    }

    verdict.className = 'refi-verdict ' + cls;
    verdict.innerHTML = `<div class="refi-verdict-icon">${icon}</div><div class="refi-verdict-text"><strong>${heading}</strong><p>${body}</p></div>`;
  }

  // ── Interest Saved tile label ──
  const elIntSavedLabel = document.getElementById('stat-intsaved-label');
  const elIntSavedSub   = document.getElementById('stat-intsaved-sub');
  if (elIntSavedLabel) elIntSavedLabel.textContent = r.interestSaved < 0 ? 'INTEREST ADDED' : 'INTEREST SAVED';
  if (elIntSavedSub)   elIntSavedSub.textContent   = r.interestSaved < 0 ? 'more than staying put' : 'over full loan life';

  // ── Term extension warning ──
  const warnEl = document.getElementById('refiTermWarning');
  if (warnEl) {
    if (r.termExtended && r.monthlySavings > 0 && r.interestSaved < 0) {
      warnEl.style.display = 'flex';
      const extraYears = Math.round((r.n2 - r.n1) / 12);
      const extraYrStr = `${extraYears} year${extraYears !== 1 ? 's' : ''}`;
      const stayLabel  = unknown ? '10-year estimate' : `${state.stayYears}-year stay`;

      // Compute net benefit the same way the tile does
      let warnNetToShow;
      if (unknown) {
        const H10 = 10 * 12;
        const sg10 = r.monthlySavings * Math.min(H10, r.n1);
        const rInv = state.investmentReturn / 100 / 12;
        const opp10 = rInv > 0 && r.outOfPocket > 0 ? r.outOfPocket * (Math.pow(1 + rInv, H10) - 1) : 0;
        warnNetToShow = sg10 - r.outOfPocket - opp10;
      } else {
        warnNetToShow = r.netBenefit;
      }

      let msg;
      if (warnNetToShow > 0) {
        msg = `Extending your term by ${extraYrStr} lowers your monthly payment but increases total interest paid by ${fmt(Math.abs(r.interestSaved))} over the life of the loan. Net Benefit is positive because it only measures your ${stayLabel} — the monthly savings during that window outweigh your closing costs. If you hold the loan longer or sell later than planned, the total interest cost will continue to grow.`;
      } else {
        msg = `Extending your term by ${extraYrStr} lowers your monthly payment but increases total interest paid by ${fmt(Math.abs(r.interestSaved))} over the life of the loan. Net Benefit is also negative — the monthly savings over your ${stayLabel} don't cover your closing costs. This refinance doesn't make financial sense at your current rate, costs, and stay horizon.`;
      }

      warnEl.querySelector('span').textContent = msg;
    } else {
      warnEl.style.display = 'none';
    }
  }

  // ── Detail breakdown ──
  const d = document.getElementById('detail-current-pmt');
  if (d) d.textContent = fmt(r.P1) + '/mo';

  const pmiRow = document.getElementById('detail-pmi-row');
  const pmiEl  = document.getElementById('detail-pmi');
  if (pmiRow) pmiRow.style.display = state.monthlyPMI > 0 ? '' : 'none';
  if (pmiEl && state.monthlyPMI > 0) pmiEl.textContent = '+' + fmt(state.monthlyPMI) + '/mo eliminated';

  const ePmt = document.getElementById('detail-new-pmt');
  if (ePmt) ePmt.textContent = fmt(r.P2) + '/mo';

  const ePmtLabel = document.getElementById('detail-new-pmt-label');
  if (ePmtLabel) ePmtLabel.textContent = r.rolledAmt > 0
    ? `New monthly P&I (on ${fmt(r.newLoanBal)} balance)`
    : 'New monthly P&I';

  const f2 = document.getElementById('detail-monthly-diff');
  if (f2) {
    f2.textContent = (r.monthlySavings >= 0 ? '-' : '+') + fmt(Math.abs(r.monthlySavings)) + '/mo';
    f2.style.color = r.monthlySavings >= 0 ? 'var(--green)' : 'var(--red)';
  }

  const netSectionLabel = document.getElementById('detail-net-section-label');
  if (netSectionLabel) netSectionLabel.textContent = isTermReduction ? 'LIFETIME INTEREST SAVINGS' : 'NET BENEFIT OVER YOUR STAY';

  const grossLabel = document.getElementById('detail-gross-savings-label');
  const g = document.getElementById('detail-gross-savings');
  if (isTermReduction) {
    if (grossLabel) grossLabel.textContent = 'Total interest savings';
    if (g) { g.textContent = fmt(r.interestSaved); g.style.color = 'var(--green)'; }
  } else {
    if (grossLabel) grossLabel.textContent = unknown ? 'Payment savings over your stay' : `Payment savings over ${state.stayYears}-yr stay`;
    if (g) { g.textContent = unknown ? '—' : fmt(r.grossSavings); g.style.color = ''; }
  }

  // Points cost display helper
  const ptsDisplay = document.getElementById('pointsCostDisplay');
  if (ptsDisplay) {
    const pts = state.points || 0;
    if (pts > 0) {
      ptsDisplay.textContent = pts + (pts === 1 ? ' point' : ' points') + ' × ' + fmt(state.loanBalance) + ' = ' + fmt(r.pointsCost) + ' added to upfront costs';
    } else {
      ptsDisplay.textContent = 'Each point = 1% of loan balance, typically reduces your rate by ~0.125–0.25%.';
    }
  }

  const lenderCostEl    = document.getElementById('detail-lender-costs');
  const lenderCostLabel = document.getElementById('detail-lender-costs-label');
  if (lenderCostEl) {
    const lenderOOP = state.closingCosts - r.rolledAmt;
    lenderCostEl.textContent = lenderOOP > 0 ? '-' + fmt(lenderOOP) : '$0';
    lenderCostEl.style.color = lenderOOP > 0 ? 'var(--red)' : 'var(--text-muted)';
  }
  if (lenderCostLabel) lenderCostLabel.textContent = r.rolledAmt > 0 ? 'Lender costs (out-of-pocket)' : 'Lender closing costs';

  const ptsRow = document.getElementById('detail-points-row');
  const ptsEl  = document.getElementById('detail-points');
  if (ptsRow) ptsRow.style.display = (state.points > 0) ? '' : 'none';
  if (ptsEl && state.points > 0) ptsEl.textContent = '-' + fmt(r.pointsCost);

  const rolledRow = document.getElementById('detail-rolled-row');
  if (rolledRow) rolledRow.style.display = r.rolledAmt > 0 ? '' : 'none';
  const rolledEl = document.getElementById('detail-rolled');
  if (rolledEl) rolledEl.textContent = fmt(r.rolledAmt) + ' added to balance';

  const ppDetailEl = document.getElementById('detail-prepaid-costs');
  if (ppDetailEl) ppDetailEl.textContent = '-' + fmt(r.prepaidCosts);

  const ii = document.getElementById('detail-oppcost');
  if (ii) {
    if (!isTermReduction && unknown) {
      ii.textContent = '—';
    } else {
      ii.textContent = '-' + fmt(isTermReduction ? lifetimeOppCost : r.oppCost);
    }
  }

  const detailNetLabel = document.getElementById('detail-net-label');
  if (detailNetLabel) detailNetLabel.textContent = isTermReduction ? 'Net lifetime savings' : unknown ? 'Net benefit (est. 10 yr)' : 'Net benefit';

  const jj = document.getElementById('detail-net');
  if (jj) {
    let netVal;
    if (isTermReduction) {
      netVal = r.interestSaved - r.outOfPocket - lifetimeOppCost;
    } else if (unknown) {
      const H10 = 10 * 12;
      const sg10 = r.monthlySavings * Math.min(H10, r.n1);
      const rInv = state.investmentReturn / 100 / 12;
      const opp10 = rInv > 0 && r.outOfPocket > 0 ? r.outOfPocket * (Math.pow(1 + rInv, H10) - 1) : 0;
      netVal = sg10 - r.outOfPocket - opp10;
    } else {
      netVal = r.netBenefit;
    }
    jj.textContent = (netVal >= 0 ? '' : '-') + fmt(Math.abs(netVal));
    jj.style.color = netVal >= 0 ? 'var(--green)' : 'var(--red)';
  }

  const chartWrap = document.getElementById('refiChartWrap');
  const chartNote = document.getElementById('refiChartNote');
  if (isTermReduction) {
    if (refiChart) { refiChart.destroy(); refiChart = null; }
    if (chartWrap) {
      chartWrap.querySelector('canvas').style.display = 'none';
      chartWrap.querySelector('.chart-legend').style.display = 'none';
    }
    if (chartNote) chartNote.style.display = '';
  } else {
    if (chartWrap) {
      chartWrap.querySelector('canvas').style.display = '';
      chartWrap.querySelector('.chart-legend').style.display = '';
    }
    if (chartNote) chartNote.style.display = 'none';
    renderChart(r);
  }
}

// ── Unknown-mode UI sync ─────────────────────────────────────────────
function syncUnknownMode() {
  const unknown = state.stayUnknown;
  const btn = document.getElementById('stayUnknownBtn');
  const sliderRow = document.getElementById('staySliderRow');
  const valueDisplay = document.getElementById('stayValueDisplay');
  const note = document.getElementById('stayHorizonNote');
  if (btn) btn.classList.toggle('active', unknown);
  if (sliderRow) sliderRow.style.display = unknown ? 'none' : '';
  if (valueDisplay) valueDisplay.style.display = unknown ? 'none' : '';
  if (note) note.textContent = unknown
    ? 'Showing the minimum stay required to break even. Toggle off to set a stay duration and see your net benefit.'
    : 'The break-even and net benefit figures update based on your expected stay.';
}

// ── Roll-mode UI sync ────────────────────────────────────────────────
function syncRollMode() {
  const mode = state.rolledMode;
  document.querySelectorAll('[data-mode]').forEach(function(btn) {
    btn.classList.toggle('pill-btn--active', btn.dataset.mode === mode);
  });
  const partialField = document.getElementById('rolledAmountField');
  if (partialField) partialField.style.display = mode === 'some' ? '' : 'none';
}

// ── State management ────────────────────────────────────────────────
function setVal(key, val) {
  state[key] = val;
  saveState();
  render();
}

function saveState() {
  try { localStorage.setItem(REFI_LS_KEY, JSON.stringify(state)); } catch (_) {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(REFI_LS_KEY);
    if (raw) state = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) { state = { ...DEFAULTS }; }
}

function syncInputs() {
  for (const [key, val] of Object.entries(state)) {
    const el = document.getElementById(key);
    if (el && el.tagName === 'INPUT') el.value = val;
    if (el && el.tagName === 'SELECT') el.value = val;
  }
  const sd = document.getElementById('stayDisplay');
  if (sd) sd.textContent = state.stayYears;
  const rateSlider = document.getElementById('newRateSlider');
  if (rateSlider) rateSlider.value = state.newRate;
}

// ── Event wiring ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  loadState();
  syncInputs();
  syncUnknownMode();
  syncRollMode();
  render();

  // Number inputs
  ['loanBalance', 'currentRate', 'remainingYears', 'newRate', 'points', 'closingCosts', 'prepaidCosts', 'monthlyPMI', 'investmentReturn', 'rolledCosts'].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function () {
      const v = parseFloat(el.value);
      if (!isNaN(v) && v >= 0) setVal(id, v);
    });
    el.addEventListener('blur', function () {
      if (el.value === '' || el.value === null) {
        el.value = 0;
        setVal(id, 0);
      }
    });
  });

  // Fill closing-cost estimates (both lender fees and prepaids)
  const fillBtn = document.getElementById('fillClosingCosts');
  if (fillBtn) {
    fillBtn.addEventListener('click', function () {
      const lb = state.loanBalance || DEFAULTS.loanBalance;
      // Lender fees: ~$1,200 origination + 0.8% title/escrow/appraisal/recording
      const ccRaw = 1200 + lb * 0.008;
      const ccEst = Math.max(1500, Math.min(Math.round(ccRaw / 500) * 500, 20000));
      // Prepaid costs: ~$600 flat + 0.4% of loan (2 mo taxes + 2 mo insurance + prepaid interest)
      const ppRaw = 600 + lb * 0.004;
      const ppEst = Math.max(500, Math.min(Math.round(ppRaw / 250) * 250, 10000));
      state.closingCosts = ccEst;
      state.prepaidCosts = ppEst;
      const ccEl = document.getElementById('closingCosts');
      const ppEl = document.getElementById('prepaidCosts');
      if (ccEl) ccEl.value = ccEst;
      if (ppEl) ppEl.value = ppEst;
      saveState();
      render();
    });
  }

  // New rate slider — syncs with the newRate number input bidirectionally
  const rateSlider = document.getElementById('newRateSlider');
  const rateInput  = document.getElementById('newRate');
  if (rateSlider) {
    rateSlider.addEventListener('input', function () {
      const v = parseFloat(rateSlider.value);
      state.newRate = v;
      if (rateInput) rateInput.value = v;
      saveState();
      render();
    });
  }
  if (rateInput) {
    rateInput.addEventListener('input', function () {
      const v = parseFloat(rateInput.value);
      if (!isNaN(v) && rateSlider) rateSlider.value = v;
    });
  }

  // New term select
  const termSel = document.getElementById('newTermYears');
  if (termSel) {
    termSel.addEventListener('change', function () {
      setVal('newTermYears', parseInt(termSel.value));
    });
  }

  // Stay horizon slider
  const slider = document.getElementById('staySlider');
  const stayDisplay = document.getElementById('stayDisplay');
  if (slider) {
    slider.value = state.stayYears;
    slider.addEventListener('input', function () {
      const v = parseInt(slider.value);
      if (stayDisplay) stayDisplay.textContent = v;
      setVal('stayYears', v);
    });
  }

  // "I don't know" toggle
  const stayUnknownBtn = document.getElementById('stayUnknownBtn');
  if (stayUnknownBtn) {
    stayUnknownBtn.addEventListener('click', function () {
      state.stayUnknown = !state.stayUnknown;
      saveState();
      syncUnknownMode();
      render();
    });
  }

  // Roll-mode pill buttons
  document.querySelectorAll('[data-mode]').forEach(function(btn) {
    btn.addEventListener('click', function () {
      state.rolledMode = btn.dataset.mode;
      saveState();
      syncRollMode();
      render();
    });
  });

  // Reset
  document.getElementById('printBtn')?.addEventListener('click', () => window.print());

  const resetBtn = document.getElementById('resetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      state = { ...DEFAULTS };
      saveState();
      syncInputs();
      syncUnknownMode();
      syncRollMode();
      if (slider) slider.value = state.stayYears;
      render();
    });
  }

  // Advanced collapse
  const advToggle = document.getElementById('advToggle');
  const advBody   = document.getElementById('advBody');
  if (advToggle && advBody) {
    advToggle.addEventListener('click', function () {
      const expanded = advToggle.getAttribute('aria-expanded') === 'true';
      advToggle.setAttribute('aria-expanded', String(!expanded));
      if (expanded) {
        advBody.style.overflow = 'hidden';
        advBody.style.maxHeight = advBody.scrollHeight + 'px';
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { advBody.style.maxHeight = '0'; });
        });
      } else {
        advBody.style.overflow = 'hidden';
        advBody.style.maxHeight = advBody.scrollHeight + 'px';
        setTimeout(function () {
          if (advToggle.getAttribute('aria-expanded') === 'true') {
            advBody.style.overflow = 'visible';
            advBody.style.maxHeight = 'none';
          }
        }, 300);
      }
    });
  }
});
