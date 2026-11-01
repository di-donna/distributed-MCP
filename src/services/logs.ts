import type { DB } from '../db.js';
import { HiveError, assertMaxLength, jsonForStorage, normalizeProject, now, parseJson } from '../util.js';
import { ftsQuery } from './kb.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface LogEntry {
  id: number;
  project: string;
  stream: string;
  level: LogLevel;
  message: string;
  data: unknown;
  user_name: string | null;
  agent_id: string | null;
  agent_name: string | null;
  task_id: string | null;
  /** Share session that wrote the line (null for system lines and pre-0.2 rows). */
  session_id: string | null;
  ts: number;
}

interface LogRow extends Omit<LogEntry, 'data'> {
  data: string | null;
}

const STREAM_RE = /^[A-Za-z0-9][A-Za-z0-9_.:\-/]{0,63}$/;
export function normalizeStream(stream?: string | null): string {
  const s = (stream ?? '').trim();
  if (!s) return 'general';
  if (!STREAM_RE.test(s)) throw new HiveError('stream must be 1-64 characters: letters, digits, dots, colons, dashes, slashes or underscores');
  return s;
}

export interface AppendLogInput {
  project?: string;
  stream?: string;
  level?: string;
  message: string;
  data?: unknown;
  userId?: string;
  userName?: string;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  sessionId?: string;
}

export function appendLog(db: DB, input: AppendLogInput): LogEntry {
  const level = (input.level ?? 'info').toLowerCase() as LogLevel;
  if (!LOG_LEVELS.includes(level)) throw new HiveError(`level must be one of ${LOG_LEVELS.join(', ')}`);
  assertMaxLength('message', input.message, 16 * 1024);
  if (!input.message.trim()) throw new HiveError('message is required');
  const data = input.data === undefined || input.data === null ? null : jsonForStorage('data', input.data, 64 * 1024);
  const ts = now();
  const r = db
    .prepare(
      `INSERT INTO logs (project, stream, level, message, data, user_id, user_name, agent_id, agent_name, task_id, session_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      normalizeProject(input.project),
      normalizeStream(input.stream),
      level,
      input.message,
      data,
      input.userId ?? null,
      input.userName ?? null,
      input.agentId ?? null,
      input.agentName ?? null,
      input.taskId ?? null,
      input.sessionId ?? null,
      ts
    );
  return getLog(db, Number(r.lastInsertRowid))!;
}

function toEntry(r: LogRow): LogEntry {
  return { ...r, data: parseJson<unknown>(r.data, null) };
}

export function getLog(db: DB, id: number): LogEntry | undefined {
  const row = db.prepare('SELECT * FROM logs WHERE id = ?').get(id) as LogRow | undefined;
  return row ? toEntry(row) : undefined;
}

export interface TailFilter {
  project?: string;
  stream?: string;
  taskId?: string;
  minLevel?: string;
  sinceId?: number;
  sinceTs?: number;
  limit?: number;
}

export function tailLogs(db: DB, f: TailFilter): LogEntry[] {
  const limit = Math.max(1, Math.min(500, f.limit ?? 50));
  const minIdx = f.minLevel ? LOG_LEVELS.indexOf(f.minLevel.toLowerCase() as LogLevel) : 0;
  const allowed = LOG_LEVELS.slice(Math.max(0, minIdx));
  const rows = db
    .prepare(
      `SELECT * FROM logs
       WHERE (? IS NULL OR project = ?)
         AND (? IS NULL OR stream = ?)
         AND (? IS NULL OR task_id = ?)
         AND (? IS NULL OR id > ?)
         AND (? IS NULL OR ts >= ?)
         AND level IN (SELECT value FROM json_each(?))
       ORDER BY id DESC LIMIT ?`
    )
    .all(
      f.project ?? null,
      f.project ?? null,
      f.stream ?? null,
      f.stream ?? null,
      f.taskId ?? null,
      f.taskId ?? null,
      f.sinceId ?? null,
      f.sinceId ?? null,
      f.sinceTs ?? null,
      f.sinceTs ?? null,
      JSON.stringify(allowed),
      limit
    ) as LogRow[];
  return rows.reverse().map(toEntry);
}

export function searchLogs(db: DB, query: string, f: { project?: string; stream?: string; limit?: number }): LogEntry[] {
  const limit = Math.max(1, Math.min(200, f.limit ?? 50));
  const rows = db
    .prepare(
      `SELECT l.* FROM logs_fts JOIN logs l ON l.id = logs_fts.rowid
       WHERE logs_fts MATCH ?
         AND (? IS NULL OR l.project = ?)
         AND (? IS NULL OR l.stream = ?)
       ORDER BY l.id DESC LIMIT ?`
    )
    .all(ftsQuery(query), f.project ?? null, f.project ?? null, f.stream ?? null, f.stream ?? null, limit) as LogRow[];
  return rows.map(toEntry);
}

export function listStreams(db: DB, project?: string): Array<{ stream: string; project: string; entries: number; last_ts: number }> {
  return db
    .prepare(
      `SELECT stream, project, COUNT(*) AS entries, MAX(ts) AS last_ts FROM logs
       WHERE (? IS NULL OR project = ?) GROUP BY project, stream ORDER BY last_ts DESC LIMIT 200`
    )
    .all(project ?? null, project ?? null) as Array<{ stream: string; project: string; entries: number; last_ts: number }>;
}
