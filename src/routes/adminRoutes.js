const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireRole } = require('../middleware/rbac');
const { doubleCsrfProtection, attachCsrfToken } = require('../middleware/csrf');
const {
  createUserByAdmin,
  toggleUserActiveStatus,
  getAllUsers,
  getFacultyUsers,
  getClubAdminUsers
} = require('../services/userService');
const {
  createClub,
  updateClub,
  assignClubAdminAndCoordinators,
  deleteClub,
  getAllClubs
} = require('../services/clubService');

const router = express.Router();

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});

// ============================================================================
// USER MANAGEMENT ROUTES
// ============================================================================

/**
 * GET /admin/users
 * User Management Directory Page (SUPER_ADMIN, ADMIN)
 */
router.get('/admin/users', requireRole('SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const users = getAllUsers();
  const facultyMentors = getFacultyUsers();
  const clubAdmins = getClubAdminUsers();

  res.render('admin/users', {
    title: 'User Management - CampusClubOS',
    users,
    facultyMentors,
    clubAdmins,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

/**
 * POST /admin/users
 * Create User Account (SUPER_ADMIN creates ADMIN/FACULTY/CLUB_ADMIN; ADMIN creates CLUB_ADMIN ONLY)
 */
router.post('/admin/users', requireRole('SUPER_ADMIN', 'ADMIN'), adminLimiter, doubleCsrfProtection, (req, res) => {
  try {
    const newUser = createUserByAdmin(req.user, req.body);
    if (req.accepts('html')) {
      return res.redirect(`/admin/users?success=${encodeURIComponent(`User account for '${newUser.full_name}' (${newUser.role}) created successfully.`)}`);
    }
    return res.status(201).json({ message: 'User created successfully', user: newUser });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/admin/users?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

/**
 * POST /admin/users/:id/toggle-status
 * Deactivate / Reactivate User Account (SUPER_ADMIN ONLY)
 */
router.post('/admin/users/:id/toggle-status', requireRole('SUPER_ADMIN'), adminLimiter, doubleCsrfProtection, (req, res) => {
  try {
    const result = toggleUserActiveStatus(req.user, req.params.id, req.body.isActive);
    const statusText = result.is_active === 1 ? 'reactivated' : 'deactivated';

    if (req.accepts('html')) {
      return res.redirect(`/admin/users?success=${encodeURIComponent(`Account for ${result.email} ${statusText} successfully.`)}`);
    }
    return res.json({ message: `Account ${statusText} successfully`, user: result });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/admin/users?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// CLUB MANAGEMENT ROUTES
// ============================================================================

/**
 * GET /admin/clubs
 * Club Directory & Management Page (SUPER_ADMIN, ADMIN)
 */
router.get('/admin/clubs', requireRole('SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const clubs = getAllClubs();
  const facultyMentors = getFacultyUsers();
  const clubAdmins = getClubAdminUsers();

  res.render('admin/clubs', {
    title: 'Club Directory Management - CampusClubOS',
    clubs,
    facultyMentors,
    clubAdmins,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

/**
 * POST /admin/clubs
 * Create New Campus Club (SUPER_ADMIN ONLY)
 */
router.post('/admin/clubs', requireRole('SUPER_ADMIN'), adminLimiter, doubleCsrfProtection, (req, res) => {
  try {
    const newClub = createClub(req.user, req.body);
    if (req.accepts('html')) {
      return res.redirect(`/admin/clubs?success=${encodeURIComponent(`Campus Club '${newClub.name}' (${newClub.code}) created successfully.`)}`);
    }
    return res.status(201).json({ message: 'Club created successfully', club: newClub });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/admin/clubs?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

/**
 * POST /admin/clubs/:id/update
 * Update Club Details & Status (SUPER_ADMIN, ADMIN)
 */
router.post('/admin/clubs/:id/update', requireRole('SUPER_ADMIN', 'ADMIN'), adminLimiter, doubleCsrfProtection, (req, res) => {
  try {
    const updated = updateClub(req.user, req.params.id, req.body);
    if (req.accepts('html')) {
      return res.redirect(`/admin/clubs?success=${encodeURIComponent(`Club '${updated.name}' updated successfully.`)}`);
    }
    return res.json({ message: 'Club updated successfully', club: updated });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/admin/clubs?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

/**
 * POST /admin/clubs/:id/assign
 * Assign / Reassign Club Admin & Faculty Coordinators (SUPER_ADMIN, ADMIN)
 */
router.post('/admin/clubs/:id/assign', requireRole('SUPER_ADMIN', 'ADMIN'), adminLimiter, doubleCsrfProtection, (req, res) => {
  try {
    assignClubAdminAndCoordinators(req.user, req.params.id, req.body);
    if (req.accepts('html')) {
      return res.redirect(`/admin/clubs?success=${encodeURIComponent('Club Admin and Faculty Coordinators reassigned successfully.')}`);
    }
    return res.json({ message: 'Club personnel reassigned successfully' });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/admin/clubs?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

/**
 * POST /admin/clubs/:id/delete
 * Delete Campus Club (SUPER_ADMIN ONLY)
 */
router.post('/admin/clubs/:id/delete', requireRole('SUPER_ADMIN'), adminLimiter, doubleCsrfProtection, (req, res) => {
  try {
    const result = deleteClub(req.user, req.params.id);
    if (req.accepts('html')) {
      return res.redirect(`/admin/clubs?success=${encodeURIComponent(result.message)}`);
    }
    return res.json(result);
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/admin/clubs?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

module.exports = router;
