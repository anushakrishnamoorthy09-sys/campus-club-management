const http = require('http');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const { registerStudent } = require('../src/services/authService');
const { verifyGoogleProfile } = require('../src/config/passport');

const PORT = 3099;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_12345';
const COOKIE_NAME = 'token';

const testResults = [];

function recordResult(testName, passed, details = '') {
  testResults.push({
    test: testName,
    status: passed ? 'PASS ✅' : 'FAIL ❌',
    details: details
  });
}

// Helper function to execute HTTP requests
function makeRequest(method, path, bodyData = null, cookieHeaders = []) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path: path,
      method: method,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
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
        params.append(key, value);
      }
      payload = params.toString();
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        const setCookies = res.headers['set-cookie'] || [];
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          setCookies: setCookies,
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
      // 1. LOGGED-OUT ACCESS REDIRECTION ASSERTIONS
      // ----------------------------------------------------------------------
      console.log('[SECURITY TEST 1] Verifying Logged-out Access Redirection to /login...');
      const protectedPaths = [
        '/dashboard',
        '/dashboard/super-admin',
        '/dashboard/admin',
        '/dashboard/club-admin',
        '/dashboard/faculty',
        '/dashboard/student',
        '/admin/timetable',
        '/admin/users',
        '/admin/clubs',
        '/club/events',
        '/club/members',
        '/club/roles',
        '/club/certificates',
        '/club/badges',
        '/faculty/events',
        '/faculty/od',
        '/faculty/mentees',
        '/student/events',
        '/student/my-registrations',
        '/student/od',
        '/student/certificates',
        '/student/badges',
        '/complete-profile'
      ];

      let allLoggedOutRedirected = true;
      for (const p of protectedPaths) {
        const res = await makeRequest('GET', p);
        if (res.statusCode !== 302 || res.headers.location !== '/login') {
          allLoggedOutRedirected = false;
          console.error(` ❌ Logged-out access to ${p} returned ${res.statusCode} (Location: ${res.headers.location})`);
        }
      }

      recordResult(
        '1. Logged-out access redirects to /login',
        allLoggedOutRedirected,
        `Tested ${protectedPaths.length} protected routes`
      );

      // Fetch Seeded Users from DB
      const superAdminUser = db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN'").get();
      const adminUser = db.prepare("SELECT id FROM users WHERE role = 'ADMIN'").get();
      const facultyUser = db.prepare("SELECT id FROM users WHERE role = 'FACULTY'").get();
      const clubAdminUser = db.prepare("SELECT id FROM users WHERE role = 'CLUB_ADMIN'").get();
      const studentUser = db.prepare("SELECT id FROM users WHERE role = 'STUDENT'").get();

      // ----------------------------------------------------------------------
      // 2. TIMETABLE ROUTE PERMISSION ASSERTIONS (GET & POST)
      // ----------------------------------------------------------------------
      console.log('[SECURITY TEST 2] Verifying Super Admin Timetable Route Guards...');
      let timetableGuardsPassed = true;

      const roleCookies = [
        { role: 'STUDENT', cookie: getJwtCookie(studentUser.id) },
        { role: 'CLUB_ADMIN', cookie: getJwtCookie(clubAdminUser.id) },
        { role: 'FACULTY', cookie: getJwtCookie(facultyUser.id) },
        { role: 'ADMIN', cookie: getJwtCookie(adminUser.id) }
      ];

      for (const { role, cookie } of roleCookies) {
        const resGet = await makeRequest('GET', '/admin/timetable', null, [cookie]);
        if (resGet.statusCode !== 403) {
          timetableGuardsPassed = false;
          console.error(` ❌ ${role} accessed GET /admin/timetable with status ${resGet.statusCode} (Expected: 403)`);
        }
      }

      // Super Admin GET access check
      const superAdminCookie = getJwtCookie(superAdminUser.id);
      const resSuperAdminGet = await makeRequest('GET', '/admin/timetable', null, [superAdminCookie]);
      if (resSuperAdminGet.statusCode !== 200) {
        timetableGuardsPassed = false;
        console.error(` ❌ SUPER_ADMIN failed GET /admin/timetable with status ${resSuperAdminGet.statusCode}`);
      }

      recordResult(
        '2. Super Admin Timetable guarded against Non-SuperAdmin roles',
        timetableGuardsPassed,
        'Student, Club Admin, Faculty, and Admin return 403; Super Admin returns 200'
      );

      // ----------------------------------------------------------------------
      // 3. STUDENT ROUTE ACCESS RESTRICTION ASSERTIONS
      // ----------------------------------------------------------------------
      console.log('[SECURITY TEST 3] Verifying Student 403 Blocks on Admin, Club & Faculty Routes...');
      const studentRestrictedPaths = [
        '/admin/timetable',
        '/admin/users',
        '/admin/clubs',
        '/club/events',
        '/club/members',
        '/club/roles',
        '/club/certificates',
        '/club/badges',
        '/faculty/events',
        '/faculty/od',
        '/faculty/mentees'
      ];

      let studentRestrictedPassed = true;
      const studentCookie = getJwtCookie(studentUser.id);

      for (const p of studentRestrictedPaths) {
        const res = await makeRequest('GET', p, null, [studentCookie]);
        if (res.statusCode !== 403) {
          studentRestrictedPassed = false;
          console.error(` ❌ Student accessed ${p} with status ${res.statusCode} (Expected: 403)`);
        }
      }

      recordResult(
        '3. Student receives 403 on every Admin, Club and Faculty route',
        studentRestrictedPassed,
        `Tested ${studentRestrictedPaths.length} privileged endpoints`
      );

      // ----------------------------------------------------------------------
      // 4. REGISTRATION RA NUMBER VALIDATION ASSERTIONS
      // ----------------------------------------------------------------------
      console.log('[SECURITY TEST 4] Verifying Registration RA Number Validation...');
      let raValidationPassed = true;
      const facultyMentor = db.prepare("SELECT user_id FROM faculty LIMIT 1").get();

      const baseRegData = {
        fullName: 'Test Student',
        email: 'test_ra_val@campus.edu',
        password: 'Password123!',
        department: 'CSE',
        yearOfStudy: 2,
        section: 'A',
        classMentorId: facultyMentor.user_id
      };

      // A. 14-char RA
      try {
        registerStudent({ ...baseRegData, raNumber: 'RA123456789012' });
        raValidationPassed = false;
      } catch (err) {
        if (err.statusCode !== 400) raValidationPassed = false;
      }

      // B. 16-char RA
      try {
        registerStudent({ ...baseRegData, raNumber: 'RA12345678901234' });
        raValidationPassed = false;
      } catch (err) {
        if (err.statusCode !== 400) raValidationPassed = false;
      }

      // C. Non-alphanumeric RA
      try {
        registerStudent({ ...baseRegData, raNumber: 'RA123456789012!' });
        raValidationPassed = false;
      } catch (err) {
        if (err.statusCode !== 400) raValidationPassed = false;
      }

      // D. Duplicate RA
      try {
        registerStudent({ ...baseRegData, raNumber: 'RA2311003010001' });
        raValidationPassed = false;
      } catch (err) {
        if (err.statusCode !== 409) raValidationPassed = false;
      }

      // E. Lowercase variant of existing RA
      try {
        registerStudent({ ...baseRegData, raNumber: 'ra2311003010001' });
        raValidationPassed = false;
      } catch (err) {
        if (err.statusCode !== 409) raValidationPassed = false;
      }

      recordResult(
        '4. Registration rejects invalid, duplicate & lowercase RA variants',
        raValidationPassed,
        'Validated 14-char (400), 16-char (400), non-alphanumeric (400), duplicate (409), lowercase duplicate (409)'
      );

      // ----------------------------------------------------------------------
      // 5. ROLE INJECTION PREVENTION ASSERTION
      // ----------------------------------------------------------------------
      console.log('[SECURITY TEST 5] Verifying Injected Role Sanitization on Registration...');
      let roleInjectionPassed = true;

      const registeredUser = registerStudent({
        fullName: 'Hacker User',
        email: 'hacker_role_inject@campus.edu',
        password: 'Password123!',
        raNumber: 'RA8888888888888',
        department: 'CSE',
        yearOfStudy: 1,
        section: 'A',
        classMentorId: facultyMentor.user_id,
        role: 'SUPER_ADMIN',
        is_active: 1
      });

      const dbUser = db.prepare('SELECT role FROM users WHERE id = ?').get(registeredUser.id);
      if (dbUser.role !== 'STUDENT') {
        roleInjectionPassed = false;
        console.error(` ❌ Role injection succeeded! DB User Role: ${dbUser.role}`);
      }

      recordResult(
        '5. Registration ignores injected role field (forces STUDENT)',
        roleInjectionPassed,
        `Submitted role='SUPER_ADMIN', persisted DB role='${dbUser.role}'`
      );

      // ----------------------------------------------------------------------
      // 6. JWT SECURITY ASSERTIONS (Tampered, Expired, Deactivated)
      // ----------------------------------------------------------------------
      console.log('[SECURITY TEST 6] Verifying JWT Security Enforcement...');
      let jwtSecurityPassed = true;

      // A. Tampered Secret Token
      const tamperedCookie = getJwtCookie(studentUser.id, 'WRONG_INVALID_SECRET_KEY');
      const resTampered = await makeRequest('GET', '/dashboard', null, [tamperedCookie]);
      if (resTampered.statusCode !== 302 || resTampered.headers.location !== '/login') {
        jwtSecurityPassed = false;
        console.error(` ❌ Tampered JWT returned ${resTampered.statusCode}`);
      }

      // B. Expired Token
      const expiredCookie = getJwtCookie(studentUser.id, JWT_SECRET, '-1s');
      const resExpired = await makeRequest('GET', '/dashboard', null, [expiredCookie]);
      if (resExpired.statusCode !== 302 || resExpired.headers.location !== '/login') {
        jwtSecurityPassed = false;
        console.error(` ❌ Expired JWT returned ${resExpired.statusCode}`);
      }

      // C. Deactivated User Token
      const deactivateUserRes = db.prepare("INSERT INTO users (email, full_name, role, is_active) VALUES ('inactive@campus.edu', 'Inactive User', 'STUDENT', 0)").run();
      const inactiveCookie = getJwtCookie(deactivateUserRes.lastInsertRowid);
      const resInactive = await makeRequest('GET', '/dashboard', null, [inactiveCookie]);
      if (resInactive.statusCode !== 302 || resInactive.headers.location !== '/login') {
        jwtSecurityPassed = false;
        console.error(` ❌ Deactivated user JWT returned ${resInactive.statusCode}`);
      }

      recordResult(
        '6. Tampered, expired & deactivated user JWTs are rejected',
        jwtSecurityPassed,
        'Tampered signature, expired timestamp, and is_active=0 correctly invalidated'
      );

      // ----------------------------------------------------------------------
      // 7. GOOGLE OAUTH STAFF DENIAL ASSERTION
      // ----------------------------------------------------------------------
      console.log('[SECURITY TEST 7] Verifying Staff Google OAuth Rejection & Audit Log...');
      let googleStaffDeniedPassed = true;

      const mockStaffProfile = {
        id: 'google_staff_sec_test',
        displayName: 'Dr. Alan Turing',
        emails: [{ value: 'faculty.mentor@campus.edu' }]
      };

      let authUser = null;
      let authInfo = null;

      await new Promise((resolve) => {
        verifyGoogleProfile(null, null, mockStaffProfile, (err, user, info) => {
          authUser = user;
          authInfo = info;
          resolve();
        });
      });

      const auditLogRecord = db.prepare(
        "SELECT * FROM audit_logs WHERE action = 'GOOGLE_AUTH_STAFF_DENIED' AND actor_id = ?"
      ).get(facultyUser.id);

      if (authUser !== false || !auditLogRecord) {
        googleStaffDeniedPassed = false;
        console.error(' ❌ Staff Google OAuth was not rejected or audit logged.');
      }

      recordResult(
        '7. Staff email cannot authenticate through Google flow',
        googleStaffDeniedPassed,
        'Refused with message and recorded GOOGLE_AUTH_STAFF_DENIED audit log'
      );

      // ----------------------------------------------------------------------
      // 8. CSRF PROTECTION ASSERTIONS
      // ----------------------------------------------------------------------
      console.log('[SECURITY TEST 8] Verifying CSRF Protection on State-Changing POSTs...');
      let csrfProtectionPassed = true;

      // Unprotected POST /login without CSRF token
      const resPostLoginNoCsrf = await makeRequest('POST', '/login', {
        email: 'student1@campus.edu',
        password: 'Password123!'
      });

      if (resPostLoginNoCsrf.statusCode !== 403) {
        csrfProtectionPassed = false;
        console.error(` ❌ POST /login without CSRF token returned ${resPostLoginNoCsrf.statusCode} (Expected: 403)`);
      }

      // Unprotected POST /register without CSRF token
      const resPostRegNoCsrf = await makeRequest('POST', '/register', {
        fullName: 'No CSRF Student',
        email: 'nocsrf@campus.edu',
        password: 'Password123!',
        raNumber: 'RA7777777777777',
        department: 'CSE',
        yearOfStudy: '2',
        section: 'A',
        classMentorId: facultyMentor.user_id
      });

      if (resPostRegNoCsrf.statusCode !== 403) {
        csrfProtectionPassed = false;
        console.error(` ❌ POST /register without CSRF token returned ${resPostRegNoCsrf.statusCode} (Expected: 403)`);
      }

      recordResult(
        '8. State-changing POST requests without CSRF token are rejected',
        csrfProtectionPassed,
        'POST /login and POST /register return HTTP 403 Forbidden without CSRF token'
      );

    } catch (err) {
      console.error('Fatal Security Test Exception:', err);
      overallSuccess = false;
    } finally {
      server.close();

      console.log('\n========================================================================================');
      console.log('                          SECURITY AUDIT RESULTS SUMMARY                                ');
      console.log('========================================================================================\n');
      console.table(testResults);

      const hasFailures = testResults.some(r => r.status.includes('FAIL'));
      if (hasFailures || !overallSuccess) {
        console.error('\n❌ SECURITY AUDIT FAILED! Exit Code 1\n');
        process.exit(1);
      } else {
        console.log('\n✅ ALL 8 SECURITY ASSERTIONS PASSED! Exit Code 0\n');
        process.exit(0);
      }
    }
  });
}

runSecurityTestSuite();
