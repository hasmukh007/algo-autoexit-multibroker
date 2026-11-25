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
    autoSquareOffTime: '15:15',
    trailingSLPoints: 10,
    autoExitEnabled: true
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
      autoSquareOffTime:
        (fileConfig.riskSettings && fileConfig.riskSettings.autoSquareOffTime) ||
        env.DEFAULT_AUTO_SQUAREOFF_TIME ||
        DEFAULT_CONFIG.riskSettings.autoSquareOffTime
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
