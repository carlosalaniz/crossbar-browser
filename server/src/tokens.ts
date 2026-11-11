// SPDX-License-Identifier: AGPL-3.0-only
// Agent tokens: read or act, with a required agent name. Stored as SHA-256; the secret is shown once.
import type { TokenKind } from "@crossbar/shared";
import { now, getSetting, type DB } from "./db.ts";
import { randomId, sha256 } from "./crypto.ts";

export const UNUSED_REVOKE_MS = 90 * 24 * 3600 * 1000;

export interface TokenInfo {
  id: string;
  userId: string;
  agentName: string;
  kind: TokenKind;
}

export class Tokens {
  private readonly db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  create(userId: string, agentName: string, kind: TokenKind): { id: string; secret: string } {
    const id = randomId(9);
    const secret = `cb_${kind}_${randomId(32)}`;
    this.db.prepare("INSERT INTO tokens (id, user_id, agent_name, kind, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, userId, agentName, kind, sha256(secret), now());
    return { id, secret };
  }

  /** Returns the token if valid. Revokes tokens unused for 90 days. Refuses everything during panic. */
  verify(secret: string, at = Date.now()): TokenInfo | null {
    if (!secret.startsWith("cb_")) return null;
    const row = this.db.prepare("SELECT id, user_id, agent_name, kind, created_at, last_used, revoked_at FROM tokens WHERE secret_hash = ?").get(sha256(secret)) as
      | { id: string; user_id: string; agent_name: string; kind: TokenKind; created_at: string; last_used: string | null; revoked_at: string | null }
      | undefined;
    if (!row || row.revoked_at) return null;
    const lastActivity = Date.parse(row.last_used ?? row.created_at);
    if (at - lastActivity > UNUSED_REVOKE_MS) {
      this.revoke(row.id, row.user_id, "unused for 90 days");
      return null;
    }
    if (getSetting(this.db, row.user_id, "panic")) return null;
    this.db.prepare("UPDATE tokens SET last_used = ? WHERE id = ?").run(new Date(at).toISOString(), row.id);
    return { id: row.id, userId: row.user_id, agentName: row.agent_name, kind: row.kind };
  }

  list(userId: string) {
    return this.db.prepare("SELECT id, agent_name AS agentName, kind, created_at AS createdAt, last_used AS lastUsed, revoked_at AS revokedAt, revoked_reason AS revokedReason FROM tokens WHERE user_id = ? ORDER BY created_at DESC").all(userId);
  }

  revoke(id: string, userId: string, reason: string): boolean {
    return this.db.prepare("UPDATE tokens SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(now(), reason, id, userId).changes > 0;
  }

  /** Daily sweep for the 90-day rule, so unused tokens are revoked even if never presented. */
  sweep(at = Date.now()): number {
    const cutoff = new Date(at - UNUSED_REVOKE_MS).toISOString();
    return Number(this.db.prepare("UPDATE tokens SET revoked_at = ?, revoked_reason = 'unused for 90 days' WHERE revoked_at IS NULL AND COALESCE(last_used, created_at) < ?").run(new Date(at).toISOString(), cutoff).changes);
  }
}
