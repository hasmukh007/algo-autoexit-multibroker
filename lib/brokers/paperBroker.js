const fs = require('fs');
const path = require('path');

/**
 * Paper Trading Broker Adapter (Options-Only Virtual Execution)
 * Runs alongside live brokers even in LIVE mode, persisting virtual capital,
 * open/closed options positions, and order book to local JSON and updating MTM
 * from live NIFTY Option Chain WebSocket quotes.
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
    this.stateFile = accountConfig.stateFile !== undefined
      ? accountConfig.stateFile
      : path.join(__dirname, '..', '..', 'data', `paper-state-${this.id}.json`);

    this.funds = {
      availableCash: this.initialBalance,
      utilizedMargin: 0,
      totalBalance: this.initialBalance
    };
    this.positions = [];
    this.orders = [];
    this._cache = {
      positions: { data: [] },
      holdings: { data: [] },
      funds: { data: { ...this.funds } },
      orders: { data: [] }
    };

    this._loadState();
    this._syncCache();
  }

  _loadState() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (parsed.funds) {
          this.funds = {
            availableCash: Number(parsed.funds.availableCash ?? this.initialBalance),
            utilizedMargin: Number(parsed.funds.utilizedMargin || 0),
            totalBalance: Number(parsed.funds.totalBalance ?? this.initialBalance)
          };
        }
        if (Array.isArray(parsed.positions)) this.positions = parsed.positions;
        if (Array.isArray(parsed.orders)) this.orders = parsed.orders;
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
          funds: this.funds,
          positions: this.positions,
          orders: this.orders,
          updatedAt: new Date().toISOString()
        }, null, 2),
        'utf8'
      );
    } catch (e) {}
  }

  _recalculateFunds() {
    let utilized = 0;
    let realized = 0;
    for (const p of this.positions) {
      realized += Number(p.realizedPnl || 0);
      if (Number(p.netQty || 0) > 0) {
        utilized += Number(p.netQty) * Number(p.buyAvg || 0);
      } else if (Number(p.netQty || 0) < 0) {
        utilized += Math.abs(Number(p.netQty)) * Number(p.sellAvg || 0);
      }
    }
    const equity = Number((this.initialBalance + realized).toFixed(2));
    this.funds.utilizedMargin = Number(utilized.toFixed(2));
    this.funds.availableCash = Number(Math.max(0, equity - utilized).toFixed(2));
    this.funds.totalBalance = equity;
  }

  _syncCache() {
    this._cache.positions.data = this.positions.map(p => ({ ...p }));
    this._cache.holdings.data = [];
    this._cache.funds.data = { ...this.funds };
    this._cache.orders.data = this.orders.map(o => ({ ...o }));
  }

  async login() {
    this.isAuthenticated = true;
    this.lastLoginTime = new Date().toISOString();
    this.lastError = null;
    return {
      success: true,
      message: `Paper Trading ready (Balance ₹${this.funds.availableCash.toLocaleString('en-IN')})`
    };
  }

  async getFunds() {
    this._recalculateFunds();
    this._syncCache();
    return { ...this.funds };
  }

  async getPositions() {
    this._syncCache();
    return this.positions.map(p => ({ ...p }));
  }

  async getHoldings() {
    return [];
  }

  async getOrderBook() {
    this._syncCache();
    return this.orders.map(o => ({ ...o }));
  }

  /**
   * Update paper option positions' live LTP & MTM from incoming NIFTY option chain ticks.
   */
  syncWithNiftySnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.strikes) || this.positions.length === 0) return;
    const priceBySym = new Map();
    for (const row of snapshot.strikes) {
      for (const leg of [row.ce, row.pe]) {
        if (leg && leg.symbol && Number(leg.ltp) > 0) {
          priceBySym.set(String(leg.symbol).trim().toUpperCase(), Number(leg.ltp));
        }
      }
    }
    let changed = false;
    for (const pos of this.positions) {
      if (!pos.isOpen || pos.netQty === 0) continue;
      const liveLtp = priceBySym.get(String(pos.symbol || '').trim().toUpperCase());
      if (liveLtp > 0 && liveLtp !== pos.ltp) {
        pos.ltp = liveLtp;
        pos.unrealizedPnl = pos.netQty > 0
          ? Number(((liveLtp - pos.buyAvg) * pos.netQty).toFixed(2))
          : Number(((pos.sellAvg - liveLtp) * Math.abs(pos.netQty)).toFixed(2));
        pos.totalPnl = Number((pos.unrealizedPnl + Number(pos.realizedPnl || 0)).toFixed(2));
        changed = true;
      }
    }
    if (changed) {
      this._checkPendingOrdersOnSnapshot(priceBySym);
      this._syncCache();
    } else if (this.orders.some(o => o.status === 'OPEN')) {
      if (this._checkPendingOrdersOnSnapshot(priceBySym)) {
        this._syncCache();
      }
    }
  }

  _checkPendingOrdersOnSnapshot(priceBySym) {
    let filledAny = false;
    for (const ord of this.orders) {
      if (ord.status !== 'OPEN') continue;
      const liveLtp = priceBySym.get(String(ord.symbol || '').trim().toUpperCase());
      if (!(liveLtp > 0)) continue;
      const ot = String(ord.orderType || '').toUpperCase();
      const side = String(ord.transactionType || 'B').toUpperCase();
      let triggered = false;
      let fillPx = liveLtp;
      if (ot === 'SL' || ot === 'SL-LMT' || ot === 'SL-M' || ot === 'SL-MKT') {
        const trig = Number(ord.triggerPrice || 0);
        if (side === 'S' && trig > 0 && liveLtp <= trig) {
          triggered = true;
          fillPx = Number(ord.price) > 0 ? Math.max(liveLtp, Number(ord.price)) : liveLtp;
        } else if (side === 'B' && trig > 0 && liveLtp >= trig) {
          triggered = true;
          fillPx = Number(ord.price) > 0 ? Math.min(liveLtp, Number(ord.price)) : liveLtp;
        }
      } else if (ot === 'L' || ot === 'LMT') {
        const lim = Number(ord.price || 0);
        if (side === 'S' && lim > 0 && liveLtp >= lim) {
          triggered = true;
          fillPx = lim;
        } else if (side === 'B' && lim > 0 && liveLtp <= lim) {
          triggered = true;
          fillPx = lim;
        }
      }
      if (triggered) {
        ord.status = 'COMPLETE';
        ord.filledQuantity = ord.quantity;
        ord.price = Number(fillPx.toFixed(2));
        this._applyExecutionToPosition(ord, fillPx);
        filledAny = true;
      }
    }
    if (filledAny) {
      this._recalculateFunds();
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
        isOpen: false
      };
      this.positions.push(pos);
    }

    const prevNet = Number(pos.netQty || 0);
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
    const curPos = this.positions.find(p => String(p.symbol).toUpperCase() === sym && p.product === product);
    const refLtp = Number(order.ltp || (curPos && curPos.ltp) || 0);

    const isSlType = ot === 'SL' || ot === 'SL-LMT' || ot === 'SL-M' || ot === 'SL-MKT';
    const keepPendingSl = isSlType && trig > 0 && (
      !(refLtp > 0) ||
      (side === 'S' && refLtp > trig) ||
      (side === 'B' && refLtp < trig)
    );

    const execPrice = lim > 0
      ? lim
      : (refLtp > 0 ? refLtp : (trig > 0 ? trig : 120));

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
      filledQuantity: keepPendingSl ? 0 : qty,
      price: Number(execPrice.toFixed(2)),
      triggerPrice: Number(trig.toFixed(2)),
      instrumentToken: order.instrumentToken || '',
      status: keepPendingSl ? 'OPEN' : 'COMPLETE',
      orderTime: new Date().toLocaleTimeString()
    };
    this.orders.unshift(newOrder);

    if (!keepPendingSl) {
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
