/**
 * Kotak Neo Trade API Client (Node.js)
 * Implements REST API v2 endpoints for authentication, orders, positions, holdings, and limits.
 */
function normalizeKotakBaseUrl(url) {
  const raw = (url || '').trim();
  if (!raw || raw.includes('napi.kotaksecurities.com')) {
    return 'https://mis.kotaksecurities.com';
  }
  return raw;
}

function normalizeKotakMobile(mobile) {
  const raw = String(mobile || '').trim().replace(/\s+/g, '');
  if (/^\d{10}$/.test(raw)) return `+91${raw}`;
  if (/^91\d{10}$/.test(raw)) return `+${raw}`;
  return raw;
}

function extractKotakErrorMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data === 'string') return data.trim() || fallback;
  if (Array.isArray(data)) {
    const parts = data.map(item => extractKotakErrorMessage(item, '')).filter(Boolean);
    return parts.join('; ') || fallback;
  }
  if (typeof data === 'object') {
    const candidates = [
      data.message,
      data.errMsg,
      data.emsg,
      data.description,
      data.error_description,
      data.errorMessage,
      data.error,
      data.fault,
      data.data,
      data.raw
    ];
    for (const c of candidates) {
      if (c === undefined || c === null) continue;
      if (typeof c === 'string' && c.trim()) return c.trim();
      if (typeof c === 'object') {
        const nested = extractKotakErrorMessage(c, '');
        if (nested) return nested;
      }
    }
    try {
      const s = JSON.stringify(data);
      if (s && s !== '{}') return s;
    } catch (e) {}
  }
  return fallback;
}

function isNoDataError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  return (
    msg.includes('no data') ||
    msg.includes('no record') ||
    msg.includes('no positions') ||
    msg.includes('no holdings') ||
    msg.includes('no orders')
  );
}

function isTransientBridgeError(err) {
  if (!err) return false;
  const status = Number(err.status || 0);
  const msg = String(err.message || '').toLowerCase();
  return (
    status === 424 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    msg.includes('bridge api error') ||
    msg.includes('300015')
  );
}

function isJwtClockSkewError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('token used before issued') || msg.includes('used before issued');
}

class KotakNeoClient {
  constructor(config = {}) {
    this.baseUrl = normalizeKotakBaseUrl(config.baseUrl);
    this.consumerKey = (config.consumerKey || '').trim();
    this.mobileNumber = (config.mobileNumber || '').trim();
    this.ucc = (config.ucc || '').trim();
    this.mpin = config.mpin || '';
    this.totpSecret = (config.totpSecret || '').trim();
    this.neoFinKey = 'neotradeapi';
    this._retryDelayMs = typeof config.retryDelayMs === 'number' ? config.retryDelayMs : 350;
    this._jwtSkewRetryDelayMs = typeof config.jwtSkewRetryDelayMs === 'number' ? config.jwtSkewRetryDelayMs : 1200;

    // Active session state
    this.sessionToken = null; // High privilege Trading Token
    this.viewToken = null;    // Pre-auth View Token
    this.sid = null;          // Session ID
    this.activeBaseUrl = this.baseUrl; // Dynamically updated from tradeApiValidate
    this.sessionUser = null;
    this.lastLoginTime = null;
    this.isAuthenticated = false;
  }

  /**
   * Helper to perform HTTP requests using Node 20 native fetch
   */
  async _request(endpoint, options = {}) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.activeBaseUrl}${endpoint}`;
    const headers = {
      'neo-fin-key': this.neoFinKey,
      'accept': 'application/json',
      ...(options.headers || {})
    };

    if (this.consumerKey && !headers['Authorization']) {
      headers['Authorization'] = this.consumerKey;
    }
    if (!options.skipSessionHeaders) {
      if (this.sessionToken && !headers['Auth']) {
        headers['Auth'] = this.sessionToken;
      }
      if (this.sid && !headers['Sid']) {
        headers['Sid'] = this.sid;
      }
    }

    const fetchOptions = {
      method: options.method || 'GET',
      headers
    };

    if (options.body) {
      if (options.isForm) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        fetchOptions.body = options.body;
      } else {
        headers['Content-Type'] = 'application/json';
        fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      }
    }

    const maxJwtSkewRetries = typeof options.jwtSkewRetries === 'number' ? options.jwtSkewRetries : 3;
    for (let attempt = 0; attempt <= maxJwtSkewRetries; attempt++) {
      try {
        const response = await fetch(url, fetchOptions);
        const text = await response.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = { raw: text };
        }

        if (!response.ok || (data && (data.stat === 'Not_Ok' || data.status === false))) {
          const fallback = `HTTP ${response.status}: ${response.statusText || 'Kotak Neo API error'}`;
          const errorMsg = extractKotakErrorMessage(data, fallback);
          const err = new Error(errorMsg);
          err.status = response.status;
          err.details = data;
          throw err;
        }

        return data;
      } catch (err) {
        if (err && err.cause && err.message === 'fetch failed') {
          const causeMsg = err.cause.message || err.cause.code || 'Network request failed';
          const wrapped = new Error(`Kotak Neo connection error (${url}): ${causeMsg}`);
          wrapped.cause = err.cause;
          throw wrapped;
        }
        if (isJwtClockSkewError(err)) {
          if (attempt < maxJwtSkewRetries) {
            const delayMs = this._jwtSkewRetryDelayMs * (attempt + 1);
            if (delayMs > 0) {
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            continue;
          }
          err.message = `${err.message} (JWT iat ahead of server clock; sync system NTP or retry login)`;
        }
        throw err;
      }
    }
  }

  /**
   * Step 1: TOTP Login
   * Authenticates mobile number, UCC, and TOTP to generate view token and session ID
   */
  async loginWithTotp(mobileNumber, ucc, totp) {
    const mobile = normalizeKotakMobile(mobileNumber || this.mobileNumber);
    const userUcc = String(ucc || this.ucc || '').trim();

    if (!mobile || !userUcc || !totp) {
      throw new Error('Mobile number, UCC, and 6-digit TOTP are required for login.');
    }

    const endpoint = `${this.baseUrl}/login/1.0/tradeApiLogin`;
    const payload = {
      mobileNumber: mobile,
      ucc: userUcc,
      totp: String(totp).trim()
    };

    const headers = {};
    if (this.consumerKey) {
      headers['Authorization'] = this.consumerKey;
    }

    const res = await this._request(endpoint, {
      method: 'POST',
      headers,
      body: payload,
      skipSessionHeaders: true
    });

    // In Kotak Neo API, response typically contains view token and sid
    const data = res.data || res;
    this.viewToken = data.token || data.viewToken || data.sessionToken;
    this.sid = data.sid || data.sessionId;
    if (!this.viewToken) {
      throw new Error(extractKotakErrorMessage(res, 'Kotak Neo TOTP login did not return a view token.'));
    }
    this.ucc = userUcc;
    this.mobileNumber = mobile;

    return {
      success: true,
      message: 'TOTP verified successfully. Ready for MPIN validation.',
      viewToken: this.viewToken,
      sid: this.sid,
      raw: res
    };
  }

  /**
   * Step 2: Validate MPIN
   * Elevates session using MPIN to generate final trading token and dynamic base URL
   */
  async validateMpin(mpin, ucc, viewToken = null) {
    const userMpin = mpin || this.mpin;
    const userUcc = ucc || this.ucc;
    const token = viewToken || this.viewToken;

    if (!userMpin) {
      throw new Error('MPIN is required for trading validation.');
    }

    const endpoint = `${this.baseUrl}/login/1.0/tradeApiValidate`;
    const payload = {
      mpin: String(userMpin).trim()
    };

    const headers = {};
    if (this.consumerKey) {
      headers['Authorization'] = this.consumerKey;
    } else if (token) {
      headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }
    if (token) {
      headers['Auth'] = token;
    }
    if (this.sid) {
      headers['Sid'] = this.sid;
    }

    const res = await this._request(endpoint, {
      method: 'POST',
      headers,
      body: payload,
      skipSessionHeaders: true
    });

    const data = res.data || res;
    this.sessionToken = data.token || data.tradingToken || data.authToken || token;
    if (!this.sessionToken) {
      throw new Error(extractKotakErrorMessage(res, 'Kotak Neo MPIN validation did not return a session token.'));
    }
    if (data.sid) this.sid = data.sid;
    if (data.baseUrl) this.activeBaseUrl = data.baseUrl;

    this.sessionUser = {
      ucc: userUcc,
      clientName: data.clientName || data.userName || userUcc,
      email: data.email || null,
      accountType: data.accountType || 'Trading'
    };

    this.isAuthenticated = true;
    this.lastLoginTime = new Date().toISOString();

    return {
      success: true,
      message: 'Logged in to Kotak Neo successfully.',
      sessionToken: this.sessionToken,
      sid: this.sid,
      activeBaseUrl: this.activeBaseUrl,
      user: this.sessionUser
    };
  }

  /**
   * Complete full automated login with credentials
   * If totpSecret is configured, it auto-generates the current TOTP
   */
  async fullLogin(credentials = {}) {
    const totpHelper = require('./totpHelper');

    const mobile = credentials.mobileNumber || this.mobileNumber;
    const ucc = credentials.ucc || this.ucc;
    const mpin = credentials.mpin || this.mpin;
    let totp = credentials.totp;

    const secret = credentials.totpSecret || this.totpSecret;
    if (!totp && secret) {
      totp = totpHelper.generateTOTP(secret);
    }

    if (!totp) {
      throw new Error('Please provide a 6-digit TOTP or a valid TOTP Secret key.');
    }

    // Step 1: Login with TOTP
    await this.loginWithTotp(mobile, ucc, totp);

    // Step 2: Validate MPIN
    const validateRes = await this.validateMpin(mpin, ucc, this.viewToken);
    return validateRes;
  }

  /**
   * Log out and clear session tokens
   */
  logout() {
    this.sessionToken = null;
    this.viewToken = null;
    this.sid = null;
    this.isAuthenticated = false;
    this.sessionUser = null;
    this.lastLoginTime = null;
    return { success: true, message: 'Logged out.' };
  }

  /**
   * Get Current Session Status
   */
  getSessionStatus() {
    return {
      isAuthenticated: this.isAuthenticated,
      hasSessionToken: Boolean(this.sessionToken),
      ucc: this.ucc,
      lastLoginTime: this.lastLoginTime,
      activeBaseUrl: this.activeBaseUrl,
      user: this.sessionUser
    };
  }

  /* ============================================================
     ORDER MANAGEMENT ENDPOINTS
     ============================================================ */

  /**
   * Place an Order
   * @param {Object} order - Order parameters
   */
  async placeOrder(order = {}) {
    if (!this.isAuthenticated && !this.sessionToken) {
      throw new Error('Session not authenticated. Please log in first.');
    }

    const payload = {
      am: order.amo ? 'YES' : 'NO',
      dq: String(order.disclosedQuantity || '0'),
      es: order.exchangeSegment || 'nse_cm', // nse_cm, nse_fo, bse_cm, bse_fo, mcx_fo
      mp: '0',
      pc: order.product || 'MIS',            // MIS, CNC, NRML
      pf: 'N',
      pr: String(order.price || '0'),        // 0 for MKT
      pt: order.orderType || 'MKT',          // MKT, L, SL, SL-M
      qt: String(order.quantity),
      rt: order.validity || 'DAY',           // DAY, IOC
      tp: String(order.triggerPrice || '0'), // Trigger price for SL/SL-M
      ts: order.tradingSymbol,               // Trading Symbol e.g. "RELIANCE-EQ"
      tt: order.transactionType              // 'B' (Buy) or 'S' (Sell)
    };

    const params = new URLSearchParams();
    params.append('jData', JSON.stringify(payload));

    const res = await this._request('/quick/order/rule/ms/place', {
      method: 'POST',
      body: params.toString(),
      isForm: true
    });

    return {
      success: true,
      orderId: (res.data && (res.data.nOrdNo || res.data.orderId)) || res.nOrdNo || 'ORD-' + Date.now(),
      data: res
    };
  }

  /**
   * Modify an Existing Order
   */
  async modifyOrder(order = {}) {
    if (!this.isAuthenticated && !this.sessionToken) {
      throw new Error('Session not authenticated.');
    }

    const payload = {
      no: String(order.orderId),
      am: order.amo ? 'YES' : 'NO',
      dq: String(order.disclosedQuantity || '0'),
      es: order.exchangeSegment || 'nse_cm',
      mp: '0',
      pc: order.product || 'MIS',
      pr: String(order.price || '0'),
      pt: order.orderType || 'L',
      qt: String(order.quantity),
      rt: order.validity || 'DAY',
      tp: String(order.triggerPrice || '0'),
      ts: order.tradingSymbol
    };

    const params = new URLSearchParams();
    params.append('jData', JSON.stringify(payload));

    const res = await this._request('/quick/order/rule/ms/modify', {
      method: 'POST',
      body: params.toString(),
      isForm: true
    });

    return {
      success: true,
      orderId: order.orderId,
      data: res
    };
  }

  /**
   * Cancel an Open Order
   */
  async cancelOrder(orderId, amo = false) {
    if (!this.isAuthenticated && !this.sessionToken) {
      throw new Error('Session not authenticated.');
    }

    const payload = {
      no: String(orderId),
      am: amo ? 'YES' : 'NO'
    };

    const params = new URLSearchParams();
    params.append('jData', JSON.stringify(payload));

    const res = await this._request('/quick/order/rule/ms/cancel', {
      method: 'POST',
      body: params.toString(),
      isForm: true
    });

    return {
      success: true,
      orderId,
      data: res
    };
  }

  /**
   * Fetch Order Book / List of Orders
   */
  async getOrderBook() {
    if (!this.isAuthenticated && !this.sessionToken) {
      throw new Error('Session not authenticated.');
    }

    try {
      const res = await this._request('/quick/user/orders', { method: 'GET' });
      const orders = Array.isArray(res.data) ? res.data : Array.isArray(res) ? res : (res.data ? [res.data] : []);
      
      // Normalize order book fields
      return orders.map(ord => {
        const avgExec = Number(ord.avgPrc || ord.flPrc || ord.tradePrice || 0);
        const limitPx = Number(ord.prc || ord.pr || 0);
        return {
          orderId: ord.nOrdNo || ord.orderId || ord.ordNo,
          symbol: ord.trdSym || ord.tsym || ord.tradingSymbol || ord.symbol,
          exchange: ord.es || ord.exchangeSegment || 'NSE',
          product: ord.prod || ord.pc || ord.product || 'MIS',
          transactionType: ord.trantype || ord.tt || (ord.side === 'BUY' ? 'B' : 'S'),
          orderType: ord.prctyp || ord.pt || ord.orderType || 'MKT',
          quantity: Number(ord.qty || ord.qt || 0),
          filledQuantity: Number(ord.fldQty || ord.filledQty || 0),
          pendingQuantity: Number(ord.pndQty || ord.pendingQty || 0),
          price: avgExec > 0 ? avgExec : limitPx,
          avgPrice: avgExec > 0 ? avgExec : limitPx,
          triggerPrice: Number(ord.trgPrc || ord.tp || 0),
          status: (ord.ordSt || ord.stat || ord.status || 'PENDING').toUpperCase(),
          statusMessage: ord.rejRsn || ord.rejReason || ord.statusMsg || '',
          orderTime: ord.ordDtTm || ord.orderTime || new Date().toISOString()
        };
      });
    } catch (err) {
      if (isNoDataError(err)) return [];
      throw err;
    }
  }

  /**
   * Fetch Trade Book / Executed Trades
   */
  async getTradeBook() {
    if (!this.isAuthenticated && !this.sessionToken) {
      throw new Error('Session not authenticated.');
    }

    try {
      const res = await this._request('/quick/user/trades', { method: 'GET' });
      return Array.isArray(res.data) ? res.data : Array.isArray(res) ? res : [];
    } catch (err) {
      return [];
    }
  }

  /* ============================================================
     PORTFOLIO & FUNDS ENDPOINTS
     ============================================================ */

  /**
   * Fetch Real-Time Positions
   */
  async getPositions() {
    if (!this.isAuthenticated && !this.sessionToken) {
      throw new Error('Session not authenticated.');
    }

    let rawList = [];
    try {
      const res = await this._request('/quick/user/positions', { method: 'GET' });
      rawList = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);
    } catch (e) {
      if (isNoDataError(e)) return [];
      try {
        const fallback = await this._request('/portfolio/v2/positions', { method: 'GET' });
        rawList = Array.isArray(fallback.data) ? fallback.data : (Array.isArray(fallback) ? fallback : []);
      } catch (e2) {
        if (isNoDataError(e2)) return [];
        throw e2;
      }
    }

    // Normalize positions
    return rawList.map(pos => {
      const flBuyQty = Number(pos.flBuyQty || pos.flBQty || pos.buyQty || 0);
      const flSellQty = Number(pos.flSellQty || pos.flSQty || pos.sellQty || 0);
      const cfBuyQty = Number(pos.cfBuyQty || 0);
      const cfSellQty = Number(pos.cfSellQty || 0);
      const buyQty = flBuyQty + cfBuyQty;
      const sellQty = flSellQty + cfSellQty;

      const netQty = Number(pos.netQty !== undefined && pos.netQty !== '' ? pos.netQty : (buyQty - sellQty));

      const totalBuyAmt = Number(pos.buyAmt || 0) + Number(pos.cfBuyAmt || 0);
      const totalSellAmt = Number(pos.sellAmt || 0) + Number(pos.cfSellAmt || 0);

      const buyAvg = Number(pos.buyAvgPrc || pos.buyAvg || pos.bAvg || (buyQty > 0 && totalBuyAmt > 0 ? totalBuyAmt / buyQty : 0));
      const sellAvg = Number(pos.sellAvgPrc || pos.sellAvg || pos.sAvg || (sellQty > 0 && totalSellAmt > 0 ? totalSellAmt / sellQty : 0));
      const ltp = Number(pos.ltp || pos.lastPrice || pos.prc || (netQty > 0 ? buyAvg : sellAvg));

      // Calculate PnL if not directly provided
      let unrealizedPnl = Number(pos.urmtom || pos.unrealizedPnl || 0);
      let realizedPnl = Number(pos.rpnl || pos.realizedPnl || 0);

      if (netQty !== 0 && !unrealizedPnl && ltp) {
        if (netQty > 0 && buyAvg > 0) {
          unrealizedPnl = (ltp - buyAvg) * netQty;
        } else if (netQty < 0 && sellAvg > 0) {
          unrealizedPnl = (sellAvg - ltp) * Math.abs(netQty);
        }
      }
      if (netQty === 0 && !realizedPnl && totalBuyAmt > 0 && totalSellAmt > 0) {
        realizedPnl = totalSellAmt - totalBuyAmt;
      }

      const totalPnl = unrealizedPnl + realizedPnl;

      return {
        symbol: pos.trdSym || pos.tsym || pos.tradingSymbol || pos.symbol,
        exchangeSegment: pos.exSeg || pos.es || pos.exchangeSegment || 'nse_cm',
        product: pos.prod || pos.pc || pos.product || 'MIS',
        instrumentToken: pos.tok || pos.instrumentToken,
        netQty,
        buyQty,
        sellQty,
        buyAvg: Number(buyAvg.toFixed(2)),
        sellAvg: Number(sellAvg.toFixed(2)),
        ltp: Number(ltp.toFixed(2)),
        unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
        realizedPnl: Number(realizedPnl.toFixed(2)),
        totalPnl: Number(totalPnl.toFixed(2)),
        pnlPercentage: buyAvg && buyAvg > 0 ? Number(((ltp - buyAvg) / buyAvg * 100).toFixed(2)) : 0,
        isOpen: netQty !== 0
      };
    });
  }

  /**
   * Fetch Demat Holdings
   */
  async getHoldings() {
    if (!this.isAuthenticated && !this.sessionToken) {
      throw new Error('Session not authenticated.');
    }

    try {
      const res = await this._request('/portfolio/v1/holdings', { method: 'GET' });
      const rawList = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);
      return rawList.map(h => ({
        symbol: h.tsym || h.tradingSymbol || h.symbol,
        exchange: h.es || 'NSE',
        instrumentToken: h.instrumentToken || h.tok || h.symbolCode,
        quantity: Number(h.holdQty || h.quantity || h.qty || 0),
        collateralQty: Number(h.collateralQty || 0),
        averagePrice: Number(h.avgPrc || h.averagePrice || 0),
        ltp: Number(h.ltp || h.lastPrice || h.closePrice || 0),
        currentValue: Number(h.curVal || ((h.holdQty || 0) * (h.ltp || 0))),
        pnl: Number(h.pnl || (((h.ltp || 0) - (h.avgPrc || 0)) * (h.holdQty || 0)))
      }));
    } catch (err) {
      if (isNoDataError(err)) return [];
      throw err;
    }
  }

  async _fetchLimitsWithPayload(payload) {
    const params = new URLSearchParams();
    params.append('jData', JSON.stringify(payload));
    try {
      return await this._request('/quick/user/limits', {
        method: 'POST',
        body: params.toString(),
        isForm: true
      });
    } catch (err) {
      if (err && err.status === 404) {
        return await this._request('/quick/user/limits', { method: 'GET' });
      }
      throw err;
    }
  }

  /**
   * Fetch Account Funds and Limits
   */
  async getLimits() {
    if (!this.isAuthenticated && !this.sessionToken) {
      throw new Error('Session not authenticated.');
    }

    const payloads = [
      { seg: 'ALL', exch: 'ALL', prod: 'ALL' },
      { seg: 'ALL', exch: 'NSE', prod: 'ALL' },
      { seg: 'CASH', exch: 'NSE', prod: 'ALL' },
      { seg: 'FO', exch: 'NSE', prod: 'ALL' }
    ];

    let res;
    let lastErr;
    try {
      res = await this._fetchLimitsWithPayload(payloads[0]);
    } catch (err) {
      lastErr = err;
      if (isTransientBridgeError(err)) {
        // Retry once after brief pause, then probe NSE/CASH/FO in case an unenabled segment causes bridge error
        if (this._retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this._retryDelayMs));
        }
        try {
          res = await this._fetchLimitsWithPayload(payloads[0]);
        } catch (retryErr) {
          lastErr = retryErr;
          if (isTransientBridgeError(retryErr)) {
            for (let i = 1; i < payloads.length; i++) {
              try {
                res = await this._fetchLimitsWithPayload(payloads[i]);
                lastErr = null;
                break;
              } catch (segErr) {
                lastErr = segErr;
                if (!isTransientBridgeError(segErr)) break;
              }
            }
          }
        }
      }
      if (!res) {
        if (lastErr) lastErr.isBridgeError = isTransientBridgeError(lastErr);
        throw lastErr;
      }
    }

    const data = (res && res.data) || res || {};
    const availableCash = Number(data.Net || data.net || data.cash || data.availableMargin || data.Cash || 0);
    const utilizedMargin = Number(data.MarginUsed || data.marginUsed || data.utilizedMargin || 0);
    const collateralMargin = Number(data.CollateralValue || data.collateral || data.collateralMargin || 0);
    const grossMargin = Number(data.GrossMargin || data.grossMargin || data.totalMargin || (availableCash + utilizedMargin));

    return {
      availableCash,
      utilizedMargin,
      collateralMargin,
      grossMargin,
      raw: data
    };
  }
}

module.exports = KotakNeoClient;
