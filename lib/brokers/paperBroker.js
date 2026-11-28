const fs = require('fs');
const path = require('path');
const ChargesCalculator = require('../chargesCalculator');

function getISTTimeParts(dateObj = new Date()) {
  const utc = dateObj.getTime() + dateObj.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 3600000 * 5.5);
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  return {
    dayOfWeek: ist.getDay(), // 0=Sun..6=Sat
    dateStr: ist.toISOString().split('T')[0],
    hours,
    minutes,
    minutesOfDay: hours * 60 + minutes
  };
}

function isPaperMarketHoursIST(dateObj = new Date()) {
  const parts = getISTTimeParts(dateObj);
  if (parts.dayOfWeek === 0 || parts.dayOfWeek === 6) return false;
  return parts.minutesOfDay >= (9 * 60 + 15) && parts.minutesOfDay < (15 * 60 + 30);
}

function getISTDateStr(dateObj = new Date()) {
  return getISTTimeParts(dateObj).dateStr;
}

function isMisProduct(product = 'MIS') {
  const p = String(product || 'MIS').trim().toUpperCase();
  return p === 'MIS' || p === 'INTRADAY' || p === 'I';
}

/**
 * Paper Trading Broker Adapter (Options-Only Virtual Execution)
 * Runs alongside live brokers even in LIVE mode, persisting virtual capital,
 * open/closed options positions, and order book to local JSON, updating live
 * Net Position P&L (including charges) into account balance, and carrying
 * closing net equity forward automatically across restarts and trading days.
 */
class PaperBroker {
  constructor(accountConfig = {}) {
    this.id = accountConfig.id || `acc_paper_${Date.now()}`;
    this.broker = 'paper';
    this.name = accountConfig.name || 'Paper Trading (Options)';
    this.isMock = false;
    this.isPaper = true;
    this.isAuthenticated = true;
    this.lastLoginTime = new Date().toISOString();
    this.lastError = null;

    this.initialBalance = Math.max(1000, Number(accountConfig.initialBalance || 500000));
    this.carriedBalance = this.initialBalance;
    this.lastTradingDate = getISTDateStr();
    this.lastMisSquareOffDate = '';
    this.enforceMarketHours = accountConfig.enforceMarketHours !== false;

    this.brokerageType = accountConfig.brokerageType;
    this.brokeragePerOrder = accountConfig.brokeragePerOrder;
    this.optionsBrokerage = accountConfig.optionsBrokerage;
    this._onOrdersChanged = typeof accountConfig.onOrdersChanged === 'function'
      ? accountConfig.onOrdersChanged
      : null;
    this._lastOrdersSig = '';
    this._chargeSettingsProvider = typeof accountConfig.chargeSettingsProvider === 'function'
      ? accountConfig.chargeSettingsProvider
      : null;
    this._staticChargeSettings = accountConfig.chargeSettings || null;
    this._chargesEnabled = Boolean(
      this._chargeSettingsProvider ||
      this._staticChargeSettings ||
      accountConfig.includeCharges ||
      accountConfig.brokerageType !== undefined ||
      accountConfig.brokeragePerOrder !== undefined
    );

    this.stateFile = accountConfig.stateFile !== undefined
      ? accountConfig.stateFile
      : path.join(__dirname, '..', '..', 'data', `paper-state-${this.id}.json`);

    this.funds = {
      availableCash: this.initialBalance,
      utilizedMargin: 0,
      totalBalance: this.initialBalance,
      carriedBalance: this.initialBalance,
      netPnl: 0
    };
    this.positions = [];
    this.orders = [];
    this._lastFeedPrices = new Map();
    this._lastTokenPrices = new Map();
    this._cache = {
      positions: { data: [] },
      holdings: { data: [] },
      funds: { data: { ...this.funds } },
      orders: { data: [] }
    };

    this._loadState();
    this.rolloverIfNewDay(getISTDateStr());
    this._recalculateFunds();
    this._syncCache();
  }

  _getChargeConfig() {
    if (!this._chargesEnabled) return null;
    const chargeSettings = this._chargeSettingsProvider
      ? (this._chargeSettingsProvider() || {})
      : (this._staticChargeSettings || ChargesCalculator.getDefaultChargeSettings());
    const brokerPref = {
      brokerageType: this.brokerageType,
      brokeragePerOrder: this.brokeragePerOrder,
      optionsBrokerage: this.optionsBrokerage
    };
    return { chargeSettings, brokerPref };
  }

  _computePositionNetInfo(pos, cfg) {
    const gross = Number(pos.unrealizedPnl || 0) + Number(pos.realizedPnl || 0);
    if (!cfg) {
      return { grossPnl: gross, totalCharges: 0, netPnl: gross };
    }
    const sym = String(pos.symbol || '').trim().toUpperCase();
    const matchingOrders = this.orders.filter(o =>
      String(o.symbol || '').trim().toUpperCase() === sym &&
      ChargesCalculator.isExecutedOrder(o)
    );
    const info = ChargesCalculator.calculatePositionCharges(
      { ...pos, totalPnl: gross },
      cfg.brokerPref,
      cfg.chargeSettings,
      matchingOrders.length > 0 ? matchingOrders : null
    );
    return {
      grossPnl: Number(info.grossPnl || gross),
      totalCharges: Number(info.totalCharges || 0),
      netPnl: Number(info.netPnl !== undefined ? info.netPnl : gross)
    };
  }

  _loadState() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (Number(parsed.carriedBalance) > 0) {
          this.carriedBalance = Number(parsed.carriedBalance);
        } else if (parsed.funds && Number(parsed.funds.carriedBalance) > 0) {
          this.carriedBalance = Number(parsed.funds.carriedBalance);
        }
        if (parsed.lastTradingDate) {
          this.lastTradingDate = String(parsed.lastTradingDate);
        } else if (parsed.updatedAt) {
          this.lastTradingDate = getISTDateStr(new Date(parsed.updatedAt));
        }
        if (parsed.lastMisSquareOffDate) {
          this.lastMisSquareOffDate = String(parsed.lastMisSquareOffDate);
        }
        const fallbackIst = parsed.updatedAt ? getISTTimeParts(new Date(parsed.updatedAt)) : null;
        if (parsed.funds) {
          this.funds = {
            availableCash: Number(parsed.funds.availableCash ?? this.carriedBalance),
            utilizedMargin: Number(parsed.funds.utilizedMargin || 0),
            totalBalance: Number(parsed.funds.totalBalance ?? this.carriedBalance),
            carriedBalance: this.carriedBalance,
            netPnl: Number(parsed.funds.netPnl || 0)
          };
        }
        if (Array.isArray(parsed.positions)) {
          this.positions = parsed.positions.map(p => ({
            ...p,
            openedIstDate: p.openedIstDate || this.lastTradingDate,
            openedIstMinutes: p.openedIstMinutes !== undefined
              ? p.openedIstMinutes
              : (fallbackIst ? fallbackIst.minutesOfDay : 555)
          }));
        }
        if (Array.isArray(parsed.orders)) {
          this.orders = parsed.orders.map(o => ({
            ...o,
            openedIstDate: o.openedIstDate || this.lastTradingDate,
            openedIstMinutes: o.openedIstMinutes !== undefined
              ? o.openedIstMinutes
              : (fallbackIst ? fallbackIst.minutesOfDay : 555)
          }));
        }
      }
    } catch (e) {}
  }

  _saveState() {
    if (!this.stateFile) return;
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify({
          id: this.id,
          name: this.name,
          initialBalance: this.initialBalance,
          carriedBalance: this.carriedBalance,
          lastTradingDate: this.lastTradingDate,
          lastMisSquareOffDate: this.lastMisSquareOffDate,
          funds: this.funds,
          positions: this.positions,
          orders: this.orders,
          updatedAt: new Date().toISOString()
        }, null, 2),
        'utf8'
      );
    } catch (e) {}
  }

  /**
   * Square off all open Paper MIS intraday positions at current Market Price at/after 15:30 IST (3:30 PM),
   * and cancel any pending OPEN MIS Limit/Trigger orders. Leaves NRML positions and orders intact.
   */
  autoSquareOffMisIfNeeded(now = new Date(), options = {}) {
    const parts = getISTTimeParts(now);
    const force = Boolean(options.force);
    const afterCutoff = force || parts.minutesOfDay >= (15 * 60 + 30);
    if (!afterCutoff) {
      return { squaredOffCount: 0, cancelledOrdersCount: 0, items: [] };
    }

    const qualifiesBeforeClose = item => {
      if (force) return true;
      const itemDate = item && item.openedIstDate ? String(item.openedIstDate) : this.lastTradingDate;
      if (itemDate && itemDate < parts.dateStr) return true;
      if (!item || item.openedIstMinutes === undefined || item.openedIstMinutes === null) return true;
      return Number(item.openedIstMinutes) < (15 * 60 + 30);
    };

    let cancelledOrdersCount = 0;
    for (const ord of this.orders) {
      if (ord.status === 'OPEN' && isMisProduct(ord.product) && qualifiesBeforeClose(ord)) {
        ord.status = 'CANCELLED';
        ord.cancelReason = 'MIS Auto Square-Off 15:30 IST';
        cancelledOrdersCount++;
      }
    }

    const items = [];
    let squaredOffCount = 0;
    for (const pos of this.positions) {
      if (!pos.isOpen || Number(pos.netQty || 0) === 0) continue;
      if (!isMisProduct(pos.product)) continue;
      if (!qualifiesBeforeClose(pos)) continue;

      const qty = Math.abs(Number(pos.netQty));
      const exitSide = Number(pos.netQty) > 0 ? 'S' : 'B';
      const symKey = String(pos.symbol || '').trim().toUpperCase();
      const tokKey = pos.instrumentToken ? String(pos.instrumentToken).trim() : '';
      const marketLtp = this._lastFeedPrices.get(symKey)
        || (tokKey ? this._lastTokenPrices.get(tokKey) : 0)
        || Number(pos.ltp || 0)
        || (Number(pos.netQty) > 0 ? Number(pos.buyAvg || 0) : Number(pos.sellAvg || 0))
        || 0;
      const execPx = Number(Number(marketLtp).toFixed(2));

      const sqOrder = {
        orderId: `PAPER-MIS-SQ-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        accountId: this.id,
        broker: 'paper',
        brokerName: this.name,
        symbol: symKey,
        exchange: (pos.exchangeSegment || 'NFO').toUpperCase(),
        product: pos.product || 'MIS',
        transactionType: exitSide,
        orderType: 'MKT',
        quantity: qty,
        filledQuantity: qty,
        price: execPx,
        triggerPrice: 0,
        instrumentToken: pos.instrumentToken || '',
        status: 'COMPLETE',
        isAutoMisSquareOff: true,
        orderTime: '15:30 IST Auto Square-Off',
        openedIstDate: parts.dateStr,
        openedIstMinutes: parts.minutesOfDay
      };
      this.orders.unshift(sqOrder);
      this._applyExecutionToPosition(sqOrder, execPx);
      squaredOffCount++;
      items.push({ symbol: symKey, quantity: qty, side: exitSide, price: execPx, orderId: sqOrder.orderId });
    }

    if (squaredOffCount > 0 || cancelledOrdersCount > 0) {
      this.lastMisSquareOffDate = parts.dateStr;
      this._recalculateFunds();
      this._syncCache();
      this._saveState();
    }

    return { squaredOffCount, cancelledOrdersCount, items };
  }

  /**
   * Carry forward net realized/settled P&L automatically when a new IST trading day begins.
   * Intraday MIS positions & closed trades settle into carriedBalance; NRML open positions
   * and open NRML orders stay active and carry forward cleanly to the next trading day.
   */
  rolloverIfNewDay(todayStr = getISTDateStr()) {
    if (!this.lastTradingDate) {
      this.lastTradingDate = todayStr;
      return false;
    }
    if (this.lastTradingDate === todayStr) return false;

    const cfg = this._getChargeConfig();
    let settledNet = 0;
    const remainingOpen = [];

    for (const pos of this.positions) {
      const product = String(pos.product || 'MIS').toUpperCase();
      const netQty = Number(pos.netQty || 0);
      const isClosed = !pos.isOpen || netQty === 0;

      if (isClosed || isMisProduct(product)) {
        const netInfo = this._computePositionNetInfo(pos, cfg);
        settledNet += netInfo.netPnl;
      } else {
        // Carry forward open NRML position: settle any prior closed portion into carriedBalance,
        // and keep original entry avg & unrealized MTM intact across trading days!
        const netInfo = this._computePositionNetInfo(pos, cfg);
        const openUnrealized = Number(pos.unrealizedPnl || 0);
        const realizedPartNet = Number(pos.realizedPnl || 0) !== 0
          ? (netInfo.netPnl - openUnrealized)
          : 0;
        settledNet += realizedPartNet;
        const entryPx = netQty > 0 ? Number(pos.buyAvg || pos.ltp || 0) : Number(pos.sellAvg || pos.ltp || 0);
        const ltpPx = Number(pos.ltp || entryPx || 0);
        const nextUnreal = netQty > 0
          ? Number(((ltpPx - entryPx) * netQty).toFixed(2))
          : Number(((entryPx - ltpPx) * Math.abs(netQty)).toFixed(2));
        remainingOpen.push({
          ...pos,
          buyQty: netQty > 0 ? Math.abs(netQty) : 0,
          sellQty: netQty < 0 ? Math.abs(netQty) : 0,
          buyAvg: netQty > 0 ? entryPx : 0,
          sellAvg: netQty < 0 ? entryPx : 0,
          ltp: ltpPx,
          realizedPnl: 0,
          unrealizedPnl: nextUnreal,
          totalPnl: nextUnreal,
          isOpen: true,
          openedIstDate: pos.openedIstDate || this.lastTradingDate,
          openedIstMinutes: pos.openedIstMinutes !== undefined ? pos.openedIstMinutes : 555
        });
      }
    }

    const carriedNrmlKeys = new Set(
      remainingOpen.map(p => `${String(p.symbol || '').trim().toUpperCase()}_${String(p.product || 'NRML').toUpperCase()}`)
    );
    this.carriedBalance = Number(Math.max(0, this.carriedBalance + settledNet).toFixed(2));
    this.positions = remainingOpen;
    this.orders = this.orders.filter(o => {
      if (isMisProduct(o.product)) return false;
      if (o.status === 'OPEN') return true;
      const k = `${String(o.symbol || '').trim().toUpperCase()}_${String(o.product || 'NRML').toUpperCase()}`;
      return carriedNrmlKeys.has(k);
    });
    this.lastTradingDate = todayStr;
    this.lastMisSquareOffDate = '';
    this._recalculateFunds();
    this._syncCache();
    this._saveState();
    return true;
  }

  _recalculateFunds() {
    const cfg = this._getChargeConfig();
    let utilized = 0;
    let totalNetPnl = 0;
    let realizedNetPnl = 0;
    let unrealizedPnl = 0;
    let totalCharges = 0;

    for (const p of this.positions) {
      const info = this._computePositionNetInfo(p, cfg);
      totalNetPnl += info.netPnl;
      totalCharges += info.totalCharges;
      unrealizedPnl += Number(p.unrealizedPnl || 0);
      realizedNetPnl += Number(p.realizedPnl || 0) - info.totalCharges;

      if (Number(p.netQty || 0) > 0) {
        utilized += Number(p.netQty) * Number(p.buyAvg || 0);
      } else if (Number(p.netQty || 0) < 0) {
        utilized += Math.abs(Number(p.netQty)) * Number(p.sellAvg || 0);
      }
    }

    const equity = Number(Math.max(0, this.carriedBalance + totalNetPnl).toFixed(2));
    this.funds.carriedBalance = Number(this.carriedBalance.toFixed(2));
    this.funds.utilizedMargin = Number(utilized.toFixed(2));
    this.funds.totalBalance = equity;
    this.funds.availableCash = Number(Math.max(0, equity - utilized).toFixed(2));
    this.funds.netPnl = Number(totalNetPnl.toFixed(2));
    this.funds.realizedNetPnl = Number(realizedNetPnl.toFixed(2));
    this.funds.unrealizedPnl = Number(unrealizedPnl.toFixed(2));
    this.funds.totalCharges = Number(totalCharges.toFixed(2));
  }

  _syncCache() {
    this._cache.positions.data = this.positions.map(p => ({ ...p }));
    this._cache.holdings.data = [];
    this._cache.funds.data = { ...this.funds };
    this._cache.orders.data = this.orders.map(o => ({ ...o }));
    const ordersSig = this.orders
      .map(o => `${o.orderId || ''}:${o.status || ''}:${o.filledQuantity || 0}:${o.price || 0}:${o.triggerPrice || 0}`)
      .join('|');
    if (ordersSig !== this._lastOrdersSig) {
      this._lastOrdersSig = ordersSig;
      if (typeof this._onOrdersChanged === 'function') {
        try {
          this._onOrdersChanged(this._cache.orders.data);
        } catch (e) {}
      }
    }
  }

  getFundsSnapshot() {
    this.rolloverIfNewDay(getISTDateStr());
    this.autoSquareOffMisIfNeeded();
    this._recalculateFunds();
    this._syncCache();
    return { ...this.funds };
  }

  async login() {
    this.rolloverIfNewDay(getISTDateStr());
    this.autoSquareOffMisIfNeeded();
    this._recalculateFunds();
    this._syncCache();
    this.isAuthenticated = true;
    this.lastLoginTime = new Date().toISOString();
    this.lastError = null;
    return {
      success: true,
      message: `Paper Trading ready (Balance ₹${this.funds.availableCash.toLocaleString('en-IN')})`
    };
  }

  async getFunds() {
    return this.getFundsSnapshot();
  }

  async getPositions() {
    this.rolloverIfNewDay(getISTDateStr());
    this.autoSquareOffMisIfNeeded();
    this._syncCache();
    return this.positions.map(p => ({ ...p }));
  }

  async getHoldings() {
    return [];
  }

  async getOrderBook() {
    this.rolloverIfNewDay(getISTDateStr());
    this.autoSquareOffMisIfNeeded();
    this._syncCache();
    return this.orders.map(o => ({ ...o }));
  }

  _roundTick(val) {
    const n = Number(val || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Number((Math.round(n / 0.05) * 0.05).toFixed(2));
  }

  isMarketHoursOpen(now = new Date()) {
    return isPaperMarketHoursIST(now);
  }

  _applyFeedPrices(priceBySym, priceByToken = new Map(), now = new Date()) {
    const hasOpenOrders = this.orders.some(o => o.status === 'OPEN');
    if (this.positions.length === 0 && !hasOpenOrders) return;

    let changed = false;
    for (const pos of this.positions) {
      if (!pos.isOpen || pos.netQty === 0) continue;
      const symKey = String(pos.symbol || '').trim().toUpperCase();
      const tokKey = pos.instrumentToken ? String(pos.instrumentToken).trim() : '';
      const liveLtp = priceBySym.get(symKey) || (tokKey ? priceByToken.get(tokKey) : 0);
      if (liveLtp > 0 && liveLtp !== pos.ltp) {
        pos.ltp = liveLtp;
        pos.unrealizedPnl = pos.netQty > 0
          ? Number(((liveLtp - pos.buyAvg) * pos.netQty).toFixed(2))
          : Number(((pos.sellAvg - liveLtp) * Math.abs(pos.netQty)).toFixed(2));
        pos.totalPnl = Number((pos.unrealizedPnl + Number(pos.realizedPnl || 0)).toFixed(2));
        changed = true;
      }
    }
    const canMatchOrders = !this.enforceMarketHours || this.isMarketHoursOpen(now);
    const filledOrder = canMatchOrders ? this._checkPendingOrdersOnSnapshot(priceBySym, priceByToken) : false;
    if (changed || filledOrder) {
      this._recalculateFunds();
      this._syncCache();
      this._saveState();
    }
  }

  /**
   * Update paper option positions' live LTP & MTM and trigger/fill matching OPEN
   * Limit & Trigger orders from incoming NIFTY option chain ticks.
   */
  syncWithNiftySnapshot(snapshot, now = new Date()) {
    if (!snapshot || !Array.isArray(snapshot.strikes)) return;
    const priceBySym = new Map();
    const priceByToken = new Map();
    for (const row of snapshot.strikes) {
      for (const leg of [row.ce, row.pe]) {
        if (leg && Number(leg.ltp) > 0) {
          const ltp = Number(leg.ltp);
          if (leg.symbol) {
            const symKey = String(leg.symbol).trim().toUpperCase();
            priceBySym.set(symKey, ltp);
            this._lastFeedPrices.set(symKey, ltp);
          }
          if (leg.instrumentToken) {
            const tokKey = String(leg.instrumentToken).trim();
            priceByToken.set(tokKey, ltp);
            this._lastTokenPrices.set(tokKey, ltp);
          }
        }
      }
    }
    const tickTime = now || (snapshot.timestamp ? new Date(snapshot.timestamp) : new Date());
    this._applyFeedPrices(priceBySym, priceByToken, tickTime);
  }

  /**
   * Sync a single live WebSocket tick ({ symbol, tradingSymbol, token, ltp }) with
   * open Paper positions and pending Limit/Trigger orders.
   */
  syncWithTick(tick = {}, now = new Date()) {
    const ltp = Number(tick.ltp || 0);
    if (!(ltp > 0)) return;
    const priceBySym = new Map();
    const priceByToken = new Map();
    const symRaw = tick.symbol || tick.tradingSymbol || '';
    if (symRaw) {
      const symKey = String(symRaw).trim().toUpperCase();
      priceBySym.set(symKey, ltp);
      this._lastFeedPrices.set(symKey, ltp);
    }
    const tokRaw = tick.token || tick.instrumentToken || tick.securityId || tick.instrumentId || '';
    if (tokRaw) {
      const tokKey = String(tokRaw).trim();
      priceByToken.set(tokKey, ltp);
      this._lastTokenPrices.set(tokKey, ltp);
    }
    if (priceBySym.size === 0 && priceByToken.size === 0) return;
    const tickTime = now || (tick.receivedAt ? new Date(tick.receivedAt) : new Date());
    this._applyFeedPrices(priceBySym, priceByToken, tickTime);
  }

  _checkPendingOrdersOnSnapshot(priceBySym, priceByToken = new Map()) {
    let filledAny = false;
    let stateMutated = false;
    for (const ord of this.orders) {
      if (ord.status !== 'OPEN') continue;
      const symKey = String(ord.symbol || '').trim().toUpperCase();
      const tokKey = ord.instrumentToken ? String(ord.instrumentToken).trim() : '';
      const liveLtp = priceBySym.get(symKey) || (tokKey ? priceByToken.get(tokKey) : 0);
      if (!(liveLtp > 0)) continue;
      const tickLtp = this._roundTick(liveLtp);
      const ot = String(ord.orderType || '').toUpperCase();
      const side = String(ord.transactionType || 'B').toUpperCase();
      let matched = false;
      let fillPx = liveLtp;
      if (ot === 'SL' || ot === 'SL-LMT' || ot === 'SL-M' || ot === 'SL-MKT') {
        const trig = Number(ord.triggerPrice || 0);
        const lim = Number(ord.price || 0);
        const isSlMarket = ot === 'SL-M' || ot === 'SL-MKT' || !(lim > 0);
        if (!ord.slTriggered && trig > 0) {
          if ((side === 'S' && liveLtp <= trig) || (side === 'B' && liveLtp >= trig)) {
            ord.slTriggered = true;
            stateMutated = true;
          }
        }
        if (ord.slTriggered || !(trig > 0)) {
          if (isSlMarket) {
            matched = true;
            fillPx = liveLtp;
          } else if ((side === 'S' && tickLtp >= lim) || (side === 'B' && tickLtp <= lim)) {
            matched = true;
            fillPx = side === 'S' ? Math.max(lim, liveLtp) : Math.min(lim, liveLtp);
          }
        }
      } else if (ot === 'L' || ot === 'LMT') {
        const lim = Number(ord.price || 0);
        if (side === 'S' && lim > 0 && tickLtp >= lim) {
          matched = true;
          fillPx = Math.max(lim, liveLtp);
        } else if (side === 'B' && lim > 0 && tickLtp <= lim) {
          matched = true;
          fillPx = Math.min(lim, liveLtp);
        }
      }
      if (matched) {
        ord.status = 'COMPLETE';
        ord.filledQuantity = ord.quantity;
        ord.price = Number(fillPx.toFixed(2));
        this._applyExecutionToPosition(ord, fillPx);
        filledAny = true;
        stateMutated = true;
      }
    }
    if (filledAny) {
      this._recalculateFunds();
    }
    if (stateMutated) {
      this._saveState();
    }
    return filledAny;
  }

  _applyExecutionToPosition(ord, execPrice) {
    const sym = String(ord.symbol || '').trim().toUpperCase();
    const product = String(ord.product || 'MIS').toUpperCase();
    const side = String(ord.transactionType || 'B').toUpperCase() === 'S' ? 'S' : 'B';
    const qty = Number(ord.quantity || 0);

    let pos = this.positions.find(
      p => String(p.symbol).toUpperCase() === sym && p.product === product
    );
    if (!pos) {
      const nowParts = getISTTimeParts();
      pos = {
        accountId: this.id,
        broker: 'paper',
        brokerName: this.name,
        symbol: sym,
        exchangeSegment: ord.exchange || 'nse_fo',
        product,
        instrumentToken: ord.instrumentToken || '',
        netQty: 0,
        buyQty: 0,
        sellQty: 0,
        buyAvg: 0,
        sellAvg: 0,
        ltp: execPrice,
        unrealizedPnl: 0,
        realizedPnl: 0,
        totalPnl: 0,
        isOpen: false,
        openedIstDate: ord.openedIstDate || nowParts.dateStr,
        openedIstMinutes: ord.openedIstMinutes !== undefined ? ord.openedIstMinutes : nowParts.minutesOfDay
      };
      this.positions.push(pos);
    }

    const prevNet = Number(pos.netQty || 0);
    if (prevNet === 0) {
      const nowParts = getISTTimeParts();
      pos.openedIstDate = ord.openedIstDate || nowParts.dateStr;
      pos.openedIstMinutes = ord.openedIstMinutes !== undefined ? ord.openedIstMinutes : nowParts.minutesOfDay;
    }
    if (side === 'B') {
      const prevBuyQty = Number(pos.buyQty || 0);
      const totalBuyCost = prevBuyQty * Number(pos.buyAvg || 0) + qty * execPrice;
      pos.buyQty = prevBuyQty + qty;
      pos.buyAvg = Number((totalBuyCost / pos.buyQty).toFixed(2));

      if (prevNet < 0) {
        const closedQty = Math.min(qty, Math.abs(prevNet));
        pos.realizedPnl = Number((Number(pos.realizedPnl || 0) + (pos.sellAvg - execPrice) * closedQty).toFixed(2));
      }
      pos.netQty = prevNet + qty;
    } else {
      const prevSellQty = Number(pos.sellQty || 0);
      const totalSellVal = prevSellQty * Number(pos.sellAvg || 0) + qty * execPrice;
      pos.sellQty = prevSellQty + qty;
      pos.sellAvg = Number((totalSellVal / pos.sellQty).toFixed(2));

      if (prevNet > 0) {
        const closedQty = Math.min(qty, prevNet);
        pos.realizedPnl = Number((Number(pos.realizedPnl || 0) + (execPrice - pos.buyAvg) * closedQty).toFixed(2));
      }
      pos.netQty = prevNet - qty;
    }

    pos.ltp = execPrice;
    pos.isOpen = pos.netQty !== 0;
    pos.unrealizedPnl = pos.isOpen
      ? (pos.netQty > 0
        ? Number(((pos.ltp - pos.buyAvg) * pos.netQty).toFixed(2))
        : Number(((pos.sellAvg - pos.ltp) * Math.abs(pos.netQty)).toFixed(2)))
      : 0;
    pos.totalPnl = Number((pos.unrealizedPnl + Number(pos.realizedPnl || 0)).toFixed(2));
  }

  async placeOrder(order = {}) {
    const tradeTime = order.openedAt ? new Date(order.openedAt) : new Date();
    if (this.enforceMarketHours && !order.isAutoMisSquareOff && !this.isMarketHoursOpen(tradeTime)) {
      throw new Error('Paper account can only trade during market hours (Mon–Fri, 09:15 AM – 03:30 PM IST).');
    }

    const qty = Math.max(0, Math.round(Number(order.quantity || 0)));
    if (!(qty > 0)) {
      throw new Error('Paper order quantity must be greater than 0');
    }

    const sym = String(order.tradingSymbol || order.symbol || '').trim().toUpperCase();
    const side = String(order.transactionType || 'B').toUpperCase() === 'S' ? 'S' : 'B';
    const ot = String(order.orderType || 'MKT').toUpperCase();
    const product = String(order.product || 'MIS').toUpperCase();
    const trig = Number(order.triggerPrice || 0);
    const lim = Number(order.price || 0);
    const tokKey = order.instrumentToken ? String(order.instrumentToken).trim() : '';
    const curPos = this.positions.find(p => String(p.symbol).toUpperCase() === sym && p.product === product);
    const feedLtp = this._lastFeedPrices.get(sym) || (tokKey ? this._lastTokenPrices.get(tokKey) : 0) || 0;
    const refLtp = Number(feedLtp > 0 ? feedLtp : (order.ltp || (curPos && curPos.ltp) || 0));
    const tickRefLtp = this._roundTick(refLtp);

    const isSlType = ot === 'SL' || ot === 'SL-LMT' || ot === 'SL-M' || ot === 'SL-MKT';
    const isLimitType = ot === 'L' || ot === 'LMT';

    let keepPending = false;
    let slTriggeredNow = false;
    let execPrice = lim > 0 ? lim : (refLtp > 0 ? refLtp : (trig > 0 ? trig : 120));

    if (isSlType) {
      const hasTrigger = trig > 0;
      const trigCrossed = refLtp > 0 && hasTrigger && (side === 'S' ? refLtp <= trig : refLtp >= trig);
      const isSlMarket = ot === 'SL-M' || ot === 'SL-MKT' || !(lim > 0);
      const limitMatches = isSlMarket || (refLtp > 0 && (side === 'S' ? tickRefLtp >= lim : tickRefLtp <= lim));
      if (!trigCrossed || !limitMatches) {
        keepPending = true;
        slTriggeredNow = trigCrossed;
      } else {
        execPrice = isSlMarket
          ? refLtp
          : (side === 'S' ? Math.max(lim, refLtp) : Math.min(lim, refLtp));
      }
    } else if (isLimitType) {
      if (lim > 0) {
        const limitMatched = refLtp > 0 && (side === 'S' ? tickRefLtp >= lim : tickRefLtp <= lim);
        if (!limitMatched) {
          keepPending = true;
          execPrice = lim;
        } else {
          execPrice = side === 'S' ? Math.max(lim, refLtp) : Math.min(lim, refLtp);
        }
      } else if (!(refLtp > 0)) {
        keepPending = true;
      }
    }

    const openedParts = getISTTimeParts(order.openedAt ? new Date(order.openedAt) : new Date());
    const orderId = `PAPER-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const newOrder = {
      orderId,
      accountId: this.id,
      broker: 'paper',
      brokerName: this.name,
      symbol: sym,
      exchange: (order.exchangeSegment || 'NFO').toUpperCase(),
      product,
      transactionType: side,
      orderType: ot,
      quantity: qty,
      filledQuantity: keepPending ? 0 : qty,
      price: Number(execPrice.toFixed(2)),
      triggerPrice: Number(trig.toFixed(2)),
      slTriggered: slTriggeredNow,
      instrumentToken: order.instrumentToken || '',
      status: keepPending ? 'OPEN' : 'COMPLETE',
      orderTime: new Date().toLocaleTimeString(),
      openedIstDate: openedParts.dateStr,
      openedIstMinutes: openedParts.minutesOfDay
    };
    this.orders.unshift(newOrder);

    if (!keepPending) {
      this._applyExecutionToPosition(newOrder, execPrice);
    }

    this._recalculateFunds();
    this._syncCache();
    this._saveState();

    return {
      success: true,
      orderId,
      status: newOrder.status,
      message: `[PAPER ${newOrder.status}] ${side === 'B' ? 'BUY' : 'SELL'} ${sym} x ${qty} @ ₹${execPrice.toFixed(2)}`
    };
  }

  async modifyOrder(order = {}) {
    const ord = this.orders.find(o => o.orderId === order.orderId);
    if (!ord) throw new Error(`Paper order ${order.orderId} not found`);
    if (ord.status !== 'OPEN') throw new Error(`Paper order ${order.orderId} is ${ord.status}`);
    if (order.quantity !== undefined) ord.quantity = Math.max(1, Math.round(Number(order.quantity)));
    if (order.price !== undefined) ord.price = Number(Number(order.price).toFixed(2));
    if (order.triggerPrice !== undefined) ord.triggerPrice = Number(Number(order.triggerPrice).toFixed(2));
    if (order.orderType) ord.orderType = String(order.orderType).toUpperCase();
    this._syncCache();
    this._saveState();
    return { success: true, orderId: ord.orderId };
  }

  async cancelOrder(orderId) {
    const ord = this.orders.find(o => o.orderId === orderId);
    if (ord) ord.status = 'CANCELLED';
    this._syncCache();
    this._saveState();
    return { success: true, orderId };
  }

  reset(newBalance = null) {
    if (newBalance !== null && Number(newBalance) >= 1000) {
      this.initialBalance = Number(newBalance);
    }
    this.carriedBalance = this.initialBalance;
    this.lastTradingDate = getISTDateStr();
    this.lastMisSquareOffDate = '';
    this.positions = [];
    this.orders = [];
    this._recalculateFunds();
    this._syncCache();
    this._saveState();
    return { success: true, funds: { ...this.funds } };
  }

  deleteStateFile() {
    try {
      if (this.stateFile && fs.existsSync(this.stateFile)) {
        fs.unlinkSync(this.stateFile);
      }
    } catch (e) {}
  }

  disconnect() {}
}

module.exports = PaperBroker;
