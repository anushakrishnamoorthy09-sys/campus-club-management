const db = require('../db/index');
const { hasPermission } = require('../services/permissions');

/**
 * Log denied authorization attempts to audit_logs
 */
function logAccessDenied(actorId, path, method, details) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (actor_id, action, target_entity, details_json) VALUES (?, ?, ?, ?)'
    ).run(actorId || 1, 'ACCESS_DENIED', 'route', JSON.stringify({ path, method, ...details }));
  } catch (err) {
    console.error('[AUDIT LOG DENIAL ERROR]:', err.message);
  }
}

/**
 * Require one or more fixed system roles
 * @param  {...String} roles - Allowed system roles
 */
function requireRole(...roles) {
  const middleware = (req, res, next) => {
    if (!req.user) {
      if (req.accepts('html') && req.method === 'GET') {
        return res.redirect('/login');
      }
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Super Admin has global override capability unless strictly scoped
    if (req.user.role === 'SUPER_ADMIN' || roles.includes(req.user.role)) {
      return next();
    }

    // Log denied attempt
    logAccessDenied(req.user.id, req.originalUrl, req.method, {
      userRole: req.user.role,
      requiredRoles: roles
    });

    res.status(403);
    if (req.accepts('html') && req.method === 'GET') {
      return res.render('403', { title: '403 - Forbidden' });
    }
    return res.json({ error: 'Access Forbidden: Insufficient privileges' });
  };

  // Annotate guard metadata for route audit tooling
  middleware.__guardType = 'requireRole';
  middleware.__roles = roles;
  return middleware;
}

/**
 * Require fine-grained permission with optional dynamic scope resolver
 * @param {String} permissionName - Required permission name
 * @param {Function} scopeResolver - Optional (req) => { clubId, studentId }
 */
function requirePermission(permissionName, scopeResolver = null) {
  const middleware = (req, res, next) => {
    if (!req.user) {
      if (req.accepts('html') && req.method === 'GET') {
        return res.redirect('/login');
      }
      return res.status(401).json({ error: 'Authentication required' });
    }

    const scope = scopeResolver ? scopeResolver(req) : {};
    const permitted = hasPermission(req.user, permissionName, scope);

    if (permitted) {
      return next();
    }

    // Log denied attempt
    logAccessDenied(req.user.id, req.originalUrl, req.method, {
      userRole: req.user.role,
      requiredPermission: permissionName,
      scope
    });

    res.status(403);
    if (req.accepts('html') && req.method === 'GET') {
      return res.render('403', { title: '403 - Forbidden' });
    }
    return res.json({ error: `Access Forbidden: Missing permission '${permissionName}'` });
  };

  // Annotate guard metadata for route audit tooling
  middleware.__guardType = 'requirePermission';
  middleware.__permission = permissionName;
  return middleware;
}

/**
 * Scope Helper: Extracts clubId from params, query or body
 */
function requireClubScope(req) {
  const clubId = req.params.clubId || req.params.id || req.query.clubId || req.body.clubId;
  return { clubId: clubId ? parseInt(clubId, 10) : null };
}

/**
 * Scope Guard: Ensures user is Faculty Coordinator for target club (or Admin/Super Admin)
 */
function requireCoordinatorOf(clubIdResolver) {
  const middleware = (req, res, next) => {
    if (!req.user) {
      if (req.accepts('html') && req.method === 'GET') {
        return res.redirect('/login');
      }
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'ADMIN') {
      return next();
    }

    const clubId = typeof clubIdResolver === 'function' ? clubIdResolver(req) : req.params.clubId;
    if (req.user.role === 'FACULTY' && clubId) {
      const coordinator = db.prepare(
        'SELECT id FROM club_coordinators WHERE club_id = ? AND faculty_user_id = ?'
      ).get(clubId, req.user.id);

      if (coordinator) {
        return next();
      }
    }

    logAccessDenied(req.user.id, req.originalUrl, req.method, {
      reason: 'NOT_CLUB_FACULTY_COORDINATOR',
      clubId
    });

    res.status(403);
    if (req.accepts('html') && req.method === 'GET') {
      return res.render('403', { title: '403 - Forbidden' });
    }
    return res.json({ error: 'Access Forbidden: Must be assigned Faculty Coordinator for this club' });
  };

  middleware.__guardType = 'requireCoordinatorOf';
  return middleware;
}

/**
 * Scope Guard: Ensures user is Class Mentor for target student (or Admin/Super Admin)
 */
function requireMentorOf(studentIdResolver) {
  const middleware = (req, res, next) => {
    if (!req.user) {
      if (req.accepts('html') && req.method === 'GET') {
        return res.redirect('/login');
      }
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (req.user.role === 'SUPER_ADMIN' || req.user.role === 'ADMIN') {
      return next();
    }

    const studentUserId = typeof studentIdResolver === 'function' ? studentIdResolver(req) : req.params.studentId;
    if (req.user.role === 'FACULTY' && studentUserId) {
      const student = db.prepare(
        'SELECT id FROM students WHERE user_id = ? AND class_mentor_id = ?'
      ).get(studentUserId, req.user.id);

      if (student) {
        return next();
      }
    }

    logAccessDenied(req.user.id, req.originalUrl, req.method, {
      reason: 'NOT_ASSIGNED_CLASS_MENTOR',
      studentUserId
    });

    res.status(403);
    if (req.accepts('html') && req.method === 'GET') {
      return res.render('403', { title: '403 - Forbidden' });
    }
    return res.json({ error: 'Access Forbidden: Must be assigned Class Mentor for this student' });
  };

  middleware.__guardType = 'requireMentorOf';
  return middleware;
}

module.exports = {
  requireRole,
  requirePermission,
  requireClubScope,
  requireCoordinatorOf,
  requireMentorOf
};
