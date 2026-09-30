const { seedDatabase } = require('../db/seed');
const db = require('../src/db/index');
const eventService = require('../src/services/eventService');
const registrationService = require('../src/services/registrationService');
const odService = require('../src/services/odService');
const clubRoleService = require('../src/services/clubRoleService');

async function runDemo() {
  // 1. Seed database
  await seedDatabase();

  // Fetch actors after seed
  const clubAdmin = db.prepare("SELECT * FROM users WHERE email = 'clubadmin@campus.edu'").get();
  const facultyCoord = db.prepare("SELECT * FROM users WHERE email = 'faculty.mentor@campus.edu'").get();
  const student1 = db.prepare("SELECT * FROM users WHERE email = 'student1@campus.edu'").get();
  const club = db.prepare("SELECT * FROM clubs LIMIT 1").get();
  const role = db.prepare("SELECT * FROM club_roles WHERE club_id = ? LIMIT 1").get(club.id);

  console.log('\n=== RUNNING FULL LIVE DEMONSTRATION WORKFLOW ===\n');

  // 1. Submit Event
  console.log('Step 1: Club Admin creates & submits event...');
  const createdEvt = eventService.createEvent(clubAdmin, club.id, {
    title: 'Full Notification Lifecycle Hackathon',
    description: 'Annual coding hackathon event for notifications audit',
    venue: 'Tech Park Auditorium A',
    event_date: '2026-10-15',
    start_time: '09:00',
    end_time: '17:00',
    capacity: 50
  });

  const submittedEvt = eventService.transition(createdEvt.id, 'submit', clubAdmin);
  console.log(` -> Event '${submittedEvt.title}' submitted (Status: ${submittedEvt.status})\n`);

  // 2. Approve Event
  console.log('Step 2: Faculty Coordinator approves event...');
  const approvedEvt = eventService.transition(submittedEvt.id, 'approve', facultyCoord);
  console.log(` -> Event '${approvedEvt.title}' approved (Status: ${approvedEvt.status})\n`);

  // 3. Student Registers
  console.log('Step 3: Student registers for approved event...');
  const reg = registrationService.register(approvedEvt.id, student1.id);
  console.log(` -> Registration created ID: ${reg.id}\n`);

  // 4. Student Applies for OD
  console.log('Step 4: Student applies for OD...');
  const odReq = odService.request(student1.id, reg.id);
  console.log(` -> OD Request created ID: ${odReq.id} (Status: ${odReq.status})\n`);

  // 5. Mentor Approves OD
  console.log('Step 5: Class Mentor approves OD...');
  const approvedOd = odService.review(odReq.id, facultyCoord, 'approve', 'Academic clearance granted for hackathon');
  console.log(` -> OD Request approved (Status: ${approvedOd.status})\n`);

  // 6. Assign Dynamic Role
  console.log('Step 6: Club Admin assigns dynamic role to student...');
  const mem = db.prepare("SELECT id FROM club_memberships WHERE club_id = ? AND user_id = ?").get(club.id, student1.id);
  clubRoleService.assignMemberDynamicRole(clubAdmin, club.id, { membershipIdInput: mem.id, clubRoleIdInput: role.id });
  console.log(` -> Role '${role.role_name}' assigned to Student 1\n`);

  // 7. Dump all received notifications grouped by user
  console.log('========================================================================================');
  console.log('                       NOTIFICATIONS DELIVERED PER RECIPIENT USER                       ');
  console.log('========================================================================================\n');
  const users = db.prepare("SELECT id, full_name, email, role FROM users ORDER BY id").all();

  for (const u of users) {
    const notifs = db.prepare("SELECT id, title, message, type, link_url, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id ASC").all(u.id);
    if (notifs.length > 0) {
      console.log(`👤 User: ${u.full_name} (${u.email} - Role: ${u.role}) [${notifs.length} Notifications]`);
      console.table(notifs.map(n => ({
        ID: n.id,
        Type: n.type,
        Title: n.title,
        Message: n.message,
        Link: n.link_url
      })));
      console.log('\n');
    }
  }
}

runDemo();
