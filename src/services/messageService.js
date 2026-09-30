const db = require('../db/index');
const { hasPermission } = require('./permissions');
const notificationService = require('./notificationService');

/**
 * HTML Escaping helper to prevent XSS / HTML injection in chat messages
 */
function escapeHtml(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Audit Logger Helper
 */
function logAudit(actorId, action, targetEntity, targetId = null, detailsObj = {}) {
  try {
    db.prepare(
      'INSERT INTO audit_logs (actor_id, action, target_entity, target_id, details_json) VALUES (?, ?, ?, ?, ?)'
    ).run(actorId, action, targetEntity, targetId, JSON.stringify(detailsObj));
  } catch (err) {
    console.error('[MESSAGING AUDIT LOG ERROR]:', err.message);
  }
}

/**
 * Resolve allowed participants set for thread context
 * Returns { title, participantUserIds, contextSummary } or throws 404/403
 */
function resolveThreadParticipants(contextTypeInput, contextIdInput, targetUserIdInput, actorUser) {
  const contextType = (contextTypeInput || '').toUpperCase().trim();
  const contextId = contextIdInput ? parseInt(contextIdInput, 10) : null;
  const targetUserId = targetUserIdInput ? parseInt(targetUserIdInput, 10) : null;

  // STRICT RULE: Students can NEVER participate in or create any messaging thread
  if (actorUser.role === 'STUDENT') {
    const err = new Error('Access Forbidden: Students are not permitted to use messaging');
    err.statusCode = 404; // 404 per specification for non-participants / unauthorized roles
    throw err;
  }

  const participantUserIds = new Set();
  let title = '';
  let contextSummary = null;

  // --------------------------------------------------------------------------
  // 1. EVENT CONTEXT THREAD
  // --------------------------------------------------------------------------
  if (contextType === 'EVENT') {
    if (!contextId) {
      const err = new Error('Valid event ID is required for EVENT thread');
      err.statusCode = 404;
      throw err;
    }

    const event = db.prepare(`
      SELECT e.*, c.name as club_name, c.club_admin_id
      FROM events e
      JOIN clubs c ON e.club_id = c.id
      WHERE e.id = ?
    `).get(contextId);

    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    // A. Club Admin
    if (event.club_admin_id) {
      participantUserIds.add(event.club_admin_id);
    }

    // B. Assigned Club Faculty Coordinators
    const coordinators = db.prepare('SELECT faculty_user_id FROM club_coordinators WHERE club_id = ?').all(event.club_id);
    coordinators.forEach(c => participantUserIds.add(c.faculty_user_id));

    // C. Club members with MESSAGE_FACULTY permission in this club
    const clubMembers = db.prepare("SELECT user_id FROM club_memberships WHERE club_id = ? AND status = 'APPROVED'").all(event.club_id);
    clubMembers.forEach(m => {
      const memUser = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(m.user_id);
      if (memUser && hasPermission(memUser, 'MESSAGE_FACULTY', { clubId: event.club_id })) {
        participantUserIds.add(memUser.id);
      }
    });

    // D. Admins & Super Admins
    const admins = db.prepare("SELECT id FROM users WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND is_active = 1").all();
    admins.forEach(a => participantUserIds.add(a.id));

    // Security Check: Actor MUST be an allowed participant
    if (!participantUserIds.has(actorUser.id)) {
      const err = new Error('Thread not found or access denied');
      err.statusCode = 404;
      throw err;
    }

    title = `Event Discussion: ${event.title}`;
    contextSummary = {
      type: 'EVENT',
      id: event.id,
      title: event.title,
      clubName: event.club_name,
      date: event.event_date,
      venue: event.venue,
      status: event.status
    };
  }
  // --------------------------------------------------------------------------
  // 2. OD_REQUEST CONTEXT THREAD
  // --------------------------------------------------------------------------
  else if (contextType === 'OD_REQUEST') {
    if (!contextId) {
      const err = new Error('Valid OD request ID is required for OD_REQUEST thread');
      err.statusCode = 404;
      throw err;
    }

    const od = db.prepare(`
      SELECT od.*, er.event_id, e.title as event_title, e.club_id, e.event_date,
             s.ra_number, u_student.full_name as student_name
      FROM od_requests od
      JOIN event_registrations er ON od.registration_id = er.id
      JOIN events e ON er.event_id = e.id
      JOIN students s ON od.student_user_id = s.user_id
      JOIN users u_student ON s.user_id = u_student.id
      WHERE od.id = ?
    `).get(contextId);

    if (!od) {
      const err = new Error('OD Request not found');
      err.statusCode = 404;
      throw err;
    }

    // A. Student's Class Mentor
    if (od.class_mentor_id) {
      participantUserIds.add(od.class_mentor_id);
    }

    // B. Event's Club Faculty Coordinator(s)
    const coordinators = db.prepare('SELECT faculty_user_id FROM club_coordinators WHERE club_id = ?').all(od.club_id);
    coordinators.forEach(c => participantUserIds.add(c.faculty_user_id));

    // C. If escalated -> Admins & Super Admins
    if (od.escalated_at) {
      const admins = db.prepare("SELECT id FROM users WHERE role IN ('ADMIN', 'SUPER_ADMIN') AND is_active = 1").all();
      admins.forEach(a => participantUserIds.add(a.id));
    }

    // STRICT SPEC RULE: Students and Club Admin are NOT participants of OD threads
    // Security Check: Actor MUST be in participant set
    if (!participantUserIds.has(actorUser.id)) {
      const err = new Error('Thread not found or access denied');
      err.statusCode = 404;
      throw err;
    }

    title = `OD Discussion #${od.id}: ${od.student_name} (${od.ra_number})`;
    contextSummary = {
      type: 'OD_REQUEST',
      id: od.id,
      studentName: od.student_name,
      raNumber: od.ra_number,
      eventTitle: od.event_title,
      eventDate: od.event_date,
      status: od.status,
      isEscalated: Boolean(od.escalated_at)
    };
  }
  // --------------------------------------------------------------------------
  // 3. DIRECT THREAD
  // --------------------------------------------------------------------------
  else if (contextType === 'DIRECT') {
    if (!targetUserId) {
      const err = new Error('Target user ID is required for direct messaging');
      err.statusCode = 404;
      throw err;
    }

    const targetUser = db.prepare('SELECT id, full_name, role, is_active FROM users WHERE id = ?').get(targetUserId);
    if (!targetUser || targetUser.is_active !== 1) {
      const err = new Error('Target user not found');
      err.statusCode = 404;
      throw err;
    }

    // Allowed pairs: Faculty <-> Faculty and Faculty <-> Club Admin
    const isActorFaculty = actorUser.role === 'FACULTY';
    const isTargetFaculty = targetUser.role === 'FACULTY';
    const isActorClubAdmin = actorUser.role === 'CLUB_ADMIN';
    const isTargetClubAdmin = targetUser.role === 'CLUB_ADMIN';

    const isValidFacultyFaculty = isActorFaculty && isTargetFaculty;
    const isValidFacultyClubAdmin = (isActorFaculty && isTargetClubAdmin) || (isActorClubAdmin && isTargetFaculty);

    if (!isValidFacultyFaculty && !isValidFacultyClubAdmin) {
      const err = new Error('Direct messaging is restricted to Faculty-Faculty and Faculty-Club Admin pairs');
      err.statusCode = 404;
      throw err;
    }

    participantUserIds.add(actorUser.id);
    participantUserIds.add(targetUser.id);

    title = `Direct: ${actorUser.full_name} & ${targetUser.full_name}`;
    contextSummary = {
      type: 'DIRECT',
      targetUser: { id: targetUser.id, name: targetUser.full_name, role: targetUser.role }
    };
  } else {
    const err = new Error('Invalid context type');
    err.statusCode = 404;
    throw err;
  }

  return {
    title,
    participantUserIds: Array.from(participantUserIds),
    contextSummary
  };
}

/**
 * Get or create a communication thread for a context
 */
function getOrCreateThread(contextTypeInput, contextIdInput, targetUserIdInput, actorUser) {
  const contextType = (contextTypeInput || '').toUpperCase().trim();
  const contextId = contextIdInput ? parseInt(contextIdInput, 10) : null;
  const targetUserId = targetUserIdInput ? parseInt(targetUserIdInput, 10) : null;

  const { title, participantUserIds, contextSummary } = resolveThreadParticipants(contextType, contextId, targetUserId, actorUser);

  let thread;

  if (contextType === 'EVENT' || contextType === 'OD_REQUEST') {
    thread = db.prepare('SELECT * FROM communication_threads WHERE context_type = ? AND context_id = ?').get(contextType, contextId);

    if (!thread) {
      const tx = db.transaction(() => {
        const res = db.prepare(
          'INSERT INTO communication_threads (context_type, context_id, title) VALUES (?, ?, ?)'
        ).run(contextType, contextId, title);

        const newThreadId = res.lastInsertRowid;
        const stmtPart = db.prepare('INSERT INTO thread_participants (thread_id, user_id) VALUES (?, ?)');
        for (const uid of participantUserIds) {
          stmtPart.run(newThreadId, uid);
        }

        return db.prepare('SELECT * FROM communication_threads WHERE id = ?').get(newThreadId);
      });
      thread = tx();
    } else {
      // Refresh participants (ensure newly added admins/coordinators are included)
      const stmtPart = db.prepare('INSERT OR IGNORE INTO thread_participants (thread_id, user_id) VALUES (?, ?)');
      for (const uid of participantUserIds) {
        stmtPart.run(thread.id, uid);
      }
    }
  } else if (contextType === 'DIRECT') {
    // Search for existing DIRECT thread with exact pair
    const p1 = actorUser.id;
    const p2 = targetUserId;

    thread = db.prepare(`
      SELECT t.*
      FROM communication_threads t
      JOIN thread_participants tp1 ON t.id = tp1.thread_id AND tp1.user_id = ?
      JOIN thread_participants tp2 ON t.id = tp2.thread_id AND tp2.user_id = ?
      WHERE t.context_type = 'DIRECT'
    `).get(p1, p2);

    if (!thread) {
      const tx = db.transaction(() => {
        const res = db.prepare(
          'INSERT INTO communication_threads (context_type, context_id, title) VALUES (?, NULL, ?)'
        ).run('DIRECT', title);

        const newThreadId = res.lastInsertRowid;
        db.prepare('INSERT INTO thread_participants (thread_id, user_id) VALUES (?, ?)').run(newThreadId, p1);
        db.prepare('INSERT INTO thread_participants (thread_id, user_id) VALUES (?, ?)').run(newThreadId, p2);

        return db.prepare('SELECT * FROM communication_threads WHERE id = ?').get(newThreadId);
      });
      thread = tx();
    }
  }

  // Ensure actor is in thread_participants
  const isParticipant = db.prepare('SELECT 1 FROM thread_participants WHERE thread_id = ? AND user_id = ?').get(thread.id, actorUser.id);
  if (!isParticipant) {
    const err = new Error('Thread not found or access denied');
    err.statusCode = 404;
    throw err;
  }

  thread.contextSummary = contextSummary;
  return thread;
}

/**
 * Post a message to a thread
 */
function postMessage(threadIdInput, actorUser, messageTextInput) {
  const threadId = parseInt(threadIdInput, 10);
  const text = (messageTextInput || '').trim();

  if (isNaN(threadId) || !threadId) {
    const err = new Error('Valid thread ID is required');
    err.statusCode = 404;
    throw err;
  }

  if (!text || text.length === 0) {
    const err = new Error('Message text cannot be empty');
    err.statusCode = 400;
    throw err;
  }

  if (text.length > 2000) {
    const err = new Error('Message text exceeds maximum limit of 2000 characters');
    err.statusCode = 400;
    throw err;
  }

  // Security check: Actor MUST be in thread_participants
  const isParticipant = db.prepare('SELECT 1 FROM thread_participants WHERE thread_id = ? AND user_id = ?').get(threadId, actorUser.id);
  if (!isParticipant) {
    const err = new Error('Thread not found or access denied');
    err.statusCode = 404;
    throw err;
  }

  const thread = db.prepare('SELECT * FROM communication_threads WHERE id = ?').get(threadId);
  if (!thread) {
    const err = new Error('Thread not found');
    err.statusCode = 404;
    throw err;
  }

  const tx = db.transaction(() => {
    const res = db.prepare(
      'INSERT INTO messages (thread_id, sender_id, message_text, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(threadId, actorUser.id, text);

    const messageId = res.lastInsertRowid;

    // Notify all OTHER participants
    const participants = db.prepare('SELECT user_id FROM thread_participants WHERE thread_id = ? AND user_id != ?').all(threadId, actorUser.id);
    const snippet = text.length > 60 ? text.substring(0, 60) + '...' : text;

    for (const p of participants) {
      notificationService.createNotification(
        p.user_id,
        `New Message: ${thread.title}`,
        `${actorUser.full_name}: "${snippet}"`,
        'MESSAGE',
        `/messages/${threadId}`
      );
    }

    logAudit(actorUser.id, 'MESSAGE_SENT', 'messages', messageId, { threadId, snippet });

    return db.prepare(`
      SELECT m.*, u.full_name as sender_name, u.role as sender_role
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.id = ?
    `).get(messageId);
  });

  const createdMsg = tx();
  createdMsg.message_text_escaped = escapeHtml(createdMsg.message_text);
  return createdMsg;
}

/**
 * List all messages in a thread with HTML escaping
 */
function listMessages(threadIdInput, actorUser) {
  const threadId = parseInt(threadIdInput, 10);
  if (isNaN(threadId) || !threadId) {
    const err = new Error('Valid thread ID is required');
    err.statusCode = 404;
    throw err;
  }

  // Security check: Actor MUST be in thread_participants
  const isParticipant = db.prepare('SELECT 1 FROM thread_participants WHERE thread_id = ? AND user_id = ?').get(threadId, actorUser.id);
  if (!isParticipant) {
    const err = new Error('Thread not found or access denied');
    err.statusCode = 404;
    throw err;
  }

  const thread = db.prepare('SELECT * FROM communication_threads WHERE id = ?').get(threadId);
  if (!thread) {
    const err = new Error('Thread not found');
    err.statusCode = 404;
    throw err;
  }

  const messages = db.prepare(`
    SELECT m.*, u.full_name as sender_name, u.role as sender_role
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE m.thread_id = ?
    ORDER BY m.created_at ASC, m.id ASC
  `).all(threadId);

  // Escape HTML on every message
  messages.forEach(m => {
    m.message_text_escaped = escapeHtml(m.message_text);
  });

  // Fetch Context Summary
  let contextSummary = null;
  if (thread.context_type === 'EVENT' && thread.context_id) {
    const event = db.prepare('SELECT e.*, c.name as club_name FROM events e JOIN clubs c ON e.club_id = c.id WHERE e.id = ?').get(thread.context_id);
    if (event) {
      contextSummary = { type: 'EVENT', id: event.id, title: event.title, clubName: event.club_name, date: event.event_date, venue: event.venue, status: event.status };
    }
  } else if (thread.context_type === 'OD_REQUEST' && thread.context_id) {
    const od = db.prepare(`
      SELECT od.*, e.title as event_title, s.ra_number, u.full_name as student_name
      FROM od_requests od
      JOIN event_registrations er ON od.registration_id = er.id
      JOIN events e ON er.event_id = e.id
      JOIN students s ON od.student_user_id = s.user_id
      JOIN users u ON s.user_id = u.id
      WHERE od.id = ?
    `).get(thread.context_id);
    if (od) {
      contextSummary = { type: 'OD_REQUEST', id: od.id, studentName: od.student_name, raNumber: od.ra_number, eventTitle: od.event_title, status: od.status };
    }
  }

  return {
    thread,
    contextSummary,
    messages
  };
}

/**
 * List all active threads for a user inbox
 */
function getUserThreads(actorUser) {
  if (actorUser.role === 'STUDENT') {
    return [];
  }

  const threads = db.prepare(`
    SELECT t.*,
           (SELECT m.message_text FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) as last_message_text,
           (SELECT m.created_at FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) as last_message_at,
           (SELECT u.full_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) as last_sender_name
    FROM communication_threads t
    JOIN thread_participants tp ON t.id = tp.thread_id
    WHERE tp.user_id = ?
    ORDER BY COALESCE(last_message_at, t.created_at) DESC
  `).all(actorUser.id);

  threads.forEach(t => {
    t.last_message_text_escaped = escapeHtml(t.last_message_text || '');
  });

  return threads;
}

module.exports = {
  escapeHtml,
  resolveThreadParticipants,
  getOrCreateThread,
  postMessage,
  listMessages,
  getUserThreads
};
