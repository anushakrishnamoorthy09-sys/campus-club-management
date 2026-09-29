const bcrypt = require('bcrypt');
const { z } = require('zod');
const db = require('../db/index');

/**
 * Zod Schema for User Creation by Super Admin / Admin
 */
const createUserSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters'),
  email: z.string().trim().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['ADMIN', 'FACULTY', 'CLUB_ADMIN'], {
    errorMap: () => ({ message: 'Invalid target role selected' })
  }),
  department: z.string().trim().optional(),
  designation: z.string().trim().optional()
});

/**
 * Audit Logger Helper
 */
function logAudit(actorId, action, targetEntity, targetId = null, detailsObj = {}) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json) VALUES (?, ?, ?, ?, ?)'
    ).run(actorId, action, targetEntity, targetId, JSON.stringify(detailsObj));
  } catch (err) {
    console.error('[AUDIT LOG ERROR]:', err.message);
  }
}

/**
 * Create a new user account with strict server-side role creation matrix
 * @param {Object} creatorUser - Authenticated user object from req.user
 * @param {Object} inputData - Request body data
 */
function createUserByAdmin(creatorUser, inputData) {
  // 1. Zod Validation
  const parseResult = createUserSchema.safeParse(inputData);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const error = new Error(firstIssue.message);
    error.statusCode = 400;
    throw error;
  }

  const data = parseResult.data;

  // 2. Strict Server-Side Creator Role Matrix Enforcement
  if (creatorUser.role === 'ADMIN') {
    if (data.role !== 'CLUB_ADMIN') {
      logAudit(creatorUser.id, 'USER_CREATE_DENIED', 'users', null, {
        attemptedRole: data.role,
        reason: 'ADMIN accounts can only create CLUB_ADMIN accounts'
      });

      const error = new Error('Access Forbidden: Admin accounts are restricted to creating Club Admin accounts only');
      error.statusCode = 403;
      throw error;
    }
  } else if (creatorUser.role !== 'SUPER_ADMIN') {
    const error = new Error('Access Forbidden: Insufficient privileges to create user accounts');
    error.statusCode = 403;
    throw error;
  }

  // 3. Faculty Specific Input Validation
  if (data.role === 'FACULTY') {
    if (!data.department || data.department.trim().length === 0) {
      const error = new Error('Department is required for Faculty accounts');
      error.statusCode = 400;
      throw error;
    }
    if (!data.designation || data.designation.trim().length === 0) {
      const error = new Error('Designation is required for Faculty accounts');
      error.statusCode = 400;
      throw error;
    }
  }

  // 4. Check Email Uniqueness
  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(data.email);
  if (existingEmail) {
    const error = new Error('Email address is already registered');
    error.statusCode = 409;
    throw error;
  }

  // 5. Execute Atomic Database Transaction
  const hash = bcrypt.hashSync(data.password, 10);

  const transaction = db.transaction(() => {
    const userRes = db.prepare(
      'INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, 1)'
    ).run(data.email, hash, data.fullName, data.role);

    const newUserId = userRes.lastInsertRowid;

    if (data.role === 'FACULTY') {
      db.prepare(
        'INSERT INTO faculty (user_id, department, designation) VALUES (?, ?, ?)'
      ).run(newUserId, data.department, data.designation);
    }

    logAudit(creatorUser.id, 'USER_CREATED_BY_ADMIN', 'users', newUserId, {
      createdEmail: data.email,
      assignedRole: data.role,
      creatorRole: creatorUser.role
    });

    return {
      id: newUserId,
      email: data.email,
      full_name: data.fullName,
      role: data.role
    };
  });

  return transaction();
}

/**
 * Toggle user account active status (SUPER_ADMIN ONLY)
 * Prevents self-deactivation.
 */
function toggleUserActiveStatus(actorUser, targetUserIdInput, newIsActiveInput) {
  if (actorUser.role !== 'SUPER_ADMIN') {
    const error = new Error('Access Forbidden: Only Super Admin can deactivate/reactivate accounts');
    error.statusCode = 403;
    throw error;
  }

  const targetUserId = parseInt(targetUserIdInput, 10);
  const newIsActive = Number(newIsActiveInput) === 1 ? 1 : 0;

  // Self-deactivation prevention
  if (actorUser.id === targetUserId) {
    const error = new Error('Action Denied: You cannot deactivate your own Super Admin account');
    error.statusCode = 400;
    throw error;
  }

  const targetUser = db.prepare('SELECT id, email, role, is_active FROM users WHERE id = ?').get(targetUserId);
  if (!targetUser) {
    const error = new Error('Target user account not found');
    error.statusCode = 404;
    throw error;
  }

  db.prepare('UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newIsActive, targetUserId);

  logAudit(actorUser.id, 'USER_STATUS_TOGGLED', 'users', targetUserId, {
    previousStatus: targetUser.is_active,
    newStatus: newIsActive,
    userEmail: targetUser.email
  });

  return {
    id: targetUserId,
    email: targetUser.email,
    is_active: newIsActive
  };
}

/**
 * Get all users with profile metadata
 */
function getAllUsers() {
  const users = db.prepare(`
    SELECT 
      u.id, 
      u.email, 
      u.full_name, 
      u.role, 
      u.is_active, 
      u.created_at,
      f.department as faculty_department,
      f.designation as faculty_designation,
      s.ra_number,
      s.department as student_department,
      s.year_of_study,
      s.section
    FROM users u
    LEFT JOIN faculty f ON u.id = f.user_id
    LEFT JOIN students s ON u.id = s.user_id
    ORDER BY u.id DESC
  `).all();

  return users;
}

/**
 * Fetch Faculty users list for assignment dropdowns
 */
function getFacultyUsers() {
  return db.prepare(`
    SELECT u.id as faculty_user_id, u.full_name, f.department, f.designation
    FROM users u
    JOIN faculty f ON u.id = f.user_id
    WHERE u.role = 'FACULTY' AND u.is_active = 1
    ORDER BY u.full_name ASC
  `).all();
}

/**
 * Fetch Club Admin users list for assignment dropdowns
 */
function getClubAdminUsers() {
  return db.prepare(`
    SELECT u.id, u.full_name, u.email, c.name as assigned_club_name
    FROM users u
    LEFT JOIN clubs c ON u.id = c.club_admin_id
    WHERE u.role = 'CLUB_ADMIN' AND u.is_active = 1
    ORDER BY u.full_name ASC
  `).all();
}

module.exports = {
  createUserSchema,
  createUserByAdmin,
  toggleUserActiveStatus,
  getAllUsers,
  getFacultyUsers,
  getClubAdminUsers
};
