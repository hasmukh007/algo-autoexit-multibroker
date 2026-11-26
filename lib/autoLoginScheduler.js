const EventEmitter = require('events');
const { getISTInfo } = require('./niftyFeedManager');

/**
 * Automatically authenticates all enabled broker accounts at 8:59 AM IST daily
 * (before the 9:00 AM IST opening balance & NIFTY/option chain feed start).
 */
class AutoLoginScheduler extends EventEmitter {
  constructor(multiBrokerManager, options = {}) {
    super();
    this.multiBrokerManager = multiBrokerManager;
    this.checkIntervalMs = options.checkIntervalMs || 10000;
    this.targetHourIST = options.targetHourIST !== undefined ? options.targetHourIST : 8;
    this.targetMinuteIST = options.targetMinuteIST !== undefined ? options.targetMinuteIST : 59;

    this.lastRunDate = null;
    this.isRunningLogin = false;
    this.timer = null;

    if (!options.disableTimers) {
      this.start();
    }
  }

  start() {
    this.stop();
    this._checkAndTrigger();
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

    if (!isPastTarget || this.lastRunDate === ist.dateStr || this.isRunningLogin) {
      return { triggered: false, date: ist.dateStr };
    }

    this.lastRunDate = ist.dateStr;
    this.isRunningLogin = true;
    try {
      const results = await this.multiBrokerManager.loginAllBrokers();
      const payload = {
        triggered: true,
        date: ist.dateStr,
        timeIST: ist.timeFormatted,
        results
      };
      this.emit('auto_login_completed', payload);
      return payload;
    } finally {
      this.isRunningLogin = false;
    }
  }
}

module.exports = AutoLoginScheduler;
