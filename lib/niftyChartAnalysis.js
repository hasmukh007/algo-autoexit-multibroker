const IST_OFFSET_SEC = 19800; // +05:30 IST
const NSE_SESSION_START_SEC = 9 * 3600 + 15 * 60; // 09:15 IST (33300s from IST midnight)
const NSE_OPEN_MIN = 9 * 60 + 15; // 555 (09:15 IST)
const NSE_CLOSE_MIN = 15 * 60 + 30; // 930 (15:30 IST exclusive)

/**
 * Returns true strictly during regular NSE trading hours: Mon-Fri, 09:15:00 to 15:29:59 IST.
 */
function isISTTradingHours(epochSec) {
  const t = Math.floor(Number(epochSec));
  if (!Number.isFinite(t) || t <= 0) return false;
  const d = new Date((t + IST_OFFSET_SEC) * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= NSE_OPEN_MIN && mins < NSE_CLOSE_MIN;
}

function round2(n) {
  return Number(Number(n).toFixed(2));
}

function getISTDateKey(epochSec) {
  const shiftedMs = (Math.floor(Number(epochSec)) + IST_OFFSET_SEC) * 1000;
  return new Date(shiftedMs).toISOString().slice(0, 10);
}

function formatISTSessionLabel(epochSec) {
  const shiftedMs = (Math.floor(Number(epochSec)) + IST_OFFSET_SEC) * 1000;
  const d = new Date(shiftedMs);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${dd} ${months[d.getUTCMonth()]}`;
}

/**
 * Find session boundary candles (first candle of each new IST trading date after the first).
 */
function getSessionBoundaries(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const boundaries = [];
  let prevDate = getISTDateKey(candles[0].time);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const d = getISTDateKey(c.time);
    if (d !== prevDate) {
      boundaries.push({
        time: Number(c.time),
        date: d,
        label: formatISTSessionLabel(c.time)
      });
      prevDate = d;
    }
  }
  return boundaries;
}

/**
 * Aggregate base OHLCV candles into NSE 09:15 IST-aligned bars of `minutes` (e.g. 5, 15, 60).
 * Anchoring to 09:15 IST ensures 1h bars fall on 09:15, 10:15, 11:15, 12:15, 13:15, 14:15, 15:15 IST.
 */
function aggregateToSessionTimeframe(candles = [], minutes = 5) {
  const intervalSec = Number(minutes) * 60;
  if (!Array.isArray(candles) || candles.length === 0 || !(intervalSec > 0)) return [];

  const sorted = [...candles].sort((a, b) => Number(a.time) - Number(b.time));
  const buckets = new Map();

  for (const c of sorted) {
    const t = Math.floor(Number(c.time));
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    const volume = Number(c.volume || 0);
    if (!isISTTradingHours(t) || !Number.isFinite(open) || !Number.isFinite(close) || close <= 0) continue;

    const istSec = t + IST_OFFSET_SEC;
    const istDayStart = Math.floor(istSec / 86400) * 86400;
    const sessionAnchor = istDayStart + NSE_SESSION_START_SEC;
    const bucketIdx = Math.floor((istSec - sessionAnchor) / intervalSec);
    const bucketTime = (sessionAnchor + bucketIdx * intervalSec) - IST_OFFSET_SEC;

    const existing = buckets.get(bucketTime);
    if (!existing) {
      buckets.set(bucketTime, {
        time: bucketTime,
        open: round2(open),
        high: round2(Number.isFinite(high) ? high : open),
        low: round2(Number.isFinite(low) ? low : open),
        close: round2(close),
        volume,
        source: c.source || 'agg'
      });
    } else {
      existing.high = round2(Math.max(existing.high, Number.isFinite(high) ? high : close));
      existing.low = round2(Math.min(existing.low, Number.isFinite(low) ? low : close));
      existing.close = round2(close);
      existing.volume += volume;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

/**
 * Compute standard Heikin-Ashi candles from regular OHLC candles.
 * Preserves rawHigh / rawLow alongside haHigh / haLow and assigns `color` ('green' | 'red').
 */
function calculateHeikinAshi(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const sorted = [...candles].sort((a, b) => Number(a.time) - Number(b.time));
  const ha = [];
  let prevHaOpen = null;
  let prevHaClose = null;

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const o = Number(c.open);
    const h = Number(c.high);
    const l = Number(c.low);
    const cl = Number(c.close);

    const haClose = (o + h + l + cl) / 4;
    const haOpen = i === 0 ? (o + cl) / 2 : (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(h, haOpen, haClose);
    const haLow = Math.min(l, haOpen, haClose);
    const color = haClose >= haOpen ? 'green' : 'red';

    ha.push({
      time: Number(c.time),
      open: round2(haOpen),
      high: round2(haHigh),
      low: round2(haLow),
      close: round2(haClose),
      rawHigh: round2(h),
      rawLow: round2(l),
      volume: Number(c.volume || 0),
      color
    });

    prevHaOpen = haOpen;
    prevHaClose = haClose;
  }

  return ha;
}

/**
 * Detect Heikin-Ashi Support & Resistance zones:
 * - Consecutive > 2 green HA candles (count >= 3): mark the run's High as Resistance.
 * - Consecutive > 2 red HA candles (count >= 3): mark the run's Low as Support.
 */
function detectHeikinAshiZones(haCandles = [], timeframe = '5m') {
  const resistances = [];
  const supports = [];

  if (!Array.isArray(haCandles) || haCandles.length === 0) {
    return {
      timeframe,
      candleCount: 0,
      resistances,
      supports,
      latestResistance: null,
      latestSupport: null,
      currentStreak: { color: null, count: 0 }
    };
  }

  let runStart = 0;
  for (let i = 1; i <= haCandles.length; i++) {
    const isEnd = i === haCandles.length || haCandles[i].color !== haCandles[runStart].color;
    if (!isEnd) continue;

    const run = haCandles.slice(runStart, i);
    const color = run[0].color;
    if (run.length > 2) {
      if (color === 'green') {
        let peakCandle = run[0];
        let maxHigh = Number(peakCandle.high);
        for (const bar of run) {
          const h = Number(bar.high);
          if (h >= maxHigh) {
            maxHigh = h;
            peakCandle = bar;
          }
        }
        resistances.push({
          timeframe,
          type: 'resistance',
          price: round2(maxHigh),
          count: run.length,
          startTime: run[0].time,
          endTime: run[run.length - 1].time,
          markerTime: peakCandle.time
        });
      } else if (color === 'red') {
        let troughCandle = run[0];
        let minLow = Number(troughCandle.low);
        for (const bar of run) {
          const l = Number(bar.low);
          if (l <= minLow) {
            minLow = l;
            troughCandle = bar;
          }
        }
        supports.push({
          timeframe,
          type: 'support',
          price: round2(minLow),
          count: run.length,
          startTime: run[0].time,
          endTime: run[run.length - 1].time,
          markerTime: troughCandle.time
        });
      }
    }

    runStart = i;
  }

  // Compute current active trailing streak
  const lastColor = haCandles[haCandles.length - 1].color;
  let streakCount = 0;
  for (let i = haCandles.length - 1; i >= 0 && haCandles[i].color === lastColor; i--) {
    streakCount++;
  }

  return {
    timeframe,
    candleCount: haCandles.length,
    resistances,
    supports,
    latestResistance: resistances.length > 0 ? resistances[resistances.length - 1] : null,
    latestSupport: supports.length > 0 ? supports[supports.length - 1] : null,
    currentStreak: { color: lastColor, count: streakCount }
  };
}

/**
 * Compute Previous Day High (PDH), Previous Day Low (PDL), Previous Day Close (PDC),
 * and Standard Floor Pivot Points (P, R1, R2, R3, S1, S2, S3).
 */
function calculatePreviousDayAndPivots(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const byDate = new Map();
  const sorted = [...candles].sort((a, b) => Number(a.time) - Number(b.time));
  for (const c of sorted) {
    const dk = getISTDateKey(c.time);
    if (!byDate.has(dk)) byDate.set(dk, []);
    byDate.get(dk).push(c);
  }

  const dates = Array.from(byDate.keys()).sort();
  if (dates.length < 2) return null;

  const currentDate = dates[dates.length - 1];
  const prevDate = dates[dates.length - 2];
  const prevCandles = byDate.get(prevDate);
  if (!prevCandles || prevCandles.length === 0) return null;

  let pdh = -Infinity;
  let pdl = Infinity;
  for (const c of prevCandles) {
    const h = Number(c.high);
    const l = Number(c.low);
    if (h > pdh) pdh = h;
    if (l < pdl) pdl = l;
  }
  const pdc = Number(prevCandles[prevCandles.length - 1].close);
  const p = (pdh + pdl + pdc) / 3;
  const range = pdh - pdl;

  return {
    prevDate,
    currentDate,
    pdh: round2(pdh),
    pdl: round2(pdl),
    pdc: round2(pdc),
    pivot: round2(p),
    r1: round2(2 * p - pdl),
    s1: round2(2 * p - pdh),
    r2: round2(p + range),
    s2: round2(p - range),
    r3: round2(pdh + 2 * (p - pdl)),
    s3: round2(pdl - 2 * (pdh - p))
  };
}

/**
 * Build full chart analysis from 3m candles (and optional 1m candles for exact 5m buckets).
 */
function buildChartAnalysis(candles3m = [], candles1m = []) {
  const sorted3m = Array.isArray(candles3m)
    ? candles3m.filter(c => isISTTradingHours(c.time)).sort((a, b) => Number(a.time) - Number(b.time))
    : [];

  // Merge 1m candles per IST date when available so 5m/15m/1h use highest available resolution
  const valid1m = Array.isArray(candles1m) ? candles1m.filter(c => isISTTradingHours(c.time)) : [];
  const dates1m = new Set(valid1m.map(c => getISTDateKey(c.time)));
  const fineSource = [
    ...valid1m,
    ...sorted3m.filter(c => !dates1m.has(getISTDateKey(c.time)))
  ].sort((a, b) => Number(a.time) - Number(b.time));

  const tfDefs = [
    { key: '5m', minutes: 5 },
    { key: '15m', minutes: 15 },
    { key: '1h', minutes: 60 }
  ];

  const timeframes = {};
  for (const tf of tfDefs) {
    const agg = aggregateToSessionTimeframe(fineSource, tf.minutes);
    const haCandles = calculateHeikinAshi(agg);
    const zones = detectHeikinAshiZones(haCandles, tf.key);
    timeframes[tf.key] = {
      ...zones,
      haCandles
    };
  }

  return {
    sessions: getSessionBoundaries(sorted3m),
    pivots: calculatePreviousDayAndPivots(fineSource.length > 0 ? fineSource : sorted3m),
    timeframes
  };
}

module.exports = {
  IST_OFFSET_SEC,
  NSE_SESSION_START_SEC,
  isISTTradingHours,
  getISTDateKey,
  formatISTSessionLabel,
  getSessionBoundaries,
  aggregateToSessionTimeframe,
  calculateHeikinAshi,
  detectHeikinAshiZones,
  calculatePreviousDayAndPivots,
  buildChartAnalysis
};
