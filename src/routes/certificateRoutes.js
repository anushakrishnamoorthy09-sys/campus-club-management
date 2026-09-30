const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/index');
const { requirePermission, requireRole } = require('../middleware/rbac');
const { doubleCsrfProtection, attachCsrfToken } = require('../middleware/csrf');
const certificateService = require('../services/certificateService');
const pdfService = require('../services/pdfService');
const { hasPermission } = require('../services/permissions');

const router = express.Router();

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again later.' }
});

/**
 * Dynamic Scope Resolver for Club Event Scope
 */
function resolveEventClubScope(req) {
  const eventId = req.params.id || req.params.eventId;
  if (eventId) {
    const event = db.prepare('SELECT club_id FROM events WHERE id = ?').get(eventId);
    if (event) return { clubId: event.club_id };
  }
  const directClubId = req.params.clubId || req.query.clubId || (req.body && req.body.clubId);
  if (directClubId) {
    return { clubId: parseInt(directClubId, 10) };
  }
  if (req.user && req.user.role === 'CLUB_ADMIN') {
    const club = db.prepare('SELECT id FROM clubs WHERE club_admin_id = ? LIMIT 1').get(req.user.id);
    if (club) return { clubId: club.id };
  }
  return { clubId: null };
}

// ============================================================================
// 1. PUBLIC VERIFICATION: GET /verify & GET /verify/:uuid (No Login Required)
// ============================================================================
router.get('/verify', verifyLimiter, attachCsrfToken, (req, res) => {
  const queryUuid = (req.query.uuid || req.query.id || '').trim();
  let cert = null;
  let searched = false;

  if (queryUuid) {
    searched = true;
    try {
      cert = certificateService.getPublicCertificate(queryUuid);
    } catch (err) {
      console.error('[VERIFY SEARCH ERROR]:', err.message);
      cert = null;
    }
  }

  res.render('verify', {
    title: 'Public Certificate Verification - CampusClubOS',
    queryUuid,
    searched,
    cert
  });
});

router.get('/verify/:uuid', verifyLimiter, attachCsrfToken, (req, res) => {
  const uuidParam = (req.params.uuid || '').trim();
  let cert = null;
  const searched = true;

  try {
    cert = certificateService.getPublicCertificate(uuidParam);
  } catch (err) {
    console.error('[VERIFY DIRECT ERROR]:', err.message);
    cert = null;
  }

  res.render('verify', {
    title: cert ? `Certificate Verified - ${cert.studentName}` : 'Certificate Not Found',
    queryUuid: uuidParam,
    searched,
    cert
  });
});

// ============================================================================
// 2. CLUB SIDE: GET /club/events/:id/certificates - Certificate Roster & Issue Page
// ============================================================================
router.get('/club/events/:id/certificates', requirePermission('ISSUE_CERTIFICATE', resolveEventClubScope), attachCsrfToken, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  try {
    const data = certificateService.getEventCertificateRoster(eventId, req.user);
    res.render('club/events/certificates', {
      title: `Certificates - ${data.event.title}`,
      event: data.event,
      roster: data.roster,
      summary: data.summary,
      allowedRoles: data.allowedRoles,
      isCompleted: data.event.status === 'COMPLETED',
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (statusCode === 404) {
      return res.status(404).render('404', { title: '404 - Event Not Found' });
    }
    return res.status(statusCode).render('error', { title: 'Certificates Access Error', message: err.message });
  }
});

// ============================================================================
// 3. POST /club/events/:id/certificates/issue - Single Issue
// ============================================================================
router.post('/club/events/:id/certificates/issue', requirePermission('ISSUE_CERTIFICATE', resolveEventClubScope), doubleCsrfProtection, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const { studentUserId, roleType } = req.body;

  try {
    const cert = certificateService.issue(eventId, studentUserId, roleType, req.user);
    const msg = `Successfully issued ${cert.role_type} certificate to student.`;
    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}/certificates?success=${encodeURIComponent(msg)}`);
    }
    return res.status(201).json({ message: msg, certificate: cert });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}/certificates?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 4. POST /club/events/:id/certificates/bulk-issue - Bulk Issue
// ============================================================================
router.post('/club/events/:id/certificates/bulk-issue', requirePermission('ISSUE_CERTIFICATE', resolveEventClubScope), doubleCsrfProtection, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const { defaultRole, studentRoles } = req.body;

  let roleMap = {};
  if (studentRoles && typeof studentRoles === 'object') {
    roleMap = studentRoles;
  }

  try {
    const result = certificateService.bulkIssue(eventId, req.user, defaultRole, roleMap);
    const msg = `Bulk issuance completed! Issued: ${result.issuedCount}, Skipped: ${result.skippedCount}.`;
    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}/certificates?success=${encodeURIComponent(msg)}`);
    }
    return res.json({ message: msg, result });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}/certificates?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 5. POST /club/events/:id/certificates/:certId/revoke - Revoke Certificate
// ============================================================================
router.post('/club/events/:id/certificates/:certId/revoke', doubleCsrfProtection, (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const certId = parseInt(req.params.certId, 10);
  const { reason } = req.body;

  try {
    const revoked = certificateService.revoke(certId, req.user, reason);
    const msg = `Certificate #${revoked.certificate_uuid} revoked successfully.`;
    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}/certificates?success=${encodeURIComponent(msg)}`);
    }
    return res.json({ message: msg, certificate: revoked });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return res.redirect(`/club/events/${eventId}/certificates?error=${encodeURIComponent(err.message)}`);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

// ============================================================================
// 6. STUDENT SIDE: GET /student/certificates - List Student's Certificates
// ============================================================================
router.get('/student/certificates', requireRole('STUDENT', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const certificates = certificateService.getStudentCertificates(req.user.id);
  res.render('student/certificates', {
    title: 'My Verifiable Certificates',
    certificates,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 7. GET /student/certificates/:id/download - Stream Certificate PDF
// ============================================================================
router.get('/student/certificates/:id/download', async (req, res) => {
  const identifier = req.params.id;

  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Lookup Certificate
  let cert = db.prepare(`
    SELECT cert.*, e.club_id
    FROM certificates cert
    JOIN events e ON cert.event_id = e.id
    WHERE cert.certificate_uuid = ? OR cert.id = ?
  `).get(identifier, parseInt(identifier, 10) || 0);

  if (!cert) {
    return res.status(404).render('404', { title: '404 - Certificate Not Found' });
  }

  // Authorization Check:
  // Owner student OR Club Admin of event's club OR Faculty Coordinator of event's club OR Admin/Super Admin
  const isOwner = req.user.role === 'STUDENT' && req.user.id === cert.student_user_id;
  const isSuperAdmin = req.user.role === 'SUPER_ADMIN' || req.user.role === 'ADMIN';
  const isClubAdmin = req.user.role === 'CLUB_ADMIN' && Boolean(
    db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(cert.club_id, req.user.id)
  );
  const isCoordinator = req.user.role === 'FACULTY' && Boolean(
    db.prepare('SELECT id FROM club_coordinators WHERE club_id = ? AND faculty_user_id = ?').get(cert.club_id, req.user.id)
  );

  if (!isOwner && !isSuperAdmin && !isClubAdmin && !isCoordinator) {
    // Other students get 404 per security specification
    return res.status(404).render('404', { title: '404 - Certificate Not Found' });
  }

  try {
    const pdfBuffer = await pdfService.generateCertificatePdf(cert.certificate_uuid);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Certificate-${cert.certificate_uuid.substring(0, 8)}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error('[PDF DOWNLOAD ERROR]:', err);
    return res.status(500).render('error', { title: 'PDF Generation Error', message: 'Failed to render certificate PDF.' });
  }
});

// ============================================================================
// 8. GET /student/portfolio.pdf - Stream Student Portfolio Activity PDF
// ============================================================================
router.get('/student/portfolio.pdf', async (req, res) => {
  if (!req.user || req.user.role !== 'STUDENT') {
    return res.status(403).render('403', { title: '403 - Forbidden', message: 'Only logged-in students can export their activity portfolio.' });
  }

  try {
    const pdfBuffer = await pdfService.generatePortfolioPdf(req.user.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Portfolio-${req.user.ra_number || req.user.id}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error('[PORTFOLIO PDF ERROR]:', err);
    return res.status(500).render('error', { title: 'PDF Generation Error', message: 'Failed to generate student activity portfolio.' });
  }
});

// ============================================================================
// 9. FACULTY OVERSIGHT: GET /faculty/certificates
// ============================================================================
router.get('/faculty/certificates', requireRole('FACULTY', 'SUPER_ADMIN', 'ADMIN'), attachCsrfToken, (req, res) => {
  const certificates = certificateService.getFacultyCertificates(req.user.id);
  res.render('faculty/certificates', {
    title: 'Faculty Oversight - Certificates Issued',
    certificates,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ============================================================================
// 10. ADMIN OVERSIGHT: GET /admin/certificates
// ============================================================================
router.get('/admin/certificates', requireRole('ADMIN', 'SUPER_ADMIN'), attachCsrfToken, (req, res) => {
  const filters = {
    clubId: req.query.clubId,
    eventId: req.query.eventId,
    raNumber: req.query.raNumber,
    date: req.query.date
  };

  const certificates = certificateService.getAllCertificates(filters);
  const clubs = db.prepare('SELECT id, name, code FROM clubs ORDER BY name ASC').all();

  res.render('admin/certificates', {
    title: 'Admin Oversight - Certificates',
    certificates,
    clubs,
    filters,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

module.exports = router;
