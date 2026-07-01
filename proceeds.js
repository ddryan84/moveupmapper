(function () {

  var DEFAULTS = {
    salePrice:      650000,
    mortgage:       380000,
    listingComm:    2.5,
    buyerComm:      2.5,
    otherCosts:     1.5,
    otherCostsMode: 'pct',
    credits:        0
  };

  var STORAGE_KEY = 'proceeds_v2';
  var otherCostsMode = 'pct';

  function fmt(n) {
    if (!isFinite(n)) return '—';
    return '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  }
  function fmtSigned(n) {
    if (!isFinite(n)) return '—';
    if (n === 0) return '$0';
    return '−' + fmt(n);
  }
  function fmtPct(p) { return p.toFixed(2) + '%'; }

  function calc(sp, mort, lComm, bComm, other, credits, mode) {
    var listing  = sp * lComm  / 100;
    var buyer    = sp * bComm  / 100;
    var closing  = mode === 'dollar' ? other : sp * other / 100;
    var totalCosts = listing + buyer + closing + credits;
    var net      = sp - totalCosts - mort;
    return {
      sp: sp, mort: mort,
      listing: listing, buyer: buyer, closing: closing, credits: credits,
      totalCosts: totalCosts,
      net: net,
      grossEquity: sp - mort,
      costPct: sp > 0 ? totalCosts / sp * 100 : 0
    };
  }

  function getInputs() {
    return {
      salePrice:      parseFloat(document.getElementById('salePrice').value)   || 0,
      mortgage:       parseFloat(document.getElementById('mortgage').value)     || 0,
      listingComm:    parseFloat(document.getElementById('listingComm').value)  || 0,
      buyerComm:      parseFloat(document.getElementById('buyerComm').value)    || 0,
      otherCosts:     parseFloat(document.getElementById('otherCosts').value)   || 0,
      otherCostsMode: otherCostsMode,
      credits:        parseFloat(document.getElementById('credits').value)      || 0
    };
  }

  function setEl(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }

  function render(r) {
    // Stat tiles
    setEl('stat-net',         fmt(r.net));
    setEl('stat-gross-equity', fmt(r.grossEquity));
    setEl('stat-total-costs', fmt(r.totalCosts));
    setEl('stat-cost-pct',    fmtPct(r.costPct));

    var netStatEl = document.getElementById('stat-net');
    if (netStatEl) netStatEl.style.color = r.net < 0 ? 'var(--red)' : '';

    // Waterfall
    setEl('wf-sale',        fmt(r.sp));
    setEl('wf-listing',     fmtSigned(r.listing));
    setEl('wf-buyer',       r.buyer > 0 ? fmtSigned(r.buyer) : '—');
    setEl('wf-closing',     fmtSigned(r.closing));
    setEl('wf-credits',     r.credits > 0 ? fmtSigned(r.credits) : '—');
    setEl('wf-after-costs', fmt(r.sp - r.totalCosts));
    setEl('wf-mortgage',    fmtSigned(r.mort));
    setEl('wf-net',         fmt(r.net));

    var creditsRow = document.getElementById('wf-credits-row');
    if (creditsRow) creditsRow.style.opacity = r.credits > 0 ? '1' : '0.4';
    var buyerRowEl = document.getElementById('wf-buyer-row');
    if (buyerRowEl) buyerRowEl.style.opacity = r.buyer > 0 ? '1' : '0.4';

    var netTotalEl = document.getElementById('wf-net');
    if (netTotalEl) netTotalEl.className = 'proceeds-total-value' + (r.net < 0 ? ' proceeds-total-value--neg' : '');

    // Verdict
    var verdict = document.getElementById('proceedsVerdict');
    if (verdict) {
      var cls, icon, title, body;
      if (r.net < 0) {
        cls = 'refi-verdict--red'; icon = '!';
        title = 'Underwater — sale proceeds wouldn\'t cover the mortgage';
        body = 'After paying off the mortgage and selling costs, you\'d be short by ' + fmt(Math.abs(r.net)) + '. Consider whether the home has appreciated enough to sell, or discuss options with your lender.';
      } else if (r.grossEquity > 0 && r.net / r.grossEquity < 0.6) {
        cls = 'refi-verdict--amber'; icon = '~';
        title = 'Selling costs are a significant portion of your equity';
        body = 'You\'ll net ' + fmt(r.net) + ' — about ' + (r.net / r.grossEquity * 100).toFixed(0) + '% of your gross equity. Total selling costs represent ' + fmtPct(r.costPct) + ' of the sale price.';
      } else {
        cls = 'refi-verdict--green'; icon = '✓';
        title = 'Solid net proceeds from this sale';
        body = 'You\'ll walk away with ' + fmt(r.net) + '. Selling costs total ' + fmt(r.totalCosts) + ' (' + fmtPct(r.costPct) + ' of the sale price), leaving you with ' + (r.net / r.sp * 100).toFixed(1) + '% of gross sale value.';
      }
      verdict.className = 'refi-verdict ' + cls;
      var iconEl  = verdict.querySelector('.refi-verdict-icon');
      var titleEl = verdict.querySelector('.refi-verdict-text strong');
      var bodyEl  = verdict.querySelector('.refi-verdict-text p');
      if (iconEl)  iconEl.textContent  = icon;
      if (titleEl) titleEl.textContent = title;
      if (bodyEl)  bodyEl.textContent  = body;
    }

    // Mobile bar
    setEl('mbar-v1', fmt(r.net));
    setEl('mbar-v2', fmtPct(r.costPct) + ' costs');
  }

  function update() {
    var i = getInputs();
    if (i.salePrice <= 0) return;
    var r = calc(i.salePrice, i.mortgage, i.listingComm, i.buyerComm, i.otherCosts, i.credits, otherCostsMode);
    render(r);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(i)); } catch(e) {}
  }

  function applyOtherCostsMode(mode) {
    otherCostsMode = mode;
    var inp    = document.getElementById('otherCosts');
    var prefix = document.getElementById('otherCostsPrefix');
    var helper = document.getElementById('otherCostsHelper');
    if (mode === 'dollar') {
      inp.step = '500'; inp.removeAttribute('max');
      if (prefix) prefix.style.display = '';
    } else {
      inp.step = '0.25'; inp.max = '10';
      if (prefix) prefix.style.display = 'none';
    }
    if (helper) helper.textContent = mode === 'dollar'
      ? 'Enter exact dollar amount for title, transfer taxes, escrow, attorney fees'
      : 'Title, transfer tax, escrow, attorney — typically 1–2% of sale price';
    document.querySelectorAll('#otherCostsModeToggle .other-costs-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  function setDefaults(v) {
    document.getElementById('salePrice').value   = v.salePrice   != null ? v.salePrice   : DEFAULTS.salePrice;
    document.getElementById('mortgage').value    = v.mortgage    != null ? v.mortgage    : DEFAULTS.mortgage;
    document.getElementById('listingComm').value = v.listingComm != null ? v.listingComm : DEFAULTS.listingComm;
    document.getElementById('buyerComm').value   = v.buyerComm   != null ? v.buyerComm   : DEFAULTS.buyerComm;
    document.getElementById('otherCosts').value  = v.otherCosts  != null ? v.otherCosts  : DEFAULTS.otherCosts;
    document.getElementById('credits').value     = v.credits || '';
    applyOtherCostsMode(v.otherCostsMode || 'pct');
  }

  document.addEventListener('DOMContentLoaded', function () {
    ['salePrice','mortgage','listingComm','buyerComm','otherCosts','credits'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', update);
    });

    document.querySelectorAll('#otherCostsModeToggle .other-costs-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var newMode = btn.dataset.mode;
        if (newMode === otherCostsMode) return;
        var inp = document.getElementById('otherCosts');
        var val = parseFloat(inp.value) || 0;
        var sp  = parseFloat(document.getElementById('salePrice').value) || 0;
        if (newMode === 'dollar') {
          inp.value = sp > 0 ? Math.round(sp * val / 100) : '';
        } else {
          inp.value = sp > 0 ? parseFloat((val / sp * 100).toFixed(2)) : '';
        }
        applyOtherCostsMode(newMode);
        update();
      });
    });

    document.getElementById('resetBtn').addEventListener('click', function () {
      localStorage.removeItem(STORAGE_KEY);
      setDefaults(DEFAULTS);
      update();
    });

    document.getElementById('shareBtn').addEventListener('click', function () {
      var i = getInputs();
      var p = new URLSearchParams();
      Object.keys(i).forEach(function (k) { p.set(k, i[k]); });
      var url = location.origin + location.pathname + '?' + p;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function () {
          var btn = document.getElementById('shareBtn');
          var orig = btn.innerHTML;
          btn.innerHTML = 'Copied!';
          setTimeout(function () { btn.innerHTML = orig; }, 2000);
        });
      }
    });

    document.getElementById('printBtn').addEventListener('click', function () { window.print(); });

    var params = new URLSearchParams(location.search);
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch(e) {}
    var vals = DEFAULTS;
    if (params.has('salePrice')) {
      vals = {};
      ['salePrice','mortgage','listingComm','buyerComm','otherCosts','credits'].forEach(function (k) {
        vals[k] = params.has(k) ? parseFloat(params.get(k)) : DEFAULTS[k];
      });
      vals.otherCostsMode = params.get('otherCostsMode') || 'pct';
    } else if (saved) {
      vals = saved;
    }
    setDefaults(vals);
    update();
  });

}());
