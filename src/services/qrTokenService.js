const crypto = require('crypto');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_12345';

/**
 * QR Token Service
 * Short-lived signed token generation and verification using HMAC-SHA256
 * Window step: 20 seconds. Token is valid for ~60 seconds (up to 3 consecutive windows).
 */

const WINDOW_STEP_MS = 20000; // 20 seconds

/**
 * Get current time window index
 */
function getCurrentWindow() {
  return Math.floor(Date.now() / WINDOW_STEP_MS);
}

/**
 * Compute HMAC-SHA256 for eventId and timeWindow
 */
function computeHmac(eventId, windowIndex) {
  const payload = `${eventId}:${windowIndex}`;
  return crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
}

/**
 * Generate a signed QR token for an event
 * Format: <eventId>.<windowIndex>.<hmacHex>
 */
function generateToken(eventId, windowIndex = getCurrentWindow()) {
  const eventIdNum = parseInt(eventId, 10);
  const hmac = computeHmac(eventIdNum, windowIndex);
  return `${eventIdNum}.${windowIndex}.${hmac}`;
}

/**
 * Verify a signed QR token
 * Returns { valid: true, eventId, windowIndex } or { valid: false, reason }
 */
function verifyToken(token, expectedEventId = null) {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'Missing or malformed token' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'Invalid token format' };
  }

  const [eventIdStr, windowStr, hmacHex] = parts;
  const eventId = parseInt(eventIdStr, 10);
  const windowIndex = parseInt(windowStr, 10);

  if (isNaN(eventId) || isNaN(windowIndex) || !hmacHex) {
    return { valid: false, reason: 'Invalid token parameters' };
  }

  if (expectedEventId !== null && parseInt(expectedEventId, 10) !== eventId) {
    return { valid: false, reason: 'Token is for another event' };
  }

  // Time window validity: current window, -1 window, -2 window (~60 seconds tolerance)
  const currentWindow = getCurrentWindow();
  const ageInWindows = currentWindow - windowIndex;

  if (ageInWindows < 0 || ageInWindows > 2) {
    return { valid: false, reason: 'QR code has expired' };
  }

  // Constant-time HMAC verification
  const expectedHmac = computeHmac(eventId, windowIndex);
  const hmacBuffer = Buffer.from(hmacHex, 'hex');
  const expectedBuffer = Buffer.from(expectedHmac, 'hex');

  if (hmacBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(hmacBuffer, expectedBuffer)) {
    return { valid: false, reason: 'Invalid signature or tampered token' };
  }

  return {
    valid: true,
    eventId,
    windowIndex
  };
}

module.exports = {
  getCurrentWindow,
  generateToken,
  verifyToken
};
