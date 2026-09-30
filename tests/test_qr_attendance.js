const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const eventService = require('../src/services/eventService');
const registrationService = require('../src/services/registrationService');
const attendanceService = require('../src/services/attendanceService');
const qrTokenService = require('../src/services/qrTokenService');

const testResults = [];

function recordTest(testName, passed, details = '') {
  testResults.push({
    test: testName,
    status: passed ? 'PASS ✅' : 'FAIL ❌',
    details
  });
}

function runQrAttendanceTests() {
  console.log('\n========================================================================================');
  console.log('                  CAMPUSCLUBOS QR ATTENDANCE CHECK-IN TEST SUITE                       ');
  console.log('========================================================================================\n');

  // Seed DB fresh
  seedDatabase();

  const superAdmin = db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN'").get();
  const clubAdmin = db.prepare("SELECT * FROM users WHERE email = 'clubadmin@campus.edu'").get();
  const faculty1 = db.prepare("SELECT * FROM users WHERE email = 'faculty.mentor@campus.edu'").get();
  const student1 = db.prepare("SELECT * FROM users WHERE email = 'student1@campus.edu'").get();
  const student2 = db.prepare("SELECT * FROM users WHERE email = 'student2@campus.edu'").get();
  const codingClub = db.prepare("SELECT * FROM clubs WHERE code = 'CODE01'").get();

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // Create Event 1 (Ongoing Event)
  const event1 = eventService.createEvent(clubAdmin, codingClub.id, {
    title: 'Hackathon QR Workshop',
    description: 'Testing QR attendance',
    venue: 'Auditorium A',
    event_date: todayStr,
    start_time: '23:45',
    end_time: '23:55',
    capacity: 100
  });
  eventService.transition(event1.id, 'submit', clubAdmin);
  eventService.transition(event1.id, 'approve', faculty1);
  // Register Student 1 for Event 1 (while APPROVED)
  registrationService.register(event1.id, student1.id);

  // Now transition Event 1 to ONGOING
  eventService.transition(event1.id, 'start', clubAdmin);

  // Create Event 2 (Approved Event - Not Ongoing)
  const event2 = eventService.createEvent(clubAdmin, codingClub.id, {
    title: 'Future Tech Seminar',
    description: 'Not started event',
    venue: 'Seminar Hall 2',
    event_date: todayStr,
    start_time: '14:00',
    end_time: '16:00',
    capacity: 50
  });
  eventService.transition(event2.id, 'submit', clubAdmin);
  eventService.transition(event2.id, 'approve', faculty1); // Event 2 is APPROVED (not ONGOING)

  // Register Student 1 for Event 2 (while APPROVED)
  registrationService.register(event2.id, student1.id);

  // ------------------------------------------------------------------------
  // TEST 1: Valid token works & marks PRESENT with method='QR'
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 1] Verifying valid token check-in...');
    const validToken = qrTokenService.generateToken(event1.id);
    const verification = qrTokenService.verifyToken(validToken, event1.id);
    if (!verification.valid) throw new Error(`Token verification failed: ${verification.reason}`);

    const record = attendanceService.markAttendance(event1.id, student1.id, 'PRESENT', student1, 'QR');
    const dbRecord = db.prepare('SELECT * FROM attendance WHERE event_id = ? AND student_user_id = ?').get(event1.id, student1.id);

    const pass = dbRecord && dbRecord.status === 'PRESENT' && dbRecord.method === 'QR';
    recordTest('1. Valid token works & sets status=PRESENT and method=QR', pass, `Recorded method: ${dbRecord ? dbRecord.method : 'NONE'}`);
  } catch (err) {
    recordTest('1. Valid token works & sets status=PRESENT and method=QR', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 2: Expired token rejected
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 2] Verifying expired token rejection...');
    const oldWindowIndex = qrTokenService.getCurrentWindow() - 5; // 5 windows ago (> 100 seconds old)
    const expiredToken = qrTokenService.generateToken(event1.id, oldWindowIndex);
    const verification = qrTokenService.verifyToken(expiredToken, event1.id);

    const pass = !verification.valid && verification.reason.includes('expired');
    recordTest('2. Expired token (>60s) rejected', pass, verification.reason || 'Verification allowed expired token');
  } catch (err) {
    recordTest('2. Expired token (>60s) rejected', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 3: Tampered token rejected
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 3] Verifying tampered token signature rejection...');
    const validToken = qrTokenService.generateToken(event1.id);
    const parts = validToken.split('.');
    const tamperedToken = `${parts[0]}.${parts[1]}.0000000000000000000000000000000000000000000000000000000000000000`;
    const verification = qrTokenService.verifyToken(tamperedToken, event1.id);

    const pass = !verification.valid && verification.reason.includes('signature');
    recordTest('3. Tampered token signature rejected', pass, verification.reason || 'Verification allowed tampered token');
  } catch (err) {
    recordTest('3. Tampered token signature rejected', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 4: Token for another event rejected
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 4] Verifying token generated for Event 2 fails when scanned for Event 1...');
    const tokenEvent2 = qrTokenService.generateToken(event2.id);
    const verification = qrTokenService.verifyToken(tokenEvent2, event1.id); // Validating against Event 1

    const pass = !verification.valid && verification.reason.includes('another event');
    recordTest('4. Token for another event rejected', pass, verification.reason || 'Verification allowed token for wrong event');
  } catch (err) {
    recordTest('4. Token for another event rejected', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 5: Unregistered student rejected
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 5] Verifying unregistered student check-in rejection...');
    // Student 2 is NOT registered for Event 1
    attendanceService.markAttendance(event1.id, student2.id, 'PRESENT', student2, 'QR');
    recordTest('5. Unregistered student check-in rejected', false, 'Allowed unregistered student to check in');
  } catch (err) {
    const pass = err.statusCode === 400 && err.message.includes('not registered');
    recordTest('5. Unregistered student check-in rejected', pass, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 6: Non-student roles rejected
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 6] Verifying non-student role check-in rejection...');
    // Faculty user scanning QR for themselves
    attendanceService.markAttendance(event1.id, faculty1.id, 'PRESENT', faculty1, 'QR');
    recordTest('6. Non-student roles check-in rejected', false, 'Allowed faculty account to self check in');
  } catch (err) {
    const pass = (err.statusCode === 403 || err.statusCode === 400);
    recordTest('6. Non-student roles check-in rejected', pass, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 7: Event not ongoing rejected
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 7] Verifying event not ongoing check-in rejection...');
    // Event 2 is APPROVED (not ONGOING)
    attendanceService.markAttendance(event2.id, student1.id, 'PRESENT', student1, 'QR');
    recordTest('7. Event not ongoing check-in rejected', false, 'Allowed check-in on non-ongoing event');
  } catch (err) {
    const pass = err.statusCode === 400 && err.message.includes('ONGOING');
    recordTest('7. Event not ongoing check-in rejected', pass, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 8: Double scan idempotent
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 8] Verifying double scan idempotency...');
    // Scan #1 was performed in TEST 1.
    // Perform Scan #2 as Student 1 for Event 1
    const record2 = attendanceService.markAttendance(event1.id, student1.id, 'PRESENT', student1, 'QR');
    const dbRecord2 = db.prepare('SELECT * FROM attendance WHERE event_id = ? AND student_user_id = ?').get(event1.id, student1.id);

    const pass = dbRecord2 && dbRecord2.status === 'PRESENT' && dbRecord2.method === 'QR';
    recordTest('8. Double scan idempotent (scanning twice is harmless)', pass, `Status: ${dbRecord2.status}, Method: ${dbRecord2.method}`);
  } catch (err) {
    recordTest('8. Double scan idempotent (scanning twice is harmless)', false, err.message);
  }

  // Summary
  console.log('\n========================================================================================');
  console.log('                      QR ATTENDANCE TEST RESULTS SUMMARY                                ');
  console.log('========================================================================================\n');
  console.table(testResults);

  const hasFailures = testResults.some(r => r.status.includes('FAIL'));
  if (hasFailures) {
    console.error('\n❌ QR ATTENDANCE TESTS FAILED! Exit Code 1\n');
    process.exit(1);
  } else {
    console.log('\n✅ ALL 8 QR ATTENDANCE TEST SCENARIOS PASSED! Exit Code 0\n');
  }
}

if (require.main === module) {
  runQrAttendanceTests();
}

module.exports = { runQrAttendanceTests };
