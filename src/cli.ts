#!/usr/bin/env node
/**
 * Admin CLI that talks to the SQLite database directly (run it on the host that holds the DB,
 * e.g. `docker compose exec hive node dist/cli.js invite --note Bob`).
 */
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { bootstrapAdmin, createApiKey, createInvite, getUserByName, listApiKeys, listInvites, listUsers, revokeApiKey, setUserRole } from './services/members.js';
import { listProjects } from './services/tasks.js';
import { kbStats } from './services/kb.js';

interface Args {
  cmd: string;
  flags: Record<string, string | true>;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const [cmd = 'help', ...tail] = argv;
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = tail[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { cmd, flags, rest };
}

const HELP = `hive-admin — manage the Hive MCP workspace database

Usage: hive-admin <command> [options]     (DB_PATH env selects the database)

  bootstrap                         Create the admin member if missing and print its API key
  invite [--note X] [--role admin] [--uses N] [--expires-hours H]
                                    Create an invite code for a new teammate
  invites                           List invites
  users                             List members
  role <name> <member|admin>        Change a member's role
  key <name> [--label X]            Create a personal API key for a member
  keys [name]                       List API keys (secrets never shown)
  revoke-key <key_id>               Revoke an API key
  stats                             Show project and knowledge-base statistics
`;

function main(): void {
  const { cmd, flags, rest } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
  const num = (v: string | true | undefined): number | undefined => (typeof v === 'string' ? Number(v) : undefined);

  switch (cmd) {
    case 'bootstrap': {
      const boot = bootstrapAdmin(db, cfg.adminName, cfg.adminKey);
      if (!boot.created) console.log(`admin "${boot.user.name}" already exists; use "key ${boot.user.name}" to mint a new key`);
      else console.log(`created admin "${boot.user.name}"\nAPI key: ${boot.key ?? '(from HIVE_ADMIN_KEY)'}`);
      break;
    }
    case 'invite': {
      const admin = listUsers(db).find((u) => u.role === 'admin');
      const { invite, code } = createInvite(db, {
        createdBy: admin?.id,
        role: str(flags.role) === 'admin' ? 'admin' : 'member',
        maxUses: num(flags.uses),
        expiresInHours: num(flags['expires-hours']) ?? 168,
        note: str(flags.note)
      });
      console.log(`invite ${invite.id} (${invite.role}, ${invite.max_uses} use(s), expires ${invite.expires_at ? new Date(invite.expires_at * 1000).toISOString() : 'never'})`);
      console.log(`code: ${code}`);
      console.log(`Tell the teammate: add ${cfg.publicUrl}/mcp as a custom connector in Claude, sign in, paste the code and enter their name.`);
      break;
    }
    case 'invites':
      console.table(listInvites(db).map((i) => ({ ...i, created_at: new Date(i.created_at * 1000).toISOString() })));
      break;
    case 'users':
      console.table(listUsers(db).map((u) => ({ id: u.id, name: u.name, role: u.role, last_seen: u.last_seen_at ? new Date(u.last_seen_at * 1000).toISOString() : '-' })));
      break;
    case 'role': {
      const [name, role] = rest;
      const user = name ? getUserByName(db, name) : undefined;
      if (!user || (role !== 'admin' && role !== 'member')) throw new Error('usage: role <name> <member|admin>');
      setUserRole(db, user.id, role);
      console.log(`${user.name} is now ${role}`);
      break;
    }
    case 'key': {
      const user = rest[0] ? getUserByName(db, rest[0]) : undefined;
      if (!user) throw new Error('usage: key <member name> [--label X]');
      const k = createApiKey(db, user.id, str(flags.label) ?? 'cli');
      console.log(`key ${k.id} for ${user.name}: ${k.key}`);
      break;
    }
    case 'keys': {
      const user = rest[0] ? getUserByName(db, rest[0]) : undefined;
      console.table(listApiKeys(db, user?.id));
      break;
    }
    case 'revoke-key': {
      if (!rest[0]) throw new Error('usage: revoke-key <key_id>');
      revokeApiKey(db, rest[0]);
      console.log(`revoked ${rest[0]}`);
      break;
    }
    case 'stats':
      console.table(listProjects(db));
      console.log(kbStats(db));
      break;
    default:
      console.log(HELP);
  }
  db.close();
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
