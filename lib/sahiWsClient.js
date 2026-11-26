const EventEmitter = require('events');

const SAHI_MARKET_WS_URL = 'wss://direct.sahi.com/v1/stream/marketdata';
const SAHI_ORDER_WS_URL = 'wss://direct.sahi.com/v1/stream/orders';

const SAHI_MODE = {
  INVALID: 0,
  LTP: 1,
  QUOTE: 2,
  DEPTH: 3
};

const EXCHANGE_SEGMENT_NAMES = {
  1: 'NSE',
  2: 'BSE',
  3: 'NFO',
  4: 'BFO'
};

const INSTRUMENT_TYPE_NAMES = {
  1: 'INDEX',
  2: 'STOCK',
  3: 'ETF',
  4: 'INDEX_FUT',
  5: 'INDEX_OPT_CE',
  6: 'INDEX_OPT_PE',
  7: 'STOCK_FUT',
  8: 'STOCK_OPT_CE',
  9: 'STOCK_OPT_PE'
};

/* ============================================================
   MINIMAL ZERO-DEPENDENCY PROTOBUF WIRE CODEC (sahi.direct.marketdata.v1)
   Uses BigInt so 64-bit timestamps, paise prices, and IDs never truncate.
   ============================================================ */

function encodeVarintBigInt(value) {
  let v = BigInt(value);
  if (v < 0n) {
    v = BigInt.asUintN(64, v);
  }
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return bytes;
}

function encodePackedInt64Field(fieldNum, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const inner = [];
  for (const id of ids) {
    const n = Number(id);
    if (!Number.isFinite(n)) continue;
    inner.push(...encodeVarintBigInt(BigInt(Math.trunc(n))));
  }
  if (inner.length === 0) return [];
  return [
    ...encodeVarintBigInt((fieldNum << 3) | 2),
    ...encodeVarintBigInt(inner.length),
    ...inner
  ];
}

function encodeLengthDelimitedField(fieldNum, bodyBytes) {
  return [
    ...encodeVarintBigInt((fieldNum << 3) | 2),
    ...encodeVarintBigInt(bodyBytes.length),
    ...bodyBytes
  ];
}

function encodeClientSubscribe(mode, instrumentIds) {
  const modeVal = Number(mode) || SAHI_MODE.QUOTE;
  const subBytes = [
    ...encodeVarintBigInt((1 << 3) | 0),
    ...encodeVarintBigInt(modeVal),
    ...encodePackedInt64Field(2, instrumentIds)
  ];
  return Uint8Array.from(encodeLengthDelimitedField(1, subBytes));
}

function encodeClientUnsubscribe(instrumentIds) {
  const unsubBytes = encodePackedInt64Field(1, instrumentIds);
  return Uint8Array.from(encodeLengthDelimitedField(2, unsubBytes));
}

function encodeClientModeChange(mode, instrumentIds) {
  const modeVal = Number(mode) || SAHI_MODE.QUOTE;
  const msgBytes = [
    ...encodeVarintBigInt((1 << 3) | 0),
    ...encodeVarintBigInt(modeVal),
    ...encodePackedInt64Field(2, instrumentIds)
  ];
  return Uint8Array.from(encodeLengthDelimitedField(3, msgBytes));
}

function readVarint(u8, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < u8.length) {
    const byte = u8[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: BigInt.asIntN(64, result), next: pos };
    }
    shift += 7n;
    if (shift > 70n) break;
  }
  return { value: 0n, next: u8.length };
}

function skipWireField(u8, offset, wireType) {
  if (wireType === 0) {
    return readVarint(u8, offset).next;
  }
  if (wireType === 1) {
    return Math.min(u8.length, offset + 8);
  }
  if (wireType === 2) {
    const lenRes = readVarint(u8, offset);
    return Math.min(u8.length, lenRes.next + Number(lenRes.value));
  }
  if (wireType === 5) {
    return Math.min(u8.length, offset + 4);
  }
  return u8.length;
}

function toUint8Array(input) {
  if (!input) return null;
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Buffer.isBuffer(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

function decodeDepthLevel(u8, start, end) {
  let pos = start;
  const level = { price: 0, qty: 0, numOrders: 0 };
  while (pos < end) {
    const tagRes = readVarint(u8, pos);
    pos = tagRes.next;
    const tag = Number(tagRes.value);
    const field = tag >>> 3;
    const wire = tag & 0x07;
    if (wire !== 0) {
      pos = skipWireField(u8, pos, wire);
      continue;
    }
    const valRes = readVarint(u8, pos);
    pos = valRes.next;
    if (field === 1) level.price = Number((Number(valRes.value) / 100).toFixed(2));
    else if (field === 2) level.qty = Number(valRes.value);
    else if (field === 3) level.numOrders = Number(valRes.value);
  }
  return level;
}

function decodeTickMessage(u8, start, end, kind) {
  let pos = start;
  const tick = {
    type: kind,
    instrumentId: null,
    exchangeSegment: null,
    instrumentType: null,
    ltp: 0,
    lastTradeTime: null,
    volume: 0,
    dprUpper: null,
    dprLower: null,
    prevOi: null,
    oi: null,
    bestBuys: [],
    bestSells: [],
    bid: null,
    ask: null,
    totalBuyQty: 0,
    totalSellQty: 0,
    receivedAt: Date.now()
  };

  while (pos < end) {
    const tagRes = readVarint(u8, pos);
    pos = tagRes.next;
    const tag = Number(tagRes.value);
    const field = tag >>> 3;
    const wire = tag & 0x07;

    if (wire === 0) {
      const valRes = readVarint(u8, pos);
      pos = valRes.next;
      const n = Number(valRes.value);
      if (field === 1) tick.instrumentId = n;
      else if (field === 2) tick.exchangeSegment = EXCHANGE_SEGMENT_NAMES[n] || String(n);
      else if (field === 3) tick.instrumentType = INSTRUMENT_TYPE_NAMES[n] || String(n);
      else if (field === 4) tick.ltp = Number((n / 100).toFixed(2));
      else if (field === 5) tick.lastTradeTime = n;
      else if (field === 6) tick.volume = n;
      else if (field === 7) tick.dprUpper = Number((n / 100).toFixed(2));
      else if (field === 8) tick.dprLower = Number((n / 100).toFixed(2));
      else if (field === 9) tick.prevOi = n;
      else if (field === 10) tick.oi = n;
      else if (field === 13) tick.totalBuyQty = n;
      else if (field === 14) tick.totalSellQty = n;
    } else if (wire === 2 && (field === 11 || field === 12)) {
      const lenRes = readVarint(u8, pos);
      pos = lenRes.next;
      const subEnd = Math.min(end, pos + Number(lenRes.value));
      const lvl = decodeDepthLevel(u8, pos, subEnd);
      pos = subEnd;
      if (field === 11) tick.bestBuys.push(lvl);
      else tick.bestSells.push(lvl);
    } else {
      pos = skipWireField(u8, pos, wire);
    }
  }

  if (tick.bestBuys.length > 0 && tick.bestBuys[0].price > 0) tick.bid = tick.bestBuys[0].price;
  if (tick.bestSells.length > 0 && tick.bestSells[0].price > 0) tick.ask = tick.bestSells[0].price;

  return tick;
}

function decodeAckMessage(u8, start, end) {
  let pos = start;
  const ack = { type: 'ack', action: 0, instrumentIds: [] };
  while (pos < end) {
    const tagRes = readVarint(u8, pos);
    pos = tagRes.next;
    const tag = Number(tagRes.value);
    const field = tag >>> 3;
    const wire = tag & 0x07;
    if (field === 1 && wire === 0) {
      const valRes = readVarint(u8, pos);
      pos = valRes.next;
      ack.action = Number(valRes.value);
    } else if (field === 2 && wire === 0) {
      const valRes = readVarint(u8, pos);
      pos = valRes.next;
      ack.instrumentIds.push(Number(valRes.value));
    } else if (field === 2 && wire === 2) {
      const lenRes = readVarint(u8, pos);
      pos = lenRes.next;
      const subEnd = Math.min(end, pos + Number(lenRes.value));
      while (pos < subEnd) {
        const valRes = readVarint(u8, pos);
        pos = valRes.next;
        ack.instrumentIds.push(Number(valRes.value));
      }
    } else {
      pos = skipWireField(u8, pos, wire);
    }
  }
  return ack;
}

function decodeStreamErrorMessage(u8, start, end) {
  let pos = start;
  const err = { type: 'error', code: '', message: '' };
  while (pos < end) {
    const tagRes = readVarint(u8, pos);
    pos = tagRes.next;
    const tag = Number(tagRes.value);
    const field = tag >>> 3;
    const wire = tag & 0x07;
    if (wire === 2 && (field === 1 || field === 2)) {
      const lenRes = readVarint(u8, pos);
      pos = lenRes.next;
      const subEnd = Math.min(end, pos + Number(lenRes.value));
      const str = Buffer.from(u8.subarray(pos, subEnd)).toString('utf8');
      pos = subEnd;
      if (field === 1) err.code = str;
      else err.message = str;
    } else {
      pos = skipWireField(u8, pos, wire);
    }
  }
  return err;
}

function decodeServerMessage(input) {
  const u8 = toUint8Array(input);
  if (!u8 || u8.length === 0) return null;

  let pos = 0;
  while (pos < u8.length) {
    const tagRes = readVarint(u8, pos);
    pos = tagRes.next;
    const tag = Number(tagRes.value);
    const field = tag >>> 3;
    const wire = tag & 0x07;

    if (wire !== 2) {
      pos = skipWireField(u8, pos, wire);
      continue;
    }

    const lenRes = readVarint(u8, pos);
    pos = lenRes.next;
    const subEnd = Math.min(u8.length, pos + Number(lenRes.value));

    if (field === 1) return decodeAckMessage(u8, pos, subEnd);
    if (field === 2) return decodeTickMessage(u8, pos, subEnd, 'ltp_tick');
    if (field === 3) return decodeTickMessage(u8, pos, subEnd, 'quote_tick');
    if (field === 4) return decodeTickMessage(u8, pos, subEnd, 'depth_tick');
    if (field === 5) return decodeStreamErrorMessage(u8, pos, subEnd);

    pos = subEnd;
  }
  return null;
}

/**
 * Manages Sahi Direct WebSocket streams:
 * - Market Data Tick Stream (wss://direct.sahi.com/v1/stream/marketdata, binary Protobuf)
 * - Live Order Updates Stream (wss://direct.sahi.com/v1/stream/orders, JSON text)
 */
class SahiWsClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.accessToken = options.accessToken || '';
    this.marketUrl = options.marketUrl || SAHI_MARKET_WS_URL;
    this.orderUrl = options.orderUrl || SAHI_ORDER_WS_URL;
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;

    this.marketWs = null;
    this.orderWs = null;
    this.isMarketConnected = false;
    this.isOrderConnected = false;
    this._shouldReconnect = false;

    this._marketReconnectTimer = null;
    this._orderReconnectTimer = null;

    // Keyed by String(instrumentId)
    this.ticks = new Map();
    // Map<number, Set<number>> mode -> instrumentIds
    this._subscriptions = new Map();
  }

  updateCredentials({ accessToken } = {}) {
    if (accessToken !== undefined) this.accessToken = accessToken || '';
  }

  _authHeaders() {
    const token = this.accessToken.startsWith('Bearer ')
      ? this.accessToken
      : `Bearer ${this.accessToken}`;
    return { Authorization: token };
  }

  connect() {
    if (!this.WebSocketImpl || !this.accessToken) return;
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
      try { this.marketWs.close(1000, 'disconnect'); } catch (e) {}
      this.marketWs = null;
    }
    if (this.orderWs) {
      try { this.orderWs.close(1000, 'disconnect'); } catch (e) {}
      this.orderWs = null;
    }
    this.isMarketConnected = false;
    this.isOrderConnected = false;
  }

  _connectMarketWs() {
    if (this.marketWs || !this.accessToken || !this._shouldReconnect) return;

    try {
      const ws = new this.WebSocketImpl(this.marketUrl, {
        headers: this._authHeaders()
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
        if (typeof raw === 'string') return;
        const handleBuf = buf => {
          const msg = decodeServerMessage(buf);
          if (!msg) return;
          if (msg.type === 'error') {
            this.emit('stream_error', msg);
            return;
          }
          if (msg.type === 'ack') {
            this.emit('ack', msg);
            return;
          }
          if (msg.instrumentId !== null && msg.instrumentId !== undefined) {
            this.ticks.set(String(msg.instrumentId), msg);
            this.emit('tick', msg);
          }
        };
        if (raw && typeof raw.arrayBuffer === 'function') {
          raw.arrayBuffer().then(handleBuf).catch(() => {});
        } else {
          handleBuf(raw);
        }
      });

      ws.addEventListener('close', ev => {
        this.isMarketConnected = false;
        this.marketWs = null;
        const code = ev && ev.code ? Number(ev.code) : 1000;
        if (code === 4401 || code === 4403) {
          this.emit('auth_closed', { stream: 'marketdata', code });
          this._shouldReconnect = false;
          return;
        }
        if (this._shouldReconnect && !this._marketReconnectTimer) {
          this._marketReconnectTimer = setTimeout(() => {
            this._marketReconnectTimer = null;
            this._connectMarketWs();
          }, 5000);
        }
      });

      ws.addEventListener('error', () => {});
    } catch (err) {
      this.marketWs = null;
      this.isMarketConnected = false;
    }
  }

  _connectOrderWs() {
    if (this.orderWs || !this.accessToken || !this._shouldReconnect) return;

    try {
      const ws = new this.WebSocketImpl(this.orderUrl, {
        headers: this._authHeaders()
      });
      this.orderWs = ws;

      ws.addEventListener('open', () => {
        this.isOrderConnected = true;
        this.emit('order_ws_connected');
      });

      ws.addEventListener('message', event => {
        const raw = event.data;
        if (typeof raw !== 'string') return;
        try {
          const msg = JSON.parse(raw);
          if (msg && msg.order_id) {
            this.emit('order_update', msg);
          }
        } catch (e) {}
      });

      ws.addEventListener('close', ev => {
        this.isOrderConnected = false;
        this.orderWs = null;
        const code = ev && ev.code ? Number(ev.code) : 1000;
        if (code === 4401 || code === 4403) {
          this.emit('auth_closed', { stream: 'orders', code });
          return;
        }
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

  subscribe(mode = SAHI_MODE.QUOTE, instrumentIds = []) {
    if (!Array.isArray(instrumentIds) || instrumentIds.length === 0) return;
    const modeNum = Number(mode) || SAHI_MODE.QUOTE;
    if (!this._subscriptions.has(modeNum)) {
      this._subscriptions.set(modeNum, new Set());
    }
    const existing = this._subscriptions.get(modeNum);
    const newlyAdded = [];
    for (const id of instrumentIds) {
      const n = Number(id);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (!existing.has(n)) {
        existing.add(n);
        newlyAdded.push(n);
      }
    }

    if (newlyAdded.length > 0 && this.marketWs && this.isMarketConnected) {
      this._sendSubscribeBatches(modeNum, newlyAdded);
    }
  }

  _sendSubscribeBatches(mode, ids) {
    if (!this.marketWs || !this.isMarketConnected || !ids || ids.length === 0) return;
    // Sahi allows up to 1000 instrument_ids per connection; batch comfortably at 200 per frame
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      try {
        const frame = encodeClientSubscribe(mode, batch);
        this.marketWs.send(frame);
      } catch (e) {}
    }
  }

  _flushSubscriptions() {
    if (!this.marketWs || !this.isMarketConnected) return;
    for (const [mode, set] of this._subscriptions.entries()) {
      if (set.size > 0) {
        this._sendSubscribeBatches(mode, Array.from(set));
      }
    }
  }

  getTick(instrumentId) {
    if (instrumentId === undefined || instrumentId === null) return null;
    return this.ticks.get(String(instrumentId)) || null;
  }
}

module.exports = {
  SahiWsClient,
  SAHI_MODE,
  SAHI_MARKET_WS_URL,
  SAHI_ORDER_WS_URL,
  encodeClientSubscribe,
  encodeClientUnsubscribe,
  encodeClientModeChange,
  decodeServerMessage
};
