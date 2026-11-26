/**
 * NIFTY 50 3-Minute Live Chart Controller
 * - Loads stored candles from local SQLite (/api/nifty-chart, auto-backfilling 3 days if empty)
 * - Streams real-time WebSocket 3-minute candle updates via SSE (nifty_candle)
 * - Renders via TradingView Lightweight Charts (with built-in Canvas 2D OHLC fallback)
 */

const chartState = {
  candles: [],
  previousNiftyLtp: null,
  lwChart: null,
  candleSeries: null,
  fallbackCanvas: null,
  hoverIndex: null
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
  resetZoomBtn: document.getElementById('resetZoomBtn'),
  backfillBtn: document.getElementById('backfillBtn'),
  connStatus: document.getElementById('connStatus'),
  connLabel: document.getElementById('connLabel'),

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
  const d = new Date((Number(epochSec) + 19800) * 1000);
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
    C_DOM.topNiftyLtp.textContent = ltp.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
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
      ? `9:00 AM Live Feed • WebSocket Streaming`
      : `9:00 AM Feed • Awaiting Live Broker Quote`;
  } else {
    C_DOM.topNiftyFeedPill.className = 'nifty-feed-pill waiting';
    C_DOM.topNiftyFeedStatus.textContent = `Live Option Feed Scheduled for ${fs.scheduledTimeIST || '09:00 IST'}`;
  }
}

function updateOhlcStrip(candle) {
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
  C_DOM.candleSourceDisplay.textContent = candle.source === 'ws' ? 'WebSocket (Live)' : 'Broker REST (3D History)';
}

function initChartRenderer() {
  if (window.LightweightCharts) {
    const chart = window.LightweightCharts.createChart(C_DOM.chartContainer, {
      layout: {
        background: { color: '#0b1222' },
        textColor: '#94a3b8'
      },
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

    chart.subscribeCrosshairMove(param => {
      if (param && param.time && param.seriesData) {
        const d = param.seriesData.get(candleSeries);
        if (d) {
          const match = chartState.candles.find(c => c.time === param.time);
          updateOhlcStrip({ ...d, time: param.time, source: match ? match.source : 'ws' });
          return;
        }
      }
      if (chartState.candles.length > 0) {
        updateOhlcStrip(chartState.candles[chartState.candles.length - 1]);
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
    const visible = chartState.candles.slice(-120);
    if (visible.length === 0) return;
    const plotW = Math.max(1, rect.width - 75);
    const step = plotW / visible.length;
    const idx = Math.max(0, Math.min(visible.length - 1, Math.floor((x - 12) / step)));
    chartState.hoverIndex = idx;
    updateOhlcStrip(visible[idx]);
    drawFallbackCandles();
  });

  canvas.addEventListener('mouseleave', () => {
    chartState.hoverIndex = null;
    if (chartState.candles.length > 0) {
      updateOhlcStrip(chartState.candles[chartState.candles.length - 1]);
    }
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

  const visible = chartState.candles.slice(-120);
  if (visible.length === 0) return;

  const padLeft = 12;
  const padRight = 70;
  const padTop = 18;
  const padBottom = 28;
  const plotW = Math.max(50, width - padLeft - padRight);
  const plotH = Math.max(50, height - padTop - padBottom);

  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of visible) {
    if (c.low < minP) minP = c.low;
    if (c.high > maxP) maxP = c.high;
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

function setAllCandles(candles) {
  chartState.candles = Array.isArray(candles) ? candles : [];
  C_DOM.chartDbCountBadge.textContent = `${chartState.candles.length} Candles`;

  if (chartState.candles.length === 0) {
    C_DOM.chartEmptyOverlay.style.display = 'flex';
    C_DOM.chartStatusText.textContent = 'No 3-minute candles yet. Connect a live broker or click Load 3 Days History.';
    updateOhlcStrip(null);
  } else {
    C_DOM.chartEmptyOverlay.style.display = 'none';
    const latest = chartState.candles[chartState.candles.length - 1];
    updateOhlcStrip(latest);
    C_DOM.chartStatusText.textContent = `Showing ${chartState.candles.length} NIFTY 3m candles (SQLite persisted + WebSocket live)`;
  }

  if (chartState.candleSeries) {
    chartState.candleSeries.setData(
      chartState.candles.map(c => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      }))
    );
    chartState.lwChart.timeScale().fitContent();
  } else {
    drawFallbackCandles();
  }
}

function applyLiveCandle(candle) {
  if (!candle) return;
  const list = chartState.candles;
  const last = list[list.length - 1];

  if (last && last.time === candle.time) {
    list[list.length - 1] = candle;
  } else if (!last || candle.time > last.time) {
    list.push(candle);
  }

  C_DOM.chartDbCountBadge.textContent = `${list.length} Candles`;
  C_DOM.chartEmptyOverlay.style.display = 'none';
  updateOhlcStrip(candle);
  C_DOM.chartStatusText.textContent = `Live WebSocket 3m Candle • ${list.length} candles in SQLite`;

  if (chartState.candleSeries) {
    chartState.candleSeries.update({
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close
    });
  } else {
    drawFallbackCandles();
  }
}

async function loadInitialChart() {
  try {
    const res = await fetch('/api/nifty-chart?days=3');
    const d = await res.json();
    if (d.success) {
      setAllCandles(d.candles || []);
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
        applyLiveCandle(payload.candle);
      }
    } catch (err) {}
  });

  es.addEventListener('nifty_candles_reset', e => {
    try {
      const payload = JSON.parse(e.data);
      if (payload && Array.isArray(payload.candles)) {
        setAllCandles(payload.candles);
      }
    } catch (err) {}
  });

  es.onerror = () => {
    C_DOM.connLabel.textContent = 'Reconnecting...';
    C_DOM.connStatus.querySelector('.status-indicator').className = 'status-indicator offline';
  };
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
      setAllCandles(d.candles || []);
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
