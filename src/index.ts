import { createApp } from './app.js';
import { VERSION, loadConfig, type Config } from './config.js';
import { openDb } from './db.js';
import { bootstrapAdmin } from './services/members.js';
import { expireLeases } from './services/tasks.js';

let cfg: Config;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(`hive-mcp: configuration error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const isLocalUrl = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(cfg.publicUrl);
const db = openDb(cfg.dbPath);
const boot = bootstrapAdmin(db, cfg.adminName, cfg.adminKey);
const { app, provider, mcpUrl } = createApp(cfg, db);

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`hive-mcp ${VERSION} listening on http://${cfg.host}:${cfg.port}`);
  console.log(`  workspace : ${cfg.teamName}`);
  console.log(`  public URL: ${cfg.publicUrl}`);
  console.log(`  MCP URL   : ${mcpUrl}`);
  console.log(`  database  : ${cfg.dbPath}`);
  if (isLocalUrl) {
    console.log('  note      : a localhost URL works for Claude Code and the MCP Inspector on this machine;');
    console.log('              Claude.ai needs a public https URL (set DOMAIN with docker compose, or PUBLIC_URL).');
  } else if (!cfg.publicUrl.startsWith('https://')) {
    console.warn(`  WARNING   : PUBLIC_URL ${cfg.publicUrl} is not https; Claude.ai only connects to https URLs.`);
  }
  if (boot.created) {
    console.log('');
    console.log(`  Created admin member "${boot.user.name}".`);
    if (boot.key) {
      console.log('  ADMIN API KEY (shown once; store it somewhere safe):');
      console.log(`    ${boot.key}`);
    } else {
      console.log('  Admin API key taken from HIVE_ADMIN_KEY.');
    }
    console.log('');
    console.log('  Next steps:');
    console.log(`    1. In Claude: Customize → Connectors → Add custom connector → ${mcpUrl}`);
    console.log('    2. Choose Sign in and paste the admin API key.');
    console.log('    3. Ask Claude to "create an invite for <name>" and send them the share_message it returns.');
    console.log('');
  }
});

const housekeeping = setInterval(() => {
  try {
    provider.cleanupExpired();
    expireLeases(db);
  } catch (err) {
    console.error('housekeeping failed:', err);
  }
}, 60_000);
housekeeping.unref();

function shutdown(signal: string): void {
  console.log(`received ${signal}, shutting down`);
  clearInterval(housekeeping);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
