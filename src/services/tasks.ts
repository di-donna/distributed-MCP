import type { DB } from '../db.js';
import { HiveError, assertMaxLength, clampInt, jsonForStorage, normalizeProject, normalizeTags, now, parseJson, randomId } from '../util.js';
import type { Agent } from './agents.js';
import { appendLog } from './logs.js';
import { putDoc } from './kb.js';
import type { User } from './members.js';

export type TaskStatus = 'open' | 'claimed' | 'done' | 'failed' | 'cancelled';
export const TASK_STATUSES: TaskStatus[] = ['open', 'claimed', 'done', 'failed', 'cancelled'];

export interface Task {
  id: string;
  project: string;
  parent_id: string | null;
  title: string;
  description: string;
  inputs: Record<string, unknown>;
  priority: number;
  status: TaskStatus;
  /** Derived: open but waiting on dependencies. */
  blocked?: boolean;
  requires: string[];
  depends_on: string[];
  tags: string[];
  created_by_name: string | null;
  claimed_by: string | null;
  claimed_by_name: string | null;
  claimed_at: number | null;
  lease_seconds: number;
  lease_expires_at: number | null;
  attempts: number;
  max_attempts: number;
  progress: string | null;
  result: string | null;
  result_kb_path: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  /** Share session that created the task (null for pre-0.2 rows). */
  session_id: string | null;
}

interface TaskRow extends Omit<Task, 'inputs' | 'requires' | 'depends_on' | 'tags' | 'blocked'> {
  inputs: string;
  requires: string;
  depends_on: string;
  tags: string;
  created_by: string | null;
}

function toTask(r: TaskRow): Task {
  const { created_by: _createdBy, ...rest } = r;
  return {
    ...rest,
    inputs: parseJson<Record<string, unknown>>(r.inputs, {}),
    requires: parseJson<string[]>(r.requires, []),
    depends_on: parseJson<string[]>(r.depends_on, []),
    tags: parseJson<string[]>(r.tags, [])
  };
}

const BLOCKED_SQL = `EXISTS (
  SELECT 1 FROM json_each(t.depends_on) d LEFT JOIN tasks dt ON dt.id = d.value
  WHERE dt.id IS NULL OR dt.status != 'done')`;

/** Return claimed tasks whose lease ran out to the pool (or fail them when attempts are exhausted). */
export function expireLeases(db: DB): number {
  const ts = now();
  const expired = db.prepare("SELECT id, project, attempts, max_attempts, claimed_by_name FROM tasks WHERE status = 'claimed' AND lease_expires_at < ?").all(ts) as Array<{
    id: string;
    project: string;
    attempts: number;
    max_attempts: number;
    claimed_by_name: string | null;
  }>;
  if (expired.length === 0) return 0;
  const update = db.prepare(
    `UPDATE tasks SET status = ?, error = ?, claimed_by = NULL, claimed_by_name = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'claimed'`
  );
  db.transaction(() => {
    for (const t of expired) {
      const exhausted = t.attempts >= t.max_attempts;
      update.run(exhausted ? 'failed' : 'open', exhausted ? `lease expired ${t.attempts} time(s); no attempts left` : null, ts, t.id);
      appendLog(db, {
        project: t.project,
        stream: 'tasks',
        level: 'warn',
        message: `lease expired on task ${t.id} (held by ${t.claimed_by_name ?? 'unknown'}); ${exhausted ? 'marked failed' : 'returned to the pool'}`,
        taskId: t.id
      });
    }
  })();
  return expired.length;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  project?: string;
  priority?: number;
  requires?: string[];
  depends_on?: string[];
  tags?: string[];
  inputs?: Record<string, unknown>;
  max_attempts?: number;
  lease_seconds?: number;
  parent_id?: string;
}

/** Throw unless the referenced task exists and lives in `project`. */
function requireTaskInProject(db: DB, taskId: string, project: string, what: string): void {
  const row = db.prepare('SELECT project FROM tasks WHERE id = ?').get(taskId) as { project: string } | undefined;
  if (!row) throw new HiveError(`${what} ${taskId} does not exist`, 'not_found');
  if (row.project !== project) throw new HiveError(`${what} ${taskId} belongs to project "${row.project}", not "${project}"`, 'wrong_project');
}

export function createTask(db: DB, user: User, input: CreateTaskInput, sessionId?: string): Task {
  const title = input.title.trim();
  if (!title) throw new HiveError('title is required');
  assertMaxLength('title', title, 200);
  assertMaxLength('description', input.description, 32 * 1024);
  const project = normalizeProject(input.project);
  const dependsOn = [...new Set((input.depends_on ?? []).map((d) => d.trim()).filter(Boolean))];
  for (const dep of dependsOn) requireTaskInProject(db, dep, project, 'depends_on task');
  if (input.parent_id) requireTaskInProject(db, input.parent_id, project, 'parent task');
  const ts = now();
  const id = randomId('task', 8);
  db.prepare(
    `INSERT INTO tasks (id, project, parent_id, title, description, inputs, priority, status, requires, depends_on, tags,
       created_by, created_by_name, lease_seconds, max_attempts, created_at, updated_at, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    project,
    input.parent_id ?? null,
    title,
    input.description ?? '',
    jsonForStorage('inputs', input.inputs ?? {}, 64 * 1024),
    clampInt(input.priority, -100, 100, 0),
    JSON.stringify(normalizeTags(input.requires)),
    JSON.stringify(dependsOn),
    JSON.stringify(normalizeTags(input.tags)),
    user.id,
    user.name,
    clampInt(input.lease_seconds, 30, 24 * 3600, 900),
    clampInt(input.max_attempts, 1, 10, 3),
    ts,
    ts,
    sessionId ?? null
  );
  return getTask(db, id)!;
}

export function getTask(db: DB, id: string): Task | undefined {
  const row = db.prepare(`SELECT t.*, ${BLOCKED_SQL} AS blocked FROM tasks t WHERE t.id = ?`).get(id) as (TaskRow & { blocked: number }) | undefined;
  if (!row) return undefined;
  const task = toTask(row);
  task.blocked = row.status === 'open' && row.blocked === 1;
  return task;
}

export interface ClaimInput {
  project?: string;
  taskId?: string;
  capabilities?: string[];
  leaseSeconds?: number;
  sessionId?: string;
}

/** Atomically claim the best available task for an agent. Returns undefined when nothing is runnable. */
export function claimTask(db: DB, user: User, agent: Agent, input: ClaimInput): Task | undefined {
  expireLeases(db);
  const caps = normalizeTags(input.capabilities ?? agent.capabilities);
  const ts = now();
  return db.transaction(() => {
    const candidate = db
      .prepare(
        `SELECT t.* FROM tasks t
         WHERE t.status = 'open'
           AND (? IS NULL OR t.project = ?)
           AND (? IS NULL OR t.id = ?)
           AND NOT ${BLOCKED_SQL}
           AND NOT EXISTS (SELECT 1 FROM json_each(t.requires) r WHERE r.value NOT IN (SELECT value FROM json_each(?)))
         ORDER BY t.priority DESC, t.created_at ASC LIMIT 1`
      )
      .get(input.project ?? null, input.project ?? null, input.taskId ?? null, input.taskId ?? null, JSON.stringify(caps)) as TaskRow | undefined;
    if (!candidate) {
      if (input.taskId) {
        const t = getTask(db, input.taskId);
        if (!t) throw new HiveError(`task ${input.taskId} not found`, 'not_found');
        if (input.project && t.project !== input.project) {
          throw new HiveError(`task ${input.taskId} belongs to project "${t.project}"; this conversation is shared with "${input.project}" only`, 'wrong_project');
        }
        if (t.status !== 'open') throw new HiveError(`task ${input.taskId} is ${t.status}${t.claimed_by_name ? ` by ${t.claimed_by_name}` : ''}`, 'conflict');
        if (t.blocked) throw new HiveError(`task ${input.taskId} is waiting on dependencies: ${t.depends_on.join(', ')}`, 'conflict');
        throw new HiveError(`task ${input.taskId} requires capabilities [${t.requires.join(', ')}]; this agent has [${caps.join(', ')}]`, 'conflict');
      }
      return undefined;
    }
    const lease = clampInt(input.leaseSeconds, 30, 24 * 3600, candidate.lease_seconds);
    const r = db
      .prepare(
        `UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_by_name = ?, claimed_at = ?, lease_expires_at = ?,
           attempts = attempts + 1, error = NULL, progress = NULL, updated_at = ? WHERE id = ? AND status = 'open'`
      )
      .run(agent.id, `${user.name}/${agent.name}`, ts, ts + lease, ts, candidate.id);
    if (r.changes !== 1) throw new HiveError('claim lost a race; try again', 'conflict');
    appendLog(db, {
      project: candidate.project,
      stream: 'tasks',
      message: `claimed task ${candidate.id} "${candidate.title}" (attempt ${candidate.attempts + 1}/${candidate.max_attempts})`,
      userId: user.id,
      userName: user.name,
      agentId: agent.id,
      agentName: agent.name,
      taskId: candidate.id,
      sessionId: input.sessionId
    });
    return getTask(db, candidate.id);
  })();
}

function requireHeldTask(db: DB, user: User, agent: Agent, taskId: string, force: boolean): Task {
  const task = getTask(db, taskId);
  if (!task) throw new HiveError(`task ${taskId} not found`, 'not_found');
  if (task.status !== 'claimed') throw new HiveError(`task ${taskId} is ${task.status}, not claimed`, 'conflict');
  if (task.claimed_by !== agent.id && !(force && user.role === 'admin')) {
    throw new HiveError(`task ${taskId} is held by ${task.claimed_by_name}, not by this agent`, 'forbidden');
  }
  return task;
}

export function heartbeatTask(db: DB, user: User, agent: Agent, taskId: string, progress?: string, extendSeconds?: number): Task {
  const task = requireHeldTask(db, user, agent, taskId, false);
  assertMaxLength('progress', progress, 2000);
  const ts = now();
  const lease = clampInt(extendSeconds, 30, 24 * 3600, task.lease_seconds);
  db.prepare('UPDATE tasks SET lease_expires_at = ?, progress = COALESCE(?, progress), updated_at = ? WHERE id = ?').run(ts + lease, progress ?? null, ts, taskId);
  return getTask(db, taskId)!;
}

export interface CompleteInput {
  result: string;
  kbPath?: string;
  kbTitle?: string;
  kbTags?: string[];
  force?: boolean;
  sessionId?: string;
}

export function completeTask(db: DB, user: User, agent: Agent, taskId: string, input: CompleteInput, maxDocBytes: number): Task {
  assertMaxLength('result', input.result, 256 * 1024);
  return db.transaction(() => {
    const task = requireHeldTask(db, user, agent, taskId, input.force ?? false);
    let kbPath: string | null = null;
    if (input.kbPath) {
      const doc = putDoc(
        db,
        user,
        {
          path: input.kbPath,
          title: input.kbTitle ?? `Result: ${task.title}`,
          content: input.result,
          kind: 'result',
          project: task.project,
          tags: [...(input.kbTags ?? []), ...task.tags],
          meta: { task_id: task.id, agent: agent.name },
          sessionId: input.sessionId
        },
        maxDocBytes
      );
      kbPath = doc.path;
    }
    const ts = now();
    db.prepare(
      `UPDATE tasks SET status = 'done', result = ?, result_kb_path = ?, error = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?`
    ).run(input.result, kbPath, ts, ts, taskId);
    appendLog(db, {
      project: task.project,
      stream: 'tasks',
      message: `completed task ${task.id} "${task.title}"${kbPath ? ` → kb:${kbPath}` : ''}`,
      userId: user.id,
      userName: user.name,
      agentId: agent.id,
      agentName: agent.name,
      taskId: task.id,
      sessionId: input.sessionId
    });
    return getTask(db, taskId)!;
  })();
}

export function failTask(db: DB, user: User, agent: Agent, taskId: string, error: string, retry: boolean, force = false, sessionId?: string): Task {
  assertMaxLength('error', error, 16 * 1024);
  return db.transaction(() => {
    const task = requireHeldTask(db, user, agent, taskId, force);
    const ts = now();
    const canRetry = retry && task.attempts < task.max_attempts;
    db.prepare(
      `UPDATE tasks SET status = ?, error = ?, claimed_by = NULL, claimed_by_name = NULL, claimed_at = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ? WHERE id = ?`
    ).run(canRetry ? 'open' : 'failed', error, canRetry ? null : ts, ts, taskId);
    appendLog(db, {
      project: task.project,
      stream: 'tasks',
      level: canRetry ? 'warn' : 'error',
      message: `task ${task.id} "${task.title}" failed (attempt ${task.attempts}/${task.max_attempts}): ${error.slice(0, 500)}${canRetry ? ' — returned to the pool' : ''}`,
      userId: user.id,
      userName: user.name,
      agentId: agent.id,
      agentName: agent.name,
      taskId: task.id,
      sessionId
    });
    return getTask(db, taskId)!;
  })();
}

export function releaseTask(db: DB, user: User, agent: Agent, taskId: string, note?: string, sessionId?: string): Task {
  const task = requireHeldTask(db, user, agent, taskId, user.role === 'admin');
  const ts = now();
  db.prepare(
    `UPDATE tasks SET status = 'open', claimed_by = NULL, claimed_by_name = NULL, claimed_at = NULL, lease_expires_at = NULL,
       attempts = MAX(0, attempts - 1), progress = ?, updated_at = ? WHERE id = ?`
  ).run(note ?? null, ts, taskId);
  appendLog(db, {
    project: task.project,
    stream: 'tasks',
    message: `released task ${task.id} back to the pool${note ? `: ${note}` : ''}`,
    userId: user.id,
    userName: user.name,
    agentId: agent.id,
    agentName: agent.name,
    taskId: task.id,
    sessionId
  });
  return getTask(db, taskId)!;
}

export function cancelTask(db: DB, user: User, taskId: string, reason?: string, sessionId?: string): Task {
  const task = getTask(db, taskId);
  if (!task) throw new HiveError(`task ${taskId} not found`, 'not_found');
  if (task.status === 'done' || task.status === 'cancelled') throw new HiveError(`task ${taskId} is already ${task.status}`, 'conflict');
  const row = db.prepare('SELECT created_by FROM tasks WHERE id = ?').get(taskId) as { created_by: string | null };
  if (user.role !== 'admin' && row.created_by !== user.id) throw new HiveError('only the creator or an admin can cancel a task', 'forbidden');
  const ts = now();
  db.prepare(
    `UPDATE tasks SET status = 'cancelled', error = ?, claimed_by = NULL, claimed_by_name = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?`
  ).run(reason ?? 'cancelled', ts, ts, taskId);
  appendLog(db, { project: task.project, stream: 'tasks', message: `cancelled task ${task.id}${reason ? `: ${reason}` : ''}`, userId: user.id, userName: user.name, taskId: task.id, sessionId });
  return getTask(db, taskId)!;
}

export function updateTask(
  db: DB,
  user: User,
  taskId: string,
  patch: { title?: string; description?: string; priority?: number; requires?: string[]; depends_on?: string[]; tags?: string[]; inputs?: Record<string, unknown> }
): Task {
  const task = getTask(db, taskId);
  if (!task) throw new HiveError(`task ${taskId} not found`, 'not_found');
  if (task.status === 'done' || task.status === 'cancelled') throw new HiveError(`task ${taskId} is ${task.status} and cannot be edited`, 'conflict');
  const dependsOn = patch.depends_on ? [...new Set(patch.depends_on.map((d) => d.trim()).filter(Boolean))] : undefined;
  if (dependsOn) {
    for (const dep of dependsOn) {
      if (dep === taskId) throw new HiveError('a task cannot depend on itself');
      requireTaskInProject(db, dep, task.project, 'depends_on task');
    }
  }
  db.prepare(
    `UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), priority = COALESCE(?, priority),
       requires = COALESCE(?, requires), depends_on = COALESCE(?, depends_on), tags = COALESCE(?, tags), inputs = COALESCE(?, inputs), updated_at = ?
     WHERE id = ?`
  ).run(
    patch.title?.trim() || null,
    patch.description ?? null,
    patch.priority === undefined ? null : clampInt(patch.priority, -100, 100, 0),
    patch.requires ? JSON.stringify(normalizeTags(patch.requires)) : null,
    dependsOn ? JSON.stringify(dependsOn) : null,
    patch.tags ? JSON.stringify(normalizeTags(patch.tags)) : null,
    patch.inputs ? jsonForStorage('inputs', patch.inputs, 64 * 1024) : null,
    now(),
    taskId
  );
  return getTask(db, taskId)!;
}

export interface ListTasksFilter {
  project?: string;
  status?: TaskStatus;
  claimedBy?: string;
  parentId?: string;
  tag?: string;
  limit?: number;
}

export function listTasks(db: DB, f: ListTasksFilter): Task[] {
  expireLeases(db);
  const limit = Math.max(1, Math.min(200, f.limit ?? 50));
  const rows = db
    .prepare(
      `SELECT t.*, ${BLOCKED_SQL} AS blocked FROM tasks t
       WHERE (? IS NULL OR t.project = ?)
         AND (? IS NULL OR t.status = ?)
         AND (? IS NULL OR t.claimed_by = ?)
         AND (? IS NULL OR t.parent_id = ?)
         AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?))
       ORDER BY CASE t.status WHEN 'claimed' THEN 0 WHEN 'open' THEN 1 WHEN 'failed' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
                t.priority DESC, t.created_at ASC
       LIMIT ?`
    )
    .all(
      f.project ?? null,
      f.project ?? null,
      f.status ?? null,
      f.status ?? null,
      f.claimedBy ?? null,
      f.claimedBy ?? null,
      f.parentId ?? null,
      f.parentId ?? null,
      f.tag ?? null,
      f.tag?.toLowerCase() ?? null,
      limit
    ) as Array<TaskRow & { blocked: number }>;
  return rows.map((r) => {
    const t = toTask(r);
    t.blocked = r.status === 'open' && r.blocked === 1;
    // Keep list payloads small; full text is available from task_get.
    if (t.description.length > 400) t.description = `${t.description.slice(0, 400)}…`;
    if (t.result && t.result.length > 400) t.result = `${t.result.slice(0, 400)}…`;
    return t;
  });
}

export function listProjects(db: DB): Array<{ project: string; open: number; claimed: number; done: number; failed: number; cancelled: number; docs: number }> {
  expireLeases(db);
  const rows = db
    .prepare(
      `SELECT project,
         SUM(status = 'open') AS open, SUM(status = 'claimed') AS claimed, SUM(status = 'done') AS done,
         SUM(status = 'failed') AS failed, SUM(status = 'cancelled') AS cancelled
       FROM tasks GROUP BY project`
    )
    .all() as Array<{ project: string; open: number; claimed: number; done: number; failed: number; cancelled: number }>;
  const docCounts = new Map(
    (db.prepare('SELECT project, COUNT(*) AS n FROM kb_docs GROUP BY project').all() as Array<{ project: string; n: number }>).map((r) => [r.project, r.n])
  );
  const seen = new Set(rows.map((r) => r.project));
  const out = rows.map((r) => ({ ...r, docs: docCounts.get(r.project) ?? 0 }));
  for (const [project, docs] of docCounts) {
    if (!seen.has(project)) out.push({ project, open: 0, claimed: 0, done: 0, failed: 0, cancelled: 0, docs });
  }
  return out.sort((a, b) => a.project.localeCompare(b.project));
}
