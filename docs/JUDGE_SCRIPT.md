# CampusClubOS - Judge Verification & Demo Script

This script provides step-by-step, click-by-click instructions for hackathon judges to verify all core functional flows and business logic rules of **CampusClubOS**.

---

## 🔑 Seeded Demo Credentials

> **Default Password for ALL Accounts:** `Password123!`

| Role | Email Address | Description & Context |
| :--- | :--- | :--- |
| **Super Admin** | `superadmin@campus.edu` | Master administrator; full platform access & Timetable control. |
| **Admin** | `admin@campus.edu` | Campus admin; cross-club monitoring, analytics, certificate audit. |
| **Faculty 1** | `faculty.mentor@campus.edu` | Class Mentor for `student1` & Coordinator for `Coding Club`. |
| **Faculty 2** | `faculty.advisor@campus.edu` | Independent Faculty member (Electrical Engineering). |
| **Club Admin** | `clubadmin@campus.edu` | Leader of `Coding Club` (CODE01). |
| **Student 1** | `student1@campus.edu` | RA: `RA2311003010001`, "Logistics Lead" member in `Coding Club`. |
| **Student 2** | `student2@campus.edu` | RA: `RA2311003010002`, regular student member in `Coding Club`. |

---

## 🛠️ Flow 1: Master Timetable Management Flow

### A. Super Admin Timetable Period Addition
1. Log out (if logged in) and navigate to `/login`.
2. Sign in as **Super Admin** (`superadmin@campus.edu` / `Password123!`).
3. Click **Timetable** in the main navigation header (or visit `/admin/timetable`).
4. Click **View / Manage Active Timetable**.
5. Fill out the "Add Period" form:
   - **Period Number:** `11`
   - **Label:** `Evening Review`
   - **Start Time:** `16:45`
   - **End Time:** `17:30`
   - **Type:** `CLASS`
6. Click **Add Period**.
7. **Verification:** Confirm `Evening Review (16:45 - 17:30)` appears in the active period schedule list.

### B. Overlapping Period Rejection (RBAC & Business Rules)
1. In the same "Add Period" form, attempt to submit an overlapping period:
   - **Period Number:** `12`
   - **Label:** `Conflicting Period`
   - **Start Time:** `17:00`
   - **End Time:** `17:45`
2. Click **Add Period**.
3. **Verification:** System displays an error message rejecting the addition due to timing overlap (`17:00` overlaps with existing period ending at `17:30`).

### C. Non-Super Admin Access Refusal (RBAC Enforcement)
1. Log out and sign in as **Club Admin** (`clubadmin@campus.edu` / `Password123!`).
2. Attempt to navigate directly to `/admin/timetable`.
3. **Verification:** System denies access and displays a `403 Forbidden` error (only Super Admins can manage timetables).

---

## 📅 Flow 2: Event Proposal, Faculty Approval Gate & Resubmission Flow

### A. Event Proposal Submission by Club Admin
1. Sign in as **Club Admin** (`clubadmin@campus.edu` / `Password123!`).
2. Navigate to **Club Events** (`/club/events`) and click **Create New Event**.
3. Fill out the event creation form:
   - **Title:** `Spring Hackathon 2026`
   - **Description:** `24-hour coding challenge and project showcase`
   - **Date:** Choose tomorrow's date
   - **Start Time:** `10:00`
   - **End Time:** `16:00`
   - **Venue:** `Lab 1 & 2`
   - **Capacity:** `60`
4. Click **Create Event Draft**. Event is created in `DRAFT` state.
5. On the event details page, click **Submit for Faculty Review**. Event transitions to `PENDING_APPROVAL`.

### B. Faculty Coordinator Review & Approval Gate
1. Log out and sign in as **Faculty 1** (`faculty.mentor@campus.edu` / `Password123!`).
2. Navigate to **Pending Approvals** (`/faculty/events`).
3. Locate `Spring Hackathon 2026` and click **Review Proposal**.
4. Click **Approve Event**.
5. **Verification:** Status transitions to `APPROVED`. The event is now visible on the public student portal.

### C. Edit-After-Approval Protection & Resubmission
1. Log out and sign in as **Club Admin** (`clubadmin@campus.edu` / `Password123!`).
2. Navigate to `/club/events` and click on `Spring Hackathon 2026`.
3. Click **Edit Event**, change the **Venue** to `Main Auditorium`, and click **Save Changes**.
4. **Verification:** Notice that editing key fields automatically resets status to `PENDING_APPROVAL` and hides it from student event lists until re-approved.
5. Click **Submit for Faculty Review** to resubmit.

---

## 🎓 Flow 3: Student Registration & On-Duty (OD) Flow

### A. Student Event Registration
1. Log out and sign in as **Student 2** (`student2@campus.edu` / `Password123!`).
2. Navigate to **Events** (`/student/events`).
3. Click on the seeded approved event: `Live Coding Bootcamp 2026`.
4. Click **Register for Event**.
5. **Verification:** Registration confirmation appears, and the event moves to **My Registrations** (`/student/registrations`).

### B. OD Application & Academic Impact Preview
1. On **My Registrations** (`/student/registrations`), click **Apply for On-Duty (OD)** next to `Live Coding Bootcamp 2026`.
2. The OD application modal displays the automatically calculated timetable periods affected by the event timing (`14:00 - 16:30`).
3. Click **Submit OD Application**. Status becomes `PENDING`.

### C. Class Mentor Review & Period Snapshot
1. Log out and sign in as **Faculty 1** (`faculty.mentor@campus.edu` / `Password123!`).
2. Navigate to **Mentee OD Requests** (`/faculty/od`).
3. Locate the OD request from `Student 2` (Jane Smith) and click **Review Request**.
4. Enter remark: `Approved for academic participation` and click **Approve OD**.
5. **Verification:** Status becomes `APPROVED`. An immutable snapshot of the 3 affected class periods is recorded in `od_request_periods`.

---

## 📲 Flow 4: Dynamic QR Code Attendance Check-In

### A. Live Dynamic QR Display (Club Admin)
1. Sign in as **Club Admin** (`clubadmin@campus.edu` / `Password123!`).
2. Open the event page for `Live Coding Bootcamp 2026` (`/club/events/3`).
3. Click **Start Event** (transitions event status to `ONGOING`).
4. Click **Show Live QR Check-In Terminal**.
5. **Verification:** The page renders a dynamic QR code with an embedded HMAC-signed token that refreshes automatically every 20 seconds.

### B. Student Self Check-In via QR Code
1. Log out and sign in as **Student 1** (`student1@campus.edu` / `Password123!`).
2. Open the QR check-in terminal link in your browser (`/checkin?t=<TOKEN>` or click the URL shown below the QR code).
3. **Verification:** The system validates the HMAC token, marks Student 1 `PRESENT` with method `QR`, and displays a green success confirmation badge. Re-scanning the same token returns an idempotent success message without duplicate entries.

---

## 📜 Flow 5: Verifiable Certificates & Badges Flow

### A. Bulk Certificate Issuance
1. Sign in as **Club Admin** (`clubadmin@campus.edu` / `Password123!`).
2. Open event `Annual Tech Symposium 2026` (`/club/events/5`) which is in state `COMPLETED`.
3. Click **Certificates Management** (`/club/events/5/certificates`).
4. Click **Bulk Issue Certificates for All Present Attendees**.
5. **Verification:** A certificate is generated for `Student 1` (John Doe) who was marked `PRESENT`. `Student 2` (ABSENT) is skipped.

### B. Public Verification Portal & PDF Download
1. Log out and navigate to public URL: `/verify`.
2. Enter the seeded Certificate UUID: `c0a80101-5678-4321-89ab-cdef01234567`.
3. Click **Verify Certificate**.
4. **Verification:** Displays status `VALID`, student name `John Doe`, masked RA Number `RA231100*****001`, event title, and club name.
5. Sign in as **Student 1** (`student1@campus.edu` / `Password123!`) and navigate to **My Certificates** (`/student/certificates`).
6. Click **Download PDF Certificate**. The browser opens an vector A4 PDF rendered via `pdfkit` containing embedded verification QR code and SHA-256 hash.

### C. Manual & Automated Badge Awarding
1. Sign in as **Club Admin** (`clubadmin@campus.edu` / `Password123!`).
2. Navigate to **Club Badges** (`/club/badges`).
3. In the "Award Badge" section:
   - Select Badge: `Top Coder 2026`
   - Select Student: `Student 2 (Jane Smith)`
   - Reason: `Outstanding performance in speed coding challenge`
4. Click **Award Badge**.
5. Log out and sign in as **Student 2** (`student2@campus.edu` / `Password123!`).
6. Navigate to **My Profile** (`/student/profile`).
7. **Verification:** The `Top Coder 2026` badge appears in Student 2's verified badges showcase.

---

## 📊 Summary of Demo Accounts & Password

- **Password:** `Password123!`
- **Super Admin:** `superadmin@campus.edu`
- **Campus Admin:** `admin@campus.edu`
- **Faculty Coordinator/Mentor:** `faculty.mentor@campus.edu`
- **Club Admin:** `clubadmin@campus.edu`
- **Students:** `student1@campus.edu`, `student2@campus.edu`
