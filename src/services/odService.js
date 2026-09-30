const db = require('../db/index');
const timetableService = require('./timetableService');
const { createNotification } = require('./notificationService');

/**
 * On-Duty (OD) Domain Service
 * Enforces institutional rules, DB transaction atomicity, triggers, and scope-based permissions.
 */

/**
 * Helper to fetch periods associated with an OD request.
 * Returns immutable snapshot rows from od_request_periods if decided,
 * or parses working_periods_json if pending/closed without snapshot.
 */
function fetchPeriodsForOd(odId, workingPeriodsJson, status) {
  if (['APPROVED', 'REJECTED'].includes(status)) {
    const snapshotRows = db.prepare(`
      SELECT timetable_id, timetable_name, period_number, period_label, start_time, end_time
      FROM od_request_periods
      WHERE od_request_id = ?
      ORDER BY period_number ASC
    `).all(odId);

    if (snapshotRows.length > 0) {
      return snapshotRows;
    }
  }

  if (workingPeriodsJson) {
    try {
      return JSON.parse(workingPeriodsJson);
    } catch (e) {
      return [];
    }
  }

  return [];
}

/**
 * Helper to format read query results for OD requests.
 */
function formatOdRecord(row) {
  if (!row) return null;

  const periods = fetchPeriodsForOd(row.id, row.working_periods_json, row.status);

  return {
    id: row.id,
    registration_id: row.registration_id,
    student_user_id: row.student_user_id,
    student_name: row.student_name,
    ra_number: row.ra_number,
    department: row.department,
    year_of_study: row.year_of_study,
    section: row.section,
    class_mentor_id: row.class_mentor_id,
    mentor_name: row.mentor_name,
    event_id: row.event_id,
    event_title: row.event_title,
    event_venue: row.event_venue,
    event_date: row.event_date,
    start_time: row.start_time,
    end_time: row.end_time,
    event_status: row.event_status,
    club_id: row.club_id,
    club_name: row.club_name,
    club_code: row.club_code,
    status: row.status,
    faculty_remark: row.faculty_remark,
    reviewed_by: row.reviewed_by,
    reviewer_name: row.reviewer_name,
    reviewed_at: row.reviewed_at,
    escalated_at: row.escalated_at,
    escalated_by: row.escalated_by,
    escalation_reason: row.escalation_reason,
    decided_via: row.decided_via,
    created_at: row.created_at,
    attendance_status: row.attendance_status || null,
    periods
  };
}

/**
 * Base SQL SELECT query for OD requests with full student, mentor, event, club, and attendance details.
 */
const BASE_OD_SELECT = `
  SELECT od.*,
         er.event_id, er.registered_at,
         e.club_id, e.title as event_title, e.venue as event_venue, e.event_date, e.start_time, e.end_time, e.status as event_status,
         c.name as club_name, c.code as club_code,
         s.ra_number, s.department, s.year_of_study, s.section,
         u.full_name as student_name,
         u_mentor.full_name as mentor_name,
         u_rev.full_name as reviewer_name,
         att.status as attendance_status
  FROM od_requests od
  JOIN event_registrations er ON od.registration_id = er.id
  JOIN events e ON er.event_id = e.id
  JOIN clubs c ON e.club_id = c.id
  JOIN students s ON od.student_user_id = s.user_id
  JOIN users u ON s.user_id = u.id
  LEFT JOIN users u_mentor ON od.class_mentor_id = u_mentor.id
  LEFT JOIN users u_rev ON od.reviewed_by = u_rev.id
  LEFT JOIN attendance att ON (att.event_id = e.id AND att.student_user_id = od.student_user_id)
`;

/**
 * 1. odService.request(studentUserId, registrationId)
 * Submits an On-Duty request for an approved/ongoing event registration in ONE transaction.
 */
function request(studentUserId, registrationId) {
  if (!studentUserId) throw new Error('Student user ID is required.');
  if (!registrationId) throw new Error('Registration ID is required.');

  const requestTx = db.transaction(() => {
    // 1. Fetch registration, student, and event details
    const reg = db.prepare(`
      SELECT er.id as registration_id, er.student_user_id, er.event_id,
             e.status as event_status, e.event_date, e.start_time, e.end_time, e.title as event_title,
             s.class_mentor_id, s.ra_number, u.full_name as student_name
      FROM event_registrations er
      JOIN events e ON er.event_id = e.id
      JOIN students s ON er.student_user_id = s.user_id
      JOIN users u ON s.user_id = u.id
      WHERE er.id = ?
    `).get(registrationId);

    if (!reg) {
      const err = new Error('Registration not found.');
      err.statusCode = 404;
      throw err;
    }

    // Security check: Registration must belong to THIS student
    if (Number(reg.student_user_id) !== Number(studentUserId)) {
      const err = new Error('Forbidden: Registration does not belong to this student.');
      err.statusCode = 403;
      throw err;
    }

    // Refuse if event status is NOT APPROVED or ONGOING
    if (!['APPROVED', 'ONGOING'].includes(reg.event_status)) {
      const err = new Error(`OD request blocked: Event is currently ${reg.event_status}. OD requests are only allowed for APPROVED or ONGOING events.`);
      err.statusCode = 400;
      throw err;
    }

    // Refuse if student has no class mentor assigned
    if (!reg.class_mentor_id) {
      const err = new Error('OD request blocked: Student has no assigned class mentor.');
      err.statusCode = 400;
      throw err;
    }

    // Check for open OD (PENDING or APPROVED) for this registration
    const existingActive = db.prepare(`
      SELECT id, status FROM od_requests
      WHERE registration_id = ? AND status IN ('PENDING', 'APPROVED')
    `).get(registrationId);

    if (existingActive) {
      const err = new Error(`OD request blocked: An active OD request (${existingActive.status}) already exists for this registration.`);
      err.statusCode = 409;
      throw err;
    }

    // Compute affected periods with timetableService.previewPeriods
    const preview = timetableService.previewPeriods(reg.event_date, reg.start_time, reg.end_time);

    if (!preview.active) {
      if (preview.reason === 'NO_ACTIVE_STRUCTURE') {
        const err = new Error('OD request blocked: No active timetable structure exists for the event date.');
        err.statusCode = 400;
        throw err;
      }
      if (preview.reason === 'NON_WORKING_DAY') {
        const err = new Error('OD request blocked: Event date is a non-working day according to the active timetable.');
        err.statusCode = 400;
        throw err;
      }
    }

    if (preview.reason === 'ONLY_BREAKS' || !preview.periods || preview.periods.length === 0) {
      const err = new Error('OD request blocked: Event overlaps only breaks or zero academic CLASS periods. No OD is needed or possible.');
      err.statusCode = 400;
      throw err;
    }

    // Fetch active timetable details to attach metadata to working periods
    const activeStructure = timetableService.findActiveStructure(reg.event_date);
    const timetableId = activeStructure ? activeStructure.timetable.id : null;
    const timetableName = activeStructure ? activeStructure.timetable.name : 'Active Timetable';

    const workingPeriods = preview.periods.map(p => ({
      timetable_id: p.timetable_id || timetableId,
      timetable_name: p.timetable_name || timetableName,
      period_number: p.period_number,
      period_label: p.label || p.period_label || `Period ${p.period_number}`,
      start_time: p.start_time,
      end_time: p.end_time,
      type: p.type
    }));

    const workingPeriodsJson = JSON.stringify(workingPeriods);

    // Insert od_requests with status PENDING and working copy of periods
    const insRes = db.prepare(`
      INSERT INTO od_requests (registration_id, student_user_id, class_mentor_id, status, working_periods_json)
      VALUES (?, ?, ?, 'PENDING', ?)
    `).run(registrationId, studentUserId, reg.class_mentor_id, workingPeriodsJson);

    const odId = insRes.lastInsertRowid;

    // Notify class mentor
    createNotification(
      reg.class_mentor_id,
      'New OD Request Raised',
      `Student ${reg.student_name} (${reg.ra_number}) submitted an OD request for event '${reg.event_title}'.`,
      'OD_REQUEST_RAISED',
      '/faculty/od'
    );

    // Audit log
    db.prepare(`
      INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
      VALUES (?, 'OD_REQUEST_CREATED', 'OD_REQUEST', ?, ?)
    `).run(studentUserId, odId, JSON.stringify({
      registration_id: registrationId,
      event_id: reg.event_id,
      class_mentor_id: reg.class_mentor_id,
      period_count: workingPeriods.length
    }));

    return getForStudent(odId, studentUserId);
  });

  return requestTx();
}

/**
 * 2. odService.review(odId, actor, decision, remark)
 * Class Mentor decision on PENDING OD request in ONE transaction.
 * Snapshot recorded directly from stored working copy (working_periods_json).
 */
function review(odId, actor, decision, remark) {
  if (!odId) throw new Error('OD ID is required.');
  if (!actor || !actor.id) throw new Error('Actor information is required.');

  const reviewTx = db.transaction(() => {
    const od = db.prepare(`
      SELECT od.*, e.title as event_title, u.full_name as student_name
      FROM od_requests od
      JOIN event_registrations er ON od.registration_id = er.id
      JOIN events e ON er.event_id = e.id
      JOIN users u ON od.student_user_id = u.id
      WHERE od.id = ?
    `).get(odId);

    if (!od) {
      const err = new Error('OD request not found.');
      err.statusCode = 404;
      throw err;
    }

    // Student can never decide their own request
    if (Number(actor.id) === Number(od.student_user_id)) {
      const err = new Error('Forbidden: Self-approval is impossible.');
      err.statusCode = 403;
      throw err;
    }

    // Only the assigned class mentor (od_requests.class_mentor_id) may decide
    if (Number(actor.id) !== Number(od.class_mentor_id)) {
      const err = new Error('Forbidden: Only the assigned class mentor for this student can decide this OD request.');
      err.statusCode = 403;
      throw err;
    }

    // Only PENDING requests can be decided
    if (od.status !== 'PENDING') {
      const err = new Error(`OD request review blocked: Request status is already ${od.status}.`);
      err.statusCode = 400;
      throw err;
    }

    // Validate decision
    const normalizedDecision = String(decision).toLowerCase();
    if (!['approve', 'reject'].includes(normalizedDecision)) {
      const err = new Error("Invalid decision. Must be 'approve' or 'reject'.");
      err.statusCode = 400;
      throw err;
    }

    const trimmedRemark = remark ? String(remark).trim() : '';

    // Rejection requires a remark
    if (normalizedDecision === 'reject' && !trimmedRemark) {
      const err = new Error('Rejection remark is mandatory when rejecting an OD request.');
      err.statusCode = 400;
      throw err;
    }

    if (normalizedDecision === 'approve') {
      // Set status = APPROVED
      db.prepare(`
        UPDATE od_requests
        SET status = 'APPROVED',
            faculty_remark = ?,
            reviewed_by = ?,
            reviewed_at = CURRENT_TIMESTAMP,
            decided_via = 'MENTOR'
        WHERE id = ?
      `).run(trimmedRemark || null, actor.id, odId);

      // Write final immutable snapshot into od_request_periods from stored working copy
      // This choice guarantees snapshot stability regardless of subsequent timetable edits.
      const periods = fetchPeriodsForOd(odId, od.working_periods_json, 'PENDING');
      const stmtSnapshot = db.prepare(`
        INSERT INTO od_request_periods (od_request_id, timetable_id, timetable_name, period_number, period_label, start_time, end_time)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const p of periods) {
        stmtSnapshot.run(
          odId,
          p.timetable_id || 1,
          p.timetable_name || 'Active Timetable',
          p.period_number,
          p.period_label || p.label || `Period ${p.period_number}`,
          p.start_time,
          p.end_time
        );
      }

      // Notify student
      createNotification(
        od.student_user_id,
        'OD Request Approved',
        `Your OD request for event '${od.event_title}' has been APPROVED by your class mentor.`,
        'OD_REVIEWED',
        '/student/od'
      );

      // Audit log
      db.prepare(`
        INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
        VALUES (?, 'OD_APPROVED', 'OD_REQUEST', ?, ?)
      `).run(actor.id, odId, JSON.stringify({ decision: 'APPROVED', remark: trimmedRemark || null, decided_via: 'MENTOR' }));

    } else {
      // Set status = REJECTED
      db.prepare(`
        UPDATE od_requests
        SET status = 'REJECTED',
            faculty_remark = ?,
            reviewed_by = ?,
            reviewed_at = CURRENT_TIMESTAMP,
            decided_via = 'MENTOR'
        WHERE id = ?
      `).run(trimmedRemark, actor.id, odId);

      // Notify student
      createNotification(
        od.student_user_id,
        'OD Request Rejected',
        `Your OD request for event '${od.event_title}' was REJECTED: ${trimmedRemark}`,
        'OD_REVIEWED',
        '/student/od'
      );

      // Audit log
      db.prepare(`
        INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
        VALUES (?, 'OD_REJECTED', 'OD_REQUEST', ?, ?)
      `).run(actor.id, odId, JSON.stringify({ decision: 'REJECTED', remark: trimmedRemark, decided_via: 'MENTOR' }));
    }

    return getForMentor(odId, actor.id) || getForAdmin(odId);
  });

  return reviewTx();
}

/**
 * 3. Escalation: Mentor escalates a PENDING OD to Admin with a reason.
 */
function escalate(odId, actor, reason) {
  if (!odId) throw new Error('OD ID is required.');
  if (!actor || !actor.id) throw new Error('Actor information is required.');

  const trimmedReason = reason ? String(reason).trim() : '';
  if (!trimmedReason) {
    const err = new Error('Escalation reason is mandatory.');
    err.statusCode = 400;
    throw err;
  }

  const escalateTx = db.transaction(() => {
    const od = db.prepare(`
      SELECT od.*, e.title as event_title, u.full_name as student_name, s.ra_number
      FROM od_requests od
      JOIN event_registrations er ON od.registration_id = er.id
      JOIN events e ON er.event_id = e.id
      JOIN students s ON od.student_user_id = s.user_id
      JOIN users u ON od.student_user_id = u.id
      WHERE od.id = ?
    `).get(odId);

    if (!od) {
      const err = new Error('OD request not found.');
      err.statusCode = 404;
      throw err;
    }

    // Only class mentor can escalate
    if (Number(actor.id) !== Number(od.class_mentor_id)) {
      const err = new Error('Forbidden: Only the assigned class mentor can escalate this OD request.');
      err.statusCode = 403;
      throw err;
    }

    // Only PENDING ODs can be escalated
    if (od.status !== 'PENDING') {
      const err = new Error(`Only PENDING OD requests can be escalated. Current status is ${od.status}.`);
      err.statusCode = 400;
      throw err;
    }

    // Set escalation metadata
    db.prepare(`
      UPDATE od_requests
      SET escalated_at = CURRENT_TIMESTAMP,
          escalated_by = ?,
          escalation_reason = ?
      WHERE id = ?
    `).run(actor.id, trimmedReason, odId);

    // Notify all Admins and Super Admins
    const admins = db.prepare(`
      SELECT id FROM users WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND is_active = 1
    `).all();

    for (const adm of admins) {
      createNotification(
        adm.id,
        'OD Request Escalated',
        `OD request for ${od.student_name} (${od.ra_number}) on event '${od.event_title}' was escalated by mentor. Reason: ${trimmedReason}`,
        'OD_ESCALATED',
        '/admin/od'
      );
    }

    // Audit log
    db.prepare(`
      INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
      VALUES (?, 'OD_ESCALATED', 'OD_REQUEST', ?, ?)
    `).run(actor.id, odId, JSON.stringify({ reason: trimmedReason }));

    return getForMentor(odId, actor.id);
  });

  return escalateTx();
}

/**
 * 3b. Escalation Review: Admin or Super Admin approves/rejects an ESCALATED OD.
 * Admin/Super Admin may NOT decide a PENDING (non-escalated) OD.
 */
function escalationReview(odId, actor, decision, remark) {
  if (!odId) throw new Error('OD ID is required.');
  if (!actor || !actor.id) throw new Error('Actor information is required.');

  const escalationReviewTx = db.transaction(() => {
    // Role check: Only ADMIN or SUPER_ADMIN
    if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role)) {
      const err = new Error('Forbidden: Only Administrators can review escalated OD requests.');
      err.statusCode = 403;
      throw err;
    }

    const od = db.prepare(`
      SELECT od.*, e.title as event_title, u.full_name as student_name
      FROM od_requests od
      JOIN event_registrations er ON od.registration_id = er.id
      JOIN events e ON er.event_id = e.id
      JOIN users u ON od.student_user_id = u.id
      WHERE od.id = ?
    `).get(odId);

    if (!od) {
      const err = new Error('OD request not found.');
      err.statusCode = 404;
      throw err;
    }

    // Self-approval check
    if (Number(actor.id) === Number(od.student_user_id)) {
      const err = new Error('Forbidden: Self-approval is impossible.');
      err.statusCode = 403;
      throw err;
    }

    // Admin can ONLY decide an ESCALATED OD (escalated_at IS NOT NULL)
    if (!od.escalated_at) {
      const err = new Error('Forbidden: Administrators cannot decide non-escalated PENDING OD requests.');
      err.statusCode = 403;
      throw err;
    }

    if (od.status !== 'PENDING') {
      const err = new Error(`OD request is already ${od.status}.`);
      err.statusCode = 400;
      throw err;
    }

    const normalizedDecision = String(decision).toLowerCase();
    if (!['approve', 'reject'].includes(normalizedDecision)) {
      const err = new Error("Invalid decision. Must be 'approve' or 'reject'.");
      err.statusCode = 400;
      throw err;
    }

    const trimmedRemark = remark ? String(remark).trim() : '';
    if (!trimmedRemark) {
      const err = new Error('A decision reason/remark is mandatory when an Administrator decides an escalated OD request.');
      err.statusCode = 400;
      throw err;
    }

    if (normalizedDecision === 'approve') {
      db.prepare(`
        UPDATE od_requests
        SET status = 'APPROVED',
            faculty_remark = ?,
            reviewed_by = ?,
            reviewed_at = CURRENT_TIMESTAMP,
            decided_via = 'ADMIN_ESCALATION'
        WHERE id = ?
      `).run(trimmedRemark, actor.id, odId);

      // Write immutable snapshot to od_request_periods from stored working copy
      const periods = fetchPeriodsForOd(odId, od.working_periods_json, 'PENDING');
      const stmtSnapshot = db.prepare(`
        INSERT INTO od_request_periods (od_request_id, timetable_id, timetable_name, period_number, period_label, start_time, end_time)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const p of periods) {
        stmtSnapshot.run(
          odId,
          p.timetable_id || 1,
          p.timetable_name || 'Active Timetable',
          p.period_number,
          p.period_label || p.label || `Period ${p.period_number}`,
          p.start_time,
          p.end_time
        );
      }

      createNotification(
        od.student_user_id,
        'OD Request Approved (Escalated)',
        `Your escalated OD request for event '${od.event_title}' was APPROVED by Administration. Remark: ${trimmedRemark}`,
        'OD_REVIEWED',
        '/student/od'
      );

      db.prepare(`
        INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
        VALUES (?, 'OD_ESCALATION_APPROVED', 'OD_REQUEST', ?, ?)
      `).run(actor.id, odId, JSON.stringify({ decision: 'APPROVED', remark: trimmedRemark, decided_via: 'ADMIN_ESCALATION' }));

    } else {
      db.prepare(`
        UPDATE od_requests
        SET status = 'REJECTED',
            faculty_remark = ?,
            reviewed_by = ?,
            reviewed_at = CURRENT_TIMESTAMP,
            decided_via = 'ADMIN_ESCALATION'
        WHERE id = ?
      `).run(trimmedRemark, actor.id, odId);

      createNotification(
        od.student_user_id,
        'OD Request Rejected (Escalated)',
        `Your escalated OD request for event '${od.event_title}' was REJECTED by Administration: ${trimmedRemark}`,
        'OD_REVIEWED',
        '/student/od'
      );

      db.prepare(`
        INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
        VALUES (?, 'OD_ESCALATION_REJECTED', 'OD_REQUEST', ?, ?)
      `).run(actor.id, odId, JSON.stringify({ decision: 'REJECTED', remark: trimmedRemark, decided_via: 'ADMIN_ESCALATION' }));
    }

    return getForAdmin(odId);
  });

  return escalationReviewTx();
}

/**
 * 4. Mentor Reassignment: Admin/Super Admin reassigns a student's class mentor.
 * Moves PENDING (and escalated) ODs to the new mentor; DECIDED ODs keep original reviewer forever.
 */
function reassignMentor(studentUserId, newMentorId, actor) {
  if (!studentUserId) throw new Error('Student user ID is required.');
  if (!newMentorId) throw new Error('New mentor user ID is required.');
  if (!actor || !actor.id) throw new Error('Actor information is required.');

  if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role)) {
    const err = new Error('Forbidden: Only Administrators can reassign class mentors.');
    err.statusCode = 403;
    throw err;
  }

  const reassignTx = db.transaction(() => {
    const student = db.prepare(`
      SELECT s.*, u.full_name as student_name, s.class_mentor_id as old_mentor_id
      FROM students s
      JOIN users u ON s.user_id = u.id
      WHERE s.user_id = ?
    `).get(studentUserId);

    if (!student) {
      const err = new Error(`Student with user ID #${studentUserId} not found.`);
      err.statusCode = 404;
      throw err;
    }

    const newMentor = db.prepare(`
      SELECT f.*, u.full_name as mentor_name
      FROM faculty f
      JOIN users u ON f.user_id = u.id
      WHERE f.user_id = ?
    `).get(newMentorId);

    if (!newMentor) {
      const err = new Error(`Faculty mentor with user ID #${newMentorId} not found.`);
      err.statusCode = 404;
      throw err;
    }

    const oldMentorId = student.old_mentor_id;

    // Update students table
    db.prepare(`
      UPDATE students
      SET class_mentor_id = ?
      WHERE user_id = ?
    `).run(newMentorId, studentUserId);

    // Update class_mentor_id on PENDING (and escalated) ODs ONLY
    const movedOdRes = db.prepare(`
      UPDATE od_requests
      SET class_mentor_id = ?
      WHERE student_user_id = ? AND status = 'PENDING'
    `).run(newMentorId, studentUserId);

    // Notify student
    createNotification(
      studentUserId,
      'Class Mentor Reassigned',
      `Your class mentor has been updated to ${newMentor.mentor_name}.`,
      'MENTOR_REASSIGNED',
      '/student/profile'
    );

    // Notify old mentor
    createNotification(
      oldMentorId,
      'Student Reassigned Away',
      `Student ${student.student_name} was reassigned to another class mentor (${newMentor.mentor_name}).`,
      'MENTOR_REASSIGNED',
      '/faculty/students'
    );

    // Notify new mentor
    createNotification(
      newMentorId,
      'New Student Assigned',
      `Student ${student.student_name} has been assigned to your mentorship.`,
      'MENTOR_REASSIGNED',
      '/faculty/students'
    );

    // Audit log
    db.prepare(`
      INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
      VALUES (?, 'STUDENT_MENTOR_REASSIGNED', 'STUDENT', ?, ?)
    `).run(actor.id, studentUserId, JSON.stringify({
      old_mentor_id: oldMentorId,
      new_mentor_id: newMentorId,
      pending_ods_moved: movedOdRes.changes
    }));

    return { student_user_id: studentUserId, old_mentor_id: oldMentorId, new_mentor_id: newMentorId, pending_ods_moved: movedOdRes.changes };
  });

  return reassignTx();
}

/**
 * 5. Event Side Effects: Auto-close PENDING & ESCALATED ODs when an event is cancelled or returned to PENDING_APPROVAL.
 * APPROVED ODs remain APPROVED in record, flagged with cancellation context for display & notifications.
 */
function autoCloseForEvent(eventId, reason) {
  if (!eventId) return [];

  const autoCloseTx = db.transaction(() => {
    // 1. Fetch pending & escalated requests
    const pendingRequests = db.prepare(`
      SELECT od.id, od.student_user_id, od.class_mentor_id, e.title as event_title
      FROM od_requests od
      JOIN event_registrations er ON od.registration_id = er.id
      JOIN events e ON er.event_id = e.id
      WHERE er.event_id = ? AND od.status = 'PENDING'
    `).all(eventId);

    const autoRemark = `Auto-closed due to event update/cancellation: ${reason || 'Event structure modified'}`;

    const stmtClose = db.prepare(`
      UPDATE od_requests
      SET status = 'CLOSED',
          faculty_remark = ?,
          reviewed_by = NULL,
          reviewed_at = CURRENT_TIMESTAMP,
          decided_via = 'SYSTEM_AUTO_CLOSE'
      WHERE id = ?
    `);

    const closed = [];
    for (const req of pendingRequests) {
      stmtClose.run(autoRemark, req.id);
      closed.push(req);

      createNotification(
        req.student_user_id,
        'OD Request Auto-Closed',
        `Your pending OD request for event '${req.event_title}' was auto-closed: ${reason || 'Event cancelled'}`,
        'OD_CLOSED',
        '/student/od'
      );
    }

    // 2. Fetch approved requests to send cancellation warning notifications
    const approvedRequests = db.prepare(`
      SELECT od.id, od.student_user_id, e.title as event_title
      FROM od_requests od
      JOIN event_registrations er ON od.registration_id = er.id
      JOIN events e ON er.event_id = e.id
      WHERE er.event_id = ? AND od.status = 'APPROVED'
    `).all(eventId);

    for (const req of approvedRequests) {
      createNotification(
        req.student_user_id,
        'Event Cancelled (Approved OD Alert)',
        `Event '${req.event_title}' for which you have an APPROVED OD has been cancelled or modified: ${reason || 'Event cancelled'}`,
        'EVENT_CANCELLED_OD_ALERT',
        '/student/od'
      );
    }

    // Audit log if any closed
    if (closed.length > 0) {
      db.prepare(`
        INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
        VALUES (1, 'OD_AUTO_CLOSED', 'EVENT', ?, ?)
      `).run(eventId, JSON.stringify({ closed_count: closed.length, reason }));
    }

    return closed;
  });

  return autoCloseTx();
}

/**
 * 6. Read Helpers with Built-In Scope Checks
 */

function listForStudent(studentUserId) {
  if (!studentUserId) return [];
  const rows = db.prepare(`${BASE_OD_SELECT} WHERE od.student_user_id = ? ORDER BY od.created_at DESC`).all(studentUserId);
  return rows.map(formatOdRecord);
}

function listPendingForMentor(mentorUserId) {
  if (!mentorUserId) return [];
  const rows = db.prepare(`${BASE_OD_SELECT} WHERE od.class_mentor_id = ? AND od.status = 'PENDING' ORDER BY od.created_at ASC`).all(mentorUserId);
  return rows.map(formatOdRecord);
}

function listHistoryForMentor(mentorUserId) {
  if (!mentorUserId) return [];
  const rows = db.prepare(`${BASE_OD_SELECT} WHERE (od.class_mentor_id = ? OR od.reviewed_by = ?) AND od.status != 'PENDING' ORDER BY od.reviewed_at DESC, od.created_at DESC`).all(mentorUserId, mentorUserId);
  return rows.map(formatOdRecord);
}

function listEscalatedForAdmin() {
  const rows = db.prepare(`${BASE_OD_SELECT} WHERE od.status = 'PENDING' AND od.escalated_at IS NOT NULL ORDER BY od.escalated_at ASC`).all();
  return rows.map(formatOdRecord);
}

function getForStudent(odId, studentUserId) {
  if (!odId || !studentUserId) return null;
  const row = db.prepare(`${BASE_OD_SELECT} WHERE od.id = ? AND od.student_user_id = ?`).get(odId, studentUserId);
  return formatOdRecord(row);
}

function getForMentor(odId, mentorUserId) {
  if (!odId || !mentorUserId) return null;
  const row = db.prepare(`${BASE_OD_SELECT} WHERE od.id = ? AND (od.class_mentor_id = ? OR od.reviewed_by = ?)`).get(odId, mentorUserId, mentorUserId);
  return formatOdRecord(row);
}

function getForAdmin(odId) {
  if (!odId) return null;
  const row = db.prepare(`${BASE_OD_SELECT} WHERE od.id = ?`).get(odId);
  return formatOdRecord(row);
}

module.exports = {
  request,
  review,
  escalate,
  escalationReview,
  reassignMentor,
  autoCloseForEvent,
  listForStudent,
  listPendingForMentor,
  listHistoryForMentor,
  listEscalatedForAdmin,
  getForStudent,
  getForMentor,
  getForAdmin
};
