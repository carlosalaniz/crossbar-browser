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

/**
 * Sensitive categories (ADR 0014). Each is a permission on the Crossbar account, off by default: while
 * it's off, its sites are blocked for agents; a person turns it on in Settings (never an agent).
 * The host lists are hand-maintained and will miss sites (moving to data later).
 */
export const CATEGORIES = {
  banking: {
    label: "Banking and money",
    help: "Banks, brokerages, payment apps and crypto exchanges.",
    hosts: [
      "paypal.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "capitalone.com", "citi.com", "americanexpress.com", "revolut.com", "wise.com", "monzo.com", "n26.com", "venmo.com", "stripe.com",
      "usbank.com", "pnc.com", "truist.com", "ally.com", "discover.com", "citizensbank.com", "chime.com", "marcus.com", "sofi.com", "cash.app", "zellepay.com", "synchrony.com",
      "hsbc.com", "barclays.co.uk", "lloydsbank.com", "natwest.com", "santander.com", "bbva.com", "ing.com", "mabanque.bnpparibas", "deutsche-bank.de",
      "bbva.mx", "banorte.com", "santander.com.mx", "banamex.com", "hsbc.com.mx", "scotiabank.com.mx", "nu.com.mx", "mercadopago.com", "mercadopago.com.mx", "banregio.com", "inbursa.com",
      "schwab.com", "fidelity.com", "vanguard.com", "etrade.com", "robinhood.com", "interactivebrokers.com", "merrilledge.com", "morganstanley.com", "wealthfront.com", "betterment.com", "webull.com", "tdameritrade.com", "gbm.com", "gbm.com.mx",
      "coinbase.com", "binance.com", "kraken.com", "gemini.com", "crypto.com", "bitso.com",
    ],
  },
  mail: {
    label: "Email",
    help: "Webmail inboxes.",
    hosts: ["mail.google.com", "gmail.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com", "proton.me", "protonmail.com", "fastmail.com", "icloud.com"],
  },
  passwords: {
    label: "Password managers",
    help: "Vaults that hold your passwords.",
    hosts: ["1password.com", "bitwarden.com", "lastpass.com", "dashlane.com", "keepersecurity.com", "vault.bitwarden.com"],
  },
  cloud: {
    label: "Cloud consoles",
    help: "Admin consoles for cloud and hosting accounts.",
    hosts: ["console.aws.amazon.com", "signin.aws.amazon.com", "portal.azure.com", "console.cloud.google.com", "cloud.digitalocean.com", "dash.cloudflare.com", "app.netlify.com", "vercel.com", "hetzner.cloud", "console.hetzner.cloud"],
  },
  signin: {
    label: "Account and sign-in pages",
    help: "Google, Microsoft and Apple account pages. Agents may type on sign-in providers when this category is on.",
    hosts: ["accounts.google.com", "myaccount.google.com", "login.microsoftonline.com", "account.microsoft.com", "appleid.apple.com", "id.apple.com"],
  },
  government: {
    label: "Government and taxes",
    help: "Government identity and tax accounts.",
    hosts: ["login.gov", "id.me", "irs.gov", "ssa.gov", "sat.gob.mx"],
  },
} as const;
export type Category = keyof typeof CATEGORIES;
export const CATEGORY_IDS = Object.keys(CATEGORIES) as Category[];

/** Every host blocked by some category (kept for callers that want the flat list). */
export const DEFAULT_BLOCKED: string[] = CATEGORY_IDS.flatMap((c) => [...CATEGORIES[c].hosts]);

export interface SiteView {
  level: SiteLevel;
  adblock: boolean;
  device: "narrow" | "desktop" | "mobile";
  matched: string | null;
  source: SiteRule["source"] | "category";
  /** The sensitive category this site belongs to, if any (ADR 0014). */
  category?: Category;
}

export class Sites {
  private readonly db: DB;
  /** The app's own host(s), always blocked for agents. */
  private readonly selfHosts: string[];
  private readonly categoryOfHost = new Map<string, Category>();
  /** extraSignIn: more sign-in providers (CROSSBAR_SIGNIN_PROVIDERS), in the sign-in category. Only tightens. */
  constructor(db: DB, selfHosts: string[] = [], extraSignIn: string[] = []) {
    this.db = db;
    this.selfHosts = selfHosts.map((h) => h.toLowerCase());
    for (const c of CATEGORY_IDS) for (const h of CATEGORIES[c].hosts) this.categoryOfHost.set(h, c);
    for (const h of extraSignIn) this.categoryOfHost.set(h.toLowerCase(), "signin");
  }

  /** Categories this account has turned on for agents (human-only setting). */
  enabledCategories(userId: string): Set<Category> {
    const raw = (this.db.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'categories'").get(userId) as { value: string } | undefined)?.value;
    try {
      return new Set((raw ? (JSON.parse(raw) as string[]) : []).filter((c): c is Category => (CATEGORY_IDS as string[]).includes(c)));
    } catch {
      return new Set();
    }
  }

  /** Human only (ADR 0014): turn a sensitive category on or off for this account. */
  setCategory(userId: string, category: Category, enabled: boolean): Category[] {
    const cur = this.enabledCategories(userId);
    if (enabled) cur.add(category);
    else cur.delete(category);
    const list = [...cur].sort();
    this.db.prepare("INSERT INTO settings (user_id, key, value) VALUES (?, 'categories', ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value").run(userId, JSON.stringify(list));
    return list;
  }

  list(userId: string): SiteRule[] {
    const rows = this.db.prepare("SELECT pattern, level, adblock, device, source FROM sites WHERE user_id = ? ORDER BY pattern").all(userId) as Array<{ pattern: string; level: SiteLevel; adblock: number; device: "narrow" | "desktop" | "mobile"; source: SiteRule["source"] }>;
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
    // Single-label names (app, router, nas) are intranet hosts.
    if (!isIP(bare) && !host.includes(".")) return { level: "blocked", adblock: true, device: "desktop", matched: "lan", source: "default" };
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
    let category: Category | undefined;
    let matchedCategory: string | null = null;
    for (const c of candidates) {
      const row = stmt.get(userId, c) as { pattern: string; level: SiteLevel; adblock: number; device: "narrow" | "desktop" | "mobile"; source: SiteRule["source"] } | undefined;
      // A person's own rule for this host or domain wins over the category (most specific first).
      if (row) return { level: row.level, adblock: !!row.adblock, device: row.device, matched: row.pattern, source: row.source, category: category ?? this.categoryOfHost.get(c) };
      if (category) continue;
      category = this.categoryOfHost.get(c);
      if (!category) continue;
      matchedCategory = c;
      // Sensitive category turned off: blocked. A rule on a parent domain doesn't unlock it
      // (google.com "read as you" with mail off leaves mail.google.com blocked).
      if (!this.enabledCategories(userId).has(category)) return { level: "blocked", adblock: true, device: "desktop", matched: c, source: "category", category };
      // Turned on: the normal ladder, so keep walking up: the person's rule for a parent domain still
      // applies (live: google.com "read as you" was skipped for mail.google.com, so Gmail opened anonymous).
    }
    if (category) return { level: "read", adblock: true, device: "desktop", matched: matchedCategory, source: "category", category };
    return { level: "read", adblock: true, device: "desktop", matched: null, source: "default" };
  }

  set(userId: string, rule: { pattern: string; level?: SiteLevel; adblock?: boolean; device?: "narrow" | "desktop" | "mobile" }, source: SiteRule["source"]): SiteRule {
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

  /** Blocked sensitive categories and LAN can only be unblocked by a person (human-only list). */
  isProtectedCategory(userId: string, pattern: string): boolean {
    const v = this.resolve(userId, normalisePattern(pattern));
    return v.level === "blocked" && (v.source === "default" || v.source === "category");
  }
}

export function normalisePattern(p: string): string {
  const s = p.trim().toLowerCase();
  const host = s.includes("/") ? hostOf(s.startsWith("http") ? s : `https://${s}`) : s;
  return host.replace(/^\*\./, "").replace(/\.$/, "");
}
