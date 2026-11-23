const KotakNeoClient = require('../kotakNeoClient');

/**
 * Kotak Neo Broker Adapter
 * Standardizes KotakNeoClient methods into the unified multi-broker interface.
 */
class KotakNeoBroker {
  constructor(accountConfig = {}) {
    this.id = accountConfig.id || 'kotak_' + Date.now();
    this.broker = 'kotakneo';
    this.name = accountConfig.name || 'Kotak Neo';
    this.isMock = Boolean(accountConfig.isMock);

    this.client = new KotakNeoClient({
      baseUrl: accountConfig.baseUrl || 'https://napi.kotaksecurities.com',
      consumerKey: accountConfig.consumerKey || '',
      mobileNumber: accountConfig.mobileNumber || '',
      ucc: accountConfig.ucc || '',
      mpin: accountConfig.mpin || '',
      totpSecret: accountConfig.totpSecret || ''
    });
  }

  get isAuthenticated() {
    return this.isMock ? true : this.client.isAuthenticated;
  }

  async login(totpOverride = null) {
    if (this.isMock) return { success: true, message: 'Kotak Neo (Mock) connected' };
    return await this.client.fullLogin({ totp: totpOverride });
  }

  async getFunds() {
    if (this.isMock) {
      return { availableCash: 250000, utilizedMargin: 45000, totalBalance: 295000 };
    }

    try {
      const limits = await this.client.getLimits();
      const cash = Number(limits.availableCash || 0);
      const used = Number(limits.utilizedMargin || 0);
      return {
        availableCash: cash,
        utilizedMargin: used,
        totalBalance: cash + used,
        raw: limits
      };
    } catch (err) {
      console.warn(`[KotakNeo] Error fetching funds: ${err.message}`);
      return { availableCash: 0, utilizedMargin: 0, totalBalance: 0 };
    }
  }

  async getPositions() {
    if (this.isMock) return [];

    try {
      const list = await this.client.getPositions();
      return list.map(pos => ({
        ...pos,
        accountId: this.id,
        broker: 'kotakneo',
        brokerName: this.name
      }));
    } catch (err) {
      console.warn(`[KotakNeo] Error fetching positions: ${err.message}`);
      return [];
    }
  }

  async placeOrder(order = {}) {
    if (this.isMock) {
      return { success: true, orderId: 'KOTAK-MOCK-' + Date.now() };
    }
    return await this.client.placeOrder(order);
  }

  async cancelOrder(orderId) {
    if (this.isMock) return { success: true, orderId };
    return await this.client.cancelOrder(orderId);
  }

  async getOrderBook() {
    if (this.isMock) return [];

    try {
      const list = await this.client.getOrderBook();
      return list.map(ord => ({
        ...ord,
        accountId: this.id,
        broker: 'kotakneo',
        brokerName: this.name
      }));
    } catch (err) {
      return [];
    }
  }
}

module.exports = KotakNeoBroker;
