const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const KotakNeoBroker = require('./brokers/kotakNeoBroker');
const AngelOneBroker = require('./brokers/angelOneBroker');
const DhanBroker = require('./brokers/dhanBroker');
const SahiBroker = require('./brokers/sahiBroker');
const MockBrokerManager = require('./brokers/mockBroker');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

function hasAccountCredentials(acc) {
  if (!acc) return false;
  if (acc.broker === 'dhan') return Boolean(acc.accessToken);
  if (acc.broker === 'angelone') return Boolean(acc.apiKey && acc.clientCode);
  if (acc.broker === 'sahi') return Boolean((acc.keyId && acc.secret) || acc.accessToken);
  return Boolean(acc.consumerKey && acc.ucc);
}

class MultiBrokerManager extends EventEmitter {
  constructor(configManager) {
    super();
    this.configManager = configManager;
    this.brokerInstances = new Map();
    this.mockManager = new MockBrokerManager();
    this.dataFeedSource = 'kotakneo'; // 'kotakneo', 'angelone', or 'dhan'

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
          baseUrl: 'https://mis.kotaksecurities.com'
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
    const previousInstances = new Map(this.brokerInstances);
    this.brokerInstances.clear();
    const config = this.configManager.loadConfig();
    const isGlobalMock = config.mode === 'mock';

    const accounts = this.getRawAccounts();
    accounts.forEach(acc => {
      if (!acc.enabled) return;

      const hasCreds = hasAccountCredentials(acc);

      let instance;
      const accountConfig = { ...acc, isMock: isGlobalMock || !hasCreds };

      if (acc.broker === 'kotakneo') {
        instance = new KotakNeoBroker(accountConfig);
      } else if (acc.broker === 'angelone') {
        instance = new AngelOneBroker(accountConfig);
      } else if (acc.broker === 'dhan') {
        instance = new DhanBroker(accountConfig);
      } else if (acc.broker === 'sahi') {
        instance = new SahiBroker(accountConfig);
      }

      if (instance) {
        // Preserve active authenticated session tokens across reloads when mode/credentials match
        const prev = previousInstances.get(acc.id);
        if (prev && prev.broker === instance.broker && prev.isMock === instance.isMock && prev.isAuthenticated) {
          if (instance.broker === 'angelone') {
            instance.jwtToken = prev.jwtToken;
            instance.refreshToken = prev.refreshToken;
            instance.feedToken = prev.feedToken;
            instance.isAuthenticated = prev.isAuthenticated;
            instance.lastLoginTime = prev.lastLoginTime;
            instance._positionsLoadedOnce = prev._positionsLoadedOnce;
            instance._holdingsLoadedOnce = prev._holdingsLoadedOnce;
            instance._fundsLoadedOnce = prev._fundsLoadedOnce;
            instance._ordersLoadedOnce = prev._ordersLoadedOnce;
            instance._cache = prev._cache;
            if (typeof prev.disconnect === 'function') prev.disconnect();
            instance._startWebSockets();
          } else if (instance.broker === 'kotakneo' && prev.client && instance.client) {
            instance.client.sessionToken = prev.client.sessionToken;
            instance.client.viewToken = prev.client.viewToken;
            instance.client.sid = prev.client.sid;
            instance.client.activeBaseUrl = prev.client.activeBaseUrl;
            instance.client.sessionUser = prev.client.sessionUser;
            instance.client.lastLoginTime = prev.client.lastLoginTime;
            instance.client.isAuthenticated = prev.client.isAuthenticated;
            instance._positionsLoadedOnce = prev._positionsLoadedOnce;
            instance._holdingsLoadedOnce = prev._holdingsLoadedOnce;
            instance._fundsLoadedOnce = prev._fundsLoadedOnce;
            instance._ordersLoadedOnce = prev._ordersLoadedOnce;
            instance._cache = prev._cache;
            if (typeof prev.disconnect === 'function') prev.disconnect();
            instance._startWebSockets();
          } else if (instance.broker === 'dhan') {
            instance.isAuthenticated = prev.isAuthenticated;
            instance.lastLoginTime = prev.lastLoginTime;
            instance._positionsLoadedOnce = prev._positionsLoadedOnce;
            instance._holdingsLoadedOnce = prev._holdingsLoadedOnce;
            instance._fundsLoadedOnce = prev._fundsLoadedOnce;
            instance._ordersLoadedOnce = prev._ordersLoadedOnce;
            instance._cache = prev._cache;
            if (typeof prev.disconnect === 'function') prev.disconnect();
            instance._startWebSockets();
          } else if (instance.broker === 'sahi') {
            instance.accessToken = prev.accessToken;
            instance.expiresAt = prev.expiresAt;
            instance.userId = prev.userId;
            instance.isAuthenticated = prev.isAuthenticated;
            instance.lastLoginTime = prev.lastLoginTime;
            instance._positionsLoadedOnce = prev._positionsLoadedOnce;
            instance._holdingsLoadedOnce = prev._holdingsLoadedOnce;
            instance._fundsLoadedOnce = prev._fundsLoadedOnce;
            instance._ordersLoadedOnce = prev._ordersLoadedOnce;
            instance._cache = prev._cache;
            if (typeof prev.disconnect === 'function') prev.disconnect();
            instance._startWebSockets();
          }
        } else if (prev && typeof prev.disconnect === 'function') {
          prev.disconnect();
        }
        this._bindBrokerEvents(instance);
        this.brokerInstances.set(acc.id, instance);
      }
    });

    // Disconnect removed/disabled previous instances
    for (const [oldId, oldInst] of previousInstances.entries()) {
      if (!this.brokerInstances.has(oldId) && typeof oldInst.disconnect === 'function') {
        oldInst.disconnect();
      }
    }
  }

  _bindBrokerEvents(instance) {
    if (!instance || !instance.wsClient || typeof instance.wsClient.on !== 'function') return;
    instance.wsClient.on('tick', tick => {
      this.emit('ws_tick', {
        broker: instance.broker,
        accountId: instance.id,
        tick
      });
    });
    instance.wsClient.on('order_update', update => {
      this.emit('order_update', {
        broker: instance.broker,
        accountId: instance.id,
        update
      });
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
        hasCredentials: hasAccountCredentials(acc),
        isAuthenticated: instance ? instance.isAuthenticated : false,
        lastError: instance ? (instance.lastError || null) : null,
        clientCode: (instance && instance.userId) || acc.ucc || acc.clientCode || acc.clientId || acc.keyId || ''
      };
    });
  }

  addAccount(accData) {
    const raw = this.getRawAccounts();
    const { totp, ...persistentData } = accData;
    const newId = `acc_${accData.broker}_${Date.now()}`;
    const account = {
      id: newId,
      broker: accData.broker,
      name: accData.name || `${accData.broker.toUpperCase()} Account`,
      enabled: accData.enabled !== undefined ? accData.enabled : true,
      ...persistentData
    };
    raw.push(account);
    this.saveRawAccounts(raw);
    return account;
  }

  updateAccount(id, accData) {
    const raw = this.getRawAccounts();
    const idx = raw.findIndex(a => a.id === id);
    if (idx === -1) throw new Error(`Account ${id} not found`);

    const { totp, ...persistentData } = accData;
    raw[idx] = {
      ...raw[idx],
      ...persistentData,
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
    const res = await instance.login(totpOverride);
    if (res && res.success) {
      this.setDataFeedSource(instance.broker);
    }
    return {
      ...res,
      accountId: id,
      broker: instance.broker,
      accountName: instance.name,
      dataFeedSource: this.dataFeedSource
    };
  }

  /**
   * Auto-login all enabled broker accounts sequentially (used at 8:59 AM IST or manual trigger)
   */
  async loginAllBrokers() {
    const results = [];
    for (const [id, instance] of this.brokerInstances.entries()) {
      if (instance.isMock) {
        results.push({ accountId: id, broker: instance.broker, accountName: instance.name, success: true, skipped: true, message: 'Mock mode' });
        continue;
      }
      if (instance.isAuthenticated && (instance.broker !== 'angelone' || instance.jwtToken)) {
        results.push({ accountId: id, broker: instance.broker, accountName: instance.name, success: true, alreadyAuthenticated: true, message: 'Already authenticated' });
        continue;
      }
      try {
        const res = await instance.login();
        results.push({
          accountId: id,
          broker: instance.broker,
          accountName: instance.name,
          success: Boolean(res && res.success),
          message: (res && res.message) || 'Authenticated'
        });
      } catch (err) {
        results.push({
          accountId: id,
          broker: instance.broker,
          accountName: instance.name,
          success: false,
          message: err.message
        });
      }
    }
    return results;
  }

  /**
   * Authenticate an added/updated account (when possible) and subscribe market data feed
   */
  async authenticateAndSubscribe(id, totpOverride = null) {
    const instance = this.brokerInstances.get(id);
    if (!instance) {
      return { authenticated: false, subscribed: false, message: 'Account disabled or inactive' };
    }

    try {
      const res = await instance.login(totpOverride || null);
      if (res && res.success) {
        this.setDataFeedSource(instance.broker);
        return {
          authenticated: true,
          subscribed: true,
          message: res.message,
          accountId: id,
          broker: instance.broker,
          accountName: instance.name,
          isMock: instance.isMock,
          dataFeedSource: this.dataFeedSource
        };
      }
      return {
        authenticated: false,
        subscribed: false,
        message: (res && res.message) || 'Login did not succeed',
        accountId: id,
        broker: instance.broker,
        accountName: instance.name
      };
    } catch (err) {
      return {
        authenticated: false,
        subscribed: false,
        message: err.message,
        accountId: id,
        broker: instance.broker,
        accountName: instance.name
      };
    }
  }

  /**
   * Fetch aggregated real-time positions from all connected active brokers
   */
  async getAllPositions(options = {}) {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      return await this.mockManager.getPositions();
    }

    const all = [];
    for (const [id, broker] of this.brokerInstances.entries()) {
      try {
        const positions = await broker.getPositions(options);
        all.push(...positions);
      } catch (err) {
        console.warn(`Error getting positions for ${broker.name}:`, err.message);
      }
    }
    return all;
  }

  /**
   * Fetch aggregated holdings across all active broker accounts
   */
  async getAllHoldings(options = {}) {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      return [];
    }

    const all = [];
    for (const [id, broker] of this.brokerInstances.entries()) {
      if (typeof broker.getHoldings !== 'function') continue;
      try {
        const holdings = await broker.getHoldings(options);
        all.push(...holdings);
      } catch (err) {
        console.warn(`Error getting holdings for ${broker.name}:`, err.message);
      }
    }
    return all;
  }

  /**
   * Fetch total funds across all active broker accounts
   */
  async getAllFunds(options = {}) {
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
        const funds = await broker.getFunds(options);
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
  async getAllOrders(options = {}) {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      return await this.mockManager.getOrderBook();
    }

    const all = [];
    for (const [id, broker] of this.brokerInstances.entries()) {
      try {
        const orders = await broker.getOrderBook(options);
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
    if (source === 'angelone' || source === 'kotakneo' || source === 'dhan' || source === 'sahi') {
      this.dataFeedSource = source;
      return { success: true, dataFeedSource: source };
    }
    throw new Error('Data feed source must be "kotakneo", "angelone", "dhan", or "sahi"');
  }

  getDataFeedSource() {
    return this.dataFeedSource;
  }

  /**
   * Returns true if live mode is enabled and at least one non-mock broker is authenticated.
   */
  hasActiveLiveFeedBroker() {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') return false;

    for (const broker of this.brokerInstances.values()) {
      if (!broker.isMock && broker.isAuthenticated) {
        return true;
      }
    }
    return false;
  }

  /**
   * Fetch live NIFTY index spot quote from the active authenticated data feed broker
   */
  async getLiveNiftySpotQuote() {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') return null;

    const preferred = this.dataFeedSource;
    const candidates = [];
    for (const broker of this.brokerInstances.values()) {
      if (!broker.isMock && broker.isAuthenticated && typeof broker.getIndexQuote === 'function') {
        if (broker.broker === preferred) candidates.unshift(broker);
        else candidates.push(broker);
      }
    }

    for (const broker of candidates) {
      const quote = await broker.getIndexQuote('NIFTY');
      if (quote && quote.ltp > 0) {
        return { ...quote, broker: broker.broker };
      }
    }
    return null;
  }

  /**
   * Fetch live NIFTY Option Chain quotes from the active authenticated data feed broker (when supported)
   */
  async getLiveNiftyOptionChain(atmStrike = null) {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') return null;

    const preferred = this.dataFeedSource;
    const candidates = [];
    for (const broker of this.brokerInstances.values()) {
      if (!broker.isMock && broker.isAuthenticated && typeof broker.getOptionChain === 'function') {
        if (broker.broker === preferred) candidates.unshift(broker);
        else candidates.push(broker);
      }
    }

    for (const broker of candidates) {
      const chain = await broker.getOptionChain(atmStrike);
      if (chain && chain.oc) {
        return { ...chain, broker: broker.broker };
      }
    }
    return null;
  }

  /**
   * Fetch historical NIFTY candles (e.g. last 3 days) from the preferred or first authenticated live broker
   */
  async getNiftyHistoricalCandles({ days = 3, interval = '3m' } = {}) {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') return { broker: null, candles: [] };

    const preferred = this.dataFeedSource;
    const candidates = [];
    for (const broker of this.brokerInstances.values()) {
      if (!broker.isMock && broker.isAuthenticated && typeof broker.getHistoricalCandles === 'function') {
        if (broker.broker === preferred) candidates.unshift(broker);
        else candidates.push(broker);
      }
    }

    for (const broker of candidates) {
      try {
        const candles = await broker.getHistoricalCandles({ days, interval });
        if (Array.isArray(candles) && candles.length > 0) {
          return { broker: broker.broker, candles };
        }
      } catch (e) {}
    }

    return { broker: null, candles: [] };
  }
}

module.exports = MultiBrokerManager;
