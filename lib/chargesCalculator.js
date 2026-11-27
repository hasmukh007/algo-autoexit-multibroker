/**
 * Indian Options Brokerage and Statutory Charges Calculator
 * All trading is Options-only:
 * - Brokerage (configurable per broker account, ₹/order)
 * - STT: 0.15% on sell turnover only
 * - Transaction Charges: 0.03553% on total turnover (Buy + Sell)
 * - SEBI Charges: ₹10 / crore on total turnover (Buy + Sell)
 * - IPFT Charges: ₹0.01 / crore on total turnover (Buy + Sell)
 * - Stamp Duty: 0.003% on buy turnover
 * - GST: 18% on (Brokerage + SEBI + Transaction Charges + IPFT)
 */

const DEFAULT_CHARGE_SETTINGS = {
  sttPct: 0.15,
  exchangeTxnPct: 0.03553,
  sebiPerCrore: 10,
  ipftPerCrore: 0.01,
  stampDutyBuyPct: 0.003,
  gstPct: 18
};

class ChargesCalculator {
  static getDefaultChargeSettings() {
    return { ...DEFAULT_CHARGE_SETTINGS };
  }

  /**
   * All trading is Options-only.
   */
  static categorizeAsset() {
    return 'OPTIONS';
  }

  /**
   * Resolve per-order Options brokerage rate from account preferences
   */
  static resolveBrokerageRate(_assetType = 'OPTIONS', _isDelivery = false, brokerPreferences = {}) {
    if (brokerPreferences.brokerageType === 'zero') {
      return 0;
    }
    if (brokerPreferences.optionsBrokerage !== undefined && brokerPreferences.optionsBrokerage !== '') {
      return Math.max(0, Number(brokerPreferences.optionsBrokerage));
    }
    if (brokerPreferences.brokeragePerOrder !== undefined && brokerPreferences.brokeragePerOrder !== '') {
      return Math.max(0, Number(brokerPreferences.brokeragePerOrder));
    }
    if (brokerPreferences.flatBrokerage !== undefined && brokerPreferences.flatBrokerage !== '') {
      return Math.max(0, Number(brokerPreferences.flatBrokerage));
    }
    return 20;
  }

  /**
   * Resolve normalized statutory charge rates from defaults + overrides.
   */
  static _resolveRates(chargeSettings = {}) {
    return {
      sttPct: chargeSettings.sttPct !== undefined ? Number(chargeSettings.sttPct) : DEFAULT_CHARGE_SETTINGS.sttPct,
      exchangeTxnPct: chargeSettings.exchangeTxnPct !== undefined ? Number(chargeSettings.exchangeTxnPct) : DEFAULT_CHARGE_SETTINGS.exchangeTxnPct,
      sebiPerCrore: chargeSettings.sebiPerCrore !== undefined ? Number(chargeSettings.sebiPerCrore) : DEFAULT_CHARGE_SETTINGS.sebiPerCrore,
      ipftPerCrore: chargeSettings.ipftPerCrore !== undefined ? Number(chargeSettings.ipftPerCrore) : DEFAULT_CHARGE_SETTINGS.ipftPerCrore,
      stampDutyBuyPct: chargeSettings.stampDutyBuyPct !== undefined ? Number(chargeSettings.stampDutyBuyPct) : DEFAULT_CHARGE_SETTINGS.stampDutyBuyPct,
      gstPct: chargeSettings.gstPct !== undefined ? Number(chargeSettings.gstPct) : DEFAULT_CHARGE_SETTINGS.gstPct
    };
  }

  /**
   * Determine whether a normalized broker order has executed (full or partial fill).
   */
  static isExecutedOrder(ord = {}) {
    if (!ord || typeof ord !== 'object') return false;
    const st = String(ord.status || '').trim().toUpperCase();
    const filled = Number(ord.filledQuantity || ord.filledQty || 0);
    if (st === 'REJECTED' || st === 'FAILED') return false;
    if (st === 'CANCELLED' || st === 'CANCELED') {
      return filled > 0;
    }
    const execStatuses = new Set([
      'COMPLETE',
      'COMPLETED',
      'TRADED',
      'FILLED',
      'EXECUTED',
      'PARTIALFILLED',
      'PARTIAL_FILLED',
      'PARTIALLY_FILLED'
    ]);
    return execStatuses.has(st) || filled > 0;
  }

  /**
   * Ceiling Stamp Duty to the next whole rupee for a single buy trade turnover.
   */
  static _ceilStampDuty(buyTurnover, stampDutyBuyPct) {
    const raw = Math.max(0, Number(buyTurnover || 0)) * (Math.max(0, Number(stampDutyBuyPct || 0)) / 100);
    return raw > 0 ? Math.ceil(Number(raw.toFixed(6))) : 0;
  }

  /**
   * Compute statutory charges & GST from buy/sell turnovers and buy/sell brokerage.
   */
  static _buildChargeBreakdown({
    assetType = 'OPTIONS',
    chargeSource = 'orders',
    perOrderRate = 20,
    buyTurnover = 0,
    sellTurnover = 0,
    buyOrderSides = 0,
    sellOrderSides = 0,
    buyBrokerage = 0,
    sellBrokerage = 0,
    buyStampDutyOverride = null,
    grossPnl = 0,
    rates
  }) {
    const totalTurnover = buyTurnover + sellTurnover;
    const orderSides = buyOrderSides + sellOrderSides;
    const brokerage = buyBrokerage + sellBrokerage;

    // STT: 0.15% on sell turnover only
    const sttRate = Math.max(0, rates.sttPct) / 100;
    const buyStt = 0;
    const sellStt = sellTurnover * sttRate;

    // Exchange Transaction Charges: 0.03553% on total turnover (buy + sell)
    const exchRate = Math.max(0, rates.exchangeTxnPct) / 100;
    const buyExchangeTxn = buyTurnover * exchRate;
    const sellExchangeTxn = sellTurnover * exchRate;

    // SEBI Charges: ₹10 / crore on total turnover
    const sebiRate = Math.max(0, rates.sebiPerCrore) / 10000000;
    const buySebi = buyTurnover * sebiRate;
    const sellSebi = sellTurnover * sebiRate;

    // IPFT Charges: ₹0.01 / crore on total turnover
    const ipftRate = Math.max(0, rates.ipftPerCrore) / 10000000;
    const buyIpft = buyTurnover * ipftRate;
    const sellIpft = sellTurnover * ipftRate;

    // Stamp Duty: 0.003% on buy turnover, ceiled to next whole rupee per trade
    const buyStampDuty = buyStampDutyOverride !== null && buyStampDutyOverride !== undefined
      ? Number(buyStampDutyOverride)
      : this._ceilStampDuty(buyTurnover, rates.stampDutyBuyPct);
    const sellStampDuty = 0;

    // GST: 18% on (Brokerage + SEBI + Exchange Transaction + IPFT)
    const gstRate = Math.max(0, rates.gstPct) / 100;
    const buyGst = (buyBrokerage + buySebi + buyExchangeTxn + buyIpft) * gstRate;
    const sellGst = (sellBrokerage + sellSebi + sellExchangeTxn + sellIpft) * gstRate;

    const stt = buyStt + sellStt;
    const exchangeTxn = buyExchangeTxn + sellExchangeTxn;
    const ipft = buyIpft + sellIpft;
    const sebi = buySebi + sellSebi;
    const stampDuty = buyStampDuty + sellStampDuty;
    const gst = buyGst + sellGst;

    const buySideCharges = buyBrokerage + buyStt + buyExchangeTxn + buyIpft + buySebi + buyStampDuty + buyGst;
    const sellSideCharges = sellBrokerage + sellStt + sellExchangeTxn + sellIpft + sellSebi + sellGst;
    const totalCharges = buySideCharges + sellSideCharges;
    const netPnl = grossPnl - totalCharges;

    return {
      assetType,
      chargeSource,
      orderSides,
      buyOrders: buyOrderSides,
      sellOrders: sellOrderSides,
      brokeragePerOrder: Number(perOrderRate.toFixed(2)),
      buyTurnover: Number(buyTurnover.toFixed(2)),
      sellTurnover: Number(sellTurnover.toFixed(2)),
      totalTurnover: Number(totalTurnover.toFixed(2)),
      buySideCharges: Number(buySideCharges.toFixed(2)),
      sellSideCharges: Number(sellSideCharges.toFixed(2)),
      brokerage: Number(brokerage.toFixed(2)),
      stt: Number(stt.toFixed(2)),
      exchangeTxn: Number(exchangeTxn.toFixed(2)),
      ipft: Number(ipft.toFixed(4)),
      sebi: Number(sebi.toFixed(2)),
      stampDuty: Number(stampDuty.toFixed(2)),
      gst: Number(gst.toFixed(2)),
      totalCharges: Number(totalCharges.toFixed(2)),
      grossPnl: Number(grossPnl.toFixed(2)),
      netPnl: Number(netPnl.toFixed(2))
    };
  }

  /**
   * Calculate brokerage & all statutory charges directly from executed orders.
   * Each executed order incurs per-order brokerage regardless of buy/sell netting.
   */
  static calculateChargesFromOrders(orders = [], brokerPreferences = {}, chargeSettings = {}, posFallback = null) {
    const assetType = 'OPTIONS';
    const rates = this._resolveRates(chargeSettings);
    const perOrderRate = this.resolveBrokerageRate(assetType, false, brokerPreferences);

    let buyTurnover = 0;
    let sellTurnover = 0;
    let buyOrderCount = 0;
    let sellOrderCount = 0;
    let buyStampDutyTotal = 0;

    const executed = (Array.isArray(orders) ? orders : []).filter(o => this.isExecutedOrder(o));
    for (const ord of executed) {
      const filled = Number(ord.filledQuantity || ord.filledQty || 0);
      const qty = filled > 0 ? filled : Number(ord.quantity || 0);
      if (!(qty > 0)) continue;

      const txRaw = String(ord.transactionType || ord.side || 'B').trim().toUpperCase();
      const side = (txRaw === 'S' || txRaw === 'SELL') ? 'S' : 'B';

      let execPrice = Number(ord.avgPrice || ord.averagePrice || ord.tradedPrice || ord.price || 0);
      if (!(execPrice > 0) && posFallback) {
        execPrice = side === 'B'
          ? Number(posFallback.buyAvg || posFallback.avgPrice || posFallback.ltp || 0)
          : Number(posFallback.sellAvg || posFallback.avgPrice || posFallback.ltp || 0);
      }
      const ordTurnover = qty * Math.max(0, execPrice);

      if (side === 'B') {
        buyTurnover += ordTurnover;
        buyOrderCount += 1;
        buyStampDutyTotal += this._ceilStampDuty(ordTurnover, rates.stampDutyBuyPct);
      } else {
        sellTurnover += ordTurnover;
        sellOrderCount += 1;
      }
    }

    const buyBrokerage = perOrderRate * buyOrderCount;
    const sellBrokerage = perOrderRate * sellOrderCount;

    let grossPnl = sellTurnover - buyTurnover;
    if (posFallback) {
      if (posFallback.totalPnl !== undefined && posFallback.totalPnl !== null && !Number.isNaN(Number(posFallback.totalPnl))) {
        grossPnl = Number(posFallback.totalPnl);
      } else if (posFallback.unrealizedPnl !== undefined || posFallback.realizedPnl !== undefined) {
        grossPnl = Number(posFallback.unrealizedPnl || 0) + Number(posFallback.realizedPnl || 0);
      }
    }

    return this._buildChargeBreakdown({
      assetType,
      chargeSource: 'orders',
      perOrderRate,
      buyTurnover,
      sellTurnover,
      buyOrderSides: buyOrderCount,
      sellOrderSides: sellOrderCount,
      buyBrokerage,
      sellBrokerage,
      buyStampDutyOverride: buyStampDutyTotal,
      grossPnl,
      rates
    });
  }

  /**
   * Calculate all statutory & brokerage charges for an Options position.
   * Uses executed orders when available (orders > net position); falls back to
   * position averages only when no executed order list exists.
   */
  static calculatePositionCharges(pos = {}, brokerPreferences = {}, chargeSettings = {}, executedOrders = null) {
    const ordersList = Array.isArray(executedOrders) && executedOrders.length > 0
      ? executedOrders
      : (Array.isArray(pos.executedOrders) && pos.executedOrders.length > 0 ? pos.executedOrders : null);

    if (ordersList) {
      const hasExecuted = ordersList.some(o => this.isExecutedOrder(o));
      if (hasExecuted) {
        return this.calculateChargesFromOrders(ordersList, brokerPreferences, chargeSettings, pos);
      }
    }

    const rawBuyQty = Number(pos.buyQty || 0);
    const rawSellQty = Number(pos.sellQty || 0);
    const rawBuyAvg = Number(pos.buyAvg || 0);
    const rawSellAvg = Number(pos.sellAvg || 0);
    const ltp = Number(pos.ltp || 0);
    const netQty = Number(pos.netQty || 0);
    const assetType = 'OPTIONS';
    const rates = this._resolveRates(chargeSettings);

    // Ensure open leg quantities/averages are populated even if broker omits day buyQty/sellQty
    let buyQty = rawBuyQty;
    let buyAvg = rawBuyAvg;
    let sellQty = rawSellQty;
    let sellAvg = rawSellAvg;

    if (netQty > 0 && buyQty < netQty) {
      buyQty = netQty;
      if (!buyAvg) buyAvg = Number(pos.avgPrice || pos.costPrice || ltp || 0);
    } else if (netQty < 0 && sellQty < Math.abs(netQty)) {
      sellQty = Math.abs(netQty);
      if (!sellAvg) sellAvg = Number(pos.avgPrice || pos.costPrice || ltp || 0);
    }

    // Fallback estimation when order book has no matching executed orders
    let simulatedSellQty = sellQty;
    let simulatedSellAvg = sellAvg;
    let simulatedBuyQty = buyQty;
    let simulatedBuyAvg = buyAvg;

    if (netQty > 0) {
      const exitPrice = ltp > 0 ? ltp : buyAvg;
      simulatedSellQty = sellQty + netQty;
      simulatedSellAvg = simulatedSellQty > 0 ? ((sellQty * sellAvg) + (netQty * exitPrice)) / simulatedSellQty : 0;
    } else if (netQty < 0) {
      const absNet = Math.abs(netQty);
      const exitPrice = ltp > 0 ? ltp : sellAvg;
      simulatedBuyQty = buyQty + absNet;
      simulatedBuyAvg = simulatedBuyQty > 0 ? ((buyQty * buyAvg) + (absNet * exitPrice)) / simulatedBuyQty : 0;
    }

    const buyTurnover = simulatedBuyQty * simulatedBuyAvg;
    const sellTurnover = simulatedSellQty * simulatedSellAvg;

    const fallbackBuyOrders = simulatedBuyQty > 0 ? 1 : 0;
    const fallbackSellOrders = simulatedSellQty > 0 ? 1 : 0;
    const executedCount = Number(pos.executedOrderCount || 0);
    const perOrderRate = this.resolveBrokerageRate(assetType, false, brokerPreferences);

    let buyOrderSides = fallbackBuyOrders;
    let sellOrderSides = fallbackSellOrders;
    if (executedCount > 0) {
      if (netQty > 0) {
        buyOrderSides = executedCount;
        sellOrderSides = 1;
      } else if (netQty < 0) {
        buyOrderSides = 1;
        sellOrderSides = executedCount;
      } else {
        buyOrderSides = Math.ceil(executedCount / 2);
        sellOrderSides = Math.max(1, executedCount - buyOrderSides);
      }
    }

    const buyBrokerage = perOrderRate * buyOrderSides;
    const sellBrokerage = perOrderRate * sellOrderSides;

    let grossPnl = 0;
    if (pos.totalPnl !== undefined && pos.totalPnl !== null && !Number.isNaN(Number(pos.totalPnl))) {
      grossPnl = Number(pos.totalPnl);
    } else if (pos.unrealizedPnl !== undefined || pos.realizedPnl !== undefined) {
      grossPnl = Number(pos.unrealizedPnl || 0) + Number(pos.realizedPnl || 0);
    } else if (buyTurnover > 0 || sellTurnover > 0) {
      grossPnl = sellTurnover - buyTurnover;
    }

    return this._buildChargeBreakdown({
      assetType,
      chargeSource: 'position_fallback',
      perOrderRate,
      buyTurnover,
      sellTurnover,
      buyOrderSides,
      sellOrderSides,
      buyBrokerage,
      sellBrokerage,
      grossPnl,
      rates
    });
  }
}

module.exports = ChargesCalculator;
