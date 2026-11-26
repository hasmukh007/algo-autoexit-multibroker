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
  livePriceLine: null,
  liveCountdownText: '--:--',
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
  candleCountdownTopLabel: document.getElementById('candleCountdownTopLabel'),
  candleCountdownDisplay: document.getElementById('candleCountdownDisplay'),
  candleBarCountdown: document.getElementById('candleBarCountdown'),
  openChartOrderBtn: document.getElementById('openChartOrderBtn'),
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
  toastContainer: document.getElementById('toastContainer'),

  // Chart Quick Order Modal
  chartOrderModal: document.getElementById('chartOrderModal'),
  closeChartOrderModal: document.getElementById('closeChartOrderModal'),
  cancelChartOrderBtn: document.getElementById('cancelChartOrderBtn'),
  chartOrderModalTitle: document.getElementById('chartOrderModalTitle'),
  chartOrderForm: document.getElementById('chartOrderForm'),
  chOrdSymbol: document.getElementById('chOrdSymbol'),
  chOrdToken: document.getElementById('chOrdToken'),
  chOrdSymbolLabel: document.getElementById('chOrdSymbolLabel'),
  chOrdLtpLabel: document.getElementById('chOrdLtpLabel'),
  chOrdBalanceLabel: document.getElementById('chOrdBalanceLabel'),
  chOrdBroker: document.getElementById('chOrdBroker'),
  chOrdRoutingMode: document.getElementById('chOrdRoutingMode'),
  chOrdStrikeSelect: document.getElementById('chOrdStrikeSelect'),
  chResetAtmBtn: document.getElementById('chResetAtmBtn'),
  chCeBtn: document.getElementById('chCeBtn'),
  chPeBtn: document.getElementById('chPeBtn'),
  chOrdSide: document.getElementById('chOrdSide'),
  chOrdProduct: document.getElementById('chOrdProduct'),
  chOrdQtyLabel: document.getElementById('chOrdQtyLabel'),
  chAutoQty: document.getElementById('chAutoQty'),
  chOrdQty: document.getElementById('chOrdQty'),
  chSizingHint: document.getElementById('chSizingHint'),
  chOrdType: document.getElementById('chOrdType'),
  chOrdPricingRow: document.getElementById('chOrdPricingRow'),
  chOrdTriggerGroup: document.getElementById('chOrdTriggerGroup'),
  chOrdTriggerPrice: document.getElementById('chOrdTriggerPrice'),
  chOrdPriceGroup: document.getElementById('chOrdPriceGroup'),
  chOrdPriceLabel: document.getElementById('chOrdPriceLabel'),
  chOrdPriceHint: document.getElementById('chOrdPriceHint'),
  chOrdPrice: document.getElementById('chOrdPrice'),
  submitChartOrderBtn: document.getElementById('submitChartOrderBtn')
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

function getActiveBarPeriodSeconds() {
  if (chartState.activeTf === '5m_ha') return 300;
  if (chartState.activeTf === '15m_ha') return 900;
  if (chartState.activeTf === '1h_ha') return 3600;
  return 180;
}

function getActiveTfShortLabel() {
  if (chartState.activeTf === '5m_ha') return '5m HA';
  if (chartState.activeTf === '15m_ha') return '15m HA';
  if (chartState.activeTf === '1h_ha') return '1h HA';
  return '3m';
}

function updateCandleCountdown(istNow) {
  const now = istNow || new Date(Date.now() + IST_OFFSET_SEC * 1000);
  const useUtcFields = !istNow;
  const day = useUtcFields ? now.getUTCDay() : now.getDay();
  const hh = useUtcFields ? now.getUTCHours() : now.getHours();
  const mm = useUtcFields ? now.getUTCMinutes() : now.getMinutes();
  const ss = useUtcFields ? now.getUTCSeconds() : now.getSeconds();
  const secOfDay = hh * 3600 + mm * 60 + ss;
  const closeSec = 15 * 3600 + 30 * 60;
  const tfSec = getActiveBarPeriodSeconds();
  const tfLabel = getActiveTfShortLabel();

  let topLabel = `Bar (${tfLabel}):`;
  let countdownStr = '--:--';

  if (day >= 1 && day <= 5 && secOfDay >= NSE_SESSION_START_SEC && secOfDay < closeSec) {
    const elapsedInSession = secOfDay - NSE_SESSION_START_SEC;
    const nextCloseElapsed = Math.min(closeSec - NSE_SESSION_START_SEC, (Math.floor(elapsedInSession / tfSec) + 1) * tfSec);
    const rem = Math.max(0, nextCloseElapsed - elapsedInSession);
    const rMin = Math.floor(rem / 60);
    const rSec = rem % 60;
    countdownStr = rem >= 3600
      ? `${String(Math.floor(rem / 3600)).padStart(2, '0')}:${String(Math.floor((rem % 3600) / 60)).padStart(2, '0')}:${String(rSec).padStart(2, '0')}`
      : `${String(rMin).padStart(2, '0')}:${String(rSec).padStart(2, '0')}`;
  } else {
    topLabel = 'Next Open:';
    let daysAhead = 0;
    if (day === 0) daysAhead = 1;
    else if (day === 6) daysAhead = 2;
    else if (secOfDay >= closeSec) daysAhead = day === 5 ? 3 : 1;
    const targetSec = daysAhead * 86400 + NSE_SESSION_START_SEC;
    const rem = Math.max(0, targetSec - secOfDay);
    const h = Math.floor(rem / 3600);
    const m = Math.floor((rem % 3600) / 60);
    const s = rem % 60;
    countdownStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  if (C_DOM.candleCountdownTopLabel) C_DOM.candleCountdownTopLabel.textContent = topLabel;
  if (C_DOM.candleCountdownDisplay) C_DOM.candleCountdownDisplay.textContent = countdownStr;
  if (C_DOM.candleBarCountdown) C_DOM.candleBarCountdown.textContent = countdownStr;
  chartState.liveCountdownText = countdownStr;
  if (typeof updateLivePriceLineWithCountdown === 'function') {
    updateLivePriceLineWithCountdown();
  }
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
  updateCandleCountdown(ist);
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
  if (typeof updateLivePriceLineWithCountdown === 'function') {
    updateLivePriceLineWithCountdown();
  }

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

function getLiveChartPriceAndColor() {
  const list = getDisplayedCandles(false);
  const lastCandle = list.length > 0 ? list[list.length - 1] : null;
  const spotLtp = Number(chartState.previousNiftyLtp || 0);
  const livePrice = (chartState.activeTf === '3m' && spotLtp > 0)
    ? spotLtp
    : (lastCandle ? Number(lastCandle.close) : spotLtp);
  if (!(livePrice > 0)) return null;
  const isUp = !lastCandle || livePrice >= Number(lastCandle.open);
  return { livePrice, color: isUp ? '#10b981' : '#ef4444' };
}

function updateLivePriceLineWithCountdown() {
  const info = getLiveChartPriceAndColor();
  if (!info) return;
  const lineTitle = `${getActiveTfShortLabel()} • ${chartState.liveCountdownText || '--:--'}`;
  if (chartState.candleSeries) {
    try {
      if (!chartState.livePriceLine) {
        chartState.livePriceLine = chartState.candleSeries.createPriceLine({
          price: info.livePrice,
          color: info.color,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: lineTitle
        });
      } else {
        chartState.livePriceLine.applyOptions({
          price: info.livePrice,
          color: info.color,
          title: lineTitle
        });
      }
    } catch (e) {}
  } else if (chartState.fallbackCanvas) {
    drawFallbackCandles();
  }
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
    updateLivePriceLineWithCountdown();

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
      wickDownColor: '#ef4444',
      priceLineVisible: false,
      lastValueVisible: false
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

  // Live Price Line with Bar Countdown
  const liveInfo = getLiveChartPriceAndColor();
  if (liveInfo && liveInfo.livePrice >= minP && liveInfo.livePrice <= maxP) {
    const yLive = yOf(liveInfo.livePrice);
    const cdText = chartState.liveCountdownText || '--:--';
    ctx.save();
    ctx.strokeStyle = liveInfo.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padLeft, yLive);
    ctx.lineTo(width - padRight, yLive);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = liveInfo.color;
    ctx.fillRect(width - padRight + 2, yLive - 10, padRight - 6, 30);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px JetBrains Mono, monospace';
    ctx.fillText(liveInfo.livePrice.toFixed(2), width - padRight + 6, yLive + 2);
    ctx.fillStyle = '#fef08a';
    ctx.fillText(cdText, width - padRight + 6, yLive + 14);
    ctx.restore();
  }
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
      updateChartOrderSnapshot(d.data);
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
      const snap = JSON.parse(e.data);
      updateTopNiftyBar(snap);
      updateChartOrderSnapshot(snap);
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
      updateClock();
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

/* ============================================================
   CHART QUICK ORDER MODAL (ATM CE/PE, STRIKES, COUNTDOWN & SIZING)
   ============================================================ */

const chartOrderState = {
  snapshot: null,
  optType: 'CE', // 'CE' | 'PE'
  useAtm: true,
  selectedStrike: null,
  strikeSig: '',
  ltp: 0,
  lotSize: 65,
  freezeQty: 1755,
  availableCash: 0,
  rate: 0,
  limitEdited: false,
  triggerEdited: false,
  sizingSeq: 0,
  routingMode: 'selected',
  eligibleBrokers: [],
  skippedBrokers: []
};

function roundChTick(val, step = 0.05) {
  const n = Number(val || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Number((Math.round(n / step) * step).toFixed(2));
}

function defaultChLimitPrice(basePrice, side) {
  const p = Number(basePrice || 0);
  if (!(p > 0)) return 0;
  return roundChTick(Math.max(0.05, p + (side === 'S' ? -0.5 : 0.5)));
}

async function loadChartOrderAccounts() {
  try {
    const [accRes, statusRes] = await Promise.all([
      fetch('/api/accounts'),
      fetch('/api/status')
    ]);
    const d = await accRes.json();
    const st = await statusRes.json().catch(() => null);
    let storedRoute = '';
    try { storedRoute = localStorage.getItem('algo_order_routing_mode') || ''; } catch (e) {}
    const rMode = storedRoute || (st && st.success && st.riskSettings && st.riskSettings.orderRoutingMode) || 'selected';
    if (C_DOM.chOrdRoutingMode) {
      C_DOM.chOrdRoutingMode.value = rMode === 'all_funded' ? 'all_funded' : 'selected';
    }
    if (d.success && Array.isArray(d.data) && C_DOM.chOrdBroker) {
      let storedBroker = '';
      try { storedBroker = localStorage.getItem('algo_selected_order_broker') || ''; } catch (e) {}
      const prev = C_DOM.chOrdBroker.value || storedBroker;
      C_DOM.chOrdBroker.innerHTML = '';
      d.data.forEach(acc => {
        const opt = document.createElement('option');
        opt.value = acc.id;
        opt.textContent = `${acc.name} (${acc.broker.toUpperCase()})`;
        C_DOM.chOrdBroker.appendChild(opt);
      });
      if (prev && d.data.some(a => a.id === prev)) {
        C_DOM.chOrdBroker.value = prev;
      }
    }
  } catch (e) {}
}

function populateChartStrikeDropdown(snap) {
  if (!C_DOM.chOrdStrikeSelect || !snap || !Array.isArray(snap.strikes) || snap.strikes.length === 0) return;
  const sig = snap.strikes.map(r => `${r.strike}:${r.isAtm ? 1 : 0}`).join('|');
  const formatLbl = row => {
    const tag = row.isAtm ? ' (ATM)' : (row.moneynessLabel ? ` (${row.moneynessLabel})` : '');
    const ceL = row.ce && Number(row.ce.ltp) > 0 ? `CE ₹${Number(row.ce.ltp).toFixed(1)}` : 'CE --';
    const peL = row.pe && Number(row.pe.ltp) > 0 ? `PE ₹${Number(row.pe.ltp).toFixed(1)}` : 'PE --';
    return `${row.strike}${tag} — ${ceL} | ${peL}`;
  };
  if (C_DOM.chOrdStrikeSelect.options.length !== snap.strikes.length || chartOrderState.strikeSig !== sig) {
    chartOrderState.strikeSig = sig;
    C_DOM.chOrdStrikeSelect.innerHTML = '';
    snap.strikes.forEach(row => {
      const opt = document.createElement('option');
      opt.value = String(row.strike);
      opt.textContent = formatLbl(row);
      C_DOM.chOrdStrikeSelect.appendChild(opt);
    });
  } else {
    snap.strikes.forEach((row, idx) => {
      const opt = C_DOM.chOrdStrikeSelect.options[idx];
      if (opt) opt.textContent = formatLbl(row);
    });
  }
  const desired = (!chartOrderState.useAtm && chartOrderState.selectedStrike)
    ? String(chartOrderState.selectedStrike)
    : String(snap.atmStrike || snap.strikes[Math.floor(snap.strikes.length / 2)].strike);
  if (C_DOM.chOrdStrikeSelect.value !== desired && Array.from(C_DOM.chOrdStrikeSelect.options).some(o => o.value === desired)) {
    C_DOM.chOrdStrikeSelect.value = desired;
  }
}

function applyChartOrderContract(userChanged = false) {
  const snap = chartOrderState.snapshot;
  if (C_DOM.chCeBtn) C_DOM.chCeBtn.classList.toggle('active', chartOrderState.optType === 'CE');
  if (C_DOM.chPeBtn) C_DOM.chPeBtn.classList.toggle('active', chartOrderState.optType === 'PE');
  if (!snap || !Array.isArray(snap.strikes) || snap.strikes.length === 0) return;

  populateChartStrikeDropdown(snap);
  let row = null;
  if (!chartOrderState.useAtm && chartOrderState.selectedStrike) {
    row = snap.strikes.find(r => Number(r.strike) === Number(chartOrderState.selectedStrike));
  }
  if (!row) {
    row = snap.strikes.find(r => r.isAtm || r.strike === snap.atmStrike) ||
      snap.strikes[Math.floor(snap.strikes.length / 2)];
  }
  const leg = row ? (chartOrderState.optType === 'PE' ? row.pe : row.ce) : null;
  if (!leg) return;

  const prevSym = (C_DOM.chOrdSymbol && C_DOM.chOrdSymbol.value) || '';
  const symChanged = Boolean(leg.symbol && prevSym !== leg.symbol);
  if (C_DOM.chOrdSymbol) C_DOM.chOrdSymbol.value = leg.symbol || '';
  if (C_DOM.chOrdToken) C_DOM.chOrdToken.value = leg.instrumentToken || '';
  if (C_DOM.chOrdSymbolLabel) C_DOM.chOrdSymbolLabel.textContent = leg.symbol || '--';
  if (Number(leg.ltp) > 0) chartOrderState.ltp = Number(leg.ltp);
  if (C_DOM.chOrdLtpLabel) {
    C_DOM.chOrdLtpLabel.textContent = chartOrderState.ltp > 0 ? `₹${chartOrderState.ltp.toFixed(2)}` : '--';
  }
  if (userChanged || symChanged) {
    chartOrderState.limitEdited = false;
    chartOrderState.triggerEdited = false;
    syncChartOrderPricingUI(true);
    recalcChartOrderQty();
  } else if (C_DOM.chOrdType && C_DOM.chOrdType.value === 'MKT' && C_DOM.chartOrderModal && C_DOM.chartOrderModal.classList.contains('active')) {
    recalcChartOrderQty();
  }
}

function updateChartOrderSnapshot(snapshot) {
  if (!snapshot) return;
  chartOrderState.snapshot = snapshot;
  applyChartOrderContract(false);
}

function syncChartOrderPricingUI(forceDefaults = false) {
  const ot = C_DOM.chOrdType ? C_DOM.chOrdType.value : 'MKT';
  const side = (C_DOM.chOrdSide && C_DOM.chOrdSide.value) || 'B';
  const ltp = Number(chartOrderState.ltp || 0);

  if (C_DOM.submitChartOrderBtn) {
    C_DOM.submitChartOrderBtn.className = side === 'S' ? 'btn-primary btn-sell' : 'btn-primary btn-buy';
    C_DOM.submitChartOrderBtn.textContent = side === 'S' ? 'Place SELL Order' : 'Place BUY Order';
  }

  if (ot === 'MKT') {
    if (C_DOM.chOrdPricingRow) C_DOM.chOrdPricingRow.style.display = 'none';
    if (C_DOM.chOrdTriggerGroup) C_DOM.chOrdTriggerGroup.style.display = 'none';
    return;
  }
  if (C_DOM.chOrdPricingRow) C_DOM.chOrdPricingRow.style.display = 'grid';

  if (ot === 'SL') {
    if (C_DOM.chOrdTriggerGroup) C_DOM.chOrdTriggerGroup.style.display = 'block';
    if (C_DOM.chOrdPriceLabel) C_DOM.chOrdPriceLabel.textContent = 'SL Limit Price (₹)';
    if (C_DOM.chOrdPriceHint) {
      C_DOM.chOrdPriceHint.textContent = side === 'S' ? 'Default = Trigger - 0.50 (Sell)' : 'Default = Trigger + 0.50 (Buy)';
    }
    if (forceDefaults) {
      if (C_DOM.chOrdTriggerPrice && !chartOrderState.triggerEdited && ltp > 0) {
        C_DOM.chOrdTriggerPrice.value = roundChTick(ltp).toFixed(2);
      }
      const trig = Number((C_DOM.chOrdTriggerPrice && C_DOM.chOrdTriggerPrice.value) || ltp || 0);
      if (C_DOM.chOrdPrice && !chartOrderState.limitEdited && trig > 0) {
        C_DOM.chOrdPrice.value = defaultChLimitPrice(trig, side).toFixed(2);
      }
    }
    return;
  }

  if (C_DOM.chOrdTriggerGroup) C_DOM.chOrdTriggerGroup.style.display = 'none';
  if (C_DOM.chOrdPriceLabel) C_DOM.chOrdPriceLabel.textContent = 'Limit Price (₹)';
  if (C_DOM.chOrdPriceHint) {
    C_DOM.chOrdPriceHint.textContent = side === 'S' ? 'Default = LTP - 0.50 (Sell)' : 'Default = LTP + 0.50 (Buy)';
  }
  if (forceDefaults && C_DOM.chOrdPrice && !chartOrderState.limitEdited && ltp > 0) {
    C_DOM.chOrdPrice.value = defaultChLimitPrice(ltp, side).toFixed(2);
  }
}

function updateChartOrderSizingHint() {
  if (!C_DOM.chSizingHint) return;
  const qty = Math.round(Number((C_DOM.chOrdQty && C_DOM.chOrdQty.value) || 0));
  const fq = Number(chartOrderState.freezeQty || 0);
  const lot = Number(chartOrderState.lotSize || 65);
  const rate = Number(chartOrderState.rate || 0);
  const maxSlice = fq > 0 ? Math.max(lot, Math.floor(fq / lot) * lot) : 0;
  const sliceCount = (fq > 0 && qty > fq) ? Math.ceil(qty / maxSlice) : (qty > 0 ? 1 : 0);
  const splitNote = sliceCount > 1 ? ` • Auto-splits into ${sliceCount} orders (max ${maxSlice}/order)` : '';
  const insNote = (C_DOM.chAutoQty && C_DOM.chAutoQty.checked && rate > 0 && qty === 0)
    ? ` • Need ₹${(lot * rate).toFixed(2)} for 1 lot`
    : '';
  const rateNote = rate > 0 ? `Rate: ₹${rate.toFixed(2)} | ` : '';
  if (chartOrderState.routingMode === 'all_funded' && Array.isArray(chartOrderState.eligibleBrokers)) {
    const elig = chartOrderState.eligibleBrokers;
    const skip = chartOrderState.skippedBrokers || [];
    const eligTxt = elig.length > 0 ? elig.map(b => `${b.name}: ${b.quantity}`).join(', ') : 'None';
    C_DOM.chSizingHint.textContent = `All Funded (${elig.length}/${elig.length + skip.length}): ${eligTxt} | ${rateNote}Lot: ${lot}`;
    return;
  }
  C_DOM.chSizingHint.textContent = `${rateNote}Lot: ${lot} | Freeze: ${fq > 0 ? fq : 'None'}${splitNote}${insNote}`;
}

async function recalcChartOrderQty() {
  const seq = ++chartOrderState.sizingSeq;
  try {
    const symbol = (C_DOM.chOrdSymbol && C_DOM.chOrdSymbol.value) || '';
    const accountId = (C_DOM.chOrdBroker && C_DOM.chOrdBroker.value) || '';
    if (!symbol || !accountId) return;
    const ot = C_DOM.chOrdType ? C_DOM.chOrdType.value : 'MKT';
    const side = (C_DOM.chOrdSide && C_DOM.chOrdSide.value) || 'B';
    const price = ot === 'MKT' ? 0 : Number((C_DOM.chOrdPrice && C_DOM.chOrdPrice.value) || 0);
    const triggerPrice = ot === 'SL' && C_DOM.chOrdTriggerPrice ? Number(C_DOM.chOrdTriggerPrice.value || 0) : 0;
    const routingMode = (C_DOM.chOrdRoutingMode && C_DOM.chOrdRoutingMode.value) || 'selected';

    const res = await fetch('/api/orders/calculate-quantity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId,
        routingMode,
        tradingSymbol: symbol,
        instrumentToken: C_DOM.chOrdToken ? C_DOM.chOrdToken.value : '',
        exchangeSegment: 'NFO',
        orderType: ot,
        transactionType: side,
        lotSize: chartOrderState.lotSize,
        price,
        triggerPrice,
        ltp: Number(chartOrderState.ltp || 0)
      })
    });
    const d = await res.json();
    if (seq !== chartOrderState.sizingSeq) return;
    if (d.success && d.data) {
      chartOrderState.lotSize = d.data.lotSize || 65;
      chartOrderState.freezeQty = d.data.freezeQty || 0;
      chartOrderState.availableCash = d.data.availableCash || 0;
      chartOrderState.rate = Number(d.data.price || 0);
      chartOrderState.routingMode = d.data.routingMode || routingMode;
      chartOrderState.eligibleBrokers = d.data.eligibleBrokers || [];
      chartOrderState.skippedBrokers = d.data.skippedBrokers || [];
      if (C_DOM.chOrdBalanceLabel) {
        C_DOM.chOrdBalanceLabel.textContent = `₹${Number(chartOrderState.availableCash).toLocaleString('en-IN')}`;
      }
      if (C_DOM.chOrdQtyLabel) {
        C_DOM.chOrdQtyLabel.textContent = `Quantity (Lot Size = ${chartOrderState.lotSize})`;
      }
      if (C_DOM.chOrdQty) {
        C_DOM.chOrdQty.min = chartOrderState.lotSize;
        C_DOM.chOrdQty.step = chartOrderState.lotSize;
        if (C_DOM.chAutoQty && C_DOM.chAutoQty.checked) {
          C_DOM.chOrdQty.value = Math.max(0, Number(d.data.quantity || 0));
        }
      }
      updateChartOrderSizingHint();
    }
  } catch (e) {}
}

if (C_DOM.openChartOrderBtn) {
  C_DOM.openChartOrderBtn.addEventListener('click', async () => {
    await loadChartOrderAccounts();
    applyChartOrderContract(true);
    syncChartOrderPricingUI(true);
    if (C_DOM.chartOrderModal) C_DOM.chartOrderModal.classList.add('active');
    recalcChartOrderQty();
  });
}
if (C_DOM.closeChartOrderModal) {
  C_DOM.closeChartOrderModal.addEventListener('click', () => C_DOM.chartOrderModal.classList.remove('active'));
}
if (C_DOM.cancelChartOrderBtn) {
  C_DOM.cancelChartOrderBtn.addEventListener('click', () => C_DOM.chartOrderModal.classList.remove('active'));
}
if (C_DOM.chCeBtn) {
  C_DOM.chCeBtn.addEventListener('click', () => {
    chartOrderState.optType = 'CE';
    applyChartOrderContract(true);
  });
}
if (C_DOM.chPeBtn) {
  C_DOM.chPeBtn.addEventListener('click', () => {
    chartOrderState.optType = 'PE';
    applyChartOrderContract(true);
  });
}
if (C_DOM.chResetAtmBtn) {
  C_DOM.chResetAtmBtn.addEventListener('click', () => {
    chartOrderState.useAtm = true;
    chartOrderState.selectedStrike = null;
    applyChartOrderContract(true);
  });
}
if (C_DOM.chOrdStrikeSelect) {
  C_DOM.chOrdStrikeSelect.addEventListener('change', () => {
    const val = Number(C_DOM.chOrdStrikeSelect.value || 0);
    if (val > 0) {
      chartOrderState.useAtm = false;
      chartOrderState.selectedStrike = val;
      applyChartOrderContract(true);
    }
  });
}
if (C_DOM.chOrdSide) {
  C_DOM.chOrdSide.addEventListener('change', () => {
    chartOrderState.limitEdited = false;
    syncChartOrderPricingUI(true);
    recalcChartOrderQty();
  });
}
if (C_DOM.chOrdType) {
  C_DOM.chOrdType.addEventListener('change', () => {
    chartOrderState.limitEdited = false;
    chartOrderState.triggerEdited = false;
    syncChartOrderPricingUI(true);
    recalcChartOrderQty();
  });
}
if (C_DOM.chOrdTriggerPrice) {
  C_DOM.chOrdTriggerPrice.addEventListener('input', () => {
    chartOrderState.triggerEdited = true;
    const trig = Number(C_DOM.chOrdTriggerPrice.value || 0);
    if (C_DOM.chOrdType && C_DOM.chOrdType.value === 'SL' && trig > 0 && !chartOrderState.limitEdited) {
      C_DOM.chOrdPrice.value = defaultChLimitPrice(trig, C_DOM.chOrdSide.value).toFixed(2);
    }
    recalcChartOrderQty();
  });
}
if (C_DOM.chOrdPrice) {
  C_DOM.chOrdPrice.addEventListener('input', () => {
    chartOrderState.limitEdited = true;
    recalcChartOrderQty();
  });
}
if (C_DOM.chOrdBroker) {
  C_DOM.chOrdBroker.addEventListener('change', () => {
    try { localStorage.setItem('algo_selected_order_broker', C_DOM.chOrdBroker.value || ''); } catch (e) {}
    recalcChartOrderQty();
  });
}
if (C_DOM.chOrdRoutingMode) {
  C_DOM.chOrdRoutingMode.addEventListener('change', () => {
    try { localStorage.setItem('algo_order_routing_mode', C_DOM.chOrdRoutingMode.value || 'selected'); } catch (e) {}
    recalcChartOrderQty();
  });
}
if (C_DOM.chAutoQty) {
  C_DOM.chAutoQty.addEventListener('change', recalcChartOrderQty);
}
if (C_DOM.chOrdQty) {
  C_DOM.chOrdQty.addEventListener('input', () => {
    if (C_DOM.chAutoQty) C_DOM.chAutoQty.checked = false;
    updateChartOrderSizingHint();
  });
}
if (C_DOM.chartOrderForm) {
  C_DOM.chartOrderForm.addEventListener('submit', async e => {
    e.preventDefault();
    const ot = C_DOM.chOrdType.value;
    const payload = {
      accountId: C_DOM.chOrdBroker.value,
      routingMode: (C_DOM.chOrdRoutingMode && C_DOM.chOrdRoutingMode.value) || 'selected',
      tradingSymbol: C_DOM.chOrdSymbol.value,
      instrumentToken: C_DOM.chOrdToken ? C_DOM.chOrdToken.value : '',
      exchangeSegment: 'nse_fo',
      transactionType: C_DOM.chOrdSide.value,
      product: C_DOM.chOrdProduct.value,
      orderType: ot,
      quantity: Number(C_DOM.chOrdQty.value),
      autoQuantity: Boolean(C_DOM.chAutoQty && C_DOM.chAutoQty.checked),
      lotSize: chartOrderState.lotSize,
      freezeQty: chartOrderState.freezeQty,
      price: ot === 'MKT' ? 0 : Number(C_DOM.chOrdPrice.value || 0),
      triggerPrice: ot === 'SL' && C_DOM.chOrdTriggerPrice ? Number(C_DOM.chOrdTriggerPrice.value || 0) : 0,
      ltp: chartOrderState.ltp
    };
    C_DOM.submitChartOrderBtn.disabled = true;
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const d = await res.json();
      if (d.success) {
        const msg = d.routingMode === 'all_funded'
          ? `Executed on ${d.executedCount} funded broker(s): ${(d.executedBrokers || []).map(b => `${b.name} (${b.quantity})`).join(', ')}`
          : (d.sliced
            ? `Order split into ${d.sliceCount} orders (Freeze ${d.freezeQty}): ${payload.transactionType === 'B' ? 'BUY' : 'SELL'} ${payload.tradingSymbol} x ${d.totalQuantity}`
            : `Order placed: ${payload.transactionType === 'B' ? 'BUY' : 'SELL'} ${payload.tradingSymbol} x ${d.totalQuantity || payload.quantity}`);
        showToast(msg, 'success');
        C_DOM.chartOrderModal.classList.remove('active');
      } else {
        showToast(d.message || 'Order failed', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      C_DOM.submitChartOrderBtn.disabled = false;
    }
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initChartRenderer();
  loadNiftySpotSnapshot();
  loadInitialChart();
  loadChartOrderAccounts();
  initEventSource();
});
