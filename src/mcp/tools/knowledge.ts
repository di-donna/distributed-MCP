import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { deleteDoc, docHistory, getDoc, getDocVersion, listDocs, putDoc, searchDocs } from '../../services/kb.js';
import { HiveError, slugify } from '../../util.js';
import { defineTool, type ToolContext } from '../context.js';

const KINDS_HELP = 'Common kinds: doc (default), finding, result, note, decision, spec, resource (a link/reference), runbook.';

export function registerKnowledgeTools(server: McpServer, ctx: ToolContext): void {
  defineTool(
    server,
    'kb_search',
    {
      title: 'Search knowledge base',
      description:
        "Full-text search across everything the team has written to the shared knowledge base (docs, findings, task results, notes). ALWAYS search here before starting research or a task so you build on teammates' work instead of repeating it. Returns ranked hits with snippets; use kb_get to read a full document.",
      input: {
        query: z.string().describe('Keywords (AND-ed, prefix matched). Example: "rate limit retry"'),
        kind: z.string().optional().describe(`Restrict to one kind. ${KINDS_HELP}`),
        project: z.string().optional().describe('Restrict to one project'),
        tag: z.string().optional().describe('Restrict to documents carrying this tag'),
        limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10)')
      },
      readOnly: true,
      idempotent: true
    },
    ({ query, kind, project, tag, limit }) => searchDocs(ctx.db, query, { kind, project, tag, limit })
  );

  defineTool(
    server,
    'kb_get',
    {
      title: 'Read document',
      description: 'Read one knowledge-base document in full by path (preferred) or id. Optionally read an older version.',
      input: {
        path: z.string().optional().describe('Document path, e.g. "research/rate-limits.md"'),
        id: z.string().optional().describe('Document id (doc_…) as an alternative to path'),
        version: z.number().int().positive().optional().describe('Read this historical version instead of the latest')
      },
      readOnly: true,
      idempotent: true
    },
    ({ path, id, version }) => {
      const doc = getDoc(ctx.db, { path, id }, true);
      if (!doc) throw new HiveError(`document not found: ${path ?? id}`, 'not_found');
      if (version && version !== doc.version) {
        const old = getDocVersion(ctx.db, doc.id, version);
        if (!old) throw new HiveError(`version ${version} of ${doc.path} not found`, 'not_found');
        return old;
      }
      return doc;
    }
  );

  defineTool(
    server,
    'kb_put',
    {
      title: 'Write document',
      description:
        'Create or overwrite a document in the shared knowledge base so every teammate and agent can find it. Documents are versioned (old versions stay readable). Use clear hierarchical paths like "projects/alpha/design.md" or "findings/2025-01-api-limits.md". Pass expected_version when updating something you read earlier to avoid clobbering a concurrent edit.',
      input: {
        path: z.string().describe('Hierarchical path; the document key. Overwrites if it exists.'),
        content: z.string().describe('Full document body (Markdown recommended)'),
        title: z.string().optional().describe('Human title; defaults to the file name'),
        kind: z.string().optional().describe(KINDS_HELP),
        tags: z.array(z.string()).optional().describe('Tags for filtering, e.g. ["api","limits"]'),
        project: z.string().optional().describe('Project this belongs to (default "default")'),
        meta: z.record(z.string(), z.unknown()).optional().describe('Small structured metadata (source URLs, dates, confidence…)'),
        if_absent: z.boolean().optional().describe('Only create; fail if the path already exists'),
        expected_version: z.number().int().positive().optional().describe('Fail if the current version is not this (optimistic locking)')
      },
      idempotent: true
    },
    ({ path, content, title, kind, tags, project, meta, if_absent, expected_version }) => {
      const doc = putDoc(ctx.db, ctx.user, { path, content, title, kind, tags, project, meta, ifAbsent: if_absent, expectedVersion: expected_version }, ctx.cfg.maxDocBytes);
      const { content: _c, ...summary } = doc;
      return { saved: true, ...summary, bytes: Buffer.byteLength(content) };
    }
  );

  defineTool(
    server,
    'kb_list',
    {
      title: 'List documents',
      description: 'Browse documents by path prefix, kind, project, tag or recency (metadata only, newest first). Use updated_since to see what changed while you were away.',
      input: {
        prefix: z.string().optional().describe('Path prefix / folder, e.g. "findings"'),
        kind: z.string().optional(),
        project: z.string().optional(),
        tag: z.string().optional(),
        updated_since: z.number().int().optional().describe('Unix seconds; only documents updated after this'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50')
      },
      readOnly: true,
      idempotent: true
    },
    ({ prefix, kind, project, tag, updated_since, limit }) => listDocs(ctx.db, { prefix, kind, project, tag, updatedSince: updated_since, limit })
  );

  defineTool(
    server,
    'kb_history',
    {
      title: 'Document history',
      description: 'List the saved versions of a document (who changed it and when). Read a specific version with kb_get.',
      input: { path: z.string() },
      readOnly: true,
      idempotent: true
    },
    ({ path }) => {
      const doc = getDoc(ctx.db, { path }, false);
      if (!doc) throw new HiveError(`document not found: ${path}`, 'not_found');
      return { path: doc.path, current_version: doc.version, versions: docHistory(ctx.db, doc.id) };
    }
  );

  defineTool(
    server,
    'kb_delete',
    {
      title: 'Delete document',
      description: 'Permanently delete a document and its history. Only the author or an admin can delete. Prefer overwriting with a corrected version.',
      input: { path: z.string() },
      destructive: true
    },
    ({ path }) => ({ deleted: deleteDoc(ctx.db, ctx.user, path).path })
  );

  defineTool(
    server,
    'finding_post',
    {
      title: 'Post finding',
      description:
        'Record a discrete finding, insight, or conclusion for the team: what you found, the evidence, and your confidence. Stored in the knowledge base under findings/ so it is searchable by everyone. Post findings as you go, not only at the end.',
      input: {
        title: z.string().describe('One-line statement of the finding'),
        summary: z.string().describe('The finding in a few sentences'),
        evidence: z.string().optional().describe('Supporting detail: data, quotes, links, reproduction steps'),
        confidence: z.enum(['low', 'medium', 'high']).optional().describe('How sure you are'),
        tags: z.array(z.string()).optional(),
        project: z.string().optional(),
        task_id: z.string().optional().describe('Task this finding came from, if any'),
        sources: z.array(z.string()).optional().describe('URLs or document paths that back this up')
      }
    },
    ({ title, summary, evidence, confidence, tags, project, task_id, sources }) => {
      const date = new Date().toISOString().slice(0, 10);
      const path = `findings/${date}-${slugify(title)}-${Math.random().toString(36).slice(2, 6)}.md`;
      const body = [
        `# ${title}`,
        '',
        `**Confidence:** ${confidence ?? 'unspecified'}  `,
        `**By:** ${ctx.user.name}  `,
        task_id ? `**Task:** ${task_id}  ` : '',
        '',
        summary,
        evidence ? `\n## Evidence\n\n${evidence}` : '',
        sources?.length ? `\n## Sources\n\n${sources.map((s) => `- ${s}`).join('\n')}` : ''
      ]
        .filter((line) => line !== '')
        .join('\n');
      const doc = putDoc(
        ctx.db,
        ctx.user,
        { path, title, content: body, kind: 'finding', tags, project, meta: { confidence: confidence ?? null, task_id: task_id ?? null, sources: sources ?? [] } },
        ctx.cfg.maxDocBytes
      );
      return { posted: true, path: doc.path, id: doc.id, project: doc.project };
    }
  );

  defineTool(
    server,
    'finding_list',
    {
      title: 'List findings',
      description: 'Recent findings posted by the team (newest first). Filter by project or tag.',
      input: {
        project: z.string().optional(),
        tag: z.string().optional(),
        updated_since: z.number().int().optional().describe('Unix seconds'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20')
      },
      readOnly: true,
      idempotent: true
    },
    ({ project, tag, updated_since, limit }) => listDocs(ctx.db, { kind: 'finding', project, tag, updatedSince: updated_since, limit: limit ?? 20 })
  );
}
