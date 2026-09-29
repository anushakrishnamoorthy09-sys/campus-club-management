const db = require('../db/index');

/**
 * Single helper service function to insert in-app notifications
 * @param {Number} userId - Target recipient user ID
 * @param {String} title - Notification title header
 * @param {String} message - Body text message
 * @param {String} type - Notification category (SYSTEM, EVENT, OD, CERTIFICATE, BADGE)
 * @param {String} linkUrl - Optional deep link URL
 */
function createNotification(userId, title, message, type = 'SYSTEM', linkUrl = null) {
  try {
    const res = db.prepare(
      'INSERT INTO notifications (user_id, title, message, type, link_url) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, title, message, type, linkUrl);
    return res.lastInsertRowid;
  } catch (err) {
    console.error('[NOTIFICATION SERVICE ERROR]:', err.message);
    throw err;
  }
}

module.exports = {
  createNotification
};
