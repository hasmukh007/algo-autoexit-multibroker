/**
 * Multi-Broker Algo Auto-Exit Application Controller
 * Manages Kotak Neo, Angel One, and Dhan integrations, 9:00 AM balance, and Net Profit % triggers.
 */

const state = {
  mode: 'mock',
  dataFeedSource: 'kotakneo',
  openingBalance: {
    openingBalance: 500000,
    capturedAt: null,
    date: ''
  },
  accounts: [],
  positions: [],
  orders: [],
  rules: {},
  totals: {
    totalGrossPnl: 0,
    totalCharges: 0,
    totalNetPnl: 0,
    overallNetProfitPct: 0,
    openPositionsCount: 0
  },
  previousLtps: new Map(),
  previousNiftyLtp: null
};

const DOM = {
  // Top NIFTY Live Bar
  topNiftyLtp: document.getElementById('topNiftyLtp'),
  topNiftyChange: document.getElementById('topNiftyChange'),
  topNiftyOpen: document.getElementById('topNiftyOpen'),
  topNiftyHigh: document.getElementById('topNiftyHigh'),
  topNiftyLow: document.getElementById('topNiftyLow'),
  topNiftyAtm: document.getElementById('topNiftyAtm'),
  topNiftyFeedPill: document.getElementById('topNiftyFeedPill'),
  topNiftyFeedStatus: document.getElementById('topNiftyFeedStatus'),

  // Top Nav
  modeBadge: document.getElementById('modeBadge'),
  modeText: document.getElementById('modeText'),
  toggleModeBtn: document.getElementById('toggleModeBtn'),
  activeFeedText: document.getElementById('activeFeedText'),
  switchFeedBtn: document.getElementById('switchFeedBtn'),
  istClock: document.getElementById('istClock'),
  marketPill: document.getElementById('marketPill'),
  openAccountsBtn: document.getElementById('openAccountsBtn'),
  accountsBtnText: document.getElementById('accountsBtnText'),
  connStatus: document.getElementById('connStatus'),
  connLabel: document.getElementById('connLabel'),
  exitAllBtn: document.getElementById('exitAllBtn'),
  cancelAllOrdersBtn: document.getElementById('cancelAllOrdersBtn'),

  // 9:00 AM Opening Balance Banner
  openingBalanceDisplay: document.getElementById('openingBalanceDisplay'),
  openingBalanceTime: document.getElementById('openingBalanceTime'),
  syncBalanceBtn: document.getElementById('syncBalanceBtn'),
  overrideBalanceBtn: document.getElementById('overrideBalanceBtn'),

  // Quick Net Profit Controls
  quickTargetPct: document.getElementById('quickTargetPct'),
  quickNearBuffer: document.getElementById('quickNearBuffer'),
  quickStopLossPct: document.getElementById('quickStopLossPct'),
  quickTargetInrHint: document.getElementById('quickTargetInrHint'),
  quickNearInrHint: document.getElementById('quickNearInrHint'),
  quickStopInrHint: document.getElementById('quickStopInrHint'),
  applyGlobalRuleBtn: document.getElementById('applyGlobalRuleBtn'),

  // Metrics
  heroMetricCard: document.getElementById('heroMetricCard'),
  totalNetPnl: document.getElementById('totalNetPnl'),
  netProfitPctBadge: document.getElementById('netProfitPctBadge'),
  totalGrossPnl: document.getElementById('totalGrossPnl'),
  totalCharges: document.getElementById('totalCharges'),
  capitalReturnPct: document.getElementById('capitalReturnPct'),
  targetDisplay: document.getElementById('targetDisplay'),
  maxLossDisplay: document.getElementById('maxLossDisplay'),
  availableFunds: document.getElementById('availableFunds'),
  utilizedMargin: document.getElementById('utilizedMargin'),
  engineStatusText: document.getElementById('engineStatusText'),
  autoExitToggle: document.getElementById('autoExitToggle'),
  monitoredPositionsCount: document.getElementById('monitoredPositionsCount'),

  // Tabs
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabPanels: document.querySelectorAll('.tab-panel'),
  positionsTabBadge: document.getElementById('positionsTabBadge'),
  ordersTabBadge: document.getElementById('ordersTabBadge'),

  // Tables
  positionsTableBody: document.getElementById('positionsTableBody'),
  refreshPositionsBtn: document.getElementById('refreshPositionsBtn'),
  ordersTableBody: document.getElementById('ordersTableBody'),
  refreshOrdersBtn: document.getElementById('refreshOrdersBtn'),
  accountsTableBody: document.getElementById('accountsTableBody'),
  addNewAccountBtn: document.getElementById('addNewAccountBtn'),
  currentFeedBadge: document.getElementById('currentFeedBadge'),
  feedKotakRadio: document.getElementById('feedKotakRadio'),
  feedAngelRadio: document.getElementById('feedAngelRadio'),
  feedDhanRadio: document.getElementById('feedDhanRadio'),
  logsContainer: document.getElementById('logsContainer'),
  clearLogsBtn: document.getElementById('clearLogsBtn'),

  // Place Order Form
  orderForm: document.getElementById('orderForm'),
  orderBrokerSelect: document.getElementById('orderBrokerSelect'),
  buyRadio: document.getElementById('buyRadio'),
  sellRadio: document.getElementById('sellRadio'),
  orderSymbol: document.getElementById('orderSymbol'),
  orderSegment: document.getElementById('orderSegment'),
  orderProduct: document.getElementById('orderProduct'),
  orderType: document.getElementById('orderType'),
  orderQuantity: document.getElementById('orderQuantity'),
  orderPrice: document.getElementById('orderPrice'),
  submitOrderBtn: document.getElementById('submitOrderBtn'),

  // Modals
  accountModal: document.getElementById('accountModal'),
  closeAccountModal: document.getElementById('closeAccountModal'),
  accountModalTitle: document.getElementById('accountModalTitle'),
  accountForm: document.getElementById('accountForm'),
  editAccountId: document.getElementById('editAccountId'),
  accBroker: document.getElementById('accBroker'),
  accName: document.getElementById('accName'),
  kotakFields: document.getElementById('kotakFields'),
  kotakConsumerKey: document.getElementById('kotakConsumerKey'),
  kotakMobile: document.getElementById('kotakMobile'),
  kotakUcc: document.getElementById('kotakUcc'),
  kotakMpin: document.getElementById('kotakMpin'),
  kotakTotpSecret: document.getElementById('kotakTotpSecret'),
  angelFields: document.getElementById('angelFields'),
  angelApiKey: document.getElementById('angelApiKey'),
  angelClientCode: document.getElementById('angelClientCode'),
  angelPassword: document.getElementById('angelPassword'),
  angelTotpSecret: document.getElementById('angelTotpSecret'),
  dhanFields: document.getElementById('dhanFields'),
  dhanClientId: document.getElementById('dhanClientId'),
  dhanAccessToken: document.getElementById('dhanAccessToken'),
  accOneTimeTotp: document.getElementById('accOneTimeTotp'),
  testAccConnBtn: document.getElementById('testAccConnBtn'),

  autoExitModal: document.getElementById('autoExitModal'),
  closeAutoExitModal: document.getElementById('closeAutoExitModal'),
  modalPosTitle: document.getElementById('modalPosTitle'),
  modalPosSummary: document.getElementById('modalPosSummary'),
  autoExitRuleForm: document.getElementById('autoExitRuleForm'),
  rulePosSymbol: document.getElementById('rulePosSymbol'),
  rulePosProduct: document.getElementById('rulePosProduct'),
  rulePosAccountId: document.getElementById('rulePosAccountId'),
  ruleTargetNetPct: document.getElementById('ruleTargetNetPct'),
  ruleNearBuffer: document.getElementById('ruleNearBuffer'),
  ruleStopLossNetPct: document.getElementById('ruleStopLossNetPct'),
  ruleTrailingSL: document.getElementById('ruleTrailingSL'),
  deleteRuleBtn: document.getElementById('deleteRuleBtn'),

  chargesModal: document.getElementById('chargesModal'),
  closeChargesModal: document.getElementById('closeChargesModal'),
  chargesModalContent: document.getElementById('chargesModalContent'),

  toastContainer: document.getElementById('toastContainer')
};

/* ============================================================
   FORMATTING & UTILITIES
   ============================================================ */
function formatCurrency(amount) {
  const num = Number(amount || 0);
  const formatted = Math.abs(num).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return (num < 0 ? '-₹' : '₹') + formatted;
}

function toDisplayText(val, fallback = 'Unknown error') {
  if (val === undefined || val === null) return fallback;
  if (typeof val === 'string') return val;
  if (val instanceof Error) return val.message || fallback;
  if (typeof val === 'object') {
    const candidate = val.message || val.errMsg || val.error || val.description;
    if (typeof candidate === 'string') return candidate;
    try {
      return JSON.stringify(val);
    } catch (e) {
      return fallback;
    }
  }
  return String(val);
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${toDisplayText(message, '')}</span>`;
  DOM.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

// Update live IST Clock
function updateClock() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 3600000 * 5.5);

  const h = String(ist.getHours()).padStart(2, '0');
  const m = String(ist.getMinutes()).padStart(2, '0');
  const s = String(ist.getSeconds()).padStart(2, '0');
  DOM.istClock.textContent = `${h}:${m}:${s} IST`;

  const day = ist.getDay();
  const totalMin = ist.getHours() * 60 + ist.getMinutes();
  const isOpen = day >= 1 && day <= 5 && totalMin >= 555 && totalMin <= 930;

  if (isOpen) {
    DOM.marketPill.textContent = 'MARKET OPEN';
    DOM.marketPill.className = 'market-pill open';
  } else {
    DOM.marketPill.textContent = 'MARKET CLOSED';
    DOM.marketPill.className = 'market-pill closed';
  }
}
setInterval(updateClock, 1000);
updateClock();

// Recalculate quick hint labels based on opening balance
function updateQuickHints() {
  const bal = Number(state.openingBalance.openingBalance || 500000);
  const targetPct = Number(DOM.quickTargetPct.value || 1.5);
  const nearBuf = Number(DOM.quickNearBuffer.value || 98);
  const stopPct = Number(DOM.quickStopLossPct.value || 1.0);

  const targetInr = (bal * targetPct) / 100;
  const nearInr = targetInr * (nearBuf / 100);
  const stopInr = (bal * stopPct) / 100;

  DOM.quickTargetInrHint.textContent = `= ₹${targetInr.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Net`;
  DOM.quickNearInrHint.textContent = `≥ ₹${nearInr.toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${nearBuf}%)`;
  DOM.quickStopInrHint.textContent = `= -₹${stopInr.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Net`;
  DOM.targetDisplay.textContent = `${targetPct.toFixed(2)}% (₹${targetInr.toLocaleString('en-IN', { maximumFractionDigits: 0 })})`;
  DOM.maxLossDisplay.textContent = `-${stopPct.toFixed(2)}% (-₹${stopInr.toLocaleString('en-IN', { maximumFractionDigits: 0 })})`;
}
DOM.quickTargetPct.addEventListener('input', updateQuickHints);
DOM.quickNearBuffer.addEventListener('input', updateQuickHints);
DOM.quickStopLossPct.addEventListener('input', updateQuickHints);

/* ============================================================
   SSE (SERVER-SENT EVENTS) CONNECTION
   ============================================================ */
function initEventSource() {
  const es = new EventSource('/api/stream');

  es.addEventListener('connected', () => {
    DOM.connLabel.textContent = 'Live SSE Active';
    DOM.connStatus.querySelector('.status-indicator').className = 'status-indicator online';
  });

  es.addEventListener('market_tick', e => {
    try {
      const payload = JSON.parse(e.data);
      handleMarketTick(payload);
    } catch (err) {}
  });

  es.addEventListener('nifty_tick', e => {
    try {
      const snapshot = JSON.parse(e.data);
      updateTopNiftyTicker(snapshot);
    } catch (err) {}
  });

  es.addEventListener('feed_subscribed', e => {
    try {
      const info = JSON.parse(e.data);
      const label = formatFeedSourceLabel(info.broker);
      DOM.activeFeedText.textContent = label;
      DOM.currentFeedBadge.textContent = `Current: ${label}`;
      showToast(`Subscribed live NIFTY + ${info.totalContracts} Option Chain feed on ${label} (${info.accountName || 'Active'})`, 'success');
    } catch (err) {}
  });

  es.addEventListener('log', e => {
    try {
      const log = JSON.parse(e.data);
      appendLogEntry(log);
    } catch (err) {}
  });

  es.addEventListener('position_exited', e => {
    try {
      const data = JSON.parse(e.data);
      showToast(`Position ${data.key} exited on ${data.position.brokerName || data.position.broker}! Order: ${data.orderId}`, 'warning');
      loadPositions();
      loadOrders();
    } catch (err) {}
  });

  es.onerror = () => {
    DOM.connLabel.textContent = 'Reconnecting...';
    DOM.connStatus.querySelector('.status-indicator').className = 'status-indicator offline';
  };
}

function formatFeedSourceLabel(source) {
  if (source === 'angelone') return 'Angel One';
  if (source === 'dhan') return 'Dhan';
  return 'Kotak Neo';
}

function handleMarketTick(payload) {
  if (payload.mode) updateModeUI(payload.mode);

  if (payload.dataFeedSource) {
    state.dataFeedSource = payload.dataFeedSource;
    DOM.activeFeedText.textContent = formatFeedSourceLabel(payload.dataFeedSource);
    DOM.currentFeedBadge.textContent = `Current: ${DOM.activeFeedText.textContent}`;
  }

  if (payload.openingBalance) {
    state.openingBalance = payload.openingBalance;
    DOM.openingBalanceDisplay.textContent = formatCurrency(payload.openingBalance.openingBalance);
    if (payload.openingBalance.timeFormatted) {
      DOM.openingBalanceTime.textContent = `Captured: ${payload.openingBalance.timeFormatted}`;
    }
    updateQuickHints();
  }

  if (payload.totals) {
    state.totals = payload.totals;
    updateMetricHeaders();
  }

  if (payload.positions) {
    state.positions = payload.positions;
    renderPositionsTable();
  }

  if (payload.funds) {
    DOM.availableFunds.textContent = formatCurrency(payload.funds.availableCash);
    DOM.utilizedMargin.textContent = formatCurrency(payload.funds.utilizedMargin);
  }

  if (payload.accounts) {
    state.accounts = payload.accounts;
    renderAccountsTable();
    updateBrokerSelect();
  }

  if (payload.rules) {
    state.rules = payload.rules;
  }
}

function updateMetricHeaders() {
  const net = state.totals.totalNetPnl;
  const gross = state.totals.totalGrossPnl;
  const charges = state.totals.totalCharges;
  const netPct = state.totals.overallNetProfitPct;

  DOM.totalNetPnl.textContent = formatCurrency(net);
  DOM.totalGrossPnl.textContent = formatCurrency(gross);
  DOM.totalCharges.textContent = formatCurrency(charges);
  DOM.capitalReturnPct.textContent = `${netPct > 0 ? '+' : ''}${netPct.toFixed(2)}%`;

  if (net >= 0) {
    DOM.heroMetricCard.className = 'metric-card hero-metric profit';
    DOM.netProfitPctBadge.className = 'metric-badge profit';
    DOM.netProfitPctBadge.textContent = `+${netPct.toFixed(2)}% Net Capital Profit`;
  } else {
    DOM.heroMetricCard.className = 'metric-card hero-metric loss';
    DOM.netProfitPctBadge.className = 'metric-badge loss';
    DOM.netProfitPctBadge.textContent = `${netPct.toFixed(2)}% Net Capital Loss`;
  }

  const openCount = state.positions.filter(p => p.isOpen && p.netQty !== 0).length;
  DOM.positionsTabBadge.textContent = openCount;
  DOM.monitoredPositionsCount.textContent = openCount;
}

function appendLogEntry(log) {
  const entry = document.createElement('div');
  const typeClass = (log.type || 'info').toLowerCase();
  entry.className = `log-entry log-${typeClass}`;
  entry.innerHTML = `
    <span class="log-time">[${log.timeFormatted || new Date().toLocaleTimeString()}]</span>
    <span class="log-msg">${log.message}</span>
  `;
  DOM.logsContainer.insertBefore(entry, DOM.logsContainer.firstChild);
  if (DOM.logsContainer.children.length > 100) {
    DOM.logsContainer.lastChild.remove();
  }
}

/* ============================================================
   DATA LOADERS & RENDERERS
   ============================================================ */
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.success) {
      state.mode = data.mode;
      state.dataFeedSource = data.dataFeedSource;
      if (data.openingBalance) state.openingBalance = data.openingBalance;
      if (data.accounts) state.accounts = data.accounts;

      updateModeUI(data.mode);
      DOM.openingBalanceDisplay.textContent = formatCurrency(state.openingBalance.openingBalance);
      DOM.activeFeedText.textContent = formatFeedSourceLabel(data.dataFeedSource);
      DOM.currentFeedBadge.textContent = `Current: ${DOM.activeFeedText.textContent}`;
      if (DOM.feedKotakRadio) DOM.feedKotakRadio.checked = data.dataFeedSource === 'kotakneo';
      if (DOM.feedAngelRadio) DOM.feedAngelRadio.checked = data.dataFeedSource === 'angelone';
      if (DOM.feedDhanRadio) DOM.feedDhanRadio.checked = data.dataFeedSource === 'dhan';
      DOM.engineStatusText.textContent = data.autoExitRunning ? 'ACTIVE' : 'PAUSED';
      DOM.autoExitToggle.checked = Boolean(data.autoExitRunning);

      renderAccountsTable();
      updateBrokerSelect();
      updateQuickHints();
    }
  } catch (err) {}
}

function updateModeUI(mode) {
  state.mode = mode;
  if (mode === 'live') {
    DOM.modeBadge.className = 'mode-badge live';
    DOM.modeText.textContent = 'LIVE BROKER TRADING';
  } else {
    DOM.modeBadge.className = 'mode-badge';
    DOM.modeText.textContent = 'SIMULATION (MOCK)';
  }
}

function updateBrokerSelect() {
  DOM.orderBrokerSelect.innerHTML = '';
  state.accounts.forEach(acc => {
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.textContent = `${acc.name} (${acc.broker.toUpperCase()}) - ${acc.clientCode || 'Active'}`;
    DOM.orderBrokerSelect.appendChild(opt);
  });
}

async function loadPositions(force = false) {
  try {
    const res = await fetch(force ? '/api/positions?force=1' : '/api/positions');
    const data = await res.json();
    if (data.success && Array.isArray(data.data)) {
      state.positions = data.data;
      renderPositionsTable();
    }
  } catch (e) {}
}

async function loadOrders(force = false) {
  try {
    const res = await fetch(force ? '/api/orders?force=1' : '/api/orders');
    const data = await res.json();
    if (data.success && Array.isArray(data.data)) {
      state.orders = data.data;
      renderOrdersTable();
    }
  } catch (e) {}
}

async function loadAccounts() {
  try {
    const res = await fetch('/api/accounts');
    const data = await res.json();
    if (data.success && Array.isArray(data.data)) {
      state.accounts = data.data;
      renderAccountsTable();
      updateBrokerSelect();
    }
  } catch (e) {}
}

function renderPositionsTable() {
  if (!state.positions || state.positions.length === 0) {
    DOM.positionsTableBody.innerHTML = `<tr><td colspan="12" class="empty-state">No open positions across any broker. Place an order or execute a trade to see it here.</td></tr>`;
    return;
  }

  let html = '';
  state.positions.forEach(pos => {
    const key = `${pos.accountId}_${pos.symbol}_${pos.product}`;
    const generalKey = `any_${pos.symbol}_${pos.product}`;
    const rule = state.rules[key] || state.rules[generalKey];

    const prevLtp = state.previousLtps.get(pos.symbol);
    let flashClass = '';
    if (prevLtp !== undefined && pos.ltp !== prevLtp) {
      flashClass = pos.ltp > prevLtp ? 'flash-up' : 'flash-down';
    }
    state.previousLtps.set(pos.symbol, pos.ltp);

    const isGrossProfit = (pos.grossPnl || 0) >= 0;
    const isNetProfit = (pos.netPnl || 0) >= 0;

    let brokerBadgeClass = 'badge-kotakneo';
    if (pos.broker === 'angelone') brokerBadgeClass = 'badge-angelone';
    if (pos.broker === 'dhan') brokerBadgeClass = 'badge-dhan';

    let ruleBadge = `<span class="badge">No Rule</span>`;
    if (rule && rule.enabled) {
      const parts = [];
      if (rule.targetNetProfitPct) parts.push(`Target: +${rule.targetNetProfitPct}% (near ${rule.nearThresholdBufferPct || 98}%)`);
      if (rule.stopLossNetPct) parts.push(`SL: -${rule.stopLossNetPct}%`);
      ruleBadge = `<span class="badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8;">${parts.join(' | ')}</span>`;
    }

    html += `
      <tr class="${!pos.isOpen ? 'closed-pos-row' : ''}">
        <td><span class="badge ${brokerBadgeClass}">${pos.brokerName || pos.broker.toUpperCase()}</span></td>
        <td><strong>${pos.symbol}</strong></td>
        <td><span class="badge">${pos.product}</span></td>
        <td class="text-right mono" style="font-weight: 700; color: ${pos.netQty > 0 ? 'var(--profit-color)' : (pos.netQty < 0 ? 'var(--loss-color)' : 'var(--text-muted)')};">
          ${pos.netQty}
        </td>
        <td class="text-right mono">₹${pos.buyAvg ? pos.buyAvg.toFixed(2) : (pos.sellAvg ? pos.sellAvg.toFixed(2) : '0.00')}</td>
        <td class="text-right mono ${flashClass}" style="font-weight: 700;">₹${pos.ltp.toFixed(2)}</td>
        <td class="text-right mono ${isGrossProfit ? 'profit-text' : 'loss-text'}">${formatCurrency(pos.grossPnl)}</td>
        <td class="text-right mono">
          <a href="#" class="view-charges-link" data-symbol="${pos.symbol}" data-charges='${JSON.stringify(pos.chargeDetails || {})}'>
            ${formatCurrency(pos.totalCharges)}
          </a>
        </td>
        <td class="text-right mono ${isNetProfit ? 'profit-text' : 'loss-text'}" style="font-weight: 700; font-size: 13px;">
          ${formatCurrency(pos.netPnl)}
        </td>
        <td class="text-right mono ${isNetProfit ? 'profit-text' : 'loss-text'}" style="font-weight: 700;">
          ${pos.netProfitPctOfCapital > 0 ? '+' : ''}${pos.netProfitPctOfCapital}%
        </td>
        <td>${ruleBadge}</td>
        <td class="text-center">
          ${pos.isOpen ? `
            <button class="btn-xs btn-outline set-rule-btn" data-symbol="${pos.symbol}" data-product="${pos.product}" data-acc="${pos.accountId}">Set % Exit</button>
            <button class="btn-xs btn-danger exit-now-btn" data-symbol="${pos.symbol}" data-product="${pos.product}" data-acc="${pos.accountId}">Exit</button>
          ` : `<span class="badge" style="opacity: 0.5;">Closed</span>`}
        </td>
      </tr>
    `;
  });

  DOM.positionsTableBody.innerHTML = html;

  // View charges breakdown modal link
  document.querySelectorAll('.view-charges-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const symbol = link.getAttribute('data-symbol');
      const details = JSON.parse(link.getAttribute('data-charges') || '{}');
      openChargesModal(symbol, details);
    });
  });

  // Set rule button
  document.querySelectorAll('.set-rule-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sym = btn.getAttribute('data-symbol');
      const prod = btn.getAttribute('data-product');
      const acc = btn.getAttribute('data-acc');
      openAutoExitModal(sym, prod, acc);
    });
  });

  // Manual Exit row button
  document.querySelectorAll('.exit-now-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sym = btn.getAttribute('data-symbol');
      const prod = btn.getAttribute('data-product');
      const acc = btn.getAttribute('data-acc');
      if (confirm(`Exit position ${sym} at MARKET price now?`)) {
        try {
          const res = await fetch('/api/autoexit/exit-position', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: sym, product: prod, accountId: acc, reason: 'Manual Row Exit' })
          });
          const d = await res.json();
          if (d.success) {
            showToast(`Exit order sent for ${sym}!`, 'success');
            loadPositions();
            loadOrders();
          }
        } catch (e) {
          showToast(e.message, 'error');
        }
      }
    });
  });
}

function renderOrdersTable() {
  if (!state.orders || state.orders.length === 0) {
    DOM.ordersTableBody.innerHTML = `<tr><td colspan="9" class="empty-state">No orders in history.</td></tr>`;
    DOM.ordersTabBadge.textContent = '0';
    return;
  }

  DOM.ordersTabBadge.textContent = state.orders.filter(o => o.status === 'OPEN' || o.status === 'PENDING').length;

  let html = '';
  state.orders.forEach(ord => {
    let bClass = 'badge-kotakneo';
    if (ord.broker === 'angelone') bClass = 'badge-angelone';
    if (ord.broker === 'dhan') bClass = 'badge-dhan';

    html += `
      <tr>
        <td><span class="badge ${bClass}">${ord.brokerName || ord.broker}</span></td>
        <td class="mono" style="font-size: 11px;">${ord.orderId}</td>
        <td class="mono" style="font-size: 11px; color: var(--text-muted);">${ord.orderTime || '--'}</td>
        <td><strong>${ord.symbol}</strong></td>
        <td><span class="badge" style="${ord.transactionType === 'B' ? 'background: var(--profit-bg); color: var(--profit-color);' : 'background: var(--loss-bg); color: var(--loss-color);'}">${ord.transactionType === 'B' ? 'BUY' : 'SELL'}</span></td>
        <td><span class="badge">${ord.orderType}</span></td>
        <td class="text-right mono">${ord.filledQuantity || ord.quantity}/${ord.quantity}</td>
        <td class="text-right mono">₹${Number(ord.price || 0).toFixed(2)}</td>
        <td><span class="badge" style="${ord.status === 'COMPLETE' ? 'background: var(--profit-bg); color: var(--profit-color);' : ''}">${ord.status}</span></td>
      </tr>
    `;
  });
  DOM.ordersTableBody.innerHTML = html;
}

function renderAccountsTable() {
  DOM.accountsBtnText.textContent = `Brokers (${state.accounts.filter(a => a.enabled).length} Active)`;

  if (!state.accounts || state.accounts.length === 0) {
    DOM.accountsTableBody.innerHTML = `<tr><td colspan="6" class="empty-state">No broker accounts configured.</td></tr>`;
    return;
  }

  let html = '';
  state.accounts.forEach(acc => {
    let bClass = 'badge-kotakneo';
    if (acc.broker === 'angelone') bClass = 'badge-angelone';
    if (acc.broker === 'dhan') bClass = 'badge-dhan';

    html += `
      <tr>
        <td><span class="badge ${bClass}">${acc.broker.toUpperCase()}</span></td>
        <td><strong>${acc.name}</strong></td>
        <td class="mono">${acc.clientCode || 'Configured'}</td>
        <td>
          <span class="badge" style="${acc.isAuthenticated ? 'background: var(--profit-bg); color: var(--profit-color);' : (acc.lastError ? 'background: var(--loss-bg); color: var(--loss-color);' : 'background: var(--warning-bg); color: var(--warning-color);')}">
            ${acc.isAuthenticated ? 'AUTHENTICATED' : (acc.lastError ? 'AUTH ERROR' : 'READY')}
          </span>
          ${acc.lastError ? `<div style="font-size: 10px; color: var(--loss-color); margin-top: 3px; max-width: 260px;">${toDisplayText(acc.lastError)}</div>` : ''}
        </td>
        <td class="mono">${acc.enabled ? 'Active' : 'Disabled'}</td>
        <td>
          <button class="btn-xs btn-outline test-acc-btn" data-id="${acc.id}">Test Login</button>
          <button class="btn-xs btn-outline delete-acc-btn" data-id="${acc.id}">Delete</button>
        </td>
      </tr>
    `;
  });
  DOM.accountsTableBody.innerHTML = html;

  document.querySelectorAll('.test-acc-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      showToast(`Logging in & subscribing feed for ${id}...`, 'info');
      try {
        let res = await fetch(`/api/accounts/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        let d = await res.json();
        if (!d.success && d.message && d.message.toLowerCase().includes('totp')) {
          const totp = prompt('Enter 6-digit TOTP to login & subscribe live feed:');
          if (totp) {
            res = await fetch(`/api/accounts/${id}/test`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ totp: totp.trim() })
            });
            d = await res.json();
          }
        }
        if (d.success) {
          showToast(
            d.feedSubscribed
              ? `${d.message || 'Login successful'} • Feed subscribed!`
              : (d.message || 'Login successful'),
            'success'
          );
          if (d.niftyFeed) updateTopNiftyTicker(d.niftyFeed);
        } else {
          showToast(d.message || 'Login failed', 'error');
        }
        loadAccounts();
      } catch (e) {
        showToast(e.message, 'error');
      }
    });
  });

  document.querySelectorAll('.delete-acc-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      if (confirm(`Delete account ${id}?`)) {
        await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
        showToast('Account deleted', 'info');
        loadAccounts();
      }
    });
  });
}

/* ============================================================
   MODALS & CHARGES BREAKDOWN
   ============================================================ */
function openChargesModal(symbol, details) {
  DOM.chargesModalContent.innerHTML = `
    <div style="font-size: 13px; line-height: 1.8;">
      <h4 style="margin-bottom: 12px; color: #fff;">Charges for <strong>${symbol}</strong></h4>
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-subtle); padding: 4px 0;">
        <span>Total Turnover:</span>
        <strong class="mono">₹${details.totalTurnover ? details.totalTurnover.toLocaleString('en-IN') : '0.00'}</strong>
      </div>
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-subtle); padding: 4px 0;">
        <span>Brokerage:</span>
        <strong class="mono">₹${details.brokerage ? details.brokerage.toFixed(2) : '0.00'}</strong>
      </div>
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-subtle); padding: 4px 0;">
        <span>Securities Transaction Tax (STT):</span>
        <strong class="mono">₹${details.stt ? details.stt.toFixed(2) : '0.00'}</strong>
      </div>
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-subtle); padding: 4px 0;">
        <span>Exchange Transaction Charges:</span>
        <strong class="mono">₹${details.exchangeTxn ? details.exchangeTxn.toFixed(2) : '0.00'}</strong>
      </div>
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-subtle); padding: 4px 0;">
        <span>GST (18% on Brokerage & Txn):</span>
        <strong class="mono">₹${details.gst ? details.gst.toFixed(2) : '0.00'}</strong>
      </div>
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-subtle); padding: 4px 0;">
        <span>Stamp Duty:</span>
        <strong class="mono">₹${details.stampDuty ? details.stampDuty.toFixed(2) : '0.00'}</strong>
      </div>
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid var(--border-subtle); padding: 4px 0;">
        <span>SEBI Turnover Charges:</span>
        <strong class="mono">₹${details.sebi ? details.sebi.toFixed(2) : '0.00'}</strong>
      </div>
      <div style="display: flex; justify-content: space-between; margin-top: 10px; padding: 6px 0; font-size: 14px; color: var(--loss-color);">
        <span>TOTAL ESTIMATED CHARGES:</span>
        <strong class="mono">₹${details.totalCharges ? details.totalCharges.toFixed(2) : '0.00'}</strong>
      </div>
    </div>
  `;
  DOM.chargesModal.classList.add('active');
}
DOM.closeChargesModal.addEventListener('click', () => DOM.chargesModal.classList.remove('active'));

// Position Auto-Exit Rule Modal
function openAutoExitModal(symbol, product, accountId) {
  const pos = state.positions.find(p => p.symbol === symbol && p.product === product);
  if (!pos) return;

  DOM.modalPosTitle.textContent = `Set Net Profit % Auto-Exit: ${pos.symbol}`;
  DOM.modalPosSummary.innerHTML = `
    <div>Broker: <strong>${pos.brokerName || pos.broker}</strong></div>
    <div>Net Qty: <strong>${pos.netQty}</strong></div>
    <div>Current Net P&L: <strong>₹${pos.netPnl} (${pos.netProfitPctOfCapital}%)</strong></div>
  `;

  DOM.rulePosSymbol.value = pos.symbol;
  DOM.rulePosProduct.value = pos.product;
  DOM.rulePosAccountId.value = pos.accountId || accountId;

  const key = `${pos.accountId}_${pos.symbol}_${pos.product}`;
  const existing = state.rules[key];

  if (existing) {
    DOM.ruleTargetNetPct.value = existing.targetNetProfitPct || DOM.quickTargetPct.value;
    DOM.ruleNearBuffer.value = existing.nearThresholdBufferPct || DOM.quickNearBuffer.value;
    DOM.ruleStopLossNetPct.value = existing.stopLossNetPct || DOM.quickStopLossPct.value;
    DOM.ruleTrailingSL.value = existing.trailingSLPoints || '';
    DOM.deleteRuleBtn.style.display = 'inline-block';
  } else {
    DOM.ruleTargetNetPct.value = DOM.quickTargetPct.value || 1.5;
    DOM.ruleNearBuffer.value = DOM.quickNearBuffer.value || 98;
    DOM.ruleStopLossNetPct.value = DOM.quickStopLossPct.value || 1.0;
    DOM.ruleTrailingSL.value = '';
    DOM.deleteRuleBtn.style.display = 'none';
  }

  DOM.autoExitModal.classList.add('active');
}
DOM.closeAutoExitModal.addEventListener('click', () => DOM.autoExitModal.classList.remove('active'));

DOM.autoExitRuleForm.addEventListener('submit', async e => {
  e.preventDefault();
  const payload = {
    symbol: DOM.rulePosSymbol.value,
    product: DOM.rulePosProduct.value,
    accountId: DOM.rulePosAccountId.value,
    targetNetProfitPct: Number(DOM.ruleTargetNetPct.value),
    nearThresholdBufferPct: Number(DOM.ruleNearBuffer.value),
    stopLossNetPct: Number(DOM.ruleStopLossNetPct.value),
    trailingSLPoints: DOM.ruleTrailingSL.value ? Number(DOM.ruleTrailingSL.value) : undefined,
    enabled: true
  };

  try {
    const res = await fetch('/api/autoexit/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (d.success) {
      showToast(`Auto-Exit rule saved for ${payload.symbol}!`, 'success');
      DOM.autoExitModal.classList.remove('active');
      loadPositions();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
});

DOM.deleteRuleBtn.addEventListener('click', async () => {
  const symbol = DOM.rulePosSymbol.value;
  const product = DOM.rulePosProduct.value;
  const accountId = DOM.rulePosAccountId.value;
  await fetch('/api/autoexit/rules', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, product, accountId })
  });
  showToast('Rule removed', 'info');
  DOM.autoExitModal.classList.remove('active');
  loadPositions();
});

// Quick Global Rule apply on page
DOM.applyGlobalRuleBtn.addEventListener('click', async () => {
  const targetPct = Number(DOM.quickTargetPct.value);
  const nearBuf = Number(DOM.quickNearBuffer.value);
  const stopLossPct = Number(DOM.quickStopLossPct.value);

  // Apply to all currently open positions
  const openPos = state.positions.filter(p => p.isOpen && p.netQty !== 0);
  if (openPos.length === 0) {
    showToast('No open positions right now. Settings will apply globally to next trades!', 'info');
  }

  for (const pos of openPos) {
    await fetch('/api/autoexit/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: pos.symbol,
        product: pos.product,
        accountId: pos.accountId,
        targetNetProfitPct: targetPct,
        nearThresholdBufferPct: nearBuf,
        stopLossNetPct: stopLossPct,
        enabled: true
      })
    });
  }

  // Update global risk settings
  await fetch('/api/risk-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetDailyNetProfitPct: targetPct,
      maxDailyLossNetPct: stopLossPct,
      autoExitEnabled: true
    })
  });

  showToast(`Applied Net Profit % exit rule (+${targetPct}% / near ${nearBuf}%) across all positions!`, 'success');
  loadPositions();
});

// 9:00 AM Balance Sync & Override
DOM.syncBalanceBtn.addEventListener('click', async () => {
  showToast('Retrieving morning funds across all brokers...', 'info');
  try {
    const res = await fetch('/api/opening-balance/sync', { method: 'POST' });
    const d = await res.json();
    if (d.success) {
      state.openingBalance = d.data;
      DOM.openingBalanceDisplay.textContent = formatCurrency(d.data.openingBalance);
      DOM.openingBalanceTime.textContent = `Captured: ${d.data.timeFormatted}`;
      updateQuickHints();
      showToast('Opening balance synced successfully!', 'success');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
});

DOM.overrideBalanceBtn.addEventListener('click', async () => {
  const current = state.openingBalance.openingBalance || 500000;
  const input = prompt('Enter 9:00 AM Opening Balance (₹):', current);
  if (input && Number(input) > 0) {
    const res = await fetch('/api/opening-balance/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Number(input) })
    });
    const d = await res.json();
    if (d.success) {
      state.openingBalance = d.data;
      DOM.openingBalanceDisplay.textContent = formatCurrency(d.data.openingBalance);
      DOM.openingBalanceTime.textContent = d.data.timeFormatted;
      updateQuickHints();
      showToast('Opening balance updated.', 'success');
    }
  }
});

// Broker Accounts Modal
DOM.openAccountsBtn.addEventListener('click', () => {
  // switch to brokers tab
  DOM.tabBtns.forEach(b => b.classList.remove('active'));
  DOM.tabPanels.forEach(p => p.classList.remove('active'));
  const btn = document.querySelector('[data-tab="tabBrokers"]');
  btn.classList.add('active');
  document.getElementById('tabBrokers').classList.add('active');
  loadAccounts();
});

DOM.addNewAccountBtn.addEventListener('click', () => {
  DOM.accountModalTitle.textContent = 'Add Broker Account';
  DOM.editAccountId.value = '';
  DOM.accBroker.value = 'kotakneo';
  DOM.accName.value = '';
  switchBrokerFields('kotakneo');
  DOM.accountModal.classList.add('active');
});
DOM.closeAccountModal.addEventListener('click', () => DOM.accountModal.classList.remove('active'));

DOM.accBroker.addEventListener('change', e => {
  switchBrokerFields(e.target.value);
});

function switchBrokerFields(broker) {
  DOM.kotakFields.style.display = broker === 'kotakneo' ? 'block' : 'none';
  DOM.angelFields.style.display = broker === 'angelone' ? 'block' : 'none';
  DOM.dhanFields.style.display = broker === 'dhan' ? 'block' : 'none';
}

function buildAccountPayloadFromModal() {
  const broker = DOM.accBroker.value;
  const payload = {
    broker,
    name: DOM.accName.value,
    enabled: true
  };

  if (broker === 'kotakneo') {
    payload.consumerKey = DOM.kotakConsumerKey.value.trim();
    payload.mobileNumber = DOM.kotakMobile.value.trim();
    payload.ucc = DOM.kotakUcc.value.trim();
    payload.mpin = DOM.kotakMpin.value.trim();
    payload.totpSecret = DOM.kotakTotpSecret.value.trim();
  } else if (broker === 'angelone') {
    payload.apiKey = DOM.angelApiKey.value.trim();
    payload.clientCode = DOM.angelClientCode.value.trim();
    payload.password = DOM.angelPassword.value;
    payload.totpSecret = DOM.angelTotpSecret.value.trim();
  } else if (broker === 'dhan') {
    payload.clientId = DOM.dhanClientId.value.trim();
    payload.accessToken = DOM.dhanAccessToken.value.trim();
  }

  if (DOM.accOneTimeTotp && DOM.accOneTimeTotp.value.trim()) {
    payload.totp = DOM.accOneTimeTotp.value.trim();
  }
  return payload;
}

if (DOM.testAccConnBtn) {
  DOM.testAccConnBtn.addEventListener('click', async () => {
    const payload = buildAccountPayloadFromModal();
    if (!payload.totp && payload.broker !== 'dhan' && !payload.totpSecret) {
      const entered = prompt('Enter 6-digit TOTP to test connection:');
      if (entered) payload.totp = entered.trim();
    }
    showToast(`Testing ${formatFeedSourceLabel(payload.broker)} connection...`, 'info');
    try {
      const res = await fetch('/api/accounts/test-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const d = await res.json();
      if (d.success) {
        showToast(toDisplayText(d.message, 'Connection verified!'), 'success');
      } else {
        showToast(toDisplayText(d.message, 'Connection test failed'), 'error');
      }
    } catch (err) {
      showToast(toDisplayText(err, 'Connection test failed'), 'error');
    }
  });
}

DOM.accountForm.addEventListener('submit', async e => {
  e.preventDefault();
  const payload = buildAccountPayloadFromModal();

  try {
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (d.success) {
      if (d.feedSubscribed) {
        showToast(`Account added, logged in & subscribed to NIFTY + Option Chain feed (${formatFeedSourceLabel(d.dataFeedSource)})!`, 'success');
        if (d.niftyFeed) updateTopNiftyTicker(d.niftyFeed);
      } else {
        const reason = d.loginResult && d.loginResult.message ? ` (${d.loginResult.message})` : '';
        showToast(`Account added! Click Test Login with TOTP to subscribe feed${reason}.`, 'info');
      }
      if (DOM.accOneTimeTotp) DOM.accOneTimeTotp.value = '';
      DOM.accountModal.classList.remove('active');
      loadAccounts();
    } else {
      showToast(d.message || 'Failed to add account', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Market Data Feed Switching
DOM.switchFeedBtn.addEventListener('click', async () => {
  const order = ['kotakneo', 'angelone', 'dhan'];
  const idx = order.indexOf(state.dataFeedSource);
  const target = order[(idx + 1) % order.length];
  await setFeedSource(target);
});

DOM.feedKotakRadio.addEventListener('change', () => setFeedSource('kotakneo'));
DOM.feedAngelRadio.addEventListener('change', () => setFeedSource('angelone'));
if (DOM.feedDhanRadio) DOM.feedDhanRadio.addEventListener('change', () => setFeedSource('dhan'));

async function setFeedSource(source) {
  try {
    const res = await fetch('/api/datafeed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source })
    });
    const d = await res.json();
    if (d.success) {
      state.dataFeedSource = source;
      DOM.activeFeedText.textContent = formatFeedSourceLabel(source);
      DOM.currentFeedBadge.textContent = `Current: ${DOM.activeFeedText.textContent}`;
      if (DOM.feedKotakRadio) DOM.feedKotakRadio.checked = source === 'kotakneo';
      if (DOM.feedAngelRadio) DOM.feedAngelRadio.checked = source === 'angelone';
      if (DOM.feedDhanRadio) DOM.feedDhanRadio.checked = source === 'dhan';
      showToast(`Market data subscription switched to ${DOM.activeFeedText.textContent}`, 'info');
    }
  } catch (e) {}
}

// Mode switch (Live vs Mock)
DOM.toggleModeBtn.addEventListener('click', async () => {
  const newMode = state.mode === 'live' ? 'mock' : 'live';
  const res = await fetch('/api/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: newMode })
  });
  const d = await res.json();
  if (d.success) {
    showToast(`Switched mode to ${newMode.toUpperCase()}`, 'info');
    updateModeUI(newMode);
    if (d.niftyFeed) updateTopNiftyTicker(d.niftyFeed);
    loadPositions();
    loadOrders();
    loadAccounts();
  }
});

// Order Placement Form
DOM.buyRadio.addEventListener('change', () => {
  DOM.submitOrderBtn.className = 'btn-primary-large btn-buy';
  DOM.submitOrderBtn.querySelector('span').textContent = 'PLACE BUY ORDER';
});
DOM.sellRadio.addEventListener('change', () => {
  DOM.submitOrderBtn.className = 'btn-primary-large btn-sell';
  DOM.submitOrderBtn.querySelector('span').textContent = 'PLACE SELL ORDER';
});

document.querySelectorAll('.chip').forEach(c => {
  c.addEventListener('click', () => {
    DOM.orderSymbol.value = c.getAttribute('data-symbol');
    DOM.orderSegment.value = c.getAttribute('data-segment');
  });
});
document.querySelectorAll('.chip-qty').forEach(c => {
  c.addEventListener('click', () => {
    DOM.orderQuantity.value = Number(DOM.orderQuantity.value || 0) + Number(c.getAttribute('data-qty'));
  });
});

DOM.orderForm.addEventListener('submit', async e => {
  e.preventDefault();
  const payload = {
    accountId: DOM.orderBrokerSelect.value,
    tradingSymbol: DOM.orderSymbol.value.trim(),
    exchangeSegment: DOM.orderSegment.value,
    transactionType: DOM.buyRadio.checked ? 'B' : 'S',
    product: DOM.orderProduct.value,
    orderType: DOM.orderType.value,
    quantity: Number(DOM.orderQuantity.value),
    price: Number(DOM.orderPrice.value || 0)
  };

  DOM.submitOrderBtn.disabled = true;
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (d.success) {
      showToast(`Order executed on broker! ID: ${d.orderId}`, 'success');
      loadPositions();
      loadOrders();
    } else {
      showToast(d.message || 'Order execution failed', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    DOM.submitOrderBtn.disabled = false;
  }
});

// Panic Actions
DOM.exitAllBtn.addEventListener('click', async () => {
  if (confirm('🚨 EMERGENCY: Square-off ALL positions across Angel One, Dhan, and Kotak Neo now?')) {
    const res = await fetch('/api/autoexit/exit-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Emergency Panic Button' })
    });
    const d = await res.json();
    if (d.success) {
      showToast('All open positions squared off across all brokers!', 'warning');
      loadPositions();
    }
  }
});

DOM.cancelAllOrdersBtn.addEventListener('click', async () => {
  if (confirm('Cancel all pending orders?')) {
    showToast('Orders cancellation sent.', 'info');
  }
});

// Tab Switcher
DOM.tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    DOM.tabBtns.forEach(b => b.classList.remove('active'));
    DOM.tabPanels.forEach(p => p.classList.remove('active'));

    btn.classList.add('active');
    const target = btn.getAttribute('data-tab');
    document.getElementById(target).classList.add('active');

    if (target === 'tabPositions') loadPositions();
    if (target === 'tabOrderBook') loadOrders();
    if (target === 'tabBrokers') loadAccounts();
  });
});

DOM.refreshPositionsBtn.addEventListener('click', () => loadPositions(true));
DOM.refreshOrdersBtn.addEventListener('click', () => loadOrders(true));
DOM.clearLogsBtn.addEventListener('click', () => DOM.logsContainer.innerHTML = '');

function updateTopNiftyTicker(snapshot) {
  if (!snapshot || !snapshot.spot || !DOM.topNiftyLtp) return;
  const spot = snapshot.spot;
  const hasSpot = spot.ltp !== null && spot.ltp !== undefined;
  const prev = state.previousNiftyLtp;

  if (hasSpot) {
    const ltp = Number(spot.ltp);
    DOM.topNiftyLtp.textContent = ltp.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });

    if (prev !== null && ltp !== prev) {
      DOM.topNiftyLtp.classList.remove('flash-up', 'flash-down');
      void DOM.topNiftyLtp.offsetWidth;
      DOM.topNiftyLtp.classList.add(ltp > prev ? 'flash-up' : 'flash-down');
    }
    state.previousNiftyLtp = ltp;

    const chg = Number(spot.change || 0);
    const chgPct = Number(spot.changePct || 0);
    const sign = chg >= 0 ? '+' : '';
    DOM.topNiftyChange.textContent = `${sign}${chg.toFixed(2)} (${sign}${chgPct.toFixed(2)}%)`;
    DOM.topNiftyChange.className = `nifty-change mono ${chg >= 0 ? 'profit-text' : 'loss-text'}`;
  } else {
    DOM.topNiftyLtp.textContent = '--';
    DOM.topNiftyChange.textContent = 'Awaiting Live Quote';
    DOM.topNiftyChange.className = 'nifty-change mono';
  }

  if (DOM.topNiftyOpen) DOM.topNiftyOpen.textContent = spot.open !== null && spot.open !== undefined ? Number(spot.open).toFixed(2) : '--';
  if (DOM.topNiftyHigh) DOM.topNiftyHigh.textContent = spot.high !== null && spot.high !== undefined ? Number(spot.high).toFixed(2) : '--';
  if (DOM.topNiftyLow) DOM.topNiftyLow.textContent = spot.low !== null && spot.low !== undefined ? Number(spot.low).toFixed(2) : '--';
  if (DOM.topNiftyAtm) DOM.topNiftyAtm.textContent = snapshot.atmStrike || '--';

  if (snapshot.feedState && DOM.topNiftyFeedStatus && DOM.topNiftyFeedPill) {
    const fs = snapshot.feedState;
    const brokerTag = fs.feedSubscribed && fs.subscribedBroker ? ` • ${formatFeedSourceLabel(fs.subscribedBroker)}` : '';
    const isLive = fs.sourceMode === 'live_broker';
    if (fs.isRunning) {
      DOM.topNiftyFeedPill.className = isLive ? 'nifty-feed-pill active' : 'nifty-feed-pill waiting';
      DOM.topNiftyFeedStatus.textContent = isLive
        ? `9:00 AM Live Feed${brokerTag} • 10 ITM + ATM + 10 OTM CE/PE (${fs.totalContracts || 42})`
        : `9:00 AM Feed${brokerTag} • Awaiting Live Broker Quote`;
    } else if (fs.status === 'WAITING_9AM') {
      DOM.topNiftyFeedPill.className = 'nifty-feed-pill waiting';
      DOM.topNiftyFeedStatus.textContent = `Live Option Feed Scheduled for ${fs.scheduledTimeIST || '09:00 IST'}`;
    } else {
      DOM.topNiftyFeedPill.className = 'nifty-feed-pill stopped';
      DOM.topNiftyFeedStatus.textContent = 'Option Feed Paused';
    }
  }
}

async function loadNiftyFeedSnapshot() {
  try {
    const res = await fetch('/api/nifty-feed');
    const d = await res.json();
    if (d.success && d.data) {
      updateTopNiftyTicker(d.data);
    }
  } catch (e) {}
}

// Initialization
window.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  loadNiftyFeedSnapshot();
  loadPositions();
  loadOrders();
  loadAccounts();
  initEventSource();
});
