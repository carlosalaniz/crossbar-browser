// SPDX-License-Identifier: AGPL-3.0-only
// SQLite (node:sqlite) for v1. One file under the data dir.
import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  fresh_until TEXT
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('read','act')),
  secret_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used TEXT,
  revoked_at TEXT,
  revoked_reason TEXT
);

CREATE TABLE IF NOT EXISTS sites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  level TEXT NOT NULL,
  adblock INTEGER NOT NULL DEFAULT 1,
  device TEXT NOT NULL DEFAULT 'desktop',
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, pattern)
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id TEXT,
  task_key TEXT,
  domain TEXT NOT NULL,
  action_class TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  last_used TEXT,
  expires_at TEXT,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id TEXT,
  agent_name TEXT,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  resolver_id TEXT,
  dedupe_key TEXT,
  facts TEXT NOT NULL,
  agent_reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS tickets_open ON tickets (user_id, state);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_id TEXT,
  agent_name TEXT,
  session_id TEXT,
  tab_id TEXT,
  profile TEXT,
  initiator TEXT,
  method TEXT,
  scheme_host TEXT,
  domain TEXT,
  path TEXT,
  operation TEXT,
  novelty TEXT,
  shapes TEXT,
  tainted INTEGER NOT NULL DEFAULT 0,
  taint_source TEXT,
  overlap_chars INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  rule TEXT,
  flagged INTEGER NOT NULL DEFAULT 0,
  sealed_values TEXT
);
CREATE INDEX IF NOT EXISTS activity_user ON activity (user_id, id);
-- Append-only: agents can't edit or delete; retention deletes by age only.
CREATE TRIGGER IF NOT EXISTS activity_no_update BEFORE UPDATE ON activity
  WHEN NEW.sealed_values IS NOT OLD.sealed_values AND NEW.sealed_values IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'activity is append-only'); END;
CREATE TRIGGER IF NOT EXISTS activity_no_update_fields BEFORE UPDATE OF ts, user_id, token_id, agent_name, method, scheme_host, domain, path, shapes, outcome, rule ON activity
  BEGIN SELECT RAISE(ABORT, 'activity is append-only'); END;

CREATE TABLE IF NOT EXISTS resource_counts (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  count INTEGER NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id, domain, day)
);

CREATE TABLE IF NOT EXISTS flags (
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, domain)
);

CREATE TABLE IF NOT EXISTS denied_proposals (
  user_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  until TEXT NOT NULL,
  PRIMARY KEY (user_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();
export const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

export function getMeta(db: DB, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}
export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
export function getSetting(db: DB, userId: string, key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE user_id = ? AND key = ?").get(userId, key) as { value: string } | undefined)?.value;
}
export function setSetting(db: DB, userId: string, key: string, value: string | null): void {
  if (value === null) db.prepare("DELETE FROM settings WHERE user_id = ? AND key = ?").run(userId, key);
  else db.prepare("INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value").run(userId, key, value);
}
