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

    // Audit logs for execution trail
    this.auditLogs = [];
    this.maxLogs = 200;

    // Monitoring state
    this.isRunning = false;
    this.pollIntervalMs = 1200;
    this.timer = null;

    // State guards to prevent duplicate exit order placement
    this.exitingPositions = new Set();

    // Daily net profit target / max loss guard keyed by IST date
    this.dailyBreaker = { dateStr: '', reason: null, overallNetProfitPct: 0, totalNetPnl: 0 };
  }

  clearDailyBreaker() {
    this.dailyBreaker = { dateStr: getISTInfo().dateStr, reason: null, overallNetProfitPct: 0, totalNetPnl: 0 };
  }

  getDailyRiskGuardStatus() {
    const today = getISTInfo().dateStr;
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

    const enrichedPositions = positions.map(pos => {
      const brokerPref = this.multiBrokerManager.getAccountBrokerage(pos.accountId, pos.broker);
      const executedOrderCount = this.multiBrokerManager.getExecutedOrderCount(pos.accountId, pos.symbol);
      const chargeInfo = ChargesCalculator.calculatePositionCharges({ ...pos, executedOrderCount }, brokerPref);
      totalGrossPnl += chargeInfo.grossPnl;
      totalEstimatedCharges += chargeInfo.totalCharges;
      totalNetPnl += chargeInfo.netPnl;

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

    const openPositions = enrichedPositions.filter(p => p.isOpen && p.netQty !== 0);
    const overallNetProfitPct = openingBalance > 0
      ? Number(((totalNetPnl / openingBalance) * 100).toFixed(2))
      : 0;
    const today = getISTInfo().dateStr;

    // 1. Check Global Portfolio Net Profit % & Max Loss % Circuit Breakers
    if (risk.autoExitEnabled) {
      const targetPct = Number(risk.targetDailyNetProfitPct || 0);
      const nearFactor = Math.max(50, Math.min(100, Number(risk.nearThresholdBufferPct || 100))) / 100;
      const effTargetPct = Number((targetPct * nearFactor).toFixed(4));

      if (targetPct > 0 && overallNetProfitPct >= effTargetPct) {
        this.dailyBreaker = {
          dateStr: today,
          reason: `Daily Net Profit Target reached (${overallNetProfitPct}% >= ${effTargetPct}% after charges)`,
          overallNetProfitPct,
          totalNetPnl: Number(totalNetPnl.toFixed(2))
        };
        if (openPositions.length > 0) {
          this.log(
            'ALERT',
            `🎯 Global Target Net Profit % Reached: ${overallNetProfitPct}% >= ${effTargetPct}% of 9:00 AM Balance (₹${openingBalance.toLocaleString('en-IN')}). Net Profit: ₹${totalNetPnl.toFixed(2)} (Gross: ₹${totalGrossPnl.toFixed(2)} - Charges: ₹${totalEstimatedCharges.toFixed(2)}). Squaring off all positions!`
          );
          await this.exitAllPositions('Global Net Profit % Achieved');
        }
        return;
      }

      const maxLossPct = Math.abs(Number(risk.maxDailyLossNetPct || 0));
      if (maxLossPct > 0 && overallNetProfitPct <= -maxLossPct) {
        this.dailyBreaker = {
          dateStr: today,
          reason: `Daily Max Net Loss breached (${overallNetProfitPct}% <= -${maxLossPct}% after charges)`,
          overallNetProfitPct,
          totalNetPnl: Number(totalNetPnl.toFixed(2))
        };
        if (openPositions.length > 0) {
          this.log(
            'ALERT',
            `🚨 Global Max Net Loss % Hit: ${overallNetProfitPct}% <= -${maxLossPct}% of 9:00 AM Balance (₹${openingBalance.toLocaleString('en-IN')}). Net Loss: ₹${totalNetPnl.toFixed(2)}. Squaring off all positions!`
          );
          await this.exitAllPositions('Global Max Net Loss % Breached');
        }
        return;
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

    // 2. Position-Specific Net Profit % Auto-Exit Evaluation
    for (const pos of openPositions) {
      const specificKey = `${pos.accountId}_${pos.symbol}_${pos.product}`;
      const generalKey = `any_${pos.symbol}_${pos.product}`;
      const rule = this.positionRules.get(specificKey) || this.positionRules.get(generalKey);

      if (!rule || !rule.enabled) continue;
      if (this.exitingPositions.has(specificKey)) continue;

      const netPnl = pos.netPnl;
      const netPct = pos.netProfitPctOfCapital;
      const ltp = pos.ltp;

      // Near/Above Target Net Profit % check
      if (rule.targetNetProfitPct && rule.targetNetProfitPct > 0) {
        const buffer = (rule.nearThresholdBufferPct || 100) / 100;
        const triggerThreshold = rule.targetNetProfitPct * buffer;

        if (netPct >= triggerThreshold) {
          this.log(
            'TRIGGER',
            `🎯 Net Position Profit Reached for ${pos.symbol} on ${pos.brokerName || pos.broker}: Net Profit ${netPct}% >= ${triggerThreshold}% (Target ${rule.targetNetProfitPct}% of ₹${openingBalance.toLocaleString('en-IN')}). Net P&L: ₹${netPnl.toFixed(2)} [Gross: ₹${pos.grossPnl} - Charges: ₹${pos.totalCharges}]. Executing exit!`
          );
          await this.exitPosition(pos, `Net Profit Target (${rule.targetNetProfitPct}%)`);
          continue;
        }
      }

      // Stop Loss Net % check
      if (rule.stopLossNetPct && rule.stopLossNetPct > 0) {
        if (netPct <= -Math.abs(rule.stopLossNetPct)) {
          this.log(
            'TRIGGER',
            `🛑 Net Position Stop-Loss Hit for ${pos.symbol} on ${pos.brokerName || pos.broker}: Net Loss ${netPct}% <= -${rule.stopLossNetPct}% of 9:00 AM Balance. Net P&L: ₹${netPnl.toFixed(2)} [Charges: ₹${pos.totalCharges}]. Executing exit!`
          );
          await this.exitPosition(pos, `Net Stop-Loss (-${rule.stopLossNetPct}%)`);
          continue;
        }
      }

      // Absolute Net Profit INR check
      if (rule.targetNetProfitINR && rule.targetNetProfitINR > 0 && netPnl >= rule.targetNetProfitINR) {
        this.log('TRIGGER', `🎯 Net Profit INR Target hit for ${pos.symbol}: Net ₹${netPnl.toFixed(2)} >= ₹${rule.targetNetProfitINR}`);
        await this.exitPosition(pos, `Target Net INR (₹${rule.targetNetProfitINR})`);
        continue;
      }

      // Absolute Net Loss INR check
      if (rule.stopLossNetINR && rule.stopLossNetINR > 0 && netPnl <= -Math.abs(rule.stopLossNetINR)) {
        this.log('TRIGGER', `🛑 Net Loss INR Stop hit for ${pos.symbol}: Net ₹${netPnl.toFixed(2)} <= -₹${rule.stopLossNetINR}`);
        await this.exitPosition(pos, `Stop Loss Net INR (-₹${rule.stopLossNetINR})`);
        continue;
      }
    }
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
  async exitPosition(pos, reason = 'Auto-Exit') {
    const key = `${pos.accountId}_${pos.symbol}_${pos.product}`;
    if (this.exitingPositions.has(key)) return;

    this.exitingPositions.add(key);

    try {
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
  }

  /**
   * Emergency: Exit all open positions across all connected brokers
   */
  async exitAllPositions(reason = 'Emergency Panic Square-Off All') {
    this.log('ALERT', `🚨 EXIT ALL POSITIONS TRIGGERED: ${reason}`);
    try {
      const positions = await this.multiBrokerManager.getAllPositions();
      const openPositions = positions.filter(p => p.isOpen && p.netQty !== 0);

      const results = [];
      for (const pos of openPositions) {
        try {
          const res = await this.exitPosition(pos, reason);
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
