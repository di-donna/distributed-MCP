import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { endSession, listSessions, startSession } from '../../services/sessions.js';
import { defineTool, type ToolContext } from '../context.js';

export function registerSessionTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    'session_start',
    {
      title: 'Share this conversation with a project',
      description:
        'Share THIS conversation with one project so it can write to the team workspace. Call it only when the user has explicitly asked, in this conversation, to share it with a project, or when they ran the hive_coordinator or hive_worker prompt. Never call it on your own initiative, and never for unrelated or private conversations. If the project is unclear, ask the user. Returns a session_id that every write tool needs; it only works for writes into this project. Call once per conversation and reuse the id.',
      input: {
        project: z.string().describe('Project to share with, e.g. "tok-bench"'),
        title: z.string().describe('What this conversation is about, as teammates will see it, e.g. "Benchmarking SentencePiece"')
      }
    },
    ({ project, title }) => {
      const s = startSession(ctx.db, ctx.user, { project, title });
      return {
        session_id: s.id,
        project: s.project,
        title: s.title,
        idle_timeout_hours: ctx.cfg.sessionIdleHours,
        note: `Pass session_id to every write in this conversation only; writes go to project "${s.project}". Share only material relevant to that project. Call session_end when the user wants to stop sharing.`
      };
    }
  );

  defineTool(
    server,
    'session_end',
    {
      title: 'Stop sharing this conversation',
      description: 'End a share session: its session_id stops accepting writes. What it already shared stays in the workspace. Call when the user says to stop sharing, or when the shared work is finished.',
      input: { session_id: z.string() },
      idempotent: true
    },
    ({ session_id }) => {
      const s = endSession(ctx.db, ctx.user, session_id);
      return { ended: true, session_id: s.id, project: s.project, ended_at: s.ended_at };
    }
  );

  defineTool(
    server,
    'session_list',
    {
      title: 'List shared conversations',
      description:
        "List share sessions with what each contributed (docs, logs, messages, tasks). Yours by default; all=true shows every member's sessions, e.g. to see which conversations are shared into a project.",
      input: {
        project: z.string().optional(),
        all: z.boolean().optional().describe("Include other members' sessions"),
        active_only: z.boolean().optional().describe('Hide ended and idle-expired sessions'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50')
      },
      readOnly: true,
      idempotent: true
    },
    ({ project, all, active_only, limit }) => listSessions(ctx.db, ctx.user, { project, all, activeOnly: active_only, limit }, ctx.cfg.sessionIdleHours)
  );
}
