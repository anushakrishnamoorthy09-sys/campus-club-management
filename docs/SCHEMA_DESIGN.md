# CampusClubOS - Database Schema Design & Integrity Architecture

This document summarizes the database design, constraints, triggers, and partial unique indexes implemented in `db/schema.sql` for **CampusClubOS**.

---

## 🔒 Mandatory Structural Rules & Constraints

1. **Foreign Key Enforcement**:
   - Every database connection runs `PRAGMA foreign_keys = ON;`.
   - Relationships between entities use strict `ON DELETE RESTRICT`, `CASCADE`, or `SET NULL` behaviors.

2. **Student Identity & RA Number Integrity**:
   - `students.ra_number` is defined with `UNIQUE` and `CHECK (ra_number GLOB '[A-Z0-9][A-Z0-9]...'` exactly 15 uppercase alphanumeric characters).
   - Application-level normalization enforces `trim().toUpperCase()`.

3. **Role-Based Entity Constraints**:
   - Single club per Club Admin (`clubs.club_admin_id UNIQUE`).
   - Super Admin only timetable writes with DB-level active day checks.

4. **Time & Schedule Formatting Constraints**:
   - `start_time` and `end_time` check constraints enforce `GLOB '[0-2][0-9]:[0-5][0-9]'` and `end_time > start_time`.

---

## ⚡ SQLite Triggers & Business Logic Guards

```sql
-- 1. Prevent Student Event Registration unless status is 'APPROVED'
CREATE TRIGGER trg_prevent_unapproved_event_registration
BEFORE INSERT ON event_registrations
FOR EACH ROW
WHEN (SELECT status FROM events WHERE id = NEW.event_id) != 'APPROVED'
BEGIN
    SELECT RAISE(FAIL, 'Event registration blocked: Event status must be APPROVED.');
END;

-- 2. Prevent Direct Transition from REJECTED to APPROVED without Resubmission
CREATE TRIGGER trg_prevent_rejected_to_approved
BEFORE UPDATE OF status ON events
FOR EACH ROW
WHEN OLD.status = 'REJECTED' AND NEW.status = 'APPROVED'
BEGIN
    SELECT RAISE(FAIL, 'Illegal event status transition: REJECTED events must be resubmitted to DRAFT first.');
END;

-- 3. Prevent Modification of Decided OD Requests
CREATE TRIGGER trg_prevent_decided_od_update
BEFORE UPDATE ON od_requests
FOR EACH ROW
WHEN OLD.status IN ('APPROVED', 'REJECTED', 'CLOSED')
BEGIN
    SELECT RAISE(FAIL, 'Immutable OD Request: Decided On-Duty applications cannot be modified.');
END;

-- 4. Prevent Modification of Historical OD Period Snapshots
CREATE TRIGGER trg_prevent_od_period_snapshot_update
BEFORE UPDATE ON od_request_periods
FOR EACH ROW
BEGIN
    SELECT RAISE(FAIL, 'Immutable Historical Snapshot: OD request period snapshots cannot be modified.');
END;
```

---

## 🏎️ Database Indexes & Partial Indexes

1. `idx_single_active_timetable_day`:
   ```sql
   CREATE UNIQUE INDEX idx_single_active_timetable_day 
   ON timetable_working_days(day_of_week) 
   WHERE is_active = 1;
   ```
   *Guarantees that at most one active timetable structure exists per day of the week across the entire database.*

2. `idx_events_club_status`:
   ```sql
   CREATE INDEX idx_events_club_status ON events(club_id, status);
   ```
   *Accelerates club event filtering and status state machine queries.*

3. `idx_event_registrations_user`:
   ```sql
   CREATE INDEX idx_event_registrations_user ON event_registrations(student_user_id);
   ```
   *Optimizes student my-registrations roster lookups and OD eligibility checks.*
