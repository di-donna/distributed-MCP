import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from '../config.js';
import type { ToolContext } from './context.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerAdminTools } from './tools/admin.js';
import { registerIdentityTools } from './tools/identity.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerLogTools } from './tools/logs.js';
import { registerTaskTools } from './tools/tasks.js';

/** Build an MCP server bound to one authenticated member. Cheap enough to do per request. */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'hive', title: `${ctx.cfg.teamName} shared workspace`, version: VERSION },
    {
      instructions: `This connector is a shared workspace for a team of people and their Claude agents (you are acting as member "${ctx.user.name}"). It holds a versioned knowledge base (kb_*), findings (finding_*), append-only log streams (log_*), a chat (msg_*), and a task queue with atomic claiming and leases (task_*), so several agents on different machines can split work like a distributed system.
Conventions: kb_search before researching anything; finding_post insights as you discover them; log_append progress for long work; use task_claim/task_complete when working from the queue; project_status to see the big picture. Everything you write is visible to all members.`
    }
  );
  registerIdentityTools(server, ctx);
  registerKnowledgeTools(server, ctx);
  registerTaskTools(server, ctx);
  registerLogTools(server, ctx);
  registerAdminTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  return server;
}
