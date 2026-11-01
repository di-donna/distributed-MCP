import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listAgents, resolveAgent } from '../../services/agents.js';
import { listDocs } from '../../services/kb.js';
import { tailLogs } from '../../services/logs.js';
import {
  TASK_STATUSES,
  cancelTask,
  claimTask,
  completeTask,
  createTask,
  failTask,
  getTask,
  heartbeatTask,
  listProjects,
  listTasks,
  releaseTask,
  updateTask
} from '../../services/tasks.js';
import { listSessions, sessionProject, type ShareSession } from '../../services/sessions.js';
import { HiveError, normalizeProject } from '../../util.js';
import { defineSessionTool, defineTool, type ToolContext } from '../context.js';

const taskShape = {
  title: z.string().describe('Short imperative title, e.g. "Benchmark tokenizer on 10k docs"'),
  description: z.string().optional().describe('Everything a worker needs: goal, acceptance criteria, where to write results'),
  project: z.string().optional().describe("Optional; must be the session's project, which is the default"),
  priority: z.number().int().min(-100).max(100).optional().describe('Higher is claimed first (default 0)'),
  requires: z.array(z.string()).optional().describe('Capability tags a worker must have, e.g. ["python"]'),
  depends_on: z.array(z.string()).optional().describe('Task ids that must be done first'),
  tags: z.array(z.string()).optional(),
  inputs: z.record(z.string(), z.unknown()).optional().describe('Structured inputs (shard ranges, URLs, parameters)'),
  max_attempts: z.number().int().min(1).max(10).optional().describe('Retries before the task is marked failed (default 3)'),
  lease_seconds: z.number().int().min(30).max(86400).optional().describe('How long a claim lasts without heartbeat (default 900)'),
  parent_id: z.string().optional().describe('Parent task when decomposing a bigger task')
};

export function registerTaskTools(server: McpServer, ctx: ToolContext): void {
  /** A session may only act on tasks in its own project. */
  const requireTaskInSession = (taskId: string, session: ShareSession): void => {
    const task = getTask(ctx.db, taskId);
    if (!task) throw new HiveError(`task ${taskId} not found`, 'not_found');
    if (task.project !== session.project) {
      throw new HiveError(`task ${taskId} belongs to project "${task.project}"; this conversation is shared with "${session.project}" only`, 'wrong_project');
    }
  };

  defineSessionTool(
    server,
    ctx,
    'task_create',
    {
      title: 'Create task',
      description:
        'Add a unit of work to the shared queue so any available agent (yours or a teammate\'s) can claim it. Write the description so a worker with no other context can finish it. Use depends_on to express ordering and requires for capability constraints.',
      input: taskShape
    },
    (args, session) => createTask(ctx.db, ctx.user, { ...args, project: sessionProject(session, args.project) }, session.id)
  );

  defineSessionTool(
    server,
    ctx,
    'task_create_batch',
    {
      title: 'Create tasks (batch)',
      description: 'Create many tasks at once, e.g. when splitting a job into shards. Returns the created task ids in order. All-or-nothing.',
      input: { tasks: z.array(z.object(taskShape)).min(1).max(200) }
    },
    ({ tasks }, session) =>
      ctx.db
        .transaction(() => tasks.map((t) => createTask(ctx.db, ctx.user, { ...t, project: sessionProject(session, t.project) }, session.id)))()
        .map((t) => ({ id: t.id, title: t.title, project: t.project }))
  );

  defineSessionTool(
    server,
    ctx,
    'task_claim',
    {
      title: 'Claim next task',
      description:
        'Atomically claim the highest-priority runnable task (dependencies done, capabilities satisfied) so no other agent works on it. Returns the task, or null when nothing is available. You then hold a lease: call task_heartbeat periodically on long work and finish with task_complete or task_fail. Pass task_id to claim a specific task.',
      input: {
        agent_id: z.string().optional().describe('Your agent id from agent_register (defaults to your "default" agent)'),
        project: z.string().optional().describe("Optional; must be the session's project (claims only ever come from it)"),
        task_id: z.string().optional().describe('Claim this specific task instead of the best available one'),
        capabilities: z.array(z.string()).optional().describe('Override the capabilities registered for the agent'),
        lease_seconds: z.number().int().min(30).max(86400).optional().describe('Override the lease length for this claim')
      }
    },
    ({ agent_id, project, task_id, capabilities, lease_seconds }, session) => {
      const p = sessionProject(session, project);
      const agent = resolveAgent(ctx.db, ctx.user, agent_id);
      const task = claimTask(ctx.db, ctx.user, agent, { project: p, taskId: task_id, capabilities, leaseSeconds: lease_seconds, sessionId: session.id });
      if (!task) {
        const open = listTasks(ctx.db, { project: p, status: 'open', limit: 5 });
        return { claimed: null, agent_id: agent.id, hint: open.length ? `${open.length}+ open tasks exist but are blocked or need other capabilities` : 'no open tasks; check project_status or create some' };
      }
      return { claimed: task, agent_id: agent.id, lease_expires_at: task.lease_expires_at };
    }
  );

  defineSessionTool(
    server,
    ctx,
    'task_heartbeat',
    {
      title: 'Heartbeat task',
      description: 'Extend your lease on a claimed task and optionally record a progress note visible to teammates. Call every few minutes during long work, otherwise the task returns to the pool when the lease expires.',
      input: {
        task_id: z.string(),
        agent_id: z.string().optional(),
        progress: z.string().optional().describe('Short status, e.g. "40% done, 3 shards left"'),
        extend_seconds: z.number().int().min(30).max(86400).optional()
      },
      idempotent: true
    },
    ({ task_id, agent_id, progress, extend_seconds }, session) => {
      requireTaskInSession(task_id, session);
      return heartbeatTask(ctx.db, ctx.user, resolveAgent(ctx.db, ctx.user, agent_id), task_id, progress, extend_seconds);
    }
  );

  defineSessionTool(
    server,
    ctx,
    'task_complete',
    {
      title: 'Complete task',
      description:
        'Mark a task you hold as done and store its result (Markdown or JSON text) where the coordinator and other workers can read it. Set kb_path to also publish the result as a knowledge-base document (recommended for anything others will build on).',
      input: {
        task_id: z.string(),
        result: z.string().describe('The deliverable or a summary of it with pointers'),
        agent_id: z.string().optional(),
        kb_path: z.string().optional().describe('Also save the result as a document at this path'),
        kb_title: z.string().optional(),
        kb_tags: z.array(z.string()).optional(),
        force: z.boolean().optional().describe('Admins only: complete a task held by someone else')
      }
    },
    ({ task_id, result, agent_id, kb_path, kb_title, kb_tags, force }, session) => {
      requireTaskInSession(task_id, session);
      return completeTask(
        ctx.db,
        ctx.user,
        resolveAgent(ctx.db, ctx.user, agent_id),
        task_id,
        { result, kbPath: kb_path, kbTitle: kb_title, kbTags: kb_tags, force, sessionId: session.id },
        ctx.cfg.maxDocBytes
      );
    }
  );

  defineSessionTool(
    server,
    ctx,
    'task_fail',
    {
      title: 'Fail task',
      description: 'Report that a task you hold could not be completed. With retry=true (default) it returns to the pool for another attempt until max_attempts is reached; with retry=false it is marked failed immediately.',
      input: {
        task_id: z.string(),
        error: z.string().describe('What went wrong and what the next worker should know'),
        retry: z.boolean().optional().describe('Default true'),
        agent_id: z.string().optional(),
        force: z.boolean().optional().describe('Admins only: fail a task held by someone else')
      }
    },
    ({ task_id, error, retry, agent_id, force }, session) => {
      requireTaskInSession(task_id, session);
      return failTask(ctx.db, ctx.user, resolveAgent(ctx.db, ctx.user, agent_id), task_id, error, retry ?? true, force ?? false, session.id);
    }
  );

  defineSessionTool(
    server,
    ctx,
    'task_release',
    {
      title: 'Release task',
      description: 'Give a claimed task back to the pool without counting an attempt (e.g. you picked it up but cannot do it). Add a note for the next worker.',
      input: { task_id: z.string(), agent_id: z.string().optional(), note: z.string().optional() }
    },
    ({ task_id, agent_id, note }, session) => {
      requireTaskInSession(task_id, session);
      return releaseTask(ctx.db, ctx.user, resolveAgent(ctx.db, ctx.user, agent_id), task_id, note, session.id);
    }
  );

  defineSessionTool(
    server,
    ctx,
    'task_cancel',
    {
      title: 'Cancel task',
      description: 'Cancel an open, claimed or failed task (creator or admin only).',
      input: { task_id: z.string(), reason: z.string().optional() },
      destructive: true
    },
    ({ task_id, reason }, session) => {
      requireTaskInSession(task_id, session);
      return cancelTask(ctx.db, ctx.user, task_id, reason, session.id);
    }
  );

  defineSessionTool(
    server,
    ctx,
    'task_update',
    {
      title: 'Update task',
      description: 'Edit an open or claimed task: title, description, priority, requires, depends_on, tags or inputs. Omitted fields are unchanged.',
      input: {
        task_id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        requires: z.array(z.string()).optional(),
        depends_on: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        inputs: z.record(z.string(), z.unknown()).optional()
      },
      idempotent: true
    },
    ({ task_id, ...patch }, session) => {
      requireTaskInSession(task_id, session);
      return updateTask(ctx.db, ctx.user, task_id, patch);
    }
  );

  defineTool(
    server,
    'task_get',
    {
      title: 'Get task',
      description: 'Read one task in full, including its result, error, progress note and the last log lines written for it.',
      input: { task_id: z.string() },
      readOnly: true,
      idempotent: true
    },
    ({ task_id }) => {
      const task = getTask(ctx.db, task_id);
      if (!task) throw new HiveError(`task ${task_id} not found`, 'not_found');
      return { ...task, recent_logs: tailLogs(ctx.db, { taskId: task_id, limit: 20 }) };
    }
  );

  defineTool(
    server,
    'task_list',
    {
      title: 'List tasks',
      description: 'List tasks by project, status, tag or holder. Long descriptions/results are truncated; use task_get for full text.',
      input: {
        project: z.string().optional(),
        status: z.enum(TASK_STATUSES).optional(),
        claimed_by: z.string().optional().describe('Agent id'),
        parent_id: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50')
      },
      readOnly: true,
      idempotent: true
    },
    ({ project, status, claimed_by, parent_id, tag, limit }) => listTasks(ctx.db, { project, status, claimedBy: claimed_by, parentId: parent_id, tag, limit })
  );

  defineTool(
    server,
    'project_status',
    {
      title: 'Project status',
      description:
        'Dashboard for one project (or all projects when omitted): task counts by status, who is working on what, which conversations are shared into it, recent findings, and the latest task log lines. Coordinators should poll this to decide what to do next.',
      input: { project: z.string().optional() },
      readOnly: true,
      idempotent: true
    },
    ({ project }) => {
      if (!project) return { projects: listProjects(ctx.db), active_agents: listAgents(ctx.db, 600).map((a) => ({ id: a.id, name: a.name, member: a.user_name })) };
      const p = normalizeProject(project);
      const tasks = listTasks(ctx.db, { project: p, limit: 200 });
      const counts: Record<string, number> = { open: 0, blocked: 0, claimed: 0, done: 0, failed: 0, cancelled: 0 };
      for (const t of tasks) {
        if (t.status === 'open' && t.blocked) counts.blocked!++;
        else counts[t.status] = (counts[t.status] ?? 0) + 1;
      }
      return {
        project: p,
        counts,
        in_progress: tasks.filter((t) => t.status === 'claimed').map((t) => ({ id: t.id, title: t.title, held_by: t.claimed_by_name, progress: t.progress, lease_expires_at: t.lease_expires_at })),
        next_up: tasks.filter((t) => t.status === 'open' && !t.blocked).slice(0, 10).map((t) => ({ id: t.id, title: t.title, priority: t.priority, requires: t.requires })),
        failed: tasks.filter((t) => t.status === 'failed').map((t) => ({ id: t.id, title: t.title, error: t.error })),
        active_sessions: listSessions(ctx.db, ctx.user, { project: p, all: true, activeOnly: true, limit: 20 }, ctx.cfg.sessionIdleHours).map((s) => ({
          member: s.user_name,
          title: s.title,
          started_at: s.created_at,
          last_used_at: s.last_used_at,
          contributions: s.contributions
        })),
        recent_findings: listDocs(ctx.db, { kind: 'finding', project: p, limit: 5 }).map((d) => ({ path: d.path, title: d.title, by: d.updated_by_name, at: d.updated_at })),
        recent_results: listDocs(ctx.db, { kind: 'result', project: p, limit: 5 }).map((d) => ({ path: d.path, title: d.title, by: d.updated_by_name, at: d.updated_at })),
        recent_task_log: tailLogs(ctx.db, { project: p, stream: 'tasks', limit: 15 }).map((l) => ({ ts: l.ts, level: l.level, message: l.message }))
      };
    }
  );
}
