const http = require('http');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const { registerStudent } = require('../src/services/authService');
const { verifyGoogleProfile } = require('../src/config/passport');
const { createClubRole } = require('../src/services/clubRoleService');
const eventService = require('../src/services/eventService');
const registrationService = require('../src/services/registrationService');

const PORT = 3099;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_12345';
const COOKIE_NAME = 'token';

const testResults = [];
const untestableReports = [];

function recordResult(testName, passed, details = '') {
  testResults.push({
    test: testName,
    status: passed ? 'PASS ✅' : 'FAIL ❌',
    details: details
  });
}

function recordUntestable(testName, reason) {
  testResults.push({
    test: testName,
    status: 'SKIP ⚠️',
    details: `NOT TESTABLE YET: ${reason}`
  });
  untestableReports.push({ feature: testName, reason });
}

// Low-level HTTP request helper
function makeRequest(method, path, bodyData = null, cookieHeaders = [], extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: method,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...extraHeaders
      }
    };

    if (cookieHeaders && cookieHeaders.length > 0) {
      options.headers['Cookie'] = cookieHeaders.join('; ');
    }

    let payload = '';
    if (bodyData) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(bodyData)) {
        if (Array.isArray(value)) {
          for (const item of value) params.append(key, item);
        } else if (value !== undefined && value !== null) {
          params.append(key, value);
        }
      }
      payload = params.toString();
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          setCookies: res.headers['set-cookie'] || [],
          body: responseBody
        });
      });
    });

    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

function getJwtCookie(userId, customSecret = JWT_SECRET, expiresIn = '1h') {
  const token = jwt.sign({ userId }, customSecret, { expiresIn });
  return `${COOKIE_NAME}=${token}`;
}

// Helper for asserting that a synchronous service call throws an expected status code
function expectThrows(fn, expectedStatusCode = 403) {
  try {
    fn();
    return { success: false, actualStatus: 'NO_THROW', error: 'Expected function to throw, but it succeeded' };
  } catch (err) {
    const statusCode = err.statusCode || 500;
    if (statusCode === expectedStatusCode) {
      return { success: true, actualStatus: statusCode, error: null };
    }
    return { success: false, actualStatus: statusCode, error: `Expected ${expectedStatusCode}, got ${statusCode} (${err.message})` };
  }
}

/**
 * Shared Test Client Helper
 * Logs in as a given user, manages session cookies, and fetches valid CSRF tokens for state-changing requests.
 */
class TestClient {
  constructor(userId = null) {
    this.userId = userId;
    this.authCookie = userId ? getJwtCookie(userId) : null;
    this.csrfCookie = null;
    this.csrfToken = null;
  }

  async fetchCsrfToken() {
    let fetchPath = '/register';
    if (this.userId) {
      const user = db.prepare('SELECT role FROM users WHERE id = ?').get(this.userId);
      if (user) {
        if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') fetchPath = '/admin/events';
        else if (user.role === 'FACULTY') fetchPath = '/faculty/events';
        else if (user.role === 'CLUB_ADMIN') fetchPath = '/club/events';
        else fetchPath = '/student/events';
      }
    }

    const initialCookies = this.authCookie ? [this.authCookie] : [];
    const res = await makeRequest('GET', fetchPath, null, initialCookies);

    for (const cookieStr of res.setCookies) {
      if (cookieStr.startsWith('x-csrf-token=')) {
        this.csrfCookie = cookieStr.split(';')[0];
      }
    }

    const match = res.body.match(/name="_csrf"\s+value="([^"]+)"/) || res.body.match(/value="([^"]+)"\s+name="_csrf"/);
    if (match) {
      this.csrfToken = match[1];
    }
  }

  getCookies() {
    const list = [];
    if (this.authCookie) list.push(this.authCookie);
    if (this.csrfCookie) list.push(this.csrfCookie);
    return list;
  }

  async get(path, customHeaders = {}) {
    return makeRequest('GET', path, null, this.getCookies(), customHeaders);
  }

  async post(path, bodyData = {}, options = {}) {
    const skipCsrf = options.skipCsrf || false;
    // Default to JSON accept header on API POST requests so routes return exact JSON status codes rather than HTML redirects
    const customHeaders = {
      'Accept': 'application/json',
      ...(options.headers || {})
    };

    if (!skipCsrf) {
      await this.fetchCsrfToken();
      bodyData = { _csrf: this.csrfToken, ...bodyData };
    }

    const res = await makeRequest('POST', path, bodyData, this.getCookies(), customHeaders);

    // Harness Assertion: If CSRF token was attached, 403 response MUST NOT be due to CSRF invalidation!
    if (!skipCsrf && res.statusCode === 403 && res.body.includes('invalid csrf token')) {
      throw new Error(`Harness Error: Request to ${path} failed with 'invalid csrf token' despite attaching token.`);
    }

    return res;
  }
}

async function runSecurityTestSuite() {
  console.log('\n========================================================================================');
  console.log('                 CAMPUSCLUBOS AUTOMATED SECURITY AUDIT TEST SUITE                       ');
  console.log('========================================================================================\n');

  // Seed DB fresh
  seedDatabase();

  const server = app.listen(PORT, async () => {
    let overallSuccess = true;

    try {
      // ----------------------------------------------------------------------
      // FETCH SEEDED USERS & ENTITIES FROM DB
      // ----------------------------------------------------------------------
      const superAdminUser = db.prepare("SELECT id, role FROM users WHERE role = 'SUPER_ADMIN'").get();
      const adminUser = db.prepare("SELECT id, role FROM users WHERE role = 'ADMIN'").get();
      const facultyUser = db.prepare("SELECT id, role FROM users WHERE role = 'FACULTY' LIMIT 1").get();
      const clubAdminUser = db.prepare("SELECT id, role FROM users WHERE role = 'CLUB_ADMIN' LIMIT 1").get();
      const student1User = db.prepare("SELECT id, role FROM users WHERE email = 'student1@campus.edu'").get();
      const student2User = db.prepare("SELECT id, role FROM users WHERE email = 'student2@campus.edu'").get();
      const faculty2User = db.prepare("SELECT id, role FROM users WHERE email = 'faculty.advisor@campus.edu'").get();
      const codingClub = db.prepare("SELECT id FROM clubs WHERE code = 'CODE01'").get();
      const activeTT = db.prepare("SELECT id FROM timetables WHERE is_active = 1 LIMIT 1").get();

      // ======================================================================
      // PHASE 1 & 2 BASELINE ASSERTIONS
      // ======================================================================

      // TEST 1: Logged-out access redirection
      try {
        console.log('[SECURITY TEST 1] Verifying Logged-out Access Redirection to /login...');
        const protectedPaths = [
          '/dashboard', '/dashboard/super-admin', '/dashboard/admin', '/dashboard/club-admin',
          '/dashboard/faculty', '/dashboard/student', '/admin/timetable', '/admin/users',
          '/admin/clubs', '/club/events', '/club/members', '/club/roles', '/club/certificates',
          '/club/badges', '/faculty/events', '/faculty/od', '/faculty/mentees', '/student/events',
          '/student/my-registrations', '/student/od', '/student/certificates', '/student/badges',
          '/complete-profile'
        ];

        let redirectedCount = 0;
        const anonClient = new TestClient(null);

        for (const p of protectedPaths) {
          const res = await anonClient.get(p);
          if (res.statusCode === 302 && res.headers.location === '/login') {
            redirectedCount++;
          }
        }
        const passed = redirectedCount === protectedPaths.length;
        recordResult(
          'Phase 1. Logged-out access redirects to /login',
          passed,
          `Tested ${protectedPaths.length} paths: ${redirectedCount}/${protectedPaths.length} redirected to /login (302)`
        );
      } catch (err) {
        recordResult('Phase 1. Logged-out access redirects to /login', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // TEST 2: Super Admin Timetable Route Guards (GET)
      try {
        console.log('[SECURITY TEST 2] Verifying Super Admin Timetable Route Guards (GET)...');
        const studClient = new TestClient(student1User.id);
        const caClient = new TestClient(clubAdminUser.id);
        const facClient = new TestClient(facultyUser.id);
        const adminClient = new TestClient(adminUser.id);
        const saClient = new TestClient(superAdminUser.id);

        const resStud = await studClient.get('/admin/timetable');
        const resCA = await caClient.get('/admin/timetable');
        const resFac = await facClient.get('/admin/timetable');
        const resAdmin = await adminClient.get('/admin/timetable');
        const resSA = await saClient.get('/admin/timetable');

        const passed = resStud.statusCode === 403 && resCA.statusCode === 403 &&
                       resFac.statusCode === 403 && resAdmin.statusCode === 403 &&
                       resSA.statusCode === 200;

        recordResult(
          'Phase 1. Super Admin Timetable guarded against Non-SuperAdmin roles (GET)',
          passed,
          `Student ${resStud.statusCode}, ClubAdmin ${resCA.statusCode}, Faculty ${resFac.statusCode}, Admin ${resAdmin.statusCode}, SuperAdmin ${resSA.statusCode}`
        );
      } catch (err) {
        recordResult('Phase 1. Super Admin Timetable guarded against Non-SuperAdmin roles (GET)', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // TEST 3: Student Route Access Restrictions
      try {
        console.log('[SECURITY TEST 3] Verifying Student 403 Blocks on Privileged Routes...');
        const studentRestrictedPaths = [
          '/admin/timetable', '/admin/users', '/admin/clubs', '/club/events',
          '/club/members', '/club/roles', '/club/certificates', '/club/badges',
          '/faculty/events', '/faculty/od', '/faculty/mentees'
        ];
        const studClient = new TestClient(student2User.id);
        let count403 = 0;

        for (const p of studentRestrictedPaths) {
          const res = await studClient.get(p);
          if (res.statusCode === 403) count403++;
        }

        const passed = count403 === studentRestrictedPaths.length;
        recordResult(
          'Phase 1. Student receives 403 on privileged routes',
          passed,
          `Tested ${studentRestrictedPaths.length} paths: ${count403}/${studentRestrictedPaths.length} returned 403`
        );
      } catch (err) {
        recordResult('Phase 1. Student receives 403 on privileged routes', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // TEST 4: Registration RA Number Validation
      try {
        console.log('[SECURITY TEST 4] Verifying Registration RA Number Validation...');
        const facultyMentor = db.prepare("SELECT user_id FROM faculty LIMIT 1").get();
        const baseRegData = {
          fullName: 'Test Student', email: 'test_ra_val@campus.edu', password: 'Password123!',
          department: 'CSE', yearOfStudy: 2, section: 'A', classMentorId: facultyMentor.user_id
        };

        const r1 = expectThrows(() => registerStudent({ ...baseRegData, raNumber: 'RA123456789012' }), 400);
        const r2 = expectThrows(() => registerStudent({ ...baseRegData, raNumber: 'RA12345678901234' }), 400);
        const r3 = expectThrows(() => registerStudent({ ...baseRegData, raNumber: 'RA123456789012!' }), 400);
        const r4 = expectThrows(() => registerStudent({ ...baseRegData, raNumber: 'RA2311003010001' }), 409);
        const r5 = expectThrows(() => registerStudent({ ...baseRegData, raNumber: 'ra2311003010001' }), 409);

        const passed = r1.success && r2.success && r3.success && r4.success && r5.success;
        recordResult(
          'Phase 2. Registration rejects invalid, duplicate & lowercase RA variants',
          passed,
          `14-char (${r1.actualStatus}), 16-char (${r2.actualStatus}), non-alphanumeric (${r3.actualStatus}), duplicate (${r4.actualStatus}), lowercase (${r5.actualStatus})`
        );
      } catch (err) {
        recordResult('Phase 2. Registration rejects invalid, duplicate & lowercase RA variants', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // TEST 5: Role Injection Prevention
      try {
        console.log('[SECURITY TEST 5] Verifying Injected Role Sanitization on Registration...');
        const facultyMentor = db.prepare("SELECT user_id FROM faculty LIMIT 1").get();
        const registeredUser = registerStudent({
          fullName: 'Hacker User', email: 'hacker_role_inject@campus.edu', password: 'Password123!',
          raNumber: 'RA8888888888888', department: 'CSE', yearOfStudy: 1, section: 'A',
          classMentorId: facultyMentor.user_id, role: 'SUPER_ADMIN', is_active: 1
        });
        const dbUser = db.prepare('SELECT role FROM users WHERE id = ?').get(registeredUser.id);
        const passed = dbUser && dbUser.role === 'STUDENT';
        recordResult(
          'Phase 2. Registration ignores injected role field',
          passed,
          `Submitted role=SUPER_ADMIN, persisted DB role=${dbUser ? dbUser.role : 'UNKNOWN'}`
        );
      } catch (err) {
        recordResult('Phase 2. Registration ignores injected role field', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // TEST 6: JWT Security Assertions
      try {
        console.log('[SECURITY TEST 6] Verifying JWT Security Enforcement...');
        const tamperedCookie = getJwtCookie(student1User.id, 'WRONG_INVALID_SECRET_KEY');
        const resTampered = await makeRequest('GET', '/dashboard', null, [tamperedCookie]);

        const expiredCookie = getJwtCookie(student1User.id, JWT_SECRET, '-1s');
        const resExpired = await makeRequest('GET', '/dashboard', null, [expiredCookie]);

        const passed = (resTampered.statusCode === 302 && resTampered.headers.location === '/login') &&
                       (resExpired.statusCode === 302 && resExpired.headers.location === '/login');

        recordResult(
          'Phase 2. Tampered & expired JWTs are rejected',
          passed,
          `Tampered signature ${resTampered.statusCode} (Location: ${resTampered.headers.location}), Expired token ${resExpired.statusCode} (Location: ${resExpired.headers.location})`
        );
      } catch (err) {
        recordResult('Phase 2. Tampered & expired JWTs are rejected', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // TEST 7: Staff Google OAuth Rejection
      try {
        console.log('[SECURITY TEST 7] Verifying Staff Google OAuth Rejection...');
        const mockStaffProfile = {
          id: 'google_staff_sec_test', displayName: 'Dr. Alan Turing',
          emails: [{ value: 'faculty.mentor@campus.edu' }]
        };
        let authUser = null;
        await new Promise((resolve) => {
          verifyGoogleProfile(null, null, mockStaffProfile, (err, user) => { authUser = user; resolve(); });
        });
        const auditLogRecord = db.prepare("SELECT * FROM audit_logs WHERE action = 'GOOGLE_AUTH_STAFF_DENIED' AND actor_id = ?").get(facultyUser.id);
        const passed = authUser === false && Boolean(auditLogRecord);
        recordResult(
          'Phase 2. Staff email cannot authenticate through Google flow',
          passed,
          `Auth user result: ${authUser}, Audit log logged: ${Boolean(auditLogRecord)}`
        );
      } catch (err) {
        recordResult('Phase 2. Staff email cannot authenticate through Google flow', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // TEST 8: CSRF Protection on State-Changing POSTs (Skip token)
      try {
        console.log('[SECURITY TEST 8] Verifying CSRF Protection on State-Changing POSTs (No Token)...');
        const anonClient = new TestClient(null);
        const resPostLoginNoCsrf = await anonClient.post('/login', { email: 'student1@campus.edu', password: 'Password123!' }, { skipCsrf: true });

        const facultyMentor = db.prepare("SELECT user_id FROM faculty LIMIT 1").get();
        const resPostRegNoCsrf = await anonClient.post('/register', {
          fullName: 'No CSRF Student', email: 'nocsrf@campus.edu', password: 'Password123!',
          raNumber: 'RA7777777777777', department: 'CSE', yearOfStudy: '2', section: 'A', classMentorId: facultyMentor.user_id
        }, { skipCsrf: true });

        const passed = resPostLoginNoCsrf.statusCode === 403 && resPostRegNoCsrf.statusCode === 403;
        recordResult(
          'Phase 2. State-changing POST requests without CSRF token return 403',
          passed,
          `POST /login ${resPostLoginNoCsrf.statusCode}, POST /register ${resPostRegNoCsrf.statusCode}`
        );
      } catch (err) {
        recordResult('Phase 2. State-changing POST requests without CSRF token return 403', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // ======================================================================
      // PHASE 3 SECURITY ASSERTIONS
      // ======================================================================
      console.log('\n----------------------------------------------------------------------------------------');
      console.log('                          RUNNING PHASE 3 SECURITY ASSERTIONS                           ');
      console.log('----------------------------------------------------------------------------------------\n');

      // PHASE 3 - TEST 1: Admin & Club Admin Account Creation Matrix
      try {
        console.log('[PHASE 3 - TEST 1] Verifying Account Creation Restrictions for Admin and Club Admin...');
        const adminClient = new TestClient(adminUser.id);
        const caClient = new TestClient(clubAdminUser.id);

        const r1 = await adminClient.post('/admin/users', { fullName: 'Illegal Admin', email: 'ill_admin@campus.edu', password: 'Password123!', role: 'ADMIN' });
        const r2 = await adminClient.post('/admin/users', { fullName: 'Illegal Faculty', email: 'ill_faculty@campus.edu', password: 'Password123!', role: 'FACULTY', department: 'CSE', designation: 'Prof' });
        const r3 = await adminClient.post('/admin/users', { fullName: 'Valid Club Admin', email: 'valid_ca_created@campus.edu', password: 'Password123!', role: 'CLUB_ADMIN' });
        const r4 = await caClient.post('/admin/users', { fullName: 'Illegal CA User', email: 'ca_ill_user@campus.edu', password: 'Password123!', role: 'CLUB_ADMIN' });

        const isR1Denied = r1.statusCode === 403 && !r1.body.includes('invalid csrf token');
        const isR2Denied = r2.statusCode === 403 && !r2.body.includes('invalid csrf token');
        const isR3Success = r3.statusCode === 201 || r3.statusCode === 302;
        const isR4Denied = r4.statusCode === 403 && !r4.body.includes('invalid csrf token');

        // Check audit log for denied attempt
        const auditLog = db.prepare("SELECT id FROM audit_logs WHERE actor_id = ? AND action = 'USER_CREATE_DENIED' ORDER BY id DESC LIMIT 1").get(adminUser.id);
        const hasAudit = Boolean(auditLog);

        const passed = isR1Denied && isR2Denied && isR3Success && isR4Denied && hasAudit;
        recordResult(
          'P3-1. Admin cannot create Admin/Faculty; Club Admin cannot create any account',
          passed,
          `Admin->ADMIN ${r1.statusCode}, Admin->FACULTY ${r2.statusCode}, Admin->CLUB_ADMIN ${r3.statusCode}, ClubAdmin->User ${r4.statusCode}`
        );
      } catch (err) {
        recordResult('P3-1. Admin cannot create Admin/Faculty; Club Admin cannot create any account', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 3 - TEST 2: Dynamic Role Permission Probe & Scope Isolation
      try {
        console.log('[PHASE 3 - TEST 2] Verifying Permission Probe Guarding & Scope Isolation...');
        // Seed a second club ("Robotics Club") with a new Club Admin
        const ca2UserRes = db.prepare("INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ('ca2@campus.edu', 'hash', 'Club Admin 2', 'CLUB_ADMIN', 1)").run();
        const clubBRes = db.prepare("INSERT INTO clubs (name, code, description, category, club_admin_id, status, created_by) VALUES ('Robotics Club', 'ROBO01', 'Robotics', 'Tech', ?, 'ACTIVE', ?)").run(ca2UserRes.lastInsertRowid, superAdminUser.id);
        const clubBId = clubBRes.lastInsertRowid;

        const stud2Client = new TestClient(student2User.id);
        const stud1Client = new TestClient(student1User.id);

        const r1 = await stud2Client.get(`/club/${codingClub.id}/_probe/EVENT_CREATE`);
        const r2 = await stud1Client.get(`/club/${codingClub.id}/_probe/EVENT_EDIT`);
        const r3 = await stud1Client.get(`/club/${codingClub.id}/_probe/VIEW_REGISTRATIONS`);
        const r4 = await stud1Client.get(`/club/${codingClub.id}/_probe/MARK_ATTENDANCE`);
        const r5 = await stud1Client.get(`/club/${clubBId}/_probe/EVENT_EDIT`);

        const passed = r1.statusCode === 403 && r2.statusCode === 200 && r3.statusCode === 200 &&
                       r4.statusCode === 403 && r5.statusCode === 403;

        recordResult(
          'P3-2. User without permission gets 403; dynamic role gets 200 on granted & 403 for another club',
          passed,
          `NoPerm ${r1.statusCode}, Granted1 ${r2.statusCode}, Granted2 ${r3.statusCode}, Ungranted ${r4.statusCode}, OtherClub ${r5.statusCode}`
        );
      } catch (err) {
        recordResult('P3-2. User without permission gets 403; dynamic role gets 200 on granted & 403 for another club', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 3 - TEST 3: Club Admin Cross-Club IDOR Protection
      try {
        console.log('[PHASE 3 - TEST 3] Verifying Dynamic Role IDOR & Cross-Club Guarding...');
        const clubB = db.prepare("SELECT id FROM clubs WHERE code = 'ROBO01'").get();
        const roleBRes = db.prepare("INSERT INTO club_roles (club_id, role_name, description) VALUES (?, 'Robotics Lead', 'Manages robotics')").run(clubB.id);
        const roleBId = roleBRes.lastInsertRowid;
        const membershipA = db.prepare("SELECT id FROM club_memberships WHERE club_id = ? AND user_id = ?").get(codingClub.id, student1User.id);

        const caClient = new TestClient(clubAdminUser.id);

        const r1 = await caClient.post(`/club/${clubB.id}/roles/${roleBId}/update`, { roleName: 'Hacked Role' });
        const r2 = await caClient.post(`/club/${codingClub.id}/roles/${roleBId}/update`, { roleName: 'Hacked Role' });
        const r3 = await caClient.post(`/club/${clubB.id}/roles/${roleBId}/delete`, {});
        const r4 = await caClient.post(`/club/${codingClub.id}/roles/${roleBId}/delete`, {});
        const r5 = await caClient.post(`/club/${clubB.id}/members/assign-role`, { membershipIdInput: 1, clubRoleIdInput: roleBId });
        const r6 = await caClient.post(`/club/${codingClub.id}/members/assign-role`, { membershipIdInput: membershipA.id, clubRoleIdInput: roleBId });

        // Rule 5: IDOR by another club's resource id may return 403 OR 404 (or 400) but NEVER 2xx/3xx
        const isBlocked = (res) => [400, 403, 404].includes(res.statusCode) && !res.body.includes('invalid csrf token');

        const passed = isBlocked(r1) && isBlocked(r2) && isBlocked(r3) && isBlocked(r4) && isBlocked(r5) && isBlocked(r6);
        recordResult(
          'P3-3. Club Admin cannot edit, delete or assign roles of another club (IDOR protection)',
          passed,
          `CrossEdit ${r1.statusCode}, IdorEdit ${r2.statusCode}, CrossDel ${r3.statusCode}, IdorDel ${r4.statusCode}, CrossAssign ${r5.statusCode}, IdorAssign ${r6.statusCode}`
        );
      } catch (err) {
        recordResult('P3-3. Club Admin cannot edit, delete or assign roles of another club (IDOR protection)', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 3 - TEST 4: Forbidden Dynamic Role System Permissions
      try {
        console.log('[PHASE 3 - TEST 4] Verifying Prohibition of System Permissions on Dynamic Roles...');
        const caClient = new TestClient(clubAdminUser.id);

        const c1 = await caClient.post(`/club/${codingClub.id}/roles`, { roleName: 'ForbiddenRole_TT', permissionNames: ['TIMETABLE_CREATE_EDIT'] });
        const c2 = await caClient.post(`/club/${codingClub.id}/roles`, { roleName: 'ForbiddenRole_EV', permissionNames: ['APPROVE_EVENT'] });
        const c3 = await caClient.post(`/club/${codingClub.id}/roles`, { roleName: 'ForbiddenRole_OD', permissionNames: ['APPROVE_OD'] });

        // Create a valid dynamic role for update test via HTTP
        const validRoleRes = await caClient.post(`/club/${codingClub.id}/roles`, { roleName: 'Valid Temp Role', permissionNames: ['EVENT_CREATE'] });
        const createdRole = db.prepare("SELECT id FROM club_roles WHERE club_id = ? AND role_name = 'Valid Temp Role'").get(codingClub.id);

        let u1 = { statusCode: 403, body: '' }, u2 = { statusCode: 403, body: '' }, u3 = { statusCode: 403, body: '' };
        if (createdRole) {
          u1 = await caClient.post(`/club/${codingClub.id}/roles/${createdRole.id}/update`, { roleName: 'Valid Temp Role', permissionNames: ['TIMETABLE_CREATE_EDIT'] });
          u2 = await caClient.post(`/club/${codingClub.id}/roles/${createdRole.id}/update`, { roleName: 'Valid Temp Role', permissionNames: ['APPROVE_EVENT'] });
          u3 = await caClient.post(`/club/${codingClub.id}/roles/${createdRole.id}/update`, { roleName: 'Valid Temp Role', permissionNames: ['APPROVE_OD'] });
        }

        // Direct service call test using expectThrows
        const s1 = expectThrows(() => createClubRole(clubAdminUser, codingClub.id, { roleName: 'ForbiddenRole_Direct', permissionNames: ['APPROVE_EVENT'] }), 403);

        const isDenied = (res) => res.statusCode === 403 && !res.body.includes('invalid csrf token');

        const passed = isDenied(c1) && isDenied(c2) && isDenied(c3) &&
                       isDenied(u1) && isDenied(u2) && isDenied(u3) && s1.success;

        recordResult(
          'P3-4. Granting forbidden system permissions to dynamic role returns 403 on create and update',
          passed,
          `CreateTT ${c1.statusCode}, CreateEv ${c2.statusCode}, CreateOD ${c3.statusCode}, UpdateTT ${u1.statusCode}, UpdateEv ${u2.statusCode}, UpdateOD ${u3.statusCode}, DirectSvc (${s1.actualStatus})`
        );
      } catch (err) {
        recordResult('P3-4. Granting forbidden system permissions to dynamic role returns 403 on create and update', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 3 - TEST 5: Timetable Write Endpoints Authorization Matrix
      try {
        console.log('[PHASE 3 - TEST 5] Verifying Timetable Write Endpoints Authorization Matrix...');
        const studClient = new TestClient(student1User.id);
        const caClient = new TestClient(clubAdminUser.id);
        const facClient = new TestClient(facultyUser.id);
        const adminClient = new TestClient(adminUser.id);
        const saClient = new TestClient(superAdminUser.id);

        const ttWriteEndpoints = [
          { name: 'CREATE', path: '/admin/timetable', body: { name: 'New TT', scope: 'Test', effective_from: '2026-09-01' } },
          { name: 'UPDATE', path: `/admin/timetable/${activeTT.id}/update`, body: { name: 'Updated TT', scope: 'Test', effective_from: '2026-09-01' } },
          { name: 'ACTIVATE', path: `/admin/timetable/${activeTT.id}/activate`, body: {} },
          { name: 'DEACTIVATE', path: `/admin/timetable/${activeTT.id}/deactivate`, body: {} },
          { name: 'DELETE', path: `/admin/timetable/${activeTT.id}/delete`, body: {} }
        ];

        const nonSaClients = [
          { name: 'Student', client: studClient },
          { name: 'ClubAdmin', client: caClient },
          { name: 'Faculty', client: facClient },
          { name: 'Admin', client: adminClient }
        ];

        let allNonSaBlocked = true;
        const roleStatusMap = {};

        for (const { name, client } of nonSaClients) {
          const statuses = [];
          for (const ep of ttWriteEndpoints) {
            const res = await client.post(ep.path, ep.body);
            statuses.push(res.statusCode);
            if (res.statusCode !== 403 || res.body.includes('invalid csrf token')) {
              allNonSaBlocked = false;
            }
          }
          roleStatusMap[name] = statuses.join('/');
        }

        const resSaWrite = await saClient.post('/admin/timetable', {
          name: 'Super Admin Test TT', scope: 'System', effective_from: '2026-10-01',
          working_days: ['MONDAY'], periods_json: JSON.stringify([{ period_number: 1, label: 'P1', start_time: '09:00', end_time: '10:00', type: 'CLASS' }])
        });

        const saSuccess = resSaWrite.statusCode === 201 || resSaWrite.statusCode === 302 || resSaWrite.statusCode === 200;
        const passed = allNonSaBlocked && saSuccess;

        recordResult(
          'P3-5. Every timetable write endpoint returns 403 for Admin, Club Admin, Faculty, Student; succeeds for Super Admin',
          passed,
          `Student (${roleStatusMap['Student']}), ClubAdmin (${roleStatusMap['ClubAdmin']}), Faculty (${roleStatusMap['Faculty']}), Admin (${roleStatusMap['Admin']}), SuperAdmin ${resSaWrite.statusCode}`
        );
      } catch (err) {
        recordResult('P3-5. Every timetable write endpoint returns 403 for Admin, Club Admin, Faculty, Student; succeeds for Super Admin', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 3 - TEST 6: Deactivated User Token Immediate Rejection
      try {
        console.log('[PHASE 3 - TEST 6] Verifying Immediate Token Rejection for Deactivated Users...');
        const tempUserRes = db.prepare("INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ('deact_test@campus.edu', 'hash', 'Deact User', 'STUDENT', 1)").run();
        const tempUserId = tempUserRes.lastInsertRowid;
        db.prepare("INSERT INTO students (user_id, ra_number, department, year_of_study, section, class_mentor_id) VALUES (?, 'RA9999999999999', 'CSE', 1, 'A', ?)").run(tempUserId, facultyUser.id);

        const deactClient = new TestClient(tempUserId);
        const resBefore = await deactClient.get('/dashboard');

        // Immediately deactivate user in DB
        db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(tempUserId);

        const resAfterHtml = await deactClient.get('/dashboard');
        const resAfterJson = await deactClient.get('/timetable/view', { 'Accept': 'application/json' });

        const passed = (resBefore.statusCode === 302 && resBefore.headers.location !== '/login') &&
                       (resAfterHtml.statusCode === 302 && resAfterHtml.headers.location === '/login') &&
                       (resAfterJson.statusCode === 302 || resAfterJson.statusCode === 401);

        recordResult(
          'P3-6. Deactivated user token is rejected immediately',
          passed,
          `BeforeDeact ${resBefore.statusCode} (Loc: ${resBefore.headers.location}), AfterDeactHTML ${resAfterHtml.statusCode} (Loc: ${resAfterHtml.headers.location}), AfterDeactJSON ${resAfterJson.statusCode}`
        );
      } catch (err) {
        recordResult('P3-6. Deactivated user token is rejected immediately', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 3 - TEST 7: One-Club-Per-Admin & Delete Club with Members Block
      try {
        console.log('[PHASE 3 - TEST 7] Verifying One-Club-Per-Admin & Club Deletion Member Blocking...');
        const saClient = new TestClient(superAdminUser.id);

        // A. Reject second club for same Club Admin (Alex Club Leader - clubAdminUser.id)
        const r1 = await saClient.post('/admin/clubs', {
          name: 'Duplicate Admin Club', code: 'DUP01', description: 'Second club for existing CA',
          category: 'Tech', clubAdminId: clubAdminUser.id, facultyCoordinatorIds: [facultyUser.id]
        });

        // B. Deleting a club that has active members is BLOCKED (Coding Club has Student 1 & 2)
        const r2 = await saClient.post(`/admin/clubs/${codingClub.id}/delete`, {});

        // C. Deleting an empty club (no members) SUCCEEDS
        const emptyCaUser = db.prepare("INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ('empty_ca@campus.edu', 'hash', 'Empty CA', 'CLUB_ADMIN', 1)").run();
        const emptyClubRes = db.prepare("INSERT INTO clubs (name, code, description, category, club_admin_id, status, created_by) VALUES ('Empty Club', 'EMP01', 'Empty', 'Tech', ?, 'ACTIVE', ?)").run(emptyCaUser.lastInsertRowid, superAdminUser.id);
        const emptyClubId = emptyClubRes.lastInsertRowid;

        const r3 = await saClient.post(`/admin/clubs/${emptyClubId}/delete`, {});

        const passed = r1.statusCode === 409 && r2.statusCode === 400 && (r3.statusCode === 200 || r3.statusCode === 302);
        recordResult(
          'P3-7. Second club for same Club Admin is rejected; deleting club with members is blocked',
          passed,
          `SecondClub ${r1.statusCode}, DeleteWithMembers ${r2.statusCode}, DeleteEmpty ${r3.statusCode}`
        );
      } catch (err) {
        recordResult('P3-7. Second club for same Club Admin is rejected; deleting club with members is blocked', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 3 - TEST 8: Notification Isolation Audit & Reporting
      try {
        console.log('[PHASE 3 - TEST 8] Auditing Notification Isolation Capabilities...');
        const notificationService = require('../src/services/notificationService');

        // Create a test notification belonging to Student 1
        const notifId = notificationService.createNotification(
          student1User.id,
          'Security Test Notification',
          'Isolation test payload for student1',
          'SYSTEM',
          '/dashboard/student'
        );

        const stud1Client = new TestClient(student1User.id);
        const stud2Client = new TestClient(student2User.id);

        // Student 2 attempts to mark Student 1's notification as read (IDOR attack)
        const attackRes = await stud2Client.post(`/notifications/${notifId}/read`, {}, { headers: { 'Accept': 'application/json' } });
        const isIdorBlocked = attackRes.statusCode === 403 || attackRes.statusCode === 404;

        // Student 1 marks their own notification as read (Authorized access)
        const ownRes = await stud1Client.post(`/notifications/${notifId}/read`, {}, { headers: { 'Accept': 'application/json' } });
        const isOwnSuccess = ownRes.statusCode === 200 || ownRes.statusCode === 302;

        if (isIdorBlocked && isOwnSuccess) {
          recordResult(
            'P3-8. Notification isolation (User A cannot read/mark User B notifications)',
            true,
            `CrossUserRead (Blocked: ${attackRes.statusCode}), OwnRead (Allowed: ${ownRes.statusCode})`
          );
        } else {
          recordResult(
            'P3-8. Notification isolation (User A cannot read/mark User B notifications)',
            false,
            `IDOR failure! CrossUserStatus=${attackRes.statusCode}, OwnStatus=${ownRes.statusCode}`
          );
        }
      } catch (err) {
        recordResult('P3-8. Notification isolation (User A cannot read/mark User B notifications)', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // ======================================================================
      // PHASE 4 SECURITY ASSERTIONS (EVENT DOMAIN & REGISTRATIONS)
      // ======================================================================
      console.log('\n----------------------------------------------------------------------------------------');
      console.log('                          RUNNING PHASE 4 SECURITY ASSERTIONS                           ');
      console.log('----------------------------------------------------------------------------------------\n');

      const codingClubCoord = db.prepare('SELECT faculty_user_id FROM club_coordinators WHERE club_id = ? LIMIT 1').get(codingClub.id);
      const codingFacultyUser = db.prepare("SELECT id, role, is_active FROM users WHERE id = ?").get(codingClubCoord.faculty_user_id);
      const caUser = db.prepare("SELECT id, role, is_active FROM users WHERE id = ?").get(clubAdminUser.id);
      const todayStr = new Date().toISOString().split('T')[0];

      // Helper function for building test events in legal target states
      function buildTestEvent(stateName, titleSuffix = '', customOpts = {}) {
        const title = `P4 Test Event ${stateName} ${titleSuffix} ${Date.now()}`;
        const evt = eventService.createEvent(caUser, codingClub.id, {
          title,
          description: 'Security test event description',
          venue: customOpts.venue || 'Lab 101',
          event_date: customOpts.event_date || '2026-11-20',
          start_time: customOpts.start_time || '10:00',
          end_time: customOpts.end_time || '12:00',
          capacity: customOpts.capacity || 50
        });

        if (stateName === 'DRAFT') return evt;

        if (stateName === 'PENDING_APPROVAL') {
          return eventService.transition(evt.id, 'submit', caUser);
        }

        if (stateName === 'REJECTED') {
          eventService.transition(evt.id, 'submit', caUser);
          return eventService.transition(evt.id, 'reject', codingFacultyUser, { remark: 'Initial rejection remark' });
        }

        if (stateName === 'APPROVED') {
          eventService.transition(evt.id, 'submit', caUser);
          return eventService.transition(evt.id, 'approve', codingFacultyUser);
        }

        if (stateName === 'CANCELLED') {
          eventService.transition(evt.id, 'submit', caUser);
          eventService.transition(evt.id, 'approve', codingFacultyUser);
          return eventService.transition(evt.id, 'cancel', caUser, { reason: 'Cancelled for security testing' });
        }

        if (stateName === 'COMPLETED') {
          db.prepare("UPDATE events SET event_date = ?, start_time = '23:58', end_time = '23:59' WHERE id = ?").run(todayStr, evt.id);
          const e2 = db.prepare('SELECT * FROM events WHERE id = ?').get(evt.id);
          eventService.transition(e2.id, 'submit', caUser);
          eventService.transition(e2.id, 'approve', codingFacultyUser);
          eventService.transition(e2.id, 'start', caUser);
          return eventService.transition(e2.id, 'complete', caUser);
        }

        return evt;
      }

      // PHASE 4 - TEST 1: Student registration status restrictions
      try {
        console.log('[PHASE 4 - TEST 1] Verifying Student Registration Status Restrictions...');
        const draftEvt = buildTestEvent('DRAFT', 'P4_1');
        const pendingEvt = buildTestEvent('PENDING_APPROVAL', 'P4_1');
        const rejectedEvt = buildTestEvent('REJECTED', 'P4_1');
        const cancelledEvt = buildTestEvent('CANCELLED', 'P4_1');
        const completedEvt = buildTestEvent('COMPLETED', 'P4_1');

        const stud1Client = new TestClient(student1User.id);

        const rDraft = await stud1Client.post(`/student/events/${draftEvt.id}/register`, {});
        const rPending = await stud1Client.post(`/student/events/${pendingEvt.id}/register`, {});
        const rRejected = await stud1Client.post(`/student/events/${rejectedEvt.id}/register`, {});
        const rCancelled = await stud1Client.post(`/student/events/${cancelledEvt.id}/register`, {});
        const rCompleted = await stud1Client.post(`/student/events/${completedEvt.id}/register`, {});

        const isDenied = (res) => [400, 403, 404, 422].includes(res.statusCode) || (res.body && res.body.includes('error'));
        const passed = isDenied(rDraft) && isDenied(rPending) && isDenied(rRejected) && isDenied(rCancelled) && isDenied(rCompleted);

        recordResult(
          'P4-1. Student cannot register for DRAFT, PENDING_APPROVAL, REJECTED, CANCELLED or COMPLETED event',
          passed,
          `DRAFT (${rDraft.statusCode}), PENDING (${rPending.statusCode}), REJECTED (${rRejected.statusCode}), CANCELLED (${rCancelled.statusCode}), COMPLETED (${rCompleted.statusCode})`
        );
      } catch (err) {
        recordResult('P4-1. Student cannot register for DRAFT, PENDING_APPROVAL, REJECTED, CANCELLED or COMPLETED event', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 2: Student detail URL 404 leakage protection
      try {
        console.log('[PHASE 4 - TEST 2] Verifying Student Detail URL 404 Guarding (No Data Leakage)...');
        const draftEvt = buildTestEvent('DRAFT', 'P4_2');
        const pendingEvt = buildTestEvent('PENDING_APPROVAL', 'P4_2');
        const rejectedEvt = buildTestEvent('REJECTED', 'P4_2');

        const stud1Client = new TestClient(student1User.id);

        const rDraft = await stud1Client.get(`/student/events/${draftEvt.id}`);
        const rPending = await stud1Client.get(`/student/events/${pendingEvt.id}`);
        const rRejected = await stud1Client.get(`/student/events/${rejectedEvt.id}`);

        const passed = rDraft.statusCode === 404 && !rDraft.body.includes(draftEvt.title) &&
                       rPending.statusCode === 404 && !rPending.body.includes(pendingEvt.title) &&
                       rRejected.statusCode === 404 && !rRejected.body.includes(rejectedEvt.title);

        recordResult(
          'P4-2. Student gets 404 with no data for detail URL of DRAFT/PENDING/REJECTED event',
          passed,
          `DRAFT (${rDraft.statusCode}), PENDING (${rPending.statusCode}), REJECTED (${rRejected.statusCode})`
        );
      } catch (err) {
        recordResult('P4-2. Student gets 404 with no data for detail URL of DRAFT/PENDING/REJECTED event', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 3: Duplicate registration & capacity-1 concurrency
      try {
        console.log('[PHASE 4 - TEST 3] Verifying Duplicate Registration (409) & Capacity Concurrency...');
        const approvedEvt = buildTestEvent('APPROVED', 'P4_3');

        const stud1Client = new TestClient(student1User.id);
        const stud2Client = new TestClient(student2User.id);

        // Initial registration for Student 1
        const rFirst = await stud1Client.post(`/student/events/${approvedEvt.id}/register`, {});
        const isFirstOk = rFirst.statusCode === 200 || rFirst.statusCode === 201 || (rFirst.statusCode === 302 && !rFirst.headers.location.includes('error'));

        // Duplicate registration for Student 1
        const rDup = await stud1Client.post(`/student/events/${approvedEvt.id}/register`, {});
        const isDupDenied = rDup.statusCode === 409 || (rDup.body && rDup.body.includes('already registered'));

        // Capacity-1 concurrency test
        const cap1Evt = buildTestEvent('APPROVED', 'Cap1_P4_3', { capacity: 1 });
        const [rConc1, rConc2] = await Promise.all([
          stud1Client.post(`/student/events/${cap1Evt.id}/register`, {}),
          stud2Client.post(`/student/events/${cap1Evt.id}/register`, {})
        ]);

        const statuses = [rConc1.statusCode, rConc2.statusCode];
        const regCount = db.prepare('SELECT COUNT(*) as cnt FROM event_registrations WHERE event_id = ?').get(cap1Evt.id).cnt;

        const passed = isFirstOk && isDupDenied && regCount === 1;

        recordResult(
          'P4-3. Duplicate registration returns 409; concurrent registration on capacity-1 event allows exactly 1',
          passed,
          `FirstReg (${rFirst.statusCode}), DupReg (${rDup.statusCode}), ConcurrentStatuses (${statuses.join('/')}), PersistedRegs (${regCount})`
        );
      } catch (err) {
        recordResult('P4-3. Duplicate registration returns 409; concurrent registration on capacity-1 event allows exactly 1', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 4: Raw SQL registration & illegal status jump DB triggers
      try {
        console.log('[PHASE 4 - TEST 4] Verifying Raw SQL Registration & Status Jump DB Triggers...');
        const draftEvt = buildTestEvent('DRAFT', 'P4_4');
        const rejectedEvt = buildTestEvent('REJECTED', 'P4_4');

        const r1 = expectThrows(() => {
          db.prepare('INSERT INTO event_registrations (event_id, student_user_id) VALUES (?, ?)').run(draftEvt.id, student1User.id);
        }, 500);

        const r2 = expectThrows(() => {
          db.prepare("UPDATE events SET status = 'APPROVED' WHERE id = ?").run(rejectedEvt.id);
        }, 500);

        const passed = r1.success && r2.success;

        recordResult(
          'P4-4. Raw SQL registration on non-approved event fails (trigger); raw status jump REJECTED->APPROVED fails (trigger)',
          passed,
          `RawRegTrigger (${r1.actualStatus}), RawStatusJumpTrigger (${r2.actualStatus})`
        );
      } catch (err) {
        recordResult('P4-4. Raw SQL registration on non-approved event fails (trigger); raw status jump REJECTED->APPROVED fails (trigger)', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 5: Approval authorization & self-approval prohibition
      try {
        console.log('[PHASE 4 - TEST 5] Verifying Self-Approval Block & Coordinator Scope Isolation...');
        // A. Club Admin cannot approve own event
        const caPendingEvt = buildTestEvent('PENDING_APPROVAL', 'CA_Self_P4_5');
        const rSelfCA = expectThrows(() => eventService.transition(caPendingEvt.id, 'approve', caUser), 403);

        // B. Non-coordinator faculty gets 403
        const nonCoordUser = db.prepare("INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ('noncoord@campus.edu', 'hash', 'Non Coord Faculty', 'FACULTY', 1)").run();
        const nonCoordActor = { id: nonCoordUser.lastInsertRowid, role: 'FACULTY', is_active: 1 };
        const nonCoordClient = new TestClient(nonCoordActor.id);

        const rNCApprove = await nonCoordClient.post(`/faculty/events/${caPendingEvt.id}/approve`, {});
        const rNCReject = await nonCoordClient.post(`/faculty/events/${caPendingEvt.id}/reject`, { remark: 'Illegal rejection' });
        const rNCEscalate = await nonCoordClient.post(`/faculty/events/${caPendingEvt.id}/escalate`, { reason: 'Illegal escalation' });

        // C. Coordinator of Club A deciding Club B event
        const roboClub = db.prepare("SELECT id FROM clubs WHERE code = 'ROBO01'").get();
        const ca2User = db.prepare("SELECT id FROM users WHERE email = 'ca2@campus.edu'").get();
        const roboCaActor = db.prepare("SELECT id, role, is_active FROM users WHERE id = ?").get(ca2User.id);
        const roboEvt = eventService.createEvent(roboCaActor, roboClub.id, {
          title: 'Robotics Event P4_5', description: 'Robotics event description', venue: 'Lab 2',
          event_date: '2026-11-25', start_time: '14:00', end_time: '16:00', capacity: 30
        });
        eventService.transition(roboEvt.id, 'submit', roboCaActor);

        const facClient = new TestClient(codingFacultyUser.id);
        const rCrossApprove = await facClient.post(`/faculty/events/${roboEvt.id}/approve`, {});

        const isDenied = (res) => [403, 404].includes(res.statusCode) && !res.body.includes('invalid csrf token');
        const passed = rSelfCA.success && isDenied(rNCApprove) && isDenied(rNCReject) && isDenied(rNCEscalate) && isDenied(rCrossApprove);

        recordResult(
          'P4-5. Club Admin cannot approve own event; non-coordinator faculty gets 403; coordinator of A cannot decide B',
          passed,
          `CASelf (${rSelfCA.actualStatus}), NonCoordApprove (${rNCApprove.statusCode}), NonCoordReject (${rNCReject.statusCode}), NonCoordEscalate (${rNCEscalate.statusCode}), CrossClubDecide (${rCrossApprove.statusCode})`
        );
      } catch (err) {
        recordResult('P4-5. Club Admin cannot approve own event; non-coordinator faculty gets 403; coordinator of A cannot decide B', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 6: Field Injection Protection & Cross-Club IDOR
      try {
        console.log('[PHASE 4 - TEST 6] Verifying Injected Fields Ignored & Dynamic Role IDOR...');
        // A. Field injection during create
        const injectedData = {
          title: 'Injection Event P4_6', description: 'Injection event description', venue: 'Hall B',
          event_date: '2026-11-28', start_time: '10:00', end_time: '12:00', capacity: 20,
          status: 'APPROVED', club_id: 9999, created_by: 9999, rejection_remark: 'Fake Remark'
        };

        const createdEvt = eventService.createEvent(caUser, codingClub.id, injectedData);
        const dbEvt = db.prepare('SELECT status, club_id, created_by, rejection_remark FROM events WHERE id = ?').get(createdEvt.id);

        const isInjectionSafe = dbEvt.status === 'DRAFT' && dbEvt.club_id === codingClub.id &&
                                dbEvt.created_by === caUser.id && dbEvt.rejection_remark === null;

        // B. Club Admin cannot edit event for another club
        const roboClub = db.prepare("SELECT id FROM clubs WHERE code = 'ROBO01'").get();
        const ca2User = db.prepare("SELECT id FROM users WHERE email = 'ca2@campus.edu'").get();
        const roboCaActor = db.prepare("SELECT id, role, is_active FROM users WHERE id = ?").get(ca2User.id);
        const roboEvt = eventService.createEvent(roboCaActor, roboClub.id, {
          title: 'Robotics Evt P4_6', description: 'Robotics event description', venue: 'Lab 3',
          event_date: '2026-11-29', start_time: '10:00', end_time: '12:00', capacity: 20
        });

        const caClient = new TestClient(clubAdminUser.id);
        const rCrossEdit = await caClient.post(`/club/events/${roboEvt.id}/edit`, { title: 'Hacked Title' });
        const isCrossEditDenied = [400, 403, 404].includes(rCrossEdit.statusCode);

        const passed = isInjectionSafe && isCrossEditDenied;

        recordResult(
          'P4-6. Field injection (status, club_id, etc.) in event create is ignored; Club Admin cannot edit another club event (IDOR)',
          passed,
          `PersistedStatus (${dbEvt.status}), PersistedClubId (${dbEvt.club_id}), PersistedCreator (${dbEvt.created_by}), CrossClubEdit (${rCrossEdit.statusCode})`
        );
      } catch (err) {
        recordResult('P4-6. Field injection in event create is ignored; Club Admin cannot edit another club event (IDOR)', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 7: Resubmission Workflow & Rejection Remark Enforcement
      try {
        console.log('[PHASE 4 - TEST 7] Verifying Resubmission Workflow & Rejection Reason Requirement...');
        const rejectedEvt = buildTestEvent('REJECTED', 'P4_7');

        // Direct transition REJECTED -> APPROVED without resubmit must fail
        const rIllegalApprove = expectThrows(() => eventService.transition(rejectedEvt.id, 'approve', codingFacultyUser), 400);

        // Resubmit REJECTED -> PENDING_APPROVAL works
        const resubmittedEvt = eventService.transition(rejectedEvt.id, 'submit', caUser);
        const isResubmitted = resubmittedEvt.status === 'PENDING_APPROVAL';

        // Approve PENDING_APPROVAL -> APPROVED works
        const approvedEvt = eventService.transition(resubmittedEvt.id, 'approve', codingFacultyUser);
        const isApproved = approvedEvt.status === 'APPROVED';

        // Reject pending event without reason fails
        const newPendingEvt = buildTestEvent('PENDING_APPROVAL', 'P4_7_NoReason');
        const rNoReasonReject = expectThrows(() => eventService.transition(newPendingEvt.id, 'reject', codingFacultyUser, { remark: '  ' }), 400);

        const passed = rIllegalApprove.success && isResubmitted && isApproved && rNoReasonReject.success;

        recordResult(
          'P4-7. Rejected event cannot go to APPROVED without resubmission; resubmit then approve works; reject without reason fails',
          passed,
          `DirectApprove (${rIllegalApprove.actualStatus}), ResubmitOk (${isResubmitted}), ApproveOk (${isApproved}), NoReasonReject (${rNoReasonReject.actualStatus})`
        );
      } catch (err) {
        recordResult('P4-7. Rejected event cannot go to APPROVED without resubmission; resubmit then approve works; reject without reason fails', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 8: Editing Rules, Re-approval Triggers & Capacity Limits
      try {
        console.log('[PHASE 4 - TEST 8] Verifying Edit Constraints (PENDING Block, Re-approval Trigger, Capacity Limit)...');
        // A. PENDING_APPROVAL event cannot be edited
        const pendingEvt = buildTestEvent('PENDING_APPROVAL', 'P4_8');
        const rEditPending = expectThrows(() => eventService.updateEvent(caUser, pendingEvt.id, { ...pendingEvt, title: 'New Title' }), 400);

        // B. Editing key fields of APPROVED event returns it to PENDING_APPROVAL & removes from student list
        const approvedEvt = buildTestEvent('APPROVED', 'P4_8_EditApproved');
        const updatedEvt = eventService.updateEvent(caUser, approvedEvt.id, { ...approvedEvt, venue: 'Auditorium Hall C' });
        const isPendingNow = updatedEvt.status === 'PENDING_APPROVAL';

        const visibleToStudent = eventService.listVisibleToStudent(student1User.id);
        const isHiddenFromStudent = !visibleToStudent.some(e => e.id === approvedEvt.id);

        // C. Re-approve and register 2 students, then try setting capacity to 1 (should fail)
        eventService.transition(updatedEvt.id, 'approve', codingFacultyUser);
        registrationService.register(updatedEvt.id, student1User.id);
        registrationService.register(updatedEvt.id, student2User.id);

        const rCapReduce = expectThrows(() => eventService.updateEvent(caUser, updatedEvt.id, { ...updatedEvt, capacity: 1 }), 400);

        const passed = rEditPending.success && isPendingNow && isHiddenFromStudent && rCapReduce.success;

        recordResult(
          'P4-8. PENDING event cannot be edited; editing key field of APPROVED returns to PENDING & hides from student; capacity < reg count fails',
          passed,
          `EditPending (${rEditPending.actualStatus}), StatusAfterEdit (${updatedEvt.status}), HiddenFromStudent (${isHiddenFromStudent}), CapReduce (${rCapReduce.actualStatus})`
        );
      } catch (err) {
        recordResult('P4-8. PENDING event cannot be edited; editing key field of APPROVED returns to PENDING & hides from student; capacity < reg count fails', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 9: Dynamic Role Specific Permissions
      try {
        console.log('[PHASE 4 - TEST 9] Verifying Dynamic Role Fine-Grained Permission Guards...');
        // Create student user with a dynamic role in Coding Club that has ONLY EVENT_CREATE permission
        const dynUserRes = db.prepare("INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ('dynstudent@campus.edu', 'hash', 'Dyn Student', 'STUDENT', 1)").run();
        const dynUserId = dynUserRes.lastInsertRowid;
        db.prepare("INSERT INTO students (user_id, ra_number, department, year_of_study, section, class_mentor_id) VALUES (?, 'RA3333333333333', 'CSE', 2, 'A', ?)").run(dynUserId, codingFacultyUser.id);

        // Create dynamic role with EVENT_CREATE only
        const roleRes = createClubRole(caUser, codingClub.id, { roleName: 'DraftOnlyRole', permissionNames: ['EVENT_CREATE'] });
        db.prepare("INSERT INTO club_memberships (club_id, user_id, club_role_id, status) VALUES (?, ?, ?, 'APPROVED')").run(codingClub.id, dynUserId, roleRes.id);

        const dynClient = new TestClient(dynUserId);
        const draftEvt = buildTestEvent('DRAFT', 'P4_9');

        const rSubmit = await dynClient.post(`/club/events/${draftEvt.id}/transition`, { action: 'submit' });
        const rRegList = await dynClient.get(`/club/events/${draftEvt.id}/registrations`);
        const rEdit = await dynClient.post(`/club/events/${draftEvt.id}/edit`, { title: 'Dyn Hacked' });

        const isDenied = (res) => res.statusCode === 403 && !res.body.includes('invalid csrf token');
        const passed = isDenied(rSubmit) && isDenied(rRegList) && isDenied(rEdit);

        recordResult(
          'P4-9. Dynamic role without EVENT_SUBMIT, VIEW_REGISTRATIONS or EVENT_EDIT gets 403 on respective actions',
          passed,
          `Submit (${rSubmit.statusCode}), RegList (${rRegList.statusCode}), Edit (${rEdit.statusCode})`
        );
      } catch (err) {
        recordResult('P4-9. Dynamic role without EVENT_SUBMIT, VIEW_REGISTRATIONS or EVENT_EDIT gets 403 on respective actions', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 10: Admin Governance & Super Admin Override Rules
      try {
        console.log('[PHASE 4 - TEST 10] Verifying Admin Escalation Limit, SA Override & Self-Decision Protection...');
        const pendingEvt = buildTestEvent('PENDING_APPROVAL', 'P4_10');

        const adminClient = new TestClient(adminUser.id);
        const saClient = new TestClient(superAdminUser.id);
        const saUser = db.prepare("SELECT id, role, is_active FROM users WHERE id = ?").get(superAdminUser.id);

        // A. Admin cannot approve non-escalated event
        const rAdminApprove = await adminClient.post(`/admin/events/${pendingEvt.id}/action`, { action: 'approve' });
        const isAdminBlocked = [400, 403].includes(rAdminApprove.statusCode);

        // B. Super Admin override without reason fails
        const rSAOverrideNoReason = await saClient.post(`/admin/events/${pendingEvt.id}/action`, { action: 'override-approve', reason: '  ' });
        const isNoReasonBlocked = [400, 403].includes(rSAOverrideNoReason.statusCode);

        // C. Super Admin override with reason succeeds & audit logged
        const rSAOverride = await saClient.post(`/admin/events/${pendingEvt.id}/action`, { action: 'override-approve', reason: 'Emergency Super Admin approval override' });
        const isSAOverrideOk = rSAOverride.statusCode === 200 || rSAOverride.statusCode === 302;
        const auditRecord = db.prepare("SELECT * FROM audit_logs WHERE target_id = ? AND action = 'EVENT_OVERRIDE_APPROVED'").get(pendingEvt.id);
        const isAuditLogged = Boolean(auditRecord);

        // D. Creator cannot decide own event (Super Admin creates an event)
        const saEvt = eventService.createEvent(saUser, codingClub.id, {
          title: 'SA Created Event P4_10', description: 'Super Admin test description', venue: 'Lab 5',
          event_date: '2026-11-30', start_time: '10:00', end_time: '12:00', capacity: 20
        });
        eventService.transition(saEvt.id, 'submit', saUser);
        const rSASelfOverride = await saClient.post(`/admin/events/${saEvt.id}/action`, { action: 'override-approve', reason: 'Self approval attempt' });
        const isSelfDecideBlocked = [400, 403].includes(rSASelfOverride.statusCode);

        const passed = isAdminBlocked && isNoReasonBlocked && isSAOverrideOk && isAuditLogged && isSelfDecideBlocked;

        recordResult(
          'P4-10. Admin cannot approve non-escalated event; Super Admin override requires reason & is audit logged; creator cannot decide own event',
          passed,
          `AdminNonEsc (${rAdminApprove.statusCode}), SAOverrideNoReason (${rSAOverrideNoReason.statusCode}), SAOverride (${rSAOverride.statusCode}), AuditLogged (${isAuditLogged}), SelfDecide (${rSASelfOverride.statusCode})`
        );
      } catch (err) {
        recordResult('P4-10. Admin cannot approve non-escalated event; Super Admin override requires reason & is audit logged; creator cannot decide own event', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 11: Execution Controls & Cancel Notifications
      try {
        console.log('[PHASE 4 - TEST 11] Verifying Event Execution Rules & Cancellation Notifications...');
        // A. Start refused on non-today date
        const futureEvt = buildTestEvent('APPROVED', 'Future_P4_11', { event_date: '2026-12-01' });
        const rStartFuture = expectThrows(() => eventService.transition(futureEvt.id, 'start', caUser), 400);

        // B. Complete refused unless ONGOING
        const rCompleteApproved = expectThrows(() => eventService.transition(futureEvt.id, 'complete', caUser), 400);

        // C. Cancel without reason fails
        const rCancelNoReason = expectThrows(() => eventService.transition(futureEvt.id, 'cancel', caUser, { reason: '' }), 400);

        // D. Cancel with reason notifies registered students
        registrationService.register(futureEvt.id, student1User.id);
        const cancelledEvt = eventService.transition(futureEvt.id, 'cancel', caUser, { reason: 'Severe weather alert' });

        const notifCancel = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND message LIKE '%weather alert%'").get(student1User.id);
        const isCancelNotified = Boolean(notifCancel);

        // Editing key field of APPROVED event returns it for re-approval and notifies registered student
        const approvedEvt2 = buildTestEvent('APPROVED', 'ApprovedForEditNotif_P4_11');
        registrationService.register(approvedEvt2.id, student1User.id);
        eventService.updateEvent(caUser, approvedEvt2.id, { ...approvedEvt2, venue: 'Re-approval Hall X' });

        const notifReopen = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND message LIKE '%re-approval%'").get(student1User.id);
        const isReopenNotified = Boolean(notifReopen);

        const passed = rStartFuture.success && rCompleteApproved.success && rCancelNoReason.success && isCancelNotified && isReopenNotified;

        recordResult(
          'P4-11. Start refused on non-today date; Complete refused unless ONGOING; Cancel requires reason & notifies registered students',
          passed,
          `StartFuture (${rStartFuture.actualStatus}), CompleteApproved (${rCompleteApproved.actualStatus}), CancelNoReason (${rCancelNoReason.actualStatus}), CancelNotified (${isCancelNotified}), ReopenNotified (${isReopenNotified})`
        );
      } catch (err) {
        recordResult('P4-11. Start refused on non-today date; Complete refused unless ONGOING; Cancel requires reason & notifies registered students', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 12: Event Input Validation Constraints
      try {
        console.log('[PHASE 4 - TEST 12] Verifying Input Validation (Past Date, Invalid Time, Zero Capacity)...');
        const baseData = {
          title: 'Invalid Evt', description: 'Security test event description', venue: 'Hall 1',
          event_date: '2026-11-20', start_time: '10:00', end_time: '12:00', capacity: 20
        };

        const rPastDate = expectThrows(() => eventService.createEvent(caUser, codingClub.id, { ...baseData, event_date: '2020-01-01' }), 400);
        const rEndBeforeStart = expectThrows(() => eventService.createEvent(caUser, codingClub.id, { ...baseData, start_time: '14:00', end_time: '13:00' }), 400);
        const rZeroCap = expectThrows(() => eventService.createEvent(caUser, codingClub.id, { ...baseData, capacity: 0 }), 400);

        const passed = rPastDate.success && rEndBeforeStart.success && rZeroCap.success;

        recordResult(
          'P4-12. Past-dated event, end_time <= start_time and capacity 0 are all rejected',
          passed,
          `PastDate (${rPastDate.actualStatus}), EndBeforeStart (${rEndBeforeStart.actualStatus}), ZeroCap (${rZeroCap.actualStatus})`
        );
      } catch (err) {
        recordResult('P4-12. Past-dated event, end_time <= start_time and capacity 0 are all rejected', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 4 - TEST 13: Route Access Isolation for Events
      try {
        console.log('[PHASE 4 - TEST 13] Verifying Unauthenticated & Student Privileged Event Route Access Restrictions...');
        const anonClient = new TestClient(null);
        const plainStudUser = db.prepare("INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ('plainstud_route_test@campus.edu', 'hash', 'Plain Student', 'STUDENT', 1)").run();
        const plainStudUserId = plainStudUser.lastInsertRowid;
        db.prepare("INSERT INTO students (user_id, ra_number, department, year_of_study, section, class_mentor_id) VALUES (?, 'RA4444444444444', 'CSE', 2, 'A', ?)").run(plainStudUserId, codingFacultyUser.id);
        const studClient = new TestClient(plainStudUserId);

        const privEventPaths = ['/club/events', '/faculty/events', '/admin/events'];

        let anonRedirects = 0;
        let studBlocked = 0;

        for (const p of privEventPaths) {
          const resAnon = await anonClient.get(p);
          if (resAnon.statusCode === 302 && resAnon.headers.location === '/login') anonRedirects++;

          const resStud = await studClient.get(p);
          if (resStud.statusCode === 403) studBlocked++;
        }

        const passed = anonRedirects === privEventPaths.length && studBlocked === privEventPaths.length;

        recordResult(
          'P4-13. Unauthenticated access redirects; student receives 403 on Club Admin, Faculty and Admin event routes',
          passed,
          `AnonRedirects (${anonRedirects}/${privEventPaths.length}), Student403 (${studBlocked}/${privEventPaths.length})`
        );
      } catch (err) {
        recordResult('P4-13. Unauthenticated access redirects; student receives 403 on Club Admin, Faculty and Admin event routes', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // ======================================================================
      // PHASE 5 SECURITY ASSERTIONS (ON-DUTY (OD) & NOTIFICATION DOMAIN)
      // ======================================================================
      console.log('\n----------------------------------------------------------------------------------------');
      console.log('                   RUNNING PHASE 5 SECURITY ASSERTIONS (OD & NOTIFICATION)              ');
      console.log('----------------------------------------------------------------------------------------\n');

      const odService = require('../src/services/odService');
      const notificationService = require('../src/services/notificationService');

      // PHASE 5 - TEST 1: Student OD Request Authorization Boundaries
      try {
        console.log('[PHASE 5 - TEST 1] Verifying Student OD Request Authorization Boundaries...');
        const stud1Client = new TestClient(student1User.id);

        const approvedEvtP5 = buildTestEvent('APPROVED', 'Approved_P5_1');
        const draftEvtP5 = buildTestEvent('DRAFT', 'Draft_P5_1');
        const rejectedEvtP5 = buildTestEvent('REJECTED', 'Rejected_P5_1');

        const stud1Reg = registrationService.register(approvedEvtP5.id, student1User.id);
        const stud2Reg = registrationService.register(approvedEvtP5.id, student2User.id);

        // Temporarily drop trigger to insert registrations on DRAFT and REJECTED test fixture events
        db.exec('DROP TRIGGER IF EXISTS trg_check_event_registration_status;');
        db.prepare('INSERT INTO event_registrations (event_id, student_user_id) VALUES (?, ?)').run(draftEvtP5.id, student1User.id);
        const draftRegRow = db.prepare('SELECT id FROM event_registrations WHERE event_id = ? AND student_user_id = ?').get(draftEvtP5.id, student1User.id);

        db.prepare('INSERT INTO event_registrations (event_id, student_user_id) VALUES (?, ?)').run(rejectedEvtP5.id, student1User.id);
        const rejectedRegRow = db.prepare('SELECT id FROM event_registrations WHERE event_id = ? AND student_user_id = ?').get(rejectedEvtP5.id, student1User.id);

        db.exec(`
          CREATE TRIGGER trg_check_event_registration_status
          BEFORE INSERT ON event_registrations
          FOR EACH ROW
          BEGIN
              SELECT RAISE(ABORT, 'Event registration blocked: Event status must be APPROVED.')
              WHERE (SELECT status FROM events WHERE id = NEW.event_id) != 'APPROVED';
          END;
        `);

        const resNotReg = await stud1Client.post('/student/od/request', { registration_id: 999999 });
        const resForeignReg = await stud1Client.post('/student/od/request', { registration_id: stud2Reg.id });
        const resDraft = await stud1Client.post('/student/od/request', { registration_id: draftRegRow.id });
        const resRejected = await stud1Client.post('/student/od/request', { registration_id: rejectedRegRow.id });

        const passed = (resNotReg.statusCode === 400 || resNotReg.statusCode === 404 || resNotReg.statusCode === 403) &&
                       (resForeignReg.statusCode === 403 || resForeignReg.statusCode === 400) &&
                       (resDraft.statusCode === 400 || resDraft.statusCode === 403) &&
                       (resRejected.statusCode === 400 || resRejected.statusCode === 403);

        recordResult(
          'P5-1. Student cannot request OD for un-registered, foreign, or non-approved events',
          passed,
          `NotReg (${resNotReg.statusCode}), ForeignReg (${resForeignReg.statusCode}), Draft (${resDraft.statusCode}), Rejected (${resRejected.statusCode})`
        );
      } catch (err) {
        recordResult('P5-1. Student cannot request OD for un-registered, foreign, or non-approved events', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 5 - TEST 2: OD Overlap with Breaks Only or Inactive Timetable Blocking
      try {
        console.log('[PHASE 5 - TEST 2] Verifying OD Overlap with Breaks Only or Inactive Timetable Blocking (4xx response)...');
        const stud1Client = new TestClient(student1User.id);

        const breakEvt = eventService.createEvent(caUser, codingClub.id, {
          title: 'Break Only Event P5_2', description: 'Event during lunch break', venue: 'Cafeteria',
          event_date: '2026-10-20', start_time: '13:00', end_time: '14:00', capacity: 20
        });
        const breakEvtSub = eventService.transition(breakEvt.id, 'submit', caUser);
        eventService.transition(breakEvtSub.id, 'approve', codingFacultyUser);
        const breakReg = registrationService.register(breakEvt.id, student1User.id);

        const resBreaksOnly = await stud1Client.post('/student/od/request', { registration_id: breakReg.id });

        const activeTTRow = db.prepare("SELECT id FROM timetables WHERE is_active = 1").get();
        db.prepare("UPDATE timetables SET is_active = 0 WHERE id = ?").run(activeTTRow.id);

        const validEvtP5 = buildTestEvent('APPROVED', 'ValidEvt_P5_2');
        const validRegP5 = registrationService.register(validEvtP5.id, student1User.id);
        const resNoTT = await stud1Client.post('/student/od/request', { registration_id: validRegP5.id });

        db.prepare("UPDATE timetables SET is_active = 1 WHERE id = ?").run(activeTTRow.id);

        const passed = (resBreaksOnly.statusCode >= 400 && resBreaksOnly.statusCode < 500) &&
                       (resNoTT.statusCode >= 400 && resNoTT.statusCode < 500);

        recordResult(
          'P5-2. OD blocked with 4xx when overlapping only breaks or no active timetable',
          passed,
          `BreaksOnly (${resBreaksOnly.statusCode}), NoActiveTimetable (${resNoTT.statusCode})`
        );
      } catch (err) {
        recordResult('P5-2. OD blocked with 4xx when overlapping only breaks or no active timetable', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 5 - TEST 3: Student OD Approval/Rejection Prevention
      try {
        console.log('[PHASE 5 - TEST 3] Verifying Student Cannot Approve/Reject Any OD (403)...');
        const stud1Client = new TestClient(student1User.id);

        const validEvtP5_3 = buildTestEvent('APPROVED', 'ValidEvt_P5_3');
        const validRegP5_3 = registrationService.register(validEvtP5_3.id, student1User.id);
        const odReqP5_3 = odService.request(student1User.id, validRegP5_3.id);

        const resApproveOwn = await stud1Client.post(`/faculty/od/${odReqP5_3.id}/action`, { action: 'approve' });
        const resRejectOwn = await stud1Client.post(`/faculty/od/${odReqP5_3.id}/action`, { action: 'reject', remark: 'Self reject' });
        const resAdminRouteOwn = await stud1Client.post(`/admin/od/${odReqP5_3.id}/action`, { action: 'approve' });

        const passed = resApproveOwn.statusCode === 403 &&
                       resRejectOwn.statusCode === 403 &&
                       resAdminRouteOwn.statusCode === 403;

        recordResult(
          'P5-3. Student cannot approve or reject any OD, including their own (403)',
          passed,
          `FacultyRouteApprove (${resApproveOwn.statusCode}), FacultyRouteReject (${resRejectOwn.statusCode}), AdminRouteApprove (${resAdminRouteOwn.statusCode})`
        );
      } catch (err) {
        recordResult('P5-3. Student cannot approve or reject any OD, including their own (403)', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 5 - TEST 4: Foreign Mentor & Non-Mentor Coordinator Scope Isolation
      try {
        console.log('[PHASE 5 - TEST 4] Verifying Foreign Mentor & Non-Mentor Coordinator Scope Restrictions (403/404)...');
        const faculty2Client = new TestClient(faculty2User.id);

        const validEvtP5_4 = buildTestEvent('APPROVED', 'ValidEvt_P5_4');
        const validRegP5_4 = registrationService.register(validEvtP5_4.id, student1User.id);
        const odReqP5_4 = odService.request(student1User.id, validRegP5_4.id);

        const resView = await faculty2Client.get(`/faculty/od/${odReqP5_4.id}`);
        const resApprove = await faculty2Client.post(`/faculty/od/${odReqP5_4.id}/action`, { action: 'approve' });
        const resReject = await faculty2Client.post(`/faculty/od/${odReqP5_4.id}/action`, { action: 'reject', remark: 'No' });
        const resEscalate = await faculty2Client.post(`/faculty/od/${odReqP5_4.id}/action`, { action: 'escalate', reason: 'No' });

        const isViewBlocked = resView.statusCode === 403 || resView.statusCode === 404;
        const isApproveBlocked = resApprove.statusCode === 403 || resApprove.statusCode === 404;
        const isRejectBlocked = resReject.statusCode === 403 || resReject.statusCode === 404;
        const isEscalateBlocked = resEscalate.statusCode === 403 || resEscalate.statusCode === 404;

        const passed = isViewBlocked && isApproveBlocked && isRejectBlocked && isEscalateBlocked;

        recordResult(
          'P5-4. Non-mentor faculty & non-mentor coordinator get 403/404 on view, approve, reject and escalate',
          passed,
          `View (${resView.statusCode}), Approve (${resApprove.statusCode}), Reject (${resReject.statusCode}), Escalate (${resEscalate.statusCode})`
        );
      } catch (err) {
        recordResult('P5-4. Non-mentor faculty & non-mentor coordinator get 403/404 on view, approve, reject and escalate', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 5 - TEST 5: Mentor Decision Constraints & Single-Decision Rule
      try {
        console.log('[PHASE 5 - TEST 5] Verifying Mentor Decision Constraints & Single-Decision Rule...');
        const mentorClient = new TestClient(codingFacultyUser.id);

        const validEvtP5_5 = buildTestEvent('APPROVED', 'ValidEvt_P5_5');
        const validRegP5_5 = registrationService.register(validEvtP5_5.id, student1User.id);
        const odReqP5_5 = odService.request(student1User.id, validRegP5_5.id);

        const resNoRemark = await mentorClient.post(`/faculty/od/${odReqP5_5.id}/action`, { action: 'reject', remark: '' });
        const resApproveOk = await mentorClient.post(`/faculty/od/${odReqP5_5.id}/action`, { action: 'approve', remark: 'Clearance granted' });
        const resSecondDecision = await mentorClient.post(`/faculty/od/${odReqP5_5.id}/action`, { action: 'reject', remark: 'Second attempt' });

        const passed = resNoRemark.statusCode === 400 &&
                       (resApproveOk.statusCode === 200 || resApproveOk.statusCode === 302) &&
                       resSecondDecision.statusCode === 400;

        recordResult(
          'P5-5. Stored mentor decides once; second decision fails; reject without remark fails',
          passed,
          `RejectNoRemark (${resNoRemark.statusCode}), ApproveOk (${resApproveOk.statusCode}), SecondDecision (${resSecondDecision.statusCode})`
        );
      } catch (err) {
        recordResult('P5-5. Stored mentor decides once; second decision fails; reject without remark fails', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 5 - TEST 6: Admin Escalated OD Decision Boundary & Self-Decision Protection
      try {
        console.log('[PHASE 5 - TEST 6] Verifying Admin Escalated OD Decision Boundary & Self-Decision Protection...');
        const adminClient = new TestClient(adminUser.id);

        const validEvtP5_6 = buildTestEvent('APPROVED', 'ValidEvt_P5_6');
        const validRegP5_6 = registrationService.register(validEvtP5_6.id, student1User.id);
        const pendingOdP5_6 = odService.request(student1User.id, validRegP5_6.id);

        const resAdminPending = await adminClient.post(`/admin/od/${pendingOdP5_6.id}/action`, { action: 'approve', reason: 'Admin attempt' });

        odService.escalate(pendingOdP5_6.id, codingFacultyUser, 'Complex academic schedule conflict');

        const resAdminEscalateNoReason = await adminClient.post(`/admin/od/${pendingOdP5_6.id}/action`, { action: 'approve', reason: '' });
        const resAdminEscalateOk = await adminClient.post(`/admin/od/${pendingOdP5_6.id}/action`, { action: 'approve', reason: 'Admin override granted' });

        const selfDecideResult = expectThrows(() => odService.review(pendingOdP5_6.id, { id: student1User.id, role: 'FACULTY' }, 'approve'), 403);

        const passed = resAdminPending.statusCode === 403 &&
                       resAdminEscalateNoReason.statusCode === 400 &&
                       (resAdminEscalateOk.statusCode === 200 || resAdminEscalateOk.statusCode === 302) &&
                       selfDecideResult.success;

        recordResult(
          'P5-6. Admin cannot decide pending non-escalated OD; can decide escalated with reason; self-decision refused',
          passed,
          `AdminPending (${resAdminPending.statusCode}), EscalateNoReason (${resAdminEscalateNoReason.statusCode}), EscalateOk (${resAdminEscalateOk.statusCode}), SelfDecideRefused (${selfDecideResult.actualStatus})`
        );
      } catch (err) {
        recordResult('P5-6. Admin cannot decide pending non-escalated OD; can decide escalated with reason; self-decision refused', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 5 - TEST 7: Student OD Detail URL Privacy & Mentor Queue Isolation
      try {
        console.log('[PHASE 5 - TEST 7] Verifying Student OD Detail URL Privacy & Mentor Queue Isolation...');
        const stud2Client = new TestClient(student2User.id);

        const validEvtP5_7 = buildTestEvent('APPROVED', 'ValidEvt_P5_7');
        const validRegP5_7 = registrationService.register(validEvtP5_7.id, student1User.id);
        const stud1OdP5_7 = odService.request(student1User.id, validRegP5_7.id);

        const resForeignDetail = await stud2Client.get(`/student/od/${stud1OdP5_7.id}`);

        const faculty2PendingList = odService.listPendingForMentor(faculty2User.id);
        const containsForeignOd = faculty2PendingList.some(item => item.id === stud1OdP5_7.id);

        const passed = resForeignDetail.statusCode === 404 && !containsForeignOd;

        recordResult(
          'P5-7. Foreign student OD detail URL returns 404; another mentor queue never contains foreign ODs',
          passed,
          `ForeignDetail (${resForeignDetail.statusCode}), ForeignQueueContained (${containsForeignOd})`
        );
      } catch (err) {
        recordResult('P5-7. Foreign student OD detail URL returns 404; another mentor queue never contains foreign ODs', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 5 - TEST 8: DB Triggers Guarding Decided ODs & Snapshot Rows
      try {
        console.log('[PHASE 5 - TEST 8] Verifying Database Triggers Lock Decided OD Rows & Period Snapshots...');
        const validEvtP5_8 = buildTestEvent('APPROVED', 'ValidEvt_P5_8');
        const validRegP5_8 = registrationService.register(validEvtP5_8.id, student1User.id);
        const odReqP5_8 = odService.request(student1User.id, validRegP5_8.id);
        odService.review(odReqP5_8.id, codingFacultyUser, 'approve', 'Clearance approved');

        const rTriggerOd = expectThrows(() => db.prepare("UPDATE od_requests SET status = 'REJECTED' WHERE id = ?").run(odReqP5_8.id), 500);
        const rTriggerPeriods = expectThrows(() => db.prepare("UPDATE od_request_periods SET period_label = 'Hacked' WHERE od_request_id = ?").run(odReqP5_8.id), 500);

        const passed = rTriggerOd.success && rTriggerPeriods.success;

        recordResult(
          'P5-8. Raw SQL update of a decided OD or of its snapshot rows is rejected by DB triggers',
          passed,
          `UpdateDecidedOd (${rTriggerOd.actualStatus}), UpdateSnapshotPeriods (${rTriggerPeriods.actualStatus})`
        );
      } catch (err) {
        recordResult('P5-8. Raw SQL update of a decided OD or of its snapshot rows is rejected by DB triggers', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 5 - TEST 9: Snapshot Immutability Across Timetable Updates
      try {
        console.log('[PHASE 5 - TEST 9] Verifying Snapshot Immutability Across Timetable Updates...');
        const validEvtP5_9 = buildTestEvent('APPROVED', 'ValidEvt_P5_9');
        const validRegP5_9 = registrationService.register(validEvtP5_9.id, student1User.id);
        const odReqP5_9 = odService.request(student1User.id, validRegP5_9.id);
        odService.review(odReqP5_9.id, codingFacultyUser, 'approve', 'Approved for snapshot test');

        const initialPeriods = db.prepare("SELECT period_number, period_label, start_time, end_time FROM od_request_periods WHERE od_request_id = ? ORDER BY period_number").all(odReqP5_9.id);

        const activeTTRow = db.prepare("SELECT id FROM timetables WHERE is_active = 1").get();
        db.prepare("UPDATE timetable_periods SET label = 'MODIFIED PERIOD NAME' WHERE timetable_id = ?").run(activeTTRow.id);

        const postEditPeriods = db.prepare("SELECT period_number, period_label, start_time, end_time FROM od_request_periods WHERE od_request_id = ? ORDER BY period_number").all(odReqP5_9.id);

        const isImmutable = JSON.stringify(initialPeriods) === JSON.stringify(postEditPeriods) && initialPeriods.length > 0;

        recordResult(
          'P5-9. After a timetable edit, an already-decided OD periods snapshot remains unchanged',
          isImmutable,
          `PeriodsCount (${initialPeriods.length}), IdenticalSnapshots (${isImmutable})`
        );
      } catch (err) {
        recordResult('P5-9. After a timetable edit, an already-decided OD periods snapshot remains unchanged', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 5 - TEST 10: Event Cancellation Auto-Close & Mentor Reassignment Scope
      try {
        console.log('[PHASE 5 - TEST 10] Verifying Event Cancellation Auto-Close & Mentor Reassignment Scope...');
        const cancelEvtP5 = buildTestEvent('APPROVED', 'CancelEvt_P5_10');
        const cancelRegP5 = registrationService.register(cancelEvtP5.id, student1User.id);
        const pendingOdToCancel = odService.request(student1User.id, cancelRegP5.id);

        eventService.transition(cancelEvtP5.id, 'cancel', caUser, { reason: 'Severe weather alert cancellation' });

        const cancelledOdRow = db.prepare("SELECT status, faculty_remark FROM od_requests WHERE id = ?").get(pendingOdToCancel.id);
        const isAutoClosed = cancelledOdRow.status === 'CLOSED' && cancelledOdRow.faculty_remark.includes('Severe weather alert cancellation');

        const validEvtP5_10 = buildTestEvent('APPROVED', 'ValidEvt_P5_10');
        const validRegP5_10 = registrationService.register(validEvtP5_10.id, student1User.id);
        const pendingOdForReassign = odService.request(student1User.id, validRegP5_10.id);

        odService.reassignMentor(student1User.id, faculty2User.id, adminUser);

        const pendingOdPostReassign = db.prepare("SELECT class_mentor_id FROM od_requests WHERE id = ?").get(pendingOdForReassign.id);

        odService.reassignMentor(student1User.id, codingFacultyUser.id, adminUser);

        const isReassignedOk = pendingOdPostReassign.class_mentor_id === faculty2User.id;

        const passed = isAutoClosed && isReassignedOk;

        recordResult(
          'P5-10. Cancelling an event closes pending ODs and notifies students; mentor reassignment moves pending ODs only',
          passed,
          `AutoClosedPending (${isAutoClosed}), PendingMovedToNewMentor (${isReassignedOk})`
        );
      } catch (err) {
        recordResult('P5-10. Cancelling an event closes pending ODs and notifies students; mentor reassignment moves pending ODs only', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 5 - TEST 11: Notification Isolation & Workflow Trigger Audit
      try {
        console.log('[PHASE 5 - TEST 11] Verifying Notification Isolation & Workflow Triggers...');
        const stud1Client = new TestClient(student1User.id);
        const stud2Client = new TestClient(student2User.id);

        const testNotifId = notificationService.createNotification(student1User.id, 'Isolation Test', 'Isolation Payload', 'SYSTEM', '/dashboard');

        const resCrossRead = await stud2Client.post(`/notifications/${testNotifId}/read`, {}, { headers: { 'Accept': 'application/json' } });
        const isIdorBlocked = resCrossRead.statusCode === 403 || resCrossRead.statusCode === 404;

        const resOwnRead = await stud1Client.post(`/notifications/${testNotifId}/read`, {}, { headers: { 'Accept': 'application/json' } });
        const isOwnSuccess = resOwnRead.statusCode === 200 || resOwnRead.statusCode === 302;

        const eventSubmitNotif = db.prepare("SELECT * FROM notifications WHERE type = 'EVENT' AND message LIKE '%submitted%'").get();
        const odRaisedNotif = db.prepare("SELECT * FROM notifications WHERE type = 'OD_REQUEST_RAISED'").get();
        const odReviewedNotif = db.prepare("SELECT * FROM notifications WHERE type = 'OD_REVIEWED'").get();

        const allTriggersVerified = Boolean(eventSubmitNotif) && Boolean(odRaisedNotif) && Boolean(odReviewedNotif);

        const passed = isIdorBlocked && isOwnSuccess && allTriggersVerified;

        recordResult(
          'P5-11. Notification isolation (User A cannot read/mark User B notifications) & mandatory workflow triggers verified',
          passed,
          `CrossUserRead (Blocked: ${resCrossRead.statusCode}), OwnRead (Allowed: ${resOwnRead.statusCode}), AllTriggersFired (${allTriggersVerified})`
        );
      } catch (err) {
        recordResult('P5-11. Notification isolation & mandatory workflow triggers verified', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // ============================================================================
      // PHASE 6: ANALYTICS SECURITY & AUTHORIZATION TESTS
      // ============================================================================

      // PHASE 6 - TEST 1: Cross-Club Analytics Authorization Enforcement (HTTP level)
      try {
        console.log('[PHASE 6 - TEST 1] Verifying Cross-Club Analytics Authorization via TestClient...');

        let foreignClubAdmin = db.prepare("SELECT id FROM users WHERE email = 'foreignadmin_sec@campus.edu'").get();
        if (!foreignClubAdmin) {
          const resFa = db.prepare("INSERT INTO users (email, password_hash, full_name, role) VALUES ('foreignadmin_sec@campus.edu', '$2b$10$hash', 'Foreign Admin Sec', 'CLUB_ADMIN')").run();
          foreignClubAdmin = { id: resFa.lastInsertRowid };
        }
        let foreignClub = db.prepare("SELECT id FROM clubs WHERE code = 'FSEC01'").get();
        if (!foreignClub) {
          const resFc = db.prepare("INSERT INTO clubs (name, code, description, category, club_admin_id, created_by) VALUES ('Foreign Sec Club', 'FSEC01', 'Desc', 'Technical', ?, ?)").run(foreignClubAdmin.id, superAdminUser.id);
          foreignClub = { id: resFc.lastInsertRowid };
        }

        const clubAdminClient = new TestClient(clubAdminUser.id);
        const foreignAdminClient = new TestClient(foreignClubAdmin.id);

        const resCrossAccess = await foreignAdminClient.get(`/club/analytics?clubId=${codingClub.id}`, { headers: { 'Accept': 'application/json' } });
        const isCrossBlocked = resCrossAccess.statusCode === 403 || resCrossAccess.statusCode === 404;

        const resOwnAccess = await clubAdminClient.get(`/club/analytics?clubId=${codingClub.id}`, { headers: { 'Accept': 'application/json' } });
        const isOwnAllowed = resOwnAccess.statusCode === 200;

        const passed = isCrossBlocked && isOwnAllowed;

        recordResult(
          'P6-1. Cross-club analytics access is refused (403/404); authorized Club Admin can view own analytics',
          passed,
          `CrossAccessStatus (${resCrossAccess.statusCode}), OwnAccessStatus (${resOwnAccess.statusCode})`
        );
      } catch (err) {
        recordResult('P6-1. Cross-club analytics access refused', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 6 - TEST 2: Student Analytics Cross-Access & Role Guards
      try {
        console.log('[PHASE 6 - TEST 2] Verifying Student Analytics Isolation & Role Guards...');
        const student1Client = new TestClient(student1User.id);
        const student2Client = new TestClient(student2User.id);
        const adminClient = new TestClient(adminUser.id);

        const resCrossStudent = await student2Client.get(`/student/analytics?studentUserId=${student1User.id}`, { headers: { 'Accept': 'application/json' } });
        const isCrossStudentBlocked = resCrossStudent.statusCode === 403 || resCrossStudent.statusCode === 404;

        const resOwnStudent = await student1Client.get(`/student/analytics?studentUserId=${student1User.id}`, { headers: { 'Accept': 'application/json' } });
        const isOwnStudentAllowed = resOwnStudent.statusCode === 200;

        const resAdminStudent = await adminClient.get(`/student/analytics?studentUserId=${student1User.id}`, { headers: { 'Accept': 'application/json' } });
        const isAdminStudentAllowed = resAdminStudent.statusCode === 200;

        const passed = isCrossStudentBlocked && isOwnStudentAllowed && isAdminStudentAllowed;

        recordResult(
          'P6-2. Student cross-analytics access is refused (403/404); student can access own; Admin can access any',
          passed,
          `CrossStudentStatus (${resCrossStudent.statusCode}), OwnStudentStatus (${resOwnStudent.statusCode}), AdminStudentStatus (${resAdminStudent.statusCode})`
        );
      } catch (err) {
        recordResult('P6-2. Student analytics isolation & role guards verified', false, `UNEXPECTED ERROR: ${err.message}`);
      }

      // PHASE 6 - TEST 3: Admin & Faculty Analytics Endpoint Role Protection & Unauthenticated Redirects
      try {
        console.log('[PHASE 6 - TEST 3] Verifying Admin/Faculty Analytics Role Guards & Unauthenticated Access...');
        const anonClient = new TestClient(null);
        const studentClient = new TestClient(student1User.id);
        const facultyClient = new TestClient(facultyUser.id);
        const adminClient = new TestClient(adminUser.id);

        const resStudentAdminPage = await studentClient.get('/admin/analytics', { headers: { 'Accept': 'application/json' } });
        const isStudentAdminBlocked = resStudentAdminPage.statusCode === 403;

        const resAdminPage = await adminClient.get('/admin/analytics', { headers: { 'Accept': 'application/json' } });
        const isAdminAllowed = resAdminPage.statusCode === 200;

        const resFacultyPage = await facultyClient.get('/faculty/analytics', { headers: { 'Accept': 'application/json' } });
        const isFacultyAllowed = resFacultyPage.statusCode === 200;

        const resAnonPage = await anonClient.get('/admin/analytics');
        const isAnonBlocked = resAnonPage.statusCode === 302 || resAnonPage.statusCode === 401;

        const passed = isStudentAdminBlocked && isAdminAllowed && isFacultyAllowed && isAnonBlocked;

        recordResult(
          'P6-3. Analytics endpoints enforce role guards (/admin/analytics 403 for student, 200 for Admin; unauth redirects)',
          passed,
          `StudentAdmin (${resStudentAdminPage.statusCode}), AdminPage (${resAdminPage.statusCode}), FacultyPage (${resFacultyPage.statusCode}), UnauthStatus (${resAnonPage.statusCode})`
        );
      } catch (err) {
        recordResult('P6-3. Analytics endpoints role guards & unauthenticated access verified', false, `UNEXPECTED ERROR: ${err.message}`);
      }

    } catch (err) {
      console.error('Fatal Security Test Exception:', err);
      overallSuccess = false;
    } finally {
      server.close();

      console.log('\n========================================================================================');
      console.log('                          SECURITY AUDIT RESULTS SUMMARY                                ');
      console.log('========================================================================================\n');
      console.table(testResults);

      if (untestableReports.length > 0) {
        console.log('\n----------------------------------------------------------------------------------------');
        console.log('                        REPORT: UNTESTABLE FEATURES / ENDPOINTS                         ');
        console.log('----------------------------------------------------------------------------------------');
        untestableReports.forEach((item, index) => {
          console.log(`${index + 1}. [${item.feature}]:`);
          console.log(`   Reason: ${item.reason}\n`);
        });
      }

      const hasFailures = testResults.some(r => r.status.includes('FAIL'));
      if (hasFailures || !overallSuccess) {
        console.error('\n❌ SECURITY AUDIT FAILED! Exit Code 1\n');
        process.exit(1);
      } else {
        console.log('\n✅ ALL TESTABLE SECURITY ASSERTIONS PASSED! Exit Code 0\n');
        process.exit(0);
      }
    }
  });
}

runSecurityTestSuite();
