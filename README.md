# Hive MCP — a shared brain for a team of Claude agents

Hive is a remote [MCP](https://modelcontextprotocol.io) server you host once and add to Claude as a
**custom connector**. Every person on the team connects their own Claude account (Max, Pro, Team or
Enterprise) to the same server, and from then on all of their Claude sessions — claude.ai, Claude
Desktop, mobile, Claude Code, Agent SDK scripts — read and write one shared workspace:

| Area | What it holds | Tools |
|---|---|---|
| Knowledge base | Versioned Markdown documents with full-text search, tags and projects | `kb_search` `kb_get` `kb_put` `kb_list` `kb_history` `kb_delete` |
| Findings | Discrete insights with confidence and evidence, searchable by all | `finding_post` `finding_list` |
| Logs | Append-only, searchable log streams (progress, measurements, errors) | `log_append` `log_tail` `log_search` `log_streams` |
| Chat | Channels and agent-to-agent direct messages for coordination | `msg_post` `msg_read` |
| Task queue | Work items with priorities, dependencies, capability requirements, atomic claiming and leases | `task_create` `task_create_batch` `task_claim` `task_heartbeat` `task_complete` `task_fail` `task_release` `task_cancel` `task_update` `task_get` `task_list` `project_status` |
| Identity | Members, agents, invites, API keys | `hive_whoami` `hive_overview` `agent_register` `agent_list` `invite_create` `invite_list` `member_list` `member_set_role` `apikey_create` `apikey_list` `apikey_revoke` |

That combination lets agents on different machines and accounts work like a distributed system: a
coordinator splits a job into tasks, workers on any network claim them one at a time (no two agents
ever get the same task), stream logs and findings while they work, publish results to the knowledge
base, and the coordinator synthesises the whole. Three bundled prompts (`hive_coordinator`,
`hive_worker`, `hive_briefing`) script those roles.

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ Alice        │   │ Bob          │   │ Cara         │
│ claude.ai    │   │ Claude Code  │   │ Claude Code  │
│ (coordinator)│   │ (worker)     │   │ (worker)     │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │ OAuth / API key  │                  │
       └───────────┬──────┴──────────────────┘
                   ▼  https://hive.example.com/mcp
         ┌─────────────────────┐
         │  hive-mcp (Node)    │  knowledge base · findings · logs
         │  SQLite + FTS5      │  chat · task queue with leases
         └─────────────────────┘
```

## How it works

* **Transport**: MCP Streamable HTTP at `/mcp` (stateless; safe behind any proxy).
* **Auth**: the server is both OAuth 2.1 authorization server and resource server. It supports
  Client ID Metadata Documents (what Claude's "published identity" option uses), Dynamic Client
  Registration (Claude Code, MCP Inspector), PKCE, refresh and revocation, and it serves the
  `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` documents.
  Plain personal API keys (`hv_key_…`) also work as bearer tokens for tools that cannot do OAuth.
* **Identity**: on the sign-in page a new teammate pastes a one-time **invite code** and their name;
  they receive a personal API key for later sign-ins. Everything they write is attributed to them.
* **Storage**: one SQLite file (WAL mode, FTS5 search). No other services required.
* **Concurrency**: task claims are single-row atomic updates inside a transaction; a claim holds a
  lease that must be renewed with `task_heartbeat` or the task returns to the pool and the attempt
  counts against `max_attempts`.

## Quick start (local)

```bash
npm install
npm run dev            # http://localhost:8787 ; the first boot prints an admin API key
npm test               # end-to-end tests: OAuth flows, knowledge base, task queue, logs, chat
```

Then in Claude Code:

```bash
claude mcp add --transport http hive http://localhost:8787/mcp --header "Authorization: Bearer hv_key_…"
```

(Local http works for Claude Code and the MCP Inspector. Claude.ai connects from Anthropic's cloud and
needs a public https URL — see below.)

## Deploy

Claude.ai talks to connectors from Anthropic's servers, so the host must be reachable on the public
internet over HTTPS. Any Node 20+ host works; the easiest routes:

**Docker Compose + Caddy (automatic Let's Encrypt certificates)**

```bash
cp .env.example .env       # set DOMAIN=hive.example.com (DNS A/AAAA record → this machine)
docker compose up -d
docker compose logs hive   # shows the generated admin API key on first boot (or set HIVE_ADMIN_KEY)
```

**Fly.io** — `fly.toml` is included: `fly launch --copy-config --no-deploy`, create the volume,
set `HIVE_ADMIN_KEY` as a secret, `fly deploy`.

**Railway / Render / any PaaS** — build with the `Dockerfile`, mount a persistent disk at `/data`,
and set `PUBLIC_URL` to the public https URL, `TRUST_PROXY=1`.

Environment variables are documented in `.env.example`. `PUBLIC_URL` must be exactly the origin
Claude will use (it is the OAuth issuer).

## Connect your team

1. **Admin bootstrap** — the first boot creates the `admin` member and prints an API key. Keep it.
2. **Add the connector** — in Claude: *Customize → Connectors → + Add → Add custom connector*, name
   it, paste `https://hive.example.com/mcp`, leave authentication on *Sign in now* / automatic client
   registration. (On Team/Enterprise an owner adds it under *Organization settings → Connectors*;
   each member then signs in individually.)
3. **Sign in** — the server's page asks for an invite code or an API key. The admin pastes the admin
   key; teammates paste an invite code and their name, and receive their own personal key.
4. **Invite teammates** — ask Claude to run `invite_create` (admin only), or on the server:
   `docker compose exec hive node dist/cli.js invite --note "Bob"`. Send the code privately.
5. **Claude Code** — `claude mcp add --transport http hive https://hive.example.com/mcp` then `/mcp`
   to sign in through the browser, or pass `--header "Authorization: Bearer hv_key_…"`.
6. **Scripts / Agent SDK / API** — any MCP client that sends `Authorization: Bearer hv_key_…`
   works, including the Claude API's MCP connector (`mcp_servers: [{type:"url", url, name,
   authorization_token}]`) so you can run headless workers.

Team and Enterprise admins can also store a key under *Request headers* when adding the connector,
but then everyone acts as that one member; per-person sign-in is recommended.

## Running a distributed job

Coordinator (any member, e.g. in claude.ai): use the `hive_coordinator` prompt, or just ask:

> Use the hive connector. Split "benchmark every open-source tokenizer on our corpus" into tasks under
> project `tok-bench`, one per tokenizer, requiring capability `python`, and post the plan.

Workers (teammates, typically Claude Code on their own machines): use the `hive_worker` prompt, or:

> Register as agent `bob-laptop` with capabilities python,browser; then keep claiming tasks from
> project `tok-bench`, log progress, post findings, and complete each task with the result saved to
> `results/tok-bench/<slug>.md` until the queue is empty.

Each `task_claim` hands out a different task, blocked tasks wait for their dependencies, failed
attempts are retried up to `max_attempts`, and `project_status` shows the whole board. Anyone can
read the results later with `kb_search`/`kb_get`, or ask Claude for the `hive_briefing` prompt.

Agents can also expose documents as MCP resources (`hive://kb/{path}`, `hive://projects/{p}/board`)
for clients that support attaching resources.

## Tool reference (short)

| Tool | Notes |
|---|---|
| `kb_put` | Create/overwrite a document by path; `expected_version` for optimistic locking, `if_absent` to create only. Kinds: doc, finding, result, note, decision, spec, resource… |
| `kb_search` | FTS5 search (porter stemming, prefix match), filter by kind/project/tag, ranked with snippets |
| `kb_get` / `kb_history` | Read current or historical versions |
| `finding_post` | Writes `findings/<date>-<slug>.md` with confidence, evidence and sources |
| `task_create` | `priority`, `requires` (capability tags), `depends_on`, `inputs`, `lease_seconds` (default 900), `max_attempts` (default 3) |
| `task_claim` | Best runnable task for the agent's capabilities (or a specific `task_id`); returns `null` when nothing is available |
| `task_complete` | Stores the result; `kb_path` also publishes it as a `result` document |
| `task_fail` | `retry` (default true) returns it to the pool while attempts remain |
| `log_append` / `log_tail` | Streams per project; `since_id` for polling; levels debug/info/warn/error |
| `msg_post` / `msg_read` | Channels plus direct messages via `to_agent` |

All tools return JSON text; errors come back as `code: message` with `isError`.

## Admin CLI

Runs directly against the database (same machine/container as the server):

```
node dist/cli.js bootstrap | invite [--note X --role admin --uses N --expires-hours H] | invites
node dist/cli.js users | role <name> <member|admin> | key <name> | keys [name] | revoke-key <id> | stats
```

## Security notes

* Only invite codes and API keys grant access; both are stored hashed. Tokens expire (24 h access,
  90 d refresh by default) and can be revoked.
* Client ID Metadata Documents are only fetched from hosts in `CIMD_ALLOWED_HOSTS`
  (default `claude.ai, claude.com, anthropic.com`); set `*` to allow any https host (private
  addresses are then refused to avoid SSRF).
* Members can delete only their own documents and cancel only their own tasks; admins can do both
  for anyone. Everything else is readable and writable by all members — this is a trust-the-team
  tool. Back up `/data/hive.db` (it is a single file; `sqlite3 hive.db ".backup out.db"` is safe
  while running).
* Treat content in the knowledge base as data, not instructions: anything a teammate's agent wrote
  will be read by yours.

## Project layout

```
src/
  app.ts            Express app: discovery docs, OAuth endpoints, /mcp
  index.ts          entry point (bootstraps the admin, housekeeping)
  cli.ts            hive-admin CLI
  auth/             OAuth provider (SQLite-backed), CIMD resolver, sign-in pages
  mcp/              MCP server factory, tools, prompts, resources
  services/         members/invites/keys, agents, knowledge base, tasks, logs, messages
  db.ts             schema (SQLite + FTS5)
test/e2e.test.ts    end-to-end tests over HTTP using the MCP client SDK
```

## Limits and ideas for later

* Single process + SQLite: fine for a team and thousands of tasks; not for many instances behind a
  load balancer.
* No web dashboard; the `hive_briefing` prompt and `project_status` tool cover most needs.
* Possible additions: webhooks/notifications when tasks finish, per-project access control, S3
  backups, an SSE event stream for live dashboards.
