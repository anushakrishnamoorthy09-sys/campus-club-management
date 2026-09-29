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

/**
 * ROLE DASHBOARDS
 */
router.get('/dashboard/super-admin', requireRole('SUPER_ADMIN'), (req, res) => {
  res.render('dashboards/super_admin', {
    title: 'Super Admin Control Panel - CampusClubOS',
    activeTab: 'overview'
  });
});

router.get('/dashboard/admin', requireRole('ADMIN'), (req, res) => {
  res.render('dashboards/admin', {
    title: 'Campus Admin Dashboard - CampusClubOS',
    activeTab: 'overview'
  });
});

router.get('/dashboard/club-admin', requireRole('CLUB_ADMIN'), (req, res) => {
  res.render('dashboards/club_admin', {
    title: 'Club Admin Workspace - CampusClubOS',
    activeTab: 'overview'
  });
});

router.get('/dashboard/faculty', requireRole('FACULTY'), (req, res) => {
  res.render('dashboards/faculty', {
    title: 'Faculty Portal - CampusClubOS',
    activeTab: 'overview'
  });
});

router.get('/dashboard/student', requireRole('STUDENT'), (req, res) => {
  res.render('dashboards/student', {
    title: 'Student Hub - CampusClubOS',
    activeTab: 'overview'
  });
});

/**
 * PLACEHOLDER GUARDED FEATURE SHELLS (To be populated in later phases)
 */

// Super Admin Only
router.get('/admin/timetable', requireRole('SUPER_ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'Timetable Structure Management - CampusClubOS',
    featureName: 'Master Timetable Structure Management',
    roleRequired: 'SUPER_ADMIN'
  });
});

// Club Admin Shells
router.get('/club/events', requireRole('CLUB_ADMIN', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'Club Event Management - CampusClubOS',
    featureName: 'Club Event Creation & Faculty Submission',
    roleRequired: 'CLUB_ADMIN'
  });
});

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

// Faculty Shells
router.get('/faculty/events', requireRole('FACULTY', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'Event Approvals - CampusClubOS',
    featureName: 'Club Event Proposals Review Queue',
    roleRequired: 'FACULTY (Coordinator)'
  });
});

router.get('/faculty/od', requireRole('FACULTY', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'On-Duty Approvals - CampusClubOS',
    featureName: 'Mentee OD Application Review Queue',
    roleRequired: 'FACULTY (Class Mentor)'
  });
});

router.get('/faculty/mentees', requireRole('FACULTY', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'Mentee Roster - CampusClubOS',
    featureName: 'Assigned Mentee Participation Records',
    roleRequired: 'FACULTY'
  });
});

// Student Shells
router.get('/student/events', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'Approved Events - CampusClubOS',
    featureName: 'Browse & Register for Approved Events',
    roleRequired: 'STUDENT'
  });
});

router.get('/student/my-registrations', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'My Event Registrations - CampusClubOS',
    featureName: 'My Event Registrations & Check-In',
    roleRequired: 'STUDENT'
  });
});

router.get('/student/od', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), (req, res) => {
  res.render('placeholder', {
    title: 'On-Duty Requests - CampusClubOS',
    featureName: 'My OD Applications & Period Status',
    roleRequired: 'STUDENT'
  });
});

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
