const EventEmitter = require('events');
const ChargesCalculator = require('./chargesCalculator');
const { getISTInfo, isPortfolioQuietHoursIST } = require('./niftyFeedManager');

/**
 * Algo Auto-Exit Engine (Multi-Broker & Net Profit % Aware)
 * Evaluates open positions and overall portfolio net profit % based on:
 * - Opening Balance captured at 9:00 AM IST
 * - Full Indian Brokerage & Statutory Taxes (STT, Exchange Txn, SEBI, GST, Stamp Duty)
 * - Net Profit % = (Gross P&L - All Charges) / Opening Balance * 100
 * - Triggers exit orders when net profit % is near or above the target threshold.
 */
class AutoExitEngine extends EventEmitter {
  constructor(multiBrokerManager, openingBalanceScheduler, configManager) {
    super();
    this.multiBrokerManager = multiBrokerManager;
    this.openingBalanceScheduler = openingBalanceScheduler;
    this.configManager = configManager;

    // Per-position rules map: key is `${accountId}_${symbol}_${product}`
    this.positionRules = new Map();

    // Per-position staged target SL & trailing state: key is `${accountId}_${symbol}_${product}`
    this.targetStates = new Map();

    // Audit logs for execution trail
    this.auditLogs = [];
    this.maxLogs = 200;

    // Monitoring state
    this.isRunning = false;
    this.pollIntervalMs = 1200;
    this.timer = null;

    // State guards to prevent duplicate exit order placement
    this.exitingPositions = new Set();

    // Per-account daily net profit target / max loss guard keyed by accountId
    this.dailyBreaker = { dateStr: '', reason: null, overallNetProfitPct: 0, totalNetPnl: 0 };
    this.accountBreakers = new Map();

    // Optional confirmation gate (used by web server so algo orders ask UI confirmation + bell sound first)
    this.orderExecutorGate = null;
  }

  setOrderExecutorGate(fn) {
    this.orderExecutorGate = typeof fn === 'function' ? fn : null;
  }

  async _dispatchBrokerAction({ dedupeKey, summary, executeFn }) {
    if (!this.orderExecutorGate) {
      return await executeFn();
    }
    return await this.orderExecutorGate({ dedupeKey, summary, executeFn });
  }

  clearDailyBreaker(accountId = null) {
    const today = getISTInfo().dateStr;
    if (accountId) {
      this.accountBreakers.delete(accountId);
      return;
    }
    this.accountBreakers.clear();
    this.dailyBreaker = { dateStr: today, reason: null, overallNetProfitPct: 0, totalNetPnl: 0 };
  }

  clearAccountBreaker(accountId) {
    if (accountId) this.accountBreakers.delete(accountId);
  }

  getDailyRiskGuardStatus(accountId = null) {
    const today = getISTInfo().dateStr;
    if (accountId) {
      const accB = this.accountBreakers.get(accountId);
      if (!accB || accB.dateStr !== today) {
        return { dateStr: today, accountId, blocked: false, reason: null, netProfitPct: 0, netPnl: 0 };
      }
      return {
        dateStr: today,
        accountId,
        blocked: Boolean(accB.reason),
        reason: accB.reason,
        netProfitPct: accB.netProfitPct || 0,
        netPnl: accB.netPnl || 0
      };
    }
    if (this.dailyBreaker.dateStr !== today) {
      return { dateStr: today, blocked: false, reason: null, overallNetProfitPct: 0, totalNetPnl: 0 };
    }
    return {
      dateStr: today,
      blocked: Boolean(this.dailyBreaker.reason),
      reason: this.dailyBreaker.reason,
      overallNetProfitPct: this.dailyBreaker.overallNetProfitPct || 0,
      totalNetPnl: this.dailyBreaker.totalNetPnl || 0
    };
  }

  log(type, message, details = null) {
    const entry = {
      id: 'LOG-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      timestamp: new Date().toISOString(),
      timeFormatted: new Date().toLocaleTimeString(),
      type, // 'INFO' | 'TRIGGER' | 'EXIT' | 'ALERT' | 'ERROR'
      message,
      details
    };
    this.auditLogs.unshift(entry);
    if (this.auditLogs.length > this.maxLogs) {
      this.auditLogs.pop();
    }
    this.emit('log', entry);
    return entry;
  }

  getAuditLogs() {
    return this.auditLogs;
  }

  /**
   * Set or update exit rules for a specific position
   */
  setPositionRule(accountId, symbol, product, rules = {}) {
    const key = `${accountId || 'any'}_${symbol}_${product || 'MIS'}`;
    const current = this.positionRules.get(key) || {};
    const updated = {
      ...current,
      accountId: accountId || 'any',
      symbol,
      product: product || 'MIS',
      // Net Profit % of Opening Balance target (e.g. 1.5%)
      targetNetProfitPct: rules.targetNetProfitPct !== undefined ? Number(rules.targetNetProfitPct) : current.targetNetProfitPct,
      // Stop Loss Net % of Opening Balance (e.g. -1.0%)
      stopLossNetPct: rules.stopLossNetPct !== undefined ? Number(rules.stopLossNetPct) : current.stopLossNetPct,
      // Near threshold buffer: e.g. 98% of target triggers exit, or 100% exact
      nearThresholdBufferPct: rules.nearThresholdBufferPct !== undefined ? Number(rules.nearThresholdBufferPct) : (current.nearThresholdBufferPct || 100),
      // Absolute Net Profit INR target
      targetNetProfitINR: rules.targetNetProfitINR !== undefined ? Number(rules.targetNetProfitINR) : current.targetNetProfitINR,
      // Absolute Net Stop Loss INR
      stopLossNetINR: rules.stopLossNetINR !== undefined ? Number(rules.stopLossNetINR) : current.stopLossNetINR,
      // Trailing SL points
      trailingSLPoints: rules.trailingSLPoints !== undefined ? Number(rules.trailingSLPoints) : current.trailingSLPoints,
      enabled: rules.enabled !== undefined ? Boolean(rules.enabled) : (current.enabled !== undefined ? current.enabled : true),
      peakLtp: current.peakLtp || null,
      updatedAt: new Date().toISOString()
    };

    this.positionRules.set(key, updated);
    this.log('INFO', `Updated Net Profit % Auto-Exit rules for ${symbol} (${product})`, updated);
    this.emit('rule_updated', { key, rules: updated });
    return updated;
  }

  removePositionRule(accountId, symbol, product) {
    const key = `${accountId || 'any'}_${symbol}_${product || 'MIS'}`;
    const deleted = this.positionRules.delete(key);
    if (deleted) {
      this.log('INFO', `Removed Auto-Exit rule for ${symbol}`);
      this.emit('rule_removed', { key });
    }
    return deleted;
  }

  getAllPositionRules() {
    const rulesObj = {};
    for (const [k, v] of this.positionRules.entries()) {
      rulesObj[k] = v;
    }
    return rulesObj;
  }

  getAllTargetStates() {
    const obj = {};
    for (const [k, v] of this.targetStates.entries()) {
      obj[k] = { ...v };
    }
    return obj;
  }

  _roundToTick(val, tick = 0.05) {
    const n = Number(val || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Number((Math.round(n / tick) * tick).toFixed(2));
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log('INFO', 'Auto-Exit Engine started with Net Profit & Charges calculation.');
    this._runLoop();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log('INFO', 'Auto-Exit Engine paused.');
  }

  _runLoop() {
    if (!this.isRunning) return;

    this._evaluatePositions()
      .catch(err => {
        this.log('ERROR', `Auto-Exit evaluation cycle error: ${err.message}`);
      })
      .finally(() => {
        if (this.isRunning) {
          this.timer = setTimeout(() => this._runLoop(), this.pollIntervalMs);
        }
      });
  }

  /**
   * Main Evaluation Cycle across all multi-broker positions
   */
  async _evaluatePositions() {
    if (isPortfolioQuietHoursIST() && !this.allowQuietHoursEval) {
      return;
    }
    const config = this.configManager.loadConfig();
    const risk = config.riskSettings || {};

    const openBalData = this.openingBalanceScheduler.getOpeningBalanceData();
    const openingBalance = Number(openBalData.openingBalance || 500000);

    let positions = [];
    try {
      positions = await this.multiBrokerManager.getAllPositions();
    } catch (err) {
      return;
    }

    if (!Array.isArray(positions)) return;

    // Calculate charges and Net P&L for every position
    let totalGrossPnl = 0;
    let totalEstimatedCharges = 0;
    let totalNetPnl = 0;

    const chargeSettings = config.chargeSettings || {};
    const enrichedPositions = typeof this.multiBrokerManager.enrichPositionsWithCharges === 'function'
      ? this.multiBrokerManager.enrichPositionsWithCharges(positions, openingBalance, chargeSettings)
      : positions.map(pos => {
          const brokerPref = this.multiBrokerManager.getAccountBrokerage(pos.accountId, pos.broker);
          const executedOrders = typeof this.multiBrokerManager.getExecutedOrders === 'function'
            ? this.multiBrokerManager.getExecutedOrders(pos.accountId, pos.symbol)
            : [];
          const chargeInfo = ChargesCalculator.calculatePositionCharges(pos, brokerPref, chargeSettings, executedOrders);
          const netProfitPctOfCapital = openingBalance > 0
            ? Number(((chargeInfo.netPnl / openingBalance) * 100).toFixed(2))
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

    for (const pos of enrichedPositions) {
      totalGrossPnl += Number(pos.grossPnl || 0);
      totalEstimatedCharges += Number(pos.totalCharges || 0);
      totalNetPnl += Number(pos.netPnl || 0);
    }

    const openPositions = enrichedPositions.filter(p => p.isOpen && p.netQty !== 0);
    const today = getISTInfo().dateStr;

    // 1. Per-Account Net Profit Target % & Max Loss % Circuit Breakers (instead of global)
    if (risk.autoExitEnabled) {
      const byAccount = new Map();
      for (const pos of enrichedPositions) {
        const accKey = pos.accountId || 'default';
        if (!byAccount.has(accKey)) byAccount.set(accKey, []);
        byAccount.get(accKey).push(pos);
      }

      const openBalAccounts = Array.isArray(openBalData.accounts) ? openBalData.accounts : [];
      for (const [accId, accPositions] of byAccount.entries()) {
        const accOpen = accPositions.filter(p => p.isOpen && p.netQty !== 0);
        const accGross = accPositions.reduce((s, p) => s + Number(p.grossPnl || 0), 0);
        const accCharges = accPositions.reduce((s, p) => s + Number(p.totalCharges || 0), 0);
        const accNetPnl = accPositions.reduce((s, p) => s + Number(p.netPnl || 0), 0);

        const openEntry = openBalAccounts.find(a => a.id === accId);
        let accCapital = openEntry ? Number(openEntry.totalBalance || openEntry.availableCash || 0) : 0;
        if (!(accCapital > 0) && typeof this.multiBrokerManager._getCachedBrokerFunds === 'function') {
          const inst = this.multiBrokerManager.brokerInstances && this.multiBrokerManager.brokerInstances.get(accId);
          if (inst) {
            const cf = this.multiBrokerManager._getCachedBrokerFunds(inst);
            accCapital = Number(cf.totalBalance || cf.availableCash || inst.initialBalance || 0);
          }
        }
        if (!(accCapital > 0)) accCapital = openingBalance;

        const accNetPct = accCapital > 0 ? Number(((accNetPnl / accCapital) * 100).toFixed(2)) : 0;
        const accRisk = typeof this.multiBrokerManager.getAccountRiskSettings === 'function'
          ? this.multiBrokerManager.getAccountRiskSettings(accId)
          : {
              targetNetProfitPct: Number(risk.targetDailyNetProfitPct || 0),
              stopLossNetPct: Number(risk.maxDailyLossNetPct || 0),
              nearThresholdBufferPct: Number(risk.nearThresholdBufferPct || 100)
            };

        const accName = (accPositions[0] && (accPositions[0].brokerName || accPositions[0].broker)) || accId;
        const nearFactor = Math.max(50, Math.min(100, Number(accRisk.nearThresholdBufferPct || 100))) / 100;
        const effTargetPct = Number((accRisk.targetNetProfitPct * nearFactor).toFixed(4));

        if (accRisk.targetNetProfitPct > 0 && accNetPct >= effTargetPct) {
          this.accountBreakers.set(accId, {
            dateStr: today,
            reason: `Account Target reached on ${accName} (${accNetPct}% >= ${effTargetPct}% after charges)`,
            netProfitPct: accNetPct,
            netPnl: Number(accNetPnl.toFixed(2))
          });
          if (accOpen.length > 0) {
            this.log(
              'INFO',
              `🎯 Account Target Net Profit % Reached (${accName}): ${accNetPct}% >= ${effTargetPct}% of Account Capital (₹${accCapital.toLocaleString('en-IN')}). Target SL/50%-Partial & 1/3 Trailing active per position.`
            );
          }
        }

        const maxLossPct = Math.abs(Number(accRisk.stopLossNetPct || 0));
        if (maxLossPct > 0 && accNetPct <= -maxLossPct) {
          this.accountBreakers.set(accId, {
            dateStr: today,
            reason: `Account SL reached on ${accName} (${accNetPct}% <= -${maxLossPct}% after charges)`,
            netProfitPct: accNetPct,
            netPnl: Number(accNetPnl.toFixed(2))
          });
          if (accOpen.length > 0) {
            this.log(
              'ALERT',
              `🚨 Account Stop-Loss Hit (${accName}): ${accNetPct}% <= -${maxLossPct}% of Account Capital (₹${accCapital.toLocaleString('en-IN')}). Net Loss: ₹${accNetPnl.toFixed(2)}. Squaring off ${accName} positions!`
            );
            await this.exitAccountPositions(accId, `Account Max Net Loss % Breached (${accName})`);
          }
          continue;
        }
      }

      // Auto Square-off Time (e.g. 15:15 IST)
      if (openPositions.length > 0 && risk.autoSquareOffTime && this._isTimeReached(risk.autoSquareOffTime)) {
        const misPositions = openPositions.filter(p => p.product === 'MIS' || p.product === 'INTRADAY');
        if (misPositions.length > 0) {
          this.log('ALERT', `⏰ 15:15 IST Auto Square-off time reached. Squaring off ${misPositions.length} intraday positions.`);
          for (const pos of misPositions) {
            await this.exitPosition(pos, `15:15 Auto Square-off`);
          }
          return;
        }
      }
    }

    // Clean up stale targetStates for closed positions
    const openKeySet = new Set(openPositions.map(p => `${p.accountId}_${p.symbol}_${p.product}`));
    for (const [k, ts] of this.targetStates.entries()) {
      if (!openKeySet.has(k)) {
        if (ts && Array.isArray(ts.slOrderIds) && ts.slOrderIds.length > 0 && typeof this.multiBrokerManager.cancelOrders === 'function') {
          await this.multiBrokerManager.cancelOrders(ts.accountId, ts.broker, ts.slOrderIds);
        }
        this.targetStates.delete(k);
      }
    }

    // Group open count & capital per account for default account-level target derivation
    const openCountByAccount = new Map();
    for (const p of openPositions) {
      const aid = p.accountId || 'default';
      openCountByAccount.set(aid, (openCountByAccount.get(aid) || 0) + 1);
    }

    // 2. Per-Position Staged Target Management & Net Stop Loss Evaluation
    for (const pos of openPositions) {
      const specificKey = `${pos.accountId}_${pos.symbol}_${pos.product}`;
      const generalKey = `any_${pos.symbol}_${pos.product}`;
      const rule = this.positionRules.get(specificKey) || this.positionRules.get(generalKey);
      const netPnl = pos.netPnl;
      const netPct = pos.netProfitPctOfCapital;

      if (rule && rule.enabled && !this.exitingPositions.has(specificKey)) {
        // Stop Loss Net % check
        if (rule.stopLossNetPct && rule.stopLossNetPct > 0 && netPct <= -Math.abs(rule.stopLossNetPct)) {
          this.log(
            'TRIGGER',
            `🛑 Net Position Stop-Loss Hit for ${pos.symbol} on ${pos.brokerName || pos.broker}: Net Loss ${netPct}% <= -${rule.stopLossNetPct}% of 9:00 AM Balance. Net P&L: ₹${netPnl.toFixed(2)} [Charges: ₹${pos.totalCharges}]. Executing exit!`
          );
          await this.exitPosition(pos, `Net Stop-Loss (-${rule.stopLossNetPct}%)`);
          continue;
        }

        // Absolute Net Loss INR check
        if (rule.stopLossNetINR && rule.stopLossNetINR > 0 && netPnl <= -Math.abs(rule.stopLossNetINR)) {
          this.log('TRIGGER', `🛑 Net Loss INR Stop hit for ${pos.symbol}: Net ₹${netPnl.toFixed(2)} <= -₹${rule.stopLossNetINR}`);
          await this.exitPosition(pos, `Stop Loss Net INR (-₹${rule.stopLossNetINR})`);
          continue;
        }
      }

      // Compute position's target net INR (rule target first, else account target % when autoExitEnabled)
      const accId = pos.accountId || 'default';
      const accRisk = typeof this.multiBrokerManager.getAccountRiskSettings === 'function'
        ? this.multiBrokerManager.getAccountRiskSettings(accId)
        : { targetNetProfitPct: Number(risk.targetDailyNetProfitPct || 0), nearThresholdBufferPct: Number(risk.nearThresholdBufferPct || 100) };

      const openEntry = (Array.isArray(openBalData.accounts) ? openBalData.accounts : []).find(a => a.id === accId);
      let accCapital = openEntry ? Number(openEntry.totalBalance || openEntry.availableCash || 0) : 0;
      if (!(accCapital > 0) && typeof this.multiBrokerManager._getCachedBrokerFunds === 'function') {
        const inst = this.multiBrokerManager.brokerInstances && this.multiBrokerManager.brokerInstances.get(accId);
        if (inst) {
          const cf = this.multiBrokerManager._getCachedBrokerFunds(inst);
          accCapital = Number(cf.totalBalance || cf.availableCash || inst.initialBalance || 0);
        }
      }
      if (!(accCapital > 0)) accCapital = openingBalance;

      let targetGoalINR = 0;
      if (rule && rule.enabled) {
        if (rule.targetNetProfitINR && rule.targetNetProfitINR > 0) {
          targetGoalINR = Number(rule.targetNetProfitINR);
        } else if (rule.targetNetProfitPct && rule.targetNetProfitPct > 0) {
          const buf = (rule.nearThresholdBufferPct || 100) / 100;
          targetGoalINR = openingBalance * (rule.targetNetProfitPct / 100) * buf;
        }
      } else if (risk.autoExitEnabled && accRisk.targetNetProfitPct > 0) {
        const buf = Math.max(50, Math.min(100, Number(accRisk.nearThresholdBufferPct || 100))) / 100;
        const accCount = Math.max(1, openCountByAccount.get(accId) || 1);
        targetGoalINR = (accCapital * (accRisk.targetNetProfitPct / 100) * buf) / accCount;
      }

      if (targetGoalINR > 0 && !this.exitingPositions.has(specificKey)) {
        await this._managePositionTargetOrder(pos, targetGoalINR);
      }
    }
  }

  /**
   * Staged target lifecycle per position:
   * - At 50% of target price: place SL-LMT at (entryPrice + 1.5 trigger / entryPrice + 1.0 limit) for full qty
   * - At 100% of target price: exit 50% qty (MKT) & move SL-LMT to 50% profit target for remaining qty
   * - After 100%: trail SL-LMT by +1/3 of target price move on every +1/3 upward move
   */
  async _managePositionTargetOrder(pos, targetGoalINR) {
    const key = `${pos.accountId}_${pos.symbol}_${pos.product}`;
    const ltp = Number(pos.ltp || 0);
    const netQty = Number(pos.netQty || 0);
    const absNet = Math.abs(netQty);
    if (!(ltp > 0) || !(absNet > 0) || !(targetGoalINR > 0)) return null;

    const isLong = netQty > 0;
    const entryPrice = isLong
      ? Number(pos.buyAvg || pos.avgPrice || ltp)
      : Number(pos.sellAvg || pos.avgPrice || ltp);
    if (!(entryPrice > 0)) return null;

    let ts = this.targetStates.get(key);
    const shouldInit = !ts || ts.isLong !== isLong || (ts.stage === 'MONITORING' && absNet > ts.initialQty);
    if (shouldInit) {
      const estCharges = Math.max(0, Number(pos.totalCharges || 0));
      const targetMove = Math.max(0.10, (targetGoalINR + estCharges) / absNet);
      const halfTargetPrice = isLong
        ? this._roundToTick(entryPrice + targetMove * 0.5)
        : this._roundToTick(Math.max(0.05, entryPrice - targetMove * 0.5));
      const fullTargetPrice = isLong
        ? this._roundToTick(entryPrice + targetMove)
        : this._roundToTick(Math.max(0.05, entryPrice - targetMove));
      const target125Price = isLong
        ? this._roundToTick(entryPrice + targetMove * 1.25)
        : this._roundToTick(Math.max(0.05, entryPrice - targetMove * 1.25));
      const target150Price = isLong
        ? this._roundToTick(entryPrice + targetMove * 1.5)
        : this._roundToTick(Math.max(0.05, entryPrice - targetMove * 1.5));
      const trailStep = Math.max(0.05, this._roundToTick(targetMove / 3));

      ts = {
        key,
        accountId: pos.accountId,
        broker: pos.broker,
        symbol: pos.symbol,
        product: pos.product,
        stage: 'MONITORING',
        isLong,
        entryPrice: this._roundToTick(entryPrice),
        initialQty: absNet,
        targetGoalINR: Number(targetGoalINR.toFixed(2)),
        targetMove: Number(targetMove.toFixed(2)),
        halfTargetPrice,
        fullTargetPrice,
        target125Price,
        target150Price,
        trailStep,
        hit150Locked: false,
        slOrderIds: [],
        slTriggerPrice: 0,
        slLimitPrice: 0,
        slQty: 0,
        lastTrailAnchor: 0
      };
      this.targetStates.set(key, ts);
    }

    const hit50 = isLong ? ltp >= ts.halfTargetPrice : ltp <= ts.halfTargetPrice;
    const hit100 = isLong ? ltp >= ts.fullTargetPrice : ltp <= ts.fullTargetPrice;
    const hit150 = isLong ? ltp >= ts.target150Price : ltp <= ts.target150Price;
    const exitSide = isLong ? 'S' : 'B';

    // Stage 150%: Profit reached 150% of target -> cancel ALL pending orders + confirmations and send 125% profit SL WITHOUT confirmation
    if (!ts.hit150Locked && hit150 && !this.exitingPositions.has(key)) {
      this.exitingPositions.add(key);
      try {
        ts.hit150Locked = true;
        this.emit('cancel_pending_confirmations', {
          key,
          accountId: pos.accountId,
          symbol: pos.symbol
        });

        let cancelledCount = 0;
        if (typeof this.multiBrokerManager.cancelAllPendingOrdersForPosition === 'function') {
          const cancelRes = await this.multiBrokerManager.cancelAllPendingOrdersForPosition(
            pos.accountId,
            pos.broker,
            pos.symbol,
            ts.slOrderIds || []
          );
          cancelledCount = (cancelRes && Array.isArray(cancelRes.cancelledIds)) ? cancelRes.cancelledIds.length : 0;
        } else if (ts.slOrderIds && ts.slOrderIds.length > 0 && typeof this.multiBrokerManager.cancelOrders === 'function') {
          await this.multiBrokerManager.cancelOrders(pos.accountId, pos.broker, ts.slOrderIds);
          cancelledCount = ts.slOrderIds.length;
        }

        const slTrig125 = ts.target125Price;
        const slLim125 = isLong
          ? this._roundToTick(Math.max(0.05, slTrig125 - 0.5))
          : this._roundToTick(slTrig125 + 0.5);

        const slRes = await this.multiBrokerManager.placeOrder({
          accountId: pos.accountId,
          broker: pos.broker,
          tradingSymbol: pos.symbol,
          exchangeSegment: pos.exchangeSegment || 'nse_fo',
          transactionType: exitSide,
          orderType: 'SL',
          quantity: absNet,
          price: slLim125,
          triggerPrice: slTrig125,
          ltp,
          product: pos.product,
          instrumentToken: pos.instrumentToken,
          isExit: true,
          reason: '150% Target Hit - Auto 125% Profit SL (No Confirmation)'
        });

        ts.stage = 'TRAILING';
        ts.slOrderIds = (slRes && slRes.orderIds && slRes.orderIds.length > 0)
          ? slRes.orderIds
          : (slRes && slRes.orderId ? [slRes.orderId] : []);
        ts.slTriggerPrice = slTrig125;
        ts.slLimitPrice = slLim125;
        ts.slQty = absNet;
        ts.lastTrailAnchor = ltp;

        this.log(
          'TRIGGER',
          `🚀 150% Profit Target reached on ${pos.symbol} (LTP ₹${ltp} >= ₹${ts.target150Price}): cancelled ${cancelledCount} pending order(s) & placed 125% Profit SL-LMT Trigger ₹${slTrig125} / Limit ₹${slLim125} for ${absNet} qty WITHOUT confirmation`
        );
      } catch (err) {
        ts.hit150Locked = false;
        this.log('ERROR', `150% Target SL placement failed on ${pos.symbol}: ${err.message}`);
      } finally {
        this.exitingPositions.delete(key);
      }
      return ts;
    }

    // Stage 2: 100% Profit Target Reached -> exit 50% qty & move SL-LMT to 50% target for remaining qty
    if (ts.stage !== 'TRAILING' && hit100) {
      this.exitingPositions.add(key);
      try {
        const lotSize = typeof this.multiBrokerManager.getPositionLotSize === 'function'
          ? this.multiBrokerManager.getPositionLotSize(pos)
          : 65;
        const effLot = (lotSize > 1 && absNet >= lotSize) ? lotSize : 1;
        const totalLots = Math.floor(absNet / effLot);
        const exitQty = totalLots >= 2 ? Math.floor(totalLots / 2) * effLot : absNet;
        const remainingQty = absNet - exitQty;

        const slTrig50 = ts.halfTargetPrice;
        const slLim50 = isLong
          ? this._roundToTick(Math.max(0.05, slTrig50 - 0.5))
          : this._roundToTick(slTrig50 + 0.5);

        await this._dispatchBrokerAction({
          dedupeKey: `${key}:STAGE2_100PCT`,
          summary: {
            title: remainingQty > 0
              ? '100% Target Reached — Confirm 50% Exit + SL Order'
              : '100% Target Reached — Confirm Full Lot Exit',
            brokerLabel: pos.brokerName || pos.broker || pos.accountId,
            transactionType: exitSide,
            symbol: pos.symbol,
            product: pos.product,
            orderType: remainingQty > 0 ? 'MKT + SL' : 'MKT',
            quantity: remainingQty > 0 ? `${exitQty} MKT Exit + ${remainingQty} SL` : exitQty,
            price: remainingQty > 0 ? slLim50 : ltp,
            triggerPrice: remainingQty > 0 ? slTrig50 : 0,
            ltp,
            reason: remainingQty > 0
              ? `100% Target hit: exit ${exitQty} qty (50%) & place SL-LMT @ ₹${slTrig50}/₹${slLim50} for remaining ${remainingQty} qty`
              : `100% Target hit on single lot: exit ${exitQty} qty at MARKET`
          },
          executeFn: async () => {
            if (remainingQty > 0) {
              let activeOrderIds = [...(ts.slOrderIds || [])];
              if (activeOrderIds.length > 0 && typeof this.multiBrokerManager.modifyOrReplaceOrder === 'function') {
                const modRes = await this.multiBrokerManager.modifyOrReplaceOrder({
                  accountId: pos.accountId,
                  broker: pos.broker,
                  orderIds: activeOrderIds,
                  replacementOrder: {
                    tradingSymbol: pos.symbol,
                    exchangeSegment: pos.exchangeSegment || 'nse_fo',
                    transactionType: exitSide,
                    orderType: 'SL',
                    quantity: remainingQty,
                    price: slLim50,
                    triggerPrice: slTrig50,
                    ltp,
                    product: pos.product,
                    instrumentToken: pos.instrumentToken
                  }
                });
                activeOrderIds = (modRes && modRes.orderIds && modRes.orderIds.length > 0)
                  ? modRes.orderIds
                  : (modRes && modRes.orderId ? [modRes.orderId] : []);
              }

              await this.multiBrokerManager.exitPosition(pos, `100% Target Hit - Exiting 50% (${exitQty} qty)`, exitQty);

              if (activeOrderIds.length === 0) {
                const slRes = await this.multiBrokerManager.placeOrder({
                  accountId: pos.accountId,
                  broker: pos.broker,
                  tradingSymbol: pos.symbol,
                  exchangeSegment: pos.exchangeSegment || 'nse_fo',
                  transactionType: exitSide,
                  orderType: 'SL',
                  quantity: remainingQty,
                  price: slLim50,
                  triggerPrice: slTrig50,
                  ltp,
                  product: pos.product,
                  instrumentToken: pos.instrumentToken,
                  isExit: true,
                  reason: '50% Profit Target SL on Remaining Qty'
                });
                activeOrderIds = (slRes && slRes.orderIds && slRes.orderIds.length > 0)
                  ? slRes.orderIds
                  : (slRes && slRes.orderId ? [slRes.orderId] : []);
              }

              ts.stage = 'TRAILING';
              ts.slOrderIds = activeOrderIds;
              ts.slTriggerPrice = slTrig50;
              ts.slLimitPrice = slLim50;
              ts.slQty = remainingQty;
              ts.lastTrailAnchor = ltp;

              this.log(
                'TRIGGER',
                `🎯 100% Target hit on ${pos.symbol} (LTP ₹${ltp}): exited 50% (${exitQty} qty) & set SL-LMT for ${remainingQty} qty @ Trigger ₹${slTrig50} / Limit ₹${slLim50} (50% target), trailing every ₹${ts.trailStep}`
              );
              this.emit('position_exited', { key, position: pos, partial: true, exitQty, remainingQty, reason: '100% Target - 50% Partial Exit' });
            } else {
              if (ts.slOrderIds && ts.slOrderIds.length > 0 && typeof this.multiBrokerManager.cancelOrders === 'function') {
                await this.multiBrokerManager.cancelOrders(pos.accountId, pos.broker, ts.slOrderIds);
              }
              const exitRes = await this.multiBrokerManager.exitPosition(pos, `100% Target Reached (Single lot ${exitQty} qty)`, exitQty);
              this.positionRules.delete(key);
              this.targetStates.delete(key);
              this.log('EXIT', `✅ Exit order placed on ${pos.brokerName || pos.broker} for ${pos.symbol}. Order ID: ${(exitRes && exitRes.orderId) || 'N/A'}`);
              this.emit('position_exited', { key, position: pos, orderId: exitRes && exitRes.orderId, reason: '100% Target Reached (Single lot)' });
            }
          }
        });
      } finally {
        if (ts && ts.stage === 'TRAILING') {
          this.exitingPositions.delete(key);
        } else {
          setTimeout(() => this.exitingPositions.delete(key), 1500);
        }
      }
      return ts;
    }

    // Stage 1: 50% Profit Reached -> send SL-LMT order (Trigger: Buy + 1.5, Limit: Buy + 1.0)
    if (ts.stage === 'MONITORING' && hit50) {
      const trigPx = isLong
        ? this._roundToTick(ts.entryPrice + 1.5)
        : this._roundToTick(Math.max(0.05, ts.entryPrice - 1.5));
      const limPx = isLong
        ? this._roundToTick(Math.max(0.05, ts.entryPrice + 1.0))
        : this._roundToTick(Math.max(0.05, ts.entryPrice - 1.0));

      await this._dispatchBrokerAction({
        dedupeKey: `${key}:STAGE1_50PCT`,
        summary: {
          title: '50% Target Hit — Confirm Breakeven+ SL Order',
          brokerLabel: pos.brokerName || pos.broker || pos.accountId,
          transactionType: exitSide,
          symbol: pos.symbol,
          product: pos.product,
          orderType: 'SL',
          quantity: absNet,
          price: limPx,
          triggerPrice: trigPx,
          ltp,
          reason: `50% Target reached (LTP ₹${ltp} >= ₹${ts.halfTargetPrice}): send SL-LMT Trigger ₹${trigPx} (Entry+1.5) / Limit ₹${limPx} (Entry+1.0)`
        },
        executeFn: async () => {
          const slRes = await this.multiBrokerManager.placeOrder({
            accountId: pos.accountId,
            broker: pos.broker,
            tradingSymbol: pos.symbol,
            exchangeSegment: pos.exchangeSegment || 'nse_fo',
            transactionType: exitSide,
            orderType: 'SL',
            quantity: absNet,
            price: limPx,
            triggerPrice: trigPx,
            ltp,
            product: pos.product,
            instrumentToken: pos.instrumentToken,
            isExit: true,
            reason: '50% Target Hit - Breakeven+1.5/1.0 SL Order'
          });

          ts.stage = 'BREAKEVEN_SL_PLACED';
          ts.slOrderIds = (slRes && slRes.orderIds && slRes.orderIds.length > 0)
            ? slRes.orderIds
            : (slRes && slRes.orderId ? [slRes.orderId] : []);
          ts.slTriggerPrice = trigPx;
          ts.slLimitPrice = limPx;
          ts.slQty = absNet;

          this.log(
            'TRIGGER',
            `🛡️ 50% of Target reached on ${pos.symbol} (LTP ₹${ltp} >= ₹${ts.halfTargetPrice}): placed SL-LMT for ${absNet} qty @ Trigger ₹${trigPx} (Entry+1.5) / Limit ₹${limPx} (Entry+1.0)`
          );
        }
      });
      return ts;
    }

    // Stage 3: Trail every 1/3 of price move after 100% partial exit
    if (ts.stage === 'TRAILING' && absNet > 0) {
      const moveSinceAnchor = isLong ? (ltp - ts.lastTrailAnchor) : (ts.lastTrailAnchor - ltp);
      if (moveSinceAnchor >= ts.trailStep) {
        const steps = Math.floor(moveSinceAnchor / ts.trailStep);
        const advance = this._roundToTick(steps * ts.trailStep);
        if (advance > 0) {
          const nextTrig = isLong
            ? this._roundToTick(Math.min(ltp - 0.5, ts.slTriggerPrice + advance))
            : this._roundToTick(Math.max(ltp + 0.5, Math.max(0.05, ts.slTriggerPrice - advance)));
          const improved = isLong ? nextTrig > ts.slTriggerPrice : nextTrig < ts.slTriggerPrice;

          if (improved) {
            const nextLim = isLong
              ? this._roundToTick(Math.max(0.05, nextTrig - 0.5))
              : this._roundToTick(nextTrig + 0.5);

            const replacementOrder = {
              tradingSymbol: pos.symbol,
              exchangeSegment: pos.exchangeSegment || 'nse_fo',
              transactionType: exitSide,
              orderType: 'SL',
              quantity: absNet,
              price: nextLim,
              triggerPrice: nextTrig,
              ltp,
              product: pos.product,
              instrumentToken: pos.instrumentToken
            };

            await this._dispatchBrokerAction({
              dedupeKey: `${key}:TRAIL:${nextTrig}`,
              summary: {
                title: '1/3 Move Trail — Confirm Updated SL Order',
                brokerLabel: pos.brokerName || pos.broker || pos.accountId,
                transactionType: exitSide,
                symbol: pos.symbol,
                product: pos.product,
                orderType: 'SL',
                quantity: absNet,
                price: nextLim,
                triggerPrice: nextTrig,
                ltp,
                reason: `Trail SL by +₹${advance} (1/3 move): new Trigger ₹${nextTrig} / Limit ₹${nextLim} for ${absNet} qty`
              },
              executeFn: async () => {
                let updatedIds = ts.slOrderIds || [];
                if (typeof this.multiBrokerManager.modifyOrReplaceOrder === 'function') {
                  const modRes = await this.multiBrokerManager.modifyOrReplaceOrder({
                    accountId: pos.accountId,
                    broker: pos.broker,
                    orderIds: ts.slOrderIds || [],
                    replacementOrder
                  });
                  updatedIds = (modRes && modRes.orderIds && modRes.orderIds.length > 0)
                    ? modRes.orderIds
                    : (modRes && modRes.orderId ? [modRes.orderId] : updatedIds);
                }

                ts.slOrderIds = updatedIds;
                ts.slTriggerPrice = nextTrig;
                ts.slLimitPrice = nextLim;
                ts.slQty = absNet;
                ts.lastTrailAnchor = isLong
                  ? this._roundToTick(ts.lastTrailAnchor + advance)
                  : this._roundToTick(Math.max(0.05, ts.lastTrailAnchor - advance));

                this.log(
                  'TRIGGER',
                  `📈 Trailing SL advanced +₹${advance} (1/3 move) on ${pos.symbol}: Trigger ₹${nextTrig} / Limit ₹${nextLim} (${absNet} qty)`
                );
              }
            });
          }
        }
      }
    }

    return ts;
  }

  _isTimeReached(targetTimeStr) {
    if (!targetTimeStr) return false;
    const [targetHour, targetMin] = targetTimeStr.split(':').map(Number);
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const ist = new Date(utc + 3600000 * 5.5);
    const curHour = ist.getHours();
    const curMin = ist.getMinutes();
    return curHour > targetHour || (curHour === targetHour && curMin >= targetMin);
  }

  /**
   * Send Exit order to the exact broker that holds this position
   */
  async exitPosition(pos, reason = 'Auto-Exit', options = {}) {
    const key = `${pos.accountId}_${pos.symbol}_${pos.product}`;
    if (this.exitingPositions.has(key)) return;

    const runExit = async () => {
      if (this.exitingPositions.has(key)) return;
      this.exitingPositions.add(key);

      try {
        const ts = this.targetStates.get(key);
        if (ts && Array.isArray(ts.slOrderIds) && ts.slOrderIds.length > 0 && typeof this.multiBrokerManager.cancelOrders === 'function') {
          await this.multiBrokerManager.cancelOrders(pos.accountId, pos.broker, ts.slOrderIds);
        }
        this.targetStates.delete(key);

        this.log('EXIT', `⚡ Executing Exit on ${pos.brokerName || pos.broker} for ${pos.symbol} (${pos.netQty}). Reason: ${reason}`);
        const res = await this.multiBrokerManager.exitPosition(pos, reason);
        this.log('EXIT', `✅ Exit order placed on ${pos.brokerName || pos.broker} for ${pos.symbol}. Order ID: ${res.orderId || 'N/A'}`);

        this.positionRules.delete(key);
        this.emit('position_exited', { key, position: pos, orderId: res.orderId, reason });
        return res;
      } catch (err) {
        this.log('ERROR', `❌ Failed to exit position on ${pos.broker}: ${err.message}`);
        throw err;
      } finally {
        setTimeout(() => this.exitingPositions.delete(key), 3000);
      }
    };

    if (options && options.skipGate) {
      return await runExit();
    }

    return await this._dispatchBrokerAction({
      dedupeKey: `${key}:EXIT:${reason}`,
      summary: {
        title: 'Confirm Square-Off Exit Order',
        brokerLabel: pos.brokerName || pos.broker || pos.accountId,
        transactionType: Number(pos.netQty || 0) < 0 ? 'B' : 'S',
        symbol: pos.symbol,
        product: pos.product,
        orderType: 'MKT',
        quantity: Math.abs(Number(pos.netQty || 0)),
        ltp: pos.ltp,
        reason
      },
      executeFn: runExit
    });
  }

  /**
   * Exit all open positions belonging to a single broker account
   */
  async exitAccountPositions(accountId, reason = 'Account Risk Trigger') {
    const positions = await this.multiBrokerManager.getAllPositions();
    const accountOpen = positions.filter(p => p.isOpen && p.netQty !== 0 && p.accountId === accountId);
    const results = [];
    for (const pos of accountOpen) {
      try {
        const res = await this.exitPosition(pos, reason);
        results.push({ symbol: pos.symbol, broker: pos.broker, success: true, orderId: res && res.orderId });
      } catch (e) {
        results.push({ symbol: pos.symbol, broker: pos.broker, success: false, error: e.message });
      }
    }
    return { accountId, count: accountOpen.length, results };
  }

  /**
   * Emergency: Exit all open positions across all connected brokers
   */
  async exitAllPositions(reason = 'Emergency Panic Square-Off All', options = {}) {
    this.log('ALERT', `🚨 EXIT ALL POSITIONS TRIGGERED: ${reason}`);
    try {
      const positions = await this.multiBrokerManager.getAllPositions();
      const openPositions = positions.filter(p => p.isOpen && p.netQty !== 0);

      const results = [];
      for (const pos of openPositions) {
        try {
          const res = await this.exitPosition(pos, reason, options);
          results.push({ symbol: pos.symbol, broker: pos.broker, success: true, orderId: res && res.orderId });
        } catch (e) {
          results.push({ symbol: pos.symbol, broker: pos.broker, success: false, error: e.message });
        }
      }
      return { count: openPositions.length, results };
    } catch (err) {
      this.log('ERROR', `Error in exitAllPositions: ${err.message}`);
      throw err;
    }
  }
}

module.exports = AutoExitEngine;
