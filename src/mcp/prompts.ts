import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './context.js';

const text = (t: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: t } }] });

export function registerPrompts(server: McpServer, ctx: ToolContext): void {
  server.registerPrompt(
    'hive_worker',
    {
      title: 'Work as a hive worker',
      description: 'Turn this session into a worker that repeatedly claims tasks from the shared queue, does them, logs progress and posts results until the queue is empty.',
      argsSchema: {
        project: z.string().optional().describe('Project to pull tasks from (omit for any)'),
        agent_name: z.string().optional().describe('Name for this worker agent'),
        capabilities: z.string().optional().describe('Comma-separated capability tags, e.g. "python,browser"')
      }
    },
    ({ project, agent_name, capabilities }) =>
      text(
        `You are one worker in a team of agents sharing the "${ctx.cfg.teamName}" workspace (member: ${ctx.user.name}). Work the shared task queue until it is empty.

Setup:
1. Call agent_register with name "${agent_name ?? 'worker'}" and capabilities [${(capabilities ?? '').split(',').map((c) => `"${c.trim()}"`).filter((c) => c !== '""').join(', ')}]. Keep the returned agent_id.
2. Call hive_overview${project ? ` and project_status for project "${project}"` : ''} to understand what is going on.

Loop:
3. task_claim${project ? ` (project "${project}")` : ''}. If it returns null, read msg_read and project_status once more; if there is still nothing, stop and report what you did.
4. Before doing the task, kb_search for its topic so you reuse what teammates already found. Read relevant documents with kb_get.
5. Do the work. While working: log_append progress to a stream named after the task or project; task_heartbeat at least every 5 minutes with a progress note; finding_post any discrete insight immediately.
6. Finish with task_complete (put the full deliverable in result, and set kb_path like "results/<project>/<task-slug>.md" so others can read it) or task_fail with a precise error. Never leave a task claimed.
7. Post a one-line msg_post to the project channel saying what you finished, then go back to step 3.

Rules: do not duplicate work that kb_search shows is done; prefer small frequent log lines over one big summary; if a task is unclear, task_release it with a note rather than guessing.`
      )
  );

  server.registerPrompt(
    'hive_coordinator',
    {
      title: 'Coordinate a distributed job',
      description: 'Decompose a goal into parallel tasks for the team, monitor progress, and synthesise the results.',
      argsSchema: {
        project: z.string().describe('Project name to file tasks under'),
        goal: z.string().describe('What the team should achieve')
      }
    },
    ({ project, goal }) =>
      text(
        `You are the coordinator for project "${project}" in the "${ctx.cfg.teamName}" workspace. Goal: ${goal}

1. kb_search and kb_list (project "${project}") to see what already exists; read anything relevant.
2. Write the plan to the knowledge base at "projects/${project}/plan.md" with kb_put: the goal, how you split it, and where results should go.
3. Decompose the goal into independent tasks sized for 10-60 minutes of agent work each. Use task_create_batch. Give each task a self-contained description (inputs, acceptance criteria, output path "results/${project}/<slug>.md"), capability requirements in requires, and depends_on for ordering. Create a final "synthesise results" task that depends on all of them.
4. Post to msg_post channel "${project}": what the project is and that tasks are available. Workers (teammates' Claude sessions using the hive_worker prompt) will claim them.
5. Monitor with project_status and log_tail (stream "tasks"). Re-create or task_update tasks that fail; answer questions in msg_read; add tasks as results reveal more work.
6. When everything is done, read the results (kb_list prefix "results/${project}"), write the synthesis to "projects/${project}/summary.md", and post the conclusion as finding_post.

If you also have spare capacity, you may claim and execute tasks yourself with task_claim.`
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
        `Brief me on the "${ctx.cfg.teamName}" workspace${project ? ` for project "${project}"` : ''} over the last ${hours} hours. Use: hive_overview, project_status${project ? ` ("${project}")` : ''}, finding_list (updated_since ${since}), kb_list (updated_since ${since}), log_tail (since_ts ${since}, min_level warn), msg_read. Then write a concise briefing: headline findings, results delivered, what is in progress and by whom, what is blocked or failed, open questions in the chat, and suggested next actions.`
      );
    }
  );
}
