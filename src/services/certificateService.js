const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/index');
const { hasPermission } = require('./permissions');
const notificationService = require('./notificationService');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_12345';
const ALLOWED_ROLES = ['PARTICIPANT', 'WINNER', 'RUNNER_UP', 'VOLUNTEER', 'ORGANIZER'];

/**
 * Audit Logger Helper
 */
function logAudit(actorId, action, targetEntity, targetId = null, detailsObj = {}) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json) VALUES (?, ?, ?, ?, ?)'
    ).run(actorId, action, targetEntity, targetId, JSON.stringify(detailsObj));
  } catch (err) {
    console.error('[CERTIFICATE AUDIT LOG ERROR]:', err.message);
  }
}

/**
 * Mask RA Number for public privacy (e.g., RA2311003010001 -> RA23...0001)
 */
function maskRaNumber(raNumber) {
  if (!raNumber || typeof raNumber !== 'string' || raNumber.length < 8) {
    return raNumber || '';
  }
  const prefix = raNumber.substring(0, 4);
  const suffix = raNumber.substring(raNumber.length - 4);
  return `${prefix}...${suffix}`;
}

/**
 * Compute SHA-256 Verification Hash over immutable DB certificate fields
 */
function computeVerificationHash(certificateUuid, eventId, studentUserId, raNumber, roleType) {
  const payload = `${certificateUuid}:${eventId}:${studentUserId}:${raNumber}:${roleType}:${JWT_SECRET}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Issue a single certificate to a present event attendee
 */
function issue(eventIdInput, studentUserIdInput, participationRoleInput, actorUser) {
  const eventId = parseInt(eventIdInput, 10);
  const studentUserId = parseInt(studentUserIdInput, 10);
  const roleType = (participationRoleInput || 'PARTICIPANT').toUpperCase().trim();

  if (isNaN(eventId) || !eventId) {
    const err = new Error('Valid event ID is required');
    err.statusCode = 400;
    throw err;
  }

  if (isNaN(studentUserId) || !studentUserId) {
    const err = new Error('Valid student user ID is required');
    err.statusCode = 400;
    throw err;
  }

  if (!ALLOWED_ROLES.includes(roleType)) {
    const err = new Error(`Invalid participation role '${roleType}'. Allowed roles: ${ALLOWED_ROLES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  // 1. Fetch Event & verify Club Scope
  const event = db.prepare(`
    SELECT e.*, c.name as club_name, c.club_admin_id
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    const err = new Error('Event not found');
    err.statusCode = 404;
    throw err;
  }

  // 2. Permission Check: Require ISSUE_CERTIFICATE for event's club
  if (!hasPermission(actorUser, 'ISSUE_CERTIFICATE', { clubId: event.club_id })) {
    const err = new Error('Access Forbidden: Missing ISSUE_CERTIFICATE permission for this club');
    err.statusCode = 403;
    throw err;
  }

  // 3. Event Status Constraint: Must be COMPLETED
  if (event.status !== 'COMPLETED') {
    const err = new Error(`Certificates can only be issued for COMPLETED events. Current event status is '${event.status}'.`);
    err.statusCode = 400;
    throw err;
  }

  // 4. Fetch Student Profile & verify Registration
  const student = db.prepare(`
    SELECT s.user_id, s.ra_number, s.department, u.full_name, u.email
    FROM students s
    JOIN users u ON s.user_id = u.id
    WHERE s.user_id = ?
  `).get(studentUserId);

  if (!student) {
    const err = new Error('Student profile not found');
    err.statusCode = 404;
    throw err;
  }

  const registration = db.prepare('SELECT id FROM event_registrations WHERE event_id = ? AND student_user_id = ?').get(eventId, studentUserId);
  if (!registration) {
    const err = new Error('Action Denied: Student is not registered for this event');
    err.statusCode = 400;
    throw err;
  }

  // 5. Attendance Check: Must be PRESENT
  const attendance = db.prepare('SELECT status FROM attendance WHERE event_id = ? AND student_user_id = ?').get(eventId, studentUserId);
  if (!attendance || attendance.status !== 'PRESENT') {
    const err = new Error('Action Denied: Certificate can only be issued to students marked PRESENT');
    err.statusCode = 400;
    throw err;
  }

  // 6. Duplicate Issue Check
  const existingCert = db.prepare('SELECT id, certificate_uuid FROM certificates WHERE event_id = ? AND student_user_id = ?').get(eventId, studentUserId);
  if (existingCert) {
    const err = new Error(`Certificate has already been issued to this student for this event (ID: ${existingCert.certificate_uuid}).`);
    err.statusCode = 400;
    throw err;
  }

  // 7. Generate UUID and Hash
  const certificateUuid = uuidv4();
  const verificationHash = computeVerificationHash(certificateUuid, eventId, studentUserId, student.ra_number, roleType);

  // 8. Execute DB Insertion & Notification in Transaction
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO certificates (
        certificate_uuid, event_id, student_user_id, role_type, verification_hash, issued_by, issued_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'ISSUED')
    `).run(certificateUuid, eventId, studentUserId, roleType, verificationHash, actorUser.id);

    logAudit(actorUser.id, 'CERTIFICATE_ISSUED', 'certificates', eventId, {
      certificateUuid,
      eventId,
      studentUserId,
      roleType,
      studentRa: student.ra_number
    });

    notificationService.createNotification(
      studentUserId,
      'Certificate Issued!',
      `Congratulations! Your certificate of ${roleType} for '${event.title}' is now available.`,
      'CERTIFICATE_ISSUED',
      `/student/certificates`
    );

    try {
      const badgeService = require('./badgeService');
      badgeService.evaluateAutoBadges(studentUserId);
    } catch (e) {
      console.error('[AUTO BADGE ERROR]:', e.message);
    }

    return db.prepare('SELECT * FROM certificates WHERE certificate_uuid = ?').get(certificateUuid);
  });

  return tx();
}

/**
 * Bulk issue certificates to all confirmed (PRESENT) attendees in one transaction
 */
function bulkIssue(eventIdInput, actorUser, defaultRole = 'PARTICIPANT', studentRoleMap = {}) {
  const eventId = parseInt(eventIdInput, 10);
  const roleDefault = (defaultRole || 'PARTICIPANT').toUpperCase().trim();

  if (isNaN(eventId) || !eventId) {
    const err = new Error('Valid event ID is required');
    err.statusCode = 400;
    throw err;
  }

  const event = db.prepare(`
    SELECT e.*, c.name as club_name, c.club_admin_id
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    const err = new Error('Event not found');
    err.statusCode = 404;
    throw err;
  }

  // Permission Check
  if (!hasPermission(actorUser, 'ISSUE_CERTIFICATE', { clubId: event.club_id })) {
    const err = new Error('Access Forbidden: Missing ISSUE_CERTIFICATE permission for this club');
    err.statusCode = 403;
    throw err;
  }

  if (event.status !== 'COMPLETED') {
    const err = new Error(`Certificates can only be issued for COMPLETED events. Current event status is '${event.status}'.`);
    err.statusCode = 400;
    throw err;
  }

  // Fetch all PRESENT attendees for the event
  const presentAttendees = db.prepare(`
    SELECT att.student_user_id, s.ra_number, u.full_name
    FROM attendance att
    JOIN students s ON att.student_user_id = s.user_id
    JOIN users u ON s.user_id = u.id
    WHERE att.event_id = ? AND att.status = 'PRESENT'
  `).all(eventId);

  let issuedCount = 0;
  let skippedCount = 0;
  const skippedDetails = [];
  const issuedCertificates = [];

  const tx = db.transaction(() => {
    for (const attendee of presentAttendees) {
      const studentUserId = attendee.student_user_id;

      // Check if already issued
      const existing = db.prepare('SELECT id, certificate_uuid FROM certificates WHERE event_id = ? AND student_user_id = ?').get(eventId, studentUserId);
      if (existing) {
        skippedCount++;
        skippedDetails.push({ studentUserId, raNumber: attendee.ra_number, name: attendee.full_name, reason: 'ALREADY_ISSUED' });
        continue;
      }

      const roleType = (studentRoleMap[studentUserId] || roleDefault).toUpperCase().trim();
      const validRole = ALLOWED_ROLES.includes(roleType) ? roleType : 'PARTICIPANT';

      const certUuid = uuidv4();
      const vHash = computeVerificationHash(certUuid, eventId, studentUserId, attendee.ra_number, validRole);

      db.prepare(`
        INSERT INTO certificates (
          certificate_uuid, event_id, student_user_id, role_type, verification_hash, issued_by, issued_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'ISSUED')
      `).run(certUuid, eventId, studentUserId, validRole, vHash, actorUser.id);

      logAudit(actorUser.id, 'CERTIFICATE_ISSUED', 'certificates', eventId, {
        certificateUuid: certUuid,
        eventId,
        studentUserId,
        roleType: validRole,
        studentRa: attendee.ra_number
      });

      notificationService.createNotification(
        studentUserId,
        'Certificate Issued!',
        `Congratulations! Your certificate of ${validRole} for '${event.title}' is now available.`,
        'CERTIFICATE_ISSUED',
        `/student/certificates`
      );

      issuedCount++;
      issuedCertificates.push(certUuid);
    }

    return {
      eventId,
      totalPresent: presentAttendees.length,
      issuedCount,
      skippedCount,
      skippedDetails,
      issuedCertificates
    };
  });

  return tx();
}

/**
 * Revoke a certificate with mandatory reason string
 */
function revoke(certificateIdInput, actorUser, reasonInput) {
  const certId = parseInt(certificateIdInput, 10);
  const reason = (reasonInput || '').trim();

  if (!reason) {
    const err = new Error('Revocation reason is mandatory');
    err.statusCode = 400;
    throw err;
  }

  let cert;
  if (!isNaN(certId) && certId > 0) {
    cert = db.prepare(`
      SELECT cert.*, e.club_id, e.title as event_title
      FROM certificates cert
      JOIN events e ON cert.event_id = e.id
      WHERE cert.id = ?
    `).get(certId);
  } else {
    // Lookup by UUID if string passed
    cert = db.prepare(`
      SELECT cert.*, e.club_id, e.title as event_title
      FROM certificates cert
      JOIN events e ON cert.event_id = e.id
      WHERE cert.certificate_uuid = ?
    `).get(certificateIdInput);
  }

  if (!cert) {
    const err = new Error('Certificate not found');
    err.statusCode = 404;
    throw err;
  }

  if (cert.status === 'REVOKED') {
    const err = new Error('Certificate is already revoked');
    err.statusCode = 400;
    throw err;
  }

  // Authorization: Super Admin OR Club Admin of event's club
  const isSuperAdmin = actorUser.role === 'SUPER_ADMIN';
  const isClubAdmin = actorUser.role === 'CLUB_ADMIN' && Boolean(
    db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(cert.club_id, actorUser.id)
  );

  if (!isSuperAdmin && !isClubAdmin) {
    const err = new Error('Access Forbidden: Only the Club Admin or Super Admin can revoke certificates');
    err.statusCode = 403;
    throw err;
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE certificates
      SET status = 'REVOKED',
          revocation_reason = ?,
          revoked_by = ?,
          revoked_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reason, actorUser.id, cert.id);

    logAudit(actorUser.id, 'CERTIFICATE_REVOKED', 'certificates', cert.event_id, {
      certificateId: cert.id,
      certificateUuid: cert.certificate_uuid,
      studentUserId: cert.student_user_id,
      reason
    });

    return db.prepare('SELECT * FROM certificates WHERE id = ?').get(cert.id);
  });

  return tx();
}

/**
 * Public Verification Lookup
 */
function getPublicCertificate(uuidStr) {
  if (!uuidStr || typeof uuidStr !== 'string') {
    return null;
  }

  const cert = db.prepare(`
    SELECT cert.id, cert.certificate_uuid, cert.role_type, cert.verification_hash, cert.issued_at,
           cert.status, cert.revocation_reason, cert.revoked_at,
           e.id as event_id, e.title as event_title, e.event_date, e.venue,
           c.name as club_name, c.code as club_code, c.logo_url as club_logo_url,
           u_student.full_name as student_name, s.ra_number, s.department,
           u_issuer.full_name as issuer_name, u_issuer.role as issuer_role
    FROM certificates cert
    JOIN events e ON cert.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    JOIN students s ON cert.student_user_id = s.user_id
    JOIN users u_student ON s.user_id = u_student.id
    JOIN users u_issuer ON cert.issued_by = u_issuer.id
    WHERE cert.certificate_uuid = ?
  `).get(uuidStr.trim());

  if (!cert) {
    return null;
  }

  return {
    certificateUuid: cert.certificate_uuid,
    status: cert.status,
    roleType: cert.role_type,
    studentName: cert.student_name,
    maskedRaNumber: maskRaNumber(cert.ra_number),
    department: cert.department,
    eventTitle: cert.event_title,
    eventDate: cert.event_date,
    venue: cert.venue,
    clubName: cert.club_name,
    clubCode: cert.club_code,
    clubLogoUrl: cert.logo_url,
    issuerName: cert.issuer_name,
    issuerRole: cert.issuer_role,
    issuedAt: cert.issued_at,
    revocationReason: cert.revocation_reason || null,
    revokedAt: cert.revoked_at || null
  };
}

/**
 * Fetch full certificate management roster for an event
 */
function getEventCertificateRoster(eventIdInput, actorUser) {
  const eventId = parseInt(eventIdInput, 10);
  const event = db.prepare(`
    SELECT e.*, c.name as club_name, c.code as club_code
    FROM events e
    JOIN clubs c ON e.club_id = c.id
    WHERE e.id = ?
  `).get(eventId);

  if (!event) {
    const err = new Error('Event not found');
    err.statusCode = 404;
    throw err;
  }

  if (!hasPermission(actorUser, 'ISSUE_CERTIFICATE', { clubId: event.club_id })) {
    const err = new Error('Access Forbidden: Missing ISSUE_CERTIFICATE permission for this club');
    err.statusCode = 403;
    throw err;
  }

  const roster = db.prepare(`
    SELECT att.student_user_id, att.status as attendance_status, att.marked_at as attendance_marked_at,
           s.ra_number, s.department, s.year_of_study, s.section,
           u.full_name as student_name, u.email,
           cert.id as certificate_id, cert.certificate_uuid, cert.role_type, cert.issued_at, cert.status as cert_status,
           cert.revocation_reason
    FROM attendance att
    JOIN students s ON att.student_user_id = s.user_id
    JOIN users u ON s.user_id = u.id
    LEFT JOIN certificates cert ON (cert.event_id = att.event_id AND cert.student_user_id = att.student_user_id)
    WHERE att.event_id = ? AND att.status = 'PRESENT'
    ORDER BY u.full_name ASC
  `).all(eventId);

  let issuedCount = 0;
  let unissuedCount = 0;

  roster.forEach(r => {
    if (r.certificate_id && r.cert_status === 'ISSUED') {
      issuedCount++;
    } else {
      unissuedCount++;
    }
  });

  return {
    event,
    roster,
    summary: {
      totalPresent: roster.length,
      issuedCount,
      unissuedCount
    },
    allowedRoles: ALLOWED_ROLES
  };
}

/**
 * Fetch all certificates belonging to a student
 */
function getStudentCertificates(studentUserId) {
  return db.prepare(`
    SELECT cert.id, cert.certificate_uuid, cert.role_type, cert.issued_at, cert.status, cert.revocation_reason,
           e.id as event_id, e.title as event_title, e.event_date, e.venue,
           c.name as club_name, c.code as club_code
    FROM certificates cert
    JOIN events e ON cert.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    WHERE cert.student_user_id = ?
    ORDER BY cert.issued_at DESC
  `).all(studentUserId);
}

/**
 * Fetch oversight certificates for Faculty Coordinator
 */
function getFacultyCertificates(facultyUserId) {
  return db.prepare(`
    SELECT cert.id, cert.certificate_uuid, cert.role_type, cert.issued_at, cert.status, cert.revocation_reason,
           e.id as event_id, e.title as event_title, e.event_date,
           c.id as club_id, c.name as club_name, c.code as club_code,
           u_student.full_name as student_name, s.ra_number
    FROM certificates cert
    JOIN events e ON cert.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    JOIN club_coordinators cc ON c.id = cc.club_id
    JOIN students s ON cert.student_user_id = s.user_id
    JOIN users u_student ON s.user_id = u_student.id
    WHERE cc.faculty_user_id = ?
    ORDER BY cert.issued_at DESC
  `).all(facultyUserId);
}

/**
 * Fetch all certificates for Admin / Super Admin with filtering
 */
function getAllCertificates(filters = {}) {
  let query = `
    SELECT cert.id, cert.certificate_uuid, cert.role_type, cert.issued_at, cert.status, cert.revocation_reason,
           e.id as event_id, e.title as event_title, e.event_date,
           c.id as club_id, c.name as club_name, c.code as club_code,
           u_student.full_name as student_name, s.ra_number
    FROM certificates cert
    JOIN events e ON cert.event_id = e.id
    JOIN clubs c ON e.club_id = c.id
    JOIN students s ON cert.student_user_id = s.user_id
    JOIN users u_student ON s.user_id = u_student.id
    WHERE 1=1
  `;

  const params = [];

  if (filters.clubId) {
    query += ' AND c.id = ?';
    params.push(parseInt(filters.clubId, 10));
  }

  if (filters.eventId) {
    query += ' AND e.id = ?';
    params.push(parseInt(filters.eventId, 10));
  }

  if (filters.raNumber) {
    query += ' AND s.ra_number LIKE ?';
    params.push(`%${filters.raNumber.trim().toUpperCase()}%`);
  }

  if (filters.date) {
    query += ' AND e.event_date = ?';
    params.push(filters.date);
  }

  query += ' ORDER BY cert.issued_at DESC';

  return db.prepare(query).all(...params);
}

module.exports = {
  issue,
  bulkIssue,
  revoke,
  getPublicCertificate,
  getEventCertificateRoster,
  getStudentCertificates,
  getFacultyCertificates,
  getAllCertificates,
  maskRaNumber,
  computeVerificationHash
};
