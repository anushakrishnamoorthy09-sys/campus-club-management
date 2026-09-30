const http = require('http');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');

let TEST_PORT = 0;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_12345';
const COOKIE_NAME = 'token';

function makeRequest(method, path, bodyData = null, cookieHeaders = [], isJson = true) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: path,
      method: method,
      headers: {
        'Accept': isJson ? 'application/json' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
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
          setCookies,
          body: responseBody
        });
      });
    });

    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

function getJwtCookie(userId) {
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
  return `${COOKIE_NAME}=${token}`;
}

async function runAccountAndClubTests() {
  console.log('\n========================================================================================');
  console.log('              ACCOUNT & CLUB MANAGEMENT AUTOMATED TEST SUITE                            ');
  console.log('========================================================================================\n');

  seedDatabase();

  const server = app.listen(0, async () => {
    TEST_PORT = server.address().port;
    const cleanup = () => { try { server.close(); } catch(e){} };
    process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup); process.on('exit', cleanup);
    try {
      const superAdminUser = db.prepare("SELECT id FROM users WHERE role = 'SUPER_ADMIN'").get();
      const adminUser = db.prepare("SELECT id FROM users WHERE role = 'ADMIN'").get();
      const facultyUser = db.prepare("SELECT user_id FROM faculty LIMIT 1").get();

      const superAdminCookie = getJwtCookie(superAdminUser.id);
      const adminCookie = getJwtCookie(adminUser.id);

      // Fetch CSRF Token helper
      const resGetUsers = await makeRequest('GET', '/admin/users', null, [superAdminCookie], false);
      const csrfCookieHeader = resGetUsers.setCookies.find(c => c.startsWith('x-csrf-token='));
      const csrfCookieValue = csrfCookieHeader ? csrfCookieHeader.split(';')[0] : '';
      const csrfMatch = resGetUsers.body.match(/name="_csrf"\s+value="([^"]+)"/);
      const csrfToken = csrfMatch ? csrfMatch[1] : '';
      const combinedSuperAdminCookies = [superAdminCookie, csrfCookieValue];
      const combinedAdminCookies = [adminCookie, csrfCookieValue];

      // ----------------------------------------------------------------------
      // TEST 1: Admin creating ADMIN or FACULTY account -> Refused (403)
      // ----------------------------------------------------------------------
      console.log('TEST 1: Admin attempting to create ADMIN / FACULTY account (Server-Side Enforcement)');
      const resAdminCreateAdmin = await makeRequest('POST', '/admin/users', {
        _csrf: csrfToken,
        fullName: 'Forbidden Admin',
        email: 'forbidden_admin@campus.edu',
        password: 'Password123!',
        role: 'ADMIN'
      }, combinedAdminCookies, true);

      console.log(` -> POST /admin/users (role=ADMIN by Admin User) Status: ${resAdminCreateAdmin.statusCode} (Expected: 403 Forbidden)`);
      console.log(` -> Result: ${resAdminCreateAdmin.statusCode === 403 ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // ----------------------------------------------------------------------
      // TEST 2: Admin creating CLUB_ADMIN account -> Succeeds (201)
      // ----------------------------------------------------------------------
      console.log('TEST 2: Admin creating CLUB_ADMIN account');
      const resAdminCreateClubAdmin = await makeRequest('POST', '/admin/users', {
        _csrf: csrfToken,
        fullName: 'New Club Leader',
        email: 'new_club_leader@campus.edu',
        password: 'Password123!',
        role: 'CLUB_ADMIN'
      }, combinedAdminCookies, true);

      console.log(` -> POST /admin/users (role=CLUB_ADMIN by Admin User) Status: ${resAdminCreateClubAdmin.statusCode} (Expected: 201 Created)`);
      const createdClubAdmin = db.prepare("SELECT * FROM users WHERE email = 'new_club_leader@campus.edu'").get();
      console.log(` -> Created DB User: ${createdClubAdmin ? createdClubAdmin.full_name + ' (Role: ' + createdClubAdmin.role + ')' : 'NO'}`);
      console.log(` -> Result: ${createdClubAdmin && createdClubAdmin.role === 'CLUB_ADMIN' ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // ----------------------------------------------------------------------
      // TEST 3: Super Admin creating FACULTY account with profile
      // ----------------------------------------------------------------------
      console.log('TEST 3: Super Admin creating FACULTY account');
      const resCreateFaculty = await makeRequest('POST', '/admin/users', {
        _csrf: csrfToken,
        fullName: 'Dr. Ada Lovelace',
        email: 'ada_faculty@campus.edu',
        password: 'Password123!',
        role: 'FACULTY',
        department: 'Mathematics & CS',
        designation: 'Department Head'
      }, combinedSuperAdminCookies, true);

      const createdFacultyUser = db.prepare("SELECT u.id, u.full_name, f.department FROM users u JOIN faculty f ON u.id = f.user_id WHERE u.email = 'ada_faculty@campus.edu'").get();
      console.log(` -> Created Faculty Record: ${createdFacultyUser ? createdFacultyUser.full_name + ' (' + createdFacultyUser.department + ')' : 'NO'}`);
      console.log(` -> Result: ${createdFacultyUser ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // ----------------------------------------------------------------------
      // TEST 4: Self-Deactivation Prevention (400 Bad Request)
      // ----------------------------------------------------------------------
      console.log('TEST 4: Super Admin attempting self-deactivation');
      const resSelfDeactivate = await makeRequest('POST', `/admin/users/${superAdminUser.id}/toggle-status`, {
        _csrf: csrfToken,
        isActive: '0'
      }, combinedSuperAdminCookies, true);

      console.log(` -> Self-Deactivation Status: ${resSelfDeactivate.statusCode} (Expected: 400 Bad Request)`);
      console.log(` -> Result: ${resSelfDeactivate.statusCode === 400 ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // ----------------------------------------------------------------------
      // TEST 5: One-Club-Per-Club-Admin Constraint (409 Conflict)
      // ----------------------------------------------------------------------
      console.log('TEST 5: Creating Club with already assigned Club Admin (One Club per Admin)');
      const existingClub = db.prepare("SELECT club_admin_id FROM clubs WHERE club_admin_id IS NOT NULL LIMIT 1").get();

      const resDuplicateAdminClub = await makeRequest('POST', '/admin/clubs', {
        _csrf: csrfToken,
        name: 'Robotics Club',
        code: 'ROBOTICS',
        description: 'Autonomous robotics and hardware development club',
        category: 'Technical',
        clubAdminId: existingClub.club_admin_id,
        facultyCoordinatorIds: facultyUser.user_id
      }, combinedSuperAdminCookies, true);

      console.log(` -> Duplicate Club Admin Assignment Status: ${resDuplicateAdminClub.statusCode} (Expected: 409 Conflict)`);
      console.log(` -> Result: ${resDuplicateAdminClub.statusCode === 409 ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // ----------------------------------------------------------------------
      // TEST 6: Atomic Club Creation & In-App Notifications
      // ----------------------------------------------------------------------
      console.log('TEST 6: Super Admin Creating New Club & Verifying In-App Notifications');
      const resCreateClub = await makeRequest('POST', '/admin/clubs', {
        _csrf: csrfToken,
        name: 'AI & Data Science Club',
        code: 'AIDS_CLUB',
        description: 'Machine Learning, Deep Learning and AI research club',
        category: 'Technical',
        clubAdminId: createdClubAdmin.id,
        facultyCoordinatorIds: createdFacultyUser.id
      }, combinedSuperAdminCookies, true);

      const createdClub = db.prepare("SELECT * FROM clubs WHERE code = 'AIDS_CLUB'").get();
      console.log(` -> DB Club Created: ${createdClub ? createdClub.name + ' (' + createdClub.code + ')' : 'NO'}`);

      // Verify notifications generated
      const clubAdminNotification = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND title LIKE '%Club Admin%'").get(createdClubAdmin.id);
      const facultyNotification = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND title LIKE '%Faculty Coordinator%'").get(createdFacultyUser.id);

      console.log(` -> Club Admin Notification: ${clubAdminNotification ? 'YES ("' + clubAdminNotification.title + '")' : 'NO'}`);
      console.log(` -> Faculty Coordinator Notification: ${facultyNotification ? 'YES ("' + facultyNotification.title + '")' : 'NO'}`);
      console.log(` -> Result: ${createdClub && clubAdminNotification && facultyNotification ? 'PASS ✅' : 'FAIL ❌'}\n`);

      console.log('========================================================================================\n');
    } catch (err) {
      console.error('Test Exception:', err);
    } finally {
      server.close();
      process.exit(0);
    }
  });
}

runAccountAndClubTests();
