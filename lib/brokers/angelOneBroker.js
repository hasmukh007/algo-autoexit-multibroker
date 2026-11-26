const os = require('os');
const { AngelOneWsClient } = require('../angelOneWsClient');

const EXCHANGE_TYPE_MAP = {
  nse: 1,
  nse_cm: 1,
  nfo: 2,
  nse_fo: 2,
  bse: 3,
  bse_cm: 3,
  bfo: 4,
  bse_fo: 4,
  mcx: 5,
  mcx_fo: 5
};

/**
 * Angel One SmartAPI Client (Node.js)
 * - Fetches net positions, funds, and orders ONCE after login and thereafter ONLY when an order is placed/executed (or manual refresh).
 * - Streams live LTP, OHLC, OI, Volume, Depth, and Order Updates via SmartAPI WebSocket v2.
 */
class AngelOneBroker {
  constructor(accountConfig = {}) {
    this.id = accountConfig.id || 'angel_' + Date.now();
    this.broker = 'angelone';
    this.name = accountConfig.name || 'Angel One';
    this.apiKey = (accountConfig.apiKey || '').trim();
    this.clientCode = (accountConfig.clientCode || '').trim();
    this.password = accountConfig.password || '';
    this.totpSecret = (accountConfig.totpSecret || '').trim();
    this.isMock = Boolean(accountConfig.isMock);

    this.baseUrl = 'https://apiconnect.angelone.in';
    this.jwtToken = null;
    this.refreshToken = null;
    this.feedToken = null;
    this.isAuthenticated = false;
    this.lastLoginTime = null;
    this.lastError = null;
    this._lastAutoLoginAttempt = 0;
    this._loginInflight = null;

    // Event-driven REST state (no periodic getPosition polling!)
    this._positionsLoadedOnce = false;
    this._holdingsLoadedOnce = false;
    this._fundsLoadedOnce = false;
    this._ordersLoadedOnce = false;
    this._tradeRefreshTimer = null;

    // Rate-limit & request pacing state
    this._rateLimitUntil = 0;
    this._rateLimitBackoffMs = 15000;
    this._lastRateLimitLogAt = 0;
    this._lastRequestAt = 0;
    this._requestQueue = Promise.resolve();
    this._minRequestGapMs = 400;

    // Cached REST responses & in-flight deduplication
    this._cache = {
      positions: { data: [], at: 0, inflight: null },
      holdings: { data: [], at: 0, inflight: null },
      funds: { data: { availableCash: 0, utilizedMargin: 0, totalBalance: 0 }, at: 0, inflight: null },
      orders: { data: [], at: 0, inflight: null },
      quote: { data: null, at: 0, inflight: null },
      optionChain: { data: null, atmStrike: null, at: 0, inflight: null },
      scripMaster: { contracts: null, at: 0, inflight: null }
    };

    const net = this._detectNetworkInfo();
    this.localIp = net.ip;
    this.macAddress = net.mac;

    // WebSocket client for Market Data + Real-time Order Execution updates
    this.wsClient = new AngelOneWsClient({
      apiKey: this.apiKey,
      clientCode: this.clientCode,
      WebSocketImpl: accountConfig.WebSocketImpl
    });

    this.wsClient.on('order_update', () => {
      // Order/trade executed or status changed -> refresh positions, orders, and funds
      this.scheduleTradeRefresh();
    });
  }

  _detectNetworkInfo() {
    try {
      const interfaces = os.networkInterfaces();
      for (const list of Object.values(interfaces)) {
        if (!Array.isArray(list)) continue;
        for (const iface of list) {
          if (iface && !iface.internal && iface.family === 'IPv4' && iface.mac && iface.mac !== '00:00:00:00:00:00') {
            return { ip: iface.address || '127.0.0.1', mac: iface.mac.toUpperCase() };
          }
        }
      }
    } catch (e) {}
    return { ip: '127.0.0.1', mac: '00:00:00:00:00:00' };
  }

  _startWebSockets() {
    if (this.isMock || !this.jwtToken || !this.apiKey || !this.clientCode) return;
    this.wsClient.updateCredentials({
      apiKey: this.apiKey,
      clientCode: this.clientCode,
      jwtToken: this.jwtToken,
      feedToken: this.feedToken
    });
    this.wsClient.connect();
    // Subscribe NIFTY 50 Spot (NSE token 99926000) on WebSocket
    this.wsClient.subscribe(3, [{ exchangeType: 1, tokens: ['99926000'] }]);
    this._subscribePositionTokens(this._cache.positions.data);
  }

  _subscribePositionTokens(positions = []) {
    if (!this.wsClient || !Array.isArray(positions) || positions.length === 0) return;
    const byExchange = new Map();
    for (const pos of positions) {
      if (!pos.instrumentToken) continue;
      const exType = EXCHANGE_TYPE_MAP[String(pos.exchangeSegment || 'nse').toLowerCase()] || 1;
      if (!byExchange.has(exType)) byExchange.set(exType, []);
      byExchange.get(exType).push(String(pos.instrumentToken));
    }
    const tokenList = [];
    for (const [exchangeType, tokens] of byExchange.entries()) {
      tokenList.push({ exchangeType, tokens });
    }
    if (tokenList.length > 0) {
      this.wsClient.subscribe(1, tokenList);
    }
  }

  _applyWsTicksToPositions(positions = []) {
    if (!Array.isArray(positions) || positions.length === 0) return [];
    return positions.map(pos => {
      const wsTick = pos.instrumentToken ? this.wsClient.getTick(pos.instrumentToken) : null;
      if (!wsTick || !(wsTick.ltp > 0)) {
        return { ...pos };
      }
      const ltp = Number(wsTick.ltp.toFixed(2));
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

  async _enqueueRequest(fn) {
    const run = async () => {
      const elapsed = Date.now() - this._lastRequestAt;
      if (elapsed < this._minRequestGapMs) {
        await new Promise(r => setTimeout(r, this._minRequestGapMs - elapsed));
      }
      this._lastRequestAt = Date.now();
      return await fn();
    };
    const next = this._requestQueue.then(run, run);
    this._requestQueue = next.catch(() => {});
    return next;
  }

  async _ensureAuthenticated() {
    if (this.isMock) return true;
    if (this.isAuthenticated && this.jwtToken) return true;
    if (this._loginInflight) return await this._loginInflight;

    if (this.totpSecret && this.apiKey && this.clientCode && this.password) {
      const now = Date.now();
      if (now - this._lastAutoLoginAttempt > 60000) {
        this._lastAutoLoginAttempt = now;
        this._loginInflight = (async () => {
          try {
            await this.login();
            return true;
          } catch (err) {
            this.lastError = err.message;
            console.warn(`[AngelOne] Auto-login failed for ${this.name}: ${err.message}`);
            return false;
          } finally {
            this._loginInflight = null;
          }
        })();
        return await this._loginInflight;
      }
    }
    return false;
  }

  async _request(endpoint, options = {}, _retried = false) {
    if (this.isMock) {
      throw new Error('Mock broker does not make real network requests');
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AngelOneSmartAPI/1.0',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': this.localIp || '127.0.0.1',
      'X-ClientPublicIP': this.localIp || '127.0.0.1',
      'X-MACAddress': this.macAddress || '00:00:00:00:00:00',
      'X-PrivateKey': this.apiKey,
      ...(options.headers || {})
    };

    if (this.jwtToken && !headers['Authorization']) {
      headers['Authorization'] = this.jwtToken.startsWith('Bearer ')
        ? this.jwtToken
        : `Bearer ${this.jwtToken}`;
    }

    const fetchOptions = {
      method: options.method || 'GET',
      headers
    };

    if (options.body) {
      fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    const response = await this._enqueueRequest(() => fetch(url, fetchOptions));
    const rawText = await response.text();
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (e) {
      data = { raw: rawText };
    }

    const rawSnippet = data && data.raw
      ? String(data.raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
      : '';
    const rawMsg = String((data && data.message) || rawSnippet || '').toLowerCase();
    const isRateLimit = response.status === 429 || (response.status === 403 && rawMsg.includes('rate'));

    if (isRateLimit) {
      const backoffMs = this._rateLimitBackoffMs;
      this._rateLimitUntil = Date.now() + backoffMs;
      this._rateLimitBackoffMs = Math.min(60000, backoffMs * 2);
      const detail = (data && data.message) || rawSnippet || `Access rate limit exceeded (backing off ${Math.round(backoffMs / 1000)}s)`;
      const errMsg = `Angel One HTTP ${response.status}: ${detail}`;
      const err = new Error(errMsg);
      err.status = response.status;
      err.isRateLimit = true;
      err.data = data;
      this.lastError = errMsg;
      throw err;
    }

    const isAuthEndpoint = endpoint.includes('/loginByPassword') || endpoint.includes('/generateTokens');
    if ((response.status === 401 || response.status === 403) && !isAuthEndpoint && !_retried) {
      const recovered = await this._recoverSession();
      if (recovered) {
        return await this._request(endpoint, options, true);
      }
      this.isAuthenticated = false;
      this.jwtToken = null;
    }

    if (!response.ok || (data.status === false && data.message)) {
      const code = data && (data.errorCode || data.errorcode || data.code);
      let errMsg = (data && data.message) || rawSnippet || '';
      if (!errMsg && response.status === 403) {
        const serverHdr = (response.headers && typeof response.headers.get === 'function' && response.headers.get('server')) || '';
        const amznErr = (response.headers && typeof response.headers.get === 'function' && response.headers.get('x-amzn-errortype')) || '';
        const extra = [serverHdr, amznErr].filter(Boolean).join('/');
        errMsg = `Angel One API error HTTP 403${extra ? ` [${extra}]` : ''} (check Trading API Key, Static IP whitelist in SmartAPI portal, or TOTP session)`;
      } else if (!errMsg) {
        errMsg = `Angel One API error HTTP ${response.status}`;
      } else if (response.status === 403) {
        errMsg = `Angel One HTTP 403${code ? ` (${code})` : ''}: ${errMsg}`;
      }
      const err = new Error(errMsg);
      err.status = response.status;
      err.data = data;
      this.lastError = errMsg;
      throw err;
    }

    this._rateLimitBackoffMs = 15000;
    this.lastError = null;
    return data;
  }

  _logRateLimitOnce(context, message) {
    const now = Date.now();
    if (now - this._lastRateLimitLogAt > 10000) {
      this._lastRateLimitLogAt = now;
      console.warn(`[AngelOne] ${context}: ${message}`);
    }
  }

  async _recoverSession() {
    if (this.refreshToken) {
      try {
        const res = await this._request('/rest/auth/angelbroking/jwt/v1/generateTokens', {
          method: 'POST',
          body: { refreshToken: this.refreshToken }
        }, true);
        if (res && res.data && res.data.jwtToken) {
          this.jwtToken = res.data.jwtToken;
          if (res.data.refreshToken) this.refreshToken = res.data.refreshToken;
          if (res.data.feedToken) this.feedToken = res.data.feedToken;
          this.isAuthenticated = true;
          this.lastLoginTime = new Date().toISOString();
          this._startWebSockets();
          return true;
        }
      } catch (e) {}
    }

    const now = Date.now();
    if (this.totpSecret && this.apiKey && this.clientCode && this.password && (now - this._lastAutoLoginAttempt > 60000)) {
      this._lastAutoLoginAttempt = now;
      try {
        await this.login();
        return true;
      } catch (e) {}
    }
    return false;
  }

  /**
   * Login using Client Code, Password, and TOTP, then fetch initial net positions & connect WebSockets
   */
  async login(totpOverride = null) {
    if (this.isMock) {
      this.isAuthenticated = true;
      this.lastLoginTime = new Date().toISOString();
      return { success: true, message: 'Angel One (Mock) connected' };
    }

    const totpHelper = require('../totpHelper');
    let totp = totpOverride;
    if (!totp && this.totpSecret) {
      totp = totpHelper.generateTOTP(this.totpSecret);
    }

    if (!totp) {
      throw new Error('Angel One requires TOTP for login');
    }

    const payload = {
      clientcode: this.clientCode,
      password: this.password,
      totp: String(totp).trim()
    };

    const res = await this._request('/rest/auth/angelbroking/user/v1/loginByPassword', {
      method: 'POST',
      body: payload
    });

    if (res.data) {
      this.jwtToken = res.data.jwtToken;
      this.refreshToken = res.data.refreshToken;
      this.feedToken = res.data.feedToken;
      this.isAuthenticated = true;
      this.lastLoginTime = new Date().toISOString();
      this.lastError = null;
      this._positionsLoadedOnce = false;
      this._holdingsLoadedOnce = false;
      this._fundsLoadedOnce = false;
      this._ordersLoadedOnce = false;

      // Connect Market Data + Order Update WebSockets and pull initial net positions & holdings
      this._startWebSockets();
      this.getPositions({ force: true }).catch(() => {});
      this.getHoldings({ force: true }).catch(() => {});
    }

    return {
      success: true,
      message: 'Angel One authenticated successfully',
      feedToken: this.feedToken
    };
  }

  /**
   * Fetch Available Funds & RMS Limits (fetched once after login, thereafter on trade/force refresh)
   */
  async getFunds(options = {}) {
    if (this.isMock) return { availableCash: 180000, utilizedMargin: 35000, totalBalance: 215000 };
    if (!(await this._ensureAuthenticated())) {
      return { availableCash: 0, utilizedMargin: 0, totalBalance: 0 };
    }

    const entry = this._cache.funds;
    const force = Boolean(options && options.force);
    if (!force && this._fundsLoadedOnce) {
      return entry.data;
    }
    if (Date.now() < this._rateLimitUntil) {
      return entry.data;
    }
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const res = await this._request('/rest/secure/angelbroking/user/v1/getRMS', { method: 'GET' });
        const d = res.data || {};
        const availableCash = Number(d.net || d.availablecash || d.cash || 0);
        const utilizedMargin = Number(d.utilisedamount || d.utiliseddebits || 0);
        entry.data = {
          availableCash,
          utilizedMargin,
          totalBalance: availableCash + utilizedMargin,
          raw: d
        };
        entry.at = Date.now();
        this._fundsLoadedOnce = true;
        return entry.data;
      } catch (err) {
        if (err.isRateLimit) this._logRateLimitOnce('Rate limited on getFunds', err.message);
        else console.warn(`[AngelOne] Error fetching funds: ${err.message}`);
        return entry.data;
      } finally {
        entry.inflight = null;
      }
    })();

    return entry.inflight;
  }

  /**
   * Fetch Net Positions:
   * - Calls REST /getPosition ONLY after login, on order/trade execution, or explicit force refresh.
   * - All regular reads return cached positions enriched with live WebSocket LTP & P&L.
   */
  async getPositions(options = {}) {
    if (this.isMock) return [];
    if (!(await this._ensureAuthenticated())) return [];

    const entry = this._cache.positions;
    const force = Boolean(options && options.force);

    // Never poll REST /getPosition periodically once loaded; update LTP/P&L from WebSocket ticks
    if (!force && this._positionsLoadedOnce) {
      return this._applyWsTicksToPositions(entry.data);
    }
    if (Date.now() < this._rateLimitUntil) {
      return this._applyWsTicksToPositions(entry.data);
    }
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const res = await this._request('/rest/secure/angelbroking/order/v1/getPosition', { method: 'GET' });
        const raw = Array.isArray(res.data) ? res.data : [];

        entry.data = raw.map(pos => {
          const netQty = Number(pos.netqty || (Number(pos.buyqty || 0) - Number(pos.sellqty || 0)));
          const buyAvg = Number(pos.buyavgprice || pos.buyprice || 0);
          const sellAvg = Number(pos.sellavgprice || pos.sellprice || 0);
          const ltp = Number(pos.ltp || pos.priceden || (netQty > 0 ? buyAvg : sellAvg));
          const unrealizedPnl = Number(pos.unrealised || 0);
          const realizedPnl = Number(pos.realised || 0);
          const totalPnl = Number(pos.pnl || (unrealizedPnl + realizedPnl));

          return {
            accountId: this.id,
            broker: 'angelone',
            brokerName: this.name,
            symbol: pos.tradingsymbol || pos.symbolname,
            exchangeSegment: (pos.exchange || 'NSE').toLowerCase(),
            product: pos.producttype || 'INTRADAY',
            instrumentToken: pos.symboltoken,
            netQty,
            buyQty: Number(pos.buyqty || 0),
            sellQty: Number(pos.sellqty || 0),
            buyAvg: Number(buyAvg.toFixed(2)),
            sellAvg: Number(sellAvg.toFixed(2)),
            ltp: Number(ltp.toFixed(2)),
            unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
            realizedPnl: Number(realizedPnl.toFixed(2)),
            totalPnl: Number(totalPnl.toFixed(2)),
            isOpen: netQty !== 0
          };
        });
        entry.at = Date.now();
        this._positionsLoadedOnce = true;
        this._subscribePositionTokens(entry.data);
        return this._applyWsTicksToPositions(entry.data);
      } catch (err) {
        if (err.isRateLimit) this._logRateLimitOnce('Rate limited on getPositions', err.message);
        else console.warn(`[AngelOne] Error fetching positions: ${err.message}`);
        return this._applyWsTicksToPositions(entry.data);
      } finally {
        entry.inflight = null;
      }
    })();

    return entry.inflight;
  }

  /**
   * Fetch Demat Holdings (REST once after login, thereafter on trade/force refresh; live LTP via WebSocket)
   */
  async getHoldings(options = {}) {
    if (this.isMock || !(await this._ensureAuthenticated())) return [];

    const entry = this._cache.holdings;
    const force = Boolean(options && options.force);
    if (!force && this._holdingsLoadedOnce) {
      return entry.data.map(h => {
        const tick = h.instrumentToken ? this.wsClient.getTick(h.instrumentToken) : null;
        if (!tick || !(tick.ltp > 0)) return { ...h };
        const ltp = Number(tick.ltp.toFixed(2));
        return {
          ...h,
          ltp,
          currentValue: Number((h.quantity * ltp).toFixed(2)),
          pnl: Number(((ltp - h.averagePrice) * h.quantity).toFixed(2))
        };
      });
    }
    if (Date.now() < this._rateLimitUntil) return entry.data;
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const res = await this._request('/rest/secure/angelbroking/portfolio/v1/getAllHolding', { method: 'GET' });
        const raw = (res && res.data && Array.isArray(res.data.holdings))
          ? res.data.holdings
          : (Array.isArray(res.data) ? res.data : []);
        entry.data = raw.map(h => {
          const qty = Number(h.quantity || 0);
          const avg = Number(h.averageprice || 0);
          const ltp = Number(h.ltp || avg);
          return {
            accountId: this.id,
            broker: 'angelone',
            brokerName: this.name,
            symbol: h.tradingsymbol,
            exchange: h.exchange || 'NSE',
            instrumentToken: h.symboltoken,
            quantity: qty,
            collateralQty: Number(h.collateralquantity || 0),
            averagePrice: avg,
            ltp,
            currentValue: Number((qty * ltp).toFixed(2)),
            pnl: Number((h.profitandloss !== undefined ? h.profitandloss : (ltp - avg) * qty).toFixed(2))
          };
        });
        this._holdingsLoadedOnce = true;
        const holdingTokens = entry.data.map(h => h.instrumentToken).filter(Boolean).map(String);
        if (holdingTokens.length > 0 && this.wsClient) {
          this.wsClient.subscribe(1, [{ exchangeType: 1, tokens: holdingTokens }]);
        }
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
   * Place Order on Angel One, then refresh net positions & order book
   */
  async placeOrder(order = {}) {
    if (this.isMock) {
      return { success: true, orderId: 'ANGEL-MOCK-' + Date.now() };
    }
    if (!(await this._ensureAuthenticated())) {
      throw new Error('Angel One session not authenticated. Please log in with TOTP first.');
    }

    const rawEx = String(order.exchangeSegment || 'NSE').toUpperCase();
    const angelExchange = (rawEx === 'NFO' || rawEx === 'NSE_FO' || rawEx === 'NSE_FNO')
      ? 'NFO'
      : ((rawEx === 'BFO' || rawEx === 'BSE_FO' || rawEx === 'BSE_FNO')
        ? 'BFO'
        : (rawEx.includes('BSE') ? 'BSE' : 'NSE'));
    const rawOrdType = String(order.orderType || 'MKT').toUpperCase();
    const angelOrderType = (rawOrdType === 'L' || rawOrdType === 'LMT' || rawOrdType === 'LIMIT')
      ? 'LIMIT'
      : ((rawOrdType === 'SL' || rawOrdType === 'SL-LMT' || rawOrdType === 'STOPLOSS_LIMIT')
        ? 'STOPLOSS_LIMIT'
        : ((rawOrdType === 'SL-M' || rawOrdType === 'SLM' || rawOrdType === 'SL-MKT') ? 'STOPLOSS_MARKET' : 'MARKET'));

    const payload = {
      variety: 'NORMAL',
      tradingsymbol: order.tradingSymbol,
      symboltoken: order.instrumentToken || '',
      transactiontype: order.transactionType === 'B' ? 'BUY' : 'SELL',
      exchange: angelExchange,
      ordertype: angelOrderType,
      producttype: order.product === 'MIS' ? 'INTRADAY' : (order.product === 'CNC' ? 'DELIVERY' : 'CARRYFORWARD'),
      duration: order.validity || 'DAY',
      price: angelOrderType === 'MARKET' || angelOrderType === 'STOPLOSS_MARKET' ? '0' : String(order.price || '0'),
      triggerprice: angelOrderType === 'STOPLOSS_LIMIT' || angelOrderType === 'STOPLOSS_MARKET' ? String(order.triggerPrice || '0') : '0',
      squareoff: '0',
      stoploss: '0',
      quantity: String(order.quantity)
    };

    const res = await this._request('/rest/secure/angelbroking/order/v1/placeOrder', {
      method: 'POST',
      body: payload
    });

    // Refresh net positions, orders & funds right after order placement
    this.scheduleTradeRefresh(300);

    return {
      success: true,
      orderId: (res.data && res.data.orderid) || 'ANGEL-' + Date.now(),
      data: res
    };
  }

  /**
   * Cancel Open Order, then refresh order book
   */
  async cancelOrder(orderId) {
    if (this.isMock) return { success: true, orderId };

    const payload = {
      variety: 'NORMAL',
      orderid: orderId
    };

    const res = await this._request('/rest/secure/angelbroking/order/v1/cancelOrder', {
      method: 'POST',
      body: payload
    });

    this.scheduleTradeRefresh(300);
    return { success: true, orderId, data: res };
  }

  /**
   * Retrieve live NIFTY spot strictly from Angel One WebSocket stream (no REST quote polling)
   */
  async getIndexQuote(symbol = 'NIFTY') {
    if (this.isMock || !this.isAuthenticated) return null;

    const token = symbol === 'NIFTY' ? '99926000' : '99926009';
    if (this.wsClient) {
      this.wsClient.subscribe(3, [{ exchangeType: 1, tokens: [token] }]);
      const wsTick = this.wsClient.getTick(token);
      if (wsTick && wsTick.ltp > 0) {
        return {
          ltp: wsTick.ltp,
          open: wsTick.open || 0,
          high: wsTick.high || wsTick.ltp,
          low: wsTick.low || wsTick.ltp,
          prevClose: wsTick.close || 0
        };
      }
    }
    return null;
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
        const res = await fetch('https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json', {
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) return cache.contracts || [];
        const list = await res.json();
        const filtered = [];
        for (const item of list) {
          if (item && item.exch_seg === 'NFO' && item.instrumenttype === 'OPTIDX' && item.name === 'NIFTY') {
            filtered.push({
              token: String(item.token),
              symbol: item.symbol,
              expiry: item.expiry,
              strike: Math.round(Number(item.strike) / 100),
              lotSize: Number(item.lotsize) > 0 ? Math.round(Number(item.lotsize)) : 65
            });
          }
        }
        cache.contracts = filtered;
        cache.at = Date.now();
        return filtered;
      } catch (e) {
        return cache.contracts || [];
      } finally {
        cache.inflight = null;
      }
    })();

    return cache.inflight;
  }

  /**
   * Retrieve live NIFTY Spot + Option Chain (10 ITM + ATM + 10 OTM CE & PE) from WebSocket stream
   * (subscribes tokens in Mode 3 SnapQuote on WS and falls back to REST only to seed missing ticks).
   */
  async getOptionChain(atmStrike) {
    if (this.isMock || !this.isAuthenticated || !atmStrike) return null;

    const contracts = await this._getNiftyOptionContracts();
    if (!contracts || contracts.length === 0) return this._cache.optionChain.data;

    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);

    const expiries = Array.from(new Set(contracts.map(c => c.expiry)))
      .map(exp => ({ exp, ts: Date.parse(exp) }))
      .filter(x => !Number.isNaN(x.ts) && x.ts >= todayMidnight.getTime())
      .sort((a, b) => a.ts - b.ts);

    if (expiries.length === 0) return this._cache.optionChain.data;
    const nearestExpiry = expiries[0].exp;

    const minStrike = atmStrike - 500;
    const maxStrike = atmStrike + 500;
    const selected = contracts.filter(
      c => c.expiry === nearestExpiry && c.strike >= minStrike && c.strike <= maxStrike
    );

    const tokenMap = new Map();
    const tokens = [];
    for (const c of selected) {
      const optType = c.symbol.endsWith('CE') ? 'ce' : (c.symbol.endsWith('PE') ? 'pe' : null);
      if (!optType) continue;
      tokenMap.set(c.token, { strike: c.strike, optType, symbol: c.symbol, lotSize: c.lotSize || 65 });
      tokens.push(c.token);
    }
    if (tokens.length === 0) return this._cache.optionChain.data;

    // Subscribe NIFTY spot + all 42 option contracts on WebSocket (Mode 3 Snap Quote)
    if (this.wsClient) {
      this.wsClient.subscribe(3, [
        { exchangeType: 1, tokens: ['99926000'] },
        { exchangeType: 2, tokens: tokens.slice(0, 49) }
      ]);

      // Assemble option chain directly from live WebSocket ticks when available
      const wsOc = {};
      let wsCount = 0;
      const cachedOc = (this._cache.optionChain.data && this._cache.optionChain.data.oc) || {};

      for (const tok of tokens) {
        const tick = this.wsClient.getTick(tok);
        if (!tick || !(tick.ltp > 0)) continue;
        wsCount++;
        const meta = tokenMap.get(tok);
        if (!wsOc[meta.strike]) wsOc[meta.strike] = {};
        const prevLeg = cachedOc[meta.strike] && cachedOc[meta.strike][meta.optType];
        const prevClose = tick.close > 0 ? tick.close : (prevLeg && prevLeg.previous_close_price) || 0;
        const oi = tick.oi !== undefined ? tick.oi : (prevLeg && prevLeg.oi);
        const prevOi = prevLeg && prevLeg.previous_oi !== undefined ? prevLeg.previous_oi : oi;

        wsOc[meta.strike][meta.optType] = {
          symbol: meta.symbol,
          instrumentToken: tok,
          lotSize: meta.lotSize || 65,
          last_price: tick.ltp,
          previous_close_price: prevClose,
          volume: tick.volume !== undefined ? tick.volume : (prevLeg && prevLeg.volume),
          oi,
          previous_oi: prevOi,
          top_bid_price: tick.bid !== undefined ? tick.bid : (prevLeg && prevLeg.top_bid_price),
          top_ask_price: tick.ask !== undefined ? tick.ask : (prevLeg && prevLeg.top_ask_price)
        };
      }

      if (wsCount > 0) {
        const wsSpot = this.wsClient.getTick('99926000');
        const spotLtp = wsSpot && wsSpot.ltp > 0 ? wsSpot.ltp : null;
        return {
          spotLtp,
          expiry: nearestExpiry,
          oc: wsOc
        };
      }
    }

    return null;
  }

  /**
   * Get Order Book (fetched once after login, thereafter on trade/order execution or explicit force refresh)
   */
  async getOrderBook(options = {}) {
    if (this.isMock) return [];
    if (!(await this._ensureAuthenticated())) return [];

    const entry = this._cache.orders;
    const force = Boolean(options && options.force);
    if (!force && this._ordersLoadedOnce) {
      return entry.data;
    }
    if (Date.now() < this._rateLimitUntil) {
      return entry.data;
    }
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const res = await this._request('/rest/secure/angelbroking/order/v1/getOrderBook', { method: 'GET' });
        const raw = Array.isArray(res.data) ? res.data : [];

        entry.data = raw.map(ord => ({
          accountId: this.id,
          broker: 'angelone',
          brokerName: this.name,
          orderId: ord.orderid,
          symbol: ord.tradingsymbol,
          exchange: ord.exchange,
          product: ord.producttype,
          transactionType: ord.transactiontype === 'BUY' ? 'B' : 'S',
          orderType: ord.ordertype,
          quantity: Number(ord.quantity || 0),
          filledQuantity: Number(ord.filledshares || 0),
          price: Number(ord.price || 0),
          status: (ord.status || 'PENDING').toUpperCase(),
          orderTime: ord.updatetime || ord.orderentrytime || new Date().toISOString()
        }));
        entry.at = Date.now();
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
   * Fetch last N days of 3-minute NIFTY historical candles via SmartAPI getCandleData
   */
  async getHistoricalCandles({ days = 3 } = {}) {
    if (this.isMock || !(await this._ensureAuthenticated())) return [];

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
    const fmtDateTime = (d, hm = null) => {
      const hh = hm ? hm.split(':')[0] : String(d.getHours()).padStart(2, '0');
      const mm = hm ? hm.split(':')[1] : String(d.getMinutes()).padStart(2, '0');
      return `${fmtDate(d)} ${hh}:${mm}`;
    };

    try {
      const res = await this._request('/rest/secure/angelbroking/historical/v1/getCandleData', {
        method: 'POST',
        body: {
          exchange: 'NSE',
          symboltoken: '99926000',
          interval: 'THREE_MINUTE',
          fromdate: fmtDateTime(istFrom, '09:15'),
          todate: fmtDateTime(istNow)
        }
      });

      const raw = res && Array.isArray(res.data) ? res.data : [];
      const parsed = raw
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

      // Keep the most recent `days` trading dates
      const dates = Array.from(new Set(parsed.map(c => new Date((c.time + 19800) * 1000).toISOString().slice(0, 10)))).sort();
      const keepDates = new Set(dates.slice(-days));
      return parsed.filter(c => keepDates.has(new Date((c.time + 19800) * 1000).toISOString().slice(0, 10)));
    } catch (err) {
      console.warn(`[AngelOne] Error fetching historical candles: ${err.message}`);
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

module.exports = AngelOneBroker;
