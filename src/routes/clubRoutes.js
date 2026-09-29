const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/index');
const { requireRole, requirePermission, requireClubScope } = require('../middleware/rbac');
const { doubleCsrfProtection, attachCsrfToken } = require('../middleware/csrf');
const { CLUB_CATALOG_PERMISSIONS } = require('../services/permissions');
const {
  createClubRole,
  updateClubRole,
  deleteClubRole,
  assignMemberDynamicRole,
  getClubRolesAndMembers
} = require('../services/clubRoleService');

const router = express.Router();

const clubLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * GET /club/:clubId/roles
 * Render Dynamic Role Management Dashboard for a specific Club
 */
router.get('/club/:clubId/roles', requireRole('CLUB_ADMIN', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const clubId = parseInt(req.params.clubId, 10);

  // IDOR & Ownership Verification for Club Admin
  if (req.user.role === 'CLUB_ADMIN') {
    const club = db.prepare('SELECT id, name FROM clubs WHERE id = ? AND club_admin_id = ?').get(clubId, req.user.id);
    if (!club) {
      res.status(403);
      if (req.accepts('html')) {
        return res.render('403', { title: '403 - Forbidden' });
      }
      return res.json({ error: 'Access Forbidden: You can only manage dynamic roles for your own club' });
    }
  }

  const club = db.prepare('SELECT id, name, code, description FROM clubs WHERE id = ?').get(clubId);
  if (!club) {
    return res.status(404).render('404', { title: '404 - Club Not Found' });
  }

  const { roles, members } = getClubRolesAndMembers(clubId);

  res.render('club/roles', {
    title: `Dynamic Roles - ${club.name}`,
    club,
    roles,
    members,
    catalogPermissions: CLUB_CATALOG_PERMISSIONS,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

/**
 * POST /club/:clubId/roles
 * Create New Dynamic Role
 */
router.post('/club/:clubId/roles', requireRole('CLUB_ADMIN', 'SUPER_ADMIN'), clubLimiter, doubleCsrfProtection, (req, res) => {
  const clubId = parseInt(req.params.clubId, 10);
  try {
    const newRole = createClubRole(req.user, clubId, req.body);
    if (req.accepts('html')) {
      return res.redirect(`/club/${clubId}/roles?success=${encodeURIComponent(`Dynamic role '${newRole.role_name}' created successfully.`)}`);
    }
    return res.status(201).json({ message: 'Role created successfully', role: newRole });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/${clubId}/roles?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

/**
 * POST /club/:clubId/roles/:roleId/update
 * Update Dynamic Role & Permissions
 */
router.post('/club/:clubId/roles/:roleId/update', requireRole('CLUB_ADMIN', 'SUPER_ADMIN'), clubLimiter, doubleCsrfProtection, (req, res) => {
  const clubId = parseInt(req.params.clubId, 10);
  try {
    const updatedRole = updateClubRole(req.user, clubId, req.params.roleId, req.body);
    if (req.accepts('html')) {
      return res.redirect(`/club/${clubId}/roles?success=${encodeURIComponent(`Dynamic role '${updatedRole.role_name}' updated successfully.`)}`);
    }
    return res.json({ message: 'Role updated successfully', role: updatedRole });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/${clubId}/roles?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

/**
 * POST /club/:clubId/roles/:roleId/delete
 * Delete Dynamic Role (Unassigns members first in transaction)
 */
router.post('/club/:clubId/roles/:roleId/delete', requireRole('CLUB_ADMIN', 'SUPER_ADMIN'), clubLimiter, doubleCsrfProtection, (req, res) => {
  const clubId = parseInt(req.params.clubId, 10);
  try {
    const deleted = deleteClubRole(req.user, clubId, req.params.roleId);
    if (req.accepts('html')) {
      return res.redirect(`/club/${clubId}/roles?success=${encodeURIComponent(`Role '${deleted.role_name}' deleted. (${deleted.unassignedMembersCount} members unassigned)`)}`);
    }
    return res.json({ message: 'Role deleted successfully', details: deleted });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/${clubId}/roles?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

/**
 * POST /club/:clubId/members/assign-role
 * Assign / Unassign Dynamic Role for Approved Member
 */
router.post('/club/:clubId/members/assign-role', requireRole('CLUB_ADMIN', 'SUPER_ADMIN'), clubLimiter, doubleCsrfProtection, (req, res) => {
  const clubId = parseInt(req.params.clubId, 10);
  try {
    const assigned = assignMemberDynamicRole(req.user, clubId, req.body);
    if (req.accepts('html')) {
      return res.redirect(`/club/${clubId}/roles?success=${encodeURIComponent('Member dynamic role updated successfully.')}`);
    }
    return res.json({ message: 'Member dynamic role updated successfully', result: assigned });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/${clubId}/roles?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// TEMPORARY GUARDED PROBE ROUTES (For Permission Verification)
// Note: Evaluates requirePermission against target URL clubId parameter.
// ============================================================================
router.get('/club/:clubId/_probe/:permission', (req, res, next) => {
  const permName = req.params.permission.toUpperCase();
  const clubId = parseInt(req.params.clubId, 10);

  const scopeResolver = (request) => ({ clubId: parseInt(request.params.clubId, 10) });
  const guard = requirePermission(permName, scopeResolver);

  guard(req, res, () => {
    return res.send(`PROBE_GRANTED:${permName}:CLUB_${clubId}`);
  });
});

module.exports = router;
