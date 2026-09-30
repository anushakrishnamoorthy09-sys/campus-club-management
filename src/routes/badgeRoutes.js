const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/index');
const { requirePermission, requireRole } = require('../middleware/rbac');
const { doubleCsrfProtection, attachCsrfToken } = require('../middleware/csrf');
const badgeService = require('../services/badgeService');

const router = express.Router();

/**
 * Dynamic Scope Resolver for Club Scope
 */
function resolveClubScope(req) {
  const directClubId = req.params.clubId || req.query.clubId || (req.body && req.body.clubId);
  if (directClubId) {
    return { clubId: parseInt(directClubId, 10) };
  }
  if (req.user && req.user.role === 'CLUB_ADMIN') {
    const club = db.prepare('SELECT id FROM clubs WHERE club_admin_id = ? LIMIT 1').get(req.user.id);
    if (club) return { clubId: club.id };
  }
  return { clubId: null };
}

// ============================================================================
// 1. UNIFIED STUDENT PROFILE: GET /student/profile
// ============================================================================
router.get('/student/profile', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  try {
    const data = badgeService.getStudentProfile(req.user.id);
    res.render('student/profile', {
      title: `${data.student.full_name} - Student Profile`,
      student: data.student,
      clubsJoined: data.clubsJoined,
      badgesEarned: data.badgesEarned,
      certificates: data.certificates,
      metrics: data.metrics,
      fixedIcons: data.fixedIcons,
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    return res.status(statusCode).render('error', { title: 'Profile Error', message: err.message });
  }
});

// ============================================================================
// 2. CLUB BADGE MANAGEMENT: GET /club/badges
// ============================================================================
router.get('/club/badges', requirePermission('AWARD_BADGE', resolveClubScope), attachCsrfToken, (req, res) => {
  const { clubId } = resolveClubScope(req);
  if (!clubId) {
    return res.status(403).render('403', { title: '403 - Forbidden', message: 'No club scope resolved for badge management.' });
  }

  try {
    const data = badgeService.getClubBadgeData(clubId, req.user);
    res.render('club/badges', {
      title: `Badge Management - ${data.club.name}`,
      club: data.club,
      badgeTypes: data.badgeTypes,
      members: data.members,
      recentAwards: data.recentAwards,
      fixedIcons: data.fixedIcons,
      userPerms: req.permSummary,
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    return res.status(statusCode).render('error', { title: 'Badge Access Error', message: err.message });
  }
});

// ============================================================================
// 3. POST /club/badges/types/new - Create Club Badge Type
// ============================================================================
router.post('/club/badges/types/new', requirePermission('AWARD_BADGE', resolveClubScope), doubleCsrfProtection, (req, res) => {
  const { clubId } = resolveClubScope(req);

  try {
    const newBadge = badgeService.createBadgeType(clubId, req.body, req.user);
    const msg = `Badge type '${newBadge.name}' created successfully.`;
    if (req.accepts('html')) {
      return res.redirect(`/club/badges?success=${encodeURIComponent(msg)}`);
    }
    return res.status(201).json({ message: msg, badge: newBadge });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/badges?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 4. POST /club/badges/types/:id/edit - Edit Club Badge Type
// ============================================================================
router.post('/club/badges/types/:id/edit', requirePermission('AWARD_BADGE', resolveClubScope), doubleCsrfProtection, (req, res) => {
  const badgeId = parseInt(req.params.id, 10);

  try {
    const updated = badgeService.updateBadgeType(badgeId, req.body, req.user);
    const msg = `Badge type '${updated.name}' updated successfully.`;
    if (req.accepts('html')) {
      return res.redirect(`/club/badges?success=${encodeURIComponent(msg)}`);
    }
    return res.json({ message: msg, badge: updated });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/badges?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 5. POST /club/badges/award - Manual Badge Awarding
// ============================================================================
router.post('/club/badges/award', requirePermission('AWARD_BADGE', resolveClubScope), doubleCsrfProtection, (req, res) => {
  const { badgeTypeId, studentUserId, reason } = req.body;

  try {
    const awarded = badgeService.award(badgeTypeId, studentUserId, req.user, reason);
    const msg = 'Badge awarded to student successfully!';
    if (req.accepts('html')) {
      return res.redirect(`/club/badges?success=${encodeURIComponent(msg)}`);
    }
    return res.status(201).json({ message: msg, awarded });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/badges?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 6. POST /club/badges/:awardId/revoke - Revoke Awarded Badge
// ============================================================================
router.post('/club/badges/:awardId/revoke', doubleCsrfProtection, (req, res) => {
  const awardId = parseInt(req.params.awardId, 10);
  const { reason } = req.body;

  try {
    const result = badgeService.revokeBadge(awardId, req.user, reason);
    if (req.accepts('html')) {
      return res.redirect(`/club/badges?success=${encodeURIComponent(result.message)}`);
    }
    return res.json(result);
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/badges?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

module.exports = router;
