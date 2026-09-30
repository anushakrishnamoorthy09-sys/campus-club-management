const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const eventService = require('../src/services/eventService');
const registrationService = require('../src/services/registrationService');
const attendanceService = require('../src/services/attendanceService');

const unitTestResults = [];

function recordTest(testName, passed, details = '') {
  unitTestResults.push({
    test: testName,
    status: passed ? 'PASS ✅' : 'FAIL ❌',
    details: details
  });
}

function runAttendanceUnitTests() {
  console.log('\n========================================================================================');
  console.log('                   CAMPUSCLUBOS ATTENDANCE DOMAIN UNIT TEST SUITE                       ');
  console.log('========================================================================================\n');

  // Seed DB fresh
  seedDatabase();

  const superAdmin = db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN'").get();
  const clubAdmin = db.prepare("SELECT * FROM users WHERE email = 'clubadmin@campus.edu'").get();
  const faculty1 = db.prepare("SELECT * FROM users WHERE email = 'faculty.mentor@campus.edu'").get();
  const student1 = db.prepare("SELECT * FROM users WHERE email = 'student1@campus.edu'").get();
  const student2 = db.prepare("SELECT * FROM users WHERE email = 'student2@campus.edu'").get();
  const codingClub = db.prepare("SELECT * FROM clubs WHERE code = 'CODE01'").get();

  // Create secondary student for testing
  const resStudent3 = db.prepare(`
    INSERT INTO users (email, password_hash, full_name, role)
    VALUES ('student3@campus.edu', '$2b$10$abcdefghijklmnopqrstuu', 'Student Three', 'STUDENT')
  `).run();
  const student3Id = resStudent3.lastInsertRowid;
  db.prepare(`
    INSERT INTO students (user_id, ra_number, department, year_of_study, section, class_mentor_id)
    VALUES (?, 'RA2311003010003', 'CSE', 2, 'A', ?)
  `).run(student3Id, faculty1.id);
  const student3 = db.prepare('SELECT * FROM users WHERE id = ?').get(student3Id);

  // Create another club & foreign club admin for cross-club scope testing
  const resForeignAdmin = db.prepare(`
    INSERT INTO users (email, password_hash, full_name, role)
    VALUES ('foreignadmin@campus.edu', '$2b$10$abcdefghijklmnopqrstuu', 'Foreign Club Admin', 'CLUB_ADMIN')
  `).run();
  const foreignAdminId = resForeignAdmin.lastInsertRowid;
  const foreignAdmin = db.prepare('SELECT * FROM users WHERE id = ?').get(foreignAdminId);

  const resForeignClub = db.prepare(`
    INSERT INTO clubs (name, code, description, category, club_admin_id, created_by)
    VALUES ('Robotics Club', 'ROBO01', 'Robotics and AI Club', 'Technical', ?, ?)
  `).run(foreignAdminId, superAdmin.id);
  const foreignClubId = resForeignClub.lastInsertRowid;

  // Create dynamic role without MARK_ATTENDANCE permission
  const resRole = db.prepare(`
    INSERT INTO club_roles (club_id, role_name, description)
    VALUES (?, 'Publicity Lead', 'Manages posters only')
  `).run(codingClub.id);
  const publicityRoleId = resRole.lastInsertRowid;

  // Assign Student 2 to Publicity Lead role in Coding Club
  db.prepare(`
    UPDATE club_memberships SET club_role_id = ? WHERE club_id = ? AND user_id = ?
  `).run(publicityRoleId, codingClub.id, student2.id);

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // ------------------------------------------------------------------------
  // Setup Fixture Event
  // ------------------------------------------------------------------------
  const fixtureEvent = eventService.createEvent(clubAdmin, codingClub.id, {
    title: 'Attendance Test Workshop',
    description: 'Testing attendance marking rules',
    venue: 'Lab 4',
    event_date: todayStr,
    start_time: '23:45',
    end_time: '23:55',
    capacity: 50
  });
  eventService.transition(fixtureEvent.id, 'submit', clubAdmin);
  eventService.transition(fixtureEvent.id, 'approve', faculty1);

  // Register Student 1 and Student 3 for fixture event
  registrationService.register(fixtureEvent.id, student1.id);
  registrationService.register(fixtureEvent.id, student3.id);

  // ------------------------------------------------------------------------
  // 1. CANNOT MARK BEFORE ONGOING (APPROVED STATUS)
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 1] Verifying marking refusal on APPROVED event...');
    attendanceService.markAttendance(fixtureEvent.id, student1.id, 'PRESENT', clubAdmin);
    recordTest('1. Refuse attendance marking before ONGOING', false, 'Allowed marking while status was APPROVED');
  } catch (err) {
    const pass = err.statusCode === 400 && err.message.includes('Attendance can only be marked while event is ONGOING or COMPLETED');
    recordTest('1. Refuse attendance marking before ONGOING', pass, err.message);
  }

  // Move event status to ONGOING
  eventService.transition(fixtureEvent.id, 'start', clubAdmin);

  // ------------------------------------------------------------------------
  // 2. CANNOT MARK UNREGISTERED STUDENT
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 2] Verifying marking refusal for unregistered student...');
    attendanceService.markAttendance(fixtureEvent.id, student2.id, 'PRESENT', clubAdmin);
    recordTest('2. Refuse marking unregistered student', false, 'Allowed marking unregistered student');
  } catch (err) {
    const pass = err.statusCode === 400 && err.message.includes('Student is not registered for this event');
    recordTest('2. Refuse marking unregistered student', pass, err.message);
  }

  // ------------------------------------------------------------------------
  // 3. DYNAMIC ROLE WITHOUT MARK_ATTENDANCE PERMISSION REFUSED (403)
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 3] Verifying 403 refusal for dynamic role lacking MARK_ATTENDANCE...');
    attendanceService.markAttendance(fixtureEvent.id, student1.id, 'PRESENT', student2);
    recordTest('3. Refuse dynamic role lacking MARK_ATTENDANCE (403)', false, 'Allowed user without permission');
  } catch (err) {
    const pass = err.statusCode === 403 && err.message.includes('Missing MARK_ATTENDANCE permission');
    recordTest('3. Refuse dynamic role lacking MARK_ATTENDANCE (403)', pass, err.message);
  }

  // ------------------------------------------------------------------------
  // 4. ANOTHER CLUB ADMIN REFUSED (403/404)
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 4] Verifying 403 refusal for another club admin...');
    attendanceService.markAttendance(fixtureEvent.id, student1.id, 'PRESENT', foreignAdmin);
    recordTest('4. Refuse foreign club admin (403)', false, 'Allowed foreign club admin to mark attendance');
  } catch (err) {
    const pass = err.statusCode === 403 && err.message.includes('Missing MARK_ATTENDANCE permission');
    recordTest('4. Refuse foreign club admin (403)', pass, err.message);
  }

  // ------------------------------------------------------------------------
  // 5. COMPLETING EVENT AUTO-MARKS UNMARKED REGISTERED STUDENTS AS ABSENT
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 5] Verifying auto-marking absentees on event completion...');
    // Mark Student 1 as PRESENT explicitly
    attendanceService.markAttendance(fixtureEvent.id, student1.id, 'PRESENT', clubAdmin);

    // Complete the event (Student 3 is registered but unmarked)
    eventService.transition(fixtureEvent.id, 'complete', clubAdmin);

    // Verify Student 1 remains PRESENT
    const att1 = db.prepare('SELECT status FROM attendance WHERE event_id = ? AND student_user_id = ?').get(fixtureEvent.id, student1.id);
    // Verify Student 3 was auto-marked ABSENT
    const att3 = db.prepare('SELECT status FROM attendance WHERE event_id = ? AND student_user_id = ?').get(fixtureEvent.id, student3.id);

    const pass = att1.status === 'PRESENT' && att3.status === 'ABSENT';
    recordTest('5. Completing event auto-marks unmarked registered students as ABSENT', pass, `Student 1 status: ${att1.status}; Student 3 auto-marked status: ${att3.status}`);
  } catch (err) {
    recordTest('5. Completing event auto-marks unmarked registered students as ABSENT', false, err.message);
  }

  // ------------------------------------------------------------------------
  // 6. ATTENDANCE LOCKED AFTER CERTIFICATE ISSUE FOR ABSENT CHANGE
  // ------------------------------------------------------------------------
  try {
    console.log('[UNIT TEST 6] Verifying certificate issuance locks attendance against ABSENT change...');
    // Issue certificate for Student 1
    db.prepare(`
      INSERT INTO certificates (certificate_uuid, event_id, student_user_id, role_type, verification_hash, issued_by)
      VALUES ('CERT-UUID-1001', ?, ?, 'PARTICIPANT', 'HASH-1001', ?)
    `).run(fixtureEvent.id, student1.id, superAdmin.id);

    // Attempt to change Student 1 attendance to ABSENT -> MUST fail
    attendanceService.markAttendance(fixtureEvent.id, student1.id, 'ABSENT', clubAdmin);
    recordTest('6. Attendance status locked after certificate issue for ABSENT change', false, 'Allowed ABSENT change after certificate issued');
  } catch (err) {
    const pass = err.statusCode === 400 && err.message.includes('Cannot mark student ABSENT because a certificate has already been issued');
    recordTest('6. Attendance status locked after certificate issue for ABSENT change', pass, err.message);
  }

  // Summary
  console.log('\n========================================================================================');
  console.log('                      ATTENDANCE DOMAIN UNIT TEST RESULTS                               ');
  console.log('========================================================================================\n');
  console.table(unitTestResults);

  const hasFailures = unitTestResults.some(r => r.status.includes('FAIL'));
  if (hasFailures) {
    console.error('\n❌ ATTENDANCE UNIT TESTS FAILED! Exit Code 1\n');
    process.exit(1);
  } else {
    console.log('\n✅ ALL 6 ATTENDANCE UNIT TEST SCENARIOS PASSED! Exit Code 0\n');
  }
}

if (require.main === module) {
  runAttendanceUnitTests();
}

module.exports = { runAttendanceUnitTests };
