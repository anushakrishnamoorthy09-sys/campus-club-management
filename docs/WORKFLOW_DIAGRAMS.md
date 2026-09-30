# CampusClubOS - System Workflow Diagrams

This document contains the 5 primary Mermaid workflow diagrams representing the core operational state machines and permission gates in **CampusClubOS**.

---

## 1. Event Approval Gate & Lifecycle Flow

```mermaid
stateDiagram-v2
    [*] --> DRAFT : Club Admin Creates Draft
    DRAFT --> PENDING_APPROVAL : Submit for Review (EVENT_SUBMIT)
    
    state PENDING_APPROVAL {
        [*] --> FacultyReview
        FacultyReview --> FacultyApproved : Faculty Coordinator Approves
        FacultyReview --> FacultyRejected : Faculty Coordinator Rejects
    }
    
    FacultyRejected --> REJECTED : Rejection Remark Captured
    REJECTED --> DRAFT : Club Admin Resubmits Draft
    
    FacultyApproved --> APPROVED : Published on Student Portal
    APPROVED --> ONGOING : Event Date/Time Arrives (Start Event)
    
    APPROVED --> PENDING_APPROVAL : Key Fields Edited (Auto-Hide)
    APPROVED --> CANCELLED : Event Cancelled (Reason + Notification)
    
    ONGOING --> COMPLETED : Mark Attendance & Finish Event
    COMPLETED --> [*]
```

---

## 2. Student On-Duty (OD) Processing Flow

```mermaid
stateDiagram-v2
    [*] --> EventRegistration : Student Registers for APPROVED Event
    EventRegistration --> OD_Requested : Student Applies for OD
    
    state OD_Requested {
        [*] --> CalculateOverlap : Automatic Timetable Period Calculator
        CalculateOverlap --> MentorReview : Form Submitted
    }
    
    MentorReview --> APPROVED : Class Mentor Approves
    MentorReview --> REJECTED : Class Mentor Rejects
    MentorReview --> ESCALATED : Escalated to Admin
    
    ESCALATED --> APPROVED : Admin Decision (Reason Logged)
    ESCALATED --> REJECTED : Admin Decision (Reason Logged)
    
    APPROVED --> SnapshotPeriods : Capture Immutable Period Snapshot (od_request_periods)
    SnapshotPeriods --> [*]
    REJECTED --> [*]
```

---

## 3. Dynamic Club Role & RBAC Flow

```mermaid
flowchart TD
    A[Club Admin] -->|1. Create Role| B[club_roles Table]
    B -->|2. Assign Permissions| C[club_role_permissions Table]
    C -->|3. Assign Role to Member| D[club_memberships Table]
    
    E[Student Member HTTP Request] -->|4. Trigger Middleware| F[requirePermission Guard]
    F -->|5. Check DB Role & Scope| G{Has Granular Permission?}
    
    G -->|Yes| H[200 OK - Access Granted]
    G -->|No| I[403 Forbidden - Access Denied]
    
    J[Club Admin Attempts System Perm] -->|e.g. TIMETABLE_CREATE_EDIT| K[Role Service Guard]
    K -->|Blocked| L[403 Error & AUDIT_LOG Entry]
```

---

## 4. Master Timetable Structure Flow

```mermaid
flowchart TD
    A[Super Admin] -->|1. Create Timetable| B[timetables Table]
    B -->|2. Set Working Days| C[timetable_working_days Table]
    C -->|3. Check Single Active Index| D{Partial Unique Index}
    
    D -->|Valid Single Active Day| E[Saved & Activated]
    D -->|Duplicate Active Day| F[DB Unique Constraint Violation]
    
    E -->|4. Add Period Timings| G[timetable_periods Table]
    G -->|5. Validate Overlaps| H{Time Overlap Validator}
    
    H -->|No Overlap| I[Period Saved]
    H -->|Overlaps Existing| J[Reject Addition 400]
```

---

## 5. Certificate Issuance & Badge Awarding Flow

```mermaid
flowchart TD
    A[Event Reaches COMPLETED State] --> B{Student Registration & Attendance Status}
    
    B -->|PRESENT| C[Eligible for Certificate]
    B -->|ABSENT / Unregistered| D[Ineligible - Issue Blocked]
    
    C -->|Bulk / Single Issue| E[Generate UUID & SHA-256 Hash]
    E -->|Write Record| F[certificates Table]
    F -->|Render Vector PDF| G[pdfkit + Verification QR Code]
    
    H[Attendance Marked PRESENT] --> I{Check System Badge Milestones}
    I -->|First Event| J[Award 'First Event' Badge]
    I -->|3-Event Streak| K[Award '3-Event Streak' Badge]
    
    L[Club Admin / AWARD_BADGE] -->|Manual Award| M[student_badges Table]
    M -->|Dispatch Notification| N[Student Profile Gallery Updated]
```
