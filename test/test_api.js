const assert = require('assert');

async function runTests() {
  console.log('🧪 Starting Multi-Broker, Charges & Brokerage Test Suite...\n');

  // 1. Charges Calculator Test (Standard ₹20/order vs Zero Brokerage ₹0/order)
  console.log('1. Testing Indian Brokerage & Statutory Taxes Calculator (Oct 2024+ rates)...');
  const ChargesCalculator = require('../lib/chargesCalculator');

  // Options Trade: 50 qty bought at 100, sold at 120 (Gross P&L = +1000)
  // Buy Turnover = 5000, Sell Turnover = 6000, Total Turnover = 11000
  const optionsPos = {
    symbol: 'NIFTY 24NOV 24200 CE',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    buyQty: 50,
    sellQty: 50,
    buyAvg: 100,
    sellAvg: 120,
    ltp: 120,
    netQty: 0,
    totalPnl: 1000
  };

  // Asset categorization tests for varied broker option symbol formats (Options-only mode)
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY 26NOV 25500 CALL', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY 26NOV 25500 PUT', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY-26NOV26-25500-CE', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY26N2625500C', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY26N2625500P', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY26C25500', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY26P25500', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('RELIANCE-EQ', 'nse_cm'), 'OPTIONS');
  console.log('   ✅ Options-only symbol categorization verified.');

  // Standard Flat ₹20/order (e.g. Angel One / Dhan)
  const stdCharges = ChargesCalculator.calculatePositionCharges(optionsPos, { brokerageType: 'flat', brokeragePerOrder: 20 });
  assert.strictEqual(stdCharges.assetType, 'OPTIONS');
  assert.strictEqual(stdCharges.totalTurnover, 11000);
  assert.strictEqual(stdCharges.brokerage, 40, 'Round trip options brokerage must be ₹40 (20+20)');
  assert.strictEqual(stdCharges.stt, 9, 'STT 0.15% on ₹6000 sell turnover only must be ₹9.00');
  assert.strictEqual(stdCharges.exchangeTxn, Number((11000 * 0.0003553).toFixed(2)), 'Options Exch Txn 0.03553% on total turnover');
  assert.strictEqual(stdCharges.sebi, Number(((11000 / 1e7) * 10).toFixed(2)), 'SEBI ₹10/crore on total turnover');
  assert.strictEqual(stdCharges.ipft, Number(((11000 / 1e7) * 0.01).toFixed(4)), 'IPFT ₹0.01/crore on total turnover');
  assert.strictEqual(stdCharges.stampDuty, Math.ceil(Number((5000 * 0.00003).toFixed(6))), 'Stamp duty 0.003% on ₹5000 buy turnover ceiled to ₹1');
  const expectedGstBase = 40 + (11000 * (10 / 1e7)) + (11000 * 0.0003553) + (11000 * (0.01 / 1e7));
  assert.strictEqual(stdCharges.gst, Number((expectedGstBase * 0.18).toFixed(2)), 'GST 18% on (Brokerage + SEBI + Txn + IPFT)');
  assert(stdCharges.buySideCharges > 0 && stdCharges.sellSideCharges > 0, 'Both buy-side and sell-side charges must be calculated');
  assert.strictEqual(Number((stdCharges.buySideCharges + stdCharges.sellSideCharges).toFixed(2)), stdCharges.totalCharges, 'Buy + Sell side charges must equal totalCharges');
  assert.strictEqual(stdCharges.netPnl, Number((1000 - stdCharges.totalCharges).toFixed(2)));
  console.log(`   ✅ Options (₹20/ord): Gross ₹1,000 | Buy: ₹${stdCharges.buySideCharges} + Sell: ₹${stdCharges.sellSideCharges} = Total: ₹${stdCharges.totalCharges} | GST: ₹${stdCharges.gst} | Stamp: ₹${stdCharges.stampDuty} | Net P&L: ₹${stdCharges.netPnl}`);

  // Zero Brokerage Plan (e.g. Kotak Neo Trade Free / Youth)
  const zeroCharges = ChargesCalculator.calculatePositionCharges(optionsPos, { brokerageType: 'zero', brokeragePerOrder: 0 });
  assert.strictEqual(zeroCharges.brokerage, 0, 'Zero plan brokerage must be ₹0');
  assert(zeroCharges.totalCharges < stdCharges.totalCharges, 'Zero brokerage plan must have lower total charges');
  console.log(`   ✅ Options (₹0/ord): Gross ₹1,000 | Charges: ₹${zeroCharges.totalCharges} (Brk ₹${zeroCharges.brokerage}, STT ₹${zeroCharges.stt}, Exch ₹${zeroCharges.exchangeTxn}, GST ₹${zeroCharges.gst}) | Net P&L: ₹${zeroCharges.netPnl}`);

  // Custom Statutory Charge Settings override test
  const customTaxCharges = ChargesCalculator.calculatePositionCharges(
    optionsPos,
    { brokerageType: 'flat', brokeragePerOrder: 20 },
    { sttPct: 0.2, exchangeTxnPct: 0.05, sebiPerCrore: 10, ipftPerCrore: 0.01, stampDutyBuyPct: 0.01, gstPct: 0 }
  );
  assert.strictEqual(customTaxCharges.stt, 12, 'Custom STT 0.2% on ₹6000 sell turnover only must be ₹12');
  assert.strictEqual(customTaxCharges.exchangeTxn, 5.5, 'Custom Exch Txn 0.05% on ₹11000 must be ₹5.50');
  assert.strictEqual(customTaxCharges.stampDuty, 1, 'Custom Stamp Duty 0.01% on ₹5000 (₹0.50) ceiled to ₹1');
  assert.strictEqual(customTaxCharges.gst, 0, 'Custom GST 0% must be ₹0');
  console.log(`   ✅ Custom statutory charge rates verified (STT ₹${customTaxCharges.stt}, Stamp ₹${customTaxCharges.stampDuty}, GST ₹${customTaxCharges.gst}).`);

  // Open Long Position with omitted buyQty/sellQty (fallback check)
  const openPosNoBuyQty = {
    symbol: 'NIFTY 24NOV 24200 CE',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    buyQty: 0,
    sellQty: 0,
    buyAvg: 100,
    sellAvg: 0,
    ltp: 120,
    netQty: 50,
    totalPnl: 1000
  };
  const openFallbackCharges = ChargesCalculator.calculatePositionCharges(openPosNoBuyQty, { brokerageType: 'flat', brokeragePerOrder: 20 });
  assert.strictEqual(openFallbackCharges.buyTurnover, 5000, 'Open position must infer buyTurnover even if broker omits buyQty');
  assert.strictEqual(openFallbackCharges.sellTurnover, 6000, 'Open position must project sellTurnover at LTP');
  assert.strictEqual(openFallbackCharges.brokerage, 40);
  console.log(`   ✅ Open position turnover fallback verified: Buy ₹${openFallbackCharges.buyTurnover}, Sell ₹${openFallbackCharges.sellTurnover}`);

  // 1b. Order-Based Charges Test (2 BUY orders = ₹40 brokerage, 1 BUY + 1 SELL = ₹40, ignores CANCELLED/REJECTED)
  const twoBuyOrders = [
    { orderId: 'ORD1', symbol: 'NIFTY26NOV25500CE', transactionType: 'B', quantity: 65, filledQuantity: 65, price: 100, status: 'COMPLETE' },
    { orderId: 'ORD2', symbol: 'NIFTY26NOV25500CE', transactionType: 'B', quantity: 65, filledQuantity: 65, price: 120, status: 'COMPLETE' },
    { orderId: 'ORD3', symbol: 'NIFTY26NOV25500CE', transactionType: 'S', quantity: 65, filledQuantity: 0, price: 130, status: 'OPEN' },
    { orderId: 'ORD4', symbol: 'NIFTY26NOV25500CE', transactionType: 'S', quantity: 65, filledQuantity: 0, price: 130, status: 'REJECTED' }
  ];
  const openPosWithTwoBuys = {
    symbol: 'NIFTY26NOV25500CE',
    buyQty: 130,
    sellQty: 0,
    buyAvg: 110,
    sellAvg: 0,
    ltp: 125,
    netQty: 130,
    totalPnl: 1950
  };
  const twoBuyOrderCharges = ChargesCalculator.calculatePositionCharges(
    openPosWithTwoBuys,
    { brokerageType: 'flat', brokeragePerOrder: 20 },
    ChargesCalculator.getDefaultChargeSettings(),
    twoBuyOrders
  );
  assert.strictEqual(twoBuyOrderCharges.chargeSource, 'orders');
  assert.strictEqual(twoBuyOrderCharges.orderSides, 2, 'Must count 2 executed BUY orders (ignoring OPEN/REJECTED)');
  assert.strictEqual(twoBuyOrderCharges.buyOrders, 2);
  assert.strictEqual(twoBuyOrderCharges.sellOrders, 0);
  assert.strictEqual(twoBuyOrderCharges.brokerage, 40, '2 executed orders @ ₹20 must give ₹40 brokerage, NOT ₹20');
  assert.strictEqual(twoBuyOrderCharges.buyTurnover, 14300, 'Buy turnover must sum 65*100 + 65*120 = ₹14,300');
  assert.strictEqual(twoBuyOrderCharges.sellTurnover, 0, 'Sell turnover must be ₹0 when no sell orders executed');
  assert.strictEqual(twoBuyOrderCharges.stt, 0, 'STT must be ₹0 when only buy orders executed');
  assert.strictEqual(twoBuyOrderCharges.exchangeTxn, Number((14300 * 0.0003553).toFixed(2)));
  assert.strictEqual(twoBuyOrderCharges.stampDuty, 2, 'Stamp duty must ceiling per buy trade: ₹1 (65*100) + ₹1 (65*120) = ₹2');
  const expBuyGstBase = 40 + (14300 * (10 / 1e7)) + (14300 * 0.0003553) + (14300 * (0.01 / 1e7));
  assert.strictEqual(twoBuyOrderCharges.gst, Number((expBuyGstBase * 0.18).toFixed(2)));
  console.log(`   ✅ Order-based charges (2 BUY orders): Orders=${twoBuyOrderCharges.orderSides}, Brokerage=₹${twoBuyOrderCharges.brokerage}, STT=₹${twoBuyOrderCharges.stt}, Stamp=₹${twoBuyOrderCharges.stampDuty}, GST=₹${twoBuyOrderCharges.gst}`);

  // Closed trade with 1 BUY + 1 SELL executed orders
  const buySellOrders = [
    { orderId: 'O-B1', symbol: 'NIFTY26NOV25500PE', transactionType: 'B', quantity: 65, filledQuantity: 65, price: 80, status: 'TRADED' },
    { orderId: 'O-S1', symbol: 'NIFTY26NOV25500PE', transactionType: 'S', quantity: 65, filledQuantity: 65, price: 100, status: 'FILLED' }
  ];
  const bsCharges = ChargesCalculator.calculateChargesFromOrders(buySellOrders, { brokerageType: 'flat', brokeragePerOrder: 20 });
  assert.strictEqual(bsCharges.orderSides, 2);
  assert.strictEqual(bsCharges.brokerage, 40);
  assert.strictEqual(bsCharges.buyTurnover, 5200);
  assert.strictEqual(bsCharges.sellTurnover, 6500);
  assert.strictEqual(bsCharges.totalTurnover, 11700);
  assert.strictEqual(bsCharges.stt, Number((6500 * 0.0015).toFixed(2)));
  assert.strictEqual(bsCharges.stampDuty, 1, 'Stamp duty 0.003% on ₹5200 buy turnover (₹0.156) ceiled to ₹1');
  console.log(`   ✅ Order-based charges (1 BUY + 1 SELL): Orders=${bsCharges.orderSides}, Brokerage=₹${bsCharges.brokerage}, Total Charges=₹${bsCharges.totalCharges}`);

  // 2. MultiBrokerManager & Account Brokerage Lookup Test
  console.log('\n2. Testing MultiBrokerManager & Per-Account Brokerage...');
  const configManager = require('../lib/configManager');
  const MultiBrokerManager = require('../lib/multiBrokerManager');
  const mgr = new MultiBrokerManager(configManager);

  const accounts = mgr.getAccounts();
  assert(Array.isArray(accounts), 'Accounts must be an array');
  const kotakBrk = mgr.getAccountBrokerage(null, 'kotakneo');
  assert(typeof kotakBrk.brokeragePerOrder === 'number' && kotakBrk.brokeragePerOrder >= 0, 'Kotak Neo brokerage should be a non-negative number');
  const angelBrk = mgr.getAccountBrokerage(null, 'angelone');
  assert(typeof angelBrk.brokeragePerOrder === 'number' && angelBrk.brokeragePerOrder >= 0, 'Angel One brokerage should be a non-negative number');

  // Verify live cache { data: [...] } order lookup & enrichPositionsWithCharges
  const fakeLiveInst = {
    id: 'acc_live_test',
    broker: 'angelone',
    name: 'Angel Test',
    _cache: {
      orders: {
        data: [
          { orderId: 'L1', accountId: 'acc_live_test', symbol: 'NIFTY26NOV25500CE', transactionType: 'B', quantity: 65, filledQuantity: 65, price: 100, status: 'COMPLETE' },
          { orderId: 'L2', accountId: 'acc_live_test', symbol: 'NIFTY26NOV25500CE', transactionType: 'S', quantity: 65, filledQuantity: 65, price: 120, status: 'COMPLETE' }
        ]
      }
    }
  };
  const origLiveMode = configManager.loadConfig().mode;
  const origBrokerInst = mgr.brokerInstances.get('acc_live_test');
  try {
    configManager.saveConfig({ mode: 'live' });
    mgr.brokerInstances.set('acc_live_test', fakeLiveInst);
    const liveExec = mgr.getExecutedOrders('acc_live_test', 'NIFTY26NOV25500CE');
    assert.strictEqual(liveExec.length, 2, 'getExecutedOrders must read _cache.orders.data in live mode');
    const enrichedLive = mgr.enrichPositionsWithCharges(
      [{ accountId: 'acc_live_test', broker: 'angelone', symbol: 'NIFTY26NOV25500CE', netQty: 0, buyQty: 65, sellQty: 65, buyAvg: 100, sellAvg: 120, ltp: 120, totalPnl: 1300 }],
      500000,
      ChargesCalculator.getDefaultChargeSettings()
    );
    assert.strictEqual(enrichedLive[0].chargeDetails.chargeSource, 'orders');
    assert.strictEqual(enrichedLive[0].chargeDetails.orderSides, 2);
    assert.strictEqual(enrichedLive[0].chargeDetails.brokerage, 40);
  } finally {
    if (origBrokerInst) mgr.brokerInstances.set('acc_live_test', origBrokerInst);
    else mgr.brokerInstances.delete('acc_live_test');
    configManager.saveConfig({ mode: origLiveMode });
  }
  console.log(`   ✅ Loaded ${accounts.length} accounts; per-account brokerage & live order-cache charge enrichment verified.`);

  // 3. PaperBroker Virtual Execution & MTM Test
  console.log('\n3. Testing PaperBroker (Virtual Options Account)...');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const PaperBroker = require('../lib/brokers/paperBroker');
  const paperStatePath = path.join(os.tmpdir(), `paper-test-${Date.now()}.json`);
  const paper = new PaperBroker({
    id: 'paper_unit_1',
    name: 'Paper Options Desk',
    initialBalance: 200000,
    enforceMarketHours: false,
    stateFile: paperStatePath
  });
  await paper.login();
  assert.strictEqual(paper.isAuthenticated, true);
  assert.strictEqual(paper.isPaper, true);
  const buyRes = await paper.placeOrder({
    tradingSymbol: 'NIFTY27OCT26C25000',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    transactionType: 'B',
    orderType: 'MKT',
    quantity: 65,
    ltp: 100
  });
  assert.strictEqual(buyRes.success, true);
  assert.strictEqual((await paper.getFunds()).utilizedMargin, 6500);
  paper.syncWithNiftySnapshot({
    strikes: [{ strike: 25000, ce: { symbol: 'NIFTY27OCT26C25000', ltp: 140 }, pe: { symbol: 'NIFTY27OCT26P25000', ltp: 90 } }]
  });
  const paperPosAfterTick = await paper.getPositions();
  assert.strictEqual(paperPosAfterTick.length, 1);
  assert.strictEqual(paperPosAfterTick[0].ltp, 140);
  assert.strictEqual(paperPosAfterTick[0].unrealizedPnl, 2600);
  await paper.placeOrder({
    tradingSymbol: 'NIFTY27OCT26C25000',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    transactionType: 'S',
    orderType: 'MKT',
    quantity: 65,
    ltp: 140
  });
  const fundsAfterExit = await paper.getFunds();
  assert.strictEqual(fundsAfterExit.utilizedMargin, 0);
  assert.strictEqual(fundsAfterExit.availableCash, 202600);
  paper.reset(150000);
  assert.strictEqual((await paper.getFunds()).availableCash, 150000);
  assert.strictEqual((await paper.getPositions()).length, 0);
  paper.deleteStateFile();
  if (fs.existsSync(paperStatePath)) fs.unlinkSync(paperStatePath);
  console.log('   ✅ PaperBroker buy/sell, live snapshot MTM sync, and balance reset verified.');

  // 4. AutoExitEngine Per-Account SL/Target Isolation & Rule Test
  console.log('\n4. Testing AutoExitEngine Per-Account SL/Target Isolation...');
  const OpeningBalanceScheduler = require('../lib/openingBalanceScheduler');
  const AutoExitEngine = require('../lib/autoExitEngine');
  const scheduler = new OpeningBalanceScheduler(mgr);
  const engine = new AutoExitEngine(mgr, scheduler, configManager);
  const rule = engine.setPositionRule('mock_kotak_1', 'NIFTY 24NOV 24200 CE', 'MIS', {
    targetNetProfitPct: 0.5,
    nearThresholdBufferPct: 95,
    stopLossNetPct: -1.0,
    enabled: true
  });
  assert.strictEqual(rule.targetNetProfitPct, 0.5);

  // Simulate two independent accounts with different per-account Target / SL thresholds
  const exitCalls = [];
  const fakeMgr = {
    mockManager: { updateLtpsFromRealFeed() {} },
    getAccounts() {
      return [
        { id: 'acc_a', name: 'Account A', broker: 'kotakneo', enabled: true },
        { id: 'acc_b', name: 'Account B', broker: 'paper', enabled: true }
      ];
    },
    getAccountBrokerage() { return { brokerageType: 'zero', brokeragePerOrder: 0 }; },
    getExecutedOrderCount() { return 2; },
    getAccountRiskSettings(id) {
      if (id === 'acc_a') return { targetNetProfitPct: 2.0, stopLossNetPct: -1.0, nearThresholdBufferPct: 100 };
      return { targetNetProfitPct: 10.0, stopLossNetPct: -5.0, nearThresholdBufferPct: 100 };
    },
    async getAllPositions() {
      return [
        { accountId: 'acc_a', broker: 'kotakneo', brokerName: 'Acc A', symbol: 'NIFTY27OCT26C25000', exchangeSegment: 'nse_fo', product: 'MIS', netQty: 65, buyQty: 65, sellQty: 0, buyAvg: 100, sellAvg: 0, ltp: 145, totalPnl: 2925, isOpen: true },
        { accountId: 'acc_b', broker: 'paper', brokerName: 'Acc B', symbol: 'NIFTY27OCT26P25000', exchangeSegment: 'nse_fo', product: 'MIS', netQty: 65, buyQty: 65, sellQty: 0, buyAvg: 100, sellAvg: 0, ltp: 145, totalPnl: 2925, isOpen: true }
      ];
    },
    async getAllFunds() {
      return {
        perAccount: {
          acc_a: { availableCash: 100000, totalBalance: 100000 },
          acc_b: { availableCash: 100000, totalBalance: 100000 }
        }
      };
    },
    async exitPosition(pos) {
      exitCalls.push(pos);
      return { success: true, orderId: 'EXIT-' + pos.accountId };
    }
  };
  const fakeCfg = {
    loadConfig: () => ({
      chargeSettings: ChargesCalculator.getDefaultChargeSettings(),
      riskSettings: { autoExitEnabled: true }
    })
  };
  const perAccEngine = new AutoExitEngine(
    fakeMgr,
    {
      getOpeningBalanceData: () => ({
        openingBalance: 200000,
        accounts: [
          { id: 'acc_a', availableCash: 100000, totalBalance: 100000 },
          { id: 'acc_b', availableCash: 100000, totalBalance: 100000 }
        ]
      })
    },
    fakeCfg
  );
  perAccEngine.allowQuietHoursEval = true;
  await perAccEngine._evaluatePositions();
  // Account A hit +2.9% >= +2.0% target -> exited only Account A; Account B (+2.9% < +10.0% target) stays open!
  assert.strictEqual(exitCalls.length, 1, 'Only Account A should exit when Account A hits its own target');
  assert.strictEqual(exitCalls[0].accountId, 'acc_a');
  assert.strictEqual(perAccEngine.getDailyRiskGuardStatus('acc_a').blocked, true, 'Account A breaker must be active');
  assert.strictEqual(perAccEngine.getDailyRiskGuardStatus('acc_b').blocked, false, 'Account B breaker must remain unblocked');
  console.log('   ✅ Per-account SL/Target isolation verified (Account A exited independently; Account B untouched).');

  // 5. SahiBroker Cross-Broker Option Symbol Translation Test
  console.log('\n5. Testing SahiBroker Cross-Broker Option Symbol Translation...');
  const SahiBroker = require('../lib/brokers/sahiBroker');
  const sahiTest = new SahiBroker({ accessToken: 'tok_test', autoConnect: false });
  const sampleCsv = [
    'id,isin,symbol,company_name,underlying_symbol,exchange,segment,token,instrument_type,option_type,expiry_date,strike_price,lot_size',
    '2039678,,NIFTY01DEC26C25000,NIFTY 01DEC26 CE 25000,NIFTY,NSE,NFO,47767,OPTIDX,CE,01-12-2026,25000,65',
    '2039677,,NIFTY01DEC26P25000,NIFTY 01DEC26 PE 25000,NIFTY,NSE,NFO,47768,OPTIDX,PE,01-12-2026,25000,65',
    '2105001,,NIFTY29DEC26P25000,NIFTY 29DEC26 PE 25000,NIFTY,NSE,NFO,71504,OPTIDX,PE,29-12-2026,25000,65'
  ].join('\n');
  const sentBodies = [];
  const origFetch = global.fetch;
  try {
    global.fetch = async (url, opts) => {
      if (String(url).includes('instruments.csv')) {
        return { ok: true, status: 200, text: async () => sampleCsv };
      }
      sentBodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ order_ids: ['SAHI-ORD-1'] }) };
    };
    await sahiTest.placeOrder({ tradingSymbol: 'NIFTY01DEC2625000CE', exchangeSegment: 'nse_fo', transactionType: 'B', orderType: 'MKT', quantity: 65 });
    await sahiTest.placeOrder({ tradingSymbol: 'NIFTY26D0125000PE', exchangeSegment: 'nse_fo', transactionType: 'B', orderType: 'MKT', quantity: 65 });
    await sahiTest.placeOrder({ tradingSymbol: 'NIFTY-DEC2026-25000-PE', exchangeSegment: 'NFO', transactionType: 'B', orderType: 'MKT', quantity: 65 });
    await sahiTest.placeOrder({ tradingSymbol: 'NIFTY26DEC25000PE', exchangeSegment: 'nse_fo', transactionType: 'B', orderType: 'MKT', quantity: 65 });
    await sahiTest.placeOrder({ tradingSymbol: 'NIFTY 01DEC26 25000 CE', exchangeSegment: 'nse_fo', transactionType: 'B', orderType: 'MKT', quantity: 65 });
    await sahiTest.placeOrder({ tradingSymbol: 'NIFTY01DEC26C25000', exchangeSegment: 'NFO', transactionType: 'B', orderType: 'MKT', quantity: 65 });
  } finally {
    global.fetch = origFetch;
  }
  assert.strictEqual(sentBodies[0].symbol, 'NIFTY01DEC26C25000', 'Angel format must translate to Sahi symbol');
  assert.strictEqual(sentBodies[1].symbol, 'NIFTY01DEC26P25000', 'Kotak weekly format must translate to Sahi symbol');
  assert.strictEqual(sentBodies[2].symbol, 'NIFTY29DEC26P25000', 'Dhan monthly format must translate to Sahi monthly expiry');
  assert.strictEqual(sentBodies[3].symbol, 'NIFTY29DEC26P25000', 'Kotak monthly NIFTY26DEC25000PE must translate without splitting 25000');
  assert.strictEqual(sentBodies[4].symbol, 'NIFTY01DEC26C25000', 'Spaced option symbol must translate to Sahi symbol');
  assert.strictEqual(sentBodies[5].symbol, 'NIFTY01DEC26C25000', 'Native Sahi symbol must stay intact');
  console.log('   ✅ SahiBroker translated Angel/Kotak/Dhan/Sahi option symbols cleanly.');

  // 6. Quantity Sizing Using Minimum of Opening Balance & Total Available Funds + Enrich Orders Per-Trade
  console.log('\n6. Testing Min(Opening Balance, Available Funds) Sizing & Per-Trade Order Charges...');
  mgr.setOpeningBalanceProvider(() => ({
    openingBalance: 100000,
    isAutoCaptured: true,
    accounts: [{ id: 'mock_kotak_1', availableCash: 100000, totalBalance: 100000 }]
  }));
  const capCapped = await mgr._sizeForFunds(
    { availableCash: 250000, utilizedMargin: 0 },
    { price: 100, ltp: 100, orderType: 'MKT', transactionType: 'B' },
    { lotSize: 65, freezeQty: 1800 },
    65,
    1800,
    { capitalDeployPct: 100 },
    'mock_kotak_1'
  );
  assert.strictEqual(capCapped.usableCash, 100000, 'When availableCash (250k) > openingBalance (100k), must use 100k');
  assert.strictEqual(capCapped.quantity, 975, '100000 / 100 = 1000 qty -> 15 lots = 975');

  const availCapped = await mgr._sizeForFunds(
    { availableCash: 60000, utilizedMargin: 0 },
    { price: 100, ltp: 100, orderType: 'MKT', transactionType: 'B' },
    { lotSize: 65, freezeQty: 1800 },
    65,
    1800,
    { capitalDeployPct: 100 },
    'mock_kotak_1'
  );
  assert.strictEqual(availCapped.usableCash, 60000, 'When availableCash (60k) < openingBalance (100k), must use 60k');
  assert.strictEqual(availCapped.quantity, 585, '60000 / 100 = 600 qty -> 9 lots = 585');

  const perTradeEnriched = mgr.enrichOrdersWithCharges(
    [
      { orderId: 'T1', broker: 'angelone', symbol: 'NIFTY01DEC2625000CE', transactionType: 'B', quantity: 65, filledQuantity: 65, price: 100, status: 'COMPLETE' },
      { orderId: 'T2', broker: 'angelone', symbol: 'NIFTY01DEC2625000CE', transactionType: 'S', quantity: 65, filledQuantity: 65, price: 110, status: 'COMPLETE' },
      { orderId: 'T3', broker: 'angelone', symbol: 'NIFTY01DEC2625000CE', transactionType: 'B', quantity: 65, filledQuantity: 0, price: 95, status: 'REJECTED' }
    ],
    ChargesCalculator.getDefaultChargeSettings()
  );
  assert.strictEqual(perTradeEnriched[0].chargeDetails.brokerage, 20);
  assert.strictEqual(perTradeEnriched[0].chargeDetails.stampDuty, 1);
  assert.strictEqual(perTradeEnriched[0].chargeDetails.stt, 0);
  assert.strictEqual(perTradeEnriched[1].chargeDetails.brokerage, 20);
  assert.strictEqual(perTradeEnriched[1].chargeDetails.stampDuty, 0);
  assert(perTradeEnriched[1].chargeDetails.stt > 0);
  assert.strictEqual(perTradeEnriched[2].chargeDetails, undefined, 'Rejected order must have no trade charges');
  console.log('   ✅ Min(Opening Balance, Available Funds) sizing & per-trade order charge enrichment verified.');

  // 7. Staged Target Order Logic Test:
  //    - 50% of target price -> SL-LMT Trigger buyPrice + 1.5, Limit buyPrice + 1.0
  //    - 100% of target price -> Exit 50% qty (MKT) + SL-LMT at 50% profit target for remaining 50% qty
  //    - Trail SL every 1/3 of target price move
  console.log('\n7. Testing Staged Target Order Logic (50% Breakeven SL, 100% Partial Exit + 50% SL, 1/3 Trailing)...');
  const stageActions = [];
  let simQty = 130;
  let simLtp = 100;
  const simOrders = new Map();
  let seqId = 1;
  const stageMgr = {
    mockManager: { updateLtpsFromRealFeed() {} },
    getAccountBrokerage() { return { brokerageType: 'zero', brokeragePerOrder: 0 }; },
    getExecutedOrders() { return []; },
    getPositionLotSize() { return 65; },
    getAccountRiskSettings() { return { targetNetProfitPct: 0, stopLossNetPct: 0, nearThresholdBufferPct: 100 }; },
    async getAllFunds() { return { perAccount: { acc_t: { availableCash: 100000, totalBalance: 100000 } } }; },
    async getAllPositions() {
      if (simQty <= 0) return [];
      return [{
        accountId: 'acc_t',
        broker: 'paper',
        brokerName: 'Paper Target',
        symbol: 'NIFTY01DEC26C25000',
        exchangeSegment: 'nse_fo',
        product: 'MIS',
        netQty: simQty,
        buyQty: 130,
        sellQty: 130 - simQty,
        buyAvg: 100,
        sellAvg: 0,
        ltp: simLtp,
        totalPnl: Number(((simLtp - 100) * simQty).toFixed(2)),
        isOpen: true
      }];
    },
    async placeOrder(ord) {
      const id = `ORD-${seqId++}`;
      simOrders.set(id, { ...ord, orderId: id });
      stageActions.push({ op: 'place', ...ord, orderId: id });
      return { success: true, orderId: id, orderIds: [id] };
    },
    async modifyOrReplaceOrder({ orderIds, replacementOrder }) {
      const id = (orderIds && orderIds[0]) || `ORD-${seqId++}`;
      simOrders.set(id, { ...replacementOrder, orderId: id });
      stageActions.push({ op: 'modify', orderId: id, ...replacementOrder });
      return { success: true, orderId: id, orderIds: [id] };
    },
    async exitPosition(pos, reason, overrideQty) {
      const q = overrideQty || pos.netQty;
      simQty -= q;
      stageActions.push({ op: 'exit', quantity: q, reason });
      return { success: true, orderId: `EXIT-${seqId++}` };
    },
    async cancelOrders() {}
  };
  const stageEngine = new AutoExitEngine(
    stageMgr,
    { getOpeningBalanceData: () => ({ openingBalance: 100000, accounts: [{ id: 'acc_t', availableCash: 100000, totalBalance: 100000 }] }) },
    { loadConfig: () => ({ chargeSettings: ChargesCalculator.getDefaultChargeSettings(), riskSettings: { autoExitEnabled: true } }) }
  );
  stageEngine.allowQuietHoursEval = true;
  // Gross target move ~₹20/unit on 130 qty => ~₹2600 target => 100% Target Price ~ ₹120, 50% Target ~ ₹110, 1/3 trail ~ ₹6.65
  stageEngine.setPositionRule('acc_t', 'NIFTY01DEC26C25000', 'MIS', { targetNetProfitINR: 2600, enabled: true });

  // Step A: Evaluate at ₹105 (< 50% target) -> no orders yet
  simLtp = 105;
  await stageEngine._evaluatePositions();
  assert.strictEqual(stageActions.length, 0, 'Must not place SL before 50% target price');
  const initTs = stageEngine.getAllTargetStates()['acc_t_NIFTY01DEC26C25000_MIS'];
  assert.strictEqual(initTs.stage, 'MONITORING');

  // Step B: Move to 50% of target price -> places SL-LMT @ Trigger = Buy + 1.5 (101.50), Limit = Buy + 1.0 (101.00)
  simLtp = initTs.halfTargetPrice;
  await stageEngine._evaluatePositions();
  assert.strictEqual(stageActions.length, 1);
  assert.strictEqual(stageActions[0].op, 'place');
  assert.strictEqual(stageActions[0].orderType, 'SL');
  assert.strictEqual(stageActions[0].quantity, 130);
  assert.strictEqual(stageActions[0].triggerPrice, 101.5);
  assert.strictEqual(stageActions[0].price, 101);
  assert.strictEqual(stageEngine.getAllTargetStates()['acc_t_NIFTY01DEC26C25000_MIS'].stage, 'BREAKEVEN_SL_PLACED');

  // Step C: Move to 100% target price -> modifies SL to 50% target on remaining 65 qty & exits 65 qty (50%)
  simLtp = initTs.fullTargetPrice;
  await stageEngine._evaluatePositions();
  assert.strictEqual(simQty, 65, 'Must exit 50% (65 of 130 qty) when 100% target reached');
  const mod100 = stageActions.find(a => a.op === 'modify');
  assert(mod100, 'Must modify/move SL order to 50% target with remaining qty');
  assert.strictEqual(mod100.quantity, 65);
  assert.strictEqual(mod100.triggerPrice, initTs.halfTargetPrice);
  assert.strictEqual(mod100.price, Number((initTs.halfTargetPrice - 0.5).toFixed(2)));
  assert.strictEqual(stageEngine.getAllTargetStates()['acc_t_NIFTY01DEC26C25000_MIS'].stage, 'TRAILING');

  // Step D: Move further by 1/3 of target price move -> trails SL up by +1/3 step
  const prevSl = mod100.triggerPrice;
  simLtp = Number((initTs.fullTargetPrice + initTs.trailStep + 0.05).toFixed(2));
  await stageEngine._evaluatePositions();
  const modTrail = stageActions.filter(a => a.op === 'modify').pop();
  assert(modTrail.triggerPrice > prevSl, `Trailing SL must advance after 1/3 move (${prevSl} -> ${modTrail.triggerPrice})`);
  console.log(`   ✅ Staged Target workflow verified: 50% SL (${stageActions[0].triggerPrice}/${stageActions[0].price}) -> 100% Exit 50% + SL @ 50% (${mod100.triggerPrice}) -> 1/3 Trail (${modTrail.triggerPrice}).`);

  // 8. Confirmation Gate Test for AutoExitEngine
  console.log('\n8. Testing Confirmation Gate (Nothing Sent Until Confirmed)...');
  const gatedPending = [];
  let brokerSentCount = 0;
  const gateEngine = new AutoExitEngine(
    {
      mockManager: { updateLtpsFromRealFeed() {} },
      getAccountBrokerage() { return { brokerageType: 'zero', brokeragePerOrder: 0 }; },
      getExecutedOrders() { return []; },
      getAccountRiskSettings() { return { targetNetProfitPct: 0, stopLossNetPct: 0, nearThresholdBufferPct: 100 }; },
      async getAllPositions() {
        return [{ accountId: 'acc_g', broker: 'paper', symbol: 'NIFTY01DEC26C25000', product: 'MIS', netQty: 130, buyQty: 130, buyAvg: 100, ltp: 112, totalPnl: 1560, isOpen: true }];
      },
      async placeOrder() { brokerSentCount++; return { success: true, orderId: 'GATED-1' }; }
    },
    { getOpeningBalanceData: () => ({ openingBalance: 100000 }) },
    { loadConfig: () => ({ chargeSettings: ChargesCalculator.getDefaultChargeSettings(), riskSettings: { autoExitEnabled: true } }) }
  );
  gateEngine.allowQuietHoursEval = true;
  gateEngine.setOrderExecutorGate(async req => {
    gatedPending.push(req);
    return { queued: true };
  });
  gateEngine.setPositionRule('acc_g', 'NIFTY01DEC26C25000', 'MIS', { targetNetProfitINR: 2600, enabled: true });
  await gateEngine._evaluatePositions();
  assert.strictEqual(gatedPending.length, 1, 'Confirmation gate must intercept order before calling broker');
  assert.strictEqual(brokerSentCount, 0, 'Broker must NOT receive order before confirmation');
  await gatedPending[0].executeFn();
  assert.strictEqual(brokerSentCount, 1, 'Broker must receive order only after user confirms');
  console.log('   ✅ Order confirmation gate verified: broker blocked until user confirms.');

  // 9. 150% Profit Target -> Cancel ALL Pending Orders + Confirmations & Send 125% SL Without Confirmation
  console.log('\n9. Testing 150% Profit Target (Cancel All Pending + 125% Profit SL Without Confirmation)...');
  const cancelCalls = [];
  const placed150 = [];
  let gateCalledDuring150 = false;
  let cancelConfirmEvent = null;
  let ltp150 = 105;

  const mockInst150 = {
    async getOrderBook() {
      return [
        { orderId: 'OPEN-1', accountId: 'acc_150', symbol: 'NIFTY01DEC26C25000', status: 'OPEN' },
        { orderId: 'TRIG-2', accountId: 'acc_150', symbol: 'NIFTY01DEC26C25000', status: 'TRIGGER PENDING' },
        { orderId: 'DONE-3', accountId: 'acc_150', symbol: 'NIFTY01DEC26C25000', status: 'COMPLETE' },
        { orderId: 'OTHER-4', accountId: 'acc_150', symbol: 'NIFTY01DEC26P25000', status: 'OPEN' }
      ];
    },
    async cancelOrder(oid) {
      cancelCalls.push(oid);
    }
  };
  const mgr150 = new MultiBrokerManager(
    { loadConfig: () => ({ mode: 'live', accounts: [] }) },
    { createAdapter: () => null },
    null
  );
  mgr150.brokerInstances.set('acc_150', mockInst150);

  const engine150Mgr = {
    mockManager: { updateLtpsFromRealFeed() {} },
    getAccountBrokerage() { return { brokerageType: 'zero', brokeragePerOrder: 0 }; },
    getExecutedOrders() { return []; },
    getPositionLotSize() { return 65; },
    getAccountRiskSettings() { return { targetNetProfitPct: 0, stopLossNetPct: 0, nearThresholdBufferPct: 100 }; },
    async getAllPositions() {
      return [{
        accountId: 'acc_150',
        broker: 'kotak',
        symbol: 'NIFTY01DEC26C25000',
        exchangeSegment: 'nse_fo',
        product: 'MIS',
        netQty: 130,
        buyQty: 130,
        buyAvg: 100,
        ltp: ltp150,
        totalPnl: Number(((ltp150 - 100) * 130).toFixed(2)),
        isOpen: true
      }];
    },
    cancelAllPendingOrdersForPosition: mgr150.cancelAllPendingOrdersForPosition.bind(mgr150),
    async placeOrder(ord) {
      placed150.push(ord);
      return { success: true, orderId: `SL125-${placed150.length}`, orderIds: [`SL125-${placed150.length}`] };
    }
  };

  const engine150 = new AutoExitEngine(
    engine150Mgr,
    { getOpeningBalanceData: () => ({ openingBalance: 100000 }) },
    { loadConfig: () => ({ chargeSettings: ChargesCalculator.getDefaultChargeSettings(), riskSettings: { autoExitEnabled: true } }) }
  );
  engine150.allowQuietHoursEval = true;
  engine150.on('cancel_pending_confirmations', ev => { cancelConfirmEvent = ev; });
  engine150.setOrderExecutorGate(async () => {
    gateCalledDuring150 = true;
    return { queued: true };
  });
  engine150.setPositionRule('acc_150', 'NIFTY01DEC26C25000', 'MIS', { targetNetProfitINR: 2600, enabled: true });

  // Initialize state at ₹105 (<50%)
  await engine150._evaluatePositions();
  const ts150 = engine150.getAllTargetStates()['acc_150_NIFTY01DEC26C25000_MIS'];
  assert(ts150 && ts150.target150Price > ts150.target125Price, 'Expected valid 125% & 150% price levels');

  // Price jumps to >= 150% of profit target -> must NOT invoke confirmation gate, must cancel OPEN-1 & TRIG-2 (not DONE-3 or OTHER-4), and must place SL @ target125Price
  ltp150 = ts150.target150Price;
  await engine150._evaluatePositions();

  assert.strictEqual(gateCalledDuring150, false, '150% trigger MUST bypass order confirmation gate');
  assert(cancelConfirmEvent && cancelConfirmEvent.symbol === 'NIFTY01DEC26C25000', 'Must emit cancel_pending_confirmations event');
  assert.deepStrictEqual(cancelCalls.sort(), ['OPEN-1', 'TRIG-2'], 'Must cancel all open/pending orders for that symbol only');
  assert.strictEqual(placed150.length, 1, 'Must place 125% profit SL order directly without confirmation');
  assert.strictEqual(placed150[0].orderType, 'SL');
  assert.strictEqual(placed150[0].transactionType, 'S');
  assert.strictEqual(placed150[0].quantity, 130);
  assert.strictEqual(placed150[0].triggerPrice, ts150.target125Price);
  assert.strictEqual(placed150[0].price, Number((ts150.target125Price - 0.5).toFixed(2)));
  assert.strictEqual(engine150.getAllTargetStates()['acc_150_NIFTY01DEC26C25000_MIS'].hit150Locked, true);

  // Re-evaluate at same 150% price -> must NOT place duplicate SL
  await engine150._evaluatePositions();
  assert.strictEqual(placed150.length, 1, 'Must not place duplicate 125% SL order on subsequent ticks');
  console.log(`   ✅ 150% Profit Target verified: cancelled ${cancelCalls.join(', ')} & sent 125% SL @ ${ts150.target125Price} without confirmation.`);

  // 10. Signed Stop Loss (-ve Loss SL w/ Charges vs +ve Profit SL when LTP > Target) & Cancel Pending SL Before Target Order
  console.log('\n10. Testing Signed Stop Loss (-10% Loss SL, +10% Profit SL, & Cancel Pending SL Before Profit Target)...');
  let slTestLtp = 100;
  let slTestQty = 100;
  const slTimeline = [];
  let slOrdSeq = 1;
  let openPendingSlIds = [];

  const slMgr = {
    mockManager: { updateLtpsFromRealFeed() {} },
    getAccountBrokerage() { return { brokerageType: 'flat', brokeragePerOrder: 20 }; },
    getExecutedOrders() {
      return [{ orderId: 'BUY-1', accountId: 'acc_sl', symbol: 'NIFTY01DEC26C25000', transactionType: 'B', quantity: 100, filledQuantity: 100, price: 100, status: 'COMPLETE' }];
    },
    getPositionLotSize() { return 50; },
    getAccountRiskSettings() { return { targetNetProfitPct: 0, stopLossNetPct: 0, nearThresholdBufferPct: 100 }; },
    async getAllPositions() {
      if (slTestQty <= 0) return [];
      return [{
        accountId: 'acc_sl',
        broker: 'angelone',
        symbol: 'NIFTY01DEC26C25000',
        exchangeSegment: 'NFO',
        product: 'MIS',
        netQty: slTestQty,
        buyQty: 100,
        buyAvg: 100,
        ltp: slTestLtp,
        totalPnl: Number(((slTestLtp - 100) * slTestQty).toFixed(2)),
        isOpen: true
      }];
    },
    async cancelAllPendingOrdersForPosition(accId, brk, sym, extraIds = [], excludeIds = []) {
      const ex = new Set(excludeIds);
      const cancelledIds = Array.from(new Set([...openPendingSlIds, ...extraIds])).filter(id => !ex.has(id));
      openPendingSlIds = openPendingSlIds.filter(id => !cancelledIds.includes(id));
      if (cancelledIds.length > 0) slTimeline.push({ op: 'cancelPending', cancelledIds });
      return { cancelledIds };
    },
    async placeOrder(ord) {
      const id = `SLTEST-${slOrdSeq++}`;
      openPendingSlIds.push(id);
      slTimeline.push({ op: 'place', orderId: id, ...ord });
      return { success: true, orderId: id, orderIds: [id] };
    },
    async exitPosition(pos, reason, overrideQty) {
      const q = overrideQty || pos.netQty;
      slTestQty -= q;
      slTimeline.push({ op: 'exit', quantity: q, reason });
      return { success: true, orderId: `EXITSL-${slOrdSeq++}` };
    }
  };

  const slEngine = new AutoExitEngine(
    slMgr,
    { getOpeningBalanceData: () => ({ openingBalance: 10000, accounts: [{ id: 'acc_sl', availableCash: 10000, totalBalance: 10000 }] }) },
    { loadConfig: () => ({ chargeSettings: ChargesCalculator.getDefaultChargeSettings(), riskSettings: { autoExitEnabled: true } }) }
  );
  slEngine.allowQuietHoursEval = true;

  // Case 10A: Opening balance ₹10,000, Bought 100 @ ₹100, SL = -10% -> must place SL-LMT @ ~90.70 trig / ~90.20 limit (charge-adjusted -₹1000 Net)
  slEngine.setPositionRule('acc_sl', 'NIFTY01DEC26C25000', 'MIS', {
    stopLossNetPct: -10,
    targetNetProfitPct: 30, // Target +30% (+₹3000 -> 50% at ~115.4)
    nearThresholdBufferPct: 100,
    enabled: true
  });
  await slEngine._evaluatePositions();
  const negSlPlace = slTimeline.find(e => e.op === 'place');
  assert(negSlPlace, 'Negative -10% SL must send SL-LMT order when LTP > trigger');
  assert(negSlPlace.triggerPrice > 90 && negSlPlace.triggerPrice < 91.5, `Expected -10% SL trigger ~90.70 incl. charges, got ${negSlPlace.triggerPrice}`);
  assert.strictEqual(negSlPlace.price, Number((negSlPlace.triggerPrice - 0.5).toFixed(2)), 'Limit must be 0.50 below SL trigger');

  // Case 10B: Profit reaches 50% of Target -> must cancel pending -10% SL order BEFORE sending target order
  const negSlId = negSlPlace.orderId;
  slTestLtp = 116;
  await slEngine._evaluatePositions();
  const cancelIdx = slTimeline.findIndex(e => e.op === 'cancelPending' && e.cancelledIds.includes(negSlId));
  const stage1Idx = slTimeline.findIndex(e => e.op === 'place' && String(e.reason || '').includes('50% Target'));
  assert(cancelIdx >= 0 && stage1Idx > cancelIdx, 'Must cancel pending SL order BEFORE sending profit target order');

  // Case 10C: Fresh position with Positive SL = +10% (Opening ₹10,000, 100 qty @ ₹100)
  slTimeline.length = 0;
  openPendingSlIds = [];
  slEngine.targetStates.clear();
  slEngine.positionRules.clear();
  slTestQty = 100;
  slEngine.setPositionRule('acc_sl', 'NIFTY01DEC26C25000', 'MIS', {
    stopLossNetPct: 10, // Positive +10% Profit SL -> ~110.75 incl. charges
    targetNetProfitPct: 0,
    enabled: true
  });

  // At LTP ₹105 (below +10% target ~110.75) -> NO SL order yet, NO false loss exit!
  slTestLtp = 105;
  await slEngine._evaluatePositions();
  assert.strictEqual(slTimeline.length, 0, 'Positive +10% SL must NOT exit at loss or place SL when LTP <= SL target');

  // At LTP ₹113 (above +10% target ~110.75) -> sends SL order in profit @ ~110.75 / ~110.25!
  slTestLtp = 113;
  await slEngine._evaluatePositions();
  const posSlPlace = slTimeline.find(e => e.op === 'place');
  assert(posSlPlace, 'Positive +10% SL must send Profit SL-LMT order once LTP > profit SL price');
  assert(posSlPlace.triggerPrice >= 110 && posSlPlace.triggerPrice < 112, `Expected +10% profit SL trigger ~110.75 incl. charges, got ${posSlPlace.triggerPrice}`);
  assert.strictEqual(posSlPlace.price, Number((posSlPlace.triggerPrice - 0.5).toFixed(2)));

  // Case 10D: Price crashes on negative -10% SL (unprotected/gapped) -> must exit on loss
  slTimeline.length = 0;
  openPendingSlIds = [];
  slEngine.targetStates.clear();
  slEngine.positionRules.clear();
  slTestQty = 100;
  slTestLtp = 88;
  slEngine.setPositionRule('acc_sl', 'NIFTY01DEC26C25000', 'MIS', { stopLossNetPct: -10, enabled: true });
  await slEngine._evaluatePositions();
  assert(slTimeline.some(e => e.op === 'exit'), 'Negative SL must exit on loss when threshold is breached');
  console.log(`   ✅ Signed SL verified: -10% SL (${negSlPlace.triggerPrice}/${negSlPlace.price}) -> cancelled before Target (${stage1Idx > cancelIdx}) -> +10% Profit SL (${posSlPlace.triggerPrice}/${posSlPlace.price}) -> loss breach exit.`);

  // 11. Market Order -> Limit Order at Current Live Price (LTP)
  console.log('\n11. Testing Market Order -> Limit Order at Current Price (LTP)...');
  const sentToBroker = [];
  const mktToLmtMgr = new MultiBrokerManager(
    { loadConfig: () => ({ mode: 'live', accounts: [] }) },
    { createAdapter: () => null },
    null
  );
  mktToLmtMgr.brokerInstances.set('acc_lmt', {
    id: 'acc_lmt',
    broker: 'kotakneo',
    isMock: false,
    isAuthenticated: true,
    async getFunds() { return { availableCash: 100000, utilizedMargin: 0, totalBalance: 100000 }; },
    async placeOrder(ord) {
      sentToBroker.push(ord);
      return { success: true, orderId: `ORD-LMT-${sentToBroker.length}` };
    }
  });

  const mktPlaceRes = await mktToLmtMgr.placeOrder({
    accountId: 'acc_lmt',
    tradingSymbol: 'NIFTY01DEC26C25000',
    exchangeSegment: 'nse_fo',
    transactionType: 'B',
    orderType: 'MKT',
    quantity: 65,
    price: 0,
    ltp: 142.33
  });
  assert.strictEqual(mktPlaceRes.convertedFromMkt, true);
  assert.strictEqual(sentToBroker.length, 1);
  assert.strictEqual(sentToBroker[0].orderType, 'L', 'MKT order with live LTP must be dispatched as Limit (L)');
  assert.strictEqual(sentToBroker[0].price, 142.35, 'Limit price must match current price rounded to 0.05 tick');

  await mktToLmtMgr.exitPosition({
    accountId: 'acc_lmt',
    broker: 'kotakneo',
    symbol: 'NIFTY01DEC26C25000',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    netQty: 65,
    ltp: 118.42
  }, 'Exit at LTP Limit');
  assert.strictEqual(sentToBroker.length, 2);
  assert.strictEqual(sentToBroker[1].orderType, 'L', 'exitPosition must convert MKT exit to Limit (L) at position LTP');
  assert.strictEqual(sentToBroker[1].price, 118.4);
  console.log(`   ✅ MKT->LMT conversion verified: entry LMT @ ₹${sentToBroker[0].price}, exit LMT @ ₹${sentToBroker[1].price}.`);

  // 12. Manage-Orders Checkbox Gating (Only Selected Brokers Manage Orders)
  console.log('\n12. Testing Manage-Orders Checkbox Gating Across MultiBrokerManager & AutoExitEngine...');
  const rawAccList = [
    { id: 'acc_managed', broker: 'kotakneo', name: 'Managed Broker', enabled: true, manageOrders: true },
    { id: 'acc_viewonly', broker: 'angelone', name: 'View-Only Broker', enabled: true, manageOrders: false }
  ];
  const gatedBrokerOrders = [];
  const manageMgr = new MultiBrokerManager(
    { loadConfig: () => ({ mode: 'live', accounts: [] }) },
    { createAdapter: () => null },
    null
  );
  manageMgr.getRawAccounts = () => rawAccList;
  manageMgr.brokerInstances.set('acc_managed', {
    id: 'acc_managed',
    broker: 'kotakneo',
    name: 'Managed Broker',
    isMock: false,
    isAuthenticated: true,
    async getFunds() { return { availableCash: 100000, utilizedMargin: 0, totalBalance: 100000 }; },
    async placeOrder(ord) {
      gatedBrokerOrders.push({ acc: 'acc_managed', ...ord });
      return { success: true, orderId: 'MGD-1' };
    }
  });
  manageMgr.brokerInstances.set('acc_viewonly', {
    id: 'acc_viewonly',
    broker: 'angelone',
    name: 'View-Only Broker',
    isMock: false,
    isAuthenticated: true,
    async getFunds() { return { availableCash: 100000, utilizedMargin: 0, totalBalance: 100000 }; },
    async placeOrder(ord) {
      gatedBrokerOrders.push({ acc: 'acc_viewonly', ...ord });
      return { success: true, orderId: 'VW-1' };
    }
  });

  // Direct placeOrder on unchecked account must throw
  let blockedViewOnly = false;
  try {
    await manageMgr.placeOrder({
      accountId: 'acc_viewonly',
      tradingSymbol: 'NIFTY01DEC26C25000',
      exchangeSegment: 'nse_fo',
      transactionType: 'B',
      orderType: 'L',
      quantity: 65,
      price: 100
    });
  } catch (e) {
    blockedViewOnly = String(e.message || '').includes('Order management is disabled');
  }
  assert.strictEqual(blockedViewOnly, true, 'Unchecked broker must be rejected for order placement');

  // all_funded routing must send ONLY to checked broker
  const allFundedRes = await manageMgr.placeOrder({
    routingMode: 'all_funded',
    tradingSymbol: 'NIFTY01DEC26C25000',
    exchangeSegment: 'nse_fo',
    transactionType: 'B',
    orderType: 'L',
    quantity: 65,
    price: 100
  });
  assert.strictEqual(allFundedRes.executedCount, 1, 'Only 1 checked broker should receive routed order');
  assert.strictEqual(gatedBrokerOrders.length, 1);
  assert.strictEqual(gatedBrokerOrders[0].acc, 'acc_managed');

  // AutoExitEngine must touch ONLY checked account positions
  const autoExitTouched = [];
  const managedAutoEngine = new AutoExitEngine(
    {
      mockManager: { updateLtpsFromRealFeed() {} },
      isAccountOrderManaged: id => manageMgr.isAccountOrderManaged(id),
      getAccountBrokerage() { return { brokerageType: 'zero', brokeragePerOrder: 0 }; },
      getExecutedOrders() { return []; },
      getPositionLotSize() { return 65; },
      getAccountRiskSettings() { return { targetNetProfitPct: 10, stopLossNetPct: -10, nearThresholdBufferPct: 100 }; },
      async getAllPositions() {
        return [
          { accountId: 'acc_managed', broker: 'kotakneo', brokerName: 'Managed', symbol: 'NIFTY01DEC26C25000', product: 'MIS', netQty: 65, buyQty: 65, buyAvg: 100, ltp: 117, totalPnl: 1105, isOpen: true },
          { accountId: 'acc_viewonly', broker: 'angelone', brokerName: 'ViewOnly', symbol: 'NIFTY01DEC26P25000', product: 'MIS', netQty: 65, buyQty: 65, buyAvg: 100, ltp: 117, totalPnl: 1105, isOpen: true }
        ];
      },
      async placeOrder(ord) {
        autoExitTouched.push(ord.accountId);
        return { success: true, orderId: 'AE-ORD-' + ord.accountId };
      },
      async exitPosition(pos) {
        autoExitTouched.push(pos.accountId);
        return { success: true, orderId: 'AE-' + pos.accountId };
      }
    },
    { getOpeningBalanceData: () => ({ openingBalance: 10000, accounts: [{ id: 'acc_managed', totalBalance: 10000 }, { id: 'acc_viewonly', totalBalance: 10000 }] }) },
    { loadConfig: () => ({ chargeSettings: ChargesCalculator.getDefaultChargeSettings(), riskSettings: { autoExitEnabled: true } }) }
  );
  managedAutoEngine.allowQuietHoursEval = true;
  await managedAutoEngine._evaluatePositions();
  assert.deepStrictEqual(autoExitTouched, ['acc_managed'], 'AutoExitEngine must exit/manage ONLY checked broker accounts');
  console.log('   ✅ Manage-Orders checkbox gating verified: unchecked broker excluded from manual orders, routing, and Auto-Exit.');

  // 13. Order Window Bulk Stoploss Button (-ve = buyPrice - % of min(open, avail); +ve = buyPrice + charges + % of min(open, avail))
  console.log('\n13. Testing Order Window Bulk Stoploss for Selected Brokers...');
  const bulkSlSent = [];
  const bulkSlMgr = new MultiBrokerManager(
    {
      loadConfig: () => ({
        mode: 'live',
        chargeSettings: ChargesCalculator.getDefaultChargeSettings(),
        riskSettings: { autoExitEnabled: true }
      })
    },
    { createAdapter: () => null },
    null
  );
  bulkSlMgr.setOpeningBalanceProvider(() => ({
    openingBalance: 20000,
    accounts: [
      { id: 'acc_sl_m1', availableCash: 15000, totalBalance: 15000 }, // min(15000, available=10000) = 10000
      { id: 'acc_sl_m2', availableCash: 10000, totalBalance: 10000 }  // min(10000, available=20000) = 10000
    ]
  }));
  bulkSlMgr.getRawAccounts = () => [
    { id: 'acc_sl_m1', broker: 'kotakneo', name: 'Kotak Managed', enabled: true, manageOrders: true, brokerageType: 'zero', brokeragePerOrder: 0 },
    { id: 'acc_sl_m2', broker: 'angelone', name: 'Angel Managed', enabled: true, manageOrders: true, brokerageType: 'flat', brokeragePerOrder: 20 },
    { id: 'acc_sl_u3', broker: 'dhan', name: 'Dhan Unchecked', enabled: true, manageOrders: false }
  ];
  let bulkLtp = 100;
  const makeBulkInst = (id, broker, avail) => ({
    id,
    broker,
    name: id,
    isMock: false,
    isAuthenticated: true,
    async getFunds() { return { availableCash: 0, utilizedMargin: avail, totalBalance: avail }; },
    async getPositions() {
      return [{
        accountId: id,
        broker,
        brokerName: id,
        symbol: 'NIFTY01DEC26C25000',
        exchangeSegment: 'nse_fo',
        product: 'MIS',
        netQty: 100,
        buyQty: 100,
        buyAvg: 100,
        ltp: bulkLtp,
        isOpen: true
      }];
    },
    async getOrderBook() { return []; },
    async placeOrder(ord) {
      bulkSlSent.push({ id, ...ord });
      return { success: true, orderId: `BSL-${id}-${bulkSlSent.length}` };
    }
  });
  bulkSlMgr.brokerInstances.set('acc_sl_m1', makeBulkInst('acc_sl_m1', 'kotakneo', 10000)); // min(15000,10000) = 10000
  bulkSlMgr.brokerInstances.set('acc_sl_m2', makeBulkInst('acc_sl_m2', 'angelone', 20000)); // min(10000,20000) = 10000
  bulkSlMgr.brokerInstances.set('acc_sl_u3', makeBulkInst('acc_sl_u3', 'dhan', 50000));     // unchecked -> MUST be ignored!

  // Case 13A: Negative SL (-10%) -> buyingPrice (100) - 10% of min(open, avail) (1000/100 = 10) = 90.00 trigger / 89.50 limit
  bulkLtp = 100;
  const negBulkRes = await bulkSlMgr.sendStopLossForManagedPositions({ slPct: -10, scope: 'all_managed', preview: false });
  assert.strictEqual(negBulkRes.sent.length, 2, 'Must send SL for both checked brokers only (ignoring unchecked Dhan)');
  assert(bulkSlSent.every(o => o.id !== 'acc_sl_u3'), 'Unchecked broker must NOT receive SL order');
  assert.strictEqual(negBulkRes.sent[0].capitalBase, 10000);
  assert.strictEqual(negBulkRes.sent[0].triggerPrice, 90);
  assert.strictEqual(negBulkRes.sent[0].limitPrice, 89.5);
  assert.strictEqual(negBulkRes.sent[1].capitalBase, 10000);
  assert.strictEqual(negBulkRes.sent[1].triggerPrice, 90);

  // Case 13B: Positive SL (+10%) while LTP = 105 (below +10% SL) -> skipped cleanly
  bulkSlSent.length = 0;
  bulkLtp = 105;
  const posSkipRes = await bulkSlMgr.sendStopLossForManagedPositions({ slPct: 10, scope: 'all_managed', preview: false });
  assert.strictEqual(posSkipRes.sent.length, 0);
  assert.strictEqual(posSkipRes.skipped.length, 2, 'Must skip +10% SL when LTP (105) is below trigger');

  // Case 13C: Positive SL (+10%) while LTP = 115 (> trigger) -> sends SL at buyingPrice + charges + 10% of min(open, avail)
  bulkLtp = 115;
  const posSendRes = await bulkSlMgr.sendStopLossForManagedPositions({ slPct: 10, scope: 'all_managed', preview: false });
  assert.strictEqual(posSendRes.sent.length, 2);
  // Zero-brokerage Kotak: charges ~ ₹26.3 => trigger ~ 110.25; ₹20/ord Angel: charges ~ ₹73.5 => trigger ~ 110.75
  assert(posSendRes.sent[0].triggerPrice >= 110.2 && posSendRes.sent[0].triggerPrice <= 110.35, `Expected Kotak +10% SL ~110.25, got ${posSendRes.sent[0].triggerPrice}`);
  assert(posSendRes.sent[1].triggerPrice >= 110.7 && posSendRes.sent[1].triggerPrice <= 110.85, `Expected Angel +10% SL ~110.75, got ${posSendRes.sent[1].triggerPrice}`);
  assert(posSendRes.sent[1].chargesINR > posSendRes.sent[0].chargesINR, 'Broker with ₹20/ord brokerage must include higher charges than ₹0/ord');
  console.log(`   ✅ Order Window Bulk SL verified: -10% @ ₹${negBulkRes.sent[0].triggerPrice}, +10% Kotak @ ₹${posSendRes.sent[0].triggerPrice} / Angel @ ₹${posSendRes.sent[1].triggerPrice}.`);

  // Case 13D: Order Window Bulk Target Limit Order (+10%) -> sends Limit ('L') order at buyingPrice + charges + 10% of min(open, avail) even when LTP (100) < Target (110+)!
  bulkSlSent.length = 0;
  bulkLtp = 100;
  const tgtRes = await bulkSlMgr.sendTargetForManagedPositions({ targetPct: 10, qtyPct: 100, scope: 'all_managed', preview: false });
  assert.strictEqual(tgtRes.sent.length, 2, 'Target Limit must send for both checked brokers even when LTP < Target');
  assert.strictEqual(tgtRes.sent[0].orderType, 'L');
  assert.strictEqual(tgtRes.sent[0].triggerPrice, 0, 'Target Limit order must have triggerPrice = 0');
  assert.strictEqual(tgtRes.sent[0].quantity, 100);
  assert(tgtRes.sent[0].limitPrice >= 110.2 && tgtRes.sent[0].limitPrice <= 110.35, `Expected Kotak +10% Target Limit ~110.25, got ${tgtRes.sent[0].limitPrice}`);
  assert(tgtRes.sent[1].limitPrice >= 110.7 && tgtRes.sent[1].limitPrice <= 110.85, `Expected Angel +10% Target Limit ~110.75, got ${tgtRes.sent[1].limitPrice}`);
  assert.strictEqual(bulkSlSent[0].orderType, 'L');
  assert.strictEqual(bulkSlSent[0].triggerPrice, 0);
  assert.strictEqual(bulkSlSent[1].orderType, 'L');

  // Case 13E: Partial Target Limit Order quantities (50% quantity & 25% quantity with lot ceiling, e.g. 325 = 5 lots -> ceil(5/2)=3 -> 195)
  bulkSlSent.length = 0;
  const tgt50Res = await bulkSlMgr.sendTargetForManagedPositions({ targetPct: 10, qtyPct: 50, scope: 'all_managed', preview: false });
  assert.strictEqual(tgt50Res.sent[0].quantity, 50, '50% quantity target must send 50 of 100 qty');
  assert.strictEqual(tgt50Res.sent[0].limitPrice, tgtRes.sent[0].limitPrice, 'Partial target must keep exact target price level');
  const tgt25Res = await bulkSlMgr.sendTargetForManagedPositions({ targetPct: 10, qtyPct: 25, scope: 'all_managed', preview: false });
  assert.strictEqual(tgt25Res.sent[0].quantity, 25, '25% quantity target must send 25 of 100 qty');

  // Verify exact 325 qty (5 lots of 65): 50% -> ceil(5/2) = 3 lots = 195; 25% -> ceil(5/4) = 2 lots = 130
  const lot5Inst = bulkSlMgr.brokerInstances.get('acc_sl_m1');
  const origGetPos = lot5Inst.getPositions.bind(lot5Inst);
  lot5Inst.getPositions = async () => {
    const rows = await origGetPos();
    return [{ ...rows[0], netQty: 325, buyQty: 325 }];
  };
  const tgt325_50 = await bulkSlMgr.sendTargetForManagedPositions({ targetPct: 10, qtyPct: 50, accountId: 'acc_sl_m1', scope: 'selected', preview: true });
  assert.strictEqual(tgt325_50.items[0].quantity, 195, '325 qty (5 lots) at 50% must ceil to 3 lots = 195');
  const tgt325_25 = await bulkSlMgr.sendTargetForManagedPositions({ targetPct: 10, qtyPct: 25, accountId: 'acc_sl_m1', scope: 'selected', preview: true });
  assert.strictEqual(tgt325_25.items[0].quantity, 130, '325 qty (5 lots) at 25% must ceil to 2 lots = 130');
  console.log(`   ✅ Order Window Bulk Target Limit verified: LMT Kotak @ ₹${tgtRes.sent[0].limitPrice} / Angel @ ₹${tgtRes.sent[1].limitPrice} (325 -> 50%:${tgt325_50.items[0].quantity}, 25%:${tgt325_25.items[0].quantity}).`);

  // 14. Paper Account Net Position P&L Balance Sync & Automatic Carry-Forward Across Restart & New Day
  console.log('\n14. Testing Paper Account Net Position P&L Balance Sync & Auto Carry-Forward...');
  const paperCarryPath = path.join(os.tmpdir(), `paper-carry-${Date.now()}.json`);
  const paperCfg = {
    id: 'paper_carry_1',
    name: 'Paper Carry Test',
    initialBalance: 100000,
    brokerageType: 'flat',
    brokeragePerOrder: 20,
    chargeSettings: ChargesCalculator.getDefaultChargeSettings(),
    enforceMarketHours: false,
    stateFile: paperCarryPath
  };
  let paperCarry = new PaperBroker(paperCfg);
  await paperCarry.login();
  await paperCarry.placeOrder({
    tradingSymbol: 'NIFTY01DEC26C25000',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    transactionType: 'B',
    orderType: 'L',
    quantity: 100,
    price: 100,
    ltp: 100
  });
  // Live price rises to ₹120 -> unrealized = +2000, minus round-trip charges (~75) => Net Position P&L updates Paper Balance!
  paperCarry.syncWithNiftySnapshot({
    strikes: [{ strike: 25000, ce: { symbol: 'NIFTY01DEC26C25000', ltp: 120 }, pe: { symbol: 'NIFTY01DEC26P25000', ltp: 90 } }]
  });
  const openFunds = await paperCarry.getFunds();
  assert(openFunds.netPnl > 1950 && openFunds.netPnl < 1985, `Expected Net P&L after buy charges ~1971.2, got ${openFunds.netPnl}`);
  assert.strictEqual(openFunds.totalBalance, Number((100000 + openFunds.netPnl).toFixed(2)), 'Paper totalBalance must reflect Net Position P&L');
  assert.strictEqual(openFunds.availableCash, Number((openFunds.totalBalance - 10000).toFixed(2)), 'Paper availableCash must reflect Net Equity minus utilized margin');

  // Close position at ₹120
  await paperCarry.placeOrder({
    tradingSymbol: 'NIFTY01DEC26C25000',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    transactionType: 'S',
    orderType: 'L',
    quantity: 100,
    price: 120,
    ltp: 120
  });
  const closedFunds = await paperCarry.getFunds();
  const expectedDay1End = closedFunds.totalBalance;
  assert(expectedDay1End > 101900 && expectedDay1End < 101950);
  assert.strictEqual(closedFunds.availableCash, expectedDay1End);

  // Simulate server restart on same day -> carried equity must remain intact
  paperCarry = new PaperBroker(paperCfg);
  assert.strictEqual((await paperCarry.getFunds()).totalBalance, expectedDay1End, 'Must carry balance across restart');

  // Simulate next trading day rollover -> previous net P&L carries forward into new day carriedBalance automatically!
  const rolled = paperCarry.rolloverIfNewDay('2099-12-31');
  assert.strictEqual(rolled, true);
  const day2Funds = await paperCarry.getFunds();
  assert.strictEqual(day2Funds.carriedBalance, expectedDay1End, 'Next day carriedBalance must equal Day 1 ending net balance');
  assert.strictEqual(day2Funds.availableCash, expectedDay1End, 'Next day availableCash must carry forward automatically');
  assert.strictEqual((await paperCarry.getPositions()).length, 0, 'Prior day MIS/closed positions clear after carrying P&L forward');

  // Verify MultiBrokerManager exposes live carried balance on getAccounts() & getAccountOpeningBalance()
  const paperMgr = new MultiBrokerManager(
    { loadConfig: () => ({ mode: 'live', chargeSettings: ChargesCalculator.getDefaultChargeSettings(), riskSettings: {} }) },
    { createAdapter: () => null },
    null
  );
  paperMgr.getRawAccounts = () => [{ id: 'paper_carry_1', broker: 'paper', name: 'Paper Carry Test', enabled: true, initialBalance: 100000 }];
  paperMgr.brokerInstances.set('paper_carry_1', paperCarry);
  const accListWithCarry = paperMgr.getAccounts();
  assert.strictEqual(accListWithCarry[0].availableCash, expectedDay1End);
  assert.strictEqual(accListWithCarry[0].carriedBalance, expectedDay1End);
  assert.strictEqual(paperMgr.getAccountOpeningBalance('paper_carry_1'), expectedDay1End);

  paperCarry.deleteStateFile();
  if (fs.existsSync(paperCarryPath)) fs.unlinkSync(paperCarryPath);
  console.log(`   ✅ Paper Account Net P&L & Auto Carry-Forward verified: Start ₹100,000 -> End/Carry ₹${expectedDay1End}.`);

  console.log('\n🧪 Test 15: MultiBrokerManager.getAccounts() Exposes Available Balance for All Brokers...');
  const balMgr = new MultiBrokerManager(
    { loadConfig: () => ({ mode: 'live', chargeSettings: ChargesCalculator.getDefaultChargeSettings(), riskSettings: {} }) },
    { createAdapter: () => null },
    null
  );
  balMgr.getRawAccounts = () => [
    { id: 'angel_live', broker: 'angelone', name: 'Angel Live', enabled: true },
    { id: 'dhan_live', broker: 'dhan', name: 'Dhan Live', enabled: true },
    { id: 'kotak_live', broker: 'kotak', name: 'Kotak Live', enabled: true },
    { id: 'sahi_live', broker: 'sahi', name: 'Sahi Live', enabled: true },
    { id: 'paper_live', broker: 'paper', name: 'Paper Live', enabled: true, initialBalance: 150000 }
  ];
  balMgr.brokerInstances.set('angel_live', { _cache: { funds: { data: { availableCash: 120000, utilizedMargin: 15000, totalBalance: 135000 } } } });
  balMgr.brokerInstances.set('dhan_live', { _cache: { funds: { data: { availableCash: 220000, utilizedMargin: 5000, totalBalance: 225000 } } } });
  balMgr.brokerInstances.set('kotak_live', { _cache: { funds: { data: { availableCash: 320000, utilizedMargin: 0, totalBalance: 320000 } } } });
  balMgr.brokerInstances.set('sahi_live', { _cache: { funds: { data: { availableCash: 420000, utilizedMargin: 20000, totalBalance: 440000 } } } });
  balMgr.brokerInstances.set('paper_live', { isPaper: true, getFundsSnapshot: () => ({ availableCash: 148500, utilizedMargin: 1500, totalBalance: 150000, carriedBalance: 150000 }) });

  const allAccountsWithBal = balMgr.getAccounts();
  assert.strictEqual(allAccountsWithBal.find(a => a.id === 'angel_live').availableCash, 120000);
  assert.strictEqual(allAccountsWithBal.find(a => a.id === 'dhan_live').availableCash, 220000);
  assert.strictEqual(allAccountsWithBal.find(a => a.id === 'kotak_live').availableCash, 320000);
  assert.strictEqual(allAccountsWithBal.find(a => a.id === 'sahi_live').availableCash, 420000);
  assert.strictEqual(allAccountsWithBal.find(a => a.id === 'paper_live').availableCash, 148500);

  // Also check Mock Mode exposes availableCash for mock accounts via getAccounts()
  const mockAccs = mgr.getAccounts();
  assert(mockAccs.length > 0 && mockAccs.every(a => typeof a.availableCash === 'number'), 'Every mock account must expose numeric availableCash');
  console.log('   ✅ Available balance exposed on Angel One, Dhan, Kotak Neo, Sahi, Paper, and Mock accounts.');

  console.log('\n🧪 Test 16: MultiBrokerManager.resetPaperAccount() Resets Active Instance After reloadBrokers()...');
  const paperResetStateFile = path.join(os.tmpdir(), `paper-reset-bug-${Date.now()}.json`);
  const PaperBrokerCls = require('../lib/brokers/paperBroker');
  let memAccounts = [{ id: 'paper_bug_1', broker: 'paper', name: 'Paper Reset Test', enabled: true, initialBalance: 100000, stateFile: paperResetStateFile }];
  const resetMgr = new MultiBrokerManager(
    { loadConfig: () => ({ mode: 'live', chargeSettings: ChargesCalculator.getDefaultChargeSettings(), riskSettings: {} }) },
    { createAdapter: () => null },
    null
  );
  resetMgr.getRawAccounts = () => memAccounts.map(a => ({ ...a }));
  resetMgr.saveRawAccounts = next => {
    memAccounts = next.map(a => ({ ...a }));
    resetMgr.brokerInstances.clear();
    for (const acc of memAccounts) {
      if (acc.enabled && acc.broker === 'paper') {
        resetMgr.brokerInstances.set(acc.id, new PaperBrokerCls({
          ...acc,
          isMock: false,
          enforceMarketHours: false,
          chargeSettingsProvider: () => ChargesCalculator.getDefaultChargeSettings()
        }));
      }
    }
  };
  resetMgr.saveRawAccounts(memAccounts);
  // Place a paper trade so positions & orders are non-empty and cash != initialBalance
  await resetMgr.placeOrder({
    accountId: 'paper_bug_1',
    tradingSymbol: 'NIFTY28MAR2625000CE',
    exchangeSegment: 'nse_fo',
    transactionType: 'B',
    orderType: 'L',
    quantity: 65,
    price: 100,
    ltp: 100,
    product: 'MIS',
    userConfirmed: true
  });
  assert.strictEqual((await resetMgr.brokerInstances.get('paper_bug_1').getPositions()).length, 1);
  assert.strictEqual((await resetMgr.brokerInstances.get('paper_bug_1').getOrderBook()).length, 1);

  // Reset Paper with a new balance >= 1000 (previously orphaned inst across reloadBrokers!)
  const resetOut = resetMgr.resetPaperAccount('paper_bug_1', 250000);
  assert.strictEqual(resetOut.funds.availableCash, 250000);
  const activePaperAfter = resetMgr.brokerInstances.get('paper_bug_1');
  assert.strictEqual((await activePaperAfter.getPositions()).length, 0, 'Active Paper instance positions must be cleared after reset');
  assert.strictEqual((await activePaperAfter.getOrderBook()).length, 0, 'Active Paper instance orders must be cleared after reset');
  assert.strictEqual((await activePaperAfter.getFunds()).availableCash, 250000, 'Active Paper instance balance must equal 250000');

  // Verify subsequent syncPaperPositions() tick & reload do NOT bring back old state!
  resetMgr.syncPaperPositions({ strikes: [] });
  resetMgr.saveRawAccounts(memAccounts);
  const reloadedAfterTick = resetMgr.brokerInstances.get('paper_bug_1');
  assert.strictEqual((await reloadedAfterTick.getPositions()).length, 0, 'Reset must persist across sync & reloadBrokers');
  assert.strictEqual((await reloadedAfterTick.getFunds()).availableCash, 250000, 'Reset balance must persist across sync & reloadBrokers');
  reloadedAfterTick.deleteStateFile();
  if (fs.existsSync(paperResetStateFile)) fs.unlinkSync(paperResetStateFile);
  console.log('   ✅ Paper reset reliably clears positions/orders & updates active balance across reloadBrokers().');

  console.log('\n🧪 Test 17: Positions Tab Net Return % Uses Each Broker Account\'s Own Opening Balance...');
  const pctMgr = new MultiBrokerManager(
    { loadConfig: () => ({ mode: 'live', chargeSettings: ChargesCalculator.getDefaultChargeSettings(), riskSettings: {} }) },
    { createAdapter: () => null },
    null
  );
  pctMgr.getRawAccounts = () => [
    { id: 'acc_kotak_pct', broker: 'kotakneo', name: 'Kotak', enabled: true, brokerageType: 'zero', brokeragePerOrder: 0 },
    { id: 'acc_angel_pct', broker: 'angelone', name: 'Angel', enabled: true, brokerageType: 'zero', brokeragePerOrder: 0 },
    { id: 'acc_paper_pct', broker: 'paper', name: 'Paper', enabled: true, initialBalance: 250000, brokerageType: 'zero', brokeragePerOrder: 0 }
  ];
  pctMgr.brokerInstances.set('acc_paper_pct', {
    isPaper: true,
    carriedBalance: 250000,
    initialBalance: 250000,
    getFundsSnapshot: () => ({ availableCash: 250000, carriedBalance: 250000, totalBalance: 250000 })
  });
  pctMgr.setOpeningBalanceProvider(() => ({
    openingBalance: 850000,
    isAutoCaptured: true,
    accounts: [
      { id: 'acc_kotak_pct', availableCash: 100000, totalBalance: 100000 },
      { id: 'acc_angel_pct', availableCash: 500000, totalBalance: 500000 }
    ]
  }));

  const zeroChargesPct = { sttPct: 0, exchangeTxnPct: 0, sebiPerCrore: 0, ipftPerCrore: 0, stampDutyBuyPct: 0, gstPct: 0 };
  const multiPos = [
    { accountId: 'acc_kotak_pct', broker: 'kotakneo', symbol: 'NIFTY28MAR2625000CE', product: 'MIS', netQty: 0, buyQty: 65, sellQty: 65, buyAvg: 100, sellAvg: 100, realizedPnl: 5000, unrealizedPnl: 0, totalPnl: 5000, isOpen: false },
    { accountId: 'acc_angel_pct', broker: 'angelone', symbol: 'NIFTY28MAR2625000CE', product: 'MIS', netQty: 0, buyQty: 65, sellQty: 65, buyAvg: 100, sellAvg: 100, realizedPnl: 5000, unrealizedPnl: 0, totalPnl: 5000, isOpen: false },
    { accountId: 'acc_paper_pct', broker: 'paper', symbol: 'NIFTY28MAR2625000CE', product: 'MIS', netQty: 0, buyQty: 65, sellQty: 65, buyAvg: 100, sellAvg: 100, realizedPnl: 5000, unrealizedPnl: 0, totalPnl: 5000, isOpen: false }
  ];
  const enrichedPct = pctMgr.enrichPositionsWithCharges(multiPos, 850000, zeroChargesPct);
  assert.strictEqual(enrichedPct[0].accountOpeningBalance, 100000);
  assert.strictEqual(enrichedPct[0].netProfitPctOfCapital, 5, 'Kotak ₹5,000 net on ₹1,00,000 opening must be +5%');
  assert.strictEqual(enrichedPct[1].accountOpeningBalance, 500000);
  assert.strictEqual(enrichedPct[1].netProfitPctOfCapital, 1, 'Angel ₹5,000 net on ₹5,00,000 opening must be +1%');
  assert.strictEqual(enrichedPct[2].accountOpeningBalance, 250000);
  assert.strictEqual(enrichedPct[2].netProfitPctOfCapital, 2, 'Paper ₹5,000 net on ₹2,50,000 carried opening must be +2%');
  console.log('   ✅ Positions Net Return % calculated per broker opening balance (5% / 1% / 2% vs 8.5L global).');

  console.log('\n🧪 Test 18: Paper Account Limit & Trigger Orders Complete Only When Feed Price Matches...');
  const paperLimPath = path.join(os.tmpdir(), `paper-lim-trig-${Date.now()}.json`);
  const paperLim = new PaperBroker({
    id: 'paper_lim_1',
    name: 'Paper Limit/SL',
    initialBalance: 200000,
    enforceMarketHours: false,
    stateFile: paperLimPath
  });
  await paperLim.login();

  // 18A: Place Entry Limit BUY @ ₹95 while NO feed tick yet -> stays OPEN
  const entryNoFeed = await paperLim.placeOrder({
    tradingSymbol: 'NIFTY28MAR2625000CE',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    transactionType: 'B',
    orderType: 'L',
    quantity: 65,
    price: 95
  });
  assert.strictEqual(entryNoFeed.status, 'OPEN');
  assert.strictEqual((await paperLim.getPositions()).length, 0);

  // Feed tick at ₹100 -> above Buy Limit ₹95, must remain OPEN
  paperLim.syncWithNiftySnapshot({
    strikes: [{ strike: 25000, ce: { symbol: 'NIFTY28MAR2625000CE', ltp: 100 }, pe: { symbol: 'NIFTY28MAR2625000PE', ltp: 100 } }]
  });
  assert.strictEqual((await paperLim.getOrderBook())[0].status, 'OPEN');
  assert.strictEqual((await paperLim.getPositions()).length, 0);

  // Feed tick at ₹97 -> still > ₹95, stays OPEN
  paperLim.syncWithNiftySnapshot({
    strikes: [{ strike: 25000, ce: { symbol: 'NIFTY28MAR2625000CE', ltp: 97 }, pe: { symbol: 'NIFTY28MAR2625000PE', ltp: 100 } }]
  });
  assert.strictEqual((await paperLim.getOrderBook())[0].status, 'OPEN');

  // Feed tick drops to ₹94 <= ₹95 -> Buy Limit fills and opens position!
  paperLim.syncWithNiftySnapshot({
    strikes: [{ strike: 25000, ce: { symbol: 'NIFTY28MAR2625000CE', ltp: 94 }, pe: { symbol: 'NIFTY28MAR2625000PE', ltp: 100 } }]
  });
  const ordersAfterEntry = await paperLim.getOrderBook();
  assert.strictEqual(ordersAfterEntry[0].status, 'COMPLETE', 'Buy Limit must complete once feed price <= limit');
  assert.strictEqual(ordersAfterEntry[0].filledQuantity, 65);
  assert.strictEqual(ordersAfterEntry[0].price, 94);
  assert.strictEqual((await paperLim.getPositions())[0].netQty, 65);

  // 18B: Target Limit SELL @ ₹110 while feed is ₹94 -> must stay OPEN until feed >= ₹110
  const tgtSell = await paperLim.placeOrder({
    tradingSymbol: 'NIFTY28MAR2625000CE',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    transactionType: 'S',
    orderType: 'L',
    quantity: 65,
    price: 110
  });
  assert.strictEqual(tgtSell.status, 'OPEN');
  paperLim.syncWithNiftySnapshot({
    strikes: [{ strike: 25000, ce: { symbol: 'NIFTY28MAR2625000CE', ltp: 108 }, pe: { symbol: 'NIFTY28MAR2625000PE', ltp: 100 } }]
  });
  assert.strictEqual((await paperLim.getOrderBook()).find(o => o.orderId === tgtSell.orderId).status, 'OPEN');
  paperLim.syncWithNiftySnapshot({
    strikes: [{ strike: 25000, ce: { symbol: 'NIFTY28MAR2625000CE', ltp: 110 }, pe: { symbol: 'NIFTY28MAR2625000PE', ltp: 100 } }]
  });
  assert.strictEqual((await paperLim.getOrderBook()).find(o => o.orderId === tgtSell.orderId).status, 'COMPLETE');
  assert.strictEqual((await paperLim.getPositions())[0].netQty, 0);

  // 18C: Trigger SL BUY @ Trigger ₹105 / Limit ₹106 when feed is ₹100 -> stays OPEN until feed >= ₹105 (via syncWithTick)
  const trigBuy = await paperLim.placeOrder({
    tradingSymbol: 'NIFTY28MAR2625000PE',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    transactionType: 'B',
    orderType: 'SL',
    quantity: 65,
    triggerPrice: 105,
    price: 106
  });
  assert.strictEqual(trigBuy.status, 'OPEN');
  paperLim.syncWithTick({ symbol: 'NIFTY28MAR2625000PE', ltp: 104 });
  assert.strictEqual((await paperLim.getOrderBook()).find(o => o.orderId === trigBuy.orderId).status, 'OPEN');
  paperLim.syncWithTick({ symbol: 'NIFTY28MAR2625000PE', ltp: 105.5 });
  const trigFilled = (await paperLim.getOrderBook()).find(o => o.orderId === trigBuy.orderId);
  assert.strictEqual(trigFilled.status, 'COMPLETE', 'SL trigger order must complete when feed matches trigger & limit');
  assert.strictEqual(trigFilled.price, 105.5);
  paperLim.deleteStateFile();
  if (fs.existsSync(paperLimPath)) fs.unlinkSync(paperLimPath);
  console.log('   ✅ Paper Limit & Trigger orders remain OPEN until live feed price matches.');

  console.log('\n🧪 Test 19: Paper Account MIS 3:30 PM Market Square-Off & NRML Next-Day Carry-Forward...');
  const { getISTInfo } = require('../lib/niftyFeedManager');
  const todayIst = getISTInfo().dateStr;
  const paperEodPath = path.join(os.tmpdir(), `paper-mis-nrml-${Date.now()}.json`);
  const paperEod = new PaperBroker({
    id: 'paper_eod_1',
    name: 'Paper MIS/NRML',
    initialBalance: 100000,
    brokerageType: 'zero',
    brokeragePerOrder: 0,
    enforceMarketHours: false,
    stateFile: paperEodPath
  });
  await paperEod.login();
  // Seed feed prices
  paperEod.syncWithNiftySnapshot({
    strikes: [{
      strike: 25000,
      ce: { symbol: 'NIFTY28MAR2625000CE', ltp: 100 },
      pe: { symbol: 'NIFTY28MAR2625000PE', ltp: 100 }
    }]
  });

  // Open an MIS position at 10:00 AM IST & a pending MIS Limit order
  await paperEod.placeOrder({
    tradingSymbol: 'NIFTY28MAR2625000CE',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    transactionType: 'B',
    orderType: 'MKT',
    quantity: 65,
    ltp: 100,
    openedAt: `${todayIst}T10:00:00+05:30`
  });
  await paperEod.placeOrder({
    tradingSymbol: 'NIFTY28MAR2625000CE',
    exchangeSegment: 'nse_fo',
    product: 'MIS',
    transactionType: 'S',
    orderType: 'L',
    quantity: 65,
    price: 150,
    openedAt: `${todayIst}T10:05:00+05:30`
  });
  // Open an NRML position at 10:00 AM IST & a pending NRML Limit order
  await paperEod.placeOrder({
    tradingSymbol: 'NIFTY28MAR2625000PE',
    exchangeSegment: 'nse_fo',
    product: 'NRML',
    transactionType: 'B',
    orderType: 'MKT',
    quantity: 65,
    ltp: 100,
    openedAt: `${todayIst}T10:10:00+05:30`
  });
  await paperEod.placeOrder({
    tradingSymbol: 'NIFTY28MAR2625000PE',
    exchangeSegment: 'nse_fo',
    product: 'NRML',
    transactionType: 'S',
    orderType: 'L',
    quantity: 65,
    price: 160,
    openedAt: `${todayIst}T10:15:00+05:30`
  });

  // Feed moves: MIS CE = ₹115, NRML PE = ₹120
  paperEod.syncWithNiftySnapshot({
    strikes: [{
      strike: 25000,
      ce: { symbol: 'NIFTY28MAR2625000CE', ltp: 115 },
      pe: { symbol: 'NIFTY28MAR2625000PE', ltp: 120 }
    }]
  });

  // Before 15:30 IST (e.g. 15:29 IST) -> MIS stays open
  const before330 = paperEod.autoSquareOffMisIfNeeded(new Date(`${todayIst}T15:29:00+05:30`));
  assert.strictEqual(before330.squaredOffCount, 0);
  assert.strictEqual((await paperEod.getPositions()).find(p => p.product === 'MIS').netQty, 65);

  // At 15:30 IST -> MIS auto squared off at current market price ₹115, pending MIS order cancelled, NRML stays open!
  const at330 = paperEod.autoSquareOffMisIfNeeded(new Date(`${todayIst}T15:30:00+05:30`));
  assert.strictEqual(at330.squaredOffCount, 1, 'MIS position must be squared off at 3:30 PM IST');
  assert.strictEqual(at330.cancelledOrdersCount, 1, 'Pending MIS order must be cancelled at 3:30 PM IST');
  const posAfter330 = await paperEod.getPositions();
  const misPos330 = posAfter330.find(p => p.product === 'MIS');
  const nrmlPos330 = posAfter330.find(p => p.product === 'NRML');
  assert.strictEqual(misPos330.netQty, 0);
  assert.strictEqual(misPos330.isOpen, false);
  assert.strictEqual(misPos330.realizedPnl, 975, 'MIS must square off at market price 115: (115 - 100) * 65 = 975');
  assert.strictEqual(nrmlPos330.netQty, 65, 'NRML position must remain open after 3:30 PM');
  assert.strictEqual(nrmlPos330.isOpen, true);

  // Roll over to next trading day -> MIS net P&L (gross 975 minus statutory charges) settles into carriedBalance, NRML carries forward!
  const nrmlFundsBeforeRoll = await paperEod.getFunds();
  const misNetBeforeRoll = paperEod._computePositionNetInfo(misPos330, paperEod._getChargeConfig()).netPnl;
  const rolledEod = paperEod.rolloverIfNewDay('2099-12-31');
  assert.strictEqual(rolledEod, true);
  const posDay2 = await paperEod.getPositions();
  assert.strictEqual(posDay2.length, 1, 'Only NRML position carries forward to next day; MIS settled');
  assert.strictEqual(posDay2[0].product, 'NRML');
  assert.strictEqual(posDay2[0].netQty, 65);
  assert.strictEqual(posDay2[0].buyAvg, 100, 'Carried NRML must retain entry avg ₹100');
  assert.strictEqual(posDay2[0].unrealizedPnl, 1300, 'Carried NRML must preserve open unrealized P&L');
  const nrmlFundsDay2 = await paperEod.getFunds();
  assert.strictEqual(nrmlFundsDay2.carriedBalance, Number((100000 + misNetBeforeRoll).toFixed(2)), 'Day 1 MIS Net P&L carries into Day 2 carriedBalance');
  assert.strictEqual(nrmlFundsDay2.totalBalance, nrmlFundsBeforeRoll.totalBalance, 'Total equity must stay continuous across NRML carry-forward');
  const ordersDay2 = await paperEod.getOrderBook();
  assert.strictEqual(ordersDay2.some(o => o.product === 'NRML' && o.status === 'OPEN'), true, 'Pending NRML order carries forward');
  paperEod.deleteStateFile();
  if (fs.existsSync(paperEodPath)) fs.unlinkSync(paperEodPath);
  console.log('   ✅ Paper MIS 3:30 PM Market Square-Off & NRML next-day carry-forward verified.');

  console.log('\n🧪 Test 20: Paper Account Only Trades During Market Hours (Mon-Fri 09:15-15:30 IST)...');
  const paperMktHrsPath = path.join(os.tmpdir(), `paper-mkt-hrs-${Date.now()}.json`);
  const paperMktHrs = new PaperBroker({
    id: 'paper_mkt_hrs_1',
    name: 'Paper Market Hours',
    initialBalance: 100000,
    stateFile: paperMktHrsPath
  });
  assert.strictEqual(paperMktHrs.enforceMarketHours, true, 'PaperBroker must enforce market hours by default');

  const blockedTimes = [
    ['Saturday', '2026-11-28T11:00:00+05:30'],
    ['Sunday', '2026-11-29T11:00:00+05:30'],
    ['Before 09:15 IST', '2026-11-27T09:14:00+05:30'],
    ['At/After 15:30 IST', '2026-11-27T15:30:00+05:30']
  ];
  for (const [label, iso] of blockedTimes) {
    let errMsg = '';
    try {
      await paperMktHrs.placeOrder({
        tradingSymbol: 'NIFTY28MAR2625000CE',
        exchangeSegment: 'nse_fo',
        product: 'MIS',
        transactionType: 'B',
        orderType: 'MKT',
        quantity: 65,
        ltp: 100,
        openedAt: iso
      });
    } catch (e) {
      errMsg = e.message;
    }
    assert(errMsg.toLowerCase().includes('market hours'), `Expected market-hours rejection for ${label}, got: "${errMsg}"`);
  }

  // Allowed during Fri 09:15–15:29:59 IST: place Limit Buy @ 95 while LTP is 100 -> stays OPEN
  const openLimMkt = await paperMktHrs.placeOrder({
    tradingSymbol: 'NIFTY28MAR2625000CE',
    exchangeSegment: 'nse_fo',
    product: 'NRML',
    transactionType: 'B',
    orderType: 'L',
    quantity: 65,
    price: 95,
    ltp: 100,
    openedAt: '2026-11-27T14:30:00+05:30'
  });
  assert.strictEqual(openLimMkt.status, 'OPEN');

  // Off-hours tick (Saturday) must NOT trigger/fill pending Paper Limit orders
  paperMktHrs.syncWithNiftySnapshot({
    strikes: [{ strike: 25000, ce: { symbol: 'NIFTY28MAR2625000CE', ltp: 94 }, pe: { symbol: 'NIFTY28MAR2625000PE', ltp: 100 } }]
  }, new Date('2026-11-28T11:00:00+05:30'));
  assert.strictEqual((await paperMktHrs.getOrderBook())[0].status, 'OPEN', 'Pending Limit order must NOT fill outside market hours');

  // Market-hours tick (Friday 14:35 IST) DOES fill matching Limit order
  paperMktHrs.syncWithNiftySnapshot({
    strikes: [{ strike: 25000, ce: { symbol: 'NIFTY28MAR2625000CE', ltp: 94 }, pe: { symbol: 'NIFTY28MAR2625000PE', ltp: 100 } }]
  }, new Date('2026-11-27T14:35:00+05:30'));
  assert.strictEqual((await paperMktHrs.getOrderBook())[0].status, 'COMPLETE', 'Pending Limit order must fill during market hours');
  paperMktHrs.deleteStateFile();
  if (fs.existsSync(paperMktHrsPath)) fs.unlinkSync(paperMktHrsPath);
  console.log('   ✅ Paper market-hours gating (Mon-Fri 09:15-15:30 IST) verified.');

  console.log('\n🧪 Test 21: Paper Account Order Book & orders_changed Event Update Immediately on Order Placement...');
  const obStatePath = path.join(os.tmpdir(), `paper-ob-rt-${Date.now()}.json`);
  const obMgr = new MultiBrokerManager(
    { loadConfig: () => ({ mode: 'live', chargeSettings: ChargesCalculator.getDefaultChargeSettings(), riskSettings: {} }) },
    { createAdapter: () => null },
    null
  );
  obMgr.enforceMarketHours = false;
  let obMemAccs = [{ id: 'paper_ob_1', broker: 'paper', name: 'Paper Realtime OB', enabled: true, initialBalance: 200000, stateFile: obStatePath }];
  obMgr.getRawAccounts = () => obMemAccs.map(a => ({ ...a }));
  obMgr.saveRawAccounts = next => {
    obMemAccs = next.map(a => ({ ...a }));
    obMgr.reloadBrokers();
  };
  obMgr.reloadBrokers();

  const orderEvents = [];
  obMgr.on('orders_changed', evt => orderEvents.push(evt));

  await obMgr.placeOrder({
    accountId: 'paper_ob_1',
    tradingSymbol: 'NIFTY28MAR2625000CE',
    exchangeSegment: 'nse_fo',
    transactionType: 'B',
    orderType: 'L',
    quantity: 65,
    price: 95,
    ltp: 100,
    product: 'MIS',
    userConfirmed: true
  });
  assert.strictEqual(orderEvents.length, 1, 'Placing Paper Limit order must emit orders_changed immediately');
  let cachedOb = obMgr.getCachedOrders();
  assert.strictEqual(cachedOb.length, 1, 'getCachedOrders() must immediately contain newly placed Paper order');
  assert.strictEqual(cachedOb[0].status, 'OPEN');

  // Matching tick fills the order and immediately fires orders_changed + updates getCachedOrders()
  obMgr.syncPaperPositions({
    strikes: [{ strike: 25000, ce: { symbol: 'NIFTY28MAR2625000CE', ltp: 94 }, pe: { symbol: 'NIFTY28MAR2625000PE', ltp: 100 } }]
  });
  assert.strictEqual(orderEvents.length, 2, 'Filling Paper order from feed must emit orders_changed immediately');
  cachedOb = obMgr.getCachedOrders();
  assert.strictEqual(cachedOb[0].status, 'COMPLETE');
  assert.strictEqual(cachedOb[0].filledQuantity, 65);

  obMgr.brokerInstances.get('paper_ob_1').deleteStateFile();
  if (fs.existsSync(obStatePath)) fs.unlinkSync(obStatePath);
  console.log('   ✅ Immediate Paper Order Book & orders_changed event updates verified.');

  scheduler.stopScheduler();
  mgr.mockManager.stopSimulation();
  if (typeof mgr.disconnectAll === 'function') mgr.disconnectAll();

  console.log('\n🎉 ALL TESTS PASSED!\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
