const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const eventService = require('../src/services/eventService');
const registrationService = require('../src/services/registrationService');
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

function runUnitTests() {
  console.log('\n========================================================================================');
  console.log('                   CAMPUSCLUBOS EVENT DOMAIN UNIT TEST SUITE                            ');
  console.log('========================================================================================\n');

  // Seed DB fresh
  seedDatabase();

  const superAdmin = db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN'").get();
  const admin = db.prepare("SELECT * FROM users WHERE role = 'ADMIN'").get();
  const faculty1 = db.prepare("SELECT * FROM users WHERE email = 'faculty.mentor@campus.edu'").get();
  const faculty2 = db.prepare("SELECT * FROM users WHERE email = 'faculty.advisor@campus.edu'").get();
  const clubAdmin = db.prepare("SELECT * FROM users WHERE email = 'clubadmin@campus.edu'").get();
  const student1 = db.prepare("SELECT * FROM users WHERE email = 'student1@campus.edu'").get();
  const student2 = db.prepare("SELECT * FROM users WHERE email = 'student2@campus.edu'").get();
  const codingClub = db.prepare("SELECT * FROM clubs WHERE code = 'CODE01'").get();

  const todayStr = getAsiaKolkataToday();

  // ------------------------------------------------------------------------
  // 1. LEGAL EVENT CREATION & TRANSITIONS
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 1] Verifying Event Creation & Standard Approval Workflow...');
    const newEvent = eventService.createEvent(clubAdmin, codingClub.id, {
      title: 'Hackathon 2026',
      description: 'Annual Campus Hackathon Event',
      venue: 'Main Auditorium',
      event_date: todayStr,
      start_time: '23:45',
      end_time: '23:55',
      capacity: 100
    });

    let pass = newEvent.status === 'DRAFT' && newEvent.club_id === codingClub.id;

    // Submit DRAFT -> PENDING_APPROVAL
    const submitted = eventService.transition(newEvent.id, 'submit', clubAdmin);
    pass = pass && submitted.status === 'PENDING_APPROVAL';

    // Approve PENDING_APPROVAL -> APPROVED (Faculty 1 is coordinator)
    const approved = eventService.transition(newEvent.id, 'approve', faculty1);
    pass = pass && approved.status === 'APPROVED';

    recordTest('1. Create DRAFT -> Submit PENDING_APPROVAL -> Approve APPROVED', pass, `Status sequence: DRAFT -> PENDING_APPROVAL -> APPROVED`);
  } catch (err) {
    recordTest('1. Create DRAFT -> Submit PENDING_APPROVAL -> Approve APPROVED', false, err.message);
  }

  // ------------------------------------------------------------------------
  // 2. REJECT & RESUBMIT WORKFLOW
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 2] Verifying Rejection & Resubmission Workflow...');
    const ev = eventService.createEvent(clubAdmin, codingClub.id, {
      title: 'Workshop',
      description: 'Web Dev Workshop',
      venue: 'Lab 1',
      event_date: todayStr,
      start_time: '23:45',
      end_time: '23:55',
      capacity: 50
    });

    eventService.transition(ev.id, 'submit', clubAdmin);
    const rejected = eventService.transition(ev.id, 'reject', faculty1, { remark: 'Needs revised budget' });
    let pass = rejected.status === 'REJECTED' && rejected.rejection_remark === 'Needs revised budget';

    // Resubmit REJECTED -> PENDING_APPROVAL
    const resubmitted = eventService.transition(ev.id, 'submit', clubAdmin);
    pass = pass && resubmitted.status === 'PENDING_APPROVAL' && resubmitted.rejection_remark === null;

    recordTest('2. Reject REJECTED -> Resubmit PENDING_APPROVAL', pass, 'Rejection remark saved; cleared on resubmit');
  } catch (err) {
    recordTest('2. Reject REJECTED -> Resubmit PENDING_APPROVAL', false, err.message);
  }

  // ------------------------------------------------------------------------
  // 3. ESCALATION & ADMIN APPROVAL / REJECTION WORKFLOW
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 3] Verifying Escalation & Admin Resolution Workflow...');
    const ev = eventService.createEvent(clubAdmin, codingClub.id, {
      title: 'Mega Fest',
      description: 'Inter-College Mega Cultural Event',
      venue: 'Stadium',
      event_date: todayStr,
      start_time: '23:45',
      end_time: '23:55',
      capacity: 500
    });

    eventService.transition(ev.id, 'submit', clubAdmin);
    const escalated = eventService.transition(ev.id, 'escalate', faculty1, { reason: 'Requires Admin venue clearance' });
    let pass = escalated.status === 'PENDING_APPROVAL' && escalated.escalated_at !== null && escalated.escalation_reason === 'Requires Admin venue clearance';

    // Escalation-approve by Admin
    const adminApproved = eventService.transition(ev.id, 'escalation-approve', admin, { reason: 'Venue clearance granted' });
    pass = pass && adminApproved.status === 'APPROVED';

    recordTest('3. Escalate to Admin -> Admin Escalation Approve', pass, 'Escalation details recorded & Admin approved');
  } catch (err) {
    recordTest('3. Escalate to Admin -> Admin Escalation Approve', false, err.message);
  }

  // ------------------------------------------------------------------------
  // 4. SUPER ADMIN OVERRIDE WORKFLOW
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 4] Verifying Super Admin Override Approval...');
    const ev = eventService.createEvent(clubAdmin, codingClub.id, {
      title: 'Override Event',
      description: 'Special Event Description',
      venue: 'Seminar Hall',
      event_date: todayStr,
      start_time: '23:00',
      end_time: '23:55',
      capacity: 30
    });

    eventService.transition(ev.id, 'submit', clubAdmin);
    const overridden = eventService.transition(ev.id, 'override-approve', superAdmin, { reason: 'Super Admin Override' });
    const pass = overridden.status === 'APPROVED';

    recordTest('4. Super Admin Override Approval', pass, 'Super Admin overridden status to APPROVED');
  } catch (err) {
    recordTest('4. Super Admin Override Approval', false, err.message);
  }

  // ------------------------------------------------------------------------
  // 5. EVENT START & COMPLETE WORKFLOW
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 5] Verifying Start (ONGOING) & Complete (COMPLETED) Workflow...');
    const ev = eventService.createEvent(clubAdmin, codingClub.id, {
      title: 'Today Live Event',
      description: 'Live Event Description',
      venue: 'Lab 2',
      event_date: todayStr,
      start_time: '23:00',
      end_time: '23:59',
      capacity: 40
    });

    eventService.transition(ev.id, 'submit', clubAdmin);
    eventService.transition(ev.id, 'approve', faculty1);

    const started = eventService.transition(ev.id, 'start', clubAdmin);
    let pass = started.status === 'ONGOING';

    const completed = eventService.transition(ev.id, 'complete', clubAdmin);
    pass = pass && completed.status === 'COMPLETED';

    recordTest('5. Start ONGOING -> Complete COMPLETED', pass, 'APPROVED -> ONGOING -> COMPLETED on scheduled date');
  } catch (err) {
    recordTest('5. Start ONGOING -> Complete COMPLETED', false, err.message);
  }

  // ------------------------------------------------------------------------
  // 6. ILLEGAL TRANSITION JUMPS (MUST FAIL)
  // ------------------------------------------------------------------------
  console.log('[UNIT TEST 6] Verifying Rejection of Illegal Transition Jumps...');
  let illegalPass = true;
  const evIllegal = eventService.createEvent(clubAdmin, codingClub.id, {
    title: 'Illegal Jumps Test Event',
    description: 'Testing invalid transitions',
    venue: 'Hall A',
    event_date: todayStr,
    start_time: '23:10',
    end_time: '23:50',
    capacity: 20
  });

  // A. DRAFT -> APPROVED (must fail)
  try {
    eventService.transition(evIllegal.id, 'approve', faculty1);
    illegalPass = false;
  } catch (err) { if (err.statusCode !== 400) illegalPass = false; }

  // Submit to PENDING_APPROVAL
  eventService.transition(evIllegal.id, 'submit', clubAdmin);

  // B. PENDING_APPROVAL -> ONGOING (must fail)
  try {
    eventService.transition(evIllegal.id, 'start', clubAdmin);
    illegalPass = false;
  } catch (err) { if (err.statusCode !== 400) illegalPass = false; }

  // C. PENDING_APPROVAL -> COMPLETED (must fail)
  try {
    eventService.transition(evIllegal.id, 'complete', clubAdmin);
    illegalPass = false;
  } catch (err) { if (err.statusCode !== 400) illegalPass = false; }

  // Approve properly
  eventService.transition(evIllegal.id, 'approve', faculty1);

  // D. APPROVED -> DRAFT (must fail)
  try {
    eventService.transition(evIllegal.id, 'submit', clubAdmin);
    illegalPass = false;
  } catch (err) { if (err.statusCode !== 400) illegalPass = false; }

  // Start & Complete
  eventService.transition(evIllegal.id, 'start', clubAdmin);
  eventService.transition(evIllegal.id, 'complete', clubAdmin);

  // E. COMPLETED -> anything (must fail)
  try {
    eventService.transition(evIllegal.id, 'cancel', clubAdmin, { reason: 'Too late' });
    illegalPass = false;
  } catch (err) { if (err.statusCode !== 400) illegalPass = false; }

  recordTest('6. Rejection of illegal transition jumps (DRAFT->APPROVED, PENDING->ONGOING/COMPLETED, COMPLETED->ANY)', illegalPass, 'All 5 illegal transition attempts threw 400 Bad Request');

  // ------------------------------------------------------------------------
  // 7. SELF-APPROVAL & WRONG-CLUB FACULTY COORDINATOR PROTECTION
  // ------------------------------------------------------------------------
  console.log('[UNIT TEST 7] Verifying Self-Approval & Wrong-Club Coordinator Restrictions...');
  let scopePass = true;

  // Create event by Club Admin, then set created_by to Faculty 1 to test self-approval protection
  const evSelf = eventService.createEvent(clubAdmin, codingClub.id, {
    title: 'Faculty Created Event',
    description: 'Faculty Event',
    venue: 'Hall B',
    event_date: todayStr,
    start_time: '23:15',
    end_time: '23:45',
    capacity: 25
  });
  db.prepare('UPDATE events SET created_by = ? WHERE id = ?').run(faculty1.id, evSelf.id);
  eventService.transition(evSelf.id, 'submit', clubAdmin);

  // Faculty 1 attempts self-approval -> 403
  try {
    eventService.transition(evSelf.id, 'approve', faculty1);
    scopePass = false;
  } catch (err) { if (err.statusCode !== 403) scopePass = false; }

  // Faculty 2 (NOT coordinator of Coding Club) attempts approval -> 403
  try {
    eventService.transition(evSelf.id, 'approve', faculty2);
    scopePass = false;
  } catch (err) { if (err.statusCode !== 403) scopePass = false; }

  recordTest('7. Self-approval & wrong-club coordinator blocked (403)', scopePass, 'Self-approval and foreign club coordinator denied with status 403');

  // ------------------------------------------------------------------------
  // 8. MATERIAL EDIT ON APPROVED EVENT RETURNS TO PENDING_APPROVAL
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 8] Verifying Material Edit on APPROVED Event Moves Back to PENDING_APPROVAL...');
    const evEdit = eventService.createEvent(clubAdmin, codingClub.id, {
      title: 'Original Title',
      description: 'Original Description',
      venue: 'Hall 1',
      event_date: todayStr,
      start_time: '23:20',
      end_time: '23:50',
      capacity: 50
    });
    eventService.transition(evEdit.id, 'submit', clubAdmin);
    eventService.transition(evEdit.id, 'approve', faculty1);

    // Non-material edit (description only) -> remains APPROVED
    const updated1 = eventService.updateEvent(clubAdmin, evEdit.id, {
      title: 'Original Title',
      description: 'Updated Description Only',
      venue: 'Hall 1',
      event_date: todayStr,
      start_time: '23:20',
      end_time: '23:50',
      capacity: 50
    });
    let pass = updated1.status === 'APPROVED';

    // Material edit (venue change) -> moves back to PENDING_APPROVAL
    const updated2 = eventService.updateEvent(clubAdmin, evEdit.id, {
      title: 'Original Title',
      description: 'Updated Description Only',
      venue: 'Hall 2 (Changed)',
      event_date: todayStr,
      start_time: '23:20',
      end_time: '23:50',
      capacity: 50
    });
    pass = pass && updated2.status === 'PENDING_APPROVAL';

    recordTest('8. Material edit on APPROVED event moves back to PENDING_APPROVAL', pass, 'Non-material kept APPROVED; venue change moved back to PENDING_APPROVAL');
  } catch (err) {
    recordTest('8. Material edit on APPROVED event moves back to PENDING_APPROVAL', false, err.message);
  }

  // ------------------------------------------------------------------------
  // 9. STUDENT REGISTRATION, CAPACITY BOUNDARY & DUPLICATE BLOCK
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 9] Verifying Registration Service Capacity & Duplicate Controls...');
    const evReg = eventService.createEvent(clubAdmin, codingClub.id, {
      title: 'Small Capacity Workshop',
      description: 'Limited Seats Event',
      venue: 'Small Room',
      event_date: todayStr,
      start_time: '23:30',
      end_time: '23:55',
      capacity: 1 // Only 1 seat
    });
    eventService.transition(evReg.id, 'submit', clubAdmin);
    eventService.transition(evReg.id, 'approve', faculty1);

    // Student 1 registers -> succeeds
    const reg1 = registrationService.register(evReg.id, student1.id);
    let pass = Boolean(reg1.id);

    // Student 1 duplicate registration -> 409
    try {
      registrationService.register(evReg.id, student1.id);
      pass = false;
    } catch (err) { if (err.statusCode !== 409) pass = false; }

    // Student 2 registers -> exceeds capacity (400)
    try {
      registrationService.register(evReg.id, student2.id);
      pass = false;
    } catch (err) { if (err.statusCode !== 400) pass = false; }

    recordTest('9. Registration capacity boundary & duplicate registration enforcement', pass, 'Single seat registered; duplicate (409) and capacity overflow (400) blocked');
  } catch (err) {
    recordTest('9. Registration capacity boundary & duplicate registration enforcement', false, err.message);
  }

  // ------------------------------------------------------------------------
  // 10. RAW SQL TRIGGER ENFORCEMENT ON DATABASE
  // ------------------------------------------------------------------------
  console.log('[UNIT TEST 10] Verifying DB Triggers Block Raw SQL Violations...');
  let triggerPass = true;

  const evTrig = eventService.createEvent(clubAdmin, codingClub.id, {
    title: 'Trigger Test Event',
    description: 'Raw SQL Trigger Test',
    venue: 'Lab 3',
    event_date: todayStr,
    start_time: '23:35',
    end_time: '23:58',
    capacity: 10
  });

  // A. Direct raw SQL status jump: DRAFT -> APPROVED (must be aborted by DB trigger)
  try {
    db.prepare("UPDATE events SET status = 'APPROVED' WHERE id = ?").run(evTrig.id);
    triggerPass = false;
  } catch (err) {
    if (!err.message.includes('Invalid event transition')) triggerPass = false;
  }

  // B. Direct raw SQL registration insert on DRAFT event (must be aborted by DB trigger)
  try {
    db.prepare("INSERT INTO event_registrations (event_id, student_user_id) VALUES (?, ?)").run(evTrig.id, student1.id);
    triggerPass = false;
  } catch (err) {
    if (!err.message.includes('Event registration blocked')) triggerPass = false;
  }

  recordTest('10. Raw SQL trigger enforcement (trg_check_event_status_transition & trg_check_event_registration_status)', triggerPass, 'Direct raw SQL status updates and registration inserts aborted by SQLite triggers');

  // Summary
  console.log('\n========================================================================================');
  console.log('                        EVENT DOMAIN UNIT TEST RESULTS                                  ');
  console.log('========================================================================================\n');
  console.table(unitTestResults);

  const hasFailures = unitTestResults.some(r => r.status.includes('FAIL'));
  if (hasFailures) {
    console.error('\n❌ UNIT TESTS FAILED! Exit Code 1\n');
    process.exit(1);
  } else {
    console.log('\n✅ ALL 10 UNIT TEST SCENARIOS PASSED! Exit Code 0\n');
    process.exit(0);
  }
}

if (require.main === module) {
  runUnitTests();
}

module.exports = { runUnitTests };
