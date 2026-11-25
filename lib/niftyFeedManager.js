const EventEmitter = require('events');

const NIFTY_STRIKE_STEP = 50;
const ITM_COUNT = 10;
const OTM_COUNT = 10;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Get current IST date/time components.
 */
function getISTInfo(now = new Date()) {
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utcMs + 3600000 * 5.5);
  const year = ist.getFullYear();
  const month = String(ist.getMonth() + 1).padStart(2, '0');
  const day = String(ist.getDate()).padStart(2, '0');
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const seconds = ist.getSeconds();
  const dateStr = `${year}-${month}-${day}`;
  const timeFormatted = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} IST`;
  return { ist, dateStr, hours, minutes, seconds, timeFormatted };
}

/**
 * Compute nearest Thursday expiry label (e.g. "26NOV") for NIFTY weekly contracts.
 */
function getNearestExpiryLabel(istDate = getISTInfo().ist) {
  const d = new Date(istDate.getTime());
  const day = d.getDay(); // 0=Sun..4=Thu..6=Sat
  const daysUntilThu = (4 - day + 7) % 7;
  d.setDate(d.getDate() + daysUntilThu);
  const dd = String(d.getDate()).padStart(2, '0');
  const mmm = MONTHS[d.getMonth()];
  return `${dd}${mmm}`;
}

function computeAtmStrike(spotPrice, step = NIFTY_STRIKE_STEP) {
  const num = Number(spotPrice);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num / step) * step;
}

/**
 * Classify OI Built-Up from price change and OI change.
 */
function computeOiBuildup(priceChange, oiChange) {
  if (priceChange === null || priceChange === undefined || oiChange === null || oiChange === undefined) {
    return { label: null, code: null };
  }
  const p = Number(priceChange);
  const o = Number(oiChange);
  if (p >= 0 && o >= 0) return { label: 'Long Built Up', code: 'long_buildup' };
  if (p < 0 && o >= 0) return { label: 'Short Built Up', code: 'short_buildup' };
  if (p >= 0 && o < 0) return { label: 'Short Covering', code: 'short_covering' };
  return { label: 'Long Unwinding', code: 'long_unwinding' };
}

function createEmptyOptionLeg(strike, optionType, expiryLabel, atmStrike) {
  const isCall = optionType === 'CE';
  const stepsFromAtm = Math.round((strike - atmStrike) / NIFTY_STRIKE_STEP);
  let moneyness = 'ATM';
  let moneynessLabel = 'ATM';
  if (stepsFromAtm !== 0) {
    const absSteps = Math.abs(stepsFromAtm);
    moneyness = isCall ? (stepsFromAtm < 0 ? 'ITM' : 'OTM') : (stepsFromAtm > 0 ? 'ITM' : 'OTM');
    moneynessLabel = `${moneyness} ${absSteps}`;
  }

  return {
    symbol: `NIFTY ${expiryLabel} ${strike} ${optionType}`,
    strike,
    optionType,
    moneyness,
    moneynessLabel,
    ltp: null,
    prevClose: null,
    change: null,
    changePct: null,
    bid: null,
    ask: null,
    volume: null,
    oi: null,
    oiChange: null,
    oiBuildup: null,
    oiBuildupCode: null,
    iv: null,
    lastUpdated: null
  };
}

/**
 * Manages live NIFTY 50 spot price and the 9:00 AM IST Option Feed
 * (10 ITM + 1 ATM + 10 OTM Calls & Puts = 21 strikes / 42 option contracts).
 * Uses strictly live broker market data (no mock/simulated feed).
 */
class NiftyFeedManager extends EventEmitter {
  constructor(multiBrokerManager, configManager, options = {}) {
    super();
    this.multiBrokerManager = multiBrokerManager;
    this.configManager = configManager;

    this.tickIntervalMs = options.tickIntervalMs || 1500;
    this.scheduleCheckMs = options.scheduleCheckMs || 5000;
    this.startHourIST = options.startHourIST !== undefined ? options.startHourIST : 9;
    this.startMinuteIST = options.startMinuteIST !== undefined ? options.startMinuteIST : 0;

    this.spot = {
      symbol: 'NIFTY 50',
      ltp: null,
      prevClose: null,
      open: null,
      high: null,
      low: null,
      change: null,
      changePct: null,
      lastUpdated: null
    };

    this.atmStrike = null;
    this.expiryLabel = getNearestExpiryLabel();
    this.strikes = [];

    this.feedState = {
      isRunning: false,
      status: 'WAITING_9AM', // 'WAITING_9AM' | 'ACTIVE' | 'STOPPED'
      autoStarted9AM: false,
      startedDate: null,
      startedAt: null,
      startedAtIST: null,
      scheduledTimeIST: `${String(this.startHourIST).padStart(2, '0')}:${String(this.startMinuteIST).padStart(2, '0')} IST`,
      sourceMode: 'live_waiting', // 'live_broker' | 'live_waiting'
      liveQuoteReceived: false,
      lastLiveQuoteAt: null,
      dataFeedSource: this.multiBrokerManager ? this.multiBrokerManager.getDataFeedSource() : 'kotakneo',
      feedSubscribed: false,
      subscribedBroker: null,
      subscribedAccountId: null,
      subscribedAccountName: null,
      subscribedAtIST: null,
      itmCount: ITM_COUNT,
      otmCount: OTM_COUNT,
      totalStrikes: ITM_COUNT + 1 + OTM_COUNT,
      totalContracts: (ITM_COUNT + 1 + OTM_COUNT) * 2
    };

    this._tickTimer = null;
    this._scheduleTimer = null;
    this._wsPushTimer = null;

    if (this.multiBrokerManager && typeof this.multiBrokerManager.on === 'function') {
      this.multiBrokerManager.on('ws_tick', () => {
        if (this._wsPushTimer) return;
        this._wsPushTimer = setTimeout(() => {
          this._wsPushTimer = null;
          this._tick().catch(() => {});
        }, 250);
      });
    }

    if (!options.disableTimers) {
      this.startBackgroundLoops();
    }
  }

  _buildOptionChainShell(centerAtmStrike) {
    if (!centerAtmStrike) return;
    const prevByStrike = new Map();
    for (const row of this.strikes) {
      prevByStrike.set(row.strike, row);
    }

    this.atmStrike = centerAtmStrike;
    const list = [];
    for (let offset = -ITM_COUNT; offset <= OTM_COUNT; offset++) {
      const strike = centerAtmStrike + offset * NIFTY_STRIKE_STEP;
      const ceShell = createEmptyOptionLeg(strike, 'CE', this.expiryLabel, centerAtmStrike);
      const peShell = createEmptyOptionLeg(strike, 'PE', this.expiryLabel, centerAtmStrike);
      const prevRow = prevByStrike.get(strike);
      if (prevRow) {
        Object.assign(ceShell, prevRow.ce, {
          moneyness: ceShell.moneyness,
          moneynessLabel: ceShell.moneynessLabel
        });
        Object.assign(peShell, prevRow.pe, {
          moneyness: peShell.moneyness,
          moneynessLabel: peShell.moneynessLabel
        });
      }
      list.push({
        strike,
        isAtm: offset === 0,
        distanceSteps: offset,
        ce: ceShell,
        pe: peShell
      });
    }
    this.strikes = list;
  }

  startBackgroundLoops() {
    this.stopBackgroundLoops();

    // Check 9:00 AM IST schedule immediately and periodically
    this._check9AMSchedule();
    this._scheduleTimer = setInterval(() => {
      this._check9AMSchedule();
    }, this.scheduleCheckMs);

    // Live tick loop (polls active broker for real live quotes)
    this._tickTimer = setInterval(() => {
      this._tick().catch(() => {});
    }, this.tickIntervalMs);
  }

  stopBackgroundLoops() {
    if (this._scheduleTimer) {
      clearInterval(this._scheduleTimer);
      this._scheduleTimer = null;
    }
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._wsPushTimer) {
      clearTimeout(this._wsPushTimer);
      this._wsPushTimer = null;
    }
  }

  /**
   * Auto-starts the NIFTY + 10 ITM + ATM + 10 OTM Call & Put feed at 9:00 AM IST.
   */
  _check9AMSchedule(now = new Date()) {
    const ist = getISTInfo(now);
    const isPast9AM = ist.hours > this.startHourIST ||
      (ist.hours === this.startHourIST && ist.minutes >= this.startMinuteIST);

    if (isPast9AM && this.feedState.startedDate !== ist.dateStr) {
      this.startFeed({ isAuto9AM: true, now });
    } else if (!isPast9AM && !this.feedState.isRunning) {
      this.feedState.status = 'WAITING_9AM';
    }
  }

  /**
   * Start (or restart) the NIFTY + 10 ITM + ATM + 10 OTM option chain feed.
   */
  startFeed({ isAuto9AM = false, recenter = true, now = new Date() } = {}) {
    const ist = getISTInfo(now);
    this.expiryLabel = getNearestExpiryLabel(ist.ist);

    if (this.spot.ltp && (recenter || this.strikes.length === 0)) {
      const atm = computeAtmStrike(this.spot.ltp);
      this._buildOptionChainShell(atm);
    }

    this.feedState.isRunning = true;
    this.feedState.status = 'ACTIVE';
    this.feedState.autoStarted9AM = isAuto9AM;
    this.feedState.startedDate = ist.dateStr;
    this.feedState.startedAt = now.toISOString();
    this.feedState.startedAtIST = ist.timeFormatted;
    this.feedState.dataFeedSource = this.multiBrokerManager
      ? this.multiBrokerManager.getDataFeedSource()
      : 'kotakneo';

    const eventPayload = {
      atmStrike: this.atmStrike,
      expiryLabel: this.expiryLabel,
      totalStrikes: this.strikes.length,
      totalContracts: this.strikes.length * 2,
      autoStarted9AM: isAuto9AM,
      startedAtIST: ist.timeFormatted
    };

    this.emit('feed_started', eventPayload);
    return this.getSnapshot();
  }

  stopFeed() {
    this.feedState.isRunning = false;
    this.feedState.status = 'STOPPED';
    this.emit('feed_stopped', { stoppedAtIST: getISTInfo().timeFormatted });
    return this.getSnapshot();
  }

  recenterAtm() {
    const newAtm = computeAtmStrike(this.spot.ltp);
    if (newAtm) {
      this._buildOptionChainShell(newAtm);
      this.emit('atm_recentered', { atmStrike: newAtm });
    }
    return this.getSnapshot();
  }

  /**
   * Immediately subscribe and start the NIFTY + 10 ITM + ATM + 10 OTM CE/PE feed
   * when a broker login is added or authenticated.
   */
  async subscribeOnBrokerLogin({ accountId, broker, accountName } = {}) {
    const ist = getISTInfo();
    if (broker) {
      this.feedState.dataFeedSource = broker;
      this.feedState.subscribedBroker = broker;
    }
    this.feedState.subscribedAccountId = accountId || null;
    this.feedState.subscribedAccountName = accountName || null;
    this.feedState.feedSubscribed = true;
    this.feedState.subscribedAtIST = ist.timeFormatted;

    const snapshot = this.startFeed({
      isAuto9AM: this.feedState.autoStarted9AM,
      recenter: !this.feedState.isRunning
    });

    // Pull immediate tick so live quote reflects right away
    const ticked = await this._tick();

    this.emit('feed_subscribed', {
      accountId: this.feedState.subscribedAccountId,
      broker: this.feedState.subscribedBroker,
      accountName: this.feedState.subscribedAccountName,
      atmStrike: ticked.atmStrike,
      totalStrikes: ticked.strikes.length,
      totalContracts: ticked.strikes.length * 2,
      subscribedAtIST: ist.timeFormatted
    });

    return ticked || snapshot;
  }

  async _tick() {
    let liveSpotLtp = null;
    let liveSpotQuote = null;
    let liveChain = null;

    if (this.multiBrokerManager) {
      this.feedState.dataFeedSource = this.multiBrokerManager.getDataFeedSource();
    }

    const nowIso = new Date().toISOString();

    if (this.feedState.isRunning && this.atmStrike && this.multiBrokerManager && typeof this.multiBrokerManager.getLiveNiftyOptionChain === 'function') {
      try {
        liveChain = await this.multiBrokerManager.getLiveNiftyOptionChain(this.atmStrike);
        if (liveChain && Number(liveChain.spotLtp) > 0) {
          liveSpotLtp = Number(liveChain.spotLtp);
        }
      } catch (e) {}
    }

    if (liveSpotLtp === null && this.multiBrokerManager && typeof this.multiBrokerManager.getLiveNiftySpotQuote === 'function') {
      try {
        liveSpotQuote = await this.multiBrokerManager.getLiveNiftySpotQuote();
        if (liveSpotQuote && Number(liveSpotQuote.ltp) > 0) {
          liveSpotLtp = Number(liveSpotQuote.ltp);
        }
      } catch (e) {}
    }

    if (liveSpotLtp !== null) {
      this.spot.ltp = Number(liveSpotLtp.toFixed(2));
      if (liveSpotQuote && Number(liveSpotQuote.prevClose) > 0) {
        this.spot.prevClose = Number(liveSpotQuote.prevClose);
      }
      if (liveSpotQuote && Number(liveSpotQuote.open) > 0) {
        this.spot.open = Number(liveSpotQuote.open);
      }
      const liveHigh = liveSpotQuote && Number(liveSpotQuote.high) > 0 ? Number(liveSpotQuote.high) : this.spot.ltp;
      const liveLow = liveSpotQuote && Number(liveSpotQuote.low) > 0 ? Number(liveSpotQuote.low) : this.spot.ltp;
      this.spot.high = this.spot.high ? Number(Math.max(this.spot.high, liveHigh, this.spot.ltp).toFixed(2)) : Number(liveHigh.toFixed(2));
      this.spot.low = this.spot.low ? Number(Math.min(this.spot.low, liveLow, this.spot.ltp).toFixed(2)) : Number(liveLow.toFixed(2));

      if (this.spot.prevClose && this.spot.prevClose > 0) {
        this.spot.change = Number((this.spot.ltp - this.spot.prevClose).toFixed(2));
        this.spot.changePct = Number(((this.spot.change / this.spot.prevClose) * 100).toFixed(2));
      } else {
        this.spot.change = 0;
        this.spot.changePct = 0;
      }
      this.spot.lastUpdated = nowIso;

      // Always auto-recenter 21 strikes (10 ITM + 1 ATM + 10 OTM) to current live ATM
      const computedAtm = computeAtmStrike(this.spot.ltp);
      if (computedAtm && (this.strikes.length === 0 || this.atmStrike !== computedAtm)) {
        const hadStrikes = this.strikes.length > 0;
        const previousAtm = this.atmStrike;
        this._buildOptionChainShell(computedAtm);
        if (hadStrikes && previousAtm !== computedAtm) {
          liveChain = null; // Re-fetch option chain centered on the new ATM strike
          this.emit('atm_recentered', { atmStrike: computedAtm, previousAtmStrike: previousAtm });
        }
      }
    }

    if (this.feedState.isRunning && !liveChain && this.atmStrike && this.multiBrokerManager && typeof this.multiBrokerManager.getLiveNiftyOptionChain === 'function') {
      try {
        liveChain = await this.multiBrokerManager.getLiveNiftyOptionChain(this.atmStrike);
      } catch (e) {}
    }

    if (this.feedState.isRunning && liveChain && liveChain.oc) {
      if (liveChain.expiry) {
        this.expiryLabel = liveChain.expiry;
      }
      this._applyLiveOptionChain(liveChain.oc, nowIso);
    }

    if (this.spot.ltp !== null || (liveChain && liveChain.oc)) {
      this.feedState.sourceMode = 'live_broker';
      this.feedState.liveQuoteReceived = true;
      this.feedState.lastLiveQuoteAt = nowIso;
    } else {
      this.feedState.sourceMode = 'live_waiting';
      this.feedState.liveQuoteReceived = false;
    }

    const snapshot = this.getSnapshot();
    this.emit('tick', snapshot);
    return snapshot;
  }

  _applyLiveOptionChain(ocMap, nowIso) {
    for (const row of this.strikes) {
      const strikeData = ocMap[String(row.strike)] || ocMap[`${row.strike}.000000`] || ocMap[row.strike];
      if (!strikeData) continue;
      if (strikeData.ce) this._applyLiveOptionLeg(row.ce, strikeData.ce, nowIso);
      if (strikeData.pe) this._applyLiveOptionLeg(row.pe, strikeData.pe, nowIso);
    }
  }

  _applyLiveOptionLeg(leg, live, nowIso) {
    if (live.symbol) leg.symbol = live.symbol;
    const ltp = live.last_price !== undefined ? Number(live.last_price) : leg.ltp;
    const prevClose = live.previous_close_price !== undefined ? Number(live.previous_close_price) : leg.prevClose;
    const oi = live.oi !== undefined ? Number(live.oi) : leg.oi;
    const prevOi = live.previous_oi !== undefined ? Number(live.previous_oi) : oi;
    const oiChange = (oi !== null && prevOi !== null) ? (oi - prevOi) : (live.oi_change !== undefined ? Number(live.oi_change) : leg.oiChange);

    let change = null;
    let changePct = null;
    if (live.net_change !== undefined) {
      change = Number(Number(live.net_change).toFixed(2));
      changePct = live.percent_change !== undefined
        ? Number(Number(live.percent_change).toFixed(2))
        : (prevClose && prevClose > 0 ? Number(((change / prevClose) * 100).toFixed(2)) : null);
    } else if (ltp !== null && prevClose !== null && prevClose > 0) {
      change = Number((ltp - prevClose).toFixed(2));
      changePct = Number(((change / prevClose) * 100).toFixed(2));
    }

    leg.ltp = ltp !== null ? Number(ltp.toFixed(2)) : null;
    leg.prevClose = prevClose !== null ? Number(prevClose.toFixed(2)) : null;
    leg.change = change;
    leg.changePct = changePct;
    if (live.top_bid_price !== undefined) leg.bid = Number(live.top_bid_price);
    if (live.top_ask_price !== undefined) leg.ask = Number(live.top_ask_price);
    if (live.volume !== undefined) leg.volume = Number(live.volume);
    leg.oi = oi;
    leg.oiChange = oiChange;
    if (live.implied_volatility !== undefined) leg.iv = Number(Number(live.implied_volatility).toFixed(2));

    const oiBuildupInfo = computeOiBuildup(leg.change, leg.oiChange);
    leg.oiBuildup = oiBuildupInfo.label;
    leg.oiBuildupCode = oiBuildupInfo.code;
    leg.lastUpdated = nowIso;
  }

  getSummary() {
    let totalCeOi = 0;
    let totalPeOi = 0;
    let maxCeOiStrike = null;
    let maxPeOiStrike = null;
    let maxCeOi = -1;
    let maxPeOi = -1;

    for (const row of this.strikes) {
      if (row.ce.oi !== null) {
        totalCeOi += row.ce.oi;
        if (row.ce.oi > maxCeOi) {
          maxCeOi = row.ce.oi;
          maxCeOiStrike = row.strike;
        }
      }
      if (row.pe.oi !== null) {
        totalPeOi += row.pe.oi;
        if (row.pe.oi > maxPeOi) {
          maxPeOi = row.pe.oi;
          maxPeOiStrike = row.strike;
        }
      }
    }

    const pcr = totalCeOi > 0 ? Number((totalPeOi / totalCeOi).toFixed(2)) : null;

    return {
      totalCeOi: totalCeOi > 0 ? totalCeOi : null,
      totalPeOi: totalPeOi > 0 ? totalPeOi : null,
      pcr,
      maxCeOiStrike,
      maxPeOiStrike
    };
  }

  getSnapshot() {
    return {
      timestamp: Date.now(),
      spot: { ...this.spot },
      atmStrike: this.atmStrike,
      currentSpotAtm: computeAtmStrike(this.spot.ltp),
      expiryLabel: this.expiryLabel,
      feedState: { ...this.feedState },
      summary: this.getSummary(),
      strikes: this.strikes.map(row => ({
        strike: row.strike,
        isAtm: row.isAtm,
        distanceSteps: row.distanceSteps,
        ce: { ...row.ce },
        pe: { ...row.pe }
      }))
    };
  }
}

module.exports = {
  NiftyFeedManager,
  computeAtmStrike,
  computeOiBuildup,
  getISTInfo,
  getNearestExpiryLabel,
  NIFTY_STRIKE_STEP,
  ITM_COUNT,
  OTM_COUNT
};
