const http = require('http');
const app = require('../src/app');
const db = require('../src/db/index');
const jwt = require('jsonwebtoken');

let TEST_PORT = 0;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_12345';
const COOKIE_NAME = 'token';

// Helper function to make HTTP GET request with optional cookie
function makeGetRequest(path, cookieHeader = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: path,
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    };

    if (cookieHeader) {
      options.headers['Cookie'] = cookieHeader;
    }

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

// Helper to generate auth cookie for a given user email
function getCookieForEmail(email) {
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) {
    throw new Error(`User with email ${email} not found in DB`);
  }
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
  return `${COOKIE_NAME}=${token}`;
}

async function runRbacTests() {
  console.log('\n========================================================================================');
  console.log('                          RBAC AUTHORIZATION DEMONSTRATION                              ');
  console.log('========================================================================================\n');

  const server = app.listen(0, async () => {
    TEST_PORT = server.address().port;
    const cleanup = () => { try { server.close(); } catch(e){} };
    process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup); process.on('exit', cleanup);
    try {
      // 1. Logged-out access to /dashboard
      console.log('TEST 1: Unauthenticated request to GET /dashboard');
      const res1 = await makeGetRequest('/dashboard');
      console.log(` -> Status Code: ${res1.statusCode} (Expected: 302 Redirect)`);
      console.log(` -> Location Header: ${res1.headers.location} (Expected: /login)`);
      console.log(` -> Result: ${res1.statusCode === 302 && res1.headers.location === '/login' ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // 2. Club Admin requesting /admin/timetable
      console.log('TEST 2: Club Admin (clubadmin@campus.edu) requesting GET /admin/timetable');
      const clubAdminCookie = getCookieForEmail('clubadmin@campus.edu');
      const res2 = await makeGetRequest('/admin/timetable', clubAdminCookie);
      console.log(` -> Status Code: ${res2.statusCode} (Expected: 403 Forbidden)`);
      console.log(` -> Result: ${res2.statusCode === 403 ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // 3. Student requesting /dashboard/faculty
      console.log('TEST 3: Student (student1@campus.edu) requesting GET /dashboard/faculty');
      const studentCookie = getCookieForEmail('student1@campus.edu');
      const res3 = await makeGetRequest('/dashboard/faculty', studentCookie);
      console.log(` -> Status Code: ${res3.statusCode} (Expected: 403 Forbidden)`);
      console.log(` -> Result: ${res3.statusCode === 403 ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // 4. Student requesting /dashboard/student (Authorized access)
      console.log('TEST 4: Student (student1@campus.edu) requesting GET /dashboard/student');
      const res4 = await makeGetRequest('/dashboard/student', studentCookie);
      console.log(` -> Status Code: ${res4.statusCode} (Expected: 200 OK)`);
      console.log(` -> Result: ${res4.statusCode === 200 ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // 5. Verify Audit Logs for ACCESS_DENIED entries
      console.log('TEST 5: Checking audit_logs DB table for ACCESS_DENIED events');
      const logs = db.prepare(
        "SELECT id, actor_id, action, target_entity, details_json, timestamp FROM audit_logs WHERE action = 'ACCESS_DENIED' ORDER BY id DESC LIMIT 5"
      ).all();
      console.log(` -> Found ${logs.length} access denial entries in audit_logs:`);
      logs.forEach(log => {
        const details = JSON.parse(log.details_json);
        console.log(`    [Audit Log #${log.id}] Actor ID: ${log.actor_id} | Path: ${details.path} | Method: ${details.method} | User Role: ${details.userRole}`);
      });
      console.log(` -> Result: ${logs.length >= 2 ? 'PASS ✅' : 'FAIL ❌'}\n`);

      console.log('========================================================================================\n');
    } catch (err) {
      console.error('Test error:', err);
    } finally {
      server.close();
      process.exit(0);
    }
  });
}

runRbacTests();
