import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDoc, listDocs } from '../services/kb.js';
import { getTask, listProjects, listTasks } from '../services/tasks.js';
import { HiveError } from '../util.js';
import type { ToolContext } from './context.js';

export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'kb-document',
    new ResourceTemplate('hive://kb/{+path}', {
      list: async () => ({
        resources: listDocs(ctx.db, { limit: 200 }).map((d) => ({
          uri: `hive://kb/${d.path}`,
          name: d.path,
          title: d.title,
          description: `${d.kind} · ${d.project} · v${d.version} · by ${d.updated_by_name ?? '?'}`,
          mimeType: 'text/markdown'
        }))
      })
    }),
    { title: 'Knowledge-base document', description: 'A document from the shared knowledge base, addressed by path.', mimeType: 'text/markdown' },
    async (uri, vars) => {
      const path = decodeURIComponent(String(vars.path ?? ''));
      const doc = getDoc(ctx.db, { path }, true);
      if (!doc) throw new HiveError(`document not found: ${path}`, 'not_found');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc.content ?? '' }] };
    }
  );

  server.registerResource(
    'task',
    new ResourceTemplate('hive://tasks/{id}', { list: undefined }),
    { title: 'Task', description: 'One task from the shared queue as JSON.', mimeType: 'application/json' },
    async (uri, vars) => {
      const task = getTask(ctx.db, String(vars.id));
      if (!task) throw new HiveError(`task not found: ${String(vars.id)}`, 'not_found');
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(task, null, 2) }] };
    }
  );

  server.registerResource(
    'project-board',
    new ResourceTemplate('hive://projects/{project}/board', {
      list: async () => ({
        resources: listProjects(ctx.db).map((p) => ({
          uri: `hive://projects/${p.project}/board`,
          name: `${p.project} board`,
          description: `${p.open} open · ${p.claimed} in progress · ${p.done} done · ${p.failed} failed`,
          mimeType: 'text/markdown'
        }))
      })
    }),
    { title: 'Project board', description: 'Markdown summary of a project: tasks by status and recent documents.', mimeType: 'text/markdown' },
    async (uri, vars) => {
      const project = String(vars.project);
      const tasks = listTasks(ctx.db, { project, limit: 200 });
      const docs = listDocs(ctx.db, { project, limit: 20 });
      const section = (title: string, rows: string[]) => (rows.length ? `## ${title}\n\n${rows.join('\n')}\n` : '');
      const line = (t: (typeof tasks)[number]) => `- ${t.id} **${t.title}**${t.claimed_by_name ? ` — ${t.claimed_by_name}` : ''}${t.progress ? ` (${t.progress})` : ''}${t.error ? ` — ${t.error}` : ''}`;
      const md =
        `# Project ${project}\n\n` +
        section('In progress', tasks.filter((t) => t.status === 'claimed').map(line)) +
        section('Ready', tasks.filter((t) => t.status === 'open' && !t.blocked).map(line)) +
        section('Blocked', tasks.filter((t) => t.status === 'open' && t.blocked).map(line)) +
        section('Failed', tasks.filter((t) => t.status === 'failed').map(line)) +
        section('Done', tasks.filter((t) => t.status === 'done').map(line)) +
        section('Recent documents', docs.map((d) => `- hive://kb/${d.path} — ${d.title} (${d.kind}, v${d.version})`));
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: md }] };
    }
  );
}
