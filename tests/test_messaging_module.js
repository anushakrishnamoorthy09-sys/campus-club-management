const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const messageService = require('../src/services/messageService');

console.log('========================================================================================');
console.log('                   CAMPUSCLUBOS MESSAGING DOMAIN TEST SUITE                             ');
console.log('========================================================================================\n');

let passedCount = 0;
let totalCount = 0;

function assert(condition, message) {
  totalCount++;
  if (condition) {
    console.log(`  [PASS] Test ${totalCount}: ${message}`);
    passedCount++;
  } else {
    console.error(`❌ [FAIL] Test ${totalCount}: ${message}`);
    process.exitCode = 1;
  }
}

try {
  // Seed database fresh
  seedDatabase();

  const superAdmin = db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN'").get();
  const admin = db.prepare("SELECT * FROM users WHERE role = 'ADMIN'").get();
  const faculty1 = db.prepare("SELECT * FROM users WHERE email = 'faculty.mentor@campus.edu'").get();
  const faculty2 = db.prepare("SELECT * FROM users WHERE email = 'faculty.advisor@campus.edu'").get();
  const clubAdmin = db.prepare("SELECT * FROM users WHERE email = 'clubadmin@campus.edu'").get();
  const student1 = db.prepare("SELECT * FROM users WHERE email = 'student1@campus.edu'").get();
  const student2 = db.prepare("SELECT * FROM users WHERE email = 'student2@campus.edu'").get();
  const codingClub = db.prepare("SELECT * FROM clubs WHERE code = 'CODE01'").get();

  // Create Foreign Club and Foreign Coordinator
  const resFcUser = db.prepare("INSERT INTO users (email, password_hash, full_name, role) VALUES ('foreign_coord@campus.edu', 'hash', 'Foreign Coordinator', 'FACULTY')").run();
  const foreignCoord = db.prepare('SELECT * FROM users WHERE id = ?').get(resFcUser.lastInsertRowid);
  db.prepare("INSERT INTO faculty (user_id, department, designation) VALUES (?, 'ECE', 'Assistant Professor')").run(foreignCoord.id);

  const resFc = db.prepare("INSERT INTO clubs (name, code, description, category, club_admin_id, created_by) VALUES ('Foreign Club Msg', 'FCMSG', 'Desc', 'Technical', NULL, ?)").run(superAdmin.id);
  const foreignClubId = resFc.lastInsertRowid;
  db.prepare("INSERT INTO club_coordinators (club_id, faculty_user_id) VALUES (?, ?)").run(foreignClubId, foreignCoord.id);

  // Create Event in Coding Club
  const resEvent = db.prepare("INSERT INTO events (club_id, title, description, venue, event_date, start_time, end_time, capacity, status, created_by) VALUES (?, 'Msg Event', 'Desc', 'Hall A', '2026-10-15', '10:00', '12:00', 50, 'APPROVED', ?)").run(codingClub.id, clubAdmin.id);
  const eventId = resEvent.lastInsertRowid;

  // Create OD Request
  const resOdReg = db.prepare("INSERT INTO event_registrations (event_id, student_user_id) VALUES (?, ?)").run(eventId, student1.id);
  const resOd = db.prepare("INSERT INTO od_requests (registration_id, student_user_id, class_mentor_id, status) VALUES (?, ?, ?, 'PENDING')").run(resOdReg.lastInsertRowid, student1.id, faculty1.id);
  const odId = resOd.lastInsertRowid;

  console.log('--- Executing Messaging Unit & Matrix Assertions ---\n');

  // 1. Student strictly forbidden from accessing any thread -> 404
  try {
    messageService.getOrCreateThread('EVENT', eventId, null, student1);
    assert(false, 'Student should be blocked with 404 on thread access');
  } catch (err) {
    assert(err.statusCode === 404, 'Student receives 404 on thread access attempt');
  }

  // 2. Event Thread Creation & Participant Resolution
  const eventThread = messageService.getOrCreateThread('EVENT', eventId, null, clubAdmin);
  assert(eventThread.context_type === 'EVENT', 'Event thread successfully resolved for Club Admin');

  // 3. Coordinator of another club (foreignCoord) cannot join or read event thread -> 404
  try {
    messageService.listMessages(eventThread.id, foreignCoord);
    assert(false, 'Foreign club coordinator should be blocked with 404');
  } catch (err) {
    assert(err.statusCode === 404, 'Foreign club coordinator receives 404 on event thread');
  }

  // 4. Assigned Faculty Coordinator (faculty1) can access event thread
  const faculty1MsgList = messageService.listMessages(eventThread.id, faculty1);
  assert(Array.isArray(faculty1MsgList.messages), 'Assigned Faculty Coordinator can read event thread');

  // 5. Unassigned Faculty (faculty2) cannot read OD thread -> 404
  const odThread = messageService.getOrCreateThread('OD_REQUEST', odId, null, faculty1);
  try {
    messageService.listMessages(odThread.id, faculty2);
    assert(false, 'Unassigned faculty should be blocked with 404 on OD thread');
  } catch (err) {
    assert(err.statusCode === 404, 'Unassigned faculty receives 404 on OD thread');
  }

  // 6. Student & Club Admin are NOT participants of OD threads
  try {
    messageService.listMessages(odThread.id, clubAdmin);
    assert(false, 'Club Admin should be excluded with 404 from OD thread');
  } catch (err) {
    assert(err.statusCode === 404, 'Club Admin strictly excluded with 404 from OD thread');
  }

  // 7. Direct Thread Deduplication
  const dt1 = messageService.getOrCreateThread('DIRECT', null, faculty2.id, faculty1);
  const dt2 = messageService.getOrCreateThread('DIRECT', null, faculty1.id, faculty2);
  assert(dt1.id === dt2.id, 'Direct threads between same user pair are deduplicated');

  // 8. Posting message trims text, escapes HTML, and triggers notification to other participants
  const testHtmlText = '<script>alert("XSS")</script> Hello Faculty!';
  const postedMsg = messageService.postMessage(eventThread.id, clubAdmin, testHtmlText);
  assert(postedMsg.message_text_escaped.includes('&lt;script&gt;'), 'Message text is properly HTML-escaped');

  const notif = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'MESSAGE'").get(faculty1.id);
  assert(Boolean(notif), 'Posting message dispatches MESSAGE notification to other thread participants');

  console.log(`\n========================================================================================`);
  console.log(`                    MESSAGING TEST RESULTS: ${passedCount}/${totalCount} PASSED`);
  console.log(`========================================================================================\n`);

} catch (globalErr) {
  console.error('CRITICAL MESSAGING TEST ERROR:', globalErr);
  process.exit(1);
}
