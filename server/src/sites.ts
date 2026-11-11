// SPDX-License-Identifier: AGPL-3.0-only
// Site ladder (Access Model): one level per registrable domain (Public Suffix List),
// specific host rules override it, the most specific rule wins.
import { getDomain, getHostname } from "tldts";
import { isIP } from "node:net";
import { LEVEL_RANK, type SiteLevel, type SiteRule } from "@crossbar/shared";
import { now, type DB } from "./db.ts";

/** Registrable domain (eTLD+1). IPs and single-label hosts are their own domain. */
export function registrable(hostOrUrl: string): string {
  const host = (getHostname(hostOrUrl) ?? hostOrUrl).toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) return host;
  return getDomain(host, { allowPrivateDomains: false }) ?? host;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Blocked by default: mail, banking, password managers, cloud consoles, sign-in, Harbor. */
export const DEFAULT_BLOCKED = [
  "mail.google.com", "gmail.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com", "proton.me", "protonmail.com", "fastmail.com", "icloud.com",
  "paypal.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "capitalone.com", "citi.com", "americanexpress.com", "revolut.com", "wise.com", "monzo.com", "n26.com", "venmo.com", "stripe.com", "coinbase.com", "binance.com", "kraken.com",
  "1password.com", "bitwarden.com", "lastpass.com", "dashlane.com", "keepersecurity.com", "vault.bitwarden.com",
  "console.aws.amazon.com", "signin.aws.amazon.com", "portal.azure.com", "console.cloud.google.com", "cloud.digitalocean.com", "dash.cloudflare.com", "app.netlify.com", "vercel.com", "hetzner.cloud", "console.hetzner.cloud",
  "accounts.google.com", "myaccount.google.com", "login.microsoftonline.com", "account.microsoft.com", "appleid.apple.com", "id.apple.com",
];

export interface SiteView {
  level: SiteLevel;
  adblock: boolean;
  device: "desktop" | "mobile";
  matched: string | null;
  source: SiteRule["source"];
}

export class Sites {
  private readonly db: DB;
  /** The app's own host(s), always blocked for agents. */
  private readonly selfHosts: string[];
  constructor(db: DB, selfHosts: string[] = []) {
    this.db = db;
    this.selfHosts = selfHosts.map((h) => h.toLowerCase());
  }

  list(userId: string): SiteRule[] {
    const rows = this.db.prepare("SELECT pattern, level, adblock, device, source FROM sites WHERE user_id = ? ORDER BY pattern").all(userId) as Array<{ pattern: string; level: SiteLevel; adblock: number; device: "desktop" | "mobile"; source: SiteRule["source"] }>;
    return rows.map((r) => ({ ...r, adblock: !!r.adblock }));
  }

  /** Effective rule for a URL or host. */
  resolve(userId: string, urlOrHost: string): SiteView {
    const host = (urlOrHost.includes("/") ? hostOf(urlOrHost) : urlOrHost).toLowerCase();
    const bare = host.replace(/^\[|\]$/g, "");
    if (!host) return { level: "blocked", adblock: true, device: "desktop", matched: null, source: "default" };
    if (this.selfHosts.includes(host)) return { level: "blocked", adblock: true, device: "desktop", matched: host, source: "default" };
    // LAN and private ranges by literal: the proxy enforces after DNS; this catches literals early.
    if (isIP(bare) && /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|::1$|f[cd]|fe[89ab])/i.test(bare)) {
      return { level: "blocked", adblock: true, device: "desktop", matched: "private", source: "default" };
    }
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) {
      return { level: "blocked", adblock: true, device: "desktop", matched: "lan", source: "default" };
    }
    // Most specific user rule: walk from the full host up to the registrable domain.
    const reg = registrable(host);
    const candidates: string[] = [];
    let h = host;
    for (;;) {
      candidates.push(h);
      if (h === reg || !h.includes(".")) break;
      h = h.slice(h.indexOf(".") + 1);
    }
    const stmt = this.db.prepare("SELECT pattern, level, adblock, device, source FROM sites WHERE user_id = ? AND pattern = ?");
    for (const c of candidates) {
      const row = stmt.get(userId, c) as { pattern: string; level: SiteLevel; adblock: number; device: "desktop" | "mobile"; source: SiteRule["source"] } | undefined;
      if (row) return { level: row.level, adblock: !!row.adblock, device: row.device, matched: row.pattern, source: row.source };
      if (DEFAULT_BLOCKED.includes(c)) return { level: "blocked", adblock: true, device: "desktop", matched: c, source: "default" };
    }
    return { level: "read", adblock: true, device: "desktop", matched: null, source: "default" };
  }

  set(userId: string, rule: { pattern: string; level?: SiteLevel; adblock?: boolean; device?: "desktop" | "mobile" }, source: SiteRule["source"]): SiteRule {
    const pattern = normalisePattern(rule.pattern);
    const cur = this.resolve(userId, pattern);
    const next = { pattern, level: rule.level ?? cur.level, adblock: rule.adblock ?? cur.adblock, device: rule.device ?? cur.device, source };
    this.db
      .prepare(
        `INSERT INTO sites (user_id, pattern, level, adblock, device, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, pattern) DO UPDATE SET level = excluded.level, adblock = excluded.adblock, device = excluded.device, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(userId, pattern, next.level, next.adblock ? 1 : 0, next.device, source, now());
    return next;
  }

  /** True if this change loosens access (needs a proposal when an agent asks). */
  isLoosening(userId: string, rule: { pattern: string; level?: SiteLevel; adblock?: boolean }): boolean {
    const cur = this.resolve(userId, normalisePattern(rule.pattern));
    if (rule.level && LEVEL_RANK[rule.level] > LEVEL_RANK[cur.level]) return true;
    if (rule.adblock === false && cur.adblock) return true;
    return false;
  }

  /** Default-blocked categories and LAN can only be unblocked by a person (human-only list). */
  isProtectedCategory(userId: string, pattern: string): boolean {
    const v = this.resolve(userId, normalisePattern(pattern));
    return v.source === "default" && v.level === "blocked";
  }
}

export function normalisePattern(p: string): string {
  const s = p.trim().toLowerCase();
  const host = s.includes("/") ? hostOf(s.startsWith("http") ? s : `https://${s}`) : s;
  return host.replace(/^\*\./, "").replace(/\.$/, "");
}
