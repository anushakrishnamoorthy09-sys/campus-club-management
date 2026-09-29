const jwt = require('jsonwebtoken');
const db = require('../db/index');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_12345';
const COOKIE_NAME = 'token';

/**
 * Sign JWT containing ONLY user ID
 */
function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Set HttpOnly, SameSite=Lax authentication cookie
 */
function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
}

/**
 * Clear authentication cookie
 */
function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
}

/**
 * Middleware: Extract JWT, verify, query DB for user & role
 */
function loadUserSession(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  req.user = null;
  res.locals.user = null;

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || !decoded.userId) {
      clearAuthCookie(res);
      return next();
    }

    // Query User from Database to ensure real-time role & active status validation
    const user = db.prepare('SELECT id, email, full_name, role, is_active FROM users WHERE id = ?').get(decoded.userId);

    if (!user || user.is_active !== 1) {
      // Inactive or deleted user -> Invalidate session
      clearAuthCookie(res);
      return next();
    }

    // Attach student profile details if user is STUDENT
    if (user.role === 'STUDENT') {
      const studentProfile = db.prepare('SELECT id as student_profile_id, ra_number, department, year_of_study, section, class_mentor_id FROM students WHERE user_id = ?').get(user.id);
      if (studentProfile) {
        Object.assign(user, studentProfile);
        user.is_profile_complete = true;
      } else {
        user.is_profile_complete = false;
      }
    }

    // Attach faculty profile details if user is FACULTY
    if (user.role === 'FACULTY') {
      const facultyProfile = db.prepare('SELECT id as faculty_profile_id, department, designation FROM faculty WHERE user_id = ?').get(user.id);
      if (facultyProfile) {
        Object.assign(user, facultyProfile);
      }
    }

    req.user = user;
    res.locals.user = user;
    next();
  } catch (err) {
    // Malformed or expired token
    clearAuthCookie(res);
    next();
  }
}

/**
 * Require Authentication Middleware
 * Redirects HTML requests to /login, returns 401 JSON for API requests
 */
function requireAuth(req, res, next) {
  if (req.user) {
    return next();
  }

  if (req.accepts('html') && req.method === 'GET') {
    return res.redirect('/login');
  }

  return res.status(401).json({ error: 'Authentication required' });
}

/**
 * Enforce Profile Completion for Google Students
 * Redirects incomplete student profiles to /complete-profile
 */
function enforceProfileCompletion(req, res, next) {
  if (req.user && req.user.role === 'STUDENT' && req.user.is_profile_complete === false) {
    const allowedPaths = ['/complete-profile', '/logout', '/login'];
    if (!allowedPaths.includes(req.path)) {
      if (req.accepts('html') && req.method === 'GET') {
        return res.redirect('/complete-profile');
      }
      return res.status(403).json({
        error: 'Student profile completion required',
        redirectUrl: '/complete-profile'
      });
    }
  }
  next();
}

module.exports = {
  signToken,
  setAuthCookie,
  clearAuthCookie,
  loadUserSession,
  requireAuth,
  enforceProfileCompletion
};
