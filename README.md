# 🎓 CampusClubOS - Campus Club Management Platform

A robust, enterprise-grade Campus Club Management Platform built for higher education institutions. **CampusClubOS** automates club administration, event proposals, faculty approvals, academic On-Duty (OD) request processing, dynamic QR attendance check-in, verifiable PDF certificates, badges, contextual messaging, and role-based analytics.

---

## 🛠️ Technology Stack & Justifications

| Technology | Justification |
| :--- | :--- |
| **Node.js + Express** | Fast, asynchronous event-driven server architecture with low memory footprint and simple middleware pipeline. |
| **EJS (Embedded JavaScript)** | Fast server-side HTML rendering eliminating SPA build step overhead while remaining fully SEO-friendly. |
| **Tailwind CSS** | Modern utility-first CSS framework allowing rapid responsive UI design and polished glassmorphism aesthetics. |
| **SQLite3 (`better-sqlite3`)** | High-performance synchronous SQL engine with strict foreign key constraints (`PRAGMA foreign_keys = ON;`). |
| **`express-session` & `bcrypt`** | Secure session-based authentication with salted password hashing and cookie tamper protection. |
| **`passport-google-oauth20`** | Standardized Google OAuth 2.0 integration for seamless student single sign-on (SSO). |
| **`pdfkit` & `qrcode`** | Server-side vector A4 PDF generation with embedded QR codes and SHA-256 verification hashes. |

---

## 🚀 Quick Setup & Installation

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
*(On Windows PowerShell: `copy .env.example .env`)*

### 3. Initialize & Seed Database
```bash
npm run db:reset
```

### 4. Start Development Server
```bash
npm run dev
# Or for production:
npm start
```
The application will boot at `http://localhost:3000`.

---

## 🔐 Google OAuth 2.0 Setup

To enable Google Sign-In for students:
1. Visit the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project and set up an **OAuth 2.0 Client ID** under **APIs & Services > Credentials**.
3. Add `http://localhost:3000/auth/google/callback` to **Authorized Redirect URIs**.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in your `.env` file.

---

## 🧪 Running Automated Test Suites

CampusClubOS features a comprehensive suite of unit tests, security assertion suites, and route guard audits:

```bash
# 1. Run Unit Tests (9 domain suites)
npm run test:unit

# 2. Run Security Assertion Suite (42 RBAC & IDOR checks)
npm run test:security

# 3. Run Route Guard Audit (Verifies guards on all 117 endpoints)
npm run routes
```

---

## 🔑 Demo Account Credentials

> **Default Password for ALL Accounts:** `Password123!`

| Role | Email Address | Notes |
| :--- | :--- | :--- |
| **Super Admin** | `superadmin@campus.edu` | Master administrator; full platform access & Timetable control. |
| **Admin** | `admin@campus.edu` | Campus admin; cross-club monitoring, analytics, certificate audit. |
| **Faculty 1** | `faculty.mentor@campus.edu` | Class Mentor for `student1` & Coordinator for `Coding Club`. |
| **Faculty 2** | `faculty.advisor@campus.edu` | Independent Faculty member (Electrical Engineering). |
| **Club Admin** | `clubadmin@campus.edu` | Leader of `Coding Club` (CODE01). |
| **Student 1** | `student1@campus.edu` | RA: `RA2311003010001`, "Logistics Lead" member in `Coding Club`. |
| **Student 2** | `student2@campus.edu` | RA: `RA2311003010002`, regular student member in `Coding Club`. |

---

## 📚 Documentation Index

- [Judge Script & Clickthrough Demo (`docs/JUDGE_SCRIPT.md`)](docs/JUDGE_SCRIPT.md)
- [System Architecture Spec (`docs/SPEC.md`)](docs/SPEC.md)
- [RBAC & Permissions Matrix (`docs/PERMISSIONS.md`)](docs/PERMISSIONS.md)
- [Analytics Metrics Definitions (`docs/ANALYTICS_METRICS.md`)](docs/ANALYTICS_METRICS.md)
- [Notifications Map (`docs/NOTIFICATIONS_MAP.md`)](docs/NOTIFICATIONS_MAP.md)
- [Coverage Report (`docs/COVERAGE_REPORT.md`)](docs/COVERAGE_REPORT.md)
- [Architectural Decisions Log (`docs/DECISIONS.md`)](docs/DECISIONS.md)
- [Project Progress Log (`docs/PROGRESS.md`)](docs/PROGRESS.md)
