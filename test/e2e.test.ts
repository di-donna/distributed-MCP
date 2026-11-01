import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { bootstrapAdmin } from '../src/services/members.js';

const CIMD_CLIENT_ID = 'https://claude.ai/.well-known/test-mcp-client.json';
const CIMD_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let base: string;
let server: Server;
let db: DB;
let cfg: Config;
let adminKey: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

before(async () => {
  const port = await freePort();
  base = `http://localhost:${port}`;
  cfg = loadConfig({ PORT: String(port), PUBLIC_URL: base, DB_PATH: ':memory:', HIVE_TEAM_NAME: 'Test Hive', HIVE_ADMIN_NAME: 'root' });
  db = openDb(':memory:');
  const boot = bootstrapAdmin(db, cfg.adminName);
  adminKey = boot.key!;
  const cimdFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url === CIMD_CLIENT_ID) {
      return new Response(
        JSON.stringify({ client_id: CIMD_CLIENT_ID, client_name: 'Claude (test)', redirect_uris: [CIMD_REDIRECT], token_endpoint_auth_method: 'none' }),
        { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' } }
      );
    }
    return new Response('not found', { status: 404 });
  };
  const { app } = createApp(cfg, db, { cimdFetch });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function mcp(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  const text = content[0]?.text ?? '';
  if (res.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** Share a test client's "conversation" with a project; returns the session_id writes need. */
async function share(client: Client, project: string, title = `e2e ${project}`): Promise<string> {
  return (await call<{ session_id: string }>(client, 'session_start', { project, title })).session_id;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function form(path: string, fields: Record<string, string>): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  });
}

function txnFromHtml(html: string): string {
  const m = /name="txn" value="([^"]+)"/.exec(html);
  assert.ok(m, 'login page should carry a txn');
  return m![1]!;
}

describe('discovery and auth gate', () => {
  test('unauthenticated MCP request gets 401 with resource metadata pointer', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    const www = res.headers.get('www-authenticate') ?? '';
    assert.match(www, /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  test('protected resource + authorization server metadata are served', async () => {
    const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    assert.equal(pr.resource, `${base}/mcp`);
    // One issuer string everywhere (RFC 8414 §3.3 / RFC 9207): Claude refuses to connect on any mismatch,
    // including a trailing slash. The iss returned with the code is checked in the OAuth flow test below.
    assert.deepEqual(pr.authorization_servers, [base]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(as.issuer, base, 'issuer is exactly the origin the metadata is published under');
    assert.equal(`${as.issuer}/.well-known/oauth-authorization-server`, `${base}/.well-known/oauth-authorization-server`);
    assert.equal(as.client_id_metadata_document_supported, true);
    assert.equal(as.registration_endpoint, `${base}/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  });

  test('healthz and landing page respond', async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Add custom connector/);
    assert.ok(html.includes(`claude mcp add --transport http distributed-mcp ${base}/mcp`), 'landing page shows the Claude Code command');
    assert.match(html, /Sharing is opt-in/);
  });
});

describe('configuration', () => {
  test('HIVE_ADMIN_KEY must look like an API key', () => {
    assert.throws(() => loadConfig({ HIVE_ADMIN_KEY: 'letmein' }), /HIVE_ADMIN_KEY must start with "hv_key_"/);
    assert.throws(() => loadConfig({ HIVE_ADMIN_KEY: 'hv_key_short' }), /at least 32 characters/);
    const good = `hv_key_${randomBytes(24).toString('base64url')}`;
    assert.equal(loadConfig({ HIVE_ADMIN_KEY: ` ${good} ` }).adminKey, good);
    assert.equal(loadConfig({ HIVE_ADMIN_KEY: '' }).adminKey, undefined);
  });
});

describe('members, invites and the OAuth flow', () => {
  let inviteCode: string;
  let danaKey: string;
  let danaToken: string;
  let danaRefresh: string;
  let clientId: string;

  test('admin authenticates with the bootstrap API key', async () => {
    const client = await mcp(adminKey);
    const me = await call<{ member: { name: string; role: string }; authenticated_via: string }>(client, 'hive_whoami');
    assert.equal(me.member.name, 'root');
    assert.equal(me.member.role, 'admin');
    assert.equal(me.authenticated_via, 'apikey');
    const inv = await call<{ invite_code: string; share_message: string }>(client, 'invite_create', { note: 'Dana' });
    assert.match(inv.invite_code, /^hv_inv_/);
    assert.ok(inv.share_message.includes(inv.invite_code), 'share_message carries the code');
    assert.ok(inv.share_message.includes(`${base}/mcp`), 'share_message carries the connector URL');
    assert.match(inv.share_message, /single use, expires \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    assert.match(inv.share_message, /claude mcp add --transport http distributed-mcp /);
    assert.match(inv.share_message, /Nothing is shared automatically/);
    inviteCode = inv.invite_code;
    await client.close();
  });

  test('bad API key is rejected', async () => {
    await assert.rejects(mcp('hv_key_definitely-not-valid'), /invalid_token/);
  });

  test('dynamic client registration + authorization code + PKCE (joining with an invite)', async () => {
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code (test)', redirect_uris: ['http://localhost:9999/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })
    });
    assert.equal(reg.status, 201);
    clientId = ((await reg.json()) as { client_id: string }).client_id;

    const badReg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example/callback'], token_endpoint_auth_method: 'none' })
    });
    assert.equal(badReg.status, 400);

    const { verifier, challenge } = pkce();
    const authz = new URL('/authorize', base);
    authz.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://localhost:9999/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${base}/mcp`
    }).toString();
    const page = await fetch(authz);
    assert.equal(page.status, 200);
    const txn = txnFromHtml(await page.text());

    // wrong credential re-renders the form with an error
    const bad = await form('/login', { txn, credential: 'hv_inv_nope', name: 'Dana' });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /not recognised/);

    const joined = await form('/login', { txn, credential: inviteCode, name: 'Dana' });
    assert.equal(joined.status, 200);
    const html = await joined.text();
    const keyMatch = /(hv_key_[A-Za-z0-9_-]+)/.exec(html);
    assert.ok(keyMatch, 'joined page should show the new API key');
    danaKey = keyMatch![1]!;
    assert.ok(
      html.includes(`claude mcp add --transport http distributed-mcp ${base}/mcp --header &quot;Authorization: Bearer ${danaKey}&quot;`),
      'joined page shows the Claude Code command with the new key'
    );
    const hrefMatch = /href="(http:\/\/localhost:9999\/callback[^"]+)"/.exec(html);
    assert.ok(hrefMatch, 'joined page should link to the redirect URI');
    const cb = new URL(hrefMatch![1]!.replace(/&amp;/g, '&'));
    assert.equal(cb.searchParams.get('state'), 'xyz');
    assert.equal(cb.searchParams.get('iss'), base);
    const code = cb.searchParams.get('code')!;

    // the invite is single-use
    const page2 = await fetch(authz);
    const txn2 = txnFromHtml(await page2.text());
    const reuse = await form('/login', { txn: txn2, credential: inviteCode, name: 'Mallory' });
    assert.equal(reuse.status, 400);

    // wrong verifier fails, right verifier succeeds
    const badTok = await form('/token', { grant_type: 'authorization_code', code, code_verifier: 'wrong', client_id: clientId, redirect_uri: 'http://localhost:9999/callback' });
    assert.equal(badTok.status, 400);
    const tok = await form('/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: 'http://localhost:9999/callback', resource: `${base}/mcp` });
    assert.equal(tok.status, 200);
    const tokens = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string };
    assert.equal(tokens.token_type, 'bearer');
    danaToken = tokens.access_token;
    danaRefresh = tokens.refresh_token;

    // codes are single use
    const replay = await form('/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
    assert.equal(replay.status, 400);

    const client = await mcp(danaToken);
    const me = await call<{ member: { name: string; role: string }; authenticated_via: string }>(client, 'hive_whoami');
    assert.equal(me.member.name, 'Dana');
    assert.equal(me.member.role, 'member');
    assert.equal(me.authenticated_via, 'oauth');
    await assert.rejects(call(client, 'invite_create', {}), /forbidden/);
    await client.close();
  });

  test('refresh and revoke', async () => {
    const refreshed = await form('/token', { grant_type: 'refresh_token', refresh_token: danaRefresh, client_id: clientId });
    assert.equal(refreshed.status, 200);
    const t = (await refreshed.json()) as { access_token: string; refresh_token: string };
    assert.notEqual(t.access_token, danaToken);
    assert.equal(t.refresh_token, danaRefresh);
    const c = await mcp(t.access_token);
    await call(c, 'hive_whoami');
    await c.close();

    const rev = await form('/revoke', { token: danaRefresh, client_id: clientId });
    assert.equal(rev.status, 200);
    await assert.rejects(mcp(t.access_token), /invalid_token/);
    const again = await form('/token', { grant_type: 'refresh_token', refresh_token: danaRefresh, client_id: clientId });
    assert.equal(again.status, 400);
  });

  test('Client ID Metadata Document clients (Claude.ai style) can authorize; unknown hosts cannot', async () => {
    const { verifier, challenge } = pkce();
    const params = { response_type: 'code', client_id: CIMD_CLIENT_ID, redirect_uri: CIMD_REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's1' };
    const authz = new URL('/authorize', base);
    authz.search = new URLSearchParams(params).toString();
    const page = await fetch(authz);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Claude \(test\)/);
    const txn = txnFromHtml(html);

    // existing member signs in with their personal key → straight redirect
    const login = await form('/login', { txn, credential: danaKey, name: '' });
    assert.equal(login.status, 302);
    const loc = new URL(login.headers.get('location')!);
    assert.equal(`${loc.origin}${loc.pathname}`, CIMD_REDIRECT);
    assert.equal(loc.searchParams.get('state'), 's1');
    const advertised = ((await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as { issuer: string }).issuer;
    assert.equal(loc.searchParams.get('iss'), advertised, 'iss returned to Claude must equal the advertised issuer');
    const tok = await form('/token', { grant_type: 'authorization_code', code: loc.searchParams.get('code')!, code_verifier: verifier, client_id: CIMD_CLIENT_ID, redirect_uri: CIMD_REDIRECT });
    assert.equal(tok.status, 200);
    const { access_token } = (await tok.json()) as { access_token: string };
    const c = await mcp(access_token);
    const me = await call<{ member: { name: string } }>(c, 'hive_whoami');
    assert.equal(me.member.name, 'Dana');
    await c.close();

    // redirect_uri must match the metadata document
    const wrongRedirect = new URL('/authorize', base);
    wrongRedirect.search = new URLSearchParams({ ...params, redirect_uri: 'https://claude.ai/elsewhere' }).toString();
    assert.equal((await fetch(wrongRedirect)).status, 400);

    // hosts outside the allow-list are refused
    const evil = new URL('/authorize', base);
    evil.search = new URLSearchParams({ ...params, client_id: 'https://evil.example/client.json', redirect_uri: 'https://evil.example/cb' }).toString();
    const evilRes = await fetch(evil);
    assert.equal(evilRes.status, 400);
    assert.equal(((await evilRes.json()) as { error: string }).error, 'invalid_client');
  });

  test('members can mint and revoke their own API keys', async () => {
    const c = await mcp(danaKey);
    const k = await call<{ id: string; key: string }>(c, 'apikey_create', { label: 'laptop' });
    assert.match(k.key, /^hv_key_/);
    const c2 = await mcp(k.key);
    await call(c2, 'hive_whoami');
    await c2.close();
    await call(c, 'apikey_revoke', { key_id: k.id });
    await assert.rejects(mcp(k.key), /invalid_token/);
    const keys = await call<Array<{ id: string }>>(c, 'apikey_list');
    assert.ok(keys.length >= 2);
    await c.close();
  });

  // expose for later suites
  after(() => {
    (globalThis as Record<string, unknown>).__danaKey = danaKey;
  });
});

describe('knowledge base', () => {
  test('put, search, versioning, history, optimistic locking, delete', async () => {
    const admin = await mcp(adminKey);
    const dana = await mcp((globalThis as Record<string, unknown>).__danaKey as string);
    const adminS = await share(admin, 'alpha');
    const danaS = await share(dana, 'alpha');

    const first = await call<{ version: number; path: string }>(admin, 'kb_put', {
      session_id: adminS,
      path: '/research/rate-limits.md',
      title: 'API rate limits',
      content: 'The upstream API allows 60 requests per minute. Retry with exponential backoff.',
      tags: ['API', 'limits'],
      project: 'alpha'
    });
    assert.equal(first.version, 1);
    assert.equal(first.path, 'research/rate-limits.md');
    await call(dana, 'kb_put', { session_id: danaS, path: 'research/tokenizer.md', content: 'Tokenizer benchmark: 12k docs/sec on one core.', kind: 'note' });

    const hits = await call<Array<{ path: string; snippet: string }>>(dana, 'kb_search', { query: 'rate limit backoff' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.path, 'research/rate-limits.md');
    assert.match(hits[0]!.snippet, /\[/);
    const byTag = await call<Array<{ path: string }>>(dana, 'kb_list', { tag: 'api' });
    assert.equal(byTag.length, 1);
    assert.equal((await call<unknown[]>(dana, 'kb_search', { query: 'tokenizer', kind: 'note' })).length, 1);
    assert.equal((await call<unknown[]>(dana, 'kb_search', { query: 'tokenizer', kind: 'doc' })).length, 0);

    const v2 = await call<{ version: number; project: string }>(dana, 'kb_put', { session_id: danaS, path: 'research/rate-limits.md', content: 'Updated: limit is now 120/min.', expected_version: 1 });
    assert.equal(v2.version, 2);
    assert.equal(v2.project, 'alpha', 'an update without project keeps the session project instead of moving the doc to default');
    await assert.rejects(call(dana, 'kb_put', { session_id: danaS, path: 'research/rate-limits.md', content: 'stale write', expected_version: 1 }), /conflict/);
    await assert.rejects(call(dana, 'kb_put', { session_id: danaS, path: 'research/rate-limits.md', content: 'x', if_absent: true }), /already exists/);

    const latest = await call<{ content: string; version: number; updated_by_name: string }>(dana, 'kb_get', { path: 'research/rate-limits.md' });
    assert.equal(latest.version, 2);
    assert.match(latest.content, /120/);
    assert.equal(latest.updated_by_name, 'Dana');
    const old = await call<{ content: string; version: number }>(dana, 'kb_get', { path: 'research/rate-limits.md', version: 1 });
    assert.match(old.content, /60 requests/);
    const hist = await call<{ versions: unknown[] }>(dana, 'kb_history', { path: 'research/rate-limits.md' });
    assert.equal(hist.versions.length, 2);

    // search reflects the update
    assert.equal((await call<unknown[]>(dana, 'kb_search', { query: 'exponential' })).length, 0);
    assert.equal((await call<unknown[]>(dana, 'kb_search', { query: '120' })).length, 1);

    const finding = await call<{ path: string }>(dana, 'finding_post', { session_id: danaS, title: 'Backoff works', summary: 'Backoff eliminated 429s.', confidence: 'high', project: 'alpha', tags: ['api'] });
    assert.match(finding.path, /^findings\/\d{4}-\d{2}-\d{2}-backoff-works/);
    assert.equal((await call<unknown[]>(admin, 'finding_list', { project: 'alpha' })).length, 1);

    // only author/admin may delete
    await assert.rejects(call(dana, 'kb_delete', { session_id: danaS, path: 'research/rate-limits.md' }), /forbidden/);
    await call(admin, 'kb_delete', { session_id: adminS, path: 'research/rate-limits.md' });
    await assert.rejects(call(dana, 'kb_get', { path: 'research/rate-limits.md' }), /not_found/);

    // resources expose documents
    const list = await dana.listResources();
    assert.ok(list.resources.some((r) => r.uri === 'hive://kb/research/tokenizer.md'));
    const read = await dana.readResource({ uri: 'hive://kb/research/tokenizer.md' });
    assert.match((read.contents[0] as { text: string }).text, /12k docs/);
    const templates = await dana.listResourceTemplates();
    assert.ok(templates.resourceTemplates.some((t) => t.uriTemplate === 'hive://tasks/{id}'));

    await admin.close();
    await dana.close();
  });
});

describe('distributed task queue', () => {
  test('create, capability gating, dependencies, atomic claim, complete, lease expiry, failure', async () => {
    const admin = await mcp(adminKey);
    const dana = await mcp((globalThis as Record<string, unknown>).__danaKey as string);
    const adminS = await share(admin, 'beta');
    const danaS = await share(dana, 'beta');

    const a = await call<{ id: string }>(admin, 'task_create', { session_id: adminS, title: 'Shard 1', description: 'process shard 1', project: 'beta', requires: ['python'], inputs: { shard: 1 } });
    const b = await call<{ id: string; blocked: boolean }>(admin, 'task_create', { session_id: adminS, title: 'Merge', depends_on: [a.id], priority: 10 });
    assert.equal(b.blocked, true);
    await assert.rejects(call(admin, 'task_create', { session_id: adminS, title: 'bad', depends_on: ['task_nope'] }), /not_found/);
    const batch = await call<Array<{ id: string }>>(admin, 'task_create_batch', { session_id: adminS, tasks: [{ title: 'Shard 2', requires: ['python'] }, { title: 'Shard 3', project: 'beta', requires: ['python'] }] });
    assert.equal(batch.length, 2);

    // admin's default agent has no capabilities → nothing claimable (B is blocked)
    const none = await call<{ claimed: null }>(admin, 'task_claim', { session_id: adminS });
    assert.equal(none.claimed, null);

    const agent = await call<{ id: string }>(dana, 'agent_register', { name: 'py-worker', capabilities: ['python', 'Research'] });
    const claim1 = await call<{ claimed: { id: string; status: string; attempts: number; claimed_by_name: string } }>(dana, 'task_claim', { session_id: danaS, agent_id: agent.id, project: 'beta' });
    assert.equal(claim1.claimed.id, a.id);
    assert.equal(claim1.claimed.status, 'claimed');
    assert.equal(claim1.claimed.attempts, 1);
    assert.equal(claim1.claimed.claimed_by_name, 'Dana/py-worker');

    // a second claim by a different agent cannot get the same task
    const agent2 = await call<{ id: string }>(dana, 'agent_register', { name: 'py-worker-2', capabilities: ['python'] });
    const claim2 = await call<{ claimed: { id: string } }>(dana, 'task_claim', { session_id: danaS, agent_id: agent2.id });
    assert.notEqual(claim2.claimed.id, a.id);
    assert.ok(batch.some((t) => t.id === claim2.claimed.id));
    await call(dana, 'task_release', { session_id: danaS, task_id: claim2.claimed.id, agent_id: agent2.id, note: 'busy' });

    // only the holder may heartbeat/complete
    await assert.rejects(call(admin, 'task_complete', { session_id: adminS, task_id: a.id, result: 'nope' }), /held by/);
    const hb = await call<{ progress: string; lease_expires_at: number }>(dana, 'task_heartbeat', { session_id: danaS, task_id: a.id, agent_id: agent.id, progress: 'halfway' });
    assert.equal(hb.progress, 'halfway');

    const done = await call<{ status: string; result_kb_path: string }>(dana, 'task_complete', {
      session_id: danaS,
      task_id: a.id,
      agent_id: agent.id,
      result: '# Shard 1\n\nrows=1000',
      kb_path: 'results/beta/shard-1.md'
    });
    assert.equal(done.status, 'done');
    assert.equal(done.result_kb_path, 'results/beta/shard-1.md');
    const doc = await call<{ kind: string; meta: { task_id: string } }>(dana, 'kb_get', { path: 'results/beta/shard-1.md' });
    assert.equal(doc.kind, 'result');
    assert.equal(doc.meta.task_id, a.id);

    // dependency satisfied → merge task is now claimable by anyone, highest priority first
    const mergeClaim = await call<{ claimed: { id: string } }>(admin, 'task_claim', { session_id: adminS });
    assert.equal(mergeClaim.claimed.id, b.id);
    await call(admin, 'task_fail', { session_id: adminS, task_id: b.id, error: 'merge tool crashed', retry: true });
    assert.equal((await call<{ status: string; attempts: number }>(admin, 'task_get', { task_id: b.id })).status, 'open');

    // lease expiry returns a task to the pool and counts the attempt
    const again = await call<{ claimed: { id: string; attempts: number } }>(admin, 'task_claim', { session_id: adminS, task_id: b.id });
    assert.equal(again.claimed.attempts, 2);
    db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 5, b.id);
    const after = await call<{ status: string; claimed_by: string | null }>(admin, 'task_get', { task_id: b.id });
    const expiredList = await call<Array<{ id: string; status: string }>>(admin, 'task_list', { project: 'beta', status: 'open' });
    assert.ok(expiredList.some((t) => t.id === b.id), `expected ${b.id} to be open again, got ${JSON.stringify(after)}`);
    const third = await call<{ claimed: { attempts: number } }>(dana, 'task_claim', { session_id: danaS, task_id: b.id, agent_id: agent.id });
    assert.equal(third.claimed.attempts, 3);
    const failed = await call<{ status: string }>(dana, 'task_fail', { session_id: danaS, task_id: b.id, agent_id: agent.id, error: 'still broken', retry: true });
    assert.equal(failed.status, 'failed', 'max_attempts exhausted → failed');

    const status = await call<{ counts: Record<string, number>; failed: unknown[]; recent_task_log: unknown[] }>(admin, 'project_status', { project: 'beta' });
    assert.equal(status.counts.done, 1);
    assert.equal(status.counts.failed, 1);
    assert.equal(status.counts.open, 2);
    assert.ok(status.recent_task_log.length >= 5);

    const cancelled = await call<{ status: string }>(admin, 'task_cancel', { session_id: adminS, task_id: batch[1]!.id, reason: 'no longer needed' });
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(call(dana, 'task_cancel', { session_id: danaS, task_id: batch[0]!.id }), /forbidden/);

    const board = await dana.readResource({ uri: 'hive://projects/beta/board' });
    assert.match((board.contents[0] as { text: string }).text, /# Project beta/);

    await admin.close();
    await dana.close();
  });
});

describe('logs, messages, prompts', () => {
  test('log streams and chat', async () => {
    const admin = await mcp(adminKey);
    const dana = await mcp((globalThis as Record<string, unknown>).__danaKey as string);
    const adminS = await share(admin, 'beta');
    const danaS = await share(dana, 'beta');

    const l1 = await call<{ id: number }>(dana, 'log_append', { session_id: danaS, stream: 'crawler', message: 'fetched 100 pages', data: { pages: 100 }, project: 'beta' });
    const l2 = await call<{ id: number; level: string }>(dana, 'log_append', { session_id: danaS, stream: 'crawler', message: 'rate limited by upstream', level: 'warn' });
    assert.ok(l2.id > l1.id);
    const tail = await call<Array<{ id: number; message: string; data: unknown }>>(admin, 'log_tail', { stream: 'crawler' });
    assert.deepEqual(tail.map((l) => l.id), [l1.id, l2.id]);
    assert.deepEqual(tail[0]!.data, { pages: 100 });
    const onlyNew = await call<Array<{ id: number }>>(admin, 'log_tail', { stream: 'crawler', since_id: l1.id });
    assert.deepEqual(onlyNew.map((l) => l.id), [l2.id]);
    const warns = await call<Array<{ level: string }>>(admin, 'log_tail', { stream: 'crawler', min_level: 'warn' });
    assert.equal(warns.length, 1);
    assert.equal((await call<unknown[]>(admin, 'log_search', { query: 'rate limited' })).length, 1);
    assert.ok((await call<Array<{ stream: string }>>(admin, 'log_streams', {})).some((s) => s.stream === 'crawler'));
    await assert.rejects(call(admin, 'log_append', { session_id: adminS, message: 'x', level: 'loud' }), /invalid/i);

    const me = await call<{ agents: Array<{ id: string; name: string }> }>(dana, 'hive_whoami');
    const worker = me.agents.find((a) => a.name === 'py-worker')!;
    await call(admin, 'msg_post', { session_id: adminS, channel: 'beta', body: 'tasks are up' });
    await call(admin, 'msg_post', { session_id: adminS, body: 'psst, take shard 3', to_agent: worker.id });
    const forWorker = await call<Array<{ body: string }>>(dana, 'msg_read', { agent_id: worker.id });
    assert.deepEqual(forWorker.map((m) => m.body), ['tasks are up', 'psst, take shard 3']);
    const forOther = await call<Array<{ body: string }>>(dana, 'msg_read', {});
    assert.deepEqual(forOther.map((m) => m.body), ['tasks are up']);

    const overview = await call<{ projects: Array<{ project: string }>; active_agents: unknown[] }>(dana, 'hive_overview');
    assert.ok(overview.projects.some((p) => p.project === 'beta'));
    assert.ok(overview.active_agents.length >= 2);

    const prompts = await dana.listPrompts();
    assert.deepEqual(prompts.prompts.map((p) => p.name).sort(), ['hive_briefing', 'hive_coordinator', 'hive_worker']);
    const worked = await dana.getPrompt({ name: 'hive_worker', arguments: { project: 'beta', agent_name: 'w1', capabilities: 'python,browser' } });
    const workerText = (worked.messages[0]!.content as { text: string }).text;
    assert.match(workerText, /"python", "browser"/);
    assert.match(workerText, /session_start with project "beta"/);
    const coord = await dana.getPrompt({ name: 'hive_coordinator', arguments: { project: 'beta', goal: 'ship it' } });
    assert.match((coord.messages[0]!.content as { text: string }).text, /session_start with project "beta"/);

    const tools = await dana.listTools();
    const names = tools.tools.map((t) => t.name);
    assert.equal(names.length, 40, `expected the full toolset, got ${names.length}`);
    assert.ok(['session_start', 'session_end', 'session_list'].every((n) => names.includes(n)));
    const kbPut = tools.tools.find((t) => t.name === 'kb_put')!;
    assert.ok((kbPut.inputSchema.required ?? []).includes('session_id'), 'write tools require session_id');
    await admin.close();
    await dana.close();
  });
});

describe('share sessions', () => {
  test('writes need a session of this member, confined to its project, and are traceable', async () => {
    const admin = await mcp(adminKey);
    const dana = await mcp((globalThis as Record<string, unknown>).__danaKey as string);

    // a conversation that was never shared cannot write
    await assert.rejects(call(dana, 'log_append', { message: 'private chat leaking' }), /session_id/);
    await assert.rejects(call(dana, 'kb_put', { session_id: 'ses_madeup', path: 'x.md', content: 'x' }), /no_session/);
    const adminG = await share(admin, 'gamma', 'admin planning gamma');
    await assert.rejects(call(dana, 'kb_put', { session_id: adminG, path: 'x.md', content: 'x' }), /no_session/, "another member's session id does not work");

    const g = await share(dana, 'gamma', 'Dana researching gamma');
    // only the session's project
    await assert.rejects(call(dana, 'kb_put', { session_id: g, path: 'gamma/a.md', content: 'x', project: 'alpha' }), /wrong_project/);
    await assert.rejects(call(dana, 'kb_put', { session_id: g, path: 'research/tokenizer.md', content: 'overwrite alpha doc' }), /wrong_project/);
    await assert.rejects(call(dana, 'kb_delete', { session_id: g, path: 'research/tokenizer.md' }), /wrong_project/);
    await assert.rejects(call(dana, 'msg_post', { session_id: g, channel: 'beta', body: 'wrong room' }), /wrong_project/);
    await assert.rejects(call(dana, 'log_append', { session_id: g, message: 'x', project: 'beta' }), /wrong_project/);
    const betaOpen = await call<Array<{ id: string }>>(dana, 'task_list', { project: 'beta', status: 'open' });
    await assert.rejects(call(dana, 'task_claim', { session_id: g, task_id: betaOpen[0]!.id }), /wrong_project/);
    await assert.rejects(call(dana, 'task_update', { session_id: g, task_id: betaOpen[0]!.id, title: 'hijack' }), /wrong_project/);
    await assert.rejects(call(dana, 'task_create', { session_id: g, title: 'cross', depends_on: [betaOpen[0]!.id] }), /wrong_project/);

    // writes inside the project work and record the session
    const doc = await call<{ project: string }>(dana, 'kb_put', { session_id: g, path: 'gamma/notes.md', content: 'gamma notes', meta: { shared_from_session: 'spoofed' } });
    assert.equal(doc.project, 'gamma');
    const full = await call<{ meta: Record<string, unknown> }>(dana, 'kb_get', { path: 'gamma/notes.md' });
    assert.equal(full.meta.shared_from_session, g, 'server sets provenance and ignores a spoofed value');
    const line = await call<{ session_id: string; project: string }>(dana, 'log_append', { session_id: g, message: 'started gamma' });
    assert.equal(line.session_id, g);
    assert.equal(line.project, 'gamma');
    const msg = await call<{ session_id: string; channel: string }>(dana, 'msg_post', { session_id: g, body: 'hello gamma' });
    assert.equal(msg.channel, 'gamma');
    assert.equal(msg.session_id, g);
    const task = await call<{ id: string; session_id: string; project: string }>(dana, 'task_create', { session_id: g, title: 'Gamma task' });
    assert.equal(task.project, 'gamma');
    assert.equal(task.session_id, g);
    const adminBeta = await share(admin, 'beta', 'admin on beta');
    await assert.rejects(call(admin, 'task_cancel', { session_id: adminBeta, task_id: task.id }), /wrong_project/, 'even an admin cannot reach into another project from a session');

    const mine = await call<Array<{ id: string; active: boolean; contributions: Record<string, number> }>>(dana, 'session_list', { project: 'gamma' });
    const listed = mine.find((s) => s.id === g)!;
    assert.equal(listed.active, true);
    assert.deepEqual(listed.contributions, { docs: 1, logs: 1, messages: 1, tasks: 1 });
    const status = await call<{ active_sessions: Array<{ member: string; title: string }> }>(admin, 'project_status', { project: 'gamma' });
    assert.ok(status.active_sessions.some((s) => s.member === 'Dana' && s.title === 'Dana researching gamma'));
    const everyone = await call<Array<{ user_name: string }>>(dana, 'session_list', { project: 'gamma', all: true });
    assert.ok(everyone.some((s) => s.user_name === 'root'));

    // idle sessions expire; ended sessions refuse writes
    db.prepare('UPDATE share_sessions SET last_used_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - (cfg.sessionIdleHours + 1) * 3600, adminG);
    await assert.rejects(call(admin, 'log_append', { session_id: adminG, message: 'stale' }), /session_expired/);
    const ended = await call<{ ended: boolean }>(dana, 'session_end', { session_id: g });
    assert.equal(ended.ended, true);
    await assert.rejects(call(dana, 'log_append', { session_id: g, message: 'after end' }), /session_ended/);
    assert.equal((await call<Array<{ id: string }>>(dana, 'session_list', { project: 'gamma', active_only: true })).length, 0);

    await admin.close();
    await dana.close();
  });

  test('opening a 0.1 database adds the session columns', () => {
    const file = join(tmpdir(), `hive-migrate-${randomBytes(4).toString('hex')}.db`);
    try {
      openDb(file).close();
      const raw = new Database(file);
      for (const t of ['logs', 'messages', 'tasks']) {
        raw.exec(`DROP INDEX IF EXISTS idx_${t}_session; ALTER TABLE ${t} DROP COLUMN session_id;`);
      }
      raw.prepare("INSERT INTO logs (project, stream, level, message, ts) VALUES ('old', 'general', 'info', 'from 0.1', 1)").run();
      raw.close();
      const migrated = openDb(file);
      for (const t of ['logs', 'messages', 'tasks']) {
        const cols = (migrated.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
        assert.ok(cols.includes('session_id'), `${t}.session_id added`);
      }
      assert.equal((migrated.prepare("SELECT message, session_id FROM logs WHERE project = 'old'").get() as { message: string; session_id: null }).session_id, null);
      migrated.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
    }
  });
});
