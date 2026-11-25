/**
 * Live NIFTY Option Chain Controller
 * Renders 10 ITM + 1 ATM + 10 OTM Calls & Puts with real-time SSE tick updates.
 */

const ocState = {
  snapshot: null,
  previousNiftyLtp: null,
  previousOptionLtps: new Map(), // key -> ltp
  filterRange: 'all', // 'all' | '5'
  accounts: [],
  renderedKeySignature: ''
};

const OC_DOM = {
  topNiftyLtp: document.getElementById('topNiftyLtp'),
  topNiftyChange: document.getElementById('topNiftyChange'),
  topNiftyOpen: document.getElementById('topNiftyOpen'),
  topNiftyHigh: document.getElementById('topNiftyHigh'),
  topNiftyLow: document.getElementById('topNiftyLow'),
  topNiftyAtm: document.getElementById('topNiftyAtm'),
  topNiftyFeedPill: document.getElementById('topNiftyFeedPill'),
  topNiftyFeedStatus: document.getElementById('topNiftyFeedStatus'),

  activeFeedText: document.getElementById('activeFeedText'),
  sourceModeBadge: document.getElementById('sourceModeBadge'),
  istClock: document.getElementById('istClock'),
  marketPill: document.getElementById('marketPill'),
  recenterAtmBtn: document.getElementById('recenterAtmBtn'),
  toggleFeedBtn: document.getElementById('toggleFeedBtn'),
  connStatus: document.getElementById('connStatus'),
  connLabel: document.getElementById('connLabel'),

  ocFeedStateText: document.getElementById('ocFeedStateText'),
  ocFeedTimeBadge: document.getElementById('ocFeedTimeBadge'),
  ocExpiryLabel: document.getElementById('ocExpiryLabel'),
  ocLastTickTime: document.getElementById('ocLastTickTime'),
  ocAtmStrikeDisplay: document.getElementById('ocAtmStrikeDisplay'),
  ocStrikeRange: document.getElementById('ocStrikeRange'),
  ocContractCount: document.getElementById('ocContractCount'),
  ocPcrDisplay: document.getElementById('ocPcrDisplay'),
  ocTotalCeOi: document.getElementById('ocTotalCeOi'),
  ocTotalPeOi: document.getElementById('ocTotalPeOi'),
  ocMaxPeOiStrike: document.getElementById('ocMaxPeOiStrike'),
  ocMaxCeOiStrike: document.getElementById('ocMaxCeOiStrike'),

  optionChainBody: document.getElementById('optionChainBody'),
  filterBtns: document.querySelectorAll('.oc-filter-btn'),

  ocOrderModal: document.getElementById('ocOrderModal'),
  closeOcOrderModal: document.getElementById('closeOcOrderModal'),
  cancelOcOrderBtn: document.getElementById('cancelOcOrderBtn'),
  ocOrderModalTitle: document.getElementById('ocOrderModalTitle'),
  ocOrderForm: document.getElementById('ocOrderForm'),
  ocOrdSymbol: document.getElementById('ocOrdSymbol'),
  ocOrdSide: document.getElementById('ocOrdSide'),
  ocOrdSymbolLabel: document.getElementById('ocOrdSymbolLabel'),
  ocOrdLtpLabel: document.getElementById('ocOrdLtpLabel'),
  ocOrdBroker: document.getElementById('ocOrdBroker'),
  ocOrdProduct: document.getElementById('ocOrdProduct'),
  ocOrdQty: document.getElementById('ocOrdQty'),
  ocOrdType: document.getElementById('ocOrdType'),
  ocOrdPriceGroup: document.getElementById('ocOrdPriceGroup'),
  ocOrdPrice: document.getElementById('ocOrdPrice'),
  submitOcOrderBtn: document.getElementById('submitOcOrderBtn'),
  toastContainer: document.getElementById('toastContainer')
};

function toDisplayText(val, fallback = '') {
  if (val === undefined || val === null) return fallback;
  if (typeof val === 'string') return val;
  if (val instanceof Error) return val.message || fallback;
  if (typeof val === 'object') {
    const candidate = val.message || val.errMsg || val.error || val.description;
    if (typeof candidate === 'string') return candidate;
    try { return JSON.stringify(val); } catch (e) { return fallback; }
  }
  return String(val);
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${toDisplayText(message)}</span>`;
  OC_DOM.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function formatCompactNumber(num) {
  if (num === null || num === undefined) return '--';
  const n = Number(num);
  if (Number.isNaN(n)) return '--';
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return String(n);
}

function updateClock() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 3600000 * 5.5);

  const h = String(ist.getHours()).padStart(2, '0');
  const m = String(ist.getMinutes()).padStart(2, '0');
  const s = String(ist.getSeconds()).padStart(2, '0');
  OC_DOM.istClock.textContent = `${h}:${m}:${s} IST`;

  const day = ist.getDay();
  const totalMin = ist.getHours() * 60 + ist.getMinutes();
  const isOpen = day >= 1 && day <= 5 && totalMin >= 555 && totalMin <= 930;

  if (isOpen) {
    OC_DOM.marketPill.textContent = 'MARKET OPEN';
    OC_DOM.marketPill.className = 'market-pill open';
  } else {
    OC_DOM.marketPill.textContent = 'MARKET CLOSED';
    OC_DOM.marketPill.className = 'market-pill closed';
  }
}
setInterval(updateClock, 1000);
updateClock();

function updateTopNiftyBar(snapshot) {
  if (!snapshot || !snapshot.spot) return;
  const spot = snapshot.spot;
  const hasSpot = spot.ltp !== null && spot.ltp !== undefined;
  const prev = ocState.previousNiftyLtp;

  if (hasSpot) {
    const ltp = Number(spot.ltp);
    OC_DOM.topNiftyLtp.textContent = ltp.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });

    if (prev !== null && ltp !== prev) {
      OC_DOM.topNiftyLtp.classList.remove('flash-up', 'flash-down');
      void OC_DOM.topNiftyLtp.offsetWidth;
      OC_DOM.topNiftyLtp.classList.add(ltp > prev ? 'flash-up' : 'flash-down');
    }
    ocState.previousNiftyLtp = ltp;

    const chg = Number(spot.change || 0);
    const chgPct = Number(spot.changePct || 0);
    const sign = chg >= 0 ? '+' : '';
    OC_DOM.topNiftyChange.textContent = `${sign}${chg.toFixed(2)} (${sign}${chgPct.toFixed(2)}%)`;
    OC_DOM.topNiftyChange.className = `nifty-change mono ${chg >= 0 ? 'profit-text' : 'loss-text'}`;
  } else {
    OC_DOM.topNiftyLtp.textContent = '--';
    OC_DOM.topNiftyChange.textContent = 'Awaiting Live Quote';
    OC_DOM.topNiftyChange.className = 'nifty-change mono';
  }

  OC_DOM.topNiftyOpen.textContent = spot.open !== null && spot.open !== undefined ? Number(spot.open).toFixed(2) : '--';
  OC_DOM.topNiftyHigh.textContent = spot.high !== null && spot.high !== undefined ? Number(spot.high).toFixed(2) : '--';
  OC_DOM.topNiftyLow.textContent = spot.low !== null && spot.low !== undefined ? Number(spot.low).toFixed(2) : '--';
  OC_DOM.topNiftyAtm.textContent = snapshot.atmStrike || '--';

  const fs = snapshot.feedState || {};
  const brokerTag = fs.feedSubscribed && fs.subscribedBroker ? ` • ${formatFeedLabel(fs.subscribedBroker)}` : '';
  const isLive = fs.sourceMode === 'live_broker';
  if (fs.isRunning) {
    OC_DOM.topNiftyFeedPill.className = isLive ? 'nifty-feed-pill active' : 'nifty-feed-pill waiting';
    OC_DOM.topNiftyFeedStatus.textContent = isLive
      ? `9:00 AM Live Feed${brokerTag} • 10 ITM + ATM + 10 OTM CE/PE (${fs.totalContracts || 42})`
      : `9:00 AM Feed${brokerTag} • Awaiting Live Broker Quote`;
  } else if (fs.status === 'WAITING_9AM') {
    OC_DOM.topNiftyFeedPill.className = 'nifty-feed-pill waiting';
    OC_DOM.topNiftyFeedStatus.textContent = `Live Option Feed Scheduled for ${fs.scheduledTimeIST || '09:00 IST'}`;
  } else {
    OC_DOM.topNiftyFeedPill.className = 'nifty-feed-pill stopped';
    OC_DOM.topNiftyFeedStatus.textContent = 'Option Feed Paused';
  }
}

function formatFeedLabel(source) {
  if (source === 'angelone') return 'Angel One';
  if (source === 'dhan') return 'Dhan';
  return 'Kotak Neo';
}

function updateSummaryCards(snapshot) {
  const fs = snapshot.feedState || {};
  const summary = snapshot.summary || {};

  OC_DOM.activeFeedText.textContent = formatFeedLabel(fs.dataFeedSource);
  OC_DOM.sourceModeBadge.textContent = fs.sourceMode === 'live_broker' ? 'LIVE BROKER' : 'AWAITING LIVE';

  if (fs.isRunning) {
    OC_DOM.ocFeedStateText.textContent = fs.autoStarted9AM ? 'LIVE (9:00 AM)' : 'LIVE';
    OC_DOM.ocFeedStateText.className = 'metric-val profit-text';
    OC_DOM.ocFeedTimeBadge.className = 'metric-badge profit';
    OC_DOM.ocFeedTimeBadge.textContent = fs.startedAtIST ? `Started ${fs.startedAtIST}` : 'Active';
    OC_DOM.toggleFeedBtn.textContent = 'Pause Feed';
    OC_DOM.toggleFeedBtn.className = 'btn-warning btn-sm';
  } else if (fs.status === 'WAITING_9AM') {
    OC_DOM.ocFeedStateText.textContent = 'WAITING 9:00 AM';
    OC_DOM.ocFeedStateText.className = 'metric-val';
    OC_DOM.ocFeedTimeBadge.className = 'metric-badge';
    OC_DOM.ocFeedTimeBadge.textContent = fs.scheduledTimeIST || '09:00 IST';
    OC_DOM.toggleFeedBtn.textContent = 'Start Feed Now';
    OC_DOM.toggleFeedBtn.className = 'btn-primary btn-sm';
  } else {
    OC_DOM.ocFeedStateText.textContent = 'PAUSED';
    OC_DOM.ocFeedStateText.className = 'metric-val loss-text';
    OC_DOM.ocFeedTimeBadge.className = 'metric-badge loss';
    OC_DOM.ocFeedTimeBadge.textContent = 'Stopped';
    OC_DOM.toggleFeedBtn.textContent = 'Resume Feed';
    OC_DOM.toggleFeedBtn.className = 'btn-primary btn-sm';
  }

  OC_DOM.ocExpiryLabel.textContent = snapshot.expiryLabel || '--';
  OC_DOM.ocLastTickTime.textContent = new Date(snapshot.timestamp || Date.now()).toLocaleTimeString();
  OC_DOM.ocAtmStrikeDisplay.textContent = snapshot.atmStrike || '--';

  const strikes = snapshot.strikes || [];
  if (strikes.length > 0) {
    OC_DOM.ocStrikeRange.textContent = `${strikes[0].strike} – ${strikes[strikes.length - 1].strike}`;
    OC_DOM.ocContractCount.textContent = `${strikes.length * 2} (${strikes.length} CE / ${strikes.length} PE)`;
  } else {
    OC_DOM.ocStrikeRange.textContent = '--';
    OC_DOM.ocContractCount.textContent = 'Awaiting Live Spot';
  }

  OC_DOM.ocPcrDisplay.textContent = summary.pcr !== null && summary.pcr !== undefined ? Number(summary.pcr).toFixed(2) : '--';
  OC_DOM.ocTotalCeOi.textContent = formatCompactNumber(summary.totalCeOi);
  OC_DOM.ocTotalPeOi.textContent = formatCompactNumber(summary.totalPeOi);
  OC_DOM.ocMaxPeOiStrike.textContent = summary.maxPeOiStrike || '--';
  OC_DOM.ocMaxCeOiStrike.textContent = summary.maxCeOiStrike || '--';
}

function getFilteredStrikes(strikes) {
  if (ocState.filterRange === '5') {
    return strikes.filter(r => Math.abs(r.distanceSteps) <= 5);
  }
  return strikes;
}

function formatChangeText(chg, chgPct) {
  if (chg === null || chg === undefined) return '--';
  const c = Number(chg);
  const p = chgPct !== null && chgPct !== undefined ? Number(chgPct) : 0;
  const sign = c >= 0 ? '+' : '';
  return `${sign}${c.toFixed(2)} (${sign}${p.toFixed(1)}%)`;
}

function formatPrice(val) {
  return val !== null && val !== undefined ? `₹${Number(val).toFixed(2)}` : '--';
}

function formatBidAsk(bid, ask) {
  if (bid === null || bid === undefined || ask === null || ask === undefined) return '--';
  return `${Number(bid).toFixed(2)} / ${Number(ask).toFixed(2)}`;
}

function formatIv(iv) {
  return iv !== null && iv !== undefined ? `${Number(iv).toFixed(2)}%` : '--';
}

function getBuildupClass(code) {
  return code ? code.replace(/_/g, '-') : 'otm';
}

function renderOptionChainTable(snapshot) {
  const allStrikes = snapshot.strikes || [];
  const strikes = getFilteredStrikes(allStrikes);

  if (strikes.length === 0) {
    OC_DOM.optionChainBody.innerHTML = `<tr><td colspan="17" class="empty-state">Awaiting live broker feed — log in an active live broker account (Angel One, Kotak Neo, or Dhan) to stream live NIFTY &amp; 10 ITM + ATM + 10 OTM Option Chain data.</td></tr>`;
    ocState.renderedKeySignature = '';
    return;
  }

  const maxOi = Math.max(
    1,
    ...allStrikes.map(r => Math.max(r.ce.oi || 0, r.pe.oi || 0))
  );

  const signature = `${ocState.filterRange}:${strikes.map(r => r.strike).join(',')}`;
  const canPatchInPlace = ocState.renderedKeySignature === signature;

  if (!canPatchInPlace) {
    let html = '';
    strikes.forEach(row => {
      const ce = row.ce;
      const pe = row.pe;
      const ceItmClass = ce.moneyness === 'ITM' ? 'oc-itm-ce' : '';
      const peItmClass = pe.moneyness === 'ITM' ? 'oc-itm-pe' : '';
      const atmClass = row.isAtm ? 'oc-atm-row' : '';
      const ceChgClass = ce.change === null ? '' : (ce.change >= 0 ? 'profit-text' : 'loss-text');
      const peChgClass = pe.change === null ? '' : (pe.change >= 0 ? 'profit-text' : 'loss-text');

      html += `
        <tr class="${atmClass}" data-strike="${row.strike}">
          <td class="${ceItmClass}">
            <span class="badge buildup-badge ${getBuildupClass(ce.oiBuildupCode)}" id="ce-buildup-${row.strike}">${ce.oiBuildup || '--'}</span>
          </td>
          <td class="text-right mono ${ceItmClass}">
            <div class="oi-cell">
              <div class="oi-bar-bg ce"><div class="oi-bar-fill ce" id="ce-oibar-${row.strike}" style="width: ${ce.oi ? Math.min(100, (ce.oi / maxOi) * 100).toFixed(1) : 0}%"></div></div>
              <span id="ce-oi-${row.strike}">${formatCompactNumber(ce.oi)}</span>
            </div>
          </td>
          <td class="text-right mono ${ceItmClass}" id="ce-vol-${row.strike}">${formatCompactNumber(ce.volume)}</td>
          <td class="text-right mono ${ceItmClass}" id="ce-iv-${row.strike}">${formatIv(ce.iv)}</td>
          <td class="text-right mono ${ceItmClass}" id="ce-ba-${row.strike}">${formatBidAsk(ce.bid, ce.ask)}</td>
          <td class="text-right mono ${ceItmClass} ${ceChgClass}" id="ce-chg-${row.strike}">${formatChangeText(ce.change, ce.changePct)}</td>
          <td class="text-right mono oc-ltp-cell ${ceItmClass}" id="ce-ltp-${row.strike}">${formatPrice(ce.ltp)}</td>
          <td class="text-center ${ceItmClass}">
            <div class="oc-trade-btns">
              <button class="btn-oc-buy" data-symbol="${ce.symbol}" data-side="B" data-ltp="${ce.ltp || 0}" title="Buy ${ce.symbol}">B</button>
              <button class="btn-oc-sell" data-symbol="${ce.symbol}" data-side="S" data-ltp="${ce.ltp || 0}" title="Sell ${ce.symbol}">S</button>
            </div>
          </td>

          <td class="text-center mono oc-strike-cell">
            <strong>${row.strike}</strong>
            ${row.isAtm ? '<span class="atm-tag">ATM</span>' : ''}
          </td>

          <td class="text-center ${peItmClass}">
            <div class="oc-trade-btns">
              <button class="btn-oc-buy" data-symbol="${pe.symbol}" data-side="B" data-ltp="${pe.ltp || 0}" title="Buy ${pe.symbol}">B</button>
              <button class="btn-oc-sell" data-symbol="${pe.symbol}" data-side="S" data-ltp="${pe.ltp || 0}" title="Sell ${pe.symbol}">S</button>
            </div>
          </td>
          <td class="text-right mono oc-ltp-cell ${peItmClass}" id="pe-ltp-${row.strike}">${formatPrice(pe.ltp)}</td>
          <td class="text-right mono ${peItmClass} ${peChgClass}" id="pe-chg-${row.strike}">${formatChangeText(pe.change, pe.changePct)}</td>
          <td class="text-right mono ${peItmClass}" id="pe-ba-${row.strike}">${formatBidAsk(pe.bid, pe.ask)}</td>
          <td class="text-right mono ${peItmClass}" id="pe-iv-${row.strike}">${formatIv(pe.iv)}</td>
          <td class="text-right mono ${peItmClass}" id="pe-vol-${row.strike}">${formatCompactNumber(pe.volume)}</td>
          <td class="text-right mono ${peItmClass}">
            <div class="oi-cell">
              <div class="oi-bar-bg pe"><div class="oi-bar-fill pe" id="pe-oibar-${row.strike}" style="width: ${pe.oi ? Math.min(100, (pe.oi / maxOi) * 100).toFixed(1) : 0}%"></div></div>
              <span id="pe-oi-${row.strike}">${formatCompactNumber(pe.oi)}</span>
            </div>
          </td>
          <td class="${peItmClass}">
            <span class="badge buildup-badge ${getBuildupClass(pe.oiBuildupCode)}" id="pe-buildup-${row.strike}">${pe.oiBuildup || '--'}</span>
          </td>
        </tr>
      `;
    });
    OC_DOM.optionChainBody.innerHTML = html;
    ocState.renderedKeySignature = signature;

    strikes.forEach(row => {
      if (row.ce.ltp !== null) ocState.previousOptionLtps.set(row.ce.symbol, row.ce.ltp);
      if (row.pe.ltp !== null) ocState.previousOptionLtps.set(row.pe.symbol, row.pe.ltp);
    });
    return;
  }

  // Smooth in-place updates so cells flash without rebuilding DOM
  strikes.forEach(row => {
    patchLegCells(row.strike, 'ce', row.ce, maxOi);
    patchLegCells(row.strike, 'pe', row.pe, maxOi);
  });
}

function patchLegCells(strike, prefix, leg, maxOi) {
  const buildupEl = document.getElementById(`${prefix}-buildup-${strike}`);
  const ltpEl = document.getElementById(`${prefix}-ltp-${strike}`);
  const chgEl = document.getElementById(`${prefix}-chg-${strike}`);
  const baEl = document.getElementById(`${prefix}-ba-${strike}`);
  const ivEl = document.getElementById(`${prefix}-iv-${strike}`);
  const volEl = document.getElementById(`${prefix}-vol-${strike}`);
  const oiEl = document.getElementById(`${prefix}-oi-${strike}`);
  const oiBarEl = document.getElementById(`${prefix}-oibar-${strike}`);

  if (!ltpEl) return;

  if (buildupEl) {
    buildupEl.textContent = leg.oiBuildup || '--';
    buildupEl.className = `badge buildup-badge ${getBuildupClass(leg.oiBuildupCode)}`;
  }

  const prevLtp = ocState.previousOptionLtps.get(leg.symbol);
  if (prevLtp !== undefined && leg.ltp !== null && leg.ltp !== prevLtp) {
    ltpEl.classList.remove('flash-up', 'flash-down');
    void ltpEl.offsetWidth;
    ltpEl.classList.add(leg.ltp > prevLtp ? 'flash-up' : 'flash-down');
  }
  if (leg.ltp !== null) ocState.previousOptionLtps.set(leg.symbol, leg.ltp);

  ltpEl.textContent = formatPrice(leg.ltp);

  if (chgEl) {
    chgEl.textContent = formatChangeText(leg.change, leg.changePct);
    chgEl.classList.remove('profit-text', 'loss-text');
    if (leg.change !== null) {
      chgEl.classList.add(leg.change >= 0 ? 'profit-text' : 'loss-text');
    }
  }
  if (baEl) baEl.textContent = formatBidAsk(leg.bid, leg.ask);
  if (ivEl) ivEl.textContent = formatIv(leg.iv);
  if (volEl) volEl.textContent = formatCompactNumber(leg.volume);
  if (oiEl) oiEl.textContent = formatCompactNumber(leg.oi);
  if (oiBarEl) oiBarEl.style.width = `${leg.oi ? Math.min(100, (leg.oi / maxOi) * 100).toFixed(1) : 0}%`;

  const rowEl = ltpEl.closest('tr');
  if (rowEl) {
    rowEl.querySelectorAll(`button[data-symbol="${leg.symbol}"]`).forEach(btn => {
      btn.setAttribute('data-ltp', String(leg.ltp || 0));
    });
  }
}

function handleSnapshot(snapshot) {
  ocState.snapshot = snapshot;
  updateTopNiftyBar(snapshot);
  updateSummaryCards(snapshot);
  renderOptionChainTable(snapshot);
}

async function loadInitialSnapshot() {
  try {
    const res = await fetch('/api/nifty-feed');
    const d = await res.json();
    if (d.success && d.data) {
      handleSnapshot(d.data);
    }
  } catch (e) {}
}

async function loadAccounts() {
  try {
    const res = await fetch('/api/accounts');
    const d = await res.json();
    if (d.success && Array.isArray(d.data)) {
      ocState.accounts = d.data;
      OC_DOM.ocOrdBroker.innerHTML = '';
      if (d.data.length === 0) {
        const opt = document.createElement('option');
        opt.value = 'mock_kotak_1';
        opt.textContent = 'Default Broker (Simulation)';
        OC_DOM.ocOrdBroker.appendChild(opt);
      } else {
        d.data.forEach(acc => {
          const opt = document.createElement('option');
          opt.value = acc.id;
          opt.textContent = `${acc.name} (${acc.broker.toUpperCase()})`;
          OC_DOM.ocOrdBroker.appendChild(opt);
        });
      }
    }
  } catch (e) {}
}

function initEventSource() {
  const es = new EventSource('/api/stream');

  es.addEventListener('connected', () => {
    OC_DOM.connLabel.textContent = 'Live SSE Active';
    OC_DOM.connStatus.querySelector('.status-indicator').className = 'status-indicator online';
  });

  es.addEventListener('nifty_tick', e => {
    try {
      const snapshot = JSON.parse(e.data);
      handleSnapshot(snapshot);
    } catch (err) {}
  });

  es.addEventListener('feed_subscribed', e => {
    try {
      const info = JSON.parse(e.data);
      showToast(`Feed subscribed via ${formatFeedLabel(info.broker)} (${info.accountName || 'Active'})`, 'success');
    } catch (err) {}
  });

  es.onerror = () => {
    OC_DOM.connLabel.textContent = 'Reconnecting...';
    OC_DOM.connStatus.querySelector('.status-indicator').className = 'status-indicator offline';
  };
}

// Button handlers
OC_DOM.toggleFeedBtn.addEventListener('click', async () => {
  const isRunning = ocState.snapshot && ocState.snapshot.feedState && ocState.snapshot.feedState.isRunning;
  const endpoint = isRunning ? '/api/nifty-feed/stop' : '/api/nifty-feed/start';
  try {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await res.json();
    if (d.success && d.data) {
      handleSnapshot(d.data);
      showToast(isRunning ? 'Option Chain feed paused.' : 'NIFTY Option Chain feed started!', 'info');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
});

OC_DOM.recenterAtmBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/nifty-feed/recenter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await res.json();
    if (d.success && d.data) {
      handleSnapshot(d.data);
      showToast(`Option Chain recentered to ATM ${d.data.atmStrike}`, 'success');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
});

OC_DOM.filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    OC_DOM.filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ocState.filterRange = btn.getAttribute('data-range') || 'all';
    if (ocState.snapshot) {
      renderOptionChainTable(ocState.snapshot);
    }
  });
});

// Quick order delegation on option chain table
OC_DOM.optionChainBody.addEventListener('click', e => {
  const btn = e.target.closest('.btn-oc-buy, .btn-oc-sell');
  if (!btn) return;
  const symbol = btn.getAttribute('data-symbol');
  const side = btn.getAttribute('data-side');
  const ltp = Number(btn.getAttribute('data-ltp') || 0);

  OC_DOM.ocOrdSymbol.value = symbol;
  OC_DOM.ocOrdSide.value = side;
  OC_DOM.ocOrdSymbolLabel.textContent = symbol;
  OC_DOM.ocOrdLtpLabel.textContent = `₹${ltp.toFixed(2)}`;
  OC_DOM.ocOrdPrice.value = ltp.toFixed(2);
  OC_DOM.ocOrderModalTitle.textContent = `${side === 'B' ? 'BUY' : 'SELL'} Option: ${symbol}`;
  OC_DOM.submitOcOrderBtn.className = side === 'B' ? 'btn-primary btn-buy' : 'btn-primary btn-sell';
  OC_DOM.submitOcOrderBtn.textContent = `Place ${side === 'B' ? 'BUY' : 'SELL'} Order`;
  OC_DOM.ocOrderModal.classList.add('active');
});

OC_DOM.ocOrdType.addEventListener('change', () => {
  OC_DOM.ocOrdPriceGroup.style.display = OC_DOM.ocOrdType.value === 'L' ? 'flex' : 'none';
});

OC_DOM.closeOcOrderModal.addEventListener('click', () => OC_DOM.ocOrderModal.classList.remove('active'));
OC_DOM.cancelOcOrderBtn.addEventListener('click', () => OC_DOM.ocOrderModal.classList.remove('active'));

OC_DOM.ocOrderForm.addEventListener('submit', async e => {
  e.preventDefault();
  const payload = {
    accountId: OC_DOM.ocOrdBroker.value,
    tradingSymbol: OC_DOM.ocOrdSymbol.value,
    exchangeSegment: 'nse_fo',
    transactionType: OC_DOM.ocOrdSide.value,
    product: OC_DOM.ocOrdProduct.value,
    orderType: OC_DOM.ocOrdType.value,
    quantity: Number(OC_DOM.ocOrdQty.value),
    price: OC_DOM.ocOrdType.value === 'L' ? Number(OC_DOM.ocOrdPrice.value || 0) : 0
  };

  OC_DOM.submitOcOrderBtn.disabled = true;
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (d.success) {
      showToast(`Order placed: ${payload.transactionType === 'B' ? 'BUY' : 'SELL'} ${payload.tradingSymbol} x ${payload.quantity}`, 'success');
      OC_DOM.ocOrderModal.classList.remove('active');
    } else {
      showToast(d.message || 'Order failed', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    OC_DOM.submitOcOrderBtn.disabled = false;
  }
});

window.addEventListener('DOMContentLoaded', () => {
  loadInitialSnapshot();
  loadAccounts();
  initEventSource();
});
