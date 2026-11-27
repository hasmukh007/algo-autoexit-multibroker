const assert = require('assert');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const { NiftyFeedManager, computeAtmStrike, computeOiBuildup, isPortfolioQuietHoursIST } = require('../lib/niftyFeedManager');
const { NiftyCandleManager, aggregateTo3MinuteCandles } = require('../lib/niftyCandleManager');
const {
  isISTTradingHours,
  getSessionBoundaries,
  aggregateToSessionTimeframe,
  calculateHeikinAshi,
  detectHeikinAshiZones,
  calculatePreviousDayAndPivots,
  buildChartAnalysis
} = require('../lib/niftyChartAnalysis');
const AutoLoginScheduler = require('../lib/autoLoginScheduler');
const {
  ScripMasterManager,
  splitQuantityByFreeze,
  calculateOrderQuantity,
  resolveOrderTypePricing
} = require('../lib/scripMasterManager');
const AngelOneBroker = require('../lib/brokers/angelOneBroker');
const KotakNeoBroker = require('../lib/brokers/kotakNeoBroker');
const DhanBroker = require('../lib/brokers/dhanBroker');
const SahiBroker = require('../lib/brokers/sahiBroker');
const { parseSmartStreamPacket } = require('../lib/angelOneWsClient');
const { parseKotakMarketMessage } = require('../lib/kotakNeoWsClient');
const { parseDhanFeedPacket } = require('../lib/dhanWsClient');
const { encodeClientSubscribe, decodeServerMessage } = require('../lib/sahiWsClient');
const KotakNeoClient = require('../lib/kotakNeoClient');
const MultiBrokerManager = require('../lib/multiBrokerManager');
const configManager = require('../lib/configManager');

function makeISTDate(year, month, day, hourIST, minIST) {
  const utcMs = Date.UTC(year, month - 1, day, hourIST, minIST, 0) - 3600000 * 5.5;
  return new Date(utcMs);
}

function httpRequest(port, reqPath, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {}
      },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function readSSEEvents(port, durationMs = 2200) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/stream' }, res => {
      let raw = '';
      res.on('data', chunk => (raw += chunk.toString()));
      setTimeout(() => {
        req.destroy();
        resolve({ status: res.statusCode, raw });
      }, durationMs);
    });
    req.on('error', err => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
  });
}

async function run() {
  console.log('🧪 Testing Live-Only 9:00 AM NIFTY Feed & Option Chain...\n');

  // 1. Live-only feed manager: starts with null spot/strikes (NO mock prices) and populates only from live quotes
  let mockQuoteResponse = null;
  let mockChainResponse = null;
  const fakeBrokerMgr = {
    getDataFeedSource: () => 'angelone',
    hasActiveLiveFeedBroker: () => true,
    getLiveNiftySpotQuote: async () => mockQuoteResponse,
    getLiveNiftyOptionChain: async () => mockChainResponse
  };
  const feed = new NiftyFeedManager(fakeBrokerMgr, configManager, { disableTimers: true });

  // Initially no fake mock prices
  const initSnap = feed.getSnapshot();
  assert.strictEqual(initSnap.spot.ltp, null, 'Initial spot must be null (no mock spot)');
  assert.strictEqual(initSnap.strikes.length, 0, 'Initial strikes must be empty until live spot arrives');

  // Before 9:00 AM IST (08:59)
  const before9AM = makeISTDate(2026, 11, 25, 8, 59);
  feed._check9AMSchedule(before9AM);
  assert.strictEqual(feed.feedState.isRunning, false, 'Feed must stay waiting before 09:00 AM IST');
  assert.strictEqual(feed.feedState.status, 'WAITING_9AM');
  console.log('   ✅ Before 09:00 AM IST: Feed status is WAITING_9AM with zero mock prices.');

  // Tick without live quote: must NOT generate mock data
  const noQuoteTick = await feed._tick();
  assert.strictEqual(noQuoteTick.spot.ltp, null, 'Must remain null without live broker quote');
  assert.strictEqual(noQuoteTick.feedState.sourceMode, 'live_waiting');

  // At 9:00 AM IST (09:00)
  const at9AM = makeISTDate(2026, 11, 25, 9, 0);
  feed._check9AMSchedule(at9AM);
  assert.strictEqual(feed.feedState.isRunning, true, 'Feed must auto-start at 09:00 AM IST');
  assert.strictEqual(feed.feedState.autoStarted9AM, true);

  // Feed live NIFTY spot + live option chain quotes
  mockQuoteResponse = { ltp: 24512.40, prevClose: 24400.00, open: 24425.00 };
  const atm = computeAtmStrike(24512.40);
  const liveOc = {};
  for (let i = -10; i <= 10; i++) {
    const k = atm + i * 50;
    liveOc[k] = {
      ce: { last_price: 200 - i * 10, previous_close_price: 180 - i * 10, oi: 500000, previous_oi: 450000, volume: 120000, top_bid_price: 199, top_ask_price: 201 },
      pe: { last_price: 200 + i * 10, previous_close_price: 210 + i * 10, oi: 600000, previous_oi: 580000, volume: 110000, top_bid_price: 199, top_ask_price: 201 }
    };
  }
  mockChainResponse = { spotLtp: 24512.40, expiry: '26NOV2026', oc: liveOc };

  const liveTick = await feed._tick();
  assert.strictEqual(liveTick.feedState.sourceMode, 'live_broker');
  assert.strictEqual(liveTick.spot.ltp, 24512.40);
  assert.strictEqual(liveTick.atmStrike, 24500);
  assert.strictEqual(liveTick.strikes.length, 21, 'Must have 21 strikes (10 ITM + 1 ATM + 10 OTM)');

  const ceItm = liveTick.strikes.filter(s => s.ce.moneyness === 'ITM');
  const ceAtm = liveTick.strikes.filter(s => s.ce.moneyness === 'ATM');
  const ceOtm = liveTick.strikes.filter(s => s.ce.moneyness === 'OTM');
  const peItm = liveTick.strikes.filter(s => s.pe.moneyness === 'ITM');
  const peAtm = liveTick.strikes.filter(s => s.pe.moneyness === 'ATM');
  const peOtm = liveTick.strikes.filter(s => s.pe.moneyness === 'OTM');

  assert.strictEqual(ceItm.length, 10);
  assert.strictEqual(ceAtm.length, 1);
  assert.strictEqual(ceOtm.length, 10);
  assert.strictEqual(peItm.length, 10);
  assert.strictEqual(peAtm.length, 1);
  assert.strictEqual(peOtm.length, 10);
  assert.strictEqual(ceAtm[0].ce.oiBuildup, 'Long Built Up');
  assert.strictEqual(peAtm[0].pe.oiBuildup, 'Short Built Up');

  assert.strictEqual(computeOiBuildup(5, 100).label, 'Long Built Up');
  assert.strictEqual(computeOiBuildup(-5, 100).label, 'Short Built Up');
  assert.strictEqual(computeOiBuildup(5, -100).label, 'Short Covering');
  assert.strictEqual(computeOiBuildup(-5, -100).label, 'Long Unwinding');

  // Verify option chain auto-recenters automatically when live NIFTY spot shifts ATM
  mockQuoteResponse = { ltp: 24565.00, prevClose: 24400.00, open: 24425.00 };
  mockChainResponse = { spotLtp: 24565.00, expiry: '26NOV2026', oc: liveOc };
  const shiftedTick = await feed._tick();
  assert.strictEqual(shiftedTick.atmStrike, 24550, 'ATM strike must auto-recenter to 24550 when spot moves to 24565');
  assert.strictEqual(shiftedTick.strikes[0].strike, 24050);
  assert.strictEqual(shiftedTick.strikes[10].strike, 24550);
  assert.strictEqual(shiftedTick.strikes[10].isAtm, true);
  assert.strictEqual(shiftedTick.strikes[20].strike, 25050);
  console.log('   ✅ Live-only tick populated 21 strikes (10 ITM + ATM + 10 OTM), OI Built Up, and auto-recentered ATM.');

  // 2. AngelOneBroker: binary WS packet parsing, login+order-only REST getPosition, and live WS LTP updates
  const pktBuf = Buffer.alloc(347);
  pktBuf.writeUInt8(3, 0); // Mode 3 Snap Quote
  pktBuf.writeUInt8(2, 1); // NFO
  pktBuf.write('72314', 2, 'utf8');
  pktBuf.writeBigInt64LE(1n, 27);
  pktBuf.writeBigInt64LE(1700000000000n, 35);
  pktBuf.writeBigInt64LE(14255n, 43); // LTP = 142.55
  pktBuf.writeBigInt64LE(250000n, 67); // Volume
  pktBuf.writeBigInt64LE(13000n, 91); // Open = 130.00
  pktBuf.writeBigInt64LE(14500n, 99); // High = 145.00
  pktBuf.writeBigInt64LE(12800n, 107); // Low = 128.00
  pktBuf.writeBigInt64LE(13500n, 115); // Close = 135.00
  pktBuf.writeBigInt64LE(950000n, 131); // OI
  pktBuf.writeUInt16LE(0, 147); // Buy flag
  pktBuf.writeBigInt64LE(14240n, 157); // Bid = 142.40
  pktBuf.writeUInt16LE(1, 167); // Sell flag
  pktBuf.writeBigInt64LE(14265n, 177); // Ask = 142.65

  const decodedPkt = parseSmartStreamPacket(pktBuf);
  assert.strictEqual(decodedPkt.token, '72314');
  assert.strictEqual(decodedPkt.ltp, 142.55);
  assert.strictEqual(decodedPkt.volume, 250000);
  assert.strictEqual(decodedPkt.oi, 950000);
  assert.strictEqual(decodedPkt.bid, 142.4);
  assert.strictEqual(decodedPkt.ask, 142.65);

  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      setTimeout(() => this._emit('open', {}), 0);
    }
    addEventListener(evt, fn) {
      if (!this.listeners.has(evt)) this.listeners.set(evt, []);
      this.listeners.get(evt).push(fn);
    }
    _emit(evt, payload) {
      for (const fn of (this.listeners.get(evt) || [])) fn(payload);
    }
    send() {}
    close() {}
  }

  const originalFetch = global.fetch;
  let getPositionCalls = 0;
  let quoteRestCalls = 0;
  let angel = null;
  try {
    global.fetch = async url => {
      if (url.includes('/loginByPassword')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            status: true,
            data: { jwtToken: 'jwt-1', refreshToken: 'ref-1', feedToken: 'feed-1' }
          })
        };
      }
      if (url.includes('/getPosition')) {
        getPositionCalls++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            status: true,
            data: [{
              tradingsymbol: 'NIFTY26NOV24500CE',
              symboltoken: '72314',
              exchange: 'NFO',
              producttype: 'INTRADAY',
              netqty: '50',
              buyqty: '50',
              sellqty: '0',
              buyavgprice: '120.00',
              ltp: '125.00',
              unrealised: '250.00',
              realised: '0'
            }]
          })
        };
      }
      if (url.includes('/placeOrder')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ status: true, data: { orderid: 'ANG-ORD-1' } })
        };
      }
      if (url.includes('/quote/')) {
        quoteRestCalls++;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: true, data: {} }) };
    };

    angel = new AngelOneBroker({
      id: 'test_angel_ws',
      apiKey: 'KEY123',
      clientCode: 'C123',
      password: 'PASS',
      isMock: false,
      WebSocketImpl: FakeWebSocket
    });
    angel._minRequestGapMs = 0;

    // Unauthenticated must not call REST
    assert.deepStrictEqual(await angel.getPositions(), []);
    assert.strictEqual(getPositionCalls, 0);

    // Login fetches net positions ONCE
    await angel.login('123456');
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(getPositionCalls, 1, 'getPositions REST must run once right after login');

    // Polling 5 times must make ZERO additional REST getPosition calls
    for (let i = 0; i < 5; i++) {
      await angel.getPositions();
    }
    assert.strictEqual(getPositionCalls, 1, 'Regular polling must NOT call REST getPosition again');

    // WebSocket tick updates position LTP & PnL in memory with ZERO REST calls
    angel.wsClient.marketWs._emit('message', { data: pktBuf });
    const wsUpdatedPositions = await angel.getPositions();
    assert.strictEqual(wsUpdatedPositions[0].ltp, 142.55, 'Position LTP must update from WebSocket tick');
    assert.strictEqual(wsUpdatedPositions[0].unrealizedPnl, Number(((142.55 - 120) * 50).toFixed(2)));
    assert.strictEqual(getPositionCalls, 1);

    // WebSocket NIFTY spot tick serves getIndexQuote with ZERO REST calls
    const spotBuf = Buffer.alloc(123);
    spotBuf.writeUInt8(2, 0);
    spotBuf.writeUInt8(1, 1);
    spotBuf.write('99926000', 2, 'utf8');
    spotBuf.writeBigInt64LE(2461050n, 43); // 24610.50
    spotBuf.writeBigInt64LE(2450000n, 115); // 24500.00
    angel.wsClient.marketWs._emit('message', { data: spotBuf });
    const wsSpot = await angel.getIndexQuote('NIFTY');
    assert.strictEqual(wsSpot.ltp, 24610.5);
    assert.strictEqual(quoteRestCalls, 0, 'NIFTY spot must be retrieved from WebSocket without REST quote call');

    // Placing an order or receiving Order WS update triggers REST getPosition refresh
    await angel.placeOrder({
      tradingSymbol: 'NIFTY26NOV24500CE',
      instrumentToken: '72314',
      transactionType: 'B',
      quantity: 50,
      exchangeSegment: 'nse_fo',
      product: 'MIS'
    });
    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual(getPositionCalls, 2, 'Placing an order must trigger getPositions REST refresh');

    angel.wsClient.orderWs._emit('message', { data: JSON.stringify({ orderData: { orderid: 'ANG-ORD-1', status: 'complete' } }) });
    await new Promise(r => setTimeout(r, 450));
    assert.strictEqual(getPositionCalls, 3, 'Order execution WS event must trigger getPositions REST refresh');

    console.log('   ✅ AngelOneBroker fetches positions on login/trade only and streams live LTP/quotes via WebSocket.');
  } finally {
    if (angel) angel.disconnect();
    global.fetch = originalFetch;
  }

  // 2c. KotakNeoBroker: WebSocket market/order streams + login/order-only REST positions & holdings
  assert.strictEqual(parseKotakMarketMessage(JSON.stringify({ ak: 'ok', type: 'cn' })).length, 0);
  const kTicks = parseKotakMarketMessage(JSON.stringify([{ tk: 'Nifty 50', e: 'nse_cm', ltp: 24650.25, c: 24500 }]));
  assert.strictEqual(kTicks.length, 1);
  assert.strictEqual(kTicks[0].ltp, 24650.25);

  let kPosCalls = 0;
  let kHoldCalls = 0;
  let kotakBroker = null;
  const origFetchK2 = global.fetch;
  try {
    global.fetch = async url => {
      if (url.includes('/tradeApiLogin')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { token: 'vt', sid: 's1' } }) };
      }
      if (url.includes('/tradeApiValidate')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { token: 'st', sid: 's2', baseUrl: 'https://e21.kotaksecurities.com' } }) };
      }
      if (url.includes('/positions')) {
        kPosCalls++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: [{ tsym: 'RELIANCE-EQ', tok: '2885', es: 'nse_cm', prod: 'MIS', flBQty: 10, flSQty: 0, buyAvgPrc: 1200, ltp: 1210 }] })
        };
      }
      if (url.includes('/holdings')) {
        kHoldCalls++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: [{ tsym: 'TCS-EQ', tok: '11536', holdQty: 5, avgPrc: 3900, ltp: 3950 }] })
        };
      }
      if (url.includes('/place')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { nOrdNo: 'KTK-1' } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: {} }) };
    };

    kotakBroker = new KotakNeoBroker({
      id: 'test_kotak_ws',
      consumerKey: 'ck',
      mobileNumber: '9876543210',
      ucc: 'U1',
      mpin: '123456',
      isMock: false,
      WebSocketImpl: FakeWebSocket
    });
    await kotakBroker.login('123456');
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(kPosCalls, 1, 'Kotak positions fetched once on login');
    assert.strictEqual(kHoldCalls, 1, 'Kotak holdings fetched once on login');

    await kotakBroker.getPositions();
    await kotakBroker.getHoldings();
    assert.strictEqual(kPosCalls, 1, 'Kotak regular polling must not call REST');
    assert.strictEqual(kHoldCalls, 1, 'Kotak regular holdings polling must not call REST');

    // Simulate Kotak WebSocket live ticks
    kotakBroker.wsClient.marketWs._emit('message', {
      data: JSON.stringify([
        { tk: 'Nifty 50', e: 'nse_cm', ltp: 24700.5, c: 24500 },
        { tk: '2885', e: 'nse_cm', ltp: 1255.0 }
      ])
    });
    const kSpot = await kotakBroker.getIndexQuote('NIFTY');
    assert.strictEqual(kSpot.ltp, 24700.5);
    const kPosWs = await kotakBroker.getPositions();
    assert.strictEqual(kPosWs[0].ltp, 1255);
    assert.strictEqual(kPosWs[0].unrealizedPnl, 550);

    // Order WS update triggers REST refresh
    kotakBroker.wsClient.orderWs._emit('message', { data: JSON.stringify({ type: 'order', nOrdNo: 'KTK-1', ordSt: 'complete' }) });
    await new Promise(r => setTimeout(r, 420));
    assert.strictEqual(kPosCalls, 2);
    assert.strictEqual(kHoldCalls, 2);
    console.log('   ✅ KotakNeoBroker updates positions/holdings on login/trade only and streams live ticks via WebSocket.');
  } finally {
    if (kotakBroker) kotakBroker.disconnect();
    global.fetch = origFetchK2;
  }

  // 2d. DhanBroker: Dhan v2 binary WS packet parsing + login/order-only REST positions & holdings
  const dhanFullBuf = Buffer.alloc(82);
  dhanFullBuf.writeUInt8(8, 0); // ResponseCode 8 = Full packet
  dhanFullBuf.writeUInt16LE(82, 1);
  dhanFullBuf.writeUInt8(0, 3); // IDX_I
  dhanFullBuf.writeUInt32LE(13, 4); // SecurityId 13 (NIFTY)
  dhanFullBuf.writeFloatLE(24725.5, 8); // LTP
  dhanFullBuf.writeInt32LE(550000, 22); // Volume
  dhanFullBuf.writeInt32LE(1200000, 34); // OI
  dhanFullBuf.writeFloatLE(24600.0, 50); // Close
  const dhanDecoded = parseDhanFeedPacket(dhanFullBuf);
  assert.strictEqual(dhanDecoded.securityId, '13');
  assert.strictEqual(dhanDecoded.ltp, 24725.5);
  assert.strictEqual(dhanDecoded.oi, 1200000);

  let dPosCalls = 0;
  let dHoldCalls = 0;
  let dhanBroker = null;
  const origFetchD = global.fetch;
  try {
    global.fetch = async url => {
      if (url.includes('/fundlimit')) {
        const body = { availMargin: 200000, utilizedAmount: 10000 };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (url.includes('/positions')) {
        dPosCalls++;
        const body = [{ tradingSymbol: 'INFY-EQ', securityId: '1594', exchangeSegment: 'NSE_EQ', productType: 'INTRADAY', netQty: 10, buyQty: 10, buyAvg: 1800, lastTradedPrice: 1810 }];
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (url.includes('/holdings')) {
        dHoldCalls++;
        const body = [{ tradingSymbol: 'HDFCBANK', securityId: '1333', exchange: 'NSE_EQ', totalQty: 20, avgCostPrice: 1600, lastTradedPrice: 1620 }];
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      const body = { orderId: 'DHN-1' };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    };

    dhanBroker = new DhanBroker({
      id: 'test_dhan_ws',
      clientId: '1000001',
      accessToken: 'dhan-jwt',
      isMock: false,
      autoConnect: false,
      WebSocketImpl: FakeWebSocket
    });
    await dhanBroker.login();
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(dPosCalls, 1, 'Dhan positions fetched once on login');
    assert.strictEqual(dHoldCalls, 1, 'Dhan holdings fetched once on login');

    await dhanBroker.getPositions();
    await dhanBroker.getHoldings();
    assert.strictEqual(dPosCalls, 1, 'Dhan regular polling must not call REST');
    assert.strictEqual(dHoldCalls, 1, 'Dhan regular holdings polling must not call REST');

    // Simulate Dhan binary WebSocket ticks for NIFTY (13) and INFY (1594)
    dhanBroker.wsClient.marketWs._emit('message', { data: dhanFullBuf });
    const dSpot = await dhanBroker.getIndexQuote('NIFTY');
    assert.strictEqual(dSpot.ltp, 24725.5);

    const posTickerBuf = Buffer.alloc(16);
    posTickerBuf.writeUInt8(2, 0);
    posTickerBuf.writeUInt16LE(16, 1);
    posTickerBuf.writeUInt8(1, 3); // NSE_EQ
    posTickerBuf.writeUInt32LE(1594, 4);
    posTickerBuf.writeFloatLE(1845.5, 8);
    dhanBroker.wsClient.marketWs._emit('message', { data: posTickerBuf });
    const dPosWs = await dhanBroker.getPositions();
    assert.strictEqual(dPosWs[0].ltp, 1845.5);
    assert.strictEqual(dPosWs[0].unrealizedPnl, 455);

    // Order alert WS event triggers REST refresh
    dhanBroker.wsClient.orderWs._emit('message', { data: JSON.stringify({ Type: 'order_alert', Data: { orderId: 'DHN-1', orderStatus: 'TRADED' } }) });
    await new Promise(r => setTimeout(r, 420));
    assert.strictEqual(dPosCalls, 2);
    assert.strictEqual(dHoldCalls, 2);
    console.log('   ✅ DhanBroker updates positions/holdings on login/trade only and streams live binary ticks via WebSocket.');
  } finally {
    if (dhanBroker) dhanBroker.disconnect();
    global.fetch = origFetchD;
  }

  // 2d-sahi. SahiBroker: auth mint, paise->INR conversion, Protobuf WS market stream, and 3m historical candles
  const encodeTestVarint = val => {
    let v = BigInt(val);
    const out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return out;
  };
  const pbVarint = (field, val) => [...encodeTestVarint((field << 3) | 0), ...encodeTestVarint(val)];
  const pbBytes = (field, bytes) => [...encodeTestVarint((field << 3) | 2), ...encodeTestVarint(bytes.length), ...bytes];

  // Encode ServerMessage { quote_tick (field 3): instrument_id=10854, segment=NSE(1), type=INDEX(1), ltp=2481250 paise (24812.50), volume=0 }
  const quoteTickBody = [
    ...pbVarint(1, 10854),
    ...pbVarint(2, 1),
    ...pbVarint(3, 1),
    ...pbVarint(4, 2481250),
    ...pbVarint(6, 0)
  ];
  const sahiSpotProto = Uint8Array.from(pbBytes(3, quoteTickBody));
  const decodedSpot = decodeServerMessage(sahiSpotProto);
  assert.strictEqual(decodedSpot.type, 'quote_tick');
  assert.strictEqual(decodedSpot.instrumentId, 10854);
  assert.strictEqual(decodedSpot.ltp, 24812.5);

  const subFrame = encodeClientSubscribe(2, [10854, 12027]);
  assert(subFrame instanceof Uint8Array && subFrame.length > 4, 'Sahi protobuf subscribe frame must encode cleanly');

  const depthBidBody = [...pbVarint(1, 184550), ...pbVarint(2, 50), ...pbVarint(3, 2)];
  const depthAskBody = [...pbVarint(1, 184600), ...pbVarint(2, 75), ...pbVarint(3, 3)];
  const depthTickBody = [
    ...pbVarint(1, 12027),
    ...pbVarint(2, 1),
    ...pbVarint(3, 2),
    ...pbVarint(4, 184575),
    ...pbVarint(10, 125000),
    ...pbBytes(11, depthBidBody),
    ...pbBytes(12, depthAskBody)
  ];
  const sahiDepthProto = Uint8Array.from(pbBytes(4, depthTickBody));

  const origFetchSahi = global.fetch;
  let sahiBroker;
  try {
    let sahiPosCalls = 0;
    let sahiHoldCalls = 0;
    let sahiAuthBody = null;
    let sahiPlacedOrderBody = null;

    global.fetch = async (url, opts = {}) => {
      if (url.includes('/api/v1/apikeys/token')) {
        sahiAuthBody = JSON.parse(opts.body);
        const body = { access_token: 'sahi-jwt-123', token_type: 'Bearer', expires_in: 36000, expires_at: '2099-01-01T06:00:00+05:30', scope: 'orders.write orders.read positions.read holdings.read funds.read profile.read marketdata.read' };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (url.includes('/v1/profile')) {
        const body = { user_id: 'SAHI999', name: 'Test Sahi Trader' };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (url.includes('/v1/funds')) {
        const body = {
          available: { stocks_delivery: 10000000, intraday_and_fno_selling: 11500050 },
          balance: { opening_balance: 10000000, payin: 500000, payout: 0, collateral: 2000000, delivery_sell_credit: 0 },
          utilised: { span: 800000, exposure: 200000, delivery_margin: 0, intraday_margin: 0, delivery_buy: 0, charges: 0, mtm_loss: 0 }
        };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (url.includes('/v1/positions')) {
        sahiPosCalls++;
        const body = {
          positions: [{
            exchange_segment: 'NSE',
            symbol: 'RELIANCE',
            instrument_id: 12027,
            product: 'I',
            open_buy_avg_price: 184000,
            total_buy_qty: 10,
            total_sell_qty: 0,
            net_qty: 10,
            net_avg_price: 184000,
            realised_pnl: 0
          }]
        };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (url.includes('/v1/holdings')) {
        sahiHoldCalls++;
        const body = {
          holdings: [{
            isin: 'INE002A01018',
            instrument_ids: [12027],
            t1_qty: 0,
            dp_qty: 5,
            holding_qty: 5,
            holding_avg_price: 180000,
            authorised_qty: 5,
            net_qty: 5
          }]
        };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (url.includes('instruments.csv')) {
        const csv = [
          'id,isin,symbol,company_name,series,underlying_symbol,exchange,segment,token,instrument_type,option_type,expiry_date,strike_price,lot_size,tick_size,freeze_quantity,price_precision,price_multiplier',
          '10854,,,Nifty 50,,,NSE,NSE,26000,IDX,,,0.00,0,0.00,0,0,0',
          '12027,INE002A01018,RELIANCE,Reliance Industries,EQ,,NSE,NSE,2885,STK,,,0.00,1,0.10,0,2,1'
        ].join('\n');
        return { ok: true, status: 200, text: async () => csv };
      }
      if (url.includes('/v1/marketdata/candles')) {
        const ts1 = Date.now() - 360000;
        const body = {
          instrument_id: 10854,
          size: '3m',
          candles: [[ts1, 2480000, 2482000, 2479000, 2481250, 0]],
          has_more: false
        };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
      }
      if (url.includes('/v1/orders') && opts.method === 'POST') {
        sahiPlacedOrderBody = JSON.parse(opts.body);
        const body = { order_ids: ['2611260000001234'] };
        return { ok: true, status: 201, text: async () => JSON.stringify(body), json: async () => body };
      }
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    };

    sahiBroker = new SahiBroker({
      id: 'test_sahi_ws',
      keyId: 'pk_test_123',
      secret: 'sahi_sk_test_456',
      isMock: false,
      autoConnect: false,
      WebSocketImpl: FakeWebSocket
    });

    const loginRes = await sahiBroker.login();
    assert.strictEqual(loginRes.success, true);
    assert.strictEqual(sahiAuthBody.totp, undefined, 'Regular Sahi key must omit totp field');
    await new Promise(r => setTimeout(r, 30));

    const sahiFunds = await sahiBroker.getFunds();
    assert.strictEqual(sahiFunds.availableCash, 115000.5);
    assert.strictEqual(sahiFunds.utilizedMargin, 10000);
    assert.strictEqual(sahiFunds.totalBalance, 125000);

    assert.strictEqual(sahiPosCalls, 1, 'Sahi positions fetched once on login');
    assert.strictEqual(sahiHoldCalls, 1, 'Sahi holdings fetched once on login');
    await sahiBroker.getPositions();
    await sahiBroker.getHoldings();
    assert.strictEqual(sahiPosCalls, 1, 'Sahi regular polling must use cached positions');
    assert.strictEqual(sahiHoldCalls, 1, 'Sahi regular polling must use cached holdings');

    // Feed live Protobuf WS frames for NIFTY (10854) and RELIANCE (12027)
    sahiBroker.wsClient.marketWs._emit('message', { data: sahiSpotProto });
    sahiBroker.wsClient.marketWs._emit('message', { data: sahiDepthProto });

    const sSpot = await sahiBroker.getIndexQuote('NIFTY');
    assert.strictEqual(sSpot.ltp, 24812.5);

    const sPosWs = await sahiBroker.getPositions();
    assert.strictEqual(sPosWs[0].ltp, 1845.75);
    assert.strictEqual(sPosWs[0].unrealizedPnl, 57.5); // (1845.75 - 1840) * 10

    const sCandles = await sahiBroker.getHistoricalCandles({ days: 3, interval: '3m' });
    assert.strictEqual(sCandles.length, 1);
    assert.strictEqual(sCandles[0].close, 24812.5);

    const sOrdRes = await sahiBroker.placeOrder({
      tradingSymbol: 'RELIANCE',
      exchangeSegment: 'nse_cm',
      transactionType: 'B',
      orderType: 'LMT',
      product: 'MIS',
      quantity: 2,
      price: 1845.75
    });
    assert.strictEqual(sOrdRes.orderId, '2611260000001234');
    assert.strictEqual(sahiPlacedOrderBody.exchange_segment, 'NSE');
    assert.strictEqual(sahiPlacedOrderBody.product, 'I');
    assert.strictEqual(sahiPlacedOrderBody.price, 184575, 'Sahi order price must convert INR to integer paise');

    const mgrFeedCheck = new MultiBrokerManager({ loadConfig: () => ({ mode: 'mock' }) });
    assert.strictEqual(mgrFeedCheck.setDataFeedSource('sahi').dataFeedSource, 'sahi');
    for (const inst of mgrFeedCheck.brokerInstances.values()) {
      if (typeof inst.disconnect === 'function') inst.disconnect();
    }

    console.log('   ✅ SahiBroker authenticates, converts paise<->INR, decodes Protobuf WS ticks, and fetches 3m history.');
  } finally {
    if (sahiBroker) sahiBroker.disconnect();
    global.fetch = origFetchSahi;
  }

  // 2e. NiftyCandleManager: 3-minute SQLite persistence, WS candle aggregation, and 3-day REST backfill
  const testDbPath = path.join(__dirname, '..', 'data', 'test_candles_tmp.db');
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(testDbPath + suffix)) fs.unlinkSync(testDbPath + suffix);
  }

  // Verify 1m -> 3m aggregation (e.g. 09:15, 09:16, 09:17 -> 09:15)
  const baseSec = Math.floor(Date.UTC(2026, 10, 25, 3, 45, 0) / 1000); // 09:15:00 IST
  const agg = aggregateTo3MinuteCandles([
    { time: baseSec, open: 24500, high: 24510, low: 24495, close: 24508, volume: 100 },
    { time: baseSec + 60, open: 24508, high: 24520, low: 24505, close: 24515, volume: 150 },
    { time: baseSec + 120, open: 24515, high: 24518, low: 24502, close: 24512, volume: 120 }
  ]);
  assert.strictEqual(agg.length, 1);
  assert.strictEqual(agg[0].time, baseSec);
  assert.strictEqual(agg[0].open, 24500);
  assert.strictEqual(agg[0].high, 24520);
  assert.strictEqual(agg[0].low, 24495);
  assert.strictEqual(agg[0].close, 24512);
  assert.strictEqual(agg[0].volume, 370);

  let backfillCalls = 0;
  const fakeHistMgr = {
    getNiftyHistoricalCandles: async () => {
      backfillCalls++;
      return {
        broker: 'angelone',
        candles: [
          { time: baseSec - 86400, open: 24450, high: 24470, low: 24440, close: 24465, volume: 200, source: 'rest' },
          { time: baseSec - 86400 + 180, open: 24465, high: 24490, low: 24460, close: 24485, volume: 250, source: 'rest' }
        ]
      };
    }
  };

  let candleMgr = new NiftyCandleManager(fakeHistMgr, { dbPath: testDbPath });
  try {
    const bf1 = await candleMgr.backfillIfEmpty(3);
    assert.strictEqual(bf1.backfilled, true);
    assert.strictEqual(bf1.count, 2);
    assert.strictEqual(backfillCalls, 1);

    // Calling backfillIfEmpty again must NOT hit broker REST since DB already has history
    const bf2 = await candleMgr.backfillIfEmpty(3);
    assert.strictEqual(bf2.backfilled, false);
    assert.strictEqual(backfillCalls, 1);

    // Off-hours / weekend ticks must NOT create candles
    const off0859Ms = makeISTDate(2026, 11, 26, 8, 59).getTime();
    const off1530Ms = makeISTDate(2026, 11, 26, 15, 30).getTime();
    const offSatMs = makeISTDate(2026, 11, 28, 11, 0).getTime();
    assert.strictEqual(isISTTradingHours(Math.floor(off0859Ms / 1000)), false);
    assert.strictEqual(isISTTradingHours(Math.floor(off1530Ms / 1000)), false);
    assert.strictEqual(isISTTradingHours(Math.floor(offSatMs / 1000)), false);
    assert.strictEqual(isISTTradingHours(baseSec), true);
    assert.strictEqual(candleMgr.onSpotTick(24500, off0859Ms), null, 'Pre-market tick before 09:15 IST must NOT build candle');
    assert.strictEqual(candleMgr.onSpotTick(24500, off1530Ms), null, 'Post-market tick at 15:30 IST must NOT build candle');
    assert.strictEqual(candleMgr.onSpotTick(24500, offSatMs), null, 'Weekend tick must NOT build candle');

    // Live WebSocket ticks generate and update 3-minute candles during trading hours
    const c1 = candleMgr.onSpotTick(24500, baseSec * 1000 + 10000);
    const c2 = candleMgr.onSpotTick(24525, baseSec * 1000 + 70000);
    const c3 = candleMgr.onSpotTick(24492, baseSec * 1000 + 120000);
    const cNext = candleMgr.onSpotTick(24530, (baseSec + 180) * 1000 + 5000);

    assert.strictEqual(c1.time, baseSec);
    assert.strictEqual(c3.open, 24500);
    assert.strictEqual(c3.high, 24525);
    assert.strictEqual(c3.low, 24492);
    assert.strictEqual(c3.close, 24492);
    assert.strictEqual(cNext.time, baseSec + 180);
    candleMgr.close();

    // Re-open SQLite DB to verify candles persisted on disk
    candleMgr = new NiftyCandleManager(fakeHistMgr, { dbPath: testDbPath });
    const loaded = candleMgr.getCandles();
    assert.strictEqual(loaded.length, 4);
    assert.strictEqual(loaded[2].high, 24525);
    assert.strictEqual(loaded[3].open, 24530);
    console.log('   ✅ NiftyCandleManager builds candles strictly in IST trading hours (09:15-15:29 Mon-Fri), persists in SQLite, and backfills 3d REST history.');
  } finally {
    candleMgr.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(testDbPath + suffix)) fs.unlinkSync(testDbPath + suffix);
    }
  }

  // 2f. AutoLoginScheduler: does NOT trigger at 08:58 IST, triggers once at 08:59 AM IST
  let autoLoginCalls = 0;
  const fakeAutoLoginMgr = {
    loginAllBrokers: async () => {
      autoLoginCalls++;
      return [
        { accountId: 'k1', broker: 'kotakneo', success: true },
        { accountId: 'a1', broker: 'angelone', success: true },
        { accountId: 'd1', broker: 'dhan', success: true }
      ];
    }
  };
  const autoLoginSched = new AutoLoginScheduler(fakeAutoLoginMgr, { disableTimers: true });

  const at858 = makeISTDate(2026, 11, 26, 8, 58);
  const res858 = await autoLoginSched._checkAndTrigger(at858);
  assert.strictEqual(res858.triggered, false, 'Must NOT auto-login before 08:59 AM IST');
  assert.strictEqual(autoLoginCalls, 0);

  const at859 = makeISTDate(2026, 11, 26, 8, 59);
  const res859 = await autoLoginSched._checkAndTrigger(at859);
  assert.strictEqual(res859.triggered, true, 'Must auto-login all brokers at 08:59 AM IST');
  assert.strictEqual(autoLoginCalls, 1);
  assert.strictEqual(res859.results.length, 3);

  // Repeat check same day must not re-login
  const at902 = makeISTDate(2026, 11, 26, 9, 2);
  const res902 = await autoLoginSched._checkAndTrigger(at902);
  assert.strictEqual(at902 ? res902.triggered : false, false);
  assert.strictEqual(autoLoginCalls, 1);
  console.log('   ✅ AutoLoginScheduler triggers loginAllBrokers once daily at 08:59 AM IST.');

  // 2g. Chart Analysis: Session Boundaries, 5m/15m/1h Heikin-Ashi (>2G Res / >2R Sup), PDH/PDL, Pivots
  const d1Start = Math.floor(makeISTDate(2026, 11, 25, 9, 15).getTime() / 1000);
  const d2Start = Math.floor(makeISTDate(2026, 11, 26, 9, 15).getTime() / 1000);

  // Build Day 1 (prev day) 1m candles over 2 hours (9:15..11:15) with known PDH=25200, PDL=24900, PDC=25100
  const multiDay1m = [];
  for (let m = 0; m < 120; m++) {
    const t = d1Start + m * 60;
    const base = 25000 + m;
    multiDay1m.push({
      time: t,
      open: base,
      high: m === 50 ? 25200 : base + 10,
      low: m === 10 ? 24900 : base - 10,
      close: m === 119 ? 25100 : base + 2,
      volume: 100
    });
  }
  // Build Day 2 (today) 1m candles: first 10 mins steady, then rally (4 green HA 5m bars), then drop (3 red HA 5m bars)
  const d2Prices = [
    25100, 25120, 25140, 25160, 25180, // 09:15..09:19 -> 5m #1 bullish
    25180, 25200, 25230, 25250, 25270, // 09:20..09:24 -> 5m #2 bullish
    25270, 25300, 25330, 25360, 25400, // 09:25..09:29 -> 5m #3 bullish (peak 25400)
    25400, 25360, 25300, 25240, 25190, // 09:30..09:34 -> 5m #4 bearish
    25190, 25150, 25110, 25070, 25040, // 09:35..09:39 -> 5m #5 bearish
    25040, 25010, 24980, 24960, 24950, // 09:40..09:44 -> 5m #6 bearish
    24950, 24920, 24890, 24870, 24850  // 09:45..09:49 -> 5m #7 bearish (trough 24850)
  ];
  for (let m = 0; m < d2Prices.length; m++) {
    const p = d2Prices[m];
    const prevP = m > 0 ? d2Prices[m - 1] : 25090;
    multiDay1m.push({
      time: d2Start + m * 60,
      open: prevP,
      high: Math.max(prevP, p),
      low: Math.min(prevP, p),
      close: p,
      volume: 50
    });
  }

  const sessions = getSessionBoundaries(multiDay1m);
  assert.strictEqual(sessions.length, 1, 'Expected 1 session boundary between Day 1 and Day 2');
  assert.strictEqual(sessions[0].time, d2Start, 'Session boundary must align cleanly with 09:15 IST open');

  const pivots = calculatePreviousDayAndPivots(multiDay1m);
  assert.strictEqual(pivots.pdh, 25200);
  assert.strictEqual(pivots.pdl, 24900);
  assert.strictEqual(pivots.pdc, 25100);
  assert.strictEqual(pivots.pivot, 25066.67); // (25200 + 24900 + 25100) / 3
  assert.strictEqual(pivots.r1, 25233.33);
  assert.strictEqual(pivots.s1, 24933.33);

  // Verify >2 green & >2 red rule explicitly on synthetic HA sequence
  const syntheticHa = [
    { time: 100, open: 100, high: 110, low: 98, close: 108, color: 'green' },
    { time: 200, open: 104, high: 115, low: 103, close: 114, color: 'green' }, // only 2 green -> should NOT mark resistance
    { time: 300, open: 114, high: 115, low: 105, close: 106, color: 'red' },
    { time: 400, open: 110, high: 111, low: 101, close: 102, color: 'red' },
    { time: 500, open: 106, high: 107, low: 95, close: 97, color: 'red' },   // 3 red -> Support @ 95
    { time: 600, open: 97, high: 105, low: 96, close: 104, color: 'green' },
    { time: 700, open: 100, high: 112, low: 100, close: 111, color: 'green' },
    { time: 800, open: 105, high: 125, low: 105, close: 122, color: 'green' },
    { time: 900, open: 113, high: 120, low: 112, close: 119, color: 'green' } // 4 green -> Resistance @ 125
  ];
  const syntheticZones = detectHeikinAshiZones(syntheticHa, '5m');
  assert.strictEqual(syntheticZones.resistances.length, 1, 'Only >2 green streak should mark resistance');
  assert.strictEqual(syntheticZones.resistances[0].price, 125);
  assert.strictEqual(syntheticZones.resistances[0].count, 4);
  assert.strictEqual(syntheticZones.supports.length, 1, 'Only >2 red streak should mark support');
  assert.strictEqual(syntheticZones.supports[0].price, 95);
  assert.strictEqual(syntheticZones.supports[0].count, 3);

  const agg5m = aggregateToSessionTimeframe(multiDay1m, 5);
  const agg15m = aggregateToSessionTimeframe(multiDay1m, 15);
  const agg1h = aggregateToSessionTimeframe(multiDay1m, 60);
  assert(agg5m.length > agg15m.length && agg15m.length > agg1h.length);
  const fullAnalysis = buildChartAnalysis(aggregateTo3MinuteCandles(multiDay1m), multiDay1m);
  assert(fullAnalysis.timeframes['5m'] && fullAnalysis.timeframes['15m'] && fullAnalysis.timeframes['1h']);
  assert(fullAnalysis.timeframes['5m'].latestResistance && fullAnalysis.timeframes['5m'].latestSupport, '5m HA should detect both >2G resistance and >2R support');
  console.log('   ✅ Chart analysis computes session vertical lines, PDH/PDL, Pivot Points, and 5m/15m/1h Heikin-Ashi S/R zones.');

  // 2h. ScripMasterManager 08:55 AM IST Scheduler, Freeze Splitting & Balance-Based Auto-Qty
  const testScripDbPath = path.join(__dirname, '..', 'data', 'test_scrip_tmp.db');
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(testScripDbPath + suffix)) fs.unlinkSync(testScripDbPath + suffix);
  }
  const origFetchScrip = global.fetch;
  let scripMgr;
  try {
    let dlCalls = 0;
    global.fetch = async url => {
      dlCalls++;
      if (url.includes('instruments.csv')) {
        const csv = [
          'id,isin,symbol,company_name,series,underlying_symbol,exchange,segment,token,instrument_type,option_type,expiry_date,strike_price,lot_size,tick_size,freeze_quantity,price_precision,price_multiplier',
          '1914891,,NIFTY27OCT26C25000,,,NIFTY,NSE,NFO,51440,OPTIDX,CE,27-10-2026,25000.00,65,0.05,1800,2,1'
        ].join('\n');
        return { ok: true, status: 200, text: async () => csv };
      }
      if (url.includes('OpenAPIScripMaster.json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([{
            symbol: 'NIFTY26NOV2624800CE',
            exch_seg: 'NFO',
            token: '72314',
            name: 'NIFTY',
            instrumenttype: 'OPTIDX',
            lotsize: '65'
          }])
        };
      }
      return { ok: true, status: 200, text: async () => '' };
    };

    scripMgr = new ScripMasterManager({ dbPath: testScripDbPath, disableTimers: true });
    assert.strictEqual((await scripMgr._checkAndTrigger(makeISTDate(2026, 11, 26, 8, 54))).triggered, false, 'Must NOT download scrip master before 08:55 AM IST');
    const dl855 = await scripMgr._checkAndTrigger(makeISTDate(2026, 11, 26, 8, 55));
    assert.strictEqual(dl855.triggered, true, 'Must download scrip master at 08:55 AM IST');
    assert.strictEqual((await scripMgr._checkAndTrigger(makeISTDate(2026, 11, 26, 9, 5))).triggered, false, 'Must not re-download same day');

    const sahiSpec = scripMgr.getContractSpec({ symbol: 'NIFTY27OCT26C25000', exchangeSegment: 'NFO' });
    assert.strictEqual(sahiSpec.lotSize, 65);
    assert.strictEqual(sahiSpec.freezeQty, 1800);

    const angelSpec = scripMgr.getContractSpec({ symbol: 'NIFTY26NOV2624800CE', exchangeSegment: 'NFO' });
    assert.strictEqual(angelSpec.lotSize, 65);
    assert.strictEqual(angelSpec.freezeQty, 1800, 'Angel contract must inherit NIFTY freezeQty from ScripMaster');

    assert.deepStrictEqual(splitQuantityByFreeze(3705, 1800, 65), [1755, 1755, 195]);
    assert.deepStrictEqual(splitQuantityByFreeze(1300, 1800, 65), [1300]);

    const sized = calculateOrderQuantity({ availableCash: 100000, price: 150, lotSize: 65, freezeQty: 1800 });
    assert.strictEqual(sized.lots, 10);
    assert.strictEqual(sized.quantity, 650);
    assert.deepStrictEqual(sized.slices, [650]);

    const largeSized = calculateOrderQuantity({ availableCash: 500000, price: 150, lotSize: 65, freezeQty: 1800 });
    assert.strictEqual(largeSized.quantity, 3315); // floor(500000/150)=3333 -> 51 lots * 65 = 3315
    assert.deepStrictEqual(largeSized.slices, [1755, 1560]);

    // Test MultiBrokerManager.placeOrder freeze splitting + autoQuantity
    const mgrSplit = new MultiBrokerManager({ loadConfig: () => ({ mode: 'live' }) }, { scripMasterManager: scripMgr, dailyOrdersFile: null, enforceQuietHours: false });
    for (const inst of mgrSplit.brokerInstances.values()) {
      if (typeof inst.disconnect === 'function') inst.disconnect();
    }
    mgrSplit.brokerInstances.clear();
    const placedSlices = [];
    const mockLiveBroker = {
      id: 'live_test_1',
      broker: 'kotakneo',
      isMock: false,
      isAuthenticated: true,
      getFunds: async () => ({ availableCash: 100000, utilizedMargin: 0, totalBalance: 100000 }),
      placeOrder: async ord => {
        placedSlices.push(ord.quantity);
        return { success: true, orderId: 'ORD-' + placedSlices.length };
      },
      disconnect: () => {}
    };
    mgrSplit.brokerInstances.set('live_test_1', mockLiveBroker);

    const splitRes = await mgrSplit.placeOrder({
      accountId: 'live_test_1',
      tradingSymbol: 'NIFTY27OCT26C25000',
      exchangeSegment: 'NFO',
      transactionType: 'B',
      orderType: 'MKT',
      quantity: 3705
    });
    assert.strictEqual(splitRes.sliced, true);
    assert.strictEqual(splitRes.sliceCount, 3);
    assert.deepStrictEqual(placedSlices, [1755, 1755, 195]);

    placedSlices.length = 0;
    const autoRes = await mgrSplit.placeOrder({
      accountId: 'live_test_1',
      tradingSymbol: 'NIFTY27OCT26C25000',
      exchangeSegment: 'NFO',
      transactionType: 'B',
      orderType: 'L',
      price: 150,
      autoQuantity: true
    });
    assert.strictEqual(autoRes.totalQuantity, 650);
    assert.deepStrictEqual(placedSlices, [650]);

    // Test order-type-aware pricing (+0.5 Buy / -0.5 Sell, MKT=LTP, L=Limit, SL=Trigger+Limit)
    const mktPricing = resolveOrderTypePricing({ orderType: 'MKT', transactionType: 'B', ltp: 142.35 });
    assert.strictEqual(mktPricing.sizingPrice, 142.35);
    assert.strictEqual(mktPricing.orderPrice, 0);

    const limitBuyDefault = resolveOrderTypePricing({ orderType: 'L', transactionType: 'B', ltp: 120 });
    assert.strictEqual(limitBuyDefault.orderPrice, 120.5);
    assert.strictEqual(limitBuyDefault.sizingPrice, 120.5);

    const limitSellDefault = resolveOrderTypePricing({ orderType: 'L', transactionType: 'S', ltp: 120 });
    assert.strictEqual(limitSellDefault.orderPrice, 119.5);
    assert.strictEqual(limitSellDefault.sizingPrice, 119.5);

    const slBuyDefault = resolveOrderTypePricing({ orderType: 'SL', transactionType: 'B', triggerPrice: 150 });
    assert.strictEqual(slBuyDefault.triggerPrice, 150);
    assert.strictEqual(slBuyDefault.orderPrice, 150.5);
    assert.strictEqual(slBuyDefault.sizingPrice, 150.5);

    const slSellDefault = resolveOrderTypePricing({ orderType: 'SL', transactionType: 'S', triggerPrice: 150 });
    assert.strictEqual(slSellDefault.triggerPrice, 150);
    assert.strictEqual(slSellDefault.orderPrice, 149.5);
    assert.strictEqual(slSellDefault.sizingPrice, 149.5);

    const calcMkt = calculateOrderQuantity({
      availableCash: 50000,
      orderType: 'MKT',
      transactionType: 'B',
      price: 0,
      ltp: 125,
      lotSize: 65,
      freezeQty: 1800
    });
    assert.strictEqual(calcMkt.price, 125);
    assert.strictEqual(calcMkt.quantity, Math.floor(Math.floor(50000 / 125) / 65) * 65);

    const calcLimit = calculateOrderQuantity({
      availableCash: 50000,
      orderType: 'L',
      transactionType: 'B',
      price: 100,
      ltp: 125,
      lotSize: 65,
      freezeQty: 1800
    });
    assert.strictEqual(calcLimit.price, 100);
    assert.strictEqual(calcLimit.orderPrice, 100);
    assert.strictEqual(calcLimit.quantity, Math.floor(Math.floor(50000 / 100) / 65) * 65);

    const calcSl = calculateOrderQuantity({
      availableCash: 50000,
      orderType: 'SL',
      transactionType: 'B',
      triggerPrice: 150,
      price: 150.5,
      lotSize: 65,
      freezeQty: 1800
    });
    assert.strictEqual(calcSl.triggerPrice, 150);
    assert.strictEqual(calcSl.orderPrice, 150.5);
    assert.strictEqual(calcSl.quantity, Math.floor(Math.floor(50000 / 150.5) / 65) * 65);

    // Test AngelOneBroker & DhanBroker placeOrder SL/NFO mapping using mocked fetch
    let angelBodySent = null;
    let dhanBodySent = null;
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('apiconnect.angelone.in')) {
        angelBodySent = JSON.parse(init.body || '{}');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ status: true, data: { orderid: 'ANG-SL-1' } })
        };
      }
      if (u.includes('api.dhan.co')) {
        dhanBodySent = JSON.parse(init.body || '{}');
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ orderId: 'DHN-SL-1', orderStatus: 'TRANSIT' })
        };
      }
      return origFetchScrip(url, init);
    };

    const angelPlaceTest = new AngelOneBroker({
      id: 'ang_sl_1',
      apiKey: 'ak',
      clientCode: 'CC1'
    });
    angelPlaceTest.jwtToken = 'jwt_test';
    angelPlaceTest.isAuthenticated = true;
    angelPlaceTest.scheduleTradeRefresh = () => {};
    const angSlRes = await angelPlaceTest.placeOrder({
      tradingSymbol: 'NIFTY27OCT2625000CE',
      symbolToken: '99999',
      exchangeSegment: 'nse_fo',
      transactionType: 'B',
      orderType: 'SL',
      product: 'NRML',
      quantity: 325,
      price: 150.5,
      triggerPrice: 150
    });
    assert.strictEqual(angSlRes.success, true);
    assert.strictEqual(angelBodySent.exchange, 'NFO');
    assert.strictEqual(angelBodySent.ordertype, 'STOPLOSS_LIMIT');
    assert.strictEqual(angelBodySent.price, '150.5');
    assert.strictEqual(angelBodySent.triggerprice, '150');

    const dhanPlaceTest = new DhanBroker({
      id: 'dhn_sl_1',
      clientId: 'DH1',
      accessToken: 'tok_test'
    });
    dhanPlaceTest.scheduleTradeRefresh = () => {};
    const dhanSlRes = await dhanPlaceTest.placeOrder({
      tradingSymbol: 'NIFTY27OCT2625000CE',
      securityId: '88888',
      exchangeSegment: 'nse_fo',
      transactionType: 'B',
      orderType: 'SL',
      product: 'NRML',
      quantity: 325,
      price: 150.5,
      triggerPrice: 150
    });
    assert.strictEqual(dhanSlRes.success, true);
    assert.strictEqual(dhanBodySent.orderType, 'STOP_LOSS');
    assert.strictEqual(dhanBodySent.price, 150.5);
    assert.strictEqual(dhanBodySent.triggerPrice, 150);

    // Test Capital Deploy % (50%), Max Daily Orders Cap, Daily Risk Guard, and All-Funded Multi-Broker Routing
    let riskState = {
      capitalDeployPct: 50,
      maxDailyOrders: 3,
      orderRoutingMode: 'selected',
      targetDailyNetProfitPct: 2.0,
      maxDailyLossNetPct: 1.5
    };
    let dailyBlocked = false;
    const mgrRisk = new MultiBrokerManager(
      { loadConfig: () => ({ mode: 'live', riskSettings: riskState }) },
      {
        scripMasterManager: scripMgr,
        dailyOrdersFile: null,
        enforceQuietHours: false,
        dailyRiskGuardProvider: () => (dailyBlocked ? { blocked: true, reason: 'Max loss hit' } : { blocked: false, reason: null })
      }
    );
    for (const inst of mgrRisk.brokerInstances.values()) {
      if (typeof inst.disconnect === 'function') inst.disconnect();
    }
    mgrRisk.brokerInstances.clear();
    const routedOrders = [];
    const makeRoutedBroker = (id, name, cash) => ({
      id,
      name,
      broker: 'sahi',
      isMock: false,
      isAuthenticated: true,
      getFunds: async () => ({ availableCash: cash, utilizedMargin: 0, totalBalance: cash }),
      placeOrder: async ord => {
        routedOrders.push({ id, qty: ord.quantity });
        return { success: true, orderId: `${id}-ORD-${routedOrders.length}` };
      },
      disconnect: () => {}
    });
    mgrRisk.brokerInstances.set('b_empty', makeRoutedBroker('b_empty', 'Angel Empty', 0));
    mgrRisk.brokerInstances.set('b_funded_1', makeRoutedBroker('b_funded_1', 'Sahi 1', 50000));
    mgrRisk.brokerInstances.set('b_funded_2', makeRoutedBroker('b_funded_2', 'Dhan 2', 30000));

    // At 50% deploy: Sahi 1 (₹50,000 -> ₹25,000 usable) @ ₹150 => floor(25000/150/65)*65 = 2 lots (130), Dhan 2 (₹15,000 usable) => 1 lot (65)
    const previewAll = await mgrRisk.calculateOrderQuantityForAccount({
      accountId: 'b_funded_1',
      routingMode: 'all_funded',
      tradingSymbol: 'NIFTY27OCT26C25000',
      exchangeSegment: 'NFO',
      orderType: 'L',
      price: 150
    });
    assert.strictEqual(previewAll.capitalDeployPct, 50);
    assert.strictEqual(previewAll.quantity, 130);
    assert.strictEqual(previewAll.eligibleBrokers.length, 2);
    assert.strictEqual(previewAll.skippedBrokers.length, 1);

    const routeRes = await mgrRisk.placeOrder({
      routingMode: 'all_funded',
      tradingSymbol: 'NIFTY27OCT26C25000',
      exchangeSegment: 'NFO',
      transactionType: 'B',
      orderType: 'L',
      price: 150,
      autoQuantity: true
    });
    assert.strictEqual(routeRes.routingMode, 'all_funded');
    assert.strictEqual(routeRes.executedCount, 2);
    assert.strictEqual(routeRes.totalQuantity, 195);
    assert.strictEqual(routeRes.skippedBrokers.length, 1);
    assert.deepStrictEqual(routedOrders, [
      { id: 'b_funded_1', qty: 130 },
      { id: 'b_funded_2', qty: 65 }
    ]);

    // Used 2 of 3 maxDailyOrders; place 3rd order on b_funded_1 -> OK; 4th entry order -> blocked; exitPosition -> allowed!
    const thirdOrd = await mgrRisk.placeOrder({
      accountId: 'b_funded_1',
      routingMode: 'selected',
      tradingSymbol: 'NIFTY27OCT26C25000',
      exchangeSegment: 'NFO',
      transactionType: 'B',
      orderType: 'MKT',
      quantity: 65
    });
    assert.strictEqual(thirdOrd.dailyOrders.ordersPlacedToday, 3);
    await assert.rejects(
      () => mgrRisk.placeOrder({
        accountId: 'b_funded_1',
        routingMode: 'selected',
        tradingSymbol: 'NIFTY27OCT26C25000',
        exchangeSegment: 'NFO',
        transactionType: 'B',
        orderType: 'MKT',
        quantity: 65
      }),
      /Daily max orders limit reached/
    );
    // Exit order must bypass daily order & circuit breaker limits
    dailyBlocked = true;
    const exitBypassRes = await mgrRisk.exitPosition({
      accountId: 'b_funded_1',
      broker: 'sahi',
      symbol: 'NIFTY27OCT26C25000',
      exchangeSegment: 'NFO',
      netQty: 65,
      product: 'MIS'
    });
    assert.strictEqual(exitBypassRes.success, true);

    // Test 4:00 PM - 9:00 AM IST Quiet Hours pause vs Manual Fetch
    assert.strictEqual(isPortfolioQuietHoursIST(new Date('2026-11-26T15:59:59+05:30')), false);
    assert.strictEqual(isPortfolioQuietHoursIST(new Date('2026-11-26T16:00:00+05:30')), true);
    assert.strictEqual(isPortfolioQuietHoursIST(new Date('2026-11-27T08:59:59+05:30')), true);
    assert.strictEqual(isPortfolioQuietHoursIST(new Date('2026-11-27T09:00:00+05:30')), false);

    const mgrQuiet = new MultiBrokerManager(
      { loadConfig: () => ({ mode: 'live', riskSettings: {} }) },
      { scripMasterManager: scripMgr, dailyOrdersFile: null, enforceQuietHours: true }
    );
    for (const inst of mgrQuiet.brokerInstances.values()) {
      if (typeof inst.disconnect === 'function') inst.disconnect();
    }
    mgrQuiet.brokerInstances.clear();
    let qPosCalls = 0, qFundsCalls = 0, qHoldCalls = 0, qOrdCalls = 0, qLoginOpts = null;
    mgrQuiet.brokerInstances.set('q1', {
      id: 'q1',
      name: 'Quiet Broker',
      broker: 'sahi',
      isMock: false,
      isAuthenticated: false,
      _cache: {
        positions: { data: [{ symbol: 'CACHED-POS', netQty: 1 }] },
        holdings: { data: [{ symbol: 'CACHED-HOLD', quantity: 2 }] },
        funds: { data: { availableCash: 1234, utilizedMargin: 0, totalBalance: 1234 } },
        orders: { data: [{ orderId: 'CACHED-ORD' }] }
      },
      login: async (_t, opts) => { qLoginOpts = opts; return { success: true }; },
      getPositions: async () => { qPosCalls++; return [{ symbol: 'LIVE-POS', netQty: 1 }]; },
      getFunds: async () => { qFundsCalls++; return { availableCash: 9999, utilizedMargin: 0, totalBalance: 9999 }; },
      getHoldings: async () => { qHoldCalls++; return [{ symbol: 'LIVE-HOLD', quantity: 5 }]; },
      getOrderBook: async () => { qOrdCalls++; return [{ orderId: 'LIVE-ORD' }]; },
      disconnect: () => {}
    });

    const quietTime5PM = new Date('2026-11-26T17:00:00+05:30');
    const quietPos = await mgrQuiet.getAllPositions({ now: quietTime5PM });
    const quietFunds = await mgrQuiet.getAllFunds({ now: quietTime5PM });
    const quietHold = await mgrQuiet.getAllHoldings({ now: quietTime5PM });
    const quietOrd = await mgrQuiet.getAllOrders({ now: quietTime5PM });
    await mgrQuiet.loginAllBrokers({ now: quietTime5PM });
    assert.strictEqual(qPosCalls, 0);
    assert.strictEqual(qFundsCalls, 0);
    assert.strictEqual(qHoldCalls, 0);
    assert.strictEqual(qOrdCalls, 0);
    assert.strictEqual(qLoginOpts.skipPortfolioFetch, true);
    assert.strictEqual(quietPos[0].symbol, 'CACHED-POS');
    assert.strictEqual(quietFunds.availableCash, 1234);
    assert.strictEqual(quietFunds.quietHoursPaused, true);
    assert.strictEqual(quietHold[0].symbol, 'CACHED-HOLD');
    assert.strictEqual(quietOrd[0].orderId, 'CACHED-ORD');

    // Manual button click ALWAYS fetches even during quiet hours
    const manualAll = await mgrQuiet.fetchAllPortfolioManual();
    assert.strictEqual(qPosCalls, 1);
    assert.strictEqual(qFundsCalls, 1);
    assert.strictEqual(qHoldCalls, 1);
    assert.strictEqual(qOrdCalls, 1);
    assert.strictEqual(manualAll.positions[0].symbol, 'LIVE-POS');
    assert.strictEqual(manualAll.funds.availableCash, 9999);
    assert.strictEqual(manualAll.holdings[0].symbol, 'LIVE-HOLD');
    assert.strictEqual(manualAll.orders[0].orderId, 'LIVE-ORD');

    console.log('   ✅ ScripMasterManager loads lotSize/freezeQty at 08:55 AM IST, auto-sizes from balance, and splits orders > freeze.');
  } finally {
    if (scripMgr) scripMgr.close();
    global.fetch = origFetchScrip;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(testScripDbPath + suffix)) fs.unlinkSync(testScripDbPath + suffix);
    }
  }

  // 2b. KotakNeoClient baseUrl migration & login header checks
  const kotakLegacy = new KotakNeoClient({
    baseUrl: 'https://napi.kotaksecurities.com',
    consumerKey: 'ckey_123',
    mobileNumber: '+919999999999',
    ucc: 'UCC1'
  });
  assert.strictEqual(kotakLegacy.baseUrl, 'https://mis.kotaksecurities.com', 'Legacy napi URL must upgrade to mis.kotaksecurities.com');

  const origFetchKotak = global.fetch;
  try {
    let loginUrl = '';
    let loginHeaders = {};
    let loginBody = {};
    global.fetch = async (url, opts) => {
      loginUrl = url;
      loginHeaders = opts.headers || {};
      loginBody = JSON.parse(opts.body || '{}');
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { token: 'vt', sid: 's1' } }) };
    };
    await kotakLegacy.loginWithTotp('9876543210', 'UCC1', '123456');
    assert.strictEqual(loginUrl, 'https://mis.kotaksecurities.com/login/1.0/tradeApiLogin');
    assert.strictEqual(loginHeaders.Authorization, 'ckey_123');
    assert.strictEqual(loginBody.mobileNumber, '+919876543210', '10-digit mobile must normalize to +91');

    // Nested error object must NOT produce [object Object]
    global.fetch = async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: { code: 900901, message: 'Invalid Credentials' } })
    });
    await assert.rejects(
      () => kotakLegacy.loginWithTotp('9876543210', 'UCC1', '123456'),
      err => err.message === 'Invalid Credentials' && !err.message.includes('[object Object]')
    );

    // Verify validateMpin sends only { mpin } (no unknown "ucc" field)
    let validateBody = null;
    global.fetch = async (url, opts) => {
      validateBody = JSON.parse(opts.body || '{}');
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { token: 'st', sid: 's2', baseUrl: 'https://gw.kotaksecurities.com' } }) };
    };
    const valRes = await kotakLegacy.validateMpin('654321', 'UCC1', 'vt');
    assert.strictEqual(valRes.success, true);
    assert.deepStrictEqual(validateBody, { mpin: '654321' }, 'tradeApiValidate payload must only contain mpin');

    // Verify getPositions returns [] when Kotak Neo reports "No Data"
    kotakLegacy.isAuthenticated = true;
    kotakLegacy.sessionToken = 'st';
    kotakLegacy.sid = 's2';
    global.fetch = async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ stat: 'Not_Ok', errMsg: 'No Data' })
    });
    const emptyPos = await kotakLegacy.getPositions();
    assert.deepStrictEqual(emptyPos, [], 'Kotak "No Data" must resolve cleanly to empty positions array');

    // Verify getHoldings returns [] when Kotak Neo reports "No holdings found for this client ..."
    global.fetch = async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: [{ message: 'No holdings found for this client 118BB' }] })
    });
    const emptyHold = await kotakLegacy.getHoldings();
    assert.deepStrictEqual(emptyHold, [], 'Kotak "No holdings found" must resolve cleanly to empty holdings array');

    // Verify getLimits sends POST /quick/user/limits with jData and parses PascalCase fields
    let limitsMethod = '';
    let limitsBody = '';
    global.fetch = async (_url, opts) => {
      limitsMethod = opts.method;
      limitsBody = opts.body;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ Net: '150250.50', MarginUsed: '24500.00', CollateralValue: '50000' })
      };
    };
    const limitsRes = await kotakLegacy.getLimits();
    assert.strictEqual(limitsMethod, 'POST');
    assert(limitsBody.includes('jData='));
    assert.strictEqual(limitsRes.availableCash, 150250.5);
    assert.strictEqual(limitsRes.utilizedMargin, 24500);
    assert.strictEqual(limitsRes.collateralMargin, 50000);

    // Verify getLimits recovers from "bridge API error out" on ALL/ALL/ALL by retrying / falling back to NSE segment
    const kotakFast = new KotakNeoClient({
      consumerKey: 'ck',
      mobileNumber: '9999999999',
      ucc: 'U1',
      retryDelayMs: 0
    });
    kotakFast.isAuthenticated = true;
    kotakFast.sessionToken = 'st';
    kotakFast.sid = 'sid';
    const seenPayloads = [];
    global.fetch = async (_url, opts) => {
      const parsedBody = new URLSearchParams(opts.body).get('jData');
      seenPayloads.push(JSON.parse(parsedBody));
      if (parsedBody.includes('"exch":"ALL"')) {
        return {
          ok: false,
          status: 424,
          statusText: 'Failed Dependency',
          text: async () => JSON.stringify({ stCode: 300015, message: 'bridge API error out' })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ Net: '90000', MarginUsed: '10000' })
      };
    };
    const fallbackLimits = await kotakFast.getLimits();
    assert.strictEqual(fallbackLimits.availableCash, 90000);
    assert.strictEqual(fallbackLimits.utilizedMargin, 10000);
    assert(seenPayloads.some(p => p.exch === 'NSE'), 'Expected getLimits to fall back to NSE segment after bridge error');

    // Verify persistent bridge error marks err.isBridgeError and KotakNeoBroker cools down repeated getFunds calls
    global.fetch = async () => ({
      ok: false,
      status: 424,
      statusText: 'Failed Dependency',
      text: async () => JSON.stringify({ message: 'bridge API error out' })
    });
    await assert.rejects(
      () => kotakFast.getLimits(),
      err => err.message === 'bridge API error out' && err.isBridgeError === true
    );

    const cooldownBroker = new KotakNeoBroker({
      id: 'kotak-bridge-cooldown',
      isMock: false,
      bridgeErrorCooldownMs: 60000
    });
    let getLimitsAttempts = 0;
    cooldownBroker.client.isAuthenticated = true;
    cooldownBroker.client.getLimits = async () => {
      getLimitsAttempts++;
      const err = new Error('bridge API error out');
      err.isBridgeError = true;
      throw err;
    };
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      await cooldownBroker.getFunds();
      await cooldownBroker.getFunds();
      await cooldownBroker.getFunds();
      assert.strictEqual(getLimitsAttempts, 1, 'Non-force getFunds should respect bridge error cooldown instead of spamming API');
      await cooldownBroker.getFunds({ force: true });
      assert.strictEqual(getLimitsAttempts, 2, 'Force getFunds should bypass cooldown');
    } finally {
      console.warn = origWarn;
    }

    // Array / stat: Not_Ok error format
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ stat: 'Not_Ok', emsg: 'Invalid MPIN' })
    });
    await assert.rejects(
      () => kotakLegacy.validateMpin('000000', 'UCC1', 'vt'),
      err => err.message === 'Invalid MPIN'
    );

    // Verify JWT "Token used before issued" clock skew retries cleanly during login validation
    const kotakJwt = new KotakNeoClient({
      consumerKey: 'ck',
      mobileNumber: '9999999999',
      ucc: 'UCC1',
      jwtSkewRetryDelayMs: 0
    });
    kotakJwt.sessionToken = 'stale-session-token';
    kotakJwt.sid = 'stale-sid';
    let totpReqHeaders = null;
    global.fetch = async (_url, opts) => {
      totpReqHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { token: 'fresh-view-token', sid: 'fresh-sid' } })
      };
    };
    await kotakJwt.loginWithTotp('9999999999', 'UCC1', '123456');
    assert.strictEqual(totpReqHeaders['Auth'], undefined, 'loginWithTotp must not send stale session Auth header');
    assert.strictEqual(totpReqHeaders['Sid'], undefined, 'loginWithTotp must not send stale session Sid header');

    let mpinAttempts = 0;
    global.fetch = async () => {
      mpinAttempts++;
      if (mpinAttempts < 3) {
        return {
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => JSON.stringify({ message: 'error in parsing jwt Token used before issued' })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { token: 'final-session-token', sid: 'final-sid', baseUrl: 'https://e21.kotaksecurities.com' } })
      };
    };
    const mpinOk = await kotakJwt.validateMpin('1234', 'UCC1', 'fresh-view-token');
    assert.strictEqual(mpinOk.success, true);
    assert.strictEqual(mpinAttempts, 3, 'validateMpin should retry transient JWT "Token used before issued" errors');

    global.fetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ message: 'error in parsing jwt Token used before issued' })
    });
    await assert.rejects(
      () => kotakJwt.validateMpin('1234', 'UCC1', 'fresh-view-token'),
      /sync system NTP/
    );

    global.fetch = async () => {
      const err = new TypeError('fetch failed');
      err.cause = new Error('getaddrinfo ENOTFOUND example.invalid');
      throw err;
    };
    await assert.rejects(
      () => kotakLegacy.loginWithTotp('+919999999999', 'UCC1', '123456'),
      /ENOTFOUND/
    );
    console.log('   ✅ KotakNeoClient normalizes mobile, extracts nested errors cleanly (no [object Object]), and surfaces network causes.');
  } finally {
    global.fetch = origFetchKotak;
  }

  // 3. Server HTTP & SSE integration tests
  const testPort = 3456;
  const serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(testPort) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server failed to start in time')), 6000);
      serverProc.stdout.on('data', d => {
        if (d.toString().includes(`http://localhost:${testPort}`)) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProc.stderr.on('data', d => {
        const msg = d.toString();
        if (msg.trim()) console.error('[server stderr]', msg);
      });
    });

    const homeRes = await httpRequest(testPort, '/');
    assert.strictEqual(homeRes.status, 200);
    assert(homeRes.body.includes('topNiftyLtp'));
    assert(homeRes.body.includes('/option-chain'));
    assert(homeRes.body.includes('/chart'));
    assert(homeRes.body.includes('min="65" step="65"'), 'Order quantity input must set min="65" and step="65" so multiples like 325 pass validation');
    assert(homeRes.body.includes('atmCeBtn') && homeRes.body.includes('atmPeBtn'), 'Dashboard must expose ATM CE / ATM PE default selector');
    assert(homeRes.body.includes('orderTriggerPrice'), 'Dashboard must expose SL Trigger Price input');
    assert(homeRes.body.includes('topContractLtp') && homeRes.body.includes('orderBannerLtp'), 'Dashboard must show current price at top of window and order panel');
    assert(homeRes.body.includes('orderStrikeSelect') && homeRes.body.includes('orderResetAtmBtn'), 'Dashboard must expose Strike Price selector for Call/Put');
    assert(homeRes.body.includes('quickCapitalDeployPct') && homeRes.body.includes('quickMaxOrders') && homeRes.body.includes('quickRoutingMode') && homeRes.body.includes('orderRoutingMode'), 'Dashboard must expose Capital Deploy %, Max Orders/Day, and Order Routing controls on top');
    assert(homeRes.body.includes('fetchPortfolioBtn') && homeRes.body.includes('portfolioFetchStatusBadge') && homeRes.body.includes('holdingsTableBody') && homeRes.body.includes('refreshHoldingsBtn'), 'Dashboard must expose Fetch Pos/Funds/Hold/Orders button and Holdings table');
    assert(homeRes.body.includes('openChargeSettingsBtn') && homeRes.body.includes('chargeSettingsModal') && homeRes.body.includes('chgSttPct') && homeRes.body.includes('chgGstPct'), 'Dashboard must expose Charges button and popup settings modal');
    assert(homeRes.body.includes('quickRiskAccountSelect') && homeRes.body.includes('addPaperAccountBtn') && homeRes.body.includes('paperFields') && homeRes.body.includes('accTargetNetPct'), 'Dashboard must expose per-account SL/Target selector and Paper Trading account controls');
    assert(!homeRes.body.includes('mcx_fo') && !homeRes.body.includes('value="CNC"') && !homeRes.body.includes('customBrokerageFields'), 'Dashboard must be Options-only without Futures/MCX/Delivery options');
    assert(homeRes.body.includes('positionFilterGroup') && homeRes.body.includes('data-pos-filter="per_trade"') && homeRes.body.includes('perTradeTableContainer'), 'Dashboard must expose Net Position & Per Trade filters and table');
    assert(homeRes.body.includes('orderStatusFilterGroup') && homeRes.body.includes('data-order-filter="completed"') && homeRes.body.includes('data-order-filter="rejected"') && homeRes.body.includes('data-order-filter="cancelled"'), 'Dashboard must expose Order filters for All/Completed/Open/Rejected/Cancelled');
    assert(homeRes.body.includes('order-confirm.js'), 'Dashboard must load order-confirm.js');
    const confirmJsRes = await httpRequest(testPort, '/order-confirm.js');
    assert.strictEqual(confirmJsRes.status, 200);
    assert(confirmJsRes.body.includes('playOrderBellSound') && confirmJsRes.body.includes('confirmOrderBeforeSend') && confirmJsRes.body.includes('attachOrderConfirmationStream'), 'order-confirm.js must expose bell sound, confirmation modal, and SSE listener');
    const pendingRes = await httpRequest(testPort, '/api/pending-orders');
    assert.strictEqual(pendingRes.status, 200);
    assert.strictEqual(pendingRes.body ? JSON.parse(pendingRes.body).success : false, true);
    const appJsRes = await httpRequest(testPort, '/app.js');
    assert.strictEqual(appJsRes.status, 200);
    assert(appJsRes.body.includes('brokerSelectSignature') && appJsRes.body.includes('algo_selected_order_broker'), 'updateBrokerSelect must preserve user-selected broker across SSE ticks');
    assert(appJsRes.body.includes('sizingSeq') && appJsRes.body.includes('Math.max(0, Number(d.data.quantity || 0))'), 'refreshOrderSizingFromBalance must guard stale async responses and update zero-qty cleanly');
    assert(appJsRes.body.includes('populateStrikeSelect') && appJsRes.body.includes('updateOrderCurrentPriceDisplay'), 'app.js must populate strike selector and update top current price display');
    assert(appJsRes.body.includes('if (userChanged || ot === \'MKT\')'), 'Live ticks must NOT overwrite Limit or SL Limit/Trigger price textboxes');
    assert(appJsRes.body.includes('riskSettingsInitialized') && appJsRes.body.includes('algo_order_routing_mode'), 'app.js must preserve Execution Target dropdown across SSE ticks');
    assert(appJsRes.body.includes('chargeSettingsForm') && appJsRes.body.includes('updateQuickRiskAccountSelect') && appJsRes.body.includes('reset-paper-btn'), 'app.js must wire Charge Settings modal, per-account SL/Target select, and Paper reset');
    assert(appJsRes.body.includes('renderPerTradeTable') && appJsRes.body.includes('getOrderFilterCategory'), 'app.js must wire Per Trade rendering and Order status filters');
    const ocJsRes = await httpRequest(testPort, '/option-chain.js');
    assert.strictEqual(ocJsRes.status, 200);
    assert(ocJsRes.body.includes('algo_selected_order_broker') && ocJsRes.body.includes('sizingSeq'), 'option-chain.js must preserve broker selection and guard async sizing');
    console.log('   ✅ GET / serves terminal with live top NIFTY ticker, Option Chain, and Chart links.');

    const ocRes = await httpRequest(testPort, '/option-chain');
    assert.strictEqual(ocRes.status, 200);
    assert(ocRes.body.includes('optionChainTable'));
    assert(ocRes.body.includes('<th>OI Built Up</th>'));
    assert(ocRes.body.includes('NIFTY Lot = 65'), 'Option chain modal must default to NIFTY lot size 65');
    assert(ocRes.body.includes('ocOrdTriggerPrice') && ocRes.body.includes('value="SL"'), 'Option chain modal must expose SL Trigger Price & Limit Price controls');
    assert(ocRes.body.includes('ocOrdRoutingMode') && ocRes.body.includes('ocDayCapHint'), 'Option chain modal must expose order routing mode & day settings summary');
    assert(!ocRes.body.includes('<th>Side</th>'));
    console.log('   ✅ GET /option-chain serves live-only Option Chain page with OI Built Up & NIFTY Lot = 65.');

    const chartPageRes = await httpRequest(testPort, '/chart');
    assert.strictEqual(chartPageRes.status, 200);
    assert(chartPageRes.body.includes('chartContainer'));
    assert(chartPageRes.body.includes('toggleSessions'));
    assert(chartPageRes.body.includes('toggleHaSr'));
    assert(chartPageRes.body.includes('togglePdhPdl'));
    assert(chartPageRes.body.includes('togglePivots'));
    assert(chartPageRes.body.includes('data-tf="5m_ha"'));
    assert(chartPageRes.body.includes('data-tf="15m_ha"'));
    assert(chartPageRes.body.includes('data-tf="1h_ha"'));
    assert(chartPageRes.body.includes('openChartOrderBtn') && chartPageRes.body.includes('chartOrderModal'), 'Chart page must expose Place Order button & modal');
    assert(chartPageRes.body.includes('candleCountdownDisplay') && chartPageRes.body.includes('candleBarCountdown'), 'Chart page must show candle countdown');
    const chartJsRes = await httpRequest(testPort, '/chart.js');
    assert.strictEqual(chartJsRes.status, 200);
    assert(chartJsRes.body.includes('updateCandleCountdown') && chartJsRes.body.includes('updateLivePriceLineWithCountdown') && chartJsRes.body.includes('recalcChartOrderQty'), 'chart.js must implement candle countdown on price line and quick order modal');
    console.log('   ✅ GET /chart serves live NIFTY chart page with Session Line, 5m/15m/1h HA S/R, Pivots, and PDH/PDL.');

    const chartApiRes = await httpRequest(testPort, '/api/nifty-chart');
    assert.strictEqual(chartApiRes.status, 200);
    const chartApiJson = JSON.parse(chartApiRes.body);
    assert.strictEqual(chartApiJson.success, true);
    assert.strictEqual(chartApiJson.timeframe, '3m');
    assert(Array.isArray(chartApiJson.candles));
    assert(chartApiJson.analysis && chartApiJson.analysis.timeframes && chartApiJson.analysis.timeframes['5m'], 'Expected analysis payload with 5m/15m/1h HA');
    console.log(`   ✅ GET /api/nifty-chart returned 3m chart state (${chartApiJson.count} stored candles).`);

    const apiRes = await httpRequest(testPort, '/api/nifty-feed');
    assert.strictEqual(apiRes.status, 200);
    const apiJson = JSON.parse(apiRes.body);
    assert.strictEqual(apiJson.success, true);
    assert(apiJson.data.feedState.sourceMode !== 'simulated', 'Mock/simulated feed must be completely removed');
    console.log(`   ✅ GET /api/nifty-feed confirmed live-only sourceMode=${apiJson.data.feedState.sourceMode}.`);

    const stopRes = await httpRequest(testPort, '/api/nifty-feed/stop', 'POST', {});
    assert.strictEqual(JSON.parse(stopRes.body).data.feedState.isRunning, false);

    const startRes = await httpRequest(testPort, '/api/nifty-feed/start', 'POST', {});
    assert.strictEqual(JSON.parse(startRes.body).data.feedState.isRunning, true);

    const testCredsRes = await httpRequest(testPort, '/api/accounts/test-credentials', 'POST', {
      broker: 'kotakneo',
      consumerKey: 'k',
      mobileNumber: '9876543210',
      ucc: 'U1',
      mpin: '123456'
    });
    const testCredsJson = JSON.parse(testCredsRes.body);
    assert.strictEqual(testCredsRes.status, 200);
    assert.strictEqual(typeof testCredsJson.message, 'string');
    assert(!testCredsJson.message.includes('[object Object]'));

    const testSahiCredsRes = await httpRequest(testPort, '/api/accounts/test-credentials', 'POST', {
      broker: 'sahi',
      keyId: 'pk_test',
      secret: 'sahi_sk_test'
    });
    const testSahiCredsJson = JSON.parse(testSahiCredsRes.body);
    assert.strictEqual(testSahiCredsRes.status, 200);
    assert.strictEqual(typeof testSahiCredsJson.message, 'string');

    const scripStatusRes = await httpRequest(testPort, '/api/scrip-master/status');
    assert.strictEqual(scripStatusRes.status, 200);
    assert.strictEqual(JSON.parse(scripStatusRes.body).data.scheduledTimeIST, '08:55 IST');

    const scripLookupRes = await httpRequest(testPort, '/api/scrip-master/lookup?symbol=NIFTY27OCT26C25000&segment=NFO');
    assert.strictEqual(scripLookupRes.status, 200);
    const scripLookupData = JSON.parse(scripLookupRes.body).data;
    assert.strictEqual(scripLookupData.lotSize, 65);
    assert(scripLookupData.freezeQty >= 1755);

    const calcQtyRes = await httpRequest(testPort, '/api/orders/calculate-quantity', 'POST', {
      tradingSymbol: 'NIFTY27OCT26C25000',
      exchangeSegment: 'NFO',
      orderType: 'L',
      transactionType: 'B',
      price: 150
    });
    assert.strictEqual(calcQtyRes.status, 200);
    const calcQtyData = JSON.parse(calcQtyRes.body).data;
    assert.strictEqual(calcQtyData.lotSize, 65);
    assert(calcQtyData.freezeQty >= 1755);
    assert.strictEqual(calcQtyData.orderType, 'L');
    assert.strictEqual(calcQtyData.orderPrice, 150);

    const calcSlHttpRes = await httpRequest(testPort, '/api/orders/calculate-quantity', 'POST', {
      tradingSymbol: 'NIFTY27OCT26C25000',
      exchangeSegment: 'NFO',
      orderType: 'SL',
      transactionType: 'B',
      triggerPrice: 140
    });
    assert.strictEqual(calcSlHttpRes.status, 200);
    const calcSlHttpData = JSON.parse(calcSlHttpRes.body).data;
    assert.strictEqual(calcSlHttpData.orderType, 'SL');
    assert.strictEqual(calcSlHttpData.triggerPrice, 140);
    assert.strictEqual(calcSlHttpData.orderPrice, 140.5);

    const calcMktHttpRes = await httpRequest(testPort, '/api/orders/calculate-quantity', 'POST', {
      tradingSymbol: 'NIFTY27OCT26C25000',
      exchangeSegment: 'NFO',
      orderType: 'MKT',
      transactionType: 'B',
      ltp: 120
    });
    assert.strictEqual(calcMktHttpRes.status, 200);
    const calcMktHttpData = JSON.parse(calcMktHttpRes.body).data;
    assert.strictEqual(calcMktHttpData.orderType, 'MKT');
    assert.strictEqual(calcMktHttpData.price, 120);

    const statusRes = await httpRequest(testPort, '/api/status');
    assert.strictEqual(statusRes.status, 200);
    const statusData = JSON.parse(statusRes.body);
    assert(statusData.riskSettings && statusData.dailyOrders && statusData.portfolioSchedule && statusData.chargeSettings, 'GET /api/status must expose riskSettings, dailyOrders, portfolioSchedule, and chargeSettings');

    // Verify GET & POST /api/charge-settings (then restore original settings)
    const getChgRes = await httpRequest(testPort, '/api/charge-settings');
    assert.strictEqual(getChgRes.status, 200);
    const origCharges = JSON.parse(getChgRes.body).chargeSettings;
    assert.strictEqual(origCharges.sttPct, 0.15);
    assert.strictEqual(origCharges.exchangeTxnPct, 0.03553);
    assert.strictEqual(origCharges.sebiPerCrore, 10);
    assert.strictEqual(origCharges.ipftPerCrore, 0.01);
    assert.strictEqual(origCharges.stampDutyBuyPct, 0.003);
    assert.strictEqual(origCharges.gstPct, 18);

    const updChgRes = await httpRequest(testPort, '/api/charge-settings', 'POST', { sttPct: 0.16 });
    assert.strictEqual(updChgRes.status, 200);
    assert.strictEqual(JSON.parse(updChgRes.body).chargeSettings.sttPct, 0.16);
    await httpRequest(testPort, '/api/charge-settings', 'POST', origCharges);

    // Verify Paper Account test-credentials + create + per-account risk-settings + paper-reset + cleanup delete
    const paperTestRes = await httpRequest(testPort, '/api/accounts/test-credentials', 'POST', { broker: 'paper', name: 'Paper Check', initialBalance: 300000 });
    assert.strictEqual(paperTestRes.status, 200);
    assert.strictEqual(JSON.parse(paperTestRes.body).success, true);

    const createPaperRes = await httpRequest(testPort, '/api/accounts', 'POST', {
      broker: 'paper',
      name: 'HTTP Test Paper Account',
      initialBalance: 400000,
      brokerageType: 'zero',
      brokeragePerOrder: 0,
      targetNetProfitPct: 2.5,
      stopLossNetPct: 1.25
    });
    assert.strictEqual(createPaperRes.status, 200);
    const createdPaper = JSON.parse(createPaperRes.body).data;
    assert(createdPaper && createdPaper.id);

    const accRiskRes = await httpRequest(testPort, `/api/accounts/${createdPaper.id}/risk-settings`, 'POST', {
      targetNetProfitPct: 3.2,
      stopLossNetPct: 0.8,
      nearThresholdBufferPct: 97
    });
    assert.strictEqual(accRiskRes.status, 200);
    const accRiskJson = JSON.parse(accRiskRes.body);
    assert.strictEqual(accRiskJson.accountRisk.targetNetProfitPct, 3.2);
    assert.strictEqual(accRiskJson.accountRisk.stopLossNetPct, 0.8);

    const paperResetRes = await httpRequest(testPort, `/api/accounts/${createdPaper.id}/paper-reset`, 'POST', { initialBalance: 250000 });
    assert.strictEqual(paperResetRes.status, 200);
    assert.strictEqual(JSON.parse(paperResetRes.body).funds.availableCash, 250000);

    const delPaperRes = await httpRequest(testPort, `/api/accounts/${createdPaper.id}`, 'DELETE');
    assert.strictEqual(delPaperRes.status, 200);
    console.log('   ✅ /api/charge-settings, per-account SL/Target API, and Paper Trading account HTTP lifecycle verified.');

    const manualFetchHttpRes = await httpRequest(testPort, '/api/portfolio/fetch', 'POST', {});
    assert.strictEqual(manualFetchHttpRes.status, 200);
    const manualFetchHttpData = JSON.parse(manualFetchHttpRes.body);
    assert.strictEqual(manualFetchHttpData.success, true);
    assert(Array.isArray(manualFetchHttpData.positions) && Array.isArray(manualFetchHttpData.holdings) && Array.isArray(manualFetchHttpData.orders) && manualFetchHttpData.funds);

    const calcAllHttpRes = await httpRequest(testPort, '/api/orders/calculate-quantity', 'POST', {
      tradingSymbol: 'NIFTY27OCT26C25000',
      exchangeSegment: 'NFO',
      orderType: 'MKT',
      transactionType: 'B',
      routingMode: 'all_funded',
      allocationPct: 50,
      ltp: 120
    });
    assert.strictEqual(calcAllHttpRes.status, 200);
    const calcAllHttpData = JSON.parse(calcAllHttpRes.body).data;
    assert.strictEqual(calcAllHttpData.routingMode, 'all_funded');
    assert.strictEqual(calcAllHttpData.capitalDeployPct, 50);
    assert(Array.isArray(calcAllHttpData.eligibleBrokers) && Array.isArray(calcAllHttpData.skippedBrokers));
    console.log('   ✅ /api/scrip-master/* and /api/orders/calculate-quantity endpoints verified.');

    const sse = await readSSEEvents(testPort, 2200);
    assert.strictEqual(sse.status, 200);
    assert(sse.raw.includes('event: connected'));
    assert(sse.raw.includes('event: nifty_tick'));
    console.log('   ✅ GET /api/stream broadcasts live nifty_tick updates over SSE.');
  } finally {
    http.globalAgent.destroy();
    serverProc.kill('SIGKILL');
  }

  console.log('\n🎉 ALL LIVE-ONLY NIFTY FEED & OPTION CHAIN TESTS PASSED!\n');
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
