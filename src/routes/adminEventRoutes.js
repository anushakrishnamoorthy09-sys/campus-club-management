const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/index');
const { requireRole } = require('../middleware/rbac');
const { doubleCsrfProtection, attachCsrfToken } = require('../middleware/csrf');
const eventService = require('../services/eventService');
const odService = require('../services/odService');

const router = express.Router();

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Format relative time elapsed since date
 */
function getRelativeTimeString(dateString) {
  if (!dateString) return 'N/A';
  const past = new Date(dateString);
  const now = new Date();
  const diffMs = Math.max(0, now - past);

  const mins = Math.floor(diffMs / (1000 * 60));
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

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

// ============================================================================
// 1. GET /admin/events - Institution-wide Event Governance & Escalation Queue
// ============================================================================
router.get('/admin/events', requireRole('ADMIN', 'SUPER_ADMIN'), attachCsrfToken, (req, res) => {
  const selectedClubId = req.query.clubId ? parseInt(req.query.clubId, 10) : null;
  const statusFilter = (req.query.status || 'ALL').toUpperCase();
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';

  const clubs = db.prepare('SELECT id, name, code FROM clubs ORDER BY name ASC').all();

  const escalatedEvents = db.prepare(`
    SELECT e.*, c.name as club_name, c.code as club_code, u.full_name as creator_name, u.email as creator_email,
           esc.full_name as escalator_name
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    JOIN users u ON e.created_by = u.id
    LEFT JOIN users esc ON e.escalated_by = esc.id
    WHERE e.status = 'PENDING_APPROVAL' AND e.escalated_at IS NOT NULL
    ORDER BY e.escalated_at ASC
  `).all();

  escalatedEvents.forEach(e => {
    e.periodImpact = eventService.getPeriodImpact(e);
    e.venueConflicts = eventService.findVenueConflicts(e);
    e.waitTime = getRelativeTimeString(e.escalated_at || e.updated_at);
  });

  const pendingOverview = db.prepare(`
    SELECT e.*, c.name as club_name, c.code as club_code, u.full_name as creator_name
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    JOIN users u ON e.created_by = u.id
    WHERE e.status = 'PENDING_APPROVAL'
    ORDER BY e.created_at ASC
  `).all();

  pendingOverview.forEach(e => {
    e.waitTime = getRelativeTimeString(e.created_at || e.updated_at);
  });

  let whereClauses = [];
  let params = [];

  if (selectedClubId) {
    whereClauses.push('e.club_id = ?');
    params.push(selectedClubId);
  }

  if (statusFilter !== 'ALL') {
    whereClauses.push('e.status = ?');
    params.push(statusFilter);
  }

  if (startDate) {
    whereClauses.push('e.event_date >= ?');
    params.push(startDate);
  }

  if (endDate) {
    whereClauses.push('e.event_date <= ?');
    params.push(endDate);
  }

  const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const allEvents = db.prepare(`
    SELECT e.*, c.name as club_name, c.code as club_code, u.full_name as creator_name
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    JOIN users u ON e.created_by = u.id
    ${whereSql}
    ORDER BY e.event_date DESC, e.start_time DESC
  `).all(...params);

  res.render('admin/events/index', {
    title: 'Institutional Event Governance & Approvals',
    clubs,
    escalatedEvents,
    pendingOverview,
    allEvents,
    selectedClubId,
    statusFilter,
    startDate,
    endDate,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 2. GET /admin/events/:id - Event Details & Admin / Super Admin Action Controls
// ============================================================================
router.get('/admin/events/:id', requireRole('ADMIN', 'SUPER_ADMIN'), attachCsrfToken, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const event = db.prepare(`
    SELECT e.*, c.name as club_name, c.code as club_code, u.full_name as creator_name, u.email as creator_email, u.role as creator_role,
           esc.full_name as escalator_name
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    JOIN users u ON e.created_by = u.id
    LEFT JOIN users esc ON e.escalated_by = esc.id
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
  const waitTime = getRelativeTimeString(event.created_at || event.updated_at);

  res.render('admin/events/show', {
    title: `Admin Governance - ${event.title}`,
    event,
    auditLogs,
    periodImpact,
    venueConflicts,
    waitTime,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 3. POST /admin/events/:id/action - Admin & Super Admin Decisions & Overrides
// ============================================================================
router.post('/admin/events/:id/action', requireRole('ADMIN', 'SUPER_ADMIN'), adminLimiter, doubleCsrfProtection, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const action = (req.body.action || '').toLowerCase().trim();

  try {
    const updated = eventService.transition(eventId, action, req.user, req.body);
    const actionLabel = action.toUpperCase();

    if (req.accepts('html')) {
      return res.redirect(`/admin/events?success=${encodeURIComponent(`Admin action ${actionLabel} executed successfully. Event '${updated.title}' is now ${updated.status}.`)}`);
    }
    return res.json({ message: `Action ${actionLabel} executed successfully`, event: updated });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/admin/events/${eventId}?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 4. GET /admin/od - Escalated OD Queue & Global Roster
// ============================================================================
router.get('/admin/od', requireRole('ADMIN', 'SUPER_ADMIN'), attachCsrfToken, (req, res) => {
  const activeTab = req.query.tab || 'escalated';
  const selectedStatus = (req.query.status || '').toUpperCase();
  const searchRa = (req.query.searchRa || '').trim().toUpperCase();
  const dateFilter = req.query.date || '';

  const escalatedQueue = odService.listEscalatedForAdmin();

  // Global OD Explorer with filters
  let whereClauses = [];
  let params = [];

  if (selectedStatus) {
    whereClauses.push('od.status = ?');
    params.push(selectedStatus);
  }

  if (searchRa) {
    whereClauses.push('s.ra_number LIKE ?');
    params.push(`%${searchRa}%`);
  }

  if (dateFilter) {
    whereClauses.push('e.event_date = ?');
    params.push(dateFilter);
  }

  const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const queryGlobal = `
    SELECT od.*,
           er.event_id,
           e.title as event_title, e.venue as event_venue, e.event_date, e.start_time, e.end_time, e.status as event_status,
           c.name as club_name, c.code as club_code,
           s.ra_number, s.department, s.year_of_study, s.section,
           u.full_name as student_name,
           u_mentor.full_name as mentor_name,
           u_rev.full_name as reviewer_name
    FROM od_requests od
    JOIN event_registrations er ON od.registration_id = er.id
    JOIN events e ON er.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    JOIN students s ON od.student_user_id = s.user_id
    JOIN users u ON s.user_id = u.id
    LEFT JOIN users u_mentor ON od.class_mentor_id = u_mentor.id
    LEFT JOIN users u_rev ON od.reviewed_by = u_rev.id
    ${whereSql}
    ORDER BY od.created_at DESC
  `;

  const globalRows = db.prepare(queryGlobal).all(...params);
  const globalODs = globalRows.map(r => ({
    ...r,
    periods: odService.getForAdmin(r.id) ? odService.getForAdmin(r.id).periods : []
  }));

  res.render('admin/od/index', {
    title: 'Institutional On-Duty Governance',
    escalatedQueue,
    globalODs,
    activeTab,
    selectedStatus,
    searchRa,
    dateFilter,
    formatTime12h,
    formatPeriodSummary,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 5. GET /admin/od/:id - Escalated OD Review Detail Page
// ============================================================================
router.get('/admin/od/:id', requireRole('ADMIN', 'SUPER_ADMIN'), attachCsrfToken, (req, res) => {
  const odId = parseInt(req.params.id, 10);
  const od = odService.getForAdmin(odId);

  if (!od) {
    return res.status(404).render('404', { title: '404 - OD Request Not Found' });
  }

  res.render('admin/od/show', {
    title: `Admin OD Governance - OD #${od.id}`,
    od,
    formatTime12h,
    formatPeriodSummary,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 6. POST /admin/od/:id/action - Admin Decision on Escalated OD Request
// ============================================================================
router.post('/admin/od/:id/action', requireRole('ADMIN', 'SUPER_ADMIN'), adminLimiter, doubleCsrfProtection, (req, res) => {
  const odId = parseInt(req.params.id, 10);
  const action = (req.body.action || '').toLowerCase().trim();
  const remark = req.body.remark || req.body.reason || '';

  try {
    const updated = odService.escalationReview(odId, req.user, action, remark);
    const msg = `Escalated OD #${odId} ${updated.status} successfully via Administrative Decision.`;

    if (req.accepts('html')) {
      return res.redirect(`/admin/od?success=${encodeURIComponent(msg)}`);
    }
    return res.json({ message: msg, od: updated });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/admin/od/${odId}?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 7. GET /admin/mentor-reassignment - Class Mentor Reassignment Page
// ============================================================================
router.get('/admin/mentor-reassignment', requireRole('ADMIN', 'SUPER_ADMIN'), attachCsrfToken, (req, res) => {
  const searchRa = (req.query.searchRa || '').trim().toUpperCase();

  let selectedStudent = null;
  let pendingOdsToMove = [];
  let facultyMentors = [];

  if (searchRa) {
    selectedStudent = db.prepare(`
      SELECT s.*, u.full_name as student_name, u.email as student_email,
             m.full_name as mentor_name, f.department as mentor_department
      FROM students s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN users m ON s.class_mentor_id = m.id
      LEFT JOIN faculty f ON s.class_mentor_id = f.user_id
      WHERE s.ra_number = ?
    `).get(searchRa);

    if (selectedStudent) {
      pendingOdsToMove = db.prepare(`
        SELECT od.id, e.title as event_title, e.event_date
        FROM od_requests od
        JOIN event_registrations er ON od.registration_id = er.id
        JOIN events e ON er.event_id = e.id
        WHERE od.student_user_id = ? AND od.status = 'PENDING'
      `).all(selectedStudent.user_id);

      facultyMentors = db.prepare(`
        SELECT f.user_id, u.full_name, f.department, f.designation
        FROM faculty f
        JOIN users u ON f.user_id = u.id
        WHERE u.is_active = 1
        ORDER BY u.full_name ASC
      `).all();
    }
  }

  res.render('admin/mentor_reassignment', {
    title: 'Class Mentor Reassignment',
    searchRa,
    selectedStudent,
    pendingOdsToMove,
    facultyMentors,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 8. POST /admin/mentor-reassignment - Execute Mentor Reassignment
// ============================================================================
router.post('/admin/mentor-reassignment', requireRole('ADMIN', 'SUPER_ADMIN'), adminLimiter, doubleCsrfProtection, (req, res) => {
  const studentUserId = parseInt(req.body.studentUserId, 10);
  const newMentorId = parseInt(req.body.newMentorId, 10);

  try {
    const result = odService.reassignMentor(studentUserId, newMentorId, req.user);
    const msg = `Class mentor reassigned successfully. ${result.pending_ods_moved} pending OD application(s) transferred to the new mentor.`;

    if (req.accepts('html')) {
      return res.redirect(`/admin/mentor-reassignment?success=${encodeURIComponent(msg)}`);
    }
    return res.json({ message: msg, result });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/admin/mentor-reassignment?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

module.exports = router;
