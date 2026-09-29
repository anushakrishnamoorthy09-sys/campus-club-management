const http = require('http');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');

const PORT = 3059;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_12345';
const COOKIE_NAME = 'token';

function makeRequest(method, path, bodyData = null, cookieHeaders = [], isJson = true) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
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

async function runDynamicRoleAndProbeTests() {
  console.log('\n========================================================================================');
  console.log('         DYNAMIC ROLES & PERMISSION PROBES DEMONSTRATION TEST SUITE                     ');
  console.log('========================================================================================\n');

  seedDatabase();

  const server = app.listen(PORT, async () => {
    try {
      const student1 = db.prepare("SELECT id FROM users WHERE email = 'student1@campus.edu'").get();
      const clubAdmin = db.prepare("SELECT id FROM users WHERE email = 'clubadmin@campus.edu'").get();
      const codingClub = db.prepare("SELECT id FROM clubs WHERE code = 'CODE01'").get();

      const student1Cookie = getJwtCookie(student1.id);
      const clubAdminCookie = getJwtCookie(clubAdmin.id);

      const clubId = codingClub.id;

      // ----------------------------------------------------------------------
      // DEMO 1: Seeded "Logistics Lead" Member Probes in OWN Club
      // Granted: EVENT_EDIT, VIEW_REGISTRATIONS
      // Ungranted: ISSUE_CERTIFICATE, AWARD_BADGE, MARK_ATTENDANCE
      // ----------------------------------------------------------------------
      console.log(`DEMO 1: Testing Probes for Seeded "Logistics Lead" (student1@campus.edu) in Club #${clubId}`);

      const resEventEdit = await makeRequest('GET', `/club/${clubId}/_probe/EVENT_EDIT`, null, [student1Cookie], false);
      console.log(` -> Probe EVENT_EDIT Status: ${resEventEdit.statusCode} | Body: "${resEventEdit.body}" (Expected: 200 PROBE_GRANTED)`);

      const resViewReg = await makeRequest('GET', `/club/${clubId}/_probe/VIEW_REGISTRATIONS`, null, [student1Cookie], false);
      console.log(` -> Probe VIEW_REGISTRATIONS Status: ${resViewReg.statusCode} | Body: "${resViewReg.body}" (Expected: 200 PROBE_GRANTED)`);

      const resIssueCert = await makeRequest('GET', `/club/${clubId}/_probe/ISSUE_CERTIFICATE`, null, [student1Cookie], false);
      console.log(` -> Probe ISSUE_CERTIFICATE Status: ${resIssueCert.statusCode} (Expected: 403 Forbidden)`);

      const resAwardBadge = await makeRequest('GET', `/club/${clubId}/_probe/AWARD_BADGE`, null, [student1Cookie], false);
      console.log(` -> Probe AWARD_BADGE Status: ${resAwardBadge.statusCode} (Expected: 403 Forbidden)`);

      const demo1Passed = (
        resEventEdit.statusCode === 200 &&
        resViewReg.statusCode === 200 &&
        resIssueCert.statusCode === 403 &&
        resAwardBadge.statusCode === 403
      );
      console.log(` -> Result: ${demo1Passed ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // ----------------------------------------------------------------------
      // DEMO 2: Same "Logistics Lead" Member Probes in DIFFERENT Club (Cross-Club IDOR Protection)
      // ----------------------------------------------------------------------
      console.log('DEMO 2: Testing Cross-Club IDOR Protection for "Logistics Lead" on Club #999 Probes');

      const resCrossEdit = await makeRequest('GET', '/club/999/_probe/EVENT_EDIT', null, [student1Cookie], false);
      console.log(` -> Probe /club/999/_probe/EVENT_EDIT Status: ${resCrossEdit.statusCode} (Expected: 403 Forbidden)`);

      const resCrossViewReg = await makeRequest('GET', '/club/999/_probe/VIEW_REGISTRATIONS', null, [student1Cookie], false);
      console.log(` -> Probe /club/999/_probe/VIEW_REGISTRATIONS Status: ${resCrossViewReg.statusCode} (Expected: 403 Forbidden)`);

      const demo2Passed = (resCrossEdit.statusCode === 403 && resCrossViewReg.statusCode === 403);
      console.log(` -> Result: ${demo2Passed ? 'PASS ✅' : 'FAIL ❌'}\n`);

      // ----------------------------------------------------------------------
      // DEMO 3: Club Admin Posting TIMETABLE_CREATE_EDIT in Dynamic Role -> Refused 403
      // ----------------------------------------------------------------------
      console.log('DEMO 3: Club Admin attempting to grant Forbidden System Permission TIMETABLE_CREATE_EDIT');

      const resGetRoles = await makeRequest('GET', `/club/${clubId}/roles`, null, [clubAdminCookie], false);
      const csrfCookieHeader = resGetRoles.setCookies.find(c => c.startsWith('x-csrf-token='));
      const csrfCookieValue = csrfCookieHeader ? csrfCookieHeader.split(';')[0] : '';
      const csrfMatch = resGetRoles.body.match(/name="_csrf"\s+value="([^"]+)"/);
      const csrfToken = csrfMatch ? csrfMatch[1] : '';
      const combinedAdminCookies = [clubAdminCookie, csrfCookieValue];

      const resForbiddenPerm = await makeRequest('POST', `/club/${clubId}/roles`, {
        _csrf: csrfToken,
        roleName: 'Hacked Admin Position',
        description: 'Attempting to inject timetable edit permission',
        permissionNames: ['EVENT_CREATE', 'TIMETABLE_CREATE_EDIT']
      }, combinedAdminCookies, true);

      console.log(` -> POST /club/${clubId}/roles (with TIMETABLE_CREATE_EDIT) Status: ${resForbiddenPerm.statusCode} (Expected: 403 Forbidden)`);
      console.log(` -> Response Payload: ${resForbiddenPerm.body}`);

      // Verify Audit Log entry for denial
      const denialAudit = db.prepare(
        "SELECT * FROM audit_logs WHERE action = 'DYNAMIC_ROLE_PERM_DENIED' AND actor_id = ? ORDER BY id DESC LIMIT 1"
      ).get(clubAdmin.id);

      console.log(` -> Audit Log Denial Recorded: ${denialAudit ? 'YES (Action: ' + denialAudit.action + ')' : 'NO'}`);
      const demo3Passed = (resForbiddenPerm.statusCode === 403 && denialAudit !== undefined);
      console.log(` -> Result: ${demo3Passed ? 'PASS ✅' : 'FAIL ❌'}\n`);

      console.log('========================================================================================\n');
    } catch (err) {
      console.error('Test Exception:', err);
    } finally {
      server.close();
      process.exit(0);
    }
  });
}

runDynamicRoleAndProbeTests();
