// SPDX-License-Identifier: AGPL-3.0-only
// Notifications through ntfy. Built only from server-controlled fields (AGENTS.md rule 12):
// no page titles, no agent text. Deny can be inline because denying only tightens.
import type { Ticket } from "./tickets.ts";
import type { DB } from "./db.ts";
import { getSetting } from "./db.ts";
import type { Keys } from "./crypto.ts";

export interface Notifier {
  ticket(t: Ticket): void;
  test(userId: string): Promise<boolean>;
}

/** After a notification, further asks from the same agent within this window are merged into one (ADR 0019). */
export const MERGE_WINDOW_MS = 120_000;

const VERB: Record<string, string> = {
  comment: "post a comment",
  vote: "vote",
  save: "save or follow something",
  message: "send a private message",
  pay: "pay",
  delete: "delete something",
  credentials: "change account security",
  oauth: "authorize an app",
  sensitive_path: "open a private page",
  taint_exit: "send data to a new site",
  login_use: "use your login",
  write: "send data",
};

/** Who wants to do what, where; and what each choice does. Server-controlled fields only (AGENTS.md rule 12). */
export function describeTicket(t: Ticket): { title: string; body: string } {
  const f = t.facts as Record<string, unknown>;
  const agent = t.agentName ?? "An agent";
  const domain = String(f.domain ?? "a site");
  if (t.kind === "challenge") {
    const kind = String(f.kind);
    if (kind === "login") return { title: `Log in to ${domain}`, body: `${agent} is waiting. Tap to take control and log in.` };
    if (kind === "verification") return { title: `Confirm a payment on ${domain}`, body: `Your bank is asking. ${agent} is waiting.` };
    if (kind === "captcha") return { title: `Solve a check on ${domain}`, body: `A ${String(f.vendor ?? "captcha")} check is in the way. ${agent} is waiting.` };
    if (f.vendor === "agent") return { title: `${agent} needs you on ${domain}`, body: "Tap to take control. Its reason is on the request page." };
    return { title: `${domain} is blocking ${agent}`, body: "Tap to take a look." };
  }
  if (t.kind === "proposal") return { title: `${agent} asks for more access on ${String(f.pattern ?? domain)}`, body: "Approve: the change applies. Deny: nothing changes." };
  if ((f.trigger as { kind?: string } | undefined)?.kind === "page") {
    return { title: `A page on ${domain} wants to send data`, body: `Not after a click by ${agent}. Usually analytics; deny if unsure.` };
  }
  const once = f.alwaysAsks ? " (just this once)" : "";
  return { title: `${agent} wants to ${VERB[String(f.actionClass)] ?? "send data"} on ${domain}`, body: `Approve: it goes through${once}. Deny: ${agent} is told no.` };
}

/** Writes a page makes by itself (usually analytics) wait quietly in Requests; they don't push (ADR 0019). */
export function shouldNotify(t: Ticket): boolean {
  return !(t.kind === "approval" && (t.facts as { trigger?: { kind?: string } }).trigger?.kind === "page");
}

export class NtfyNotifier implements Notifier {
  private readonly db: DB;
  private readonly keys: Keys;
  private readonly appOrigin: string;
  private readonly lastSent = new Map<string, number>();
  private readonly queued = new Map<string, Ticket[]>();
  readonly sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  private readonly fetchImpl: typeof fetch;

  constructor(db: DB, keys: Keys, appOrigin: string, fetchImpl: typeof fetch = fetch) {
    this.db = db;
    this.keys = keys;
    this.appOrigin = appOrigin.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  denyLink(ticketId: string): string {
    return `${this.appOrigin}/api/tickets/${ticketId}/deny-link?sig=${this.keys.sign(`deny:${ticketId}`)}`;
  }

  ticket(t: Ticket): void {
    if (!shouldNotify(t)) return;
    // One stream per agent: a burst of asks from one agent becomes one follow-up, not a notification each.
    const key = `${t.userId}|${t.tokenId ?? ""}`;
    const last = this.lastSent.get(key) ?? 0;
    if (Date.now() - last < MERGE_WINDOW_MS) {
      const q = this.queued.get(key) ?? [];
      q.push(t);
      this.queued.set(key, q);
      if (q.length === 1) setTimeout(() => this.flush(key, t.userId), MERGE_WINDOW_MS - (Date.now() - last)).unref();
      return;
    }
    this.lastSent.set(key, Date.now());
    void this.send(t.userId, describeTicket(t), `${this.appOrigin}/#/tickets/${t.id}`, t.kind === "challenge" ? null : t.id, t.kind);
  }

  private flush(key: string, userId: string): void {
    // Only what is still waiting: asks answered meanwhile don't notify.
    const q = (this.queued.get(key) ?? []).filter((t) => this.stillOpen(t));
    this.queued.delete(key);
    if (q.length === 0) return;
    this.lastSent.set(key, Date.now());
    if (q.length === 1) return void this.send(userId, describeTicket(q[0]!), `${this.appOrigin}/#/tickets/${q[0]!.id}`, q[0]!.kind === "challenge" ? null : q[0]!.id, q[0]!.kind);
    const agent = q[0]!.agentName ?? "An agent";
    void this.send(userId, { title: `${agent} has ${q.length} more requests`, body: q.map((t) => describeTicket(t).title).join("\n") }, `${this.appOrigin}/#/`, null, "approval");
  }

  private stillOpen(t: Ticket): boolean {
    const row = this.db.prepare("SELECT state FROM tickets WHERE id = ?").get(t.id) as { state: string } | undefined;
    return !row || row.state === "open" || row.state === "claimed";
  }

  private async send(userId: string, msg: { title: string; body: string }, click: string, denyTicketId: string | null, kind = "approval"): Promise<boolean> {
    const url = getSetting(this.db, userId, "ntfyUrl");
    if (!url) return false;
    const headers: Record<string, string> = { Title: msg.title, Click: click, Tags: "crossbar", Priority: kind === "proposal" ? "default" : "high" };
    if (denyTicketId) headers.Actions = `view, Review, ${click}; http, Deny, ${this.denyLink(denyTicketId)}, method=POST, clear=true`;
    this.sent.push({ url, headers, body: msg.body });
    try {
      const r = await this.fetchImpl(url, { method: "POST", headers, body: msg.body });
      return r.ok;
    } catch {
      return false;
    }
  }

  test(userId: string): Promise<boolean> {
    return this.send(userId, { title: "Crossbar test", body: "Notifications work." }, `${this.appOrigin}/`, null);
  }
}
