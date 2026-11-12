// SPDX-License-Identifier: AGPL-3.0-only
// End to end: MCP -> server -> pool -> real Chromium -> local test site. No live websites.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPool, localLauncher } from "@crossbar/browser/pool";
import { startSite } from "../../browser/test/site.ts";
import { skipReason } from "../../browser/test/harness.ts";
import { startTestApp, sleep } from "./helpers.ts";

describe("end to end with a real browser", { skip: skipReason }, () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let pool: LocalPool;
  let dir: string;
  before(async () => {
    site = await startSite();
    dir = mkdtempSync(join(tmpdir(), "crossbar-e2e-"));
    pool = new LocalPool(
      localLauncher({ dataDir: dir, hostResolverRules: "MAP *.test 127.0.0.1", headless: true, extraArgs: process.env.CROSSBAR_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] }),
    );
    t = await startTestApp({ pool, settleMs: 1500 });
  });
  after(async () => {
    await t?.close();
    await pool?.close();
    await site?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("read, type, click: the comment POST waits for a person", async () => {
    const c = await t.mcpClient(t.token("alice", "act", "e2e-agent"));
    const opened = await c.call("open", { url: site.url("a.test", "/pages/article") });
    assert.equal(opened.state, "ok", JSON.stringify(opened));
    const read = await c.call("read", { mode: "content+links" });
    const data = read.data as { content: string; links: Array<{ ref: string; kind: string; text: string }> };
    assert.match(data.content, /Running Caddy as a reverse proxy/);
    assert.doesNotMatch(data.content, /IGNORE PREVIOUS/);
    const input = data.links.find((l) => l.kind === "input")!;
    const post = data.links.find((l) => l.text === "Post")!;
    assert.equal((await c.call("type", { ref: input.ref, text: "Try reverse_proxy" })).state, "ok");
    const clicked = await c.call("click", { ref: post.ref });
    assert.equal(clicked.state, "pending_approval", JSON.stringify(clicked));
    assert.equal(site.hits.filter((h) => h.method === "POST").length, 0, "POST left before approval");
    const card = await t.api("GET", `/api/tickets/${clicked.ticket!.id}`, { user: "alice" });
    const facts = card.json.facts as { method: string; fields: Array<{ key: string; preview: string; typedByAgent: boolean }> };
    assert.equal(facts.method, "POST");
    assert.ok(facts.fields.some((f) => f.key === "comment" && f.typedByAgent && f.preview === "Try reverse_proxy"));
    await t.api("POST", `/api/tickets/${clicked.ticket!.id}/approve`, { user: "alice", body: { scope: "once" } });
    for (let i = 0; i < 40 && site.hits.filter((h) => h.method === "POST").length === 0; i++) await sleep(50);
    assert.equal(site.hits.filter((h) => h.method === "POST").length, 1);
    const w = await c.call("wait_for_ticket", { ticket: clicked.ticket!.id, timeoutSeconds: 1 });
    assert.equal((w.data as { state: string }).state, "approved");
  });

  test("an agent can type into a password field (owner's decision, 11 Nov 2026)", async () => {
    const c = await t.mcpClient(t.token("alice", "act"));
    await c.call("open", { url: site.url("a.test", "/password-form") });
    await c.call("read", { mode: "content+links" });
    // Refs are assigned in order; the password field is the second input.
    const r = await c.call("type", { ref: "e2", text: "hunter2" });
    assert.equal(r.state, "ok");
  });

  test("agent input looks like a hand: travel before the press, a real hold, a key per character, wheel to reach (audit S05-S07)", async () => {
    const c = await t.mcpClient(t.token("alice", "act"));
    await c.call("open", { url: site.url("a.test", "/pages/events") });
    const links = ((await c.call("read", { mode: "content+links" })).data as { links: Array<{ ref: string; kind: string; text: string }> }).links;
    await c.call("type", { ref: links.find((l) => l.kind === "input")!.ref, text: "Ana Ruiz" });
    await c.call("click", { ref: links.find((l) => l.text === "Far button")!.ref });
    const content = ((await c.call("read")).data as { content: string }).content;
    const ev = JSON.parse(/EVENTS (\{.*\})/.exec(content)![1]!) as { moves: number; held: number; keydowns: number; inputs: number; trusted: boolean; scrolls: number; value: string };
    assert.equal(ev.value, "Ana Ruiz");
    assert.equal(ev.keydowns, 8, "one keydown per character");
    assert.ok(ev.moves >= 3, `pointer travelled ${ev.moves} steps before the press`);
    assert.ok(ev.held >= 40, `press held ${ev.held} ms`);
    assert.ok(ev.scrolls >= 1, "the far button was reached with the wheel, not scrollIntoView");
    assert.equal(ev.trusted, true);
  });

  test("scroll collects a virtualized list through MCP", async () => {
    const c = await t.mcpClient(t.token("alice"));
    await c.call("open", { url: site.url("a.test", "/pages/virtual") });
    const r = await c.call("scroll", { until: { items: 30 }, selector: "article" });
    const d = r.data as { items: unknown[]; stoppedBecause: string };
    assert.equal(d.stoppedBecause, "target");
    assert.equal(d.items.length, 30);
  });

  test("takeover follows a sign-in popup and comes back when it closes", async () => {
    const c = await t.mcpClient(t.token("alice", "read"));
    const r = await c.call("open", { url: site.url("a.test", "/pages/sso") });
    assert.equal(r.state, "blocked", JSON.stringify(r));
    const id = r.ticket!.id;
    const claim = await t.api("POST", `/api/tickets/${id}/claim`, { user: "alice" });
    const base = claim.json.tab as string;
    const key = async (k: string) => {
      await t.api("POST", `/api/tickets/${id}/input`, { user: "alice", body: { type: "keyDown", key: k, code: k, text: k === "Enter" ? "\r" : "" } });
      await t.api("POST", `/api/tickets/${id}/input`, { user: "alice", body: { type: "keyUp", key: k, code: k } });
    };
    // Focus the "Sign in with IdP" button (after the password field) and press Enter: a user gesture opens the popup.
    await key("Tab");
    await key("Tab");
    await key("Enter");
    let current = base;
    for (let i = 0; i < 40 && current === base; i++) {
      await sleep(100);
      current = String((await t.api("GET", `/api/tickets/${id}`, { user: "alice" })).json.takeoverTab);
    }
    assert.notEqual(current, base, "the popup didn't become the takeover tab");
    // In the popup (another site), the Allow button has focus.
    await sleep(500);
    await key("Enter");
    for (let i = 0; i < 40 && current !== base; i++) {
      await sleep(100);
      current = String((await t.api("GET", `/api/tickets/${id}`, { user: "alice" })).json.takeoverTab);
    }
    assert.equal(current, base, "control didn't come back when the popup closed");
    await sleep(800);
    const done = await t.api("POST", `/api/tickets/${id}/done`, { user: "alice" });
    assert.equal(done.json.verified, true, JSON.stringify(done.json));
  });

  test("typing works on configured extra sign-in providers", async () => {
    const extra = new LocalPool(localLauncher({ dataDir: dir, hostResolverRules: "MAP *.test 127.0.0.1", headless: true, extraArgs: process.env.CROSSBAR_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] }), { extraSignInProviders: ["b.test"] });
    try {
      const tab = await extra.openTab("idp-user", "anon");
      tab.setPolicy({ decide: () => "allow" });
      await tab.navigate(site.url("b.test", "/pages/article"));
      const page = await tab.extract({ includeLinks: true });
      const input = page.links!.find((l) => l.kind === "input")!;
      await tab.type(input.ref, "hello", false);
    } finally {
      await extra.close();
    }
  });

  test("an idle browser stops after its last tab closes and relaunches on the next use (step 10)", async () => {
    const idle = new LocalPool(localLauncher({ dataDir: dir, hostResolverRules: "MAP *.test 127.0.0.1", headless: true, extraArgs: process.env.CROSSBAR_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] }), { idleStopMs: 300 });
    try {
      const a = await idle.openTab("idle-user", "anon");
      const b = await idle.openTab("idle-user", "anon");
      a.setPolicy({ decide: () => "allow" });
      await a.navigate(site.url("a.test", "/pages/article"));
      await a.close();
      await sleep(700);
      assert.equal(idle.running(), 1, "stopped while a tab was still open");
      await b.close();
      for (let i = 0; i < 40 && idle.running() > 0; i++) await sleep(100);
      assert.equal(idle.running(), 0, "didn't stop when idle");
      const c = await idle.openTab("idle-user", "anon");
      c.setPolicy({ decide: () => "allow" });
      assert.equal((await c.navigate(site.url("a.test", "/pages/article"))).title, "Caddy reverse proxy notes");
      assert.equal(idle.running(), 1);
    } finally {
      await idle.close();
    }
  });

  test("diagnostic page: no automation flags after an agent reads, types and clicks (signal plan B)", async () => {
    const c = await t.mcpClient(t.token("alice", "act"));
    await c.call("open", { url: site.url("a.test", "/pages/diag") });
    const links = ((await c.call("read", { mode: "content+links" })).data as { links: Array<{ ref: string; kind: string; text: string }> }).links;
    await c.call("type", { ref: links.find((l) => l.kind === "input")!.ref, text: "hello" });
    await c.call("click", { ref: links.find((l) => /record a press/.test(l.text))!.ref });
    await sleep(700);
    const content = ((await c.call("read")).data as { content: string }).content;
    const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
    const d = JSON.parse(json) as { automation: { webdriver: boolean }; dom: { foreignMutations: number }; hooks: { titleReads: number; querySelectorCalls: number }; input: { untrusted: number; keydown: number; movesBeforePress: number; lastPressMs: number }; flags: string[] };
    assert.deepEqual(d.flags, [], JSON.stringify(d));
    assert.equal(d.automation.webdriver, false);
    assert.equal(d.dom.foreignMutations, 0);
    assert.equal(d.hooks.titleReads + d.hooks.querySelectorCalls, 0);
    assert.equal(d.input.keydown, 5);
    assert.ok(d.input.movesBeforePress >= 3 && d.input.lastPressMs >= 40, JSON.stringify(d.input));
  });

  test("custom clickables get refs; click by text is the fallback; covered elements are refused", async () => {
    const c = await t.mcpClient(t.token("alice", "read"));
    await c.call("open", { url: site.url("a.test", "/pages/flair") });
    const read = (await c.call("read", { mode: "content+links" })).data as { links: Array<{ ref: string; kind: string; text: string }> };
    const options = read.links.filter((l) => ["Discussion", "Question", "Resources"].includes(l.text));
    assert.equal(options.length, 3, JSON.stringify(read.links));
    assert.ok(options.every((o) => o.kind === "clickable"));
    assert.equal((await c.call("click", { ref: options[0]!.ref })).state, "ok");
    let page = (await c.call("read")).data as { content: string };
    assert.match(page.content, /Selected flair: Discussion/);
    assert.equal((await c.call("click", { text: "question" })).state, "ok");
    page = (await c.call("read")).data as { content: string };
    assert.match(page.content, /Selected flair: Question/);
    // Something on top of it: the element check before click refuses.
    const covered = await c.call("click", { text: "Hidden behind" });
    assert.equal(covered.state, "error");
    assert.match(String(covered.message), /on top of/);
    assert.equal((await c.call("click", { text: "No such option" })).state, "error");
    assert.equal((await c.call("click", {})).state, "error");
  });

  test("the click check works like a person's click: shadow DOM, labels on top, and it names real overlays", async () => {
    const c = await t.mcpClient(t.token("alice", "read"));
    await c.call("open", { url: site.url("a.test", "/pages/click-check") });
    const links = ((await c.call("read", { mode: "content+links" })).data as { links: Array<{ ref: string; kind: string; text: string }> }).links;
    const result = async () => ((await c.call("read")).data as { content: string }).content.match(/Result: (\w+)/)?.[1];
    // A web component that draws the option in its shadow DOM.
    assert.equal((await c.call("click", { text: "Alpha" })).state, "ok");
    assert.equal(await result(), "Alpha");
    // A radio whose label is drawn on top of it.
    const radio = links.find((l) => l.kind === "input" || l.kind === "option" || l.text === "beta")!;
    const r = await c.call("click", { ref: radio.ref });
    assert.equal(r.state, "ok", JSON.stringify(r));
    assert.equal(await result(), "Beta");
    // A real overlay: refused, and it says what's on top with a ref.
    const save = links.find((l) => l.text === "Save draft")!;
    const covered = await c.call("click", { ref: save.ref });
    assert.equal(covered.state, "error");
    const m = /on top of e\d+: (.+) \[(e\d+)\]/.exec(String(covered.message));
    assert.ok(m, String(covered.message));
    assert.match(m![1]!, /Cookies|dialog|Accept all|We use cookies/);
    // Deal with it, then the click goes through.
    assert.equal((await c.call("click", { text: "Accept all" })).state, "ok");
    assert.equal((await c.call("click", { ref: save.ref })).state, "ok");
    assert.equal(await result(), "Saved");
  });
});
