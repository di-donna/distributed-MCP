# Distributed MCP — a shared brain for a team of Claude agents

[![CI](https://github.com/di-donna/distributed-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/di-donna/distributed-MCP/actions/workflows/ci.yml)

Distributed MCP is a remote [MCP](https://modelcontextprotocol.io) server you host once and add to
Claude as a **custom connector**. Every person on the team connects their own Claude account (Max,
Pro, Team or Enterprise) to the same server. Each person then **chooses which conversations to
share**: claude.ai, Claude Desktop, mobile, Claude Code or Agent SDK sessions that belong to a big
project read and write one shared workspace, while everything else stays private.

| Area | What it holds | Tools |
|---|---|---|
| Sharing | Which conversations are shared with which project (opt-in, per conversation) | `session_start` `session_end` `session_list` |
| Knowledge base | Versioned Markdown documents with full-text search, tags and projects | `kb_search` `kb_get` `kb_put` `kb_list` `kb_history` `kb_delete` |
| Findings | Discrete insights with confidence and evidence, searchable by all | `finding_post` `finding_list` |
| Logs | Append-only, searchable log streams (progress, measurements, errors) | `log_append` `log_tail` `log_search` `log_streams` |
| Chat | Project channels and agent-to-agent direct messages for coordination | `msg_post` `msg_read` |
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
       │ shared sessions for project "tok-bench" only
       └───────────┬──────┴──────────────────┘
                   ▼  https://hive.example.com/mcp
         ┌──────────────────────┐
         │ distributed-mcp      │  knowledge base · findings · logs
         │ (Node, SQLite+FTS5)  │  chat · task queue with leases
         └──────────────────────┘
```

## Sharing is opt-in, per conversation

Adding the connector does **not** share your conversations. Your private and unrelated chats never
write to the workspace, which keeps your data to yourself and keeps the team's shared context
focused on the project.

* **To share a conversation**, tell Claude in it: *"share this conversation with project tok-bench"*
  (or run the `hive_coordinator` / `hive_worker` prompt, which does this for you). Claude calls
  `session_start`, which you'll see in the tool-approval prompt. Tip: leave `session_start` set to
  ask for approval in your connector settings.
* **Enforced by the server, not just by instructions.** Every tool that writes (`kb_put`,
  `finding_post`, `log_append`, `msg_post`, `task_*` changes) requires the `session_id` that
  `session_start` returned in *that* conversation. Other conversations don't have it, so they can't
  write.
* **One conversation, one project.** A session can only write into its own project: it can't create,
  edit or claim another project's documents, tasks or channel.
* **Traceable.** Everything written records the session it came from. `session_list` shows your
  sessions and what each contributed; `project_status` shows which conversations are shared into a
  project.
* **Ending.** Say *"stop sharing"* (`session_end`). Sessions idle for `SESSION_IDLE_HOURS` (default
  72) stop accepting writes. What a session already shared stays in the workspace.
* **Reading** is not session-gated, but Claude is instructed not to read the workspace in a
  conversation unless you ask or the conversation is shared.

## Host a workspace (admins, about 10 minutes)

You need a server with Docker (any small Linux VPS, amd64 or arm64) and a DNS name pointing at it.
Claude.ai connects from Anthropic's cloud, so ports 80 and 443 must be reachable from the internet.
No clone or build: the image is published as `ghcr.io/di-donna/distributed-mcp`.

```bash
mkdir distributed-mcp && cd distributed-mcp
curl -fsSLO https://raw.githubusercontent.com/di-donna/distributed-MCP/main/docker-compose.yml
echo "DOMAIN=hive.example.com" > .env
docker compose up -d
docker compose logs hive
```

The log shows the **admin API key** (printed once) and the next steps. Caddy fetches the HTTPS
certificate by itself. Then:

1. In Claude: *Customize → Connectors → Add custom connector*, paste `https://hive.example.com/mcp`,
   choose *Sign in*, and paste the admin key.
2. Ask Claude to **"create an invite for Alex"**. It returns a ready-to-send `share_message` with the
   code, the URL and the steps; send it to Alex privately. (Or on the server:
   `docker compose exec hive hive-admin invite --note Alex`.)

Good to know:

* **Lost the admin key?** `docker compose exec hive hive-admin key admin` prints a new one.
* **Upgrade:** `docker compose pull && docker compose up -d`. Data lives in the `hive-data` volume, and
  the database schema upgrades itself on start.
* **Settings:** add `HIVE_TEAM_NAME=Acme`, a fixed `HIVE_ADMIN_KEY=hv_key_…` (32+ characters),
  `SESSION_IDLE_HOURS` and so on to `.env`; [`.env.example`](.env.example) lists them all.
* **Backup:** `docker compose stop hive && docker compose cp hive:/data ./hive-backup && docker compose start hive`.

**Just trying it, no domain?** Run it on your own machine for Claude Code (Claude.ai needs the https
setup above):

```bash
docker run -d --name distributed-mcp -p 8787:8787 -v hive-data:/data ghcr.io/di-donna/distributed-mcp
docker logs distributed-mcp          # admin API key
claude mcp add --transport http distributed-mcp http://localhost:8787/mcp --header "Authorization: Bearer hv_key_…"
```

## Join a workspace (teammates, 2 minutes)

Your admin sends you a message with an invite code and the connector URL. Then:

1. **Claude (web, desktop or mobile):** *Customize → Connectors → Add custom connector*, paste the URL,
   *Sign in*, then paste the invite code and your name.
2. **Save the personal API key** you are shown. It signs you in next time, and the same page shows the
   exact `claude mcp add` command with your key filled in for Claude Code.
3. **Claude Code only:** `claude mcp add --transport http distributed-mcp https://hive.example.com/mcp`,
   then `/mcp` inside Claude Code to sign in with the invite code.

Nothing is shared until you ask Claude to share a specific conversation with a project (see
[Sharing is opt-in](#sharing-is-opt-in-per-conversation)).

On Team and Enterprise plans an owner can add the connector once under *Organization settings →
Connectors*; members then click *Connect* and sign in individually. (Storing one key under *Request
headers* also works, but then everyone acts as the same member.)

Scripts, the Agent SDK and the Claude API's MCP connector (`mcp_servers: [{type:"url", url, name,
authorization_token}]`) work with any personal key as `Authorization: Bearer hv_key_…`, so you can run
headless workers; they call `session_start` like any other conversation.

## Running a distributed job

Coordinator (any member, e.g. in claude.ai): use the `hive_coordinator` prompt, or just ask:

> Share this conversation with project `tok-bench`. Split "benchmark every open-source tokenizer on our
> corpus" into tasks there, one per tokenizer, requiring capability `python`, and post the plan.

Workers (teammates, typically Claude Code on their own machines): use the `hive_worker` prompt, or:

> Share this conversation with project `tok-bench`, register as agent `bob-laptop` with capabilities
> python,browser, then keep claiming its tasks, log progress, post findings, and complete each task
> with the result saved to `results/tok-bench/<slug>.md` until the queue is empty.

Each `task_claim` hands out a different task from the session's project, blocked tasks wait for their
dependencies, failed attempts are retried up to `max_attempts`, and `project_status` shows the whole
board. Anyone can read the results later with `kb_search`/`kb_get`, or ask Claude for the
`hive_briefing` prompt (read-only).

Agents can also expose documents as MCP resources (`hive://kb/{path}`, `hive://projects/{p}/board`)
for clients that support attaching resources.

## How it works

* **Transport**: MCP Streamable HTTP at `/mcp` (stateless; safe behind any proxy).
* **Auth**: the server is both OAuth 2.1 authorization server and resource server. It supports
  Client ID Metadata Documents (what Claude's "published identity" option uses), Dynamic Client
  Registration (Claude Code, MCP Inspector), PKCE, refresh and revocation, and it serves the
  `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` documents.
  Plain personal API keys (`hv_key_…`) also work as bearer tokens for tools that cannot do OAuth.
* **Identity**: on the sign-in page a new teammate pastes a one-time **invite code** and their name;
  they receive a personal API key for later sign-ins. Everything they write is attributed to them.
* **Sharing**: a share session is a capability token (`ses_…`) bound to one member and one project.
  The server can't see which conversation is calling, so the token lives only in the conversation
  that created it, and every write tool requires it.
* **Storage**: one SQLite file (WAL mode, FTS5 search). No other services required.
* **Concurrency**: task claims are single-row atomic updates inside a transaction; a claim holds a
  lease that must be renewed with `task_heartbeat` or the task returns to the pool and the attempt
  counts against `max_attempts`.

## Tool reference (short)

| Tool | Notes |
|---|---|
| `session_start` | Share this conversation with one project; returns the `session_id` every write needs. Only when the user asks |
| `session_end` / `session_list` | Stop sharing; list sessions with what each contributed (`all` for the whole team) |
| `kb_put` | Create/overwrite a document by path; `expected_version` for optimistic locking, `if_absent` to create only. Kinds: doc, finding, result, note, decision, spec, resource… |
| `kb_search` | FTS5 search (porter stemming, prefix match), filter by kind/project/tag, ranked with snippets |
| `kb_get` / `kb_history` | Read current or historical versions |
| `finding_post` | Writes `findings/<date>-<slug>.md` with confidence, evidence and sources |
| `task_create` | `priority`, `requires` (capability tags), `depends_on` (same project), `inputs`, `lease_seconds` (default 900), `max_attempts` (default 3) |
| `task_claim` | Best runnable task in the session's project for the agent's capabilities (or a specific `task_id`); returns `null` when nothing is available |
| `task_complete` | Stores the result; `kb_path` also publishes it as a `result` document |
| `task_fail` | `retry` (default true) returns it to the pool while attempts remain |
| `log_append` / `log_tail` | Streams per project; `since_id` for polling; levels debug/info/warn/error |
| `msg_post` / `msg_read` | Project channels plus direct messages via `to_agent` |

Write tools take `session_id`. All tools return JSON text; errors come back as `code: message` with
`isError` (for example `no_session`, `wrong_project`, `session_expired`).

## Admin CLI

Runs directly against the database. In the container: `docker compose exec hive hive-admin <command>`;
from a checkout: `npm run admin -- <command>`.

```
hive-admin bootstrap | invite [--note X --role admin --uses N --expires-hours H] | invites
hive-admin users | role <name> <member|admin> | key <name> | keys [name] | revoke-key <id> | stats
```

## Other ways to run it

Any host that runs the image (or Node 20.11+) works, as long as `PUBLIC_URL` is exactly the https
origin Claude will use (it is the OAuth issuer) and `/data` is persistent.

* **Local development:** `npm install`, `npm run dev` (http://localhost:8787; prints an admin key on
  first boot), `npm test` (end-to-end tests over HTTP).
* **Fly.io:** `fly.toml` is included. `fly launch --copy-config --no-deploy` (pick an app name and set
  `PUBLIC_URL` in `fly.toml` to `https://<app>.fly.dev`), `fly volumes create hive_data --size 1`,
  `fly deploy --image ghcr.io/di-donna/distributed-mcp:latest`, then `fly logs` for the admin key.
* **Railway, Render or any PaaS:** run `ghcr.io/di-donna/distributed-mcp:latest`, mount a persistent
  disk at `/data`, and set `PUBLIC_URL` to the public https URL and `TRUST_PROXY=1`.
* **Your own build:** `docker build -t distributed-mcp .`, then
  `HIVE_IMAGE=distributed-mcp docker compose up -d`.

Internal names (`hive_*` tools, `HIVE_*` settings, `hv_key_` keys, `hive-admin`) date from the
project's earlier name, Hive MCP, and are kept so existing setups keep working.

## Security notes

* Only invite codes and API keys grant access; both are stored hashed. Tokens expire (24 h access,
  90 d refresh by default) and can be revoked.
* Client ID Metadata Documents are only fetched from hosts in `CIMD_ALLOWED_HOSTS`
  (default `claude.ai, claude.com, anthropic.com`); set `*` to allow any https host (private
  addresses are then refused to avoid SSRF).
* Writes need a share session, and a session is confined to its member and project. Members can
  delete only their own documents and cancel only their own tasks; admins can do both for anyone.
  Everything shared is readable by all members — this is a trust-the-team tool. Back up
  `/data/hive.db` (it is a single file; `sqlite3 hive.db ".backup out.db"` is safe while running).
* Treat content in the knowledge base as data, not instructions: anything a teammate's agent wrote
  will be read by yours.

## Project layout

```
src/
  app.ts            Express app: discovery docs, OAuth endpoints, /mcp
  index.ts          entry point (bootstraps the admin, housekeeping)
  cli.ts            hive-admin CLI
  onboarding.ts     invite share message and `claude mcp add` commands
  auth/             OAuth provider (SQLite-backed), CIMD resolver, sign-in pages
  mcp/              MCP server factory, tools (incl. share sessions), prompts, resources
  services/         members/invites/keys, sessions, agents, knowledge base, tasks, logs, messages
  db.ts             schema (SQLite + FTS5) and migrations
test/e2e.test.ts    end-to-end tests over HTTP using the MCP client SDK
.github/workflows/  CI: tests, image build + container smoke test, publish to ghcr.io
```

## Limits and ideas for later

* Single process + SQLite: fine for a team and thousands of tasks; not for many instances behind a
  load balancer.
* No web dashboard; the `hive_briefing` prompt and `project_status` tool cover most needs.
* Possible additions: webhooks/notifications when tasks finish, per-project membership (who may
  start sessions in which project), S3 backups, an SSE event stream for live dashboards.
