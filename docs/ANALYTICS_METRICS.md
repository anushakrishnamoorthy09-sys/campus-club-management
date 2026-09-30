# CampusClubOS - Analytics Metrics Specification & SQL Reference

## 1. Overview
This document defines the mathematical formulas, SQL queries, and zero-division handling for all analytics dashboards across the platform.

---

## 2. Club Analytics Metrics (`getClubAnalytics`)

### A. Approved Member Count
* **Formula**: Total memberships with `status = 'APPROVED'` for the target club.
* **SQL**:
  ```sql
  SELECT COUNT(*) FROM club_memberships WHERE club_id = ? AND status = 'APPROVED';
  ```

### B. Events Held
* **Formula**: Total events with `status = 'COMPLETED'` for the target club.
* **SQL**:
  ```sql
  SELECT COUNT(*) FROM events WHERE club_id = ? AND status = 'COMPLETED';
  ```

### C. Total Registrations
* **Formula**: Total student registrations across all events hosted by the club.
* **SQL**:
  ```sql
  SELECT COUNT(er.id)
  FROM event_registrations er
  JOIN events e ON er.event_id = e.id
  WHERE e.club_id = ?;
  ```

### D. Average Attendance Rate (%)
* **Formula**: Average over all `COMPLETED` events of `(PRESENT Attendees / Total Registrations) * 100`.
* **Zero Division**: If a completed event has 0 registrations, its attendance rate is `0.0%`. If a club has 0 completed events, the overall average is `0.0%`.
* **SQL**:
  ```sql
  SELECT COALESCE(ROUND(AVG(
    CASE
      WHEN registered_count = 0 THEN 0.0
      ELSE (CAST(present_count AS FLOAT) / registered_count) * 100.0
    END
  ), 1), 0.0) as avg_attendance_rate
  FROM (
    SELECT e.id,
           COUNT(DISTINCT er.id) as registered_count,
           COUNT(DISTINCT CASE WHEN a.status = 'PRESENT' THEN a.id END) as present_count
    FROM events e
    LEFT JOIN event_registrations er ON e.id = er.event_id
    LEFT JOIN attendance a ON e.id = a.event_id AND a.student_user_id = er.student_user_id
    WHERE e.club_id = ? AND e.status = 'COMPLETED'
    GROUP BY e.id
  );
  ```

### E. Certificates Issued
* **Formula**: Total active (`ISSUED`) certificates generated for events in this club.
* **SQL**:
  ```sql
  SELECT COUNT(c.id)
  FROM certificates c
  JOIN events e ON c.event_id = e.id
  WHERE e.club_id = ? AND c.status = 'ISSUED';
  ```

### F. Badges Awarded
* **Formula**: Total badges awarded under the club's specific badge catalog.
* **SQL**:
  ```sql
  SELECT COUNT(sb.id)
  FROM student_badges sb
  JOIN badges b ON sb.badge_id = b.id
  WHERE b.club_id = ?;
  ```

### G. Event Status Breakdown
* **Formula**: Distribution of event statuses (`DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `ONGOING`, `COMPLETED`, `REJECTED`, `CANCELLED`).
* **SQL**:
  ```sql
  SELECT status, COUNT(*) as count
  FROM events
  WHERE club_id = ?
  GROUP BY status;
  ```

---

## 3. Student Analytics Metrics (`getStudentAnalytics`)

### A. Events Attended
* **Formula**: Total event attendance entries marked as `PRESENT`.
* **SQL**:
  ```sql
  SELECT COUNT(*) FROM attendance WHERE student_user_id = ? AND status = 'PRESENT';
  ```

### B. Registrations Count
* **Formula**: Total event registrations.
* **SQL**:
  ```sql
  SELECT COUNT(*) FROM event_registrations WHERE student_user_id = ?;
  ```

### C. OD Requests & Approval Rate
* **Formula**:
  * Total Requests: Count of all `od_requests`.
  * Approval Rate (%): `APPROVED Requests / Decided Requests (APPROVED + REJECTED) * 100`.
* **Zero Division**: If no decided OD requests exist, approval rate is `0.0%`.
* **SQL**:
  ```sql
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
  WHERE student_user_id = ?;
  ```

### D. Certificates & Badges Earned
* **SQL**:
  ```sql
  SELECT COUNT(*) FROM certificates WHERE student_user_id = ? AND status = 'ISSUED';
  SELECT COUNT(*) FROM student_badges WHERE student_user_id = ?;
  ```

---

## 4. Admin & Super Admin Analytics (`getAdminAnalytics` & `getSuperAdminAnalytics`)

### A. Cross-Club Comparison Table & Activity Score
* **Ranking Formula**: `Activity Score = (Completed Events * 10) + Total Registrations`.
* **SQL**:
  ```sql
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
  ORDER BY activity_score DESC;
  ```

### B. Pending Approval Queue & Oldest Waiting Time
* **SQL**:
  ```sql
  SELECT
    COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) as pending_events,
    MIN(CASE WHEN status = 'PENDING_APPROVAL' THEN created_at END) as oldest_pending_event_at,
    COUNT(CASE WHEN status = 'PENDING_APPROVAL' AND escalated_at IS NOT NULL THEN 1 END) as escalated_events,
    MIN(CASE WHEN status = 'PENDING_APPROVAL' AND escalated_at IS NOT NULL THEN escalated_at END) as oldest_escalated_event_at
  FROM events;

  SELECT
    COUNT(CASE WHEN status = 'PENDING' AND escalated_at IS NOT NULL THEN 1 END) as escalated_ods,
    MIN(CASE WHEN status = 'PENDING' AND escalated_at IS NOT NULL THEN escalated_at END) as oldest_escalated_od_at
  FROM od_requests;
  ```

### C. Overall Platform OD Approval Rate
* **SQL**:
  ```sql
  SELECT
    COUNT(*) as total_ods,
    COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) as approved_ods,
    COUNT(CASE WHEN status IN ('APPROVED', 'REJECTED') THEN 1 END) as decided_ods,
    CASE
      WHEN COUNT(CASE WHEN status IN ('APPROVED', 'REJECTED') THEN 1 END) = 0 THEN 0.0
      ELSE ROUND((CAST(COUNT(CASE WHEN status = 'APPROVED' THEN 1 END) AS FLOAT) /
            COUNT(CASE WHEN status IN ('APPROVED', 'REJECTED') THEN 1 END)) * 100.0, 1)
    END as overall_od_approval_rate
  FROM od_requests;
  ```

### D. Events Per Month
* **SQL**:
  ```sql
  SELECT strftime('%Y-%m', event_date) as month, COUNT(*) as count
  FROM events
  GROUP BY strftime('%Y-%m', event_date)
  ORDER BY month ASC;
  ```

---

## 5. Faculty & Mentor Analytics (`getFacultyAnalytics`)

### A. Pending Counts
* **Events Pending Approval** in assigned clubs.
* **OD Requests Pending Approval** for assigned student mentees.

### B. Approval Turnaround Time
* Average turnaround time in hours between OD request creation and mentor decision.

### C. Mentees Participation Summary
* Mentees count, total events attended, total ODs requested/approved.
