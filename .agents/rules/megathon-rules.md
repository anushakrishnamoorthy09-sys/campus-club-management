---
trigger: always_on
---

PROJECT: Campus Club Management Platform (36-hour hackathon, solo developer).

STACK (fixed, do not change):
- Node.js + Express, server-rendered EJS views, Tailwind CSS (CDN is fine)
- SQLite3 via better-sqlite3 (ONLY database; no other DB for core data)
- express-session for sessions, bcrypt for passwords, passport-google-oauth20 for student Google Sign-In
- pdfkit + qrcode for certificates

NON-NEGOTIABLE RULES:
1. Every DB connection must run: PRAGMA foreign_keys = ON.
2. All authorization is enforced server-side via one middleware: requirePermission(permission, scopeResolver). Hiding UI is never a substitute.
3. events.status and od_requests.status may ONLY be changed through their service functions (eventService.transition, odService.transition), which validate allowed transitions and the actor's rights.
4. Students can never see or register for an event unless its status is 'approved' (or later published states). Enforce in queries AND in a DB trigger.
5. A student is identified by RA Number: exactly 15 alphanumeric characters, UNIQUE, validated in the app and by a CHECK constraint.
6. Never put real secrets in the repo. Use .env (git-ignored) and maintain .env.example.
7. Business logic lives in /src/services; routes stay thin; SQL lives in services or /src/db.
8. Keep code simple and readable; the developer must be able to explain every part.
9. Do only the task asked. Do not add features or refactor unrelated files.
10. After each task, list the files changed and how to verify the result.

Source of truth documents: /docs/SPEC.md, /docs/PERMISSIONS.md, /db/schema.sql. If code and these conflict, tell me instead of silently deviating.