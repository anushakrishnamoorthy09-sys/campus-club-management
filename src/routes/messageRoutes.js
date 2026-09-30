const express = require('express');
const router = express.Router();
const messageService = require('../services/messageService');
const db = require('../db/index');
const { requireRole } = require('../middleware/rbac');
const { doubleCsrfProtection, attachCsrfToken } = require('../middleware/csrf');

// Messaging is strictly forbidden to Students per requirements spec.
const ALLOWED_MESSAGING_ROLES = ['SUPER_ADMIN', 'ADMIN', 'CLUB_ADMIN', 'FACULTY'];

/**
 * 1. GET /messages - User Inbox
 */
router.get('/messages', requireRole(...ALLOWED_MESSAGING_ROLES), attachCsrfToken, (req, res, next) => {
  try {
    const threads = messageService.getUserThreads(req.user);
    res.render('messages/index', {
      title: 'Communication Threads Inbox',
      threads,
      user: req.user
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 2. GET /messages/new - Start New Direct Thread Selection Page
 * MUST BE REGISTERED BEFORE /messages/:id
 */
router.get('/messages/new', requireRole(...ALLOWED_MESSAGING_ROLES), attachCsrfToken, (req, res, next) => {
  try {
    // Eligible target users for direct messaging: Faculty <-> Faculty or Faculty <-> Club Admin
    let targets = [];
    if (req.user.role === 'FACULTY') {
      targets = db.prepare(`
        SELECT id, full_name, email, role
        FROM users
        WHERE role IN ('FACULTY', 'CLUB_ADMIN') AND id != ? AND is_active = 1
        ORDER BY full_name ASC
      `).all(req.user.id);
    } else if (req.user.role === 'CLUB_ADMIN') {
      targets = db.prepare(`
        SELECT id, full_name, email, role
        FROM users
        WHERE role = 'FACULTY' AND is_active = 1
        ORDER BY full_name ASC
      `).all();
    } else if (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN') {
      targets = db.prepare(`
        SELECT id, full_name, email, role
        FROM users
        WHERE role IN ('FACULTY', 'CLUB_ADMIN', 'ADMIN', 'SUPER_ADMIN') AND id != ? AND is_active = 1
        ORDER BY full_name ASC
      `).all(req.user.id);
    }

    res.render('messages/new', {
      title: 'New Direct Message',
      targets,
      user: req.user
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 3. POST /messages/new - Create or Retrieve Direct Thread
 * MUST BE REGISTERED BEFORE /messages/:id
 */
router.post('/messages/new', requireRole(...ALLOWED_MESSAGING_ROLES), doubleCsrfProtection, (req, res, next) => {
  try {
    const targetUserId = parseInt(req.body.targetUserId, 10);
    const thread = messageService.getOrCreateThread('DIRECT', null, targetUserId, req.user);
    res.redirect(`/messages/${thread.id}`);
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).render('error', { title: 'Messaging Error', message: err.message });
    }
    next(err);
  }
});

/**
 * 4. GET /messages/context/:type/:id - Contextual Discuss Redirect Helper
 */
router.get('/messages/context/:type/:id', requireRole(...ALLOWED_MESSAGING_ROLES), (req, res, next) => {
  try {
    const contextType = req.params.type.toUpperCase();
    const contextId = parseInt(req.params.id, 10);

    const thread = messageService.getOrCreateThread(contextType, contextId, null, req.user);
    res.redirect(`/messages/${thread.id}`);
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).render('error', { title: 'Thread Access Refused', message: err.message });
    }
    next(err);
  }
});

/**
 * 5. GET /messages/:id - Chat Room View with Polling Support
 */
router.get('/messages/:id', requireRole(...ALLOWED_MESSAGING_ROLES), attachCsrfToken, (req, res, next) => {
  try {
    const threadId = parseInt(req.params.id, 10);
    const data = messageService.listMessages(threadId, req.user);

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true, ...data });
    }

    res.render('messages/show', {
      title: data.thread.title,
      thread: data.thread,
      contextSummary: data.contextSummary,
      messages: data.messages,
      user: req.user
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).render('error', { title: 'Thread Not Found', message: err.message });
    }
    next(err);
  }
});

/**
 * 6. POST /messages/:id - Post Message into Thread
 */
router.post('/messages/:id', requireRole(...ALLOWED_MESSAGING_ROLES), doubleCsrfProtection, (req, res, next) => {
  try {
    const threadId = parseInt(req.params.id, 10);
    const { text } = req.body;

    const message = messageService.postMessage(threadId, req.user, text);

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(201).json({ success: true, message });
    }

    res.redirect(`/messages/${threadId}`);
  } catch (err) {
    if (err.statusCode) {
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return res.redirect(`/messages/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    }
    next(err);
  }
});

module.exports = router;
