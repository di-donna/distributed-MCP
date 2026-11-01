import type { DB } from '../db.js';
import { HiveError, assertMaxLength, now } from '../util.js';
import type { Agent } from './agents.js';
import type { User } from './members.js';

export interface Message {
  id: number;
  channel: string;
  from_user_name: string | null;
  from_agent: string | null;
  from_agent_name: string | null;
  to_agent: string | null;
  body: string;
  /** Share session that posted it (null for pre-0.2 rows). */
  session_id: string | null;
  ts: number;
}

const CHANNEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,63}$/;
export function normalizeChannel(channel?: string | null): string {
  const c = (channel ?? '').trim();
  if (!c) return 'general';
  if (!CHANNEL_RE.test(c)) throw new HiveError('channel must be 1-64 characters: letters, digits, dots, colons, dashes or underscores');
  return c;
}

export function postMessage(
  db: DB,
  user: User,
  agent: Agent | undefined,
  input: { channel?: string; body: string; toAgent?: string; sessionId?: string }
): Message {
  assertMaxLength('body', input.body, 16 * 1024);
  if (!input.body.trim()) throw new HiveError('body is required');
  const r = db
    .prepare(
      `INSERT INTO messages (channel, from_user, from_user_name, from_agent, from_agent_name, to_agent, body, session_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(normalizeChannel(input.channel), user.id, user.name, agent?.id ?? null, agent?.name ?? null, input.toAgent ?? null, input.body, input.sessionId ?? null, now());
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(r.lastInsertRowid)) as Message;
}

export function readMessages(db: DB, f: { channel?: string; sinceId?: number; forAgent?: string; limit?: number }): Message[] {
  const limit = Math.max(1, Math.min(200, f.limit ?? 50));
  const rows = db
    .prepare(
      `SELECT id, channel, from_user_name, from_agent, from_agent_name, to_agent, body, session_id, ts FROM messages
       WHERE (? IS NULL OR channel = ?)
         AND (? IS NULL OR id > ?)
         AND (to_agent IS NULL OR to_agent = ?)
       ORDER BY id DESC LIMIT ?`
    )
    .all(f.channel ?? null, f.channel ?? null, f.sinceId ?? null, f.sinceId ?? null, f.forAgent ?? '', limit) as Message[];
  return rows.reverse();
}

export function listChannels(db: DB): Array<{ channel: string; messages: number; last_ts: number }> {
  return db
    .prepare('SELECT channel, COUNT(*) AS messages, MAX(ts) AS last_ts FROM messages WHERE to_agent IS NULL GROUP BY channel ORDER BY last_ts DESC LIMIT 100')
    .all() as Array<{ channel: string; messages: number; last_ts: number }>;
}
