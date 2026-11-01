import { createApp } from './app.js';
import { VERSION, loadConfig } from './config.js';
import { openDb } from './db.js';
import { bootstrapAdmin } from './services/members.js';
import { expireLeases } from './services/tasks.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const boot = bootstrapAdmin(db, cfg.adminName, cfg.adminKey);
const { app, provider, mcpUrl } = createApp(cfg, db);

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`hive-mcp ${VERSION} listening on http://${cfg.host}:${cfg.port}`);
  console.log(`  workspace : ${cfg.teamName}`);
  console.log(`  public URL: ${cfg.publicUrl}`);
  console.log(`  MCP URL   : ${mcpUrl}`);
  console.log(`  database  : ${cfg.dbPath}`);
  if (boot.created) {
    console.log('');
    console.log(`  Created admin member "${boot.user.name}".`);
    if (boot.key) {
      console.log('  ADMIN API KEY (shown once; store it somewhere safe):');
      console.log(`    ${boot.key}`);
    } else {
      console.log('  Admin API key taken from HIVE_ADMIN_KEY.');
    }
    console.log('  Use it as "Authorization: Bearer <key>" or paste it on the sign-in page, then run invite_create to add teammates.');
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
