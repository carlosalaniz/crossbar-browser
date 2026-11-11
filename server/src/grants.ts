// SPDX-License-Identifier: AGPL-3.0-only
// Grants created by a person's approval. once: one request. task: token + task + site + class, 1 h idle.
// always: site + class, lapses after 90 days unused. Irreversible classes only honour "once".
import { ALWAYS_ASK, type ActionClass, type GrantScope } from "@crossbar/shared";
import { now, type DB } from "./db.ts";
import { randomId } from "./crypto.ts";

export const TASK_IDLE_MS = 3600 * 1000;
export const ALWAYS_UNUSED_MS = 90 * 24 * 3600 * 1000;

export interface GrantRow {
  id: string;
  user_id: string;
  token_id: string | null;
  task_key: string | null;
  domain: string;
  action_class: ActionClass;
  scope: GrantScope;
  request_hash: string | null;
  created_at: string;
  last_used: string | null;
  used: number;
}

export class Grants {
  private readonly db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  add(g: { userId: string; tokenId: string | null; taskKey: string | null; domain: string; actionClass: ActionClass; scope: GrantScope; requestHash: string | null }): string {
    const id = randomId(9);
    this.db
      .prepare("INSERT INTO grants (id, user_id, token_id, task_key, domain, action_class, scope, request_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, g.userId, g.scope === "always" ? null : g.tokenId, g.scope === "task" ? g.taskKey : null, g.domain, g.actionClass, g.scope, g.requestHash, now());
    return id;
  }

  /** Whether a matching grant exists, without consuming it. */
  peek(q: { userId: string; tokenId: string; taskKey: string; domain: string; actionClass: ActionClass; requestHash: string }, at = Date.now()): boolean {
    return !!this.use(q, at, false);
  }

  /** Finds and consumes a matching grant. */
  use(q: { userId: string; tokenId: string; taskKey: string; domain: string; actionClass: ActionClass; requestHash: string }, at = Date.now(), consume = true): GrantRow | null {
    const rows = this.db.prepare("SELECT * FROM grants WHERE user_id = ? AND domain = ? AND action_class = ? AND used = 0").all(q.userId, q.domain, q.actionClass) as unknown as GrantRow[];
    const alwaysAsk = ALWAYS_ASK.has(q.actionClass);
    for (const g of rows) {
      const last = Date.parse(g.last_used ?? g.created_at);
      if (g.scope === "once") {
        if (g.token_id !== q.tokenId) continue;
        if (g.request_hash && g.request_hash !== q.requestHash) continue;
        if (!consume) return g;
        this.db.prepare("UPDATE grants SET used = 1, last_used = ? WHERE id = ?").run(new Date(at).toISOString(), g.id);
        return g;
      }
      if (alwaysAsk) continue;
      if (g.scope === "task") {
        if (g.token_id !== q.tokenId || g.task_key !== q.taskKey) continue;
        if (at - last > TASK_IDLE_MS) continue;
      }
      if (g.scope === "always" && at - last > ALWAYS_UNUSED_MS) continue;
      if (!consume) return g;
      this.db.prepare("UPDATE grants SET last_used = ? WHERE id = ?").run(new Date(at).toISOString(), g.id);
      return g;
    }
    return null;
  }

  list(userId: string, tokenId?: string) {
    const all = this.db.prepare("SELECT id, token_id AS tokenId, task_key AS taskKey, domain, action_class AS actionClass, scope, created_at AS createdAt, last_used AS lastUsed FROM grants WHERE user_id = ? AND used = 0 ORDER BY created_at DESC").all(userId) as Array<{ tokenId: string | null }>;
    return tokenId ? all.filter((g) => g.tokenId === null || g.tokenId === tokenId) : all;
  }

  revoke(id: string, userId: string): boolean {
    return this.db.prepare("DELETE FROM grants WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  }

  /** Panic: drop every grant (act and signed-in). */
  dropAll(userId: string): void {
    this.db.prepare("DELETE FROM grants WHERE user_id = ?").run(userId);
  }

  /** Offer "Always" after 3 "once" approvals for the same site and class. */
  onceCount(userId: string, domain: string, actionClass: ActionClass): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM grants WHERE user_id = ? AND domain = ? AND action_class = ? AND scope = 'once'").get(userId, domain, actionClass) as { n: number }).n;
  }
}
