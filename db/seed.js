const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
require('dotenv').config();

const db = require('../src/db/index');
const { initSchema } = require('../src/db/init');

async function seedDatabase() {
  console.log('====================================================');
  console.log('CAMPUSCLUBOS DATABASE SEEDING ENGINE');
  console.log('====================================================');

  // Step 1: Initialize DDL Schema (drops & recreates all tables idempotently)
  initSchema();

  const saltRounds = 10;
  const demoPassword = 'Password123!';
  const demoPasswordHash = bcrypt.hashSync(demoPassword, saltRounds);

  const seedTransaction = db.transaction(() => {
    // ------------------------------------------------------------------------
    // 1. SYSTEM & CLUB PERMISSIONS CATALOG
    // ------------------------------------------------------------------------
    console.log('[SEED] Populating permissions catalog...');
    const permissions = [
      // System / Admin Permissions
      { name: 'TIMETABLE_CREATE_EDIT', description: 'Create, edit, activate or delete timetable structures' },
      { name: 'CREATE_SUPER_ADMIN', description: 'Create Super Admin accounts' },
      { name: 'CREATE_ADMIN', description: 'Create Admin accounts' },
      { name: 'CREATE_FACULTY', description: 'Create Faculty accounts' },
      { name: 'CREATE_CLUB', description: 'Create new campus clubs' },
      { name: 'APPROVE_EVENT', description: 'Approve or reject club event proposals' },
      { name: 'APPROVE_OD', description: 'Approve or reject student OD applications' },
      { name: 'CHANGE_SYSTEM_ROLE', description: 'Modify system-level user roles' },
      // Dynamic Club Permissions Catalog
      { name: 'EVENT_CREATE', description: 'Draft new club events' },
      { name: 'EVENT_EDIT', description: 'Edit club event details' },
      { name: 'EVENT_SUBMIT', description: 'Submit drafted events for faculty review' },
      { name: 'VIEW_REGISTRATIONS', description: 'View student registrations for club events' },
      { name: 'MARK_ATTENDANCE', description: 'Mark student attendance at events' },
      { name: 'ISSUE_CERTIFICATE', description: 'Generate certificates for completed events' },
      { name: 'AWARD_BADGE', description: 'Award badges to student profiles' },
      { name: 'VIEW_EVENT_ANALYTICS', description: 'View event participation metrics' },
      { name: 'MESSAGE_FACULTY', description: 'Send messages in faculty-club discussion threads' }
    ];

    const stmtInsertPerm = db.prepare('INSERT INTO permissions (name, description) VALUES (?, ?)');
    for (const perm of permissions) {
      stmtInsertPerm.run(perm.name, perm.description);
    }

    // Map permission names to IDs
    const permMap = {};
    db.prepare('SELECT id, name FROM permissions').all().forEach(row => {
      permMap[row.name] = row.id;
    });

    // ------------------------------------------------------------------------
    // 2. USERS & PROFILES SEEDING
    // ------------------------------------------------------------------------
    console.log('[SEED] Seeding user accounts & profiles...');
    const stmtInsertUser = db.prepare(
      'INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, 1)'
    );

    // A. Super Admin
    const superAdminRes = stmtInsertUser.run('superadmin@campus.edu', demoPasswordHash, 'Super Admin', 'SUPER_ADMIN');
    const superAdminId = superAdminRes.lastInsertRowid;

    // B. Admin
    const adminRes = stmtInsertUser.run('admin@campus.edu', demoPasswordHash, 'Campus Admin', 'ADMIN');
    const adminId = adminRes.lastInsertRowid;

    // C. Faculty 1 (Class Mentor + Club Coordinator)
    const faculty1Res = stmtInsertUser.run('faculty.mentor@campus.edu', demoPasswordHash, 'Dr. Alan Turing', 'FACULTY');
    const faculty1UserId = faculty1Res.lastInsertRowid;
    const stmtInsertFaculty = db.prepare('INSERT INTO faculty (user_id, department, designation) VALUES (?, ?, ?)');
    stmtInsertFaculty.run(faculty1UserId, 'Computer Science', 'Professor');

    // D. Faculty 2
    const faculty2Res = stmtInsertUser.run('faculty.advisor@campus.edu', demoPasswordHash, 'Dr. Grace Hopper', 'FACULTY');
    const faculty2UserId = faculty2Res.lastInsertRowid;
    stmtInsertFaculty.run(faculty2UserId, 'Electrical Engineering', 'Associate Professor');

    // E. Club Admin
    const clubAdminRes = stmtInsertUser.run('clubadmin@campus.edu', demoPasswordHash, 'Alex Club Leader', 'CLUB_ADMIN');
    const clubAdminId = clubAdminRes.lastInsertRowid;

    // F. Student 1 (RA2311003010001) - Mentor is Faculty 1 (faculty1UserId)
    const student1UserRes = stmtInsertUser.run('student1@campus.edu', demoPasswordHash, 'John Doe', 'STUDENT');
    const student1UserId = student1UserRes.lastInsertRowid;
    const stmtInsertStudent = db.prepare(
      'INSERT INTO students (user_id, ra_number, department, year_of_study, section, class_mentor_id) VALUES (?, ?, ?, ?, ?, ?)'
    );
    stmtInsertStudent.run(student1UserId, 'RA2311003010001', 'Computer Science', 3, 'A', faculty1UserId);

    // G. Student 2 (RA2311003010002) - Mentor is Faculty 1 (faculty1UserId)
    const student2UserRes = stmtInsertUser.run('student2@campus.edu', demoPasswordHash, 'Jane Smith', 'STUDENT');
    const student2UserId = student2UserRes.lastInsertRowid;
    stmtInsertStudent.run(student2UserId, 'RA2311003010002', 'Computer Science', 3, 'A', faculty1UserId);

    // ------------------------------------------------------------------------
    // 3. CLUB & COORDINATOR ASSIGNMENT
    // ------------------------------------------------------------------------
    console.log('[SEED] Creating club and assigning coordinator...');
    const stmtInsertClub = db.prepare(
      'INSERT INTO clubs (name, code, description, category, club_admin_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const clubRes = stmtInsertClub.run(
      'Coding Club',
      'CODE01',
      'Official Campus Software Engineering and Competitive Programming Club',
      'Technical',
      clubAdminId,
      'ACTIVE',
      superAdminId
    );
    const clubId = clubRes.lastInsertRowid;

    // Assign Faculty 1 (faculty1UserId) as Coordinator for Coding Club
    db.prepare('INSERT INTO club_coordinators (club_id, faculty_user_id) VALUES (?, ?)').run(clubId, faculty1UserId);

    // Add Club Admin as member of Coding Club
    db.prepare('INSERT INTO club_memberships (club_id, user_id, status) VALUES (?, ?, ?)').run(clubId, clubAdminId, 'APPROVED');

    // ------------------------------------------------------------------------
    // 4. DYNAMIC ROLE & MEMBER ASSIGNMENT
    // ------------------------------------------------------------------------
    console.log('[SEED] Creating dynamic role "Logistics Lead"...');
    const stmtInsertClubRole = db.prepare('INSERT INTO club_roles (club_id, role_name, description) VALUES (?, ?, ?)');
    const roleRes = stmtInsertClubRole.run(clubId, 'Logistics Lead', 'Manages event venues and registrations');
    const logisticsRoleId = roleRes.lastInsertRowid;

    // Assign permissions EVENT_EDIT & VIEW_REGISTRATIONS to dynamic role
    const stmtInsertRolePerm = db.prepare('INSERT INTO club_role_permissions (club_role_id, permission_id) VALUES (?, ?)');
    stmtInsertRolePerm.run(logisticsRoleId, permMap['EVENT_EDIT']);
    stmtInsertRolePerm.run(logisticsRoleId, permMap['VIEW_REGISTRATIONS']);

    // Join Student 1 to Coding Club with dynamic role "Logistics Lead"
    db.prepare('INSERT INTO club_memberships (club_id, user_id, club_role_id, status) VALUES (?, ?, ?, ?)').run(
      clubId, student1UserId, logisticsRoleId, 'APPROVED'
    );

    // Join Student 2 as regular member of Coding Club
    db.prepare('INSERT INTO club_memberships (club_id, user_id, club_role_id, status) VALUES (?, ?, NULL, ?)').run(
      clubId, student2UserId, 'APPROVED'
    );

    // ------------------------------------------------------------------------
    // 5. MASTER TIMETABLE STRUCTURE & WORKING DAYS
    // ------------------------------------------------------------------------
    console.log('[SEED] Creating master active timetable structure...');
    const stmtInsertTT = db.prepare(
      'INSERT INTO timetables (name, scope, effective_from, is_active, created_by) VALUES (?, ?, ?, 1, ?)'
    );
    const ttRes = stmtInsertTT.run('Regular Day - 2026', 'Academic Year 2026', '2026-01-01', superAdminId);
    const ttId = ttRes.lastInsertRowid;

    // Working days Mon-Fri
    const stmtInsertTTDay = db.prepare('INSERT INTO timetable_working_days (timetable_id, day_of_week, is_active) VALUES (?, ?, 1)');
    ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].forEach(day => {
      stmtInsertTTDay.run(ttId, day);
    });

    // ~8 Class Periods + Short Break + Lunch Break (Realistic college timings)
    const periods = [
      { num: 1, label: 'Period 1', start: '08:30', end: '09:20', type: 'CLASS' },
      { num: 2, label: 'Period 2', start: '09:25', end: '10:15', type: 'CLASS' },
      { num: 3, label: 'Morning Break', start: '10:15', end: '10:30', type: 'SHORT_BREAK' },
      { num: 4, label: 'Period 3', start: '10:30', end: '11:20', type: 'CLASS' },
      { num: 5, label: 'Period 4', start: '11:25', end: '12:15', type: 'CLASS' },
      { num: 6, label: 'Lunch Break', start: '12:15', end: '13:05', type: 'LUNCH_BREAK' },
      { num: 7, label: 'Period 5', start: '13:05', end: '13:55', type: 'CLASS' },
      { num: 8, label: 'Period 6', start: '14:00', end: '14:50', type: 'CLASS' },
      { num: 9, label: 'Period 7', start: '14:55', end: '15:45', type: 'CLASS' },
      { num: 10, label: 'Period 8', start: '15:50', end: '16:40', type: 'CLASS' }
    ];

    const stmtInsertPeriod = db.prepare(
      'INSERT INTO timetable_periods (timetable_id, period_number, label, start_time, end_time, type) VALUES (?, ?, ?, ?, ?, ?)'
    );
    periods.forEach(p => {
      stmtInsertPeriod.run(ttId, p.num, p.label, p.start, p.end, p.type);
    });

    // ------------------------------------------------------------------------
    // 6. GLOBAL SYSTEM BADGES SEEDING
    // ------------------------------------------------------------------------
    console.log('[SEED] Seeding global system milestone badge types...');
    const globalBadges = [
      { name: 'First Event', description: 'Awarded for attending your first campus club event', icon_name: 'sparkles' },
      { name: '3-Event Streak', description: 'Awarded for attending 3 campus club events', icon_name: 'flame' },
      { name: 'Club Volunteer', description: 'Awarded for serving as an event volunteer', icon_name: 'heart' },
      { name: 'Event Organizer', description: 'Awarded for organizing a club event', icon_name: 'briefcase' }
    ];

    // ------------------------------------------------------------------------
    // 7. EVENTS IN EVERY STATE & SEEDED FLOW DATA
    // ------------------------------------------------------------------------
    console.log('[SEED] Creating events in all lifecycle states...');
    const stmtInsertEvent = db.prepare(`
      INSERT INTO events (club_id, title, description, event_date, start_time, end_time, venue, capacity, created_by, status, rejection_remark, cancellation_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const todayStr = '2026-09-30';
    const yesterdayStr = '2026-09-29';
    const tomorrowStr = '2026-10-01';

    // A. DRAFT Event
    const draftRes = stmtInsertEvent.run(
      clubId, 'Python Workshop Drafting', 'Internal draft for beginners python class',
      tomorrowStr, '10:00', '12:00', 'Lab 3', 30, clubAdminId, 'DRAFT', null, null
    );
    const draftEventId = draftRes.lastInsertRowid;

    // B. PENDING_APPROVAL Event
    const pendingRes = stmtInsertEvent.run(
      clubId, 'AI & ML Hackathon', 'Campus-wide machine learning hackathon',
      tomorrowStr, '09:00', '17:00', 'Main Auditorium', 100, clubAdminId, 'PENDING_APPROVAL', null, null
    );
    const pendingEventId = pendingRes.lastInsertRowid;

    // C. APPROVED Event (Today, later in the day for live demo flow)
    const approvedRes = stmtInsertEvent.run(
      clubId, 'Live Coding Bootcamp 2026', 'Interactive live programming session and speed code challenge',
      todayStr, '14:00', '16:30', 'Seminar Hall A', 50, clubAdminId, 'APPROVED', null, null
    );
    const approvedEventId = approvedRes.lastInsertRowid;

    // D. REJECTED Event (with rejection reason)
    const rejectedRes = stmtInsertEvent.run(
      clubId, 'Unauthorized Night Hackathon', 'Late evening coding sprint',
      tomorrowStr, '18:00', '21:00', 'Open Grounds', 40, clubAdminId, 'REJECTED', 'Overnight events are not permitted on weekdays', null
    );

    // E. COMPLETED Event (Held yesterday, registered while APPROVED, then COMPLETED)
    const completedRes = stmtInsertEvent.run(
      clubId, 'Annual Tech Symposium 2026', 'Keynote speeches and research poster presentations',
      yesterdayStr, '09:00', '13:00', 'Auditorium Hall 1', 150, clubAdminId, 'APPROVED', null, null
    );
    const completedEventId = completedRes.lastInsertRowid;

    // F. CANCELLED Event (with cancellation reason)
    const cancelledRes = stmtInsertEvent.run(
      clubId, 'C++ Deep Dive Workshop', 'Advanced memory management and metaprogramming',
      yesterdayStr, '14:00', '16:00', 'Lab 2', 25, clubAdminId, 'CANCELLED', null, 'Guest speaker unavailable'
    );

    // ------------------------------------------------------------------------
    // 8. REGISTRATIONS, ATTENDANCE & OD SNAPSHOT
    // ------------------------------------------------------------------------
    console.log('[SEED] Seeding event registrations, attendance, and OD request snapshot...');
    const stmtInsertReg = db.prepare(
      'INSERT INTO event_registrations (event_id, student_user_id) VALUES (?, ?)'
    );

    // Registrations for Approved Event (Today)
    const regApp1 = stmtInsertReg.run(approvedEventId, student1UserId);
    const regApp2 = stmtInsertReg.run(approvedEventId, student2UserId);

    // Registrations for Completed Event (Registered while APPROVED)
    const regComp1Res = stmtInsertReg.run(completedEventId, student1UserId);
    const regComp1Id = regComp1Res.lastInsertRowid;

    const regComp2Res = stmtInsertReg.run(completedEventId, student2UserId);
    const regComp2Id = regComp2Res.lastInsertRowid;

    // Transition Event 5 from APPROVED to COMPLETED
    db.prepare("UPDATE events SET status = 'COMPLETED' WHERE id = ?").run(completedEventId);

    // Attendance for Completed Event
    const stmtInsertAttendance = db.prepare(
      'INSERT INTO attendance (event_id, student_user_id, status, method, marked_by) VALUES (?, ?, ?, ?, ?)'
    );
    stmtInsertAttendance.run(completedEventId, student1UserId, 'PRESENT', 'QR', clubAdminId);
    stmtInsertAttendance.run(completedEventId, student2UserId, 'ABSENT', 'MANUAL', clubAdminId);

    // Decided OD Request with Snapshot for Student 1 on Completed Event
    const odRes = db.prepare(`
      INSERT INTO od_requests (registration_id, student_user_id, class_mentor_id, status, reviewed_by, reviewed_at, faculty_remark, decided_via)
      VALUES (?, ?, ?, 'APPROVED', ?, datetime('now', '-1 day'), 'Academic approval granted for symposium participation', 'MENTOR')
    `).run(regComp1Id, student1UserId, faculty1UserId, faculty1UserId);
    const odId = odRes.lastInsertRowid;

    // OD Period Snapshots
    const stmtInsertOdPeriod = db.prepare(`
      INSERT INTO od_request_periods (od_request_id, timetable_id, timetable_name, period_number, period_label, start_time, end_time)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmtInsertOdPeriod.run(odId, ttId, 'Regular Day - 2026', 1, 'Period 1', '08:30', '09:20');
    stmtInsertOdPeriod.run(odId, ttId, 'Regular Day - 2026', 2, 'Period 2', '09:25', '10:15');
    stmtInsertOdPeriod.run(odId, ttId, 'Regular Day - 2026', 4, 'Period 3', '10:30', '11:20');

    // ------------------------------------------------------------------------
    // 9. CERTIFICATE ISSUANCE & BADGES
    // ------------------------------------------------------------------------
    console.log('[SEED] Seeding certificates and badges...');
    const certUuid = 'c0a80101-5678-4321-89ab-cdef01234567';
    const certHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    db.prepare(`
      INSERT INTO certificates (
        certificate_uuid, event_id, student_user_id, role_type, verification_hash, issued_by
      ) VALUES (?, ?, ?, 'PARTICIPANT', ?, ?)
    `).run(certUuid, completedEventId, student1UserId, certHash, clubAdminId);

    // Club Custom Badge
    const clubBadgeRes = db.prepare(
      'INSERT INTO badges (club_id, name, description, icon_name) VALUES (?, ?, ?, ?)'
    ).run(clubId, 'Top Coder 2026', 'Awarded for exceptional algorithmic problem solving', 'trophy');
    const clubBadgeId = clubBadgeRes.lastInsertRowid;

    // Award Club Badge & System Badge to Student 1
    const stmtInsertAward = db.prepare(
      'INSERT INTO student_badges (badge_id, student_user_id, awarded_by, reason) VALUES (?, ?, ?, ?)'
    );
    stmtInsertAward.run(clubBadgeId, student1UserId, clubAdminId, 'Winner of Coding Sprint 2026');

    const firstEventBadge = db.prepare("SELECT id FROM badges WHERE name = 'First Event' AND club_id IS NULL").get();
    if (firstEventBadge) {
      stmtInsertAward.run(firstEventBadge.id, student1UserId, clubAdminId, 'Attended first club event');
    }

    // ------------------------------------------------------------------------
    // 10. IN-APP NOTIFICATIONS
    // ------------------------------------------------------------------------
    console.log('[SEED] Generating seed in-app notifications...');
    const stmtInsertNotif = db.prepare(
      'INSERT INTO notifications (user_id, title, message, type, is_read) VALUES (?, ?, ?, ?, ?)'
    );
    stmtInsertNotif.run(student1UserId, 'Certificate Issued', 'Your certificate for Annual Tech Symposium 2026 is ready for download.', 'CERTIFICATE', 0);
    stmtInsertNotif.run(student1UserId, 'Badge Awarded!', 'You have been awarded the Top Coder 2026 badge!', 'BADGE', 0);
    stmtInsertNotif.run(student1UserId, 'OD Approved', 'Your On-Duty request for Annual Tech Symposium 2026 was APPROVED.', 'OD_STATUS', 1);
    stmtInsertNotif.run(faculty1UserId, 'Event Review Required', 'New event proposal "AI & ML Hackathon" requires your approval.', 'EVENT_SUBMITTED', 0);
  });

  // Execute seeding transaction
  seedTransaction();

  console.log('\n====================================================');
  console.log('DATABASE SEEDING COMPLETE! CREATED DEMO ACCOUNTS:');
  console.log('====================================================');
  console.log(`Demo Password for ALL Accounts: ${demoPassword}`);
  console.log('----------------------------------------------------');
  console.log('1. Super Admin:  superadmin@campus.edu');
  console.log('2. Admin:        admin@campus.edu');
  console.log('3. Faculty 1:    faculty.mentor@campus.edu  (Mentor + Coordinator)');
  console.log('4. Faculty 2:    faculty.advisor@campus.edu');
  console.log('5. Club Admin:   clubadmin@campus.edu       (Coding Club Admin)');
  console.log('6. Student 1:    student1@campus.edu        (RA: RA2311003010001, Logistics Lead)');
  console.log('7. Student 2:    student2@campus.edu        (RA: RA2311003010002, Regular Member)');
  console.log('====================================================\n');
}

if (require.main === module) {
  try {
    seedDatabase();
  } catch (err) {
    console.error('[SEED ERROR] Seeding failed:', err);
    process.exit(1);
  }
}

module.exports = { seedDatabase };
