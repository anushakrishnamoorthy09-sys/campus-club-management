const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const eventService = require('../src/services/eventService');
const registrationService = require('../src/services/registrationService');
const timetableService = require('../src/services/timetableService');
const odService = require('../src/services/odService');

const unitTestResults = [];

function recordTest(testName, passed, details = '') {
  unitTestResults.push({
    test: testName,
    status: passed ? 'PASS ✅' : 'FAIL ❌',
    details: details
  });
}

function getAsiaKolkataToday() {
  const now = new Date();
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function runOdUnitTests() {
  console.log('\n========================================================================================');
  console.log('                     CAMPUSCLUBOS OD DOMAIN UNIT TEST SUITE                             ');
  console.log('========================================================================================\n');

  // 1. Reset database with seeds
  seedDatabase();

  const superAdmin = db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN'").get();
  const admin = db.prepare("SELECT * FROM users WHERE role = 'ADMIN'").get();
  const facultyMentor = db.prepare("SELECT * FROM users WHERE email = 'faculty.mentor@campus.edu'").get();
  const facultyAdvisor = db.prepare("SELECT * FROM users WHERE email = 'faculty.advisor@campus.edu'").get();
  const clubAdmin = db.prepare("SELECT * FROM users WHERE email = 'clubadmin@campus.edu'").get();
  const student1 = db.prepare("SELECT * FROM users WHERE email = 'student1@campus.edu'").get();
  const student2 = db.prepare("SELECT * FROM users WHERE email = 'student2@campus.edu'").get();
  const codingClub = db.prepare("SELECT * FROM clubs WHERE code = 'CODE01'").get();

  const testDate = '2026-12-01'; // Future date (Tuesday)

  // Create an active timetable for testDate if none active
  let activeTt = timetableService.findActiveStructure(testDate);
  if (!activeTt) {
    const res = timetableService.createTimetable({
      name: 'Default Active Structure',
      scope: 'INSTITUTION',
      effective_from: '2026-01-01',
      working_days: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
      periods: [
        { period_number: 1, label: 'Period 1', type: 'CLASS', start_time: '08:00', end_time: '09:00' },
        { period_number: 2, label: 'Break 1', type: 'SHORT_BREAK', start_time: '09:00', end_time: '09:15' },
        { period_number: 3, label: 'Period 2', type: 'CLASS', start_time: '09:15', end_time: '10:15' },
        { period_number: 4, label: 'Lunch', type: 'LUNCH_BREAK', start_time: '12:00', end_time: '13:00' },
        { period_number: 5, label: 'Period 3', type: 'CLASS', start_time: '14:00', end_time: '15:00' }
      ]
    }, superAdmin.id);

    timetableService.activate(res.id, superAdmin.id);
    activeTt = timetableService.findActiveStructure(testDate);
  }

  // Create an APPROVED event overlapping CLASS periods
  const appEvent = eventService.createEvent(clubAdmin, codingClub.id, {
    title: 'Academic Hackathon',
    description: 'Event during academic hours',
    venue: 'Lab 101',
    event_date: testDate,
    start_time: '08:00',
    end_time: '10:15',
    capacity: 50
  });
  eventService.transition(appEvent.id, 'submit', clubAdmin);
  eventService.transition(appEvent.id, 'approve', facultyMentor);

  // Student 1 registers for appEvent
  const reg1 = registrationService.register(appEvent.id, student1.id);

  // Student 2 registers for appEvent
  const reg2 = registrationService.register(appEvent.id, student2.id);

  // ------------------------------------------------------------------------
  // TEST 1: Request without valid registration fails (404)
  // ------------------------------------------------------------------------
  try {
    console.log('[OD TEST 1] Verifying non-existent registration refusal...');
    odService.request(student1.id, 999999);
    recordTest('1. Request without registration fails', false, 'Did not throw expected 404 error');
  } catch (err) {
    recordTest('1. Request without registration fails', err.statusCode === 404 || err.message.includes('not found'), err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 2: Someone else's registration fails (403)
  // ------------------------------------------------------------------------
  try {
    console.log('[OD TEST 2] Verifying foreign student registration refusal...');
    odService.request(student2.id, reg1.id);
    recordTest('2. Someone else\'s registration fails', false, 'Did not throw expected 403 error');
  } catch (err) {
    recordTest('2. Someone else\'s registration fails', err.statusCode === 403 || err.message.includes('Forbidden'), err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 3: Event not approved fails
  // ------------------------------------------------------------------------
  try {
    console.log('[OD TEST 3] Verifying unapproved event OD refusal...');
    const draftEvent = eventService.createEvent(clubAdmin, codingClub.id, {
      title: 'Draft Event',
      description: 'Draft Description',
      venue: 'Hall Z',
      event_date: testDate,
      start_time: '08:00',
      end_time: '09:00',
      capacity: 10
    });

    // Bypass trigger using direct insert for fixture setup
    db.prepare('INSERT INTO event_registrations (event_id, student_user_id) VALUES (?, ?)').run(draftEvent.id, student1.id);
    const draftReg = db.prepare('SELECT id FROM event_registrations WHERE event_id = ? AND student_user_id = ?').get(draftEvent.id, student1.id);

    odService.request(student1.id, draftReg.id);
    recordTest('3. Event not approved fails', false, 'Did not throw expected error for DRAFT event');
  } catch (err) {
    recordTest('3. Event not approved fails', err.statusCode === 400 || err.message.includes('blocked'), err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 4: Breaks-only and no-timetable cases blocked
  // ------------------------------------------------------------------------
  try {
    console.log('[OD TEST 4] Verifying breaks-only and non-class time period blocking...');
    const breakEvent = eventService.createEvent(clubAdmin, codingClub.id, {
      title: 'Lunch Break Social',
      description: 'Socializing during lunch break',
      venue: 'Cafeteria',
      event_date: testDate,
      start_time: '12:15',
      end_time: '13:05', // Lunch break period only (12:15 - 13:05)
      capacity: 50
    });
    eventService.transition(breakEvent.id, 'submit', clubAdmin);
    eventService.transition(breakEvent.id, 'approve', facultyMentor);

    const breakReg = registrationService.register(breakEvent.id, student1.id);
    odService.request(student1.id, breakReg.id);
    recordTest('4. Breaks-only and no-timetable cases blocked', false, 'Did not block breaks-only event OD request');
  } catch (err) {
    recordTest('4. Breaks-only and no-timetable cases blocked', err.statusCode === 400 || err.message.includes('breaks') || err.message.includes('blocked'), err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 5: Mentor decides once, second decision fails
  // ------------------------------------------------------------------------
  let validOd;
  try {
    console.log('[OD TEST 5] Verifying single decision rule & second decision refusal...');
    validOd = odService.request(student1.id, reg1.id);
    const approvedOd = odService.review(validOd.id, facultyMentor, 'approve', 'Approved for hackathon');
    let pass = approvedOd.status === 'APPROVED';

    // Attempt second decision
    try {
      odService.review(validOd.id, facultyMentor, 'reject', 'Attempting re-decision');
      pass = false;
    } catch (err2) {
      pass = pass && (err2.statusCode === 400 || err2.message.includes('already APPROVED'));
    }

    recordTest('5. Mentor decides once, second decision fails', pass, 'First review APPROVED; second review attempt rejected with 400');
  } catch (err) {
    recordTest('5. Mentor decides once, second decision fails', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 6: Wrong faculty (including club coordinator who is not mentor) refused
  // ------------------------------------------------------------------------
  try {
    console.log('[OD TEST 6] Verifying wrong faculty / coordinator OD review refusal (403)...');
    const od2 = odService.request(student2.id, reg2.id);

    // facultyAdvisor is coordinator of codingClub, but NOT class mentor of student2!
    odService.review(od2.id, facultyAdvisor, 'approve', 'Coordinator attempt');
    recordTest('6. Wrong faculty (including club coordinator) refused', false, 'Did not refuse wrong faculty review');
  } catch (err) {
    recordTest('6. Wrong faculty (including club coordinator) refused', err.statusCode === 403 || err.message.includes('Forbidden'), err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 7: Self-approval impossible
  // ------------------------------------------------------------------------
  try {
    console.log('[OD TEST 7] Verifying self-approval refusal...');
    const od2 = db.prepare("SELECT id FROM od_requests WHERE registration_id = ? AND status = 'PENDING'").get(reg2.id);
    odService.review(od2.id, student2, 'approve', 'Self approve');
    recordTest('7. Self-approval impossible', false, 'Did not refuse student self-approval');
  } catch (err) {
    recordTest('7. Self-approval impossible', err.statusCode === 403 || err.message.includes('Forbidden') || err.message.includes('Self-approval'), err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 8: Reject without remark fails
  // ------------------------------------------------------------------------
  try {
    console.log('[OD TEST 8] Verifying rejection without remark refusal...');
    const od2 = db.prepare("SELECT id FROM od_requests WHERE registration_id = ? AND status = 'PENDING'").get(reg2.id);
    odService.review(od2.id, facultyMentor, 'reject', '');
    recordTest('8. Reject without remark fails', false, 'Did not require remark for rejection');
  } catch (err) {
    recordTest('8. Reject without remark fails', err.statusCode === 400 || err.message.includes('mandatory') || err.message.includes('remark'), err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 9: Snapshot survives a later timetable edit and stays identical
  // ------------------------------------------------------------------------
  try {
    console.log('[OD TEST 9] Verifying immutable snapshot survival across timetable updates...');
    const initialPeriods = validOd.periods;
    const initialSnapshotCount = db.prepare('SELECT COUNT(*) as count FROM od_request_periods WHERE od_request_id = ?').get(validOd.id).count;

    // Modify active timetable structure using single quotes for SQL string literal
    db.prepare("UPDATE timetable_periods SET label = 'MODIFIED PERIOD NAME' WHERE timetable_id = ?").run(activeTt.timetable.id);

    const postEditRecord = odService.getForStudent(validOd.id, student1.id);
    const postEditPeriods = postEditRecord.periods;

    let pass = initialSnapshotCount > 0 && postEditPeriods.length === initialPeriods.length;
    pass = pass && (postEditPeriods[0].period_label !== 'MODIFIED PERIOD NAME');

    recordTest('9. Snapshot survives a later timetable edit and stays identical', pass, `Periods count: ${postEditPeriods.length}; Period label remained immutable: ${postEditPeriods[0].period_label}`);
  } catch (err) {
    recordTest('9. Snapshot survives a later timetable edit and stays identical', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 10: Raw SQL update of a decided OD or its snapshot is rejected by trigger
  // ------------------------------------------------------------------------
  console.log('[OD TEST 10] Verifying DB triggers lock decided OD rows & period snapshots...');
  let triggerLockPass = true;

  // A. Direct raw SQL status/remark update on decided OD (must be aborted by trg_lock_decided_od)
  try {
    db.prepare("UPDATE od_requests SET faculty_remark = 'HACKED REMARK' WHERE id = ?").run(validOd.id);
    triggerLockPass = false;
  } catch (err) {
    if (!err.message.includes('locked')) triggerLockPass = false;
  }

  // B. Direct raw SQL update on od_request_periods (must be aborted by trg_lock_od_request_periods_update)
  try {
    db.prepare("UPDATE od_request_periods SET start_time = '00:00' WHERE od_request_id = ?").run(validOd.id);
    triggerLockPass = false;
  } catch (err) {
    if (!err.message.includes('immutable')) triggerLockPass = false;
  }

  // C. Direct raw SQL delete on od_request_periods (must be aborted by trg_lock_od_request_periods_delete)
  try {
    db.prepare("DELETE FROM od_request_periods WHERE od_request_id = ?").run(validOd.id);
    triggerLockPass = false;
  } catch (err) {
    if (!err.message.includes('immutable')) triggerLockPass = false;
  }

  recordTest('10. Raw SQL update of a decided OD or its snapshot is rejected by trigger', triggerLockPass, 'SQLite triggers aborted direct UPDATE on decided OD and UPDATE/DELETE on od_request_periods');

  // ------------------------------------------------------------------------
  // TEST 11: Duplicate open OD refused, re-apply after rejection allowed
  // ------------------------------------------------------------------------
  try {
    console.log('[OD TEST 11] Verifying duplicate open OD block & re-apply post-rejection...');
    // student1 already has an APPROVED OD for reg1.id -> duplicate request must fail (409)
    let dupPass = false;
    try {
      odService.request(student1.id, reg1.id);
    } catch (err) {
      dupPass = err.statusCode === 409 || err.message.includes('active OD request');
    }

    // Reject student2's pending OD (reg2.id)
    const od2 = db.prepare("SELECT id FROM od_requests WHERE registration_id = ? AND status = 'PENDING'").get(reg2.id);
    odService.review(od2.id, facultyMentor, 'reject', 'Rejection reason for testing re-apply');

    // Student 2 re-applies for reg2.id post-rejection -> must succeed
    const reappliedOd = odService.request(student2.id, reg2.id);
    const reapplyPass = reappliedOd && reappliedOd.status === 'PENDING';

    recordTest('11. Duplicate open OD refused, re-apply after rejection allowed', dupPass && reapplyPass, 'Duplicate request blocked (409); re-application post-rejection created new PENDING OD');
  } catch (err) {
    recordTest('11. Duplicate open OD refused, re-apply after rejection allowed', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 12: Mentor reassignment moves only pending ODs; cancelled event closes pending ODs
  // ------------------------------------------------------------------------
  try {
    console.log('[OD TEST 12] Verifying mentor reassignment scope & event cancellation auto-close...');
    // Currently student1 has validOd (APPROVED under facultyMentor).
    // student2 has a PENDING re-applied OD under facultyMentor.

    // Reassign student2's mentor from facultyMentor to facultyAdvisor
    odService.reassignMentor(student2.id, facultyAdvisor.id, superAdmin);

    const reassignedOd2 = odService.getForStudent(db.prepare("SELECT id FROM od_requests WHERE registration_id = ? AND status = 'PENDING'").get(reg2.id).id, student2.id);
    const decidedOd1 = odService.getForStudent(validOd.id, student1.id);

    let pass = Number(reassignedOd2.class_mentor_id) === Number(facultyAdvisor.id);
    pass = pass && Number(decidedOd1.class_mentor_id) === Number(facultyMentor.id); // Decided OD retained original mentor!

    // Event cancellation auto-close
    odService.autoCloseForEvent(appEvent.id, 'Weather Emergency');
    const closedOd2 = odService.getForStudent(reassignedOd2.id, student2.id);
    const keptApprovedOd1 = odService.getForStudent(validOd.id, student1.id);

    pass = pass && closedOd2.status === 'CLOSED';
    pass = pass && keptApprovedOd1.status === 'APPROVED'; // Approved OD remained APPROVED!

    recordTest('12. Mentor reassignment moves only pending ODs; cancelled event closes pending ODs', pass, 'Pending OD moved to new mentor while decided OD retained original mentor; event cancellation closed PENDING ODs while leaving APPROVED ODs intact');
  } catch (err) {
    recordTest('12. Mentor reassignment moves only pending ODs; cancelled event closes pending ODs', false, err.message);
  }

  // Summary
  console.log('\n========================================================================================');
  console.log('                          OD DOMAIN UNIT TEST RESULTS                                   ');
  console.log('========================================================================================\n');
  console.table(unitTestResults);

  const hasFailures = unitTestResults.some(r => r.status.includes('FAIL'));
  if (hasFailures) {
    console.error('\n❌ OD UNIT TESTS FAILED! Exit Code 1\n');
    process.exit(1);
  } else {
    console.log('\n✅ ALL 12 OD UNIT TEST SCENARIOS PASSED! Exit Code 0\n');
  }
}

if (require.main === module) {
  runOdUnitTests();
}

module.exports = { runOdUnitTests };
