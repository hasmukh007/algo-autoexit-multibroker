/**
 * Angel One SmartAPI Client (Node.js)
 * Implements REST endpoints for session authentication, positions, funds, and order execution.
 */
class AngelOneBroker {
  constructor(accountConfig = {}) {
    this.id = accountConfig.id || 'angel_' + Date.now();
    this.broker = 'angelone';
    this.name = accountConfig.name || 'Angel One';
    this.apiKey = accountConfig.apiKey || '';
    this.clientCode = accountConfig.clientCode || '';
    this.password = accountConfig.password || '';
    this.totpSecret = accountConfig.totpSecret || '';
    this.isMock = Boolean(accountConfig.isMock);

    this.baseUrl = 'https://apiconnect.angelone.in';
    this.jwtToken = null;
    this.refreshToken = null;
    this.feedToken = null;
    this.isAuthenticated = false;
    this.lastLoginTime = null;
  }

  async _request(endpoint, options = {}) {
    if (this.isMock) {
      throw new Error('Mock broker does not make real network requests');
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': 'fe80::1',
      'X-PrivateKey': this.apiKey,
      ...(options.headers || {})
    };

    if (this.jwtToken && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${this.jwtToken}`;
    }

    const fetchOptions = {
      method: options.method || 'GET',
      headers
    };

    if (options.body) {
      fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);
    const data = await response.json().catch(() => ({}));

    if (!response.ok || (data.status === false && data.message)) {
      const errMsg = (data && data.message) || `Angel One API error HTTP ${response.status}`;
      const err = new Error(errMsg);
      err.status = response.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  /**
   * Login using Client Code, Password, and TOTP
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
    }

    return {
      success: true,
      message: 'Angel One authenticated successfully',
      feedToken: this.feedToken
    };
  }

  /**
   * Fetch Available Funds & RMS Limits
   */
  async getFunds() {
    if (this.isMock) return { availableCash: 180000, utilizedMargin: 35000, totalBalance: 215000 };

    try {
      const res = await this._request('/rest/secure/angelbroking/user/v1/getRMS', { method: 'GET' });
      const d = res.data || {};
      const availableCash = Number(d.net || d.availablecash || d.cash || 0);
      const utilizedMargin = Number(d.utilisedamount || d.utiliseddebits || 0);
      return {
        availableCash,
        utilizedMargin,
        totalBalance: availableCash + utilizedMargin,
        raw: d
      };
    } catch (err) {
      console.warn(`[AngelOne] Error fetching funds: ${err.message}`);
      return { availableCash: 0, utilizedMargin: 0, totalBalance: 0 };
    }
  }

  /**
   * Fetch Real-Time Positions
   */
  async getPositions() {
    if (this.isMock) return [];

    try {
      const res = await this._request('/rest/secure/angelbroking/order/v1/getPosition', { method: 'GET' });
      const raw = Array.isArray(res.data) ? res.data : [];

      return raw.map(pos => {
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
    } catch (err) {
      console.warn(`[AngelOne] Error fetching positions: ${err.message}`);
      return [];
    }
  }

  /**
   * Place Order on Angel One
   */
  async placeOrder(order = {}) {
    if (this.isMock) {
      return { success: true, orderId: 'ANGEL-MOCK-' + Date.now() };
    }

    const payload = {
      variety: 'NORMAL',
      tradingsymbol: order.tradingSymbol,
      symboltoken: order.instrumentToken || '',
      transactiontype: order.transactionType === 'B' ? 'BUY' : 'SELL',
      exchange: (order.exchangeSegment || 'NSE').toUpperCase().replace('_CM', '').replace('_FO', ''),
      ordertype: order.orderType || 'MARKET',
      producttype: order.product === 'MIS' ? 'INTRADAY' : (order.product === 'CNC' ? 'DELIVERY' : 'CARRYFORWARD'),
      duration: order.validity || 'DAY',
      price: String(order.price || '0'),
      squareoff: '0',
      stoploss: '0',
      quantity: String(order.quantity)
    };

    const res = await this._request('/rest/secure/angelbroking/order/v1/placeOrder', {
      method: 'POST',
      body: payload
    });

    return {
      success: true,
      orderId: (res.data && res.data.orderid) || 'ANGEL-' + Date.now(),
      data: res
    };
  }

  /**
   * Cancel Open Order
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

    return { success: true, orderId, data: res };
  }

  /**
   * Get Order Book
   */
  async getOrderBook() {
    if (this.isMock) return [];

    try {
      const res = await this._request('/rest/secure/angelbroking/order/v1/getOrderBook', { method: 'GET' });
      const raw = Array.isArray(res.data) ? res.data : [];

      return raw.map(ord => ({
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
    } catch (err) {
      return [];
    }
  }
}

module.exports = AngelOneBroker;
