const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/index');
const { requirePermission } = require('../middleware/rbac');
const { doubleCsrfProtection, attachCsrfToken } = require('../middleware/csrf');
const upload = require('../middleware/upload');
const QRCode = require('qrcode');
const eventService = require('../services/eventService');
const attendanceService = require('../services/attendanceService');
const qrTokenService = require('../services/qrTokenService');
const notificationService = require('../services/notificationService');
const { hasPermission } = require('../services/permissions');

const router = express.Router();

const eventLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Dynamic Scope Resolver for Event Routes
 * Resolves target clubId from event params, request params, query, body, or user membership
 */
function resolveEventClubScope(req) {
  // 1. If event ID is in params, inspect event's club_id
  const eventId = req.params.id || req.params.eventId;
  if (eventId) {
    const event = db.prepare('SELECT club_id FROM events WHERE id = ?').get(eventId);
    if (event) {
      return { clubId: event.club_id };
    }
  }

  // 2. Direct clubId in params, query, or body
  const directClubId = req.params.clubId || req.query.clubId || (req.body && req.body.clubId);
  if (directClubId) {
    return { clubId: parseInt(directClubId, 10) };
  }

  // 3. User authenticated scope fallback
  if (req.user) {
    if (req.user.role === 'CLUB_ADMIN') {
      const club = db.prepare('SELECT id FROM clubs WHERE club_admin_id = ? LIMIT 1').get(req.user.id);
      if (club) return { clubId: club.id };
    }
    const member = db.prepare("SELECT club_id FROM club_memberships WHERE user_id = ? AND status = 'APPROVED' LIMIT 1").get(req.user.id);
    if (member) return { clubId: member.club_id };
  }

  return { clubId: null };
}

/**
 * Resolves user permissions summary for a specific club scope
 */
function getUserClubPermissions(user, clubId) {
  if (!user || !clubId) return { isClubAdmin: false, permissions: [], roleTitle: 'Member' };

  const isSuperAdmin = user.role === 'SUPER_ADMIN';
  const isClubAdmin = (user.role === 'CLUB_ADMIN') && Boolean(db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(clubId, user.id));

  const catalogPerms = ['EVENT_CREATE', 'EVENT_EDIT', 'EVENT_SUBMIT', 'VIEW_REGISTRATIONS'];
  const permissions = [];

  catalogPerms.forEach(p => {
    if (hasPermission(user, p, { clubId })) {
      permissions.push(p);
    }
  });

  let roleTitle = 'Member';
  if (isSuperAdmin) {
    roleTitle = 'Super Admin';
  } else if (isClubAdmin) {
    roleTitle = 'Club Admin';
  } else {
    // Check dynamic role title if assigned
    const memberRole = db.prepare(`
      SELECT cr.role_name
      FROM club_memberships cm
      JOIN club_roles cr ON cm.club_role_id = cr.id
      WHERE cm.user_id = ? AND cm.club_id = ? AND cm.status = 'APPROVED'
    `).get(user.id, clubId);
    if (memberRole && memberRole.role_name) {
      roleTitle = memberRole.role_name;
    }
  }

  return {
    isClubAdmin: isClubAdmin || isSuperAdmin,
    isSuperAdmin,
    permissions,
    roleTitle
  };
}

/**
 * Middleware: Verify user has at least one event permission or is Club Admin for resolved club scope
 */
function requireAnyEventAccess(req, res, next) {
  if (!req.user) {
    if (req.accepts('html') && req.method === 'GET') {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { clubId } = resolveEventClubScope(req);
  if (!clubId) {
    res.status(403);
    if (req.accepts('html')) {
      return res.render('403', { title: '403 - Forbidden' });
    }
    return res.json({ error: 'Access Forbidden: No club associated with user' });
  }

  const permSummary = getUserClubPermissions(req.user, clubId);
  if (permSummary.isClubAdmin || permSummary.permissions.length > 0) {
    req.clubScopeId = clubId;
    req.permSummary = permSummary;
    return next();
  }

  res.status(403);
  if (req.accepts('html')) {
    return res.render('403', { title: '403 - Forbidden' });
  }
  return res.json({ error: 'Access Forbidden: Insufficient event privileges for this club' });
}
requireAnyEventAccess.__guardType = 'requirePermission';
requireAnyEventAccess.__permission = 'EVENT_CREATE';

// ============================================================================
// 1. GET /club/events - List Club Events
// ============================================================================
router.get('/club/events', requireAnyEventAccess, attachCsrfToken, (req, res) => {
  const clubId = req.clubScopeId;
  const club = db.prepare('SELECT id, name, code, logo_url, description FROM clubs WHERE id = ?').get(clubId);
  if (!club) {
    return res.status(404).render('404', { title: '404 - Club Not Found' });
  }

  const statusFilter = (req.query.status || 'ALL').toUpperCase();

  let query = 'SELECT * FROM events WHERE club_id = ?';
  const params = [clubId];

  if (statusFilter !== 'ALL') {
    query += ' AND status = ?';
    params.push(statusFilter);
  }

  query += ' ORDER BY event_date DESC, start_time DESC';
  const events = db.prepare(query).all(...params);

  // Attach registration counts
  const getRegCount = db.prepare('SELECT COUNT(*) as count FROM event_registrations WHERE event_id = ?');
  events.forEach(e => {
    e.registration_count = getRegCount.get(e.id).count;
  });

  res.render('club/events/index', {
    title: `Events - ${club.name}`,
    club,
    events,
    statusFilter,
    userPerms: req.permSummary,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 2. GET /club/events/preview-impact - Live Academic & Venue Conflict Preview
// ============================================================================
router.get('/club/events/preview-impact', requirePermission('EVENT_CREATE', resolveEventClubScope), (req, res) => {
  const { event_date, start_time, end_time, venue, event_id } = req.query;

  if (!event_date || !start_time || !end_time) {
    return res.json({
      impact: { active: false, reason: 'MISSING_PARAMETERS', periods: [] },
      conflicts: []
    });
  }

  const impact = eventService.getPeriodImpact({ event_date, start_time, end_time });
  const conflicts = eventService.findVenueConflicts({
    event_date,
    venue: venue || '',
    start_time,
    end_time,
    id: event_id ? parseInt(event_id, 10) : null
  });

  res.json({ impact, conflicts });
});

// ============================================================================
// 3. GET /club/events/new - Render Create Event Form
// ============================================================================
router.get('/club/events/new', requirePermission('EVENT_CREATE', resolveEventClubScope), attachCsrfToken, (req, res) => {
  const { clubId } = resolveEventClubScope(req);
  const club = db.prepare('SELECT id, name, code FROM clubs WHERE id = ?').get(clubId);

  res.render('club/events/form', {
    title: `Create Event - ${club ? club.name : 'Club'}`,
    club,
    isEdit: false,
    event: {
      title: '',
      description: '',
      venue: '',
      event_date: '',
      start_time: '',
      end_time: '',
      capacity: 50,
      banner_url: ''
    },
    errors: {},
    errorMsg: req.query.error || null
  });
});

// ============================================================================
// 4. POST /club/events/new - Create Event in DRAFT
// ============================================================================
router.post(
  '/club/events/new',
  requirePermission('EVENT_CREATE', resolveEventClubScope),
  eventLimiter,
  upload.single('banner_file'),
  doubleCsrfProtection,
  (req, res) => {
    const { clubId } = resolveEventClubScope(req);
    const bodyData = { ...req.body };

    // If file uploaded via multer, use uploaded path
    if (req.file) {
      bodyData.banner_url = `/uploads/${req.file.filename}`;
    }

    try {
      const createdEvent = eventService.createEvent(req.user, clubId, bodyData);
      if (req.accepts('html')) {
        return res.redirect(`/club/events/${createdEvent.id}?success=${encodeURIComponent('Event created successfully in DRAFT status.')}`);
      }
      return res.status(201).json({ message: 'Event created successfully', event: createdEvent });
    } catch (err) {
      const statusCode = err.statusCode || 400;
      if (req.accepts('html')) {
        const club = db.prepare('SELECT id, name, code FROM clubs WHERE id = ?').get(clubId);
        return res.status(statusCode).render('club/events/form', {
          title: `Create Event - ${club ? club.name : 'Club'}`,
          club,
          isEdit: false,
          event: bodyData,
          errors: err.message ? { general: err.message } : {},
          errorMsg: err.message,
          csrfToken: res.locals.csrfToken
        });
      }
      return res.status(statusCode).json({ error: err.message });
    }
  }
);

// ============================================================================
// 5. GET /club/events/:id - Render Event Detail Page
// ============================================================================
router.get('/club/events/:id', requireAnyEventAccess, attachCsrfToken, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const event = db.prepare(`
    SELECT e.*, c.name as club_name, c.code as club_code
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    return res.status(404).render('404', { title: '404 - Event Not Found' });
  }

  // Audit Logs Timeline
  const auditLogs = db.prepare(`
    SELECT a.*, u.full_name as actor_name, u.role as actor_role
    FROM audit_logs a
    LEFT JOIN users u ON a.actor_id = u.id
    WHERE a.target_entity = 'events' AND a.target_id = ?
    ORDER BY a.timestamp ASC, a.id ASC
  `).all(eventId);

  // Registration count
  const regCount = db.prepare('SELECT COUNT(*) as count FROM event_registrations WHERE event_id = ?').get(eventId).count;

  // Read-only Period Impact preview
  const impact = eventService.getPeriodImpact(event);

  // User permission scope for this event's club
  const userPerms = getUserClubPermissions(req.user, event.club_id);

  res.render('club/events/show', {
    title: `Event Detail - ${event.title}`,
    event,
    auditLogs,
    regCount,
    impact,
    userPerms,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 6. GET /club/events/:id/edit - Render Edit Event Form
// ============================================================================
router.get('/club/events/:id/edit', requirePermission('EVENT_EDIT', resolveEventClubScope), attachCsrfToken, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const event = db.prepare(`
    SELECT e.*, c.name as club_name, c.code as club_code
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    return res.status(404).render('404', { title: '404 - Event Not Found' });
  }

  // Lock checks
  if (event.status === 'PENDING_APPROVAL') {
    return res.status(400).render('error', {
      title: 'Event Locked',
      message: 'Cannot edit event while in PENDING_APPROVAL status. Withdraw or wait for review.'
    });
  }

  if (['ONGOING', 'COMPLETED', 'CANCELLED'].includes(event.status)) {
    return res.status(400).render('error', {
      title: 'Editing Disabled',
      message: `Cannot edit event in ${event.status} status.`
    });
  }

  const club = { id: event.club_id, name: event.club_name, code: event.club_code };

  res.render('club/events/form', {
    title: `Edit Event - ${event.title}`,
    club,
    isEdit: true,
    event,
    errors: {},
    errorMsg: req.query.error || null
  });
});

// ============================================================================
// 7. POST /club/events/:id/edit - Update Event
// ============================================================================
router.post(
  '/club/events/:id/edit',
  requirePermission('EVENT_EDIT', resolveEventClubScope),
  eventLimiter,
  upload.single('banner_file'),
  doubleCsrfProtection,
  (req, res) => {
    const eventId = parseInt(req.params.id, 10);
    const bodyData = { ...req.body };

    if (req.file) {
      bodyData.banner_url = `/uploads/${req.file.filename}`;
    }

    try {
      const updated = eventService.updateEvent(req.user, eventId, bodyData);
      if (req.accepts('html')) {
        const statusMsg = updated.status === 'PENDING_APPROVAL'
          ? 'Event edited and re-submitted for approval due to material schedule/capacity changes.'
          : 'Event updated successfully.';
        return res.redirect(`/club/events/${eventId}?success=${encodeURIComponent(statusMsg)}`);
      }
      return res.json({ message: 'Event updated successfully', event: updated });
    } catch (err) {
      const statusCode = err.statusCode || 400;
      if (req.accepts('html')) {
        const existing = db.prepare('SELECT e.*, c.name as club_name, c.code as club_code FROM events e JOIN clubs c ON e.club_id = c.id WHERE e.id = ?').get(eventId);
        const club = existing ? { id: existing.club_id, name: existing.club_name, code: existing.club_code } : null;

        return res.status(statusCode).render('club/events/form', {
          title: `Edit Event - ${bodyData.title || 'Event'}`,
          club,
          isEdit: true,
          event: { ...existing, ...bodyData, id: eventId },
          errors: err.message ? { general: err.message } : {},
          errorMsg: err.message,
          csrfToken: res.locals.csrfToken
        });
      }
      return res.status(statusCode).json({ error: err.message });
    }
  }
);

// ============================================================================
// 8. POST /club/events/:id/transition - Perform Event State Transition
// ============================================================================
function transitionGuard(req, res, next) {
  const eventId = parseInt(req.params.id, 10);
  const action = (req.body.action || '').toLowerCase().trim();

  // Enforce route-level authorization guards based on requested action
  const scope = resolveEventClubScope(req);
  if (['submit', 'withdraw', 'resubmit'].includes(action)) {
    if (!hasPermission(req.user, 'EVENT_SUBMIT', scope)) {
      res.status(403);
      if (req.accepts('html')) {
        return res.redirect(`/club/events/${eventId}?error=${encodeURIComponent('Access Forbidden: Missing EVENT_SUBMIT permission')}`);
      }
      return res.json({ error: 'Access Forbidden: Missing EVENT_SUBMIT permission' });
    }
  } else if (['start', 'complete', 'cancel'].includes(action)) {
    const isClubAdmin = (req.user.role === 'CLUB_ADMIN') && Boolean(db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(scope.clubId, req.user.id));
    const isSuperAdmin = req.user.role === 'SUPER_ADMIN';

    if (!isClubAdmin && !isSuperAdmin) {
      res.status(403);
      if (req.accepts('html')) {
        return res.redirect(`/club/events/${eventId}?error=${encodeURIComponent(`Access Forbidden: Only the Club Admin can perform '${action}'`)}`);
      }
      return res.json({ error: `Access Forbidden: Only the Club Admin can perform '${action}'` });
    }
  }
  next();
}
transitionGuard.__guardType = 'requirePermission';
transitionGuard.__permission = 'EVENT_SUBMIT';

router.post('/club/events/:id/transition', transitionGuard, eventLimiter, doubleCsrfProtection, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const action = (req.body.action || '').toLowerCase().trim();

  try {
    const updatedEvent = eventService.transition(eventId, action, req.user, req.body);
    const actionLabel = action.toUpperCase();

    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}?success=${encodeURIComponent(`Event status updated to ${updatedEvent.status} via action '${actionLabel}'.`)}`);
    }
    return res.json({ message: `Transition '${actionLabel}' successful`, event: updatedEvent });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 9. GET /club/events/:id/registrations - Registered Students List
// ============================================================================
router.get('/club/events/:id/registrations', requirePermission('VIEW_REGISTRATIONS', resolveEventClubScope), attachCsrfToken, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const event = db.prepare(`
    SELECT e.*, c.name as club_name, c.code as club_code
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    return res.status(404).render('404', { title: '404 - Event Not Found' });
  }

  const registrations = db.prepare(`
    SELECT er.id as registration_id, er.registered_at, s.ra_number, s.department, u.full_name as student_name, u.email
    FROM event_registrations er
    JOIN students s ON er.student_user_id = s.user_id
    JOIN users u ON s.user_id = u.id
    WHERE er.event_id = ?
    ORDER BY er.registered_at ASC
  `).all(eventId);

  res.render('club/events/registrations', {
    title: `Registrations - ${event.title}`,
    event,
    registrations,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 10. GET /club/events/:id/attendance - Attendance Roster & Control Page
// ============================================================================
router.get('/club/events/:id/attendance', requirePermission('MARK_ATTENDANCE', resolveEventClubScope), attachCsrfToken, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  try {
    const data = attendanceService.getEventAttendanceRoster(eventId, req.user);
    res.render('club/events/attendance', {
      title: `Attendance - ${data.event.title}`,
      event: data.event,
      roster: data.roster,
      summary: data.summary,
      isEditable: data.isEditable,
      userPerms: req.permSummary,
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (statusCode === 404) {
      return res.status(404).render('404', { title: '404 - Event Not Found' });
    }
    return res.status(statusCode).render('error', { title: 'Attendance Access Error', message: err.message });
  }
});

// ============================================================================
// 11. POST /club/events/:id/attendance/mark - Mark/Toggle Single Student Attendance
// ============================================================================
router.post('/club/events/:id/attendance/mark', requirePermission('MARK_ATTENDANCE', resolveEventClubScope), eventLimiter, doubleCsrfProtection, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const { studentUserId, status } = req.body;

  try {
    const record = attendanceService.markAttendance(eventId, studentUserId, status, req.user);
    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}/attendance?success=${encodeURIComponent('Attendance status updated successfully.')}`);
    }
    return res.json({ message: 'Attendance updated successfully', record });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}/attendance?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 12. POST /club/events/:id/attendance/mark-all-present - Mark All Registered Students Present
// ============================================================================
router.post('/club/events/:id/attendance/mark-all-present', requirePermission('MARK_ATTENDANCE', resolveEventClubScope), eventLimiter, doubleCsrfProtection, (req, res) => {
  const eventId = parseInt(req.params.id, 10);

  try {
    const records = attendanceService.markAllPresent(eventId, req.user);
    const msg = `Successfully marked all ${records.length} registered students as PRESENT.`;
    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}/attendance?success=${encodeURIComponent(msg)}`);
    }
    return res.json({ message: msg, count: records.length });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}/attendance?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// Rate limiter for student check-in endpoint (20 scans per minute)
const checkinLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many check-in attempts. Please try again in a minute.' }
});

// ============================================================================
// 13. GET /club/events/:id/checkin - Render Live QR Attendance Presentation View
// ============================================================================
router.get('/club/events/:id/checkin', requirePermission('MARK_ATTENDANCE', resolveEventClubScope), attachCsrfToken, async (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const event = db.prepare(`
    SELECT e.*, c.name as club_name
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    return res.status(404).render('404', { title: '404 - Event Not Found' });
  }

  if (event.status !== 'ONGOING') {
    return res.status(400).render('error', {
      title: 'QR Check-in Unavailable',
      message: `QR Attendance Check-in is only active while the event is ONGOING. Current status is '${event.status}'.`
    });
  }

  const token = qrTokenService.generateToken(eventId);
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const checkinUrl = `${baseUrl}/checkin?t=${token}`;
  
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(checkinUrl, { width: 360, margin: 2 });
  } catch (err) {
    console.error('QR Code Generation Error:', err);
  }

  const totalRegistered = db.prepare('SELECT COUNT(*) as count FROM event_registrations WHERE event_id = ?').get(eventId).count;
  const presentCount = db.prepare("SELECT COUNT(*) as count FROM attendance WHERE event_id = ? AND status = 'PRESENT'").get(eventId).count;
  const recentCheckins = db.prepare(`
    SELECT att.marked_at, att.method, u.full_name as student_name, s.ra_number, s.department
    FROM attendance att
    JOIN students s ON att.student_user_id = s.user_id
    JOIN users u ON s.user_id = u.id
    WHERE att.event_id = ? AND att.status = 'PRESENT'
    ORDER BY att.marked_at DESC
    LIMIT 10
  `).all(eventId);

  res.render('club/events/checkin', {
    title: `Live QR Check-in - ${event.title}`,
    event,
    token,
    checkinUrl,
    qrDataUrl,
    summary: { totalRegistered, presentCount },
    recentCheckins,
    userPerms: req.permSummary
  });
});

// ============================================================================
// 14. GET /club/events/:id/checkin/qr - Live Polling API for QR & Check-in Roster
// ============================================================================
router.get('/club/events/:id/checkin/qr', requirePermission('MARK_ATTENDANCE', resolveEventClubScope), async (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const event = db.prepare('SELECT id, title, status FROM events WHERE id = ?').get(eventId);

  if (!event || event.status !== 'ONGOING') {
    return res.status(400).json({ error: 'Event is not ongoing', status: event ? event.status : 'NOT_FOUND' });
  }

  const token = qrTokenService.generateToken(eventId);
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const checkinUrl = `${baseUrl}/checkin?t=${token}`;

  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(checkinUrl, { width: 360, margin: 2 });
  } catch (err) {
    console.error('QR Code Generation API Error:', err);
  }

  const totalRegistered = db.prepare('SELECT COUNT(*) as count FROM event_registrations WHERE event_id = ?').get(eventId).count;
  const presentCount = db.prepare("SELECT COUNT(*) as count FROM attendance WHERE event_id = ? AND status = 'PRESENT'").get(eventId).count;
  const recentCheckins = db.prepare(`
    SELECT att.marked_at, att.method, u.full_name as student_name, s.ra_number, s.department
    FROM attendance att
    JOIN students s ON att.student_user_id = s.user_id
    JOIN users u ON s.user_id = u.id
    WHERE att.event_id = ? AND att.status = 'PRESENT'
    ORDER BY att.marked_at DESC
    LIMIT 10
  `).all(eventId);

  res.json({
    token,
    checkinUrl,
    qrDataUrl,
    summary: { totalRegistered, presentCount },
    recentCheckins
  });
});

// ============================================================================
// 15. GET /checkin - Student QR Code Scanning Endpoint
// ============================================================================
router.get('/checkin', checkinLimiter, (req, res) => {
  const token = (req.query.t || '').toString().trim();

  // 1. Login Requirement Check & Safe Return URL
  if (!req.user) {
    const returnTo = req.originalUrl || `/checkin?t=${encodeURIComponent(token)}`;
    if (req.accepts('html')) {
      return res.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    return res.status(401).json({ error: 'Authentication required. Please log in as a student.' });
  }

  // 2. Role Constraint Check (Must be STUDENT)
  if (req.user.role !== 'STUDENT') {
    attendanceService.logAudit(req.user.id, 'ATTENDANCE_QR_FAILED', 'events', null, {
      reason: 'NON_STUDENT_ROLE',
      userRole: req.user.role,
      token
    });
    const msg = 'Check-in Failed: Only student accounts can check in to events via QR code.';
    if (req.accepts('html')) {
      return res.status(403).render('error', { title: 'Check-in Denied', message: msg });
    }
    return res.status(403).json({ error: msg });
  }

  // 3. Token Signature & Time Window Verification
  const verification = qrTokenService.verifyToken(token);
  if (!verification.valid) {
    attendanceService.logAudit(req.user.id, 'ATTENDANCE_QR_FAILED', 'events', null, {
      reason: verification.reason,
      token
    });
    const msg = `Check-in Failed: ${verification.reason}. Screenshots of old QR codes expire after 60 seconds. Please scan the live QR code on screen.`;
    if (req.accepts('html')) {
      return res.status(400).render('error', { title: 'Check-in Failed', message: msg });
    }
    return res.status(400).json({ error: msg });
  }

  const eventId = verification.eventId;

  // 4. Fetch Event & Verify ONGOING Status
  const event = db.prepare(`
    SELECT e.*, c.name as club_name
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    attendanceService.logAudit(req.user.id, 'ATTENDANCE_QR_FAILED', 'events', eventId, {
      reason: 'EVENT_NOT_FOUND',
      token
    });
    const msg = 'Check-in Failed: Wrong event. The event specified in the QR code does not exist.';
    if (req.accepts('html')) {
      return res.status(404).render('404', { title: '404 - Event Not Found', message: msg });
    }
    return res.status(404).json({ error: msg });
  }

  if (event.status !== 'ONGOING') {
    attendanceService.logAudit(req.user.id, 'ATTENDANCE_QR_FAILED', 'events', eventId, {
      reason: 'EVENT_NOT_ONGOING',
      eventStatus: event.status
    });
    const msg = `Check-in Failed: Event is not currently ONGOING. Attendance can only be marked while event is active (Current status: '${event.status}').`;
    if (req.accepts('html')) {
      return res.status(400).render('error', { title: 'Check-in Failed', message: msg });
    }
    return res.status(400).json({ error: msg });
  }

  // 5. Verify Student Registration for Event
  const reg = db.prepare('SELECT id FROM event_registrations WHERE event_id = ? AND student_user_id = ?').get(eventId, req.user.id);
  if (!reg) {
    attendanceService.logAudit(req.user.id, 'ATTENDANCE_QR_FAILED', 'events', eventId, {
      reason: 'NOT_REGISTERED',
      studentUserId: req.user.id
    });
    const msg = `Check-in Failed: You are not registered for '${event.title}'. Only registered attendees can check in.`;
    if (req.accepts('html')) {
      return res.status(400).render('error', { title: 'Check-in Failed', message: msg });
    }
    return res.status(400).json({ error: msg });
  }

  // 6. Mark Attendance as PRESENT via attendanceService (method = 'QR', Idempotent)
  const attRecord = attendanceService.markAttendance(eventId, req.user.id, 'PRESENT', req.user, 'QR');

  // 7. Dispatch Student Notification
  notificationService.createNotification(
    req.user.id,
    'Attendance Checked In',
    `You have successfully checked in for '${event.title}' via QR code.`,
    'EVENT',
    `/student/events/${eventId}`
  );

  if (req.accepts('html')) {
    return res.render('student/checkin_success', {
      title: `Checked In - ${event.title}`,
      event,
      student: req.user,
      attRecord
    });
  }

  return res.json({ message: 'Attendance checked in successfully', event, attRecord });
});

module.exports = router;
