/**
 * NIFTY 50 Live Chart Controller
 * - Supports 3m standard candles plus 5m, 15m, and 1h Heikin-Ashi views
 * - Draws IST session-change vertical boundary lines
 * - Computes Heikin-Ashi across 5m, 15m, and 1h:
 *     >2 consecutive green HA candles -> marks High as Resistance
 *     >2 consecutive red HA candles   -> marks Low as Support
 * - Draws Previous Day High/Low (PDH / PDL) and Floor Pivot Points (P, R1-R3, S1-S3)
 */

const IST_OFFSET_SEC = 19800;
const NSE_SESSION_START_SEC = 9 * 3600 + 15 * 60;
const NSE_OPEN_MIN = 9 * 60 + 15;
const NSE_CLOSE_MIN = 15 * 60 + 30;

function isISTTradingHours(epochSec) {
  const t = Math.floor(Number(epochSec));
  if (!Number.isFinite(t) || t <= 0) return false;
  const d = new Date((t + IST_OFFSET_SEC) * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= NSE_OPEN_MIN && mins < NSE_CLOSE_MIN;
}

const chartState = {
  candles: [],
  candles1m: [],
  activeTf: '3m', // '3m' | '5m_ha' | '15m_ha' | '1h_ha'
  analysis: null,
  previousNiftyLtp: null,
  lwChart: null,
  candleSeries: null,
  sessionPrimitive: null,
  priceLines: [],
  fallbackCanvas: null,
  hoverIndex: null,
  overlays: {
    sessions: true,
    haSr: true,
    pdhPdl: true,
    pivots: true
  }
};

const C_DOM = {
  topNiftyLtp: document.getElementById('topNiftyLtp'),
  topNiftyChange: document.getElementById('topNiftyChange'),
  topNiftyOpen: document.getElementById('topNiftyOpen'),
  topNiftyHigh: document.getElementById('topNiftyHigh'),
  topNiftyLow: document.getElementById('topNiftyLow'),
  topNiftyAtm: document.getElementById('topNiftyAtm'),
  topNiftyFeedPill: document.getElementById('topNiftyFeedPill'),
  topNiftyFeedStatus: document.getElementById('topNiftyFeedStatus'),

  istClock: document.getElementById('istClock'),
  marketPill: document.getElementById('marketPill'),
  chartDbCountBadge: document.getElementById('chartDbCountBadge'),
  chartTfGroup: document.getElementById('chartTfGroup'),
  chartActiveLabel: document.getElementById('chartActiveLabel'),
  resetZoomBtn: document.getElementById('resetZoomBtn'),
  backfillBtn: document.getElementById('backfillBtn'),
  connStatus: document.getElementById('connStatus'),
  connLabel: document.getElementById('connLabel'),

  toggleSessions: document.getElementById('toggleSessions'),
  toggleHaSr: document.getElementById('toggleHaSr'),
  togglePdhPdl: document.getElementById('togglePdhPdl'),
  togglePivots: document.getElementById('togglePivots'),

  lvlPdh: document.getElementById('lvlPdh'),
  lvlPdl: document.getElementById('lvlPdl'),
  lvlPivot: document.getElementById('lvlPivot'),
  lvlR1: document.getElementById('lvlR1'),
  lvlR2: document.getElementById('lvlR2'),
  lvlR3: document.getElementById('lvlR3'),
  lvlS1: document.getElementById('lvlS1'),
  lvlS2: document.getElementById('lvlS2'),
  lvlS3: document.getElementById('lvlS3'),
  haSummary5m: document.getElementById('haSummary5m'),
  haSummary15m: document.getElementById('haSummary15m'),
  haSummary1h: document.getElementById('haSummary1h'),

  candleTimeDisplay: document.getElementById('candleTimeDisplay'),
  candleOpenDisplay: document.getElementById('candleOpenDisplay'),
  candleHighDisplay: document.getElementById('candleHighDisplay'),
  candleLowDisplay: document.getElementById('candleLowDisplay'),
  candleCloseDisplay: document.getElementById('candleCloseDisplay'),
  candleSourceDisplay: document.getElementById('candleSourceDisplay'),
  chartStatusText: document.getElementById('chartStatusText'),
  chartContainer: document.getElementById('chartContainer'),
  chartEmptyOverlay: document.getElementById('chartEmptyOverlay'),
  toastContainer: document.getElementById('toastContainer')
};

/* ============================================================
   CLIENT-SIDE CHART ANALYSIS (Session Lines, 5m/15m/1h HA S/R, Pivots, PDH/PDL)
   ============================================================ */

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

function getSessionBoundaries(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const out = [];
  let prev = getISTDateKey(candles[0].time);
  for (let i = 1; i < candles.length; i++) {
    const dk = getISTDateKey(candles[i].time);
    if (dk !== prev) {
      out.push({ time: Number(candles[i].time), date: dk, label: formatISTSessionLabel(candles[i].time) });
      prev = dk;
    }
  }
  return out;
}

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

    const ex = buckets.get(bucketTime);
    if (!ex) {
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
      ex.high = round2(Math.max(ex.high, Number.isFinite(high) ? high : close));
      ex.low = round2(Math.min(ex.low, Number.isFinite(low) ? low : close));
      ex.close = round2(close);
      ex.volume += volume;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

function calculateHeikinAshi(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const sorted = [...candles].sort((a, b) => Number(a.time) - Number(b.time));
  const ha = [];
  let prevOpen = null;
  let prevClose = null;

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const o = Number(c.open);
    const h = Number(c.high);
    const l = Number(c.low);
    const cl = Number(c.close);
    const haClose = (o + h + l + cl) / 4;
    const haOpen = i === 0 ? (o + cl) / 2 : (prevOpen + prevClose) / 2;
    const haHigh = Math.max(h, haOpen, haClose);
    const haLow = Math.min(l, haOpen, haClose);

    ha.push({
      time: Number(c.time),
      open: round2(haOpen),
      high: round2(haHigh),
      low: round2(haLow),
      close: round2(haClose),
      volume: Number(c.volume || 0),
      color: haClose >= haOpen ? 'green' : 'red',
      source: c.source || 'ha'
    });
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return ha;
}

function detectHeikinAshiZones(haCandles = [], timeframe = '5m') {
  const resistances = [];
  const supports = [];
  if (!Array.isArray(haCandles) || haCandles.length === 0) {
    return { timeframe, candleCount: 0, resistances, supports, latestResistance: null, latestSupport: null, currentStreak: { color: null, count: 0 } };
  }

  let runStart = 0;
  for (let i = 1; i <= haCandles.length; i++) {
    const isEnd = i === haCandles.length || haCandles[i].color !== haCandles[runStart].color;
    if (!isEnd) continue;

    const run = haCandles.slice(runStart, i);
    const color = run[0].color;
    if (run.length > 2) {
      if (color === 'green') {
        let peak = run[0];
        let maxH = Number(peak.high);
        for (const bar of run) {
          if (Number(bar.high) >= maxH) {
            maxH = Number(bar.high);
            peak = bar;
          }
        }
        resistances.push({ timeframe, type: 'resistance', price: round2(maxH), count: run.length, startTime: run[0].time, endTime: run[run.length - 1].time, markerTime: peak.time });
      } else {
        let trough = run[0];
        let minL = Number(trough.low);
        for (const bar of run) {
          if (Number(bar.low) <= minL) {
            minL = Number(bar.low);
            trough = bar;
          }
        }
        supports.push({ timeframe, type: 'support', price: round2(minL), count: run.length, startTime: run[0].time, endTime: run[run.length - 1].time, markerTime: trough.time });
      }
    }
    runStart = i;
  }

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
  const prevCandles = byDate.get(dates[dates.length - 2]);
  if (!prevCandles || prevCandles.length === 0) return null;

  let pdh = -Infinity;
  let pdl = Infinity;
  for (const c of prevCandles) {
    if (Number(c.high) > pdh) pdh = Number(c.high);
    if (Number(c.low) < pdl) pdl = Number(c.low);
  }
  const pdc = Number(prevCandles[prevCandles.length - 1].close);
  const p = (pdh + pdl + pdc) / 3;
  const range = pdh - pdl;

  return {
    prevDate: dates[dates.length - 2],
    currentDate: dates[dates.length - 1],
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

function computeClientAnalysis() {
  const sorted3m = [...chartState.candles].sort((a, b) => Number(a.time) - Number(b.time));
  const dates1m = new Set(chartState.candles1m.map(c => getISTDateKey(c.time)));
  const fineSource = [
    ...chartState.candles1m,
    ...sorted3m.filter(c => !dates1m.has(getISTDateKey(c.time)))
  ].sort((a, b) => Number(a.time) - Number(b.time));

  const timeframes = {};
  for (const [key, min] of [['5m', 5], ['15m', 15], ['1h', 60]]) {
    const haCandles = calculateHeikinAshi(aggregateToSessionTimeframe(fineSource, min));
    const zones = detectHeikinAshiZones(haCandles, key);
    timeframes[key] = { ...zones, haCandles };
  }

  chartState.analysis = {
    sessions: getSessionBoundaries(getDisplayedCandles(false)),
    pivots: calculatePreviousDayAndPivots(fineSource.length > 0 ? fineSource : sorted3m),
    timeframes
  };
  return chartState.analysis;
}

function getDisplayedCandles(withSessionRecalc = true) {
  if (chartState.activeTf === '3m') {
    return chartState.candles;
  }
  if (!chartState.analysis && withSessionRecalc) {
    computeClientAnalysis();
  }
  const key = chartState.activeTf.replace('_ha', '');
  const tfData = chartState.analysis && chartState.analysis.timeframes && chartState.analysis.timeframes[key];
  return (tfData && tfData.haCandles) ? tfData.haCandles : chartState.candles;
}

/* ============================================================
   LIGHTWEIGHT CHARTS SESSION VERTICAL LINE PRIMITIVE
   ============================================================ */

class SessionLinesPrimitive {
  constructor() {
    this._chart = null;
    this._requestUpdate = null;
    this._boundaries = [];
    this._enabled = true;
    this._coords = [];
  }

  attached({ chart, requestUpdate }) {
    this._chart = chart;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this._chart = null;
    this._requestUpdate = null;
  }

  setData(boundaries, enabled) {
    this._boundaries = Array.isArray(boundaries) ? boundaries : [];
    this._enabled = Boolean(enabled);
    if (this._requestUpdate) this._requestUpdate();
  }

  updateAllViews() {
    if (!this._chart || !this._enabled) {
      this._coords = [];
      return;
    }
    const ts = this._chart.timeScale();
    this._coords = this._boundaries
      .map(b => ({ x: ts.timeToCoordinate(b.time), label: b.label }))
      .filter(item => item.x !== null && item.x !== undefined && Number.isFinite(item.x));
  }

  paneViews() {
    const self = this;
    return [{
      zOrder() { return 'bottom'; },
      renderer() {
        return {
          draw(target) {
            if (!self._enabled || self._coords.length === 0) return;
            target.useMediaCoordinateSpace(scope => {
              const ctx = scope.context;
              const h = scope.mediaSize.height;
              ctx.save();
              ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
              ctx.lineWidth = 1;
              ctx.setLineDash([5, 4]);
              ctx.font = '10px JetBrains Mono, monospace';

              for (const item of self._coords) {
                const x = Math.round(item.x) + 0.5;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, h);
                ctx.stroke();

                const text = `Session ${item.label}`;
                const tw = ctx.measureText(text).width + 8;
                ctx.fillStyle = 'rgba(245, 158, 11, 0.16)';
                ctx.fillRect(x + 3, 6, tw, 16);
                ctx.fillStyle = '#fbbf24';
                ctx.fillText(text, x + 7, 17);
              }
              ctx.restore();
            });
          }
        };
      }
    }];
  }
}

/* ============================================================
   UI HELPERS & TOP BAR
   ============================================================ */

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${String(message || '')}</span>`;
  C_DOM.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function formatISTTime(epochSec, includeDate = true) {
  const d = new Date((Number(epochSec) + IST_OFFSET_SEC) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (!includeDate) return `${hh}:${mm}`;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${dd} ${months[d.getUTCMonth()]} ${hh}:${mm}`;
}

function updateClock() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 3600000 * 5.5);

  const h = String(ist.getHours()).padStart(2, '0');
  const m = String(ist.getMinutes()).padStart(2, '0');
  const s = String(ist.getSeconds()).padStart(2, '0');
  C_DOM.istClock.textContent = `${h}:${m}:${s} IST`;

  const day = ist.getDay();
  const totalMin = ist.getHours() * 60 + ist.getMinutes();
  const isOpen = day >= 1 && day <= 5 && totalMin >= 555 && totalMin <= 930;

  if (isOpen) {
    C_DOM.marketPill.textContent = 'MARKET OPEN';
    C_DOM.marketPill.className = 'market-pill open';
  } else {
    C_DOM.marketPill.textContent = 'MARKET CLOSED';
    C_DOM.marketPill.className = 'market-pill closed';
  }
}
setInterval(updateClock, 1000);
updateClock();

function updateTopNiftyBar(snapshot) {
  if (!snapshot || !snapshot.spot) return;
  const spot = snapshot.spot;
  const hasSpot = spot.ltp !== null && spot.ltp !== undefined;
  const prev = chartState.previousNiftyLtp;

  if (hasSpot) {
    const ltp = Number(spot.ltp);
    C_DOM.topNiftyLtp.textContent = ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (prev !== null && ltp !== prev) {
      C_DOM.topNiftyLtp.classList.remove('flash-up', 'flash-down');
      void C_DOM.topNiftyLtp.offsetWidth;
      C_DOM.topNiftyLtp.classList.add(ltp > prev ? 'flash-up' : 'flash-down');
    }
    chartState.previousNiftyLtp = ltp;

    const chg = Number(spot.change || 0);
    const chgPct = Number(spot.changePct || 0);
    const sign = chg >= 0 ? '+' : '';
    C_DOM.topNiftyChange.textContent = `${sign}${chg.toFixed(2)} (${sign}${chgPct.toFixed(2)}%)`;
    C_DOM.topNiftyChange.className = `nifty-change mono ${chg >= 0 ? 'profit-text' : 'loss-text'}`;
  } else {
    C_DOM.topNiftyLtp.textContent = '--';
    C_DOM.topNiftyChange.textContent = 'Awaiting Live Quote';
    C_DOM.topNiftyChange.className = 'nifty-change mono';
  }

  C_DOM.topNiftyOpen.textContent = spot.open !== null && spot.open !== undefined ? Number(spot.open).toFixed(2) : '--';
  C_DOM.topNiftyHigh.textContent = spot.high !== null && spot.high !== undefined ? Number(spot.high).toFixed(2) : '--';
  C_DOM.topNiftyLow.textContent = spot.low !== null && spot.low !== undefined ? Number(spot.low).toFixed(2) : '--';
  C_DOM.topNiftyAtm.textContent = snapshot.atmStrike || '--';

  const fs = snapshot.feedState || {};
  const isLive = fs.sourceMode === 'live_broker';
  if (fs.isRunning) {
    C_DOM.topNiftyFeedPill.className = isLive ? 'nifty-feed-pill active' : 'nifty-feed-pill waiting';
    C_DOM.topNiftyFeedStatus.textContent = isLive
      ? '9:00 AM Live Feed • WebSocket Streaming'
      : '9:00 AM Feed • Awaiting Live Broker Quote';
  } else {
    C_DOM.topNiftyFeedPill.className = 'nifty-feed-pill waiting';
    C_DOM.topNiftyFeedStatus.textContent = `Live Option Feed Scheduled for ${fs.scheduledTimeIST || '09:00 IST'}`;
  }
}

function updateOhlcStrip(candle) {
  const tfLabels = { '3m': '3m', '5m_ha': '5m Heikin-Ashi', '15m_ha': '15m Heikin-Ashi', '1h_ha': '1h Heikin-Ashi' };
  C_DOM.chartActiveLabel.textContent = `NIFTY 50 (${tfLabels[chartState.activeTf] || '3m'})`;

  if (!candle) {
    C_DOM.candleTimeDisplay.textContent = '--';
    C_DOM.candleOpenDisplay.textContent = '--';
    C_DOM.candleHighDisplay.textContent = '--';
    C_DOM.candleLowDisplay.textContent = '--';
    C_DOM.candleCloseDisplay.textContent = '--';
    C_DOM.candleSourceDisplay.textContent = '--';
    return;
  }
  const isUp = Number(candle.close) >= Number(candle.open);
  C_DOM.candleTimeDisplay.textContent = `${formatISTTime(candle.time, true)} IST`;
  C_DOM.candleOpenDisplay.textContent = Number(candle.open).toFixed(2);
  C_DOM.candleHighDisplay.textContent = Number(candle.high).toFixed(2);
  C_DOM.candleLowDisplay.textContent = Number(candle.low).toFixed(2);
  C_DOM.candleCloseDisplay.textContent = Number(candle.close).toFixed(2);
  C_DOM.candleCloseDisplay.className = isUp ? 'profit-text' : 'loss-text';
  C_DOM.candleSourceDisplay.textContent = chartState.activeTf === '3m'
    ? (candle.source === 'ws' ? 'WebSocket (Live)' : 'Broker REST (3D History)')
    : `${tfLabels[chartState.activeTf]} (Calculated)`;
}

function updateLevelsSummaryBar() {
  const a = chartState.analysis;
  const p = a && a.pivots;
  C_DOM.lvlPdh.textContent = p ? p.pdh.toFixed(2) : '--';
  C_DOM.lvlPdl.textContent = p ? p.pdl.toFixed(2) : '--';
  C_DOM.lvlPivot.textContent = p ? p.pivot.toFixed(2) : '--';
  C_DOM.lvlR1.textContent = p ? p.r1.toFixed(2) : '--';
  C_DOM.lvlR2.textContent = p ? p.r2.toFixed(2) : '--';
  C_DOM.lvlR3.textContent = p ? p.r3.toFixed(2) : '--';
  C_DOM.lvlS1.textContent = p ? p.s1.toFixed(2) : '--';
  C_DOM.lvlS2.textContent = p ? p.s2.toFixed(2) : '--';
  C_DOM.lvlS3.textContent = p ? p.s3.toFixed(2) : '--';

  const fmtHa = (label, tfKey) => {
    const z = a && a.timeframes && a.timeframes[tfKey];
    if (!z || z.candleCount === 0) return `${label}: --`;
    const resStr = z.latestResistance ? `Res ${z.latestResistance.price.toFixed(2)} (${z.latestResistance.count}G)` : 'Res --';
    const supStr = z.latestSupport ? `Sup ${z.latestSupport.price.toFixed(2)} (${z.latestSupport.count}R)` : 'Sup --';
    return `${label}: ${resStr} | ${supStr}`;
  };
  C_DOM.haSummary5m.textContent = fmtHa('5m HA', '5m');
  C_DOM.haSummary15m.textContent = fmtHa('15m HA', '15m');
  C_DOM.haSummary1h.textContent = fmtHa('1h HA', '1h');
}

/* ============================================================
   OVERLAY PRICE LINES & SESSION MARKERS
   ============================================================ */

function buildAllPriceLineSpecs() {
  const a = chartState.analysis;
  if (!a) return [];
  const lines = [];

  if (chartState.overlays.pdhPdl && a.pivots) {
    lines.push({ price: a.pivots.pdh, color: '#fbbf24', lineWidth: 2, lineStyle: 0, title: `PDH (${a.pivots.pdh.toFixed(2)})` });
    lines.push({ price: a.pivots.pdl, color: '#38bdf8', lineWidth: 2, lineStyle: 0, title: `PDL (${a.pivots.pdl.toFixed(2)})` });
  }

  if (chartState.overlays.pivots && a.pivots) {
    const p = a.pivots;
    lines.push({ price: p.pivot, color: '#c084fc', lineWidth: 1, lineStyle: 2, title: 'Pivot P' });
    lines.push({ price: p.r1, color: '#fb7185', lineWidth: 1, lineStyle: 3, title: 'R1' });
    lines.push({ price: p.r2, color: '#f43f5e', lineWidth: 1, lineStyle: 3, title: 'R2' });
    lines.push({ price: p.r3, color: '#e11d48', lineWidth: 1, lineStyle: 3, title: 'R3' });
    lines.push({ price: p.s1, color: '#34d399', lineWidth: 1, lineStyle: 3, title: 'S1' });
    lines.push({ price: p.s2, color: '#10b981', lineWidth: 1, lineStyle: 3, title: 'S2' });
    lines.push({ price: p.s3, color: '#059669', lineWidth: 1, lineStyle: 3, title: 'S3' });
  }

  if (chartState.overlays.haSr && a.timeframes) {
    const styles = {
      '5m': { resColor: '#f87171', supColor: '#4ade80', width: 1, style: 2 },
      '15m': { resColor: '#fb923c', supColor: '#2dd4bf', width: 2, style: 2 },
      '1h': { resColor: '#ef4444', supColor: '#10b981', width: 2, style: 0 }
    };
    for (const tfKey of ['5m', '15m', '1h']) {
      const z = a.timeframes[tfKey];
      const st = styles[tfKey];
      if (!z) continue;
      if (z.latestResistance) {
        lines.push({
          price: z.latestResistance.price,
          color: st.resColor,
          lineWidth: st.width,
          lineStyle: st.style,
          title: `${tfKey} HA Res (${z.latestResistance.count}G)`
        });
      }
      if (z.latestSupport) {
        lines.push({
          price: z.latestSupport.price,
          color: st.supColor,
          lineWidth: st.width,
          lineStyle: st.style,
          title: `${tfKey} HA Sup (${z.latestSupport.count}R)`
        });
      }
    }
  }

  return lines;
}

function applyOverlays() {
  computeClientAnalysis();
  updateLevelsSummaryBar();

  const displayed = getDisplayedCandles(false);
  const boundaries = getSessionBoundaries(displayed);

  if (chartState.candleSeries) {
    for (const pl of chartState.priceLines) {
      try { chartState.candleSeries.removePriceLine(pl); } catch (e) {}
    }
    chartState.priceLines = [];

    for (const spec of buildAllPriceLineSpecs()) {
      try {
        const pl = chartState.candleSeries.createPriceLine({
          price: spec.price,
          color: spec.color,
          lineWidth: spec.lineWidth,
          lineStyle: spec.lineStyle,
          axisLabelVisible: true,
          title: spec.title
        });
        chartState.priceLines.push(pl);
      } catch (e) {}
    }

    if (chartState.sessionPrimitive) {
      chartState.sessionPrimitive.setData(boundaries, chartState.overlays.sessions);
    }

    // Add chart markers for HA >2 green/red streaks when viewing an HA timeframe
    const markers = [];
    if (chartState.overlays.haSr && chartState.activeTf !== '3m') {
      const key = chartState.activeTf.replace('_ha', '');
      const z = chartState.analysis && chartState.analysis.timeframes && chartState.analysis.timeframes[key];
      if (z) {
        for (const r of z.resistances) {
          markers.push({
            time: r.markerTime,
            position: 'aboveBar',
            color: '#ef4444',
            shape: 'arrowDown',
            text: `RES ${r.price.toFixed(0)} (${r.count}G)`
          });
        }
        for (const s of z.supports) {
          markers.push({
            time: s.markerTime,
            position: 'belowBar',
            color: '#10b981',
            shape: 'arrowUp',
            text: `SUP ${s.price.toFixed(0)} (${s.count}R)`
          });
        }
      }
    }
    markers.sort((x, y) => x.time - y.time);
    try { chartState.candleSeries.setMarkers(markers); } catch (e) {}
  } else {
    drawFallbackCandles();
  }
}

/* ============================================================
   CHART RENDERER (TradingView Lightweight Charts + Canvas 2D Fallback)
   ============================================================ */

function initChartRenderer() {
  if (window.LightweightCharts) {
    const chart = window.LightweightCharts.createChart(C_DOM.chartContainer, {
      layout: { background: { color: '#0b1222' }, textColor: '#94a3b8' },
      grid: {
        vertLines: { color: 'rgba(36, 50, 79, 0.45)' },
        horzLines: { color: 'rgba(36, 50, 79, 0.45)' }
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#24324f' },
      timeScale: {
        borderColor: '#24324f',
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: time => formatISTTime(time, false)
      },
      localization: {
        timeFormatter: time => `${formatISTTime(time, true)} IST`
      }
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444'
    });

    if (typeof candleSeries.attachPrimitive === 'function') {
      try {
        const prim = new SessionLinesPrimitive();
        candleSeries.attachPrimitive(prim);
        chartState.sessionPrimitive = prim;
      } catch (e) {}
    }

    chart.subscribeCrosshairMove(param => {
      const list = getDisplayedCandles();
      if (param && param.time && param.seriesData) {
        const d = param.seriesData.get(candleSeries);
        if (d) {
          const match = list.find(c => c.time === param.time);
          updateOhlcStrip({ ...d, time: param.time, source: match ? match.source : 'ws' });
          return;
        }
      }
      if (list.length > 0) {
        updateOhlcStrip(list[list.length - 1]);
      }
    });

    const resize = () => {
      chart.applyOptions({
        width: C_DOM.chartContainer.clientWidth,
        height: C_DOM.chartContainer.clientHeight
      });
    };
    window.addEventListener('resize', resize);
    resize();

    chartState.lwChart = chart;
    chartState.candleSeries = candleSeries;
    return;
  }

  // Fallback Canvas 2D Candlestick Renderer (offline / CDN blocked)
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  C_DOM.chartContainer.appendChild(canvas);
  chartState.fallbackCanvas = canvas;

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const visible = getDisplayedCandles().slice(-120);
    if (visible.length === 0) return;
    const plotW = Math.max(1, rect.width - 80);
    const step = plotW / visible.length;
    const idx = Math.max(0, Math.min(visible.length - 1, Math.floor((x - 12) / step)));
    chartState.hoverIndex = idx;
    updateOhlcStrip(visible[idx]);
    drawFallbackCandles();
  });

  canvas.addEventListener('mouseleave', () => {
    chartState.hoverIndex = null;
    const list = getDisplayedCandles();
    if (list.length > 0) updateOhlcStrip(list[list.length - 1]);
    drawFallbackCandles();
  });

  window.addEventListener('resize', drawFallbackCandles);
}

function drawFallbackCandles() {
  const canvas = chartState.fallbackCanvas;
  if (!canvas) return;
  const width = C_DOM.chartContainer.clientWidth || 800;
  const height = C_DOM.chartContainer.clientHeight || 480;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#0b1222';
  ctx.fillRect(0, 0, width, height);

  const visible = getDisplayedCandles().slice(-120);
  if (visible.length === 0) return;

  const padLeft = 12;
  const padRight = 80;
  const padTop = 22;
  const padBottom = 28;
  const plotW = Math.max(50, width - padLeft - padRight);
  const plotH = Math.max(50, height - padTop - padBottom);

  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of visible) {
    if (c.low < minP) minP = c.low;
    if (c.high > maxP) maxP = c.high;
  }
  const lineSpecs = buildAllPriceLineSpecs();
  for (const sp of lineSpecs) {
    if (sp.price >= minP * 0.985 && sp.price <= maxP * 1.015) {
      if (sp.price < minP) minP = sp.price;
      if (sp.price > maxP) maxP = sp.price;
    }
  }

  const range = Math.max(1, maxP - minP);
  minP -= range * 0.06;
  maxP += range * 0.06;
  const totalRange = maxP - minP;
  const yOf = p => padTop + ((maxP - p) / totalRange) * plotH;

  // Grid lines & right price labels
  ctx.strokeStyle = 'rgba(36, 50, 79, 0.5)';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px JetBrains Mono, monospace';
  for (let i = 0; i <= 5; i++) {
    const y = padTop + (plotH * i) / 5;
    const price = maxP - (totalRange * i) / 5;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();
    ctx.fillText(price.toFixed(2), width - padRight + 6, y + 4);
  }

  const step = plotW / visible.length;
  const bodyW = Math.max(2, Math.min(12, step * 0.65));

  // Session Change Vertical Lines
  if (chartState.overlays.sessions) {
    let prevDate = getISTDateKey(visible[0].time);
    ctx.save();
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.font = '10px JetBrains Mono, monospace';
    for (let idx = 1; idx < visible.length; idx++) {
      const dk = getISTDateKey(visible[idx].time);
      if (dk !== prevDate) {
        const cx = padLeft + idx * step;
        ctx.beginPath();
        ctx.moveTo(cx, padTop);
        ctx.lineTo(cx, height - padBottom);
        ctx.stroke();
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(`Session ${formatISTSessionLabel(visible[idx].time)}`, cx + 4, padTop + 10);
        prevDate = dk;
      }
    }
    ctx.restore();
  }

  // Horizontal Pivot / PDH / PDL / HA S/R Lines
  for (const sp of lineSpecs) {
    if (sp.price < minP || sp.price > maxP) continue;
    const y = yOf(sp.price);
    ctx.save();
    ctx.strokeStyle = sp.color;
    ctx.lineWidth = sp.lineWidth || 1;
    if (sp.lineStyle === 2) ctx.setLineDash([5, 4]);
    else if (sp.lineStyle === 3) ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();
    ctx.fillStyle = sp.color;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText(sp.title, padLeft + 4, Math.max(padTop + 10, y - 3));
    ctx.restore();
  }

  // Candlesticks
  visible.forEach((c, idx) => {
    const cx = padLeft + idx * step + step / 2;
    const isUp = c.close >= c.open;
    const color = isUp ? '#10b981' : '#ef4444';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    ctx.beginPath();
    ctx.moveTo(cx, yOf(c.high));
    ctx.lineTo(cx, yOf(c.low));
    ctx.stroke();

    const yOpen = yOf(c.open);
    const yClose = yOf(c.close);
    const top = Math.min(yOpen, yClose);
    const h = Math.max(1.5, Math.abs(yClose - yOpen));
    ctx.fillRect(cx - bodyW / 2, top, bodyW, h);

    if (idx % Math.max(1, Math.floor(visible.length / 8)) === 0) {
      ctx.fillStyle = '#64748b';
      ctx.fillText(formatISTTime(c.time, false), cx - 16, height - 8);
    }
  });
}

function renderActiveTimeframeSeries(fitContent = true) {
  computeClientAnalysis();
  const list = getDisplayedCandles(false);
  C_DOM.chartDbCountBadge.textContent = `${chartState.candles.length} (3m) • ${list.length} Shown`;

  if (chartState.candles.length === 0) {
    C_DOM.chartEmptyOverlay.style.display = 'flex';
    C_DOM.chartStatusText.textContent = 'No 3-minute candles yet. Connect a live broker or click Load 3 Days History.';
    updateOhlcStrip(null);
  } else {
    C_DOM.chartEmptyOverlay.style.display = 'none';
    updateOhlcStrip(list[list.length - 1]);
    C_DOM.chartStatusText.textContent = chartState.activeTf === '3m'
      ? `Showing ${list.length} NIFTY 3m candles • Sessions + 5m/15m/1h HA S/R + Pivots + PDH/PDL`
      : `Showing ${list.length} ${chartState.activeTf.replace('_ha', '').toUpperCase()} Heikin-Ashi candles`;
  }

  if (chartState.candleSeries) {
    chartState.candleSeries.setData(
      list.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
    );
    applyOverlays();
    if (fitContent) {
      chartState.lwChart.timeScale().fitContent();
    }
  } else {
    applyOverlays();
  }
}

function setAllCandles(candles, candles1m = null) {
  chartState.candles = Array.isArray(candles) ? candles.filter(c => isISTTradingHours(c.time)) : [];
  if (Array.isArray(candles1m)) {
    chartState.candles1m = candles1m.filter(c => isISTTradingHours(c.time));
  }
  renderActiveTimeframeSeries(true);
}

function applyLiveCandle(candle, candle1m = null) {
  if (!candle || !isISTTradingHours(candle.time)) return;
  const list = chartState.candles;
  const last = list[list.length - 1];
  if (last && last.time === candle.time) {
    list[list.length - 1] = candle;
  } else if (!last || candle.time > last.time) {
    list.push(candle);
  }

  if (candle1m) {
    const l1 = chartState.candles1m;
    const last1 = l1[l1.length - 1];
    if (last1 && last1.time === candle1m.time) {
      l1[l1.length - 1] = candle1m;
    } else if (!last1 || candle1m.time > last1.time) {
      l1.push(candle1m);
    }
  }

  renderActiveTimeframeSeries(false);
}

/* ============================================================
   API LOADING, SSE STREAMING & CONTROLS
   ============================================================ */

async function loadInitialChart() {
  try {
    const res = await fetch('/api/nifty-chart?days=3');
    const d = await res.json();
    if (d.success) {
      setAllCandles(d.candles || [], d.candles1m || []);
      if (d.backfilled) {
        showToast(`Loaded ${d.count} 3-minute candles (last 3 days) into local SQLite DB.`, 'success');
      }
    }
  } catch (e) {
    C_DOM.chartStatusText.textContent = 'Error loading chart candles.';
  }
}

async function loadNiftySpotSnapshot() {
  try {
    const res = await fetch('/api/nifty-feed');
    const d = await res.json();
    if (d.success && d.data) {
      updateTopNiftyBar(d.data);
    }
  } catch (e) {}
}

function initEventSource() {
  const es = new EventSource('/api/stream');

  es.addEventListener('connected', () => {
    C_DOM.connLabel.textContent = 'Live SSE Active';
    C_DOM.connStatus.querySelector('.status-indicator').className = 'status-indicator online';
  });

  es.addEventListener('nifty_tick', e => {
    try {
      updateTopNiftyBar(JSON.parse(e.data));
    } catch (err) {}
  });

  es.addEventListener('nifty_candle', e => {
    try {
      const payload = JSON.parse(e.data);
      if (payload && payload.candle) {
        applyLiveCandle(payload.candle, payload.candle1m || null);
      }
    } catch (err) {}
  });

  es.addEventListener('nifty_candles_reset', e => {
    try {
      const payload = JSON.parse(e.data);
      if (payload && Array.isArray(payload.candles)) {
        setAllCandles(payload.candles, payload.candles1m || null);
      }
    } catch (err) {}
  });

  es.onerror = () => {
    C_DOM.connLabel.textContent = 'Reconnecting...';
    C_DOM.connStatus.querySelector('.status-indicator').className = 'status-indicator offline';
  };
}

if (C_DOM.chartTfGroup) {
  C_DOM.chartTfGroup.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      C_DOM.chartTfGroup.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartState.activeTf = btn.getAttribute('data-tf') || '3m';
      renderActiveTimeframeSeries(true);
    });
  });
}

if (C_DOM.toggleSessions) {
  C_DOM.toggleSessions.addEventListener('change', () => {
    chartState.overlays.sessions = C_DOM.toggleSessions.checked;
    applyOverlays();
  });
}
if (C_DOM.toggleHaSr) {
  C_DOM.toggleHaSr.addEventListener('change', () => {
    chartState.overlays.haSr = C_DOM.toggleHaSr.checked;
    applyOverlays();
  });
}
if (C_DOM.togglePdhPdl) {
  C_DOM.togglePdhPdl.addEventListener('change', () => {
    chartState.overlays.pdhPdl = C_DOM.togglePdhPdl.checked;
    applyOverlays();
  });
}
if (C_DOM.togglePivots) {
  C_DOM.togglePivots.addEventListener('change', () => {
    chartState.overlays.pivots = C_DOM.togglePivots.checked;
    applyOverlays();
  });
}

C_DOM.resetZoomBtn.addEventListener('click', () => {
  if (chartState.lwChart) {
    chartState.lwChart.timeScale().fitContent();
  } else {
    drawFallbackCandles();
  }
});

C_DOM.backfillBtn.addEventListener('click', async () => {
  C_DOM.backfillBtn.disabled = true;
  showToast('Fetching last 3 days of 3-minute NIFTY candles from active broker...', 'info');
  try {
    const res = await fetch('/api/nifty-chart/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 3 })
    });
    const d = await res.json();
    if (d.success) {
      setAllCandles(d.candles || [], d.candles1m || []);
      if (d.added > 0) {
        showToast(`Saved ${d.added} 3-minute candles from ${d.broker || 'broker'} to SQLite!`, 'success');
      } else {
        showToast('No historical candles returned (verify an active live broker is logged in).', 'warning');
      }
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    C_DOM.backfillBtn.disabled = false;
  }
});

window.addEventListener('DOMContentLoaded', () => {
  initChartRenderer();
  loadNiftySpotSnapshot();
  loadInitialChart();
  initEventSource();
});
