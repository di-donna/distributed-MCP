import { createHash, randomBytes } from 'node:crypto';

/** An error that is safe to show to the calling agent / user. */
export class HiveError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'invalid_request'
  ) {
    super(message);
    this.name = 'HiveError';
  }
}

export const now = (): number => Math.floor(Date.now() / 1000);

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Opaque identifier such as `tk_3Jx...`. */
export const randomId = (prefix: string, bytes = 12): string => `${prefix}_${randomBytes(bytes).toString('base64url')}`;

/** Secret bearer-style token such as `hv_key_...`. */
export const randomSecret = (prefix: string, bytes = 32): string => `${prefix}${randomBytes(bytes).toString('base64url')}`;

export function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || 'untitled';
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function clampInt(n: number | undefined | null, min: number, max: number, dflt: number): number {
  if (n === undefined || n === null || Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function normalizeTags(tags?: string[] | null): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = String(raw).trim().toLowerCase().slice(0, 40);
    if (t) seen.add(t);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

export function assertMaxLength(name: string, value: string | undefined, max: number): void {
  if (value !== undefined && value.length > max) {
    throw new HiveError(`${name} is too long (${value.length} chars, max ${max})`);
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{1,39}$/;
export function assertMemberName(name: string): string {
  const n = name.trim();
  if (!NAME_RE.test(n)) {
    throw new HiveError('name must be 2-40 characters: letters, digits, spaces, dots, dashes or underscores');
  }
  return n;
}

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$/;
export function normalizeProject(project?: string | null): string {
  const p = (project ?? '').trim();
  if (!p) return 'default';
  if (!PROJECT_RE.test(p)) throw new HiveError('project must be 1-64 characters: letters, digits, dots, dashes or underscores');
  return p;
}

const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export function normalizeKind(kind?: string | null, dflt = 'doc'): string {
  const k = (kind ?? '').trim().toLowerCase();
  if (!k) return dflt;
  if (!KIND_RE.test(k)) throw new HiveError('kind must be 1-32 lowercase letters, digits, dashes or underscores');
  return k;
}

/** Normalise a knowledge-base path like `research/llm-evals.md`. */
export function normalizePath(path: string): string {
  let p = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  if (!p) throw new HiveError('path is required');
  if (p.length > 200) throw new HiveError('path is too long (max 200 chars)');
  if (p.split('/').some((seg) => seg === '.' || seg === '..')) throw new HiveError('path must not contain . or .. segments');
  if (!/^[A-Za-z0-9 _.\-/()+@]+$/.test(p)) throw new HiveError('path contains unsupported characters');
  p = p.replace(/ +/g, ' ');
  return p;
}

/** JSON-serialise an object for storage, enforcing a size budget. */
export function jsonForStorage(name: string, value: unknown, maxBytes: number): string {
  const s = JSON.stringify(value ?? null);
  if (s === undefined) throw new HiveError(`${name} is not serialisable`);
  if (Buffer.byteLength(s) > maxBytes) throw new HiveError(`${name} is too large (max ${maxBytes} bytes)`);
  return s;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
