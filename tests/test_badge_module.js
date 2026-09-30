const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const eventService = require('../src/services/eventService');
const registrationService = require('../src/services/registrationService');
const attendanceService = require('../src/services/attendanceService');
const certificateService = require('../src/services/certificateService');
const badgeService = require('../src/services/badgeService');

const testResults = [];

function recordTest(testName, passed, details = '') {
  testResults.push({
    test: testName,
    status: passed ? 'PASS ✅' : 'FAIL ❌',
    details
  });
}

function runBadgeUnitTests() {
  console.log('\n========================================================================================');
  console.log('                   CAMPUSCLUBOS BADGES & PROFILE TEST SUITE                             ');
  console.log('========================================================================================\n');

  // Seed DB fresh
  seedDatabase();

  const superAdmin = db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN'").get();
  const clubAdmin = db.prepare("SELECT * FROM users WHERE email = 'clubadmin@campus.edu'").get();
  const faculty1 = db.prepare("SELECT * FROM users WHERE email = 'faculty.mentor@campus.edu'").get();
  const student1 = db.prepare("SELECT * FROM users WHERE email = 'student1@campus.edu'").get();
  const student2 = db.prepare("SELECT * FROM users WHERE email = 'student2@campus.edu'").get();
  const codingClub = db.prepare("SELECT * FROM clubs WHERE code = 'CODE01'").get();

  // Create Foreign Club Admin & Foreign Club for cross-club test
  const resForeignAdmin = db.prepare(`
    INSERT INTO users (email, password_hash, full_name, role)
    VALUES ('foreignadmin2@campus.edu', '$2b$10$abcdefghijklmnopqrstuu', 'Foreign Club Admin', 'CLUB_ADMIN')
  `).run();
  const foreignAdmin = db.prepare('SELECT * FROM users WHERE id = ?').get(resForeignAdmin.lastInsertRowid);

  const resForeignClub = db.prepare(`
    INSERT INTO clubs (name, code, description, category, club_admin_id, created_by)
    VALUES ('Robotics Club 2', 'ROBO02', 'Robotics Club', 'Technical', ?, ?)
  `).run(foreignAdmin.id, superAdmin.id);
  const foreignClubId = resForeignClub.lastInsertRowid;

  // Create custom badge for Coding Club
  const codingClubBadge = badgeService.createBadgeType(codingClub.id, {
    name: 'Top Coder 2026',
    description: 'Awarded for winning coding competition',
    icon_name: 'trophy'
  }, clubAdmin);

  // Create custom badge for Robotics Club
  const foreignClubBadge = badgeService.createBadgeType(foreignClubId, {
    name: 'Robo Builder',
    description: 'Awarded for robotics workshop',
    icon_name: 'shield'
  }, foreignAdmin);

  // ------------------------------------------------------------------------
  // TEST 1: Forbidden role cannot award badge (Student 1 trying to award)
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 1] Verifying refusal when forbidden role attempts to award badge...');
    badgeService.award(codingClubBadge.id, student2.id, student1, 'Self award attempt');
    recordTest('1. Forbidden role cannot award badge (403)', false, 'Allowed student to award badge');
  } catch (err) {
    const pass = err.statusCode === 403 && err.message.includes('AWARD_BADGE');
    recordTest('1. Forbidden role cannot award badge (403)', pass, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 2: Cross-club award refused (Coding Club admin trying to award Robotics Club badge)
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 2] Verifying cross-club badge award refusal...');
    badgeService.award(foreignClubBadge.id, student1.id, clubAdmin, 'Cross club award attempt');
    recordTest('2. Cross-club award refused (403)', false, 'Allowed cross-club admin to award badge');
  } catch (err) {
    const pass = err.statusCode === 403 && err.message.includes('AWARD_BADGE');
    recordTest('2. Cross-club award refused (403)', pass, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 3: Duplicate badge award prevented idempotently
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 3] Verifying duplicate badge award prevention...');
    const award1 = badgeService.award(codingClubBadge.id, student1.id, clubAdmin, 'First award');
    const award2 = badgeService.award(codingClubBadge.id, student1.id, clubAdmin, 'Second award');

    const count = db.prepare('SELECT COUNT(*) as count FROM student_badges WHERE badge_id = ? AND student_user_id = ?').get(codingClubBadge.id, student1.id).count;

    const pass = award1.id === award2.id && count === 1;
    recordTest('3. Duplicate badge awards prevented idempotently (Single row maintained)', pass, `Total Rows: ${count}`);
  } catch (err) {
    recordTest('3. Duplicate badge awards prevented idempotently (Single row maintained)', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 4: Automatic badges trigger exactly once ("First Event" and "3-Event Streak")
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 4] Verifying automatic milestone badges trigger upon attendance marking...');
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    // Create 3 events and mark Student 1 PRESENT in all 3
    for (let i = 1; i <= 3; i++) {
      const e = eventService.createEvent(clubAdmin, codingClub.id, {
        title: `Auto Badge Event ${i}`,
        description: `Testing auto badges ${i}`,
        venue: `Lab ${i}`,
        event_date: todayStr,
        start_time: '23:45',
        end_time: '23:55',
        capacity: 50
      });
      eventService.transition(e.id, 'submit', clubAdmin);
      eventService.transition(e.id, 'approve', faculty1);
      registrationService.register(e.id, student1.id);
      eventService.transition(e.id, 'start', clubAdmin);
      attendanceService.markAttendance(e.id, student1.id, 'PRESENT', clubAdmin, 'QR');
    }

    const studentProfile = badgeService.getStudentProfile(student1.id);
    const badgeNames = studentProfile.badgesEarned.map(b => b.badge_name);

    const hasFirstEvent = badgeNames.includes('First Event');
    const hasStreak = badgeNames.includes('3-Event Streak');

    const pass = hasFirstEvent && hasStreak && studentProfile.metrics.eventsAttendedCount === 3;
    recordTest('4. Automatic milestone badges ("First Event" & "3-Event Streak") trigger exactly once', pass, `Badges earned: ${badgeNames.join(', ')}`);
  } catch (err) {
    recordTest('4. Automatic milestone badges ("First Event" & "3-Event Streak") trigger exactly once', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 5: Notification created for each badge award
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 5] Verifying BADGE notification dispatch...');
    const notifs = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'BADGE'").all(student1.id);
    const pass = notifs.length >= 2;
    recordTest('5. System notification (type BADGE) created for each award', pass, `Notification Count: ${notifs.length}`);
  } catch (err) {
    recordTest('5. System notification (type BADGE) created for each award', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 6: Revoked badge disappears from profile
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 6] Verifying revoked badge removal from student profile...');
    const initialProfile = badgeService.getStudentProfile(student1.id);
    const awardToRevoke = initialProfile.badgesEarned.find(b => b.badge_name === 'Top Coder 2026');

    badgeService.revokeBadge(awardToRevoke.student_badge_id, clubAdmin, 'Revoking test award');

    const updatedProfile = badgeService.getStudentProfile(student1.id);
    const remainingNames = updatedProfile.badgesEarned.map(b => b.badge_name);

    const pass = !remainingNames.includes('Top Coder 2026');
    recordTest('6. Revoked badge disappears from student profile', pass, `Remaining badges: ${remainingNames.join(', ')}`);
  } catch (err) {
    recordTest('6. Revoked badge disappears from student profile', false, err.message);
  }

  // Summary
  console.log('\n========================================================================================');
  console.log('                    BADGE & PROFILE TEST RESULTS SUMMARY                                ');
  console.log('========================================================================================\n');
  console.table(testResults);

  const hasFailures = testResults.some(r => r.status.includes('FAIL'));
  if (hasFailures) {
    console.error('\n❌ BADGE & PROFILE TESTS FAILED! Exit Code 1\n');
    process.exit(1);
  } else {
    console.log('\n✅ ALL 6 BADGE & PROFILE TEST SCENARIOS PASSED! Exit Code 0\n');
  }
}

if (require.main === module) {
  runBadgeUnitTests();
}

module.exports = { runBadgeUnitTests };
