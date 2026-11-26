const KotakNeoClient = require('../kotakNeoClient');
const { KotakNeoWsClient } = require('../kotakNeoWsClient');

/**
 * Kotak Neo Broker Adapter
 * - Fetches net positions, holdings, funds, and orders ONCE after login and thereafter ONLY on order/trade execution (or force refresh).
 * - Streams live LTP, P&L, and NIFTY / Option Chain quotes via KotakNeoWsClient (no REST quote polling).
 */
class KotakNeoBroker {
  constructor(accountConfig = {}) {
    this.id = accountConfig.id || 'kotak_' + Date.now();
    this.broker = 'kotakneo';
    this.name = accountConfig.name || 'Kotak Neo';
    this.isMock = Boolean(accountConfig.isMock);
    this.lastError = null;

    this.client = new KotakNeoClient({
      baseUrl: accountConfig.baseUrl || 'https://mis.kotaksecurities.com',
      consumerKey: accountConfig.consumerKey || '',
      mobileNumber: accountConfig.mobileNumber || '',
      ucc: accountConfig.ucc || '',
      mpin: accountConfig.mpin || '',
      totpSecret: accountConfig.totpSecret || ''
    });

    this._positionsLoadedOnce = false;
    this._holdingsLoadedOnce = false;
    this._fundsLoadedOnce = false;
    this._ordersLoadedOnce = false;
    this._tradeRefreshTimer = null;
    this._errorCooldownMs = typeof accountConfig.errorCooldownMs === 'number' ? accountConfig.errorCooldownMs : 30000;
    this._bridgeErrorCooldownMs = typeof accountConfig.bridgeErrorCooldownMs === 'number' ? accountConfig.bridgeErrorCooldownMs : 60000;

    this._cache = {
      positions: { data: [], inflight: null, retryAfter: 0, lastErrLogAt: 0, lastErrMsg: '' },
      holdings: { data: [], inflight: null, retryAfter: 0, lastErrLogAt: 0, lastErrMsg: '' },
      funds: { data: { availableCash: 0, utilizedMargin: 0, totalBalance: 0 }, inflight: null, retryAfter: 0, lastErrLogAt: 0, lastErrMsg: '' },
      orders: { data: [], inflight: null, retryAfter: 0, lastErrLogAt: 0, lastErrMsg: '' },
      scripMaster: { contracts: null, at: 0, inflight: null }
    };

    this.wsClient = new KotakNeoWsClient({
      ucc: this.client.ucc,
      WebSocketImpl: accountConfig.WebSocketImpl
    });

    this.wsClient.on('order_update', () => {
      this.scheduleTradeRefresh();
    });
  }

  get isAuthenticated() {
    return this.isMock ? true : this.client.isAuthenticated;
  }

  _startWebSockets() {
    if (this.isMock || !this.client.isAuthenticated || !this.client.sessionToken || !this.client.sid) return;
    this.wsClient.updateCredentials({
      sessionToken: this.client.sessionToken,
      sid: this.client.sid,
      ucc: this.client.ucc,
      activeBaseUrl: this.client.activeBaseUrl
    });
    this.wsClient.connect();
    // Subscribe NIFTY 50 Spot index feed on Kotak WebSocket
    this.wsClient.subscribe(['nse_cm|Nifty 50'], true);
    this._subscribeHoldingAndPositionTokens();
  }

  _subscribeHoldingAndPositionTokens() {
    if (!this.wsClient) return;
    const scrips = [];
    for (const pos of this._cache.positions.data) {
      if (pos.instrumentToken) {
        const seg = (pos.exchangeSegment || 'nse_cm').toLowerCase();
        scrips.push(`${seg}|${pos.instrumentToken}`);
      }
    }
    for (const h of this._cache.holdings.data) {
      if (h.instrumentToken) {
        scrips.push(`nse_cm|${h.instrumentToken}`);
      }
    }
    if (scrips.length > 0) {
      this.wsClient.subscribe(scrips, false);
    }
  }

  _applyWsTicksToPositions(positions = []) {
    return positions.map(pos => {
      const seg = (pos.exchangeSegment || 'nse_cm').toLowerCase();
      const tick = (pos.instrumentToken && (this.wsClient.getTick(`${seg}|${pos.instrumentToken}`) || this.wsClient.getTick(pos.instrumentToken))) ||
        this.wsClient.getTick(pos.symbol);
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
      const tick = (h.instrumentToken && (this.wsClient.getTick(`nse_cm|${h.instrumentToken}`) || this.wsClient.getTick(h.instrumentToken))) ||
        this.wsClient.getTick(h.symbol);
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

  _clearCacheError(entry) {
    if (!entry) return;
    entry.retryAfter = 0;
    entry.lastErrLogAt = 0;
    entry.lastErrMsg = '';
  }

  _recordCacheError(entry, label, err) {
    const now = Date.now();
    const isBridge = Boolean(err && err.isBridgeError);
    const cooldown = isBridge ? this._bridgeErrorCooldownMs : this._errorCooldownMs;
    if (entry) {
      entry.retryAfter = now + cooldown;
    }
    const msg = (err && err.message) || 'Unknown error';
    if (!entry || entry.lastErrMsg !== msg || (now - entry.lastErrLogAt) >= 60000) {
      if (entry) {
        entry.lastErrMsg = msg;
        entry.lastErrLogAt = now;
      }
      if (isBridge) {
        console.warn(`[KotakNeo] ${label}: ${msg} (Kotak RMS bridge unavailable; retrying after ${Math.round(cooldown / 1000)}s)`);
      } else {
        console.warn(`[KotakNeo] ${label}: ${msg}`);
      }
    }
  }

  async login(totpOverride = null) {
    if (this.isMock) {
      this.lastError = null;
      return { success: true, message: 'Kotak Neo (Mock) connected' };
    }
    try {
      const res = await this.client.fullLogin({ totp: totpOverride });
      this.lastError = null;
      this._positionsLoadedOnce = false;
      this._holdingsLoadedOnce = false;
      this._fundsLoadedOnce = false;
      this._ordersLoadedOnce = false;
      this._clearCacheError(this._cache.positions);
      this._clearCacheError(this._cache.holdings);
      this._clearCacheError(this._cache.funds);
      this._clearCacheError(this._cache.orders);

      this._startWebSockets();
      // Pull initial positions, holdings, and funds once right after login
      this.getPositions({ force: true }).catch(() => {});
      this.getHoldings({ force: true }).catch(() => {});
      this.getFunds({ force: true }).catch(() => {});
      return res;
    } catch (err) {
      this.lastError = err.message;
      throw err;
    }
  }

  async getFunds(options = {}) {
    if (this.isMock) {
      return { availableCash: 250000, utilizedMargin: 45000, totalBalance: 295000 };
    }
    if (!this.isAuthenticated) {
      return { availableCash: 0, utilizedMargin: 0, totalBalance: 0 };
    }

    const entry = this._cache.funds;
    const force = Boolean(options && options.force);
    if (!force && this._fundsLoadedOnce) return entry.data;
    if (!force && Date.now() < entry.retryAfter) return entry.data;
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const limits = await this.client.getLimits();
        const cash = Number(limits.availableCash || 0);
        const used = Number(limits.utilizedMargin || 0);
        entry.data = {
          availableCash: cash,
          utilizedMargin: used,
          totalBalance: cash + used,
          raw: limits
        };
        this._fundsLoadedOnce = true;
        this._clearCacheError(entry);
        return entry.data;
      } catch (err) {
        this._recordCacheError(entry, 'Error fetching funds', err);
        return entry.data;
      } finally {
        entry.inflight = null;
      }
    })();

    return entry.inflight;
  }

  async getPositions(options = {}) {
    if (this.isMock || !this.isAuthenticated) return [];

    const entry = this._cache.positions;
    const force = Boolean(options && options.force);
    if (!force && this._positionsLoadedOnce) {
      return this._applyWsTicksToPositions(entry.data);
    }
    if (!force && Date.now() < entry.retryAfter) {
      return this._applyWsTicksToPositions(entry.data);
    }
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const list = await this.client.getPositions();
        entry.data = list.map(pos => ({
          ...pos,
          accountId: this.id,
          broker: 'kotakneo',
          brokerName: this.name
        }));
        this._positionsLoadedOnce = true;
        this._clearCacheError(entry);
        this._subscribeHoldingAndPositionTokens();
        return this._applyWsTicksToPositions(entry.data);
      } catch (err) {
        this._recordCacheError(entry, 'Error fetching positions', err);
        return this._applyWsTicksToPositions(entry.data);
      } finally {
        entry.inflight = null;
      }
    })();

    return entry.inflight;
  }

  async getHoldings(options = {}) {
    if (this.isMock || !this.isAuthenticated) return [];

    const entry = this._cache.holdings;
    const force = Boolean(options && options.force);
    if (!force && this._holdingsLoadedOnce) {
      return this._applyWsTicksToHoldings(entry.data);
    }
    if (!force && Date.now() < entry.retryAfter) {
      return this._applyWsTicksToHoldings(entry.data);
    }
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const list = await this.client.getHoldings();
        entry.data = list.map(h => ({
          ...h,
          accountId: this.id,
          broker: 'kotakneo',
          brokerName: this.name
        }));
        this._holdingsLoadedOnce = true;
        this._clearCacheError(entry);
        this._subscribeHoldingAndPositionTokens();
        return this._applyWsTicksToHoldings(entry.data);
      } catch (err) {
        this._recordCacheError(entry, 'Error fetching holdings', err);
        return this._applyWsTicksToHoldings(entry.data);
      } finally {
        entry.inflight = null;
      }
    })();

    return entry.inflight;
  }

  async placeOrder(order = {}) {
    if (this.isMock) {
      return { success: true, orderId: 'KOTAK-MOCK-' + Date.now() };
    }
    const res = await this.client.placeOrder(order);
    this.scheduleTradeRefresh(300);
    return res;
  }

  async cancelOrder(orderId) {
    if (this.isMock) return { success: true, orderId };
    const res = await this.client.cancelOrder(orderId);
    this.scheduleTradeRefresh(300);
    return res;
  }

  /**
   * Real-time NIFTY Spot strictly from Kotak Neo WebSocket (no REST quote polling)
   */
  async getIndexQuote(symbol = 'NIFTY') {
    if (this.isMock || !this.isAuthenticated) return null;
    const scrip = symbol === 'NIFTY' ? 'nse_cm|Nifty 50' : 'nse_cm|Nifty Bank';
    const altKey = symbol === 'NIFTY' ? 'Nifty 50' : 'Nifty Bank';
    this.wsClient.subscribe([scrip], true);

    const tick = this.wsClient.getTick(scrip) || this.wsClient.getTick(altKey);
    if (!tick || !(tick.ltp > 0)) return null;
    return {
      ltp: tick.ltp,
      open: tick.open || 0,
      high: tick.high || tick.ltp,
      low: tick.low || tick.ltp,
      prevClose: tick.close || 0
    };
  }

  /**
   * Real-time NIFTY Option Chain strictly from Kotak Neo WebSocket (no REST quote polling)
   */
  async getOptionChain(atmStrike) {
    if (this.isMock || !this.isAuthenticated || !atmStrike) return null;
    const contracts = await this._getNiftyOptionContracts();
    if (!contracts || contracts.length === 0) return null;

    const minStrike = atmStrike - 500;
    const maxStrike = atmStrike + 500;
    const selected = contracts.filter(c => c.strike >= minStrike && c.strike <= maxStrike);
    if (selected.length === 0) return null;

    const scrips = [];
    for (const c of selected) {
      scrips.push(`nse_fo|${c.token}`);
    }
    this.wsClient.subscribe(scrips, false);

    const oc = {};
    let wsCount = 0;
    for (const c of selected) {
      const tick = this.wsClient.getTick(`nse_fo|${c.token}`) || this.wsClient.getTick(c.token);
      if (!tick || !(tick.ltp > 0)) continue;
      wsCount++;
      if (!oc[c.strike]) oc[c.strike] = {};
      oc[c.strike][c.optType] = {
        symbol: c.symbol,
        instrumentToken: c.token,
        lotSize: c.lotSize || 65,
        last_price: tick.ltp,
        previous_close_price: tick.close || 0,
        volume: tick.volume,
        oi: tick.oi,
        top_bid_price: tick.bid,
        top_ask_price: tick.ask
      };
    }

    if (wsCount === 0) return null;
    const spotTick = this.wsClient.getTick('nse_cm|Nifty 50') || this.wsClient.getTick('Nifty 50');
    return {
      spotLtp: spotTick && spotTick.ltp > 0 ? spotTick.ltp : null,
      expiry: selected[0].expiry || null,
      oc
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
        const res = await this.client._request('/script-details/1.0/masterscrip/file-paths', { method: 'GET' });
        const paths = (res && res.data && res.data.filesPaths) || [];
        const nfoCsvUrl = paths.find(p => String(p).toLowerCase().includes('nse_fo'));
        if (!nfoCsvUrl) return cache.contracts || [];

        const csvRes = await fetch(nfoCsvUrl);
        if (!csvRes.ok) return cache.contracts || [];
        const text = await csvRes.text();
        const lines = text.split(/\r?\n/);
        if (lines.length < 2) return cache.contracts || [];

        const headers = lines[0].split(',').map(h => h.trim());
        const idxSym = headers.indexOf('pTrdSymbol');
        const idxTok = headers.indexOf('pSymbol');
        const idxName = headers.indexOf('pSymbolName');
        const idxType = headers.indexOf('pOptionType');
        const idxStrike = headers.indexOf('dStrikePrice;');
        const idxExp = headers.indexOf('lExpiryDate');
        const idxLot = headers.indexOf('lLotSize') !== -1 ? headers.indexOf('lLotSize') : headers.indexOf('iLotSize');

        const parsed = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols.length < 5) continue;
          const name = cols[idxName] ? cols[idxName].trim() : '';
          const opt = cols[idxType] ? cols[idxType].trim() : '';
          if (name !== 'NIFTY' || (opt !== 'CE' && opt !== 'PE')) continue;
          const strikeRaw = Number(cols[idxStrike] || 0);
          const strike = strikeRaw > 100000 ? Math.round(strikeRaw / 100) : Math.round(strikeRaw);
          const lotSize = (idxLot !== -1 && Number(cols[idxLot]) > 0) ? Math.round(Number(cols[idxLot])) : 65;
          parsed.push({
            token: String(cols[idxTok] || '').trim(),
            symbol: String(cols[idxSym] || '').trim(),
            optType: opt.toLowerCase(),
            strike,
            lotSize,
            expiry: cols[idxExp] ? cols[idxExp].trim() : ''
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

  async getOrderBook(options = {}) {
    if (this.isMock || !this.isAuthenticated) return [];

    const entry = this._cache.orders;
    const force = Boolean(options && options.force);
    if (!force && this._ordersLoadedOnce) return entry.data;
    if (!force && Date.now() < entry.retryAfter) return entry.data;
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const list = await this.client.getOrderBook();
        entry.data = list.map(ord => ({
          ...ord,
          accountId: this.id,
          broker: 'kotakneo',
          brokerName: this.name
        }));
        this._ordersLoadedOnce = true;
        this._clearCacheError(entry);
        return entry.data;
      } catch (err) {
        this._recordCacheError(entry, 'Error fetching orders', err);
        return entry.data;
      } finally {
        entry.inflight = null;
      }
    })();

    return entry.inflight;
  }

  /**
   * Fetch last N days of 3-minute NIFTY historical candles via Kotak Neo historical endpoint
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

    try {
      const qs = new URLSearchParams({
        neosymbol: 'nse_cm|Nifty 50',
        interval: '3min',
        from_date: fmtDate(istFrom),
        to_date: fmtDate(istNow)
      });
      const res = await this.client._request(`/market-data/1.0/historical/details?${qs.toString()}`, { method: 'GET' });
      const candles = (res && res.data && Array.isArray(res.data.candles))
        ? res.data.candles
        : (Array.isArray(res && res.candles) ? res.candles : []);

      const parsed = candles
        .map(row => {
          const tsMs = Date.parse(row[0]);
          if (Number.isNaN(tsMs)) return null;
          return {
            time: Math.floor(tsMs / 1000),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5] || 0),
            source: 'rest'
          };
        })
        .filter(Boolean);

      const dates = Array.from(new Set(parsed.map(c => new Date((c.time + 19800) * 1000).toISOString().slice(0, 10)))).sort();
      const keepDates = new Set(dates.slice(-days));
      return parsed.filter(c => keepDates.has(new Date((c.time + 19800) * 1000).toISOString().slice(0, 10)));
    } catch (err) {
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

module.exports = KotakNeoBroker;
