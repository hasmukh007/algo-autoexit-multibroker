const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { DatabaseSync } = require('node:sqlite');
const { getISTInfo } = require('./niftyFeedManager');

const DEFAULT_SCRIP_DB_PATH = path.join(__dirname, '..', 'data', 'scrip-master.db');
const SAHI_CSV_URL = 'https://assets.sahi.com/external/instruments.csv';
const ANGEL_JSON_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const DHAN_CSV_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

// Baseline fallback exchange limits when an external feed has not loaded yet
const UNDERLYING_DEFAULTS = {
  NIFTY: { lotSize: 65, freezeQty: 1800 },
  BANKNIFTY: { lotSize: 30, freezeQty: 600 },
  FINNIFTY: { lotSize: 65, freezeQty: 1800 },
  MIDCPNIFTY: { lotSize: 120, freezeQty: 2800 },
  NIFTYNXT50: { lotSize: 25, freezeQty: 600 },
  SENSEX: { lotSize: 20, freezeQty: 1000 },
  BANKEX: { lotSize: 30, freezeQty: 900 }
};

function normalizeSegment(segment) {
  const s = String(segment || '').trim().toUpperCase();
  if (s === 'NFO' || s === 'NSE_FO' || s === 'NSE_FNO' || s === 'NSEFO') return 'NFO';
  if (s === 'BFO' || s === 'BSE_FO' || s === 'BSE_FNO' || s === 'BSEFO') return 'BFO';
  if (s === 'BSE' || s === 'BSE_CM' || s === 'BSE_EQ' || s === 'BSECM') return 'BSE';
  if (s === 'MCX' || s === 'MCX_FO') return 'MCX';
  return 'NSE';
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function inferUnderlyingFromSymbol(symbol = '') {
  const s = String(symbol || '').trim().toUpperCase();
  for (const key of ['BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX', 'NIFTY']) {
    if (s.startsWith(key)) return key;
  }
  const match = s.match(/^([A-Z0-9&_-]+?)(?:\d{2}[A-Z]{3}|\d{5}|-EQ|-BE)/);
  return match ? match[1] : s;
}

/**
 * Split an order quantity into freeze-quantity compliant chunks, aligned cleanly to lotSize.
 */
function splitQuantityByFreeze(quantity, freezeQty, lotSize = 1) {
  const qty = Math.round(Number(quantity || 0));
  if (!Number.isFinite(qty) || qty <= 0) return [];

  const lot = Math.max(1, Math.round(Number(lotSize || 1)));
  const freeze = Math.max(0, Math.round(Number(freezeQty || 0)));
  if (freeze <= 0 || qty <= freeze) {
    return [qty];
  }

  const maxSlice = lot > 1 ? Math.max(lot, Math.floor(freeze / lot) * lot) : freeze;
  const slices = [];
  let remaining = qty;
  while (remaining > 0) {
    const chunk = Math.min(remaining, maxSlice);
    slices.push(chunk);
    remaining -= chunk;
  }
  return slices;
}

function roundToTick(val, tick = 0.05) {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const step = Number(tick) > 0 ? Number(tick) : 0.05;
  return Number((Math.round(n / step) * step).toFixed(2));
}

/**
 * Resolve effective execution & sizing prices based on orderType ('MKT' | 'L' | 'SL') and side ('B' | 'S'):
 * - MKT: sizes using current live LTP (`ltp`), places order at market (`price: 0`).
 * - L (Limit): defaults limit price to LTP + 0.5 (Buy) or LTP - 0.5 (Sell) if omitted, sizes using limit price.
 * - SL (SL-LMT): asks for Trigger + Limit price; defaults limit price to Trigger + 0.5 (Buy) or Trigger - 0.5 (Sell), sizes using limit price.
 */
function resolveOrderTypePricing({
  orderType = 'MKT',
  transactionType = 'B',
  price = 0,
  triggerPrice = 0,
  ltp = 0,
  offset = 0.5
} = {}) {
  const ot = String(orderType || 'MKT').trim().toUpperCase();
  const side = String(transactionType || 'B').trim().toUpperCase() === 'S' ? 'S' : 'B';
  const liveLtp = Number(ltp || 0);
  const delta = side === 'S' ? -Math.abs(Number(offset || 0.5)) : Math.abs(Number(offset || 0.5));

  if (ot === 'MKT' || ot === 'MARKET') {
    const sizingPrice = liveLtp > 0 ? liveLtp : Number(price || 0);
    return {
      orderType: 'MKT',
      sizingPrice: roundToTick(sizingPrice),
      orderPrice: 0,
      triggerPrice: 0
    };
  }

  if (ot === 'SL' || ot === 'SL-LMT' || ot === 'STOPLOSS_LIMIT') {
    const resolvedTrigger = Number(triggerPrice) > 0 ? roundToTick(triggerPrice) : roundToTick(liveLtp);
    const defaultLimit = resolvedTrigger > 0 ? roundToTick(Math.max(0.05, resolvedTrigger + delta)) : 0;
    const resolvedLimit = Number(price) > 0 ? roundToTick(price) : defaultLimit;
    return {
      orderType: 'SL',
      sizingPrice: resolvedLimit > 0 ? resolvedLimit : resolvedTrigger,
      orderPrice: resolvedLimit,
      triggerPrice: resolvedTrigger
    };
  }

  // Limit order ('L' / 'LMT' / 'LIMIT')
  const defaultLimit = liveLtp > 0 ? roundToTick(Math.max(0.05, liveLtp + delta)) : 0;
  const resolvedLimit = Number(price) > 0 ? roundToTick(price) : defaultLimit;
  return {
    orderType: 'L',
    sizingPrice: resolvedLimit > 0 ? resolvedLimit : roundToTick(liveLtp),
    orderPrice: resolvedLimit,
    triggerPrice: 0
  };
}

/**
 * Calculate maximum affordable quantity in valid lot multiples given available broker cash and price.
 */
function calculateOrderQuantity({
  availableCash = 0,
  price = 0,
  triggerPrice = 0,
  ltp = 0,
  orderType = 'MKT',
  transactionType = 'B',
  lotSize = 1,
  freezeQty = 0,
  allocationPct = 100,
  bufferPct = 0
} = {}) {
  const cash = Math.max(0, Number(availableCash || 0));
  const pricing = resolveOrderTypePricing({ orderType, transactionType, price, triggerPrice, ltp });
  const unitPrice = pricing.sizingPrice;
  const lot = Math.max(1, Math.round(Number(lotSize || 1)));
  const freeze = Math.max(0, Math.round(Number(freezeQty || 0)));
  const alloc = Math.max(0, Math.min(100, Number(allocationPct || 100)));
  const buf = Math.max(0, Math.min(50, Number(bufferPct || 0)));
  const usableCash = Number((cash * (alloc / 100) * (1 - buf / 100)).toFixed(2));

  if (!(usableCash > 0) || !(unitPrice > 0)) {
    return {
      availableCash: cash,
      usableCash,
      price: unitPrice > 0 ? unitPrice : 0,
      orderType: pricing.orderType,
      orderPrice: pricing.orderPrice,
      triggerPrice: pricing.triggerPrice,
      lotSize: lot,
      freezeQty: freeze,
      lots: 0,
      quantity: 0,
      slices: [],
      sliceCount: 0,
      estimatedCost: 0
    };
  }

  const rawUnits = Math.floor(usableCash / unitPrice);
  const lots = Math.floor(rawUnits / lot);
  const quantity = lots * lot;
  const slices = splitQuantityByFreeze(quantity, freeze, lot);

  return {
    availableCash: cash,
    usableCash,
    price: unitPrice,
    orderType: pricing.orderType,
    orderPrice: pricing.orderPrice,
    triggerPrice: pricing.triggerPrice,
    lotSize: lot,
    freezeQty: freeze,
    lots,
    quantity,
    slices,
    sliceCount: slices.length,
    estimatedCost: Number((quantity * unitPrice).toFixed(2))
  };
}

/**
 * Downloads & caches multi-broker Scrip Masters daily at 08:55 AM IST,
 * resolving instrument lot sizes and exchange freeze quantities across Kotak, Angel One, Dhan, and Sahi.
 */
class ScripMasterManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dbPath = options.dbPath || DEFAULT_SCRIP_DB_PATH;
    this.sahiCsvUrl = options.sahiCsvUrl || SAHI_CSV_URL;
    this.angelJsonUrl = options.angelJsonUrl || ANGEL_JSON_URL;
    this.dhanCsvUrl = options.dhanCsvUrl || DHAN_CSV_URL;

    this.targetHourIST = options.targetHourIST !== undefined ? options.targetHourIST : 8;
    this.targetMinuteIST = options.targetMinuteIST !== undefined ? options.targetMinuteIST : 55;
    this.checkIntervalMs = options.checkIntervalMs || 15000;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this._initSchema();

    this.lastRunDate = this._getMeta('last_download_date');
    this.lastDownloadAt = this._getMeta('last_download_at');
    this.instrumentCount = Number(this._getMeta('instrument_count') || this._countRows());
    this.isDownloading = false;
    this._downloadInflight = null;
    this.timer = null;

    if (!options.disableTimers) {
      this.start();
    }
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instruments (
        symbol TEXT NOT NULL,
        segment TEXT NOT NULL,
        token TEXT NOT NULL DEFAULT '',
        underlying TEXT NOT NULL DEFAULT '',
        instrument_type TEXT NOT NULL DEFAULT '',
        lot_size INTEGER NOT NULL DEFAULT 1,
        freeze_qty INTEGER NOT NULL DEFAULT 0,
        tick_size REAL NOT NULL DEFAULT 0.05,
        source TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (symbol, segment)
      );
      CREATE INDEX IF NOT EXISTS idx_inst_token ON instruments (token, segment);
      CREATE INDEX IF NOT EXISTS idx_inst_underlying ON instruments (underlying, segment, instrument_type);
    `);

    this._stmtUpsert = this.db.prepare(`
      INSERT INTO instruments (symbol, segment, token, underlying, instrument_type, lot_size, freeze_qty, tick_size, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, segment) DO UPDATE SET
        token = CASE WHEN excluded.token != '' THEN excluded.token ELSE instruments.token END,
        underlying = CASE WHEN excluded.underlying != '' THEN excluded.underlying ELSE instruments.underlying END,
        instrument_type = CASE WHEN excluded.instrument_type != '' THEN excluded.instrument_type ELSE instruments.instrument_type END,
        lot_size = CASE WHEN excluded.lot_size > 0 THEN excluded.lot_size ELSE instruments.lot_size END,
        freeze_qty = CASE WHEN excluded.freeze_qty > 0 THEN excluded.freeze_qty ELSE instruments.freeze_qty END,
        tick_size = CASE WHEN excluded.tick_size > 0 THEN excluded.tick_size ELSE instruments.tick_size END,
        source = excluded.source
    `);
  }

  _getMeta(key) {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
    return row ? row.value : null;
  }

  _setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  _countRows() {
    const row = this.db.prepare(`SELECT COUNT(*) AS cnt FROM instruments`).get();
    return Number((row && row.cnt) || 0);
  }

  start() {
    this.stop();
    this._checkAndTrigger().catch(() => {});
    this.timer = setInterval(() => {
      this._checkAndTrigger().catch(() => {});
    }, this.checkIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _checkAndTrigger(now = new Date()) {
    const ist = getISTInfo(now);
    const isPastTarget = ist.hours > this.targetHourIST ||
      (ist.hours === this.targetHourIST && ist.minutes >= this.targetMinuteIST);

    if (!isPastTarget || this.lastRunDate === ist.dateStr || this.isDownloading) {
      return { triggered: false, dateStr: ist.dateStr, lastRunDate: this.lastRunDate };
    }

    const result = await this.downloadAll(now);
    return { triggered: true, dateStr: ist.dateStr, ...result };
  }

  /**
   * Upsert normalized records: { symbol, segment, token, underlying, instrumentType, lotSize, freezeQty, tickSize, source }
   */
  upsertRecords(records = []) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    let count = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of records) {
        const symbol = String(r.symbol || '').trim().toUpperCase();
        if (!symbol) continue;
        const segment = normalizeSegment(r.segment);
        const token = String(r.token || '').trim();
        const underlying = String(r.underlying || '').trim().toUpperCase();
        const instType = String(r.instrumentType || '').trim().toUpperCase();
        const lotSize = Math.max(1, Math.round(Number(r.lotSize || 1)));
        const freezeQty = Math.max(0, Math.round(Number(r.freezeQty || 0)));
        const tickSize = Number(r.tickSize || 0.05) || 0.05;
        this._stmtUpsert.run(symbol, segment, token, underlying, instType, lotSize, freezeQty, tickSize, r.source || 'manual');
        count++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.instrumentCount = this._countRows();
    return count;
  }

  _parseSahiCsvText(text) {
    const lines = String(text || '').split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]).map(h => h.trim());
    const idxId = headers.indexOf('id');
    const idxSym = headers.indexOf('symbol');
    const idxUnderlying = headers.indexOf('underlying_symbol');
    const idxSeg = headers.indexOf('segment');
    const idxInstType = headers.indexOf('instrument_type');
    const idxLot = headers.indexOf('lot_size');
    const idxFreeze = headers.indexOf('freeze_quantity');
    const idxTick = headers.indexOf('tick_size');

    const records = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cols = parseCsvLine(lines[i]);
      if (cols.length < 10) continue;
      const symbol = String(cols[idxSym] || '').trim();
      if (!symbol) continue;
      const segment = normalizeSegment(cols[idxSeg]);
      const instType = String(cols[idxInstType] || '').trim().toUpperCase();
      if (instType === 'IDX') continue;
      records.push({
        symbol,
        segment,
        token: String(cols[idxId] || '').trim(),
        underlying: String(cols[idxUnderlying] || '').trim(),
        instrumentType: instType,
        lotSize: Math.max(1, Math.round(Number(cols[idxLot] || 1))),
        freezeQty: Math.max(0, Math.round(Number(cols[idxFreeze] || 0))),
        tickSize: Number(cols[idxTick] || 0.05) || 0.05,
        source: 'sahi'
      });
    }
    return records;
  }

  _parseAngelJsonList(list) {
    if (!Array.isArray(list)) return [];
    const records = [];
    for (const item of list) {
      if (!item || !item.symbol) continue;
      const segment = normalizeSegment(item.exch_seg);
      records.push({
        symbol: String(item.symbol).trim(),
        segment,
        token: String(item.token || '').trim(),
        underlying: String(item.name || '').trim(),
        instrumentType: String(item.instrumenttype || '').trim(),
        lotSize: Math.max(1, Math.round(Number(item.lotsize || 1))),
        freezeQty: 0,
        tickSize: Number(item.tick_size || 5) >= 1 ? Number(item.tick_size) / 100 : 0.05,
        source: 'angelone'
      });
    }
    return records;
  }

  _parseDhanCsvText(text) {
    const lines = String(text || '').split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim());
    const idxEx = headers.indexOf('SEM_EXM_EXCH_ID');
    const idxInst = headers.indexOf('SEM_INSTRUMENT_NAME');
    const idxSym = headers.indexOf('SEM_TRADING_SYMBOL');
    const idxId = headers.indexOf('SEM_SMST_SECURITY_ID');
    const idxLot = headers.indexOf('SEM_LOT_UNITS');
    const idxTick = headers.indexOf('SEM_TICK_SIZE');
    if (idxSym === -1 || idxEx === -1) return [];

    const records = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cols = lines[i].split(',');
      const symbol = String(cols[idxSym] || '').trim();
      if (!symbol) continue;
      const ex = String(cols[idxEx] || '').trim().toUpperCase();
      const instType = String(cols[idxInst] || '').trim().toUpperCase();
      const isFno = instType.includes('FUT') || instType.includes('OPT');
      const segment = ex === 'BSE' ? (isFno ? 'BFO' : 'BSE') : (isFno ? 'NFO' : 'NSE');
      records.push({
        symbol,
        segment,
        token: String(cols[idxId] || '').trim(),
        underlying: inferUnderlyingFromSymbol(symbol),
        instrumentType: instType,
        lotSize: Math.max(1, Math.round(Number((idxLot !== -1 ? cols[idxLot] : 1) || 1))),
        freezeQty: 0,
        tickSize: (idxTick !== -1 && Number(cols[idxTick]) > 0) ? Number(cols[idxTick]) : 0.05,
        source: 'dhan'
      });
    }
    return records;
  }

  async _fetchText(url, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Download public Scrip Masters (Sahi + Angel One + Dhan), load lot sizes and freeze quantities.
   */
  async downloadAll(now = new Date()) {
    if (this._downloadInflight) return await this._downloadInflight;

    this.isDownloading = true;
    const ist = getISTInfo(now);
    const stats = { sahi: 0, angelone: 0, dhan: 0, errors: [] };

    this._downloadInflight = (async () => {
      try {
        try {
          const csv = await this._fetchText(this.sahiCsvUrl, 25000);
          const recs = this._parseSahiCsvText(csv);
          stats.sahi = this.upsertRecords(recs);
        } catch (err) {
          stats.errors.push(`sahi: ${err.message}`);
        }

        try {
          const jsonText = await this._fetchText(this.angelJsonUrl, 25000);
          const parsed = JSON.parse(jsonText);
          const recs = this._parseAngelJsonList(parsed);
          stats.angelone = this.upsertRecords(recs);
        } catch (err) {
          stats.errors.push(`angelone: ${err.message}`);
        }

        try {
          const dhanCsv = await this._fetchText(this.dhanCsvUrl, 25000);
          const recs = this._parseDhanCsvText(dhanCsv);
          stats.dhan = this.upsertRecords(recs);
        } catch (err) {
          stats.errors.push(`dhan: ${err.message}`);
        }

        this.lastRunDate = ist.dateStr;
        this.lastDownloadAt = now.toISOString();
        this.instrumentCount = this._countRows();
        this._setMeta('last_download_date', this.lastRunDate);
        this._setMeta('last_download_at', this.lastDownloadAt);
        this._setMeta('instrument_count', this.instrumentCount);

        const summary = {
          dateStr: ist.dateStr,
          timeIST: ist.timeFormatted,
          instrumentCount: this.instrumentCount,
          stats
        };
        this.emit('scrip_master_loaded', summary);
        return summary;
      } finally {
        this.isDownloading = false;
        this._downloadInflight = null;
      }
    })();

    return await this._downloadInflight;
  }

  /**
   * Look up lotSize and freezeQty for any contract by symbol/token/underlying.
   */
  getContractSpec({ symbol = '', underlying = '', exchangeSegment = '', instrumentToken = '' } = {}) {
    const sym = String(symbol || '').trim().toUpperCase();
    const seg = exchangeSegment ? normalizeSegment(exchangeSegment) : '';
    const tok = String(instrumentToken || '').trim();

    let row = null;
    if (sym && seg) {
      row = this.db.prepare(`SELECT * FROM instruments WHERE symbol = ? AND segment = ? LIMIT 1`).get(sym, seg);
    }
    if (!row && sym) {
      row = this.db.prepare(`SELECT * FROM instruments WHERE symbol = ? ORDER BY freeze_qty DESC, lot_size DESC LIMIT 1`).get(sym);
    }
    if (!row && tok && seg) {
      row = this.db.prepare(`SELECT * FROM instruments WHERE token = ? AND segment = ? LIMIT 1`).get(tok, seg);
    }
    if (!row && tok) {
      row = this.db.prepare(`SELECT * FROM instruments WHERE token = ? ORDER BY freeze_qty DESC LIMIT 1`).get(tok);
    }

    const inferredUnderlying = String(
      (row && row.underlying) || underlying || inferUnderlyingFromSymbol(sym) || ''
    ).toUpperCase();

    // If matched Angel/Dhan/Kotak row has freeze_qty = 0 on an F&O derivative, inherit freeze_qty from underlying F&O rows
    let freezeQty = row ? Number(row.freeze_qty || 0) : 0;
    let lotSize = row ? Number(row.lot_size || 1) : 1;

    const isDerivative = seg === 'NFO' || seg === 'BFO' ||
      (row && (row.segment === 'NFO' || row.segment === 'BFO' || String(row.instrument_type).includes('OPT') || String(row.instrument_type).includes('FUT'))) ||
      /CE$|PE$|FUT$/.test(sym);

    if (isDerivative && inferredUnderlying) {
      if (freezeQty <= 0) {
        const freezeRow = this.db.prepare(`
          SELECT MAX(freeze_qty) AS fq, MAX(lot_size) AS ls
          FROM instruments
          WHERE underlying = ? AND freeze_qty > 0
        `).get(inferredUnderlying);
        if (freezeRow && Number(freezeRow.fq) > 0) {
          freezeQty = Number(freezeRow.fq);
        }
      }
      const def = UNDERLYING_DEFAULTS[inferredUnderlying];
      if (def) {
        if (!row && lotSize <= 1) lotSize = def.lotSize;
        if (freezeQty <= 0) freezeQty = def.freezeQty;
      }
    }

    return {
      symbol: sym,
      segment: seg || (row && row.segment) || 'NSE',
      underlying: inferredUnderlying,
      lotSize: Math.max(1, lotSize),
      freezeQty: Math.max(0, freezeQty),
      tickSize: row ? Number(row.tick_size || 0.05) : 0.05,
      source: row ? row.source : (isDerivative && UNDERLYING_DEFAULTS[inferredUnderlying] ? 'default' : 'none')
    };
  }

  getStatus() {
    return {
      lastDownloadDate: this.lastRunDate,
      lastDownloadAt: this.lastDownloadAt,
      instrumentCount: this.instrumentCount,
      scheduledTimeIST: `${String(this.targetHourIST).padStart(2, '0')}:${String(this.targetMinuteIST).padStart(2, '0')} IST`,
      isDownloading: this.isDownloading
    };
  }

  close() {
    this.stop();
    try {
      this.db.close();
    } catch (e) {}
  }
}

module.exports = {
  ScripMasterManager,
  splitQuantityByFreeze,
  calculateOrderQuantity,
  resolveOrderTypePricing,
  roundToTick,
  normalizeSegment,
  inferUnderlyingFromSymbol,
  UNDERLYING_DEFAULTS
};
