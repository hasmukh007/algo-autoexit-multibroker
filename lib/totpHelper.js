const crypto = require('crypto');

/**
 * Base32 decoder for RFC 6238 TOTP secrets
 * Compatible with Google Authenticator, Microsoft Authenticator, Kotak Neo QR codes
 */
function base32Decode(base32) {
  if (!base32) return Buffer.alloc(0);
  const clean = base32.replace(/[\s=-]/g, '').toUpperCase();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (let i = 0; i < clean.length; i++) {
    const val = alphabet.indexOf(clean[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Generate 6-digit TOTP (Time-based One-Time Password) from secret
 * @param {string} secret Base32 encoded secret key
 * @param {number} stepSeconds Time step (standard 30s)
 * @param {number} digits Number of digits (standard 6)
 * @param {number} timestamp Optional timestamp in ms (defaults to Date.now())
 * @returns {string} 6-digit TOTP code
 */
function generateTOTP(secret, stepSeconds = 30, digits = 6, timestamp = Date.now()) {
  if (!secret) return '';
  const key = base32Decode(secret);
  if (key.length === 0) return '';
  const epoch = Math.floor(timestamp / 1000);
  const counter = Math.floor(epoch / stepSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter), 0);
  
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

/**
 * Calculate remaining seconds before the current TOTP expires
 * @param {number} stepSeconds 
 * @returns {number} Seconds left in current window (1-30)
 */
function getTOTPRemainingSeconds(stepSeconds = 30) {
  const currentSeconds = Math.floor(Date.now() / 1000) % stepSeconds;
  return stepSeconds - currentSeconds;
}

/**
 * Validate a 6-digit TOTP code against a secret with window tolerance
 * @param {string} token 6-digit code to test
 * @param {string} secret Base32 secret
 * @param {number} windowTolerance Number of windows back/forward to check (default: 1)
 * @returns {boolean}
 */
function verifyTOTP(token, secret, windowTolerance = 1) {
  if (!token || !secret) return false;
  const now = Date.now();
  for (let i = -windowTolerance; i <= windowTolerance; i++) {
    const candidate = generateTOTP(secret, 30, 6, now + i * 30000);
    if (candidate === token.trim()) return true;
  }
  return false;
}

module.exports = {
  generateTOTP,
  getTOTPRemainingSeconds,
  verifyTOTP,
  base32Decode
};
