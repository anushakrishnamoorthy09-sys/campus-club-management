const db = require('../db/index');

/**
 * Single helper service function to insert in-app notifications
 * @param {Number} userId - Target recipient user ID
 * @param {String} title - Notification title header
 * @param {String} message - Body text message
 * @param {String} type - Notification category (SYSTEM, EVENT, OD_REQUEST_RAISED, OD_REVIEWED, OD_ESCALATED, OD_CLOSED, MENTOR_REASSIGNED, ROLE_ASSIGNED, BADGE)
 * @param {String} linkUrl - Optional deep link URL
 */
function createNotification(userId, title, message, type = 'SYSTEM', linkUrl = null) {
  try {
    const res = db.prepare(
      'INSERT INTO notifications (user_id, title, message, type, link_url) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, title, message, type, linkUrl);

    // Optional email sender stub for future extensibility
    sendEmailNotificationStub(userId, title, message);

    return res.lastInsertRowid;
  } catch (err) {
    console.error('[NOTIFICATION SERVICE ERROR]:', err.message);
    throw err;
  }
}

/**
 * Documented hook for future badge award notifications
 */
function awardBadgeNotification(studentUserId, badgeName, clubName) {
  return createNotification(
    studentUserId,
    'Badge Awarded!',
    `Congratulations! You were awarded the '${badgeName}' badge by ${clubName}.`,
    'BADGE',
    '/student/badges'
  );
}

/**
 * Extensible email sender stub (In-app only currently)
 */
function sendEmailNotificationStub(userId, title, message) {
  if (process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true') {
    console.log(`[EMAIL STUB] Sent to User ID ${userId}: [${title}] ${message}`);
  }
}

/**
 * Get paginated or filtered notifications for a user
 */
function getUserNotifications(userId, limit = 50, unreadOnly = false) {
  let query = 'SELECT * FROM notifications WHERE user_id = ?';
  const params = [userId];

  if (unreadOnly) {
    query += ' AND is_read = 0';
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

/**
 * Get top N recent notifications for user dashboard
 */
function getRecentNotifications(userId, limit = 5) {
  return db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(userId, limit);
}

/**
 * Count unread notifications
 */
function getUnreadCount(userId) {
  const row = db.prepare(
    'SELECT COUNT(*) as unread_count FROM notifications WHERE user_id = ? AND is_read = 0'
  ).get(userId);
  return row ? row.unread_count : 0;
}

/**
 * Mark a single notification as read with strict IDOR ownership enforcement
 */
function markAsRead(notificationId, userId) {
  const notif = db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId);
  if (!notif) {
    const err = new Error('Notification not found');
    err.statusCode = 404;
    throw err;
  }

  if (notif.user_id !== userId) {
    const err = new Error('Access Forbidden: You do not own this notification');
    err.statusCode = 403;
    throw err;
  }

  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(notificationId);
  return { success: true, notification: notif };
}

/**
 * Mark all unread notifications as read for a user
 */
function markAllAsRead(userId) {
  const res = db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
  return { updatedCount: res.changes };
}

module.exports = {
  createNotification,
  awardBadgeNotification,
  getUserNotifications,
  getRecentNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  sendEmailNotificationStub
};
