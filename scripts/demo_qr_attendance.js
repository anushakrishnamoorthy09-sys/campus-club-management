const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const eventService = require('../src/services/eventService');
const registrationService = require('../src/services/registrationService');
const attendanceService = require('../src/services/attendanceService');
const qrTokenService = require('../src/services/qrTokenService');

function runDemo() {
  console.log('\n========================================================================================');
  console.log('                 CAMPUSCLUBOS QR ATTENDANCE END-TO-END DEMONSTRATION                   ');
  console.log('========================================================================================\n');

  // Seed DB fresh
  seedDatabase();

  const clubAdmin = db.prepare("SELECT * FROM users WHERE email = 'clubadmin@campus.edu'").get();
  const faculty1 = db.prepare("SELECT * FROM users WHERE email = 'faculty.mentor@campus.edu'").get();
  const student1 = db.prepare("SELECT * FROM users WHERE email = 'student1@campus.edu'").get();
  const codingClub = db.prepare("SELECT * FROM clubs WHERE code = 'CODE01'").get();

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  console.log('1. Club Admin creates and submits event...');
  const event = eventService.createEvent(clubAdmin, codingClub.id, {
    title: 'Hackathon 2026 Opening Ceremony',
    description: 'Annual flagship hackathon live checkin',
    venue: 'Main Auditorium',
    event_date: todayStr,
    start_time: '23:45',
    end_time: '23:55',
    capacity: 200
  });
  eventService.transition(event.id, 'submit', clubAdmin);

  console.log('2. Faculty Coordinator approves event...');
  eventService.transition(event.id, 'approve', faculty1);

  console.log('3. Student 1 registers for the event...');
  registrationService.register(event.id, student1.id);

  console.log('4. Club Admin starts the event (Status: ONGOING)...');
  const ongoingEvent = eventService.transition(event.id, 'start', clubAdmin);
  console.log(`   -> Event #${ongoingEvent.id} '${ongoingEvent.title}' status is now: ${ongoingEvent.status}`);

  console.log('5. Club Admin opens /club/events/:id/checkin (Generates dynamic QR Token)...');
  const token = qrTokenService.generateToken(ongoingEvent.id);
  const checkinUrl = `http://localhost:3000/checkin?t=${token}`;
  console.log(`   -> Live QR Target URL: ${checkinUrl}`);

  console.log('\n6. Student 1 scans QR code (Opening GET /checkin?t=... as Student 1)...');
  const attRecord = attendanceService.markAttendance(ongoingEvent.id, student1.id, 'PRESENT', student1, 'QR');
  console.log(`   -> Check-in Successful! Status: ${attRecord.status}, Method: ${attRecord.method}, Marked At: ${attRecord.marked_at}`);

  console.log('\n7. Polling live attendance roster (/club/events/:id/checkin/qr)...');
  const roster = db.prepare(`
    SELECT att.marked_at, att.method, u.full_name as student_name, s.ra_number, s.department
    FROM attendance att
    JOIN students s ON att.student_user_id = s.user_id
    JOIN users u ON s.user_id = u.id
    WHERE att.event_id = ? AND att.status = 'PRESENT'
    ORDER BY att.marked_at DESC
  `).all(ongoingEvent.id);

  const presentCount = db.prepare("SELECT COUNT(*) as count FROM attendance WHERE event_id = ? AND status = 'PRESENT'").get(ongoingEvent.id).count;
  const totalRegistered = db.prepare('SELECT COUNT(*) as count FROM event_registrations WHERE event_id = ?').get(ongoingEvent.id).count;

  console.log(`   -> Total Registered: ${totalRegistered} | Total Present: ${presentCount}`);
  console.log('   -> Live Check-ins Stream:');
  console.table(roster);

  console.log('\n========================================================================================');
  console.log('                           DEMO COMPLETED SUCCESSFULLY!                                 ');
  console.log('========================================================================================\n');
}

if (require.main === module) {
  runDemo();
}

module.exports = { runDemo };
