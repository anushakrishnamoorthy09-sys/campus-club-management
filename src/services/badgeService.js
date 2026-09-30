const db = require('../db/index');
const { hasPermission } = require('./permissions');
const notificationService = require('./notificationService');

const FIXED_ICONS = ['sparkles', 'flame', 'heart', 'briefcase', 'trophy', 'star', 'shield'];

/**
 * Audit Logger Helper
 */
function logAudit(actorId, action, targetEntity, targetId = null, detailsObj = {}) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json) VALUES (?, ?, ?, ?, ?)'
    ).run(actorId, action, targetEntity, targetId, JSON.stringify(detailsObj));
  } catch (err) {
    console.error('[BADGE AUDIT LOG ERROR]:', err.message);
  }
}

/**
 * Create a new badge type for a club
 */
function createBadgeType(clubIdInput, data, actorUser) {
  const clubId = parseInt(clubIdInput, 10);
  const name = (data.name || '').trim();
  const description = (data.description || '').trim();
  let iconName = (data.icon_name || 'star').toLowerCase().trim();

  if (isNaN(clubId) || !clubId) {
    const err = new Error('Valid club ID is required');
    err.statusCode = 400;
    throw err;
  }

  if (!name || !description) {
    const err = new Error('Badge name and description are required');
    err.statusCode = 400;
    throw err;
  }

  if (!FIXED_ICONS.includes(iconName)) {
    iconName = 'star';
  }

  // Permission Check: Require AWARD_BADGE for the club
  if (!hasPermission(actorUser, 'AWARD_BADGE', { clubId })) {
    const err = new Error('Access Forbidden: Missing AWARD_BADGE permission for this club');
    err.statusCode = 403;
    throw err;
  }

  // Check duplicate name in same club
  const existing = db.prepare('SELECT id FROM badges WHERE club_id = ? AND LOWER(name) = LOWER(?)').get(clubId, name);
  if (existing) {
    const err = new Error(`Badge type '${name}' already exists for this club`);
    err.statusCode = 400;
    throw err;
  }

  const res = db.prepare(
    'INSERT INTO badges (club_id, name, description, icon_name) VALUES (?, ?, ?, ?)'
  ).run(clubId, name, description, iconName);

  logAudit(actorUser.id, 'BADGE_TYPE_CREATED', 'badges', res.lastInsertRowid, {
    clubId,
    name,
    iconName
  });

  return db.prepare('SELECT * FROM badges WHERE id = ?').get(res.lastInsertRowid);
}

/**
 * Edit an existing club badge type
 */
function updateBadgeType(badgeTypeIdInput, data, actorUser) {
  const badgeId = parseInt(badgeTypeIdInput, 10);
  const badge = db.prepare('SELECT * FROM badges WHERE id = ?').get(badgeId);

  if (!badge) {
    const err = new Error('Badge type not found');
    err.statusCode = 404;
    throw err;
  }

  if (badge.club_id === null && actorUser.role !== 'SUPER_ADMIN') {
    const err = new Error('Access Forbidden: Only Super Admin can edit global system badges');
    err.statusCode = 403;
    throw err;
  }

  if (badge.club_id !== null && !hasPermission(actorUser, 'AWARD_BADGE', { clubId: badge.club_id })) {
    const err = new Error('Access Forbidden: Missing AWARD_BADGE permission for this club');
    err.statusCode = 403;
    throw err;
  }

  const name = (data.name || badge.name).trim();
  const description = (data.description || badge.description).trim();
  let iconName = (data.icon_name || badge.icon_name).toLowerCase().trim();
  if (!FIXED_ICONS.includes(iconName)) iconName = badge.icon_name;

  db.prepare(`
    UPDATE badges
    SET name = ?, description = ?, icon_name = ?
    WHERE id = ?
  `).run(name, description, iconName, badgeId);

  logAudit(actorUser.id, 'BADGE_TYPE_UPDATED', 'badges', badgeId, { name, iconName });

  return db.prepare('SELECT * FROM badges WHERE id = ?').get(badgeId);
}

/**
 * Award a badge to a student (Manual or Automated)
 */
function award(badgeTypeIdInput, studentUserIdInput, actorUser, reasonInput = '') {
  const badgeId = parseInt(badgeTypeIdInput, 10);
  const studentUserId = parseInt(studentUserIdInput, 10);
  const reason = (reasonInput || '').trim();

  if (isNaN(badgeId) || !badgeId || isNaN(studentUserId) || !studentUserId) {
    const err = new Error('Valid badge ID and student user ID are required');
    err.statusCode = 400;
    throw err;
  }

  const badge = db.prepare(`
    SELECT b.*, c.name as club_name
    FROM badges b
    LEFT JOIN clubs c ON b.club_id = c.id
    WHERE b.id = ?
  `).get(badgeId);

  if (!badge) {
    const err = new Error('Badge type not found');
    err.statusCode = 404;
    throw err;
  }

  const student = db.prepare(`
    SELECT s.user_id, u.full_name, s.ra_number
    FROM students s
    JOIN users u ON s.user_id = u.id
    WHERE s.user_id = ?
  `).get(studentUserId);

  if (!student) {
    const err = new Error('Student user not found');
    err.statusCode = 404;
    throw err;
  }

  // Authorization Check:
  const isSystem = actorUser.isSystem === true;
  const isSuperAdmin = actorUser.role === 'SUPER_ADMIN';

  if (badge.club_id === null) {
    // Global badge -> Only system or Super Admin can award
    if (!isSystem && !isSuperAdmin) {
      const err = new Error('Access Forbidden: Global milestone badges can only be awarded by the system or Super Admin');
      err.statusCode = 403;
      throw err;
    }
  } else {
    // Club badge -> Requires AWARD_BADGE in that specific club
    if (!hasPermission(actorUser, 'AWARD_BADGE', { clubId: badge.club_id })) {
      const err = new Error('Access Forbidden: Missing AWARD_BADGE permission for this club');
      err.statusCode = 403;
      throw err;
    }
  }

  // Check duplicate award
  const existing = db.prepare('SELECT * FROM student_badges WHERE badge_id = ? AND student_user_id = ?').get(badgeId, studentUserId);
  if (existing) {
    // Idempotent: return existing record without error or duplication
    return existing;
  }

  const tx = db.transaction(() => {
    const res = db.prepare(`
      INSERT INTO student_badges (badge_id, student_user_id, awarded_by, reason, awarded_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(badgeId, studentUserId, actorUser.id || 1, reason || null);

    const sourceName = badge.club_name || 'Campus System';
    notificationService.awardBadgeNotification(studentUserId, badge.name, sourceName);

    logAudit(actorUser.id || 1, 'BADGE_AWARDED', 'student_badges', res.lastInsertRowid, {
      badgeId,
      badgeName: badge.name,
      studentUserId,
      studentRa: student.ra_number,
      reason
    });

    return db.prepare('SELECT * FROM student_badges WHERE id = ?').get(res.lastInsertRowid);
  });

  return tx();
}

/**
 * Revoke an awarded badge
 */
function revokeBadge(studentBadgeIdInput, actorUser, reasonInput) {
  const studentBadgeId = parseInt(studentBadgeIdInput, 10);
  const reason = (reasonInput || '').trim();

  if (!reason) {
    const err = new Error('Revocation reason is mandatory');
    err.statusCode = 400;
    throw err;
  }

  const record = db.prepare(`
    SELECT sb.*, b.club_id, b.name as badge_name, s.ra_number
    FROM student_badges sb
    JOIN badges b ON sb.badge_id = b.id
    JOIN students s ON sb.student_user_id = s.user_id
    WHERE sb.id = ?
  `).get(studentBadgeId);

  if (!record) {
    const err = new Error('Awarded badge record not found');
    err.statusCode = 404;
    throw err;
  }

  const isSuperAdmin = actorUser.role === 'SUPER_ADMIN';
  const isClubAdmin = record.club_id !== null && actorUser.role === 'CLUB_ADMIN' && Boolean(
    db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(record.club_id, actorUser.id)
  );

  if (!isSuperAdmin && !isClubAdmin) {
    const err = new Error('Access Forbidden: Only the Club Admin or Super Admin can revoke awarded badges');
    err.statusCode = 403;
    throw err;
  }

  db.prepare('DELETE FROM student_badges WHERE id = ?').run(studentBadgeId);

  logAudit(actorUser.id, 'BADGE_REVOKED', 'student_badges', studentBadgeId, {
    badgeId: record.badge_id,
    badgeName: record.badge_name,
    studentUserId: record.student_user_id,
    reason
  });

  return { success: true, message: `Badge '${record.badge_name}' revoked successfully.` };
}

/**
 * Evaluate and trigger automatic milestone badges for a student
 * Called inside/after attendance marking or certificate issuance
 */
function evaluateAutoBadges(studentUserIdInput) {
  const studentUserId = parseInt(studentUserIdInput, 10);
  if (!studentUserId) return;

  const systemActor = { id: 1, role: 'SUPER_ADMIN', isSystem: true };

  // Fetch global system badges
  const globalBadges = db.prepare('SELECT id, name FROM badges WHERE club_id IS NULL').all();
  const badgeMap = {};
  globalBadges.forEach(b => { badgeMap[b.name] = b.id; });

  // 1. Check PRESENT attendance count
  const attCount = db.prepare("SELECT COUNT(*) as count FROM attendance WHERE student_user_id = ? AND status = 'PRESENT'").get(studentUserId).count;

  if (attCount >= 1 && badgeMap['First Event']) {
    try { award(badgeMap['First Event'], studentUserId, systemActor, 'Automated milestone: 1st attended event'); } catch (e) {}
  }

  if (attCount >= 3 && badgeMap['3-Event Streak']) {
    try { award(badgeMap['3-Event Streak'], studentUserId, systemActor, 'Automated milestone: 3 attended events streak'); } catch (e) {}
  }

  // 2. Check Certificates for VOLUNTEER or ORGANIZER roles
  const certs = db.prepare("SELECT role_type FROM certificates WHERE student_user_id = ? AND status = 'ISSUED'").all(studentUserId);
  const roles = new Set(certs.map(c => c.role_type));

  if (roles.has('VOLUNTEER') && badgeMap['Club Volunteer']) {
    try { award(badgeMap['Club Volunteer'], studentUserId, systemActor, 'Automated milestone: Event Volunteer Certificate'); } catch (e) {}
  }

  if (roles.has('ORGANIZER') && badgeMap['Event Organizer']) {
    try { award(badgeMap['Event Organizer'], studentUserId, systemActor, 'Automated milestone: Event Organizer Certificate'); } catch (e) {}
  }
}

/**
 * Fetch unified student profile data
 */
function getStudentProfile(studentUserIdInput) {
  const studentUserId = parseInt(studentUserIdInput, 10);
  const student = db.prepare(`
    SELECT s.id as student_id, s.user_id, s.ra_number, s.department, s.year_of_study, s.section, s.class_mentor_id,
           u.full_name, u.email, u.created_at as joined_campus_at,
           u_mentor.full_name as mentor_name, u_mentor.email as mentor_email, f.department as mentor_dept
    FROM students s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN users u_mentor ON s.class_mentor_id = u_mentor.id
    LEFT JOIN faculty f ON s.class_mentor_id = f.user_id
    WHERE s.user_id = ?
  `).get(studentUserId);

  if (!student) {
    const err = new Error('Student profile not found');
    err.statusCode = 404;
    throw err;
  }

  // Joined Clubs & Roles
  const clubsJoined = db.prepare(`
    SELECT cm.joined_at, cm.status, c.id as club_id, c.name as club_name, c.code as club_code, c.logo_url,
           cr.role_name
    FROM club_memberships cm
    JOIN clubs c ON cm.club_id = c.id
    LEFT JOIN club_roles cr ON cm.club_role_id = cr.id
    WHERE cm.user_id = ? AND cm.status = 'APPROVED'
    ORDER BY c.name ASC
  `).all(studentUserId);

  // All Badges Earned across all clubs & system
  const badgesEarned = db.prepare(`
    SELECT sb.id as student_badge_id, sb.awarded_at, sb.reason,
           b.id as badge_id, b.name as badge_name, b.description, b.icon_name,
           c.name as club_name, c.code as club_code
    FROM student_badges sb
    JOIN badges b ON sb.badge_id = b.id
    LEFT JOIN clubs c ON b.club_id = c.id
    WHERE sb.student_user_id = ?
    ORDER BY sb.awarded_at DESC
  `).all(studentUserId);

  // Certificates List
  const certificates = db.prepare(`
    SELECT cert.id, cert.certificate_uuid, cert.role_type, cert.issued_at, cert.status, cert.revocation_reason,
           e.title as event_title, e.event_date, c.name as club_name
    FROM certificates cert
    JOIN events e ON cert.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    WHERE cert.student_user_id = ?
    ORDER BY cert.issued_at DESC
  `).all(studentUserId);

  // Attended Events Count
  const eventsAttendedCount = db.prepare("SELECT COUNT(*) as count FROM attendance WHERE student_user_id = ? AND status = 'PRESENT'").get(studentUserId).count;

  // OD Metrics & Approval Rate
  const totalOdRequests = db.prepare('SELECT COUNT(*) as count FROM od_requests WHERE student_user_id = ?').get(studentUserId).count;
  const approvedOdRequests = db.prepare("SELECT COUNT(*) as count FROM od_requests WHERE student_user_id = ? AND status = 'APPROVED'").get(studentUserId).count;

  let odApprovalRate = 'N/A';
  if (totalOdRequests > 0) {
    odApprovalRate = `${((approvedOdRequests / totalOdRequests) * 100).toFixed(1)}%`;
  }

  return {
    student,
    clubsJoined,
    badgesEarned,
    certificates,
    metrics: {
      eventsAttendedCount,
      totalOdRequests,
      approvedOdRequests,
      odApprovalRate,
      totalBadgesCount: badgesEarned.length,
      totalCertificatesCount: certificates.length
    },
    fixedIcons: FIXED_ICONS
  };
}

/**
 * Fetch club badge roster & management data
 */
function getClubBadgeData(clubIdInput, actorUser) {
  const clubId = parseInt(clubIdInput, 10);
  const club = db.prepare('SELECT id, name, code FROM clubs WHERE id = ?').get(clubId);

  if (!club) {
    const err = new Error('Club not found');
    err.statusCode = 404;
    throw err;
  }

  if (!hasPermission(actorUser, 'AWARD_BADGE', { clubId })) {
    const err = new Error('Access Forbidden: Missing AWARD_BADGE permission for this club');
    err.statusCode = 403;
    throw err;
  }

  // Club badge types
  const badgeTypes = db.prepare('SELECT * FROM badges WHERE club_id = ? ORDER BY name ASC').all(clubId);

  // Members & Attendees Roster for awarding
  const members = db.prepare(`
    SELECT DISTINCT u.id as student_user_id, u.full_name, s.ra_number, s.department
    FROM club_memberships cm
    JOIN students s ON cm.user_id = s.user_id
    JOIN users u ON s.user_id = u.id
    WHERE cm.club_id = ? AND cm.status = 'APPROVED'
    ORDER BY u.full_name ASC
  `).all(clubId);

  // Recent awards in this club
  const recentAwards = db.prepare(`
    SELECT sb.id as student_badge_id, sb.awarded_at, sb.reason,
           b.name as badge_name, b.icon_name,
           u_student.full_name as student_name, s.ra_number,
           u_actor.full_name as awarded_by_name
    FROM student_badges sb
    JOIN badges b ON sb.badge_id = b.id
    JOIN students s ON sb.student_user_id = s.user_id
    JOIN users u_student ON s.user_id = u_student.id
    JOIN users u_actor ON sb.awarded_by = u_actor.id
    WHERE b.club_id = ?
    ORDER BY sb.awarded_at DESC
  `).all(clubId);

  return {
    club,
    badgeTypes,
    members,
    recentAwards,
    fixedIcons: FIXED_ICONS
  };
}

module.exports = {
  createBadgeType,
  updateBadgeType,
  award,
  revokeBadge,
  evaluateAutoBadges,
  getStudentProfile,
  getClubBadgeData,
  FIXED_ICONS
};
