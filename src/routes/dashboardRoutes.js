const express = require('express');
const { requireRole, requirePermission } = require('../middleware/rbac');

const router = express.Router();

/**
 * GET /dashboard
 * Root Dashboard router that redirects to the role-specific dashboard.
 */
router.get('/dashboard', requireRole('SUPER_ADMIN', 'ADMIN', 'CLUB_ADMIN', 'FACULTY', 'STUDENT'), (req, res) => {
  switch (req.user.role) {
    case 'SUPER_ADMIN':
      return res.redirect('/dashboard/super-admin');
    case 'ADMIN':
      return res.redirect('/dashboard/admin');
    case 'CLUB_ADMIN':
      return res.redirect('/dashboard/club-admin');
    case 'FACULTY':
      return res.redirect('/dashboard/faculty');
    case 'STUDENT':
      return res.redirect('/dashboard/student');
    default:
      return res.redirect('/login');
  }
});

const notificationService = require('../services/notificationService');

/**
 * ROLE DASHBOARDS
 */
router.get('/dashboard/super-admin', requireRole('SUPER_ADMIN'), (req, res) => {
  const recentNotifications = notificationService.getRecentNotifications(req.user.id, 5);
  res.render('dashboards/super_admin', {
    title: 'Super Admin Control Panel - CampusClubOS',
    activeTab: 'overview',
    recentNotifications
  });
});

router.get('/dashboard/admin', requireRole('ADMIN'), (req, res) => {
  const recentNotifications = notificationService.getRecentNotifications(req.user.id, 5);
  res.render('dashboards/admin', {
    title: 'Campus Admin Dashboard - CampusClubOS',
    activeTab: 'overview',
    recentNotifications
  });
});

router.get('/dashboard/club-admin', requireRole('CLUB_ADMIN'), (req, res) => {
  const recentNotifications = notificationService.getRecentNotifications(req.user.id, 5);
  res.render('dashboards/club_admin', {
    title: 'Club Admin Workspace - CampusClubOS',
    activeTab: 'overview',
    recentNotifications
  });
});

router.get('/dashboard/faculty', requireRole('FACULTY'), (req, res) => {
  const recentNotifications = notificationService.getRecentNotifications(req.user.id, 5);
  res.render('dashboards/faculty', {
    title: 'Faculty Portal - CampusClubOS',
    activeTab: 'overview',
    recentNotifications
  });
});

router.get('/dashboard/student', requireRole('STUDENT'), (req, res) => {
  const db = require('../db/index');
  const studentUserId = req.user.id;

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_ods,
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) as approved_count,
      SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) as rejected_count,
      SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) as closed_count
    FROM od_requests
    WHERE student_user_id = ?
  `).get(studentUserId);

  const totalOds = stats ? (stats.total_ods || 0) : 0;
  const pendingCount = stats ? (stats.pending_count || 0) : 0;
  const approvedCount = stats ? (stats.approved_count || 0) : 0;
  const rejectedCount = stats ? (stats.rejected_count || 0) : 0;
  const closedCount = stats ? (stats.closed_count || 0) : 0;

  const decidedCount = approvedCount + rejectedCount;
  const approvalRate = decidedCount > 0 ? Math.round((approvedCount / decidedCount) * 100) : 0;

  const recentNotifications = notificationService.getRecentNotifications(studentUserId, 5);

  res.render('dashboards/student', {
    title: 'Student Hub - CampusClubOS',
    activeTab: 'overview',
    odStats: {
      totalOds,
      pendingCount,
      approvedCount,
      rejectedCount,
      closedCount,
      approvalRate
    },
    recentNotifications
  });
});

/**
 * PLACEHOLDER GUARDED FEATURE SHELLS (To be populated in later phases)
 */


// Club Admin Shells

router.get('/club/members', requireRole('CLUB_ADMIN', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'Club Membership Management - CampusClubOS',
    featureName: 'Club Member Roster & Approvals',
    roleRequired: 'CLUB_ADMIN'
  });
});

router.get('/club/roles', requireRole('CLUB_ADMIN', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  if (req.user.role === 'CLUB_ADMIN') {
    const club = require('../db/index').prepare('SELECT id FROM clubs WHERE club_admin_id = ?').get(req.user.id);
    if (club) {
      return res.redirect(`/club/${club.id}/roles`);
    }
  }
  return res.redirect('/admin/clubs');
});

router.get('/club/certificates', requireRole('CLUB_ADMIN', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'Certificate Issuance - CampusClubOS',
    featureName: 'Certificate PDF & QR Issuance',
    roleRequired: 'CLUB_ADMIN'
  });
});

router.get('/club/badges', requireRole('CLUB_ADMIN', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'Badge Awarding - CampusClubOS',
    featureName: 'Club Recognition Badges',
    roleRequired: 'CLUB_ADMIN'
  });
});


// Student Shells

router.get('/student/certificates', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'My Certificates - CampusClubOS',
    featureName: 'Verifiable Certificate Downloads',
    roleRequired: 'STUDENT'
  });
});

router.get('/student/badges', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'My Badges - CampusClubOS',
    featureName: 'Personal Achievement Portfolio Badges',
    roleRequired: 'STUDENT'
  });
});

module.exports = router;
