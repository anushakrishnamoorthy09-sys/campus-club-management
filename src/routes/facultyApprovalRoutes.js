const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/index');
const { requireRole, requireCoordinatorOf } = require('../middleware/rbac');
const { doubleCsrfProtection, attachCsrfToken } = require('../middleware/csrf');
const eventService = require('../services/eventService');
const odService = require('../services/odService');

const router = express.Router();

const facultyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Time & period formatting helpers for faculty views
 */
function formatTime12h(timeStr) {
  if (!timeStr) return '';
  const [hStr, mStr] = timeStr.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (isNaN(h) || isNaN(m)) return timeStr;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m < 10 ? '0' + m : m} ${ampm}`;
}

function formatPeriodSummary(periods) {
  if (!periods || !Array.isArray(periods) || periods.length === 0) return 'Zero CLASS periods';
  const sorted = [...periods].sort((a, b) => Number(a.period_number) - Number(b.period_number));
  const nums = sorted.map(p => Number(p.period_number));
  const minNum = nums[0];
  const maxNum = nums[nums.length - 1];

  let pStr = '';
  if (nums.length === 1) {
    pStr = `Period ${minNum}`;
  } else if (maxNum - minNum === nums.length - 1) {
    pStr = `Periods ${minNum}-${maxNum}`;
  } else {
    pStr = `Periods ${nums.join(', ')}`;
  }

  const startTime12 = formatTime12h(sorted[0].start_time);
  const endTime12 = formatTime12h(sorted[sorted.length - 1].end_time);

  return `${pStr} (${startTime12} - ${endTime12})`;
}

function formatTotalMinutes(periods) {
  if (!periods || !Array.isArray(periods) || periods.length === 0) return '0 minutes';
  let totalMins = 0;
  periods.forEach(p => {
    if (p.start_time && p.end_time) {
      const [sH, sM] = p.start_time.split(':').map(Number);
      const [eH, eM] = p.end_time.split(':').map(Number);
      totalMins += (eH * 60 + eM) - (sH * 60 + sM);
    }
  });

  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs > 0 && mins > 0) {
    return `${totalMins} mins (${hrs} hr${hrs > 1 ? 's' : ''} ${mins} min${mins > 1 ? 's' : ''})`;
  } else if (hrs > 0) {
    return `${totalMins} mins (${hrs} hr${hrs > 1 ? 's' : ''})`;
  }
  return `${totalMins} minutes`;
}

function formatTimeWaited(createdAtStr) {
  if (!createdAtStr) return '0 mins';
  const created = new Date(createdAtStr);
  const now = new Date();
  const diffMs = Math.max(0, now - created);
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  if (diffHours > 0) return `${diffHours} hr${diffHours > 1 ? 's' : ''} ago`;
  return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
}

/**
 * Resolver for event's clubId for scope guarding
 */
function resolveEventClubId(req) {
  const eventId = req.params.id || req.params.eventId || req.body.eventId;
  if (eventId) {
    const event = db.prepare('SELECT club_id FROM events WHERE id = ?').get(eventId);
    if (event) return event.club_id;
  }
  return req.params.clubId || req.query.clubId || req.body.clubId;
}

// ============================================================================
// 1. GET /faculty/events - Queue of PENDING_APPROVAL events for Coordinated Clubs
// ============================================================================
router.get('/faculty/events', requireRole('FACULTY', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  let coordinatedClubIds = [];
  if (req.user.role === 'FACULTY') {
    const coords = db.prepare('SELECT club_id FROM club_coordinators WHERE faculty_user_id = ?').all(req.user.id);
    coordinatedClubIds = coords.map(c => c.club_id);
  } else {
    const allClubs = db.prepare('SELECT id FROM clubs').all();
    coordinatedClubIds = allClubs.map(c => c.id);
  }

  if (coordinatedClubIds.length === 0) {
    return res.render('faculty/events/index', {
      title: 'Faculty Event Approvals',
      pendingEvents: [],
      decisionHistory: [],
      coordinatedClubs: [],
      error: req.query.error || null,
      success: req.query.success || null
    });
  }

  const placeholders = coordinatedClubIds.map(() => '?').join(',');
  const coordinatedClubs = db.prepare(`SELECT * FROM clubs WHERE id IN (${placeholders})`).all(...coordinatedClubIds);

  const pendingEvents = db.prepare(`
    SELECT e.*, c.name as club_name, c.code as club_code, u.full_name as creator_name, u.email as creator_email, u.role as creator_role
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    JOIN users u ON e.created_by = u.id
    WHERE e.club_id IN (${placeholders}) AND e.status = 'PENDING_APPROVAL'
    ORDER BY e.updated_at ASC
  `).all(...coordinatedClubIds);

  const getClubStats = db.prepare(`
    SELECT 
      SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) as approved_count,
      SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) as rejected_count
    FROM events WHERE club_id = ?
  `);

  pendingEvents.forEach(e => {
    e.periodImpact = eventService.getPeriodImpact(e);
    e.venueConflicts = eventService.findVenueConflicts(e);
    e.clubStats = getClubStats.get(e.club_id) || { approved_count: 0, rejected_count: 0 };
  });

  const decisionLogs = db.prepare(`
    SELECT a.*, u.full_name as actor_name, e.title as event_title, c.name as club_name
    FROM audit_logs a
    JOIN events e ON a.target_id = e.id AND a.target_entity = 'events'
    JOIN clubs c ON e.club_id = c.id
    LEFT JOIN users u ON a.actor_id = u.id
    WHERE e.club_id IN (${placeholders})
      AND a.action IN ('EVENT_APPROVED', 'EVENT_REJECTED', 'EVENT_ESCALATED', 'EVENT_ESCALATION_APPROVED', 'EVENT_ESCALATION_REJECTED', 'EVENT_OVERRIDE_APPROVED', 'EVENT_OVERRIDE_REJECTED')
    ORDER BY a.timestamp DESC
    LIMIT 50
  `).all(...coordinatedClubIds);

  res.render('faculty/events/index', {
    title: 'Faculty Event Approvals Queue',
    pendingEvents,
    decisionHistory: decisionLogs,
    coordinatedClubs,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 2. GET /faculty/events/:id - Event Details & Action Controls
// ============================================================================
router.get('/faculty/events/:id', requireCoordinatorOf(resolveEventClubId), attachCsrfToken, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const event = db.prepare(`
    SELECT e.*, c.name as club_name, c.code as club_code, u.full_name as creator_name, u.email as creator_email, u.role as creator_role
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    JOIN users u ON e.created_by = u.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    return res.status(404).render('404', { title: '404 - Event Not Found' });
  }

  const auditLogs = db.prepare(`
    SELECT a.*, u.full_name as actor_name, u.role as actor_role
    FROM audit_logs a
    LEFT JOIN users u ON a.actor_id = u.id
    WHERE a.target_entity = 'events' AND a.target_id = ?
    ORDER BY a.timestamp ASC, a.id ASC
  `).all(eventId);

  const periodImpact = eventService.getPeriodImpact(event);
  const venueConflicts = eventService.findVenueConflicts(event);

  const clubStats = db.prepare(`
    SELECT 
      SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) as approved_count,
      SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) as rejected_count
    FROM events WHERE club_id = ?
  `).get(event.club_id) || { approved_count: 0, rejected_count: 0 };

  res.render('faculty/events/show', {
    title: `Review Event - ${event.title}`,
    event,
    auditLogs,
    periodImpact,
    venueConflicts,
    clubStats,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 3. POST /faculty/events/:id/action - Perform Approve / Reject / Escalate
// ============================================================================
router.post('/faculty/events/:id/action', requireCoordinatorOf(resolveEventClubId), facultyLimiter, doubleCsrfProtection, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const action = (req.body.action || '').toLowerCase().trim();

  try {
    const updated = eventService.transition(eventId, action, req.user, req.body);
    const actionLabel = action.toUpperCase();

    if (req.accepts('html')) {
      return res.redirect(`/faculty/events?success=${encodeURIComponent(`Event proposal '${updated.title}' updated to ${updated.status} via action ${actionLabel}.`)}`);
    }
    return res.json({ message: `Action ${actionLabel} successful`, event: updated });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/faculty/events/${eventId}?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 4. GET /faculty/od - Faculty Mentee OD Pending Queue & History
// ============================================================================
router.get('/faculty/od', requireRole('FACULTY', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const facultyUserId = req.user.id;
  const activeTab = req.query.tab || 'pending';

  const pendingODs = odService.listPendingForMentor(facultyUserId);
  const decisionHistory = odService.listHistoryForMentor(facultyUserId);

  // Attach student past OD history summary and time waited for pending items
  const getStudentHistory = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) as rejected
    FROM od_requests WHERE student_user_id = ?
  `);

  pendingODs.forEach(od => {
    od.timeWaited = formatTimeWaited(od.created_at);
    od.studentHistory = getStudentHistory.get(od.student_user_id) || { total: 0, approved: 0, rejected: 0 };
  });

  res.render('faculty/od/index', {
    title: 'Mentee On-Duty Approvals',
    pendingODs,
    decisionHistory,
    activeTab,
    formatTime12h,
    formatPeriodSummary,
    formatTotalMinutes,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 5. GET /faculty/od/:id - Faculty OD Review Detail Page (Guarded by Class Mentor Scope)
// ============================================================================
router.get('/faculty/od/:id', requireRole('FACULTY', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const odId = parseInt(req.params.id, 10);
  const facultyUserId = req.user.id;

  // odService.getForMentor returns null if faculty is not assigned class mentor or reviewer!
  const od = odService.getForMentor(odId, facultyUserId);

  if (!od) {
    return res.status(403).render('403', {
      title: '403 - Access Forbidden',
      message: 'Forbidden: Only the assigned class mentor for this student can view or decide this On-Duty request.'
    });
  }

  res.render('faculty/od/show', {
    title: `Review OD #${od.id} - ${od.student_name}`,
    od,
    formatTime12h,
    formatPeriodSummary,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 6. POST /faculty/od/:id/action - Faculty Review Action (Approve / Reject / Escalate)
// ============================================================================
router.post('/faculty/od/:id/action', requireRole('FACULTY', 'SUPER_ADMIN', 'ADMIN'), facultyLimiter, doubleCsrfProtection, (req, res) => {
  const odId = parseInt(req.params.id, 10);
  const action = (req.body.action || '').toLowerCase().trim();
  const remark = req.body.remark || req.body.reason || '';

  try {
    let result;
    if (action === 'approve') {
      result = odService.review(odId, req.user, 'approve', remark);
    } else if (action === 'reject') {
      result = odService.review(odId, req.user, 'reject', remark);
    } else if (action === 'escalate') {
      result = odService.escalate(odId, req.user, remark);
    } else {
      const err = new Error(`Unknown review action '${action}'`);
      err.statusCode = 400;
      throw err;
    }

    const msg = `OD application #${odId} updated via action ${action.toUpperCase()}.`;

    if (req.accepts('html')) {
      return res.redirect(`/faculty/od?success=${encodeURIComponent(msg)}`);
    }
    return res.json({ message: msg, od: result });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/faculty/od/${odId}?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 7. GET /faculty/mentees - Assigned Mentees Roster & Stats
// ============================================================================
router.get('/faculty/mentees', requireRole('FACULTY', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const facultyUserId = req.user.id;

  const mentees = db.prepare(`
    SELECT s.user_id, s.ra_number, s.department, s.year_of_study, s.section,
           u.full_name, u.email,
           (SELECT COUNT(*) FROM event_registrations WHERE student_user_id = s.user_id) as registration_count,
           (SELECT COUNT(*) FROM attendance WHERE student_user_id = s.user_id AND status = 'PRESENT') as attended_count,
           (SELECT COUNT(*) FROM od_requests WHERE student_user_id = s.user_id) as total_ods,
           (SELECT COUNT(*) FROM od_requests WHERE student_user_id = s.user_id AND status = 'PENDING') as pending_ods,
           (SELECT COUNT(*) FROM od_requests WHERE student_user_id = s.user_id AND status = 'APPROVED') as approved_ods,
           (SELECT COUNT(*) FROM od_requests WHERE student_user_id = s.user_id AND status = 'REJECTED') as rejected_ods
    FROM students s
    JOIN users u ON s.user_id = u.id
    WHERE s.class_mentor_id = ?
    ORDER BY s.ra_number ASC
  `).all(facultyUserId);

  mentees.forEach(m => {
    const decided = (m.approved_ods || 0) + (m.rejected_ods || 0);
    m.approval_rate = decided > 0 ? Math.round((m.approved_ods / decided) * 100) : 0;
  });

  res.render('faculty/mentees/index', {
    title: 'Assigned Mentee Roster',
    mentees,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 8. GET /faculty/mentees/:studentUserId - Mentee Profile & Portfolio Drill-Down
// ============================================================================
router.get('/faculty/mentees/:studentUserId', requireRole('FACULTY', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const studentUserId = parseInt(req.params.studentUserId, 10);
  const facultyUserId = req.user.id;

  const mentee = db.prepare(`
    SELECT s.*, u.full_name, u.email
    FROM students s
    JOIN users u ON s.user_id = u.id
    WHERE s.user_id = ?
  `).get(studentUserId);

  if (!mentee) {
    return res.status(404).render('404', { title: '404 - Mentee Not Found' });
  }

  // Scope check: Must be assigned class mentor (or Super Admin/Admin)
  if (req.user.role === 'FACULTY' && Number(mentee.class_mentor_id) !== Number(facultyUserId)) {
    return res.status(403).render('403', {
      title: '403 - Access Forbidden',
      message: 'Forbidden: You can only view detailed drill-down profiles for your own assigned mentees.'
    });
  }

  const registrations = db.prepare(`
    SELECT er.id as registration_id, er.registered_at,
           e.title as event_title, e.event_date, e.start_time, e.end_time, e.venue, e.status as event_status,
           c.name as club_name,
           att.status as attendance_status
    FROM event_registrations er
    JOIN events e ON er.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    LEFT JOIN attendance att ON (att.event_id = e.id AND att.student_user_id = er.student_user_id)
    WHERE er.student_user_id = ?
    ORDER BY e.event_date DESC
  `).all(studentUserId);

  const odRequests = odService.listForStudent(studentUserId);

  const certificates = db.prepare(`
    SELECT c.*, e.title as event_title
    FROM certificates c
    JOIN events e ON c.event_id = e.id
    WHERE c.student_user_id = ?
    ORDER BY c.issued_at DESC
  `).all(studentUserId);

  const badges = db.prepare(`
    SELECT sb.*, b.name as badge_name, b.description
    FROM student_badges sb
    JOIN badges b ON sb.badge_id = b.id
    WHERE sb.student_user_id = ?
    ORDER BY sb.awarded_at DESC
  `).all(studentUserId);

  const attendanceRecords = db.prepare('SELECT * FROM attendance WHERE student_user_id = ?').all(studentUserId);

  const approvedOds = odRequests.filter(o => o.status === 'APPROVED').length;
  const rejectedOds = odRequests.filter(o => o.status === 'REJECTED').length;
  const decided = approvedOds + rejectedOds;
  const approvalRate = decided > 0 ? Math.round((approvedOds / decided) * 100) : 0;

  res.render('faculty/mentees/show', {
    title: `Mentee Profile - ${mentee.full_name}`,
    mentee,
    registrations,
    odRequests,
    certificates,
    badges,
    attendanceRecords,
    approvalRate,
    formatTime12h,
    formatPeriodSummary,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

module.exports = router;
