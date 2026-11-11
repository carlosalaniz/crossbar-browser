// SPDX-License-Identifier: AGPL-3.0-only
// Activity log: the *shape* of data each request carries, not its values (Access Model).
// Append-only, 90 days. Flagged rows keep their values sealed (AES-GCM) for 30 days.
import { now, type DB } from "./db.ts";
import type { Keys } from "./crypto.ts";
import { registrable } from "./sites.ts";

export const RETENTION_MS = 90 * 24 * 3600 * 1000;
export const SEALED_RETENTION_MS = 30 * 24 * 3600 * 1000;

export type ValueType = "number" | "text" | "url" | "json" | "base64" | "hex" | "empty";
export interface Shape {
  where: "query" | "fragment" | "path" | "body";
  key: string;
  type: ValueType;
  length: number;
  entropy: "low" | "medium" | "high";
  hash: string;
}

export function valueType(v: string): ValueType {
  if (v === "") return "empty";
  if (/^-?\d+(\.\d+)?$/.test(v)) return "number";
  if (/^https?:\/\//i.test(v)) return "url";
  if (/^[\[{]/.test(v.trim())) {
    try {
      JSON.parse(v);
      return "json";
    } catch {
      /* not json */
    }
  }
  if (v.length >= 16 && /^[0-9a-f]+$/i.test(v)) return "hex";
  if (v.length >= 16 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v)) return "base64";
  return "text";
}

/** Shannon entropy per character, banded. */
export function entropyBand(v: string): Shape["entropy"] {
  if (v.length < 8) return "low";
  const counts = new Map<string, number>();
  for (const ch of v) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / v.length;
    h -= p * Math.log2(p);
  }
  return h < 3 ? "low" : h < 4.2 ? "medium" : "high";
}

export function extractValues(url: string, body?: string): Array<{ where: Shape["where"]; key: string; value: string }> {
  const out: Array<{ where: Shape["where"]; key: string; value: string }> = [];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return out;
  }
  for (const [k, v] of u.searchParams) out.push({ where: "query", key: k, value: v });
  if (u.hash.length > 1) {
    const frag = u.hash.slice(1);
    if (frag.includes("=")) for (const [k, v] of new URLSearchParams(frag)) out.push({ where: "fragment", key: k, value: v });
    else out.push({ where: "fragment", key: "#", value: decodeURIComponent(frag) });
  }
  u.pathname
    .split("/")
    .filter(Boolean)
    .forEach((seg, i) => out.push({ where: "path", key: `[${i}]`, value: safeDecode(seg) }));
  if (body) {
    const t = body.trim();
    if (t.startsWith("{")) {
      try {
        const obj = JSON.parse(t) as Record<string, unknown>;
        for (const [k, v] of Object.entries(obj)) out.push({ where: "body", key: k, value: typeof v === "string" ? v : JSON.stringify(v) });
      } catch {
        out.push({ where: "body", key: "(raw)", value: t });
      }
    } else if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(t)) {
      for (const [k, v] of new URLSearchParams(t)) out.push({ where: "body", key: k, value: v });
    } else out.push({ where: "body", key: "(raw)", value: t });
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function shapesOf(keys: Keys, url: string, body?: string): Shape[] {
  return extractValues(url, body).map(({ where, key, value }) => ({ where, key, type: valueType(value), length: value.length, entropy: entropyBand(value), hash: keys.keyedHash(value) }));
}

/** Text read while signed in, indexed as normalised 12-character shingles for overlap checks. */
export class ReadTextIndex {
  private readonly shingles = new Set<string>();
  static readonly N = 12;
  add(text: string): void {
    const t = normalise(text);
    for (let i = 0; i + ReadTextIndex.N <= t.length; i += 3) this.shingles.add(t.slice(i, i + ReadTextIndex.N));
    if (this.shingles.size > 500_000) this.shingles.clear();
  }
  /** Approximate number of characters of `value` that appear in the indexed text. */
  overlap(value: string): number {
    const t = normalise(value);
    if (t.length < ReadTextIndex.N) return 0;
    let hit = 0;
    let lastEnd = -1;
    for (let i = 0; i + ReadTextIndex.N <= t.length; i++) {
      if (this.shingles.has(t.slice(i, i + ReadTextIndex.N))) {
        hit += Math.min(ReadTextIndex.N, i + ReadTextIndex.N - Math.max(i, lastEnd));
        lastEnd = i + ReadTextIndex.N;
      }
    }
    return hit;
  }
  get size() {
    return this.shingles.size;
  }
}
const normalise = (s: string) => s.toLowerCase().replace(/[\s+_\-]+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "");

export interface ActivityRow {
  userId: string;
  tokenId?: string | null;
  agentName?: string | null;
  sessionId?: string | null;
  tabId?: string | null;
  profile?: string | null;
  initiator: "agent" | "page" | "redirect" | "human";
  method: string;
  url: string;
  operation?: string | null;
  novelty?: string | null;
  shapes: Shape[];
  tainted: boolean;
  taintSource?: string | null;
  overlapChars: number;
  outcome: "allowed" | "anonymous" | "held" | "approved" | "denied" | "blocked" | "blocked_ad" | "timeout";
  rule?: string | null;
  flagged?: boolean;
  values?: Record<string, string> | null;
}

export class Activity {
  private readonly db: DB;
  private readonly keys: Keys;
  constructor(db: DB, keys: Keys) {
    this.db = db;
    this.keys = keys;
  }

  log(r: ActivityRow): number {
    let schemeHost = "";
    let path = "";
    try {
      const u = new URL(r.url);
      schemeHost = `${u.protocol}//${u.host}`;
      path = u.pathname;
    } catch {
      /* keep empty */
    }
    const info = this.db
      .prepare(
        `INSERT INTO activity (ts, user_id, token_id, agent_name, session_id, tab_id, profile, initiator, method, scheme_host, domain, path, operation, novelty, shapes, tainted, taint_source, overlap_chars, outcome, rule, flagged, sealed_values)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(),
        r.userId,
        r.tokenId ?? null,
        r.agentName ?? null,
        r.sessionId ?? null,
        r.tabId ?? null,
        r.profile ?? null,
        r.initiator,
        r.method,
        schemeHost,
        schemeHost ? registrable(schemeHost) : "",
        path,
        r.operation ?? null,
        r.novelty ?? null,
        JSON.stringify(r.shapes),
        r.tainted ? 1 : 0,
        r.taintSource ?? null,
        r.overlapChars,
        r.outcome,
        r.rule ?? null,
        r.flagged ? 1 : 0,
        r.flagged && r.values ? this.keys.seal(JSON.stringify(r.values)) : null,
      );
    return Number(info.lastInsertRowid);
  }

  /** Plain resource GETs are counted per domain per session, not logged one by one. */
  count(userId: string, sessionId: string, domain: string): void {
    const day = now().slice(0, 10);
    this.db
      .prepare("INSERT INTO resource_counts (user_id, session_id, domain, count, day) VALUES (?, ?, ?, 1, ?) ON CONFLICT(user_id, session_id, domain, day) DO UPDATE SET count = count + 1")
      .run(userId, sessionId, domain, day);
  }

  /** Rows for a person (all theirs) or an agent (its own, never values). */
  list(userId: string, opts: { tokenId?: string; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 50, 500);
    const rows = (
      opts.tokenId
        ? this.db.prepare("SELECT * FROM activity WHERE user_id = ? AND token_id = ? ORDER BY id DESC LIMIT ?").all(userId, opts.tokenId, limit)
        : this.db.prepare("SELECT * FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      agent: r.agent_name,
      profile: r.profile,
      initiator: r.initiator,
      method: r.method,
      host: r.scheme_host,
      domain: r.domain,
      path: r.path,
      operation: r.operation,
      novelty: r.novelty,
      shapes: JSON.parse(String(r.shapes)),
      tainted: !!r.tainted,
      taintSource: r.taint_source,
      overlapChars: r.overlap_chars,
      outcome: r.outcome,
      rule: r.rule,
      flagged: !!r.flagged,
    }));
  }

  /** The person can open a flagged row's sealed values. Never exposed to tokens. */
  unseal(userId: string, id: number): Record<string, string> | null {
    const r = this.db.prepare("SELECT sealed_values FROM activity WHERE user_id = ? AND id = ?").get(userId, id) as { sealed_values: string | null } | undefined;
    return r?.sealed_values ? JSON.parse(this.keys.unseal(r.sealed_values)) : null;
  }

  retention(at = Date.now()): void {
    this.db.prepare("UPDATE activity SET sealed_values = NULL WHERE sealed_values IS NOT NULL AND ts < ?").run(new Date(at - SEALED_RETENTION_MS).toISOString());
    this.db.prepare("DELETE FROM activity WHERE ts < ?").run(new Date(at - RETENTION_MS).toISOString());
    this.db.prepare("DELETE FROM resource_counts WHERE day < ?").run(new Date(at - RETENTION_MS).toISOString().slice(0, 10));
  }
}
