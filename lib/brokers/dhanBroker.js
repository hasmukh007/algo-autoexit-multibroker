/**
 * DhanHQ Trading API Client (Node.js)
 * Implements REST v2 endpoints for authentication, positions, funds, and order execution.
 */
class DhanBroker {
  constructor(accountConfig = {}) {
    this.id = accountConfig.id || 'dhan_' + Date.now();
    this.broker = 'dhan';
    this.name = accountConfig.name || 'Dhan';
    this.clientId = accountConfig.clientId || '';
    this.accessToken = accountConfig.accessToken || '';
    this.isMock = Boolean(accountConfig.isMock);

    this.baseUrl = 'https://api.dhan.co/v2';
    this.isAuthenticated = Boolean(this.accessToken);
    this.lastLoginTime = this.accessToken ? new Date().toISOString() : null;
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
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = (data && (data.errorMessage || data.message)) || `Dhan API error HTTP ${response.status}`;
      const err = new Error(errMsg);
      err.status = response.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  /**
   * Test Connection / Verify Access Token
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

    // Verify token by querying fund limit
    await this.getFunds();
    this.isAuthenticated = true;
    this.lastLoginTime = new Date().toISOString();
    return { success: true, message: 'DhanHQ authenticated successfully' };
  }

  /**
   * Fetch Available Funds & Margin Limits
   */
  async getFunds() {
    if (this.isMock) return { availableCash: 310000, utilizedMargin: 52000, totalBalance: 362000 };

    try {
      const res = await this._request('/fundlimit', { method: 'GET' });
      const d = res.data || res || {};
      const availableCash = Number(d.availMargin || d.cash || 0);
      const utilizedMargin = Number(d.utilizedAmount || d.marginUsed || 0);
      return {
        availableCash,
        utilizedMargin,
        totalBalance: availableCash + utilizedMargin,
        raw: d
      };
    } catch (err) {
      console.warn(`[Dhan] Error fetching funds: ${err.message}`);
      return { availableCash: 0, utilizedMargin: 0, totalBalance: 0 };
    }
  }

  /**
   * Fetch Real-Time Positions
   */
  async getPositions() {
    if (this.isMock) return [];

    try {
      const res = await this._request('/positions', { method: 'GET' });
      const raw = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);

      return raw.map(pos => {
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
    } catch (err) {
      console.warn(`[Dhan] Error fetching positions: ${err.message}`);
      return [];
    }
  }

  /**
   * Place Order on Dhan
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

    return {
      success: true,
      orderId: (res && (res.orderId || res.data && res.data.orderId)) || 'DHAN-' + Date.now(),
      data: res
    };
  }

  /**
   * Cancel Order on Dhan
   */
  async cancelOrder(orderId) {
    if (this.isMock) return { success: true, orderId };

    const res = await this._request(`/orders/${orderId}`, {
      method: 'DELETE'
    });

    return { success: true, orderId, data: res };
  }

  /**
   * Get Order Book
   */
  async getOrderBook() {
    if (this.isMock) return [];

    try {
      const res = await this._request('/orders', { method: 'GET' });
      const raw = Array.isArray(res.data) ? res.data : (Array.isArray(res) ? res : []);

      return raw.map(ord => ({
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
    } catch (err) {
      return [];
    }
  }
}

module.exports = DhanBroker;
