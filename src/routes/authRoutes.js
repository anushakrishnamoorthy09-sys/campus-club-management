const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/index');
const { loginUser, registerStudent, completeStudentProfile, logoutUser } = require('../services/authService');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');
const { doubleCsrfProtection, attachCsrfToken } = require('../middleware/csrf');
const { passport, isGoogleConfigured } = require('../config/passport');

const router = express.Router();

// Login Rate Limiter (Max 10 login attempts per 15 min to prevent brute-force enumeration)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' }
});

/**
 * GET /login
 */
router.get('/login', attachCsrfToken, (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  const returnTo = (req.query.returnTo || '').toString();
  res.render('login', {
    title: 'Login - CampusClubOS',
    error: req.query.error || null,
    email: '',
    returnTo: (returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/\\')) ? returnTo : '',
    isGoogleConfigured
  });
});

/**
 * POST /login
 */
router.post('/login', loginLimiter, doubleCsrfProtection, (req, res) => {
  const { email, password, returnTo } = req.body;
  const ipAddress = req.ip || req.socket.remoteAddress;

  try {
    const user = loginUser(email, password, ipAddress);
    const token = signToken(user.id);
    setAuthCookie(res, token);

    let redirectTarget = '/dashboard';
    if (returnTo && typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/\\')) {
      redirectTarget = returnTo;
    }

    if (req.accepts('html')) {
      return res.redirect(redirectTarget);
    }
    return res.json({ message: 'Login successful', user, redirectTarget });
  } catch (err) {
    const statusCode = err.statusCode || 401;
    const returnToVal = (returnTo && typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/\\')) ? returnTo : '';
    if (req.accepts('html')) {
      return res.status(statusCode).render('login', {
        title: 'Login - CampusClubOS',
        error: err.message,
        email: email || '',
        returnTo: returnToVal,
        isGoogleConfigured
      });
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

/**
 * GET /register
 */
router.get('/register', attachCsrfToken, (req, res) => {
  if (req.user) {
    return res.redirect('/');
  }

  // Fetch active Faculty users for Class Mentor selection dropdown
  const facultyMentors = db.prepare(
    `SELECT u.id as faculty_user_id, u.full_name, f.department, f.designation 
     FROM users u 
     JOIN faculty f ON u.id = f.user_id 
     WHERE u.role = 'FACULTY' AND u.is_active = 1
     ORDER BY u.full_name ASC`
  ).all();

  res.render('register', {
    title: 'Student Registration - CampusClubOS',
    error: null,
    formData: {},
    facultyMentors
  });
});

/**
 * POST /register
 */
router.post('/register', loginLimiter, doubleCsrfProtection, (req, res) => {
  // Helper to re-render register view on error
  const renderRegisterError = (errorMessage, statusCode = 400) => {
    const facultyMentors = db.prepare(
      `SELECT u.id as faculty_user_id, u.full_name, f.department, f.designation 
       FROM users u 
       JOIN faculty f ON u.id = f.user_id 
       WHERE u.role = 'FACULTY' AND u.is_active = 1
       ORDER BY u.full_name ASC`
    ).all();

    return res.status(statusCode).render('register', {
      title: 'Student Registration - CampusClubOS',
      error: errorMessage,
      formData: req.body,
      facultyMentors
    });
  };

  try {
    // Strips client-supplied role/is_active inputs for strict security
    const student = registerStudent(req.body);

    // Auto-login upon successful registration
    const token = signToken(student.id);
    setAuthCookie(res, token);

    if (req.accepts('html')) {
      return res.redirect('/');
    }
    return res.status(201).json({ message: 'Registration successful', student });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return renderRegisterError(err.message, statusCode);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

/**
 * GET /auth/google
 * Initiate Google Sign-In (STUDENTS ONLY)
 */
router.get('/auth/google', (req, res, next) => {
  if (!isGoogleConfigured) {
    return res.redirect('/login?error=Google+Sign-In+is+not+configured.+Please+sign+in+with+password.');
  }
  passport.authenticate('google', {
    session: false,
    scope: ['profile', 'email']
  })(req, res, next);
});

/**
 * GET /auth/google/callback
 * Google OAuth Callback
 */
router.get('/auth/google/callback', (req, res, next) => {
  if (!isGoogleConfigured) {
    return res.redirect('/login?error=Google+Sign-In+is+not+configured');
  }

  passport.authenticate('google', { session: false }, (err, user, info) => {
    if (err) {
      console.error('[GOOGLE OAUTH ERROR]:', err);
      return res.redirect('/login?error=Google+authentication+failed');
    }

    if (!user) {
      const errorMsg = info && info.message ? info.message : 'Google authentication failed';
      return res.redirect(`/login?error=${encodeURIComponent(errorMsg)}`);
    }

    // Set JWT Cookie for authenticated Google user
    const token = signToken(user.id);
    setAuthCookie(res, token);

    // Check if Student Profile is complete
    const studentProfile = db.prepare('SELECT id FROM students WHERE user_id = ?').get(user.id);
    if (!studentProfile) {
      return res.redirect('/complete-profile');
    }

    return res.redirect('/dashboard');
  })(req, res, next);
});

/**
 * GET /complete-profile
 * Mandatory Profile Completion View for Google Students
 */
router.get('/complete-profile', requireAuth, attachCsrfToken, (req, res) => {
  if (req.user.role !== 'STUDENT') {
    return res.redirect('/dashboard');
  }

  // If student profile is already complete, redirect to dashboard
  const studentProfile = db.prepare('SELECT id FROM students WHERE user_id = ?').get(req.user.id);
  if (studentProfile) {
    return res.redirect('/dashboard');
  }

  // Fetch active Faculty users for Class Mentor selection dropdown
  const facultyMentors = db.prepare(
    `SELECT u.id as faculty_user_id, u.full_name, f.department, f.designation 
     FROM users u 
     JOIN faculty f ON u.id = f.user_id 
     WHERE u.role = 'FACULTY' AND u.is_active = 1
     ORDER BY u.full_name ASC`
  ).all();

  res.render('complete_profile', {
    title: 'Complete Student Profile - CampusClubOS',
    error: null,
    formData: {},
    facultyMentors
  });
});

/**
 * POST /complete-profile
 * Submit Profile Completion Details
 */
router.post('/complete-profile', requireAuth, loginLimiter, attachCsrfToken, doubleCsrfProtection, (req, res) => {
  const renderProfileError = (errorMessage, statusCode = 400) => {
    const facultyMentors = db.prepare(
      `SELECT u.id as faculty_user_id, u.full_name, f.department, f.designation 
       FROM users u 
       JOIN faculty f ON u.id = f.user_id 
       WHERE u.role = 'FACULTY' AND u.is_active = 1
       ORDER BY u.full_name ASC`
    ).all();

    return res.status(statusCode).render('complete_profile', {
      title: 'Complete Student Profile - CampusClubOS',
      error: errorMessage,
      formData: req.body,
      facultyMentors
    });
  };

  try {
    completeStudentProfile(req.user.id, req.body);

    if (req.accepts('html')) {
      return res.redirect('/dashboard');
    }
    return res.status(200).json({ message: 'Profile completed successfully' });
  } catch (err) {
    const statusCode = err.statusCode || 400;
    if (req.accepts('html')) {
      return renderProfileError(err.message, statusCode);
    }
    return res.status(statusCode).json({ error: err.message });
  }
});

/**
 * POST /logout
 */
router.post('/logout', doubleCsrfProtection, (req, res) => {
  if (req.user) {
    logoutUser(req.user.id);
  }
  clearAuthCookie(res);

  if (req.accepts('html')) {
    return res.redirect('/login');
  }
  return res.json({ message: 'Logged out successfully' });
});

module.exports = router;
