/**
 * Simulated Multi-Broker Provider
 * Provides realistic simulated positions and executions across Kotak Neo, Angel One, and Dhan.
 */
class MockBrokerManager {
  constructor() {
    this.accounts = [
      {
        id: 'mock_kotak_1',
        broker: 'kotakneo',
        name: 'Kotak Neo (Demo)',
        enabled: true,
        isMock: true,
        funds: { availableCash: 250000, utilizedMargin: 45000, totalBalance: 295000 }
      },
      {
        id: 'mock_angel_1',
        broker: 'angelone',
        name: 'Angel One (Demo)',
        enabled: true,
        isMock: true,
        funds: { availableCash: 180000, utilizedMargin: 32000, totalBalance: 212000 }
      },
      {
        id: 'mock_dhan_1',
        broker: 'dhan',
        name: 'Dhan (Demo)',
        enabled: true,
        isMock: true,
        funds: { availableCash: 320000, utilizedMargin: 48000, totalBalance: 368000 }
      }
    ];

    this.positions = [
      {
        accountId: 'mock_kotak_1',
        broker: 'kotakneo',
        brokerName: 'Kotak Neo (Demo)',
        symbol: 'NIFTY 24NOV 24200 CE',
        exchangeSegment: 'nse_fo',
        product: 'MIS',
        instrumentToken: '72314',
        netQty: 50,
        buyQty: 50,
        sellQty: 0,
        buyAvg: 112.40,
        sellAvg: 0,
        ltp: 126.80,
        unrealizedPnl: 720.00,
        realizedPnl: 0,
        totalPnl: 720.00,
        isOpen: true
      },
      {
        accountId: 'mock_angel_1',
        broker: 'angelone',
        brokerName: 'Angel One (Demo)',
        symbol: 'BANKNIFTY 24NOV 52200 PE',
        exchangeSegment: 'nse_fo',
        product: 'MIS',
        instrumentToken: '81920',
        netQty: -30,
        buyQty: 0,
        sellQty: 30,
        buyAvg: 0,
        sellAvg: 235.80,
        ltp: 215.20,
        unrealizedPnl: 618.00,
        realizedPnl: 0,
        totalPnl: 618.00,
        isOpen: true
      },
      {
        accountId: 'mock_dhan_1',
        broker: 'dhan',
        brokerName: 'Dhan (Demo)',
        symbol: 'RELIANCE-EQ',
        exchangeSegment: 'nse_cm',
        product: 'MIS',
        instrumentToken: '2885',
        netQty: 25,
        buyQty: 25,
        sellQty: 0,
        buyAvg: 1280.00,
        sellAvg: 0,
        ltp: 1288.40,
        unrealizedPnl: 210.00,
        realizedPnl: 0,
        totalPnl: 210.00,
        isOpen: true
      }
    ];

    this.orders = [
      {
        orderId: 'MOCK-KTK-101',
        accountId: 'mock_kotak_1',
        broker: 'kotakneo',
        brokerName: 'Kotak Neo (Demo)',
        symbol: 'NIFTY 24NOV 24200 CE',
        exchange: 'NSE',
        product: 'MIS',
        transactionType: 'B',
        orderType: 'MKT',
        quantity: 50,
        filledQuantity: 50,
        price: 112.40,
        status: 'COMPLETE',
        orderTime: new Date(Date.now() - 3600000).toLocaleTimeString()
      },
      {
        orderId: 'MOCK-ANG-102',
        accountId: 'mock_angel_1',
        broker: 'angelone',
        brokerName: 'Angel One (Demo)',
        symbol: 'BANKNIFTY 24NOV 52200 PE',
        exchange: 'NSE',
        product: 'MIS',
        transactionType: 'S',
        orderType: 'MKT',
        quantity: 30,
        filledQuantity: 30,
        price: 235.80,
        status: 'COMPLETE',
        orderTime: new Date(Date.now() - 2700000).toLocaleTimeString()
      },
      {
        orderId: 'MOCK-DHN-103',
        accountId: 'mock_dhan_1',
        broker: 'dhan',
        brokerName: 'Dhan (Demo)',
        symbol: 'RELIANCE-EQ',
        exchange: 'NSE',
        product: 'MIS',
        transactionType: 'B',
        orderType: 'L',
        quantity: 25,
        filledQuantity: 25,
        price: 1280.00,
        status: 'COMPLETE',
        orderTime: new Date(Date.now() - 1500000).toLocaleTimeString()
      }
    ];

    this._startSimulation();
  }

  _startSimulation() {
    this._timer = setInterval(() => {
      this.positions.forEach(pos => {
        if (!pos.isOpen) return;
        const delta = (Math.random() - 0.48) * 0.006;
        pos.ltp = Number((pos.ltp * (1 + delta)).toFixed(2));

        if (pos.netQty > 0) {
          pos.unrealizedPnl = Number(((pos.ltp - pos.buyAvg) * pos.netQty).toFixed(2));
        } else {
          pos.unrealizedPnl = Number(((pos.sellAvg - pos.ltp) * Math.abs(pos.netQty)).toFixed(2));
        }
        pos.totalPnl = Number((pos.unrealizedPnl + pos.realizedPnl).toFixed(2));
      });
    }, 1500);
  }

  stopSimulation() {
    if (this._timer) clearInterval(this._timer);
  }

  async getPositions() {
    return JSON.parse(JSON.stringify(this.positions));
  }

  async getFunds() {
    let cash = 0, used = 0, total = 0;
    this.accounts.forEach(a => {
      cash += a.funds.availableCash;
      used += a.funds.utilizedMargin;
      total += a.funds.totalBalance;
    });
    return {
      availableCash: cash,
      utilizedMargin: used,
      totalBalance: total,
      accounts: this.accounts.map(a => ({
        id: a.id,
        broker: a.broker,
        name: a.name,
        availableCash: a.funds.availableCash,
        utilizedMargin: a.funds.utilizedMargin,
        totalBalance: a.funds.totalBalance
      }))
    };
  }

  async getOrderBook() {
    return JSON.parse(JSON.stringify(this.orders));
  }

  async placeOrder(order = {}) {
    const account = this.accounts.find(a => a.id === order.accountId) || this.accounts[0];
    const orderId = `MOCK-${account.broker.toUpperCase().slice(0, 3)}-${Date.now()}`;
    const qty = Number(order.quantity);
    const isBuy = order.transactionType === 'B';
    const price = Number(order.price) > 0 ? Number(order.price) : 120.00;

    const newOrder = {
      orderId,
      accountId: account.id,
      broker: account.broker,
      brokerName: account.name,
      symbol: order.tradingSymbol,
      exchange: (order.exchangeSegment || 'NSE').toUpperCase(),
      product: order.product || 'MIS',
      transactionType: order.transactionType,
      orderType: order.orderType || 'MKT',
      quantity: qty,
      filledQuantity: qty,
      price,
      status: 'COMPLETE',
      orderTime: new Date().toLocaleTimeString()
    };

    this.orders.unshift(newOrder);

    // Update positions
    let existing = this.positions.find(
      p => p.symbol === order.tradingSymbol && p.accountId === account.id
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
        accountId: account.id,
        broker: account.broker,
        brokerName: account.name,
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
        isOpen: true
      });
    }

    return {
      success: true,
      orderId,
      message: `Executed on ${account.name}: ${order.transactionType === 'B' ? 'BUY' : 'SELL'} ${order.tradingSymbol} x ${qty}`
    };
  }

  async cancelOrder(orderId) {
    const ord = this.orders.find(o => o.orderId === orderId);
    if (ord) ord.status = 'CANCELLED';
    return { success: true, orderId };
  }
}

module.exports = MockBrokerManager;
