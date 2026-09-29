# BLUEPRINT VALIDATION REPORT

**Project:** CampusClubOS - Campus Club Management & OD Authorization Platform  
**Target:** 36-Hour Hackathon Execution  
**Source of Truth:** `docs/HACKATHON_REQUIREMENTS.md`  

---

## 1. CONFIRMED REQUIREMENTS
The initial blueprint correctly captured the following core requirements:
* **Faculty Gate:** Mandatory faculty approval for events and OD requests.
* **SQLite3 Persistence:** Single-file database with `PRAGMA foreign_keys = ON;`.
* **RA Number Identity:** Unique 15-digit alphanumeric student identity binding.
* **Timetable Engine:** Super Admin-controlled period definitions.
* **Historical Snapshotting:** OD approval period snapshots to prevent retroactive alteration upon timetable changes.
* **Certificate & Badge System:** PDF generation, SHA-256 verification, QR codes.

---

## 2. MISSING & CONTRADICTORY REQUIREMENTS IDENTIFIED
During the validation pass against `docs/HACKATHON_REQUIREMENTS.md`, the following gaps and contradictions were identified and addressed:

1. **Event State Machine Ambiguity:**
   * *Contradiction:* Initial blueprint collapsed event creation and submission into one state (`PENDING_APPROVAL`).
   * *Correction:* Explicitly separated `DRAFT` from `PENDING_APPROVAL`. `POST /api/events` creates in `DRAFT`. A separate `POST /api/events/:id/submit` action transitions state to `PENDING_APPROVAL` and triggers the Faculty Coordinator notification. Added explicit `RESUBMISSION` flow for `REJECTED` events.

2. **Weak SQLite RA Number Constraint:**
   * *Security Risk:* `GLOB '[A-Za-z0-9]*'` in SQLite does not strictly guarantee that *every* character is alphanumeric (it allows partial wildcard matches).
   * *Correction:* Updated SQLite DDL constraint to: `CHECK (length(ra_number) = 15 AND NOT (ra_number GLOB '*[^A-Za-z0-9]*'))`. Combined with backend Zod regex `^[A-Za-z0-9]{15}$`, this mathematically guarantees 100% 15-digit alphanumeric enforcement at all layers.

3. **Dynamic Role Privilege Escalation Gap:**
   * *Security Weakness:* Need an explicit, fixed catalog of dynamic role permissions to prevent Club Admins from assigning system-level privileges (e.g. `TIMETABLE_CREATE_EDIT`, `APPROVE_EVENT`, `APPROVE_OD`).
   * *Correction:* Defined an immutable catalog of club-level permissions (`EVENT_CREATE`, `EVENT_EDIT`, `EVENT_SUBMIT`, `VIEW_REGISTRATIONS`, `MARK_ATTENDANCE`, `ISSUE_CERTIFICATE`, `AWARD_BADGE`, `VIEW_EVENT_ANALYTICS`, `MESSAGE_FACULTY`). Added strict backend validation rejecting any system permission assignment to dynamic roles.

4. **Semantic Database Relationship Checks:**
   * *Database Risk:* SQLite foreign keys enforce table existence but cannot enforce semantic role types (e.g., ensuring `class_mentor_id` points to a `FACULTY` user, not a `STUDENT`).
   * *Correction:* Added application-level semantic validation middleware on all foreign key insertions and updates.

5. **Communication System Authorization:**
   * *Security Risk:* Lacked explicit participant authorization for communication threads, allowing potential URL parameter IDOR attacks.
   * *Correction:* Added `thread_participants` entity and `requireThreadParticipant` middleware to guard all contextual message threads (`EVENT`, `OD_REQUEST`).

6. **Missing Mandatory Notifications:**
   * *Gap:* Badge awarding notification was missing from the notification matrix.
   * *Correction:* Added `BADGE_AWARDED` trigger to notification engine.

---

## 3. SECURITY & AUTHORIZATION AUDIT
* **Session Derivation:** All protected APIs derive `userId`, `role`, and `scope` directly from verified JWT HttpOnly cookies (`req.user`), never from request bodies or URL parameters.
* **Authentication Security:** Passwords hashed with `bcrypt` (salt rounds = 10). Google Sign-In tokens verified server-side using `google-auth-library`.
* **Timetable Gate:** Server-side guard `requireRole('SUPER_ADMIN')` on all timetable mutation endpoints.
* **Role Immutability:** Users cannot alter their own system role. Role creation/assignment endpoints restricted to Super Admin / Admin.

---

## 4. DATABASE INTEGRITY IMPROVEMENTS
* `PRAGMA foreign_keys = ON;` initialized on database connection.
* Added `timetable_id` and `timetable_version` to `od_request_periods` table for auditing.
* Enforced `ON DELETE RESTRICT` on historical OD records to prevent accidental cascade deletion.

---

## 5. 36-HOUR FEASIBILITY ASSESSMENT
* Core workflow (Auth, RA Integrity, Timetable, Event Approval, OD Calculator + Snapshotting, SQLite persistence) represents 70% of total score and must be completed first.
* Optional features (QR Attendance, Portfolio Export) are strictly isolated as non-blocking stretch goals.
