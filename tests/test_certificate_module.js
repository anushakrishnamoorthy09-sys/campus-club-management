const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const eventService = require('../src/services/eventService');
const registrationService = require('../src/services/registrationService');
const attendanceService = require('../src/services/attendanceService');
const certificateService = require('../src/services/certificateService');
const pdfService = require('../src/services/pdfService');

const testResults = [];

function recordTest(testName, passed, details = '') {
  testResults.push({
    test: testName,
    status: passed ? 'PASS ✅' : 'FAIL ❌',
    details
  });
}

async function runCertificateUnitTests() {
  console.log('\n========================================================================================');
  console.log('                 CAMPUSCLUBOS CERTIFICATE MANAGEMENT TEST SUITE                         ');
  console.log('========================================================================================\n');

  // Seed DB fresh
  seedDatabase();

  const superAdmin = db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN'").get();
  const clubAdmin = db.prepare("SELECT * FROM users WHERE email = 'clubadmin@campus.edu'").get();
  const faculty1 = db.prepare("SELECT * FROM users WHERE email = 'faculty.mentor@campus.edu'").get();
  const student1 = db.prepare("SELECT * FROM users WHERE email = 'student1@campus.edu'").get();
  const student2 = db.prepare("SELECT * FROM users WHERE email = 'student2@campus.edu'").get();
  const codingClub = db.prepare("SELECT * FROM clubs WHERE code = 'CODE01'").get();

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // Create Fixture Event
  const event = eventService.createEvent(clubAdmin, codingClub.id, {
    title: 'Certificate Masterclass',
    description: 'Testing certificate rules',
    venue: 'Hall 1',
    event_date: todayStr,
    start_time: '23:45',
    end_time: '23:55',
    capacity: 100
  });
  eventService.transition(event.id, 'submit', clubAdmin);
  eventService.transition(event.id, 'approve', faculty1);

  // Register Student 1 and Student 2 while APPROVED
  registrationService.register(event.id, student1.id);
  registrationService.register(event.id, student2.id);

  // Move event to ONGOING
  eventService.transition(event.id, 'start', clubAdmin);

  // Mark Student 1 PRESENT, Student 2 ABSENT
  attendanceService.markAttendance(event.id, student1.id, 'PRESENT', clubAdmin);
  attendanceService.markAttendance(event.id, student2.id, 'ABSENT', clubAdmin);

  // ------------------------------------------------------------------------
  // TEST 1: Cannot issue before COMPLETED (Status is ONGOING)
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 1] Verifying issuance refusal before event COMPLETED...');
    certificateService.issue(event.id, student1.id, 'PARTICIPANT', clubAdmin);
    recordTest('1. Cannot issue before COMPLETED', false, 'Allowed issuance while status was ONGOING');
  } catch (err) {
    const pass = err.statusCode === 400 && err.message.includes('COMPLETED');
    recordTest('1. Cannot issue before COMPLETED', pass, err.message);
  }

  // Move event to COMPLETED
  eventService.transition(event.id, 'complete', clubAdmin);

  // ------------------------------------------------------------------------
  // TEST 2: Cannot issue to an ABSENT student
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 2] Verifying issuance refusal for ABSENT student...');
    certificateService.issue(event.id, student2.id, 'PARTICIPANT', clubAdmin);
    recordTest('2. Cannot issue to an ABSENT student', false, 'Allowed issuance to ABSENT student');
  } catch (err) {
    const pass = err.statusCode === 400 && err.message.includes('PRESENT');
    recordTest('2. Cannot issue to an ABSENT student', pass, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 3: Role without ISSUE_CERTIFICATE permission refused
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 3] Verifying refusal for role without ISSUE_CERTIFICATE...');
    certificateService.issue(event.id, student1.id, 'PARTICIPANT', student1);
    recordTest('3. Role without ISSUE_CERTIFICATE refused (403)', false, 'Allowed student without permission to issue');
  } catch (err) {
    const pass = err.statusCode === 403 && err.message.includes('ISSUE_CERTIFICATE');
    recordTest('3. Role without ISSUE_CERTIFICATE refused (403)', pass, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 4: Successful Certificate Issuance to PRESENT student
  // ------------------------------------------------------------------------
  let cert1;
  try {
    console.log('[TEST 4] Issuing valid certificate to PRESENT student...');
    cert1 = certificateService.issue(event.id, student1.id, 'WINNER', clubAdmin);
    const pass = Boolean(cert1 && cert1.certificate_uuid && cert1.role_type === 'WINNER');
    recordTest('4. Successful certificate issue to PRESENT student', pass, `UUID: ${cert1 ? cert1.certificate_uuid : 'NONE'}`);
  } catch (err) {
    recordTest('4. Successful certificate issue to PRESENT student', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 5: Duplicate issue refused
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 5] Verifying duplicate issue refusal...');
    certificateService.issue(event.id, student1.id, 'PARTICIPANT', clubAdmin);
    recordTest('5. Duplicate issue refused', false, 'Allowed duplicate certificate issue');
  } catch (err) {
    const pass = err.statusCode === 400 && err.message.includes('already been issued');
    recordTest('5. Duplicate issue refused', pass, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 6: Bulk issue skips already issued
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 6] Verifying bulk issue skips already issued certificates...');
    const bulkResult = certificateService.bulkIssue(event.id, clubAdmin, 'PARTICIPANT');
    const pass = bulkResult.issuedCount === 0 && bulkResult.skippedCount === 1;
    recordTest('6. Bulk issue skips already issued', pass, `Issued: ${bulkResult.issuedCount}, Skipped: ${bulkResult.skippedCount}`);
  } catch (err) {
    recordTest('6. Bulk issue skips already issued', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 7: Public verification shows VALID, REVOKED, and NOT FOUND correctly without 500
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 7] Verifying public verification lookups...');
    const validLookup = certificateService.getPublicCertificate(cert1.certificate_uuid);
    const invalidLookup = certificateService.getPublicCertificate('invalid-uuid-12345');

    // Revoke cert1 and check revoked lookup
    certificateService.revoke(cert1.id, clubAdmin, 'Testing revocation feature');
    const revokedLookup = certificateService.getPublicCertificate(cert1.certificate_uuid);

    const pass = validLookup.status === 'ISSUED' &&
                 invalidLookup === null &&
                 revokedLookup.status === 'REVOKED' &&
                 revokedLookup.revocationReason === 'Testing revocation feature';

    recordTest('7. Public verification (VALID, REVOKED, NOT FOUND) operates correctly without 500', pass,
               `Valid: ${validLookup.status}, Revoked: ${revokedLookup.status}, Invalid: ${invalidLookup}`);
  } catch (err) {
    recordTest('7. Public verification (VALID, REVOKED, NOT FOUND) operates correctly without 500', false, err.message);
  }

  // ------------------------------------------------------------------------
  // TEST 8: PDF generation produces application/pdf buffer of non-trivial size
  // ------------------------------------------------------------------------
  try {
    console.log('[TEST 8] Verifying PDFkit landscape certificate & portfolio generation...');
    const certPdfBuffer = await pdfService.generateCertificatePdf(cert1.certificate_uuid);
    const portfolioPdfBuffer = await pdfService.generatePortfolioPdf(student1.id);

    const pass = Buffer.isBuffer(certPdfBuffer) && certPdfBuffer.length > 2000 &&
                 Buffer.isBuffer(portfolioPdfBuffer) && portfolioPdfBuffer.length > 1500;

    recordTest('8. PDF generation produces non-trivial application/pdf buffers (>2KB)', pass,
               `Cert PDF size: ${certPdfBuffer.length} bytes | Portfolio PDF size: ${portfolioPdfBuffer.length} bytes`);
  } catch (err) {
    recordTest('8. PDF generation produces non-trivial application/pdf buffers (>2KB)', false, err.message);
  }

  // Summary
  console.log('\n========================================================================================');
  console.log('                  CERTIFICATE MODULE TEST RESULTS SUMMARY                               ');
  console.log('========================================================================================\n');
  console.table(testResults);

  const hasFailures = testResults.some(r => r.status.includes('FAIL'));
  if (hasFailures) {
    console.error('\n❌ CERTIFICATE TESTS FAILED! Exit Code 1\n');
    process.exit(1);
  } else {
    console.log('\n✅ ALL 8 CERTIFICATE TEST SCENARIOS PASSED! Exit Code 0\n');
  }
}

if (require.main === module) {
  runCertificateUnitTests();
}

module.exports = { runCertificateUnitTests };
