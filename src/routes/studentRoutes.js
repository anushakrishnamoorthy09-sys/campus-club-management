const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/index');
const { requireRole } = require('../middleware/rbac');
const { doubleCsrfProtection, attachCsrfToken } = require('../middleware/csrf');
const eventService = require('../services/eventService');
const registrationService = require('../services/registrationService');
const timetableService = require('../services/timetableService');
const odService = require('../services/odService');

const router = express.Router();

const studentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Time and period formatting helpers for student views
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

// ============================================================================
// 1. GET /student/events - Browse Approved Campus Events
// ============================================================================
router.get('/student/events', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const studentUserId = req.user.id;
  const search = (req.query.search || '').trim().toLowerCase();
  const selectedClubId = req.query.clubId ? parseInt(req.query.clubId, 10) : null;
  const dateFilter = req.query.date || '';
  const myClubsOnly = req.query.myClubsOnly === 'on' || req.query.myClubsOnly === 'true';

  let rawEvents = eventService.listVisibleToStudent(studentUserId);
  let events = rawEvents.filter(e => e.status === 'APPROVED');

  if (myClubsOnly) {
    const memberships = db.prepare("SELECT club_id FROM club_memberships WHERE user_id = ? AND status = 'APPROVED'").all(studentUserId);
    const myClubIds = new Set(memberships.map(m => m.club_id));
    events = events.filter(e => myClubIds.has(e.club_id));
  }

  if (selectedClubId) {
    events = events.filter(e => e.club_id === selectedClubId);
  }

  if (dateFilter) {
    events = events.filter(e => e.event_date === dateFilter);
  }

  if (search) {
    events = events.filter(e =>
      e.title.toLowerCase().includes(search) ||
      (e.description && e.description.toLowerCase().includes(search)) ||
      (e.venue && e.venue.toLowerCase().includes(search))
    );
  }

  const getRegStats = db.prepare('SELECT COUNT(*) as count FROM event_registrations WHERE event_id = ?');
  const checkUserReg = db.prepare('SELECT id FROM event_registrations WHERE event_id = ? AND student_user_id = ?');

  events.forEach(e => {
    e.registration_count = getRegStats.get(e.id).count;
    e.seats_remaining = Math.max(0, e.capacity - e.registration_count);
    e.is_full = e.seats_remaining === 0;
    e.is_registered = Boolean(checkUserReg.get(e.id, studentUserId));
  });

  const clubs = db.prepare("SELECT id, name, code FROM clubs WHERE status = 'ACTIVE' ORDER BY name ASC").all();

  res.render('student/events/index', {
    title: 'Browse Campus Events',
    events,
    clubs,
    search,
    selectedClubId,
    dateFilter,
    myClubsOnly,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 2. GET /student/events/:id - Event Details & Timetable Impact
// ============================================================================
router.get('/student/events/:id', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const studentUserId = req.user.id;

  const event = eventService.getEventForStudent(eventId, studentUserId);

  if (!event) {
    return res.status(404).render('404', { title: '404 - Event Not Found' });
  }

  const periodImpact = eventService.getPeriodImpact(event);
  const regStats = db.prepare('SELECT COUNT(*) as count FROM event_registrations WHERE event_id = ?').get(eventId).count;
  const seatsRemaining = Math.max(0, event.capacity - regStats);
  const isFull = seatsRemaining === 0;
  const userRegistration = db.prepare('SELECT id FROM event_registrations WHERE event_id = ? AND student_user_id = ?').get(eventId, studentUserId);

  res.render('student/events/show', {
    title: `Event Detail - ${event.title}`,
    event,
    periodImpact,
    regStats,
    seatsRemaining,
    isFull,
    isRegistered: Boolean(userRegistration),
    userRegistrationId: userRegistration ? userRegistration.id : null,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 3. POST /student/events/:id/register - Student Event Registration
// ============================================================================
router.post('/student/events/:id/register', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), studentLimiter, doubleCsrfProtection, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const studentUserId = req.user.id;

  try {
    const regResult = registrationService.register(eventId, studentUserId);
    const msg = `Successfully registered for '${regResult.event_title}'! A confirmation notification has been issued.`;

    if (req.accepts('html')) {
      return res.redirect(`/student/events/${eventId}?success=${encodeURIComponent(msg)}`);
    }
    return res.status(201).json({ message: msg, registration: regResult });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/student/events/${eventId}?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 4. POST /student/events/:id/cancel-registration - Cancel Event Registration
// ============================================================================
router.post('/student/events/:id/cancel-registration', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), studentLimiter, doubleCsrfProtection, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const studentUserId = req.user.id;

  try {
    const cancelResult = registrationService.cancelRegistration(eventId, studentUserId);
    if (req.accepts('html')) {
      return res.redirect(`/student/my-registrations?success=${encodeURIComponent(cancelResult.message)}`);
    }
    return res.json(cancelResult);
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/student/my-registrations?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 5. GET /student/my-registrations & /student/registrations - My Event Registrations Roster
// ============================================================================
const renderMyRegistrations = (req, res) => {
  const studentUserId = req.user.id;

  const registrations = db.prepare(`
    SELECT er.id as registration_id, er.registered_at,
           e.id as event_id, e.title as event_title, e.description, e.event_date, e.start_time, e.end_time, e.venue, e.banner_url, e.status as event_status,
           c.name as club_name, c.code as club_code,
           od.id as od_id, od.status as od_status, od.faculty_remark, od.reviewed_at, od.escalated_at
    FROM event_registrations er
    JOIN events e ON er.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    LEFT JOIN od_requests od ON er.id = od.registration_id AND od.id = (
      SELECT MAX(id) FROM od_requests WHERE registration_id = er.id
    )
    WHERE er.student_user_id = ?
    ORDER BY e.event_date DESC, e.start_time DESC
  `).all(studentUserId);

  res.render('student/events/registrations', {
    title: 'My Event Registrations',
    registrations,
    error: req.query.error || null,
    success: req.query.success || null
  });
};

router.get('/student/my-registrations', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, renderMyRegistrations);
router.get('/student/registrations', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, renderMyRegistrations);

// ============================================================================
// 6. GET /student/od/apply - OD Preview & Period Calculator Page
// ============================================================================
router.get('/student/od/apply', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const studentUserId = req.user.id;
  const registrationId = req.query.registrationId ? parseInt(req.query.registrationId, 10) : null;

  if (!registrationId) {
    if (req.accepts('html')) {
      return res.redirect('/student/registrations?error=' + encodeURIComponent('Registration ID is required to apply for On-Duty (OD).'));
    }
    return res.status(400).json({ error: 'Registration ID is required.' });
  }

  const reg = db.prepare(`
    SELECT er.id as registration_id, er.student_user_id, er.registered_at,
           e.id as event_id, e.title, e.venue, e.event_date, e.start_time, e.end_time, e.status as event_status,
           c.name as club_name, c.code as club_code,
           s.department, s.year_of_study, s.section, s.class_mentor_id, s.ra_number,
           u_mentor.full_name as mentor_name
    FROM event_registrations er
    JOIN events e ON er.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    JOIN students s ON er.student_user_id = s.user_id
    LEFT JOIN users u_mentor ON s.class_mentor_id = u_mentor.id
    WHERE er.id = ?
  `).get(registrationId);

  if (!reg) {
    if (req.accepts('html')) {
      return res.redirect('/student/registrations?error=' + encodeURIComponent('Registration record not found.'));
    }
    return res.status(404).json({ error: 'Registration record not found.' });
  }

  // Security check: Registration must belong to THIS student
  if (Number(reg.student_user_id) !== Number(studentUserId)) {
    if (req.accepts('html')) {
      return res.status(403).render('403', { title: '403 - Access Forbidden', message: 'Forbidden: You can only apply for OD on your own registrations.' });
    }
    return res.status(403).json({ error: 'Forbidden: Registration does not belong to you.' });
  }

  let isBlocked = false;
  let blockReason = null;

  if (!['APPROVED', 'ONGOING'].includes(reg.event_status)) {
    isBlocked = true;
    blockReason = `On-Duty applications are strictly restricted to APPROVED or ONGOING events. Current event status is '${reg.event_status}'.`;
  }

  if (!isBlocked && !reg.class_mentor_id) {
    isBlocked = true;
    blockReason = 'You do not have an assigned Class Mentor in your student profile. Please contact Administration.';
  }

  if (!isBlocked) {
    const existingActive = db.prepare(`
      SELECT id, status FROM od_requests WHERE registration_id = ? AND status IN ('PENDING', 'APPROVED')
    `).get(registrationId);

    if (existingActive) {
      isBlocked = true;
      blockReason = `An active On-Duty application (${existingActive.status}) already exists for this registration. Duplicate open applications are blocked.`;
    }
  }

  let preview = { active: false, reason: 'NOT_CHECKED', periods: [] };
  if (!isBlocked) {
    preview = timetableService.previewPeriods(reg.event_date, reg.start_time, reg.end_time);

    if (!preview.active) {
      isBlocked = true;
      if (preview.reason === 'NO_ACTIVE_STRUCTURE') {
        blockReason = `No active academic timetable structure found for the event date (${reg.event_date}). On-Duty application cannot be processed.`;
      } else if (preview.reason === 'NON_WORKING_DAY') {
        blockReason = `Event date (${reg.event_date}) is a non-working day according to the active timetable. On-Duty is not required or possible.`;
      }
    } else if (preview.reason === 'ONLY_BREAKS' || !preview.periods || preview.periods.length === 0) {
      isBlocked = true;
      blockReason = 'Event overlaps only break intervals or zero academic CLASS periods. No On-Duty is needed or possible.';
    }
  }

  const periodSummary = formatPeriodSummary(preview.periods);
  const totalMinutesFormatted = formatTotalMinutes(preview.periods);

  res.render('student/od/apply', {
    title: `Apply for OD - ${reg.title}`,
    registration: reg,
    event: reg,
    studentProfile: reg,
    mentorName: reg.mentor_name || 'Unassigned Mentor',
    periods: preview.periods,
    periodSummary,
    totalMinutesFormatted,
    isBlocked,
    blockReason,
    formatTime12h,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 7. POST /student/od/request - Submit OD Request
// ============================================================================
router.post('/student/od/request', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), studentLimiter, doubleCsrfProtection, (req, res) => {
  const studentUserId = req.user.id;
  const registrationId = parseInt(req.body.registrationId, 10);

  try {
    const createdOd = odService.request(studentUserId, registrationId);
    const msg = `On-Duty (OD) request #${createdOd.id} for '${createdOd.event_title}' submitted successfully to your Class Mentor (${createdOd.mentor_name}).`;

    if (req.accepts('html')) {
      return res.redirect(`/student/od?success=${encodeURIComponent(msg)}`);
    }
    return res.status(201).json({ message: msg, od: createdOd });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/student/od/apply?registrationId=${registrationId}&error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 8. GET /student/od - My OD Requests Roster
// ============================================================================
router.get('/student/od', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const studentUserId = req.user.id;
  const odRequests = odService.listForStudent(studentUserId);

  res.render('student/od/index', {
    title: 'My On-Duty Applications',
    odRequests,
    formatTime12h,
    formatPeriodSummary,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 9. GET /student/od/:id - OD Request Detail & Timeline (Enforces 404 for other students)
// ============================================================================
router.get('/student/od/:id', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const odId = parseInt(req.params.id, 10);
  const studentUserId = req.user.id;

  const od = odService.getForStudent(odId, studentUserId);

  if (!od) {
    return res.status(404).render('404', { title: '404 - OD Request Not Found' });
  }

  let timetableChanged = false;
  if (od.event_date && od.periods && od.periods.length > 0) {
    const currentActive = timetableService.findActiveStructure(od.event_date);
    if (currentActive && currentActive.timetable.id !== od.periods[0].timetable_id) {
      timetableChanged = true;
    }
  }

  res.render('student/od/show', {
    title: `OD Request #${od.id} - ${od.event_title}`,
    od,
    timetableChanged,
    formatTime12h,
    formatPeriodSummary,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

module.exports = router;
