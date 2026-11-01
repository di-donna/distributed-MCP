import type { DB } from '../db.js';
import {
  HiveError,
  assertMaxLength,
  jsonForStorage,
  normalizeKind,
  normalizePath,
  normalizeProject,
  normalizeTags,
  now,
  parseJson,
  randomId
} from '../util.js';
import type { User } from './members.js';

export interface Doc {
  id: string;
  path: string;
  project: string;
  kind: string;
  title: string;
  content?: string;
  tags: string[];
  meta: Record<string, unknown>;
  version: number;
  created_by_name: string | null;
  updated_by_name: string | null;
  created_at: number;
  updated_at: number;
  bytes?: number;
}

interface DocRow {
  rid: number;
  id: string;
  path: string;
  project: string;
  kind: string;
  title: string;
  content: string;
  tags: string;
  tags_text: string;
  meta: string;
  version: number;
  created_by: string | null;
  created_by_name: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface SearchHit {
  id: string;
  path: string;
  project: string;
  kind: string;
  title: string;
  tags: string[];
  version: number;
  updated_by_name: string | null;
  updated_at: number;
  snippet: string;
  score: number;
}

function toDoc(r: DocRow, withContent: boolean): Doc {
  const d: Doc = {
    id: r.id,
    path: r.path,
    project: r.project,
    kind: r.kind,
    title: r.title,
    tags: parseJson<string[]>(r.tags, []),
    meta: parseJson<Record<string, unknown>>(r.meta, {}),
    version: r.version,
    created_by_name: r.created_by_name,
    updated_by_name: r.updated_by_name,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
  if (withContent) d.content = r.content;
  else d.bytes = Buffer.byteLength(r.content);
  return d;
}

/** Turn free text into a safe FTS5 query: quoted terms AND-ed together, prefix-matching terms of 3+ chars. */
export function ftsQuery(q: string): string {
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  if (terms.length === 0) throw new HiveError('query must contain at least one word');
  return terms.map((t) => (t.length >= 3 ? `"${t}"*` : `"${t}"`)).join(' ');
}

export interface PutDocInput {
  path: string;
  title?: string;
  content: string;
  kind?: string;
  tags?: string[];
  project?: string;
  meta?: Record<string, unknown>;
  /** Only create: fail if the document already exists. */
  ifAbsent?: boolean;
  /** Optimistic concurrency: fail if the current version differs. */
  expectedVersion?: number;
}

export function putDoc(db: DB, user: User, input: PutDocInput, maxDocBytes: number): Doc {
  const path = normalizePath(input.path);
  const content = input.content ?? '';
  if (Buffer.byteLength(content) > maxDocBytes) throw new HiveError(`content is too large (max ${maxDocBytes} bytes)`);
  const title = (input.title ?? '').trim() || path.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '');
  assertMaxLength('title', title, 200);
  const kind = normalizeKind(input.kind);
  const tags = normalizeTags(input.tags);
  const project = normalizeProject(input.project);
  const meta = jsonForStorage('meta', input.meta ?? {}, 16 * 1024);
  const ts = now();

  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM kb_docs WHERE path = ?').get(path) as DocRow | undefined;
    if (existing) {
      if (input.ifAbsent) throw new HiveError(`document ${path} already exists (version ${existing.version})`, 'conflict');
      if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
        throw new HiveError(`version conflict: ${path} is at version ${existing.version}, you expected ${input.expectedVersion}`, 'conflict');
      }
      const version = existing.version + 1;
      db.prepare(
        `UPDATE kb_docs SET title = ?, content = ?, kind = ?, tags = ?, tags_text = ?, project = ?, meta = ?, version = ?,
           updated_by = ?, updated_by_name = ?, updated_at = ? WHERE rid = ?`
      ).run(title, content, kind, JSON.stringify(tags), tags.join(' '), project, meta, version, user.id, user.name, ts, existing.rid);
      db.prepare(
        'INSERT INTO kb_versions (doc_id, version, title, content, tags, meta, updated_by, updated_by_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(existing.id, version, title, content, JSON.stringify(tags), meta, user.id, user.name, ts);
      return getDoc(db, { path }, true)!;
    }
    const id = randomId('doc', 8);
    db.prepare(
      `INSERT INTO kb_docs (id, path, project, kind, title, content, tags, tags_text, meta, version,
         created_by, created_by_name, updated_by, updated_by_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
    ).run(id, path, project, kind, title, content, JSON.stringify(tags), tags.join(' '), meta, user.id, user.name, user.id, user.name, ts, ts);
    db.prepare(
      'INSERT INTO kb_versions (doc_id, version, title, content, tags, meta, updated_by, updated_by_name, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, title, content, JSON.stringify(tags), meta, user.id, user.name, ts);
    return getDoc(db, { path }, true)!;
  })();
}

export function getDoc(db: DB, ref: { path?: string; id?: string }, withContent = true): Doc | undefined {
  let row: DocRow | undefined;
  if (ref.id) row = db.prepare('SELECT * FROM kb_docs WHERE id = ?').get(ref.id) as DocRow | undefined;
  else if (ref.path) row = db.prepare('SELECT * FROM kb_docs WHERE path = ?').get(normalizePath(ref.path)) as DocRow | undefined;
  else throw new HiveError('path or id is required');
  return row ? toDoc(row, withContent) : undefined;
}

export function getDocVersion(db: DB, docId: string, version: number): Doc | undefined {
  const base = db.prepare('SELECT * FROM kb_docs WHERE id = ?').get(docId) as DocRow | undefined;
  if (!base) return undefined;
  const v = db.prepare('SELECT * FROM kb_versions WHERE doc_id = ? AND version = ?').get(docId, version) as
    | { title: string; content: string; tags: string; meta: string; updated_by_name: string | null; updated_at: number }
    | undefined;
  if (!v) return undefined;
  return {
    ...toDoc(base, false),
    title: v.title,
    content: v.content,
    tags: parseJson<string[]>(v.tags, []),
    meta: parseJson<Record<string, unknown>>(v.meta, {}),
    version,
    updated_by_name: v.updated_by_name,
    updated_at: v.updated_at,
    bytes: undefined
  };
}

export function docHistory(db: DB, docId: string): Array<{ version: number; title: string; bytes: number; updated_by_name: string | null; updated_at: number }> {
  const rows = db
    .prepare('SELECT version, title, length(content) AS bytes, updated_by_name, updated_at FROM kb_versions WHERE doc_id = ? ORDER BY version DESC')
    .all(docId) as Array<{ version: number; title: string; bytes: number; updated_by_name: string | null; updated_at: number }>;
  return rows;
}

export interface ListDocsFilter {
  prefix?: string;
  kind?: string;
  project?: string;
  tag?: string;
  updatedSince?: number;
  limit?: number;
}

export function listDocs(db: DB, f: ListDocsFilter): Doc[] {
  const limit = Math.max(1, Math.min(200, f.limit ?? 50));
  const prefix = f.prefix ? normalizePath(f.prefix) : null;
  const rows = db
    .prepare(
      `SELECT * FROM kb_docs
       WHERE (? IS NULL OR path = ? OR path LIKE ? ESCAPE '\\')
         AND (? IS NULL OR kind = ?)
         AND (? IS NULL OR project = ?)
         AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(kb_docs.tags) WHERE value = ?))
         AND (? IS NULL OR updated_at >= ?)
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(
      prefix,
      prefix,
      prefix === null ? null : `${prefix.replace(/[%_\\]/g, '\\$&')}/%`,
      f.kind ?? null,
      f.kind ?? null,
      f.project ?? null,
      f.project ?? null,
      f.tag ?? null,
      f.tag?.toLowerCase() ?? null,
      f.updatedSince ?? null,
      f.updatedSince ?? null,
      limit
    ) as DocRow[];
  return rows.map((r) => toDoc(r, false));
}

export function searchDocs(db: DB, query: string, f: { kind?: string; project?: string; tag?: string; limit?: number }): SearchHit[] {
  const limit = Math.max(1, Math.min(50, f.limit ?? 10));
  const rows = db
    .prepare(
      `SELECT d.id, d.path, d.project, d.kind, d.title, d.tags, d.version, d.updated_by_name, d.updated_at,
              snippet(kb_fts, 1, '[', ']', ' … ', 24) AS snippet,
              bm25(kb_fts, 4.0, 1.0, 2.0, 2.0) AS score
       FROM kb_fts JOIN kb_docs d ON d.rid = kb_fts.rowid
       WHERE kb_fts MATCH ?
         AND (? IS NULL OR d.kind = ?)
         AND (? IS NULL OR d.project = ?)
         AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(d.tags) WHERE value = ?))
       ORDER BY score LIMIT ?`
    )
    .all(ftsQuery(query), f.kind ?? null, f.kind ?? null, f.project ?? null, f.project ?? null, f.tag ?? null, f.tag?.toLowerCase() ?? null, limit) as Array<
    Omit<SearchHit, 'tags'> & { tags: string }
  >;
  return rows.map((r) => ({ ...r, tags: parseJson<string[]>(r.tags, []), score: Math.round(-r.score * 1000) / 1000 }));
}

export function deleteDoc(db: DB, user: User, path: string): Doc {
  const doc = getDoc(db, { path }, false);
  if (!doc) throw new HiveError(`document ${path} not found`, 'not_found');
  const row = db.prepare('SELECT created_by FROM kb_docs WHERE id = ?').get(doc.id) as { created_by: string | null };
  if (user.role !== 'admin' && row.created_by !== user.id) {
    throw new HiveError('only the author or an admin can delete a document', 'forbidden');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM kb_docs WHERE id = ?').run(doc.id);
    db.prepare('DELETE FROM kb_versions WHERE doc_id = ?').run(doc.id);
  })();
  return doc;
}

export function kbStats(db: DB): { documents: number; by_kind: Record<string, number>; projects: string[] } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM kb_docs').get() as { n: number }).n;
  const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM kb_docs GROUP BY kind').all() as Array<{ kind: string; n: number }>;
  const projects = db.prepare('SELECT DISTINCT project FROM kb_docs ORDER BY project').all() as Array<{ project: string }>;
  return { documents: total, by_kind: Object.fromEntries(kinds.map((k) => [k.kind, k.n])), projects: projects.map((p) => p.project) };
}
