import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { User } from '../services/members.js';
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

export function requireAdmin(ctx: ToolContext): void {
  if (ctx.user.role !== 'admin') throw new HiveError('this tool requires the admin role', 'forbidden');
}
