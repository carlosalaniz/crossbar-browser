// SPDX-License-Identifier: AGPL-3.0-only
// Capabilities: the contract in shared/ becomes MCP tools and OpenAPI here. No hand-written schemas.
// Human-only actions (approving, tokens, unblocking LAN/sensitive categories, notifications, cookies,
// resuming after panic, choosing resolvers) are deliberately absent from TOOLS.
import { z } from "zod";
import { TOOLS, ROUTES, LEVEL_RANK, type ToolName, type ToolResult, type TokenKind } from "@crossbar/shared";
import type { AgentSession, Services } from "./agent.ts";
import { registrable } from "./sites.ts";
import { now, setSetting, getSetting } from "./db.ts";
import { TicketError } from "./tickets.ts";

export const HUMAN_ONLY = [
  "approve_ticket",
  "approve_proposal",
  "show_token",
  "regenerate_token",
  "unblock_lan",
  "unblock_sensitive_category",
  "set_notifications",
  "import_cookies",
  "export_profile",
  "resume",
  "choose_resolvers",
] as const;

const TOKEN_RANK: Record<TokenKind, number> = { read: 0, act: 1 };

export function mcpTools() {
  return Object.values(TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>,
    annotations: { readOnlyHint: t.class === "read", destructiveHint: false, idempotentHint: t.class === "read" || t.class === "tighten", openWorldHint: t.class === "act" || t.name === "open" },
  }));
}

export function openapi(version: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    if (!r.path.startsWith("/api") && r.path !== "/mcp" && r.path !== "/healthz") continue;
    const path = r.path.replace(/:(\w+)/g, "{$1}");
    const security = r.auth === "public" ? [] : r.auth === "session" ? [{ session: [] }] : r.auth === "token" ? [{ bearer: [] }] : [{ session: [] }, { bearer: [] }];
    paths[path] ??= {};
    paths[path][r.method.toLowerCase()] = {
      summary: r.description,
      security,
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: z.toJSONSchema(r.body, { io: "input" }) } } } } : {}),
      responses: { "200": { description: "OK" } },
    };
  }
  for (const t of Object.values(TOOLS)) {
    paths[`/api/tools/${t.name}`] = {
      post: {
        summary: t.description,
        security: [{ bearer: [] }],
        requestBody: { required: true, content: { "application/json": { schema: z.toJSONSchema(t.input, { io: "input" }) } } },
        responses: { "200": { description: "ToolResult" } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Crossbar", version },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" }, session: { type: "apiKey", in: "cookie", name: "cb_session" } } },
    paths,
  };
}

export async function callTool(s: Services, a: AgentSession, name: string, rawArgs: unknown): Promise<ToolResult> {
  const def = TOOLS[name as ToolName];
  if (!def) return { state: "error", message: `Unknown tool ${name}.` };
  if (TOKEN_RANK[a.token.kind] < TOKEN_RANK[def.minToken]) return { state: "denied", reason: `${name} needs an ${def.minToken} token.` };
  const parsed = def.input.safeParse(rawArgs ?? {});
  if (!parsed.success) return { state: "error", message: `Invalid arguments: ${z.prettifyError(parsed.error)}` };
  a.lastUsed = Date.now();
  // Validated by the tool's zod schema above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args = parsed.data as Record<string, any>;
  try {
    return await dispatch(s, a, name as ToolName, args);
  } catch (e) {
    if (e instanceof TicketError) return { state: "denied", reason: e.message };
    return { state: "error", message: (e as Error).message };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dispatch(s: Services, a: AgentSession, name: ToolName, args: Record<string, any>): Promise<ToolResult> {
  const userId = a.userId;
  switch (name) {
    case "open":
      return a.open(args.url);
    case "read":
      return a.read(args.mode, args.maxChars);
    case "click":
      return args.ref ? a.click(args.ref) : a.clickText(String(args.text), Number(args.nth ?? 0));
    case "type":
      return a.type(args.ref, args.text, args.submit);
    case "scroll":
      return a.scroll(args.until, args.selector);
    case "back":
      return a.back();
    case "wait_for_ticket": {
      const t0 = s.tickets.get(args.ticket);
      if (!t0 || t0.userId !== userId || (t0.tokenId !== null && t0.tokenId !== a.token.id)) return { state: "error", message: "No such ticket for this agent." };
      const t = (await s.tickets.wait(args.ticket, (args.timeoutSeconds as number) * 1000))!;
      const next =
        t.state === "approved"
          ? "Approved. If the request was held, it has been sent; otherwise repeat the action."
          : t.state === "resolved"
            ? "Resolved. Call read for a fresh view of the page, then continue."
            : t.state === "denied"
              ? "A person denied this. Don't retry it; tell the user what you were trying to do."
              : t.state === "expired"
                ? "Nobody answered within 15 minutes. Tell the user what needs their attention and move on."
                : t.state === "failed"
                  ? "It couldn't be resolved. Tell the user."
                  : "Still waiting. Call wait_for_ticket again or do other work.";
      return { state: "ok", data: { ticket: t.id, kind: t.kind, state: t.state, next } };
    }
    case "list_activity":
      return { state: "ok", data: s.activity.list(userId, { tokenId: a.token.id, limit: args.limit }) };
    case "list_flags":
      return { state: "ok", data: s.db.prepare("SELECT domain, reason, source, created_at AS createdAt FROM flags WHERE user_id = ? ORDER BY created_at DESC").all(userId) };
    case "flag_domain": {
      const domain = registrable(String(args.domain));
      a.flag(domain, String(args.reason).slice(0, 500), `agent:${a.token.agentName}`);
      s.sites.set(userId, { pattern: domain, level: "blocked" }, "user");
      return { state: "ok", data: { domain, level: "blocked" } };
    }
    case "list_sites":
      return { state: "ok", data: s.sites.list(userId) };
    case "set_site": {
      const change = { pattern: String(args.pattern), level: args.level, adblock: args.adblock, device: args.device } as { pattern: string; level?: "blocked" | "read" | "read_as_you" | "act_as_you"; adblock?: boolean; device?: "desktop" | "mobile" };
      if (!s.sites.isLoosening(userId, change)) {
        const rule = s.sites.set(userId, change, "user");
        return { state: "ok", data: { applied: rule } };
      }
      if (a.token.kind !== "act") return { state: "denied", reason: "A read token can only tighten settings. Ask the user to change this in the web app." };
      if (s.sites.isProtectedCategory(userId, change.pattern) && change.level && LEVEL_RANK[change.level] > LEVEL_RANK.blocked) {
        return { state: "denied", reason: `${change.pattern} is blocked by default (LAN or a sensitive category). Only a person can unblock it, in the web app.` };
      }
      const current = s.sites.resolve(userId, change.pattern);
      const t = s.tickets.create({
        userId,
        tokenId: a.token.id,
        agentName: a.token.agentName,
        kind: "proposal",
        dedupeKey: JSON.stringify(change),
        agentReason: String(args.reason ?? ""),
        facts: { type: "site", pattern: change.pattern, domain: registrable(change.pattern), from: { level: current.level, adblock: current.adblock, device: current.device }, to: change },
      });
      s.notifier.ticket(t);
      return { state: "pending_approval", ticket: { id: t.id, kind: t.kind, expiresAt: t.expiresAt }, summary: `Proposed: ${change.pattern} ${current.level} → ${change.level ?? current.level}.`, hint: "A person has to approve this. Call wait_for_ticket." };
    }
    case "list_grants":
      return { state: "ok", data: s.grants.list(userId, a.token.id) };
    case "revoke_grant":
      return s.grants.revoke(String(args.id), userId) ? { state: "ok", data: { revoked: args.id } } : { state: "error", message: "No such grant." };
    case "panic":
      await panic(s, userId, `agent:${a.token.agentName}`, String(args.reason ?? ""));
      return { state: "ok", data: { panicked: true, next: "Everything is stopped. Only a person can resume, in the web app." } };
  }
}

/** Panic: suspend every token, drop act and signed-in grants and levels, close sessions. Only tightens. */
export async function panic(s: Services & { closeUserSessions?: (userId: string) => Promise<void> }, userId: string, by: string, reason: string): Promise<void> {
  if (getSetting(s.db, userId, "panic")) return;
  const raised = s.sites.list(userId).filter((r) => LEVEL_RANK[r.level] > LEVEL_RANK.read);
  setSetting(s.db, userId, "panic", JSON.stringify({ at: now(), by, reason: reason.slice(0, 500), restore: raised.map((r) => ({ pattern: r.pattern, level: r.level })) }));
  for (const r of raised) s.sites.set(userId, { pattern: r.pattern, level: "read" }, "user");
  s.grants.dropAll(userId);
  for (const t of s.tickets.listOpen(userId)) if (t.state === "open") s.tickets.deny(t.id, "panic");
  await s.closeUserSessions?.(userId);
}

/** Human only: resume after panic, restoring site levels. */
export function resume(s: Services, userId: string): boolean {
  const p = getSetting(s.db, userId, "panic");
  if (!p) return false;
  const { restore } = JSON.parse(p) as { restore: Array<{ pattern: string; level: "read_as_you" | "act_as_you" }> };
  for (const r of restore) s.sites.set(userId, r, "user");
  setSetting(s.db, userId, "panic", null);
  return true;
}
