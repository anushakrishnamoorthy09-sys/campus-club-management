-- ============================================================================
-- CAMPUSCLUBOS - INSTITUTIONAL DATABASE SCHEMA (SQLite3)
-- Mandatory Pragma: Foreign Key Enforcement MUST be enabled on every connection.
-- ============================================================================
PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- 1. USERS TABLE
-- System user credentials, primary role, and status.
-- ----------------------------------------------------------------------------
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT, -- NULL for Google OAuth-only accounts
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'CLUB_ADMIN', 'FACULTY', 'STUDENT')),
    google_id TEXT UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 2. FACULTY TABLE
-- Institutional details for faculty users (Class Mentors & Club Coordinators).
-- ----------------------------------------------------------------------------
CREATE TABLE faculty (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    department TEXT NOT NULL,
    designation TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 3. STUDENTS TABLE
-- Student academic profile bound to unique 15-digit uppercase RA Number.
-- References faculty(user_id) to guarantee class mentor is a valid FACULTY user.
-- ----------------------------------------------------------------------------
CREATE TABLE students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    ra_number TEXT NOT NULL UNIQUE CHECK (
        length(ra_number) = 15 
        AND ra_number = UPPER(ra_number) 
        AND NOT (ra_number GLOB '*[^A-Z0-9]*')
    ),
    department TEXT NOT NULL,
    year_of_study INTEGER NOT NULL CHECK (year_of_study BETWEEN 1 AND 5),
    section TEXT NOT NULL,
    class_mentor_id INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (class_mentor_id) REFERENCES faculty(user_id) ON DELETE RESTRICT
);

-- ----------------------------------------------------------------------------
-- 4. CLUBS TABLE
-- Institutional student clubs managed by assigned Club Admin & Faculty Coordinator.
-- ----------------------------------------------------------------------------
CREATE TABLE clubs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    logo_url TEXT,
    club_admin_id INTEGER UNIQUE, -- One club per Club Admin
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (club_admin_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- ----------------------------------------------------------------------------
-- 5. CLUB FACULTY COORDINATORS (Junction Table)
-- References faculty(user_id) to guarantee coordinator is a valid FACULTY user.
-- ----------------------------------------------------------------------------
CREATE TABLE club_coordinators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    faculty_user_id INTEGER NOT NULL,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(club_id, faculty_user_id),
    FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
    FOREIGN KEY (faculty_user_id) REFERENCES faculty(user_id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 6. DYNAMIC CLUB ROLES TABLE
-- Custom club-scoped positions (e.g., Event Lead, Treasurer) created by Club Admin.
-- ----------------------------------------------------------------------------
CREATE TABLE club_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    role_name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(club_id, role_name),
    FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 7. SYSTEM PERMISSIONS CATALOG TABLE
-- Complete catalog of granular system and club-level permissions.
-- ----------------------------------------------------------------------------
CREATE TABLE permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL
);

-- ----------------------------------------------------------------------------
-- 8. DYNAMIC CLUB ROLE PERMISSIONS JUNCTION
-- ----------------------------------------------------------------------------
CREATE TABLE club_role_permissions (
    club_role_id INTEGER NOT NULL,
    permission_id INTEGER NOT NULL,
    PRIMARY KEY (club_role_id, permission_id),
    FOREIGN KEY (club_role_id) REFERENCES club_roles(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 9. CLUB MEMBERSHIPS TABLE
-- Club membership and optional dynamic role assignment for members.
-- ----------------------------------------------------------------------------
CREATE TABLE club_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    club_role_id INTEGER, -- NULL for regular club members
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(club_id, user_id),
    FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (club_role_id) REFERENCES club_roles(id) ON DELETE SET NULL
);

-- ----------------------------------------------------------------------------
-- 10. TIMETABLE STRUCTURES TABLE
-- Master academic timetable period definitions created strictly by Super Admin.
-- ----------------------------------------------------------------------------
CREATE TABLE timetables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    scope TEXT NOT NULL,
    effective_from DATE NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- ----------------------------------------------------------------------------
-- 11. TIMETABLE WORKING DAYS TABLE & PARTIAL UNIQUE INDEX
-- Enforces DB-level rule: Only ONE active timetable structure per day of week.
-- ----------------------------------------------------------------------------
CREATE TABLE timetable_working_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timetable_id INTEGER NOT NULL,
    day_of_week TEXT NOT NULL CHECK (day_of_week IN ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
);

-- Partial Unique Index enforcing single active structure per day of week
CREATE UNIQUE INDEX idx_single_active_timetable_day 
ON timetable_working_days(day_of_week) 
WHERE is_active = 1;

-- ----------------------------------------------------------------------------
-- 12. TIMETABLE PERIODS TABLE
-- Period timing specifications (CLASS, SHORT_BREAK, LUNCH_BREAK).
-- ----------------------------------------------------------------------------
CREATE TABLE timetable_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timetable_id INTEGER NOT NULL,
    period_number INTEGER NOT NULL,
    label TEXT NOT NULL,
    start_time TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
    end_time TEXT NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time > start_time),
    type TEXT NOT NULL CHECK (type IN ('CLASS', 'SHORT_BREAK', 'LUNCH_BREAK')),
    UNIQUE(timetable_id, period_number),
    FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 13. EVENTS TABLE
-- Event lifecycle entity with mandatory faculty approval gate.
-- ----------------------------------------------------------------------------
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    venue TEXT NOT NULL,
    event_date DATE NOT NULL,
    start_time TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
    end_time TEXT NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time > start_time),
    capacity INTEGER NOT NULL CHECK (capacity >= 1),
    banner_url TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ONGOING', 'COMPLETED', 'CANCELLED')),
    rejection_remark TEXT,
    cancellation_reason TEXT,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- ----------------------------------------------------------------------------
-- 14. EVENT REGISTRATIONS TABLE
-- Student registration for APPROVED events. References students(user_id).
-- ----------------------------------------------------------------------------
CREATE TABLE event_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_user_id INTEGER NOT NULL,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, student_user_id),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (student_user_id) REFERENCES students(user_id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 15. ATTENDANCE TABLE
-- Event attendance tracking (MANUAL or dynamic QR). References students(user_id).
-- ----------------------------------------------------------------------------
CREATE TABLE attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    student_user_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PRESENT', 'ABSENT')),
    method TEXT NOT NULL DEFAULT 'MANUAL' CHECK (method IN ('MANUAL', 'QR')),
    marked_by INTEGER NOT NULL,
    marked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, student_user_id),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (student_user_id) REFERENCES students(user_id) ON DELETE CASCADE,
    FOREIGN KEY (marked_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- ----------------------------------------------------------------------------
-- 16. OD REQUESTS TABLE
-- Student On-Duty application. References event_registrations(id) RESTRICT.
-- ----------------------------------------------------------------------------
CREATE TABLE od_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_id INTEGER NOT NULL,
    student_user_id INTEGER NOT NULL,
    class_mentor_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    faculty_remark TEXT,
    reviewed_by INTEGER,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (registration_id) REFERENCES event_registrations(id) ON DELETE RESTRICT,
    FOREIGN KEY (student_user_id) REFERENCES students(user_id) ON DELETE CASCADE,
    FOREIGN KEY (class_mentor_id) REFERENCES faculty(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (reviewed_by) REFERENCES faculty(user_id) ON DELETE RESTRICT
);

-- Partial Unique Index: Only ONE active PENDING or APPROVED OD request per registration
CREATE UNIQUE INDEX idx_single_active_od_per_registration 
ON od_requests(registration_id) 
WHERE status IN ('PENDING', 'APPROVED');

-- ----------------------------------------------------------------------------
-- 17. OD REQUEST HISTORICAL PERIOD SNAPSHOTS TABLE
-- Permanent immutable snapshot of affected periods captured upon mentor approval.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 18. CERTIFICATES TABLE
-- Verifiable PDF certificates generated for present event attendees.
-- ----------------------------------------------------------------------------
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
    FOREIGN KEY (student_user_id) REFERENCES students(user_id) ON DELETE CASCADE,
    FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- ----------------------------------------------------------------------------
-- 19. BADGES MASTER TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER, -- NULL if institution-wide milestone badge
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    icon_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- 20. STUDENT BADGES JUNCTION TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE student_badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    badge_id INTEGER NOT NULL,
    student_user_id INTEGER NOT NULL,
    awarded_by INTEGER NOT NULL,
    awarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(badge_id, student_user_id),
    FOREIGN KEY (badge_id) REFERENCES badges(id) ON DELETE CASCADE,
    FOREIGN KEY (student_user_id) REFERENCES students(user_id) ON DELETE CASCADE,
    FOREIGN KEY (awarded_by) REFERENCES users(id) ON DELETE RESTRICT
);

-- ----------------------------------------------------------------------------
-- 21. NOTIFICATIONS TABLE
-- System notifications for all mandatory workflow triggers.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 22. COMMUNICATION THREADS & PARTICIPANTS TABLE
-- Contextual messaging threads (EVENT, OD_REQUEST, DIRECT).
-- ----------------------------------------------------------------------------
CREATE TABLE communication_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context_type TEXT NOT NULL CHECK (context_type IN ('EVENT', 'OD_REQUEST', 'DIRECT')),
    context_id INTEGER CHECK (context_type = 'DIRECT' OR context_id IS NOT NULL),
    title TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Unique index enforcing single thread per EVENT or OD_REQUEST context
CREATE UNIQUE INDEX idx_single_thread_per_context 
ON communication_threads(context_type, context_id) 
WHERE context_type IN ('EVENT', 'OD_REQUEST');

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

-- ----------------------------------------------------------------------------
-- 23. AUDIT LOGS TABLE
-- Immutable record of administrative overrides, role changes, and state transitions.
-- ----------------------------------------------------------------------------
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

-- ============================================================================
-- DATABASE INDEXES FOR OPTIMIZED LOOKUPS
-- Non-duplicate indexes on foreign keys and common search predicates.
-- ============================================================================
CREATE INDEX idx_events_club_id ON events(club_id);
CREATE INDEX idx_events_status_date ON events(status, event_date);
CREATE INDEX idx_club_memberships_user_id ON club_memberships(user_id);
CREATE INDEX idx_students_class_mentor_id ON students(class_mentor_id);
CREATE INDEX idx_club_coordinators_faculty ON club_coordinators(faculty_user_id);
CREATE INDEX idx_attendance_student ON attendance(student_user_id);
CREATE INDEX idx_certificates_student ON certificates(student_user_id);
CREATE INDEX idx_student_badges_student ON student_badges(student_user_id);
CREATE INDEX idx_messages_thread_time ON messages(thread_id, created_at);
CREATE INDEX idx_audit_logs_target ON audit_logs(target_entity, target_id);
CREATE INDEX idx_notifications_user_time ON notifications(user_id, created_at);

-- ============================================================================
-- DATABASE TRIGGERS FOR HARD ENFORCEMENT OF BUSINESS CONSTRAINTS
-- ============================================================================

-- Trigger 1: Abort registration if event is NOT in APPROVED status
CREATE TRIGGER trg_check_event_registration_status
BEFORE INSERT ON event_registrations
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'Event registration blocked: Event status must be APPROVED.')
    WHERE (SELECT status FROM events WHERE id = NEW.event_id) != 'APPROVED';
END;

-- Trigger 2: Abort registration if event capacity is full
CREATE TRIGGER trg_check_event_capacity
BEFORE INSERT ON event_registrations
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'Event registration blocked: Event capacity reached.')
    WHERE (SELECT COUNT(*) FROM event_registrations WHERE event_id = NEW.event_id) >= (SELECT capacity FROM events WHERE id = NEW.event_id);
END;

-- Trigger 3: Enforce valid state transitions on events table
CREATE TRIGGER trg_check_event_status_transition
BEFORE UPDATE OF status ON events
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'Invalid event transition: DRAFT cannot change directly to APPROVED.')
    WHERE OLD.status = 'DRAFT' AND NEW.status = 'APPROVED';

    SELECT RAISE(ABORT, 'Invalid event transition: REJECTED cannot change directly to APPROVED.')
    WHERE OLD.status = 'REJECTED' AND NEW.status = 'APPROVED';

    SELECT RAISE(ABORT, 'Invalid event transition: PENDING_APPROVAL cannot change directly to ONGOING.')
    WHERE OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'ONGOING';
END;

-- Trigger 4: Prevent modification of decided OD request status
CREATE TRIGGER trg_lock_decided_od_status
BEFORE UPDATE OF status ON od_requests
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'OD request status is locked and cannot be modified once decided.')
    WHERE OLD.status IN ('APPROVED', 'REJECTED');
END;

-- Trigger 5: Prevent alteration of od_request_periods after OD approval
CREATE TRIGGER trg_lock_od_request_periods
BEFORE UPDATE ON od_request_periods
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'Historical OD period snapshots are immutable and cannot be edited.');
END;
