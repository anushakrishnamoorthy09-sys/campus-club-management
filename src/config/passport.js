const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const db = require('../db/index');

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_CALLBACK_URL
} = process.env;

// Check if credentials exist and are not placeholder default values
const isGoogleConfigured = Boolean(
  GOOGLE_CLIENT_ID &&
  GOOGLE_CLIENT_SECRET &&
  GOOGLE_CALLBACK_URL &&
  GOOGLE_CLIENT_ID !== 'placeholder_google_client_id' &&
  GOOGLE_CLIENT_SECRET !== 'placeholder_google_client_secret'
);

/**
 * Core Google Profile Verification & Matching Logic
 * 1. Staff accounts (SUPER_ADMIN, ADMIN, CLUB_ADMIN, FACULTY) are strictly denied & audit-logged.
 * 2. Existing STUDENT accounts are linked & logged in.
 * 3. New STUDENT accounts are created as pending profiles.
 */
async function verifyGoogleProfile(accessToken, refreshToken, profile, done) {
  try {
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    const googleId = profile.id;
    const displayName = profile.displayName || 'Google Student';

    if (!email) {
      return done(null, false, { message: 'Google account email is missing or not public.' });
    }

    // Search existing user by google_id OR email
    const existingUser = db.prepare(
      'SELECT * FROM users WHERE google_id = ? OR email = ? COLLATE NOCASE'
    ).get(googleId, email);

    if (existingUser) {
      // Rule 2(b): Staff accounts (SUPER_ADMIN, ADMIN, CLUB_ADMIN, FACULTY) can NEVER use Google Sign-In
      if (existingUser.role !== 'STUDENT') {
        try {
          db.prepare(
            'INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json) VALUES (?, ?, ?, ?, ?)'
          ).run(
            existingUser.id,
            'GOOGLE_AUTH_STAFF_DENIED',
            'users',
            existingUser.id,
            JSON.stringify({
              email,
              role: existingUser.role,
              googleId,
              reason: 'Staff account attempted Google Sign-In'
            })
          );
        } catch (auditErr) {
          console.error('[AUDIT LOG ERROR]:', auditErr.message);
        }

        return done(null, false, {
          message: 'Google Sign-In is reserved for students only. Staff accounts must log in with email and password.'
        });
      }

      // Rule 2(a): Link Google ID to existing STUDENT account if not already linked
      if (!existingUser.google_id) {
        db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleId, existingUser.id);
        existingUser.google_id = googleId;
      }

      return done(null, existingUser);
    } else {
      // Rule 2(c): No account exists -> Create pending STUDENT account
      const insertResult = db.prepare(
        'INSERT INTO users (email, password_hash, full_name, role, google_id, is_active) VALUES (?, NULL, ?, ?, ?, 1)'
      ).run(email, displayName, 'STUDENT', googleId);

      const newUserId = insertResult.lastInsertRowid;
      const newUser = db.prepare('SELECT * FROM users WHERE id = ?').get(newUserId);

      try {
        db.prepare(
          'INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json) VALUES (?, ?, ?, ?, ?)'
        ).run(
          newUserId,
          'GOOGLE_STUDENT_CREATED_PENDING',
          'users',
          newUserId,
          JSON.stringify({ email, googleId })
        );
      } catch (auditErr) {
        console.error('[AUDIT LOG ERROR]:', auditErr.message);
      }

      return done(null, newUser);
    }
  } catch (err) {
    return done(err);
  }
}

if (!isGoogleConfigured) {
  console.warn('[GOOGLE OAUTH WARNING]: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing/placeholder in .env. Google Sign-In is disabled.');
} else {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL
      },
      verifyGoogleProfile
    )
  );
}

module.exports = {
  passport,
  isGoogleConfigured,
  verifyGoogleProfile
};
