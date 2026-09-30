const { z } = require('zod');
const db = require('../db/index');
const { createNotification } = require('./notificationService');

/**
 * Zod Schema for Club Creation
 */
const createClubSchema = z.object({
  name: z.string().trim().min(2, 'Club name must be at least 2 characters'),
  code: z.string().trim().min(2, 'Club code must be at least 2 characters'),
  description: z.string().trim().min(5, 'Description must be at least 5 characters'),
  category: z.string().trim().min(1, 'Category is required'),
  logoUrl: z.string().trim().optional(),
  clubAdminId: z.coerce.number().int().positive('Club Admin selection is required'),
  facultyCoordinatorIds: z.union([
    z.coerce.number().int().positive(),
    z.array(z.coerce.number().int().positive())
  ])
});

/**
 * Zod Schema for Club Update
 */
const updateClubSchema = z.object({
  name: z.string().trim().min(2, 'Club name must be at least 2 characters'),
  description: z.string().trim().min(5, 'Description must be at least 5 characters'),
  category: z.string().trim().min(1, 'Category is required'),
  logoUrl: z.string().trim().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED'], {
    errorMap: () => ({ message: 'Invalid status value' })
  })
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
 * Create a new Campus Club (SUPER_ADMIN ONLY)
 * Runs in an atomic transaction & notifies Club Admin + Coordinators
 */
function createClub(creatorUser, inputData) {
  if (creatorUser.role !== 'SUPER_ADMIN') {
    const error = new Error('Access Forbidden: Only Super Admin can create new campus clubs');
    error.statusCode = 403;
    throw error;
  }

  // 1. Zod Input Validation
  const parseResult = createClubSchema.safeParse(inputData);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const error = new Error(firstIssue.message);
    error.statusCode = 400;
    throw error;
  }

  const data = parseResult.data;
  const normalizedCode = data.code.toUpperCase();
  const coordinatorIds = Array.isArray(data.facultyCoordinatorIds)
    ? data.facultyCoordinatorIds
    : [data.facultyCoordinatorIds];

  // 2. Check Name Uniqueness
  const existingName = db.prepare('SELECT id FROM clubs WHERE name = ? COLLATE NOCASE').get(data.name);
  if (existingName) {
    const error = new Error('A club with this name already exists');
    error.statusCode = 409;
    throw error;
  }

  // 3. Check Code Uniqueness
  const existingCode = db.prepare('SELECT id FROM clubs WHERE code = ?').get(normalizedCode);
  if (existingCode) {
    const error = new Error('A club with this code already exists');
    error.statusCode = 409;
    throw error;
  }

  // 4. Validate Club Admin User
  const clubAdminUser = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(data.clubAdminId);
  if (!clubAdminUser || clubAdminUser.role !== 'CLUB_ADMIN' || clubAdminUser.is_active !== 1) {
    const error = new Error('Selected Club Admin is invalid, inactive, or does not hold the CLUB_ADMIN role');
    error.statusCode = 400;
    throw error;
  }

  // 5. Enforce One-Club-Per-Club-Admin Constraint
  const existingAdminAssignment = db.prepare('SELECT id, name FROM clubs WHERE club_admin_id = ?').get(data.clubAdminId);
  if (existingAdminAssignment) {
    const error = new Error(`Target user is already assigned as Club Admin for '${existingAdminAssignment.name}'`);
    error.statusCode = 409;
    throw error;
  }

  // 6. Validate Faculty Coordinators exist in faculty table
  for (const coordId of coordinatorIds) {
    const facultyCheck = db.prepare('SELECT user_id FROM faculty WHERE user_id = ?').get(coordId);
    if (!facultyCheck) {
      const error = new Error(`Selected Faculty Coordinator (User ID: ${coordId}) is not a valid Faculty user`);
      error.statusCode = 400;
      throw error;
    }
  }

  // 7. Execute Atomic Database Transaction
  const transaction = db.transaction(() => {
    // Insert into clubs
    const clubRes = db.prepare(
      'INSERT INTO clubs (name, code, description, category, logo_url, club_admin_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(data.name, normalizedCode, data.description, data.category, data.logoUrl || null, data.clubAdminId, 'ACTIVE', creatorUser.id);

    const clubId = clubRes.lastInsertRowid;

    // Insert into club_coordinators
    const stmtCoord = db.prepare('INSERT INTO club_coordinators (club_id, faculty_user_id) VALUES (?, ?)');
    for (const coordId of coordinatorIds) {
      stmtCoord.run(clubId, coordId);
    }

    // Insert into club_memberships (bind Club Admin membership)
    db.prepare(
      'INSERT INTO club_memberships (club_id, user_id, status) VALUES (?, ?, ?)'
    ).run(clubId, data.clubAdminId, 'APPROVED');

    // Notify Club Admin
    createNotification(
      data.clubAdminId,
      'Club Admin Assignment',
      `You have been assigned as the Club Admin for '${data.name}'.`,
      'SYSTEM',
      '/dashboard/club-admin'
    );

    // Notify Faculty Coordinators
    for (const coordId of coordinatorIds) {
      createNotification(
        coordId,
        'Faculty Coordinator Assignment',
        `You have been assigned as Faculty Coordinator for '${data.name}'.`,
        'SYSTEM',
        '/dashboard/faculty'
      );
    }

    // Record audit log
    logAudit(creatorUser.id, 'CLUB_CREATED', 'clubs', clubId, {
      name: data.name,
      code: normalizedCode,
      clubAdminId: data.clubAdminId,
      coordinatorIds
    });

    return {
      id: clubId,
      name: data.name,
      code: normalizedCode,
      club_admin_id: data.clubAdminId,
      status: 'ACTIVE'
    };
  });

  return transaction();
}

/**
 * Update Club details (ADMIN or SUPER_ADMIN)
 */
function updateClub(actorUser, clubIdInput, inputData) {
  if (actorUser.role !== 'SUPER_ADMIN' && actorUser.role !== 'ADMIN') {
    const error = new Error('Access Forbidden: Insufficient privileges to update club details');
    error.statusCode = 403;
    throw error;
  }

  const clubId = parseInt(clubIdInput, 10);
  const existingClub = db.prepare('SELECT * FROM clubs WHERE id = ?').get(clubId);
  if (!existingClub) {
    const error = new Error('Club not found');
    error.statusCode = 404;
    throw error;
  }

  // Zod Validation
  const parseResult = updateClubSchema.safeParse(inputData);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    const error = new Error(firstIssue.message);
    error.statusCode = 400;
    throw error;
  }

  const data = parseResult.data;

  // Name uniqueness check if name changed
  if (data.name.toLowerCase() !== existingClub.name.toLowerCase()) {
    const nameCheck = db.prepare('SELECT id FROM clubs WHERE name = ? COLLATE NOCASE AND id != ?').get(data.name, clubId);
    if (nameCheck) {
      const error = new Error('A club with this name already exists');
      error.statusCode = 409;
      throw error;
    }
  }

  db.prepare(
    'UPDATE clubs SET name = ?, description = ?, category = ?, logo_url = ?, status = ? WHERE id = ?'
  ).run(data.name, data.description, data.category, data.logoUrl || null, data.status, clubId);

  logAudit(actorUser.id, 'CLUB_UPDATED', 'clubs', clubId, {
    previousStatus: existingClub.status,
    newStatus: data.status,
    name: data.name
  });

  return {
    id: clubId,
    name: data.name,
    status: data.status
  };
}

/**
 * Assign Club Admin and Faculty Coordinators (ADMIN or SUPER_ADMIN)
 */
function assignClubAdminAndCoordinators(actorUser, clubIdInput, { clubAdminId, facultyCoordinatorIds }) {
  if (actorUser.role !== 'SUPER_ADMIN' && actorUser.role !== 'ADMIN') {
    const error = new Error('Access Forbidden: Insufficient privileges to reassign club personnel');
    error.statusCode = 403;
    throw error;
  }

  const clubId = parseInt(clubIdInput, 10);
  const existingClub = db.prepare('SELECT * FROM clubs WHERE id = ?').get(clubId);
  if (!existingClub) {
    const error = new Error('Club not found');
    error.statusCode = 404;
    throw error;
  }

  const targetAdminId = parseInt(clubAdminId, 10);
  const coordinatorIds = Array.isArray(facultyCoordinatorIds)
    ? facultyCoordinatorIds.map(id => parseInt(id, 10))
    : [parseInt(facultyCoordinatorIds, 10)];

  // Validate Club Admin
  const adminUser = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(targetAdminId);
  if (!adminUser || adminUser.role !== 'CLUB_ADMIN' || adminUser.is_active !== 1) {
    const error = new Error('Selected Club Admin is invalid, inactive, or does not hold the CLUB_ADMIN role');
    error.statusCode = 400;
    throw error;
  }

  // Check One-Club-Per-Admin constraint if changing admin
  if (targetAdminId !== existingClub.club_admin_id) {
    const existingAssignment = db.prepare('SELECT id, name FROM clubs WHERE club_admin_id = ? AND id != ?').get(targetAdminId, clubId);
    if (existingAssignment) {
      const error = new Error(`Target user is already assigned as Club Admin for '${existingAssignment.name}'`);
      error.statusCode = 409;
      throw error;
    }
  }

  // Validate Coordinators
  for (const coordId of coordinatorIds) {
    const facultyCheck = db.prepare('SELECT user_id FROM faculty WHERE user_id = ?').get(coordId);
    if (!facultyCheck) {
      const error = new Error(`Selected Faculty Coordinator (User ID: ${coordId}) is not a valid Faculty user`);
      error.statusCode = 400;
      throw error;
    }
  }

  const transaction = db.transaction(() => {
    // Update club admin
    db.prepare('UPDATE clubs SET club_admin_id = ? WHERE id = ?').run(targetAdminId, clubId);

    // Ensure club membership exists
    const membership = db.prepare('SELECT id FROM club_memberships WHERE club_id = ? AND user_id = ?').get(clubId, targetAdminId);
    if (!membership) {
      db.prepare('INSERT INTO club_memberships (club_id, user_id, status) VALUES (?, ?, ?)').run(clubId, targetAdminId, 'APPROVED');
    }

    // Reassign coordinators
    db.prepare('DELETE FROM club_coordinators WHERE club_id = ?').run(clubId);
    const stmtCoord = db.prepare('INSERT INTO club_coordinators (club_id, faculty_user_id) VALUES (?, ?)');
    for (const coordId of coordinatorIds) {
      stmtCoord.run(clubId, coordId);
    }

    // Send Notifications
    createNotification(
      targetAdminId,
      'Club Admin Assignment',
      `You have been assigned as Club Admin for '${existingClub.name}'.`,
      'SYSTEM',
      '/dashboard/club-admin'
    );

    for (const coordId of coordinatorIds) {
      createNotification(
        coordId,
        'Faculty Coordinator Assignment',
        `You have been assigned as Faculty Coordinator for '${existingClub.name}'.`,
        'SYSTEM',
        '/dashboard/faculty'
      );
    }

    logAudit(actorUser.id, 'CLUB_PERSONNEL_REASSIGNED', 'clubs', clubId, {
      clubAdminId: targetAdminId,
      coordinatorIds
    });
  });

  return transaction();
}

/**
 * Delete a Campus Club (SUPER_ADMIN ONLY)
 */
function deleteClub(actorUser, clubIdInput) {
  if (actorUser.role !== 'SUPER_ADMIN') {
    const error = new Error('Access Forbidden: Only Super Admin can delete campus clubs');
    error.statusCode = 403;
    throw error;
  }

  const clubId = parseInt(clubIdInput, 10);
  const club = db.prepare('SELECT id, name, club_admin_id FROM clubs WHERE id = ?').get(clubId);
  if (!club) {
    const error = new Error('Club not found');
    error.statusCode = 404;
    throw error;
  }

  // Check if club has active members
  const memberCount = db.prepare(
    'SELECT COUNT(*) as count FROM club_memberships WHERE club_id = ? AND user_id != ?'
  ).get(clubId, club.club_admin_id || 0);

  if (memberCount && memberCount.count > 0) {
    const error = new Error(`Action Denied: Cannot delete club '${club.name}' because it has active members`);
    error.statusCode = 400;
    throw error;
  }

  db.prepare('DELETE FROM clubs WHERE id = ?').run(clubId);

  logAudit(actorUser.id, 'CLUB_DELETED', 'clubs', clubId, {
    deletedClubName: club.name
  });

  return { id: clubId, message: `Club '${club.name}' deleted successfully` };
}

/**
 * Get all clubs with joined details
 */
function getAllClubs() {
  const clubs = db.prepare(`
    SELECT 
      c.id,
      c.name,
      c.code,
      c.description,
      c.category,
      c.logo_url,
      c.status,
      c.created_at,
      u.full_name as club_admin_name,
      u.email as club_admin_email,
      c.club_admin_id
    FROM clubs c
    LEFT JOIN users u ON c.club_admin_id = u.id
    ORDER BY c.id DESC
  `).all();

  // Attach Faculty Coordinators list to each club
  const stmtCoords = db.prepare(`
    SELECT u.id as faculty_user_id, u.full_name, f.department, f.designation
    FROM club_coordinators cc
    JOIN users u ON cc.faculty_user_id = u.id
    JOIN faculty f ON u.id = f.user_id
    WHERE cc.club_id = ?
  `);

  return clubs.map(club => ({
    ...club,
    coordinators: stmtCoords.all(club.id)
  }));
}

module.exports = {
  createClubSchema,
  updateClubSchema,
  createClub,
  updateClub,
  assignClubAdminAndCoordinators,
  deleteClub,
  getAllClubs
};
