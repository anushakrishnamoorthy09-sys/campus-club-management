const fs = require('fs');
const path = require('path');
const db = require('../src/db/index');
const { seedDatabase } = require('../db/seed');
const eventService = require('../src/services/eventService');
const registrationService = require('../src/services/registrationService');
const attendanceService = require('../src/services/attendanceService');
const certificateService = require('../src/services/certificateService');
const pdfService = require('../src/services/pdfService');

async function generateSample() {
  console.log('[SAMPLE GENERATOR] Initializing database...');
  seedDatabase();

  const clubAdmin = db.prepare("SELECT * FROM users WHERE email = 'clubadmin@campus.edu'").get();
  const faculty1 = db.prepare("SELECT * FROM users WHERE email = 'faculty.mentor@campus.edu'").get();
  const student1 = db.prepare("SELECT * FROM users WHERE email = 'student1@campus.edu'").get();
  const codingClub = db.prepare("SELECT * FROM clubs WHERE code = 'CODE01'").get();

  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // 1. Create and complete event
  const event = eventService.createEvent(clubAdmin, codingClub.id, {
    title: 'AI & Web Architecture Summit 2026',
    description: 'National Symposium on Advanced Software Engineering',
    venue: 'Main Auditorium',
    event_date: todayStr,
    start_time: '23:45',
    end_time: '23:55',
    capacity: 200
  });

  eventService.transition(event.id, 'submit', clubAdmin);
  eventService.transition(event.id, 'approve', faculty1);

  // Register Student 1 while APPROVED
  registrationService.register(event.id, student1.id);

  // Start & Complete Event
  eventService.transition(event.id, 'start', clubAdmin);
  attendanceService.markAttendance(event.id, student1.id, 'PRESENT', clubAdmin, 'QR');
  eventService.transition(event.id, 'complete', clubAdmin);

  // 2. Issue Certificate
  const cert = certificateService.issue(event.id, student1.id, 'WINNER', clubAdmin);
  console.log(`[SAMPLE GENERATOR] Issued Certificate UUID: ${cert.certificate_uuid}`);

  // 3. Generate PDF Buffer
  const pdfBuffer = await pdfService.generateCertificatePdf(cert.certificate_uuid);

  // 4. Save to scratch/sample_certificate.pdf
  const scratchDir = path.resolve(process.cwd(), 'scratch');
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

  const outputPath = path.resolve(scratchDir, 'sample_certificate.pdf');
  fs.writeFileSync(outputPath, pdfBuffer);

  console.log('\n========================================================================================');
  console.log('✅ SAMPLE CERTIFICATE PDF GENERATED SUCCESSFULLY!');
  console.log(`File Path: ${outputPath}`);
  console.log(`File Size: ${pdfBuffer.length} bytes`);
  console.log('========================================================================================\n');
}

if (require.main === module) {
  generateSample().catch(err => {
    console.error('Error generating sample certificate:', err);
    process.exit(1);
  });
}
