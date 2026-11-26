const { DhanWsClient } = require('../dhanWsClient');

/**
 * DhanHQ Trading API Client (Node.js)
 * - Fetches net positions, holdings, funds, and orders ONCE after login and thereafter ONLY on order/trade execution (or force refresh).
 * - Streams live LTP, P&L, and NIFTY / Option Chain quotes via DhanWsClient v2 (no REST marketfeed polling).
 */
class DhanBroker {
  constructor(accountConfig = {}) {
    this.id = accountConfig.id || 'dhan_' + Date.now();
    this.broker = 'dhan';
    this.name = accountConfig.name || 'Dhan';
    this.clientId = (accountConfig.clientId || '').trim();
    this.accessToken = (accountConfig.accessToken || '').trim();
    this.isMock = Boolean(accountConfig.isMock);
    this.lastError = null;

    this.baseUrl = 'https://api.dhan.co/v2';
    this.isAuthenticated = Boolean(this.accessToken);
    this.lastLoginTime = this.accessToken ? new Date().toISOString() : null;

    this._positionsLoadedOnce = false;
    this._holdingsLoadedOnce = false;
    this._fundsLoadedOnce = false;
    this._ordersLoadedOnce = false;
    this._tradeRefreshTimer = null;

    this._cache = {
      positions: { data: [], inflight: null },
      holdings: { data: [], inflight: null },
      funds: { data: { availableCash: 0, utilizedMargin: 0, totalBalance: 0 }, inflight: null },
      orders: { data: [], inflight: null },
      scripMaster: { contracts: null, at: 0, inflight: null }
    };

    this.wsClient = new DhanWsClient({
      clientId: this.clientId,
      accessToken: this.accessToken,
      WebSocketImpl: accountConfig.WebSocketImpl
    });

    this.wsClient.on('order_update', () => {
      this.scheduleTradeRefresh();
    });

    // If token already configured on startup in live mode, connect WS and pull initial positions/holdings
    if (!this.isMock && this.isAuthenticated && this.clientId && accountConfig.autoConnect !== false) {
      this._startWebSockets();
    }
  }

  _startWebSockets() {
    if (this.isMock || !this.isAuthenticated || !this.accessToken || !this.clientId) return;
    this.wsClient.updateCredentials({
      clientId: this.clientId,
      accessToken: this.accessToken
    });
    this.wsClient.connect();
    // Subscribe NIFTY 50 Spot (IDX_I SecurityId: 13) on Dhan WebSocket v2
    this.wsClient.subscribe(21, [{ ExchangeSegment: 'IDX_I', SecurityId: '13' }]);
    this._subscribeHoldingAndPositionTokens();
  }

  _subscribeHoldingAndPositionTokens() {
    if (!this.wsClient) return;
    const list = [];
    for (const pos of this._cache.positions.data) {
      if (pos.instrumentToken) {
        list.push({
          ExchangeSegment: String(pos.exchangeSegment || 'NSE_EQ').toUpperCase(),
          SecurityId: String(pos.instrumentToken)
        });
      }
    }
    for (const h of this._cache.holdings.data) {
      if (h.instrumentToken) {
        list.push({
          ExchangeSegment: String(h.exchange || 'NSE_EQ').toUpperCase(),
          SecurityId: String(h.instrumentToken)
        });
      }
    }
    if (list.length > 0) {
      this.wsClient.subscribe(15, list);
    }
  }

  _applyWsTicksToPositions(positions = []) {
    return positions.map(pos => {
      const tick = pos.instrumentToken
        ? this.wsClient.getTick(pos.instrumentToken, pos.exchangeSegment)
        : null;
      if (!tick || !(tick.ltp > 0)) return { ...pos };

      const ltp = Number(tick.ltp.toFixed(2));
      let unrealizedPnl = pos.unrealizedPnl;
      if (pos.netQty > 0 && pos.buyAvg > 0) {
        unrealizedPnl = Number(((ltp - pos.buyAvg) * pos.netQty).toFixed(2));
      } else if (pos.netQty < 0 && pos.sellAvg > 0) {
        unrealizedPnl = Number(((pos.sellAvg - ltp) * Math.abs(pos.netQty)).toFixed(2));
      }
      const totalPnl = Number((unrealizedPnl + Number(pos.realizedPnl || 0)).toFixed(2));
      return {
        ...pos,
        ltp,
        unrealizedPnl,
        totalPnl
      };
    });
  }

  _applyWsTicksToHoldings(holdings = []) {
    return holdings.map(h => {
      const tick = h.instrumentToken ? this.wsClient.getTick(h.instrumentToken, h.exchange) : null;
      if (!tick || !(tick.ltp > 0)) return { ...h };
      const ltp = Number(tick.ltp.toFixed(2));
      const qty = Number(h.quantity || 0);
      const avg = Number(h.averagePrice || 0);
      return {
        ...h,
        ltp,
        currentValue: Number((qty * ltp).toFixed(2)),
        pnl: Number(((ltp - avg) * qty).toFixed(2))
      };
    });
  }

  scheduleTradeRefresh(delayMs = 350) {
    if (this._tradeRefreshTimer) clearTimeout(this._tradeRefreshTimer);
    this._tradeRefreshTimer = setTimeout(() => {
      this._tradeRefreshTimer = null;
      this.refreshAfterTrade().catch(() => {});
    }, delayMs);
  }

  async refreshAfterTrade() {
    if (this.isMock || !this.isAuthenticated) return;
    await this.getPositions({ force: true });
    await this.getHoldings({ force: true });
    await this.getOrderBook({ force: true });
    await this.getFunds({ force: true });
  }

  async _request(endpoint, options = {}) {
    if (this.isMock) {
      throw new Error('Mock broker does not make real network requests');
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'access-token': this.accessToken,
      'client-id': this.clientId,
      ...(options.headers || {})
    };

    const fetchOptions = {
      method: options.method || 'GET',
      headers
    };

    if (options.body) {
      fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);
    const rawText = typeof response.text === 'function' ? await response.text() : '';
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : (typeof response.json === 'function' ? await response.json() : {});
    } catch (e) {
      data = { raw: rawText };
    }

    if (!response.ok) {
      const errMsg = (data && (data.errorMessage || data.message)) || `Dhan API error HTTP ${response.status}`;
      const err = new Error(errMsg);
      err.status = response.status;
      err.data = data;
      this.lastError = errMsg;
      throw err;
    }

    this.lastError = null;
    return data;
  }

  /**
   * Test Connection / Verify Access Token, connect WebSockets, and pull initial positions & holdings
   */
  async login() {
    if (this.isMock) {
      this.isAuthenticated = true;
      this.lastLoginTime = new Date().toISOString();
      return { success: true, message: 'Dhan (Mock) connected' };
    }

    if (!this.accessToken) {
      throw new Error('Dhan requires a valid Access Token.');
    }

    await this.getFunds({ force: true });
    this.isAuthenticated = true;
    this.lastLoginTime = new Date().toISOString();
    this._positionsLoadedOnce = false;
    this._holdingsLoadedOnce = false;
    this._ordersLoadedOnce = false;

    this._startWebSockets();
    this.getPositions({ force: true }).catch(() => {});
    this.getHoldings({ force: true }).catch(() => {});

    return { success: true, message: 'DhanHQ authenticated successfully' };
  }

  /**
   * Fetch Available Funds & Margin Limits (once on login, thereafter on trade/force refresh)
   */
  async getFunds(options = {}) {
    if (this.isMock) return { availableCash: 310000, utilizedMargin: 52000, totalBalance: 362000 };
    if (!this.isAuthenticated) return { availableCash: 0, utilizedMargin: 0, totalBalance: 0 };

    const entry = this._cache.funds;
    const force = Boolean(options && options.force);
    if (!force && this._fundsLoadedOnce) return entry.data;
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const res = await this._request('/fundlimit', { method: 'GET' });
        const d = res.data || res || {};
        const availableCash = Number(d.availMargin || d.cash || 0);
        const utilizedMargin = Number(d.utilizedAmount || d.marginUsed || 0);
        entry.data = {
          availableCash,
          utilizedMargin,
          totalBalance: availableCash + utilizedMargin,
          raw: d
        };
        this._fundsLoadedOnce = true;
        return entry.data;
      } catch (err) {
        console.warn(`[Dhan] Error fetching funds: ${err.message}`);
        return entry.data;
      } finally {
        entry.inflight = null;
      }
    })();

    return entry.inflight;
  }

  /**
   * Fetch Net Positions (REST only on login, order/trade execution, or force refresh; live LTP via WebSocket)
   */
  async getPositions(options = {}) {
    if (this.isMock || !this.isAuthenticated) return [];

    const entry = this._cache.positions;
    const force = Boolean(options && options.force);
    if (!force && this._positionsLoadedOnce) {
      return this._applyWsTicksToPositions(entry.data);
    }
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const res = await this._request('/positions', { method: 'GET' });
        const raw = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);

        entry.data = raw.map(pos => {
          const netQty = Number(pos.netQty || 0);
          const buyAvg = Number(pos.buyAvg || pos.buyPrice || 0);
          const sellAvg = Number(pos.sellAvg || pos.sellPrice || 0);
          const ltp = Number(pos.ltp || pos.lastTradedPrice || (netQty > 0 ? buyAvg : sellAvg));
          const unrealizedPnl = Number(pos.unrealizedProfit || 0);
          const realizedPnl = Number(pos.realizedProfit || 0);
          const totalPnl = Number(pos.rPnl || pos.costPrice || (unrealizedPnl + realizedPnl));

          return {
            accountId: this.id,
            broker: 'dhan',
            brokerName: this.name,
            symbol: pos.tradingSymbol || pos.customSymbol,
            exchangeSegment: (pos.exchangeSegment || 'NSE_EQ').toLowerCase(),
            product: pos.productType || 'INTRADAY',
            instrumentToken: pos.securityId,
            netQty,
            buyQty: Number(pos.buyQty || 0),
            sellQty: Number(pos.sellQty || 0),
            buyAvg: Number(buyAvg.toFixed(2)),
            sellAvg: Number(sellAvg.toFixed(2)),
            ltp: Number(ltp.toFixed(2)),
            unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
            realizedPnl: Number(realizedPnl.toFixed(2)),
            totalPnl: Number(totalPnl.toFixed(2)),
            isOpen: netQty !== 0
          };
        });
        this._positionsLoadedOnce = true;
        this._subscribeHoldingAndPositionTokens();
        return this._applyWsTicksToPositions(entry.data);
      } catch (err) {
        console.warn(`[Dhan] Error fetching positions: ${err.message}`);
        return this._applyWsTicksToPositions(entry.data);
      } finally {
        entry.inflight = null;
      }
    })();

    return entry.inflight;
  }

  /**
   * Fetch Demat Holdings (REST only on login, order/trade execution, or force refresh; live LTP via WebSocket)
   */
  async getHoldings(options = {}) {
    if (this.isMock || !this.isAuthenticated) return [];

    const entry = this._cache.holdings;
    const force = Boolean(options && options.force);
    if (!force && this._holdingsLoadedOnce) {
      return this._applyWsTicksToHoldings(entry.data);
    }
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const res = await this._request('/holdings', { method: 'GET' });
        const raw = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);
        entry.data = raw.map(h => {
          const qty = Number(h.totalQty || h.dpQty || 0);
          const avg = Number(h.avgCostPrice || 0);
          const ltp = Number(h.lastTradedPrice || avg);
          return {
            accountId: this.id,
            broker: 'dhan',
            brokerName: this.name,
            symbol: h.tradingSymbol,
            exchange: h.exchange || 'NSE_EQ',
            instrumentToken: h.securityId,
            quantity: qty,
            collateralQty: Number(h.collateralQty || 0),
            averagePrice: avg,
            ltp,
            currentValue: Number((qty * ltp).toFixed(2)),
            pnl: Number(((ltp - avg) * qty).toFixed(2))
          };
        });
        this._holdingsLoadedOnce = true;
        this._subscribeHoldingAndPositionTokens();
        return this._applyWsTicksToHoldings(entry.data);
      } catch (err) {
        console.warn(`[Dhan] Error fetching holdings: ${err.message}`);
        return this._applyWsTicksToHoldings(entry.data);
      } finally {
        entry.inflight = null;
      }
    })();

    return entry.inflight;
  }

  /**
   * Place Order on Dhan, then refresh positions/holdings/orders
   */
  async placeOrder(order = {}) {
    if (this.isMock) {
      return { success: true, orderId: 'DHAN-MOCK-' + Date.now() };
    }

    const payload = {
      dhanClientId: this.clientId,
      transactionType: order.transactionType === 'B' ? 'BUY' : 'SELL',
      exchangeSegment: (order.exchangeSegment || 'NSE_EQ').toUpperCase(),
      productType: order.product === 'MIS' ? 'INTRADAY' : (order.product === 'CNC' ? 'CNC' : 'MARGIN'),
      orderType: order.orderType === 'MKT' ? 'MARKET' : (order.orderType === 'L' ? 'LIMIT' : order.orderType),
      validity: order.validity || 'DAY',
      tradingSymbol: order.tradingSymbol,
      securityId: String(order.instrumentToken || ''),
      quantity: Number(order.quantity),
      price: Number(order.price || 0),
      triggerPrice: Number(order.triggerPrice || 0)
    };

    const res = await this._request('/orders', {
      method: 'POST',
      body: payload
    });

    this.scheduleTradeRefresh(300);

    return {
      success: true,
      orderId: (res && (res.orderId || res.data && res.data.orderId)) || 'DHAN-' + Date.now(),
      data: res
    };
  }

  /**
   * Cancel Order on Dhan, then refresh order book
   */
  async cancelOrder(orderId) {
    if (this.isMock) return { success: true, orderId };

    const res = await this._request(`/orders/${orderId}`, {
      method: 'DELETE'
    });

    this.scheduleTradeRefresh(300);
    return { success: true, orderId, data: res };
  }

  /**
   * Retrieve live NIFTY spot strictly from DhanHQ WebSocket v2 (no REST marketfeed calls)
   */
  async getIndexQuote(symbol = 'NIFTY') {
    if (this.isMock || !this.isAuthenticated) return null;

    const securityId = symbol === 'NIFTY' ? '13' : '25';
    this.wsClient.subscribe(21, [{ ExchangeSegment: 'IDX_I', SecurityId: securityId }]);

    const tick = this.wsClient.getTick(securityId, 'IDX_I');
    if (!tick || !(tick.ltp > 0)) return null;
    return {
      ltp: tick.ltp,
      open: tick.open || 0,
      high: tick.high || tick.ltp,
      low: tick.low || tick.ltp,
      prevClose: tick.prevClose || tick.close || 0
    };
  }

  async _getNiftyOptionContracts() {
    const cache = this._cache.scripMaster;
    const now = Date.now();
    if (cache.contracts && (now - cache.at < 12 * 3600 * 1000)) {
      return cache.contracts;
    }
    if (cache.inflight) return cache.inflight;

    cache.inflight = (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const res = await fetch('https://images.dhan.co/api-data/api-scrip-master.csv', {
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) return cache.contracts || [];
        const text = await res.text();
        const lines = text.split(/\r?\n/);
        if (lines.length < 2) return cache.contracts || [];

        const headers = lines[0].split(',').map(h => h.trim());
        const idxEx = headers.indexOf('SEM_EXM_EXCH_ID');
        const idxInst = headers.indexOf('SEM_INSTRUMENT_NAME');
        const idxSym = headers.indexOf('SEM_TRADING_SYMBOL');
        const idxId = headers.indexOf('SEM_SMST_SECURITY_ID');
        const idxExp = headers.indexOf('SEM_EXPIRY_DATE');
        const idxStrike = headers.indexOf('SEM_STRIKE_PRICE');
        const idxOpt = headers.indexOf('SEM_OPTION_TYPE');

        const parsed = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols.length < 7) continue;
          if (cols[idxEx] !== 'NSE' || cols[idxInst] !== 'OPTIDX') continue;
          const sym = String(cols[idxSym] || '').trim();
          const opt = String(cols[idxOpt] || '').trim();
          if (!sym.startsWith('NIFTY-') && !sym.startsWith('NIFTY ')) continue;
          if (opt !== 'CE' && opt !== 'PE') continue;
          parsed.push({
            token: String(cols[idxId] || '').trim(),
            symbol: sym,
            expiry: String(cols[idxExp] || '').trim().split(' ')[0],
            strike: Math.round(Number(cols[idxStrike] || 0)),
            optType: opt.toLowerCase()
          });
        }
        cache.contracts = parsed;
        cache.at = Date.now();
        return parsed;
      } catch (e) {
        return cache.contracts || [];
      } finally {
        cache.inflight = null;
      }
    })();

    return cache.inflight;
  }

  /**
   * Retrieve live NIFTY Option Chain strictly from DhanHQ WebSocket v2 (no REST optionchain calls)
   */
  async getOptionChain(atmStrike) {
    if (this.isMock || !this.isAuthenticated || !atmStrike) return null;

    const contracts = await this._getNiftyOptionContracts();
    if (!contracts || contracts.length === 0) return null;

    const todayStr = new Date().toISOString().slice(0, 10);
    const expiries = Array.from(new Set(contracts.map(c => c.expiry)))
      .filter(exp => exp >= todayStr)
      .sort();
    if (expiries.length === 0) return null;
    const nearestExpiry = expiries[0];

    const minStrike = atmStrike - 500;
    const maxStrike = atmStrike + 500;
    const selected = contracts.filter(
      c => c.expiry === nearestExpiry && c.strike >= minStrike && c.strike <= maxStrike
    );
    if (selected.length === 0) return null;

    const instList = selected.map(c => ({ ExchangeSegment: 'NSE_FNO', SecurityId: c.token }));
    this.wsClient.subscribe(21, [{ ExchangeSegment: 'IDX_I', SecurityId: '13' }, ...instList]);

    const oc = {};
    let wsCount = 0;
    for (const c of selected) {
      const tick = this.wsClient.getTick(c.token, 'NSE_FNO');
      if (!tick || !(tick.ltp > 0)) continue;
      wsCount++;
      if (!oc[c.strike]) oc[c.strike] = {};
      oc[c.strike][c.optType] = {
        symbol: c.symbol,
        last_price: tick.ltp,
        previous_close_price: tick.prevClose || tick.close || 0,
        volume: tick.volume,
        oi: tick.oi,
        previous_oi: tick.prevOi,
        top_bid_price: tick.bid,
        top_ask_price: tick.ask
      };
    }

    if (wsCount === 0) return null;
    const spotTick = this.wsClient.getTick('13', 'IDX_I');
    return {
      spotLtp: spotTick && spotTick.ltp > 0 ? spotTick.ltp : null,
      expiry: nearestExpiry,
      oc
    };
  }

  /**
   * Get Order Book (REST only on login, trade execution, or force refresh)
   */
  async getOrderBook(options = {}) {
    if (this.isMock || !this.isAuthenticated) return [];

    const entry = this._cache.orders;
    const force = Boolean(options && options.force);
    if (!force && this._ordersLoadedOnce) return entry.data;
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const res = await this._request('/orders', { method: 'GET' });
        const raw = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);

        entry.data = raw.map(ord => ({
          accountId: this.id,
          broker: 'dhan',
          brokerName: this.name,
          orderId: ord.orderId,
          symbol: ord.tradingSymbol,
          exchange: ord.exchangeSegment,
          product: ord.productType,
          transactionType: ord.transactionType === 'BUY' ? 'B' : 'S',
          orderType: ord.orderType,
          quantity: Number(ord.quantity || 0),
          filledQuantity: Number(ord.filledQty || 0),
          price: Number(ord.price || 0),
          status: (ord.orderStatus || 'PENDING').toUpperCase(),
          orderTime: ord.createTime || new Date().toISOString()
        }));
        this._ordersLoadedOnce = true;
        return entry.data;
      } catch (err) {
        return entry.data;
      } finally {
        entry.inflight = null;
      }
    })();

    return entry.inflight;
  }

  /**
   * Fetch last N days of 1-minute NIFTY historical candles via DhanHQ /charts/intraday
   * (aggregated to 3-minute candles by NiftyCandleManager).
   */
  async getHistoricalCandles({ days = 3 } = {}) {
    if (this.isMock || !this.isAuthenticated) return [];

    const now = new Date();
    const utcNow = now.getTime() + now.getTimezoneOffset() * 60000;
    const istNow = new Date(utcNow + 3600000 * 5.5);
    const lookbackCalendarDays = Math.max(days + 3, 6);
    const istFrom = new Date(istNow.getTime() - lookbackCalendarDays * 86400000);

    const fmtDate = d => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const fmtDateTime = (d, hms = null) => {
      if (hms) return `${fmtDate(d)} ${hms}`;
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${fmtDate(d)} ${hh}:${mm}:${ss}`;
    };

    try {
      const res = await this._request('/charts/intraday', {
        method: 'POST',
        body: {
          securityId: '13',
          exchangeSegment: 'IDX_I',
          instrument: 'INDEX',
          interval: '1',
          oi: false,
          fromDate: fmtDateTime(istFrom, '09:15:00'),
          toDate: fmtDateTime(istNow)
        }
      });

      const d = (res && res.data) || res || {};
      const timestamps = Array.isArray(d.timestamp) ? d.timestamp : (Array.isArray(d.start_Time) ? d.start_Time : []);
      const opens = Array.isArray(d.open) ? d.open : [];
      const highs = Array.isArray(d.high) ? d.high : [];
      const lows = Array.isArray(d.low) ? d.low : [];
      const closes = Array.isArray(d.close) ? d.close : [];
      const volumes = Array.isArray(d.volume) ? d.volume : [];

      const parsed = [];
      for (let i = 0; i < timestamps.length; i++) {
        const tsRaw = Number(timestamps[i]);
        const timeSec = tsRaw > 1e12 ? Math.floor(tsRaw / 1000) : Math.floor(tsRaw);
        if (!Number.isFinite(timeSec) || !(Number(closes[i]) > 0)) continue;
        parsed.push({
          time: timeSec,
          open: Number(opens[i]),
          high: Number(highs[i]),
          low: Number(lows[i]),
          close: Number(closes[i]),
          volume: Number(volumes[i] || 0),
          source: 'rest'
        });
      }

      const dates = Array.from(new Set(parsed.map(c => new Date((c.time + 19800) * 1000).toISOString().slice(0, 10)))).sort();
      const keepDates = new Set(dates.slice(-days));
      return parsed.filter(c => keepDates.has(new Date((c.time + 19800) * 1000).toISOString().slice(0, 10)));
    } catch (err) {
      console.warn(`[Dhan] Error fetching historical candles: ${err.message}`);
      return [];
    }
  }

  disconnect() {
    if (this._tradeRefreshTimer) {
      clearTimeout(this._tradeRefreshTimer);
      this._tradeRefreshTimer = null;
    }
    if (this.wsClient) {
      this.wsClient.disconnect();
    }
  }
}

module.exports = DhanBroker;
