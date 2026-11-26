const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const KotakNeoBroker = require('./brokers/kotakNeoBroker');
const AngelOneBroker = require('./brokers/angelOneBroker');
const DhanBroker = require('./brokers/dhanBroker');
const SahiBroker = require('./brokers/sahiBroker');
const MockBrokerManager = require('./brokers/mockBroker');
const { splitQuantityByFreeze, calculateOrderQuantity } = require('./scripMasterManager');
const { getISTInfo } = require('./niftyFeedManager');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');
const DEFAULT_DAILY_ORDERS_FILE = path.join(__dirname, '..', 'data', 'daily-orders.json');

function hasAccountCredentials(acc) {
  if (!acc) return false;
  if (acc.broker === 'dhan') return Boolean(acc.accessToken);
  if (acc.broker === 'angelone') return Boolean(acc.apiKey && acc.clientCode);
  if (acc.broker === 'sahi') return Boolean((acc.keyId && acc.secret) || acc.accessToken);
  return Boolean(acc.consumerKey && acc.ucc);
}

class MultiBrokerManager extends EventEmitter {
  constructor(configManager, options = {}) {
    super();
    this.configManager = configManager;
    this.scripMasterManager = options.scripMasterManager || null;
    this.dailyRiskGuardProvider = options.dailyRiskGuardProvider || null;
    this.dailyOrdersFile = options.dailyOrdersFile !== undefined ? options.dailyOrdersFile : DEFAULT_DAILY_ORDERS_FILE;
    this.brokerInstances = new Map();
    this.mockManager = new MockBrokerManager();
    this.dataFeedSource = 'kotakneo'; // 'kotakneo', 'angelone', 'dhan', or 'sahi'
    this._dailyOrdersState = { dateStr: '', count: 0 };

    this._ensureFile();
    this._loadDailyOrdersState();
    this.reloadBrokers();
  }

  setScripMasterManager(scripMasterManager) {
    this.scripMasterManager = scripMasterManager || null;
  }

  setDailyRiskGuardProvider(fn) {
    this.dailyRiskGuardProvider = typeof fn === 'function' ? fn : null;
  }

  _loadDailyOrdersState() {
    const today = getISTInfo().dateStr;
    this._dailyOrdersState = { dateStr: today, count: 0 };
    if (!this.dailyOrdersFile || !fs.existsSync(this.dailyOrdersFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dailyOrdersFile, 'utf8'));
      if (parsed && parsed.dateStr === today) {
        this._dailyOrdersState.count = Math.max(0, Math.round(Number(parsed.count || 0)));
      }
    } catch (e) {}
  }

  _saveDailyOrdersState() {
    if (!this.dailyOrdersFile) return;
    try {
      const dir = path.dirname(this.dailyOrdersFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dailyOrdersFile, JSON.stringify(this._dailyOrdersState, null, 2), 'utf8');
    } catch (e) {}
  }

  getDailyOrderCount() {
    const today = getISTInfo().dateStr;
    if (this._dailyOrdersState.dateStr !== today) {
      this._dailyOrdersState = { dateStr: today, count: 0 };
      this._saveDailyOrdersState();
    }
    return this._dailyOrdersState.count;
  }

  _incrementDailyOrderCount(by = 1) {
    const cur = this.getDailyOrderCount();
    this._dailyOrdersState.count = cur + Math.max(1, Math.round(Number(by || 1)));
    this._saveDailyOrdersState();
    return this._dailyOrdersState.count;
  }

  getDailyOrderStats() {
    const config = this.configManager.loadConfig() || {};
    const risk = config.riskSettings || {};
    const today = getISTInfo().dateStr;
    const ordersPlacedToday = this.getDailyOrderCount();
    const maxDailyOrders = Math.max(0, Math.round(Number(risk.maxDailyOrders || 0)));
    const remainingOrders = maxDailyOrders > 0 ? Math.max(0, maxDailyOrders - ordersPlacedToday) : null;
    const riskGuard = this.dailyRiskGuardProvider ? this.dailyRiskGuardProvider() : { blocked: false, reason: null };

    return {
      dateStr: today,
      ordersPlacedToday,
      maxDailyOrders,
      remainingOrders,
      capitalDeployPct: Math.max(1, Math.min(100, Number(risk.capitalDeployPct !== undefined ? risk.capitalDeployPct : 100))),
      orderRoutingMode: risk.orderRoutingMode === 'all_funded' ? 'all_funded' : 'selected',
      targetDailyNetProfitPct: Number(risk.targetDailyNetProfitPct || 0),
      maxDailyLossNetPct: Number(risk.maxDailyLossNetPct || 0),
      riskBlocked: Boolean(riskGuard && riskGuard.blocked),
      riskBlockedReason: (riskGuard && riskGuard.reason) || null
    };
  }

  _computeDeployableCash(funds = {}, risk = {}, overridePct = undefined) {
    const availableCash = Math.max(0, Number(funds.availableCash || 0));
    const utilizedMargin = Math.max(0, Number(funds.utilizedMargin || 0));
    const rawPct = overridePct !== undefined
      ? Number(overridePct)
      : (risk.capitalDeployPct !== undefined ? Number(risk.capitalDeployPct) : 100);
    const capitalDeployPct = Math.max(1, Math.min(100, Number.isFinite(rawPct) ? rawPct : 100));

    if (capitalDeployPct >= 100) {
      return { availableCash, utilizedMargin, capitalDeployPct: 100, deployBudget: availableCash };
    }
    const baseCapital = Math.max(availableCash, availableCash + utilizedMargin);
    const maxDayDeploy = Number((baseCapital * (capitalDeployPct / 100)).toFixed(2));
    const deployBudget = Number(Math.min(availableCash, Math.max(0, maxDayDeploy - utilizedMargin)).toFixed(2));
    return { availableCash, utilizedMargin, capitalDeployPct, deployBudget };
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

  _resolveBrokerInstance(accountId, brokerName) {
    if (accountId && this.brokerInstances.has(accountId)) {
      return this.brokerInstances.get(accountId);
    }
    if (brokerName) {
      for (const inst of this.brokerInstances.values()) {
        if (inst.broker === brokerName) return inst;
      }
    }
    for (const inst of this.brokerInstances.values()) {
      return inst;
    }
    return null;
  }

  async getAccountFunds(accountId, options = {}) {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      return await this.mockManager.getFunds();
    }
    const inst = this._resolveBrokerInstance(accountId);
    if (!inst) {
      return { availableCash: 0, utilizedMargin: 0, totalBalance: 0 };
    }
    return await inst.getFunds(options);
  }

  async _sizeForFunds(funds, params, spec, lotSize, freezeQty, risk) {
    const deployInfo = this._computeDeployableCash(funds, risk, params.allocationPct);
    const calc = calculateOrderQuantity({
      availableCash: deployInfo.deployBudget,
      price: Number(params.price || 0),
      triggerPrice: Number(params.triggerPrice || 0),
      ltp: Number(params.ltp || 0),
      orderType: params.orderType || 'MKT',
      transactionType: params.transactionType || 'B',
      lotSize,
      freezeQty,
      allocationPct: 100,
      bufferPct: params.bufferPct !== undefined ? Number(params.bufferPct) : 0
    });
    return {
      ...calc,
      availableCash: deployInfo.availableCash,
      utilizedMargin: deployInfo.utilizedMargin,
      capitalDeployPct: deployInfo.capitalDeployPct,
      usableCash: deployInfo.deployBudget
    };
  }

  _getCandidateAccountsForRouting(config) {
    if (config.mode === 'mock') {
      return (this.mockManager.accounts || []).map(acc => ({
        accountId: acc.id,
        broker: acc.broker,
        name: acc.name,
        isAuthenticated: true,
        isMock: true,
        getFunds: async () => acc.funds
      }));
    }
    return Array.from(this.brokerInstances.values());
  }

  async calculateOrderQuantityForAccount(params = {}) {
    const config = this.configManager.loadConfig() || {};
    const risk = config.riskSettings || {};
    const spec = this.scripMasterManager
      ? this.scripMasterManager.getContractSpec({
          symbol: params.tradingSymbol || params.symbol,
          underlying: params.underlying,
          exchangeSegment: params.exchangeSegment,
          instrumentToken: params.instrumentToken
        })
      : { lotSize: 1, freezeQty: 0 };

    const lotSize = Number(params.lotSize) > 0 ? Number(params.lotSize) : spec.lotSize;
    const freezeQty = params.freezeQty !== undefined && Number(params.freezeQty) >= 0
      ? Number(params.freezeQty)
      : spec.freezeQty;

    const funds = await this.getAccountFunds(params.accountId);
    const calc = await this._sizeForFunds(funds, params, spec, lotSize, freezeQty, risk);

    const routingMode = (params.routingMode || risk.orderRoutingMode || 'selected') === 'all_funded'
      ? 'all_funded'
      : 'selected';

    let eligibleBrokers = [];
    let skippedBrokers = [];
    if (routingMode === 'all_funded') {
      const candidates = this._getCandidateAccountsForRouting(config);
      for (const inst of candidates) {
        const accId = inst.id || inst.accountId;
        if (!inst.isMock && !inst.isAuthenticated) {
          skippedBrokers.push({
            accountId: accId,
            name: inst.name,
            broker: inst.broker,
            availableCash: 0,
            usableCash: 0,
            reason: 'Not authenticated'
          });
          continue;
        }
        let accFunds = { availableCash: 0, utilizedMargin: 0 };
        try {
          accFunds = await inst.getFunds();
        } catch (e) {}
        const accCalc = await this._sizeForFunds(accFunds, params, spec, lotSize, freezeQty, risk);
        if (accCalc.quantity >= lotSize) {
          eligibleBrokers.push({
            accountId: accId,
            name: inst.name,
            broker: inst.broker,
            availableCash: accCalc.availableCash,
            usableCash: accCalc.usableCash,
            quantity: accCalc.quantity,
            lots: accCalc.lots,
            estimatedCost: accCalc.estimatedCost,
            sliceCount: accCalc.sliceCount
          });
        } else {
          skippedBrokers.push({
            accountId: accId,
            name: inst.name,
            broker: inst.broker,
            availableCash: accCalc.availableCash,
            usableCash: accCalc.usableCash,
            reason: accCalc.price > 0
              ? `Insufficient deployable cash (₹${accCalc.usableCash.toFixed(0)} < 1 lot ₹${(lotSize * accCalc.price).toFixed(0)})`
              : 'No available funds'
          });
        }
      }
    }

    return {
      ...calc,
      routingMode,
      eligibleBrokers,
      skippedBrokers,
      dailyOrders: this.getDailyOrderStats(),
      symbol: spec.symbol || String(params.tradingSymbol || params.symbol || '').toUpperCase(),
      segment: spec.segment || params.exchangeSegment || 'NSE',
      specSource: spec.source || 'none'
    };
  }

  async _executeSingleAccountOrder(brokerInstance, isMock, orderData, spec, lotSize, freezeQty, risk) {
    let totalQuantity = Math.round(Number(orderData.quantity || 0));
    if (orderData.autoQuantity || !(totalQuantity > 0)) {
      const funds = isMock
        ? await this.mockManager.getFunds()
        : await brokerInstance.getFunds();
      const calc = await this._sizeForFunds(funds, orderData, spec, lotSize, freezeQty, risk);
      if (!(calc.quantity > 0)) {
        const minNeeded = (calc.lotSize * calc.price).toFixed(2);
        throw new Error(
          calc.price > 0
            ? `Insufficient deployable balance (₹${calc.usableCash.toFixed(2)}) for 1 lot (${calc.lotSize} × ₹${calc.price.toFixed(2)} = ₹${minNeeded})`
            : 'Price or LTP is required to calculate quantity automatically from balance'
        );
      }
      totalQuantity = calc.quantity;
    }

    const slices = splitQuantityByFreeze(totalQuantity, freezeQty, lotSize);
    if (slices.length === 0) {
      throw new Error('Order quantity must be greater than 0');
    }

    const sliceResults = [];
    for (let i = 0; i < slices.length; i++) {
      const sliceQty = slices[i];
      const payload = {
        accountId: orderData.accountId || (brokerInstance && (brokerInstance.id || brokerInstance.accountId)),
        tradingSymbol: orderData.tradingSymbol || orderData.symbol,
        exchangeSegment: orderData.exchangeSegment || spec.segment || 'nse_cm',
        transactionType: orderData.transactionType || 'B',
        orderType: orderData.orderType || 'MKT',
        quantity: sliceQty,
        price: orderData.price !== undefined ? orderData.price : 0,
        triggerPrice: orderData.triggerPrice !== undefined ? orderData.triggerPrice : 0,
        product: orderData.product || 'MIS',
        validity: orderData.validity || 'DAY',
        instrumentToken: orderData.instrumentToken
      };
      const res = isMock
        ? await this.mockManager.placeOrder(payload)
        : await brokerInstance.placeOrder(payload);
      sliceResults.push({
        sliceIndex: i + 1,
        quantity: sliceQty,
        orderId: res && res.orderId ? res.orderId : null,
        result: res
      });
    }

    const orderIds = sliceResults.map(s => s.orderId).filter(Boolean);
    return {
      success: true,
      orderId: orderIds[0] || null,
      orderIds,
      totalQuantity,
      lotSize,
      freezeQty,
      sliced: slices.length > 1,
      sliceCount: slices.length,
      slices: sliceResults
    };
  }

  /**
   * Place an order (supports auto-quantity sizing from deployable broker balance,
   * daily max-order/loss checks, selected vs all-funded routing, AND freeze-qty splitting).
   */
  async placeOrder(orderData = {}) {
    const config = this.configManager.loadConfig() || {};
    const risk = config.riskSettings || {};
    const isMock = config.mode === 'mock';
    const isExit = Boolean(orderData.isExit);

    if (!isExit) {
      if (this.dailyRiskGuardProvider) {
        const guard = this.dailyRiskGuardProvider();
        if (guard && guard.blocked) {
          throw new Error(`Order blocked: ${guard.reason || 'Daily P&L circuit breaker triggered'}`);
        }
      }
      const maxDailyOrders = Math.max(0, Math.round(Number(risk.maxDailyOrders || 0)));
      const usedToday = this.getDailyOrderCount();
      if (maxDailyOrders > 0 && usedToday >= maxDailyOrders) {
        throw new Error(`Daily max orders limit reached (${usedToday}/${maxDailyOrders} orders placed today).`);
      }
    }

    const spec = this.scripMasterManager
      ? this.scripMasterManager.getContractSpec({
          symbol: orderData.tradingSymbol || orderData.symbol,
          underlying: orderData.underlying,
          exchangeSegment: orderData.exchangeSegment,
          instrumentToken: orderData.instrumentToken
        })
      : { lotSize: 1, freezeQty: 0 };

    const lotSize = Number(orderData.lotSize) > 0 ? Math.round(Number(orderData.lotSize)) : spec.lotSize;
    const freezeQty = (orderData.freezeQty !== undefined && Number(orderData.freezeQty) >= 0)
      ? Math.round(Number(orderData.freezeQty))
      : spec.freezeQty;

    const routingMode = !isExit && ((orderData.routingMode || risk.orderRoutingMode || 'selected') === 'all_funded')
      ? 'all_funded'
      : 'selected';

    if (routingMode === 'selected') {
      const brokerInstance = this._resolveBrokerInstance(orderData.accountId, orderData.broker);
      if (!isMock && !brokerInstance) {
        throw new Error(`No active broker connection found for account ${orderData.accountId || orderData.broker || 'default'}`);
      }
      const res = await this._executeSingleAccountOrder(brokerInstance, isMock, orderData, spec, lotSize, freezeQty, risk);
      if (!isExit) this._incrementDailyOrderCount(1);
      return {
        ...res,
        routingMode: 'selected',
        dailyOrders: this.getDailyOrderStats()
      };
    }

    // All brokers having enough funds
    const candidates = this._getCandidateAccountsForRouting(config);
    const maxDailyOrders = Math.max(0, Math.round(Number(risk.maxDailyOrders || 0)));
    const requestedQty = Math.round(Number(orderData.quantity || 0));
    const useAuto = Boolean(orderData.autoQuantity || !(requestedQty > 0));

    const executedBrokers = [];
    const skippedBrokers = [];
    const allOrderIds = [];
    let grandTotalQty = 0;

    for (const inst of candidates) {
      const accId = inst.id || inst.accountId;
      if (!inst.isMock && !inst.isAuthenticated) {
        skippedBrokers.push({ accountId: accId, name: inst.name, broker: inst.broker, reason: 'Not authenticated' });
        continue;
      }

      if (maxDailyOrders > 0 && this.getDailyOrderCount() >= maxDailyOrders) {
        skippedBrokers.push({ accountId: accId, name: inst.name, broker: inst.broker, reason: `Max daily orders (${maxDailyOrders}) reached` });
        continue;
      }

      let funds = { availableCash: 0, utilizedMargin: 0 };
      try {
        funds = await inst.getFunds();
      } catch (e) {
        skippedBrokers.push({ accountId: accId, name: inst.name, broker: inst.broker, reason: e.message });
        continue;
      }

      const calc = await this._sizeForFunds(funds, orderData, spec, lotSize, freezeQty, risk);
      const qtyForBroker = useAuto ? calc.quantity : requestedQty;
      const requiredCapital = calc.price > 0 ? Number((qtyForBroker * calc.price).toFixed(2)) : 0;

      const hasEnoughFunds = useAuto
        ? (calc.quantity >= lotSize)
        : (calc.usableCash > 0 && (requiredCapital <= 0 || calc.usableCash >= requiredCapital));

      if (!hasEnoughFunds) {
        skippedBrokers.push({
          accountId: accId,
          name: inst.name,
          broker: inst.broker,
          availableCash: calc.availableCash,
          usableCash: calc.usableCash,
          reason: calc.price > 0
            ? `Insufficient deployable cash (₹${calc.usableCash.toFixed(2)} < needed ₹${(useAuto ? lotSize * calc.price : requiredCapital).toFixed(2)})`
            : 'Insufficient funds (₹0)'
        });
        continue;
      }

      const perBrokerOrder = { ...orderData, accountId: accId, autoQuantity: false, quantity: qtyForBroker };
      try {
        const res = await this._executeSingleAccountOrder(inst, isMock, perBrokerOrder, spec, lotSize, freezeQty, risk);
        this._incrementDailyOrderCount(1);
        grandTotalQty += res.totalQuantity;
        allOrderIds.push(...(res.orderIds || []));
        executedBrokers.push({
          accountId: accId,
          name: inst.name,
          broker: inst.broker,
          quantity: res.totalQuantity,
          orderId: res.orderId,
          orderIds: res.orderIds,
          sliced: res.sliced,
          sliceCount: res.sliceCount
        });
      } catch (err) {
        skippedBrokers.push({ accountId: accId, name: inst.name, broker: inst.broker, reason: err.message });
      }
    }

    if (executedBrokers.length === 0) {
      const reasons = skippedBrokers.map(s => `${s.name || s.accountId}: ${s.reason}`).join('; ');
      throw new Error(`No broker had enough deployable funds or order quota (${reasons || '0 eligible brokers'})`);
    }

    return {
      success: true,
      routingMode: 'all_funded',
      orderId: allOrderIds[0] || null,
      orderIds: allOrderIds,
      totalQuantity: grandTotalQty,
      lotSize,
      freezeQty,
      sliced: executedBrokers.some(b => b.sliced),
      sliceCount: executedBrokers.reduce((sum, b) => sum + Number(b.sliceCount || 1), 0),
      executedCount: executedBrokers.length,
      executedBrokers,
      skippedBrokers,
      dailyOrders: this.getDailyOrderStats()
    };
  }

  /**
   * Exit a specific position by dispatching to the exact broker account that owns it (auto-splits if > freeze quantity)
   */
  async exitPosition(position, reason = 'Auto-Exit') {
    const qty = Math.abs(Number(position.netQty || 0));
    if (!(qty > 0)) {
      throw new Error(`Position ${position.symbol} has zero net quantity`);
    }
    const oppositeSide = position.netQty > 0 ? 'S' : 'B';
    return await this.placeOrder({
      accountId: position.accountId,
      broker: position.broker,
      tradingSymbol: position.symbol,
      exchangeSegment: position.exchangeSegment || 'nse_cm',
      transactionType: oppositeSide,
      orderType: 'MKT',
      quantity: qty,
      price: '0',
      product: position.product,
      instrumentToken: position.instrumentToken,
      isExit: true,
      reason
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
        if (this.scripMasterManager) {
          for (const strikeRow of Object.values(chain.oc)) {
            for (const optKey of ['ce', 'pe']) {
              const leg = strikeRow && strikeRow[optKey];
              if (!leg) continue;
              const spec = this.scripMasterManager.getContractSpec({
                symbol: leg.symbol,
                underlying: 'NIFTY',
                exchangeSegment: 'NFO',
                instrumentToken: leg.instrumentToken
              });
              if (spec.lotSize > 0) leg.lotSize = spec.lotSize;
              if (spec.freezeQty > 0) leg.freezeQty = spec.freezeQty;
            }
          }
        }
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
