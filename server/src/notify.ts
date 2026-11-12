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

export const MERGE_WINDOW_MS = 30_000;

const VERB: Record<string, string> = {
  comment: "comment",
  vote: "vote",
  save: "save or follow",
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

export function describeTicket(t: Ticket): { title: string; body: string } {
  const f = t.facts as Record<string, unknown>;
  const agent = t.agentName ?? "An agent";
  const domain = String(f.domain ?? "a site");
  if (t.kind === "challenge") {
    const kind = String(f.kind);
    return { title: `${agent} needs you on ${domain}`, body: kind === "login" ? `Log in to ${domain} so ${agent} can continue.` : kind === "verification" ? `Confirm the payment on ${domain} with your bank.` : kind === "captcha" ? `A ${String(f.vendor)} check is blocking ${domain}.` : `${domain} is blocking ${agent}.` };
  }
  if (t.kind === "proposal") return { title: `${agent} asks for more access`, body: `Change ${String(f.pattern ?? domain)} settings. Review the change before approving.` };
  if ((f.trigger as { kind?: string } | undefined)?.kind === "page") {
    return { title: `A page on ${domain} wants to send data`, body: `Not after a click by ${agent}. Usually analytics; deny if unsure.` };
  }
  return { title: `${agent} wants to ${VERB[String(f.actionClass)] ?? "send data"}`, body: `${String(f.method ?? "")} to ${domain}`.trim() };
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
    const last = this.lastSent.get(t.userId) ?? 0;
    if (Date.now() - last < MERGE_WINDOW_MS) {
      // Asks within 30 s merge into one notification.
      const q = this.queued.get(t.userId) ?? [];
      q.push(t);
      this.queued.set(t.userId, q);
      if (q.length === 1) setTimeout(() => this.flush(t.userId), MERGE_WINDOW_MS - (Date.now() - last)).unref();
      return;
    }
    this.lastSent.set(t.userId, Date.now());
    void this.send(t.userId, describeTicket(t), `${this.appOrigin}/#/tickets/${t.id}`, t.kind === "challenge" ? null : t.id);
  }

  private flush(userId: string): void {
    const q = this.queued.get(userId) ?? [];
    this.queued.delete(userId);
    if (q.length === 0) return;
    this.lastSent.set(userId, Date.now());
    if (q.length === 1) return void this.send(userId, describeTicket(q[0]!), `${this.appOrigin}/#/tickets/${q[0]!.id}`, q[0]!.kind === "challenge" ? null : q[0]!.id);
    void this.send(userId, { title: `${q.length} requests are waiting`, body: q.map((t) => describeTicket(t).title).join("\n") }, `${this.appOrigin}/#/tickets`, null);
  }

  private async send(userId: string, msg: { title: string; body: string }, click: string, denyTicketId: string | null): Promise<boolean> {
    const url = getSetting(this.db, userId, "ntfyUrl");
    if (!url) return false;
    const headers: Record<string, string> = { Title: msg.title, Click: click, Tags: "crossbar", Priority: "high" };
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
