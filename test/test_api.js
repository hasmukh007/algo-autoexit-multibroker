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
