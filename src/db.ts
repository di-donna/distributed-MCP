import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_txns (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  grant_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS kb_docs (
  rid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL DEFAULT 'doc',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  tags_text TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_by_name TEXT,
  updated_by TEXT,
  updated_by_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_docs_kind ON kb_docs(kind, updated_at);
CREATE INDEX IF NOT EXISTS idx_kb_docs_project ON kb_docs(project, updated_at);

CREATE TABLE IF NOT EXISTS kb_versions (
  doc_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL,
  meta TEXT NOT NULL,
  updated_by TEXT,
  updated_by_name TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, version)
);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  title, content, tags_text, path,
  content='kb_docs', content_rowid='rid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS kb_docs_ai AFTER INSERT ON kb_docs BEGIN
  INSERT INTO kb_fts(rowid, title, content, tags_text, path) VALUES (new.rid, new.title, new.content, new.tags_text, new.path);
END;
CREATE TRIGGER IF NOT EXISTS kb_docs_ad AFTER DELETE ON kb_docs BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, title, content, tags_text, path) VALUES ('delete', old.rid, old.title, old.content, old.tags_text, old.path);
END;
CREATE TRIGGER IF NOT EXISTS kb_docs_au AFTER UPDATE ON kb_docs BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, title, content, tags_text, path) VALUES ('delete', old.rid, old.title, old.content, old.tags_text, old.path);
  INSERT INTO kb_fts(rowid, title, content, tags_text, path) VALUES (new.rid, new.title, new.content, new.tags_text, new.path);
END;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  inputs TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  requires TEXT NOT NULL DEFAULT '[]',
  depends_on TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_by_name TEXT,
  claimed_by TEXT,
  claimed_by_name TEXT,
  claimed_at INTEGER,
  lease_seconds INTEGER NOT NULL DEFAULT 900,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  progress TEXT,
  result TEXT,
  result_kb_path TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project, status, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL DEFAULT 'default',
  stream TEXT NOT NULL DEFAULT 'general',
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  data TEXT,
  user_id TEXT,
  user_name TEXT,
  agent_id TEXT,
  agent_name TEXT,
  task_id TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_stream ON logs(stream, id);
CREATE INDEX IF NOT EXISTS idx_logs_project ON logs(project, id);
CREATE INDEX IF NOT EXISTS idx_logs_task ON logs(task_id, id);

CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
  message, stream,
  content='logs', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS logs_ai AFTER INSERT ON logs BEGIN
  INSERT INTO logs_fts(rowid, message, stream) VALUES (new.id, new.message, new.stream);
END;
CREATE TRIGGER IF NOT EXISTS logs_ad AFTER DELETE ON logs BEGIN
  INSERT INTO logs_fts(logs_fts, rowid, message, stream) VALUES ('delete', old.id, old.message, old.stream);
END;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL DEFAULT 'general',
  from_user TEXT NOT NULL,
  from_user_name TEXT,
  from_agent TEXT,
  from_agent_name TEXT,
  to_agent TEXT,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, id);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, id);

-- A conversation the member explicitly shared with one project; its id is required for every write.
CREATE TABLE IF NOT EXISTS share_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_share_sessions_project ON share_sessions(project, last_used_at);
CREATE INDEX IF NOT EXISTS idx_share_sessions_user ON share_sessions(user_id, last_used_at);
`;

/** Columns added after the first release; applied to existing databases on open. */
const ADDED_COLUMNS: Array<{ table: string; column: string; type: string; index?: string }> = [
  { table: 'logs', column: 'session_id', type: 'TEXT', index: 'CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session_id)' },
  { table: 'messages', column: 'session_id', type: 'TEXT', index: 'CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)' },
  { table: 'tasks', column: 'session_id', type: 'TEXT', index: 'CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)' }
];

function migrate(db: DB): void {
  for (const { table, column, type, index } of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    if (index) db.exec(index);
  }
}

export function openDb(path: string): DB {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
