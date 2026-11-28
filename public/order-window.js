/**
 * Standalone Compact Pop-Out Order Window Controller
 * Designed to stay small next to broker terminal charts while syncing live NIFTY/Option ticks,
 * auto-sizing quantity, routing orders with confirmation + bell sound, and managing exits.
 */
(function () {
  const els = {
    niftyLtp: document.getElementById('owNiftyLtp'),
    atmBadge: document.getElementById('owAtmBadge'),
    modePill: document.getElementById('owModePill'),
    exitAllBtn: document.getElementById('owExitAllBtn'),
    brokerSelect: document.getElementById('owBrokerSelect'),
    routingMode: document.getElementById('owRoutingMode'),
    strikeSelect: document.getElementById('owStrikeSelect'),
    useAtmBtn: document.getElementById('owUseAtmBtn'),
    ceBtn: document.getElementById('owCeBtn'),
    peBtn: document.getElementById('owPeBtn'),
    symbol: document.getElementById('owSymbol'),
    contractLtp: document.getElementById('owContractLtp'),
    token: document.getElementById('owInstrumentToken'),
    orderTypeTabs: document.getElementById('owOrderTypeTabs'),
    product: document.getElementById('owProduct'),
    segment: document.getElementById('owSegment'),
    qtyLabel: document.getElementById('owQtyLabel'),
    autoQty: document.getElementById('owAutoQty'),
    quantity: document.getElementById('owQuantity'),
    triggerWrap: document.getElementById('owTriggerWrap'),
    triggerPrice: document.getElementById('owTriggerPrice'),
    limitWrap: document.getElementById('owLimitWrap'),
    price: document.getElementById('owPrice'),
    marketNote: document.getElementById('owMarketNote'),
    sizingHint: document.getElementById('owSizingHint'),
    buyBtn: document.getElementById('owBuyBtn'),
    sellBtn: document.getElementById('owSellBtn'),
    slPct: document.getElementById('owSlPct'),
    slScope: document.getElementById('owSlScope'),
    sendSlBtn: document.getElementById('owSendSlBtn'),
    slHint: document.getElementById('owSlHint'),
    targetPct: document.getElementById('owTargetPct'),
    targetQtyPct: document.getElementById('owTargetQtyPct'),
    tgtScope: document.getElementById('owTgtScope'),
    sendTargetBtn: document.getElementById('owSendTargetBtn'),
    posCount: document.getElementById('owPosCount'),
    netPnlPill: document.getElementById('owNetPnlPill'),
    posList: document.getElementById('owPosList'),
    toast: document.getElementById('owToast')
  };

  const state = {
    accounts: [],
    positions: [],
    targetStates: {},
    riskSettings: {},
    chainSnapshot: null,
    optionType: 'CE',
    orderType: 'MKT',
    selectedStrike: null,
    manualSymbol: false,
    liveLtp: 0,
    lotSize: 65,
    freezeQty: 1800,
    limitEdited: false,
    triggerEdited: false,
    sizingSeq: 0,
    lastSizingAt: 0,
    toastTimer: null
  };

  function showToast(msg, type = 'info') {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.style.display = 'block';
    els.toast.style.borderColor = type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : '#334155');
    els.toast.style.color = type === 'error' ? '#fca5a5' : (type === 'success' ? '#6ee7b7' : '#f8fafc');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      els.toast.style.display = 'none';
    }, 3200);
  }
  window.showToast = showToast;

  function roundToTick(val) {
    const n = Number(val || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Number((Math.round(n / 0.05) * 0.05).toFixed(2));
  }

  function formatInr(val) {
    const n = Number(val || 0);
    const sign = n < 0 ? '-' : '';
    return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function syncAccountsDropdown(accounts) {
    if (!els.brokerSelect || !Array.isArray(accounts)) return;
    const prevVal = els.brokerSelect.value;
    const enabled = accounts.filter(a => a.enabled && a.manageOrders !== false);
    let savedId = '';
    try { savedId = localStorage.getItem('algo_selected_order_broker') || ''; } catch (e) {}
    const currentVal = prevVal || savedId;
    const sig = enabled.map(a => `${a.id}:${a.name}:${a.availableCash ?? ''}:${a.manageOrders !== false ? 1 : 0}`).join('|');
    if (els.brokerSelect.dataset.sig === sig) return;
    els.brokerSelect.dataset.sig = sig;

    els.brokerSelect.innerHTML = enabled.length > 0
      ? enabled.map(a => {
          const bal = a.availableCash !== undefined && a.availableCash !== null
            ? ` (₹${Math.round(Number(a.availableCash)).toLocaleString('en-IN')})`
            : '';
          return `<option value="${a.id}">${a.name}${bal}</option>`;
        }).join('')
      : '<option value="">No broker checked for orders</option>';

    if (currentVal && enabled.some(a => a.id === currentVal)) {
      els.brokerSelect.value = currentVal;
    } else if (enabled[0]) {
      els.brokerSelect.value = enabled[0].id;
    }
    if (els.brokerSelect.value && els.brokerSelect.value !== prevVal) {
      refreshSizing();
    }
  }

  function syncStrikeOptions(snap) {
    if (!snap || !Array.isArray(snap.strikes) || !els.strikeSelect) return;
    const sig = `${snap.atmStrike}|${snap.strikes.map(s => s.strike).join(',')}`;
    if (els.strikeSelect.dataset.sig !== sig) {
      els.strikeSelect.dataset.sig = sig;
      els.strikeSelect.innerHTML = snap.strikes.map(row => {
        const isAtm = Number(row.strike) === Number(snap.atmStrike);
        return `<option value="${row.strike}">${row.strike}${isAtm ? ' (ATM)' : ''}</option>`;
      }).join('');
    }
    if (!state.selectedStrike && snap.atmStrike) {
      state.selectedStrike = Number(snap.atmStrike);
    }
    if (state.selectedStrike) {
      els.strikeSelect.value = String(state.selectedStrike);
    }
  }

  function applySelectedContractFromChain() {
    const snap = state.chainSnapshot;
    if (!snap || !Array.isArray(snap.strikes) || state.manualSymbol) return;
    const targetStrike = Number(state.selectedStrike || snap.atmStrike || 0);
    const row = snap.strikes.find(r => Number(r.strike) === targetStrike) ||
      snap.strikes.find(r => Number(r.strike) === Number(snap.atmStrike)) ||
      snap.strikes[0];
    if (!row) return;

    const leg = state.optionType === 'PE' ? row.pe : row.ce;
    if (!leg) return;
    const prevSymbol = (els.symbol.value || '').trim();
    if (leg.symbol) els.symbol.value = leg.symbol;
    if (leg.token) els.token.value = leg.token;
    const ltp = Number(leg.ltp || 0);
    state.liveLtp = ltp;
    els.contractLtp.textContent = ltp > 0 ? `₹${ltp.toFixed(2)}` : '--';
    syncPricingDefaults(false);

    if (leg.symbol && leg.symbol !== prevSymbol) {
      refreshSizing();
    } else if (state.orderType === 'MKT' && ltp > 0 && (Date.now() - state.lastSizingAt) >= 1500) {
      refreshSizing();
    }
  }

  function syncPricingDefaults(forceReset) {
    const ot = state.orderType;
    els.triggerWrap.style.display = ot === 'SL' ? 'block' : 'none';
    els.limitWrap.style.display = (ot === 'L' || ot === 'SL') ? 'block' : 'none';
    els.marketNote.style.display = ot === 'MKT' ? 'block' : 'none';

    const ref = Number(state.liveLtp || 0);
    if (ot === 'SL' && (!state.triggerEdited || forceReset) && ref > 0) {
      els.triggerPrice.value = roundToTick(ref).toFixed(2);
    }
    if ((ot === 'L' || ot === 'SL') && (!state.limitEdited || forceReset) && ref > 0) {
      els.price.value = roundToTick(ref + 0.5).toFixed(2);
    }
  }

  async function refreshSizing() {
    const seq = ++state.sizingSeq;
    const symbol = (els.symbol.value || '').trim();
    const accountId = els.brokerSelect ? els.brokerSelect.value : '';
    const routingMode = els.routingMode ? els.routingMode.value : 'selected';
    if (!accountId && routingMode !== 'all_funded') return;
    state.lastSizingAt = Date.now();

    const enteredPrice = Number(els.price.value || 0);
    const triggerPrice = Number(els.triggerPrice.value || 0);
    const ltp = Number(state.liveLtp || 0) || (state.orderType === 'MKT' ? enteredPrice : 0);

    try {
      const res = await fetch('/api/orders/calculate-quantity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId,
          routingMode,
          allocationPct: Number((state.riskSettings && state.riskSettings.capitalDeployPct) || 100),
          tradingSymbol: symbol || 'NIFTY',
          underlying: symbol ? undefined : 'NIFTY',
          instrumentToken: els.token ? els.token.value : '',
          exchangeSegment: els.segment ? els.segment.value : 'nse_fo',
          orderType: state.orderType,
          transactionType: 'B',
          price: state.orderType === 'MKT' ? 0 : enteredPrice,
          triggerPrice: state.orderType === 'SL' ? triggerPrice : 0,
          ltp
        })
      });
      const d = await res.json();
      if (seq !== state.sizingSeq || !d.success || !d.data) return;

      const info = d.data;
      state.lotSize = Math.max(1, Number(info.lotSize || 65));
      state.freezeQty = Math.max(0, Number(info.freezeQty || 0));
      if (Number(info.ltp) > 0 && !(state.liveLtp > 0)) {
        state.liveLtp = Number(info.ltp);
        els.contractLtp.textContent = `₹${state.liveLtp.toFixed(2)}`;
      }
      els.qtyLabel.textContent = `Qty (Lot ${state.lotSize})`;
      els.quantity.min = state.lotSize;
      els.quantity.step = state.lotSize;
      if (els.autoQty.checked) {
        els.quantity.value = Math.max(0, Number(info.quantity || 0));
      } else {
        const cur = Number(els.quantity.value || 0);
        if (!(cur > 0) || cur % state.lotSize !== 0) {
          els.quantity.value = Math.max(state.lotSize, Math.floor(cur / state.lotSize) * state.lotSize || state.lotSize);
        }
      }
      const rate = Number(info.price || 0);
      const rateStr = rate > 0 ? ` | Rate ₹${rate.toFixed(2)}` : ' | Enter price/LTP';
      if (info.routingMode === 'all_funded' && Array.isArray(info.eligibleBrokers)) {
        const elig = info.eligibleBrokers;
        const eligTxt = elig.length > 0 ? elig.map(b => `${b.name}:${b.quantity}`).join(', ') : 'None';
        els.sizingHint.textContent = `All Funded (${elig.length}): ${eligTxt}${rateStr}`;
      } else {
        const usableTxt = info.usableCash !== undefined ? `₹${Math.round(Number(info.usableCash)).toLocaleString('en-IN')}` : '--';
        const needNote = (els.autoQty.checked && rate > 0 && Number(info.quantity || 0) === 0)
          ? ` | Need ₹${(state.lotSize * rate).toFixed(0)}`
          : '';
        els.sizingHint.textContent = `Usable: ${usableTxt} | Auto: ${info.quantity || 0}${rateStr} | Frz: ${state.freezeQty || '∞'}${needNote}`;
      }
    } catch (e) {}
  }

  function renderPositions(positions = [], targetStates = {}) {
    const open = positions.filter(p => p.isOpen && Number(p.netQty || 0) !== 0);
    els.posCount.textContent = String(open.length);
    const totalNet = positions.reduce((s, p) => s + Number(p.netPnl || 0), 0);
    els.netPnlPill.textContent = `Net: ${formatInr(totalNet)}`;
    els.netPnlPill.className = `mono ${totalNet >= 0 ? 'ow-pnl-pos' : 'ow-pnl-neg'}`;

    if (open.length === 0) {
      els.posList.innerHTML = '<div class="ow-hint" style="text-align:center;padding:6px 0;">No open positions</div>';
      return;
    }

    els.posList.innerHTML = open.map(p => {
      const key = `${p.accountId}_${p.symbol}_${p.product}`;
      const ts = targetStates[key];
      const net = Number(p.netPnl || 0);
      const slTxt = ts && ts.slTriggerPrice > 0 ? ` • SL ₹${ts.slTriggerPrice}` : '';
      return `
        <div class="ow-pos-item">
          <div class="ow-pos-meta">
            <span class="ow-pos-sym">${p.symbol}</span>
            <span class="ow-pos-sub mono">${p.brokerName || p.broker} • Qty ${p.netQty} • LTP ₹${Number(p.ltp || 0).toFixed(2)}${slTxt}</span>
          </div>
          <div class="ow-pos-right">
            <span class="mono ${net >= 0 ? 'ow-pnl-pos' : 'ow-pnl-neg'}">${formatInr(net)}</span>
            <button type="button" class="btn-xs btn-danger ow-exit-pos-btn" data-acc="${p.accountId || ''}" data-sym="${p.symbol}" data-prod="${p.product || 'MIS'}">Exit</button>
          </div>
        </div>
      `;
    }).join('');
  }

  async function submitOrder(side) {
    const symbol = (els.symbol.value || '').trim();
    const accountId = els.brokerSelect ? els.brokerSelect.value : '';
    const routingMode = els.routingMode ? els.routingMode.value : 'selected';
    if (!symbol) return showToast('Select or enter a symbol first', 'error');
    if (routingMode === 'selected' && !accountId) return showToast('Select an active broker account', 'error');

    let qtyVal = Math.round(Number(els.quantity.value || 0));
    if (state.lotSize > 1 && qtyVal > 0 && qtyVal % state.lotSize !== 0) {
      qtyVal = Math.max(state.lotSize, Math.round(qtyVal / state.lotSize) * state.lotSize);
      els.quantity.value = qtyVal;
    }

    const refPrice = Number(state.liveLtp || 0);
    const trig = state.orderType === 'SL' ? Number(els.triggerPrice.value || 0) : 0;
    const isMkt = state.orderType === 'MKT';
    const lim = isMkt
      ? roundToTick(refPrice)
      : (Number(els.price.value || 0) > 0
        ? Number(els.price.value)
        : (refPrice > 0 ? roundToTick(refPrice + (side === 'B' ? 0.5 : -0.5)) : 0));

    const payload = {
      accountId,
      routingMode,
      allocationPct: Number((state.riskSettings && state.riskSettings.capitalDeployPct) || 100),
      tradingSymbol: symbol,
      instrumentToken: els.token ? els.token.value : '',
      exchangeSegment: els.segment ? els.segment.value : 'nse_fo',
      transactionType: side,
      product: els.product ? els.product.value : 'MIS',
      orderType: (isMkt && lim > 0) ? 'L' : state.orderType,
      quantity: qtyVal,
      autoQuantity: Boolean(els.autoQty && els.autoQty.checked),
      price: lim,
      triggerPrice: trig,
      ltp: Number(state.liveLtp || lim || 0),
      userConfirmed: true
    };

    const opt = els.brokerSelect && els.brokerSelect.options[els.brokerSelect.selectedIndex];
    const brokerLabel = routingMode === 'all_funded'
      ? 'All Checked Brokers'
      : ((opt && opt.textContent) || accountId);

    if (typeof window.confirmOrderBeforeSend === 'function') {
      const ok = await window.confirmOrderBeforeSend({
        ...payload,
        brokerLabel,
        sourceLabel: 'Pop-Out Order Window Confirmation'
      });
      if (!ok) {
        showToast('Order cancelled before sending to broker', 'info');
        return;
      }
    }

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const d = await res.json();
      if (d.success) {
        showToast(`${side === 'B' ? 'BUY' : 'SELL'} ${symbol} x ${d.totalQuantity || qtyVal} sent!`, 'success');
        refreshSizing();
        loadInitialData();
      } else {
        showToast(d.message || 'Order failed', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function applyMarketPayload(data) {
    if (!data) return;
    if (data.mode) {
      const isLive = data.mode === 'live';
      els.modePill.textContent = isLive ? 'LIVE' : 'MOCK';
      els.modePill.className = `ow-mode-pill${isLive ? ' live' : ''}`;
    }
    if (data.riskSettings) {
      state.riskSettings = data.riskSettings;
    }
    if (Array.isArray(data.accounts)) {
      state.accounts = data.accounts;
      syncAccountsDropdown(data.accounts);
    }
    if (Array.isArray(data.positions)) {
      state.positions = data.positions;
      state.targetStates = data.targetStates || {};
      renderPositions(data.positions, state.targetStates);
    }
  }

  function applyNiftySnapshot(snap) {
    if (!snap) return;
    state.chainSnapshot = snap;
    if (Number(snap.niftyLtp) > 0) {
      els.niftyLtp.textContent = Number(snap.niftyLtp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (snap.atmStrike) {
      els.atmBadge.textContent = `ATM ${snap.atmStrike}`;
    }
    syncStrikeOptions(snap);
    applySelectedContractFromChain();
  }

  async function loadInitialData() {
    try {
      const [statusRes, posRes, feedRes] = await Promise.all([
        fetch('/api/status').then(r => r.json()).catch(() => null),
        fetch('/api/positions').then(r => r.json()).catch(() => null),
        fetch('/api/nifty-feed').then(r => r.json()).catch(() => null)
      ]);
      if (statusRes && statusRes.success) {
        applyMarketPayload({
          mode: statusRes.mode,
          accounts: statusRes.accounts,
          riskSettings: statusRes.riskSettings
        });
        if (els.routingMode && statusRes.riskSettings && statusRes.riskSettings.orderRoutingMode) {
          els.routingMode.value = statusRes.riskSettings.orderRoutingMode === 'all_funded' ? 'all_funded' : 'selected';
        }
      }
      if (posRes && posRes.success && Array.isArray(posRes.data)) {
        applyMarketPayload({ positions: posRes.data, targetStates: state.targetStates });
      }
      if (feedRes && feedRes.success && feedRes.data) {
        applyNiftySnapshot(feedRes.data);
      }
      await refreshSizing();
    } catch (e) {}
  }

  // Event bindings
  [els.ceBtn, els.peBtn].forEach(btn => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      state.optionType = btn.dataset.opt === 'PE' ? 'PE' : 'CE';
      state.manualSymbol = false;
      els.ceBtn.classList.toggle('active', state.optionType === 'CE');
      els.peBtn.classList.toggle('active', state.optionType === 'PE');
      applySelectedContractFromChain();
      refreshSizing();
    });
  });

  if (els.strikeSelect) {
    els.strikeSelect.addEventListener('change', () => {
      state.selectedStrike = Number(els.strikeSelect.value || 0) || null;
      state.manualSymbol = false;
      applySelectedContractFromChain();
      refreshSizing();
    });
  }

  if (els.useAtmBtn) {
    els.useAtmBtn.addEventListener('click', () => {
      state.manualSymbol = false;
      state.selectedStrike = (state.chainSnapshot && Number(state.chainSnapshot.atmStrike)) || null;
      syncStrikeOptions(state.chainSnapshot);
      applySelectedContractFromChain();
      refreshSizing();
    });
  }

  document.querySelectorAll('.ow-chip[data-strike-offset]').forEach(chip => {
    chip.addEventListener('click', () => {
      state.manualSymbol = false;
      const offset = Number(chip.dataset.strikeOffset || 0);
      if (chip.dataset.opt) {
        state.optionType = chip.dataset.opt;
        els.ceBtn.classList.toggle('active', state.optionType === 'CE');
        els.peBtn.classList.toggle('active', state.optionType === 'PE');
        state.selectedStrike = (state.chainSnapshot && Number(state.chainSnapshot.atmStrike)) || state.selectedStrike;
      } else if (state.selectedStrike) {
        state.selectedStrike = Number(state.selectedStrike) + offset;
      }
      syncStrikeOptions(state.chainSnapshot);
      applySelectedContractFromChain();
      refreshSizing();
    });
  });

  if (els.orderTypeTabs) {
    els.orderTypeTabs.querySelectorAll('[data-ot]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.orderType = btn.dataset.ot || 'MKT';
        state.limitEdited = false;
        state.triggerEdited = false;
        els.orderTypeTabs.querySelectorAll('[data-ot]').forEach(b => b.classList.toggle('active', b === btn));
        syncPricingDefaults(true);
        refreshSizing();
      });
    });
  }

  document.querySelectorAll('.ow-lot-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const lots = Math.max(1, Number(chip.dataset.lots || 1));
      els.autoQty.checked = false;
      els.quantity.value = lots * Math.max(1, state.lotSize || 65);
    });
  });

  els.symbol.addEventListener('input', () => {
    state.manualSymbol = true;
    state.liveLtp = 0;
    els.contractLtp.textContent = '--';
    refreshSizing();
  });

  els.quantity.addEventListener('input', () => {
    els.autoQty.checked = false;
  });

  [els.brokerSelect, els.routingMode, els.segment, els.autoQty].forEach(el => {
    if (!el) return;
    el.addEventListener('change', () => {
      if (el === els.brokerSelect) {
        try { localStorage.setItem('algo_selected_order_broker', els.brokerSelect.value); } catch (e) {}
      }
      refreshSizing();
    });
  });

  els.triggerPrice.addEventListener('input', () => {
    state.triggerEdited = true;
    if (state.orderType === 'SL' && !state.limitEdited) {
      const trig = Number(els.triggerPrice.value || 0);
      if (trig > 0) els.price.value = roundToTick(trig + 0.5).toFixed(2);
    }
    refreshSizing();
  });
  els.price.addEventListener('input', () => {
    state.limitEdited = true;
    refreshSizing();
  });

  els.buyBtn.addEventListener('click', () => submitOrder('B'));
  els.sellBtn.addEventListener('click', () => submitOrder('S'));

  document.querySelectorAll('.ow-sl-preset').forEach(chip => {
    chip.addEventListener('click', () => {
      if (els.slPct) els.slPct.value = chip.dataset.sl || '-10';
    });
  });
  document.querySelectorAll('.ow-tgt-preset').forEach(chip => {
    chip.addEventListener('click', () => {
      if (els.targetPct) els.targetPct.value = chip.dataset.tgt || '20';
    });
  });

  async function dispatchBulkProtectiveOrder(mode) {
    const isTarget = mode === 'TARGET';
    const inputEl = isTarget ? els.targetPct : els.slPct;
    const scopeEl = isTarget ? els.tgtScope : els.slScope;
    const btnEl = isTarget ? els.sendTargetBtn : els.sendSlBtn;
    const endpoint = isTarget ? '/api/orders/send-target' : '/api/orders/send-stoploss';
    const label = isTarget ? 'Target Limit' : 'SL';

    const pct = Number(inputEl ? inputEl.value : 0);
    if (!Number.isFinite(pct) || pct === 0) {
      return showToast(`Enter a non-zero ${label} %`, 'error');
    }
    const scope = (scopeEl && scopeEl.value === 'selected') ? 'selected' : 'all_managed';
    const accountId = els.brokerSelect ? els.brokerSelect.value : '';
    const qtyPct = isTarget ? Number((els.targetQtyPct && els.targetQtyPct.value) || 100) : 100;
    const bodyBase = isTarget
      ? { targetPct: pct, qtyPct, accountId, scope }
      : { slPct: pct, accountId, scope };

    if (btnEl) btnEl.disabled = true;
    try {
      const preRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...bodyBase, preview: true })
      });
      const pre = await preRes.json();
      if (!pre.success) {
        return showToast(pre.message || `Failed to compute ${label} prices`, 'error');
      }
      const ready = (pre.items || []).filter(it => it.status === 'READY');
      const skippedList = (pre.items || []).filter(it => it.status !== 'READY');
      if (ready.length === 0) {
        const skipReason = skippedList[0] ? skippedList[0].reason : 'No open positions on checked brokers';
        return showToast(`No ${label} order ready: ${skipReason}`, 'info');
      }

      const summaryLines = ready.map(it =>
        isTarget
          ? `${it.brokerName} ${it.symbol} (${it.quantity}) -> Limit ₹${it.limitPrice}`
          : `${it.brokerName} ${it.symbol} (${it.quantity}) -> Trig ₹${it.triggerPrice} / Lim ₹${it.limitPrice}`
      ).join(' | ');

      if (typeof window.confirmOrderBeforeSend === 'function') {
        const first = ready[0];
        const confirmed = await window.confirmOrderBeforeSend({
          title: `Confirm Bulk ${label} (${pct > 0 ? '+' : ''}${pct}%${isTarget ? ` • ${qtyPct}% qty` : ''}) for ${ready.length} Position(s)`,
          sourceLabel: `Order Window ${label} Button`,
          brokerLabel: ready.length === 1 ? first.brokerName : `${ready.length} Checked Brokers`,
          transactionType: first.transactionType,
          tradingSymbol: ready.length === 1 ? first.symbol : `${ready.length} Positions`,
          product: first.product,
          orderType: isTarget ? 'L' : 'SL',
          quantity: ready.reduce((s, r) => s + Number(r.quantity || 0), 0),
          triggerPrice: isTarget ? 0 : first.triggerPrice,
          price: first.limitPrice,
          ltp: first.ltp,
          reason: summaryLines + (skippedList.length > 0 ? ` (Skipped ${skippedList.length}: ${skippedList[0].reason})` : '')
        });
        if (!confirmed) {
          return showToast(`Bulk ${label} cancelled before sending to broker`, 'info');
        }
      }

      const execRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...bodyBase, preview: false })
      });
      const exec = await execRes.json();
      if (exec.success) {
        const sentCnt = (exec.sent || []).length;
        const skipCnt = (exec.skipped || []).length;
        showToast(
          `Sent ${sentCnt} ${label} order(s)${skipCnt > 0 ? `, skipped ${skipCnt}` : ''}`,
          sentCnt > 0 ? 'success' : 'info'
        );
        loadInitialData();
      } else {
        showToast(exec.message || `Failed to send ${label} orders`, 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  if (els.sendSlBtn) els.sendSlBtn.addEventListener('click', () => dispatchBulkProtectiveOrder('SL'));
  if (els.sendTargetBtn) els.sendTargetBtn.addEventListener('click', () => dispatchBulkProtectiveOrder('TARGET'));

  if (els.exitAllBtn) {
    els.exitAllBtn.addEventListener('click', async () => {
      if (!confirm('Square-off ALL open positions across all brokers?')) return;
      try {
        const res = await fetch('/api/autoexit/exit-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const d = await res.json();
        showToast(d.message || 'Exit All executed', d.success ? 'success' : 'error');
        loadInitialData();
      } catch (e) {
        showToast(e.message, 'error');
      }
    });
  }

  if (els.posList) {
    els.posList.addEventListener('click', async ev => {
      const btn = ev.target.closest('.ow-exit-pos-btn');
      if (!btn) return;
      const symbol = btn.dataset.sym;
      const accountId = btn.dataset.acc;
      const product = btn.dataset.prod;
      try {
        const res = await fetch('/api/autoexit/exit-position', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, accountId, product, reason: 'Manual Quick Window Exit' })
        });
        const d = await res.json();
        showToast(d.success ? `Exited ${symbol}` : (d.message || 'Exit queued/failed'), d.success ? 'success' : 'info');
        loadInitialData();
      } catch (e) {
        showToast(e.message, 'error');
      }
    });
  }

  // SSE live updates
  const es = new EventSource('/api/stream');
  es.addEventListener('market_tick', e => {
    try { applyMarketPayload(JSON.parse(e.data)); } catch (err) {}
  });
  es.addEventListener('nifty_tick', e => {
    try { applyNiftySnapshot(JSON.parse(e.data)); } catch (err) {}
  });
  if (typeof window.attachOrderConfirmationStream === 'function') {
    window.attachOrderConfirmationStream(es);
  }

  // Remember Quick Order Window size and screen position across re-opens
  const BOUNDS_STORAGE_KEY = 'algo_order_window_bounds';
  let allowSaveBounds = false;
  let lastBoundsSig = '';
  let resizeSaveTimer = null;

  function readSavedBounds() {
    try {
      const raw = localStorage.getItem(BOUNDS_STORAGE_KEY);
      if (!raw) return null;
      const b = JSON.parse(raw);
      return b && typeof b === 'object' ? b : null;
    } catch (e) {
      return null;
    }
  }

  function saveCurrentBounds(force = false) {
    if (!allowSaveBounds && !force) return;
    const ow = Math.round(Number(window.outerWidth || 0));
    const oh = Math.round(Number(window.outerHeight || 0));
    const iw = Math.round(Number(window.innerWidth || 0));
    const ih = Math.round(Number(window.innerHeight || 0));
    if (iw < 240 || ih < 260) return;

    const left = Math.round(Number(window.screenX !== undefined ? window.screenX : (window.screenLeft || 0)));
    const top = Math.round(Number(window.screenY !== undefined ? window.screenY : (window.screenTop || 0)));
    const sig = `${iw}|${ih}|${ow}|${oh}|${left}|${top}`;
    if (sig === lastBoundsSig) return;
    lastBoundsSig = sig;

    try {
      localStorage.setItem(BOUNDS_STORAGE_KEY, JSON.stringify({
        innerWidth: iw,
        innerHeight: ih,
        outerWidth: ow > 0 ? ow : iw,
        outerHeight: oh > 0 ? oh : ih,
        left,
        top,
        updatedAt: Date.now()
      }));
    } catch (e) {}
  }

  function restoreSavedBounds() {
    const saved = readSavedBounds();
    const isPopupLike = Boolean(window.opener) || (window.screen && window.outerWidth < window.screen.availWidth * 0.9);
    if (saved && isPopupLike) {
      const availW = (window.screen && window.screen.availWidth) || 1920;
      const availH = (window.screen && window.screen.availHeight) || 1080;
      const targetOuterW = Math.max(280, Math.min(availW, Math.round(Number(saved.outerWidth || saved.innerWidth || 410))));
      const targetOuterH = Math.max(320, Math.min(availH, Math.round(Number(saved.outerHeight || saved.innerHeight || 660))));
      try {
        if (Number.isFinite(Number(saved.left)) && Number.isFinite(Number(saved.top))) {
          window.moveTo(Math.round(Number(saved.left)), Math.round(Number(saved.top)));
        }
        window.resizeTo(targetOuterW, targetOuterH);
      } catch (e) {}
    }
    setTimeout(() => {
      allowSaveBounds = true;
      saveCurrentBounds(true);
    }, 450);
  }

  restoreSavedBounds();
  window.addEventListener('resize', () => {
    clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => saveCurrentBounds(false), 180);
  });
  window.addEventListener('beforeunload', () => saveCurrentBounds(false));
  window.addEventListener('pagehide', () => saveCurrentBounds(false));
  setInterval(() => saveCurrentBounds(false), 750);

  window.loadPositions = loadInitialData;
  loadInitialData();
})();
