const db = require('../src/db/index');
const analyticsService = require('../src/services/analyticsService');

console.log('====================================================');
console.log('      ANALYTICS SERVICE SUITE TEST HARNESS        ');
console.log('====================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  [PASS] Test ${totalTests}: ${message}`);
    passedTests++;
  } else {
    console.error(`❌ [FAIL] Test ${totalTests}: ${message}`);
    process.exitCode = 1;
  }
}

try {
  // --------------------------------------------------------------------------
  // SETUP TEST DATASET
  // --------------------------------------------------------------------------
  console.log('--- Setting up isolated test dataset ---');

  // Cleanup any old test rows
  db.prepare("DELETE FROM attendance WHERE event_id IN (951, 952, 953)").run();
  db.prepare("DELETE FROM certificates WHERE event_id IN (951, 952, 953)").run();
  db.prepare("DELETE FROM student_badges WHERE badge_id = 991").run();
  db.prepare("DELETE FROM badges WHERE id = 991").run();
  db.prepare("DELETE FROM od_requests WHERE id = 995").run();
  db.prepare("DELETE FROM event_registrations WHERE id IN (981, 982)").run();
  db.prepare("DELETE FROM events WHERE id IN (951, 952, 953)").run();
  db.prepare("DELETE FROM club_memberships WHERE club_id IN (901, 902)").run();
  db.prepare("DELETE FROM clubs WHERE id IN (901, 902)").run();
  db.prepare("DELETE FROM students WHERE user_id IN (806, 807)").run();
  db.prepare("DELETE FROM faculty WHERE user_id = 805").run();
  db.prepare("DELETE FROM users WHERE id BETWEEN 801 AND 807").run();

  // Insert Users
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role) VALUES (801, 'sa_analytics@test.edu', 'hash', 'Super Admin Test', 'SUPER_ADMIN')").run();
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role) VALUES (802, 'admin_analytics@test.edu', 'hash', 'Admin Test', 'ADMIN')").run();
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role) VALUES (803, 'ca1_analytics@test.edu', 'hash', 'Club 1 Admin', 'CLUB_ADMIN')").run();
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role) VALUES (804, 'ca2_analytics@test.edu', 'hash', 'Club 2 Admin', 'CLUB_ADMIN')").run();
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role) VALUES (805, 'mentor_analytics@test.edu', 'hash', 'Faculty Mentor', 'FACULTY')").run();
  db.prepare("INSERT OR IGNORE INTO faculty (user_id, department, designation) VALUES (805, 'CSE', 'Assistant Professor')").run();
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role) VALUES (806, 'stud1_analytics@test.edu', 'hash', 'Student Alpha', 'STUDENT')").run();
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role) VALUES (807, 'stud2_analytics@test.edu', 'hash', 'Student Beta', 'STUDENT')").run();

  // Insert Students
  db.prepare("INSERT OR IGNORE INTO students (user_id, ra_number, department, section, year_of_study, class_mentor_id) VALUES (806, 'RA1234567890123', 'CSE', 'A', 3, 805)").run();
  db.prepare("INSERT OR IGNORE INTO students (user_id, ra_number, department, section, year_of_study, class_mentor_id) VALUES (807, 'RA9876543210987', 'ECE', 'B', 2, 805)").run();

  // Insert Clubs (Club 901 = Active, Club 902 = Zero Events Club)
  db.prepare("INSERT OR IGNORE INTO clubs (id, name, code, description, category, club_admin_id, created_by) VALUES (901, 'Alpha Analytics Club', 'AAC901', 'Test Club 1', 'TECHNICAL', 803, 801)").run();
  db.prepare("INSERT OR IGNORE INTO clubs (id, name, code, description, category, club_admin_id, created_by) VALUES (902, 'Zero Event Club', 'ZEC902', 'Test Club 2', 'CULTURAL', 804, 801)").run();

  // Insert Club Memberships
  db.prepare("INSERT OR IGNORE INTO club_memberships (club_id, user_id, status) VALUES (901, 806, 'APPROVED')").run();
  db.prepare("INSERT OR IGNORE INTO club_memberships (club_id, user_id, status) VALUES (901, 807, 'APPROVED')").run();

  // Insert Events for Club 901
  // Event 951: Created as APPROVED so trigger allows registrations, then transitioned to COMPLETED
  db.prepare("INSERT OR IGNORE INTO events (id, club_id, title, description, venue, event_date, start_time, end_time, capacity, status, created_by) VALUES (951, 901, 'Completed Event 1', 'Desc', 'Hall A', '2026-10-10', '10:00', '12:00', 50, 'APPROVED', 803)").run();

  // Event 952: COMPLETED, 0 registrations (Zero reg completed event)
  db.prepare("INSERT OR IGNORE INTO events (id, club_id, title, description, venue, event_date, start_time, end_time, capacity, status, created_by) VALUES (952, 901, 'Completed Event 0 Reg', 'Desc', 'Hall B', '2026-10-11', '14:00', '16:00', 50, 'COMPLETED', 803)").run();

  // Event 953: PENDING_APPROVAL
  db.prepare("INSERT OR IGNORE INTO events (id, club_id, title, description, venue, event_date, start_time, end_time, capacity, status, created_by) VALUES (953, 901, 'Pending Event', 'Desc', 'Hall C', '2026-10-12', '10:00', '12:00', 50, 'PENDING_APPROVAL', 803)").run();

  // Registrations for Event 951
  db.prepare("INSERT OR IGNORE INTO event_registrations (id, event_id, student_user_id) VALUES (981, 951, 806)").run();
  db.prepare("INSERT OR IGNORE INTO event_registrations (id, event_id, student_user_id) VALUES (982, 951, 807)").run();

  // Transition Event 951 to COMPLETED after registrations are in place
  db.prepare("UPDATE events SET status = 'COMPLETED' WHERE id = 951").run();

  // Attendance for Event 951 (Student 806 = PRESENT)
  db.prepare("INSERT OR IGNORE INTO attendance (event_id, student_user_id, status, method, marked_by) VALUES (951, 806, 'PRESENT', 'MANUAL', 803)").run();

  // Insert Certificate for Student 806
  db.prepare("INSERT OR IGNORE INTO certificates (certificate_uuid, event_id, student_user_id, role_type, verification_hash, issued_by) VALUES ('CERT-UUID-901', 951, 806, 'PARTICIPANT', 'HASH901', 803)").run();

  // Insert Badge for Student 806
  db.prepare("INSERT OR IGNORE INTO badges (id, club_id, name, description, icon_name) VALUES (991, 901, 'Test Club Badge', 'Desc', 'star')").run();
  db.prepare("INSERT OR IGNORE INTO student_badges (badge_id, student_user_id, awarded_by) VALUES (991, 806, 803)").run();

  // Insert OD Requests for Student 807 (Only Pending ODs to test 0 decided OD rate edge case)
  db.prepare("INSERT OR IGNORE INTO od_requests (id, registration_id, student_user_id, class_mentor_id, status) VALUES (995, 982, 807, 805, 'PENDING')").run();

  const superUser = { id: 801, role: 'SUPER_ADMIN' };
  const adminUser = { id: 802, role: 'ADMIN' };
  const ca1User = { id: 803, role: 'CLUB_ADMIN' };
  const ca2User = { id: 804, role: 'CLUB_ADMIN' };
  const mentorUser = { id: 805, role: 'FACULTY' };
  const student1User = { id: 806, role: 'STUDENT' };
  const student2User = { id: 807, role: 'STUDENT' };

  console.log('--- Executing Metric Assertions ---\n');

  // --------------------------------------------------------------------------
  // TEST 1: Club 901 Analytics (Hand-computed values)
  // Approved members: 2, Completed Events: 2, Total Registrations: 2
  // Event 951 turnout = 1/2 = 50%, Event 952 turnout = 0/0 = 0% -> Avg = 25.0%
  // --------------------------------------------------------------------------
  const club1Metrics = analyticsService.getClubAnalytics(901, ca1User);
  assert(club1Metrics.memberCount === 2, 'Club 901 member count equals 2');
  assert(club1Metrics.completedEventsCount === 2, 'Club 901 completed events equals 2');
  assert(club1Metrics.totalRegistrations === 2, 'Club 901 total registrations equals 2');
  assert(club1Metrics.avgAttendanceRate === 25.0, `Club 901 average attendance rate equals 25.0% (actual: ${club1Metrics.avgAttendanceRate})`);
  assert(club1Metrics.certificatesIssued === 1, 'Club 901 certificates issued equals 1');
  assert(club1Metrics.badgesAwarded === 1, 'Club 901 badges awarded equals 1');

  // --------------------------------------------------------------------------
  // TEST 2: Zero Event Club (Club 902)
  // --------------------------------------------------------------------------
  const club2Metrics = analyticsService.getClubAnalytics(902, ca2User);
  assert(club2Metrics.completedEventsCount === 0, 'Club 902 completed events equals 0');
  assert(club2Metrics.totalRegistrations === 0, 'Club 902 total registrations equals 0');
  assert(club2Metrics.avgAttendanceRate === 0.0, 'Club 902 average attendance rate is safely 0.0 (no NaN)');

  // --------------------------------------------------------------------------
  // TEST 3: Student 806 Analytics
  // --------------------------------------------------------------------------
  const stud1Metrics = analyticsService.getStudentAnalytics(806, student1User);
  assert(stud1Metrics.eventsAttended === 1, 'Student 806 events attended equals 1');
  assert(stud1Metrics.registrationsCount === 1, 'Student 806 registrations equals 1');
  assert(stud1Metrics.certificatesCount === 1, 'Student 806 certificates equals 1');

  // --------------------------------------------------------------------------
  // TEST 4: Student 807 Edge Case (Only Pending ODs -> 0 decided ODs)
  // --------------------------------------------------------------------------
  const stud2Metrics = analyticsService.getStudentAnalytics(807, student2User);
  assert(stud2Metrics.odTotalRequests === 1, 'Student 807 total OD requests equals 1');
  assert(stud2Metrics.odDecidedCount === 0, 'Student 807 decided OD requests equals 0');
  assert(stud2Metrics.odApprovalRate === 0.0, 'Student 807 OD approval rate is safely 0.0% when 0 requests decided');

  // --------------------------------------------------------------------------
  // TEST 5: Cross-Tenant Authorization Checks
  // Club Admin 804 attempting to access Club 901 analytics -> 403
  // --------------------------------------------------------------------------
  try {
    analyticsService.getClubAnalytics(901, ca2User);
    assert(false, 'Club Admin 804 should be denied access to Club 901');
  } catch (err) {
    assert(err.statusCode === 403, 'Unauthorized club analytics request returns 403 Forbidden');
  }

  // --------------------------------------------------------------------------
  // TEST 6: Student attempting to access another student's analytics -> 403
  // --------------------------------------------------------------------------
  try {
    analyticsService.getStudentAnalytics(806, student2User);
    assert(false, 'Student 807 should be denied access to Student 806 analytics');
  } catch (err) {
    assert(err.statusCode === 403, 'Unauthorized student analytics request returns 403 Forbidden');
  }

  // --------------------------------------------------------------------------
  // TEST 7: Admin Analytics & Cross-Club Table
  // --------------------------------------------------------------------------
  const adminMetrics = analyticsService.getAdminAnalytics(adminUser);
  assert(Array.isArray(adminMetrics.clubsComparison), 'Admin metrics includes cross-club comparison array');
  assert(adminMetrics.pendingQueue.pendingEventsCount >= 1, 'Pending queue correctly tracks pending events');

  // --------------------------------------------------------------------------
  // TEST 8: Super Admin Analytics
  // --------------------------------------------------------------------------
  const superMetrics = analyticsService.getSuperAdminAnalytics(superUser);
  assert(Array.isArray(superMetrics.platformTotals.usersByRole), 'Super admin metrics contains users by role total');
  assert(Array.isArray(superMetrics.recentAuditLogs), 'Super admin metrics contains recent audit log stream');

  console.log(`\n====================================================`);
  console.log(`RESULTS: ${passedTests}/${totalTests} TESTS PASSED CLEANLY`);
  console.log(`====================================================\n`);

} catch (globalErr) {
  console.error('CRITICAL SUITE ERROR:', globalErr);
  process.exit(1);
}
