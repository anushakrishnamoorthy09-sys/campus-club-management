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

    const stmtInsertBadge = db.prepare('INSERT INTO badges (club_id, name, description, icon_name) VALUES (NULL, ?, ?, ?)');
    for (const gb of globalBadges) {
      stmtInsertBadge.run(gb.name, gb.description, gb.icon_name);
    }
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
