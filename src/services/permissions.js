const db = require('../db/index');

/**
 * Fixed System-Level Permission Definitions Map
 */
const SYSTEM_PERMISSIONS_MAP = {
  SUPER_ADMIN: [
    '*' // Full global administrative access
  ],
  ADMIN: [
    'CREATE_CLUB_ADMIN',
    'ASSIGN_COORDINATOR',
    'MANAGE_CLUBS',
    'VIEW_ALL_EVENTS',
    'VIEW_ALL_ANALYTICS'
  ],
  FACULTY: [
    'APPROVE_EVENT', // For assigned club
    'APPROVE_OD',    // For assigned mentees
    'VIEW_MENTEES',
    'MESSAGE_FACULTY'
  ],
  CLUB_ADMIN: [
    // Implicitly holds ALL catalog club permissions for their owned club
    'EVENT_CREATE',
    'EVENT_EDIT',
    'EVENT_SUBMIT',
    'VIEW_REGISTRATIONS',
    'MARK_ATTENDANCE',
    'ISSUE_CERTIFICATE',
    'AWARD_BADGE',
    'VIEW_EVENT_ANALYTICS',
    'MESSAGE_FACULTY',
    'MANAGE_DYNAMIC_ROLES'
  ],
  STUDENT: [
    'EVENT_REGISTER',
    'OD_APPLY',
    'VIEW_OWN_CERTIFICATES',
    'VIEW_OWN_BADGES'
  ]
};

/**
 * Permitted Catalog of Club-Level Permissions (for dynamic roles)
 */
const CLUB_CATALOG_PERMISSIONS = [
  'EVENT_CREATE',
  'EVENT_EDIT',
  'EVENT_SUBMIT',
  'VIEW_REGISTRATIONS',
  'MARK_ATTENDANCE',
  'ISSUE_CERTIFICATE',
  'AWARD_BADGE',
  'VIEW_EVENT_ANALYTICS',
  'MESSAGE_FACULTY'
];

/**
 * System-Level Permissions forbidden for dynamic roles
 */
const FORBIDDEN_DYNAMIC_PERMISSIONS = [
  'TIMETABLE_CREATE_EDIT',
  'CREATE_SUPER_ADMIN',
  'CREATE_ADMIN',
  'CREATE_FACULTY',
  'CREATE_CLUB',
  'APPROVE_EVENT',
  'APPROVE_OD',
  'CHANGE_SYSTEM_ROLE'
];

/**
 * Resolve if a user holds a permission globally or within a club scope
 * @param {Object} user - User object from session
 * @param {String} permissionName - Required permission string
 * @param {Object} scope - Scope object { clubId, studentId }
 * @returns {Boolean}
 */
function hasPermission(user, permissionName, scope = {}) {
  if (!user || !user.role || user.is_active !== 1) {
    return false;
  }

  // Super Admin holds all permissions globally
  if (user.role === 'SUPER_ADMIN') {
    return true;
  }

  // Check Fixed System Role Permissions Map
  const rolePermissions = SYSTEM_PERMISSIONS_MAP[user.role] || [];
  if (rolePermissions.includes('*') || rolePermissions.includes(permissionName)) {
    // If permission requires specific club scope (e.g. Club Admin action)
    if (scope.clubId) {
      if (user.role === 'CLUB_ADMIN') {
        // Verify Club Admin owns this specific club
        const club = db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(scope.clubId, user.id);
        return Boolean(club);
      }
    }
    return true;
  }

  // Resolve Club-Specific Dynamic Role Permissions
  if (scope.clubId) {
    // 1. Check if user is Club Admin of this club
    const club = db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(scope.clubId, user.id);
    if (club && CLUB_CATALOG_PERMISSIONS.includes(permissionName)) {
      return true;
    }

    // 2. Query dynamic role permissions for member in this club
    const row = db.prepare(`
      SELECT COUNT(*) as count 
      FROM club_memberships cm
      JOIN club_role_permissions crp ON cm.club_role_id = crp.club_role_id
      JOIN permissions p ON crp.permission_id = p.id
      WHERE cm.user_id = ? 
        AND cm.club_id = ? 
        AND cm.status = 'APPROVED'
        AND p.name = ?
    `).get(user.id, scope.clubId, permissionName);

    return (row && row.count > 0);
  }

  return false;
}

module.exports = {
  SYSTEM_PERMISSIONS_MAP,
  CLUB_CATALOG_PERMISSIONS,
  FORBIDDEN_DYNAMIC_PERMISSIONS,
  hasPermission
};
