import type { DB } from '../db.js';
import type { User } from './members.js';
import { HiveError, assertMaxLength, normalizeProject, now, randomId } from '../util.js';

/**
 * A share session is one conversation that its member explicitly shared with one project.
 * Every write tool requires its id, so conversations that were never shared cannot write,
 * and a shared one can only write into its own project.
 */
export interface ShareSession {
  id: string;
  user_id: string;
  project: string;
  title: string;
  created_at: number;
  last_used_at: number;
  ended_at: number | null;
}

export interface SessionSummary extends ShareSession {
  user_name: string;
  active: boolean;
  contributions: { docs: number; logs: number; messages: number; tasks: number };
}

export const SESSION_PREFIX = 'ses';

/** Meta key the server sets on knowledge-base documents written from a session. */
export const SESSION_META_KEY = 'shared_from_session';

function isActive(s: ShareSession, idleHours: number, ts = now()): boolean {
  return s.ended_at === null && ts - s.last_used_at <= idleHours * 3600;
}

export function startSession(db: DB, user: User, input: { project: string; title: string }): ShareSession {
  const title = input.title.trim();
  if (!title) throw new HiveError('title is required: say what this conversation is about');
  assertMaxLength('title', title, 200);
  const ts = now();
  const session: ShareSession = { id: randomId(SESSION_PREFIX), user_id: user.id, project: normalizeProject(input.project), title, created_at: ts, last_used_at: ts, ended_at: null };
  db.prepare('INSERT INTO share_sessions (id, user_id, project, title, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    session.id,
    session.user_id,
    session.project,
    session.title,
    session.created_at,
    session.last_used_at
  );
  return session;
}

export function getSession(db: DB, id: string): ShareSession | undefined {
  return db.prepare('SELECT * FROM share_sessions WHERE id = ?').get(id) as ShareSession | undefined;
}

/** Resolve a session for a write: it must belong to the caller, be open, and not be idle-expired. Refreshes last use. */
export function useSession(db: DB, user: User, sessionId: string, idleHours: number): ShareSession {
  const s = getSession(db, sessionId.trim());
  if (!s || s.user_id !== user.id) {
    throw new HiveError('unknown session_id. Writes need a session this conversation started with session_start, and only when the user asked to share it', 'no_session');
  }
  if (s.ended_at !== null) throw new HiveError(`session ${s.id} was ended; ask the user whether to share this conversation again (session_start)`, 'session_ended');
  const ts = now();
  if (!isActive(s, idleHours, ts)) {
    throw new HiveError(`session ${s.id} expired after ${idleHours}h without use; ask the user whether to share this conversation again (session_start)`, 'session_expired');
  }
  db.prepare('UPDATE share_sessions SET last_used_at = ? WHERE id = ?').run(ts, s.id);
  return { ...s, last_used_at: ts };
}

/** Throw unless `project` (when given) is the session's project; returns the project to write to. */
export function sessionProject(session: ShareSession, project?: string | null): string {
  if (project !== undefined && project !== null && project.trim() !== '' && normalizeProject(project) !== session.project) {
    throw new HiveError(`this conversation is shared with project "${session.project}" only; it cannot write to "${normalizeProject(project)}"`, 'wrong_project');
  }
  return session.project;
}

export function endSession(db: DB, user: User, sessionId: string): ShareSession {
  const s = getSession(db, sessionId.trim());
  if (!s || (s.user_id !== user.id && user.role !== 'admin')) throw new HiveError('unknown session_id', 'not_found');
  if (s.ended_at === null) {
    const ts = now();
    db.prepare('UPDATE share_sessions SET ended_at = ? WHERE id = ?').run(ts, s.id);
    return { ...s, ended_at: ts };
  }
  return s;
}

export function listSessions(
  db: DB,
  user: User,
  opts: { project?: string; all?: boolean; activeOnly?: boolean; limit?: number },
  idleHours: number
): SessionSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.all) {
    where.push('s.user_id = ?');
    params.push(user.id);
  }
  if (opts.project) {
    where.push('s.project = ?');
    params.push(normalizeProject(opts.project));
  }
  if (opts.activeOnly) {
    where.push('s.ended_at IS NULL AND s.last_used_at >= ?');
    params.push(now() - idleHours * 3600);
  }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const rows = db
    .prepare(
      `SELECT s.*, u.name AS user_name,
         (SELECT COUNT(*) FROM kb_docs d WHERE json_extract(d.meta, '$.${SESSION_META_KEY}') = s.id) AS docs,
         (SELECT COUNT(*) FROM logs l WHERE l.session_id = s.id) AS logs,
         (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messages,
         (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id) AS tasks
       FROM share_sessions s JOIN users u ON u.id = s.user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.last_used_at DESC LIMIT ?`
    )
    .all(...params) as Array<ShareSession & { user_name: string; docs: number; logs: number; messages: number; tasks: number }>;
  const ts = now();
  return rows.map(({ docs, logs, messages, tasks, ...s }) => ({ ...s, active: isActive(s, idleHours, ts), contributions: { docs, logs, messages, tasks } }));
}
