# CAMPUSCLUBOS - TECHNICAL ARCHITECTURE & SYSTEM BLUEPRINT (CORRECTED)
**Project Title:** Campus Club Management & OD Authorization Platform  
**Target:** 36-Hour MegaThon Hackathon  
**Architectural Baseline:** Strictly aligned with official `HACKATHON_REQUIREMENTS.md`  

---

## 1. PROBLEM UNDERSTANDING

### 1.1 The Core Problem
College campuses operate dozens of autonomous student clubs (technical, cultural, sports, literary) using fragmented, non-verifiable channels (WhatsApp, spreadsheets, paper On-Duty forms). This creates critical institutional breakdown:
* **Attendance Fraud & Unverified ODs:** Faculty sign OD (On-Duty) requests without proof of event attendance or timing accuracy.
* **Lack of Approval Control:** Events are announced and registered before institutional or faculty authorization.
* **Identity Fragmentation:** Students use disparate emails, nicknames, or registration names with no central institutional identity lock.
* **Administrative Blind Spots:** Admins have zero real-time visibility into campus activity, capacity limits, or historical OD records.
* **Role Enforcement Gaps:** Privilege checks are often cosmetic (UI hiding) rather than backend-enforced API security.

`CampusClubOS` solves this by creating a unified, institutional single-source-of-truth platform where **faculty approval is a mandatory, non-negotiable gateway** for events and ODs, and **student identity is permanently bound to a unique 15-digit alphanumeric RA Number**.

### 1.2 Major System Actors
1. **Super Admin:** System-wide owner. Manages core institution setup, creates Admins/Faculty/Club Admins, owns the college-wide Timetable Structure, overrides approvals, views global analytics.
2. **Admin:** College administrator. Manages clubs, creates Club Admins, assigns Faculty Coordinators, monitors campus-wide participation.
3. **Faculty (Dual Hats):**
   * **Class Mentor:** Evaluates and approves/rejects OD applications raised by assigned student mentees based on auto-calculated period overlaps.
   * **Club Faculty Coordinator:** Evaluates and approves/rejects event proposals submitted by the Club Admin of their assigned club.
4. **Club Admin:** Leader of a specific club. Defines dynamic club roles from a fixed permission catalog, creates events, submits events for faculty approval, tracks attendance, issues certificates, awards badges.
5. **Dynamic Club Roles (e.g., Logistics Lead, Event Manager, Treasurer):** Custom roles created inside a club with fine-grained club-level permissions granted by the Club Admin.
6. **Student:** Enrolls using email/Google Sign-In, bound to a unique 15-digit RA Number. Joins clubs, registers for *approved* events, applies for OD, earns verifiable certificates/badges.

### 1.3 Mandatory Modules vs. Recommended/Bonus vs. Out-of-Scope

| Category | Modules / Features Included |
| :--- | :--- |
| **Mandatory Baseline (Section 4)** | 1. Club Management & Assignment<br>2. System & Dynamic Role/Permission System<br>3. Event Lifecycle with Mandatory Faculty Gate (Draft $\rightarrow$ Pending $\rightarrow$ Approved/Rejected $\rightarrow$ Resubmit)<br>4. OD Workflow + Automatic Period Calculator<br>5. In-App Notification System (7 Triggers)<br>6. Contextual Authorized Faculty/Admin Communication<br>7. Tracking & Analytics Dashboards (Per Club, Student, Admin)<br>8. Verifiable Certificate (PDF+QR) & Badge Management<br>9. Auth with Google Sign-In & 15-Digit Alphanumeric RA Integrity<br>10. Timetable Structure Engine (Super Admin controlled) |
| **Recommended / Bonus (Section 4A)** | • Fast Dynamic QR-Based Event Check-In System<br>• Event Ratings & Feedback Engine<br>• Automated Public Certificate Verification Portal (`/verify-certificate/:uuid`)<br>• Smart Timetable Overlap Warning during Event Creation<br>• Student Portfolio / Activity Transcript Export |
| **Explicitly Out-of-Scope (Section 6)** | • Payment processing / ticketing fees<br>• Native iOS/Android mobile apps (Responsive Web only)<br>• Multi-tenant / Multi-college support<br>• Subject-wise or faculty-wise class timetables<br>• Offline synchronization<br>• SMS notification gateways |

---

## 2. SYSTEM ARCHITECTURE

### 2.1 High-Level Architecture Overview
`CampusClubOS` adopts a clean monolithic client-server architecture engineered for rapid development, low execution overhead, high maintainability, and zero-configuration SQLite persistence.

```
+-----------------------------------------------------------------------+
|                            CLIENT LAYER                               |
|   React (Vite) Single Page Application + Responsive Styling             |
|   - Dynamic Role-Based Views  - Real-time Notifications Poller       |
|   - QR Scanner / Verification - Student Portfolio Viewer             |
+-----------------------------------------------------------------------+
                                   |  HTTP / REST JSON
                                   v
+-----------------------------------------------------------------------+
|                            SERVER LAYER                               |
|   Node.js + Express.js Web Framework                                  |
|   - Auth Middleware (JWT HttpOnly Cookies + Google OAuth2 Token Check)|
|   - RBAC & Scope Enforcement Engine (Session-derived identity)        |
|   - Timetable Period Calculation Engine                               |
|   - Certificate PDF Generator (PDFKit) + QR Generator                 |
|   - Audit Logging Engine                                              |
+-----------------------------------------------------------------------+
                                   |  Synchronous SQL Queries
                                   v
+-----------------------------------------------------------------------+
|                           DATABASE LAYER                              |
|   SQLite3 Database Engine (via `better-sqlite3`)                      |
|   - PRAGMA foreign_keys = ON;                                         |
|   - Strict Schema Constraints (CHECK, UNIQUE, NOT NULL)              |
|   - Single-file persistent storage (`campus_club_os.db`)              |
+-----------------------------------------------------------------------+
```

### 2.2 Component Selection & Technical Rationale

1. **Backend Framework: Node.js + Express.js**
   * *Rationale:* Lightweight, fast startup time, asynchronous I/O, native JSON handling. Perfect for 1–2 developers working under tight 36-hour timelines.
2. **Database Engine: SQLite3 via `better-sqlite3`**
   * *Rationale:* **Mandatory requirement**. `better-sqlite3` provides a synchronous, blazing-fast C++ binding for SQLite in Node.js, eliminating async database complexity while strictly supporting `PRAGMA foreign_keys = ON;`, custom `CHECK` constraints, transactions, and reliable disk persistence.
3. **Frontend Framework: React (Vite) + Vanilla CSS System**
   * *Rationale:* Lightning-fast HMR build setup, modular component architecture, smooth dynamic UI rendering for role-based navigation and real-time state feedback.
4. **Authentication & Identity: JWT in HttpOnly Cookies + `bcrypt` + `google-auth-library`**
   * *Rationale:* Secure, stateless, immune to XSS token theft, seamless handling of both email/password logins (hashed with bcrypt) and Google OAuth2 student authentications.
5. **Validation Engine: Zod Schema Validator**
   * *Rationale:* Shared runtime type safety and strict input validation (`^[A-Za-z0-9]{15}$` for RA Numbers, date formats, non-overlapping periods, non-negative capacity).
6. **Certificate & QR Engine: `pdfkit` + `qrcode`**
   * *Rationale:* Generates vector-graphic PDFs with embedded QR codes server-side in milliseconds.

---

## 3. USER ROLES & SCOPE BOUNDARIES

### 3.1 Role Capabilities & Boundaries Matrix

| Role Name | System Capabilities | Mandatory Restrictions (CANNOT Do) | Scope Level |
| :--- | :--- | :--- | :--- |
| **Super Admin** | • System-wide control<br>• Create Admin, Club Admin, Faculty<br>• Create/Edit/Activate/Delete Timetable Structure<br>• Create Clubs & Assign Faculty Coordinators<br>• Override approvals & audit RA modifications<br>• View global analytics & full audit logs | • Cannot bypass database foreign keys or constraints<br>• Cannot modify historical OD period snapshots directly | System-Wide |
| **Admin** | • Create Club Admins<br>• Assign Faculty Coordinators within scope<br>• Monitor all events & participation<br>• Approve escalated club requests | • **CANNOT** create/edit/activate Timetable Structure<br>• **CANNOT** create Super Admins<br>• **CANNOT** override Class Mentor OD decisions directly | System-Wide (Narrower than Super) |
| **Club Admin** | • Full control over assigned club<br>• Create dynamic club sub-roles (from fixed permission catalog) & assign members<br>• Create events (DRAFT) and submit for approval<br>• Resubmit REJECTED events<br>• Mark attendance, issue certificates & badges<br>• Message Faculty Coordinator | • **CANNOT** publish events without Faculty Approval<br>• **CANNOT** perform actions outside assigned club<br>• **CANNOT** modify timetable or approve OD requests<br>• **CANNOT** assign system-level permissions to dynamic roles | Club-Specific |
| **Dynamic Club Roles** (e.g. Treasurer, Event Lead) | • Execute assigned permissions (from fixed catalog: `EVENT_CREATE`, `EVENT_EDIT`, `EVENT_SUBMIT`, `VIEW_REGISTRATIONS`, `MARK_ATTENDANCE`, `ISSUE_CERTIFICATE`, `AWARD_BADGE`, `VIEW_EVENT_ANALYTICS`, `MESSAGE_FACULTY`) | • **CANNOT** receive system permissions (`TIMETABLE_CREATE_EDIT`, `APPROVE_EVENT`, `APPROVE_OD`, `CHANGE_SYSTEM_ROLE`) | Club-Specific |
| **Faculty (Dual Hats)** | **1. Class Mentor:** Approve/Reject mentee OD requests.<br>**2. Club Coordinator:** Approve/Reject club event proposals.<br>• View student participation details.<br>• Send contextual messages in assigned threads. | • **CANNOT** approve OD requests for non-mentees<br>• **CANNOT** approve events for unassigned clubs<br>• **CANNOT** edit timetable structures | Academic Department / Club Scope |
| **Student** | • Email/Google Sign-In<br>• Set/Validate 15-digit RA Number<br>• Browse clubs & join<br>• Register for **Approved** events only<br>• Apply for OD on registered events<br>• View OD status & period breakdown<br>• View & download certificates/badges | • **CANNOT** view or register for `DRAFT`, `PENDING_APPROVAL`, or `REJECTED` events<br>• **CANNOT** apply for OD without active registration<br>• **CANNOT** alter RA Number after initial lock<br>• **CANNOT** access any administrative endpoints | Self / Individual Scope |

### 3.2 Key Role Distinction: Class Mentor vs. Club Faculty Coordinator
* **Class Mentor (Faculty):** Responsible for academic oversight of a specific cohort of students (mentees). Reviews and approves **OD Requests** submitted by their mentees, evaluating the academic impact (periods missed).
* **Club Faculty Coordinator (Faculty):** Assigned to supervise a specific **Club**. Reviews and approves **Event Proposals** submitted by the Club Admin, ensuring institutional safety, venue availability, and budget alignment.

---

## 4. ROLE AND PERMISSION MATRIX

### 4.1 System Permission Definition Matrix

| Role | Action / Permission | Target Scope | Allowed / Denied | Backend Enforcement Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| **Super Admin** | `TIMETABLE_CREATE_EDIT` | System | **ALLOWED** | `requireRole('SUPER_ADMIN')` |
| **Admin / Club Admin / Faculty / Student** | `TIMETABLE_CREATE_EDIT` | System | **DENIED** | `requireRole('SUPER_ADMIN')` returns HTTP 403 |
| **Club Admin** | `EVENT_CREATE` | Own Club | **ALLOWED** | `requireClubPermission(clubId, 'EVENT_CREATE')` |
| **Club Admin** | `EVENT_PUBLISH` | Own Club | **DENIED** | Direct publication blocked; must submit to `PENDING_APPROVAL` |
| **Faculty Coordinator**| `EVENT_APPROVE_REJECT` | Assigned Club | **ALLOWED** | `requireFacultyClubCoordinator(clubId)` |
| **Student** | `EVENT_REGISTER` | Approved Event | **ALLOWED** | Check `event.status === 'APPROVED'` and `registered < capacity` |
| **Student** | `EVENT_REGISTER` | Draft / Pending / Rejected Event | **DENIED** | HTTP 400/403 "Event not open for registration" |
| **Student** | `OD_APPLY` | Registered Event | **ALLOWED** | Check `SELECT 1 FROM event_registrations WHERE student_id = ? AND event_id = ?` |
| **Student** | `OD_APPLY` | Unregistered Event | **DENIED** | HTTP 400 "Must register for event before applying for OD" |
| **Class Mentor** | `OD_APPROVE_REJECT` | Assigned Mentee | **ALLOWED** | Check `student.class_mentor_id === current_user.id` |
| **Dynamic Club Role** | System Level Permission | System | **DENIED** | Backend rejects assignment of system-level permissions |

### 4.2 Dynamic Club Role Security & Catalog Enforcement
To prevent privilege escalation, dynamic roles inside a club can **only** receive permissions from a fixed catalog:
* **Permitted Dynamic Permissions Catalog:** `EVENT_CREATE`, `EVENT_EDIT`, `EVENT_SUBMIT`, `VIEW_REGISTRATIONS`, `MARK_ATTENDANCE`, `ISSUE_CERTIFICATE`, `AWARD_BADGE`, `VIEW_EVENT_ANALYTICS`, `MESSAGE_FACULTY`.
* **Forbidden Permissions for Dynamic Roles:** `TIMETABLE_CREATE_EDIT`, `CREATE_SUPER_ADMIN`, `CREATE_ADMIN`, `APPROVE_EVENT`, `APPROVE_OD`, `CHANGE_SYSTEM_ROLE`, `CREATE_FACULTY`, `CREATE_CLUB`.

When a Club Admin creates or updates a dynamic role, backend middleware verifies every requested permission against the catalog:
```javascript
const FORBIDDEN_DYNAMIC_PERMISSIONS = [
  'TIMETABLE_CREATE_EDIT', 'CREATE_SUPER_ADMIN', 'CREATE_ADMIN', 
  'APPROVE_EVENT', 'APPROVE_OD', 'CHANGE_SYSTEM_ROLE', 'CREATE_FACULTY', 'CREATE_CLUB'
];
if (requestedPermissions.some(p => FORBIDDEN_DYNAMIC_PERMISSIONS.includes(p))) {
  return res.status(403).json({ error: "Dynamic roles cannot be granted system or approval permissions." });
}
```

---

## 5. CORE WORKFLOWS

### A. Authentication & Student Onboarding Workflow
* **Actor:** Student / All Users
* **Starting Condition:** Unauthenticated user accesses login page.
* **Steps:**
  1. User selects Email/Password login or Google Sign-In button.
  2. For Email/Password, hash/verify using `bcrypt` (salt rounds = 10).
  3. For Google Sign-In, backend verifies Google IdToken using `google-auth-library`.
  4. If user exists, issue HttpOnly JWT cookie containing `userId`, `role`, and `raNumber`.
  5. If new Student, prompt for mandatory 15-digit alphanumeric RA Number.
  6. Validate RA Number format (`^[A-Za-z0-9]{15}$`) and check DB uniqueness.
  7. Create user & student record in SQLite database.
* **Database Records Affected:** `users`, `students`, `audit_logs`.
* **Permission Checks:** None (Public Endpoint).
* **Success Condition:** Valid JWT issued in HttpOnly cookie, user redirected to dashboard.
* **Failure/Edge Cases:** Duplicate RA Number, invalid Google token, ill-formatted RA Number $\rightarrow$ HTTP 400/409 error.

### B. Club Creation and Management
* **Actor:** Super Admin / Admin
* **Starting Condition:** Admin logged in, navigates to Club Management dashboard.
* **Steps:**
  1. Admin submits club title, code, description, category, logo URL.
  2. Admin selects assigned Club Admin (User ID) and Faculty Coordinator (User ID).
  3. Backend verifies `faculty_user_id` has `role = 'FACULTY'`.
  4. Backend starts SQL transaction: inserts `clubs`, assigns `club_coordinators`, creates default `club_memberships` for Club Admin.
* **Database Records Affected:** `clubs`, `club_coordinators`, `club_memberships`, `audit_logs`.
* **Permission Checks:** `requireRole(['SUPER_ADMIN', 'ADMIN'])`.
* **Success Condition:** Club created, Club Admin and Coordinator notified.

### C. Dynamic Role Creation & Assignment
* **Actor:** Club Admin
* **Starting Condition:** Club Admin in club management tab.
* **Steps:**
  1. Club Admin defines dynamic role name (e.g., "Event Coordinator") and selects permissions from permitted catalog.
  2. Backend validates permissions against dynamic catalog.
  3. Inserts record into `club_roles` and corresponding rows in `club_role_permissions`.
  4. Club Admin assigns role to a club member.
  5. System updates member's `club_role_id` in `club_memberships`.
* **Database Records Affected:** `club_roles`, `club_role_permissions`, `club_memberships`, `notifications`.
* **Permission Checks:** `requireClubAdmin(clubId)`.
* **Success Condition:** Dynamic role active, member notified via `NEW_ROLE_ASSIGNED` trigger.

### D. Event Creation, Submission & Resubmission Lifecycle
* **Actor:** Club Admin / Permitted Dynamic Role
* **Starting Condition:** Event form filled (Title, Description, Venue, Date, Start Time, End Time, Capacity).
* **Steps:**
  1. **Creation:** Client sends `POST /api/events`. Backend creates event with `status = 'DRAFT'`. (Invisible to students and faculty).
  2. **Submission:** Club Admin clicks "Submit for Approval". Client sends `POST /api/events/:id/submit`. Backend transitions state `DRAFT` $\rightarrow$ `PENDING_APPROVAL`.
  3. Backend dispatches notification (`EVENT_SUBMITTED`) to assigned Faculty Coordinator.
  4. **Resubmission (if rejected):** Club Admin edits details of a `REJECTED` event and calls `POST /api/events/:id/submit`. State transitions `REJECTED` $\rightarrow$ `PENDING_APPROVAL`.
* **Database Records Affected:** `events`, `notifications`, `audit_logs`.
* **Permission Checks:** `requireClubPermission(clubId, 'EVENT_CREATE' / 'EVENT_SUBMIT')`.
* **Success Condition:** Event submitted to faculty review queue; students cannot view event.

### E. Faculty Event Approval / Rejection
* **Actor:** Club Faculty Coordinator
* **Starting Condition:** Faculty views Pending Event Requests queue.
* **Steps:**
  1. Faculty reviews event details, date/time, venue, affected periods.
  2. Faculty clicks "Approve" or "Reject" (with mandatory rejection remark if rejected).
  3. Backend updates `events` table status to `'APPROVED'` or `'REJECTED'`.
  4. System triggers notification (`EVENT_REVIEWED`) to Club Admin.
* **Database Records Affected:** `events`, `notifications`, `audit_logs`.
* **Permission Checks:** Backend verifies user has `role = 'FACULTY'` AND is assigned to `club_coordinators` for that club.
* **Success Condition:** If Approved, state becomes `APPROVED` and instantly visible on Student feed. If Rejected, remark stored, event remains hidden from students.

### F. Student Event Registration
* **Actor:** Student
* **Starting Condition:** Student views list of Approved events.
* **Steps:**
  1. Student clicks "Register" on an approved event card.
  2. Backend starts SQL transaction:
     a. Asserts event `status === 'APPROVED'`.
     b. Asserts current timestamp < event start time.
     c. Counts current registrations: `SELECT COUNT(*) FROM event_registrations WHERE event_id = ?`.
     d. Verifies `count < event.capacity`.
     e. Checks no duplicate registration exists for `(student_id, event_id)`.
     f. Inserts row into `event_registrations`.
  3. Sends registration confirmation notification (`EVENT_REGISTERED`) to student.
* **Database Records Affected:** `event_registrations`, `notifications`.
* **Permission Checks:** `requireRole('STUDENT')`.
* **Success Condition:** Registration record created, seat capacity incremented.
* **Failure/Edge Cases:** Event capacity reached, event unapproved (`DRAFT`/`PENDING`/`REJECTED`), duplicate attempt $\rightarrow$ HTTP 400/409 error response.

### G. Timetable Structure Engine Setup
* **Actor:** Super Admin ONLY
* **Starting Condition:** Super Admin opens Timetable Management Console.
* **Steps:**
  1. Super Admin inputs structure name, scope, effective date, working days array.
  2. Super Admin defines ordered list of periods (Label, Start Time, End Time, Type: CLASS / SHORT_BREAK / LUNCH_BREAK).
  3. Backend performs strict chronological validation:
     * `start_time < end_time` for all periods.
     * No period overlap: `Period[i].start_time >= Period[i-1].end_time`.
     * Duration > 0.
     * Raises non-blocking warning for period gaps.
  4. Saves structure into `timetables` and `timetable_periods`.
  5. Marks structure as `is_active = 1` for the specified scope.
* **Database Records Affected:** `timetables`, `timetable_periods`, `audit_logs`.
* **Permission Checks:** `requireRole('SUPER_ADMIN')` (Server-side enforced).
* **Success Condition:** Timetable structure activated system-wide.

### H. OD Request Submission
* **Actor:** Student
* **Starting Condition:** Student registered for an approved event.
* **Steps:**
  1. Student navigates to "My Event Registrations" and clicks "Apply for OD".
  2. Backend verifies active registration exists for the event (`SELECT 1 FROM event_registrations WHERE student_user_id = ? AND event_id = ?`).
  3. System triggers Automatic OD Period Calculator Engine (Workflow I).
  4. Backend creates `od_requests` record with `status = 'PENDING'`.
  5. Routes notification (`OD_REQUEST_RAISED`) to the student's assigned Class Mentor.
* **Database Records Affected:** `od_requests`, `notifications`.
* **Permission Checks:** `requireRole('STUDENT')` + registration existence check.
* **Success Condition:** OD request created with auto-calculated CLASS period list.

### I. Automatic OD Period Calculation Engine
* **Actor:** System Execution Layer
* **Starting Condition:** Triggered by OD Request Submission or Preview.
* **Steps:**
  1. Fetch event `event_date`, `start_time`, `end_time`.
  2. Determine day of week for event date (e.g., "MONDAY").
  3. Fetch active `timetables` structure applicable for that day.
  4. Query `timetable_periods` where `type = 'CLASS'`. (Excludes SHORT_BREAK and LUNCH_BREAK).
  5. Filter periods that overlap with event timing:
     `(event_start_time < period.end_time) AND (event_end_time > period.start_time)`
  6. Return ordered list of affected period labels, timing strings, timetable ID, and version.

### J. Faculty OD Approval / Rejection Workflow
* **Actor:** Class Mentor (Faculty)
* **Starting Condition:** Class Mentor opens Pending OD Approvals dashboard.
* **Steps:**
  1. Faculty views student RA Number, name, event title, venue, date, and affected CLASS periods.
  2. Faculty clicks "Approve" or "Reject" (with remark).
  3. Backend verifies user has `role = 'FACULTY'` AND `student.class_mentor_id === current_user.id`.
  4. Backend starts SQL transaction:
     a. Updates `od_requests.status` to `'APPROVED'` or `'REJECTED'`.
     b. **Historical Period Snapshotting:** Writes calculated affected period labels, clock times, `timetable_id`, and `timetable_name` into `od_request_periods` table.
  5. Dispatches notification (`OD_REVIEWED`) to student.
* **Database Records Affected:** `od_requests`, `od_request_periods`, `notifications`, `audit_logs`.
* **Permission Checks:** `requireClassMentor(student_user_id)`.
* **Success Condition:** OD status updated; permanent immutable historical snapshot recorded.

### K. Attendance Marking System
* **Actor:** Club Admin / Permitted Dynamic Role (`MARK_ATTENDANCE`)
* **Starting Condition:** Event status is `ONGOING` or `COMPLETED`.
* **Steps:**
  1. Club Admin checks off registered students from attendance checklist.
  2. Backend verifies `student_user_id` has valid registration for event.
  3. Inserts row into `attendance` table with `status = 'PRESENT'` or `'ABSENT'`.
* **Database Records Affected:** `attendance`.
* **Permission Checks:** `requireClubPermission(clubId, 'MARK_ATTENDANCE')`.
* **Success Condition:** Attendance record created, unlocking certificate eligibility for present students.

### L. Certificate Generation & Verification
* **Actor:** Club Admin / Permitted Dynamic Role (`ISSUE_CERTIFICATE`) / Student
* **Starting Condition:** Event state `COMPLETED` and student attendance verified (`PRESENT`).
* **Steps:**
  1. Club Admin clicks "Issue Certificates" (Single or Bulk).
  2. Backend verifies `events.status === 'COMPLETED'` AND `attendance.status === 'PRESENT'`.
  3. Backend generates unique UUID Certificate ID and SHA-256 verification hash.
  4. Inserts row into `certificates` table.
  5. Student visits profile, clicks "Download PDF".
  6. Backend `pdfkit` engine auto-pulls Student Name, RA Number, Event Name, Club Name, Date, Role, and generates PDF with embedded QR code pointing to public verification URL `/verify-certificate/:uuid`.
* **Database Records Affected:** `certificates`, `notifications`.
* **Permission Checks:** Attendance check + `requireClubPermission(clubId, 'ISSUE_CERTIFICATE')`.
* **Success Condition:** PDF generated; public verification URL returns authentic certificate metadata.

### M. Badge Awarding System
* **Actor:** Club Admin / Permitted Dynamic Role (`AWARD_BADGE`)
* **Starting Condition:** Student meets badge criteria.
* **Steps:**
  1. Club Admin awards custom club badge to student.
  2. Backend inserts record into `student_badges`.
  3. Sends notification (`BADGE_AWARDED`) to student.
* **Database Records Affected:** `student_badges`, `notifications`.
* **Permission Checks:** `requireClubPermission(clubId, 'AWARD_BADGE')`.
* **Success Condition:** Badge displayed on student profile across all clubs.

### N. Notification Dispatch Engine
* **Actor:** System Event Bus
* **Triggers:**
  1. `EVENT_SUBMITTED` $\rightarrow$ Faculty Coordinator
  2. `EVENT_REVIEWED` (Approved/Rejected) $\rightarrow$ Club Admin
  3. `EVENT_REGISTERED` $\rightarrow$ Student
  4. `OD_REQUEST_RAISED` $\rightarrow$ Class Mentor
  5. `OD_REVIEWED` (Approved/Rejected) $\rightarrow$ Student
  6. `NEW_ROLE_ASSIGNED` $\rightarrow$ Assigned User
  7. `BADGE_AWARDED` $\rightarrow$ Student
* **Database Records Affected:** `notifications`.

### O. Contextual Authorized Faculty-Admin Communication
* **Actor:** Authorized Thread Participants (Faculty Coordinators, Class Mentors, Club Admins, Admins)
* **Starting Condition:** User opens discussion tab attached to specific Event or OD Request.
* **Steps:**
  1. Backend verifies user is an authorized thread participant (`requireThreadParticipant`).
  2. User posts message. Backend inserts into `messages`.
  3. Notifies thread participants.
* **Database Records Affected:** `communication_threads`, `thread_participants`, `messages`, `notifications`.

### P. Analytics Engine
* **Actor:** Super Admin / Admin / Club Admin / Student
* **Starting Condition:** Dashboard page loaded.
* **Metrics:**
  * **Per Club:** Member count, total events held, average attendance rate.
  * **Per Student:** Total events attended, OD approval success rate.
  * **Admin Dashboard:** Cross-club comparison, pending-approval queue count, most active clubs.
  * **Super Admin Dashboard:** Global campus metrics.

---

## 6. EVENT STATE MACHINE

```
    +-----------------------------------------------------------------------+
    |                                DRAFT                                  |
    +-----------------------------------------------------------------------+
                                       |
                                       | (Club Admin clicks "Submit for Approval")
                                       v
    +-----------------------------------------------------------------------+
    |                       PENDING FACULTY APPROVAL                        |
    +-----------------------------------------------------------------------+
                               /               \
       (Faculty rejects with  /                 \ (Faculty approves)
            mandatory remark)/                   \
                            v                     v
    +-----------------------+             +---------------------------------+
    |       REJECTED        |             |       APPROVED / PUBLISHED      |
    +-----------------------+             +---------------------------------+
                |                                  |
                | (Club Admin edits                | (Event Date & Time arrives)
                |  & resubmits)                    v
                +--------------------->   +---------------------------------+
                                          |             ONGOING             |
                                          +---------------------------------+
                                                   |               |
                       (Event completes successfully)|               | (Emergency cancel)
                                                   v               v
                                          +----------------+ +--------------+
                                          |   COMPLETED    | |  CANCELLED   |
                                          +----------------+ +--------------+
```

### State Transition Validation Rules

| Source State | Target State | Permitted Actor | Validation Conditions / Constraints |
| :--- | :--- | :--- | :--- |
| Initial Creation | `DRAFT` | Club Admin | Saved as draft; invisible to faculty and students. |
| `DRAFT` | `PENDING_APPROVAL` | Club Admin | All mandatory fields populated; date in future; triggers faculty alert. |
| `PENDING_APPROVAL` | `APPROVED` | Faculty Coordinator | Faculty assigned to club; venue non-conflicting; publishes event. |
| `PENDING_APPROVAL` | `REJECTED` | Faculty Coordinator | Mandatory rejection remark provided. |
| `REJECTED` | `PENDING_APPROVAL` | Club Admin | Event details edited; resubmitted for faculty re-evaluation. |
| `APPROVED` | `ONGOING` | System / Club Admin | Event start time reached. |
| `APPROVED` | `CANCELLED` | Faculty / Club Admin | Cancellation reason recorded; notify registered students. |
| `ONGOING` | `COMPLETED` | Club Admin | Event end time passed; attendance locked for certificate issuance. |

### Critical Enforcement Rules:
1. **Student Isolation:** `DRAFT`, `PENDING_APPROVAL`, and `REJECTED` events MUST NOT be returned in student query APIs (`WHERE status = 'APPROVED'`).
2. **Rejection Resubmission Gate:** Rejected events CANNOT jump directly to `APPROVED`. They must be resubmitted to `PENDING_APPROVAL` and re-evaluated by Faculty.
3. **Registration Boundary:** Registrations are strictly forbidden unless `status === 'APPROVED'`.

---

## 7. OD WORKFLOW & HISTORICAL SNAPSHOTTING

### 7.1 End-to-End OD Execution Sequence
```
[Student] Registers for Approved Event 
    │
    ▼
[Student] Clicks "Apply for OD"
    │
    ▼
[Backend] Verifies Event Registration exists & Event Status = 'APPROVED'
    │
    ▼
[Timetable Engine] Reads Event Date/Time ──> Matches Active Timetable Structure ──> Auto-calculates Affected CLASS Periods
    │
    ▼
[Backend] Creates `od_requests` (Status: PENDING) ──> Notifies assigned Class Mentor
    │
    ▼
[Class Mentor] Reviews Event Details + Affected Periods
    │
    ├──► [REJECTS] ──► Status: REJECTED (Remark saved, Student notified)
    │
    └──► [APPROVES] ──► Status: APPROVED
                            │
                            ▼
           [Historical Snapshot Engine] Writes exact period timings, 
           timetable_id, and timetable_name into `od_request_periods`.
```

### 7.2 Historical Snapshotting & Deletion Safety
To guarantee historical integrity when timetables change:
```sql
CREATE TABLE od_request_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    od_request_id INTEGER NOT NULL,
    timetable_id INTEGER NOT NULL,
    timetable_name TEXT NOT NULL,
    period_number INTEGER NOT NULL,
    period_label TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    FOREIGN KEY (od_request_id) REFERENCES od_requests(id) ON DELETE RESTRICT,
    FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE RESTRICT
);
```
Historical OD snapshots use `ON DELETE RESTRICT` to prevent accidental deletion, ensuring that past approved OD records remain permanently intact regardless of future timetable edits or deletions.

---

## 8. TIMETABLE ENGINE

### 8.1 Engine Specification & Constraints
The Timetable Engine converts raw event timestamps into academic CLASS periods.

* **Structure Attributes:** Name, Scope, Effective Date, Active Flag (`0` or `1`), Working Days (`["MON","TUE","WED","THU","FRI"]`).
* **Period Attributes:** Period Number, Label ("Period 1", "Lunch Break"), Start Time (`HH:MM`), End Time (`HH:MM`), Type (`CLASS`, `SHORT_BREAK`, `LUNCH_BREAK`).
* **Duration Rule:** Automatically computed: `duration_minutes = (end_time_minutes - start_time_minutes)`. Positive duration required.
* **Break Handling:** Short Breaks and Lunch Breaks are recorded in the structure, but excluded from OD period counts.

### 8.2 Validation Algorithms
1. **Chronological Validity:** For every period $i$, $\text{start\_time}_i < \text{end\_time}_i$.
2. **Non-Overlap Rule:** For sorted periods, $\text{start\_time}_{i} \ge \text{end\_time}_{i-1}$.
3. **Single Active Structure:** Only one timetable structure can have `is_active = 1` for a given day/scope at any time.
4. **Non-Blocking Warning:** Gaps between periods raise a UI warning without blocking structure activation.

### 8.3 Super Admin Guard
Modifying timetable structures alters institutional attendance tracking. All timetable endpoints (`POST`, `PUT`, `PATCH`, `DELETE`) are guarded strictly by `requireRole('SUPER_ADMIN')`.

---

## 9. DATABASE DESIGN (Normalized SQLite3 Schema)

### 9.1 Schema DDL Script (`schema.sql`)
```sql
-- Enable Foreign Key Constraint Enforcement in SQLite3
PRAGMA foreign_keys = ON;

-- 1. USERS TABLE
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT, -- Nullable if Google Auth only
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'CLUB_ADMIN', 'FACULTY', 'STUDENT')),
    google_id TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. STUDENTS TABLE (Extends Users for Student Identity)
CREATE TABLE students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    ra_number TEXT NOT NULL UNIQUE CHECK (length(ra_number) = 15 AND NOT (ra_number GLOB '*[^A-Za-z0-9]*')),
    department TEXT NOT NULL,
    year_of_study INTEGER NOT NULL CHECK (year_of_study BETWEEN 1 AND 5),
    section TEXT NOT NULL,
    class_mentor_id INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (class_mentor_id) REFERENCES users(id) ON DELETE RESTRICT
);

-- 3. FACULTY TABLE
CREATE TABLE faculty (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    department TEXT NOT NULL,
    designation TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4. CLUBS TABLE
CREATE TABLE clubs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    logo_url TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- 5. CLUB FACULTY COORDINATORS (Junction Table)
CREATE TABLE club_coordinators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    faculty_user_id INTEGER NOT NULL,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(club_id, faculty_user_id),
    FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
    FOREIGN KEY (faculty_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 6. DYNAMIC CLUB ROLES TABLE
CREATE TABLE club_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    role_name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(club_id, role_name),
    FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

-- 7. SYSTEM PERMISSIONS TABLE
CREATE TABLE permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL
);

-- 8. DYNAMIC CLUB ROLE PERMISSIONS JUNCTION
CREATE TABLE club_role_permissions (
    club_role_id INTEGER NOT NULL,
    permission_id INTEGER NOT NULL,
    PRIMARY KEY (club_role_id, permission_id),
    FOREIGN KEY (club_role_id) REFERENCES club_roles(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- 9. CLUB MEMBERSHIPS TABLE
CREATE TABLE club_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    club_role_id INTEGER, -- Nullable for regular student members
    status TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(club_id, user_id),
    FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (club_role_id) REFERENCES club_roles(id) ON DELETE SET NULL
);

-- 10. TIMETABLE STRUCTURES TABLE
CREATE TABLE timetables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    effective_from DATE NOT NULL,
    working_days TEXT NOT NULL, -- JSON String e.g. ["MON","TUE","WED","THU","FRI"]
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- 11. TIMETABLE PERIODS TABLE
CREATE TABLE timetable_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timetable_id INTEGER NOT NULL,
    period_number INTEGER NOT NULL,
    label TEXT NOT NULL,
    start_time TEXT NOT NULL, -- Format HH:MM (24 hr)
    end_time TEXT NOT NULL,   -- Format HH:MM (24 hr)
    type TEXT NOT NULL CHECK (type IN ('CLASS', 'SHORT_BREAK', 'LUNCH_BREAK')),
    UNIQUE(timetable_id, period_number),
    FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
);

-- 12. EVENTS TABLE
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    venue TEXT NOT NULL,
    event_date DATE NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    banner_url TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ONGOING', 'COMPLETED', 'CANCELLED')),
    rejection_remark TEXT,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- 13. EVENT REGISTRATIONS TABLE
CREATE TABLE event_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_user_id INTEGER NOT NULL,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, student_user_id),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 14. ATTENDANCE TABLE
CREATE TABLE attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_user_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PRESENT', 'ABSENT')),
    marked_by INTEGER NOT NULL,
    marked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, student_user_id),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (marked_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- 15. OD REQUESTS TABLE
CREATE TABLE od_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_id INTEGER NOT NULL UNIQUE,
    student_user_id INTEGER NOT NULL,
    class_mentor_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    faculty_remark TEXT,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (registration_id) REFERENCES event_registrations(id) ON DELETE CASCADE,
    FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (class_mentor_id) REFERENCES users(id) ON DELETE RESTRICT
);

-- 16. OD REQUEST HISTORICAL PERIOD SNAPSHOTS TABLE
CREATE TABLE od_request_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    od_request_id INTEGER NOT NULL,
    timetable_id INTEGER NOT NULL,
    timetable_name TEXT NOT NULL,
    period_number INTEGER NOT NULL,
    period_label TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    FOREIGN KEY (od_request_id) REFERENCES od_requests(id) ON DELETE RESTRICT,
    FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE RESTRICT
);

-- 17. CERTIFICATES TABLE
CREATE TABLE certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    certificate_uuid TEXT NOT NULL UNIQUE,
    event_id INTEGER NOT NULL,
    student_user_id INTEGER NOT NULL,
    role_type TEXT NOT NULL DEFAULT 'PARTICIPANT' CHECK (role_type IN ('PARTICIPANT', 'WINNER', 'RUNNER_UP', 'VOLUNTEER', 'ORGANIZER')),
    verification_hash TEXT NOT NULL UNIQUE,
    issued_by INTEGER NOT NULL,
    issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, student_user_id),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE RESTRICT,
    FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- 18. BADGES MASTER TABLE
CREATE TABLE badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER, -- NULL if global badge
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    icon_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

-- 19. STUDENT BADGES JUNCTION TABLE
CREATE TABLE student_badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    badge_id INTEGER NOT NULL,
    student_user_id INTEGER NOT NULL,
    awarded_by INTEGER NOT NULL,
    awarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(badge_id, student_user_id),
    FOREIGN KEY (badge_id) REFERENCES badges(id) ON DELETE CASCADE,
    FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (awarded_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- 20. NOTIFICATIONS TABLE
CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT NOT NULL,
    link_url TEXT,
    is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 21. COMMUNICATION THREADS & MESSAGES TABLE
CREATE TABLE communication_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_type TEXT NOT NULL CHECK (context_type IN ('EVENT', 'OD_REQUEST', 'DIRECT')),
    context_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE thread_participants (
    thread_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (thread_id, user_id),
    FOREIGN KEY (thread_id) REFERENCES communication_threads(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    message_text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (thread_id) REFERENCES communication_threads(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 22. AUDIT LOGS TABLE
CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_entity TEXT NOT NULL,
    target_id INTEGER,
    details_json TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT
);

-- INDEXES FOR OPTIMIZED LOOKUPS
CREATE UNIQUE INDEX idx_students_ra_number ON students(ra_number);
CREATE INDEX idx_events_status_date ON events(status, event_date);
CREATE INDEX idx_event_registrations_student ON event_registrations(student_user_id);
CREATE INDEX idx_od_requests_mentor_status ON od_requests(class_mentor_id, status);
CREATE INDEX idx_notifications_user_read ON notifications(user_id, is_read);
CREATE UNIQUE INDEX idx_certificates_uuid ON certificates(certificate_uuid);
```

---

## 10. RA NUMBER DATA INTEGRITY

### 10.1 Specifications & Validation
* **Format:** Exactly 15 alphanumeric characters (`^[A-Za-z0-9]{15}$`).
* **Layers:**
  1. Frontend mask (upper-case, limit 15).
  2. Zod validator: `z.string().regex(/^[A-Za-z0-9]{15}$/)`.
  3. SQLite DB Constraint: `CHECK (length(ra_number) = 15 AND NOT (ra_number GLOB '*[^A-Za-z0-9]*'))`.
  4. Unique index: `idx_students_ra_number`.

### 10.2 Lock-In Policy
Students **cannot** edit their RA Number via self-service APIs. Super Admin override requires explicit audit logging in `audit_logs`.

---

## 11. API / BACKEND MODULE PLAN

| Module | Method | Endpoint | Required Permission / Role | Description & Primary Logic |
| :--- | :--- | :--- | :--- | :--- |
| **Auth** | POST | `/api/auth/register` | Public | Register email/pass or bind Google account with RA Number. |
| **Auth** | POST | `/api/auth/login` | Public | Authenticate user, issue HttpOnly JWT cookie. |
| **Auth** | GET | `/api/auth/me` | Authenticated | Return session info derived from JWT cookie. |
| **Users** | POST | `/api/users/system-user` | Super Admin / Admin | Create Admin, Club Admin, or Faculty accounts. |
| **Clubs** | POST | `/api/clubs` | Admin / Super Admin | Create club & assign Faculty Coordinator (must be `FACULTY` user). |
| **Roles** | POST | `/api/clubs/:id/roles` | Club Admin | Create dynamic role using catalog permissions only. |
| **Timetable**| POST | `/api/timetable` | **SUPER_ADMIN ONLY** | Create/Activate timetable structure with period overlap validation. |
| **Events** | POST | `/api/events` | Club Admin | Create event in `DRAFT` status. |
| **Events** | POST | `/api/events/:id/submit` | Club Admin | Submit `DRAFT` or `REJECTED` event to `PENDING_APPROVAL`. |
| **Events** | GET | `/api/events` | Student / All | Return published (`APPROVED`) events for students; all for admins. |
| **Events** | PATCH| `/api/events/:id/review`| Faculty Coordinator | Approve or Reject event with mandatory remark. |
| **Reg** | POST | `/api/registrations` | Student | Register for an approved event (checks capacity & status). |
| **OD** | POST | `/api/od/request` | Student | Raise OD request referencing active registration. |
| **OD** | PATCH| `/api/od/:id/review` | Class Mentor | Approve/Reject OD request & snapshot affected periods. |
| **Att** | POST | `/api/attendance` | Club Admin / Dynamic | Mark attendance (`MARK_ATTENDANCE`). |
| **Cert** | POST | `/api/certificates/issue`| Club Admin / Dynamic | Issue certificate (`ISSUE_CERTIFICATE`) for present attendees. |
| **Cert** | GET | `/api/certificates/verify/:uuid`| Public | Verify certificate authenticity by UUID. |
| **Badges** | POST | `/api/badges/award` | Club Admin / Dynamic | Award badge (`AWARD_BADGE`) to student profile. |
| **Comm** | POST | `/api/communication/messages`| Thread Participant | Send contextual message in authorized thread. |
| **Analytics**| GET | `/api/analytics/dashboard`| Role-based | Fetch role-scoped analytics metrics. |

---

## 12. SECURITY AND AUTHORIZATION

### 12.1 Attack Vector Mitigation Matrix

| Vulnerability / Attack Vector | Mitigation Strategy & Server-Side Enforcement |
| :--- | :--- |
| **Direct API Invocation by Student on Admin Endpoints** | Middleware checks session JWT role scope (`requireRole('ADMIN')`). Direct requests return `403 Forbidden`. |
| **Club Admin Accessing Super Admin Timetable API** | Endpoint guarded explicitly by `requireRole('SUPER_ADMIN')`. |
| **Student Registering for Unapproved Event via API** | Backend SQL validation: `WHERE id = :eventId AND status = 'APPROVED'`. Fails if `DRAFT`, `PENDING`, or `REJECTED`. |
| **Student Requesting OD Without Registration** | Backend checks `SELECT 1 FROM event_registrations WHERE student_user_id = ? AND event_id = ?`. Throws `400 Bad Request`. |
| **Tampering with RA Number or User ID (IDOR)** | User ID taken directly from verified JWT session cookie (`req.user.id`), never from client body payload. |
| **Dynamic Role Privilege Escalation** | Requested permissions checked against fixed dynamic catalog. System permissions rejected with `403`. |
| **Contextual Message Thread Access via URL ID** | Middleware checks `thread_participants` table before granting read/write access to thread. |
| **XSS Token Theft / Session Hijacking** | JWT stored exclusively in `HttpOnly`, `SameSite=Strict`, `Secure` cookies. |

---

## 13. EDGE CASES & TESTING CHECKLIST

1. **Unapproved Event Registration Attempt:** Student attempts `POST /api/registrations` on `PENDING` event $\rightarrow$ Returns HTTP `400/403`.
2. **Rejected Event Registration Attempt:** Student attempts `POST /api/registrations` on `REJECTED` event $\rightarrow$ Returns HTTP `400/403`.
3. **OD Application Without Event Registration:** Student applies for OD on unregistered event $\rightarrow$ Returns HTTP `400 Bad Request`.
4. **Student Approving Own OD:** Student calls `PATCH /api/od/:id/review` $\rightarrow$ Returns HTTP `403 Forbidden`.
5. **Faculty Approving Event for Unassigned Club:** Faculty Coordinator reviews event of unassigned club $\rightarrow$ Returns HTTP `403 Forbidden`.
6. **Faculty Approving OD for Non-Mentee:** Faculty reviews OD of non-mentee student $\rightarrow$ Returns HTTP `403 Forbidden`.
7. **Club Admin Modifying Timetable:** Club Admin calls `POST /api/timetable` $\rightarrow$ Returns HTTP `403 Forbidden`.
8. **Dynamic Role Missing `MARK_ATTENDANCE` Privilege:** Dynamic role attempts attendance marking $\rightarrow$ Returns HTTP `403 Forbidden`.
9. **Dynamic Role Attempting System Permission:** Club Admin assigns `TIMETABLE_CREATE_EDIT` to dynamic role $\rightarrow$ Returns HTTP `403 Forbidden`.
10. **Duplicate RA Number:** Registration attempted with existing RA Number $\rightarrow$ Returns HTTP `409 Conflict`.
11. **Invalid RA Number Format:** Registration attempted with `RA123` (short) or non-alphanumeric $\rightarrow$ Returns HTTP `400 Bad Request`.
12. **Duplicate Event Registration:** Student registers twice for same event $\rightarrow$ Returns HTTP `409 Conflict`.
13. **Event Capacity Exceeded:** Student registers when `count >= capacity` $\rightarrow$ Returns HTTP `400 Bad Request`.
14. **Timetable Period Overlap:** Super Admin submits overlapping periods $\rightarrow$ Returns HTTP `400 Bad Request`.
15. **Historical OD Snapshot Stability:** Modifying active timetable structure does **not** change periods in existing approved OD records.
16. **Data Persistence Across Restart:** SQLite database file (`campus_club_os.db`) retains all records after server stop and restart.

---

## 14. NOTIFICATION MATRIX

| Trigger Event | Target Recipient | Channel | Message Content |
| :--- | :--- | :--- | :--- |
| Event Submitted (`EVENT_SUBMITTED`) | Faculty Coordinator | In-App Alert | "New Event '[Title]' submitted for your approval." |
| Event Approved/Rejected (`EVENT_REVIEWED`) | Club Admin | In-App Alert | "Your Event '[Title]' was [Approved/Rejected]." |
| Student Event Registration (`EVENT_REGISTERED`) | Student | In-App Alert | "Successfully registered for '[Title]'." |
| OD Request Raised (`OD_REQUEST_RAISED`) | Class Mentor | In-App Alert | "OD Request raised by [Student Name] (RA: [RA]) for [Event]." |
| OD Approved/Rejected (`OD_REVIEWED`) | Student | In-App Alert | "Your OD Request for '[Event]' was [Approved/Rejected]." |
| New Role Assigned (`NEW_ROLE_ASSIGNED`) | Assigned User | In-App Alert | "You have been assigned role '[Role Name]' in [Club]." |
| Badge Awarded (`BADGE_AWARDED`) | Student | In-App Alert | "Congratulations! You earned badge '[Badge Name]'!" |

---

## 15. CERTIFICATE AND BADGE DESIGN

### 15.1 Certificate Verification System
* **Generation Criteria:** Requires `events.status === 'COMPLETED'` AND `attendance.status === 'PRESENT'`.
* **Unique Identification:** Server-side cryptographic UUIDv4 + SHA-256 verification hash.
* **Verification QR Code:** Embedded PDF QR code rendering `https://campusclubos.edu/verify-certificate/:uuid`.
* **Public Verification Page:** Enter UUID or scan QR to inspect authentic student, event, date, and issuer metadata.

### 15.2 Badge Architecture
Badges define lightweight achievement milestones. Awarded by system or authorized Club Admins (`AWARD_BADGE`), displayed across all clubs on Student Profile, triggers notification.

---

## 16. ANALYTICS ENGINE

### 16.1 Required Metrics by Role

| Dashboard View | Required Metrics | SQL Source Data |
| :--- | :--- | :--- |
| **Per Club** | Member count, total events held, average attendance rate | Aggregates on `club_memberships`, `events`, `attendance` |
| **Per Student** | Total events attended, OD approval success rate | Aggregates on `attendance`, `od_requests` |
| **Admin Dashboard** | Cross-club comparison, pending-approval queue count, most active clubs | Grouped counts on `events`, `event_registrations` |
| **Super Admin Dashboard** | Campus-wide global statistics, full institutional audit log | Global queries across all core tables |

---

## 17. INNOVATION OPPORTUNITIES (Non-Blocking Bonus Features)

1. **Fast Dynamic QR-Based Event Check-In Engine**
2. **Automated Public Certificate Verification Portal (`/verify-certificate/:uuid`)**
3. **Smart Timetable Conflict Warning System during Event Creation**
4. **Student Activity Portfolio / Co-Curricular Transcript PDF Exporter**

---

## 18. DEVELOPMENT PHASES

* **Phase 1: Architecture & Data Modeling** (Database schema DDL, Project scaffolding)
* **Phase 2: Database & Authentication System** (SQLite setup, JWT HttpOnly auth, Google OAuth, RA Number validation)
* **Phase 3: Role-Based Permission Engine** (Fixed & dynamic role middleware, scope resolution)
* **Phase 4: Club Management Module** (Club CRUD, Admin & Coordinator assignment)
* **Phase 5: Timetable Engine** (Super Admin timetable manager, period overlap validation)
* **Phase 6: Event Lifecycle Module** (Draft $\rightarrow$ Pending $\rightarrow$ Approved/Rejected state machine, resubmission)
* **Phase 7: Student Registration Module** (Capacity checks, duplicate prevention)
* **Phase 8: OD Workflow & Period Calculator Engine** (Auto period calculator, mentor approvals, historical snapshotting)
* **Phase 9: In-App Notification System** (Alert dispatching & unread badges)
* **Phase 10: Attendance System** (Attendance tracking & check-in)
* **Phase 11: Certificate & Badge Engine** (PDFKit generator, SHA-256 verification, QR codes)
* **Phase 12: Analytics & Communication System** (Dashboards, authorized contextual messaging)
* **Phase 13: Innovation Features Integration** (Portfolio exporter, verification portal)
* **Phase 14: Rigorous End-to-End Testing** (Edge case verification, permission boundary testing)
* **Phase 15: Seed Data & Submission Packaging** (Demo video, documentation, zip preparation)

---

## 19. 36-HOUR PRIORITY PLAN

```
+-------------------------------------------------------------------------------+
| HOUR 00 - 02 : Blueprint Finalization, DB Schema Creation (schema.sql)       |
+-------------------------------------------------------------------------------+
| HOUR 02 - 08 : Auth Engine, RA Number Integrity, Timetable Structure Engine   |
+-------------------------------------------------------------------------------+
| HOUR 08 - 16 : Event Lifecycle State Machine + Faculty Approval Gate          |
+-------------------------------------------------------------------------------+
| HOUR 16 - 24 : OD Workflow Engine, Period Calculator, Class Mentor Approvals  |
+-------------------------------------------------------------------------------+
| HOUR 24 - 30 : Certificate PDF Generator, QR Verification, Analytics, Badges |
+-------------------------------------------------------------------------------+
| HOUR 30 - 33 : Code Freeze, Edge Case Auditing, Seed Script Execution        |
+-------------------------------------------------------------------------------+
| HOUR 33 - 36 : Demo Video Recording (<= 25 min), Repo & Drive Packaging       |
+-------------------------------------------------------------------------------+
```

* **MUST FINISH:** Auth + RA Number, Timetable Engine, Event Approval Gate, OD Calculator + Snapshotting, SQLite Foreign Keys.
* **SHOULD FINISH:** Certificates (PDF+QR), Badges, Notifications, Analytics, Communication.
* **BONUS:** QR Check-in, Portfolio Exporter.

---

## 20. FINAL ARCHITECTURE DECISION

* **Frontend Framework:** React (Vite) + Vanilla CSS System
* **Backend Framework:** Node.js + Express.js REST API
* **Database Engine:** SQLite3 using `better-sqlite3` driver (`PRAGMA foreign_keys = ON;`)
* **Authentication Provider:** JWT HttpOnly Cookies + `bcrypt` + Google OAuth2 Client (`google-auth-library`)
* **PDF Engine:** `pdfkit` + `qrcode` node package
* **Folder Structure:**
```
CampusClubOS/
├── docs/
│   ├── HACKATHON_REQUIREMENTS.md
│   ├── BLUEPRINT_VALIDATION_REPORT.md
│   └── PROJECT_BLUEPRINT.md
├── server/
│   ├── src/
│   │   ├── config/ (db.js)
│   │   ├── middleware/ (auth.js, rbac.js, scope.js)
│   │   ├── routes/ (auth, clubs, events, od, timetable, certs, badges, comm)
│   │   ├── services/ (timetableEngine.js, pdfEngine.js, odEngine.js)
│   │   └── index.js
│   ├── database/
│   │   ├── schema.sql
│   │   └── seed.sql
│   └── package.json
├── client/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── context/
│   │   └── App.jsx
│   └── package.json
├── .env.example
└── README.md
```
