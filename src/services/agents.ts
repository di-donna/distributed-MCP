import type { DB } from '../db.js';
import { HiveError, assertMaxLength, normalizeTags, now, parseJson, randomId } from '../util.js';
import type { User } from './members.js';

export interface Agent {
  id: string;
  user_id: string;
  user_name?: string;
  name: string;
  capabilities: string[];
  note: string | null;
  created_at: number;
  last_seen_at: number;
}

interface AgentRow {
  id: string;
  user_id: string;
  user_name?: string;
  name: string;
  capabilities: string;
  note: string | null;
  created_at: number;
  last_seen_at: number;
}

const toAgent = (r: AgentRow): Agent => ({ ...r, capabilities: parseJson<string[]>(r.capabilities, []) });

const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-/:]{0,59}$/;

export function registerAgent(db: DB, user: User, input: { name: string; capabilities?: string[]; note?: string }): Agent {
  const name = input.name.trim();
  if (!AGENT_NAME_RE.test(name)) throw new HiveError('agent name must be 1-60 characters: letters, digits, spaces, dots, dashes, slashes or colons');
  assertMaxLength('note', input.note, 500);
  const caps = normalizeTags(input.capabilities);
  const ts = now();
  const existing = db.prepare('SELECT * FROM agents WHERE user_id = ? AND name = ?').get(user.id, name) as AgentRow | undefined;
  if (existing) {
    db.prepare('UPDATE agents SET capabilities = ?, note = COALESCE(?, note), last_seen_at = ? WHERE id = ?').run(
      JSON.stringify(input.capabilities ? caps : parseJson<string[]>(existing.capabilities, [])),
      input.note ?? null,
      ts,
      existing.id
    );
    return getAgent(db, existing.id)!;
  }
  const id = randomId('ag', 8);
  db.prepare('INSERT INTO agents (id, user_id, name, capabilities, note, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    user.id,
    name,
    JSON.stringify(caps),
    input.note ?? null,
    ts,
    ts
  );
  return getAgent(db, id)!;
}

export function getAgent(db: DB, id: string): Agent | undefined {
  const row = db
    .prepare('SELECT a.*, u.name AS user_name FROM agents a JOIN users u ON u.id = a.user_id WHERE a.id = ?')
    .get(id) as AgentRow | undefined;
  return row ? toAgent(row) : undefined;
}

export function touchAgent(db: DB, id: string): void {
  db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(now(), id);
}

export function listAgents(db: DB, activeWithinSec?: number): Agent[] {
  const since = activeWithinSec && activeWithinSec > 0 ? now() - activeWithinSec : 0;
  const rows = db
    .prepare('SELECT a.*, u.name AS user_name FROM agents a JOIN users u ON u.id = a.user_id WHERE a.last_seen_at >= ? ORDER BY a.last_seen_at DESC')
    .all(since) as AgentRow[];
  return rows.map(toAgent);
}

/** Resolve the agent a tool call acts as. Falls back to the caller's default agent. Admins may act as any agent. */
export function resolveAgent(db: DB, user: User, agentId?: string | null): Agent {
  if (!agentId) {
    return registerAgent(db, user, { name: 'default' });
  }
  const agent = getAgent(db, agentId);
  if (!agent) throw new HiveError(`agent ${agentId} not found; call agent_register first`, 'not_found');
  if (agent.user_id !== user.id && user.role !== 'admin') {
    throw new HiveError('that agent belongs to another member', 'forbidden');
  }
  touchAgent(db, agent.id);
  return agent;
}
