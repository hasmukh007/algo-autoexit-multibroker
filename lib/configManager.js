const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');
const ENV_FILE = path.join(__dirname, '..', '.env');

// Ensure data directory exists
const dataDir = path.dirname(CONFIG_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Default Configuration
const DEFAULT_CONFIG = {
  mode: 'mock', // 'live' or 'mock'
  consumerKey: '',
  mobileNumber: '',
  ucc: '',
  mpin: '',
  totpSecret: '',
  baseUrl: 'https://mis.kotaksecurities.com',
  riskSettings: {
    maxDailyLossINR: 2000,
    targetDailyProfitINR: 5000,
    targetDailyNetProfitPct: 1.5,
    maxDailyLossNetPct: -1.0,
    nearThresholdBufferPct: 98,
    capitalDeployPct: 100,
    maxDailyOrders: 0,
    orderRoutingMode: 'selected', // 'selected' | 'all_funded'
    allowPaperAfterHours: false,
    autoSquareOffTime: '15:15',
    trailingSLPoints: 10,
    autoExitEnabled: true
  },
  chargeSettings: {
    sttPct: 0.15,
    exchangeTxnPct: 0.03553,
    sebiPerCrore: 10,
    ipftPerCrore: 0.01,
    stampDutyBuyPct: 0.003,
    gstPct: 18
  }
};

/**
 * Parse .env file if it exists
 */
function parseEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return {};
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    const result = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        result[key] = val;
      }
    }
    return result;
  } catch (err) {
    console.error('Error reading .env file:', err.message);
    return {};
  }
}

/**
 * Load configuration merged from .env and config.json
 */
function loadConfig() {
  let fileConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.warn('Could not parse config.json, using defaults.');
    }
  }

  const env = parseEnvFile();

  return {
    ...DEFAULT_CONFIG,
    mode: fileConfig.mode || env.TRADING_MODE || DEFAULT_CONFIG.mode,
    consumerKey: fileConfig.consumerKey || env.KOTAK_CONSUMER_KEY || '',
    mobileNumber: fileConfig.mobileNumber || env.KOTAK_MOBILE_NUMBER || '',
    ucc: fileConfig.ucc || env.KOTAK_UCC || '',
    mpin: fileConfig.mpin || env.KOTAK_MPIN || '',
    totpSecret: fileConfig.totpSecret || env.KOTAK_TOTP_SECRET || '',
    baseUrl: ((fileConfig.baseUrl || env.KOTAK_BASE_URL || DEFAULT_CONFIG.baseUrl).includes('napi.kotaksecurities.com'))
      ? 'https://mis.kotaksecurities.com'
      : (fileConfig.baseUrl || env.KOTAK_BASE_URL || DEFAULT_CONFIG.baseUrl),
    riskSettings: {
      ...DEFAULT_CONFIG.riskSettings,
      ...(fileConfig.riskSettings || {}),
      maxDailyLossINR: Number(
        (fileConfig.riskSettings && fileConfig.riskSettings.maxDailyLossINR) ||
        env.DEFAULT_MAX_LOSS_INR ||
        DEFAULT_CONFIG.riskSettings.maxDailyLossINR
      ),
      targetDailyProfitINR: Number(
        (fileConfig.riskSettings && fileConfig.riskSettings.targetDailyProfitINR) ||
        env.DEFAULT_TARGET_PROFIT_INR ||
        DEFAULT_CONFIG.riskSettings.targetDailyProfitINR
      ),
      targetDailyNetProfitPct: Number(
        (fileConfig.riskSettings && fileConfig.riskSettings.targetDailyNetProfitPct !== undefined)
          ? fileConfig.riskSettings.targetDailyNetProfitPct
          : DEFAULT_CONFIG.riskSettings.targetDailyNetProfitPct
      ),
      maxDailyLossNetPct: Number(
        (fileConfig.riskSettings && fileConfig.riskSettings.maxDailyLossNetPct !== undefined)
          ? fileConfig.riskSettings.maxDailyLossNetPct
          : DEFAULT_CONFIG.riskSettings.maxDailyLossNetPct
      ),
      nearThresholdBufferPct: Number(
        (fileConfig.riskSettings && fileConfig.riskSettings.nearThresholdBufferPct !== undefined)
          ? fileConfig.riskSettings.nearThresholdBufferPct
          : DEFAULT_CONFIG.riskSettings.nearThresholdBufferPct
      ),
      capitalDeployPct: Math.max(1, Math.min(100, Number(
        (fileConfig.riskSettings && fileConfig.riskSettings.capitalDeployPct !== undefined)
          ? fileConfig.riskSettings.capitalDeployPct
          : DEFAULT_CONFIG.riskSettings.capitalDeployPct
      ))),
      maxDailyOrders: Math.max(0, Math.round(Number(
        (fileConfig.riskSettings && fileConfig.riskSettings.maxDailyOrders !== undefined)
          ? fileConfig.riskSettings.maxDailyOrders
          : DEFAULT_CONFIG.riskSettings.maxDailyOrders
      ))),
      orderRoutingMode: (fileConfig.riskSettings && fileConfig.riskSettings.orderRoutingMode === 'all_funded')
        ? 'all_funded'
        : 'selected',
      allowPaperAfterHours: Boolean(
        fileConfig.riskSettings && fileConfig.riskSettings.allowPaperAfterHours !== undefined
          ? fileConfig.riskSettings.allowPaperAfterHours
          : DEFAULT_CONFIG.riskSettings.allowPaperAfterHours
      ),
      autoSquareOffTime:
        (fileConfig.riskSettings && fileConfig.riskSettings.autoSquareOffTime) ||
        env.DEFAULT_AUTO_SQUAREOFF_TIME ||
        DEFAULT_CONFIG.riskSettings.autoSquareOffTime
    },
    chargeSettings: {
      ...DEFAULT_CONFIG.chargeSettings,
      ...(fileConfig.chargeSettings || {}),
      sttPct: Number(
        (fileConfig.chargeSettings && fileConfig.chargeSettings.sttPct !== undefined)
          ? fileConfig.chargeSettings.sttPct
          : DEFAULT_CONFIG.chargeSettings.sttPct
      ),
      exchangeTxnPct: Number(
        (fileConfig.chargeSettings && fileConfig.chargeSettings.exchangeTxnPct !== undefined)
          ? fileConfig.chargeSettings.exchangeTxnPct
          : DEFAULT_CONFIG.chargeSettings.exchangeTxnPct
      ),
      sebiPerCrore: Number(
        (fileConfig.chargeSettings && fileConfig.chargeSettings.sebiPerCrore !== undefined)
          ? fileConfig.chargeSettings.sebiPerCrore
          : DEFAULT_CONFIG.chargeSettings.sebiPerCrore
      ),
      ipftPerCrore: Number(
        (fileConfig.chargeSettings && fileConfig.chargeSettings.ipftPerCrore !== undefined)
          ? fileConfig.chargeSettings.ipftPerCrore
          : DEFAULT_CONFIG.chargeSettings.ipftPerCrore
      ),
      stampDutyBuyPct: Number(
        (fileConfig.chargeSettings && fileConfig.chargeSettings.stampDutyBuyPct !== undefined)
          ? fileConfig.chargeSettings.stampDutyBuyPct
          : DEFAULT_CONFIG.chargeSettings.stampDutyBuyPct
      ),
      gstPct: Number(
        (fileConfig.chargeSettings && fileConfig.chargeSettings.gstPct !== undefined)
          ? fileConfig.chargeSettings.gstPct
          : DEFAULT_CONFIG.chargeSettings.gstPct
      )
    }
  };
}

/**
 * Save configuration to config.json
 */
function saveConfig(updatedConfig) {
  const current = loadConfig();
  const merged = {
    ...current,
    ...updatedConfig,
    riskSettings: {
      ...current.riskSettings,
      ...(updatedConfig.riskSettings || {})
    },
    chargeSettings: {
      ...current.chargeSettings,
      ...(updatedConfig.chargeSettings || {})
    }
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = {
  loadConfig,
  saveConfig,
  DEFAULT_CONFIG
};
