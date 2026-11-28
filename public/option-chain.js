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
  ocOrdToken: document.getElementById('ocOrdToken'),
  ocOrdSide: document.getElementById('ocOrdSide'),
  ocOrdQtyLabel: document.getElementById('ocOrdQtyLabel'),
  ocOrdBalanceLabel: document.getElementById('ocOrdBalanceLabel'),
  ocAutoQty: document.getElementById('ocAutoQty'),
  ocSizingHint: document.getElementById('ocSizingHint'),
  ocOrdSymbolLabel: document.getElementById('ocOrdSymbolLabel'),
  ocOrdLtpLabel: document.getElementById('ocOrdLtpLabel'),
  ocOrdBroker: document.getElementById('ocOrdBroker'),
  ocOrdRoutingMode: document.getElementById('ocOrdRoutingMode'),
  ocDayCapHint: document.getElementById('ocDayCapHint'),
  ocOrdProduct: document.getElementById('ocOrdProduct'),
  ocOrdQty: document.getElementById('ocOrdQty'),
  ocOrdType: document.getElementById('ocOrdType'),
  ocOrdPricingRow: document.getElementById('ocOrdPricingRow'),
  ocOrdTriggerGroup: document.getElementById('ocOrdTriggerGroup'),
  ocOrdTriggerPrice: document.getElementById('ocOrdTriggerPrice'),
  ocOrdPriceGroup: document.getElementById('ocOrdPriceGroup'),
  ocOrdPriceLabel: document.getElementById('ocOrdPriceLabel'),
  ocOrdPriceHint: document.getElementById('ocOrdPriceHint'),
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
  if (source === 'sahi') return 'Sahi';
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
              <button class="btn-oc-buy" id="ce-buy-${row.strike}" data-symbol="${ce.symbol}" data-token="${ce.instrumentToken || ''}" data-lot-size="${ce.lotSize || 65}" data-side="B" data-ltp="${ce.ltp || 0}" title="Buy ${ce.symbol}">B</button>
              <button class="btn-oc-sell" id="ce-sell-${row.strike}" data-symbol="${ce.symbol}" data-token="${ce.instrumentToken || ''}" data-lot-size="${ce.lotSize || 65}" data-side="S" data-ltp="${ce.ltp || 0}" title="Sell ${ce.symbol}">S</button>
            </div>
          </td>

          <td class="text-center mono oc-strike-cell">
            <strong>${row.strike}</strong>
            ${row.isAtm ? '<span class="atm-tag">ATM</span>' : ''}
          </td>

          <td class="text-center ${peItmClass}">
            <div class="oc-trade-btns">
              <button class="btn-oc-buy" id="pe-buy-${row.strike}" data-symbol="${pe.symbol}" data-token="${pe.instrumentToken || ''}" data-lot-size="${pe.lotSize || 65}" data-side="B" data-ltp="${pe.ltp || 0}" title="Buy ${pe.symbol}">B</button>
              <button class="btn-oc-sell" id="pe-sell-${row.strike}" data-symbol="${pe.symbol}" data-token="${pe.instrumentToken || ''}" data-lot-size="${pe.lotSize || 65}" data-side="S" data-ltp="${pe.ltp || 0}" title="Sell ${pe.symbol}">S</button>
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

  for (const kind of ['buy', 'sell']) {
    const btn = document.getElementById(`${prefix}-${kind}-${strike}`);
    if (btn) {
      btn.setAttribute('data-symbol', leg.symbol || '');
      btn.setAttribute('data-token', leg.instrumentToken || '');
      btn.setAttribute('data-lot-size', String(leg.lotSize || 65));
      btn.setAttribute('data-ltp', String(leg.ltp || 0));
    }
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

let lastOcBrokerSig = '';

function formatOcAvailBal(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '';
  return `₹${num.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function renderOcBrokerSelect(accounts) {
  if (!OC_DOM.ocOrdBroker || !Array.isArray(accounts)) return;
  ocState.accounts = accounts;
  const managedAccounts = accounts.filter(acc => acc.enabled && acc.manageOrders !== false);
  const sig = `${accounts.length}:${managedAccounts.map(a => `${a.id}:${a.name}:${a.broker}:${a.availableCash ?? ''}`).join('|')}`;
  if (sig === lastOcBrokerSig && OC_DOM.ocOrdBroker.options.length > 0) return;
  lastOcBrokerSig = sig;

  let storedId = '';
  try { storedId = localStorage.getItem('algo_selected_order_broker') || ''; } catch (e) {}
  const prevSelected = OC_DOM.ocOrdBroker.value || storedId;
  OC_DOM.ocOrdBroker.innerHTML = '';
  if (managedAccounts.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = accounts.length === 0 ? 'Default Broker (Simulation)' : 'No broker checked for orders';
    if (accounts.length === 0) opt.value = 'mock_kotak_1';
    OC_DOM.ocOrdBroker.appendChild(opt);
  } else {
    managedAccounts.forEach(acc => {
      const opt = document.createElement('option');
      opt.value = acc.id;
      const availStr = acc.availableCash !== undefined && acc.availableCash !== null
        ? ` — Avail ${formatOcAvailBal(acc.availableCash)}`
        : '';
      opt.textContent = `${acc.name} (${acc.broker.toUpperCase()})${availStr}`;
      OC_DOM.ocOrdBroker.appendChild(opt);
    });
    if (prevSelected && managedAccounts.some(acc => acc.id === prevSelected)) {
      OC_DOM.ocOrdBroker.value = prevSelected;
    }
  }
}

async function loadAccounts() {
  try {
    const [accRes, statusRes] = await Promise.all([
      fetch('/api/accounts'),
      fetch('/api/status')
    ]);
    const d = await accRes.json();
    const st = await statusRes.json().catch(() => null);
    if (st && st.success && st.riskSettings) {
      ocModalSpec.riskSettings = st.riskSettings;
      ocModalSpec.dailyOrders = st.dailyOrders || {};
      if (OC_DOM.ocOrdRoutingMode) {
        OC_DOM.ocOrdRoutingMode.value = st.riskSettings.orderRoutingMode === 'all_funded' ? 'all_funded' : 'selected';
      }
      if (OC_DOM.ocDayCapHint) {
        const rs = st.riskSettings;
        const used = (st.dailyOrders && st.dailyOrders.ordersPlacedToday) || 0;
        const maxO = Number(rs.maxDailyOrders || 0);
        OC_DOM.ocDayCapHint.textContent = `Deploy ${rs.capitalDeployPct || 100}% • Target +${rs.targetDailyNetProfitPct || 1.5}% • Loss -${rs.maxDailyLossNetPct || 1.0}% • Orders ${used}/${maxO > 0 ? maxO : '∞'}`;
      }
    }
    if (d.success && Array.isArray(d.data)) {
      renderOcBrokerSelect(d.data);
    }
  } catch (e) {}
}

function initEventSource() {
  const es = new EventSource('/api/stream');
  if (typeof window.attachOrderConfirmationStream === 'function') {
    window.attachOrderConfirmationStream(es);
  }

  es.addEventListener('connected', () => {
    OC_DOM.connLabel.textContent = 'Live SSE Active';
    OC_DOM.connStatus.querySelector('.status-indicator').className = 'status-indicator online';
  });

  es.addEventListener('market_tick', e => {
    try {
      const m = JSON.parse(e.data);
      if (m && Array.isArray(m.accounts)) renderOcBrokerSelect(m.accounts);
    } catch (err) {}
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

const ocModalSpec = { lotSize: 65, freezeQty: 1800, availableCash: 0, ltp: 0, rate: 0, limitEdited: false, triggerEdited: false, sizingSeq: 0 };

function roundOcTick(val, step = 0.05) {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Number((Math.round(n / step) * step).toFixed(2));
}

function defaultOcLimitPrice(basePrice, side) {
  const p = Number(basePrice || 0);
  if (!(p > 0)) return 0;
  return roundOcTick(Math.max(0.05, p + (side === 'S' ? -0.5 : 0.5)));
}

function syncOcOrderTypePricingUI(forceDefaults = false) {
  const ot = OC_DOM.ocOrdType ? OC_DOM.ocOrdType.value : 'MKT';
  const side = (OC_DOM.ocOrdSide && OC_DOM.ocOrdSide.value) || 'B';
  const ltp = Number(ocModalSpec.ltp || 0);

  if (ot === 'MKT') {
    if (OC_DOM.ocOrdPricingRow) OC_DOM.ocOrdPricingRow.style.display = 'none';
    if (OC_DOM.ocOrdTriggerGroup) OC_DOM.ocOrdTriggerGroup.style.display = 'none';
    return;
  }

  if (OC_DOM.ocOrdPricingRow) OC_DOM.ocOrdPricingRow.style.display = 'grid';
  if (ot === 'SL') {
    if (OC_DOM.ocOrdTriggerGroup) OC_DOM.ocOrdTriggerGroup.style.display = 'block';
    if (OC_DOM.ocOrdPriceLabel) OC_DOM.ocOrdPriceLabel.textContent = 'SL Limit Price (₹)';
    if (OC_DOM.ocOrdPriceHint) {
      OC_DOM.ocOrdPriceHint.textContent = side === 'S' ? 'Default = Trigger - 0.50 (Sell)' : 'Default = Trigger + 0.50 (Buy)';
    }
    if (OC_DOM.ocOrdTriggerPrice && (forceDefaults || !ocModalSpec.triggerEdited)) {
      OC_DOM.ocOrdTriggerPrice.value = roundOcTick(ltp).toFixed(2);
    }
    const trig = Number((OC_DOM.ocOrdTriggerPrice && OC_DOM.ocOrdTriggerPrice.value) || ltp || 0);
    if (OC_DOM.ocOrdPrice && (forceDefaults || !ocModalSpec.limitEdited)) {
      OC_DOM.ocOrdPrice.value = defaultOcLimitPrice(trig, side).toFixed(2);
    }
    return;
  }

  // LIMIT
  if (OC_DOM.ocOrdTriggerGroup) OC_DOM.ocOrdTriggerGroup.style.display = 'none';
  if (OC_DOM.ocOrdPriceLabel) OC_DOM.ocOrdPriceLabel.textContent = 'Limit Price (₹)';
  if (OC_DOM.ocOrdPriceHint) {
    OC_DOM.ocOrdPriceHint.textContent = side === 'S' ? 'Default = LTP - 0.50 (Sell)' : 'Default = LTP + 0.50 (Buy)';
  }
  if (OC_DOM.ocOrdPrice && (forceDefaults || !ocModalSpec.limitEdited)) {
    OC_DOM.ocOrdPrice.value = defaultOcLimitPrice(ltp, side).toFixed(2);
  }
}

function updateOcFreezeHint() {
  if (!OC_DOM.ocSizingHint) return;
  const qty = Math.round(Number(OC_DOM.ocOrdQty.value || 0));
  const fq = Number(ocModalSpec.freezeQty || 0);
  const lot = Number(ocModalSpec.lotSize || 65);
  const rate = Number(ocModalSpec.rate || 0);
  const maxSlice = fq > 0 ? Math.max(lot, Math.floor(fq / lot) * lot) : 0;
  const sliceCount = (fq > 0 && qty > fq) ? Math.ceil(qty / maxSlice) : (qty > 0 ? 1 : 0);
  const splitNote = sliceCount > 1 ? ` • Auto-splits into ${sliceCount} orders (max ${maxSlice}/order)` : '';
  const insNote = (OC_DOM.ocAutoQty && OC_DOM.ocAutoQty.checked && rate > 0 && qty === 0)
    ? ` • Need ₹${(lot * rate).toFixed(2)} for 1 lot`
    : '';
  const rateNote = rate > 0 ? `Rate: ₹${rate.toFixed(2)} | ` : '';
  if (ocModalSpec.routingMode === 'all_funded' && Array.isArray(ocModalSpec.eligibleBrokers)) {
    const elig = ocModalSpec.eligibleBrokers;
    const skip = ocModalSpec.skippedBrokers || [];
    const eligTxt = elig.length > 0 ? elig.map(b => `${b.name}: ${b.quantity}`).join(', ') : 'None';
    OC_DOM.ocSizingHint.textContent = `All Funded (${elig.length}/${elig.length + skip.length}): ${eligTxt} | ${rateNote}Lot: ${lot}`;
    return;
  }
  OC_DOM.ocSizingHint.textContent = `${rateNote}Lot: ${lot} | Freeze: ${fq > 0 ? fq : 'None'}${splitNote}${insNote}`;
}

async function recalculateOcOrderQty() {
  const seq = ++ocModalSpec.sizingSeq;
  try {
    const symbol = OC_DOM.ocOrdSymbol.value;
    if (!symbol) return;
    const ot = OC_DOM.ocOrdType ? OC_DOM.ocOrdType.value : 'MKT';
    const side = (OC_DOM.ocOrdSide && OC_DOM.ocOrdSide.value) || 'B';
    const price = ot === 'MKT' ? 0 : Number(OC_DOM.ocOrdPrice.value || 0);
    const triggerPrice = ot === 'SL' && OC_DOM.ocOrdTriggerPrice ? Number(OC_DOM.ocOrdTriggerPrice.value || 0) : 0;
    const routingMode = (OC_DOM.ocOrdRoutingMode && OC_DOM.ocOrdRoutingMode.value) || 'selected';

    const res = await fetch('/api/orders/calculate-quantity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: OC_DOM.ocOrdBroker.value,
        routingMode,
        tradingSymbol: symbol,
        instrumentToken: OC_DOM.ocOrdToken ? OC_DOM.ocOrdToken.value : '',
        exchangeSegment: 'NFO',
        orderType: ot,
        transactionType: side,
        lotSize: ocModalSpec.lotSize,
        price,
        triggerPrice,
        ltp: Number(ocModalSpec.ltp || 0)
      })
    });
    const d = await res.json();
    if (seq !== ocModalSpec.sizingSeq) return;
    if (d.success && d.data) {
      ocModalSpec.lotSize = d.data.lotSize || ocModalSpec.lotSize;
      ocModalSpec.freezeQty = d.data.freezeQty || 0;
      ocModalSpec.availableCash = d.data.availableCash || 0;
      ocModalSpec.rate = Number(d.data.price || 0);
      ocModalSpec.routingMode = d.data.routingMode || routingMode;
      ocModalSpec.eligibleBrokers = d.data.eligibleBrokers || [];
      ocModalSpec.skippedBrokers = d.data.skippedBrokers || [];
      if (OC_DOM.ocOrdBalanceLabel) {
        OC_DOM.ocOrdBalanceLabel.textContent = `₹${Number(ocModalSpec.availableCash).toLocaleString('en-IN')}`;
      }
      if (OC_DOM.ocOrdQtyLabel) {
        OC_DOM.ocOrdQtyLabel.textContent = `Quantity (Lot Size = ${ocModalSpec.lotSize})`;
      }
      if (OC_DOM.ocOrdQty) {
        OC_DOM.ocOrdQty.min = ocModalSpec.lotSize;
        OC_DOM.ocOrdQty.step = ocModalSpec.lotSize;
        if (OC_DOM.ocAutoQty && OC_DOM.ocAutoQty.checked) {
          OC_DOM.ocOrdQty.value = Math.max(0, Number(d.data.quantity || 0));
        }
      }
      updateOcFreezeHint();
    }
  } catch (e) {}
}

// Quick order delegation on option chain table
OC_DOM.optionChainBody.addEventListener('click', e => {
  const btn = e.target.closest('.btn-oc-buy, .btn-oc-sell');
  if (!btn) return;
  const symbol = btn.getAttribute('data-symbol');
  const token = btn.getAttribute('data-token') || '';
  const lotSize = Number(btn.getAttribute('data-lot-size') || 65) || 65;
  const side = btn.getAttribute('data-side');
  const ltp = Number(btn.getAttribute('data-ltp') || 0);

  ocModalSpec.lotSize = lotSize;
  ocModalSpec.ltp = ltp;
  ocModalSpec.limitEdited = false;
  ocModalSpec.triggerEdited = false;
  OC_DOM.ocOrdSymbol.value = symbol;
  if (OC_DOM.ocOrdToken) OC_DOM.ocOrdToken.value = token;
  OC_DOM.ocOrdSide.value = side;
  OC_DOM.ocOrdSymbolLabel.textContent = symbol;
  OC_DOM.ocOrdLtpLabel.textContent = `₹${ltp.toFixed(2)}`;
  if (OC_DOM.ocOrdQty) {
    OC_DOM.ocOrdQty.value = lotSize;
    OC_DOM.ocOrdQty.min = lotSize;
    OC_DOM.ocOrdQty.step = lotSize;
  }
  if (OC_DOM.ocOrdQtyLabel) {
    OC_DOM.ocOrdQtyLabel.textContent = `Quantity (Lot Size = ${lotSize})`;
  }
  syncOcOrderTypePricingUI(true);
  OC_DOM.ocOrderModalTitle.textContent = `${side === 'B' ? 'BUY' : 'SELL'} Option: ${symbol}`;
  OC_DOM.submitOcOrderBtn.className = side === 'B' ? 'btn-primary btn-buy' : 'btn-primary btn-sell';
  OC_DOM.submitOcOrderBtn.textContent = `Place ${side === 'B' ? 'BUY' : 'SELL'} Order`;
  OC_DOM.ocOrderModal.classList.add('active');
  recalculateOcOrderQty();
});

if (OC_DOM.ocOrdType) {
  OC_DOM.ocOrdType.addEventListener('change', () => {
    ocModalSpec.limitEdited = false;
    ocModalSpec.triggerEdited = false;
    syncOcOrderTypePricingUI(true);
    recalculateOcOrderQty();
  });
}
if (OC_DOM.ocOrdTriggerPrice) {
  OC_DOM.ocOrdTriggerPrice.addEventListener('input', () => {
    ocModalSpec.triggerEdited = true;
    const trig = Number(OC_DOM.ocOrdTriggerPrice.value || 0);
    if (OC_DOM.ocOrdType && OC_DOM.ocOrdType.value === 'SL' && trig > 0 && !ocModalSpec.limitEdited) {
      OC_DOM.ocOrdPrice.value = defaultOcLimitPrice(trig, OC_DOM.ocOrdSide.value).toFixed(2);
    }
    recalculateOcOrderQty();
  });
}
if (OC_DOM.ocOrdPrice) {
  OC_DOM.ocOrdPrice.addEventListener('input', () => {
    ocModalSpec.limitEdited = true;
    recalculateOcOrderQty();
  });
}
if (OC_DOM.ocOrdBroker) {
  OC_DOM.ocOrdBroker.addEventListener('change', () => {
    try { localStorage.setItem('algo_selected_order_broker', OC_DOM.ocOrdBroker.value || ''); } catch (e) {}
    recalculateOcOrderQty();
  });
}
if (OC_DOM.ocOrdRoutingMode) {
  OC_DOM.ocOrdRoutingMode.addEventListener('change', recalculateOcOrderQty);
}
if (OC_DOM.ocAutoQty) {
  OC_DOM.ocAutoQty.addEventListener('change', recalculateOcOrderQty);
}
if (OC_DOM.ocOrdQty) {
  OC_DOM.ocOrdQty.addEventListener('input', () => {
    if (OC_DOM.ocAutoQty) OC_DOM.ocAutoQty.checked = false;
    updateOcFreezeHint();
  });
}

OC_DOM.closeOcOrderModal.addEventListener('click', () => OC_DOM.ocOrderModal.classList.remove('active'));
OC_DOM.cancelOcOrderBtn.addEventListener('click', () => OC_DOM.ocOrderModal.classList.remove('active'));

OC_DOM.ocOrderForm.addEventListener('submit', async e => {
  e.preventDefault();
  const ot = OC_DOM.ocOrdType.value;
  const routingMode = (OC_DOM.ocOrdRoutingMode && OC_DOM.ocOrdRoutingMode.value) || 'selected';
  const ocLtp = Number(ocModalSpec.ltp || 0);
  const mktLimitPx = ot === 'MKT' && ocLtp > 0 ? Number((Math.round(ocLtp / 0.05) * 0.05).toFixed(2)) : 0;
  const payload = {
    accountId: OC_DOM.ocOrdBroker.value,
    routingMode,
    tradingSymbol: OC_DOM.ocOrdSymbol.value,
    instrumentToken: OC_DOM.ocOrdToken ? OC_DOM.ocOrdToken.value : '',
    exchangeSegment: 'nse_fo',
    transactionType: OC_DOM.ocOrdSide.value,
    product: OC_DOM.ocOrdProduct.value,
    orderType: mktLimitPx > 0 ? 'L' : ot,
    quantity: Number(OC_DOM.ocOrdQty.value),
    autoQuantity: Boolean(OC_DOM.ocAutoQty && OC_DOM.ocAutoQty.checked),
    lotSize: ocModalSpec.lotSize,
    freezeQty: ocModalSpec.freezeQty,
    price: ot === 'MKT' ? mktLimitPx : Number(OC_DOM.ocOrdPrice.value || 0),
    triggerPrice: ot === 'SL' && OC_DOM.ocOrdTriggerPrice ? Number(OC_DOM.ocOrdTriggerPrice.value || 0) : 0,
    ltp: ocModalSpec.ltp,
    userConfirmed: true
  };

  const ocSelOpt = OC_DOM.ocOrdBroker && OC_DOM.ocOrdBroker.options[OC_DOM.ocOrdBroker.selectedIndex];
  const brokerLabel = routingMode === 'all_funded'
    ? 'All Checked Brokers'
    : ((ocSelOpt && ocSelOpt.textContent) || payload.accountId);

  if (typeof window.confirmOrderBeforeSend === 'function') {
    const confirmed = await window.confirmOrderBeforeSend({
      ...payload,
      brokerLabel,
      sourceLabel: 'Option Chain Order Confirmation'
    });
    if (!confirmed) return;
  }

  OC_DOM.submitOcOrderBtn.disabled = true;
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (d.success) {
      let msg;
      if (d.routingMode === 'all_funded') {
        msg = `Executed on ${d.executedCount} funded broker(s): ${(d.executedBrokers || []).map(b => `${b.name} (${b.quantity})`).join(', ')}`;
      } else {
        msg = d.sliced
          ? `Order split into ${d.sliceCount} orders (Freeze ${d.freezeQty}): ${payload.transactionType === 'B' ? 'BUY' : 'SELL'} ${payload.tradingSymbol} x ${d.totalQuantity}`
          : `Order placed: ${payload.transactionType === 'B' ? 'BUY' : 'SELL'} ${payload.tradingSymbol} x ${d.totalQuantity || payload.quantity}`;
      }
      showToast(msg, 'success');
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
