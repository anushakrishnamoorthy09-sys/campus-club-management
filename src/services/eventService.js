const { z } = require('zod');
const db = require('../db/index');
const { hasPermission } = require('./permissions');
const { createNotification } = require('./notificationService');
const timetableService = require('./timetableService');
const odService = require('./odService');

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
 * Whitelisted Event Input Zod Schema (Mass-assignment protection)
 */
const eventInputSchema = z.object({
  title: z.string().trim().min(2, 'Title must be at least 2 characters'),
  description: z.string().trim().min(5, 'Description must be at least 5 characters'),
  venue: z.string().trim().min(2, 'Venue must be at least 2 characters'),
  event_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Event date must be in YYYY-MM-DD format'),
  start_time: z.string().trim().regex(/^[0-2][0-9]:[0-5][0-9]$/, 'Start time must be in HH:MM format'),
  end_time: z.string().trim().regex(/^[0-2][0-9]:[0-5][0-9]$/, 'End time must be in HH:MM format'),
  capacity: z.coerce.number().int().min(1, 'Capacity must be an integer >= 1'),
  banner_url: z.string().trim().nullable().optional()
});

/**
 * Validates event time, date and duration rules
 */
function validateEventData(data) {
  const parseResult = eventInputSchema.safeParse(data);
  if (!parseResult.success) {
    const err = new Error(parseResult.error.issues[0].message);
    err.statusCode = 400;
    throw err;
  }

  const validated = parseResult.data;

  if (validated.end_time <= validated.start_time) {
    const err = new Error('End time must be after start time');
    err.statusCode = 400;
    throw err;
  }

  const { dateStr, timeStr } = getAsiaKolkataNow();
  if (validated.event_date < dateStr) {
    const err = new Error('Event date cannot be in the past');
    err.statusCode = 400;
    throw err;
  }

  if (validated.event_date === dateStr && validated.start_time <= timeStr) {
    const err = new Error('Start time for today must be in the future');
    err.statusCode = 400;
    throw err;
  }

  return validated;
}

/**
 * Create a new event in DRAFT status
 * @param {Object} actorUser - Authenticated user
 * @param {Number} scopeClubId - Club ID from authenticated scope
 * @param {Object} inputData - Request body data
 */
function createEvent(actorUser, scopeClubIdInput, inputData) {
  const scopeClubId = parseInt(scopeClubIdInput, 10);
  if (!scopeClubId || isNaN(scopeClubId)) {
    const err = new Error('Valid club scope is required to create an event');
    err.statusCode = 400;
    throw err;
  }

  // 1. Permission check
  if (!hasPermission(actorUser, 'EVENT_CREATE', { clubId: scopeClubId })) {
    const err = new Error('Access Forbidden: Missing EVENT_CREATE permission for this club');
    err.statusCode = 403;
    throw err;
  }

  // 2. Validate Club Active status
  const club = db.prepare('SELECT id, name, status FROM clubs WHERE id = ?').get(scopeClubId);
  if (!club) {
    const err = new Error('Target club not found');
    err.statusCode = 404;
    throw err;
  }

  if (club.status !== 'ACTIVE') {
    const err = new Error(`Action Denied: Cannot create events for '${club.name}' because the club is ${club.status.toLowerCase()}`);
    err.statusCode = 400;
    throw err;
  }

  // 3. Mass-assignment protection & Validation
  const validated = validateEventData(inputData);

  // 4. Database Transaction
  const tx = db.transaction(() => {
    const res = db.prepare(`
      INSERT INTO events (club_id, title, description, venue, event_date, start_time, end_time, capacity, banner_url, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)
    `).run(
      scopeClubId,
      validated.title,
      validated.description,
      validated.venue,
      validated.event_date,
      validated.start_time,
      validated.end_time,
      validated.capacity,
      validated.banner_url || null,
      actorUser.id
    );

    const eventId = res.lastInsertRowid;

    logAudit(actorUser.id, 'EVENT_CREATED', 'events', eventId, {
      title: validated.title,
      clubId: scopeClubId,
      status: 'DRAFT'
    });

    return db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  });

  return tx();
}

/**
 * Update existing event details
 */
function updateEvent(actorUser, eventIdInput, inputData) {
  const eventId = parseInt(eventIdInput, 10);

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT e.*, c.name as club_name, c.status as club_status FROM events e JOIN clubs c ON e.club_id = c.id WHERE e.id = ?').get(eventId);
    if (!existing) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    // Permission check
    if (!hasPermission(actorUser, 'EVENT_EDIT', { clubId: existing.club_id })) {
      const err = new Error('Access Forbidden: Missing EVENT_EDIT permission for this club');
      err.statusCode = 403;
      throw err;
    }

    // Lock checks by status
    if (existing.status === 'PENDING_APPROVAL') {
      const err = new Error('Cannot edit event while in PENDING_APPROVAL status. Withdraw or wait for review.');
      err.statusCode = 400;
      throw err;
    }

    if (['ONGOING', 'COMPLETED', 'CANCELLED'].includes(existing.status)) {
      const err = new Error(`Cannot edit event in ${existing.status} status.`);
      err.statusCode = 400;
      throw err;
    }

    // Mass-assignment protection & Validation
    const validated = validateEventData(inputData);

    // Capacity validation against current registrations
    const currentRegCount = db.prepare('SELECT COUNT(*) as count FROM event_registrations WHERE event_id = ?').get(eventId).count;
    if (validated.capacity < currentRegCount) {
      const err = new Error(`Capacity (${validated.capacity}) cannot be lowered below current registration count (${currentRegCount})`);
      err.statusCode = 400;
      throw err;
    }

    // Material change detection for APPROVED events
    const isMaterialChange = (
      existing.event_date !== validated.event_date ||
      existing.start_time !== validated.start_time ||
      existing.end_time !== validated.end_time ||
      existing.venue !== validated.venue ||
      validated.capacity < existing.capacity
    );

    let newStatus = existing.status;
    if (existing.status === 'APPROVED' && isMaterialChange) {
      newStatus = 'PENDING_APPROVAL';
    }

    // Update database record
    db.prepare(`
      UPDATE events
      SET title = ?, description = ?, venue = ?, event_date = ?, start_time = ?, end_time = ?, capacity = ?, banner_url = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      validated.title,
      validated.description,
      validated.venue,
      validated.event_date,
      validated.start_time,
      validated.end_time,
      validated.capacity,
      validated.banner_url || null,
      newStatus,
      eventId
    );

    if (existing.status === 'APPROVED' && isMaterialChange) {
      // Notify registered students that event is under re-approval
      handleEventCancelledOrReopened(eventId, 'Event details were updated and submitted for re-approval');

      // Notify Faculty Coordinators
      const coordinators = db.prepare('SELECT faculty_user_id FROM club_coordinators WHERE club_id = ?').all(existing.club_id);
      for (const coord of coordinators) {
        createNotification(
          coord.faculty_user_id,
          'Event Submitted for Re-Approval',
          `The approved event '${validated.title}' was edited and requires re-approval.`,
          'EVENT',
          '/faculty/events'
        );
      }

      logAudit(actorUser.id, 'EVENT_REOPENED_TO_PENDING', 'events', eventId, {
        previousStatus: 'APPROVED',
        newStatus: 'PENDING_APPROVAL',
        reason: 'Material edit on APPROVED event'
      });
    } else {
      logAudit(actorUser.id, 'EVENT_UPDATED', 'events', eventId, {
        title: validated.title,
        status: newStatus
      });
    }

    return db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  });

  return tx();
}

/**
 * State Transition Engine: The ONLY code allowed to change events.status
 * @param {Number} eventIdInput - Event ID
 * @param {String} action - Transition action
 * @param {Object} actorUser - Authenticated user object
 * @param {Object} data - Additional metadata (reasons, remarks)
 */
function transition(eventIdInput, actionInput, actorUser, data = {}) {
  const eventId = parseInt(eventIdInput, 10);
  const action = actionInput ? actionInput.toLowerCase().trim() : '';

  const tx = db.transaction(() => {
    // 1. Re-read event inside transaction
    const event = db.prepare('SELECT e.*, c.name as club_name, c.status as club_status FROM events e JOIN clubs c ON e.club_id = c.id WHERE e.id = ?').get(eventId);
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    const fromState = event.status;
    let toState = null;
    let auditAction = '';
    let remark = null;

    // Helper: Verify actor is Faculty Coordinator for event's club
    const isFacultyCoordinator = () => {
      if (actorUser.role !== 'FACULTY') return false;
      const coord = db.prepare('SELECT id FROM club_coordinators WHERE club_id = ? AND faculty_user_id = ?').get(event.club_id, actorUser.id);
      return Boolean(coord);
    };

    switch (action) {
      case 'submit': {
        if (fromState !== 'DRAFT' && fromState !== 'REJECTED') {
          const err = new Error(`Invalid transition: Cannot submit event in ${fromState} status`);
          err.statusCode = 400;
          throw err;
        }

        if (!hasPermission(actorUser, 'EVENT_SUBMIT', { clubId: event.club_id })) {
          const err = new Error('Access Forbidden: Missing EVENT_SUBMIT permission for this club');
          err.statusCode = 403;
          throw err;
        }

        if (event.club_status !== 'ACTIVE') {
          const err = new Error(`Action Denied: Cannot submit events for '${event.club_name}' because the club is ${event.club_status.toLowerCase()}`);
          err.statusCode = 400;
          throw err;
        }

        // Re-run validations at submit time
        validateEventData(event);

        toState = 'PENDING_APPROVAL';
        auditAction = fromState === 'REJECTED' ? 'EVENT_RESUBMITTED' : 'EVENT_SUBMITTED';

        db.prepare('UPDATE events SET status = ?, rejection_remark = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toState, eventId);

        // Notify Faculty Coordinators
        const coords = db.prepare('SELECT faculty_user_id FROM club_coordinators WHERE club_id = ?').all(event.club_id);
        for (const c of coords) {
          createNotification(
            c.faculty_user_id,
            'New Event Proposal Pending Review',
            `Event '${event.title}' by ${event.club_name} was submitted for your approval.`,
            'EVENT',
            '/faculty/events'
          );
        }
        break;
      }

      case 'approve': {
        if (fromState !== 'PENDING_APPROVAL') {
          const err = new Error(`Invalid transition: Cannot approve event in ${fromState} status`);
          err.statusCode = 400;
          throw err;
        }

        if (!isFacultyCoordinator()) {
          const err = new Error('Access Forbidden: Only assigned Faculty Coordinators for this club can approve event proposals');
          err.statusCode = 403;
          throw err;
        }

        // Self-approval protection
        if (event.created_by === actorUser.id) {
          const err = new Error('Action Denied: Event creators cannot approve their own event proposals');
          err.statusCode = 403;
          throw err;
        }

        if (event.club_status !== 'ACTIVE') {
          const err = new Error('Action Denied: Cannot approve event for inactive or archived club');
          err.statusCode = 400;
          throw err;
        }

        toState = 'APPROVED';
        auditAction = 'EVENT_APPROVED';

        db.prepare('UPDATE events SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toState, eventId);

        // Notify Club Admin & Creator
        const ca = db.prepare('SELECT club_admin_id FROM clubs WHERE id = ?').get(event.club_id);
        if (ca && ca.club_admin_id) {
          createNotification(ca.club_admin_id, 'Event Proposal Approved', `Your event '${event.title}' has been APPROVED.`, 'EVENT', '/club/events');
        }
        if (event.created_by !== ca?.club_admin_id) {
          createNotification(event.created_by, 'Event Proposal Approved', `Your event '${event.title}' has been APPROVED.`, 'EVENT', '/club/events');
        }
        break;
      }

      case 'reject': {
        if (fromState !== 'PENDING_APPROVAL') {
          const err = new Error(`Invalid transition: Cannot reject event in ${fromState} status`);
          err.statusCode = 400;
          throw err;
        }

        if (!isFacultyCoordinator()) {
          const err = new Error('Access Forbidden: Only assigned Faculty Coordinators for this club can reject event proposals');
          err.statusCode = 403;
          throw err;
        }

        remark = (data.remark || data.rejection_remark || '').trim();
        if (!remark) {
          const err = new Error('Rejection remark is required');
          err.statusCode = 400;
          throw err;
        }

        toState = 'REJECTED';
        auditAction = 'EVENT_REJECTED';

        db.prepare('UPDATE events SET status = ?, rejection_remark = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toState, remark, eventId);

        const ca = db.prepare('SELECT club_admin_id FROM clubs WHERE id = ?').get(event.club_id);
        if (ca && ca.club_admin_id) {
          createNotification(ca.club_admin_id, 'Event Proposal Rejected', `Your event '${event.title}' was rejected: ${remark}`, 'EVENT', '/club/events');
        }
        if (event.created_by !== ca?.club_admin_id) {
          createNotification(event.created_by, 'Event Proposal Rejected', `Your event '${event.title}' was rejected: ${remark}`, 'EVENT', '/club/events');
        }
        break;
      }

      case 'escalate': {
        if (fromState !== 'PENDING_APPROVAL') {
          const err = new Error(`Invalid transition: Cannot escalate event in ${fromState} status`);
          err.statusCode = 400;
          throw err;
        }

        if (!isFacultyCoordinator()) {
          const err = new Error('Access Forbidden: Only assigned Faculty Coordinators for this club can escalate event proposals');
          err.statusCode = 403;
          throw err;
        }

        const reason = (data.reason || data.escalation_reason || '').trim();
        if (!reason) {
          const err = new Error('Escalation reason is required');
          err.statusCode = 400;
          throw err;
        }

        toState = 'PENDING_APPROVAL'; // Remains pending approval while escalated
        auditAction = 'EVENT_ESCALATED';
        remark = reason;

        db.prepare(`
          UPDATE events
          SET escalated_at = CURRENT_TIMESTAMP, escalated_by = ?, escalation_reason = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(actorUser.id, reason, eventId);

        // Notify Admins
        const admins = db.prepare("SELECT id FROM users WHERE role IN ('SUPER_ADMIN', 'ADMIN') AND is_active = 1").all();
        for (const a of admins) {
          createNotification(a.id, 'Event Proposal Escalated', `Event '${event.title}' by ${event.club_name} was escalated by Faculty Coordinator: ${reason}`, 'EVENT', '/admin/events');
        }
        break;
      }

      case 'escalation-approve': {
        if (fromState !== 'PENDING_APPROVAL' || !event.escalated_at) {
          const err = new Error('Invalid transition: Event is not currently escalated');
          err.statusCode = 400;
          throw err;
        }

        if (actorUser.role !== 'ADMIN' && actorUser.role !== 'SUPER_ADMIN') {
          const err = new Error('Access Forbidden: Only Admin or Super Admin can resolve escalated events');
          err.statusCode = 403;
          throw err;
        }

        if (event.created_by === actorUser.id) {
          const err = new Error('Action Denied: Event creators cannot approve or resolve their own event proposals');
          err.statusCode = 403;
          throw err;
        }

        const reason = (data.reason || data.remark || '').trim();
        if (!reason || reason.length < 3) {
          const err = new Error('Escalation decision reason is required (minimum 3 characters)');
          err.statusCode = 400;
          throw err;
        }

        toState = 'APPROVED';
        auditAction = 'EVENT_ESCALATION_APPROVED';
        remark = reason;

        db.prepare('UPDATE events SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toState, eventId);

        const ca = db.prepare('SELECT club_admin_id FROM clubs WHERE id = ?').get(event.club_id);
        if (ca && ca.club_admin_id) {
          createNotification(ca.club_admin_id, 'Escalated Event Approved', `Escalated event '${event.title}' was APPROVED by Admin.`, 'EVENT', '/club/events');
        }
        if (event.created_by && event.created_by !== ca?.club_admin_id) {
          createNotification(event.created_by, 'Escalated Event Approved', `Escalated event '${event.title}' was APPROVED by Admin.`, 'EVENT', '/club/events');
        }
        break;
      }

      case 'escalation-reject': {
        if (fromState !== 'PENDING_APPROVAL' || !event.escalated_at) {
          const err = new Error('Invalid transition: Event is not currently escalated');
          err.statusCode = 400;
          throw err;
        }

        if (actorUser.role !== 'ADMIN' && actorUser.role !== 'SUPER_ADMIN') {
          const err = new Error('Access Forbidden: Only Admin or Super Admin can resolve escalated events');
          err.statusCode = 403;
          throw err;
        }

        if (event.created_by === actorUser.id) {
          const err = new Error('Action Denied: Event creators cannot reject or resolve their own event proposals');
          err.statusCode = 403;
          throw err;
        }

        remark = (data.remark || data.rejection_remark || data.reason || '').trim();
        if (!remark || remark.length < 3) {
          const err = new Error('Rejection remark is required (minimum 3 characters)');
          err.statusCode = 400;
          throw err;
        }

        toState = 'REJECTED';
        auditAction = 'EVENT_ESCALATION_REJECTED';

        db.prepare('UPDATE events SET status = ?, rejection_remark = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toState, remark, eventId);

        const ca = db.prepare('SELECT club_admin_id FROM clubs WHERE id = ?').get(event.club_id);
        if (ca && ca.club_admin_id) {
          createNotification(ca.club_admin_id, 'Escalated Event Rejected', `Escalated event '${event.title}' was REJECTED by Admin: ${remark}`, 'EVENT', '/club/events');
        }
        if (event.created_by && event.created_by !== ca?.club_admin_id) {
          createNotification(event.created_by, 'Escalated Event Rejected', `Escalated event '${event.title}' was REJECTED by Admin: ${remark}`, 'EVENT', '/club/events');
        }
        break;
      }

      case 'override-approve': {
        if (fromState !== 'PENDING_APPROVAL') {
          const err = new Error(`Invalid transition: Cannot override approve event in ${fromState} status`);
          err.statusCode = 400;
          throw err;
        }

        if (actorUser.role !== 'SUPER_ADMIN') {
          const err = new Error('Access Forbidden: Only Super Admin can override approve events');
          err.statusCode = 403;
          throw err;
        }

        if (event.created_by === actorUser.id) {
          const err = new Error('Action Denied: Event creators cannot override approve their own event proposals');
          err.statusCode = 403;
          throw err;
        }

        const reason = (data.reason || data.remark || '').trim();
        if (!reason || reason.length < 3) {
          const err = new Error('Override approval reason is required (minimum 3 characters)');
          err.statusCode = 400;
          throw err;
        }

        toState = 'APPROVED';
        auditAction = 'EVENT_OVERRIDE_APPROVED';
        remark = reason;

        db.prepare('UPDATE events SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toState, eventId);

        const ca = db.prepare('SELECT club_admin_id FROM clubs WHERE id = ?').get(event.club_id);
        if (ca && ca.club_admin_id) {
          createNotification(ca.club_admin_id, 'Event Approved via Super Admin Override', `Your event '${event.title}' was APPROVED via Super Admin override.`, 'EVENT', '/club/events');
        }
        if (event.created_by && event.created_by !== ca?.club_admin_id) {
          createNotification(event.created_by, 'Event Approved via Super Admin Override', `Your event '${event.title}' was APPROVED via Super Admin override.`, 'EVENT', '/club/events');
        }
        break;
      }

      case 'override-reject': {
        if (fromState !== 'PENDING_APPROVAL') {
          const err = new Error(`Invalid transition: Cannot override reject event in ${fromState} status`);
          err.statusCode = 400;
          throw err;
        }

        if (actorUser.role !== 'SUPER_ADMIN') {
          const err = new Error('Access Forbidden: Only Super Admin can override reject events');
          err.statusCode = 403;
          throw err;
        }

        if (event.created_by === actorUser.id) {
          const err = new Error('Action Denied: Event creators cannot override reject their own event proposals');
          err.statusCode = 403;
          throw err;
        }

        remark = (data.remark || data.rejection_remark || data.reason || '').trim();
        if (!remark || remark.length < 3) {
          const err = new Error('Override rejection remark is required (minimum 3 characters)');
          err.statusCode = 400;
          throw err;
        }

        toState = 'REJECTED';
        auditAction = 'EVENT_OVERRIDE_REJECTED';

        db.prepare('UPDATE events SET status = ?, rejection_remark = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toState, remark, eventId);

        const ca = db.prepare('SELECT club_admin_id FROM clubs WHERE id = ?').get(event.club_id);
        if (ca && ca.club_admin_id) {
          createNotification(ca.club_admin_id, 'Event Rejected via Super Admin Override', `Your event '${event.title}' was REJECTED via Super Admin override: ${remark}`, 'EVENT', '/club/events');
        }
        if (event.created_by && event.created_by !== ca?.club_admin_id) {
          createNotification(event.created_by, 'Event Rejected via Super Admin Override', `Your event '${event.title}' was REJECTED via Super Admin override: ${remark}`, 'EVENT', '/club/events');
        }
        break;
      }

      case 'withdraw': {
        if (fromState !== 'DRAFT' && fromState !== 'PENDING_APPROVAL') {
          const err = new Error(`Invalid transition: Cannot withdraw event in ${fromState} status`);
          err.statusCode = 400;
          throw err;
        }

        const isClubAdmin = actorUser.role === 'CLUB_ADMIN' && db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(event.club_id, actorUser.id);
        const isSuperAdmin = actorUser.role === 'SUPER_ADMIN';

        if (!isClubAdmin && !isFacultyCoordinator() && !isSuperAdmin) {
          const err = new Error('Access Forbidden: Insufficient privileges to withdraw this event');
          err.statusCode = 403;
          throw err;
        }

        const reason = (data.reason || data.cancellation_reason || '').trim();
        if (!reason) {
          const err = new Error('Withdrawal reason is required');
          err.statusCode = 400;
          throw err;
        }

        toState = 'CANCELLED';
        auditAction = 'EVENT_WITHDRAWN';
        remark = reason;

        db.prepare('UPDATE events SET status = ?, cancellation_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toState, reason, eventId);

        handleEventCancelledOrReopened(eventId, reason);
        break;
      }

      case 'cancel': {
        if (fromState !== 'APPROVED' && fromState !== 'ONGOING') {
          const err = new Error(`Invalid transition: Cannot cancel event in ${fromState} status`);
          err.statusCode = 400;
          throw err;
        }

        const isClubAdmin = actorUser.role === 'CLUB_ADMIN' && db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(event.club_id, actorUser.id);
        const isSuperAdmin = actorUser.role === 'SUPER_ADMIN';

        if (!isClubAdmin && !isFacultyCoordinator() && !isSuperAdmin) {
          const err = new Error('Access Forbidden: Insufficient privileges to cancel this event');
          err.statusCode = 403;
          throw err;
        }

        const reason = (data.reason || data.cancellation_reason || '').trim();
        if (!reason) {
          const err = new Error('Cancellation reason is required');
          err.statusCode = 400;
          throw err;
        }

        toState = 'CANCELLED';
        auditAction = 'EVENT_CANCELLED';
        remark = reason;

        db.prepare('UPDATE events SET status = ?, cancellation_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toState, reason, eventId);

        handleEventCancelledOrReopened(eventId, reason);
        break;
      }

      case 'start': {
        if (fromState !== 'APPROVED') {
          const err = new Error(`Invalid transition: Cannot start event in ${fromState} status`);
          err.statusCode = 400;
          throw err;
        }

        // Club Admin ONLY
        const isClubAdmin = actorUser.role === 'CLUB_ADMIN' && db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(event.club_id, actorUser.id);
        if (!isClubAdmin && actorUser.role !== 'SUPER_ADMIN') {
          const err = new Error('Access Forbidden: Only the Club Admin can start an event');
          err.statusCode = 403;
          throw err;
        }

        // Date constraint: event_date MUST be TODAY in Asia/Kolkata
        const { dateStr } = getAsiaKolkataNow();
        if (event.event_date !== dateStr) {
          const err = new Error(`Action Denied: Event can only be started on its scheduled date (${event.event_date}). Current date in Asia/Kolkata is ${dateStr}`);
          err.statusCode = 400;
          throw err;
        }

        toState = 'ONGOING';
        auditAction = 'EVENT_STARTED';

        db.prepare('UPDATE events SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toState, eventId);
        break;
      }

      case 'complete': {
        if (fromState !== 'ONGOING') {
          const err = new Error(`Invalid transition: Cannot complete event in ${fromState} status`);
          err.statusCode = 400;
          throw err;
        }

        const isClubAdmin = actorUser.role === 'CLUB_ADMIN' && db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(event.club_id, actorUser.id);
        if (!isClubAdmin && actorUser.role !== 'SUPER_ADMIN') {
          const err = new Error('Access Forbidden: Only the Club Admin can complete an event');
          err.statusCode = 403;
          throw err;
        }

        toState = 'COMPLETED';
        auditAction = 'EVENT_COMPLETED';

        db.prepare('UPDATE events SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(toState, eventId);

        // Auto-mark registered students with no attendance row as ABSENT in the same transaction
        const unmarkedRegs = db.prepare(`
          SELECT student_user_id FROM event_registrations
          WHERE event_id = ?
            AND student_user_id NOT IN (SELECT student_user_id FROM attendance WHERE event_id = ?)
        `).all(eventId, eventId);

        for (const reg of unmarkedRegs) {
          db.prepare(`
            INSERT INTO attendance (event_id, student_user_id, status, method, marked_by, marked_at)
            VALUES (?, ?, 'ABSENT', 'MANUAL', ?, CURRENT_TIMESTAMP)
          `).run(eventId, reg.student_user_id, actorUser.id);

          logAudit(actorUser.id, 'ATTENDANCE_AUTO_MARKED_ABSENT', 'attendance', eventId, {
            eventId,
            studentUserId: reg.student_user_id,
            reason: 'AUTO_MARK_ON_EVENT_COMPLETION'
          });
        }
        break;
      }

      default:
        const err = new Error(`Unknown transition action '${action}'`);
        err.statusCode = 400;
        throw err;
    }

    logAudit(actorUser.id, auditAction, 'events', eventId, {
      fromState,
      toState,
      remark: remark || null
    });

    return db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  });

  return tx();
}

/**
 * Period impact helper calling timetableService.previewPeriods
 */
function getPeriodImpact(eventLike) {
  if (!eventLike || !eventLike.event_date || !eventLike.start_time || !eventLike.end_time) {
    return { active: false, reason: 'INVALID_EVENT_DATA', periods: [] };
  }
  return timetableService.previewPeriods(eventLike.event_date, eventLike.start_time, eventLike.end_time);
}

/**
 * Finds non-blocking venue conflicts on the same date and overlapping times
 */
function findVenueConflicts(eventInput) {
  const { event_date, venue, start_time, end_time, id } = eventInput;
  if (!event_date || !venue || !start_time || !end_time) return [];

  let query = `
    SELECT id, title, start_time, end_time, venue, status
    FROM events
    WHERE venue = ? COLLATE NOCASE
      AND event_date = ?
      AND status NOT IN ('REJECTED', 'CANCELLED')
      AND (start_time < ? AND end_time > ?)
  `;
  const params = [venue, event_date, end_time, start_time];

  if (id) {
    query += ' AND id != ?';
    params.push(id);
  }

  return db.prepare(query).all(...params);
}

/**
 * List events visible to a student:
 * - ALL APPROVED events
 * - PLUS student's own registered events in ONGOING, COMPLETED, CANCELLED
 */
function listVisibleToStudent(studentUserIdInput, filters = {}) {
  const studentUserId = parseInt(studentUserIdInput, 10);

  const query = `
    SELECT DISTINCT e.*, c.name as club_name, c.logo_url as club_logo_url
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    LEFT JOIN event_registrations er ON e.id = er.event_id AND er.student_user_id = ?
    WHERE e.status = 'APPROVED'
       OR (er.student_user_id = ? AND e.status IN ('ONGOING', 'COMPLETED', 'CANCELLED'))
    ORDER BY e.event_date ASC, e.start_time ASC
  `;

  return db.prepare(query).all(studentUserId, studentUserId);
}

/**
 * Get single event for student enforcing exact visibility rule (returns null if unapproved & unregistered)
 */
function getEventForStudent(eventIdInput, studentUserIdInput) {
  const eventId = parseInt(eventIdInput, 10);
  const studentUserId = parseInt(studentUserIdInput, 10);

  const event = db.prepare(`
    SELECT e.*, c.name as club_name, c.logo_url as club_logo_url,
           (SELECT COUNT(*) FROM event_registrations WHERE event_id = e.id) as current_registrations,
           (SELECT id FROM event_registrations WHERE event_id = e.id AND student_user_id = ?) as user_registration_id
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    WHERE e.id = ?
  `).get(studentUserId, eventId);

  if (!event) return null;

  const isApproved = event.status === 'APPROVED';
  const isRegisteredReadonly = event.user_registration_id && ['ONGOING', 'COMPLETED', 'CANCELLED'].includes(event.status);

  if (!isApproved && !isRegisteredReadonly) {
    return null; // Return null so route responds with 404
  }

  return event;
}

/**
 * Helper to handle notifications & OD auto-closure when event is cancelled or reopened
 */
function handleEventCancelledOrReopened(eventId, reason) {
  const event = db.prepare('SELECT id, title FROM events WHERE id = ?').get(eventId);
  if (!event) return;

  const registrations = db.prepare('SELECT student_user_id FROM event_registrations WHERE event_id = ?').all(eventId);
  for (const reg of registrations) {
    createNotification(
      reg.student_user_id,
      'Event Updated / Cancelled',
      `Event '${event.title}' was cancelled or returned for re-approval: ${reason}`,
      'EVENT',
      '/student/my-registrations'
    );
  }

  // Auto-close pending OD requests
  odService.autoCloseForEvent(eventId, reason);
}

module.exports = {
  eventInputSchema,
  validateEventData,
  createEvent,
  updateEvent,
  transition,
  getPeriodImpact,
  findVenueConflicts,
  listVisibleToStudent,
  getEventForStudent,
  handleEventCancelledOrReopened
};
