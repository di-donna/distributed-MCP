import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

const text = (t: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: t } }] });

export function registerPrompts(server: McpServer, ctx: ToolContext): void {
  server.registerPrompt(
    'hive_worker',
    {
      title: 'Work as a hive worker',
      description:
        "Share this conversation with a project and turn it into a worker that repeatedly claims the project's tasks, does them, logs progress and posts results until the queue is empty.",
      argsSchema: {
        project: z.string().describe('Project to share this conversation with and pull tasks from'),
        agent_name: z.string().optional().describe('Name for this worker agent'),
        capabilities: z.string().optional().describe('Comma-separated capability tags, e.g. "python,browser"')
      }
    },
    ({ project, agent_name, capabilities }) =>
      text(
        `You are one worker in a team of agents sharing the "${ctx.cfg.teamName}" workspace (member: ${ctx.user.name}). By running this prompt the user shares this conversation with project "${project}". Work that project's task queue until it is empty.

Setup:
1. Call session_start with project "${project}" and a short title (e.g. "worker: ${agent_name ?? 'worker'}"). Keep the returned session_id and pass it to every write below.
2. Call agent_register with name "${agent_name ?? 'worker'}" and capabilities [${(capabilities ?? '').split(',').map((c) => `"${c.trim()}"`).filter((c) => c !== '""').join(', ')}]. Keep the returned agent_id.
3. Call project_status for project "${project}" to understand what is going on.

Loop:
4. task_claim. If it returns null, read msg_read (channel "${project}") and project_status once more; if there is still nothing, stop and report what you did.
5. Before doing the task, kb_search (project "${project}") for its topic so you reuse what teammates already found. Read relevant documents with kb_get.
6. Do the work. While working: log_append progress to a stream named after the task; task_heartbeat at least every 5 minutes with a progress note; finding_post any discrete insight about the project immediately.
7. Finish with task_complete (put the full deliverable in result, and set kb_path like "results/${project}/<task-slug>.md" so others can read it) or task_fail with a precise error. Never leave a task claimed.
8. Post a one-line msg_post saying what you finished, then go back to step 4.
9. When you stop, call session_end.

Rules: share only work on "${project}"; do not duplicate work that kb_search shows is done; prefer small frequent log lines over one big summary; if a task is unclear, task_release it with a note rather than guessing.`
      )
  );

  server.registerPrompt(
    'hive_coordinator',
    {
      title: 'Coordinate a distributed job',
      description: 'Share this conversation with a project, decompose a goal into parallel tasks for the team, monitor progress, and synthesise the results.',
      argsSchema: {
        project: z.string().describe('Project to share this conversation with and file tasks under'),
        goal: z.string().describe('What the team should achieve')
      }
    },
    ({ project, goal }) =>
      text(
        `You are the coordinator for project "${project}" in the "${ctx.cfg.teamName}" workspace. By running this prompt the user shares this conversation with project "${project}". Goal: ${goal}

1. Call session_start with project "${project}" and title "coordinator: ${goal.slice(0, 80).replace(/"/g, "'")}". Keep the session_id and pass it to every write below.
2. kb_search and kb_list (project "${project}") to see what already exists; read anything relevant.
3. Write the plan to the knowledge base at "projects/${project}/plan.md" with kb_put: the goal, how you split it, and where results should go.
4. Decompose the goal into independent tasks sized for 10-60 minutes of agent work each. Use task_create_batch. Give each task a self-contained description (inputs, acceptance criteria, output path "results/${project}/<slug>.md"), capability requirements in requires, and depends_on for ordering. Create a final "synthesise results" task that depends on all of them.
5. msg_post what the project is and that tasks are available. Workers (teammates' Claude sessions running the hive_worker prompt for "${project}") will claim them.
6. Monitor with project_status and log_tail (project "${project}", stream "tasks"). Re-create or task_update tasks that fail; answer questions in msg_read (channel "${project}"); add tasks as results reveal more work.
7. When everything is done, read the results (kb_list prefix "results/${project}"), write the synthesis to "projects/${project}/summary.md", post the conclusion as finding_post, and call session_end.

If you also have spare capacity, you may claim and execute tasks yourself with task_claim. Share only work on "${project}".`
      )
  );

  server.registerPrompt(
    'hive_briefing',
    {
      title: 'Catch me up',
      description: 'Summarise what the team has done recently: findings, results, open tasks, blockers and chatter.',
      argsSchema: { project: z.string().optional().describe('Limit to one project'), since_hours: z.string().optional().describe('Look-back window in hours (default 24)') }
    },
    ({ project, since_hours }) => {
      const hours = Number.parseFloat(since_hours ?? '24') || 24;
      const since = Math.floor(Date.now() / 1000 - hours * 3600);
      return text(
        `Brief me on the "${ctx.cfg.teamName}" workspace${project ? ` for project "${project}"` : ''} over the last ${hours} hours. This is read-only: do not start a session or write anything. Use: hive_overview, project_status${project ? ` ("${project}")` : ''}, finding_list (updated_since ${since}), kb_list (updated_since ${since}), log_tail (since_ts ${since}, min_level warn), msg_read. Then write a concise briefing: headline findings, results delivered, what is in progress and by whom, what is blocked or failed, open questions in the chat, and suggested next actions.`
      );
    }
  );
}
