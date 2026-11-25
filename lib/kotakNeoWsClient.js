const EventEmitter = require('events');

const KOTAK_HSM_URL = 'wss://mlhsm.kotaksecurities.com';

/**
 * Normalize Kotak Neo WebSocket tick payload (JSON or binary) into unified tick format.
 */
function parseKotakMarketMessage(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'pong') return [];
    try {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.data) ? parsed.data : [parsed]);
      const out = [];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        // Skip control ack frames
        if (item.type === 'cn' || item.type === 'mws' || item.type === 'ifs' || item.ak) continue;
        const token = String(item.tk || item.token || item.instrumentToken || item.symbol || '').trim();
        const exchange = String(item.e || item.ex || item.es || '').trim();
        const ltp = Number(item.ltp ?? item.lp ?? item.last_price ?? 0);
        if (!token && !(ltp > 0)) continue;
        const tick = {
          token,
          exchange,
          key: exchange && token ? `${exchange}|${token}` : token,
          ltp: ltp > 0 ? Number(ltp.toFixed(2)) : 0,
          open: item.o !== undefined ? Number(item.o) : (item.open !== undefined ? Number(item.open) : undefined),
          high: item.h !== undefined ? Number(item.h) : (item.high !== undefined ? Number(item.high) : undefined),
          low: item.l !== undefined ? Number(item.l) : (item.low !== undefined ? Number(item.low) : undefined),
          close: item.c !== undefined ? Number(item.c) : (item.close !== undefined ? Number(item.close) : undefined),
          volume: item.v !== undefined ? Number(item.v) : (item.volume !== undefined ? Number(item.volume) : undefined),
          oi: item.oi !== undefined ? Number(item.oi) : undefined,
          bid: item.bp !== undefined ? Number(item.bp) : undefined,
          ask: item.sp !== undefined ? Number(item.sp) : undefined,
          receivedAt: Date.now()
        };
        if (tick.ltp > 0) out.push(tick);
      }
      return out;
    } catch (e) {
      return [];
    }
  }
  return [];
}

/**
 * Manages Kotak Neo WebSockets:
 * - Market Data WebSocket (HSM / feedUrl) for live ticks
 * - Interactive Order & Position WebSocket (wss://<baseUrl>/realtime) for real-time trade/order updates
 */
class KotakNeoWsClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionToken = options.sessionToken || '';
    this.sid = options.sid || '';
    this.ucc = options.ucc || '';
    this.activeBaseUrl = options.activeBaseUrl || '';
    this.feedUrl = options.feedUrl || KOTAK_HSM_URL;
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;

    this.marketWs = null;
    this.orderWs = null;
    this.isMarketConnected = false;
    this.isOrderConnected = false;
    this._shouldReconnect = false;

    this._pingTimer = null;
    this._marketReconnectTimer = null;
    this._orderReconnectTimer = null;

    // Keyed by token AND `${exchange}|${token}`
    this.ticks = new Map();
    // Subscribed scrip strings (e.g. 'nse_cm|Nifty 50', 'nse_fo|72314')
    this._subscribedScrips = new Set();
    this._indexScrips = new Set();
  }

  updateCredentials({ sessionToken, sid, ucc, activeBaseUrl, feedUrl }) {
    if (sessionToken) this.sessionToken = sessionToken;
    if (sid) this.sid = sid;
    if (ucc) this.ucc = ucc;
    if (activeBaseUrl) this.activeBaseUrl = activeBaseUrl;
    if (feedUrl) this.feedUrl = feedUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  }

  _getOrderWsUrl() {
    if (!this.activeBaseUrl) return null;
    const base = this.activeBaseUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:').replace(/\/+$/, '');
    return `${base}/realtime`;
  }

  connect() {
    if (!this.WebSocketImpl || !this.sessionToken || !this.sid) return;
    this._shouldReconnect = true;
    this._connectMarketWs();
    this._connectOrderWs();
    this._startHeartbeat();
  }

  disconnect() {
    this._shouldReconnect = false;
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._marketReconnectTimer) {
      clearTimeout(this._marketReconnectTimer);
      this._marketReconnectTimer = null;
    }
    if (this._orderReconnectTimer) {
      clearTimeout(this._orderReconnectTimer);
      this._orderReconnectTimer = null;
    }
    if (this.marketWs) {
      try { this.marketWs.close(); } catch (e) {}
      this.marketWs = null;
    }
    if (this.orderWs) {
      try { this.orderWs.close(); } catch (e) {}
      this.orderWs = null;
    }
    this.isMarketConnected = false;
    this.isOrderConnected = false;
  }

  _startHeartbeat() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      if (this.marketWs && this.isMarketConnected) {
        try { this.marketWs.send(JSON.stringify({ type: 'ti', scrips: '' })); } catch (e) {}
      }
      if (this.orderWs && this.isOrderConnected) {
        try { this.orderWs.send('ping'); } catch (e) {}
      }
    }, 25000);
  }

  _connectMarketWs() {
    if (this.marketWs || !this._shouldReconnect) return;

    try {
      const ws = new this.WebSocketImpl(this.feedUrl || KOTAK_HSM_URL);
      ws.binaryType = 'arraybuffer';
      this.marketWs = ws;

      ws.addEventListener('open', () => {
        // Send HSM connection handshake
        try {
          ws.send(JSON.stringify({
            type: 'cn',
            Authorization: this.sessionToken,
            Sid: this.sid,
            source: 'WEB'
          }));
        } catch (e) {}
        this.isMarketConnected = true;
        this.emit('market_connected');
        this._flushSubscriptions();
      });

      ws.addEventListener('message', event => {
        const ticks = parseKotakMarketMessage(event.data);
        for (const tick of ticks) {
          if (tick.token) this.ticks.set(tick.token, tick);
          if (tick.key) this.ticks.set(tick.key, tick);
          this.emit('tick', tick);
        }
      });

      ws.addEventListener('close', () => {
        this.isMarketConnected = false;
        this.marketWs = null;
        if (this._shouldReconnect && !this._marketReconnectTimer) {
          this._marketReconnectTimer = setTimeout(() => {
            this._marketReconnectTimer = null;
            this._connectMarketWs();
          }, 5000);
        }
      });

      ws.addEventListener('error', () => {});
    } catch (e) {
      this.marketWs = null;
      this.isMarketConnected = false;
    }
  }

  _connectOrderWs() {
    const orderUrl = this._getOrderWsUrl();
    if (this.orderWs || !orderUrl || !this._shouldReconnect) return;

    try {
      const ws = new this.WebSocketImpl(orderUrl);
      this.orderWs = ws;

      ws.addEventListener('open', () => {
        // Kotak HSI expects unquoted raw control text frame on open
        try {
          ws.send(`{type:cn,Authorization:${this.sessionToken},Sid:${this.sid},src:WEB}`);
        } catch (e) {}
        this.isOrderConnected = true;
        this.emit('order_ws_connected');
      });

      ws.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        const trimmed = event.data.trim();
        if (!trimmed || trimmed === 'pong') return;
        try {
          const msg = JSON.parse(trimmed);
          if (msg && msg.type !== 'cn') {
            this.emit('order_update', msg);
          }
        } catch (e) {}
      });

      ws.addEventListener('close', () => {
        this.isOrderConnected = false;
        this.orderWs = null;
        if (this._shouldReconnect && !this._orderReconnectTimer) {
          this._orderReconnectTimer = setTimeout(() => {
            this._orderReconnectTimer = null;
            this._connectOrderWs();
          }, 5000);
        }
      });

      ws.addEventListener('error', () => {});
    } catch (e) {
      this.orderWs = null;
      this.isOrderConnected = false;
    }
  }

  subscribe(scrips = [], isIndex = false) {
    const targetSet = isIndex ? this._indexScrips : this._subscribedScrips;
    const newlyAdded = [];
    for (const s of scrips) {
      const clean = String(s || '').trim();
      if (clean && !targetSet.has(clean)) {
        targetSet.add(clean);
        newlyAdded.push(clean);
      }
    }
    if (newlyAdded.length > 0 && this.isMarketConnected && this.marketWs) {
      this._sendSubscribe(newlyAdded, isIndex);
    }
  }

  _sendSubscribe(scrips, isIndex = false) {
    if (!this.marketWs || !this.isMarketConnected || scrips.length === 0) return;
    try {
      this.marketWs.send(JSON.stringify({
        type: isIndex ? 'ifs' : 'mws',
        scrips: scrips.join('&'),
        channelnum: 1
      }));
    } catch (e) {}
  }

  _flushSubscriptions() {
    if (this._indexScrips.size > 0) {
      this._sendSubscribe(Array.from(this._indexScrips), true);
    }
    if (this._subscribedScrips.size > 0) {
      this._sendSubscribe(Array.from(this._subscribedScrips), false);
    }
  }

  getTick(tokenOrKey) {
    if (!tokenOrKey) return null;
    const k = String(tokenOrKey).trim();
    return this.ticks.get(k) || null;
  }
}

module.exports = {
  KotakNeoWsClient,
  parseKotakMarketMessage,
  KOTAK_HSM_URL
};
