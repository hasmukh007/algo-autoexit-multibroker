const { SahiWsClient, SAHI_MODE } = require('../sahiWsClient');
const totpHelper = require('../totpHelper');

const SAHI_AUTH_URL = 'https://apis.sahi.com';
const SAHI_API_URL = 'https://direct.sahi.com';
const SAHI_SCRIP_MASTER_URL = 'https://assets.sahi.com/external/instruments.csv';
const DEFAULT_NIFTY_INDEX_ID = 10854;

/**
 * Normalize exchange segment names into Sahi Trade API values: NSE | NFO | BSE | BFO
 */
function normalizeSahiSegment(segment) {
  const s = String(segment || '').trim().toUpperCase();
  if (s === 'NFO' || s === 'NSE_FO' || s === 'NSE_FNO' || s === 'NSEFO') return 'NFO';
  if (s === 'BFO' || s === 'BSE_FO' || s === 'BSE_FNO' || s === 'BSEFO') return 'BFO';
  if (s === 'BSE' || s === 'BSE_CM' || s === 'BSE_EQ' || s === 'BSECM') return 'BSE';
  return 'NSE';
}

/**
 * Normalize product codes into Sahi Trade API single-letter enum: C | I | M | F
 */
function normalizeSahiProduct(product, segment) {
  const p = String(product || '').trim().toUpperCase();
  if (p === 'C' || p === 'CNC' || p === 'DELIVERY') return 'C';
  if (p === 'M' || p === 'NRML' || p === 'NORMAL' || p === 'CARRYFORWARD' || p === 'MARGIN') return 'M';
  if (p === 'F' || p === 'MTF') return 'F';
  if (p === 'I' || p === 'MIS' || p === 'INTRADAY') return 'I';
  return (segment === 'NFO' || segment === 'BFO') ? 'M' : 'I';
}

/**
 * Normalize order type into Sahi Trade API enum: LMT | MKT | SL-LMT | SL-MKT
 */
function normalizeSahiOrderType(orderType) {
  const t = String(orderType || '').trim().toUpperCase();
  if (t === 'L' || t === 'LMT' || t === 'LIMIT') return 'LMT';
  if (t === 'SL' || t === 'SL-LMT' || t === 'STOPLOSS_LIMIT') return 'SL-LMT';
  if (t === 'SL-M' || t === 'SLM' || t === 'SL-MKT' || t === 'STOPLOSS_MARKET') return 'SL-MKT';
  return 'MKT';
}

/**
 * Normalize Sahi order statuses to terminal UI statuses
 */
function normalizeSahiOrderStatus(status) {
  const s = String(status || '').trim();
  const low = s.toLowerCase();
  if (low === 'completed') return 'COMPLETE';
  if (low === 'open' || low === 'openpartial' || low === 'awaitingtrigger') return 'OPEN';
  if (low === 'cancelled') return 'CANCELLED';
  if (low === 'rejected') return 'REJECTED';
  if (low === 'partialfilled') return 'PARTIALFILLED';
  return s.toUpperCase() || 'PENDING';
}

/**
 * Parse a single RFC 4180 CSV line (handles quoted fields containing commas)
 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Convert DD-MM-YYYY -> YYYY-MM-DD for consistent chronological sorting
 */
function normalizeSahiExpiryDate(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s;
}

/**
 * Sahi Direct API v1 Broker Adapter (https://docs.sahi.com/)
 * - Auth host: https://apis.sahi.com/api/v1/apikeys/token (Bearer JWT valid until 06:00 IST)
 * - API / Order / WS host: https://direct.sahi.com (/v1/...)
 * - All monetary values (price, amt, pnl, funds) are integer paise in Sahi APIs (converted to/from INR here)
 * - Live LTP, Option Chain, and Order updates strictly via SahiWsClient WebSockets (Protobuf + JSON)
 */
class SahiBroker {
  constructor(accountConfig = {}) {
    this.id = accountConfig.id || 'sahi_' + Date.now();
    this.broker = 'sahi';
    this.name = accountConfig.name || 'Sahi';
    this.keyId = (accountConfig.keyId || accountConfig.apiKey || '').trim();
    this.secret = (accountConfig.secret || accountConfig.apiSecret || '').trim();
    this.totpSecret = (accountConfig.totpSecret || '').trim();
    this.accessToken = (accountConfig.accessToken || '').trim();
    this.expiresAt = accountConfig.expiresAt || null;
    this.userId = accountConfig.userId || null;

    this.authBaseUrl = (accountConfig.authBaseUrl || SAHI_AUTH_URL).replace(/\/+$/, '');
    this.apiBaseUrl = (accountConfig.apiBaseUrl || SAHI_API_URL).replace(/\/+$/, '');
    this.scripMasterUrl = accountConfig.scripMasterUrl || SAHI_SCRIP_MASTER_URL;
    this.isMock = Boolean(accountConfig.isMock);
    this.lastError = null;

    this.isAuthenticated = Boolean(this.accessToken && !this._isTokenExpired());
    this.lastLoginTime = this.isAuthenticated ? new Date().toISOString() : null;

    this._positionsLoadedOnce = false;
    this._holdingsLoadedOnce = false;
    this._fundsLoadedOnce = false;
    this._ordersLoadedOnce = false;
    this._tradeRefreshTimer = null;
    this._errorCooldownMs = typeof accountConfig.errorCooldownMs === 'number' ? accountConfig.errorCooldownMs : 30000;

    this._cache = {
      positions: { data: [], inflight: null, retryAfter: 0, lastErrLogAt: 0, lastErrMsg: '' },
      holdings: { data: [], inflight: null, retryAfter: 0, lastErrLogAt: 0, lastErrMsg: '' },
      funds: { data: { availableCash: 0, utilizedMargin: 0, totalBalance: 0 }, inflight: null, retryAfter: 0, lastErrLogAt: 0, lastErrMsg: '' },
      orders: { data: [], inflight: null, retryAfter: 0, lastErrLogAt: 0, lastErrMsg: '' },
      scripMaster: {
        niftyIndexId: DEFAULT_NIFTY_INDEX_ID,
        contracts: null,
        byIsin: new Map(),
        byId: new Map(),
        at: 0,
        inflight: null
      }
    };

    this.wsClient = new SahiWsClient({
      accessToken: this.accessToken,
      WebSocketImpl: accountConfig.WebSocketImpl
    });

    this.wsClient.on('order_update', () => {
      this.scheduleTradeRefresh();
    });

    this.wsClient.on('auth_closed', () => {
      this.isAuthenticated = false;
      this.lastError = 'Sahi session expired (06:00 IST or revoked). Please re-login.';
    });

    if (!this.isMock && this.isAuthenticated && accountConfig.autoConnect !== false) {
      this._startWebSockets();
    }
  }

  _isTokenExpired() {
    if (!this.expiresAt) return false;
    const expMs = Date.parse(this.expiresAt);
    if (Number.isNaN(expMs)) return false;
    return Date.now() >= (expMs - 60000);
  }

  _clearCacheError(entry) {
    if (!entry) return;
    entry.retryAfter = 0;
    entry.lastErrLogAt = 0;
    entry.lastErrMsg = '';
  }

  _recordCacheError(entry, label, err) {
    const now = Date.now();
    if (entry) entry.retryAfter = now + this._errorCooldownMs;
    const msg = (err && err.message) || 'Unknown error';
    if (!entry || entry.lastErrMsg !== msg || (now - entry.lastErrLogAt) >= 60000) {
      if (entry) {
        entry.lastErrMsg = msg;
        entry.lastErrLogAt = now;
      }
      console.warn(`[Sahi] ${label}: ${msg}`);
    }
  }

  _startWebSockets() {
    if (this.isMock || !this.isAuthenticated || !this.accessToken) return;
    this.wsClient.updateCredentials({ accessToken: this.accessToken });
    this.wsClient.connect();
    const niftyId = (this._cache.scripMaster && this._cache.scripMaster.niftyIndexId) || DEFAULT_NIFTY_INDEX_ID;
    this.wsClient.subscribe(SAHI_MODE.QUOTE, [niftyId]);
    this._subscribeHoldingAndPositionTokens();
  }

  _subscribeHoldingAndPositionTokens() {
    if (!this.wsClient) return;
    const ids = [];
    for (const pos of this._cache.positions.data) {
      if (pos.instrumentToken) ids.push(Number(pos.instrumentToken));
    }
    for (const h of this._cache.holdings.data) {
      if (h.instrumentToken) ids.push(Number(h.instrumentToken));
    }
    if (ids.length > 0) {
      this.wsClient.subscribe(SAHI_MODE.LTP, ids);
    }
  }

  _applyWsTicksToPositions(positions = []) {
    return positions.map(pos => {
      const tick = pos.instrumentToken ? this.wsClient.getTick(pos.instrumentToken) : null;
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
      const tick = h.instrumentToken ? this.wsClient.getTick(h.instrumentToken) : null;
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

    const base = options.baseUrl || this.apiBaseUrl;
    const url = endpoint.startsWith('http') ? endpoint : `${base}${endpoint}`;
    const headers = {
      'Accept': 'application/json',
      ...(options.headers || {})
    };
    if (!options.skipAuth) {
      if (!this.accessToken) throw new Error('Sahi session not authenticated.');
      headers['Authorization'] = this.accessToken.startsWith('Bearer ')
        ? this.accessToken
        : `Bearer ${this.accessToken}`;
    }

    const fetchOptions = {
      method: options.method || 'GET',
      headers
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);
    if (response.status === 204) {
      return { success: true };
    }

    const rawText = typeof response.text === 'function' ? await response.text() : '';
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : (typeof response.json === 'function' ? await response.json() : {});
    } catch (e) {
      data = { raw: rawText };
    }

    if (!response.ok) {
      if (response.status === 401 && !options.skipAuth) {
        this.isAuthenticated = false;
      }
      const errMsg = (data && (data.message || data.error_description || data.error)) ||
        `Sahi API error HTTP ${response.status}`;
      const err = new Error(errMsg);
      err.status = response.status;
      err.code = data && data.code ? data.code : null;
      err.data = data;
      this.lastError = errMsg;
      throw err;
    }

    this.lastError = null;
    return data;
  }

  /**
   * Mint access token via POST https://apis.sahi.com/api/v1/apikeys/token
   * (or verify pre-configured accessToken via GET /v1/profile), connect WS, and pull portfolio.
   */
  async login(totpOverride = null, options = {}) {
    if (this.isMock) {
      this.isAuthenticated = true;
      this.lastLoginTime = new Date().toISOString();
      this.lastError = null;
      return { success: true, message: 'Sahi (Mock) connected' };
    }

    if (this.keyId && this.secret) {
      const payload = {
        key_id: this.keyId,
        secret: this.secret
      };

      let totp = totpOverride ? String(totpOverride).trim() : '';
      if (!totp && this.totpSecret) {
        totp = totpHelper.generateTOTP(this.totpSecret);
      }
      // Sahi rejects Regular keys if a `totp` field is included; only include it when supplied/configured
      if (totp) {
        payload.totp = totp;
      }

      const tokenRes = await this._request('/api/v1/apikeys/token', {
        baseUrl: this.authBaseUrl,
        method: 'POST',
        body: payload,
        skipAuth: true
      });

      if (!tokenRes || !tokenRes.access_token) {
        throw new Error('Sahi authentication did not return an access_token.');
      }
      this.accessToken = String(tokenRes.access_token).trim();
      this.expiresAt = tokenRes.expires_at || null;
    } else if (!this.accessToken) {
      throw new Error('Sahi requires API Key ID & Secret (or an active Access Token).');
    }

    this.isAuthenticated = true;
    this.lastLoginTime = new Date().toISOString();
    this.lastError = null;

    this._positionsLoadedOnce = false;
    this._holdingsLoadedOnce = false;
    this._fundsLoadedOnce = false;
    this._ordersLoadedOnce = false;
    this._clearCacheError(this._cache.positions);
    this._clearCacheError(this._cache.holdings);
    this._clearCacheError(this._cache.funds);
    this._clearCacheError(this._cache.orders);

    // Fetch user profile & scrip master lazily without blocking WS connection
    this._request('/v1/profile', { method: 'GET' })
      .then(profile => {
        if (profile && profile.user_id) this.userId = profile.user_id;
      })
      .catch(() => {});

    this._startWebSockets();
    if (!(options && options.skipPortfolioFetch)) {
      this.getFunds({ force: true }).catch(() => {});
      this.getPositions({ force: true }).catch(() => {});
      this.getHoldings({ force: true }).catch(() => {});
    }

    return {
      success: true,
      message: 'Sahi Direct API authenticated successfully',
      expiresAt: this.expiresAt
    };
  }

  /**
   * Fetch Available Funds & Margin Limits (GET /v1/funds, all values in integer paise)
   */
  async getFunds(options = {}) {
    if (this.isMock) {
      return { availableCash: 280000, utilizedMargin: 42000, totalBalance: 322000 };
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
        const res = await this._request('/v1/funds', { method: 'GET' });
        const avail = res.available || {};
        const bal = res.balance || {};
        const used = res.utilised || {};

        const availablePaise = avail.intraday_and_fno_selling !== undefined
          ? Number(avail.intraday_and_fno_selling || 0)
          : Number(avail.stocks_delivery || 0);

        const utilizedPaise =
          Number(used.span || 0) +
          Number(used.exposure || 0) +
          Number(used.delivery_margin || 0) +
          Number(used.intraday_margin || 0) +
          Number(used.delivery_buy || 0) +
          Number(used.charges || 0) +
          Number(used.mtm_loss || 0);

        const openingPlusFlowsPaise =
          Number(bal.opening_balance || 0) +
          Number(bal.payin || 0) -
          Number(bal.payout || 0) +
          Number(bal.collateral || 0) +
          Number(bal.delivery_sell_credit || 0);

        const availableCash = Number((availablePaise / 100).toFixed(2));
        const utilizedMargin = Number((utilizedPaise / 100).toFixed(2));
        const totalBalance = openingPlusFlowsPaise > 0
          ? Number((openingPlusFlowsPaise / 100).toFixed(2))
          : Number((availableCash + utilizedMargin).toFixed(2));

        entry.data = {
          availableCash,
          utilizedMargin,
          totalBalance,
          raw: res
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

  /**
   * Fetch Net Positions (GET /v1/positions; integer paise -> INR, live LTP via SahiWsClient)
   */
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
        const res = await this._request('/v1/positions', { method: 'GET' });
        const raw = Array.isArray(res.positions) ? res.positions : (Array.isArray(res) ? res : []);

        entry.data = raw.map(pos => {
          const netQty = Number(pos.net_qty || 0);
          const netAvg = Number((Number(pos.net_avg_price || 0) / 100).toFixed(2));
          const buyAvgRaw = Number(pos.open_buy_avg_price || pos.total_buy_avg_price || pos.day_buy_avg_price || pos.buy_avg_price || 0);
          const sellAvgRaw = Number(pos.open_sell_avg_price || pos.total_sell_avg_price || pos.day_sell_avg_price || pos.sell_avg_price || 0);
          const buyAvg = Number(((buyAvgRaw > 0 ? buyAvgRaw / 100 : (netQty > 0 ? netAvg : 0))).toFixed(2));
          const sellAvg = Number(((sellAvgRaw > 0 ? sellAvgRaw / 100 : (netQty < 0 ? netAvg : 0))).toFixed(2));
          const realizedPnl = Number((Number(pos.realised_pnl || 0) / 100).toFixed(2));
          const ltp = netQty > 0 ? (buyAvg || netAvg) : (netQty < 0 ? (sellAvg || netAvg) : netAvg);

          return {
            accountId: this.id,
            broker: 'sahi',
            brokerName: this.name,
            symbol: pos.symbol,
            exchangeSegment: normalizeSahiSegment(pos.exchange_segment),
            product: pos.product || 'I',
            instrumentToken: pos.instrument_id ? String(pos.instrument_id) : '',
            netQty,
            buyQty: Number(pos.total_buy_qty || pos.day_buy_qty || pos.buy_qty || pos.filled_buy_qty || 0),
            sellQty: Number(pos.total_sell_qty || pos.day_sell_qty || pos.sell_qty || pos.filled_sell_qty || 0),
            buyAvg,
            sellAvg,
            ltp: Number(Number(ltp || 0).toFixed(2)),
            unrealizedPnl: 0,
            realizedPnl,
            totalPnl: realizedPnl,
            isOpen: netQty !== 0
          };
        });

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

  /**
   * Fetch Demat Holdings (GET /v1/holdings; integer paise -> INR, live LTP via SahiWsClient)
   */
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
        const res = await this._request('/v1/holdings', { method: 'GET' });
        const raw = Array.isArray(res.holdings) ? res.holdings : (Array.isArray(res) ? res : []);
        const byIsin = this._cache.scripMaster.byIsin;
        const byId = this._cache.scripMaster.byId;

        entry.data = raw.map(h => {
          const ids = Array.isArray(h.instrument_ids) ? h.instrument_ids : [];
          const primaryId = ids.length > 0 ? String(ids[0]) : '';
          const meta = (primaryId && byId.get(Number(primaryId))) || (h.isin && byIsin.get(h.isin)) || null;
          const qty = Number(h.net_qty !== undefined ? h.net_qty : (h.holding_qty || 0));
          const avg = Number((Number(h.holding_avg_price || h.net_avg_price || 0) / 100).toFixed(2));
          const ltp = avg;
          return {
            accountId: this.id,
            broker: 'sahi',
            brokerName: this.name,
            symbol: (meta && meta.symbol) || h.isin || primaryId,
            exchange: (meta && meta.segment) || 'NSE',
            instrumentToken: primaryId,
            quantity: qty,
            collateralQty: Number(h.authorised_qty || 0),
            averagePrice: avg,
            ltp,
            currentValue: Number((qty * ltp).toFixed(2)),
            pnl: Number(((ltp - avg) * qty).toFixed(2))
          };
        });

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

  /**
   * Place Order via POST /v1/orders (price & trigger_price converted to integer paise)
   */
  async placeOrder(order = {}) {
    if (this.isMock) {
      return { success: true, orderId: 'SAHI-MOCK-' + Date.now() };
    }

    const segment = normalizeSahiSegment(order.exchangeSegment || 'NSE');
    const orderType = normalizeSahiOrderType(order.orderType || 'MKT');
    const product = normalizeSahiProduct(order.product, segment);
    const pricePaise = (orderType === 'MKT' || orderType === 'SL-MKT')
      ? 0
      : Math.round(Number(order.price || 0) * 100);

    const payload = {
      exchange_segment: segment,
      symbol: String(order.tradingSymbol || order.symbol || '').trim(),
      txn_type: String(order.transactionType || 'B').toUpperCase() === 'S' ? 'S' : 'B',
      qty: Math.round(Number(order.quantity || 0)),
      order_type: orderType,
      product,
      validity: String(order.validity || 'DAY').toUpperCase() === 'IOC' ? 'IOC' : 'DAY',
      price: pricePaise,
      variant: order.amo ? 'AMO' : 'REGULAR'
    };

    if (orderType === 'SL-LMT' || orderType === 'SL-MKT') {
      payload.trigger_price = Math.round(Number(order.triggerPrice || 0) * 100);
    }
    if (orderType === 'MKT' || orderType === 'SL-MKT') {
      payload.market_protection = typeof order.marketProtection === 'number' ? order.marketProtection : -1;
    }

    const res = await this._request('/v1/orders', {
      method: 'POST',
      body: payload
    });

    this.scheduleTradeRefresh(300);

    const orderIds = Array.isArray(res && res.order_ids) ? res.order_ids : [];
    return {
      success: true,
      orderId: orderIds[0] || (res && res.order_id) || 'SAHI-' + Date.now(),
      orderIds,
      data: res
    };
  }

  /**
   * Cancel Order via DELETE /v1/orders/{order_id}
   */
  async cancelOrder(orderId) {
    if (this.isMock) return { success: true, orderId };

    const res = await this._request(`/v1/orders/${encodeURIComponent(String(orderId))}`, {
      method: 'DELETE'
    });

    this.scheduleTradeRefresh(300);
    return { success: true, orderId, data: res };
  }

  /**
   * Get Today's Order Book via GET /v1/orders
   */
  async getOrderBook(options = {}) {
    if (this.isMock || !this.isAuthenticated) return [];

    const entry = this._cache.orders;
    const force = Boolean(options && options.force);
    if (!force && this._ordersLoadedOnce) return entry.data;
    if (!force && Date.now() < entry.retryAfter) return entry.data;
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const res = await this._request('/v1/orders', { method: 'GET' });
        const raw = Array.isArray(res.orders) ? res.orders : (Array.isArray(res) ? res : []);

        entry.data = raw.map(ord => {
          const pricePaise = Number(ord.avg_price || ord.price || 0);
          return {
            accountId: this.id,
            broker: 'sahi',
            brokerName: this.name,
            orderId: String(ord.order_id || ''),
            symbol: ord.symbol,
            exchange: ord.exchange_segment || 'NSE',
            product: ord.product || 'I',
            transactionType: ord.txn_type === 'S' ? 'S' : 'B',
            orderType: ord.order_type || 'MKT',
            quantity: Number(ord.qty || 0),
            filledQuantity: Number(ord.filled_qty || 0),
            price: Number((pricePaise / 100).toFixed(2)),
            status: normalizeSahiOrderStatus(ord.status),
            rejectionReason: ord.rejection_reason || null,
            orderTime: ord.created_at ? new Date(Number(ord.created_at)).toISOString() : new Date().toISOString()
          };
        });

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
   * Download & parse Sahi daily Scrip Master CSV (https://assets.sahi.com/external/instruments.csv)
   */
  async _loadScripMaster() {
    const cache = this._cache.scripMaster;
    const now = Date.now();
    if (cache.contracts && (now - cache.at < 12 * 3600 * 1000)) {
      return cache;
    }
    if (cache.inflight) return cache.inflight;

    cache.inflight = (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(this.scripMasterUrl, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) return cache;

        const text = await res.text();
        const lines = text.split(/\r?\n/);
        if (lines.length < 2) return cache;

        const headers = parseCsvLine(lines[0]).map(h => h.trim());
        const idxId = headers.indexOf('id');
        const idxIsin = headers.indexOf('isin');
        const idxSym = headers.indexOf('symbol');
        const idxCompany = headers.indexOf('company_name');
        const idxUnderlying = headers.indexOf('underlying_symbol');
        const idxEx = headers.indexOf('exchange');
        const idxSeg = headers.indexOf('segment');
        const idxToken = headers.indexOf('token');
        const idxInstType = headers.indexOf('instrument_type');
        const idxOpt = headers.indexOf('option_type');
        const idxExp = headers.indexOf('expiry_date');
        const idxStrike = headers.indexOf('strike_price');
        const idxLot = headers.indexOf('lot_size');

        const contracts = [];
        const byIsin = new Map();
        const byId = new Map();
        let niftyIndexId = DEFAULT_NIFTY_INDEX_ID;

        for (let i = 1; i < lines.length; i++) {
          if (!lines[i]) continue;
          const cols = parseCsvLine(lines[i]);
          if (cols.length < 10) continue;

          const id = Number(cols[idxId] || 0);
          if (!Number.isFinite(id) || id <= 0) continue;

          const isin = String(cols[idxIsin] || '').trim();
          const symbol = String(cols[idxSym] || '').trim();
          const companyName = String(cols[idxCompany] || '').trim();
          const underlying = String(cols[idxUnderlying] || '').trim();
          const exchange = String(cols[idxEx] || '').trim().toUpperCase();
          const segment = String(cols[idxSeg] || '').trim().toUpperCase();
          const token = String(cols[idxToken] || '').trim();
          const instType = String(cols[idxInstType] || '').trim().toUpperCase();
          const optType = String(cols[idxOpt] || '').trim().toUpperCase();
          const expiry = normalizeSahiExpiryDate(cols[idxExp]);
          const strike = Math.round(Number(cols[idxStrike] || 0));
          const lotSize = (idxLot !== -1 && Number(cols[idxLot]) > 0) ? Math.round(Number(cols[idxLot])) : 65;

          if (isin && symbol && !byIsin.has(isin)) {
            byIsin.set(isin, { id, symbol, segment: segment || exchange });
          }
          if (symbol) {
            byId.set(id, { id, symbol, segment: segment || exchange, isin });
          }

          if (instType === 'IDX' && exchange === 'NSE' &&
            (token === '26000' || companyName.toLowerCase() === 'nifty 50')) {
            niftyIndexId = id;
          }

          if (segment === 'NFO' && instType === 'OPTIDX' && underlying === 'NIFTY' &&
            (optType === 'CE' || optType === 'PE') && expiry && strike > 0) {
            contracts.push({
              token: String(id),
              instrumentId: id,
              symbol,
              expiry,
              strike,
              lotSize,
              optType: optType.toLowerCase()
            });
          }
        }

        cache.niftyIndexId = niftyIndexId;
        cache.contracts = contracts;
        cache.byIsin = byIsin;
        cache.byId = byId;
        cache.at = Date.now();
        return cache;
      } catch (e) {
        if (!cache.contracts) cache.contracts = [];
        return cache;
      } finally {
        cache.inflight = null;
      }
    })();

    return cache.inflight;
  }

  /**
   * Real-time NIFTY Spot strictly from Sahi WebSocket Tick Stream (no REST quote polling)
   */
  async getIndexQuote(symbol = 'NIFTY') {
    if (this.isMock || !this.isAuthenticated) return null;

    const scrip = await this._loadScripMaster();
    const indexId = symbol === 'NIFTY' ? (scrip.niftyIndexId || DEFAULT_NIFTY_INDEX_ID) : DEFAULT_NIFTY_INDEX_ID;
    this.wsClient.subscribe(SAHI_MODE.QUOTE, [indexId]);

    const tick = this.wsClient.getTick(indexId);
    if (!tick || !(tick.ltp > 0)) return null;
    return {
      ltp: tick.ltp,
      open: 0,
      high: tick.ltp,
      low: tick.ltp,
      prevClose: 0
    };
  }

  /**
   * Real-time NIFTY Option Chain strictly from Sahi WebSocket Tick Stream (Depth/Quote ticks)
   */
  async getOptionChain(atmStrike) {
    if (this.isMock || !this.isAuthenticated || !atmStrike) return null;

    const scrip = await this._loadScripMaster();
    const contracts = scrip.contracts || [];
    if (contracts.length === 0) return null;

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

    const indexId = scrip.niftyIndexId || DEFAULT_NIFTY_INDEX_ID;
    this.wsClient.subscribe(SAHI_MODE.QUOTE, [indexId]);
    this.wsClient.subscribe(SAHI_MODE.DEPTH, selected.map(c => c.instrumentId));

    const oc = {};
    let wsCount = 0;
    for (const c of selected) {
      const tick = this.wsClient.getTick(c.instrumentId);
      if (!tick || !(tick.ltp > 0)) continue;
      wsCount++;
      if (!oc[c.strike]) oc[c.strike] = {};
      oc[c.strike][c.optType] = {
        symbol: c.symbol,
        instrumentToken: String(c.instrumentId),
        lotSize: c.lotSize || 65,
        last_price: tick.ltp,
        previous_close_price: 0,
        volume: tick.volume || 0,
        oi: tick.oi || 0,
        previous_oi: tick.prevOi || 0,
        top_bid_price: tick.bid,
        top_ask_price: tick.ask
      };
    }

    if (wsCount === 0) return null;
    const spotTick = this.wsClient.getTick(indexId);
    return {
      spotLtp: spotTick && spotTick.ltp > 0 ? spotTick.ltp : null,
      expiry: nearestExpiry,
      oc
    };
  }

  /**
   * Fetch last N days of 3-minute NIFTY historical candles via GET /v1/marketdata/candles
   * Sahi natively supports `size=3m` with integer paise prices -> INR.
   */
  async getHistoricalCandles({ days = 3, interval = '3m' } = {}) {
    if (this.isMock || !this.isAuthenticated) return [];

    const scrip = await this._loadScripMaster();
    const indexId = scrip.niftyIndexId || DEFAULT_NIFTY_INDEX_ID;
    const lookbackCalendarDays = Math.max(days + 4, 7);
    const toMs = Date.now();
    const fromMs = toMs - lookbackCalendarDays * 86400000;

    try {
      const collected = [];
      let pageTo = toMs;
      for (let page = 0; page < 3; page++) {
        const qs = new URLSearchParams({
          instrument_id: String(indexId),
          size: interval === '3m' ? '3m' : '3m',
          from: String(fromMs),
          to: String(pageTo)
        });
        const res = await this._request(`/v1/marketdata/candles?${qs.toString()}`, { method: 'GET' });
        const rows = Array.isArray(res && res.candles) ? res.candles : [];
        if (rows.length === 0) break;

        for (const r of rows) {
          const tsMs = Number(r[0]);
          const close = Number(r[4]) / 100;
          if (!Number.isFinite(tsMs) || !(close > 0)) continue;
          collected.push({
            time: Math.floor(tsMs / 1000),
            open: Number((Number(r[1]) / 100).toFixed(2)),
            high: Number((Number(r[2]) / 100).toFixed(2)),
            low: Number((Number(r[3]) / 100).toFixed(2)),
            close: Number(close.toFixed(2)),
            volume: Number(r[5] || 0),
            source: 'rest'
          });
        }

        if (!res.has_more) break;
        const earliestMs = Number(rows[0][0]);
        if (!Number.isFinite(earliestMs) || earliestMs <= fromMs) break;
        pageTo = earliestMs - 1;
      }

      collected.sort((a, b) => a.time - b.time);
      const dates = Array.from(new Set(collected.map(c => new Date((c.time + 19800) * 1000).toISOString().slice(0, 10)))).sort();
      const keepDates = new Set(dates.slice(-days));
      return collected.filter(c => keepDates.has(new Date((c.time + 19800) * 1000).toISOString().slice(0, 10)));
    } catch (err) {
      console.warn(`[Sahi] Error fetching historical candles: ${err.message}`);
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

module.exports = SahiBroker;
