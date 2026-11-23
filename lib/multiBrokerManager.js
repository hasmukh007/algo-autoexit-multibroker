const fs = require('fs');
const path = require('path');
const KotakNeoBroker = require('./brokers/kotakNeoBroker');
const AngelOneBroker = require('./brokers/angelOneBroker');
const DhanBroker = require('./brokers/dhanBroker');
const MockBrokerManager = require('./brokers/mockBroker');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

class MultiBrokerManager {
  constructor(configManager) {
    this.configManager = configManager;
    this.brokerInstances = new Map();
    this.mockManager = new MockBrokerManager();
    this.dataFeedSource = 'kotakneo'; // 'kotakneo' or 'angelone'

    this._ensureFile();
    this.reloadBrokers();
  }

  _ensureFile() {
    const dir = path.dirname(ACCOUNTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(ACCOUNTS_FILE)) {
      const initial = [
        {
          id: 'acc_kotak_default',
          broker: 'kotakneo',
          name: 'Kotak Neo Main',
          enabled: true,
          consumerKey: '',
          mobileNumber: '',
          ucc: '',
          mpin: '',
          totpSecret: '',
          baseUrl: 'https://napi.kotaksecurities.com'
        },
        {
          id: 'acc_angel_default',
          broker: 'angelone',
          name: 'Angel One SmartAPI',
          enabled: false,
          apiKey: '',
          clientCode: '',
          password: '',
          totpSecret: ''
        },
        {
          id: 'acc_dhan_default',
          broker: 'dhan',
          name: 'DhanHQ Trading',
          enabled: false,
          clientId: '',
          accessToken: ''
        }
      ];
      fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(initial, null, 2), 'utf8');
    }
  }

  getRawAccounts() {
    try {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    } catch (e) {
      return [];
    }
  }

  saveRawAccounts(accounts) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
    this.reloadBrokers();
  }

  reloadBrokers() {
    this.brokerInstances.clear();
    const config = this.configManager.loadConfig();
    const isGlobalMock = config.mode === 'mock';

    const accounts = this.getRawAccounts();
    accounts.forEach(acc => {
      if (!acc.enabled) return;

      const hasCreds = acc.broker === 'dhan'
        ? Boolean(acc.accessToken)
        : (acc.broker === 'angelone' ? Boolean(acc.apiKey && acc.clientCode) : Boolean(acc.consumerKey && acc.ucc));

      let instance;
      const accountConfig = { ...acc, isMock: isGlobalMock || !hasCreds };

      if (acc.broker === 'kotakneo') {
        instance = new KotakNeoBroker(accountConfig);
      } else if (acc.broker === 'angelone') {
        instance = new AngelOneBroker(accountConfig);
      } else if (acc.broker === 'dhan') {
        instance = new DhanBroker(accountConfig);
      }

      if (instance) {
        this.brokerInstances.set(acc.id, instance);
      }
    });
  }

  getAccounts() {
    const raw = this.getRawAccounts();
    return raw.map(acc => {
      const instance = this.brokerInstances.get(acc.id);
      return {
        id: acc.id,
        broker: acc.broker,
        name: acc.name,
        enabled: acc.enabled,
        hasCredentials: acc.broker === 'dhan'
          ? Boolean(acc.accessToken)
          : (acc.broker === 'angelone' ? Boolean(acc.apiKey && acc.clientCode) : Boolean(acc.consumerKey && acc.ucc)),
        isAuthenticated: instance ? instance.isAuthenticated : false,
        clientCode: acc.ucc || acc.clientCode || acc.clientId || ''
      };
    });
  }

  addAccount(accData) {
    const raw = this.getRawAccounts();
    const newId = `acc_${accData.broker}_${Date.now()}`;
    const account = {
      id: newId,
      broker: accData.broker,
      name: accData.name || `${accData.broker.toUpperCase()} Account`,
      enabled: accData.enabled !== undefined ? accData.enabled : true,
      ...accData
    };
    raw.push(account);
    this.saveRawAccounts(raw);
    return account;
  }

  updateAccount(id, accData) {
    const raw = this.getRawAccounts();
    const idx = raw.findIndex(a => a.id === id);
    if (idx === -1) throw new Error(`Account ${id} not found`);

    raw[idx] = {
      ...raw[idx],
      ...accData,
      id
    };
    this.saveRawAccounts(raw);
    return raw[idx];
  }

  deleteAccount(id) {
    let raw = this.getRawAccounts();
    raw = raw.filter(a => a.id !== id);
    this.saveRawAccounts(raw);
    return { success: true };
  }

  async testAccountLogin(id, totpOverride = null) {
    const instance = this.brokerInstances.get(id);
    if (!instance) throw new Error(`Broker instance for ${id} not active`);
    return await instance.login(totpOverride);
  }

  /**
   * Fetch aggregated real-time positions from all connected active brokers
   */
  async getAllPositions() {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      return await this.mockManager.getPositions();
    }

    const all = [];
    for (const [id, broker] of this.brokerInstances.entries()) {
      try {
        const positions = await broker.getPositions();
        all.push(...positions);
      } catch (err) {
        console.warn(`Error getting positions for ${broker.name}:`, err.message);
      }
    }
    return all;
  }

  /**
   * Fetch total funds across all active broker accounts
   */
  async getAllFunds() {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      return await this.mockManager.getFunds();
    }

    let totalAvailableCash = 0;
    let totalUtilizedMargin = 0;
    let totalBalance = 0;
    const accountBreakdown = [];

    for (const [id, broker] of this.brokerInstances.entries()) {
      try {
        const funds = await broker.getFunds();
        totalAvailableCash += Number(funds.availableCash || 0);
        totalUtilizedMargin += Number(funds.utilizedMargin || 0);
        totalBalance += Number(funds.totalBalance || (funds.availableCash + funds.utilizedMargin) || 0);
        accountBreakdown.push({
          id,
          broker: broker.broker,
          name: broker.name,
          availableCash: funds.availableCash,
          utilizedMargin: funds.utilizedMargin,
          totalBalance: funds.totalBalance
        });
      } catch (err) {
        accountBreakdown.push({
          id,
          broker: broker.broker,
          name: broker.name,
          availableCash: 0,
          utilizedMargin: 0,
          totalBalance: 0,
          error: err.message
        });
      }
    }

    return {
      availableCash: totalAvailableCash,
      utilizedMargin: totalUtilizedMargin,
      totalBalance: totalBalance,
      accounts: accountBreakdown
    };
  }

  /**
   * Fetch aggregated order book from all active accounts
   */
  async getAllOrders() {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      return await this.mockManager.getOrderBook();
    }

    const all = [];
    for (const [id, broker] of this.brokerInstances.entries()) {
      try {
        const orders = await broker.getOrderBook();
        all.push(...orders);
      } catch (err) {}
    }
    return all;
  }

  /**
   * Exit a specific position by dispatching to the exact broker account that owns it
   */
  async exitPosition(position, reason = 'Auto-Exit') {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      const oppositeSide = position.netQty > 0 ? 'S' : 'B';
      return await this.mockManager.placeOrder({
        accountId: position.accountId,
        tradingSymbol: position.symbol,
        exchangeSegment: position.exchangeSegment,
        transactionType: oppositeSide,
        orderType: 'MKT',
        quantity: Math.abs(position.netQty),
        product: position.product
      });
    }

    let brokerInstance = this.brokerInstances.get(position.accountId);
    if (!brokerInstance) {
      // Fallback: match by broker type
      for (const inst of this.brokerInstances.values()) {
        if (inst.broker === position.broker) {
          brokerInstance = inst;
          break;
        }
      }
    }

    if (!brokerInstance) {
      throw new Error(`No active broker connection found for account ${position.accountId || position.broker}`);
    }

    const oppositeSide = position.netQty > 0 ? 'S' : 'B';
    return await brokerInstance.placeOrder({
      tradingSymbol: position.symbol,
      exchangeSegment: position.exchangeSegment || 'nse_cm',
      transactionType: oppositeSide,
      orderType: 'MKT',
      quantity: Math.abs(position.netQty),
      price: '0',
      product: position.product,
      instrumentToken: position.instrumentToken
    });
  }

  /**
   * Set primary data feed subscription source
   */
  setDataFeedSource(source) {
    if (source === 'angelone' || source === 'kotakneo') {
      this.dataFeedSource = source;
      return { success: true, dataFeedSource: source };
    }
    throw new Error('Data feed source must be either "angelone" or "kotakneo"');
  }

  getDataFeedSource() {
    return this.dataFeedSource;
  }
}

module.exports = MultiBrokerManager;
