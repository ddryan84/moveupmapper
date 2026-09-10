'use strict';

(function () {

  var DATA = (typeof module !== 'undefined' && typeof require === 'function')
    ? require('./ratefactors-data.js')
    : window.LLPA_DATA;

  var ATTRIBUTE_LABELS = {
    arm: 'Adjustable-rate mortgage',
    altFico: 'Alternative credit score method',
    condo: 'Condominium',
    investmentProperty: 'Investment property',
    manufacturedHome: 'Manufactured home',
    multiUnit: '2-4 unit property',
    secondHome: 'Second home',
    secondaryFinancing: 'Secondary financing (HELOC / 2nd lien)'
  };

  var STORAGE_KEY = 'ratefactors_v1';
  var DEFAULTS = {
    ficoScore: 720,
    downPct: 20,
    loanPurpose: 'purchase',
    occupancy: 'primary',
    propertyType: 'singleFamily',
    rateType: 'fixed',
    secondaryFinancing: 'no',
    ptsPerPoint: 0.25
  };

  function round3(n) { return Math.round(n * 1000) / 1000; }

  function findFicoBand(ficoBands, score) {
    for (var i = 0; i < ficoBands.length; i++) {
      if (score >= ficoBands[i].min && score <= ficoBands[i].max) return ficoBands[i];
    }
    return ficoBands[ficoBands.length - 1];
  }

  // Bands are published as "> lower & <= upper" (open lower bound, closed
  // upper bound), with the top band open-ended (max: null) — scan ascending
  // and take the first band whose upper bound the LTV doesn't exceed.
  function findLtvBandIndex(ltvBands, ltv) {
    for (var i = 0; i < ltvBands.length; i++) {
      if (ltvBands[i].max == null || ltv <= ltvBands[i].max) return i;
    }
    return ltvBands.length - 1;
  }

  function applicableAttributeKeys(inp) {
    var keys = [];
    if (inp.occupancy === 'secondHome') keys.push('secondHome');
    if (inp.occupancy === 'investment') keys.push('investmentProperty');
    if (inp.propertyType === 'condo') keys.push('condo');
    if (inp.propertyType === 'manufactured') keys.push('manufacturedHome');
    if (inp.propertyType === 'multiUnit') keys.push('multiUnit');
    if (inp.rateType === 'arm') keys.push('arm');
    if (inp.secondaryFinancing === 'yes') keys.push('secondaryFinancing');
    return keys;
  }

  // inp: { ficoScore, ltv, loanPurpose, occupancy, propertyType, rateType }
  function calcAdjustments(inp, data) {
    var grid = data[inp.loanPurpose];
    if (!grid) throw new Error('Unknown loan purpose: ' + inp.loanPurpose);

    if (grid.ineligibleAboveLtv != null && inp.ltv > grid.ineligibleAboveLtv) {
      return { eligible: false, ficoBand: null, ltvBand: null, items: [], totalPoints: null };
    }

    var ficoBand = findFicoBand(data.ficoBands, inp.ficoScore);
    var ltvIdx = findLtvBandIndex(grid.ltvBands, inp.ltv);
    var ltvBand = grid.ltvBands[ltvIdx];

    var items = [{
      key: 'base',
      label: 'Base (credit score × LTV)',
      points: grid.baseGrid[ficoBand.label][ltvIdx]
    }];

    applicableAttributeKeys(inp).forEach(function (key) {
      var arr = grid.specialAttributes[key];
      if (!arr || arr[ltvIdx] == null) return;
      items.push({ key: key, label: ATTRIBUTE_LABELS[key], points: arr[ltvIdx] });
    });

    var total = items.reduce(function (sum, it) { return sum + it.points; }, 0);

    return {
      eligible: true,
      ficoBand: ficoBand.label,
      ltvBand: ltvBand.label,
      items: items,
      totalPoints: round3(total)
    };
  }

  // Holds every other input constant and walks each credit-score band,
  // using the band's low end as a representative score (calcAdjustments
  // only cares which band a score falls in, not the exact number).
  function ficoSensitivity(inp, data) {
    var currentBand = findFicoBand(data.ficoBands, inp.ficoScore).label;
    return data.ficoBands.map(function (band) {
      var res = calcAdjustments(Object.assign({}, inp, { ficoScore: band.min }), data);
      return {
        label: band.label,
        eligible: res.eligible,
        totalPoints: res.totalPoints,
        isCurrent: band.label === currentBand
      };
    });
  }

  // Same idea for LTV bands. Each band's own max is a safe representative
  // LTV (falls inside that band); the open-ended top band has no max, so
  // fall back to a value above 95% (matching the highest published band).
  function ltvSensitivity(inp, data) {
    var grid = data[inp.loanPurpose];
    var currentIdx = findLtvBandIndex(grid.ltvBands, inp.ltv);
    return grid.ltvBands.map(function (band, idx) {
      var representativeLtv = band.max != null ? band.max : Math.max(inp.ltv, 96);
      var res = calcAdjustments(Object.assign({}, inp, { ltv: representativeLtv }), data);
      return {
        label: band.label,
        eligible: res.eligible,
        totalPoints: res.totalPoints,
        isCurrent: idx === currentIdx
      };
    });
  }

  // ptsPerPointPct: assumed rate-percentage-points impact per 1 price point
  // of LLPA adjustment (a commonly-cited rule of thumb, ~0.25, user-adjustable
  // in the UI — this is an explicit approximation, not a precise conversion).
  function pointsToRateDelta(points, ptsPerPointPct) {
    var ratio = ptsPerPointPct != null ? ptsPerPointPct : 0.25;
    return round3(points * ratio);
  }

  /* ── DOM wiring ── */
  if (typeof document !== 'undefined') {

    var loanPurpose = DEFAULTS.loanPurpose;
    var occupancy = DEFAULTS.occupancy;
    var rateType = DEFAULTS.rateType;
    var secondaryFinancing = DEFAULTS.secondaryFinancing;
    var currentRates = null;

    function fmtPoints(n) {
      var sign = n > 0 ? '+' : '';
      return sign + n.toFixed(3) + ' pts';
    }

    function fmtPct(n) {
      var sign = n > 0 ? '+' : '';
      return sign + n.toFixed(2) + '%';
    }

    function getInputs() {
      var downPct = parseFloat(document.getElementById('downPayment').value) || DEFAULTS.downPct;
      return {
        ficoScore: parseInt(document.getElementById('ficoScore').value, 10) || DEFAULTS.ficoScore,
        downPct: downPct,
        ltv: round3(100 - downPct),
        loanPurpose: loanPurpose,
        occupancy: occupancy,
        propertyType: document.getElementById('propertyType').value,
        rateType: rateType,
        secondaryFinancing: secondaryFinancing,
        ptsPerPoint: parseFloat(document.getElementById('ptsPerPoint').value) || DEFAULTS.ptsPerPoint
      };
    }

    function render(res, inp) {
      var ficoScoreVal = document.getElementById('ficoScoreVal');
      if (ficoScoreVal) ficoScoreVal.textContent = inp.ficoScore;
      var downPctVal = document.getElementById('downPctVal');
      if (downPctVal) downPctVal.textContent = inp.downPct + '%';
      var ltvVal = document.getElementById('ltvVal');
      if (ltvVal) ltvVal.textContent = inp.ltv + '%';

      var ineligibleEl = document.getElementById('rfIneligible');
      var bodyEl = document.getElementById('rfResultBody');
      var mbar1 = document.getElementById('mbar-v1');
      var mbar2 = document.getElementById('mbar-v2');

      if (!res.eligible) {
        if (ineligibleEl) ineligibleEl.style.display = '';
        if (bodyEl) bodyEl.style.display = 'none';
        if (mbar1) mbar1.textContent = 'N/A';
        if (mbar2) mbar2.textContent = 'N/A';
        var ficoRowsEl = document.getElementById('rfFicoSensRows');
        var ltvRowsEl = document.getElementById('rfLtvSensRows');
        if (ficoRowsEl) ficoRowsEl.innerHTML = '';
        if (ltvRowsEl) ltvRowsEl.innerHTML = '';
        var bandElIneligible = document.getElementById('rfBandSummary');
        if (bandElIneligible) bandElIneligible.textContent = 'Not eligible at this loan-to-value — see below';
        var armHintElIneligible = document.getElementById('armHint');
        if (armHintElIneligible) armHintElIneligible.textContent = '';
        return;
      }
      if (ineligibleEl) ineligibleEl.style.display = 'none';
      if (bodyEl) bodyEl.style.display = '';

      var bandEl = document.getElementById('rfBandSummary');
      if (bandEl) bandEl.textContent = 'Credit score band ' + res.ficoBand + ' · LTV band ' + res.ltvBand;

      var armHintEl = document.getElementById('armHint');
      if (armHintEl) {
        var grid = DATA[inp.loanPurpose];
        var ltvIdx = findLtvBandIndex(grid.ltvBands, inp.ltv);
        var armArr = grid.specialAttributes.arm;
        var armPts = armArr ? armArr[ltvIdx] : null;
        if (armPts == null || armPts === 0) {
          armHintEl.textContent = '';
        } else {
          armHintEl.textContent = inp.rateType === 'arm'
            ? 'ARM adds ' + fmtPoints(armPts) + ' at this LTV'
            : 'Switching to ARM would add ' + fmtPoints(armPts) + ' at this LTV';
        }
      }

      var listEl = document.getElementById('rfBreakdown');
      if (listEl) {
        listEl.innerHTML = '';
        res.items.forEach(function (it) {
          var row = document.createElement('div');
          row.className = 'afford-breakdown-row';
          var label = document.createElement('span');
          label.textContent = it.label;
          var val = document.createElement('strong');
          val.textContent = fmtPoints(it.points);
          row.appendChild(label);
          row.appendChild(val);
          listEl.appendChild(row);
        });
        var totalRow = document.createElement('div');
        totalRow.className = 'afford-breakdown-total';
        var totalLabel = document.createElement('span');
        totalLabel.textContent = 'Total adjustment';
        var totalVal = document.createElement('span');
        totalVal.textContent = fmtPoints(res.totalPoints);
        totalRow.appendChild(totalLabel);
        totalRow.appendChild(totalVal);
        listEl.appendChild(totalRow);
      }

      var rateDelta = pointsToRateDelta(res.totalPoints, inp.ptsPerPoint);
      if (mbar1) mbar1.textContent = fmtPoints(res.totalPoints);

      var baselineEl = document.getElementById('rfBaselineRate');
      var yourRateEl = document.getElementById('rfYourRate');
      var deltaSmallEl = document.getElementById('rfRateDeltaSmall');
      if (currentRates && currentRates.thirtyYear != null) {
        var estRate = round3(currentRates.thirtyYear + rateDelta);
        if (baselineEl) baselineEl.textContent = currentRates.thirtyYear.toFixed(2) + '%';
        if (yourRateEl) yourRateEl.textContent = '~' + estRate.toFixed(2) + '%';
        if (deltaSmallEl) {
          deltaSmallEl.textContent = res.totalPoints > 0
            ? fmtPct(rateDelta) + ' vs. baseline, at ' + inp.ptsPerPoint + '%/point'
            : 'Same as baseline — best-priced tier';
        }
        if (mbar2) mbar2.textContent = '~' + estRate.toFixed(2) + '%';
      } else {
        if (baselineEl) baselineEl.textContent = '—';
        if (yourRateEl) yourRateEl.textContent = '—';
        if (deltaSmallEl) deltaSmallEl.textContent = 'Loading today’s average rate…';
        if (mbar2) mbar2.textContent = '—';
      }

      renderSensitivityTables(inp);
    }

    function sensRowsHtml(list, inp) {
      return list.filter(function (r) { return r.eligible; }).map(function (r) {
        var rateCell = '—';
        if (currentRates && currentRates.thirtyYear != null) {
          var delta = pointsToRateDelta(r.totalPoints, inp.ptsPerPoint);
          rateCell = '~' + round3(currentRates.thirtyYear + delta).toFixed(2) + '%';
        }
        return '<tr' + (r.isCurrent ? ' class="afford-sens-current"' : '') + '>' +
          '<td>' + r.label + (r.isCurrent ? ' <span class="afford-sens-badge" style="background:#475569">current</span>' : '') + '</td>' +
          '<td>' + fmtPoints(r.totalPoints) + '</td>' +
          '<td>' + rateCell + '</td>' +
          '</tr>';
      }).join('');
    }

    function renderSensitivityTables(inp) {
      var ficoRowsEl = document.getElementById('rfFicoSensRows');
      var ltvRowsEl = document.getElementById('rfLtvSensRows');
      if (ficoRowsEl) ficoRowsEl.innerHTML = sensRowsHtml(ficoSensitivity(inp, DATA), inp);
      if (ltvRowsEl) ltvRowsEl.innerHTML = sensRowsHtml(ltvSensitivity(inp, DATA), inp);
    }

    function update() {
      var inp = getInputs();
      var res = calcAdjustments(inp, DATA);
      render(res, inp);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(inp)); } catch (e) {}
    }

    function setToggle(groupSelector, value, dataAttr) {
      document.querySelectorAll(groupSelector).forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset[dataAttr] === value);
      });
    }

    function setDefaults(v) {
      document.getElementById('ficoScore').value = v.ficoScore != null ? v.ficoScore : DEFAULTS.ficoScore;
      document.getElementById('downPayment').value = v.downPct != null ? v.downPct : DEFAULTS.downPct;
      document.getElementById('propertyType').value = v.propertyType || DEFAULTS.propertyType;
      document.getElementById('ptsPerPoint').value = v.ptsPerPoint != null ? v.ptsPerPoint : DEFAULTS.ptsPerPoint;
      loanPurpose = v.loanPurpose || DEFAULTS.loanPurpose;
      occupancy = v.occupancy || DEFAULTS.occupancy;
      rateType = v.rateType || DEFAULTS.rateType;
      secondaryFinancing = v.secondaryFinancing || DEFAULTS.secondaryFinancing;
      setToggle('[data-loan-purpose]', loanPurpose, 'loanPurpose');
      setToggle('[data-occupancy]', occupancy, 'occupancy');
      setToggle('[data-rate-type]', rateType, 'rateType');
      setToggle('[data-secondary-financing]', secondaryFinancing, 'secondaryFinancing');
    }

    document.addEventListener('DOMContentLoaded', function () {
      ['ficoScore', 'downPayment', 'ptsPerPoint'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', update);
      });
      var propType = document.getElementById('propertyType');
      if (propType) propType.addEventListener('change', update);

      document.querySelectorAll('[data-loan-purpose]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          loanPurpose = btn.dataset.loanPurpose;
          setToggle('[data-loan-purpose]', loanPurpose, 'loanPurpose');
          update();
        });
      });
      document.querySelectorAll('[data-occupancy]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          occupancy = btn.dataset.occupancy;
          setToggle('[data-occupancy]', occupancy, 'occupancy');
          update();
        });
      });
      document.querySelectorAll('[data-rate-type]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          rateType = btn.dataset.rateType;
          setToggle('[data-rate-type]', rateType, 'rateType');
          update();
        });
      });
      document.querySelectorAll('[data-secondary-financing]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          secondaryFinancing = btn.dataset.secondaryFinancing;
          setToggle('[data-secondary-financing]', secondaryFinancing, 'secondaryFinancing');
          update();
        });
      });

      var resetBtn = document.getElementById('resetBtn');
      if (resetBtn) {
        resetBtn.addEventListener('click', function () {
          try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
          setDefaults(DEFAULTS);
          update();
        });
      }

      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) {}
      setDefaults(saved || DEFAULTS);
      update();

      if (typeof fetchCurrentMortgageRates === 'function') {
        fetchCurrentMortgageRates().then(function (data) {
          currentRates = data;
          update();
        }).catch(function () {});
      }
    });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      findFicoBand: findFicoBand,
      findLtvBandIndex: findLtvBandIndex,
      applicableAttributeKeys: applicableAttributeKeys,
      calcAdjustments: calcAdjustments,
      ficoSensitivity: ficoSensitivity,
      ltvSensitivity: ltvSensitivity,
      pointsToRateDelta: pointsToRateDelta
    };
  }

}());
