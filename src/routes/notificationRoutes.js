const express = require('express');
const { requireRole } = require('../middleware/rbac');
const notificationService = require('../services/notificationService');

const router = express.Router();

const authGuard = requireRole('SUPER_ADMIN', 'ADMIN', 'CLUB_ADMIN', 'FACULTY', 'STUDENT');

/**
 * GET /notifications
 * Notification centre view and API listing endpoint
 */
router.get('/notifications', authGuard, (req, res) => {
  const filter = req.query.filter === 'unread' ? 'unread' : 'all';
  const unreadOnly = filter === 'unread';

  const notifications = notificationService.getUserNotifications(req.user.id, 100, unreadOnly);
  const unreadCount = notificationService.getUnreadCount(req.user.id);

  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.json({ notifications, unreadCount, filter });
  }

  res.render('notifications/index', {
    title: 'Notification Centre - CampusClubOS',
    notifications,
    filter,
    unreadCount
  });
});

/**
 * GET /notifications/unread-count
 * Lightweight polling endpoint for navbar unread badge
 */
router.get('/notifications/unread-count', authGuard, (req, res) => {
  const count = notificationService.getUnreadCount(req.user.id);
  res.json({ count });
});

/**
 * POST /notifications/:id/read
 * Mark a single notification as read (Strict IDOR ownership enforcement)
 */
router.post('/notifications/:id/read', authGuard, (req, res) => {
  const notifId = parseInt(req.params.id, 10);
  if (isNaN(notifId)) {
    return res.status(400).json({ error: 'Invalid notification ID' });
  }

  try {
    const result = notificationService.markAsRead(notifId, req.user.id);

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.json({ success: true, notification: result.notification });
    }

    res.redirect('/notifications');
  } catch (err) {
    const statusCode = err.statusCode || 500;
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(statusCode).json({ error: err.message });
    }
    res.status(statusCode).render('error', {
      title: 'Error - CampusClubOS',
      message: err.message
    });
  }
});

/**
 * POST /notifications/read-all
 * Mark all notifications as read for current user
 */
router.post('/notifications/read-all', authGuard, (req, res) => {
  notificationService.markAllAsRead(req.user.id);

  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.json({ success: true });
  }

  res.redirect('/notifications');
});

/**
 * GET /notifications/:id/click
 * Mark notification as read and deep-link to target page
 */
router.get('/notifications/:id/click', authGuard, (req, res) => {
  const notifId = parseInt(req.params.id, 10);
  if (isNaN(notifId)) {
    return res.redirect('/dashboard');
  }

  try {
    const result = notificationService.markAsRead(notifId, req.user.id);
    const targetUrl = result.notification.link_url || '/dashboard';
    res.redirect(targetUrl);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).render('error', {
      title: 'Error - CampusClubOS',
      message: err.message
    });
  }
});

module.exports = router;
