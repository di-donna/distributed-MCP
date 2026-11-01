export interface Config {
  /** Port to listen on. */
  port: number;
  /** Interface to bind. */
  host: string;
  /** Public base URL (scheme + host, no trailing slash). Used as the OAuth issuer and for links. */
  publicUrl: string;
  /** Path of the SQLite database file. */
  dbPath: string;
  /** Display name for the shared workspace. */
  teamName: string;
  /** Name of the admin user created on first boot. */
  adminName: string;
  /** Optional pre-set admin API key. If unset one is generated and printed on first boot. */
  adminKey?: string;
  /** Hostnames whose Client ID Metadata Documents may be used as OAuth client ids. `*` allows any https host. */
  cimdAllowedHosts: string[] | '*';
  /** Whether to trust X-Forwarded-* headers from a reverse proxy. */
  trustProxy: boolean;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  authCodeTtlSec: number;
  /** Max size of a single knowledge-base document in bytes. */
  maxDocBytes: number;
  /** A share session that has not been used for this many hours stops accepting writes. */
  sessionIdleHours: number;
  /** If true, the /mcp endpoint answers with plain JSON instead of SSE streams. */
  jsonResponses: boolean;
}

function envInt(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const v = env[key];
  if (!v) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function envBool(env: NodeJS.ProcessEnv, key: string, dflt: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** Same prefix as `API_KEY_PREFIX` in services/members.ts; only tokens with it are treated as API keys. */
const ADMIN_KEY_PREFIX = 'hv_key_';
const ADMIN_KEY_MIN_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const adminKey = env.HIVE_ADMIN_KEY?.trim() || undefined;
  if (adminKey && (!adminKey.startsWith(ADMIN_KEY_PREFIX) || adminKey.length < ADMIN_KEY_MIN_LENGTH)) {
    throw new Error(
      `HIVE_ADMIN_KEY must start with "${ADMIN_KEY_PREFIX}" and be at least ${ADMIN_KEY_MIN_LENGTH} characters long ` +
        `(e.g. ${ADMIN_KEY_PREFIX} followed by a long random string). Leave it unset to have a key generated and printed on first boot.`
    );
  }
  const port = envInt(env, 'PORT', 8787);
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const cimdRaw = (env.CIMD_ALLOWED_HOSTS || 'claude.ai,claude.com,anthropic.com').trim();
  const cimdAllowedHosts: string[] | '*' =
    cimdRaw === '*'
      ? '*'
      : cimdRaw
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean);
  return {
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl,
    dbPath: env.DB_PATH || './data/hive.db',
    teamName: env.HIVE_TEAM_NAME || 'Distributed MCP',
    adminName: env.HIVE_ADMIN_NAME || 'admin',
    adminKey,
    cimdAllowedHosts,
    trustProxy: envBool(env, 'TRUST_PROXY', false),
    accessTokenTtlSec: envInt(env, 'ACCESS_TOKEN_TTL_SEC', 24 * 3600),
    refreshTokenTtlSec: envInt(env, 'REFRESH_TOKEN_TTL_SEC', 90 * 24 * 3600),
    authCodeTtlSec: envInt(env, 'AUTH_CODE_TTL_SEC', 600),
    maxDocBytes: envInt(env, 'MAX_DOC_BYTES', 512 * 1024),
    sessionIdleHours: envInt(env, 'SESSION_IDLE_HOURS', 72),
    jsonResponses: envBool(env, 'MCP_JSON_RESPONSES', true)
  };
}

export const VERSION = '0.2.0';
