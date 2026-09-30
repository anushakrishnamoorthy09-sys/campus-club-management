# CampusClubOS Notification System & Trigger Mapping

This document provides the authoritative mapping of all system notification triggers, code paths, target recipients, message details, and deep links across the CampusClubOS platform.

---

## 1. Notification Trigger & Routing Matrix

| Trigger Event | Code Path / Service Function | Recipient(s) | Type Category | Link URL (`link_url`) | Specifics Included in Message |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Event Submitted** | `eventService.transition(id, 'submit', actor)` | Faculty Coordinator(s) of Club | `EVENT` | `/faculty/events` | Event title, Club name |
| **Event Approved** (Direct, Escalated, Override) | `eventService.transition(id, 'approve' \| 'escalation-approve' \| 'override-approve')` | Club Admin AND Event Creator | `EVENT` | `/club/events` | Event title, approval type, Admin/Coordinator remark |
| **Event Rejected** (Direct, Escalated, Override) | `eventService.transition(id, 'reject' \| 'escalation-reject' \| 'override-reject')` | Club Admin AND Event Creator | `EVENT` | `/club/events` | Event title, rejection reason/remark |
| **Event Escalated** | `eventService.transition(id, 'escalate', actor)` | System Admins & Super Admins | `EVENT` | `/admin/events` | Event title, Club name, escalation reason |
| **Event Cancelled / Reopened** | `eventService.handleEventCancelledOrReopened(id, reason)` | All Registered Students | `EVENT` | `/student/my-registrations` | Event title, cancellation / re-approval reason |
| **Student Event Registered** | `registrationService.register(eventId, studentUserId)` | Registering Student | `EVENT` | `/student/my-registrations` | Event title, Club name |
| **OD Request Raised** | `odService.request(studentUserId, registrationId)` | Assigned Class Mentor | `OD_REQUEST_RAISED` | `/faculty/od` | Student Name, RA Number, Event title, affected periods |
| **OD Approved** (Mentor or Escalated) | `odService.mentorReview(id, actor, 'APPROVED')` / `odService.escalationReview(...)` | Student | `OD_REVIEWED` | `/student/od` | Event title, decision, mentor/admin remark |
| **OD Rejected** (Mentor or Escalated) | `odService.mentorReview(id, actor, 'REJECTED')` / `odService.escalationReview(...)` | Student | `OD_REVIEWED` | `/student/od` | Event title, rejection remark |
| **OD Request Escalated** | `odService.escalate(odId, actor, reason)` | System Admins & Super Admins | `OD_ESCALATED` | `/admin/od` | Student Name, RA Number, Event title, escalation reason |
| **OD Closed by Cancellation** | `odService.autoCloseForEvent(eventId, reason)` | Student | `OD_CLOSED` | `/student/od` | Event title, closure reason |
| **Dynamic Role Assigned** | `clubRoleService.assignMemberRole(...)` | Target Member User | `ROLE_ASSIGNED` | `/dashboard` | Role title, Club name |
| **Club Personnel Assignment** | `clubService.createClub(...)` / `updateClub(...)` | Assigned Club Admin & Coordinators | `SYSTEM` | `/dashboard/club-admin` (CA) / `/dashboard/faculty` (FC) | Club name, role assigned |
| **Class Mentor Reassigned** | `odService.reassignClassMentor(...)` | Student, Previous Mentor, New Mentor | `MENTOR_REASSIGNED` | `/student/od` (Student) / `/faculty/mentees` (Faculty) | Student Name, RA Number, New Mentor Name |
| **Badge Awarded** *(Documented Hook)* | `notificationService.awardBadgeNotification(...)` | Student | `BADGE` | `/student/badges` | Badge Title, Club name |

---

## 2. Infrastructure Architecture & Extensibility

1. **Single Notification Dispatcher**: All notifications pass through `notificationService.createNotification(userId, title, message, type, linkUrl)`.
2. **Email Adapter Hook**: `sendEmailNotificationStub(userId, title, message)` is invoked asynchronously within `createNotification`. While email dispatch is currently out of scope, the function is stubbed to allow seamless integration of external providers (e.g. Nodemailer, SendGrid, SES) without modifying calling services.
3. **Badge Award Hook**: `notificationService.awardBadgeNotification(studentUserId, badgeName, clubName)` provides a ready-to-wire interface for the upcoming badge recognition module.
4. **Ownership & Authorization**: All notification endpoints (`/notifications`, `/notifications/:id/read`, `/notifications/read-all`, `/notifications/:id/click`) enforce server-side ownership checks (`user_id = req.user.id`). Any attempt to access or modify another user's notification returns `403 Forbidden` / `404 Not Found`.
