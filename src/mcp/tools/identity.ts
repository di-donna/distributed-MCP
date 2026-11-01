import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listAgents, registerAgent } from '../../services/agents.js';
import { kbStats } from '../../services/kb.js';
import { listStreams } from '../../services/logs.js';
import { listChannels } from '../../services/messages.js';
import { listProjects } from '../../services/tasks.js';
import { defineTool, type ToolContext } from '../context.js';

export function registerIdentityTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    'hive_whoami',
    {
      title: 'Who am I',
      description: 'Return the member you are acting as, your role, how you authenticated, and the agents registered for you. Call this once at the start of a session.',
      input: {},
      readOnly: true,
      idempotent: true
    },
    () => ({
      member: { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role },
      authenticated_via: ctx.auth.via,
      workspace: ctx.cfg.teamName,
      agents: listAgents(ctx.db).filter((a) => a.user_id === ctx.user.id)
    })
  );

  defineTool(
    server,
    'hive_overview',
    {
      title: 'Workspace overview',
      description:
        'Snapshot of the whole shared workspace: projects with task counts, agents active in the last 10 minutes, knowledge-base statistics, log streams and chat channels. Good first call when joining ongoing work.',
      input: {},
      readOnly: true,
      idempotent: true
    },
    () => ({
      workspace: ctx.cfg.teamName,
      projects: listProjects(ctx.db),
      active_agents: listAgents(ctx.db, 600).map((a) => ({ id: a.id, name: a.name, member: a.user_name, capabilities: a.capabilities, last_seen_at: a.last_seen_at })),
      knowledge_base: kbStats(ctx.db),
      log_streams: listStreams(ctx.db).slice(0, 20),
      channels: listChannels(ctx.db)
    })
  );

  defineTool(
    server,
    'agent_register',
    {
      title: 'Register agent',
      description:
        'Register (or update) the agent identity you will work as, with a name and capability tags (e.g. ["research","python","browser"]). Tasks can require capabilities; task_claim only hands you tasks you are capable of. Returns agent_id for use in task tools. Re-registering with the same name updates it.',
      input: {
        name: z.string().describe('Short agent name, unique per member, e.g. "claude-code-laptop" or "researcher-1"'),
        capabilities: z.array(z.string()).optional().describe('Capability tags this agent offers'),
        note: z.string().optional().describe('Free-form note shown to teammates, e.g. what machine/tools you have')
      },
      idempotent: true
    },
    ({ name, capabilities, note }) => registerAgent(ctx.db, ctx.user, { name, capabilities, note })
  );

  defineTool(
    server,
    'agent_list',
    {
      title: 'List agents',
      description: 'List agents across all members, most recently active first. Use active_within_seconds to see who is working right now.',
      input: {
        active_within_seconds: z.number().int().positive().optional().describe('Only agents seen within this many seconds')
      },
      readOnly: true,
      idempotent: true
    },
    ({ active_within_seconds }) => listAgents(ctx.db, active_within_seconds)
  );
}
