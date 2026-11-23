/**
 * Indian Brokerage and Statutory Charges Calculator
 * Calculates accurate regulatory and broker charges for Equity Intraday, Delivery, and F&O.
 * Includes Brokerage, STT/CTT, Exchange Turnover Charges, GST (18%), Stamp Duty, and SEBI Charges.
 */

class ChargesCalculator {
  /**
   * Determine asset category based on symbol and segment
   */
  static categorizeAsset(symbol = '', segment = 'nse_cm') {
    const sym = symbol.toUpperCase();
    const seg = segment.toLowerCase();

    if (seg.includes('fo') || sym.includes(' CE') || sym.includes(' PE') || sym.endsWith('CE') || sym.endsWith('PE')) {
      if (sym.includes(' CE') || sym.includes(' PE') || sym.endsWith('CE') || sym.endsWith('PE')) {
        return 'OPTIONS';
      }
      return 'FUTURES';
    }

    if (seg.includes('mcx')) return 'COMMODITY';
    return 'EQUITY';
  }

  /**
   * Calculate all charges for a specific position
   * @param {Object} pos - Position object containing buyQty, sellQty, buyAvg, sellAvg, ltp, netQty, product, segment
   * @param {Object} brokerPreferences - e.g. { flatBrokerage: 20 }
   */
  static calculatePositionCharges(pos = {}, brokerPreferences = {}) {
    const buyQty = Number(pos.buyQty || 0);
    const sellQty = Number(pos.sellQty || 0);
    const buyAvg = Number(pos.buyAvg || 0);
    const sellAvg = Number(pos.sellAvg || 0);
    const ltp = Number(pos.ltp || 0);
    const netQty = Number(pos.netQty || 0);
    const product = (pos.product || 'MIS').toUpperCase();
    const segment = (pos.exchangeSegment || 'nse_cm').toLowerCase();
    const assetType = this.categorizeAsset(pos.symbol, segment);

    // If position is currently open, we simulate closing it at current LTP for exit charge estimation
    let simulatedSellQty = sellQty;
    let simulatedSellAvg = sellAvg;
    let simulatedBuyQty = buyQty;
    let simulatedBuyAvg = buyAvg;

    if (netQty > 0) {
      // Long position: closing means selling netQty at LTP
      simulatedSellQty += netQty;
      simulatedSellAvg = ((sellQty * sellAvg) + (netQty * ltp)) / (sellQty + netQty);
    } else if (netQty < 0) {
      // Short position: closing means buying abs(netQty) at LTP
      const absNet = Math.abs(netQty);
      simulatedBuyQty += absNet;
      simulatedBuyAvg = ((buyQty * buyAvg) + (absNet * ltp)) / (buyQty + absNet);
    }

    const buyTurnover = simulatedBuyQty * simulatedBuyAvg;
    const sellTurnover = simulatedSellQty * simulatedSellAvg;
    const totalTurnover = buyTurnover + sellTurnover;

    let brokerage = 0;
    let stt = 0;
    let exchangeTxn = 0;
    let sebi = 0;
    let stampDuty = 0;

    // Number of executed orders estimated (1 per active side)
    const orderSides = (simulatedBuyQty > 0 ? 1 : 0) + (simulatedSellQty > 0 ? 1 : 0);

    // 1. Calculate according to Asset Type
    if (assetType === 'OPTIONS') {
      // Options Brokerage: flat ₹20 per order
      const flatRate = brokerPreferences.flatBrokerage !== undefined ? brokerPreferences.flatBrokerage : 20;
      brokerage = flatRate * orderSides;

      // STT: 0.0625% on sell side premium turnover
      stt = sellTurnover * 0.000625;

      // Exchange Txn Charges: 0.05% on NSE Options
      exchangeTxn = totalTurnover * 0.0005;

      // Stamp Duty: 0.003% on buy side
      stampDuty = buyTurnover * 0.00003;

      // SEBI charges: ₹10 per crore (0.0001%)
      sebi = totalTurnover * 0.000001;

    } else if (assetType === 'FUTURES') {
      const flatRate = brokerPreferences.flatBrokerage !== undefined ? brokerPreferences.flatBrokerage : 20;
      brokerage = flatRate * orderSides;

      // STT: 0.0125% on sell side
      stt = sellTurnover * 0.000125;

      // Exchange Txn Charges: 0.0019%
      exchangeTxn = totalTurnover * 0.000019;

      // Stamp Duty: 0.002% on buy side
      stampDuty = buyTurnover * 0.00002;

      // SEBI charges
      sebi = totalTurnover * 0.000001;

    } else {
      // EQUITY (INTRADAY vs DELIVERY)
      const isDelivery = product === 'CNC' || product === 'DELIVERY';

      if (isDelivery) {
        brokerage = 0; // Most zero brokerage delivery, or flat ₹20 if specified
        // STT: 0.1% on both Buy and Sell
        stt = totalTurnover * 0.001;
        // Exchange Txn: 0.00325%
        exchangeTxn = totalTurnover * 0.0000325;
        // Stamp Duty: 0.015% on buy
        stampDuty = buyTurnover * 0.00015;
        // SEBI
        sebi = totalTurnover * 0.000001;
      } else {
        // Intraday (MIS)
        // Brokerage: lower of 0.03% or ₹20 per order
        const buyBrokerage = Math.min(20, buyTurnover * 0.0003);
        const sellBrokerage = Math.min(20, sellTurnover * 0.0003);
        brokerage = (simulatedBuyQty > 0 ? buyBrokerage : 0) + (simulatedSellQty > 0 ? sellBrokerage : 0);

        // STT: 0.025% on sell side
        stt = sellTurnover * 0.00025;

        // Exchange Txn: 0.00325%
        exchangeTxn = totalTurnover * 0.0000325;

        // Stamp duty: 0.003% on buy
        stampDuty = buyTurnover * 0.00003;

        // SEBI
        sebi = totalTurnover * 0.000001;
      }
    }

    // GST: 18% on (Brokerage + Exchange Txn + SEBI)
    const gst = (brokerage + exchangeTxn + sebi) * 0.18;

    const totalCharges = brokerage + stt + exchangeTxn + sebi + stampDuty + gst;

    // Gross P&L
    let grossPnl = Number(pos.totalPnl || (pos.unrealizedPnl + pos.realizedPnl) || 0);
    if (!grossPnl && buyTurnover && sellTurnover) {
      grossPnl = sellTurnover - buyTurnover;
    }

    // Net P&L = Gross P&L - Total Charges
    const netPnl = grossPnl - totalCharges;

    return {
      buyTurnover: Number(buyTurnover.toFixed(2)),
      sellTurnover: Number(sellTurnover.toFixed(2)),
      totalTurnover: Number(totalTurnover.toFixed(2)),
      brokerage: Number(brokerage.toFixed(2)),
      stt: Number(stt.toFixed(2)),
      exchangeTxn: Number(exchangeTxn.toFixed(2)),
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
