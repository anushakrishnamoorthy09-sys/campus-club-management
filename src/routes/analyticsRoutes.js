const express = require('express');
const router = express.Router();
const analyticsService = require('../services/analyticsService');
const db = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/rbac');

/**
 * Dynamic Scope Resolver for Club Scope in Analytics
 */
function resolveClubScope(req) {
  const directClubId = req.query.clubId || req.params.clubId || (req.body && req.body.clubId);
  if (directClubId) {
    return { clubId: parseInt(directClubId, 10) };
  }
  if (req.user) {
    if (req.user.role === 'CLUB_ADMIN') {
      const club = db.prepare('SELECT id FROM clubs WHERE club_admin_id = ? LIMIT 1').get(req.user.id);
      if (club) return { clubId: club.id };
    }
    if (req.user.role === 'FACULTY') {
      const coord = db.prepare('SELECT club_id FROM club_coordinators WHERE faculty_user_id = ? LIMIT 1').get(req.user.id);
      if (coord) return { clubId: coord.club_id };
    }
    const membership = db.prepare("SELECT club_id FROM club_memberships WHERE user_id = ? AND status = 'APPROVED' LIMIT 1").get(req.user.id);
    if (membership) return { clubId: membership.club_id };
  }
  return { clubId: null };
}

/**
 * GET /club/analytics
 * Club Analytics view. Requires VIEW_EVENT_ANALYTICS permission for target club.
 */
router.get('/club/analytics', requirePermission('VIEW_EVENT_ANALYTICS', resolveClubScope), (req, res, next) => {
  try {
    let clubId = req.query.clubId ? parseInt(req.query.clubId, 10) : null;

    if (!clubId) {
      if (req.user.role === 'CLUB_ADMIN') {
        const club = db.prepare('SELECT id FROM clubs WHERE club_admin_id = ?').get(req.user.id);
        if (club) clubId = club.id;
      } else if (req.user.role === 'FACULTY') {
        const coord = db.prepare('SELECT club_id FROM club_coordinators WHERE faculty_user_id = ? LIMIT 1').get(req.user.id);
        if (coord) clubId = coord.club_id;
      } else {
        const membership = db.prepare("SELECT club_id FROM club_memberships WHERE user_id = ? AND status = 'APPROVED' LIMIT 1").get(req.user.id);
        if (membership) clubId = membership.club_id;
      }
    }

    if (!clubId) {
      const firstClub = db.prepare('SELECT id FROM clubs LIMIT 1').get();
      if (firstClub && (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN')) {
        clubId = firstClub.id;
      } else {
        return res.status(404).render('error', {
          title: 'Club Not Found',
          message: 'No associated club found for your account to view analytics.',
          user: req.user
        });
      }
    }

    const metrics = analyticsService.getClubAnalytics(clubId, req.user);
    const allClubs = (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN')
      ? db.prepare('SELECT id, name, code FROM clubs ORDER BY name ASC').all()
      : [];

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true, metrics });
    }

    res.render('club/analytics', {
      title: `${metrics.club.name} Analytics`,
      metrics,
      allClubs,
      selectedClubId: clubId,
      user: req.user
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).render('error', {
        title: 'Analytics Error',
        message: err.message,
        user: req.user
      });
    }
    next(err);
  }
});

/**
 * GET /student/analytics
 * Student performance analytics. Restricted to authenticated student/faculty/admin.
 */
router.get('/student/analytics', requireRole('STUDENT', 'FACULTY', 'ADMIN', 'SUPER_ADMIN'), (req, res, next) => {
  try {
    let studentUserId = req.query.studentUserId ? parseInt(req.query.studentUserId, 10) : req.user.id;

    const metrics = analyticsService.getStudentAnalytics(studentUserId, req.user);

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true, metrics });
    }

    res.render('student/analytics', {
      title: 'Student Analytics Dashboard',
      metrics,
      user: req.user
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).render('error', {
        title: 'Analytics Error',
        message: err.message,
        user: req.user
      });
    }
    next(err);
  }
});

/**
 * GET /faculty/analytics
 * Faculty coordinator & mentor analytics. Restricted to faculty/admin.
 */
router.get('/faculty/analytics', requireRole('FACULTY', 'ADMIN', 'SUPER_ADMIN'), (req, res, next) => {
  try {
    let facultyUserId = req.query.facultyUserId ? parseInt(req.query.facultyUserId, 10) : req.user.id;

    const metrics = analyticsService.getFacultyAnalytics(facultyUserId, req.user);

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true, metrics });
    }

    res.render('faculty/analytics', {
      title: 'Faculty Analytics Overview',
      metrics,
      user: req.user
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).render('error', {
        title: 'Analytics Error',
        message: err.message,
        user: req.user
      });
    }
    next(err);
  }
});

/**
 * GET /admin/analytics
 * Institution-wide Admin cross-club analytics & queues. Restricted to Admin/Super Admin.
 */
router.get('/admin/analytics', requireRole('ADMIN', 'SUPER_ADMIN'), (req, res, next) => {
  try {
    const metrics = analyticsService.getAdminAnalytics(req.user);

    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({ success: true, metrics });
    }

    res.render('admin/analytics', {
      title: 'Institution Analytics & Cross-Club Comparison',
      metrics,
      user: req.user
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).render('error', {
        title: 'Analytics Error',
        message: err.message,
        user: req.user
      });
    }
    next(err);
  }
});

module.exports = router;
