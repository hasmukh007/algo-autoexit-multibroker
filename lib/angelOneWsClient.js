const EventEmitter = require('events');

const SMART_STREAM_URL = 'wss://smartapisocket.angelone.in/smart-stream';
const ORDER_UPDATE_URL = 'wss://tns.angelone.in/smart-order-update';

/**
 * Parse a binary SmartAPI WebSocket v2 packet (Little Endian).
 * Supports Mode 1 (LTP), Mode 2 (Quote), and Mode 3 (Snap Quote with OI & Best 5 Depth).
 */
function parseSmartStreamPacket(input) {
  let u8;
  if (input instanceof ArrayBuffer) {
    u8 = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    u8 = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else if (Buffer.isBuffer(input)) {
    u8 = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    return null;
  }

  if (u8.byteLength < 51) return null;

  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const mode = view.getUint8(0);
  const exchangeType = view.getUint8(1);
  const token = Buffer.from(u8.subarray(2, 27)).toString('utf8').replace(/\0/g, '').trim();
  const sequenceNumber = Number(view.getBigInt64(27, true));
  const exchangeTimestamp = Number(view.getBigInt64(35, true));
  const ltp = Number((Number(view.getBigInt64(43, true)) / 100).toFixed(2));

  const parsed = {
    mode,
    exchangeType,
    token,
    sequenceNumber,
    exchangeTimestamp,
    ltp,
    receivedAt: Date.now()
  };

  if (mode >= 2 && u8.byteLength >= 123) {
    parsed.lastTradedQty = Number(view.getBigInt64(51, true));
    parsed.avgPrice = Number((Number(view.getBigInt64(59, true)) / 100).toFixed(2));
    parsed.volume = Number(view.getBigInt64(67, true));
    parsed.totalBuyQty = view.getFloat64(75, true);
    parsed.totalSellQty = view.getFloat64(83, true);
    parsed.open = Number((Number(view.getBigInt64(91, true)) / 100).toFixed(2));
    parsed.high = Number((Number(view.getBigInt64(99, true)) / 100).toFixed(2));
    parsed.low = Number((Number(view.getBigInt64(107, true)) / 100).toFixed(2));
    parsed.close = Number((Number(view.getBigInt64(115, true)) / 100).toFixed(2));
  }

  if (mode >= 3 && u8.byteLength >= 139) {
    parsed.oi = Number(view.getBigInt64(131, true));
    if (u8.byteLength >= 347) {
      let bestBid = null;
      let bestAsk = null;
      for (let offset = 147; offset + 20 <= 347; offset += 20) {
        const flag = view.getUint16(offset, true);
        const price = Number((Number(view.getBigInt64(offset + 10, true)) / 100).toFixed(2));
        if (price <= 0) continue;
        if (flag === 0 && bestBid === null) bestBid = price;
        if (flag === 1 && bestAsk === null) bestAsk = price;
      }
      if (bestBid !== null) parsed.bid = bestBid;
      if (bestAsk !== null) parsed.ask = bestAsk;
    }
  }

  return parsed;
}

/**
 * Manages Angel One SmartAPI WebSocket v2 (Market Data) and Smart Order Update WebSocket.
 */
class AngelOneWsClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.apiKey = options.apiKey || '';
    this.clientCode = options.clientCode || '';
    this.jwtToken = options.jwtToken || '';
    this.feedToken = options.feedToken || '';
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;

    this.marketWs = null;
    this.orderWs = null;
    this.isMarketConnected = false;
    this.isOrderConnected = false;
    this._shouldReconnect = false;

    this._pingTimer = null;
    this._marketReconnectTimer = null;
    this._orderReconnectTimer = null;

    // Live ticks keyed by token string
    this.ticks = new Map();
    // Active subscriptions keyed by `${mode}:${exchangeType}` -> Set<string>
    this._subscriptions = new Map();
  }

  updateCredentials({ apiKey, clientCode, jwtToken, feedToken }) {
    if (apiKey) this.apiKey = apiKey;
    if (clientCode) this.clientCode = clientCode;
    if (jwtToken) this.jwtToken = jwtToken;
    if (feedToken) this.feedToken = feedToken;
  }

  _cleanBearerToken() {
    if (!this.jwtToken) return '';
    return this.jwtToken.startsWith('Bearer ') ? this.jwtToken : `Bearer ${this.jwtToken}`;
  }

  connect() {
    if (!this.WebSocketImpl || !this.jwtToken || !this.apiKey || !this.clientCode) {
      return;
    }
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
        try { this.marketWs.send('ping'); } catch (e) {}
      }
      if (this.orderWs && this.isOrderConnected) {
        try { this.orderWs.send('ping'); } catch (e) {}
      }
    }, 25000);
  }

  _connectMarketWs() {
    if (this.marketWs || !this.feedToken || !this._shouldReconnect) return;

    try {
      const ws = new this.WebSocketImpl(SMART_STREAM_URL, {
        headers: {
          Authorization: this._cleanBearerToken(),
          'x-api-key': this.apiKey,
          'x-client-code': this.clientCode,
          'x-feed-token': this.feedToken
        }
      });
      ws.binaryType = 'arraybuffer';
      this.marketWs = ws;

      ws.addEventListener('open', () => {
        this.isMarketConnected = true;
        this.emit('market_connected');
        this._flushSubscriptions();
      });

      ws.addEventListener('message', event => {
        const raw = event.data;
        if (typeof raw === 'string') return; // 'pong' or heartbeat text
        const handleBuffer = buf => {
          const tick = parseSmartStreamPacket(buf);
          if (tick && tick.token) {
            this.ticks.set(tick.token, tick);
            this.emit('tick', tick);
          }
        };
        if (raw && typeof raw.arrayBuffer === 'function') {
          raw.arrayBuffer().then(handleBuffer).catch(() => {});
        } else {
          handleBuffer(raw);
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

      ws.addEventListener('error', () => {
        // Handled cleanly via close listener
      });
    } catch (err) {
      this.marketWs = null;
      this.isMarketConnected = false;
    }
  }

  _connectOrderWs() {
    if (this.orderWs || !this.jwtToken || !this._shouldReconnect) return;

    try {
      const ws = new this.WebSocketImpl(ORDER_UPDATE_URL, {
        headers: {
          Authorization: this._cleanBearerToken()
        }
      });
      this.orderWs = ws;

      ws.addEventListener('open', () => {
        this.isOrderConnected = true;
        this.emit('order_ws_connected');
      });

      ws.addEventListener('message', event => {
        const raw = event.data;
        if (typeof raw !== 'string') return;
        const trimmed = raw.trim();
        if (!trimmed || trimmed === 'pong') return;

        try {
          const msg = JSON.parse(trimmed);
          // Connection greeting has status code AB00 and no orderData
          if (msg && (msg.orderData || msg['order-status'] !== 'AB00')) {
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
    } catch (err) {
      this.orderWs = null;
      this.isOrderConnected = false;
    }
  }

  /**
   * Subscribe tokens for streaming quotes.
   * @param {number} mode 1=LTP, 2=Quote, 3=SnapQuote
   * @param {Array<{exchangeType: number, tokens: string[]}>} tokenList
   */
  subscribe(mode = 3, tokenList = []) {
    let changed = false;
    for (const group of tokenList) {
      if (!group || !Array.isArray(group.tokens) || group.tokens.length === 0) continue;
      const key = `${mode}:${group.exchangeType}`;
      let set = this._subscriptions.get(key);
      if (!set) {
        set = new Set();
        this._subscriptions.set(key, set);
      }
      for (const tok of group.tokens) {
        const t = String(tok || '').trim();
        if (t && !set.has(t)) {
          set.add(t);
          changed = true;
        }
      }
    }

    if (changed && this.isMarketConnected && this.marketWs) {
      this._sendSubscribe(mode, tokenList);
    }
  }

  _sendSubscribe(mode, tokenList) {
    if (!this.marketWs || !this.isMarketConnected) return;
    const filtered = tokenList
      .map(g => ({ exchangeType: g.exchangeType, tokens: (g.tokens || []).map(String).filter(Boolean) }))
      .filter(g => g.tokens.length > 0);
    if (filtered.length === 0) return;

    try {
      this.marketWs.send(JSON.stringify({
        correlationID: `sub_${mode}_${Date.now()}`,
        action: 1,
        params: {
          mode,
          tokenList: filtered
        }
      }));
    } catch (e) {}
  }

  _flushSubscriptions() {
    const byMode = new Map();
    for (const [key, set] of this._subscriptions.entries()) {
      const [modeStr, exStr] = key.split(':');
      const mode = Number(modeStr);
      const exchangeType = Number(exStr);
      if (!byMode.has(mode)) byMode.set(mode, []);
      byMode.get(mode).push({ exchangeType, tokens: Array.from(set) });
    }
    for (const [mode, list] of byMode.entries()) {
      this._sendSubscribe(mode, list);
    }
  }

  getTick(token) {
    if (!token) return null;
    return this.ticks.get(String(token).trim()) || null;
  }
}

module.exports = {
  AngelOneWsClient,
  parseSmartStreamPacket,
  SMART_STREAM_URL,
  ORDER_UPDATE_URL
};
