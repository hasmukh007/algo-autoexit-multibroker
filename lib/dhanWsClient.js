const EventEmitter = require('events');

const DHAN_FEED_URL = 'wss://api-feed.dhan.co';
const DHAN_ORDER_URL = 'wss://api-order-update.dhan.co';

const DHAN_EXCHANGE_SEGMENT_TO_ID = {
  IDX_I: 0,
  NSE_EQ: 1,
  NSE_FNO: 2,
  NSE_CURR: 3,
  BSE_EQ: 4,
  MCX_COMM: 5,
  BSE_CURR: 7,
  BSE_FNO: 8
};

/**
 * Parse a DhanHQ v2 binary WebSocket packet (Little Endian).
 * Supports Response Code 2 (Ticker), 4 (Quote), 5 (OI), 6 (Prev Close), and 8 (Full Packet).
 */
function parseDhanFeedPacket(input) {
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

  if (u8.byteLength < 12) return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const responseCode = view.getUint8(0);
  const msgLength = view.getUint16(1, true);
  const exchangeSegmentId = view.getUint8(3);
  const securityId = String(view.getUint32(4, true));

  const parsed = {
    responseCode,
    msgLength,
    exchangeSegmentId,
    securityId,
    receivedAt: Date.now()
  };

  if (responseCode === 2 && u8.byteLength >= 16) {
    parsed.ltp = Number(view.getFloat32(8, true).toFixed(2));
    parsed.ltt = view.getInt32(12, true);
    return parsed;
  }

  if (responseCode === 5 && u8.byteLength >= 12) {
    parsed.oi = view.getInt32(8, true);
    return parsed;
  }

  if (responseCode === 6 && u8.byteLength >= 16) {
    parsed.prevClose = Number(view.getFloat32(8, true).toFixed(2));
    parsed.prevOi = view.getInt32(12, true);
    return parsed;
  }

  if (responseCode === 4 && u8.byteLength >= 50) {
    parsed.ltp = Number(view.getFloat32(8, true).toFixed(2));
    parsed.ltq = view.getInt16(12, true);
    parsed.ltt = view.getInt32(14, true);
    parsed.atp = Number(view.getFloat32(18, true).toFixed(2));
    parsed.volume = view.getInt32(22, true);
    parsed.totalBuyQty = view.getInt32(26, true);
    parsed.totalSellQty = view.getInt32(30, true);
    parsed.open = Number(view.getFloat32(34, true).toFixed(2));
    parsed.close = Number(view.getFloat32(38, true).toFixed(2));
    parsed.high = Number(view.getFloat32(42, true).toFixed(2));
    parsed.low = Number(view.getFloat32(46, true).toFixed(2));
    return parsed;
  }

  if (responseCode === 8 && u8.byteLength >= 62) {
    parsed.ltp = Number(view.getFloat32(8, true).toFixed(2));
    parsed.ltq = view.getInt16(12, true);
    parsed.ltt = view.getInt32(14, true);
    parsed.atp = Number(view.getFloat32(18, true).toFixed(2));
    parsed.volume = view.getInt32(22, true);
    parsed.totalBuyQty = view.getInt32(26, true);
    parsed.totalSellQty = view.getInt32(30, true);
    parsed.oi = view.getInt32(34, true);
    parsed.oiDayHigh = view.getInt32(38, true);
    parsed.oiDayLow = view.getInt32(42, true);
    parsed.open = Number(view.getFloat32(46, true).toFixed(2));
    parsed.close = Number(view.getFloat32(50, true).toFixed(2));
    parsed.high = Number(view.getFloat32(54, true).toFixed(2));
    parsed.low = Number(view.getFloat32(58, true).toFixed(2));

    if (u8.byteLength >= 82) {
      // First level of 5-level depth (20 bytes per level: bidQty(4), askQty(4), bidOrd(2), askOrd(2), bidPrice(4), askPrice(4))
      const bid = Number(view.getFloat32(74, true).toFixed(2));
      const ask = Number(view.getFloat32(78, true).toFixed(2));
      if (bid > 0) parsed.bid = bid;
      if (ask > 0) parsed.ask = ask;
    }
    return parsed;
  }

  return null;
}

/**
 * Manages DhanHQ WebSocket v2 (Market Feed) and Live Order Update WebSocket.
 */
class DhanWsClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.clientId = options.clientId || '';
    this.accessToken = options.accessToken || '';
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;

    this.marketWs = null;
    this.orderWs = null;
    this.isMarketConnected = false;
    this.isOrderConnected = false;
    this._shouldReconnect = false;

    this._marketReconnectTimer = null;
    this._orderReconnectTimer = null;

    // Merged tick fields keyed by securityId and `${exchangeSegmentId}:${securityId}`
    this.ticks = new Map();
    // Subscriptions keyed by `${requestCode}:${exchangeSegment}` -> Set<string>
    this._subscriptions = new Map();
  }

  updateCredentials({ clientId, accessToken }) {
    if (clientId) this.clientId = clientId;
    if (accessToken) this.accessToken = accessToken;
  }

  connect() {
    if (!this.WebSocketImpl || !this.accessToken || !this.clientId) return;
    this._shouldReconnect = true;
    this._connectMarketWs();
    this._connectOrderWs();
  }

  disconnect() {
    this._shouldReconnect = false;
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

  _connectMarketWs() {
    if (this.marketWs || !this._shouldReconnect) return;

    try {
      const url = `${DHAN_FEED_URL}?version=2&token=${encodeURIComponent(this.accessToken)}&clientId=${encodeURIComponent(this.clientId)}&authType=2`;
      const ws = new this.WebSocketImpl(url);
      ws.binaryType = 'arraybuffer';
      this.marketWs = ws;

      ws.addEventListener('open', () => {
        this.isMarketConnected = true;
        this.emit('market_connected');
        this._flushSubscriptions();
      });

      ws.addEventListener('message', event => {
        const raw = event.data;
        if (typeof raw === 'string') return;
        const handleBuffer = buf => {
          const pkt = parseDhanFeedPacket(buf);
          if (!pkt || !pkt.securityId) return;
          const prev = this.ticks.get(pkt.securityId) || {};
          const merged = { ...prev, ...pkt };
          this.ticks.set(pkt.securityId, merged);
          this.ticks.set(`${pkt.exchangeSegmentId}:${pkt.securityId}`, merged);
          this.emit('tick', merged);
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

      ws.addEventListener('error', () => {});
    } catch (e) {
      this.marketWs = null;
      this.isMarketConnected = false;
    }
  }

  _connectOrderWs() {
    if (this.orderWs || !this._shouldReconnect) return;

    try {
      const ws = new this.WebSocketImpl(DHAN_ORDER_URL);
      this.orderWs = ws;

      ws.addEventListener('open', () => {
        try {
          ws.send(JSON.stringify({
            LoginReq: {
              MsgCode: 42,
              ClientId: String(this.clientId),
              Token: String(this.accessToken)
            },
            UserType: 'SELF'
          }));
        } catch (e) {}
        this.isOrderConnected = true;
        this.emit('order_ws_connected');
      });

      ws.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        const trimmed = event.data.trim();
        if (!trimmed) return;
        try {
          const msg = JSON.parse(trimmed);
          if (msg && (msg.Type === 'order_alert' || msg.Data || msg.orderId)) {
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

  /**
   * Subscribe instruments on DhanHQ v2 WebSocket (batches of up to 100 instruments).
   * @param {number} requestCode 15=Ticker, 17=Quote, 21=Full
   * @param {Array<{ExchangeSegment: string, SecurityId: string}>} instrumentList
   */
  subscribe(requestCode = 21, instrumentList = []) {
    const newlyAdded = [];
    for (const item of instrumentList) {
      if (!item || !item.ExchangeSegment || !item.SecurityId) continue;
      const seg = String(item.ExchangeSegment).toUpperCase();
      const id = String(item.SecurityId).trim();
      const key = `${requestCode}:${seg}`;
      let set = this._subscriptions.get(key);
      if (!set) {
        set = new Set();
        this._subscriptions.set(key, set);
      }
      if (!set.has(id)) {
        set.add(id);
        newlyAdded.push({ ExchangeSegment: seg, SecurityId: id });
      }
    }

    if (newlyAdded.length > 0 && this.isMarketConnected && this.marketWs) {
      this._sendSubscribe(requestCode, newlyAdded);
    }
  }

  _sendSubscribe(requestCode, instrumentList) {
    if (!this.marketWs || !this.isMarketConnected || instrumentList.length === 0) return;
    for (let i = 0; i < instrumentList.length; i += 100) {
      const chunk = instrumentList.slice(i, i + 100);
      try {
        this.marketWs.send(JSON.stringify({
          RequestCode: requestCode,
          InstrumentCount: chunk.length,
          InstrumentList: chunk
        }));
      } catch (e) {}
    }
  }

  _flushSubscriptions() {
    const byCode = new Map();
    for (const [key, set] of this._subscriptions.entries()) {
      const [codeStr, seg] = key.split(':');
      const code = Number(codeStr);
      if (!byCode.has(code)) byCode.set(code, []);
      for (const id of set) {
        byCode.get(code).push({ ExchangeSegment: seg, SecurityId: id });
      }
    }
    for (const [code, list] of byCode.entries()) {
      this._sendSubscribe(code, list);
    }
  }

  getTick(securityId, exchangeSegment = null) {
    if (!securityId) return null;
    if (exchangeSegment) {
      const exId = DHAN_EXCHANGE_SEGMENT_TO_ID[String(exchangeSegment).toUpperCase()];
      if (exId !== undefined) {
        const hit = this.ticks.get(`${exId}:${String(securityId).trim()}`);
        if (hit) return hit;
      }
    }
    return this.ticks.get(String(securityId).trim()) || null;
  }
}

module.exports = {
  DhanWsClient,
  parseDhanFeedPacket,
  DHAN_EXCHANGE_SEGMENT_TO_ID,
  DHAN_FEED_URL,
  DHAN_ORDER_URL
};
