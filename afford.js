(function () {

  var DEFAULTS = {
    income: 120000,
    debts: 500,
    downPayment: 60000,
    rate: 6.75,
    term: 30,
    taxRate: 1.2,
    insRate: 0.5,
    hoa: 0,
    pmiRate: 0.85
  };

  var STORAGE_KEY = 'afford_v2';
  var FRONT_LIMIT = 0.28;
  var BACK_LIMIT  = 0.43;

  var taxMode = 'pct';
  var insMode = 'pct';
  var pmiMode = 'pct';
  var lastResult = null;

  function fmtDollar(n) {
    if (!isFinite(n)) return '—';
    return '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  }
  function fmtPct(p) { return (p * 100).toFixed(1) + '%'; }

  function pmtFactor(r, n) {
    if (r === 0) return 1 / n;
    return r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  }

  function solve(inp) {
    if (inp.income <= 0) return null;
    var r       = inp.rate / 100 / 12;
    var n       = inp.term * 12;
    var grossMo = inp.income / 12;
    var factor  = pmtFactor(r, n);
    var hoa     = inp.hoa;
    var down    = inp.downPayment;

    // P-rate costs (% of home price or loan per month)
    var taxMoR = inp.taxMode === 'dollar' ? 0 : inp.taxRate / 100 / 12;
    var insMoR = inp.insMode === 'dollar' ? 0 : inp.insRate / 100 / 12;
    var pmiMoR = inp.pmiMode === 'dollar' ? 0 : inp.pmiRate / 100 / 12;

    // Flat monthly costs (when in dollar mode)
    var taxMoF = inp.taxMode === 'dollar' ? inp.taxRate / 12 : 0;
    var insMoF = inp.insMode === 'dollar' ? inp.insRate / 12 : 0;
    var pmiMoF = inp.pmiMode === 'dollar' ? inp.pmiRate      : 0;

    var maxFront = grossMo * FRONT_LIMIT;
    var maxBack  = Math.max(0, grossMo * BACK_LIMIT - inp.debts);
    var maxPITI  = Math.min(maxFront, maxBack);
    var binding  = maxFront <= maxBack ? 'front' : 'back';

    var fixedMo = hoa + taxMoF + insMoF;
    if (maxPITI <= fixedMo) return null;

    // Solve for P with PMI: (P−D)×(factor+pmiMoR) + pmiMoF + P×(taxMoR+insMoR) + fixedMo = maxPITI
    var fp    = factor + pmiMoR;
    var avail = maxPITI - fixedMo;
    var P_pmi = (avail - pmiMoF + down * fp) / (fp + taxMoR + insMoR);

    // Solve without PMI:
    var P_nop = (avail + down * factor) / (factor + taxMoR + insMoR);

    var ltv_check = P_nop > 0 ? Math.max(0, P_nop - down) / P_nop : 1;
    var P      = ltv_check <= 0.80 ? P_nop : P_pmi;
    var hasPmi = ltv_check > 0.80;

    if (P < 0) P = 0;
    var L   = Math.max(0, P - down);
    var ltv = P > 0 ? L / P : 0;

    var mPni   = L * factor;
    var mTax   = taxMoF || P * taxMoR;
    var mIns   = insMoF || P * insMoR;
    var mPmi   = hasPmi ? (pmiMoF || L * pmiMoR) : 0;
    var mTotal = mPni + mTax + mIns + mPmi + hoa;

    return {
      P: P, L: L, ltv: ltv, hasPmi: hasPmi,
      mTotal: mTotal, mPni: mPni, mTax: mTax, mIns: mIns, mPmi: mPmi, mHoa: hoa,
      frontDTI: mTotal / grossMo,
      backDTI:  (mTotal + inp.debts) / grossMo,
      binding: binding
    };
  }

  function getInputs() {
    return {
      income:      parseFloat(document.getElementById('income').value)      || 0,
      debts:       parseFloat(document.getElementById('debts').value)       || 0,
      downPayment: parseFloat(document.getElementById('downPayment').value) || 0,
      rate:        parseFloat(document.getElementById('rate').value)        || 6.75,
      term:        parseInt(document.getElementById('term').value)          || 30,
      taxRate:     parseFloat(document.getElementById('taxRate').value)     || (taxMode === 'dollar' ? 4800 : 1.2),
      insRate:     parseFloat(document.getElementById('insRate').value)     || (insMode === 'dollar' ? 2000 : 0.5),
      hoa:         parseFloat(document.getElementById('hoa').value)        || 0,
      pmiRate:     parseFloat(document.getElementById('pmiRate').value)    || (pmiMode === 'dollar' ? 200 : 0.85),
      taxMode:     taxMode,
      insMode:     insMode,
      pmiMode:     pmiMode
    };
  }

  function setEl(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }

  function dtiColor(pct, limit) {
    if (pct > limit - 0.06) return 'afford-dti-fill--amber';
    return 'afford-dti-fill--green';
  }

  function render(res) {
    if (!res) {
      ['stat-maxprice','stat-monthly','stat-frontdti','stat-backdti','stat-frontdti-2','stat-backdti-2'].forEach(function (id) { setEl(id, '—'); });
      return;
    }

    setEl('stat-maxprice',   fmtDollar(res.P));
    setEl('stat-monthly',    fmtDollar(res.mTotal));
    setEl('stat-frontdti',   fmtPct(res.frontDTI));
    setEl('stat-backdti',    fmtPct(res.backDTI));
    setEl('stat-frontdti-2', fmtPct(res.frontDTI));
    setEl('stat-backdti-2',  fmtPct(res.backDTI));
    setEl('mbar-v1', fmtDollar(res.P));
    setEl('mbar-v2', fmtDollar(res.mTotal) + '/mo');

    // Payment breakdown
    setEl('break-pni',   fmtDollar(res.mPni));
    setEl('break-tax',   fmtDollar(res.mTax));
    setEl('break-ins',   fmtDollar(res.mIns));
    setEl('break-pmi',   res.hasPmi ? fmtDollar(res.mPmi) : '—');
    setEl('break-hoa',   res.mHoa > 0 ? fmtDollar(res.mHoa) : '—');
    setEl('break-total', fmtDollar(res.mTotal));

    var pmiRow = document.getElementById('break-pmi-row');
    if (pmiRow) pmiRow.style.opacity = res.hasPmi ? '1' : '0.4';

    // DTI bars
    var frontFill = document.getElementById('dti-front-fill');
    var backFill  = document.getElementById('dti-back-fill');
    if (frontFill) {
      frontFill.style.width = Math.min(100, res.frontDTI / 0.45 * 100) + '%';
      frontFill.className = 'afford-dti-fill ' + dtiColor(res.frontDTI, FRONT_LIMIT);
    }
    if (backFill) {
      backFill.style.width = Math.min(100, res.backDTI / 0.55 * 100) + '%';
      backFill.className = 'afford-dti-fill ' + dtiColor(res.backDTI, BACK_LIMIT);
    }

    // Verdict
    var verdict = document.getElementById('affordVerdict');
    if (verdict) {
      var nearFront = res.frontDTI > FRONT_LIMIT - 0.04;
      var nearBack  = res.backDTI  > BACK_LIMIT  - 0.05;
      var cls, icon, title, body;
      if (nearFront || nearBack) {
        cls = 'refi-verdict--amber'; icon = '~';
        title = 'Near the limit: tight but typically approvable';
        body = 'Your DTI ratios are within conventional guidelines but close to the boundary. Some lenders may require compensating factors (a strong credit score, solid cash reserves, or stable employment) to approve at this level.';
      } else {
        cls = 'refi-verdict--green'; icon = '✓';
        title = 'Well within conventional lending guidelines';
        body = 'Both DTI ratios are comfortably below typical lender thresholds. Prices up to this level are generally approvable, subject to your credit score, employment history, and specific lender requirements.';
      }
      verdict.className = 'refi-verdict ' + cls;
      var iconEl  = verdict.querySelector('.refi-verdict-icon');
      var titleEl = verdict.querySelector('.refi-verdict-text strong');
      var bodyEl  = verdict.querySelector('.refi-verdict-text p');
      if (iconEl)  iconEl.textContent  = icon;
      if (titleEl) titleEl.textContent = title;
      if (bodyEl)  bodyEl.textContent  = body;
    }

    renderSensitivity();
  }

  function renderSensitivity() {
    var tbody = document.getElementById('sensRows');
    if (!tbody) return;
    var inp = getInputs();
    var offsets = [-1, -0.5, 0, 0.5, 1];
    var html = '';
    offsets.forEach(function (off) {
      var rt = inp.rate + off;
      if (rt <= 0) return;
      var r = solve(Object.assign({}, inp, {rate: rt}));
      if (!r) return;
      var cur = off === 0;
      html += '<tr' + (cur ? ' class="afford-sens-current"' : '') + '>' +
        '<td>' + rt.toFixed(2) + '%' + (cur ? ' <span class="afford-sens-badge">current</span>' : '') + '</td>' +
        '<td>' + fmtDollar(r.P) + '</td>' +
        '<td>' + fmtDollar(r.mTotal) + '/mo</td>' +
        '</tr>';
    });
    tbody.innerHTML = html;
  }

  function refreshAdvPanel() {
    var body = document.getElementById('advBody');
    if (body && body.style.maxHeight && body.style.maxHeight !== '0px') {
      body.style.maxHeight = body.scrollHeight + 'px';
    }
  }

  function update() {
    var inp = getInputs();
    if (inp.income <= 0) return;
    var res = solve(inp);
    lastResult = res;
    render(res);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(inp)); } catch(e) {}
  }

  function applyTaxMode(mode) {
    taxMode = mode;
    var prefix = document.getElementById('taxDollarPrefix');
    var input  = document.getElementById('taxRate');
    if (prefix) prefix.style.display = mode === 'dollar' ? '' : 'none';
    if (input) {
      if (mode === 'dollar') { input.removeAttribute('max'); input.step = '100'; }
      else                   { input.max = '5'; input.step = '0.1'; }
    }
    document.querySelectorAll('[data-tax-mode]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.taxMode === mode);
    });
    var helper = document.getElementById('taxHelper');
    if (helper) helper.textContent = mode === 'dollar'
      ? 'Annual property tax in dollars (÷ 12 for monthly escrow)'
      : 'Annual rate as % of home value; varies widely by location';
    refreshAdvPanel();
  }

  function applyInsMode(mode) {
    insMode = mode;
    var prefix = document.getElementById('insDollarPrefix');
    var input  = document.getElementById('insRate');
    if (prefix) prefix.style.display = mode === 'dollar' ? '' : 'none';
    if (input) {
      if (mode === 'dollar') { input.removeAttribute('max'); input.step = '50'; }
      else                   { input.max = '5'; input.step = '0.05'; }
    }
    document.querySelectorAll('[data-ins-mode]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.insMode === mode);
    });
    var helper = document.getElementById('insHelper');
    if (helper) helper.textContent = mode === 'dollar'
      ? 'Annual insurance premium in dollars (÷ 12 for monthly escrow)'
      : 'Annual insurance premium as % of home value';
    refreshAdvPanel();
  }

  function applyPmiMode(mode) {
    pmiMode = mode;
    var prefix = document.getElementById('pmiDollarPrefix');
    var input  = document.getElementById('pmiRate');
    if (prefix) prefix.style.display = mode === 'dollar' ? '' : 'none';
    if (input) {
      if (mode === 'dollar') { input.removeAttribute('max'); input.min = '0'; input.step = '10'; }
      else                   { input.max = '3'; input.min = '0.1'; input.step = '0.05'; }
    }
    document.querySelectorAll('[data-pmi-mode]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.pmiMode === mode);
    });
    var helper = document.getElementById('pmiHelper');
    if (helper) helper.textContent = mode === 'dollar'
      ? 'Monthly PMI in dollars; applies only if down payment < 20%'
      : 'Annual PMI as % of loan; applies only if down payment < 20%';
    refreshAdvPanel();
  }

  function setDefaults(v) {
    document.getElementById('income').value      = v.income      != null ? v.income      : DEFAULTS.income;
    document.getElementById('debts').value       = v.debts       != null ? v.debts       : DEFAULTS.debts;
    document.getElementById('downPayment').value = v.downPayment != null ? v.downPayment : DEFAULTS.downPayment;
    document.getElementById('rate').value        = v.rate        != null ? v.rate        : DEFAULTS.rate;
    document.getElementById('rateSlider').value  = v.rate        != null ? v.rate        : DEFAULTS.rate;
    document.getElementById('term').value        = v.term        != null ? v.term        : DEFAULTS.term;
    document.getElementById('taxRate').value     = v.taxRate     != null ? v.taxRate     : DEFAULTS.taxRate;
    document.getElementById('insRate').value     = v.insRate     != null ? v.insRate     : DEFAULTS.insRate;
    document.getElementById('hoa').value         = v.hoa || '';
    document.getElementById('pmiRate').value     = v.pmiRate     != null ? v.pmiRate     : DEFAULTS.pmiRate;
    if (v.taxMode) applyTaxMode(v.taxMode);
    if (v.insMode) applyInsMode(v.insMode);
    if (v.pmiMode) applyPmiMode(v.pmiMode);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var rateInput  = document.getElementById('rate');
    var rateSlider = document.getElementById('rateSlider');

    rateInput.addEventListener('input', function () { rateSlider.value = this.value; update(); });
    rateSlider.addEventListener('input', function () { rateInput.value = parseFloat(this.value).toFixed(2); update(); });

    ['income','debts','downPayment','taxRate','insRate','hoa','pmiRate'].forEach(function (id) {
      document.getElementById(id).addEventListener('input', update);
    });
    document.getElementById('term').addEventListener('change', update);

    document.querySelectorAll('[data-tax-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var newMode = btn.dataset.taxMode;
        if (taxMode === newMode) return;
        var input = document.getElementById('taxRate');
        var val = parseFloat(input.value);
        var ref = lastResult ? lastResult.P : 0;
        if (taxMode === 'pct' && newMode === 'dollar') {
          input.value = ref > 0 ? Math.round(val / 100 * ref / 100) * 100 : '';
        } else if (taxMode === 'dollar' && newMode === 'pct') {
          input.value = ref > 0 ? parseFloat((val / ref * 100).toFixed(2)) : DEFAULTS.taxRate;
        }
        applyTaxMode(newMode);
        update();
      });
    });

    document.querySelectorAll('[data-ins-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var newMode = btn.dataset.insMode;
        if (insMode === newMode) return;
        var input = document.getElementById('insRate');
        var val = parseFloat(input.value);
        var ref = lastResult ? lastResult.P : 0;
        if (insMode === 'pct' && newMode === 'dollar') {
          input.value = ref > 0 ? Math.round(val / 100 * ref / 100) * 100 : '';
        } else if (insMode === 'dollar' && newMode === 'pct') {
          input.value = ref > 0 ? parseFloat((val / ref * 100).toFixed(2)) : DEFAULTS.insRate;
        }
        applyInsMode(newMode);
        update();
      });
    });

    document.querySelectorAll('[data-pmi-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var newMode = btn.dataset.pmiMode;
        if (pmiMode === newMode) return;
        var input = document.getElementById('pmiRate');
        var val = parseFloat(input.value);
        var L = lastResult ? lastResult.L : 0;
        if (pmiMode === 'pct' && newMode === 'dollar') {
          input.value = L > 0 ? Math.round(val / 100 / 12 * L) : '';
        } else if (pmiMode === 'dollar' && newMode === 'pct') {
          input.value = L > 0 ? parseFloat((val * 12 / L * 100).toFixed(2)) : DEFAULTS.pmiRate;
        }
        applyPmiMode(newMode);
        update();
      });
    });

    var advToggle = document.getElementById('advToggle');
    var advBody   = document.getElementById('advBody');
    if (advToggle && advBody) {
      advToggle.addEventListener('click', function () {
        var open = this.getAttribute('aria-expanded') === 'true';
        this.setAttribute('aria-expanded', String(!open));
        advBody.style.maxHeight = open ? '0' : advBody.scrollHeight + 'px';
      });
    }

    document.getElementById('resetBtn').addEventListener('click', function () {
      localStorage.removeItem(STORAGE_KEY);
      setDefaults(DEFAULTS);
      applyTaxMode('pct');
      applyInsMode('pct');
      applyPmiMode('pct');
      update();
    });

    document.getElementById('shareBtn').addEventListener('click', function () {
      var inp = getInputs();
      var p = new URLSearchParams();
      Object.keys(inp).forEach(function (k) { p.set(k, inp[k]); });
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
    if (params.has('income')) {
      vals = {};
      ['income','debts','downPayment','rate','term','taxRate','insRate','hoa','pmiRate'].forEach(function (k) {
        vals[k] = params.has(k) ? parseFloat(params.get(k)) : DEFAULTS[k];
      });
      ['taxMode','insMode','pmiMode'].forEach(function (k) {
        if (params.has(k)) vals[k] = params.get(k);
      });
    } else if (saved) {
      vals = saved;
    }
    setDefaults(vals);
    update();
  });

}());
