/**
 * Kotak Neo Trade API Client (Node.js)
 * Implements REST API v2 endpoints for authentication, orders, positions, holdings, and limits.
 */
class KotakNeoClient {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || 'https://napi.kotaksecurities.com';
    this.consumerKey = config.consumerKey || '';
    this.mobileNumber = config.mobileNumber || '';
    this.ucc = config.ucc || '';
    this.mpin = config.mpin || '';
    this.totpSecret = config.totpSecret || '';
    this.neoFinKey = 'neotradeapi';

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

    if (this.sessionToken && !headers['Auth']) {
      headers['Auth'] = this.sessionToken;
    }
    if (this.sid && !headers['Sid']) {
      headers['Sid'] = this.sid;
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

    try {
      const response = await fetch(url, fetchOptions);
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = { raw: text };
      }

      if (!response.ok) {
        const errorMsg = (data && (data.message || data.errMsg || data.error)) || `HTTP ${response.status}: ${response.statusText}`;
        const err = new Error(errorMsg);
        err.status = response.status;
        err.details = data;
        throw err;
      }

      return data;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Step 1: TOTP Login
   * Authenticates mobile number, UCC, and TOTP to generate view token and session ID
   */
  async loginWithTotp(mobileNumber, ucc, totp) {
    const mobile = mobileNumber || this.mobileNumber;
    const userUcc = ucc || this.ucc;

    if (!mobile || !userUcc || !totp) {
      throw new Error('Mobile number, UCC, and 6-digit TOTP are required for login.');
    }

    const endpoint = `${this.baseUrl}/login/1.0/tradeApiLogin`;
    const payload = {
      mobileNumber: mobile,
      ucc: userUcc,
      totp: String(totp).trim()
    };

    const res = await this._request(endpoint, {
      method: 'POST',
      body: payload
    });

    // In Kotak Neo API, response typically contains view token and sid
    const data = res.data || res;
    this.viewToken = data.token || data.viewToken || data.sessionToken;
    this.sid = data.sid || data.sessionId;
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
      ucc: userUcc,
      mpin: String(userMpin).trim()
    };

    const headers = {};
    if (token) {
      headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
      headers['Auth'] = token;
    }
    if (this.sid) {
      headers['Sid'] = this.sid;
    }

    const res = await this._request(endpoint, {
      method: 'POST',
      headers,
      body: payload
    });

    const data = res.data || res;
    this.sessionToken = data.token || data.tradingToken || data.authToken || token;
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
      return orders.map(ord => ({
        orderId: ord.nOrdNo || ord.orderId || ord.ordNo,
        symbol: ord.tsym || ord.tradingSymbol || ord.symbol,
        exchange: ord.es || ord.exchangeSegment || 'NSE',
        product: ord.prod || ord.pc || ord.product || 'MIS',
        transactionType: ord.trantype || ord.tt || (ord.side === 'BUY' ? 'B' : 'S'),
        orderType: ord.prctyp || ord.pt || ord.orderType || 'MKT',
        quantity: Number(ord.qty || ord.qt || 0),
        filledQuantity: Number(ord.fldQty || ord.filledQty || 0),
        pendingQuantity: Number(ord.pndQty || ord.pendingQty || 0),
        price: Number(ord.prc || ord.pr || 0),
        triggerPrice: Number(ord.trgPrc || ord.tp || 0),
        status: (ord.ordSt || ord.stat || ord.status || 'PENDING').toUpperCase(),
        statusMessage: ord.rejRsn || ord.rejReason || ord.statusMsg || '',
        orderTime: ord.ordDtTm || ord.orderTime || new Date().toISOString()
      }));
    } catch (err) {
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
      // First try portfolio/v2/positions (supports LTP)
      const res = await this._request('/portfolio/v2/positions', { method: 'GET' });
      rawList = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);
    } catch (e) {
      // Fallback to quick/user/positions
      const fallback = await this._request('/quick/user/positions', { method: 'GET' });
      rawList = Array.isArray(fallback.data) ? fallback.data : (Array.isArray(fallback) ? fallback : []);
    }

    // Normalize positions
    return rawList.map(pos => {
      const buyQty = Number(pos.flBQty || pos.buyQty || 0);
      const sellQty = Number(pos.flSQty || pos.sellQty || 0);
      const netQty = Number(pos.netQty || (buyQty - sellQty));
      const buyAvg = Number(pos.buyAvgPrc || pos.buyAvg || pos.bAvg || 0);
      const sellAvg = Number(pos.sellAvgPrc || pos.sellAvg || pos.sAvg || 0);
      const ltp = Number(pos.ltp || pos.lastPrice || (netQty > 0 ? buyAvg : sellAvg));

      // Calculate PnL if not directly provided
      let unrealizedPnl = Number(pos.urmtom || pos.unrealizedPnl || 0);
      let realizedPnl = Number(pos.rpnl || pos.realizedPnl || 0);

      if (netQty !== 0 && !unrealizedPnl && ltp && buyAvg) {
        unrealizedPnl = netQty > 0 ? (ltp - buyAvg) * netQty : (sellAvg - ltp) * Math.abs(netQty);
      }

      const totalPnl = unrealizedPnl + realizedPnl;

      return {
        symbol: pos.tsym || pos.tradingSymbol || pos.symbol,
        exchangeSegment: pos.es || pos.exchangeSegment || 'nse_cm',
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
        quantity: Number(h.holdQty || h.quantity || h.qty || 0),
        collateralQty: Number(h.collateralQty || 0),
        averagePrice: Number(h.avgPrc || h.averagePrice || 0),
        ltp: Number(h.ltp || h.lastPrice || h.closePrice || 0),
        currentValue: Number(h.curVal || ((h.holdQty || 0) * (h.ltp || 0))),
        pnl: Number(h.pnl || (((h.ltp || 0) - (h.avgPrc || 0)) * (h.holdQty || 0)))
      }));
    } catch (err) {
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

    try {
      const res = await this._request('/quick/user/limits', { method: 'GET' });
      const data = res.data || res;
      return {
        availableCash: Number(data.cash || data.availableMargin || data.net || 0),
        utilizedMargin: Number(data.marginUsed || data.utilizedMargin || 0),
        collateralMargin: Number(data.collateral || data.collateralMargin || 0),
        grossMargin: Number(data.grossMargin || data.totalMargin || 0),
        raw: data
      };
    } catch (err) {
      throw err;
    }
  }
}

module.exports = KotakNeoClient;
