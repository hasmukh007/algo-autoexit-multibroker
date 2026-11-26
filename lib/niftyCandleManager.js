const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'candles.db');
const NIFTY_SYMBOL = 'NIFTY';
const TIMEFRAME_3M = '3m';
const INTERVAL_SEC = 180; // 3 minutes (aligns cleanly with 09:15 IST = 03:45 UTC)

/**
 * Aggregate 1-minute (or finer) OHLCV candles into 3-minute candles.
 */
function aggregateTo3MinuteCandles(candles = [], source = 'rest') {
  const buckets = new Map();
  const sorted = [...candles].sort((a, b) => Number(a.time) - Number(b.time));

  for (const c of sorted) {
    const t = Math.floor(Number(c.time));
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    const volume = Number(c.volume || 0);
    if (!Number.isFinite(t) || !Number.isFinite(open) || !Number.isFinite(close) || close <= 0) continue;

    const bucketTime = Math.floor(t / INTERVAL_SEC) * INTERVAL_SEC;
    const existing = buckets.get(bucketTime);
    if (!existing) {
      buckets.set(bucketTime, {
        time: bucketTime,
        open,
        high: Number.isFinite(high) ? high : open,
        low: Number.isFinite(low) ? low : open,
        close,
        volume,
        source: c.source || source
      });
    } else {
      existing.high = Math.max(existing.high, Number.isFinite(high) ? high : close);
      existing.low = Math.min(existing.low, Number.isFinite(low) ? low : close);
      existing.close = close;
      existing.volume += volume;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

/**
 * Manages NIFTY 3-minute OHLCV candles backed by local SQLite (`data/candles.db`):
 * - Aggregates real-time WebSocket ticks into live 3-minute candles
 * - Auto-backfills last 3 days via broker REST API when local DB has no history
 */
class NiftyCandleManager extends EventEmitter {
  constructor(multiBrokerManager, options = {}) {
    super();
    this.multiBrokerManager = multiBrokerManager;
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.symbol = options.symbol || NIFTY_SYMBOL;
    this.timeframe = options.timeframe || TIMEFRAME_3M;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this._initSchema();

    this.currentCandle = this._loadLatestCandle();
    this._lastPersistAt = 0;
    this._backfillInflight = null;
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candles (
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'ws',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (symbol, timeframe, time)
      );
      CREATE INDEX IF NOT EXISTS idx_candles_lookup
        ON candles (symbol, timeframe, time);
    `);

    this._stmtUpsert = this.db.prepare(`
      INSERT INTO candles (symbol, timeframe, time, open, high, low, close, volume, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, timeframe, time) DO UPDATE SET
        open = CASE WHEN candles.source = 'ws' AND excluded.source != 'ws' THEN candles.open ELSE excluded.open END,
        high = CASE WHEN candles.source = 'ws' AND excluded.source != 'ws' THEN candles.high ELSE MAX(candles.high, excluded.high) END,
        low = CASE WHEN candles.source = 'ws' AND excluded.source != 'ws' THEN candles.low ELSE MIN(candles.low, excluded.low) END,
        close = CASE WHEN candles.source = 'ws' AND excluded.source != 'ws' THEN candles.close ELSE excluded.close END,
        volume = CASE WHEN candles.source = 'ws' AND excluded.source != 'ws' THEN candles.volume ELSE excluded.volume END,
        source = CASE WHEN candles.source = 'ws' THEN 'ws' ELSE excluded.source END,
        updated_at = excluded.updated_at
    `);
  }

  _loadLatestCandle() {
    const row = this.db.prepare(`
      SELECT time, open, high, low, close, volume, source
      FROM candles
      WHERE symbol = ? AND timeframe = ?
      ORDER BY time DESC
      LIMIT 1
    `).get(this.symbol, this.timeframe);
    return row || null;
  }

  getCandleCount() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM candles WHERE symbol = ? AND timeframe = ?
    `).get(this.symbol, this.timeframe);
    return Number((row && row.cnt) || 0);
  }

  getCandles({ limit = 600 } = {}) {
    const rows = this.db.prepare(`
      SELECT time, open, high, low, close, volume, source
      FROM candles
      WHERE symbol = ? AND timeframe = ?
      ORDER BY time DESC
      LIMIT ?
    `).all(this.symbol, this.timeframe, Number(limit));
    return rows.reverse();
  }

  _persistCandle(candle) {
    if (!candle) return;
    this._stmtUpsert.run(
      this.symbol,
      this.timeframe,
      candle.time,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      Number(candle.volume || 0),
      candle.source || 'ws',
      Date.now()
    );
    this._lastPersistAt = Date.now();
  }

  upsertCandles(candles = []) {
    if (!Array.isArray(candles) || candles.length === 0) return 0;
    let count = 0;
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const c of candles) {
        const t = Math.floor(Number(c.time));
        if (!Number.isFinite(t) || !(Number(c.close) > 0)) continue;
        this._stmtUpsert.run(
          this.symbol,
          this.timeframe,
          t,
          Number(c.open),
          Number(c.high),
          Number(c.low),
          Number(c.close),
          Number(c.volume || 0),
          c.source || 'rest',
          now
        );
        count++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const latest = this._loadLatestCandle();
    if (latest && (!this.currentCandle || latest.time >= this.currentCandle.time)) {
      this.currentCandle = latest;
    }
    return count;
  }

  /**
   * Process a live WebSocket NIFTY spot tick into the current 3-minute candle.
   */
  onSpotTick(ltp, timestampMs = Date.now(), volumeDelta = 0) {
    const price = Number(ltp);
    if (!Number.isFinite(price) || price <= 0) return null;

    const tsSec = Math.floor(Number(timestampMs || Date.now()) / 1000);
    const bucketTime = Math.floor(tsSec / INTERVAL_SEC) * INTERVAL_SEC;
    let isNewCandle = false;

    if (!this.currentCandle || bucketTime > this.currentCandle.time) {
      // Flush closed previous candle before starting new bucket
      if (this.currentCandle) {
        this._persistCandle(this.currentCandle);
      }
      this.currentCandle = {
        time: bucketTime,
        open: Number(price.toFixed(2)),
        high: Number(price.toFixed(2)),
        low: Number(price.toFixed(2)),
        close: Number(price.toFixed(2)),
        volume: Number(volumeDelta || 0),
        source: 'ws'
      };
      isNewCandle = true;
      this._persistCandle(this.currentCandle);
    } else if (bucketTime === this.currentCandle.time) {
      this.currentCandle.high = Number(Math.max(this.currentCandle.high, price).toFixed(2));
      this.currentCandle.low = Number(Math.min(this.currentCandle.low, price).toFixed(2));
      this.currentCandle.close = Number(price.toFixed(2));
      if (volumeDelta > 0) {
        this.currentCandle.volume = Number(this.currentCandle.volume || 0) + Number(volumeDelta);
      }
      this.currentCandle.source = 'ws';
      if (Date.now() - this._lastPersistAt >= 2000) {
        this._persistCandle(this.currentCandle);
      }
    } else {
      // Historical out-of-order tick: update matching candle cleanly if needed
      return null;
    }

    const out = { ...this.currentCandle };
    this.emit('candle_update', { candle: out, isNewCandle });
    return out;
  }

  /**
   * Load last N days of 3-minute NIFTY candles from broker REST API if SQLite history is empty.
   */
  async backfillIfEmpty(days = 3) {
    if (this.getCandleCount() > 0) {
      return { backfilled: false, count: this.getCandleCount(), added: 0 };
    }
    return await this.backfillFromBroker(days);
  }

  async backfillFromBroker(days = 3) {
    if (this._backfillInflight) return await this._backfillInflight;
    if (!this.multiBrokerManager || typeof this.multiBrokerManager.getNiftyHistoricalCandles !== 'function') {
      return { backfilled: false, count: this.getCandleCount(), added: 0 };
    }

    this._backfillInflight = (async () => {
      try {
        const res = await this.multiBrokerManager.getNiftyHistoricalCandles({ days, interval: '3m' });
        if (!res || !Array.isArray(res.candles) || res.candles.length === 0) {
          return { backfilled: false, count: this.getCandleCount(), added: 0, broker: res && res.broker };
        }
        const normalized = aggregateTo3MinuteCandles(res.candles, 'rest');
        const added = this.upsertCandles(normalized);
        this.emit('history_backfilled', { added, total: this.getCandleCount(), broker: res.broker });
        return { backfilled: added > 0, count: this.getCandleCount(), added, broker: res.broker };
      } finally {
        this._backfillInflight = null;
      }
    })();

    return await this._backfillInflight;
  }

  flush() {
    if (this.currentCandle) {
      this._persistCandle(this.currentCandle);
    }
  }

  close() {
    this.flush();
    try {
      this.db.close();
    } catch (e) {}
  }
}

module.exports = {
  NiftyCandleManager,
  aggregateTo3MinuteCandles,
  INTERVAL_SEC
};
