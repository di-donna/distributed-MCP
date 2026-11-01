/**
 * OAuth Client ID Metadata Documents (CIMD).
 *
 * Modern MCP clients (including Claude's "published identity" option) identify themselves with an
 * https URL as `client_id`; the URL serves a JSON document describing the client. We fetch, validate
 * and cache that document so such clients need no registration step.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { OAuthClientMetadataSchema, type OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface CimdOptions {
  /** Hostnames (and their subdomains) allowed as client ids, or `*` for any https host. */
  allowedHosts: string[] | '*';
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  defaultTtlMs?: number;
}

const MIN_TTL = 60_000;
const MAX_TTL = 24 * 3600_000;

export class CimdResolver {
  private readonly cache = new Map<string, { expires: number; client: OAuthClientInformationFull }>();

  constructor(private readonly opts: CimdOptions) {}

  static isClientIdUrl(clientId: string): boolean {
    return /^https:\/\//i.test(clientId);
  }

  hostAllowed(host: string): boolean {
    if (this.opts.allowedHosts === '*') return true;
    const h = host.toLowerCase();
    return this.opts.allowedHosts.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
  }

  async resolve(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:' || url.hash || url.username || url.password || url.pathname === '/' || url.pathname === '') {
      return undefined;
    }
    if (!this.hostAllowed(url.hostname)) return undefined;

    const cached = this.cache.get(clientId);
    if (cached && cached.expires > Date.now()) return cached.client;

    if (this.opts.allowedHosts === '*' && (await resolvesToPrivateAddress(url.hostname))) return undefined;

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
        headers: { accept: 'application/json' }
      });
    } catch {
      return undefined;
    }
    if (!res.ok) return undefined;
    const text = await readLimited(res, this.opts.maxBytes ?? 64 * 1024);
    if (text === undefined) return undefined;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (typeof json !== 'object' || json === null) return undefined;
    const doc = json as Record<string, unknown>;
    if (doc.client_id !== clientId) return undefined;
    const parsed = OAuthClientMetadataSchema.safeParse(doc);
    if (!parsed.success || parsed.data.redirect_uris.length === 0) return undefined;
    if (!parsed.data.redirect_uris.every((u) => /^https:\/\//i.test(u) || isLoopbackHttp(u))) return undefined;

    const client: OAuthClientInformationFull = {
      ...parsed.data,
      client_id: clientId,
      client_secret: undefined,
      token_endpoint_auth_method: 'none'
    };
    this.cache.set(clientId, { expires: Date.now() + ttlFromHeaders(res, this.opts.defaultTtlMs ?? 3600_000), client });
    return client;
  }
}

export function isLoopbackHttp(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function ttlFromHeaders(res: Response, dflt: number): number {
  const cc = res.headers.get('cache-control') ?? '';
  const m = /max-age=(\d+)/i.exec(cc);
  if (!m) return dflt;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, Number.parseInt(m[1]!, 10) * 1000));
}

async function readLimited(res: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isPrivateAddress(mapped[1]!);
  }
  return false;
}

async function resolvesToPrivateAddress(host: string): Promise<boolean> {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (isIP(host)) return isPrivateAddress(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address));
  } catch {
    return true;
  }
}
