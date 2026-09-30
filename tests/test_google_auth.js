const http = require('http');
const app = require('../src/app');
const db = require('../src/db/index');
const jwt = require('jsonwebtoken');
const { verifyGoogleProfile } = require('../src/config/passport');

const PORT = 3056;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_12345';
const COOKIE_NAME = 'token';

// Helper function to make HTTP GET/POST requests
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
        // Extract Set-Cookie headers
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

function getAuthCookie(userId) {
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
  return `${COOKIE_NAME}=${token}`;
}

function cleanTestUser(email) {
  const existingUser = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existingUser) {
    db.prepare("DELETE FROM audit_logs WHERE actor_id = ?").run(existingUser.id);
    db.prepare("DELETE FROM students WHERE user_id = ?").run(existingUser.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(existingUser.id);
  }
}

async function runGoogleAuthTests() {
  console.log('\n========================================================================================');
  console.log('                   GOOGLE SIGN-IN & PROFILE COMPLETION TEST SUITE                       ');
  console.log('========================================================================================\n');

  const server = app.listen(PORT, async () => {
    try {
      // ----------------------------------------------------------------------
      // TEST 1: Staff Account Rejection via Google Sign-In Strategy Logic
      // ----------------------------------------------------------------------
      console.log('TEST 1: Verifying Staff Email Google Sign-In Rejection & Audit Log');
      const facultyUser = db.prepare("SELECT * FROM users WHERE role = 'FACULTY' LIMIT 1").get();
      if (!facultyUser) {
        throw new Error('No faculty user found in DB to test staff denial');
      }

      let staffDeniedError = null;
      let staffDeniedUser = null;
      let staffDeniedInfo = null;

      // Mock Google Profile for Staff User
      const mockStaffProfile = {
        id: 'google_staff_12345',
        displayName: facultyUser.full_name,
        emails: [{ value: facultyUser.email }]
      };

      await new Promise((resolve) => {
        verifyGoogleProfile(null, null, mockStaffProfile, (err, user, info) => {
          staffDeniedError = err;
          staffDeniedUser = user;
          staffDeniedInfo = info;
          resolve();
        });
      });

      console.log(` -> Staff Email Tested: ${facultyUser.email} (Role: ${facultyUser.role})`);
      console.log(` -> Authenticated User: ${staffDeniedUser} (Expected: false)`);
      console.log(` -> Rejection Message: "${staffDeniedInfo ? staffDeniedInfo.message : ''}"`);
      
      // Check Audit Log for GOOGLE_AUTH_STAFF_DENIED
      const staffAuditLog = db.prepare(
        "SELECT * FROM audit_logs WHERE action = 'GOOGLE_AUTH_STAFF_DENIED' AND actor_id = ? ORDER BY id DESC LIMIT 1"
      ).get(facultyUser.id);

      console.log(` -> Audit Log Recorded: ${staffAuditLog ? 'YES (Action: ' + staffAuditLog.action + ')' : 'NO'}`);
      console.log(` -> Result: ${staffDeniedUser === false && staffAuditLog ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // ----------------------------------------------------------------------
      // TEST 2: New Student Google Registration & Mandatory Redirect
      // ----------------------------------------------------------------------
      console.log('TEST 2: New Student Google Registration & Mandatory Profile Completion Redirect');
      
      // Clean up previous test user if exists
      cleanTestUser('new_google_student@campus.edu');

      const mockNewStudentProfile = {
        id: 'google_student_99999',
        displayName: 'New Google Student',
        emails: [{ value: 'new_google_student@campus.edu' }]
      };

      let newStudentUser = null;
      await new Promise((resolve) => {
        verifyGoogleProfile(null, null, mockNewStudentProfile, (err, user, info) => {
          newStudentUser = user;
          resolve();
        });
      });

      console.log(` -> Created Pending User ID: ${newStudentUser.id} | Role: ${newStudentUser.role}`);
      
      const authCookie = getAuthCookie(newStudentUser.id);
      
      // Attempting to visit /dashboard before completing profile
      const resDashboard = await makeRequest('GET', '/dashboard', null, [authCookie]);
      console.log(` -> GET /dashboard Status: ${resDashboard.statusCode} (Expected: 302 Redirect)`);
      console.log(` -> Redirect Location: ${resDashboard.headers.location} (Expected: /complete-profile)`);
      console.log(` -> Result: ${resDashboard.statusCode === 302 && resDashboard.headers.location === '/complete-profile' ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // ----------------------------------------------------------------------
      // TEST 3: Profile Completion Validation & Submitting Valid Profile
      // ----------------------------------------------------------------------
      console.log('TEST 3: Profile Completion Input Validation & Submission');
      
      // Fetch /complete-profile to obtain CSRF Cookie and HTML token
      const resGetCompleteProfile = await makeRequest('GET', '/complete-profile', null, [authCookie]);
      const csrfCookieHeader = resGetCompleteProfile.setCookies.find(c => c.startsWith('x-csrf-token='));
      const csrfCookieValue = csrfCookieHeader ? csrfCookieHeader.split(';')[0] : '';
      
      // Extract CSRF token from HTML input
      const csrfMatch = resGetCompleteProfile.body.match(/name="_csrf"\s+value="([^"]+)"/);
      const csrfToken = csrfMatch ? csrfMatch[1] : '';

      const combinedCookies = [authCookie, csrfCookieValue];
      const facultyMentor = db.prepare("SELECT user_id FROM faculty LIMIT 1").get();

      // (a) Invalid RA Number
      const resInvalidRa = await makeRequest('POST', '/complete-profile', {
        _csrf: csrfToken,
        raNumber: 'INVALID_RA',
        department: 'CSE',
        yearOfStudy: '2',
        section: 'A1',
        classMentorId: facultyMentor.user_id
      }, combinedCookies);

      console.log(` -> Invalid RA Status: ${resInvalidRa.statusCode} (Expected: 400 Bad Request)`);

      // (b) Valid RA Number Completion
      const validRaNumber = 'RA9999999999999';
      const resValidProfile = await makeRequest('POST', '/complete-profile', {
        _csrf: csrfToken,
        raNumber: validRaNumber,
        department: 'Computer Science',
        yearOfStudy: '2',
        section: 'B2',
        classMentorId: facultyMentor.user_id
      }, combinedCookies);

      console.log(` -> Valid Profile Submit Status: ${resValidProfile.statusCode} (Expected: 302 Redirect to /dashboard)`);
      
      // Verify profile in DB
      const studentRecord = db.prepare("SELECT * FROM students WHERE user_id = ?").get(newStudentUser.id);
      console.log(` -> DB Student Profile Created: ${studentRecord ? 'RA: ' + studentRecord.ra_number : 'NO'}`);
      console.log(` -> Result: ${studentRecord && studentRecord.ra_number === validRaNumber ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // ----------------------------------------------------------------------
      // TEST 4: Post-Completion Access to Student Dashboard
      // ----------------------------------------------------------------------
      console.log('TEST 4: Post-Completion Access to /dashboard');
      const resPostCompletion = await makeRequest('GET', '/dashboard', null, [authCookie]);
      console.log(` -> GET /dashboard Status: ${resPostCompletion.statusCode} (Expected: 302 Redirect to /dashboard/student)`);
      console.log(` -> Redirect Location: ${resPostCompletion.headers.location}`);
      console.log(` -> Result: ${resPostCompletion.statusCode === 302 && resPostCompletion.headers.location === '/dashboard/student' ? 'PASS ✅' : 'FAIL ❌'}\n`);

      console.log('========================================================================================\n');
    } catch (err) {
      console.error('Test Error:', err);
    } finally {
      // Cleanup test user
      cleanTestUser('new_google_student@campus.edu');
      server.close();
      process.exit(0);
    }
  });
}

runGoogleAuthTests();
