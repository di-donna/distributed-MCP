import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveAgent } from '../../services/agents.js';
import { LOG_LEVELS, appendLog, listStreams, searchLogs, tailLogs } from '../../services/logs.js';
import { postMessage, readMessages } from '../../services/messages.js';
import { defineTool, type ToolContext } from '../context.js';

export function registerLogTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    'log_append',
    {
      title: 'Append log',
      description:
        'Append a line to a shared, append-only log stream (e.g. "experiments", "crawler", "deploy"). Use it for progress, measurements, errors and decisions so teammates can follow and debug your work. Attach structured data when useful.',
      input: {
        message: z.string(),
        stream: z.string().optional().describe('Stream name (default "general")'),
        level: z.enum(LOG_LEVELS).optional().describe('debug | info | warn | error (default info)'),
        project: z.string().optional(),
        data: z.unknown().optional().describe('Structured payload (JSON), up to 64 KB'),
        task_id: z.string().optional().describe('Task this line relates to'),
        agent_id: z.string().optional()
      }
    },
    ({ message, stream, level, project, data, task_id, agent_id }) => {
      const agent = resolveAgent(ctx.db, ctx.user, agent_id);
      return appendLog(ctx.db, { message, stream, level, project, data, taskId: task_id, userId: ctx.user.id, userName: ctx.user.name, agentId: agent.id, agentName: agent.name });
    }
  );

  defineTool(
    server,
    'log_tail',
    {
      title: 'Tail log',
      description: 'Read the latest lines of a log stream (oldest-to-newest). Pass since_id from your last read to poll for new lines only.',
      input: {
        stream: z.string().optional(),
        project: z.string().optional(),
        task_id: z.string().optional(),
        min_level: z.enum(LOG_LEVELS).optional().describe('Hide lines below this level'),
        since_id: z.number().int().optional().describe('Only lines with id greater than this'),
        since_ts: z.number().int().optional().describe('Only lines at or after this unix time'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50')
      },
      readOnly: true,
      idempotent: true
    },
    ({ stream, project, task_id, min_level, since_id, since_ts, limit }) => tailLogs(ctx.db, { stream, project, taskId: task_id, minLevel: min_level, sinceId: since_id, sinceTs: since_ts, limit })
  );

  defineTool(
    server,
    'log_search',
    {
      title: 'Search logs',
      description: 'Full-text search over all log lines, newest first.',
      input: { query: z.string(), stream: z.string().optional(), project: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
      readOnly: true,
      idempotent: true
    },
    ({ query, stream, project, limit }) => searchLogs(ctx.db, query, { stream, project, limit })
  );

  defineTool(
    server,
    'log_streams',
    {
      title: 'List log streams',
      description: 'List log streams with entry counts and last activity.',
      input: { project: z.string().optional() },
      readOnly: true,
      idempotent: true
    },
    ({ project }) => listStreams(ctx.db, project)
  );

  defineTool(
    server,
    'msg_post',
    {
      title: 'Post message',
      description:
        'Post a short message to a team channel (default "general") so humans and other agents see it, or send a direct message to one agent with to_agent. Use for coordination: "taking shards 1-4", "API is rate limiting, back off", questions for the coordinator.',
      input: {
        body: z.string(),
        channel: z.string().optional().describe('Channel name; project names make good channels'),
        to_agent: z.string().optional().describe('Agent id for a direct message'),
        agent_id: z.string().optional().describe('Which of your agents is speaking')
      }
    },
    ({ body, channel, to_agent, agent_id }) => postMessage(ctx.db, ctx.user, resolveAgent(ctx.db, ctx.user, agent_id), { body, channel, toAgent: to_agent })
  );

  defineTool(
    server,
    'msg_read',
    {
      title: 'Read messages',
      description: 'Read channel messages plus any direct messages addressed to your agent (oldest-to-newest). Poll with since_id to get only new messages.',
      input: {
        channel: z.string().optional().describe('Omit to read all channels'),
        since_id: z.number().int().optional(),
        agent_id: z.string().optional().describe('Include direct messages for this agent'),
        limit: z.number().int().min(1).max(200).optional()
      },
      readOnly: true,
      idempotent: true
    },
    ({ channel, since_id, agent_id, limit }) => readMessages(ctx.db, { channel, sinceId: since_id, forAgent: resolveAgent(ctx.db, ctx.user, agent_id).id, limit })
  );
}
