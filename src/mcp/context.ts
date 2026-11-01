import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { User } from '../services/members.js';
import { useSession, type ShareSession } from '../services/sessions.js';
import { HiveError } from '../util.js';

export interface ToolContext {
  db: DB;
  cfg: Config;
  user: User;
  auth: { via: 'oauth' | 'apikey'; clientId: string };
}

export function ok(value: unknown): CallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

export function fail(err: unknown): CallToolResult {
  const message = err instanceof HiveError ? `${err.code}: ${err.message}` : err instanceof Error ? `error: ${err.message}` : 'error';
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export interface ToolSpec<Shape extends z.ZodRawShape> {
  title: string;
  description: string;
  input: Shape;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

/** Register a tool whose handler returns plain data; results and errors are serialised consistently. */
export function defineTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  spec: ToolSpec<Shape>,
  handler: (args: z.output<z.ZodObject<Shape>>) => unknown | Promise<unknown>
): void {
  const annotations: ToolAnnotations = {
    title: spec.title,
    readOnlyHint: spec.readOnly ?? false,
    destructiveHint: spec.destructive ?? false,
    idempotentHint: spec.idempotent ?? false,
    openWorldHint: false
  };
  server.registerTool(name, { title: spec.title, description: spec.description, inputSchema: spec.input, annotations }, (async (args: z.output<z.ZodObject<Shape>>) => {
    try {
      return ok(await handler(args));
    } catch (err) {
      return fail(err);
    }
  }) as never);
}

const SESSION_ID_INPUT = z
  .string()
  .describe("From session_start in THIS conversation. Only conversations the user explicitly shared with a project have one; never invent one or reuse another conversation's.");

/**
 * Register a tool that shares content with the team. It requires the session_id of a conversation the user
 * explicitly shared (session_start); the handler receives the resolved session and must keep writes in its project.
 */
export function defineSessionTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  name: string,
  spec: ToolSpec<Shape>,
  handler: (args: z.output<z.ZodObject<Shape>>, session: ShareSession) => unknown | Promise<unknown>
): void {
  defineTool(
    server,
    name,
    {
      ...spec,
      description: `${spec.description} Requires session_id from session_start (the user must have shared this conversation); writes go only to that session's project.`,
      input: { ...spec.input, session_id: SESSION_ID_INPUT }
    },
    (args) => {
      const { session_id, ...rest } = args as { session_id: string } & Record<string, unknown>;
      return handler(rest as z.output<z.ZodObject<Shape>>, useSession(ctx.db, ctx.user, session_id, ctx.cfg.sessionIdleHours));
    }
  );
}

export function requireAdmin(ctx: ToolContext): void {
  if (ctx.user.role !== 'admin') throw new HiveError('this tool requires the admin role', 'forbidden');
}
