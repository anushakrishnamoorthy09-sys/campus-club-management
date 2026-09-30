const db = require('../db/index');
const { hasPermission } = require('./permissions');

/**
 * Utility to format waiting time from a past timestamp string (ISO/DATETIME)
 */
function getWaitingTimeFormatted(timestampStr) {
  if (!timestampStr) return 'N/A';
  const created = new Date(timestampStr).getTime();
  const now = new Date().getTime();
  const diffMs = now - created;
  if (diffMs <= 0) return 'Just now';

  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) {
    const diffMins = Math.floor(diffMs / (1000 * 60));
    return `${diffMins} min${diffMins === 1 ? '' : 's'}`;
  }
  if (diffHours < 24) {
    return `${diffHours} hr${diffHours === 1 ? '' : 's'}`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? '' : 's'}`;
}

/**
 * 1. CLUB ANALYTICS
 * Returns metrics for a single club. Scoped to Club Admin, member with VIEW_EVENT_ANALYTICS, or Admin.
 */
function getClubAnalytics(clubIdInput, actorUser) {
  const clubId = parseInt(clubIdInput, 10);
  if (isNaN(clubId) || !clubId) {
    const err = new Error('Invalid club ID');
    err.statusCode = 404;
    throw err;
  }

  const club = db.prepare('SELECT * FROM clubs WHERE id = ?').get(clubId);
  if (!club) {
    const err = new Error('Club not found');
    err.statusCode = 404;
    throw err;
  }

  // Permission / Ownership Check
  const isAdmin = actorUser.role === 'ADMIN' || actorUser.role === 'SUPER_ADMIN';
  const isClubAdmin = club.club_admin_id === actorUser.id;
  const isCoordinator = db.prepare('SELECT 1 FROM club_coordinators WHERE club_id = ? AND faculty_user_id = ?').get(clubId, actorUser.id);
  const hasAnalyticsPermission = hasPermission(actorUser, 'VIEW_EVENT_ANALYTICS', { clubId });

  if (!isAdmin && !isClubAdmin && !isCoordinator && !hasAnalyticsPermission) {
    const err = new Error('Access denied: You are not authorized to view analytics for this club');
    err.statusCode = 403;
    throw err;
  }

  // A. Approved Member Count
  const memberCount = db.prepare('SELECT COUNT(*) as count FROM club_memberships WHERE club_id = ? AND status = \'APPROVED\'').get(clubId).count;

  // B. Completed Events Count
  const completedEventsCount = db.prepare('SELECT COUNT(*) as count FROM events WHERE club_id = ? AND status = \'COMPLETED\'').get(clubId).count;

  // C. Total Events Count
  const totalEventsCount = db.prepare('SELECT COUNT(*) as count FROM events WHERE club_id = ?').get(clubId).count;

  // D. Total Registrations
  const totalRegistrations = db.prepare(`
    SELECT COUNT(er.id) as count
    FROM event_registrations er
    JOIN events e ON er.event_id = e.id
    WHERE e.club_id = ?
  `).get(clubId).count;

  // E. Average Attendance Rate (%)
  const attendanceAgg = db.prepare(`
    SELECT COALESCE(ROUND(AVG(
      CASE
        WHEN registered_count = 0 THEN 0.0
        ELSE (CAST(present_count AS FLOAT) / registered_count) * 100.0
      END
    ), 1), 0.0) as avg_rate
    FROM (
      SELECT e.id,
             COUNT(DISTINCT er.id) as registered_count,
             COUNT(DISTINCT CASE WHEN a.status = 'PRESENT' THEN a.id END) as present_count
      FROM events e
      LEFT JOIN event_registrations er ON e.id = er.event_id
      LEFT JOIN attendance a ON e.id = a.event_id AND a.student_user_id = er.student_user_id
      WHERE e.club_id = ? AND e.status = 'COMPLETED'
      GROUP BY e.id
    )
  `).get(clubId);
  const avgAttendanceRate = attendanceAgg ? attendanceAgg.avg_rate : 0.0;

  // F. Certificates Issued
  const certificatesIssued = db.prepare(`
    SELECT COUNT(c.id) as count
    FROM certificates c
    JOIN events e ON c.event_id = e.id
    WHERE e.club_id = ? AND c.status = 'ISSUED'
  `).get(clubId).count;

  // G. Badges Awarded
  const badgesAwarded = db.prepare(`
    SELECT COUNT(sb.id) as count
    FROM student_badges sb
    JOIN badges b ON sb.badge_id = b.id
    WHERE b.club_id = ?
  `).get(clubId).count;

  // H. Event Status Breakdown
  const statusRows = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM events
    WHERE club_id = ?
    GROUP BY status
  `).all(clubId);

  const statusBreakdown = {
    DRAFT: 0,
    PENDING_APPROVAL: 0,
    APPROVED: 0,
    ONGOING: 0,
    COMPLETED: 0,
    REJECTED: 0,
    CANCELLED: 0
  };
  statusRows.forEach(row => {
    if (statusBreakdown.hasOwnProperty(row.status)) {
      statusBreakdown[row.status] = row.count;
    }
  });

  return {
    club: { id: club.id, name: club.name, code: club.code },
    memberCount,
    completedEventsCount,
    totalEventsCount,
    totalRegistrations,
    avgAttendanceRate,
    certificatesIssued,
    badgesAwarded,
    statusBreakdown
  };
}

/**
 * 2. STUDENT ANALYTICS
 * Returns metrics for a single student. Scoped to the student themselves, their mentor, or Admin.
 */
function getStudentAnalytics(studentUserIdInput, actorUser) {
  const studentUserId = parseInt(studentUserIdInput, 10);
  if (isNaN(studentUserId) || !studentUserId) {
    const err = new Error('Invalid student user ID');
    err.statusCode = 404;
    throw err;
  }

  const student = db.prepare(`
    SELECT s.*, u.full_name, u.email
    FROM students s
    JOIN users u ON s.user_id = u.id
    WHERE s.user_id = ?
  `).get(studentUserId);

  if (!student) {
    const err = new Error('Student profile not found');
    err.statusCode = 404;
    throw err;
  }

  // Scope Check
  const isAdmin = actorUser.role === 'ADMIN' || actorUser.role === 'SUPER_ADMIN';
  const isSelf = actorUser.id === studentUserId;
  const isMentor = student.class_mentor_id === actorUser.id;

  if (!isAdmin && !isSelf && !isMentor) {
    const err = new Error('Access denied: You are not authorized to view analytics for this student');
    err.statusCode = 403;
    throw err;
  }

  // A. Events Attended (PRESENT)
  const eventsAttended = db.prepare('SELECT COUNT(*) as count FROM attendance WHERE student_user_id = ? AND status = \'PRESENT\'').get(studentUserId).count;

  // B. Total Registrations
  const registrationsCount = db.prepare('SELECT COUNT(*) as count FROM event_registrations WHERE student_user_id = ?').get(studentUserId).count;

  // C. OD Requests & Approval Rate
  const odAgg = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as approved_count,
      COUNT(CASE WHEN status = 'REJECTED' THEN 1 END) as rejected_count,
      COUNT(CASE WHEN status IN ('APPROVED', 'REJECTED') THEN 1 END) as decided_count,
      CASE
        WHEN COUNT(CASE WHEN status IN ('APPROVED', 'REJECTED') THEN 1 END) = 0 THEN 0.0
        ELSE ROUND((CAST(COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) AS FLOAT) /
              COUNT(CASE WHEN status IN ('APPROVED', 'REJECTED') THEN 1 END)) * 100.0, 1)
      END as approval_rate
    FROM od_requests
    WHERE student_user_id = ?
  `).get(studentUserId);

  // D. Certificates Earned
  const certificatesCount = db.prepare('SELECT COUNT(*) as count FROM certificates WHERE student_user_id = ? AND status = \'ISSUED\'').get(studentUserId).count;

  // E. Badges Earned
  const badgesCount = db.prepare('SELECT COUNT(*) as count FROM student_badges WHERE student_user_id = ?').get(studentUserId).count;

  return {
    student: {
      userId: student.user_id,
      fullName: student.full_name,
      raNumber: student.ra_number,
      department: student.department,
      section: student.section,
      year: student.year_of_study
    },
    eventsAttended,
    registrationsCount,
    odTotalRequests: odAgg ? odAgg.total_requests : 0,
    odApprovedCount: odAgg ? odAgg.approved_count : 0,
    odRejectedCount: odAgg ? odAgg.rejected_count : 0,
    odDecidedCount: odAgg ? odAgg.decided_count : 0,
    odApprovalRate: odAgg ? odAgg.approval_rate : 0.0,
    certificatesCount,
    badgesCount
  };
}

/**
 * 3. ADMIN & SUPER ADMIN ANALYTICS
 * Cross-club comparison, queues, overall OD rate, monthly event trend.
 */
function getAdminAnalytics(actorUser) {
  if (actorUser.role !== 'ADMIN' && actorUser.role !== 'SUPER_ADMIN') {
    const err = new Error('Access denied: Admin role required');
    err.statusCode = 403;
    throw err;
  }

  // A. Cross-Club Comparison Table & Activity Score
  const clubRows = db.prepare(`
    SELECT
      c.id, c.name, c.code,
      COUNT(DISTINCT CASE WHEN cm.status = 'APPROVED' THEN cm.user_id END) as member_count,
      COUNT(DISTINCT CASE WHEN e.status = 'COMPLETED' THEN e.id END) as completed_events,
      COUNT(DISTINCT er.id) as total_registrations,
      COALESCE(ROUND(AVG(
        CASE WHEN e.status = 'COMPLETED' THEN
          CASE
            WHEN (SELECT COUNT(*) FROM event_registrations WHERE event_id = e.id) = 0 THEN 0.0
            ELSE (CAST((SELECT COUNT(*) FROM attendance WHERE event_id = e.id AND status = 'PRESENT') AS FLOAT) /
                  (SELECT COUNT(*) FROM event_registrations WHERE event_id = e.id)) * 100.0
          END
        END
      ), 1), 0.0) as avg_attendance_rate,
      ((COUNT(DISTINCT CASE WHEN e.status = 'COMPLETED' THEN e.id END) * 10) + COUNT(DISTINCT er.id)) as activity_score
    FROM clubs c
    LEFT JOIN club_memberships cm ON c.id = cm.club_id
    LEFT JOIN events e ON c.id = e.club_id
    LEFT JOIN event_registrations er ON e.id = er.event_id
    GROUP BY c.id
    ORDER BY activity_score DESC, completed_events DESC
  `).all();

  // B. Pending Approval Queues & Oldest Waiting Times
  const pendingEventsAgg = db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending_events,
      MIN(CASE WHEN status = 'PENDING_APPROVAL' THEN created_at END) as oldest_pending_event_at,
      COUNT(CASE WHEN status = 'PENDING_APPROVAL' AND escalated_at IS NOT NULL THEN 1 END) as escalated_events,
      MIN(CASE WHEN status = 'PENDING_APPROVAL' AND escalated_at IS NOT NULL THEN escalated_at END) as oldest_escalated_event_at
    FROM events
  `).get();

  const pendingODAgg = db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'PENDING' AND escalated_at IS NOT NULL THEN 1 END) as escalated_ods,
      MIN(CASE WHEN status = 'PENDING' AND escalated_at IS NOT NULL THEN escalated_at END) as oldest_escalated_od_at
    FROM od_requests
  `).get();

  const pendingQueue = {
    pendingEventsCount: pendingEventsAgg.pending_events || 0,
    oldestPendingEventWait: getWaitingTimeFormatted(pendingEventsAgg.oldest_pending_event_at),
    escalatedEventsCount: pendingEventsAgg.escalated_events || 0,
    oldestEscalatedEventWait: getWaitingTimeFormatted(pendingEventsAgg.oldest_escalated_event_at),
    escalatedODsCount: pendingODAgg.escalated_ods || 0,
    oldestEscalatedODWait: getWaitingTimeFormatted(pendingODAgg.oldest_escalated_od_at)
  };

  // C. Overall OD Approval Rate
  const overallODAgg = db.prepare(`
    SELECT
      COUNT(*) as total_ods,
      COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as approved_ods,
      COUNT(CASE WHEN status = 'REJECTED' THEN 1 END) as rejected_ods,
      COUNT(CASE WHEN status IN ('APPROVED', 'REJECTED') THEN 1 END) as decided_ods,
      CASE
        WHEN COUNT(CASE WHEN status IN ('APPROVED', 'REJECTED') THEN 1 END) = 0 THEN 0.0
        ELSE ROUND((CAST(COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) AS FLOAT) /
              COUNT(CASE WHEN status IN ('APPROVED', 'REJECTED') THEN 1 END)) * 100.0, 1)
      END as approval_rate
    FROM od_requests
  `).get();

  // D. Events Per Month
  const eventsPerMonth = db.prepare(`
    SELECT strftime('%Y-%m', event_date) as month, COUNT(*) as count
    FROM events
    GROUP BY strftime('%Y-%m', event_date)
    ORDER BY month ASC
  `).all();

  return {
    clubsComparison: clubRows,
    pendingQueue,
    overallOD: {
      total: overallODAgg.total_ods || 0,
      approved: overallODAgg.approved_ods || 0,
      rejected: overallODAgg.rejected_ods || 0,
      decided: overallODAgg.decided_ods || 0,
      approvalRate: overallODAgg.approval_rate || 0.0
    },
    eventsPerMonth
  };
}

/**
 * 4. SUPER ADMIN ANALYTICS
 * Includes admin metrics plus platform user counts, club statuses, event statuses, and audit log.
 */
function getSuperAdminAnalytics(actorUser) {
  if (actorUser.role !== 'SUPER_ADMIN') {
    const err = new Error('Access denied: Super Admin role required');
    err.statusCode = 403;
    throw err;
  }

  const baseAdminMetrics = getAdminAnalytics(actorUser);

  // Platform Totals
  const usersByRole = db.prepare('SELECT role, COUNT(*) as count FROM users GROUP BY role').all();
  const clubsByStatus = db.prepare('SELECT status, COUNT(*) as count FROM clubs GROUP BY status').all();
  const eventsByStatus = db.prepare('SELECT status, COUNT(*) as count FROM events GROUP BY status').all();

  const auditLogs = db.prepare(`
    SELECT a.*, u.full_name as actor_name, u.role as actor_role
    FROM audit_logs a
    JOIN users u ON a.actor_id = u.id
    ORDER BY a.timestamp DESC
    LIMIT 20
  `).all();

  return {
    ...baseAdminMetrics,
    platformTotals: {
      usersByRole,
      clubsByStatus,
      eventsByStatus
    },
    recentAuditLogs: auditLogs
  };
}

/**
 * 5. FACULTY ANALYTICS (Mentor & Coordinator)
 * Pending approvals, turnaround times, and mentee summaries.
 */
function getFacultyAnalytics(facultyUserIdInput, actorUser) {
  const facultyUserId = parseInt(facultyUserIdInput, 10);
  if (isNaN(facultyUserId) || !facultyUserId) {
    const err = new Error('Invalid faculty user ID');
    err.statusCode = 404;
    throw err;
  }

  // Scope check
  const isAdmin = actorUser.role === 'ADMIN' || actorUser.role === 'SUPER_ADMIN';
  const isSelf = actorUser.id === facultyUserId;
  if (!isAdmin && !isSelf) {
    const err = new Error('Access denied: You are not authorized to view this faculty\'s analytics');
    err.statusCode = 403;
    throw err;
  }

  // Assigned clubs as Coordinator
  const assignedClubs = db.prepare(`
    SELECT c.id, c.name, c.code
    FROM club_coordinators cc
    JOIN clubs c ON cc.club_id = c.id
    WHERE cc.faculty_user_id = ?
  `).all(facultyUserId);

  const clubIds = assignedClubs.map(c => c.id);

  // A. Pending Events to approve
  let pendingEventsCount = 0;
  if (clubIds.length > 0) {
    const placeholders = clubIds.map(() => '?').join(',');
    pendingEventsCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM events
      WHERE club_id IN (${placeholders}) AND status = 'PENDING_APPROVAL'
    `).get(...clubIds).count;
  }

  // B. Pending OD requests for Mentees
  const pendingMenteesODCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM od_requests
    WHERE class_mentor_id = ? AND status = 'PENDING'
  `).get(facultyUserId).count;

  // C. Mentees Summary
  const menteesSummary = db.prepare(`
    SELECT
      COUNT(DISTINCT s.user_id) as total_mentees,
      COUNT(DISTINCT CASE WHEN a.status = 'PRESENT' THEN a.id END) as mentee_events_attended,
      COUNT(DISTINCT od.id) as mentee_total_ods,
      COUNT(DISTINCT CASE WHEN od.status = 'APPROVED' THEN od.id END) as mentee_approved_ods
    FROM students s
    LEFT JOIN attendance a ON s.user_id = a.student_user_id
    LEFT JOIN od_requests od ON s.user_id = od.student_user_id
    WHERE s.class_mentor_id = ?
  `).get(facultyUserId);

  return {
    facultyUserId,
    assignedClubs,
    pendingEventsCount,
    pendingMenteesODCount,
    menteesSummary: {
      totalMentees: menteesSummary ? menteesSummary.total_mentees : 0,
      menteeEventsAttended: menteesSummary ? menteesSummary.mentee_events_attended : 0,
      menteeTotalODs: menteesSummary ? menteesSummary.mentee_total_ods : 0,
      menteeApprovedODs: menteesSummary ? menteesSummary.mentee_approved_ods : 0
    }
  };
}

module.exports = {
  getClubAnalytics,
  getStudentAnalytics,
  getAdminAnalytics,
  getSuperAdminAnalytics,
  getFacultyAnalytics
};
