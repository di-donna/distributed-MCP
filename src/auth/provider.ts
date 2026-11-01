/**
 * A self-contained OAuth 2.1 authorization server + resource server backed by SQLite.
 *
 * Supports:
 *  - Dynamic Client Registration (RFC 7591) for clients like Claude Code and the MCP Inspector.
 *  - Client ID Metadata Documents for clients like Claude.ai that identify with an https URL.
 *  - Authorization-code + PKCE flow with a sign-in page where members paste an invite code or API key.
 *  - Refresh tokens, revocation, and plain personal API keys (`hv_key_…`) as bearer tokens.
 */
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { API_KEY_PREFIX, getUser, resolveApiKey, type Role, type User } from '../services/members.js';
import { now, randomId, randomSecret, sha256 } from '../util.js';
import { CimdResolver, isLoopbackHttp } from './cimd.js';
import { loginPage } from './pages.js';

export interface HiveAuthExtra extends Record<string, unknown> {
  userId: string;
  userName: string;
  role: Role;
  via: 'oauth' | 'apikey';
  keyId?: string;
}

export interface AuthTxn {
  id: string;
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scope: string | null;
  resource: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string | null;
  resource: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

interface TokenRow {
  token_hash: string;
  kind: 'access' | 'refresh';
  client_id: string;
  user_id: string;
  scope: string | null;
  resource: string | null;
  grant_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

const TXN_TTL_SEC = 15 * 60;
/** Far-future expiry reported for API keys (the SDK middleware insists on an expiry). */
const API_KEY_VIRTUAL_TTL_SEC = 3600;

function comparableResource(value: string | URL | undefined | null): string | undefined {
  if (!value) return undefined;
  const text = String(value);
  const hash = text.indexOf('#');
  return (hash === -1 ? text : text.slice(0, hash)).replace(/\/$/, '');
}

export class HiveAuthProvider implements OAuthServerProvider {
  constructor(
    private readonly db: DB,
    private readonly cfg: Config,
    private readonly cimd: CimdResolver
  ) {}

  // ---------- clients ----------

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        if (CimdResolver.isClientIdUrl(clientId)) return this.cimd.resolve(clientId);
        const row = this.db.prepare('SELECT data FROM oauth_clients WHERE client_id = ?').get(clientId) as { data: string } | undefined;
        return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
      },
      registerClient: async (client) => {
        for (const uri of client.redirect_uris) {
          if (!/^https:\/\//i.test(uri) && !isLoopbackHttp(uri)) {
            throw new InvalidClientMetadataError(`redirect_uri must use https or a loopback http address: ${uri}`);
          }
        }
        const full = client as OAuthClientInformationFull;
        if (!full.client_id) {
          full.client_id = randomId('client', 16);
          full.client_id_issued_at = now();
        }
        this.db.prepare('INSERT OR REPLACE INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)').run(full.client_id, JSON.stringify(full), now());
        return full;
      }
    };
  }

  // ---------- authorization (sign-in page) ----------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const ts = now();
    const txn: AuthTxn = {
      id: randomId('txn', 18),
      client_id: client.client_id,
      client_name: client.client_name ?? null,
      redirect_uri: params.redirectUri,
      state: params.state ?? null,
      code_challenge: params.codeChallenge,
      scope: params.scopes?.length ? params.scopes.join(' ') : null,
      resource: params.resource ? params.resource.href : null,
      created_at: ts,
      expires_at: ts + TXN_TTL_SEC,
      used_at: null
    };
    this.db
      .prepare(
        `INSERT INTO oauth_txns (id, client_id, client_name, redirect_uri, state, code_challenge, scope, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(txn.id, txn.client_id, txn.client_name, txn.redirect_uri, txn.state, txn.code_challenge, txn.scope, txn.resource, txn.created_at, txn.expires_at);
    res
      .status(200)
      .type('html')
      .send(loginPage({ txn: txn.id, clientName: txn.client_name ?? txn.client_id, teamName: this.cfg.teamName, publicUrl: this.cfg.publicUrl }));
  }

  getTxn(id: string | undefined): AuthTxn | undefined {
    if (!id) return undefined;
    const row = this.db.prepare('SELECT * FROM oauth_txns WHERE id = ?').get(id) as AuthTxn | undefined;
    if (!row || row.used_at || row.expires_at < now()) return undefined;
    return row;
  }

  /** Mark a sign-in transaction complete for `user` and return the redirect URL carrying the authorization code. */
  completeLogin(txnId: string, user: User): string {
    return this.db.transaction(() => {
      const txn = this.getTxn(txnId);
      if (!txn) throw new InvalidGrantError('sign-in session expired');
      const ts = now();
      this.db.prepare('UPDATE oauth_txns SET used_at = ? WHERE id = ?').run(ts, txn.id);
      const code = randomSecret('hv_code_', 32);
      this.db
        .prepare(
          `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(sha256(code), txn.client_id, user.id, txn.redirect_uri, txn.code_challenge, txn.scope, txn.resource, ts, ts + this.cfg.authCodeTtlSec);
      const url = new URL(txn.redirect_uri);
      url.searchParams.set('code', code);
      if (txn.state) url.searchParams.set('state', txn.state);
      url.searchParams.set('iss', this.cfg.publicUrl);
      return url.href;
    })();
  }

  // ---------- token endpoint ----------

  private getCode(client: OAuthClientInformationFull, code: string): CodeRow {
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(sha256(code)) as CodeRow | undefined;
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('invalid authorization code');
    if (row.used_at) throw new InvalidGrantError('authorization code already used');
    if (row.expires_at < now()) throw new InvalidGrantError('authorization code expired');
    return row;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.getCode(client, authorizationCode).code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    return this.db.transaction(() => {
      const row = this.getCode(client, authorizationCode);
      if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
      if (row.resource && resource && comparableResource(row.resource) !== comparableResource(resource)) {
        throw new InvalidGrantError('resource mismatch');
      }
      this.db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?').run(now(), row.code_hash);
      return this.issueTokens(client.client_id, row.user_id, row.scope, row.resource ?? resource?.href ?? null, randomId('grant', 12), true);
    })();
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(sha256(refreshToken)) as TokenRow | undefined;
    if (!row || row.client_id !== client.client_id || row.revoked_at || row.expires_at < now()) throw new InvalidGrantError('invalid refresh token');
    if (row.resource && resource && comparableResource(row.resource) !== comparableResource(resource)) throw new InvalidGrantError('resource mismatch');
    if (!getUser(this.db, row.user_id)) throw new InvalidGrantError('member no longer exists');
    const granted = row.scope ? row.scope.split(' ') : [];
    if (scopes?.length && granted.length && scopes.some((s) => !granted.includes(s))) throw new InvalidGrantError('scope exceeds the original grant');
    const tokens = this.issueTokens(client.client_id, row.user_id, row.scope, row.resource, row.grant_id, false);
    tokens.refresh_token = refreshToken;
    return tokens;
  }

  private issueTokens(clientId: string, userId: string, scope: string | null, resource: string | null, grantId: string, withRefresh: boolean): OAuthTokens {
    const ts = now();
    const access = randomSecret('hv_at_', 32);
    const insert = this.db.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, resource, grant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(sha256(access), 'access', clientId, userId, scope, resource, grantId, ts, ts + this.cfg.accessTokenTtlSec);
    const tokens: OAuthTokens = { access_token: access, token_type: 'bearer', expires_in: this.cfg.accessTokenTtlSec };
    if (scope) tokens.scope = scope;
    if (withRefresh) {
      const refresh = randomSecret('hv_rt_', 32);
      insert.run(sha256(refresh), 'refresh', clientId, userId, scope, resource, grantId, ts, ts + this.cfg.refreshTokenTtlSec);
      tokens.refresh_token = refresh;
    }
    return tokens;
  }

  // ---------- resource server ----------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token.startsWith(API_KEY_PREFIX)) {
      const resolved = resolveApiKey(this.db, token);
      if (!resolved) throw new InvalidTokenError('API key not recognised or revoked');
      const extra: HiveAuthExtra = { userId: resolved.user.id, userName: resolved.user.name, role: resolved.user.role, via: 'apikey', keyId: resolved.keyId };
      return { token, clientId: `apikey:${resolved.keyId}`, scopes: [], expiresAt: now() + API_KEY_VIRTUAL_TTL_SEC, extra };
    }
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(sha256(token)) as TokenRow | undefined;
    if (!row || row.revoked_at) throw new InvalidTokenError('invalid token');
    if (row.expires_at < now()) throw new InvalidTokenError('token expired');
    if (row.resource && comparableResource(row.resource) !== comparableResource(`${this.cfg.publicUrl}/mcp`) && comparableResource(row.resource) !== comparableResource(this.cfg.publicUrl)) {
      throw new InvalidTokenError('token was issued for a different resource');
    }
    const user = getUser(this.db, row.user_id);
    if (!user) throw new InvalidTokenError('member no longer exists');
    const extra: HiveAuthExtra = { userId: user.id, userName: user.name, role: user.role, via: 'oauth' };
    return {
      token,
      clientId: row.client_id,
      scopes: row.scope ? row.scope.split(' ') : [],
      expiresAt: row.expires_at,
      resource: row.resource ? new URL(row.resource) : undefined,
      extra
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(sha256(request.token)) as TokenRow | undefined;
    if (!row || row.client_id !== client.client_id) return;
    const ts = now();
    if (row.kind === 'refresh') {
      this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(ts, row.grant_id);
    } else {
      this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(ts, row.token_hash);
    }
  }

  /** Delete expired codes, transactions and tokens. Safe to call periodically. */
  cleanupExpired(): void {
    const ts = now();
    this.db.prepare('DELETE FROM oauth_txns WHERE expires_at < ?').run(ts - 3600);
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(ts - 3600);
    this.db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(ts - 86400, ts - 86400);
  }
}
