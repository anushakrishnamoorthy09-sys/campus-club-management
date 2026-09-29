const { z } = require('zod');
const db = require('../db/index');
const { CLUB_CATALOG_PERMISSIONS, FORBIDDEN_DYNAMIC_PERMISSIONS } = require('./permissions');
const { createNotification } = require('./notificationService');

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
 * Verify if actor is Super Admin or the assigned Club Admin for target club
 */
function verifyClubAdminOwnership(actorUser, clubId) {
  if (!actorUser || !actorUser.role) return false;
  if (actorUser.role === 'SUPER_ADMIN') return true;
  if (actorUser.role === 'CLUB_ADMIN') {
    const club = db.prepare('SELECT id FROM clubs WHERE id = ? AND club_admin_id = ?').get(clubId, actorUser.id);
    return Boolean(club);
  }
  return false;
}

/**
 * Create a new Dynamic Club Role
 */
function createClubRole(actorUser, clubIdInput, inputData) {
  const clubId = parseInt(clubIdInput, 10);

  // 1. IDOR & Ownership Verification
  if (!verifyClubAdminOwnership(actorUser, clubId)) {
    logAudit(actorUser.id, 'DYNAMIC_ROLE_CREATE_DENIED', 'club_roles', null, {
      clubId,
      reason: 'User is not Club Admin of this club'
    });
    const error = new Error('Access Forbidden: You can only manage dynamic roles in your own club');
    error.statusCode = 403;
    throw error;
  }

  const roleName = inputData.roleName ? inputData.roleName.trim() : '';
  const description = inputData.description ? inputData.description.trim() : '';
  const rawPermissions = Array.isArray(inputData.permissionNames)
    ? inputData.permissionNames
    : (inputData.permissionNames ? [inputData.permissionNames] : []);

  if (!roleName || roleName.length < 2) {
    const error = new Error('Role name must be at least 2 characters');
    error.statusCode = 400;
    throw error;
  }

  // 2. Strict Server-Side Catalog Permission Validation
  const requestedPermissions = Array.from(new Set(rawPermissions.map(p => p.trim().toUpperCase())));

  for (const perm of requestedPermissions) {
    if (FORBIDDEN_DYNAMIC_PERMISSIONS.includes(perm) || !CLUB_CATALOG_PERMISSIONS.includes(perm)) {
      logAudit(actorUser.id, 'DYNAMIC_ROLE_PERM_DENIED', 'club_roles', null, {
        clubId,
        attemptedPermission: perm,
        reason: 'Attempted to grant forbidden or non-catalog system permission'
      });
      const error = new Error(`Access Forbidden: Cannot grant forbidden system permission '${perm}' to dynamic club roles`);
      error.statusCode = 403;
      throw error;
    }
  }

  // 3. Name Uniqueness within Club
  const existingRole = db.prepare('SELECT id FROM club_roles WHERE club_id = ? AND role_name = ? COLLATE NOCASE').get(clubId, roleName);
  if (existingRole) {
    const error = new Error(`A dynamic role named '${roleName}' already exists in this club`);
    error.statusCode = 409;
    throw error;
  }

  // 4. Atomic Transaction: Insert Role & Permissions
  const transaction = db.transaction(() => {
    const roleRes = db.prepare(
      'INSERT INTO club_roles (club_id, role_name, description) VALUES (?, ?, ?)'
    ).run(clubId, roleName, description);

    const newRoleId = roleRes.lastInsertRowid;

    if (requestedPermissions.length > 0) {
      const stmtGetPermId = db.prepare('SELECT id FROM permissions WHERE name = ?');
      const stmtInsertRolePerm = db.prepare('INSERT INTO club_role_permissions (club_role_id, permission_id) VALUES (?, ?)');

      for (const permName of requestedPermissions) {
        const permRow = stmtGetPermId.get(permName);
        if (permRow) {
          stmtInsertRolePerm.run(newRoleId, permRow.id);
        }
      }
    }

    logAudit(actorUser.id, 'DYNAMIC_ROLE_CREATED', 'club_roles', newRoleId, {
      clubId,
      roleName,
      grantedPermissions: requestedPermissions
    });

    return {
      id: newRoleId,
      club_id: clubId,
      role_name: roleName,
      permissions: requestedPermissions
    };
  });

  return transaction();
}

/**
 * Update an existing Dynamic Club Role & Permissions
 */
function updateClubRole(actorUser, clubIdInput, roleIdInput, inputData) {
  const clubId = parseInt(clubIdInput, 10);
  const roleId = parseInt(roleIdInput, 10);

  // 1. IDOR & Ownership Verification
  if (!verifyClubAdminOwnership(actorUser, clubId)) {
    logAudit(actorUser.id, 'DYNAMIC_ROLE_UPDATE_DENIED', 'club_roles', roleId, {
      clubId,
      reason: 'User is not Club Admin of this club'
    });
    const error = new Error('Access Forbidden: You can only manage dynamic roles in your own club');
    error.statusCode = 403;
    throw error;
  }

  // 2. Role Belonging Check
  const existingRole = db.prepare('SELECT * FROM club_roles WHERE id = ? AND club_id = ?').get(roleId, clubId);
  if (!existingRole) {
    const error = new Error('Dynamic role not found in this club');
    error.statusCode = 404;
    throw error;
  }

  const roleName = inputData.roleName ? inputData.roleName.trim() : existingRole.role_name;
  const description = inputData.description ? inputData.description.trim() : existingRole.description;
  const rawPermissions = Array.isArray(inputData.permissionNames)
    ? inputData.permissionNames
    : (inputData.permissionNames ? [inputData.permissionNames] : []);

  const requestedPermissions = Array.from(new Set(rawPermissions.map(p => p.trim().toUpperCase())));

  // 3. Strict Server-Side Catalog Permission Validation
  for (const perm of requestedPermissions) {
    if (FORBIDDEN_DYNAMIC_PERMISSIONS.includes(perm) || !CLUB_CATALOG_PERMISSIONS.includes(perm)) {
      logAudit(actorUser.id, 'DYNAMIC_ROLE_PERM_DENIED', 'club_roles', roleId, {
        clubId,
        attemptedPermission: perm,
        reason: 'Attempted to grant forbidden or non-catalog system permission on update'
      });
      const error = new Error(`Access Forbidden: Cannot grant forbidden system permission '${perm}' to dynamic club roles`);
      error.statusCode = 403;
      throw error;
    }
  }

  // 4. Name Uniqueness Check
  if (roleName.toLowerCase() !== existingRole.role_name.toLowerCase()) {
    const nameCheck = db.prepare('SELECT id FROM club_roles WHERE club_id = ? AND role_name = ? COLLATE NOCASE AND id != ?').get(clubId, roleName, roleId);
    if (nameCheck) {
      const error = new Error(`A dynamic role named '${roleName}' already exists in this club`);
      error.statusCode = 409;
      throw error;
    }
  }

  // 5. Atomic Transaction: Update Role Details & Permissions
  const transaction = db.transaction(() => {
    db.prepare('UPDATE club_roles SET role_name = ?, description = ? WHERE id = ?').run(roleName, description, roleId);

    db.prepare('DELETE FROM club_role_permissions WHERE club_role_id = ?').run(roleId);

    if (requestedPermissions.length > 0) {
      const stmtGetPermId = db.prepare('SELECT id FROM permissions WHERE name = ?');
      const stmtInsertRolePerm = db.prepare('INSERT INTO club_role_permissions (club_role_id, permission_id) VALUES (?, ?)');

      for (const permName of requestedPermissions) {
        const permRow = stmtGetPermId.get(permName);
        if (permRow) {
          stmtInsertRolePerm.run(roleId, permRow.id);
        }
      }
    }

    logAudit(actorUser.id, 'DYNAMIC_ROLE_UPDATED', 'club_roles', roleId, {
      clubId,
      roleName,
      grantedPermissions: requestedPermissions
    });

    return {
      id: roleId,
      club_id: clubId,
      role_name: roleName,
      permissions: requestedPermissions
    };
  });

  return transaction();
}

/**
 * Delete Dynamic Club Role (Unassigns members first in transaction)
 */
function deleteClubRole(actorUser, clubIdInput, roleIdInput) {
  const clubId = parseInt(clubIdInput, 10);
  const roleId = parseInt(roleIdInput, 10);

  // 1. IDOR & Ownership Verification
  if (!verifyClubAdminOwnership(actorUser, clubId)) {
    logAudit(actorUser.id, 'DYNAMIC_ROLE_DELETE_DENIED', 'club_roles', roleId, {
      clubId,
      reason: 'User is not Club Admin of this club'
    });
    const error = new Error('Access Forbidden: You can only manage dynamic roles in your own club');
    error.statusCode = 403;
    throw error;
  }

  // 2. Role Belonging Check
  const existingRole = db.prepare('SELECT * FROM club_roles WHERE id = ? AND club_id = ?').get(roleId, clubId);
  if (!existingRole) {
    const error = new Error('Dynamic role not found in this club');
    error.statusCode = 404;
    throw error;
  }

  // 3. Atomic Transaction: Unassign members first, then delete role
  const transaction = db.transaction(() => {
    // Unassign members holding this role
    const unassignRes = db.prepare(
      'UPDATE club_memberships SET club_role_id = NULL WHERE club_id = ? AND club_role_id = ?'
    ).run(clubId, roleId);

    // Delete role
    db.prepare('DELETE FROM club_roles WHERE id = ?').run(roleId);

    logAudit(actorUser.id, 'DYNAMIC_ROLE_DELETED', 'club_roles', roleId, {
      clubId,
      roleName: existingRole.role_name,
      unassignedMembersCount: unassignRes.changes
    });

    return {
      id: roleId,
      role_name: existingRole.role_name,
      unassignedMembersCount: unassignRes.changes
    };
  });

  return transaction();
}

/**
 * Assign / Unassign Dynamic Role to Approved Member
 */
function assignMemberDynamicRole(actorUser, clubIdInput, { membershipIdInput, clubRoleIdInput }) {
  const clubId = parseInt(clubIdInput, 10);
  const membershipId = parseInt(membershipIdInput, 10);
  const clubRoleId = clubRoleIdInput ? parseInt(clubRoleIdInput, 10) : null;

  // 1. IDOR & Ownership Verification
  if (!verifyClubAdminOwnership(actorUser, clubId)) {
    logAudit(actorUser.id, 'MEMBER_ROLE_ASSIGN_DENIED', 'club_memberships', membershipId, {
      clubId,
      reason: 'User is not Club Admin of this club'
    });
    const error = new Error('Access Forbidden: You can only manage member roles in your own club');
    error.statusCode = 403;
    throw error;
  }

  // 2. Member Belonging Check
  const membership = db.prepare(
    'SELECT cm.*, u.full_name, c.name as club_name FROM club_memberships cm JOIN users u ON cm.user_id = u.id JOIN clubs c ON cm.club_id = c.id WHERE cm.id = ? AND cm.club_id = ? AND cm.status = \'APPROVED\''
  ).get(membershipId, clubId);

  if (!membership) {
    const error = new Error('Target user is not an approved member of this club');
    error.statusCode = 400;
    throw error;
  }

  let roleRecord = null;

  if (clubRoleId) {
    // 3. Role Belonging Check
    roleRecord = db.prepare('SELECT * FROM club_roles WHERE id = ? AND club_id = ?').get(clubRoleId, clubId);
    if (!roleRecord) {
      const error = new Error('Selected dynamic role does not belong to this club');
      error.statusCode = 400;
      throw error;
    }
  }

  // 4. Execute Transaction & Send Notification
  const transaction = db.transaction(() => {
    db.prepare('UPDATE club_memberships SET club_role_id = ? WHERE id = ?').run(clubRoleId, membershipId);

    if (roleRecord) {
      createNotification(
        membership.user_id,
        'NEW_ROLE_ASSIGNED',
        `You have been assigned the dynamic role of '${roleRecord.role_name}' in '${membership.club_name}'.`,
        'SYSTEM',
        '/dashboard/student'
      );
    }

    logAudit(actorUser.id, 'MEMBER_DYNAMIC_ROLE_ASSIGNED', 'club_memberships', membershipId, {
      clubId,
      memberUserId: membership.user_id,
      assignedRoleId: clubRoleId,
      assignedRoleName: roleRecord ? roleRecord.role_name : 'UNASSIGNED'
    });

    return {
      membership_id: membershipId,
      user_id: membership.user_id,
      role_name: roleRecord ? roleRecord.role_name : null
    };
  });

  return transaction();
}

/**
 * Get all Dynamic Roles and Members for a specific Club
 */
function getClubRolesAndMembers(clubIdInput) {
  const clubId = parseInt(clubIdInput, 10);

  const roles = db.prepare(`
    SELECT cr.id, cr.role_name, cr.description, cr.created_at
    FROM club_roles cr
    WHERE cr.club_id = ?
    ORDER BY cr.id DESC
  `).all(clubId);

  const stmtPerms = db.prepare(`
    SELECT p.name
    FROM club_role_permissions crp
    JOIN permissions p ON crp.permission_id = p.id
    WHERE crp.club_role_id = ?
  `);

  const rolesWithPerms = roles.map(role => ({
    ...role,
    permissionNames: stmtPerms.all(role.id).map(r => r.name)
  }));

  const members = db.prepare(`
    SELECT 
      cm.id as membership_id,
      cm.user_id,
      cm.status,
      cm.joined_at,
      cm.club_role_id,
      u.full_name,
      u.email,
      cr.role_name
    FROM club_memberships cm
    JOIN users u ON cm.user_id = u.id
    LEFT JOIN club_roles cr ON cm.club_role_id = cr.id
    WHERE cm.club_id = ? AND cm.status = 'APPROVED'
    ORDER BY u.full_name ASC
  `).all(clubId);

  return {
    roles: rolesWithPerms,
    members
  };
}

module.exports = {
  createClubRole,
  updateClubRole,
  deleteClubRole,
  assignMemberDynamicRole,
  getClubRolesAndMembers
};
