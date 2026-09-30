const { z } = require('zod');
const db = require('../db/index');
const { hasPermission } = require('./permissions');

/**
 * Attendance Domain Service
 * Enforces institutional rules, DB transaction atomicity, certificate locking, and scope-based permissions.
 */

/**
 * Audit Logger Helper
 */
function logAudit(actorId, action, targetEntity, targetId = null, detailsObj = {}) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json) VALUES (?, ?, ?, ?, ?)'
    ).run(actorId, action, targetEntity, targetId, JSON.stringify(detailsObj));
  } catch (err) {
    console.error('[ATTENDANCE AUDIT LOG ERROR]:', err.message);
  }
}

/**
 * Zod validation schema for individual attendance status
 */
const statusSchema = z.enum(['PRESENT', 'ABSENT']);

/**
 * Mark or update attendance status for a single student for an event.
 *
 * @param {Number} eventIdInput
 * @param {Number} studentUserIdInput
 * @param {String} statusInput - 'PRESENT' or 'ABSENT'
 * @param {Object} actorUser - Authenticated user object
 * @param {String} methodInput - 'MANUAL' or 'QR' (default 'MANUAL')
 */
function markAttendance(eventIdInput, studentUserIdInput, statusInput, actorUser, methodInput = 'MANUAL') {
  const eventId = parseInt(eventIdInput, 10);
  const studentUserId = parseInt(studentUserIdInput, 10);

  if (isNaN(eventId) || !eventId) {
    const err = new Error('Valid event ID is required');
    err.statusCode = 400;
    throw err;
  }

  if (isNaN(studentUserId) || !studentUserId) {
    const err = new Error('Valid student user ID is required');
    err.statusCode = 400;
    throw err;
  }

  // Validate status
  const parsedStatus = statusSchema.safeParse((statusInput || '').toUpperCase());
  if (!parsedStatus.success) {
    const err = new Error("Invalid attendance status. Must be 'PRESENT' or 'ABSENT'.");
    err.statusCode = 400;
    throw err;
  }
  const status = parsedStatus.data;

  // Sanitize method (client cannot inject arbitrary values)
  const method = ['MANUAL', 'QR'].includes((methodInput || '').toUpperCase()) ? methodInput.toUpperCase() : 'MANUAL';

  // 1. Fetch Event and verify Club Scope & Status
  const event = db.prepare(`
    SELECT e.*, c.name as club_name, c.club_admin_id
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    const err = new Error('Event not found');
    err.statusCode = 404;
    throw err;
  }

  // 2. Permission Check: Require MARK_ATTENDANCE for event's club OR (method === 'QR' and studentUserId === actorUser.id)
  const isSelfQr = (method === 'QR' && studentUserId === actorUser.id && status === 'PRESENT');
  if (!isSelfQr && !hasPermission(actorUser, 'MARK_ATTENDANCE', { clubId: event.club_id })) {
    const err = new Error('Access Forbidden: Missing MARK_ATTENDANCE permission for this club');
    err.statusCode = 403;
    throw err;
  }

  // 3. Event Status Constraint: Must be ONGOING or COMPLETED
  if (!['ONGOING', 'COMPLETED'].includes(event.status)) {
    const err = new Error(`Attendance can only be marked while event is ONGOING or COMPLETED. Current status is '${event.status}'.`);
    err.statusCode = 400;
    throw err;
  }

  // 4. Student Registration Check
  // Note: Institutional rule - Organizers and volunteers must also be registered for the event to receive attendance records.
  const registration = db.prepare('SELECT id FROM event_registrations WHERE event_id = ? AND student_user_id = ?').get(eventId, studentUserId);
  if (!registration) {
    const err = new Error('Action Denied: Student is not registered for this event');
    err.statusCode = 400;
    throw err;
  }

  // 5. Certificate Lock Check: Cannot change to ABSENT if certificate issued
  if (status === 'ABSENT') {
    const cert = db.prepare('SELECT id FROM certificates WHERE event_id = ? AND student_user_id = ?').get(eventId, studentUserId);
    if (cert) {
      const err = new Error('Cannot mark student ABSENT because a certificate has already been issued for this event.');
      err.statusCode = 400;
      throw err;
    }
  }

  // 6. Execute Upsert & Audit Log in Transaction
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT status FROM attendance WHERE event_id = ? AND student_user_id = ?').get(eventId, studentUserId);
    const beforeStatus = existing ? existing.status : 'UNMARKED';

    db.prepare(`
      INSERT INTO attendance (event_id, student_user_id, status, method, marked_by, marked_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(event_id, student_user_id) DO UPDATE SET
        status = excluded.status,
        method = excluded.method,
        marked_by = excluded.marked_by,
        marked_at = CURRENT_TIMESTAMP
    `).run(eventId, studentUserId, status, method, actorUser.id);

    logAudit(actorUser.id, 'ATTENDANCE_MARKED', 'attendance', eventId, {
      eventId,
      studentUserId,
      beforeStatus,
      afterStatus: status,
      method
    });

    if (status === 'PRESENT') {
      try {
        const badgeService = require('./badgeService');
        badgeService.evaluateAutoBadges(studentUserId);
      } catch (e) {
        console.error('[AUTO BADGE ERROR]:', e.message);
      }
    }

    return db.prepare('SELECT * FROM attendance WHERE event_id = ? AND student_user_id = ?').get(eventId, studentUserId);
  });

  return tx();
}

/**
 * Bulk mark attendance for multiple students for an event.
 *
 * @param {Number} eventIdInput
 * @param {Array<{ studentUserId: Number, status: String }>} items
 * @param {Object} actorUser
 */
function bulkMark(eventIdInput, items, actorUser) {
  const eventId = parseInt(eventIdInput, 10);
  if (!Array.isArray(items)) {
    const err = new Error('Items must be an array of student attendance records');
    err.statusCode = 400;
    throw err;
  }

  const tx = db.transaction(() => {
    const results = [];
    for (const item of items) {
      if (!item || !item.studentUserId) continue;
      const record = markAttendance(eventId, item.studentUserId, item.status, actorUser);
      results.push(record);
    }
    return results;
  });

  return tx();
}

/**
 * Mark ALL registered students as PRESENT for an event.
 *
 * @param {Number} eventIdInput
 * @param {Object} actorUser
 */
function markAllPresent(eventIdInput, actorUser) {
  const eventId = parseInt(eventIdInput, 10);

  const tx = db.transaction(() => {
    const regs = db.prepare('SELECT student_user_id FROM event_registrations WHERE event_id = ?').all(eventId);
    const results = [];
    for (const reg of regs) {
      const record = markAttendance(eventId, reg.student_user_id, 'PRESENT', actorUser);
      results.push(record);
    }
    return results;
  });

  return tx();
}

/**
 * Fetch full attendance summary and roster for an event.
 *
 * @param {Number} eventIdInput
 * @param {Object} actorUser
 */
function getEventAttendanceRoster(eventIdInput, actorUser) {
  const eventId = parseInt(eventIdInput, 10);
  const event = db.prepare(`
    SELECT e.*, c.name as club_name, c.code as club_code
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    const err = new Error('Event not found');
    err.statusCode = 404;
    throw err;
  }

  // Permission Check
  if (!hasPermission(actorUser, 'MARK_ATTENDANCE', { clubId: event.club_id })) {
    const err = new Error('Access Forbidden: Missing MARK_ATTENDANCE permission for this club');
    err.statusCode = 403;
    throw err;
  }

  const roster = db.prepare(`
    SELECT er.id as registration_id, er.registered_at,
           s.user_id as student_user_id, s.ra_number, s.department, s.year_of_study, s.section,
           u.full_name as student_name, u.email,
           att.status as attendance_status, att.method as attendance_method, att.marked_at as attendance_marked_at,
           cert.id as certificate_id
    FROM event_registrations er
    JOIN students s ON er.student_user_id = s.user_id
    JOIN users u ON s.user_id = u.id
    LEFT JOIN attendance att ON (att.event_id = er.event_id AND att.student_user_id = er.student_user_id)
    LEFT JOIN certificates cert ON (cert.event_id = er.event_id AND cert.student_user_id = er.student_user_id)
    WHERE er.event_id = ?
    ORDER BY u.full_name ASC
  `).all(eventId);

  let presentCount = 0;
  let absentCount = 0;
  let unmarkedCount = 0;

  roster.forEach(r => {
    if (r.attendance_status === 'PRESENT') presentCount++;
    else if (r.attendance_status === 'ABSENT') absentCount++;
    else unmarkedCount++;
  });

  return {
    event,
    roster,
    summary: {
      totalRegistered: roster.length,
      presentCount,
      absentCount,
      unmarkedCount
    },
    isEditable: ['ONGOING', 'COMPLETED'].includes(event.status)
  };
}

module.exports = {
  markAttendance,
  bulkMark,
  markAllPresent,
  getEventAttendanceRoster,
  logAudit
};
