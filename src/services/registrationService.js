const db = require('../db/index');
const { createNotification } = require('./notificationService');

/**
 * Get current date (YYYY-MM-DD) and time (HH:MM) in Asia/Kolkata timezone
 */
function getAsiaKolkataNow() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const timeStr = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).substring(0, 5);
  return { dateStr, timeStr, now };
}

/**
 * Audit Logger Helper
 */
function logAudit(actorId, action, targetEntity, targetId = null, detailsObj = {}) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json) VALUES (?, ?, ?, ?, ?)'
    ).run(actorId, action, targetEntity, targetId, JSON.stringify(detailsObj));
  } catch (err) {
    console.error('[AUDIT LOG ERROR]:', err.message);
  }
}

/**
 * Register a student for an APPROVED event in a single IMMEDIATE transaction.
 * @param {Number} eventId - Target event ID
 * @param {Number} studentUserId - Authenticated student user ID
 * @returns {Object} Registration record
 */
function register(eventIdInput, studentUserIdInput) {
  const eventId = parseInt(eventIdInput, 10);
  const studentUserId = parseInt(studentUserIdInput, 10);

  const tx = db.transaction(() => {
    // 1. Fetch Event and check status
    const event = db.prepare('SELECT e.*, c.name as club_name, c.status as club_status FROM events e JOIN clubs c ON e.club_id = c.id WHERE e.id = ?').get(eventId);
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    if (event.status !== 'APPROVED') {
      const err = new Error('Registration Denied: Event registration is only available for APPROVED events');
      err.statusCode = 400;
      throw err;
    }

    // 2. Check Club Active status
    if (event.club_status !== 'ACTIVE') {
      const err = new Error('Registration Denied: Club is currently inactive or archived');
      err.statusCode = 400;
      throw err;
    }

    // 3. Verify Student Profile Completion
    const student = db.prepare('SELECT id, ra_number FROM students WHERE user_id = ?').get(studentUserId);
    if (!student || !student.ra_number) {
      const err = new Error('Registration Denied: Complete your student profile before registering for events');
      err.statusCode = 400;
      throw err;
    }

    // 4. Check if event has already started
    const { dateStr, timeStr } = getAsiaKolkataNow();
    if (event.event_date < dateStr || (event.event_date === dateStr && event.start_time <= timeStr)) {
      const err = new Error('Registration Denied: Event has already started or concluded');
      err.statusCode = 400;
      throw err;
    }

    // 5. Check Duplicate Registration
    const existingReg = db.prepare('SELECT id FROM event_registrations WHERE event_id = ? AND student_user_id = ?').get(eventId, studentUserId);
    if (existingReg) {
      const err = new Error('You are already registered for this event');
      err.statusCode = 409;
      throw err;
    }

    // 6. Check Capacity
    const regCount = db.prepare('SELECT COUNT(*) as count FROM event_registrations WHERE event_id = ?').get(eventId).count;
    if (regCount >= event.capacity) {
      const err = new Error('Registration Denied: Event maximum capacity has been reached');
      err.statusCode = 400;
      throw err;
    }

    // Insert registration
    const res = db.prepare(
      'INSERT INTO event_registrations (event_id, student_user_id) VALUES (?, ?)'
    ).run(eventId, studentUserId);

    const regId = res.lastInsertRowid;

    // 1. Notify Student
    createNotification(
      studentUserId,
      'Event Registration Confirmed',
      `You have successfully registered for '${event.title}' by ${event.club_name}.`,
      'EVENT',
      '/student/my-registrations'
    );

    // Fetch student info for recipient messages
    const studentUser = db.prepare('SELECT full_name FROM users WHERE id = ?').get(studentUserId);
    const studentName = studentUser ? studentUser.full_name : `Student (${student.ra_number})`;

    // 2. Notify Club Admin
    if (event.club_admin_id && Number(event.club_admin_id) !== studentUserId) {
      createNotification(
        event.club_admin_id,
        'New Event Registration',
        `${studentName} (${student.ra_number}) registered for your event '${event.title}'.`,
        'EVENT',
        `/club/events/${eventId}/registrations`
      );
    }

    // 3. Notify Faculty Coordinators assigned to the club
    const coordinators = db.prepare('SELECT faculty_user_id FROM club_coordinators WHERE club_id = ?').all(event.club_id);
    for (const coord of coordinators) {
      if (Number(coord.faculty_user_id) !== studentUserId) {
        createNotification(
          coord.faculty_user_id,
          'New Event Registration',
          `${studentName} (${student.ra_number}) registered for '${event.title}' (${event.club_name}).`,
          'EVENT',
          '/faculty/events'
        );
      }
    }

    // 4. Notify Campus Admins
    const admins = db.prepare("SELECT id FROM users WHERE role IN ('ADMIN', 'SUPER_ADMIN')").all();
    for (const admin of admins) {
      if (Number(admin.id) !== studentUserId && Number(admin.id) !== Number(event.club_admin_id)) {
        createNotification(
          admin.id,
          'New Event Registration',
          `${studentName} (${student.ra_number}) registered for '${event.title}' (${event.club_name}).`,
          'EVENT',
          '/admin/events'
        );
      }
    }

    logAudit(studentUserId, 'EVENT_REGISTERED', 'event_registrations', regId, {
      eventId,
      eventTitle: event.title
    });

    return {
      id: regId,
      event_id: eventId,
      student_user_id: studentUserId,
      event_title: event.title
    };
  });

  return tx.immediate();
}

/**
 * Cancel an existing event registration for a student.
 * @param {Number} eventId - Target event ID
 * @param {Number} studentUserId - Authenticated student user ID
 */
function cancelRegistration(eventIdInput, studentUserIdInput) {
  const eventId = parseInt(eventIdInput, 10);
  const studentUserId = parseInt(studentUserIdInput, 10);

  const tx = db.transaction(() => {
    const reg = db.prepare(
      'SELECT er.*, e.status as event_status, e.event_date, e.start_time, e.title as event_title FROM event_registrations er JOIN events e ON er.event_id = e.id WHERE er.event_id = ? AND er.student_user_id = ?'
    ).get(eventId, studentUserId);

    if (!reg) {
      const err = new Error('Event registration record not found');
      err.statusCode = 444;
      throw err;
    }

    if (reg.event_status !== 'APPROVED') {
      const err = new Error('Registration cancellation is only allowed while event is APPROVED');
      err.statusCode = 400;
      throw err;
    }

    const { dateStr, timeStr } = getAsiaKolkataNow();
    if (reg.event_date < dateStr || (reg.event_date === dateStr && reg.start_time <= timeStr)) {
      const err = new Error('Registration cancellation is not allowed after event has started');
      err.statusCode = 400;
      throw err;
    }

    // Check if an OD request exists for this registration
    const odReq = db.prepare('SELECT id FROM od_requests WHERE registration_id = ?').get(reg.id);
    if (odReq) {
      const err = new Error('Cannot cancel registration: An On-Duty (OD) request has already been submitted for this registration.');
      err.statusCode = 400;
      throw err;
    }

    db.prepare('DELETE FROM event_registrations WHERE id = ?').run(reg.id);

    logAudit(studentUserId, 'EVENT_REGISTRATION_CANCELLED', 'event_registrations', reg.id, {
      eventId,
      eventTitle: reg.event_title
    });

    return { success: true, message: `Registration for '${reg.event_title}' cancelled successfully` };
  });

  return tx.immediate();
}

module.exports = {
  register,
  cancelRegistration
};
