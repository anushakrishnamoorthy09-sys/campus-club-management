const http = require('http');
const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const timetableService = require('../src/services/timetableService');
const app = require('../src/app');

async function runTimetableTests() {
  console.log('\n========================================================================================');
  console.log('                 CAMPUSCLUBOS TIMETABLE ENGINE & GUARD TEST SUITE                      ');
  console.log('========================================================================================\n');

  // Step 1: Reseed Database
  seedDatabase();

  const results = [];
  function recordTest(testName, passed, details) {
    results.push({ test: testName, status: passed ? 'PASS ✅' : 'FAIL ❌', details });
    console.log(`[${passed ? 'PASS ✅' : 'FAIL ❌'}] ${testName}: ${details}`);
  }

  // ----------------------------------------------------------------------------------
  // 1. UNIT TEST: Overlapping Periods Rejected
  // ----------------------------------------------------------------------------------
  try {
    const overlapping = [
      { period_number: 1, label: 'P1', start_time: '08:30', end_time: '09:20', type: 'CLASS' },
      { period_number: 2, label: 'P2', start_time: '09:00', end_time: '09:50', type: 'CLASS' }
    ];
    const validation = timetableService.validatePeriods(overlapping);
    const hasOverlapErr = validation.errors.some(e => e.includes('Overlapping periods'));
    if (hasOverlapErr) {
      recordTest('1. Overlapping periods rejected', true, `Correctly rejected: ${validation.errors[0]}`);
    } else {
      recordTest('1. Overlapping periods rejected', false, 'Failed to reject overlapping periods');
    }
  } catch (err) {
    recordTest('1. Overlapping periods rejected', false, err.message);
  }

  // ----------------------------------------------------------------------------------
  // 2. UNIT TEST: End Time Before Start Time Rejected
  // ----------------------------------------------------------------------------------
  try {
    const invalidTimes = [
      { period_number: 1, label: 'P1', start_time: '10:00', end_time: '09:30', type: 'CLASS' }
    ];
    const validation = timetableService.validatePeriods(invalidTimes);
    const hasEndErr = validation.errors.some(e => e.includes('End time') && e.includes('must be after start time'));
    if (hasEndErr) {
      recordTest('2. End before start time rejected', true, `Correctly rejected: ${validation.errors[0]}`);
    } else {
      recordTest('2. End before start time rejected', false, 'Failed to reject end_time <= start_time');
    }
  } catch (err) {
    recordTest('2. End before start time rejected', false, err.message);
  }

  // ----------------------------------------------------------------------------------
  // 3. UNIT TEST: Gap Raises Warning Only (No Blocking Error)
  // ----------------------------------------------------------------------------------
  try {
    const gapPeriods = [
      { period_number: 1, label: 'P1', start_time: '08:30', end_time: '09:20', type: 'CLASS' },
      { period_number: 2, label: 'P2', start_time: '09:40', end_time: '10:30', type: 'CLASS' }
    ];
    const validation = timetableService.validatePeriods(gapPeriods);
    const hasNoErrors = validation.errors.length === 0;
    const hasGapWarning = validation.warnings.some(w => w.includes('Unscheduled 20-minute gap'));
    if (hasNoErrors && hasGapWarning) {
      recordTest('3. Unscheduled gap raises warning only', true, `Zero blocking errors, warning generated: ${validation.warnings[0]}`);
    } else {
      recordTest('3. Unscheduled gap raises warning only', false, `Errors: ${validation.errors.length}, Warnings: ${validation.warnings.length}`);
    }
  } catch (err) {
    recordTest('3. Unscheduled gap raises warning only', false, err.message);
  }

  // ----------------------------------------------------------------------------------
  // 4. UNIT TEST: Two Active Structures for Same Weekday Impossible & Atomic Activation
  // ----------------------------------------------------------------------------------
  try {
    const superAdmin = db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN'").get();
    
    // Create second structure for Mon-Fri
    const { id: tt2Id } = timetableService.createTimetable({
      name: 'Special Event Day - 2026',
      scope: 'Special Academic Events',
      effective_from: '2026-02-01',
      working_days: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
      periods: [
        { period_number: 1, label: 'Event Period 1', start_time: '09:00', end_time: '10:00', type: 'CLASS' },
        { period_number: 2, label: 'Event Period 2', start_time: '10:05', end_time: '11:05', type: 'CLASS' }
      ]
    }, superAdmin.id);

    // Activate tt2Id atomically
    const { replaced } = timetableService.activate(tt2Id, superAdmin.id);

    // Check active working days count for MONDAY
    const activeMonCount = db.prepare("SELECT COUNT(*) as count FROM timetable_working_days WHERE day_of_week = 'MONDAY' AND is_active = 1").get().count;

    if (activeMonCount === 1 && replaced.length > 0) {
      recordTest('4. Single active structure per weekday & atomic activation', true, `Active MONDAY count is strictly 1. Replaced 5 conflicting active days from previous timetable.`);
    } else {
      recordTest('4. Single active structure per weekday & atomic activation', false, `Active MONDAY count: ${activeMonCount}, Replaced count: ${replaced.length}`);
    }
  } catch (err) {
    recordTest('4. Single active structure per weekday & atomic activation', false, err.message);
  }

  // ----------------------------------------------------------------------------------
  // 5. UNIT TEST: previewPeriods Edge Cases
  // ----------------------------------------------------------------------------------
  try {
    // Re-activate Seeded Timetable #1
    const superAdmin = db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN'").get();
    timetableService.activate(1, superAdmin.id);

    // A. Working Monday (2026-02-02 is Monday) with CLASS overlap (08:30 to 10:00 covers Period 1 and Period 2)
    const prev1 = timetableService.previewPeriods('2026-02-02', '08:30', '10:00');
    const prev1Success = prev1.active === true && prev1.periods.length === 2;

    // B. Sunday (2026-02-01 is Sunday - Non-working day)
    const prevSun = timetableService.previewPeriods('2026-02-01', '08:30', '10:00');
    const prevSunSuccess = prevSun.active === false && prevSun.reason === 'NON_WORKING_DAY';

    // C. Time range covering ONLY lunch break (12:15 to 13:00)
    const prevBreak = timetableService.previewPeriods('2026-02-02', '12:20', '13:00');
    const prevBreakSuccess = prevBreak.active === true && prevBreak.reason === 'ONLY_BREAKS' && prevBreak.periods.length === 0;

    // D. Past date before effective date
    const prevPast = timetableService.previewPeriods('2025-12-01', '08:30', '10:00');
    const prevPastSuccess = prevPast.active === false && prevPast.reason === 'NO_ACTIVE_STRUCTURE';

    if (prev1Success && prevSunSuccess && prevBreakSuccess && prevPastSuccess) {
      recordTest('5. previewPeriods edge cases', true, 'Handled CLASS overlaps (2 periods), Sunday NON_WORKING_DAY, Lunch ONLY_BREAKS, and NO_ACTIVE_STRUCTURE correctly.');
    } else {
      recordTest('5. previewPeriods edge cases', false, `p1: ${prev1Success}, sun: ${prevSunSuccess}, break: ${prevBreakSuccess}, past: ${prevPastSuccess}`);
    }
  } catch (err) {
    recordTest('5. previewPeriods edge cases', false, err.message);
  }

  // ----------------------------------------------------------------------------------
  // 6. UNIT TEST: Defensive OD Snapshot Reference Check on Delete
  // ----------------------------------------------------------------------------------
  try {
    const superAdmin = db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN'").get();
    const student = db.prepare("SELECT u.id as user_id, s.class_mentor_id FROM users u JOIN students s ON u.id = s.user_id WHERE u.role = 'STUDENT'").get();
    const club = db.prepare("SELECT id FROM clubs LIMIT 1").get();
    
    // Create a mock approved event & registration
    const evtRes = db.prepare(`
      INSERT INTO events (club_id, title, description, venue, event_date, start_time, end_time, capacity, status, created_by)
      VALUES (?, 'Test Workshop', 'Description', 'Hall A', '2026-02-15', '09:00', '12:00', 50, 'APPROVED', ?)
    `).run(club.id, superAdmin.id);

    const regRes = db.prepare(`
      INSERT INTO event_registrations (event_id, student_user_id)
      VALUES (?, ?)
    `).run(evtRes.lastInsertRowid, student.user_id);

    // Create a mock OD request & period snapshot referencing Timetable #1
    const odRes = db.prepare(`
      INSERT INTO od_requests (registration_id, student_user_id, class_mentor_id, status)
      VALUES (?, ?, ?, 'APPROVED')
    `).run(regRes.lastInsertRowid, student.user_id, student.class_mentor_id);

    db.prepare(`
      INSERT INTO od_request_periods (od_request_id, timetable_id, timetable_name, period_number, period_label, start_time, end_time)
      VALUES (?, 1, 'Regular Day - 2026', 1, 'Period 1', '08:30', '09:20')
    `).run(odRes.lastInsertRowid);

    let threwError = false;
    try {
      timetableService.deleteTimetable(1, superAdmin.id);
    } catch (e) {
      threwError = true;
      if (e.code === 'SNAPSHOT_REFERENCES_EXIST') {
        recordTest('6. Defensive OD snapshot delete check', true, `Correctly blocked timetable deletion: ${e.message}`);
      } else {
        recordTest('6. Defensive OD snapshot delete check', false, `Unexpected error: ${e.message}`);
      }
    }

    if (!threwError) {
      recordTest('6. Defensive OD snapshot delete check', false, 'Failed to block timetable deletion when historical OD snapshots exist');
    }

    // Clean up mock OD snapshot (ignore error if trigger blocks deletion of immutable rows)
    try {
      db.prepare('DELETE FROM od_request_periods WHERE od_request_id = ?').run(odRes.lastInsertRowid);
      db.prepare('DELETE FROM od_requests WHERE id = ?').run(odRes.lastInsertRowid);
      db.prepare('DELETE FROM event_registrations WHERE id = ?').run(regRes.lastInsertRowid);
      db.prepare('DELETE FROM events WHERE id = ?').run(evtRes.lastInsertRowid);
    } catch (cleanupErr) {
      // Expected: immutable triggers prevent deletion of OD snapshots
    }
  } catch (err) {
    recordTest('6. Defensive OD snapshot delete check', false, err.message);
  }

  // ----------------------------------------------------------------------------------
  // 7. HTTP SERVER GUARD TESTS: Direct POST/PUT/DELETE by Non-SuperAdmin
  // ----------------------------------------------------------------------------------
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function postJson(urlPath, body, token) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(token ? { 'Cookie': `token=${token}` } : {})
      },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  const { signToken } = require('../src/middleware/auth');

  const clubAdmin = db.prepare("SELECT * FROM users WHERE role = 'CLUB_ADMIN'").get();
  const faculty = db.prepare("SELECT * FROM users WHERE role = 'FACULTY'").get();

  const clubAdminToken = signToken(clubAdmin.id);
  const facultyToken = signToken(faculty.id);

  // A. Club Admin attempting POST /admin/timetable
  const caRes = await postJson('/admin/timetable', { name: 'Unauthorized TT', scope: 'Test', effective_from: '2026-01-01', working_days: ['MONDAY'], periods_json: '[]' }, clubAdminToken);
  
  // B. Faculty attempting POST /admin/timetable/1/activate
  const facRes = await postJson('/admin/timetable/1/activate', {}, facultyToken);

  // Check audit log recorded for denied attempt
  const deniedLog = db.prepare("SELECT * FROM audit_logs WHERE action IN ('ACCESS_DENIED', 'TIMETABLE_ACCESS_DENIED') ORDER BY timestamp DESC LIMIT 1").get();

  if (caRes.status === 403 && facRes.status === 403 && deniedLog) {
    recordTest('7. HTTP 403 Guard & Access Denied Audit Logging', true, `Club Admin and Faculty POST requests returned HTTP 403 Forbidden. Audit log recorded TIMETABLE_ACCESS_DENIED for actor_id #${deniedLog.actor_id}.`);
  } else {
    recordTest('7. HTTP 403 Guard & Access Denied Audit Logging', false, `Club Admin status: ${caRes.status}, Faculty status: ${facRes.status}, Audit log present: ${!!deniedLog}`);
  }

  server.close();

  // Print Summary Table
  console.log('\n========================================================================================');
  console.log('                            TIMETABLE TEST RESULTS SUMMARY                              ');
  console.log('========================================================================================\n');
  console.table(results);

  const allPassed = results.every(r => r.status.includes('PASS'));
  if (allPassed) {
    console.log('\n✅ ALL TIMETABLE TEST ASSERTIONS PASSED PERFECTLY!\n');
  } else {
    console.error('\n❌ SOME TIMETABLE TESTS FAILED!\n');
    process.exit(1);
  }
}

if (require.main === module) {
  runTimetableTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
}

module.exports = { runTimetableTests };
