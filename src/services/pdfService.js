const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const db = require('../db/index');
require('dotenv').config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

/**
 * Generate Landscape A4 Certificate PDF Stream / Buffer
 * Returns a Promise that resolves to a Buffer
 */
async function generateCertificatePdf(certificateUuid) {
  const cert = db.prepare(`
    SELECT cert.id, cert.certificate_uuid, cert.role_type, cert.issued_at, cert.status, cert.revocation_reason,
           e.id as event_id, e.title as event_title, e.event_date, e.venue,
           c.name as club_name, c.code as club_code, c.logo_url as club_logo_url,
           u_student.full_name as student_name, s.ra_number, s.department,
           u_issuer.full_name as issuer_name
    FROM certificates cert
    JOIN events e ON cert.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    JOIN students s ON cert.student_user_id = s.user_id
    JOIN users u_student ON s.user_id = u_student.id
    JOIN users u_issuer ON cert.issued_by = u_issuer.id
    WHERE cert.certificate_uuid = ?
  `).get(certificateUuid);

  if (!cert) {
    const err = new Error('Certificate not found');
    err.statusCode = 404;
    throw err;
  }

  // Verification QR Code URL
  const verifyUrl = `${BASE_URL}/verify/${cert.certificate_uuid}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 120, margin: 1 });
  const qrImageBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 40
    });

    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', err => reject(err));

    const width = doc.page.width;
    const height = doc.page.height;

    // Background & Double Border
    doc.rect(20, 20, width - 40, height - 40).lineWidth(3).strokeColor('#312e81').stroke();
    doc.rect(26, 26, width - 52, height - 52).lineWidth(1).strokeColor('#6366f1').stroke();

    // Top Header: Club Name & Branding
    let logoDrawn = false;
    if (cert.club_logo_url) {
      const relativeLogo = cert.club_logo_url.startsWith('/') ? cert.club_logo_url.substring(1) : cert.club_logo_url;
      const logoPath = path.resolve(process.cwd(), 'src/public', relativeLogo);
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, 50, 45, { height: 45 });
          logoDrawn = true;
        } catch (e) {
          console.error('[PDF LOGO ERROR]:', e.message);
        }
      }
    }

    doc.fillColor('#4338ca')
       .font('Helvetica-Bold')
       .fontSize(16)
       .text(cert.club_name.toUpperCase(), logoDrawn ? 110 : 50, 50, { align: 'left' });

    doc.fillColor('#64748b')
       .font('Helvetica')
       .fontSize(10)
       .text('CAMPUS CLUB MANAGEMENT SYSTEM', logoDrawn ? 110 : 50, 70, { align: 'left' });

    // Certificate Title Header
    doc.fillColor('#1e1b4b')
       .font('Helvetica-Bold')
       .fontSize(28)
       .text('CERTIFICATE OF PARTICIPATION', 0, 115, { align: 'center' });

    doc.fillColor('#6366f1')
       .font('Helvetica-Bold')
       .fontSize(12)
       .text(`PROUDLY PRESENTED AS: ${cert.role_type}`, 0, 152, { align: 'center' });

    // Recipient Section
    doc.fillColor('#475569')
       .font('Helvetica')
       .fontSize(12)
       .text('This is to certify that', 0, 185, { align: 'center' });

    doc.fillColor('#0f172a')
       .font('Helvetica-Bold')
       .fontSize(24)
       .text(cert.student_name, 0, 210, { align: 'center' });

    doc.fillColor('#3b82f6')
       .font('Helvetica-Bold')
       .fontSize(12)
       .text(`RA NUMBER: ${cert.ra_number}`, 0, 242, { align: 'center' });

    // Event & Achievement Details
    doc.fillColor('#475569')
       .font('Helvetica')
       .fontSize(12)
       .text('has successfully attended and contributed as a recognized attendee in', 0, 275, { align: 'center' });

    doc.fillColor('#1e293b')
       .font('Helvetica-Bold')
       .fontSize(18)
       .text(`"${cert.event_title}"`, 0, 298, { align: 'center' });

    doc.fillColor('#64748b')
       .font('Helvetica')
       .fontSize(11)
       .text(`Held on ${cert.event_date} at ${cert.venue} | Organized by ${cert.club_name}`, 0, 326, { align: 'center' });

    // Status Banner if Revoked
    if (cert.status === 'REVOKED') {
      doc.fillColor('#dc2626')
         .font('Helvetica-Bold')
         .fontSize(16)
         .text('*** REVOKED CERTIFICATE ***', 0, 355, { align: 'center' });
    }

    // Bottom Footer: Issuer, QR Code, Verification URL & ID
    const footerY = 440;

    // Issuer Sign Signature Block (Left)
    doc.fillColor('#0f172a')
       .font('Helvetica-Bold')
       .fontSize(11)
       .text(cert.issuer_name, 60, footerY);

    doc.fillColor('#64748b')
       .font('Helvetica')
       .fontSize(9)
       .text('Authorized Issuer / Club Admin', 60, footerY + 14);

    doc.moveTo(60, footerY - 5).lineTo(230, footerY - 5).lineWidth(1).strokeColor('#cbd5e1').stroke();

    // Embedded Verification QR Code (Right)
    doc.image(qrImageBuffer, width - 150, footerY - 30, { width: 85, height: 85 });

    doc.fillColor('#475569')
       .font('Helvetica-Bold')
       .fontSize(8)
       .text('Scan to Verify Online', width - 260, footerY, { width: 100, align: 'right' });

    doc.fillColor('#64748b')
       .font('Helvetica')
       .fontSize(7)
       .text(verifyUrl, width - 360, footerY + 12, { width: 200, align: 'right' });

    // Bottom ID Bar
    doc.fillColor('#94a3b8')
       .font('Helvetica-Bold')
       .fontSize(8)
       .text(`CERTIFICATE ID: ${cert.certificate_uuid}`, 0, height - 42, { align: 'center' });

    doc.end();
  });
}

/**
 * Generate Student Activity Portfolio PDF Stream / Buffer (Portrait A4)
 * Returns a Promise that resolves to a Buffer
 */
async function generatePortfolioPdf(studentUserId) {
  const student = db.prepare(`
    SELECT s.user_id, s.ra_number, s.department, s.year_of_study, s.section,
           u.full_name, u.email,
           u_mentor.full_name as mentor_name
    FROM students s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN users u_mentor ON s.class_mentor_id = u_mentor.id
    WHERE s.user_id = ?
  `).get(studentUserId);

  if (!student) {
    const err = new Error('Student profile not found');
    err.statusCode = 404;
    throw err;
  }

  const eventsAttended = db.prepare(`
    SELECT e.title as event_title, e.event_date, e.venue, c.name as club_name, att.method, att.marked_at
    FROM attendance att
    JOIN events e ON att.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    WHERE att.student_user_id = ? AND att.status = 'PRESENT'
    ORDER BY e.event_date DESC
  `).all(studentUserId);

  const certificates = db.prepare(`
    SELECT cert.certificate_uuid, cert.role_type, cert.issued_at, cert.status, e.title as event_title, c.name as club_name
    FROM certificates cert
    JOIN events e ON cert.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    WHERE cert.student_user_id = ?
    ORDER BY cert.issued_at DESC
  `).all(studentUserId);

  const badges = db.prepare(`
    SELECT b.name as badge_name, b.description, b.icon_name, sb.awarded_at, c.name as club_name
    FROM student_badges sb
    JOIN badges b ON sb.badge_id = b.id
    LEFT JOIN clubs c ON b.club_id = c.id
    WHERE sb.student_user_id = ?
    ORDER BY sb.awarded_at DESC
  `).all(studentUserId);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'portrait',
      margin: 40
    });

    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', err => reject(err));

    const width = doc.page.width;

    // Header
    doc.fillColor('#1e1b4b').font('Helvetica-Bold').fontSize(22).text('STUDENT ACTIVITY PORTFOLIO', 40, 40);
    doc.fillColor('#4f46e5').font('Helvetica-Bold').fontSize(11).text('CAMPUSCLUBOS INSTITUTIONAL RECORD', 40, 66);
    doc.moveTo(40, 82).lineTo(width - 40, 82).lineWidth(1.5).strokeColor('#6366f1').stroke();

    // Student Information Table / Block
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(14).text(student.full_name, 40, 95);
    doc.fillColor('#475569').font('Helvetica').fontSize(10)
       .text(`RA Number: ${student.ra_number} | Department: ${student.department} | Year ${student.year_of_study} - Sec ${student.section}`, 40, 114)
       .text(`Class Mentor: ${student.mentor_name || 'Unassigned'} | Generated Date: ${new Date().toISOString().split('T')[0]}`, 40, 130);

    let currentY = 160;

    // Section 1: Certificates Summary
    doc.fillColor('#1e1b4b').font('Helvetica-Bold').fontSize(14).text(`Issued Certificates (${certificates.length})`, 40, currentY);
    currentY += 20;

    if (certificates.length === 0) {
      doc.fillColor('#64748b').font('Helvetica-Oblique').fontSize(9).text('No certificates issued yet.', 40, currentY);
      currentY += 20;
    } else {
      certificates.forEach((c, idx) => {
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(`${idx + 1}. ${c.event_title} (${c.role_type})`, 50, currentY);
        doc.fillColor('#64748b').font('Helvetica').fontSize(9).text(`Club: ${c.club_name} | ID: ${c.certificate_uuid} | Status: ${c.status}`, 60, currentY + 12);
        currentY += 28;
      });
    }

    currentY += 10;

    // Section 2: Badges Summary
    doc.fillColor('#1e1b4b').font('Helvetica-Bold').fontSize(14).text(`Awarded Badges (${badges.length})`, 40, currentY);
    currentY += 20;

    if (badges.length === 0) {
      doc.fillColor('#64748b').font('Helvetica-Oblique').fontSize(9).text('No badges earned yet.', 40, currentY);
      currentY += 20;
    } else {
      badges.forEach((b, idx) => {
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(`${idx + 1}. [${b.badge_name}] - ${b.description}`, 50, currentY);
        doc.fillColor('#64748b').font('Helvetica').fontSize(9).text(`Source: ${b.club_name || 'System Milestone'} | Awarded: ${b.awarded_at}`, 60, currentY + 12);
        currentY += 28;
      });
    }

    currentY += 10;

    // Section 3: Attended Events Roster
    doc.fillColor('#1e1b4b').font('Helvetica-Bold').fontSize(14).text(`Attended Events History (${eventsAttended.length})`, 40, currentY);
    currentY += 20;

    if (eventsAttended.length === 0) {
      doc.fillColor('#64748b').font('Helvetica-Oblique').fontSize(9).text('No events attended yet.', 40, currentY);
    } else {
      eventsAttended.forEach((e, idx) => {
        if (currentY > 750) {
          doc.addPage();
          currentY = 40;
        }
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(`${idx + 1}. ${e.event_title}`, 50, currentY);
        doc.fillColor('#64748b').font('Helvetica').fontSize(9).text(`Club: ${e.club_name} | Date: ${e.event_date} | Method: ${e.method}`, 60, currentY + 12);
        currentY += 28;
      });
    }

    // Footer
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(8).text('CampusClubOS Official Student Activity Record', 40, doc.page.height - 30, { align: 'center' });

    doc.end();
  });
}

module.exports = {
  generateCertificatePdf,
  generatePortfolioPdf
};
