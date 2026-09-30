# CampusClubOS - Architectural Decisions Log

## Overview
This document records key design decisions made during the autonomous hackathon execution stages.

---

### Decision 1: Single Persistent SQLite Database Engine
* **Context**: Low latency and zero-config deployment requirement.
* **Decision**: Selected `better-sqlite3` with `PRAGMA foreign_keys = ON;` and custom database triggers (`trg_check_event_registration_status`, `trg_check_event_capacity`, `trg_prevent_decided_od_update`) for hard constraint enforcement.

### Decision 2: Stateless JWT in HttpOnly Cookies with Live Database Validation
* **Context**: Stateless token authentication combined with real-time RBAC role revocation.
* **Decision**: JWT payload contains `userId` only. `loadUserSession` middleware queries the SQLite database on each request to ensure immediate session termination upon user deactivation or role change.

### Decision 3: Service-Centered Business Logic & Thin Controller Architecture
* **Context**: Strict separation of concerns, testability, and auditability.
* **Decision**: All domain mutations (`eventService.transition`, `odService.transition`, `attendanceService.markAttendance`, `certificateService.issue`, `badgeService.award`) live exclusively in `/src/services`. Routes perform input validation and delegate to services.

### Decision 4: Idempotent Automated Milestone Badge Evaluation
* **Context**: Automated badge triggers ("First Event", "3-Event Streak", "Club Volunteer", "Event Organizer").
* **Decision**: Evaluation hooks are called within database service operations (attendance marking and certificate issuance) using idempotent `award` logic to ensure a student receives each milestone badge exactly once.

### Decision 5: Non-Participant Thread Isolation for Messaging
* **Context**: Security & privacy for event discussions, OD request reviews, and direct faculty communication.
* **Decision**: All message queries check `thread_participants` for the acting user. Non-participants (and students attempting to access messaging) receive a **`404 Not Found`** response to prevent endpoint enumeration.
