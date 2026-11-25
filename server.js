const http = require('http');
const fs = require('fs');
const path = require('path');

const MultiBrokerManager = require('./lib/multiBrokerManager');
const OpeningBalanceScheduler = require('./lib/openingBalanceScheduler');
const ChargesCalculator = require('./lib/chargesCalculator');
const AutoExitEngine = require('./lib/autoExitEngine');
const { NiftyFeedManager } = require('./lib/niftyFeedManager');
const configManager = require('./lib/configManager');
const totpHelper = require('./lib/totpHelper');

// Load Configuration
let currentConfig = configManager.loadConfig();

// Instantiate MultiBrokerManager
const multiBrokerManager = new MultiBrokerManager(configManager);

// Instantiate 9:00 AM Opening Balance Scheduler
const openingBalanceScheduler = new OpeningBalanceScheduler(multiBrokerManager);

// Instantiate Algo Auto-Exit Engine
const autoExitEngine = new AutoExitEngine(multiBrokerManager, openingBalanceScheduler, configManager);
autoExitEngine.start();

// Instantiate 9:00 AM NIFTY Spot & 10 ITM + ATM + 10 OTM Option Chain Feed Manager
const niftyFeedManager = new NiftyFeedManager(multiBrokerManager, configManager);


// Active SSE client connections
const sseClients = new Set();

function broadcastSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

autoExitEngine.on('log', logEntry => broadcastSSE('log', logEntry));
autoExitEngine.on('rule_updated', data => broadcastSSE('rule_updated', data));
autoExitEngine.on('position_exited', data => broadcastSSE('position_exited', data));
openingBalanceScheduler.on('balance_updated', data => broadcastSSE('opening_balance_updated', data));

niftyFeedManager.on('feed_started', info => {
  autoExitEngine.log(
    'INFO',
    `NIFTY Option Feed started (${info.autoStarted9AM ? '9:00 AM IST Auto-Start' : 'Manual Start'}) — ATM ${info.atmStrike} | ${info.totalStrikes} strikes (${info.totalContracts} CE/PE contracts)`
  );
  broadcastSSE('nifty_tick', niftyFeedManager.getSnapshot());
});

niftyFeedManager.on('feed_stopped', () => {
  autoExitEngine.log('INFO', 'NIFTY Option Chain feed paused.');
  broadcastSSE('nifty_tick', niftyFeedManager.getSnapshot());
});

niftyFeedManager.on('atm_recentered', info => {
  autoExitEngine.log('INFO', `NIFTY Option Chain recentered around ATM ${info.atmStrike}.`);
  broadcastSSE('nifty_tick', niftyFeedManager.getSnapshot());
});

niftyFeedManager.on('feed_subscribed', info => {
  autoExitEngine.log(
    'INFO',
    `Subscribed live NIFTY + ${info.totalStrikes} strike (${info.totalContracts} CE/PE) feed on ${(info.broker || '').toUpperCase()} (${info.accountName || info.accountId})`
  );
  broadcastSSE('feed_subscribed', info);
  broadcastSSE('nifty_tick', niftyFeedManager.getSnapshot());
});

niftyFeedManager.on('tick', snapshot => {
  if (sseClients.size > 0) {
    broadcastSSE('nifty_tick', snapshot);
  }
});

multiBrokerManager.on('order_update', evt => {
  autoExitEngine.log('INFO', `Order/trade update received on ${String(evt.broker || '').toUpperCase()} WebSocket — refreshing net positions & holdings.`);
});

// Background tick broadcaster: pushes enriched positions, charges, Net P&L, 9:00 AM balance
setInterval(async () => {
  if (sseClients.size === 0) return;

  try {
    const rawPositions = await multiBrokerManager.getAllPositions();
    const openBalData = openingBalanceScheduler.getOpeningBalanceData();
    const openingBalance = Number(openBalData.openingBalance || 500000);

    let totalGrossPnl = 0;
    let totalCharges = 0;
    let totalNetPnl = 0;

    const enrichedPositions = (rawPositions || []).map(pos => {
      const chargeInfo = ChargesCalculator.calculatePositionCharges(pos);
      totalGrossPnl += chargeInfo.grossPnl;
      totalCharges += chargeInfo.totalCharges;
      totalNetPnl += chargeInfo.netPnl;

      const netProfitPctOfCapital = openingBalance > 0
        ? Number(((chargeInfo.netPnl / openingBalance) * 100).toFixed(2))
        : 0;

      return {
        ...pos,
        chargeDetails: chargeInfo,
        grossPnl: chargeInfo.grossPnl,
        totalCharges: chargeInfo.totalCharges,
        netPnl: chargeInfo.netPnl,
        netProfitPctOfCapital
      };
    });

    const funds = await multiBrokerManager.getAllFunds();
    const overallNetProfitPct = openingBalance > 0
      ? Number(((totalNetPnl / openingBalance) * 100).toFixed(2))
      : 0;

    const payload = {
      timestamp: Date.now(),
      mode: currentConfig.mode,
      dataFeedSource: multiBrokerManager.getDataFeedSource(),
      openingBalance: openBalData,
      funds,
      totals: {
        totalGrossPnl: Number(totalGrossPnl.toFixed(2)),
        totalCharges: Number(totalCharges.toFixed(2)),
        totalNetPnl: Number(totalNetPnl.toFixed(2)),
        overallNetProfitPct,
        openPositionsCount: enrichedPositions.filter(p => p.isOpen && p.netQty !== 0).length
      },
      positions: enrichedPositions,
      accounts: multiBrokerManager.getAccounts(),
      rules: autoExitEngine.getAllPositionRules()
    };

    broadcastSSE('market_tick', payload);
  } catch (err) {}
}, 1200);

// Helper to parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2e6) {
        req.connection.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({ raw: body });
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, parsedUrl) {
  let pathname = parsedUrl.pathname;
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname === '/option-chain') pathname = '/option-chain.html';

  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, 'public', safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }
  const pathname = parsedUrl.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // SSE Stream
  if (pathname === '/api/stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('event: connected\ndata: {"status":"connected"}\n\n');
    res.write(`event: nifty_tick\ndata: ${JSON.stringify(niftyFeedManager.getSnapshot())}\n\n`);
    sseClients.add(res);

    req.on('close', () => sseClients.delete(res));
    return;
  }

  // REST API Routes
  if (pathname.startsWith('/api/')) {
    try {
      /* ============================================================
         1. ACCOUNTS MANAGEMENT (Angel One, Dhan, Kotak Neo)
         ============================================================ */
      if (pathname === '/api/accounts' && method === 'GET') {
        return sendJson(res, 200, {
          success: true,
          data: multiBrokerManager.getAccounts(),
          dataFeedSource: multiBrokerManager.getDataFeedSource()
        });
      }

      if (pathname === '/api/accounts' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.broker || !['kotakneo', 'angelone', 'dhan'].includes(body.broker)) {
          return sendJson(res, 400, { success: false, message: 'Valid broker (kotakneo, angelone, dhan) is required' });
        }
        const created = multiBrokerManager.addAccount(body);
        autoExitEngine.log('INFO', `Added broker account: ${created.name} (${created.broker})`);

        const loginSub = await multiBrokerManager.authenticateAndSubscribe(created.id, body.totp);
        let feedSnapshot = null;
        if (loginSub.authenticated && loginSub.subscribed) {
          feedSnapshot = await niftyFeedManager.subscribeOnBrokerLogin({
            accountId: created.id,
            broker: created.broker,
            accountName: created.name
          });
        }

        return sendJson(res, 200, {
          success: true,
          data: created,
          loginResult: loginSub,
          feedSubscribed: Boolean(loginSub.authenticated && loginSub.subscribed),
          dataFeedSource: multiBrokerManager.getDataFeedSource(),
          niftyFeed: feedSnapshot
        });
      }

      if (pathname === '/api/accounts/test-credentials' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.broker || !['kotakneo', 'angelone', 'dhan'].includes(body.broker)) {
          return sendJson(res, 400, { success: false, message: 'Valid broker (kotakneo, angelone, dhan) is required' });
        }
        const KotakNeoBroker = require('./lib/brokers/kotakNeoBroker');
        const AngelOneBroker = require('./lib/brokers/angelOneBroker');
        const DhanBroker = require('./lib/brokers/dhanBroker');
        const testCfg = { ...body, isMock: currentConfig.mode === 'mock' };
        let tempInst;
        if (body.broker === 'kotakneo') tempInst = new KotakNeoBroker(testCfg);
        else if (body.broker === 'angelone') tempInst = new AngelOneBroker(testCfg);
        else tempInst = new DhanBroker(testCfg);

        try {
          const resLogin = await tempInst.login(body.totp || null);
          return sendJson(res, 200, {
            success: Boolean(resLogin && resLogin.success),
            message: (resLogin && typeof resLogin.message === 'string' ? resLogin.message : 'Connected successfully')
          });
        } catch (err) {
          return sendJson(res, 200, {
            success: false,
            message: typeof err.message === 'string' ? err.message : JSON.stringify(err.message)
          });
        }
      }

      if (pathname.startsWith('/api/accounts/') && pathname.endsWith('/test') && method === 'POST') {
        const id = pathname.replace('/api/accounts/', '').replace('/test', '');
        const body = await parseBody(req);
        let result;
        try {
          result = await multiBrokerManager.testAccountLogin(id, body.totp);
        } catch (loginErr) {
          autoExitEngine.log('ERROR', `Account ${id} login failed: ${loginErr.message}`);
          return sendJson(res, 200, { success: false, message: loginErr.message });
        }
        autoExitEngine.log('INFO', `Account ${id} tested: ${result.message}`);

        let feedSnapshot = null;
        if (result.success) {
          feedSnapshot = await niftyFeedManager.subscribeOnBrokerLogin({
            accountId: id,
            broker: result.broker,
            accountName: result.accountName
          });
        }

        return sendJson(res, 200, {
          ...result,
          feedSubscribed: Boolean(result.success),
          niftyFeed: feedSnapshot
        });
      }

      if (pathname.startsWith('/api/accounts/') && method === 'PUT') {
        const id = pathname.replace('/api/accounts/', '');
        const body = await parseBody(req);
        const updated = multiBrokerManager.updateAccount(id, body);
        autoExitEngine.log('INFO', `Updated broker account: ${updated.name}`);

        const loginSub = await multiBrokerManager.authenticateAndSubscribe(id, body.totp);
        let feedSnapshot = null;
        if (loginSub.authenticated && loginSub.subscribed) {
          feedSnapshot = await niftyFeedManager.subscribeOnBrokerLogin({
            accountId: id,
            broker: updated.broker,
            accountName: updated.name
          });
        }

        return sendJson(res, 200, {
          success: true,
          data: updated,
          loginResult: loginSub,
          feedSubscribed: Boolean(loginSub.authenticated && loginSub.subscribed),
          niftyFeed: feedSnapshot
        });
      }

      if (pathname.startsWith('/api/accounts/') && method === 'DELETE') {
        const id = pathname.replace('/api/accounts/', '');
        multiBrokerManager.deleteAccount(id);
        autoExitEngine.log('INFO', `Deleted broker account: ${id}`);
        return sendJson(res, 200, { success: true, message: 'Account deleted' });
      }

      /* ============================================================
         2. DATA FEED SUBSCRIPTION SOURCE (Angel One / Kotak Neo)
         ============================================================ */
      if (pathname === '/api/datafeed' && method === 'GET') {
        return sendJson(res, 200, {
          success: true,
          dataFeedSource: multiBrokerManager.getDataFeedSource()
        });
      }

      if (pathname === '/api/datafeed' && method === 'POST') {
        const body = await parseBody(req);
        const result = multiBrokerManager.setDataFeedSource(body.source);
        autoExitEngine.log('INFO', `Market data feed subscription switched to: ${body.source.toUpperCase()}`);
        return sendJson(res, 200, result);
      }

      /* ============================================================
         3. 9:00 AM OPENING BALANCE & FUNDS
         ============================================================ */
      if (pathname === '/api/opening-balance' && method === 'GET') {
        return sendJson(res, 200, {
          success: true,
          data: openingBalanceScheduler.getOpeningBalanceData()
        });
      }

      if (pathname === '/api/opening-balance/sync' && method === 'POST') {
        const result = await openingBalanceScheduler.captureOpeningBalance(false);
        autoExitEngine.log('INFO', `Synced opening balance across brokers: ₹${result.openingBalance.toLocaleString('en-IN')}`);
        return sendJson(res, 200, { success: true, data: result });
      }

      if (pathname === '/api/opening-balance/override' && method === 'POST') {
        const body = await parseBody(req);
        const result = openingBalanceScheduler.setOpeningBalance(body.amount);
        autoExitEngine.log('INFO', `Manually updated 9:00 AM opening balance to: ₹${Number(body.amount).toLocaleString('en-IN')}`);
        return sendJson(res, 200, { success: true, data: result });
      }

      if (pathname === '/api/funds' && method === 'GET') {
        const force = parsedUrl.searchParams.get('force') === '1';
        const funds = await multiBrokerManager.getAllFunds({ force });
        return sendJson(res, 200, { success: true, data: funds });
      }

      /* ============================================================
         4. POSITIONS & CHARGES BREAKDOWN
         ============================================================ */
      if (pathname === '/api/positions' && method === 'GET') {
        const force = parsedUrl.searchParams.get('force') === '1';
        const rawPositions = await multiBrokerManager.getAllPositions({ force });
        const openBalData = openingBalanceScheduler.getOpeningBalanceData();
        const openingBalance = Number(openBalData.openingBalance || 500000);

        const enrichedPositions = (rawPositions || []).map(pos => {
          const chargeInfo = ChargesCalculator.calculatePositionCharges(pos);
          const netProfitPctOfCapital = openingBalance > 0
            ? Number(((chargeInfo.netPnl / openingBalance) * 100).toFixed(2))
            : 0;

          return {
            ...pos,
            chargeDetails: chargeInfo,
            grossPnl: chargeInfo.grossPnl,
            totalCharges: chargeInfo.totalCharges,
            netPnl: chargeInfo.netPnl,
            netProfitPctOfCapital
          };
        });

        return sendJson(res, 200, { success: true, data: enrichedPositions });
      }

      if (pathname === '/api/holdings' && method === 'GET') {
        const force = parsedUrl.searchParams.get('force') === '1';
        const holdings = await multiBrokerManager.getAllHoldings({ force });
        return sendJson(res, 200, { success: true, data: holdings });
      }

      /* ============================================================
         5. ORDERS & TRADE EXECUTION
         ============================================================ */
      if (pathname === '/api/orders' && method === 'GET') {
        const force = parsedUrl.searchParams.get('force') === '1';
        const orders = await multiBrokerManager.getAllOrders({ force });
        return sendJson(res, 200, { success: true, data: orders });
      }

      if (pathname === '/api/orders' && method === 'POST') {
        const orderData = await parseBody(req);
        const result = await multiBrokerManager.exitPosition({
          accountId: orderData.accountId,
          broker: orderData.broker || 'kotakneo',
          symbol: orderData.tradingSymbol,
          exchangeSegment: orderData.exchangeSegment,
          product: orderData.product,
          netQty: orderData.transactionType === 'B' ? -Number(orderData.quantity) : Number(orderData.quantity)
        });
        autoExitEngine.log('INFO', `Order placed on broker: ${orderData.transactionType} ${orderData.tradingSymbol} x ${orderData.quantity}`, result);
        return sendJson(res, 200, result);
      }

      /* ============================================================
         6. AUTO-EXIT ENGINE & NET PROFIT % RULES
         ============================================================ */
      if (pathname === '/api/autoexit/rules' && method === 'GET') {
        return sendJson(res, 200, { success: true, data: autoExitEngine.getAllPositionRules() });
      }

      if (pathname === '/api/autoexit/rules' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.symbol) {
          return sendJson(res, 400, { success: false, message: 'symbol is required' });
        }
        const updated = autoExitEngine.setPositionRule(body.accountId, body.symbol, body.product || 'MIS', body);
        return sendJson(res, 200, { success: true, data: updated });
      }

      if (pathname === '/api/autoexit/rules' && method === 'DELETE') {
        const body = await parseBody(req);
        autoExitEngine.removePositionRule(body.accountId, body.symbol, body.product || 'MIS');
        return sendJson(res, 200, { success: true, message: 'Rule removed' });
      }

      if (pathname === '/api/autoexit/exit-position' && method === 'POST') {
        const body = await parseBody(req);
        const positions = await multiBrokerManager.getAllPositions();
        const pos = positions.find(p => p.symbol === body.symbol && (p.accountId === body.accountId || !body.accountId));
        if (!pos) {
          return sendJson(res, 404, { success: false, message: 'Position not found' });
        }
        const result = await autoExitEngine.exitPosition(pos, body.reason || 'Manual Web Exit');
        return sendJson(res, 200, { success: true, data: result });
      }

      if (pathname === '/api/autoexit/exit-all' && method === 'POST') {
        const body = await parseBody(req);
        const result = await autoExitEngine.exitAllPositions(body.reason || 'Panic Exit All Across Brokers');
        return sendJson(res, 200, { success: true, data: result });
      }

      if (pathname === '/api/autoexit/toggle' && method === 'POST') {
        const body = await parseBody(req);
        if (body.enabled) autoExitEngine.start();
        else autoExitEngine.stop();
        return sendJson(res, 200, { success: true, isRunning: autoExitEngine.isRunning });
      }

      if (pathname === '/api/autoexit/logs' && method === 'GET') {
        return sendJson(res, 200, { success: true, data: autoExitEngine.getAuditLogs() });
      }

      /* ============================================================
         7. NIFTY SPOT & 9:00 AM OPTION CHAIN FEED
         ============================================================ */
      if (pathname === '/api/nifty-feed' && method === 'GET') {
        return sendJson(res, 200, {
          success: true,
          data: niftyFeedManager.getSnapshot()
        });
      }

      if (pathname === '/api/nifty-feed/start' && method === 'POST') {
        const body = await parseBody(req);
        const snapshot = niftyFeedManager.startFeed({
          isAuto9AM: false,
          recenter: body.recenter !== false
        });
        return sendJson(res, 200, { success: true, data: snapshot });
      }

      if (pathname === '/api/nifty-feed/stop' && method === 'POST') {
        const snapshot = niftyFeedManager.stopFeed();
        return sendJson(res, 200, { success: true, data: snapshot });
      }

      if (pathname === '/api/nifty-feed/recenter' && method === 'POST') {
        const snapshot = niftyFeedManager.recenterAtm();
        return sendJson(res, 200, { success: true, data: snapshot });
      }

      /* ============================================================
         8. CONFIG & MODE
         ============================================================ */
      if (pathname === '/api/status' && method === 'GET') {
        const openBal = openingBalanceScheduler.getOpeningBalanceData();
        return sendJson(res, 200, {
          success: true,
          mode: currentConfig.mode,
          dataFeedSource: multiBrokerManager.getDataFeedSource(),
          openingBalance: openBal,
          accounts: multiBrokerManager.getAccounts(),
          riskSettings: currentConfig.riskSettings,
          autoExitRunning: autoExitEngine.isRunning
        });
      }

      if (pathname === '/api/mode' && method === 'POST') {
        const body = await parseBody(req);
        currentConfig.mode = body.mode;
        configManager.saveConfig({ mode: body.mode });
        multiBrokerManager.reloadBrokers();
        autoExitEngine.log('INFO', `Switched trading mode to: ${body.mode.toUpperCase()}`);
        const snapshot = await niftyFeedManager._tick();
        return sendJson(res, 200, { success: true, mode: currentConfig.mode, niftyFeed: snapshot });
      }

      if (pathname === '/api/risk-settings' && method === 'POST') {
        const body = await parseBody(req);
        currentConfig = configManager.saveConfig({ riskSettings: body });
        autoExitEngine.log('INFO', `Updated risk limits: Target Net Profit ${body.targetDailyNetProfitPct}%, Max Net Loss ${body.maxDailyLossNetPct}%`);
        return sendJson(res, 200, { success: true, riskSettings: currentConfig.riskSettings });
      }

      return sendJson(res, 404, { success: false, message: 'Endpoint not found' });
    } catch (err) {
      console.error('API Error:', err);
      return sendJson(res, 500, { success: false, message: err.message });
    }
  }

  // Fallback: Static Files
  serveStatic(req, res, parsedUrl);
});

const PORT = process.env.PORT || currentConfig.port || 3000;
server.listen(PORT, () => {
  console.log(`=====================================================`);
  console.log(`  Multi-Broker Algo Auto-Exit Terminal Running!`);
  console.log(`  Brokers Supported: Kotak Neo, Angel One, Dhan`);
  console.log(`  9:00 AM Balance Scheduler: ACTIVE`);
  console.log(`  Charges & Net Profit % Engine: ACTIVE`);
  console.log(`  Local URL: http://localhost:${PORT}`);
  console.log(`=====================================================`);
});
