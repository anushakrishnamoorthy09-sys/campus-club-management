const bcrypt = require('bcrypt');
const { z } = require('zod');
const db = require('../db/index');

// Zod Schema for Student Registration
const studentRegistrationSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters'),
  email: z.string().trim().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  raNumber: z.string().trim().regex(/^[A-Za-z0-9]{15}$/, 'RA Number must be exactly 15 alphanumeric characters'),
  department: z.string().trim().min(1, 'Department is required'),
  yearOfStudy: z.coerce.number().int().min(1, 'Year of study must be between 1 and 5').max(5, 'Year of study must be between 1 and 5'),
  section: z.string().trim().min(1, 'Section is required'),
  classMentorId: z.coerce.number().int().positive('Class Mentor selection is required')
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
 * Authenticate user with email and password
 */
function loginUser(email, password, ipAddress = '') {
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);

  if (!user || user.is_active !== 1) {
    // Record failed login attempt against system user or candidate ID
    const auditActor = user ? user.id : 1;
    logAudit(auditActor, 'LOGIN_FAILED', 'users', user ? user.id : null, { email, ipAddress, reason: 'USER_NOT_FOUND_OR_INACTIVE' });
    
    const error = new Error('Invalid email or password');
    error.statusCode = 401;
    throw error;
  }

  const isPasswordValid = bcrypt.compareSync(password, user.password_hash);
  if (!isPasswordValid) {
    logAudit(user.id, 'LOGIN_FAILED', 'users', user.id, { email, ipAddress, reason: 'INVALID_PASSWORD' });
    
    const error = new Error('Invalid email or password');
    error.statusCode = 401;
    throw error;
  }

  // Record successful login
  logAudit(user.id, 'LOGIN_SUCCESS', 'users', user.id, { email, ipAddress });

  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role
  };
}

/**
 * Register a new student account (Atomic Transaction)
 */
function registerStudent(inputData) {
  // 1. Zod Input Validation
  const parseResult = studentRegistrationSchema.safeParse(inputData);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const error = new Error(firstIssue.message);
    error.statusCode = 400;
    throw error;
  }

  const data = parseResult.data;
  // Normalize RA Number to UPPERCASE
  const normalizedRa = data.raNumber.toUpperCase();

  // 2. Check Email Uniqueness
  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(data.email);
  if (existingEmail) {
    const error = new Error('Email address is already registered');
    error.statusCode = 409;
    throw error;
  }

  // 3. Check RA Number Uniqueness
  const existingRa = db.prepare('SELECT id FROM students WHERE ra_number = ?').get(normalizedRa);
  if (existingRa) {
    const error = new Error('RA Number is already registered');
    error.statusCode = 409;
    throw error;
  }

  // 4. Verify Class Mentor is a valid Faculty User
  const facultyUser = db.prepare('SELECT user_id FROM faculty WHERE user_id = ?').get(data.classMentorId);
  if (!facultyUser) {
    const error = new Error('Selected Class Mentor is invalid');
    error.statusCode = 400;
    throw error;
  }

  // 5. Execute Atomic Database Transaction
  const hash = bcrypt.hashSync(data.password, 10);

  const registerTransaction = db.transaction(() => {
    // Insert into users (role is ALWAYS 'STUDENT')
    const userRes = db.prepare(
      'INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, 1)'
    ).run(data.email, hash, data.fullName, 'STUDENT');

    const newUserId = userRes.lastInsertRowid;

    // Insert into students profile
    db.prepare(
      'INSERT INTO students (user_id, ra_number, department, year_of_study, section, class_mentor_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(newUserId, normalizedRa, data.department, data.yearOfStudy, data.section, data.classMentorId);

    // Write audit log
    logAudit(newUserId, 'STUDENT_REGISTERED', 'students', newUserId, {
      raNumber: normalizedRa,
      department: data.department
    });

    return {
      id: newUserId,
      email: data.email,
      full_name: data.fullName,
      role: 'STUDENT',
      ra_number: normalizedRa
    };
  });

  return registerTransaction();
}

/**
 * Zod Schema for Google Student Profile Completion
 */
const profileCompletionSchema = z.object({
  raNumber: z.string().trim().regex(/^[A-Za-z0-9]{15}$/, 'RA Number must be exactly 15 alphanumeric characters'),
  department: z.string().trim().min(1, 'Department is required'),
  yearOfStudy: z.coerce.number().int().min(1, 'Year of study must be between 1 and 5').max(5, 'Year of study must be between 1 and 5'),
  section: z.string().trim().min(1, 'Section is required'),
  classMentorId: z.coerce.number().int().positive('Class Mentor selection is required')
});

/**
 * Complete Google Student Profile
 */
function completeStudentProfile(userId, inputData) {
  // 1. Zod Validation
  const parseResult = profileCompletionSchema.safeParse(inputData);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const error = new Error(firstIssue.message);
    error.statusCode = 400;
    throw error;
  }

  const data = parseResult.data;
  const normalizedRa = data.raNumber.toUpperCase();

  // 2. Verify User exists and is STUDENT
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.role !== 'STUDENT') {
    const error = new Error('Only student accounts can complete a student profile');
    error.statusCode = 403;
    throw error;
  }

  // 3. Check if profile already completed
  const existingProfile = db.prepare('SELECT id FROM students WHERE user_id = ?').get(userId);
  if (existingProfile) {
    const error = new Error('Student profile is already complete');
    error.statusCode = 400;
    throw error;
  }

  // 4. Check RA Number Uniqueness
  const existingRa = db.prepare('SELECT id FROM students WHERE ra_number = ?').get(normalizedRa);
  if (existingRa) {
    const error = new Error('RA Number is already registered');
    error.statusCode = 409;
    throw error;
  }

  // 5. Verify Class Mentor is a valid Faculty User
  const facultyUser = db.prepare('SELECT user_id FROM faculty WHERE user_id = ?').get(data.classMentorId);
  if (!facultyUser) {
    const error = new Error('Selected Class Mentor is invalid');
    error.statusCode = 400;
    throw error;
  }

  // 6. Insert Student Profile
  db.prepare(
    'INSERT INTO students (user_id, ra_number, department, year_of_study, section, class_mentor_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, normalizedRa, data.department, data.yearOfStudy, data.section, data.classMentorId);

  logAudit(userId, 'STUDENT_PROFILE_COMPLETED', 'students', userId, {
    raNumber: normalizedRa,
    department: data.department
  });

  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: 'STUDENT',
    ra_number: normalizedRa
  };
}

/**
 * Log out user session
 */
function logoutUser(userId) {
  if (userId) {
    logAudit(userId, 'LOGOUT', 'users', userId);
  }
}

module.exports = {
  studentRegistrationSchema,
  profileCompletionSchema,
  loginUser,
  registerStudent,
  completeStudentProfile,
  logoutUser,
  logAudit
};
