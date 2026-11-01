import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from '../config.js';
import type { ToolContext } from './context.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerAdminTools } from './tools/admin.js';
import { registerIdentityTools } from './tools/identity.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerLogTools } from './tools/logs.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerTaskTools } from './tools/tasks.js';

/** Build an MCP server bound to one authenticated member. Cheap enough to do per request. */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'distributed-mcp', title: `${ctx.cfg.teamName} shared workspace`, version: VERSION },
    {
      instructions: `This connector is a shared workspace for a team of people and their Claude agents (you are acting as member "${ctx.user.name}"). It holds a versioned knowledge base (kb_*), findings (finding_*), append-only log streams (log_*), project chat (msg_*), and a task queue with atomic claiming and leases (task_*), so agents on different machines can split a big project like a distributed system.
Sharing is opt-in, per conversation. Most of the user's conversations are private or unrelated to any team project: in those, do not read from or write to this workspace unless the user asks you to.
To contribute, the user must ask you to share THIS conversation with a project (or run the hive_coordinator / hive_worker prompt). Then call session_start once with that project and pass its session_id to every write; writes only go to that project. Share only what is relevant to the project, never unrelated or personal content. Never start a session on your own initiative or reuse another conversation's session_id. If the user wants to stop sharing, call session_end.
Everything written in a shared session is visible to all members.`
    }
  );
  registerSessionTools(server, ctx);
  registerIdentityTools(server, ctx);
  registerKnowledgeTools(server, ctx);
  registerTaskTools(server, ctx);
  registerLogTools(server, ctx);
  registerAdminTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  return server;
}
