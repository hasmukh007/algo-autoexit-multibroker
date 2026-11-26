/**
 * Indian Brokerage and Statutory Charges Calculator
 * Calculates accurate regulatory and broker charges for Equity Intraday, Delivery, and F&O.
 * Updated with SEBI / Finance Act (Oct 2024+) rates:
 * - Brokerage (configurable per broker account / segment)
 * - STT/CTT (Options 0.1% on sell, Futures 0.02% on sell, Intraday 0.025% on sell, Delivery 0.1% both sides)
 * - Exchange Transaction Charges (NSE Options 0.03503%, Futures 0.00173%, Equity 0.00297%)
 * - IPFT, SEBI Turnover Charges (0.0001%), Stamp Duty (buy side), GST (18%)
 */

class ChargesCalculator {
  /**
   * Determine asset category based on symbol, segment, and optional position metadata
   */
  static categorizeAsset(symbol = '', segment = 'nse_cm', extra = {}) {
    const sym = String(symbol || '').trim().toUpperCase();
    const seg = String(segment || 'nse_cm').toLowerCase();
    const optType = String(extra.optionType || extra.optTp || extra.instrumentType || '').toUpperCase();

    if (seg.includes('mcx')) return 'COMMODITY';


    const isOptionSym =
      optType === 'CE' ||
      optType === 'PE' ||
      optType.includes('OPT') ||
      /\b(CE|PE|CALL|PUT)\b/.test(sym) ||
      /\d+(CE|PE|C|P)$/.test(sym) ||
      /\d{2}(CE|PE|C|P)(?:\d|\b)/.test(sym) ||
      sym.includes(' CE') ||
      sym.includes(' PE') ||
      sym.endsWith('CE') ||
      sym.endsWith('PE');

    if (isOptionSym) {
      return 'OPTIONS';
    }

    if (
      seg.includes('fo') ||
      seg.includes('nfo') ||
      seg.includes('bfo') ||
      seg.includes('fno') ||
      sym.includes('FUT') ||
      optType.includes('FUT')
    ) {
      return 'FUTURES';
    }

    return 'EQUITY';
  }

  /**
   * Resolve per-order brokerage rate from account preferences
   */
  static resolveBrokerageRate(assetType, isDelivery, brokerPreferences = {}) {
    if (brokerPreferences.brokerageType === 'zero') {
      return 0;
    }

    if (assetType === 'OPTIONS' && brokerPreferences.optionsBrokerage !== undefined && brokerPreferences.optionsBrokerage !== '') {
      return Math.max(0, Number(brokerPreferences.optionsBrokerage));
    }
    if (assetType === 'FUTURES' && brokerPreferences.futuresBrokerage !== undefined && brokerPreferences.futuresBrokerage !== '') {
      return Math.max(0, Number(brokerPreferences.futuresBrokerage));
    }
    if (assetType === 'EQUITY' && isDelivery && brokerPreferences.deliveryBrokerage !== undefined && brokerPreferences.deliveryBrokerage !== '') {
      return Math.max(0, Number(brokerPreferences.deliveryBrokerage));
    }
    if (assetType === 'EQUITY' && !isDelivery && brokerPreferences.equityIntradayBrokerage !== undefined && brokerPreferences.equityIntradayBrokerage !== '') {
      return Math.max(0, Number(brokerPreferences.equityIntradayBrokerage));
    }

    if (brokerPreferences.brokeragePerOrder !== undefined && brokerPreferences.brokeragePerOrder !== '') {
      const base = Math.max(0, Number(brokerPreferences.brokeragePerOrder));
      if (assetType === 'EQUITY' && isDelivery && brokerPreferences.brokerageType !== 'custom') {
        return 0;
      }
      return base;
    }

    if (brokerPreferences.flatBrokerage !== undefined && brokerPreferences.flatBrokerage !== '') {
      return Math.max(0, Number(brokerPreferences.flatBrokerage));
    }

    return assetType === 'EQUITY' && isDelivery ? 0 : 20;
  }

  /**
   * Calculate all charges for a specific position
   * @param {Object} pos - Position object containing buyQty, sellQty, buyAvg, sellAvg, ltp, netQty, product, segment
   * @param {Object} brokerPreferences - Per-broker account brokerage configuration
   */
  static calculatePositionCharges(pos = {}, brokerPreferences = {}) {
    const rawBuyQty = Number(pos.buyQty || 0);
    const rawSellQty = Number(pos.sellQty || 0);
    const rawBuyAvg = Number(pos.buyAvg || 0);
    const rawSellAvg = Number(pos.sellAvg || 0);
    const ltp = Number(pos.ltp || 0);
    const netQty = Number(pos.netQty || 0);
    const product = (pos.product || 'MIS').toUpperCase();
    const segment = (pos.exchangeSegment || 'nse_cm').toLowerCase();
    const isBse = segment.includes('bse') || segment.includes('bfo');
    const assetType = this.categorizeAsset(pos.symbol, segment, pos);
    const isDelivery = product === 'CNC' || product === 'DELIVERY';

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

    // Simulate closing open leg at current LTP for full round-trip exit charge estimation
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
    const totalTurnover = buyTurnover + sellTurnover;

    const dpCharges = Number(pos.dpCharges || brokerPreferences.dpCharges || 0);
    const delayedCharges = Number(pos.delayedCharges || brokerPreferences.delayedCharges || 0);

    // Number of executed orders: use actual executed order count (+1 projected exit if open) when available
    const fallbackBuyOrders = simulatedBuyQty > 0 ? 1 : 0;
    const fallbackSellOrders = simulatedSellQty > 0 ? 1 : 0;
    const executedCount = Number(pos.executedOrderCount || 0);
    const orderSides = executedCount > 0
      ? executedCount + (netQty !== 0 ? 1 : 0)
      : (fallbackBuyOrders + fallbackSellOrders);
    const perOrderRate = this.resolveBrokerageRate(assetType, isDelivery, brokerPreferences);

    // Split order sides between buy and sell for per-side breakdown
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

    let buyBrokerage = 0;
    let sellBrokerage = 0;
    let buyStt = 0;
    let sellStt = 0;
    let buyExchangeTxn = 0;
    let sellExchangeTxn = 0;
    let buyIpft = 0;
    let sellIpft = 0;
    let buySebi = 0;
    let sellSebi = 0;
    let buyStampDuty = 0;
    const sellStampDuty = 0;
    if (assetType === 'OPTIONS') {
      buyBrokerage = perOrderRate * buyOrderSides;
      sellBrokerage = perOrderRate * sellOrderSides;
      // STT: 0.15% on total turnover (both buy & sell)
      buyStt = buyTurnover * 0.0015;
      sellStt = sellTurnover * 0.0015;
      // Exchange Txn Charges: 0.0355299% on total turnover (both buy & sell)
      buyExchangeTxn = buyTurnover * 0.000355299;
      sellExchangeTxn = sellTurnover * 0.000355299;
      // IPFT: 0.0000001% on total turnover (both buy & sell)
      buyIpft = buyTurnover * 0.000000001;
      sellIpft = sellTurnover * 0.000000001;
      // Stamp Duty: 0.003% buy side
      buyStampDuty = buyTurnover * 0.00003;
      // SEBI Turnover charges: 0.0001% on total turnover (both buy & sell)
      buySebi = buyTurnover * 0.000001;
      sellSebi = sellTurnover * 0.000001;

    } else if (assetType === 'FUTURES') {
      buyBrokerage = perOrderRate * buyOrderSides;
      sellBrokerage = perOrderRate * sellOrderSides;
      // STT: 0.02% on sell side
      sellStt = sellTurnover * 0.0002;
      // Exchange Txn Charges: NSE 0.00173%
      buyExchangeTxn = buyTurnover * 0.0000173;
      sellExchangeTxn = sellTurnover * 0.0000173;
      // IPFT: 0.0000001%
      buyIpft = buyTurnover * 0.000000001;
      sellIpft = sellTurnover * 0.000000001;
      // Stamp Duty: 0.002% on buy side
      buyStampDuty = buyTurnover * 0.00002;
      // SEBI charges: 0.0001%
      buySebi = buyTurnover * 0.000001;
      sellSebi = sellTurnover * 0.000001;

    } else if (assetType === 'COMMODITY') {
      buyBrokerage = perOrderRate * buyOrderSides;
      sellBrokerage = perOrderRate * sellOrderSides;
      sellStt = sellTurnover * 0.0001;
      buyExchangeTxn = buyTurnover * 0.000026;
      sellExchangeTxn = sellTurnover * 0.000026;
      buyIpft = buyTurnover * 0.000000001;
      sellIpft = sellTurnover * 0.000000001;
      buyStampDuty = buyTurnover * 0.00002;
      buySebi = buyTurnover * 0.000001;
      sellSebi = sellTurnover * 0.000001;

    } else {
      // EQUITY (INTRADAY vs DELIVERY)
      if (isDelivery) {
        buyBrokerage = perOrderRate * buyOrderSides;
        sellBrokerage = perOrderRate * sellOrderSides;
        // STT: 0.1% on both Buy and Sell
        buyStt = buyTurnover * 0.001;
        sellStt = sellTurnover * 0.001;
        // Exchange Txn: NSE 0.00297%, BSE 0.00375%
        const eqExchRate = isBse ? 0.0000375 : 0.0000297;
        buyExchangeTxn = buyTurnover * eqExchRate;
        sellExchangeTxn = sellTurnover * eqExchRate;
        // IPFT: 0.0000001%
        buyIpft = buyTurnover * 0.000000001;
        sellIpft = sellTurnover * 0.000000001;
        // Stamp Duty: 0.015% on buy
        buyStampDuty = buyTurnover * 0.00015;
        // SEBI: 0.0001%
        buySebi = buyTurnover * 0.000001;
        sellSebi = sellTurnover * 0.000001;
      } else {
        // Intraday (MIS): lower of 0.03% or configured per-order cap
        buyBrokerage = perOrderRate === 0 || simulatedBuyQty === 0 ? 0 : Math.min(perOrderRate * buyOrderSides, buyTurnover * 0.0003);
        sellBrokerage = perOrderRate === 0 || simulatedSellQty === 0 ? 0 : Math.min(perOrderRate * sellOrderSides, sellTurnover * 0.0003);

        // STT: 0.025% on sell side
        sellStt = sellTurnover * 0.00025;
        // Exchange Txn: NSE 0.00297%, BSE 0.00375%
        const eqExchRate = isBse ? 0.0000375 : 0.0000297;
        buyExchangeTxn = buyTurnover * eqExchRate;
        sellExchangeTxn = sellTurnover * eqExchRate;
        // IPFT: 0.0000001%
        buyIpft = buyTurnover * 0.000000001;
        sellIpft = sellTurnover * 0.000000001;
        // Stamp duty: 0.003% on buy
        buyStampDuty = buyTurnover * 0.00003;
        // SEBI: 0.0001%
        buySebi = buyTurnover * 0.000001;
        sellSebi = sellTurnover * 0.000001;
      }
    }

    const brokerage = buyBrokerage + sellBrokerage;
    const stt = buyStt + sellStt;
    const exchangeTxn = buyExchangeTxn + sellExchangeTxn;
    const ipft = buyIpft + sellIpft;
    const sebi = buySebi + sellSebi;
    // Stamp duty in India is rounded to nearest rupee
    const roundedBuyStampDuty = buyStampDuty > 0 ? Math.round(buyStampDuty) : 0;
    const stampDuty = roundedBuyStampDuty + sellStampDuty;

    // GST: 18% on (Brokerage + DP charges + Exchange Txn + IPFT + SEBI + delayed transaction charges)
    const buyGst = (buyBrokerage + buyExchangeTxn + buyIpft + buySebi) * 0.18;
    const sellGst = (sellBrokerage + dpCharges + sellExchangeTxn + sellIpft + sellSebi + delayedCharges) * 0.18;
    const gst = buyGst + sellGst;

    const buySideCharges = buyBrokerage + buyStt + buyExchangeTxn + buyIpft + buySebi + roundedBuyStampDuty + buyGst;
    const sellSideCharges = sellBrokerage + dpCharges + sellStt + sellExchangeTxn + sellIpft + sellSebi + delayedCharges + sellGst;
    const totalCharges = buySideCharges + sellSideCharges;

    // Gross P&L
    let grossPnl = 0;
    if (pos.totalPnl !== undefined && pos.totalPnl !== null && !Number.isNaN(Number(pos.totalPnl))) {
      grossPnl = Number(pos.totalPnl);
    } else if (pos.unrealizedPnl !== undefined || pos.realizedPnl !== undefined) {
      grossPnl = Number(pos.unrealizedPnl || 0) + Number(pos.realizedPnl || 0);
    } else if (buyTurnover > 0 || sellTurnover > 0) {
      grossPnl = sellTurnover - buyTurnover;
    }

    // Net P&L = Gross P&L - Total Charges
    const netPnl = grossPnl - totalCharges;

    return {
      assetType,
      orderSides,
      brokeragePerOrder: Number(perOrderRate.toFixed(2)),
      buyTurnover: Number(buyTurnover.toFixed(2)),
      sellTurnover: Number(sellTurnover.toFixed(2)),
      totalTurnover: Number(totalTurnover.toFixed(2)),
      buySideCharges: Number(buySideCharges.toFixed(2)),
      sellSideCharges: Number(sellSideCharges.toFixed(2)),
      brokerage: Number(brokerage.toFixed(2)),
      dpCharges: Number(dpCharges.toFixed(2)),
      delayedCharges: Number(delayedCharges.toFixed(2)),
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
}

module.exports = ChargesCalculator;
