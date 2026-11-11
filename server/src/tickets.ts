// SPDX-License-Identifier: AGPL-3.0-only
// Tickets (ADR 0001): approvals, proposals and challenges. The server owns the lifecycle:
// open -> claimed(resolverId) -> resolved | failed | expired (challenges); open -> approved | denied | expired.
import { EventEmitter } from "node:events";
import { now, inMs, type DB } from "./db.ts";
import { randomId } from "./crypto.ts";

export const TICKET_TTL_MS = 15 * 60 * 1000;
export const MAX_OPEN_PROPOSALS = 3;
export const DENIED_PROPOSAL_COOLDOWN_MS = 24 * 3600 * 1000;

export type TicketKind = "approval" | "proposal" | "challenge";
export type TicketState = "open" | "claimed" | "resolved" | "failed" | "expired" | "approved" | "denied";

export interface Ticket<F = Record<string, unknown>> {
  id: string;
  userId: string;
  tokenId: string | null;
  agentName: string | null;
  kind: TicketKind;
  state: TicketState;
  resolverId: string | null;
  dedupeKey: string | null;
  facts: F;
  agentReason: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolution: Record<string, unknown> | null;
}

const FINAL: ReadonlySet<TicketState> = new Set(["resolved", "failed", "expired", "approved", "denied"]);

interface Row {
  id: string;
  user_id: string;
  token_id: string | null;
  agent_name: string | null;
  kind: TicketKind;
  state: TicketState;
  resolver_id: string | null;
  dedupe_key: string | null;
  facts: string;
  agent_reason: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

const toTicket = (r: Row): Ticket => ({
  id: r.id,
  userId: r.user_id,
  tokenId: r.token_id,
  agentName: r.agent_name,
  kind: r.kind,
  state: r.state,
  resolverId: r.resolver_id,
  dedupeKey: r.dedupe_key,
  facts: JSON.parse(r.facts),
  agentReason: r.agent_reason,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  resolvedAt: r.resolved_at,
  resolution: r.resolution ? JSON.parse(r.resolution) : null,
});

export class TicketError extends Error {}

export class Tickets extends EventEmitter {
  private readonly db: DB;
  ttlMs = TICKET_TTL_MS;
  constructor(db: DB) {
    super();
    this.db = db;
    this.setMaxListeners(1000);
  }

  create(t: { userId: string; tokenId: string | null; agentName: string | null; kind: TicketKind; facts: unknown; agentReason?: string | null; dedupeKey?: string | null }): Ticket {
    if (t.kind === "proposal" && t.dedupeKey) {
      // Identical proposals collapse into one.
      const existing = this.db.prepare("SELECT * FROM tickets WHERE user_id = ? AND kind = 'proposal' AND dedupe_key = ? AND state = 'open'").get(t.userId, t.dedupeKey) as Row | undefined;
      if (existing) return toTicket(existing);
      const denied = this.db.prepare("SELECT until FROM denied_proposals WHERE user_id = ? AND dedupe_key = ?").get(t.userId, t.dedupeKey) as { until: string } | undefined;
      if (denied && Date.parse(denied.until) > Date.now()) throw new TicketError("This proposal was denied in the last 24 hours and can't be raised again yet.");
      const open = (this.db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE user_id = ? AND kind = 'proposal' AND state = 'open'").get(t.userId) as { n: number }).n;
      if (open >= MAX_OPEN_PROPOSALS) throw new TicketError(`At most ${MAX_OPEN_PROPOSALS} proposals can be open. Wait for a person to answer.`);
    }
    const id = randomId(12);
    this.db
      .prepare("INSERT INTO tickets (id, user_id, token_id, agent_name, kind, state, dedupe_key, facts, agent_reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)")
      .run(id, t.userId, t.tokenId, t.agentName, t.kind, t.dedupeKey ?? null, JSON.stringify(t.facts), t.agentReason ?? null, now(), inMs(this.ttlMs));
    const ticket = this.get(id)!;
    this.emit("created", ticket);
    return ticket;
  }

  get(id: string): Ticket | null {
    const r = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Row | undefined;
    return r ? toTicket(r) : null;
  }

  getFor(id: string, userId: string): Ticket | null {
    const t = this.get(id);
    return t && t.userId === userId ? t : null;
  }

  listOpen(userId: string): Ticket[] {
    this.sweep();
    return (this.db.prepare("SELECT * FROM tickets WHERE user_id = ? AND state IN ('open','claimed') ORDER BY created_at DESC").all(userId) as unknown as Row[]).map(toTicket);
  }

  private transition(id: string, from: TicketState[], to: TicketState, extra: { resolverId?: string | null; resolution?: unknown } = {}): Ticket {
    this.sweep();
    const t = this.get(id);
    if (!t) throw new TicketError("No such ticket.");
    if (!from.includes(t.state)) throw new TicketError(`Ticket is ${t.state}; can't move to ${to}.`);
    this.db
      .prepare("UPDATE tickets SET state = ?, resolver_id = COALESCE(?, resolver_id), resolution = COALESCE(?, resolution), resolved_at = CASE WHEN ? THEN ? ELSE resolved_at END WHERE id = ?")
      .run(to, extra.resolverId ?? null, extra.resolution === undefined ? null : JSON.stringify(extra.resolution), FINAL.has(to) ? 1 : 0, now(), id);
    const next = this.get(id)!;
    this.emit("changed", next);
    return next;
  }

  approve(id: string, resolution: Record<string, unknown>): Ticket {
    const t = this.get(id);
    if (t?.kind === "challenge") throw new TicketError("Challenges are resolved by a resolver and checked by the verifier, not approved.");
    return this.transition(id, ["open"], "approved", { resolution });
  }

  deny(id: string, reason = "denied by a person"): Ticket {
    const t = this.transition(id, ["open", "claimed"], "denied", { resolution: { reason } });
    if (t.kind === "proposal" && t.dedupeKey) {
      this.db.prepare("INSERT INTO denied_proposals (user_id, dedupe_key, until) VALUES (?, ?, ?) ON CONFLICT(user_id, dedupe_key) DO UPDATE SET until = excluded.until").run(t.userId, t.dedupeKey, inMs(DENIED_PROPOSAL_COOLDOWN_MS));
    }
    return t;
  }

  claim(id: string, resolverId: string): Ticket {
    return this.transition(id, ["open"], "claimed", { resolverId });
  }
  /** Only the verifier calls these for challenges. */
  resolve(id: string, resolution: Record<string, unknown> = {}): Ticket {
    return this.transition(id, ["claimed"], "resolved", { resolution });
  }
  fail(id: string, reason: string): Ticket {
    return this.transition(id, ["claimed", "open"], "failed", { resolution: { reason } });
  }
  /** The verifier found the block still there: back to open. */
  reopen(id: string): Ticket {
    const t = this.transition(id, ["claimed"], "open", {});
    this.db.prepare("UPDATE tickets SET resolver_id = NULL WHERE id = ?").run(id);
    return t;
  }

  sweep(at = Date.now()): void {
    const expired = this.db.prepare("SELECT * FROM tickets WHERE state IN ('open','claimed') AND expires_at < ?").all(new Date(at).toISOString()) as unknown as Row[];
    for (const r of expired) {
      this.db.prepare("UPDATE tickets SET state = 'expired', resolved_at = ? WHERE id = ?").run(new Date(at).toISOString(), r.id);
      this.emit("changed", this.get(r.id)!);
    }
  }

  /** Resolves when the ticket reaches a final state or the timeout passes. */
  wait(id: string, timeoutMs: number): Promise<Ticket | null> {
    const t = this.get(id);
    if (!t || FINAL.has(t.state)) return Promise.resolve(t);
    return new Promise((resolve) => {
      const onChange = (x: Ticket) => {
        if (x.id === id && FINAL.has(x.state)) finish(x);
      };
      const timer = setTimeout(() => {
        this.sweep();
        finish(this.get(id));
      }, timeoutMs);
      const expiry = setTimeout(() => this.sweep(), Math.max(0, Date.parse(t.expiresAt) - Date.now() + 5));
      const finish = (x: Ticket | null) => {
        clearTimeout(timer);
        clearTimeout(expiry);
        this.off("changed", onChange);
        resolve(x);
      };
      this.on("changed", onChange);
    });
  }
}

export const isFinal = (s: TicketState) => FINAL.has(s);
