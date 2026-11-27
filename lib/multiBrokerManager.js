const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const KotakNeoBroker = require('./brokers/kotakNeoBroker');
const AngelOneBroker = require('./brokers/angelOneBroker');
const DhanBroker = require('./brokers/dhanBroker');
const SahiBroker = require('./brokers/sahiBroker');
const PaperBroker = require('./brokers/paperBroker');
const MockBrokerManager = require('./brokers/mockBroker');
const { splitQuantityByFreeze, calculateOrderQuantity } = require('./scripMasterManager');
const { getISTInfo, isPortfolioQuietHoursIST, getPortfolioScheduleStatus } = require('./niftyFeedManager');
const ChargesCalculator = require('./chargesCalculator');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');
const DEFAULT_DAILY_ORDERS_FILE = path.join(__dirname, '..', 'data', 'daily-orders.json');

function hasAccountCredentials(acc) {
  if (!acc) return false;
  if (acc.broker === 'paper') return true;
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
    this.openingBalanceProvider = options.openingBalanceProvider || null;
    this.dailyOrdersFile = options.dailyOrdersFile !== undefined ? options.dailyOrdersFile : DEFAULT_DAILY_ORDERS_FILE;
    this.enforceQuietHours = options.enforceQuietHours !== undefined ? Boolean(options.enforceQuietHours) : true;
    this.lastManualPortfolioFetchAt = null;
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

  setOpeningBalanceProvider(fn) {
    this.openingBalanceProvider = typeof fn === 'function' ? fn : null;
  }

  /**
   * Resolve the opening balance cap for quantity sizing (account-specific when captured, else global).
   */
  getAccountOpeningBalance(accountId = null) {
    const openBal = this.openingBalanceProvider ? this.openingBalanceProvider() : null;
    if (!openBal || typeof openBal !== 'object') return 0;

    const isManualOverride = !openBal.isAutoCaptured && String(openBal.timeFormatted || '').includes('Manual');
    const globalOpening = Math.max(0, Number(openBal.openingBalance || 0));
    if (isManualOverride && globalOpening > 0) {
      return globalOpening;
    }

    if (accountId && Array.isArray(openBal.accounts)) {
      const entry = openBal.accounts.find(a => a && a.id === accountId);
      if (entry) {
        const val = Number(entry.totalBalance || entry.availableCash || 0);
        if (val > 0) return val;
      }
    }

    if (accountId) {
      const inst = this.brokerInstances.get(accountId);
      if (inst && inst.isPaper && Number(inst.initialBalance || 0) > 0) {
        return Number(inst.initialBalance);
      }
    }

    return globalOpening;
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

  _computeDeployableCash(funds = {}, risk = {}, overridePct = undefined, openingBalanceCap = 0) {
    const availableCash = Math.max(0, Number(funds.availableCash || 0));
    const utilizedMargin = Math.max(0, Number(funds.utilizedMargin || 0));
    const openingBalance = Math.max(0, Number(openingBalanceCap || 0));
    const effectiveBalance = openingBalance > 0
      ? Math.min(availableCash, openingBalance)
      : availableCash;

    const rawPct = overridePct !== undefined
      ? Number(overridePct)
      : (risk.capitalDeployPct !== undefined ? Number(risk.capitalDeployPct) : 100);
    const capitalDeployPct = Math.max(1, Math.min(100, Number.isFinite(rawPct) ? rawPct : 100));

    if (capitalDeployPct >= 100) {
      return {
        availableCash,
        openingBalance,
        effectiveBalance,
        utilizedMargin,
        capitalDeployPct: 100,
        deployBudget: Number(effectiveBalance.toFixed(2))
      };
    }
    const rawTotal = Math.max(availableCash, availableCash + utilizedMargin);
    const baseCapital = openingBalance > 0 ? Math.min(openingBalance, rawTotal) : rawTotal;
    const maxDayDeploy = Number((baseCapital * (capitalDeployPct / 100)).toFixed(2));
    const deployBudget = Number(Math.min(effectiveBalance, Math.max(0, maxDayDeploy - utilizedMargin)).toFixed(2));
    return { availableCash, openingBalance, effectiveBalance, utilizedMargin, capitalDeployPct, deployBudget };
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
      } else if (acc.broker === 'paper') {
        instance = new PaperBroker({ ...acc, isMock: false });
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
      const defaultBrk = acc.broker === 'kotakneo' ? 0 : 20;
      const brokeragePerOrder = acc.brokeragePerOrder !== undefined && acc.brokeragePerOrder !== ''
        ? Number(acc.brokeragePerOrder)
        : (acc.brokerageType === 'zero' ? 0 : defaultBrk);
      return {
        id: acc.id,
        broker: acc.broker,
        name: acc.name,
        enabled: acc.enabled,
        isPaper: acc.broker === 'paper',
        initialBalance: acc.broker === 'paper' ? Number(acc.initialBalance || 500000) : undefined,
        brokerageType: acc.brokerageType || (brokeragePerOrder === 0 ? 'zero' : 'flat'),
        brokeragePerOrder,
        optionsBrokerage: acc.optionsBrokerage !== undefined ? acc.optionsBrokerage : '',
        targetNetProfitPct: acc.targetNetProfitPct !== undefined && acc.targetNetProfitPct !== ''
          ? Number(acc.targetNetProfitPct)
          : undefined,
        stopLossNetPct: acc.stopLossNetPct !== undefined && acc.stopLossNetPct !== ''
          ? Number(acc.stopLossNetPct)
          : undefined,
        nearThresholdBufferPct: acc.nearThresholdBufferPct !== undefined && acc.nearThresholdBufferPct !== ''
          ? Number(acc.nearThresholdBufferPct)
          : undefined,
        mobileNumber: acc.mobileNumber || '',
        ucc: acc.ucc || '',
        clientCode: (instance && instance.userId) || acc.ucc || acc.clientCode || acc.clientId || acc.keyId || (acc.broker === 'paper' ? 'PAPER' : ''),
        clientId: acc.clientId || '',
        keyId: acc.keyId || '',
        hasCredentials: hasAccountCredentials(acc),
        isAuthenticated: instance ? instance.isAuthenticated : false,
        lastError: instance ? (instance.lastError || null) : null
      };
    });
  }

  getAccountRiskSettings(accountId) {
    const config = this.configManager.loadConfig() || {};
    const globalRisk = config.riskSettings || {};
    const raw = this.getRawAccounts();
    const acc = raw.find(a => a.id === accountId) || {};
    const targetNetProfitPct = acc.targetNetProfitPct !== undefined && acc.targetNetProfitPct !== ''
      ? Math.max(0, Number(acc.targetNetProfitPct))
      : Math.max(0, Number(globalRisk.targetDailyNetProfitPct || 0));
    const stopLossNetPct = acc.stopLossNetPct !== undefined && acc.stopLossNetPct !== ''
      ? Math.max(0, Number(acc.stopLossNetPct))
      : Math.max(0, Number(globalRisk.maxDailyLossNetPct || 0));
    const nearThresholdBufferPct = acc.nearThresholdBufferPct !== undefined && acc.nearThresholdBufferPct !== ''
      ? Math.max(50, Math.min(100, Number(acc.nearThresholdBufferPct)))
      : Math.max(50, Math.min(100, Number(globalRisk.nearThresholdBufferPct || 100)));

    return {
      accountId: acc.id || accountId,
      targetNetProfitPct,
      stopLossNetPct,
      nearThresholdBufferPct,
      autoExitEnabled: Boolean(globalRisk.autoExitEnabled !== false)
    };
  }

  syncPaperPositions(snapshot) {
    if (!snapshot) return;
    for (const inst of this.brokerInstances.values()) {
      if (inst && inst.isPaper && typeof inst.syncWithNiftySnapshot === 'function') {
        inst.syncWithNiftySnapshot(snapshot);
      }
    }
  }

  resetPaperAccount(accountId, newBalance = null) {
    const inst = this.brokerInstances.get(accountId);
    if (!inst || !inst.isPaper || typeof inst.reset !== 'function') {
      throw new Error(`Paper trading account ${accountId} not found or inactive`);
    }
    if (newBalance !== null && Number(newBalance) >= 1000) {
      this.updateAccount(accountId, { initialBalance: Number(newBalance) });
    }
    return inst.reset(newBalance);
  }

  getAccountBrokerage(accountId, brokerType = null) {
    const raw = this.getRawAccounts();
    const acc = raw.find(a => a.id === accountId) || (brokerType ? raw.find(a => a.broker === brokerType) : null);
    if (!acc) {
      const defaultRate = brokerType === 'kotakneo' ? 0 : 20;
      return { brokerageType: defaultRate === 0 ? 'zero' : 'flat', brokeragePerOrder: defaultRate };
    }
    const defaultRate = acc.broker === 'kotakneo' ? 0 : 20;
    const brokeragePerOrder = acc.brokeragePerOrder !== undefined && acc.brokeragePerOrder !== ''
      ? Number(acc.brokeragePerOrder)
      : (acc.brokerageType === 'zero' ? 0 : defaultRate);

    return {
      brokerageType: acc.brokerageType || (brokeragePerOrder === 0 ? 'zero' : 'flat'),
      brokeragePerOrder,
      optionsBrokerage: acc.optionsBrokerage
    };
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
    const secretFields = ['mpin', 'password', 'secret', 'accessToken', 'totpSecret', 'consumerKey', 'apiKey'];
    const cleaned = { ...persistentData };
    for (const field of secretFields) {
      if (cleaned[field] === '' || cleaned[field] === undefined) {
        delete cleaned[field];
      }
    }

    raw[idx] = {
      ...raw[idx],
      ...cleaned,
      id
    };
    this.saveRawAccounts(raw);
    return raw[idx];
  }

  deleteAccount(id) {
    const inst = this.brokerInstances.get(id);
    if (inst && inst.isPaper && typeof inst.deleteStateFile === 'function') {
      inst.deleteStateFile();
    }
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

  isPortfolioQuietHours(now = new Date()) {
    if (!this.enforceQuietHours) return false;
    return isPortfolioQuietHoursIST(now);
  }

  getPortfolioSchedule(now = new Date()) {
    return {
      ...getPortfolioScheduleStatus(now),
      lastManualFetchAt: this.lastManualPortfolioFetchAt
    };
  }

  _shouldSkipAutoFetch(options = {}) {
    if (options && options.manual) return false;
    return this.isPortfolioQuietHours(options && options.now ? options.now : new Date());
  }

  _getCachedBrokerList(broker, cacheKey) {
    const entry = broker && broker._cache && broker._cache[cacheKey];
    return Array.isArray(entry && entry.data) ? entry.data : [];
  }

  _getCachedBrokerFunds(broker) {
    const entry = broker && broker._cache && broker._cache.funds;
    const d = entry && entry.data;
    if (d && typeof d === 'object') {
      return {
        availableCash: Number(d.availableCash || 0),
        utilizedMargin: Number(d.utilizedMargin || 0),
        totalBalance: Number(d.totalBalance || 0)
      };
    }
    return { availableCash: 0, utilizedMargin: 0, totalBalance: 0 };
  }

  /**
   * Auto-login all enabled broker accounts sequentially (used at 8:59 AM IST or manual trigger)
   */
  async loginAllBrokers(options = {}) {
    const skipPortfolioFetch = options.skipPortfolioFetch !== undefined
      ? Boolean(options.skipPortfolioFetch)
      : this.isPortfolioQuietHours(options.now || new Date());
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
        const res = await instance.login(null, { skipPortfolioFetch });
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
        const canFeed = !instance.isPaper && instance.broker !== 'paper';
        if (canFeed) {
          this.setDataFeedSource(instance.broker);
        }
        return {
          authenticated: true,
          subscribed: canFeed,
          message: res.message,
          accountId: id,
          broker: instance.broker,
          accountName: instance.name,
          isMock: instance.isMock,
          isPaper: Boolean(instance.isPaper),
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
   * Fetch aggregated real-time positions from all connected active brokers.
   * Between 4:00 PM and 9:00 AM IST, returns cached positions unless options.manual is true.
   */
  async getAllPositions(options = {}) {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      return await this.mockManager.getPositions();
    }

    const skipFetch = this._shouldSkipAutoFetch(options);
    const all = [];
    for (const [id, broker] of this.brokerInstances.entries()) {
      if (skipFetch) {
        all.push(...this._getCachedBrokerList(broker, 'positions'));
        continue;
      }
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
   * Fetch aggregated holdings across all active broker accounts.
   * Between 4:00 PM and 9:00 AM IST, returns cached holdings unless options.manual is true.
   */
  async getAllHoldings(options = {}) {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      return [];
    }

    const skipFetch = this._shouldSkipAutoFetch(options);
    const all = [];
    for (const [id, broker] of this.brokerInstances.entries()) {
      if (skipFetch) {
        all.push(...this._getCachedBrokerList(broker, 'holdings'));
        continue;
      }
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
   * Fetch total funds across all active broker accounts.
   * Between 4:00 PM and 9:00 AM IST, returns cached funds unless options.manual is true.
   */
  async getAllFunds(options = {}) {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      return await this.mockManager.getFunds();
    }

    const skipFetch = this._shouldSkipAutoFetch(options);
    let totalAvailableCash = 0;
    let totalUtilizedMargin = 0;
    let totalBalance = 0;
    const accountBreakdown = [];

    for (const [id, broker] of this.brokerInstances.entries()) {
      if (skipFetch) {
        const cached = this._getCachedBrokerFunds(broker);
        totalAvailableCash += cached.availableCash;
        totalUtilizedMargin += cached.utilizedMargin;
        totalBalance += cached.totalBalance;
        accountBreakdown.push({
          id,
          broker: broker.broker,
          name: broker.name,
          availableCash: cached.availableCash,
          utilizedMargin: cached.utilizedMargin,
          totalBalance: cached.totalBalance,
          cachedOnly: true
        });
        continue;
      }
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
      quietHoursPaused: skipFetch,
      accounts: accountBreakdown
    };
  }

  /**
   * Fetch aggregated order book from all active accounts.
   * Between 4:00 PM and 9:00 AM IST, returns cached order book unless options.manual is true.
   */
  async getAllOrders(options = {}) {
    const config = this.configManager.loadConfig();
    if (config.mode === 'mock') {
      return await this.mockManager.getOrderBook();
    }

    const skipFetch = this._shouldSkipAutoFetch(options);
    const all = [];
    for (const [id, broker] of this.brokerInstances.entries()) {
      if (skipFetch) {
        all.push(...this._getCachedBrokerList(broker, 'orders'));
        continue;
      }
      try {
        const orders = await broker.getOrderBook(options);
        all.push(...orders);
      } catch (err) {}
    }
    return all;
  }

  /**
   * Explicit manual refresh across all brokers for positions, funds, holdings, and orders.
   */
  async fetchAllPortfolioManual() {
    const opts = { force: true, manual: true };
    const [positions, funds, holdings, orders] = await Promise.all([
      this.getAllPositions(opts),
      this.getAllFunds(opts),
      this.getAllHoldings(opts),
      this.getAllOrders(opts)
    ]);
    this.lastManualPortfolioFetchAt = new Date().toISOString();
    return {
      fetchedAt: this.lastManualPortfolioFetchAt,
      portfolioSchedule: this.getPortfolioSchedule(),
      positions,
      funds,
      holdings,
      orders
    };
  }

  /**
   * Return executed orders matching an account (and optional symbol) from mock or live/paper cache.
   */
  getExecutedOrders(accountId, symbol = null) {
    const config = this.configManager.loadConfig();
    let orders = [];
    if (config.mode === 'mock') {
      orders = this.mockManager.orders || [];
    } else if (accountId) {
      const inst = this.brokerInstances.get(accountId);
      orders = this._getCachedBrokerList(inst, 'orders');
    } else {
      for (const inst of this.brokerInstances.values()) {
        orders.push(...this._getCachedBrokerList(inst, 'orders'));
      }
    }

    const targetSym = symbol ? String(symbol).trim().toUpperCase() : null;
    return orders.filter(o => {
      if (accountId && o.accountId && o.accountId !== accountId) return false;
      if (targetSym && String(o.symbol || '').trim().toUpperCase() !== targetSym) return false;
      return ChargesCalculator.isExecutedOrder(o);
    });
  }

  getExecutedOrderCount(accountId, symbol) {
    if (!symbol) return 0;
    return this.getExecutedOrders(accountId, symbol).length;
  }

  /**
   * Enrich broker positions with brokerage & statutory charges derived from executed orders.
   */
  enrichPositionsWithCharges(positions = [], openingBalance = 500000, chargeSettings = {}) {
    const bal = Number(openingBalance || 500000);
    return (Array.isArray(positions) ? positions : []).map(pos => {
      const brokerPref = this.getAccountBrokerage(pos.accountId, pos.broker);
      const executedOrders = this.getExecutedOrders(pos.accountId, pos.symbol);
      const chargeInfo = ChargesCalculator.calculatePositionCharges(
        pos,
        brokerPref,
        chargeSettings,
        executedOrders
      );
      const netProfitPctOfCapital = bal > 0
        ? Number(((chargeInfo.netPnl / bal) * 100).toFixed(2))
        : 0;

      return {
        ...pos,
        chargeDetails: chargeInfo,
        grossPnl: chargeInfo.grossPnl,
        totalCharges: chargeInfo.totalCharges,
        netPnl: chargeInfo.netPnl,
        netProfitPctOfCapital
      };
    });
  }

  /**
   * Attach per-trade charge breakdown to each executed order.
   */
  enrichOrdersWithCharges(orders = [], chargeSettings = {}) {
    return (Array.isArray(orders) ? orders : []).map(ord => {
      if (!ChargesCalculator.isExecutedOrder(ord)) {
        return ord;
      }
      const brokerPref = this.getAccountBrokerage(ord.accountId, ord.broker);
      const chargeDetails = ChargesCalculator.calculateChargesFromOrders([ord], brokerPref, chargeSettings);
      return {
        ...ord,
        chargeDetails
      };
    });
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
    if (this._shouldSkipAutoFetch(options)) {
      return this._getCachedBrokerFunds(inst);
    }
    return await inst.getFunds(options);
  }

  async _sizeForFunds(funds, params, spec, lotSize, freezeQty, risk, accountId = null) {
    const openingCap = this.getAccountOpeningBalance(accountId);
    const deployInfo = this._computeDeployableCash(funds, risk, params.allocationPct, openingCap);
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
      openingBalance: deployInfo.openingBalance,
      effectiveBalance: deployInfo.effectiveBalance,
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

    const funds = await this.getAccountFunds(params.accountId, { manual: Boolean(params.manual) });
    const calc = await this._sizeForFunds(funds, params, spec, lotSize, freezeQty, risk, params.accountId);

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
          if (this._shouldSkipAutoFetch(params)) {
            accFunds = this._getCachedBrokerFunds(inst);
          } else {
            accFunds = await inst.getFunds();
          }
        } catch (e) {}
        const accCalc = await this._sizeForFunds(accFunds, params, spec, lotSize, freezeQty, risk, accId);
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
      const sizingAccountId = orderData.accountId || (brokerInstance && (brokerInstance.id || brokerInstance.accountId));
      const calc = await this._sizeForFunds(funds, orderData, spec, lotSize, freezeQty, risk, sizingAccountId);
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
      if (!isExit && this.dailyRiskGuardProvider) {
        const targetId = (brokerInstance && brokerInstance.id) || orderData.accountId;
        const guard = this.dailyRiskGuardProvider(targetId);
        if (guard && guard.blocked) {
          throw new Error(`Order blocked for account ${targetId}: ${guard.reason || 'Daily SL/Target triggered'}`);
        }
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

      if (this.dailyRiskGuardProvider) {
        const guard = this.dailyRiskGuardProvider(accId);
        if (guard && guard.blocked) {
          skippedBrokers.push({ accountId: accId, name: inst.name, broker: inst.broker, reason: guard.reason || 'Account SL/Target reached' });
          continue;
        }
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

      const calc = await this._sizeForFunds(funds, orderData, spec, lotSize, freezeQty, risk, accId);
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
   * Resolve contract lot size for a position using ScripMasterManager (defaults to 65 for NIFTY options).
   */
  getPositionLotSize(position = {}) {
    if (this.scripMasterManager) {
      const spec = this.scripMasterManager.getContractSpec({
        symbol: position.symbol || position.tradingSymbol,
        exchangeSegment: position.exchangeSegment,
        instrumentToken: position.instrumentToken
      });
      if (spec && Number(spec.lotSize) > 0) return Math.round(Number(spec.lotSize));
    }
    const sym = String(position.symbol || '').toUpperCase();
    if (sym.includes('NIFTY') && !sym.includes('BANKNIFTY') && !sym.includes('MIDCPNIFTY')) {
      return 65;
    }
    return 1;
  }

  /**
   * Cancel one or more open orders cleanly (best-effort across brokers).
   */
  async cancelOrders(accountId, brokerName, orderIds = []) {
    const config = this.configManager.loadConfig() || {};
    const isMock = config.mode === 'mock';
    const inst = isMock ? null : this._resolveBrokerInstance(accountId, brokerName);
    const list = Array.isArray(orderIds) ? orderIds.filter(Boolean) : [];
    for (const oid of list) {
      try {
        if (isMock) await this.mockManager.cancelOrder(oid);
        else if (inst && typeof inst.cancelOrder === 'function') await inst.cancelOrder(oid);
      } catch (e) {}
    }
  }

  /**
   * Cancel ALL open/pending orders for a given account + symbol (used at 150% target before placing 125% SL).
   */
  async cancelAllPendingOrdersForPosition(accountId, brokerName, symbol, extraOrderIds = []) {
    const config = this.configManager.loadConfig() || {};
    const isMock = config.mode === 'mock';
    const inst = isMock ? null : this._resolveBrokerInstance(accountId, brokerName);

    let orders = [];
    try {
      if (isMock) {
        orders = await this.mockManager.getOrderBook();
      } else if (inst && typeof inst.getOrderBook === 'function') {
        orders = await inst.getOrderBook({ force: true });
      }
    } catch (e) {
      if (inst) orders = this._getCachedBrokerList(inst, 'orders');
    }

    const FINAL_STATUSES = new Set([
      'COMPLETE', 'COMPLETED', 'TRADED', 'FILLED', 'EXECUTED',
      'CANCELLED', 'CANCELED', 'REJECTED', 'FAILED'
    ]);
    const targetSym = String(symbol || '').trim().toUpperCase();
    const idsToCancel = new Set(Array.isArray(extraOrderIds) ? extraOrderIds.filter(Boolean).map(String) : []);

    for (const ord of (Array.isArray(orders) ? orders : [])) {
      if (!ord) continue;
      const oid = String(ord.orderId || ord.ordNo || ord.nOrdNo || ord.order_id || '').trim();
      if (!oid) continue;
      if (ord.accountId && accountId && String(ord.accountId) !== String(accountId)) continue;
      const ordSym = String(ord.symbol || ord.tradingSymbol || '').trim().toUpperCase();
      if (targetSym && ordSym && ordSym !== targetSym) continue;
      const status = String(ord.status || '').trim().toUpperCase();
      if (status && FINAL_STATUSES.has(status)) continue;
      idsToCancel.add(oid);
    }

    const list = Array.from(idsToCancel);
    if (list.length > 0) {
      await this.cancelOrders(accountId, brokerName, list);
    }
    return { cancelledIds: list };
  }

  /**
   * Modify an existing pending order in-place when supported (single order + broker modifyOrder),
   * otherwise cancel existing order(s) and place the updated order.
   */
  async modifyOrReplaceOrder({ accountId, broker, orderIds = [], replacementOrder }) {
    const config = this.configManager.loadConfig() || {};
    const isMock = config.mode === 'mock';
    const inst = isMock ? null : this._resolveBrokerInstance(accountId, broker);
    const ids = Array.isArray(orderIds) ? orderIds.filter(Boolean) : [];

    if (ids.length === 1) {
      const targetHandler = isMock ? this.mockManager : inst;
      if (targetHandler && typeof targetHandler.modifyOrder === 'function') {
        try {
          const modRes = await targetHandler.modifyOrder({
            ...replacementOrder,
            orderId: ids[0]
          });
          if (modRes && modRes.success) {
            return { success: true, orderId: ids[0], orderIds: [ids[0]], modified: true };
          }
        } catch (e) {
          // Fall through to cancel + place replacement
        }
      }
    }

    await this.cancelOrders(accountId, broker, ids);
    return await this.placeOrder({
      ...replacementOrder,
      accountId,
      broker,
      isExit: true
    });
  }

  /**
   * Exit a specific position by dispatching to the exact broker account that owns it (auto-splits if > freeze quantity)
   */
  async exitPosition(position, reason = 'Auto-Exit', overrideQuantity = null) {
    const netAbs = Math.abs(Number(position.netQty || 0));
    const qty = overrideQuantity !== null && overrideQuantity !== undefined
      ? Math.min(netAbs, Math.round(Number(overrideQuantity)))
      : netAbs;
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
