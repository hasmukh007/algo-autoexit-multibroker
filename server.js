const http = require('http');
const fs = require('fs');
const path = require('path');

const MultiBrokerManager = require('./lib/multiBrokerManager');
const OpeningBalanceScheduler = require('./lib/openingBalanceScheduler');
const ChargesCalculator = require('./lib/chargesCalculator');
const AutoExitEngine = require('./lib/autoExitEngine');
const { NiftyFeedManager } = require('./lib/niftyFeedManager');
const { NiftyCandleManager } = require('./lib/niftyCandleManager');
const AutoLoginScheduler = require('./lib/autoLoginScheduler');
const { ScripMasterManager } = require('./lib/scripMasterManager');
const configManager = require('./lib/configManager');
const totpHelper = require('./lib/totpHelper');

// Load Configuration
let currentConfig = configManager.loadConfig();

// Instantiate MultiBrokerManager
const multiBrokerManager = new MultiBrokerManager(configManager);

// Instantiate 9:00 AM Opening Balance Scheduler
const openingBalanceScheduler = new OpeningBalanceScheduler(multiBrokerManager);
multiBrokerManager.setOpeningBalanceProvider(() => openingBalanceScheduler.getOpeningBalanceData());

// Instantiate Algo Auto-Exit Engine
const autoExitEngine = new AutoExitEngine(multiBrokerManager, openingBalanceScheduler, configManager);
multiBrokerManager.setDailyRiskGuardProvider(accountId => autoExitEngine.getDailyRiskGuardStatus(accountId));
autoExitEngine.start();

// Instantiate 9:00 AM NIFTY Spot & 10 ITM + ATM + 10 OTM Option Chain Feed Manager
const niftyFeedManager = new NiftyFeedManager(multiBrokerManager, configManager);

// Instantiate NIFTY 3-Minute Candle Store (SQLite + WebSocket live aggregation + 3-day REST backfill)
const niftyCandleManager = new NiftyCandleManager(multiBrokerManager);

// Instantiate 8:55 AM IST Scrip Master Downloader (loads lotSize & freezeQty daily)
const scripMasterManager = new ScripMasterManager();
multiBrokerManager.setScripMasterManager(scripMasterManager);

// Instantiate 8:59 AM IST Auto-Login Scheduler for all brokers
const autoLoginScheduler = new AutoLoginScheduler(multiBrokerManager);


// Active SSE client connections
const sseClients = new Set();

// Pending auto-order confirmations (ask confirmation + play bell on page before sending to broker)
const pendingConfirmOrders = new Map();
const dismissedConfirmKeys = new Set();

autoExitEngine.setOrderExecutorGate(async ({ dedupeKey, summary, executeFn }) => {
  if (dismissedConfirmKeys.has(dedupeKey)) {
    return { skipped: true, reason: 'User rejected this confirmation' };
  }
  for (const existing of pendingConfirmOrders.values()) {
    if (existing.dedupeKey === dedupeKey) {
      return { queued: true, pendingId: existing.id };
    }
  }
  const id = `PCONF-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const entry = {
    id,
    dedupeKey,
    summary,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    executeFn
  };
  pendingConfirmOrders.set(id, entry);
  autoExitEngine.log('ALERT', `🔔 Confirmation required on page before sending ${(summary && summary.symbol) || 'order'} (${(summary && summary.reason) || 'Algo Trigger'})`);
  broadcastSSE('order_confirmation_required', {
    id: entry.id,
    summary: entry.summary,
    status: entry.status,
    createdAt: entry.createdAt
  });
  return { queued: true, pendingId: id };
});

autoExitEngine.on('cancel_pending_confirmations', ({ key, accountId, symbol, excludePrefix, reason } = {}) => {
  const keyPrefix = key ? `${key}:` : '';
  for (const [id, entry] of pendingConfirmOrders.entries()) {
    const dedupe = String(entry.dedupeKey || '');
    if (excludePrefix && dedupe.startsWith(excludePrefix)) continue;
    const matchesKey = keyPrefix && dedupe.startsWith(keyPrefix);
    const matchesSym = symbol && entry.summary && entry.summary.symbol === symbol &&
      (!accountId || !dedupe || dedupe.startsWith(`${accountId}_`));
    if (matchesKey || matchesSym) {
      pendingConfirmOrders.delete(id);
      if (entry.dedupeKey) dismissedConfirmKeys.delete(entry.dedupeKey);
      broadcastSSE('order_confirmation_resolved', {
        id,
        status: 'CANCELLED',
        reason: reason || 'Pending Orders Cancelled'
      });
    }
  }
});

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
  niftyCandleManager.backfillIfEmpty(3).catch(() => {});
});

niftyFeedManager.on('tick', snapshot => {
  if (snapshot && snapshot.spot && snapshot.spot.ltp > 0 && snapshot.feedState && snapshot.feedState.sourceMode === 'live_broker') {
    niftyCandleManager.onSpotTick(snapshot.spot.ltp, snapshot.timestamp || Date.now());
  }
  multiBrokerManager.syncPaperPositions(snapshot);
  if (sseClients.size > 0) {
    broadcastSSE('nifty_tick', snapshot);
  }
});

multiBrokerManager.on('ws_tick', ({ broker, accountId, tick }) => {
  if (!tick || !(tick.ltp > 0)) return;
  let sahiNiftyId = 10854;
  if (broker === 'sahi' && accountId) {
    const inst = multiBrokerManager.brokerInstances.get(accountId);
    if (inst && inst._cache && inst._cache.scripMaster && inst._cache.scripMaster.niftyIndexId) {
      sahiNiftyId = inst._cache.scripMaster.niftyIndexId;
    }
  }
  const isNiftySpotTick =
    (broker === 'angelone' && String(tick.token) === '99926000') ||
    (broker === 'kotakneo' && (String(tick.token) === 'Nifty 50' || String(tick.key) === 'nse_cm|Nifty 50')) ||
    (broker === 'dhan' && String(tick.securityId) === '13' && Number(tick.exchangeSegmentId) === 0) ||
    (broker === 'sahi' && Number(tick.instrumentId) === Number(sahiNiftyId));

  if (isNiftySpotTick) {
    niftyCandleManager.onSpotTick(tick.ltp, tick.receivedAt || Date.now(), Number(tick.volume || 0));
  }
});

niftyCandleManager.on('candle_update', payload => {
  if (sseClients.size > 0) {
    broadcastSSE('nifty_candle', payload);
  }
});

niftyCandleManager.on('history_backfilled', info => {
  autoExitEngine.log('INFO', `Loaded ${info.added} NIFTY 3-minute historical candles from ${(info.broker || 'broker').toUpperCase()} into SQLite.`);
  if (sseClients.size > 0) {
    broadcastSSE('nifty_candles_reset', {
      candles: niftyCandleManager.getCandles({ limit: 600 }),
      count: niftyCandleManager.getCandleCount()
    });
  }
});

multiBrokerManager.on('order_update', evt => {
  autoExitEngine.log('INFO', `Order/trade update received on ${String(evt.broker || '').toUpperCase()} WebSocket — refreshing net positions & holdings.`);
});

scripMasterManager.on('scrip_master_loaded', summary => {
  autoExitEngine.log(
    'INFO',
    `8:55 AM Scrip Master updated (${summary.timeIST}): ${summary.instrumentCount.toLocaleString('en-IN')} contracts loaded (lot sizes & freeze limits).`
  );
  if (sseClients.size > 0) {
    broadcastSSE('scrip_master_loaded', summary);
  }
});

autoLoginScheduler.on('auto_login_completed', async payload => {
  const succeeded = (payload.results || []).filter(r => r.success && !r.skipped);
  const failed = (payload.results || []).filter(r => !r.success);
  autoExitEngine.log(
    'INFO',
    `8:59 AM Auto-Login completed (${payload.timeIST}): ${succeeded.length} connected, ${failed.length} failed.`,
    payload.results
  );

  for (const r of succeeded) {
    if (!niftyFeedManager.feedState.feedSubscribed || r.broker === multiBrokerManager.getDataFeedSource()) {
      await niftyFeedManager.subscribeOnBrokerLogin({
        accountId: r.accountId,
        broker: r.broker,
        accountName: r.accountName
      });
    }
  }
  if (succeeded.length > 0) {
    niftyCandleManager.backfillIfEmpty(3).catch(() => {});
  }
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

    const cfgNow = configManager.loadConfig();
    const chargeSettings = cfgNow.chargeSettings || {};
    const enrichedPositions = multiBrokerManager.enrichPositionsWithCharges(rawPositions, openingBalance, chargeSettings);
    for (const pos of enrichedPositions) {
      totalGrossPnl += Number(pos.grossPnl || 0);
      totalCharges += Number(pos.totalCharges || 0);
      totalNetPnl += Number(pos.netPnl || 0);
    }

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
      rules: autoExitEngine.getAllPositionRules(),
      targetStates: autoExitEngine.getAllTargetStates(),
      riskSettings: cfgNow.riskSettings,
      chargeSettings,
      dailyOrders: multiBrokerManager.getDailyOrderStats(),
      portfolioSchedule: multiBrokerManager.getPortfolioSchedule()
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
  if (pathname === '/chart') pathname = '/chart.html';
  if (pathname === '/order-window') pathname = '/order-window.html';

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
         1. ACCOUNTS MANAGEMENT (Angel One, Dhan, Kotak Neo, Sahi)
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
        if (!body.broker || !['kotakneo', 'angelone', 'dhan', 'sahi', 'paper'].includes(body.broker)) {
          return sendJson(res, 400, { success: false, message: 'Valid broker (kotakneo, angelone, dhan, sahi, paper) is required' });
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

      if (pathname === '/api/accounts/login-all' && method === 'POST') {
        const results = await multiBrokerManager.loginAllBrokers();
        const succeeded = results.filter(r => r.success && !r.skipped);
        for (const r of succeeded) {
          if (!niftyFeedManager.feedState.feedSubscribed || r.broker === multiBrokerManager.getDataFeedSource()) {
            await niftyFeedManager.subscribeOnBrokerLogin({
              accountId: r.accountId,
              broker: r.broker,
              accountName: r.accountName
            });
          }
        }
        return sendJson(res, 200, { success: true, results });
      }

      if (pathname === '/api/accounts/test-credentials' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.broker || !['kotakneo', 'angelone', 'dhan', 'sahi', 'paper'].includes(body.broker)) {
          return sendJson(res, 400, { success: false, message: 'Valid broker (kotakneo, angelone, dhan, sahi, paper) is required' });
        }
        if (body.broker === 'paper') {
          const bal = Math.max(1000, Number(body.initialBalance || 500000));
          return sendJson(res, 200, {
            success: true,
            message: `Paper Trading Options account ready with ₹${bal.toLocaleString('en-IN')} virtual capital`
          });
        }
        const KotakNeoBroker = require('./lib/brokers/kotakNeoBroker');
        const AngelOneBroker = require('./lib/brokers/angelOneBroker');
        const DhanBroker = require('./lib/brokers/dhanBroker');
        const SahiBroker = require('./lib/brokers/sahiBroker');
        const testCfg = { ...body, isMock: currentConfig.mode === 'mock' };
        let tempInst;
        if (body.broker === 'kotakneo') tempInst = new KotakNeoBroker(testCfg);
        else if (body.broker === 'angelone') tempInst = new AngelOneBroker(testCfg);
        else if (body.broker === 'dhan') tempInst = new DhanBroker(testCfg);
        else tempInst = new SahiBroker(testCfg);

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

      if (pathname.startsWith('/api/accounts/') && pathname.endsWith('/risk-settings') && method === 'POST') {
        const id = pathname.replace('/api/accounts/', '').replace('/risk-settings', '');
        const body = await parseBody(req);
        const patch = {};
        if (body.targetNetProfitPct !== undefined && body.targetNetProfitPct !== '') {
          patch.targetNetProfitPct = Math.max(0, Number(body.targetNetProfitPct));
        }
        if (body.stopLossNetPct !== undefined && body.stopLossNetPct !== '') {
          patch.stopLossNetPct = Number(body.stopLossNetPct);
        }
        if (body.nearThresholdBufferPct !== undefined && body.nearThresholdBufferPct !== '') {
          patch.nearThresholdBufferPct = Math.max(50, Math.min(100, Number(body.nearThresholdBufferPct)));
        }
        const updated = multiBrokerManager.updateAccount(id, patch);
        autoExitEngine.clearAccountBreaker(id);
        const accRisk = multiBrokerManager.getAccountRiskSettings(id);
        const slTxt = accRisk.stopLossNetPct > 0 ? `+${accRisk.stopLossNetPct}%` : `${accRisk.stopLossNetPct}%`;
        autoExitEngine.log(
          'INFO',
          `Updated per-account risk for ${updated.name}: Target +${accRisk.targetNetProfitPct}% (after charges), SL ${slTxt}, Near ${accRisk.nearThresholdBufferPct}%`
        );
        return sendJson(res, 200, {
          success: true,
          accountRisk: accRisk,
          accounts: multiBrokerManager.getAccounts()
        });
      }

      if (pathname.startsWith('/api/accounts/') && pathname.endsWith('/manage-orders') && method === 'POST') {
        const id = pathname.replace('/api/accounts/', '').replace('/manage-orders', '');
        const body = await parseBody(req);
        const manageOrders = Boolean(body.manageOrders);
        const updated = multiBrokerManager.setAccountManageOrders(id, manageOrders);
        if (!manageOrders) {
          autoExitEngine.emit('cancel_pending_confirmations', {
            accountId: id,
            reason: 'Account excluded from order management'
          });
        }
        autoExitEngine.log(
          'INFO',
          `Order management ${manageOrders ? 'ENABLED' : 'DISABLED (View-Only)'} for broker account: ${updated.name}`
        );
        return sendJson(res, 200, {
          success: true,
          accountId: id,
          manageOrders,
          accounts: multiBrokerManager.getAccounts()
        });
      }

      if (pathname.startsWith('/api/accounts/') && pathname.endsWith('/paper-reset') && method === 'POST') {
        const id = pathname.replace('/api/accounts/', '').replace('/paper-reset', '');
        const body = await parseBody(req);
        const result = multiBrokerManager.resetPaperAccount(id, body.initialBalance !== undefined ? Number(body.initialBalance) : null);
        autoExitEngine.clearAccountBreaker(id);
        autoExitEngine.log('INFO', `Reset Paper Trading account ${id} balance to ₹${result.funds.availableCash.toLocaleString('en-IN')}`);
        return sendJson(res, 200, { success: true, ...result });
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
        const result = await openingBalanceScheduler.captureOpeningBalance(false, { force: true, manual: true });
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
        const manual = parsedUrl.searchParams.get('manual') === '1';
        const funds = await multiBrokerManager.getAllFunds({ force, manual });
        return sendJson(res, 200, { success: true, data: funds });
      }

      if (pathname === '/api/portfolio/fetch' && method === 'POST') {
        const fetched = await multiBrokerManager.fetchAllPortfolioManual();
        const openBalData = openingBalanceScheduler.getOpeningBalanceData();
        const openingBalance = Number(openBalData.openingBalance || 500000);
        const cfgNow = configManager.loadConfig();
        const chargeSettings = cfgNow.chargeSettings || {};
        const enrichedPositions = multiBrokerManager.enrichPositionsWithCharges(fetched.positions || [], openingBalance, chargeSettings);
        const enrichedOrders = multiBrokerManager.enrichOrdersWithCharges(fetched.orders || [], chargeSettings);
        autoExitEngine.log(
          'INFO',
          `Manual portfolio fetch: ${enrichedPositions.length} positions, ${(fetched.holdings || []).length} holdings, ${enrichedOrders.length} orders, Cash ₹${Number((fetched.funds && fetched.funds.availableCash) || 0).toLocaleString('en-IN')}`
        );
        return sendJson(res, 200, {
          success: true,
          fetchedAt: fetched.fetchedAt,
          portfolioSchedule: fetched.portfolioSchedule,
          funds: fetched.funds,
          positions: enrichedPositions,
          holdings: fetched.holdings || [],
          orders: enrichedOrders
        });
      }

      /* ============================================================
         4. POSITIONS & CHARGES BREAKDOWN
         ============================================================ */
      if (pathname === '/api/positions' && method === 'GET') {
        const force = parsedUrl.searchParams.get('force') === '1';
        const manual = parsedUrl.searchParams.get('manual') === '1';
        const [rawPositions] = await Promise.all([
          multiBrokerManager.getAllPositions({ force, manual }),
          (force || manual) ? multiBrokerManager.getAllOrders({ force, manual }) : Promise.resolve([])
        ]);
        const openBalData = openingBalanceScheduler.getOpeningBalanceData();
        const openingBalance = Number(openBalData.openingBalance || 500000);
        const cfgNow = configManager.loadConfig();
        const chargeSettings = cfgNow.chargeSettings || {};

        const enrichedPositions = multiBrokerManager.enrichPositionsWithCharges(rawPositions, openingBalance, chargeSettings);

        return sendJson(res, 200, { success: true, data: enrichedPositions });
      }

      if (pathname === '/api/holdings' && method === 'GET') {
        const force = parsedUrl.searchParams.get('force') === '1';
        const manual = parsedUrl.searchParams.get('manual') === '1';
        const holdings = await multiBrokerManager.getAllHoldings({ force, manual });
        return sendJson(res, 200, { success: true, data: holdings });
      }

      /* ============================================================
         5. ORDERS & TRADE EXECUTION
         ============================================================ */
      if (pathname === '/api/orders' && method === 'GET') {
        const force = parsedUrl.searchParams.get('force') === '1';
        const manual = parsedUrl.searchParams.get('manual') === '1';
        const orders = await multiBrokerManager.getAllOrders({ force, manual });
        const cfgNow = configManager.loadConfig();
        const enrichedOrders = multiBrokerManager.enrichOrdersWithCharges(orders, cfgNow.chargeSettings || {});
        return sendJson(res, 200, { success: true, data: enrichedOrders });
      }

      if (pathname === '/api/orders' && method === 'POST') {
        const orderData = await parseBody(req);
        if (!(Number(orderData.ltp) > 0) && (orderData.tradingSymbol || orderData.symbol)) {
          const targetSym = String(orderData.tradingSymbol || orderData.symbol).trim().toUpperCase();
          const snap = niftyFeedManager.getSnapshot();
          if (snap && Array.isArray(snap.strikes)) {
            for (const row of snap.strikes) {
              for (const leg of [row.ce, row.pe]) {
                if (leg && String(leg.symbol || '').trim().toUpperCase() === targetSym && Number(leg.ltp) > 0) {
                  orderData.ltp = Number(leg.ltp);
                  break;
                }
              }
              if (Number(orderData.ltp) > 0) break;
            }
          }
        }
        const result = await multiBrokerManager.placeOrder(orderData);
        const splitNote = result.sliced ? ` [Split into ${result.sliceCount} orders, Freeze=${result.freezeQty}]` : '';
        const lmtNote = result.convertedFromMkt ? ` [MKT -> LMT @ ₹${result.price}]` : '';
        const routeNote = result.routingMode === 'all_funded'
          ? `across ${result.executedCount} checked broker(s)`
          : 'on checked broker';
        autoExitEngine.log(
          'INFO',
          `Order placed ${routeNote}: ${orderData.transactionType || 'B'} ${orderData.tradingSymbol} x ${result.totalQuantity}${lmtNote}${splitNote}`,
          result
        );
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/orders/send-stoploss' && method === 'POST') {
        const body = await parseBody(req);
        const result = await multiBrokerManager.sendStopLossForManagedPositions({
          slPct: body.slPct,
          accountId: body.accountId || '',
          scope: body.scope === 'selected' ? 'selected' : 'all_managed',
          preview: Boolean(body.preview)
        });
        if (!result.preview) {
          for (const item of result.sent) {
            const key = `${item.accountId}_${item.symbol}_${item.product}`;
            const existingTs = autoExitEngine.targetStates.get(key);
            if (existingTs) {
              existingTs.slOrderIds = item.orderIds && item.orderIds.length > 0
                ? item.orderIds
                : (item.orderId ? [item.orderId] : []);
              existingTs.slTriggerPrice = item.triggerPrice;
              existingTs.slLimitPrice = item.limitPrice;
              existingTs.slQty = item.quantity;
              existingTs.slSource = result.slPct > 0 ? 'PROFIT_SL' : 'LOSS_SL';
            }
            autoExitEngine.log(
              'TRIGGER',
              `🛡️ Order Window SL (${result.slPct > 0 ? '+' : ''}${result.slPct}%) placed on ${item.brokerName} for ${item.symbol} (${item.quantity} qty): Trig ₹${item.triggerPrice} / Lim ₹${item.limitPrice} (Cap ₹${item.capitalBase})`
            );
          }
        }
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/orders/send-target' && method === 'POST') {
        const body = await parseBody(req);
        const result = await multiBrokerManager.sendTargetForManagedPositions({
          targetPct: body.targetPct,
          qtyPct: body.qtyPct !== undefined ? Number(body.qtyPct) : 100,
          accountId: body.accountId || '',
          scope: body.scope === 'selected' ? 'selected' : 'all_managed',
          preview: Boolean(body.preview)
        });
        if (!result.preview) {
          for (const item of result.sent) {
            autoExitEngine.log(
              'TRIGGER',
              `🎯 Order Window Target Limit (${result.targetPct > 0 ? '+' : ''}${result.targetPct}%) placed on ${item.brokerName} for ${item.symbol} (${item.quantity} qty): Limit ₹${item.limitPrice} (Cap ₹${item.capitalBase}, Charges ₹${item.chargesINR})`
            );
          }
        }
        return sendJson(res, 200, result);
      }

      if (pathname === '/api/orders/calculate-quantity' && method === 'POST') {
        const body = await parseBody(req);
        // Resolve live LTP from option chain / positions when caller didn't pass ltp explicitly
        let liveLtp = Number(body.ltp || 0);
        if (!(liveLtp > 0) && (body.tradingSymbol || body.symbol)) {
          const targetSym = String(body.tradingSymbol || body.symbol).trim().toUpperCase();
          const snap = niftyFeedManager.getSnapshot();
          if (snap && Array.isArray(snap.strikes)) {
            for (const row of snap.strikes) {
              for (const leg of [row.ce, row.pe]) {
                if (leg && String(leg.symbol || '').trim().toUpperCase() === targetSym && Number(leg.ltp) > 0) {
                  liveLtp = Number(leg.ltp);
                  break;
                }
              }
              if (liveLtp > 0) break;
            }
          }
        }
        const calc = await multiBrokerManager.calculateOrderQuantityForAccount({
          ...body,
          ltp: liveLtp
        });
        return sendJson(res, 200, { success: true, data: { ...calc, ltp: liveLtp } });
      }

      if (pathname === '/api/scrip-master/status' && method === 'GET') {
        return sendJson(res, 200, { success: true, data: scripMasterManager.getStatus() });
      }

      if (pathname === '/api/scrip-master/refresh' && method === 'POST') {
        const summary = await scripMasterManager.downloadAll();
        return sendJson(res, 200, { success: true, data: summary });
      }

      if (pathname === '/api/scrip-master/lookup' && method === 'GET') {
        const spec = scripMasterManager.getContractSpec({
          symbol: parsedUrl.searchParams.get('symbol') || '',
          underlying: parsedUrl.searchParams.get('underlying') || '',
          exchangeSegment: parsedUrl.searchParams.get('segment') || '',
          instrumentToken: parsedUrl.searchParams.get('token') || ''
        });
        return sendJson(res, 200, { success: true, data: spec });
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

      if (pathname === '/api/pending-orders' && method === 'GET') {
        const list = Array.from(pendingConfirmOrders.values()).map(p => ({
          id: p.id,
          summary: p.summary,
          status: p.status,
          createdAt: p.createdAt
        }));
        return sendJson(res, 200, { success: true, data: list });
      }

      if (pathname.startsWith('/api/pending-orders/') && pathname.endsWith('/confirm') && method === 'POST') {
        const id = decodeURIComponent(pathname.replace('/api/pending-orders/', '').replace('/confirm', ''));
        const entry = pendingConfirmOrders.get(id);
        if (!entry) {
          return sendJson(res, 404, { success: false, message: 'Pending order confirmation not found or already resolved' });
        }
        pendingConfirmOrders.delete(id);
        dismissedConfirmKeys.delete(entry.dedupeKey);
        try {
          const result = await entry.executeFn();
          broadcastSSE('order_confirmation_resolved', { id, status: 'CONFIRMED' });
          return sendJson(res, 200, { success: true, id, status: 'CONFIRMED', result });
        } catch (execErr) {
          broadcastSSE('order_confirmation_resolved', { id, status: 'ERROR', error: execErr.message });
          return sendJson(res, 400, { success: false, id, message: execErr.message });
        }
      }

      if (pathname.startsWith('/api/pending-orders/') && pathname.endsWith('/reject') && method === 'POST') {
        const id = decodeURIComponent(pathname.replace('/api/pending-orders/', '').replace('/reject', ''));
        const entry = pendingConfirmOrders.get(id);
        if (!entry) {
          return sendJson(res, 404, { success: false, message: 'Pending order confirmation not found' });
        }
        pendingConfirmOrders.delete(id);
        dismissedConfirmKeys.add(entry.dedupeKey);
        autoExitEngine.log('INFO', `Rejected/cancelled pending order for ${(entry.summary && entry.summary.symbol) || id}`);
        broadcastSSE('order_confirmation_resolved', { id, status: 'REJECTED' });
        return sendJson(res, 200, { success: true, id, status: 'REJECTED' });
      }

      if (pathname === '/api/autoexit/exit-position' && method === 'POST') {
        const body = await parseBody(req);
        const positions = await multiBrokerManager.getAllPositions();
        const pos = positions.find(p => p.symbol === body.symbol && (p.accountId === body.accountId || !body.accountId));
        if (!pos) {
          return sendJson(res, 404, { success: false, message: 'Position not found' });
        }
        const result = await autoExitEngine.exitPosition(pos, body.reason || 'Manual Web Exit', { skipGate: Boolean(body.userConfirmed) });
        return sendJson(res, 200, { success: true, data: result });
      }

      if (pathname === '/api/autoexit/exit-all' && method === 'POST') {
        const body = await parseBody(req);
        const result = await autoExitEngine.exitAllPositions(body.reason || 'Panic Exit All Across Brokers', { skipGate: Boolean(body.userConfirmed) });
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
         7b. NIFTY 3-MINUTE CHART (SQLite + WebSocket + 3-Day Backfill)
         ============================================================ */
      if (pathname === '/api/nifty-chart' && method === 'GET') {
        const days = Number(parsedUrl.searchParams.get('days') || 3);
        const limit = Number(parsedUrl.searchParams.get('limit') || 600);
        let backfillInfo = { backfilled: false, added: 0 };
        if (niftyCandleManager.getCandleCount() === 0) {
          backfillInfo = await niftyCandleManager.backfillIfEmpty(days);
        }
        const candles = niftyCandleManager.getCandles({ limit });
        const candles1m = niftyCandleManager.getCandles({ limit: limit * 3, timeframe: '1m' });
        return sendJson(res, 200, {
          success: true,
          symbol: 'NIFTY',
          timeframe: '3m',
          count: niftyCandleManager.getCandleCount(),
          backfilled: Boolean(backfillInfo.backfilled),
          candles,
          candles1m,
          analysis: niftyCandleManager.getChartAnalysis({ limit }),
          currentCandle: niftyCandleManager.currentCandle,
          spot: niftyFeedManager.getSnapshot().spot
        });
      }

      if (pathname === '/api/nifty-chart/backfill' && method === 'POST') {
        const body = await parseBody(req);
        const days = Number(body.days || 3);
        const result = await niftyCandleManager.backfillFromBroker(days);
        return sendJson(res, 200, {
          success: true,
          ...result,
          candles: niftyCandleManager.getCandles({ limit: 600 }),
          candles1m: niftyCandleManager.getCandles({ limit: 1800, timeframe: '1m' }),
          analysis: niftyCandleManager.getChartAnalysis({ limit: 600 })
        });
      }

      /* ============================================================
         8. CONFIG & MODE
         ============================================================ */
      if (pathname === '/api/status' && method === 'GET') {
        const openBal = openingBalanceScheduler.getOpeningBalanceData();
        currentConfig = configManager.loadConfig();
        return sendJson(res, 200, {
          success: true,
          mode: currentConfig.mode,
          dataFeedSource: multiBrokerManager.getDataFeedSource(),
          openingBalance: openBal,
          accounts: multiBrokerManager.getAccounts(),
          riskSettings: currentConfig.riskSettings,
          chargeSettings: currentConfig.chargeSettings,
          dailyOrders: multiBrokerManager.getDailyOrderStats(),
          portfolioSchedule: multiBrokerManager.getPortfolioSchedule(),
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
        const sanitized = { ...body };
        if (sanitized.capitalDeployPct !== undefined) {
          sanitized.capitalDeployPct = Math.max(1, Math.min(100, Number(sanitized.capitalDeployPct) || 100));
        }
        if (sanitized.maxDailyOrders !== undefined) {
          sanitized.maxDailyOrders = Math.max(0, Math.round(Number(sanitized.maxDailyOrders) || 0));
        }
        if (sanitized.orderRoutingMode !== undefined) {
          sanitized.orderRoutingMode = sanitized.orderRoutingMode === 'all_funded' ? 'all_funded' : 'selected';
        }
        currentConfig = configManager.saveConfig({ riskSettings: sanitized });
        autoExitEngine.clearDailyBreaker();
        const rs = currentConfig.riskSettings;
        const slLogTxt = rs.maxDailyLossNetPct > 0 ? `+${rs.maxDailyLossNetPct}%` : `${rs.maxDailyLossNetPct}%`;
        autoExitEngine.log(
          'INFO',
          `Updated day order/risk settings: Deploy ${rs.capitalDeployPct}% capital, Net Target +${rs.targetDailyNetProfitPct}% (after charges), SL ${slLogTxt}, Max Orders/Day ${rs.maxDailyOrders > 0 ? rs.maxDailyOrders : 'Unlimited'}, Routing: ${rs.orderRoutingMode === 'all_funded' ? 'All Checked Brokers' : 'Checked Broker'}`
        );
        return sendJson(res, 200, {
          success: true,
          riskSettings: rs,
          dailyOrders: multiBrokerManager.getDailyOrderStats()
        });
      }

      if (pathname === '/api/charge-settings' && method === 'GET') {
        currentConfig = configManager.loadConfig();
        return sendJson(res, 200, { success: true, chargeSettings: currentConfig.chargeSettings });
      }

      if (pathname === '/api/charge-settings' && method === 'POST') {
        const body = await parseBody(req);
        const defs = ChargesCalculator.getDefaultChargeSettings();
        const sanitized = {
          sttPct: body.sttPct !== undefined ? Math.max(0, Number(body.sttPct)) : defs.sttPct,
          exchangeTxnPct: body.exchangeTxnPct !== undefined ? Math.max(0, Number(body.exchangeTxnPct)) : defs.exchangeTxnPct,
          sebiPerCrore: body.sebiPerCrore !== undefined ? Math.max(0, Number(body.sebiPerCrore)) : defs.sebiPerCrore,
          ipftPerCrore: body.ipftPerCrore !== undefined ? Math.max(0, Number(body.ipftPerCrore)) : defs.ipftPerCrore,
          stampDutyBuyPct: body.stampDutyBuyPct !== undefined ? Math.max(0, Number(body.stampDutyBuyPct)) : defs.stampDutyBuyPct,
          gstPct: body.gstPct !== undefined ? Math.max(0, Number(body.gstPct)) : defs.gstPct
        };
        currentConfig = configManager.saveConfig({ chargeSettings: sanitized });
        const cs = currentConfig.chargeSettings;
        autoExitEngine.log(
          'INFO',
          `Updated Options statutory charges: STT ${cs.sttPct}%, Exch Txn ${cs.exchangeTxnPct}%, SEBI ₹${cs.sebiPerCrore}/Cr, IPFT ₹${cs.ipftPerCrore}/Cr, Stamp Duty (Buy) ${cs.stampDutyBuyPct}%, GST ${cs.gstPct}%`
        );
        return sendJson(res, 200, { success: true, chargeSettings: cs });
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
  console.log(`  Brokers Supported: Kotak Neo, Angel One, Dhan, Sahi`);
  console.log(`  9:00 AM Balance Scheduler: ACTIVE`);
  console.log(`  Charges & Net Profit % Engine: ACTIVE`);
  console.log(`  NIFTY 3m SQLite Chart Store: ${niftyCandleManager.getCandleCount()} candles`);
  console.log(`  Local URL: http://localhost:${PORT}`);
  console.log(`=====================================================`);
});

function shutdownGracefully() {
  scripMasterManager.close();
  autoLoginScheduler.stop();
  niftyFeedManager.stopBackgroundLoops();
  niftyCandleManager.close();
  process.exit(0);
}
process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);
