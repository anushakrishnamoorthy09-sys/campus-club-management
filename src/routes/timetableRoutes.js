const express = require('express');
const router = express.Router();
const timetableService = require('../services/timetableService');
const { requireRole } = require('../middleware/rbac');
const db = require('../db/index');

/**
 * GET /admin/timetable - Super Admin Timetable Management Console
 */
router.get('/admin/timetable', requireRole('SUPER_ADMIN'), (req, res) => {
  const timetables = timetableService.getAllTimetables();
  const auditLogs = timetableService.getTimetableAuditLogs();
  
  // Selected timetable for editing if requested via ?edit=ID
  let editTimetable = null;
  if (req.query.edit) {
    editTimetable = timetableService.getTimetableById(Number(req.query.edit));
  }

  res.render('admin/timetable', {
    title: 'Timetable Structure Management - CampusClubOS',
    user: req.user,
    timetables,
    auditLogs,
    editTimetable,
    error: req.flash ? req.flash('error') : null,
    success: req.flash ? req.flash('success') : null,
    warnings: req.flash ? req.flash('warnings') : null
  });
});

/**
 * POST /admin/timetable - Create new timetable structure
 */
router.post('/admin/timetable', requireRole('SUPER_ADMIN'), (req, res) => {
  try {
    const { name, scope, effective_from, working_days, periods_json } = req.body;

    let parsedWorkingDays = [];
    if (Array.isArray(working_days)) {
      parsedWorkingDays = working_days;
    } else if (typeof working_days === 'string') {
      parsedWorkingDays = [working_days];
    }

    let parsedPeriods = [];
    if (typeof periods_json === 'string') {
      try {
        parsedPeriods = JSON.parse(periods_json);
      } catch (e) {
        return res.status(400).render('error', {
          title: '400 Bad Request',
          message: 'Invalid periods JSON payload format.',
          user: req.user
        });
      }
    } else if (Array.isArray(req.body.periods)) {
      parsedPeriods = req.body.periods;
    }

    const result = timetableService.createTimetable({
      name,
      scope,
      effective_from,
      working_days: parsedWorkingDays,
      periods: parsedPeriods
    }, req.user.id);

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(201).json({ success: true, id: result.id, warnings: result.warnings });
    }

    res.redirect('/admin/timetable');
  } catch (err) {
    if (err.validationErrors) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(400).json({ error: err.message, validationErrors: err.validationErrors, warnings: err.warnings });
      }
      return res.status(400).render('admin/timetable', {
        title: 'Timetable Structure Management - CampusClubOS',
        user: req.user,
        timetables: timetableService.getAllTimetables(),
        auditLogs: timetableService.getTimetableAuditLogs(),
        editTimetable: null,
        error: err.validationErrors.join(' | '),
        success: null,
        warnings: err.warnings
      });
    }

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(400).json({ error: err.message });
    }

    res.status(400).render('admin/timetable', {
      title: 'Timetable Structure Management - CampusClubOS',
      user: req.user,
      timetables: timetableService.getAllTimetables(),
      auditLogs: timetableService.getTimetableAuditLogs(),
      editTimetable: null,
      error: err.message,
      success: null,
      warnings: null
    });
  }
});

/**
 * POST /admin/timetable/:id/update - Update timetable structure and periods
 */
router.post('/admin/timetable/:id/update', requireRole('SUPER_ADMIN'), (req, res) => {
  const timetableId = Number(req.params.id);
  try {
    const { name, scope, effective_from, working_days, periods_json } = req.body;

    let parsedWorkingDays = [];
    if (Array.isArray(working_days)) {
      parsedWorkingDays = working_days;
    } else if (typeof working_days === 'string') {
      parsedWorkingDays = [working_days];
    }

    let parsedPeriods = [];
    if (typeof periods_json === 'string') {
      try {
        parsedPeriods = JSON.parse(periods_json);
      } catch (e) {
        return res.status(400).render('error', {
          title: '400 Bad Request',
          message: 'Invalid periods JSON payload format.',
          user: req.user
        });
      }
    } else if (Array.isArray(req.body.periods)) {
      parsedPeriods = req.body.periods;
    }

    const result = timetableService.updateTimetable(timetableId, {
      name,
      scope,
      effective_from,
      working_days: parsedWorkingDays,
      periods: parsedPeriods
    }, req.user.id);

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, id: result.id, warnings: result.warnings });
    }

    res.redirect('/admin/timetable');
  } catch (err) {
    if (err.validationErrors) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(400).json({ error: err.message, validationErrors: err.validationErrors, warnings: err.warnings });
      }
      return res.status(400).render('admin/timetable', {
        title: 'Timetable Structure Management - CampusClubOS',
        user: req.user,
        timetables: timetableService.getAllTimetables(),
        auditLogs: timetableService.getTimetableAuditLogs(),
        editTimetable: timetableService.getTimetableById(timetableId),
        error: err.validationErrors.join(' | '),
        success: null,
        warnings: err.warnings
      });
    }

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(400).json({ error: err.message });
    }

    res.status(400).render('admin/timetable', {
      title: 'Timetable Structure Management - CampusClubOS',
      user: req.user,
      timetables: timetableService.getAllTimetables(),
      auditLogs: timetableService.getTimetableAuditLogs(),
      editTimetable: timetableService.getTimetableById(timetableId),
      error: err.message,
      success: null,
      warnings: null
    });
  }
});

/**
 * POST /admin/timetable/:id/activate - Activate timetable structure
 */
router.post('/admin/timetable/:id/activate', requireRole('SUPER_ADMIN'), (req, res) => {
  const timetableId = Number(req.params.id);
  try {
    const { replaced } = timetableService.activate(timetableId, req.user.id);
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, replaced });
    }
    res.redirect('/admin/timetable');
  } catch (err) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(400).json({ error: err.message, validationErrors: err.validationErrors || [] });
    }
    res.status(400).render('admin/timetable', {
      title: 'Timetable Structure Management - CampusClubOS',
      user: req.user,
      timetables: timetableService.getAllTimetables(),
      auditLogs: timetableService.getTimetableAuditLogs(),
      editTimetable: null,
      error: err.validationErrors ? err.validationErrors.join(' | ') : err.message,
      success: null,
      warnings: null
    });
  }
});

/**
 * POST /admin/timetable/:id/deactivate - Deactivate timetable structure
 */
router.post('/admin/timetable/:id/deactivate', requireRole('SUPER_ADMIN'), (req, res) => {
  const timetableId = Number(req.params.id);
  try {
    timetableService.deactivate(timetableId, req.user.id);
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true });
    }
    res.redirect('/admin/timetable');
  } catch (err) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(400).render('admin/timetable', {
      title: 'Timetable Structure Management - CampusClubOS',
      user: req.user,
      timetables: timetableService.getAllTimetables(),
      auditLogs: timetableService.getTimetableAuditLogs(),
      editTimetable: null,
      error: err.message,
      success: null,
      warnings: null
    });
  }
});

/**
 * POST /admin/timetable/:id/delete - Delete timetable structure (Blocked if OD snapshots exist)
 */
router.post('/admin/timetable/:id/delete', requireRole('SUPER_ADMIN'), (req, res) => {
  const timetableId = Number(req.params.id);
  try {
    timetableService.deleteTimetable(timetableId, req.user.id);
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true });
    }
    res.redirect('/admin/timetable');
  } catch (err) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(400).json({ error: err.message, code: err.code || 'DELETE_FAILED' });
    }
    res.status(400).render('admin/timetable', {
      title: 'Timetable Structure Management - CampusClubOS',
      user: req.user,
      timetables: timetableService.getAllTimetables(),
      auditLogs: timetableService.getTimetableAuditLogs(),
      editTimetable: null,
      error: err.message,
      success: null,
      warnings: null
    });
  }
});

/**
 * GET /timetable/view - Read-only active timetable page for all authenticated users
 */
router.get('/timetable/view', requireRole('SUPER_ADMIN', 'ADMIN', 'CLUB_ADMIN', 'FACULTY', 'STUDENT'), (req, res) => {
  const activeToday = timetableService.findActiveStructure(new Date());
  let timetable = null;

  if (activeToday) {
    timetable = activeToday;
  } else {
    const all = timetableService.getAllTimetables();
    const activeOne = all.find(t => t.is_active === 1);
    if (activeOne) {
      timetable = timetableService.getTimetableById(activeOne.id);
    }
  }

  res.render('timetable/view', {
    title: 'Current Timetable Structure - CampusClubOS',
    user: req.user,
    activeStructure: timetable
  });
});

module.exports = router;
