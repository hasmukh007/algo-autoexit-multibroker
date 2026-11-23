/**
 * Mock Data Provider for Kotak Neo API
 * Allows safe testing and demo of all features without live credentials or off-market hours.
 */
class MockDataProvider {
  constructor() {
    this.isAuthenticated = true;
    this.sessionUser = {
      ucc: 'DEMO999',
      clientName: 'Demo Trader (Simulated)',
      email: 'demo.trader@kotakneo.local',
      accountType: 'Kotak Neo Simulation'
    };
    this.lastLoginTime = new Date().toISOString();
    this.activeBaseUrl = 'https://mock.kotaksecurities.com';

    // Account Limits
    this.limits = {
      availableCash: 250000.00,
      utilizedMargin: 45200.00,
      collateralMargin: 100000.00,
      grossMargin: 350000.00
    };

    // Realistic Mock Positions
    this.positions = [
      {
        symbol: 'NIFTY 24NOV 24200 CE',
        exchangeSegment: 'nse_fo',
        product: 'MIS',
        instrumentToken: '72314',
        netQty: 50,
        buyQty: 50,
        sellQty: 0,
        buyAvg: 112.40,
        sellAvg: 0,
        ltp: 124.60,
        unrealizedPnl: 610.00,
        realizedPnl: 0,
        totalPnl: 610.00,
        pnlPercentage: 10.85,
        isOpen: true
      },
      {
        symbol: 'BANKNIFTY 24NOV 52200 PE',
        exchangeSegment: 'nse_fo',
        product: 'MIS',
        instrumentToken: '81920',
        netQty: -30,
        buyQty: 0,
        sellQty: 30,
        buyAvg: 0,
        sellAvg: 235.80,
        ltp: 218.10,
        unrealizedPnl: 531.00,
        realizedPnl: 0,
        totalPnl: 531.00,
        pnlPercentage: 7.51,
        isOpen: true
      },
      {
        symbol: 'RELIANCE-EQ',
        exchangeSegment: 'nse_cm',
        product: 'MIS',
        instrumentToken: '2885',
        netQty: 25,
        buyQty: 25,
        sellQty: 0,
        buyAvg: 1280.00,
        sellAvg: 0,
        ltp: 1272.50,
        unrealizedPnl: -187.50,
        realizedPnl: 0,
        totalPnl: -187.50,
        pnlPercentage: -0.59,
        isOpen: true
      },
      {
        symbol: 'TATASTEEL-EQ',
        exchangeSegment: 'nse_cm',
        product: 'MIS',
        instrumentToken: '3499',
        netQty: 0,
        buyQty: 200,
        sellQty: 200,
        buyAvg: 142.10,
        sellAvg: 145.30,
        ltp: 146.00,
        unrealizedPnl: 0,
        realizedPnl: 640.00,
        totalPnl: 640.00,
        pnlPercentage: 2.25,
        isOpen: false
      }
    ];

    // Mock Orders
    this.orders = [
      {
        orderId: 'MOCK-ORD-101',
        symbol: 'NIFTY 24NOV 24200 CE',
        exchange: 'NSE',
        product: 'MIS',
        transactionType: 'B',
        orderType: 'L',
        quantity: 50,
        filledQuantity: 50,
        pendingQuantity: 0,
        price: 112.40,
        triggerPrice: 0,
        status: 'COMPLETE',
        statusMessage: 'Order fully executed',
        orderTime: new Date(Date.now() - 3600000).toLocaleTimeString()
      },
      {
        orderId: 'MOCK-ORD-102',
        symbol: 'BANKNIFTY 24NOV 52200 PE',
        exchange: 'NSE',
        product: 'MIS',
        transactionType: 'S',
        orderType: 'MKT',
        quantity: 30,
        filledQuantity: 30,
        pendingQuantity: 0,
        price: 235.80,
        triggerPrice: 0,
        status: 'COMPLETE',
        statusMessage: 'Order executed at market price',
        orderTime: new Date(Date.now() - 2700000).toLocaleTimeString()
      },
      {
        orderId: 'MOCK-ORD-103',
        symbol: 'INFY-EQ',
        exchange: 'NSE',
        product: 'CNC',
        transactionType: 'B',
        orderType: 'L',
        quantity: 10,
        filledQuantity: 0,
        pendingQuantity: 10,
        price: 1820.00,
        triggerPrice: 0,
        status: 'OPEN',
        statusMessage: 'Order placed on exchange',
        orderTime: new Date(Date.now() - 1200000).toLocaleTimeString()
      }
    ];

    // Mock Holdings
    this.holdings = [
      {
        symbol: 'HDFCBANK-EQ',
        exchange: 'NSE',
        quantity: 50,
        collateralQty: 0,
        averagePrice: 1650.00,
        ltp: 1742.80,
        currentValue: 87140.00,
        pnl: 4640.00
      },
      {
        symbol: 'TCS-EQ',
        exchange: 'NSE',
        quantity: 20,
        collateralQty: 0,
        averagePrice: 3950.00,
        ltp: 4120.50,
        currentValue: 82410.00,
        pnl: 3410.00
      },
      {
        symbol: 'ITC-EQ',
        exchange: 'NSE',
        quantity: 150,
        collateralQty: 0,
        averagePrice: 470.00,
        ltp: 468.20,
        currentValue: 70230.00,
        pnl: -270.00
      }
    ];

    // Start background tick simulation (realistic random-walk price updates)
    this._startPriceSimulation();
  }

  _startPriceSimulation() {
    this._timer = setInterval(() => {
      this.positions.forEach(pos => {
        if (!pos.isOpen) return;

        // Small random walk: -0.4% to +0.4%
        const deltaPct = (Math.random() - 0.49) * 0.008;
        const newLtp = Math.max(1, pos.ltp * (1 + deltaPct));
        pos.ltp = Number(newLtp.toFixed(2));

        if (pos.netQty > 0) {
          pos.unrealizedPnl = Number(((pos.ltp - pos.buyAvg) * pos.netQty).toFixed(2));
          pos.pnlPercentage = Number(((pos.ltp - pos.buyAvg) / pos.buyAvg * 100).toFixed(2));
        } else if (pos.netQty < 0) {
          pos.unrealizedPnl = Number(((pos.sellAvg - pos.ltp) * Math.abs(pos.netQty)).toFixed(2));
          pos.pnlPercentage = Number(((pos.sellAvg - pos.ltp) / pos.sellAvg * 100).toFixed(2));
        }
        pos.totalPnl = Number((pos.unrealizedPnl + pos.realizedPnl).toFixed(2));
      });
    }, 1500);
  }

  stopSimulation() {
    if (this._timer) clearInterval(this._timer);
  }

  getSessionStatus() {
    return {
      isAuthenticated: true,
      hasSessionToken: true,
      ucc: this.sessionUser.ucc,
      lastLoginTime: this.lastLoginTime,
      activeBaseUrl: this.activeBaseUrl,
      user: this.sessionUser,
      isMock: true
    };
  }

  async getPositions() {
    return JSON.parse(JSON.stringify(this.positions));
  }

  async getHoldings() {
    return JSON.parse(JSON.stringify(this.holdings));
  }

  async getOrderBook() {
    return JSON.parse(JSON.stringify(this.orders));
  }

  async getTradeBook() {
    return [];
  }

  async getLimits() {
    return { ...this.limits };
  }

  async placeOrder(order = {}) {
    const orderId = 'MOCK-ORD-' + Math.floor(1000 + Math.random() * 9000);
    const qty = Number(order.quantity);
    const isBuy = order.transactionType === 'B';
    const price = Number(order.price) > 0 ? Number(order.price) : 100 + Math.random() * 200;

    const newOrder = {
      orderId,
      symbol: order.tradingSymbol,
      exchange: order.exchangeSegment ? order.exchangeSegment.toUpperCase() : 'NSE',
      product: order.product || 'MIS',
      transactionType: order.transactionType,
      orderType: order.orderType || 'MKT',
      quantity: qty,
      filledQuantity: qty,
      pendingQuantity: 0,
      price: Number(price.toFixed(2)),
      triggerPrice: Number(order.triggerPrice || 0),
      status: 'COMPLETE',
      statusMessage: 'Executed in Mock Trading environment',
      orderTime: new Date().toLocaleTimeString()
    };

    this.orders.unshift(newOrder);

    // Update positions
    let existing = this.positions.find(
      p => p.symbol === order.tradingSymbol && p.product === (order.product || 'MIS')
    );

    if (existing) {
      if (isBuy) {
        existing.buyQty += qty;
        existing.netQty += qty;
      } else {
        existing.sellQty += qty;
        existing.netQty -= qty;
      }
      existing.isOpen = existing.netQty !== 0;
      if (!existing.isOpen) {
        existing.realizedPnl += existing.unrealizedPnl;
        existing.unrealizedPnl = 0;
        existing.totalPnl = existing.realizedPnl;
      }
    } else {
      this.positions.push({
        symbol: order.tradingSymbol,
        exchangeSegment: order.exchangeSegment || 'nse_cm',
        product: order.product || 'MIS',
        instrumentToken: String(Math.floor(10000 + Math.random() * 80000)),
        netQty: isBuy ? qty : -qty,
        buyQty: isBuy ? qty : 0,
        sellQty: isBuy ? 0 : qty,
        buyAvg: isBuy ? price : 0,
        sellAvg: isBuy ? 0 : price,
        ltp: price,
        unrealizedPnl: 0,
        realizedPnl: 0,
        totalPnl: 0,
        pnlPercentage: 0,
        isOpen: true
      });
    }

    return {
      success: true,
      orderId,
      message: `Mock ${order.transactionType === 'B' ? 'BUY' : 'SELL'} order placed for ${order.tradingSymbol} x ${qty}`
    };
  }

  async modifyOrder(order = {}) {
    const ord = this.orders.find(o => o.orderId === order.orderId);
    if (!ord) throw new Error(`Order ${order.orderId} not found in mock state`);

    if (order.quantity) ord.quantity = Number(order.quantity);
    if (order.price) ord.price = Number(order.price);
    if (order.orderType) ord.orderType = order.orderType;
    if (order.triggerPrice) ord.triggerPrice = Number(order.triggerPrice);

    return { success: true, orderId: ord.orderId, message: 'Order modified in mock state' };
  }

  async cancelOrder(orderId) {
    const ord = this.orders.find(o => o.orderId === orderId);
    if (!ord) throw new Error(`Order ${orderId} not found`);
    ord.status = 'CANCELLED';
    ord.pendingQuantity = 0;
    ord.statusMessage = 'Cancelled by user';
    return { success: true, orderId, message: 'Order cancelled in mock state' };
  }
}

module.exports = MockDataProvider;
