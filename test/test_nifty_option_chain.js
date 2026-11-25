const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const { NiftyFeedManager, computeAtmStrike, computeOiBuildup } = require('../lib/niftyFeedManager');
const AngelOneBroker = require('../lib/brokers/angelOneBroker');
const KotakNeoBroker = require('../lib/brokers/kotakNeoBroker');
const DhanBroker = require('../lib/brokers/dhanBroker');
const { parseSmartStreamPacket } = require('../lib/angelOneWsClient');
const { parseKotakMarketMessage } = require('../lib/kotakNeoWsClient');
const { parseDhanFeedPacket } = require('../lib/dhanWsClient');
const KotakNeoClient = require('../lib/kotakNeoClient');
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
    console.log('   ✅ GET / serves terminal with live top NIFTY ticker & Option Chain link.');

    const ocRes = await httpRequest(testPort, '/option-chain');
    assert.strictEqual(ocRes.status, 200);
    assert(ocRes.body.includes('optionChainTable'));
    assert(ocRes.body.includes('<th>OI Built Up</th>'));
    assert(!ocRes.body.includes('<th>Side</th>'));
    console.log('   ✅ GET /option-chain serves live-only Option Chain page with OI Built Up column.');

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

    const sse = await readSSEEvents(testPort, 2200);
    assert.strictEqual(sse.status, 200);
    assert(sse.raw.includes('event: connected'));
    assert(sse.raw.includes('event: nifty_tick'));
    console.log('   ✅ GET /api/stream broadcasts live nifty_tick updates over SSE.');
  } finally {
    serverProc.kill();
  }

  console.log('\n🎉 ALL LIVE-ONLY NIFTY FEED & OPTION CHAIN TESTS PASSED!\n');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
