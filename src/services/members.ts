import type { DB } from '../db.js';
import { HiveError, assertMemberName, now, randomId, randomSecret, sha256 } from '../util.js';

export type Role = 'admin' | 'member';

export interface User {
  id: string;
  name: string;
  role: Role;
  created_at: number;
  last_seen_at: number | null;
}

export interface ApiKeyInfo {
  id: string;
  user_id: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface Invite {
  id: string;
  created_by: string | null;
  role: Role;
  max_uses: number;
  uses: number;
  note: string | null;
  created_at: number;
  expires_at: number | null;
}

export const API_KEY_PREFIX = 'hv_key_';
export const INVITE_PREFIX = 'hv_inv_';

// ---------- users ----------

export function countUsers(db: DB): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n;
}

export function getUser(db: DB, id: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getUserByName(db: DB, name: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name) as User | undefined;
}

export function listUsers(db: DB): User[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all() as User[];
}

export function createUser(db: DB, input: { name: string; role?: Role }): User {
  const name = assertMemberName(input.name);
  if (getUserByName(db, name)) throw new HiveError(`a member named "${name}" already exists`, 'conflict');
  const user: User = { id: randomId('usr'), name, role: input.role ?? 'member', created_at: now(), last_seen_at: null };
  db.prepare('INSERT INTO users (id, name, role, created_at) VALUES (?, ?, ?, ?)').run(user.id, user.name, user.role, user.created_at);
  return user;
}

export function setUserRole(db: DB, userId: string, role: Role): void {
  const r = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  if (r.changes === 0) throw new HiveError('member not found', 'not_found');
}

export function touchUser(db: DB, userId: string): void {
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), userId);
}

// ---------- api keys ----------

export function createApiKey(db: DB, userId: string, label?: string): { id: string; key: string; label: string | null } {
  if (!getUser(db, userId)) throw new HiveError('member not found', 'not_found');
  const key = randomSecret(API_KEY_PREFIX, 30);
  const id = randomId('key', 8);
  db.prepare('INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    userId,
    sha256(key),
    label ?? null,
    now()
  );
  return { id, key, label: label ?? null };
}

export function resolveApiKey(db: DB, key: string): { user: User; keyId: string } | undefined {
  const row = db
    .prepare(
      `SELECT k.id AS key_id, u.* FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ? AND k.revoked_at IS NULL`
    )
    .get(sha256(key)) as (User & { key_id: string }) | undefined;
  if (!row) return undefined;
  const { key_id, ...user } = row;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), key_id);
  return { user, keyId: key_id };
}

export function listApiKeys(db: DB, userId?: string): ApiKeyInfo[] {
  if (userId) {
    return db
      .prepare('SELECT id, user_id, label, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at')
      .all(userId) as ApiKeyInfo[];
  }
  return db.prepare('SELECT id, user_id, label, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at').all() as ApiKeyInfo[];
}

export function revokeApiKey(db: DB, keyId: string, onlyForUserId?: string): void {
  const r = onlyForUserId
    ? db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now(), keyId, onlyForUserId)
    : db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), keyId);
  if (r.changes === 0) throw new HiveError('API key not found (or already revoked)', 'not_found');
}

// ---------- invites ----------

export function createInvite(
  db: DB,
  input: { createdBy?: string; role?: Role; maxUses?: number; expiresInHours?: number; note?: string }
): { invite: Invite; code: string } {
  const code = randomSecret(INVITE_PREFIX, 15);
  const ts = now();
  const invite: Invite = {
    id: randomId('inv', 8),
    created_by: input.createdBy ?? null,
    role: input.role ?? 'member',
    max_uses: Math.max(1, Math.min(1000, Math.trunc(input.maxUses ?? 1))),
    uses: 0,
    note: input.note ?? null,
    created_at: ts,
    expires_at: input.expiresInHours && input.expiresInHours > 0 ? ts + Math.trunc(input.expiresInHours * 3600) : null
  };
  db.prepare(
    `INSERT INTO invites (id, code_hash, created_by, role, max_uses, uses, note, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(invite.id, sha256(code), invite.created_by, invite.role, invite.max_uses, invite.note, invite.created_at, invite.expires_at);
  return { invite, code };
}

export function listInvites(db: DB): Invite[] {
  return db
    .prepare('SELECT id, created_by, role, max_uses, uses, note, created_at, expires_at FROM invites ORDER BY created_at DESC')
    .all() as Invite[];
}

/** Consume an invite code and create the member. Throws on any problem. */
export function redeemInvite(db: DB, code: string, name: string): User {
  return db.transaction(() => {
    const inv = db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(sha256(code.trim())) as (Invite & { code_hash: string }) | undefined;
    if (!inv) throw new HiveError('invite code not recognised', 'invalid_invite');
    if (inv.expires_at && inv.expires_at < now()) throw new HiveError('invite code has expired', 'invalid_invite');
    if (inv.uses >= inv.max_uses) throw new HiveError('invite code has already been used', 'invalid_invite');
    const user = createUser(db, { name, role: inv.role });
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?').run(inv.id);
    return user;
  })();
}

/** Create the first admin if the database is empty. Returns the generated key only when one was created. */
export function bootstrapAdmin(db: DB, adminName: string, presetKey?: string): { user: User; key?: string; created: boolean } {
  const existing = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as User | undefined;
  if (existing) return { user: existing, created: false };
  return db.transaction(() => {
    const user = createUser(db, { name: adminName, role: 'admin' });
    if (presetKey) {
      db.prepare('INSERT INTO api_keys (id, user_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)').run(
        randomId('key', 8),
        user.id,
        sha256(presetKey),
        'bootstrap (HIVE_ADMIN_KEY)',
        now()
      );
      return { user, created: true };
    }
    const { key } = createApiKey(db, user.id, 'bootstrap');
    return { user, key, created: true };
  })();
}
