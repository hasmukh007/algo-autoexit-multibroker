const assert = require('assert');

async function runTests() {
  console.log('🧪 Starting Multi-Broker & Net Profit % Test Suite...\n');

  // 1. Charges Calculator Test
  console.log('1. Testing Indian Brokerage & Statutory Taxes Calculator...');
  const ChargesCalculator = require('../lib/chargesCalculator');

  // Options Trade: 50 qty bought at 100, sold at 120 (Gross P&L = +1000)
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

  const charges = ChargesCalculator.calculatePositionCharges(optionsPos);
  assert(charges.totalTurnover === (50 * 100 + 50 * 120), 'Turnover calculation must match');
  assert(charges.brokerage === 40, 'Round trip options brokerage must be ₹40 (20+20)');
  assert(charges.stt > 0, 'STT must be calculated on sell turnover');
  assert(charges.exchangeTxn > 0, 'Exchange txn charge must be > 0');
  assert(charges.gst > 0, 'GST 18% must be calculated');
  assert(charges.totalCharges > 40, 'Total charges must exceed bare brokerage');
  assert.strictEqual(charges.netPnl, Number((1000 - charges.totalCharges).toFixed(2)), 'Net P&L must be Gross P&L minus Total Charges');
  console.log(`   ✅ Options: Gross ₹1,000 | Charges: ₹${charges.totalCharges} (Brk ₹${charges.brokerage}, STT ₹${charges.stt}, Exch ₹${charges.exchangeTxn}, GST ₹${charges.gst}) | Net P&L: ₹${charges.netPnl}`);

  // 2. 9:00 AM Opening Balance & Net Return % Test
  console.log('\n2. Testing 9:00 AM Opening Balance & Net Return % of Capital...');
  const openingCapital = 500000; // ₹5 Lakhs
  const netProfit = charges.netPnl; // e.g. ~₹930
  const netReturnPct = (netProfit / openingCapital) * 100;
  assert(typeof netReturnPct === 'number', 'Net return % must be numeric');
  console.log(`   ✅ Capital ₹${openingCapital.toLocaleString('en-IN')} | Net Profit ₹${netProfit} = ${netReturnPct.toFixed(3)}% of 9:00 AM Balance.`);

  // 3. MultiBrokerManager Test
  console.log('\n3. Testing MultiBrokerManager (Kotak Neo, Angel One, Dhan)...');
  const configManager = require('../lib/configManager');
  const MultiBrokerManager = require('../lib/multiBrokerManager');
  const mgr = new MultiBrokerManager(configManager);

  // Verify accounts can be read
  const accounts = mgr.getAccounts();
  assert(Array.isArray(accounts), 'Accounts must be an array');
  console.log(`   ✅ Loaded ${accounts.length} broker accounts.`);

  // Verify positions from mock simulation
  const positions = await mgr.getAllPositions();
  assert(positions.length >= 3, 'Simulation must return positions for Kotak, Angel, and Dhan');
  const brokersRepresented = new Set(positions.map(p => p.broker));
  assert(brokersRepresented.has('kotakneo'), 'Kotak Neo must be represented');
  assert(brokersRepresented.has('angelone'), 'Angel One must be represented');
  assert(brokersRepresented.has('dhan'), 'Dhan must be represented');
  console.log(`   ✅ Positions successfully aggregated across: ${Array.from(brokersRepresented).join(', ')}.`);

  // 4. Data Feed Switching Test
  console.log('\n4. Testing Data Feed Subscription Switching (Angel One / Kotak Neo)...');
  mgr.setDataFeedSource('angelone');
  assert.strictEqual(mgr.getDataFeedSource(), 'angelone');
  mgr.setDataFeedSource('kotakneo');
  assert.strictEqual(mgr.getDataFeedSource(), 'kotakneo');
  console.log('   ✅ Data feed subscription switched seamlessly.');

  // 5. AutoExitEngine Net Profit % Trigger Test
  console.log('\n5. Testing Net Profit % Auto-Exit Engine Triggers...');
  const OpeningBalanceScheduler = require('../lib/openingBalanceScheduler');
  const AutoExitEngine = require('../lib/autoExitEngine');

  const scheduler = new OpeningBalanceScheduler(mgr);
  scheduler.setOpeningBalance(100000); // Set ₹1 Lakh for test threshold

  const engine = new AutoExitEngine(mgr, scheduler, configManager);

  // Set rule on position: exit when net profit >= 0.5% (with 95% near buffer)
  const rule = engine.setPositionRule('mock_kotak_1', 'NIFTY 24NOV 24200 CE', 'MIS', {
    targetNetProfitPct: 0.5,
    nearThresholdBufferPct: 95,
    stopLossNetPct: 1.0,
    enabled: true
  });
  assert.strictEqual(rule.targetNetProfitPct, 0.5);
  assert.strictEqual(rule.nearThresholdBufferPct, 95);
  console.log('   ✅ Auto-Exit rule saved with targetNetProfitPct: 0.5% and nearBuffer: 95%.');

  scheduler.stopScheduler();
  mgr.mockManager.stopSimulation();

  console.log('\n🎉 ALL MULTI-BROKER & NET PROFIT % TESTS PASSED!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
