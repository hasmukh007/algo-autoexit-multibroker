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

  // Asset categorization tests for varied broker option symbol formats
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY 26NOV 25500 CALL', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY 26NOV 25500 PUT', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY-26NOV26-25500-CE', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY26N2625500C', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY26N2625500P', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY26C25500', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY26P25500', 'nse_fo'), 'OPTIONS');
  assert.strictEqual(ChargesCalculator.categorizeAsset('NIFTY26NOVFUT', 'nse_fo'), 'FUTURES');
  console.log('   ✅ Option symbol categorization verified for CALL/PUT/-CE/C/P/FUT formats.');

  // Standard Flat ₹20/order (e.g. Angel One / Dhan)
  const stdCharges = ChargesCalculator.calculatePositionCharges(optionsPos, { brokerageType: 'flat', brokeragePerOrder: 20 });
  assert.strictEqual(stdCharges.totalTurnover, 11000);
  assert.strictEqual(stdCharges.brokerage, 40, 'Round trip options brokerage must be ₹40 (20+20)');
  assert.strictEqual(stdCharges.stt, 16.5, 'STT 0.15% on ₹11000 total turnover must be ₹16.50');
  assert.strictEqual(stdCharges.exchangeTxn, Number((11000 * 0.000355299).toFixed(2)), 'Options Exch Txn 0.0355299%');
  assert.strictEqual(stdCharges.ipft, Number((11000 * 0.000000001).toFixed(4)), 'IPFT 0.0000001%');
  assert.strictEqual(stdCharges.stampDuty, Math.round(5000 * 0.00003), 'Stamp duty 0.003% on ₹5000 buy turnover rounded to nearest rupee');
  assert(stdCharges.buySideCharges > 0 && stdCharges.sellSideCharges > 0, 'Both buy-side and sell-side charges must be calculated');
  assert.strictEqual(Number((stdCharges.buySideCharges + stdCharges.sellSideCharges).toFixed(2)), stdCharges.totalCharges, 'Buy + Sell side charges must equal totalCharges');
  assert.strictEqual(stdCharges.netPnl, Number((1000 - stdCharges.totalCharges).toFixed(2)));
  console.log(`   ✅ Options (₹20/ord): Gross ₹1,000 | Buy Charges: ₹${stdCharges.buySideCharges} + Sell Charges: ₹${stdCharges.sellSideCharges} = Total: ₹${stdCharges.totalCharges} | Net P&L: ₹${stdCharges.netPnl}`);

  // Zero Brokerage Plan (e.g. Kotak Neo Trade Free / Youth)
  const zeroCharges = ChargesCalculator.calculatePositionCharges(optionsPos, { brokerageType: 'zero', brokeragePerOrder: 0 });
  assert.strictEqual(zeroCharges.brokerage, 0, 'Zero plan brokerage must be ₹0');
  assert(zeroCharges.totalCharges < stdCharges.totalCharges, 'Zero brokerage plan must have lower total charges');
  console.log(`   ✅ Options (₹0/ord): Gross ₹1,000 | Charges: ₹${zeroCharges.totalCharges} (Brk ₹${zeroCharges.brokerage}, STT ₹${zeroCharges.stt}, Exch ₹${zeroCharges.exchangeTxn}, GST ₹${zeroCharges.gst}) | Net P&L: ₹${zeroCharges.netPnl}`);

  // Custom Brokerage Plan (e.g. ₹10/order for options)
  const customCharges = ChargesCalculator.calculatePositionCharges(optionsPos, { brokerageType: 'custom', brokeragePerOrder: 20, optionsBrokerage: 10 });
  assert.strictEqual(customCharges.brokerage, 20, 'Custom options brokerage ₹10/order x 2 must be ₹20');
  console.log(`   ✅ Options (Custom ₹10/ord): Brokerage ₹${customCharges.brokerage} | Total Charges: ₹${customCharges.totalCharges}`);

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
  console.log(`   ✅ Loaded ${accounts.length} accounts; per-account brokerage lookup verified.`);

  // 3. AutoExitEngine Net Profit % Trigger Test
  console.log('\n3. Testing AutoExitEngine initialization...');
  const OpeningBalanceScheduler = require('../lib/openingBalanceScheduler');
  const AutoExitEngine = require('../lib/autoExitEngine');
  const scheduler = new OpeningBalanceScheduler(mgr);
  const engine = new AutoExitEngine(mgr, scheduler, configManager);
  const rule = engine.setPositionRule('mock_kotak_1', 'NIFTY 24NOV 24200 CE', 'MIS', {
    targetNetProfitPct: 0.5,
    nearThresholdBufferPct: 95,
    stopLossNetPct: 1.0,
    enabled: true
  });
  assert.strictEqual(rule.targetNetProfitPct, 0.5);
  console.log('   ✅ Auto-Exit rule configured.');

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
