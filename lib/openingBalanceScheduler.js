const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const OPENING_BALANCE_FILE = path.join(__dirname, '..', 'data', 'opening_balance.json');

class OpeningBalanceScheduler extends EventEmitter {
  constructor(multiBrokerManager) {
    super();
    this.multiBrokerManager = multiBrokerManager;
    this.checkInterval = 30000; // Check every 30s
    this.timer = null;

    this._ensureFile();
    this.currentData = this._loadData();
    this.startScheduler();
  }

  _ensureFile() {
    const dir = path.dirname(OPENING_BALANCE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(OPENING_BALANCE_FILE)) {
      const initial = {
        date: this._getTodayDateStr(),
        openingBalance: 500000.00, // Default baseline opening capital (₹5 Lakhs)
        capturedAt: null,
        isAutoCaptured: false,
        accounts: []
      };
      fs.writeFileSync(OPENING_BALANCE_FILE, JSON.stringify(initial, null, 2), 'utf8');
    }
  }

  _loadData() {
    try {
      return JSON.parse(fs.readFileSync(OPENING_BALANCE_FILE, 'utf8'));
    } catch (e) {
      return {
        date: this._getTodayDateStr(),
        openingBalance: 500000.00,
        capturedAt: null,
        isAutoCaptured: false,
        accounts: []
      };
    }
  }

  _saveData(data) {
    this.currentData = { ...this.currentData, ...data };
    fs.writeFileSync(OPENING_BALANCE_FILE, JSON.stringify(this.currentData, null, 2), 'utf8');
    this.emit('balance_updated', this.currentData);
    return this.currentData;
  }

  _getTodayDateStr() {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const ist = new Date(utc + 3600000 * 5.5);
    return ist.toISOString().split('T')[0];
  }

  /**
   * Start recurring background scheduler for 9:00 AM IST
   */
  startScheduler() {
    if (this.timer) clearInterval(this.timer);

    this.timer = setInterval(async () => {
      await this._checkAndCapture9AM();
    }, this.checkInterval);

    // Initial check on boot
    this._checkAndCapture9AM();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Check if current time is >= 9:00 AM IST and we haven't captured today's opening balance
   */
  async _checkAndCapture9AM() {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const ist = new Date(utc + 3600000 * 5.5);

    const todayStr = ist.toISOString().split('T')[0];
    const hour = ist.getHours();
    const min = ist.getMinutes();

    // Check if 9:00 AM IST has arrived (hour >= 9)
    const isPast9AM = hour > 9 || (hour === 9 && min >= 0);

    // If today is a new trading day and it's 9:00 AM or later, but not captured today
    if (isPast9AM && (this.currentData.date !== todayStr || !this.currentData.isAutoCaptured)) {
      console.log(`[OpeningBalanceScheduler] 9:00 AM IST reached. Retrieving morning balance across all brokers for ${todayStr}...`);
      await this.captureOpeningBalance(true);
    }
  }

  /**
   * Query all active brokers and save opening balance snapshot
   */
  async captureOpeningBalance(isAuto = false) {
    try {
      const funds = await this.multiBrokerManager.getAllFunds();
      const total = Number(funds.totalBalance || funds.availableCash || 0);

      const snapshot = {
        date: this._getTodayDateStr(),
        openingBalance: total > 0 ? total : this.currentData.openingBalance,
        capturedAt: new Date().toISOString(),
        timeFormatted: new Date().toLocaleTimeString() + ' IST',
        isAutoCaptured: isAuto,
        accounts: funds.accounts || []
      };

      this._saveData(snapshot);
      console.log(`[OpeningBalanceScheduler] Opening Balance set: ₹${snapshot.openingBalance.toLocaleString('en-IN')}`);
      return snapshot;
    } catch (err) {
      console.error('[OpeningBalanceScheduler] Error retrieving opening balance:', err.message);
      return this.currentData;
    }
  }

  /**
   * Manually set or override opening balance
   */
  setOpeningBalance(amount) {
    const num = Number(amount);
    if (isNaN(num) || num <= 0) throw new Error('Invalid opening balance amount');

    const updated = {
      openingBalance: num,
      capturedAt: new Date().toISOString(),
      timeFormatted: new Date().toLocaleTimeString() + ' IST (Manual Override)',
      isAutoCaptured: false
    };

    return this._saveData(updated);
  }

  getOpeningBalanceData() {
    return this.currentData;
  }
}

module.exports = OpeningBalanceScheduler;
