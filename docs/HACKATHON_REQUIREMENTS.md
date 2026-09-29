MegaThon Online Track - Campus Club Management Platform
36-Hour Hackathon Problem Statement
•	Track: Campus Operations & Student Engagement Tech
•	Duration: 36 Hours
•	Team Size: 1–2 members
•	Format: Build + Demo + Documentation
1. Background & Problem Context
Most colleges run dozens of student clubs — technical, cultural, sports, literary — each managing events, memberships, and approvals through scattered WhatsApp groups, Excel sheets, and paper OD (On-Duty) forms. This creates real, everyday pain:
•	Faculty can't verify who actually attended an event before signing an OD slip.
•	Club admins lose track of who registered, who attended, and who never showed up.
•	Students juggle multiple registration links and have no single place to check approval status.
•	Admins have no unified view of club activity across campus.
•	There is no single source of truth for a student's identity across clubs, events, and OD records.
Your task: design and build a working platform that brings club management, event lifecycle, OD approvals, and role-based access control into one coherent system — with faculty approval as a non-negotiable checkpoint and every student uniquely tracked by their RA Number.
This is not a CRUD-app exercise. Judges will specifically probe whether your approval workflows are actually enforced, whether role-based access is real (not cosmetic), and whether the system holds up under edge cases (duplicate registrations, rejected events reappearing, OD without event registration, etc.).
Important — read this before you plan your build: Everything in Section 4 (Core Functional Modules) is the baseline — the minimum expected of every team just to be considered complete. It is not the differentiator. What separates a winning submission from an average one is what you build on top of this baseline: your own creativity, unique features, smarter workflows, better UX ideas, or clever technical choices that go beyond what's written here. Treat this document as the floor, not the ceiling.
2. Objective
Build a centralized web (or web + mobile) platform that manages:
•	Campus clubs and their membership
•	Multi-level, role-based user management (Super Admin → Admin → Club Admin → Dynamic Club Roles → Faculty → Students)
•	End-to-end event lifecycle with mandatory faculty approval
•	On-Duty (OD) request and approval workflows tied to event participation
•	Notifications, faculty–admin communication, and basic analytics
•	Certificate and badge issuance so students have verifiable proof of participation and achievement
•	Secure authentication, with Google Sign-In for students and RA Number as the unique student identifier
3. User Roles & Required Capabilities
Role	Core Powers
🔴 Super Admin	Full system control. Creates Admin, Club Admin, and Faculty accounts. Creates clubs. Assigns Faculty Coordinators. Creates and edits the college-wide timetable structure (period timings and durations). Can override any approval. Sees platform-wide analytics.
🟠 Admin	Manages clubs and users with narrower scope than Super Admin. Creates Club Admin accounts. Assigns faculty coordinators. Monitors events/participation. Approves or escalates requests.
🔵 Club Admin	Owns one club. Creates dynamic sub-roles (President, VP, Treasurer, etc.) and assigns members to them. Creates/manages events, submits them for faculty approval. Manages registrations, tracks attendance. Issues certificates and awards badges to students post-event. Communicates with the faculty coordinator.
🟣 Club Administrators (Dynamic Roles)	Role set is not hardcoded — Club Admin defines roles and their permissions at runtime. Depending on assigned permissions: assist with events, manage registrations, coordinate participants, edit event details.
🟢 Faculty	Two functional hats: Class Mentor (handles OD approvals for their mentees) and Club Faculty Coordinator (approves/rejects events for their assigned club). Receives automated notifications. Communicates with other faculty and Club Admins. Views participation of students under them.
⚪ Student	Registers via email/password or Google Sign-In. Uniquely identified by a 15-digit alphanumeric RA Number. Browses/joins clubs, registers for events, applies for OD, tracks status of both, receives notifications, and collects certificates/badges into a personal profile.
Minimum bar for judging: a Club Admin must NOT be able to perform Super Admin actions (including editing the timetable structure), and a rejected event must NOT be visible to students as an open registration. If your role boundaries can be bypassed by hitting an API directly or guessing a URL, that's a scored deduction.
4. Mandatory Functional Modules
4.1 Club Management
•	Create / update / delete / archive clubs
•	Assign Club Admins and Faculty Coordinators to a club
•	Club profile: description, member list, event history, current status
4.2 Role & Permission Management
•	Fixed system roles (Super Admin, Admin, Faculty, Student) enforced at the backend, not just hidden in the UI
•	Dynamic role creation inside a club — Club Admin can define a new role name and choose which permissions it carries (e.g., "Logistics Lead" → can edit venue/capacity but not approve registrations)
•	Every protected action must check permission server-side
4.3 Event Management (with enforced approval gate)
•	Club Admin creates an event: title, description, date, time, venue, capacity, poster/banner (optional)
•	Event status machine (minimum required states): Draft → Pending Faculty Approval → Approved (Published) / Rejected → Ongoing → Completed / Cancelled
•	An event must not be visible/registrable by students until a Faculty Coordinator approves it.
•	Rejected events must show a rejection reason and cannot be re-published without resubmission
•	Students register for approved events only; capacity limits enforced (no overbooking)
•	Admins/Super Admins can view all events across all clubs
4.4 On-Duty (OD) Management
Flow that must be implemented exactly:
1.	Student registers for an approved event
2.	Student applies for OD, referencing that event registration (OD cannot be requested for an event the student isn't registered for)
3.	Request routes to the student's Class Mentor (their assigned faculty mentor — not the club's coordinator)
4.	The system maps the event's date and time against the active timetable structure (Section 4.10) and automatically works out which periods the student will miss (e.g., "Periods 3–5, 11:00 AM – 1:30 PM")
5.	Faculty sees event timing, venue, affected periods, and student details in the request
6.	Faculty approves or rejects, optionally with a remark
7.	Student sees live status: Pending / Approved / Rejected, along with the periods the OD covers
8.	A historical OD record persists per student (auditable trail), including a snapshot of the periods covered at the time of approval
4.5 Notification System
Minimum required triggers (in-app is acceptable; email/push is a bonus):
•	Event submitted for approval → notify assigned Faculty Coordinator
•	Event approved/rejected → notify Club Admin
•	Student registers for event → confirmation to student
•	OD request raised → notify Class Mentor
•	OD approved/rejected → notify student
•	New role assigned → notify the user
4.6 Communication System
•	Faculty ↔ Faculty messaging
•	Faculty ↔ Club Admin messaging
•	Thread should be tied to context where possible (e.g., attached to an event or OD request) rather than a generic open chat
4.7 Tracking & Analytics
•	Per-club: member count, events held, average attendance
•	Per-student: events attended, OD approval rate
•	Admin dashboard: cross-club comparison, pending-approval queue, most active clubs
4.8 Certificate & Badge Management
Certificates and badges are how a club formally recognizes participation and achievement — they must be system-generated, tied to real records (not manually typed by a student), and verifiable.
Certificates
•	Club Admin (or a permitted dynamic role) generates certificates for students after an event is marked Completed and the student's attendance is confirmed
•	Certificate must auto-pull: student name, RA Number, event name, club name, date, and role/nature of participation (e.g., "Participant", "Winner", "Volunteer", "Organizer")
•	Support at least one certificate template per club (logo/club name placeholder is enough — polished design is a bonus)
•	Generated as a downloadable file (PDF is expected) from the student's profile
•	Each certificate carries a unique certificate ID / QR code so its authenticity can be checked (a simple "verify by ID" lookup page counts — full blockchain-style verification is a stretch goal, not required)
•	Bulk-issue option for Club Admin (issue to all confirmed attendees of an event in one action) is strongly encouraged
Badges
•	Badges are lighter-weight, reusable recognition — not tied to a single certificate file, but to a milestone or category (e.g., "First Event", "3-Event Streak", "Club Volunteer", "Event Organizer")
•	Club Admin defines badge types available for their club; system or Club Admin awards them to a student's profile
•	A student's profile should visibly display all badges earned across all clubs, not just one
•	Badge awarding should trigger a notification (reuses Section 4.5's notification system)
Faculty/Admin oversight
•	Faculty Coordinator and Admin/Super Admin can view all certificates and badges issued under their scope (club/college-wide respectively) — this is an audit trail, not a manual approval gate, so it should not block issuance by default
4.9 Authentication & Identity
•	Email/password auth for all roles
•	Google Sign-In specifically for students
•	Session/role must persist correctly on refresh; unauthorized routes must redirect, not just hide UI
•	RA Number (15-digit alphanumeric) is the mandatory unique key for every student record — must be validated on entry (format check) and enforced unique at the data layer
4.10 Timetable Structure Management (Super Admin)
The platform needs to know what a "period" is on your campus so that OD requests can be expressed in terms faculty actually think in (periods missed) rather than raw clock times. This module defines only the basic structure of the timetable — period timings and durations — not subject-wise class schedules.
Who can do what
•	Only the Super Admin can create, edit, activate, or delete timetable structures. Admins, Club Admins, Faculty, and Students get read-only access at most. This restriction must be enforced server-side.
•	Faculty, Club Admins, and Students can view the active structure (e.g., when scheduling an event or applying for OD).
What a timetable structure contains
•	A name and applicable scope (e.g., "Regular Day – Odd Semester 2026"); the structure may optionally be restricted to particular working days (e.g., Mon–Fri vs. a shorter Saturday structure)
•	An ordered list of periods, each with: period number/label, start time, end time, and type (Class Period / Short Break / Lunch Break)
•	Duration is auto-calculated from start and end times and displayed, never typed in manually
•	Working days (which days of the week the structure applies to)
•	An effective-from date and an active/inactive status
Editing rules
•	Super Admin can add, remove, reorder, and change the timing of periods through a UI (not by editing the database)
•	Validation is mandatory: end time must be after start time, periods must not overlap, periods must be in chronological order, and durations must be greater than zero. Gaps between periods should raise a warning (not necessarily an error)
•	Only one structure may be active for a given day at a time
•	Edits must not silently rewrite history. Changing the active structure must not alter periods already recorded against approved/past OD requests — either version the structure with an effective-from date, or store a snapshot of the periods on each OD record
•	Every change is written to an audit log (who changed what, and when)
How the rest of the system uses it
•	OD requests automatically compute affected periods from the event's date and time (Section 4.4)
•	When a Club Admin schedules an event, the UI should show which periods it overlaps, so the club can see the academic impact before submitting for approval
•	Class Mentors see periods, not just clock times, in the OD approval screen
Not required: subject-wise or faculty-wise class timetables, substitution management, and room allocation are out of scope (see Section 6).
4A. Additional Suggested Functionality (Recommended, Not Mandatory)
These are not required to qualify, but they round out a real club-management platform and are exactly the kind of thing that scores well under Creativity & Innovation (Section 10) if you have time after the baseline is solid. Pick what's realistic for 1–2 people in the time left — don't attempt all of them.
•	Attendance / Check-in system — QR code or manual check-in at event start, feeding directly into who's eligible for a certificate or OD, instead of Club Admin marking attendance by hand
•	Feedback & Event Ratings — students rate/comment on an event after attending; feeds the Analytics module (Section 4.7) with a real "event success" signal instead of just headcount
•	Club Treasury / Budget Tracker — simple income/expense log per club (membership dues, event costs, sponsorships) visible to Club Admin and Faculty Coordinator
•	Resource & Venue Booking — clubs request a venue/slot for an event; Admin approves/rejects and prevents double-booking of the same venue at the same time
•	Leaderboard / Gamification — cross-club leaderboard based on events attended, badges earned, or OD record, to drive student engagement
•	Document Repository — per-club storage for meeting minutes, proposals, or event reports, visible to relevant roles only
•	Alumni / Club History Archive — read-only historical view of past office-bearers, events, and outcomes for a club, useful for continuity year over year
•	Certificate/Badge Portfolio Export — a student can export their full participation history (all certificates + badges) as a single PDF "activity record," useful for résumés or scholarship applications
5. Non-Functional Requirements
•	Role-based access control must be enforced server-side, not just via conditional UI rendering
•	No approval bypass — this will be actively tested by judges attempting to register for a non-approved event or approve their own OD request
•	Reasonable responsiveness — usable on a laptop and a phone browser at minimum
•	Basic input validation (RA Number format, event capacity ≥ 0, no past-dated events, etc.)
•	Data must persist between sessions (no in-memory-only demo that resets on refresh)
•	Database: SQLite3 is mandatory for all teams. Frontend/backend languages and frameworks are your choice, but persistence must be SQLite3 (no MySQL/Postgres/MongoDB/Firebase for core data). Enable foreign key enforcement (PRAGMA foreign_keys = ON) and use proper constraints — SQLite does not enforce many things by default, and judges will check that yours does.
•	Frontend/backend tech stack is otherwise your choice, but be ready to justify your choices
6. Explicitly Out of Scope (for 36 hours)
To keep the challenge achievable, teams are not required to build:
•	Payment processing for paid events
•	Native mobile apps (responsive web is sufficient)
•	Multi-college / multi-tenant support
•	Full subject-wise / faculty-wise class timetables (only the basic period structure in Section 4.10 is required)
•	Offline mode
•	SMS-based notifications (email/in-app is enough)
Teams may still attempt these as bonus/stretch features if core scope is complete.
7. Suggested 36-Hour Timeline
Time Block	Focus
Hour 0–2	Problem breakdown, role/permission matrix, data model, task split
Hour 2–8	Auth (incl. Google Sign-In), role system, base club/user CRUD, Super Admin timetable structure setup (needed before OD)
Hour 8–16	Event lifecycle + approval workflow (this is the core — don't skip depth here)
Hour 16–24	OD workflow end-to-end, notifications
Hour 24–30	Communication module, analytics dashboard, dynamic roles, certificates/badges polish
End of Hour 30	📧 Submission Google Form is emailed to all teams (see Section 8.0). Feature work should be essentially frozen by now.
Hour 30–33	Bug fixing, permission edge cases, seed demo data, ER diagram
Hour 33–36	Documentation, demo video recording, zip packaging, Drive upload, form submission before the 36-hour mark
8. Deliverables / Submission Format
Every team must submit all of the following. Incomplete or non-compliant submissions will be scored on what's present, with penalties for missing or misformatted items.
8.0 📦 Submission Channel & Format (strict)
•	GitHub Repository — a public repo containing the full, working codebase. Judges must be able to clone it without requesting access.
•	Demo Video — must be no longer than 25 minutes. Videos exceeding 25 minutes will only be evaluated up to the 25-minute mark; anything after is not considered.
•	Google Drive Folder — one shared folder with "Anyone with the link – Viewer" access (open view access, no request-access gate), containing:
1.	The demo video file (or a link to it, if hosted elsewhere, alongside the video itself)
2.	A zipped copy of the codebase — this must be uploaded even though the code is also on GitHub, as a submission-integrity backup
•	The zip file must NOT contain any .env file or any file with real secrets/credentials (API keys, DB passwords, OAuth secrets, etc.). Include a .env.example with placeholder keys instead so judges know what variables to configure if they run it locally. Submissions with real credentials in the zip will be flagged and the team will be asked to rotate those credentials immediately.
•	Submission is made through a Google Form, which will be emailed to all registered teams at the end of the 30th hour. Teams submit the public GitHub repo link and the Google Drive folder link through that form — no other submission channel (email replies, chat messages, DMs) will be accepted. Make sure the email address you registered with is monitored and check spam folders after the 30-hour mark.
•	Teams are encouraged to prepare the repo, Drive folder, and link permissions before the form arrives, so that the final six hours can go into finishing, not packaging.
•	The form closes at the end of Hour 36. Only the last response from a team is evaluated.
8.1 📄 Documentation (PDF or Markdown)
•	Project overview and problem interpretation
•	Features implemented (mapped against Section 4's module list)
•	Database schema design — entity list, relationships, and a diagram (ER diagram or equivalent) showing how clubs, roles, events, OD records, certificates/badges, and RA Numbers relate
•	Role-based workflow diagrams (Event Flow, OD Flow, Role Flow, Certificate/Badge Flow, Timetable Flow — see Section 9)
•	Screens/UI walkthrough with screenshots
•	Setup/run instructions (matching the .env.example from Section 8.0) or deployed link
•	SQLite3 setup: schema creation script (schema.sql or migrations) and a seed script that populates the demo accounts, so judges can rebuild the database from scratch. Including the .db file in the zip is allowed only if it contains demo data — no real student data.
8.2 🎥 Demo Video (strictly ≤ 25 minutes)
Must show, in this order:
1.	Login as Student (incl. Google Sign-In) and as Faculty
2.	Super Admin creating and editing the timetable structure (add/change a period, show validation rejecting an overlap), and a non-Super Admin failing to edit it
3.	Club Admin creating an event → Faculty approving it → Student registering
4.	Student applying for OD (showing the automatically calculated affected periods) → Faculty approving/rejecting it, with status update visible to student
5.	Club Admin marking an event Completed and issuing a certificate / awarding a badge → student viewing/downloading it from their profile
6.	Dynamic role creation and permission-scoped action by that role
7.	Admin/Super Admin dashboard view
8.	A brief walkthrough of the database schema/ER diagram, narrated — judges should be able to see the design, not just hear it described
8.3 🧪 Test Scenarios / Seed Accounts
Provide working credentials for at least:
•	1 Super Admin, 1 Admin
•	1 Club Admin (with at least one dynamic role created under them)
•	1 Faculty (acting as both Class Mentor and Club Coordinator, or two separate accounts)
•	2 Students (with valid-format RA Numbers)
Include a short script/checklist judges can follow to reproduce the Timetable Flow, Event Flow, OD Flow, and Certificate/Badge Flow themselves live.
8.4 📊 Functional Coverage Report
•	Checklist of completed features vs. Section 4 modules
•	Known limitations / incomplete items, stated honestly
•	Any bonus features built beyond scope
9. Required Workflow Diagrams (include in documentation)
Event Flow: Club Admin → Create Event → Faculty Approval → Published → Student Registration
OD Flow: Student → Register for Event → Apply OD → Class Mentor Review → Approve/Reject → Notification
Role Flow: Super Admin/Admin → Create Club Admin → Club Admin → Create Dynamic Roles → Assign to Members
Timetable Flow: Super Admin → Define Periods (start/end, breaks) → Validate → Activate Structure → Used by Event Scheduling & OD Period Calculation
Certificate/Badge Flow: Event Completed → Attendance Confirmed → Club Admin Generates Certificate/Awards Badge → Student Profile Updated → Notification Sent
10. Judging Criteria & Scoring Rubric (100 points)
Criteria	Points	What Judges Look For
Core Functionality Coverage	18	All mandatory modules from Section 4 — including Certificate & Badge Management and Timetable Structure — present and working, not just mocked UI
Approval Workflow Integrity	18	Faculty approval is actually enforced for events and OD — judges will try to break it
Role-Based Access Control	14	Server-side permission checks; dynamic roles genuinely scope actions; no privilege escalation via URL/API
Database Schema Design	8	Normalization, correct relationships/foreign keys, sensible indexing on lookups (e.g., RA Number), how well the schema models roles/events/OD/certificates without redundant or dangling data, and correct use of SQLite features (foreign keys enabled, CHECK/UNIQUE/NOT NULL constraints, e.g. RA Number format and uniqueness) — judged from the ER diagram, schema.sql, and the actual live database
Data Integrity & RA Number Handling	6	RA Number format validation, uniqueness enforced, used consistently as student identity
UI/UX & Usability	7	Clear navigation per role, sensible defaults, mobile-usable
Notifications & Communication	5	Right triggers fire at the right time; communication threads make sense
Analytics/Dashboard Quality	5	Useful, accurate, not just decorative charts
Documentation & Demo Quality	5	Clear, complete, matches what was actually built; submission followed the format in Section 8.0 exactly
Creativity & Innovation (beyond baseline spec)	14	Original ideas layered on top of Section 4 — smarter workflows, unique features, standout UX, or technical ingenuity not asked for in this document
Total: 100 points, inclusive of Creativity & Innovation and Database Schema Design. Section 4's module list is the qualifying baseline — required, but capped in what it alone can earn. A team that implements only what's written in this document, however cleanly, tops out on the first nine rows and scores zero on the tenth. That last category, worth 14 of the 100 points, is where teams actually differentiate themselves and where top placements are decided.
Disqualifying issues (automatic heavy penalty):
•	Students can register for an event that was never faculty-approved
•	Any role can perform another role's exclusive action without permission
•	RA Number is not unique / not validated
•	App loses all data on refresh/restart (not persisted)
•	GitHub repo is private / inaccessible, or the Drive folder does not have open view access
•	Demo video exceeds 25 minutes with essential content past the cutoff
•	Real .env file, API keys, or credentials found inside the submitted zip
•	Core data stored in anything other than SQLite3
11. Clarifying Rules
•	Faculty approval is mandatory for both events and OD requests — no shortcuts, no "auto-approve" toggles left enabled in the final build.
•	A student's identity is always tied to their RA Number, even if email/Google account changes.
•	Teams may use any frontend/backend language or framework, any auth provider, and any hosting method (local demo is acceptable if judges can run it). The database must be SQLite3.
•	AI coding assistants are allowed; teams should be able to explain and defend any part of their own code.
•	Plagiarized or pre-built (pre-hackathon) codebases will be disqualified — version control history may be checked.
•	Submission is only considered complete when both the public GitHub repo link and the open-access Google Drive folder link (video + codebase zip, no .env) are received through the Google Form before the 36-hour mark. Late or missing links follow the same penalty as a late submission.
12. Final Note to Teams
The functional spec here (roles, modules, flows) is deliberately detailed — it mirrors a real institutional requirement, not a toy problem. But it is the baseline, not the brief. Every team is expected to reach it; almost none will be remembered for reaching it. You will not have time to gold-plate every module in 36 hours. Prioritize depth on the approval workflows (events + OD) and role enforcement over breadth of nice-to-have screens — then spend whatever time is left on the one or two original ideas that make your submission yours. A judge can tell in under two minutes whether your "faculty approval" step is real or decorative, and just as fast whether you built only what was asked — make sure neither is true.
Good luck.
