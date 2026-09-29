const { doubleCsrf } = require('csrf-csrf');
require('dotenv').config();

const { doubleCsrfProtection, generateToken } = doubleCsrf({
  getSecret: () => process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_production_12345',
  cookieName: 'x-csrf-token',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  },
  size: 64,
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
  getTokenFromRequest: (req) => req.body._csrf || req.headers['x-csrf-token']
});

/**
 * Middleware: Generates a CSRF token for res.locals so EJS forms can render <input type="hidden" name="_csrf" value="<%= csrfToken %>">
 */
function attachCsrfToken(req, res, next) {
  try {
    const token = generateToken(req, res);
    res.locals.csrfToken = token;
  } catch (e) {
    res.locals.csrfToken = '';
  }
  next();
}

module.exports = {
  doubleCsrfProtection,
  attachCsrfToken
};
