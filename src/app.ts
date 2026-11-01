import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CimdResolver } from './auth/cimd.js';
import { loginRouter } from './auth/login.js';
import { landingPage } from './auth/pages.js';
import { HiveAuthProvider, type HiveAuthExtra } from './auth/provider.js';
import { VERSION, type Config } from './config.js';
import type { DB } from './db.js';
import { buildMcpServer } from './mcp/server.js';
import { getUser, touchUser } from './services/members.js';

export interface HiveApp {
  app: Express;
  provider: HiveAuthProvider;
  mcpUrl: string;
}

export interface AppDeps {
  /** Override the fetch used to load Client ID Metadata Documents (tests). */
  cimdFetch?: typeof fetch;
}

export function createApp(cfg: Config, db: DB, deps: AppDeps = {}): HiveApp {
  const issuer = new URL(cfg.publicUrl);
  const mcpUrl = new URL('/mcp', issuer);
  const cimd = new CimdResolver({ allowedHosts: cfg.cimdAllowedHosts, fetchImpl: deps.cimdFetch });
  const provider = new HiveAuthProvider(db, cfg, cimd);

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);

  // ----- discovery documents -----
  const asMetadata: OAuthMetadata = {
    ...createOAuthMetadata({ provider, issuerUrl: issuer }),
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
  };
  const prMetadata: OAuthProtectedResourceMetadata = {
    resource: mcpUrl.href,
    authorization_servers: [issuer.href],
    resource_name: `${cfg.teamName} shared workspace`,
    bearer_methods_supported: ['header'],
    resource_documentation: issuer.href
  };
  app.use('/.well-known/oauth-authorization-server', metadataHandler(asMetadata));
  app.use('/.well-known/oauth-protected-resource/mcp', metadataHandler(prMetadata));
  app.use('/.well-known/oauth-protected-resource', metadataHandler(prMetadata));

  // ----- OAuth endpoints -----
  app.use('/authorize', authorizationHandler({ provider }));
  app.use('/token', tokenHandler({ provider }));
  app.use('/register', clientRegistrationHandler({ clientsStore: provider.clientsStore, clientSecretExpirySeconds: 0 }));
  app.use('/revoke', revocationHandler({ provider }));
  app.use('/login', loginRouter(db, cfg, provider));

  // ----- MCP endpoint -----
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.use('/mcp', cors({ exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'] }));
  app.options('/mcp', (_req, res) => {
    res.sendStatus(204);
  });
  app.use('/mcp', bearer);
  app.post('/mcp', express.json({ limit: '4mb', type: () => true }), async (req: Request, res: Response) => {
    const auth = (req as Request & { auth?: AuthInfo }).auth;
    const extra = auth?.extra as HiveAuthExtra | undefined;
    const user = extra ? getUser(db, extra.userId) : undefined;
    if (!auth || !extra || !user) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthenticated' }, id: null });
      return;
    }
    touchUser(db, user.id);
    const server = buildMcpServer({ db, cfg, user, auth: { via: extra.via, clientId: auth.clientId } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: cfg.jsonResponses });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('mcp request failed:', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });
  app.all('/mcp', (_req, res) => {
    res.set('Allow', 'POST, OPTIONS').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed; this server is stateless and only accepts POST' }, id: null });
  });

  // ----- misc -----
  app.get('/', (_req, res) => {
    res.type('html').send(landingPage({ teamName: cfg.teamName, publicUrl: cfg.publicUrl, version: VERSION }));
  });
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  return { app, provider, mcpUrl: mcpUrl.href };
}
