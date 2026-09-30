# CampusClubOS - Application Screens & UI Index

This document lists all active application screens and UI views rendered by **CampusClubOS**, categorized by user role and module.

---

## 🏛️ Public Screens
- **Public Portal Landing Page** (`/`): Public event showcase and login prompt.
- **Login Screen** (`/login`): Authentication portal (Email/Password & Google OAuth 2.0).
- **Public Certificate Verification Portal** (`/verify`): Enter UUID to verify authenticity.
- **Public Certificate Verification Detail** (`/verify/:uuid`): Displays certificate status (VALID/REVOKED), student name, and masked RA Number.

---

## 🎓 Student Screens
- **Student Dashboard / Events Catalog** (`/student/events`): Browse approved events with filter options.
- **Student Event Details & Registration** (`/student/events/:id`): Event venue, capacity, and register/cancel buttons.
- **My Registrations Roster** (`/student/registrations`): View confirmed registrations and apply for OD.
- **Student OD Applications List** (`/student/od`): View submitted OD requests and mentor approval statuses.
- **Student OD Detail & Timetable Breakdown** (`/student/od/:id`): Detailed breakdown of affected class periods.
- **Student Profile & Achievements Showcase** (`/student/profile`): Read-only RA Number, metrics grid, joined clubs, badges gallery, and certificates list.
- **Student Portfolio PDF Export** (`/student/portfolio.pdf`): Vector A4 PDF download of verified achievements.
- **Student Notifications Inbox** (`/notifications`): View and mark personal notifications as read.

---

## 👔 Club Admin Screens
- **Club Management Dashboard** (`/club/events`): Overview of club events, drafts, and member rosters.
- **Create Event Proposal Screen** (`/club/events/new`): Draft new club event with timing and venue.
- **Club Event Management Console** (`/club/events/:id`): Manage event state, resubmit, or launch Live Dynamic QR Terminal.
- **Live Dynamic QR Terminal Terminal** (`/club/events/:id/qr-terminal`): Displays HMAC-signed auto-refreshing QR code for attendance.
- **Manual Attendance Roster Terminal** (`/club/attendance/:eventId`): Mark-all-present and manual attendance checkboxes.
- **Club Certificates Console** (`/club/events/:id/certificates`): Bulk and single certificate issuance and revocation console.
- **Club Badges Management** (`/club/badges`): Create custom club badges and award badges to members.
- **Dynamic Club Roles & Permissions Manager** (`/club/:clubId/roles`): Create custom dynamic roles and assign granular permissions.
- **Club Members Roster** (`/club/:clubId/members`): View members and update dynamic role assignments.
- **Club Analytics Dashboard** (`/club/analytics`): Event attendance rates, registration totals, and participation charts.

---

## 👩‍🏫 Faculty Screens
- **Faculty Pending Event Approvals** (`/faculty/events`): Review club event proposals for supervised clubs.
- **Faculty Event Proposal Review** (`/faculty/events/:id`): Approve, reject with remark, or request changes.
- **Faculty Mentee OD Approvals Queue** (`/faculty/od`): Review mentee On-Duty applications with academic impact previews.
- **Faculty Mentee OD Detail Review** (`/faculty/od/:id`): Approve/reject OD request with historical period snapshotting.
- **Faculty Certificates Audit** (`/faculty/certificates`): Read-only audit log of certificates issued for supervised clubs.
- **Faculty Analytics Dashboard** (`/faculty/analytics`): Mentee OD statistics and club performance overview.

---

## 🛡️ Admin & Super Admin Screens
- **Admin Dashboard & System Overview** (`/admin/events`): Cross-club event monitoring and escalation management.
- **Admin Certificate Audit Console** (`/admin/certificates`): System-wide certificate audit log and revocation view.
- **Admin Analytics Console** (`/admin/analytics`): Cross-club comparison tables, pending queue wait times, and activity rankings.
- **Super Admin Timetable Manager** (`/admin/timetable`): Manage master academic timetable structures, working days, and period timings.
- **Super Admin Platform Analytics** (`/admin/analytics`): Total users by role, clubs by status, and system audit trail log.

---

## 💬 Contextual Messaging Screens
- **Unified Messages Inbox** (`/messages`): View active threads and unread indicators.
- **New Direct Message Picker** (`/messages/new`): Select eligible Faculty/Club Admin recipient.
- **Chat Room Interface** (`/messages/:id`): Auto-polling chat room with participant header and timestamped messages.
