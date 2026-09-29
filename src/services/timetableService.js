const db = require('../db/index');

/**
 * Calculates period duration in minutes from HH:MM start and end times.
 * Never stored in database or typed by user.
 */
function durationMinutes(period) {
  if (!period || !period.start_time || !period.end_time) return 0;
  const [startH, startM] = period.start_time.split(':').map(Number);
  const [endH, endM] = period.end_time.split(':').map(Number);
  if (isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM)) return 0;
  
  const startTotalMinutes = startH * 60 + startM;
  const endTotalMinutes = endH * 60 + endM;
  return endTotalMinutes - startTotalMinutes;
}

/**
 * Validates a list of period objects.
 * Sorts by start_time.
 * Returns { errors: string[], warnings: string[], sortedPeriods: Array }
 */
function validatePeriods(periods = []) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(periods) || periods.length === 0) {
    errors.push('At least one timetable period is required.');
    return { errors, warnings, sortedPeriods: [] };
  }

  const timeRegex = /^[0-2][0-9]:[0-5][0-9]$/;

  // Check individual field rules
  const periodNums = new Set();
  periods.forEach((p, idx) => {
    const pNum = Number(p.period_number);
    if (!p.period_number || isNaN(pNum) || pNum <= 0) {
      errors.push(`Period #${idx + 1}: Invalid or missing period number.`);
    } else if (periodNums.has(pNum)) {
      errors.push(`Duplicate period number #${pNum} found.`);
    } else {
      periodNums.add(pNum);
    }

    if (!p.label || typeof p.label !== 'string' || !p.label.trim()) {
      errors.push(`Period #${pNum || idx + 1}: Label is required.`);
    }

    if (!p.type || !['CLASS', 'SHORT_BREAK', 'LUNCH_BREAK'].includes(p.type)) {
      errors.push(`Period #${pNum || idx + 1}: Invalid type '${p.type}'. Must be CLASS, SHORT_BREAK, or LUNCH_BREAK.`);
    }

    if (!p.start_time || !timeRegex.test(p.start_time)) {
      errors.push(`Period #${pNum || idx + 1}: Start time '${p.start_time}' is invalid. Must be in HH:MM format.`);
    }
    if (!p.end_time || !timeRegex.test(p.end_time)) {
      errors.push(`Period #${pNum || idx + 1}: End time '${p.end_time}' is invalid. Must be in HH:MM format.`);
    }

    if (timeRegex.test(p.start_time || '') && timeRegex.test(p.end_time || '')) {
      const dur = durationMinutes(p);
      if (dur <= 0) {
        errors.push(`Period #${pNum || idx + 1} (${p.label || 'Unlabeled'}): End time (${p.end_time}) must be after start time (${p.start_time}). Duration cannot be 0 or negative.`);
      }
    }
  });

  if (errors.length > 0) {
    return { errors, warnings, sortedPeriods: [] };
  }

  // Sort periods by start_time ascending
  const sortedPeriods = [...periods].sort((a, b) => a.start_time.localeCompare(b.start_time));

  // Check out-of-order numbering relative to start times
  for (let i = 1; i < sortedPeriods.length; i++) {
    const prevNum = Number(sortedPeriods[i - 1].period_number);
    const currNum = Number(sortedPeriods[i].period_number);
    if (currNum < prevNum) {
      errors.push(`Out-of-order numbering: Period #${currNum} starting at ${sortedPeriods[i].start_time} is numbered lower than Period #${prevNum} starting at ${sortedPeriods[i - 1].start_time}.`);
    }
  }

  // Check overlaps & gaps
  for (let i = 1; i < sortedPeriods.length; i++) {
    const prev = sortedPeriods[i - 1];
    const curr = sortedPeriods[i];

    // Overlap: curr.start_time < prev.end_time
    if (curr.start_time < prev.end_time) {
      errors.push(`Overlapping periods: '${prev.label}' (${prev.start_time}-${prev.end_time}) overlaps with '${curr.label}' (${curr.start_time}-${curr.end_time}).`);
    }

    // Gap: curr.start_time > prev.end_time
    if (curr.start_time > prev.end_time) {
      const gapMins = durationMinutes({ start_time: prev.end_time, end_time: curr.start_time });
      warnings.push(`Unscheduled ${gapMins}-minute gap between '${prev.label}' (ends ${prev.end_time}) and '${curr.label}' (starts ${curr.start_time}).`);
    }
  }

  return { errors, warnings, sortedPeriods };
}

/**
 * Returns all timetable structures with active status and period counts.
 */
function getAllTimetables() {
  const timetables = db.prepare(`
    SELECT t.*, u.full_name as creator_name,
      (SELECT COUNT(*) FROM timetable_periods WHERE timetable_id = t.id) as period_count
    FROM timetables t
    LEFT JOIN users u ON t.created_by = u.id
    ORDER BY t.is_active DESC, t.effective_from DESC, t.id DESC
  `).all();

  const getWorkingDays = db.prepare(`
    SELECT day_of_week, is_active FROM timetable_working_days WHERE timetable_id = ?
  `);

  return timetables.map(tt => {
    const days = getWorkingDays.all(tt.id);
    return {
      ...tt,
      working_days: days
    };
  });
}

/**
 * Fetches a single timetable with full details and sorted periods.
 */
function getTimetableById(id) {
  const timetable = db.prepare(`
    SELECT t.*, u.full_name as creator_name
    FROM timetables t
    LEFT JOIN users u ON t.created_by = u.id
    WHERE t.id = ?
  `).get(id);

  if (!timetable) return null;

  const workingDays = db.prepare(`
    SELECT day_of_week, is_active FROM timetable_working_days WHERE timetable_id = ?
  `).all(id);

  const periods = db.prepare(`
    SELECT * FROM timetable_periods WHERE timetable_id = ? ORDER BY start_time ASC
  `).all(id).map(p => ({
    ...p,
    duration_minutes: durationMinutes(p)
  }));

  return {
    ...timetable,
    working_days: workingDays,
    periods
  };
}

/**
 * Creates a new timetable structure with periods and working days.
 */
function createTimetable({ name, scope, effective_from, working_days = [], periods = [] }, actorUserId) {
  if (!name || !name.trim()) throw new Error('Timetable name is required.');
  if (!scope || !scope.trim()) throw new Error('Timetable scope is required.');
  if (!effective_from) throw new Error('Effective from date is required.');

  const validation = validatePeriods(periods);
  if (validation.errors.length > 0) {
    const err = new Error('Timetable period validation failed.');
    err.validationErrors = validation.errors;
    err.warnings = validation.warnings;
    throw err;
  }

  const validDays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
  const formattedWorkingDays = working_days
    .map(d => String(d).toUpperCase())
    .filter(d => validDays.includes(d));

  if (formattedWorkingDays.length === 0) {
    throw new Error('At least one valid working day (MONDAY-SUNDAY) must be selected.');
  }

  const insertTx = db.transaction(() => {
    const ttRes = db.prepare(`
      INSERT INTO timetables (name, scope, effective_from, is_active, created_by)
      VALUES (?, ?, ?, 0, ?)
    `).run(name.trim(), scope.trim(), effective_from, actorUserId);
    const timetableId = ttRes.lastInsertRowid;

    const stmtDay = db.prepare(`
      INSERT INTO timetable_working_days (timetable_id, day_of_week, is_active)
      VALUES (?, ?, 0)
    `);
    formattedWorkingDays.forEach(day => {
      stmtDay.run(timetableId, day);
    });

    const stmtPeriod = db.prepare(`
      INSERT INTO timetable_periods (timetable_id, period_number, label, start_time, end_time, type)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    validation.sortedPeriods.forEach(p => {
      stmtPeriod.run(timetableId, Number(p.period_number), p.label.trim(), p.start_time, p.end_time, p.type);
    });

    db.prepare(`
      INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
      VALUES (?, 'TIMETABLE_CREATED', 'TIMETABLE', ?, ?)
    `).run(actorUserId, timetableId, JSON.stringify({ name, scope, effective_from, workingDays: formattedWorkingDays, periodCount: validation.sortedPeriods.length }));

    return timetableId;
  });

  const createdId = insertTx();
  return { id: createdId, warnings: validation.warnings };
}

/**
 * Updates an existing timetable structure and re-runs period validation.
 */
function updateTimetable(timetableId, { name, scope, effective_from, working_days = [], periods = [] }, actorUserId) {
  const existing = getTimetableById(timetableId);
  if (!existing) throw new Error(`Timetable ID #${timetableId} not found.`);

  if (!name || !name.trim()) throw new Error('Timetable name is required.');
  if (!scope || !scope.trim()) throw new Error('Timetable scope is required.');
  if (!effective_from) throw new Error('Effective from date is required.');

  const validation = validatePeriods(periods);
  if (validation.errors.length > 0) {
    const err = new Error('Timetable period validation failed.');
    err.validationErrors = validation.errors;
    err.warnings = validation.warnings;
    throw err;
  }

  const validDays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
  const formattedWorkingDays = working_days
    .map(d => String(d).toUpperCase())
    .filter(d => validDays.includes(d));

  if (formattedWorkingDays.length === 0) {
    throw new Error('At least one valid working day (MONDAY-SUNDAY) must be selected.');
  }

  const updateTx = db.transaction(() => {
    db.prepare(`
      UPDATE timetables
      SET name = ?, scope = ?, effective_from = ?
      WHERE id = ?
    `).run(name.trim(), scope.trim(), effective_from, timetableId);

    // Replace working days
    db.prepare('DELETE FROM timetable_working_days WHERE timetable_id = ?').run(timetableId);
    const stmtDay = db.prepare(`
      INSERT INTO timetable_working_days (timetable_id, day_of_week, is_active)
      VALUES (?, ?, ?)
    `);
    formattedWorkingDays.forEach(day => {
      stmtDay.run(timetableId, day, existing.is_active ? 1 : 0);
    });

    // Replace periods
    db.prepare('DELETE FROM timetable_periods WHERE timetable_id = ?').run(timetableId);
    const stmtPeriod = db.prepare(`
      INSERT INTO timetable_periods (timetable_id, period_number, label, start_time, end_time, type)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    validation.sortedPeriods.forEach(p => {
      stmtPeriod.run(timetableId, Number(p.period_number), p.label.trim(), p.start_time, p.end_time, p.type);
    });

    db.prepare(`
      INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
      VALUES (?, 'TIMETABLE_UPDATED', 'TIMETABLE', ?, ?)
    `).run(actorUserId, timetableId, JSON.stringify({
      before: { name: existing.name, scope: existing.scope, effective_from: existing.effective_from },
      after: { name, scope, effective_from, workingDays: formattedWorkingDays, periodCount: validation.sortedPeriods.length }
    }));
  });

  updateTx();
  return { id: timetableId, warnings: validation.warnings };
}

/**
 * Activates a timetable structure in ONE transaction.
 * Deactivates conflicting active days in other timetables so each weekday has at most 1 active structure.
 * Returns replaced information.
 */
function activate(timetableId, actorUserId) {
  const timetable = getTimetableById(timetableId);
  if (!timetable) throw new Error(`Timetable ID #${timetableId} not found.`);

  // Re-run validation on periods before activation
  const validation = validatePeriods(timetable.periods);
  if (validation.errors.length > 0) {
    const err = new Error('Cannot activate timetable with period errors.');
    err.validationErrors = validation.errors;
    throw err;
  }

  const targetDays = timetable.working_days.map(d => d.day_of_week);
  if (targetDays.length === 0) {
    throw new Error('Cannot activate timetable with zero working days.');
  }

  const activateTx = db.transaction(() => {
    // 1. Identify conflicting active working days in other timetables
    const placeholders = targetDays.map(() => '?').join(',');
    const conflictingActiveDays = db.prepare(`
      SELECT twd.id, twd.timetable_id, twd.day_of_week, t.name as timetable_name
      FROM timetable_working_days twd
      JOIN timetables t ON twd.timetable_id = t.id
      WHERE twd.day_of_week IN (${placeholders})
        AND twd.timetable_id != ?
        AND twd.is_active = 1
    `).all(...targetDays, timetableId);

    const replacedDetails = conflictingActiveDays.map(c => ({
      timetable_id: c.timetable_id,
      timetable_name: c.timetable_name,
      day_of_week: c.day_of_week
    }));

    // 2. Deactivate conflicting active working days
    if (conflictingActiveDays.length > 0) {
      db.prepare(`
        UPDATE timetable_working_days
        SET is_active = 0
        WHERE day_of_week IN (${placeholders})
          AND timetable_id != ?
          AND is_active = 1
      `).run(...targetDays, timetableId);
    }

    // 3. Mark target timetable's working days as active
    db.prepare(`
      UPDATE timetable_working_days
      SET is_active = 1
      WHERE timetable_id = ?
    `).run(timetableId);

    // 4. Mark target timetable as active
    db.prepare(`
      UPDATE timetables
      SET is_active = 1
      WHERE id = ?
    `).run(timetableId);

    // 5. Update is_active = 0 for any timetables that no longer have active working days
    db.prepare(`
      UPDATE timetables
      SET is_active = 0
      WHERE id IN (
        SELECT t.id
        FROM timetables t
        LEFT JOIN timetable_working_days twd ON t.id = twd.timetable_id AND twd.is_active = 1
        GROUP BY t.id
        HAVING COUNT(twd.id) = 0
      )
    `).run();

    // 6. Write audit log
    db.prepare(`
      INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
      VALUES (?, 'TIMETABLE_ACTIVATED', 'TIMETABLE', ?, ?)
    `).run(actorUserId, timetableId, JSON.stringify({
      timetableName: timetable.name,
      activatedDays: targetDays,
      replacedDays: replacedDetails
    }));

    return replacedDetails;
  });

  const replaced = activateTx();
  return { success: true, replaced };
}

/**
 * Deactivates a timetable structure in a transaction.
 */
function deactivate(timetableId, actorUserId) {
  const timetable = getTimetableById(timetableId);
  if (!timetable) throw new Error(`Timetable ID #${timetableId} not found.`);

  const deactivateTx = db.transaction(() => {
    db.prepare('UPDATE timetable_working_days SET is_active = 0 WHERE timetable_id = ?').run(timetableId);
    db.prepare('UPDATE timetables SET is_active = 0 WHERE id = ?').run(timetableId);

    db.prepare(`
      INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
      VALUES (?, 'TIMETABLE_DEACTIVATED', 'TIMETABLE', ?, ?)
    `).run(actorUserId, timetableId, JSON.stringify({ timetableName: timetable.name }));
  });

  deactivateTx();
  return { success: true };
}

/**
 * Deletes a timetable structure after checking for OD request historical snapshot references defensively.
 */
function deleteTimetable(timetableId, actorUserId) {
  const timetable = getTimetableById(timetableId);
  if (!timetable) throw new Error(`Timetable ID #${timetableId} not found.`);

  // Defensive check: check if od_request_periods references this timetable
  let snapshotCount = 0;
  try {
    const row = db.prepare('SELECT COUNT(*) as count FROM od_request_periods WHERE timetable_id = ?').get(timetableId);
    snapshotCount = row ? row.count : 0;
  } catch (e) {
    // If table doesn't exist yet, proceed safely
    snapshotCount = 0;
  }

  if (snapshotCount > 0) {
    const err = new Error(`Cannot delete timetable '${timetable.name}' because ${snapshotCount} historical OD request snapshots depend on it. Please deactivate this timetable structure instead.`);
    err.code = 'SNAPSHOT_REFERENCES_EXIST';
    throw err;
  }

  const deleteTx = db.transaction(() => {
    db.prepare('DELETE FROM timetables WHERE id = ?').run(timetableId);

    db.prepare(`
      INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json)
      VALUES (?, 'TIMETABLE_DELETED', 'TIMETABLE', ?, ?)
    `).run(actorUserId, timetableId, JSON.stringify({ timetableName: timetable.name }));
  });

  deleteTx();
  return { success: true };
}

/**
 * Finds active structure for a given date.
 * Returns null if none active.
 */
function findActiveStructure(dateInput) {
  if (!dateInput) return null;

  let isoDate = '';
  let dateObj;
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    isoDate = dateInput;
    const [y, m, d] = dateInput.split('-').map(Number);
    dateObj = new Date(Date.UTC(y, m - 1, d));
  } else {
    dateObj = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
    isoDate = dateObj.toISOString().split('T')[0];
  }

  if (isNaN(dateObj.getTime())) return null;

  const daysOfWeek = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const dayName = daysOfWeek[dateObj.getUTCDay()];

  const timetable = db.prepare(`
    SELECT t.*
    FROM timetables t
    WHERE t.is_active = 1
      AND t.effective_from <= ?
    ORDER BY t.effective_from DESC, t.id DESC
    LIMIT 1
  `).get(isoDate);

  if (!timetable) return null;

  const periods = db.prepare(`
    SELECT * FROM timetable_periods WHERE timetable_id = ? ORDER BY start_time ASC
  `).all(timetable.id).map(p => ({
    ...p,
    duration_minutes: durationMinutes(p)
  }));

  const workingDays = db.prepare(`
    SELECT day_of_week, is_active FROM timetable_working_days WHERE timetable_id = ? AND is_active = 1
  `).all(timetable.id);

  return {
    timetable,
    day_of_week: dayName,
    working_days: workingDays,
    periods
  };
}

/**
 * Previews overlapping CLASS periods for a given date and time range.
 * Used by event scheduling and OD request calculators.
 * 
 * Overlap rule: eventStart < periodEnd AND eventEnd > periodStart
 */
function previewPeriods(dateInput, startTime, endTime) {
  const activeStructure = findActiveStructure(dateInput);

  if (!activeStructure) {
    return {
      active: false,
      reason: 'NO_ACTIVE_STRUCTURE',
      periods: []
    };
  }

  const { day_of_week, periods } = activeStructure;
  const isWorkingDay = activeStructure.working_days.some(d => d.day_of_week === day_of_week);

  if (!isWorkingDay) {
    return {
      active: false,
      reason: 'NON_WORKING_DAY',
      periods: []
    };
  }

  // Filter overlapping periods: start_time < endTime AND end_time > startTime
  const overlappingPeriods = periods.filter(p => {
    return p.start_time < endTime && p.end_time > startTime;
  });

  // Filter for CLASS type periods only
  const classPeriods = overlappingPeriods.filter(p => p.type === 'CLASS');

  if (overlappingPeriods.length > 0 && classPeriods.length === 0) {
    return {
      active: true,
      reason: 'ONLY_BREAKS',
      periods: []
    };
  }

  return {
    active: true,
    reason: null,
    periods: classPeriods
  };
}

/**
 * Returns audit logs for timetable changes.
 */
function getTimetableAuditLogs() {
  return db.prepare(`
    SELECT a.*, u.full_name as actor_name, u.role as actor_role
    FROM audit_logs a
    LEFT JOIN users u ON a.actor_id = u.id
    WHERE a.target_entity = 'TIMETABLE' OR a.action LIKE 'TIMETABLE_%'
    ORDER BY a.timestamp DESC
  `).all();
}

module.exports = {
  durationMinutes,
  validatePeriods,
  getAllTimetables,
  getTimetableById,
  createTimetable,
  updateTimetable,
  activate,
  deactivate,
  deleteTimetable,
  findActiveStructure,
  previewPeriods,
  getTimetableAuditLogs
};
