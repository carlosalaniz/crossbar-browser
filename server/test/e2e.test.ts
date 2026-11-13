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

  test("a service worker's POST follows its page's policy: allowed if the tab allows, refused if it holds (audit S21)", async () => {
    const run = async (user: string, verdict: "allow" | "hold") => {
      const tab = await pool.openTab(user, "anon");
      tab.setPolicy({ decide: (r) => (r.method === "GET" || r.resourceType === "Document" ? "allow" : verdict) });
      const before = site.hits.filter((h) => h.case === "service-worker").length;
      await tab.navigate(site.url("localhost", "/pages/sw-auto"));
      for (let i = 0; i < 30 && site.hits.filter((h) => h.case === "service-worker").length === before; i++) await sleep(100);
      await tab.close();
      return site.hits.filter((h) => h.case === "service-worker").length - before;
    };
    assert.equal(await run("sw-allow", "allow"), 1, "the worker's POST should pass when its page's policy allows it");
    assert.equal(await run("sw-hold", "hold"), 0, "a held write from a worker must not go out");
  });

  test("open() follows a link on the current page by clicking it; otherwise it opens the address (audit S09)", async () => {
    const c = await t.mcpClient(t.token("alice", "read"));
    await c.call("open", { url: site.url("a.test", "/pages/links") });
    const followed = await c.call("open", { url: site.url("a.test", "/pages/landing") });
    assert.equal(followed.state, "ok", JSON.stringify(followed));
    assert.match(((await c.call("read")).data as { content: string }).content, new RegExp(`referrer: ${site.url("a.test", "/pages/links").replace(/[.?]/g, "\\$&")}`));
    // A link that opens a new tab isn't followed by clicking; the address is opened in this tab.
    await c.call("open", { url: site.url("a.test", "/pages/links") });
    await c.call("open", { url: site.url("a.test", "/pages/landing?n=2") });
    assert.match(((await c.call("read")).data as { content: string }).content, /referrer: none/);
  });

  test("the narrow window: 500 px wide by default, full width for a site set to desktop (ADR 0028)", async () => {
    const c = await t.mcpClient(t.token("alice", "read"));
    const inner = async () => {
      const content = ((await c.call("read")).data as { content: string }).content;
      return (JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1)) as { screen: { inner: string } }).screen.inner;
    };
    await c.call("open", { url: site.url("a.test", "/pages/diag") });
    assert.match(await inner(), /^500x/);
    t.services.sites.set("alice", { pattern: "b.test", device: "desktop" }, "user");
    await c.call("open", { url: site.url("b.test", "/pages/diag") });
    assert.match(await inner(), /^1280x/);
  });

  test("find and click by name: icon buttons, hidden menu items, covered controls (live: Gmail, 12 Nov 2026)", async () => {
    const c = await t.mcpClient(t.token("alice", "read"));
    await c.call("open", { url: site.url("a.test", "/pages/controls") });
    type M = { ref?: string; role: string; name: string; state: string; coveredBy?: { ref: string; text: string }; openWith?: { ref: string; name: string } };
    const find = async (query: string) => ((await c.call("find", { query })).data as { matches: M[] }).matches;
    const log = async () => /clicked: \w+|nothing clicked/.exec(((await c.call("read")).data as { content: string }).content)![0];
    // The icon-only gear is found by its label, ahead of the stray "Settings" text under the header.
    const settings = await find("settings");
    assert.deepEqual([settings[0]!.role, settings[0]!.state], ["button", "visible"], JSON.stringify(settings));
    assert.equal((await c.call("click", { text: "Settings" })).state, "ok");
    assert.equal(await log(), "clicked: gear");
    // A menu item in a closed menu: hidden, and find says what opens it.
    const archive = (await find("archive"))[0]!;
    assert.equal(archive.state, "hidden");
    assert.equal(archive.openWith?.name, "More");
    const blocked = await c.call("click", { text: "Archive" });
    assert.match(String(blocked.message), /opens from "More" \[e\d+\]/);
    await c.call("click", { ref: archive.openWith!.ref });
    assert.equal((await find("archive"))[0]!.state, "visible");
    // A covered button: find names what's on top.
    const exp = (await find("export"))[0]!;
    assert.equal(exp.state, "covered");
    assert.match(exp.coveredBy!.text, /Cookies/);
    // Bad arguments say what click accepts.
    assert.match(String((await c.call("click", { target: "Settings" })).message), /Give ref .* or text/);
  });

  test("a picker in a dialog: find in it, read it, scroll it, click an option below its fold (live: Gmail themes, 13 Nov 2026)", async () => {
    const c = await t.mcpClient(t.token("alice", "act"));
    await c.call("open", { url: site.url("a.test", "/pages/picker") });
    type M = { ref?: string; role: string; name: string; state: string; coveredBy?: unknown };
    // The gear only opens a menu: the app's sync right after it isn't the agent acting, so nobody is asked (ADR 0030).
    const before = site.hits.filter((h) => h.case === "menu-sync").length;
    const gear = await c.call("click", { text: "Settings" });
    assert.equal(gear.state, "ok", JSON.stringify(gear));
    for (let i = 0; i < 40 && site.hits.filter((h) => h.case === "menu-sync").length === before; i++) await sleep(50);
    assert.equal(site.hits.filter((h) => h.case === "menu-sync").length, before + 1, "the sync after opening a menu was held");
    // No dialog yet; then "Set theme" opens it.
    assert.match(String((await c.call("find", { within: "dialog" })).message), /No dialog is open/);
    assert.equal((await c.call("click", { text: "Set theme" })).state, "ok");
    // Everything in the dialog, in order; the picture options are named by their labels.
    const listed = ((await c.call("find", { within: "dialog" })).data as { matches: M[] }).matches;
    assert.ok(listed.length >= 20, JSON.stringify(listed.length));
    const ocean = listed.find((m) => m.name.startsWith("Ocean"))!;
    // Below the grid's fold, over the dialog's own padding: out of sight, not "covered by the dialog".
    assert.equal(ocean.role, "option");
    assert.equal(ocean.state, "offscreen", JSON.stringify(ocean));
    // ARIA roles are accepted as they are.
    const byRole = ((await c.call("find", { query: "ocean", role: "option" })).data as { matches: M[] }).matches;
    assert.equal(byRole[0]?.ref, ocean.ref);
    assert.equal(((await c.call("find", { query: "ocean", role: "radio" })).data as { matches: M[] }).matches.length, 0);
    // Reading just the dialog leaves the page behind it out.
    const partR = await c.call("read", { within: "dialog" });
    const part = partR.data as { content: string };
    assert.equal(partR.state, "ok", JSON.stringify(partR));
    assert.match(part.content, /Pick your theme/);
    assert.doesNotMatch(part.content, /Inbox: 3 conversations/);
    // Scrolling inside the dialog collects its options; scroll with ref brings one into view.
    const sc = (await c.call("scroll", { within: "dialog", until: { items: 40 } })).data as { items: Array<{ text: string }>; stoppedBecause: string };
    assert.equal(sc.items.length, 40, JSON.stringify(sc.stoppedBecause));
    assert.ok(sc.items.some((i) => /^Ocean/.test(i.text)));
    assert.equal(((await c.call("scroll", { ref: listed[0]!.ref })).data as { inView: boolean }).inView, true);
    // The option scrolled out again: click brings it into the grid's view and clicks it. Choosing a theme
    // saves a setting as the person, so that request is still held.
    const picked = await c.call("click", { ref: ocean.ref });
    assert.equal(picked.state, "pending_approval", JSON.stringify(picked));
    assert.match(((await c.call("read")).data as { content: string }).content, /picked: Ocean/);
    await t.api("POST", `/api/tickets/${picked.ticket!.id}/deny`, { user: "alice" });
    // A picture of an element comes back as image content.
    const shot = await c.rpc("tools/call", { name: "look", arguments: { ref: ocean.ref } });
    const content = shot.result!.content as Array<{ type: string; mimeType?: string; data?: string }>;
    assert.equal(content[0]!.type, "image");
    assert.equal(content[0]!.mimeType, "image/jpeg");
    assert.ok(content[0]!.data!.length > 100);
    // Bad arguments say what each tool accepts.
    assert.match(String((await c.call("find", {})).message), /Give query .* or within/);
    assert.match(String((await c.call("scroll", {})).message), /Give ref .* or until/);
  });

  test("a control past the window's edge is pressed with Enter; one that can't take focus is refused, honestly (live: Gmail themes, 12 Nov 2026)", async () => {
    const c = await t.mcpClient(t.token("alice", "act"));
    await c.call("open", { url: site.url("a.test", "/pages/picker") });
    assert.equal((await c.call("click", { text: "Wide theme" })).state, "ok");
    type M = { ref?: string; name: string; state: string };
    const save = ((await c.call("find", { query: "Save", within: "dialog" })).data as { matches: M[] }).matches[0]!;
    assert.equal(save.state, "offscreen", JSON.stringify(save));
    // Save acts as the person: its request is held, and the page saw a real Enter on the button.
    const saved = await c.call("click", { ref: save.ref });
    assert.equal(saved.state, "pending_approval", JSON.stringify(saved));
    assert.match(((await c.call("read")).data as { content: string }).content, /saved wide by enter/);
    await t.api("POST", `/api/tickets/${saved.ticket!.id}/approve`, { user: "alice", body: { scope: "task" } });
    // Once approved, the same click goes through and its result says what it sent (live: the agent read the
    // activity log to learn whether its theme click had been sent).
    const again = await c.call("click", { ref: save.ref });
    assert.equal(again.state, "ok", JSON.stringify(again));
    assert.ok((again.data as { sent?: string[] }).sent?.some((w) => /^POST \S+\/sink \(approved earlier\)$/.test(w)), JSON.stringify(again.data));
    // A plain div past the edge can't be reached by keyboard either: say where it is, not that it's gone.
    const restore = await c.call("click", { text: "Restore" });
    assert.equal(restore.state, "error");
    assert.match(String(restore.message), /outside the window/);
    assert.doesNotMatch(String(restore.message), /isn't on the page/);
  });

  test("a write sent on mousedown is the click's, even long after the previous action (ADR 0027 trigger window)", async () => {
    const c = await t.mcpClient(t.token("alice", "act"));
    await c.call("open", { url: site.url("a.test", "/pages/picker") });
    const quick = ((await c.call("find", { query: "Quick apply" })).data as { matches: Array<{ ref: string }> }).matches[0]!;
    // Past the 3-second window: if the action were recorded only after the click returned, the POST sent
    // during the press would pass as the page's own background request.
    await sleep(3300);
    const before = site.hits.filter((h) => h.case === "quick-apply").length;
    const r = await c.call("click", { ref: quick.ref });
    assert.equal(r.state, "pending_approval", JSON.stringify(r));
    assert.equal(site.hits.filter((h) => h.case === "quick-apply").length, before, "the POST left without a person");
    await t.api("POST", `/api/tickets/${r.ticket!.id}/deny`, { user: "alice" });
  });

  test("open a #route: lands on that route, without waiting for a load that never comes (live: Gmail, 13 Nov 2026)", async () => {
    const c = await t.mcpClient(t.token("alice", "read"));
    await c.call("open", { url: site.url("a.test", "/pages/picker") });
    const route = async () => /route: \S*/.exec(((await c.call("read")).data as { content: string }).content)![0];
    // A link to that route exists: it's followed, and the Inbox link (same page, other route) isn't.
    let t0 = Date.now();
    const a = await c.call("open", { url: site.url("a.test", "/pages/picker#settings/themes") });
    assert.equal(a.state, "ok", JSON.stringify(a));
    assert.equal(await route(), "route: #settings/themes");
    assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`);
    // No link to it: the address changes in place, and that counts as arrived.
    t0 = Date.now();
    assert.equal((await c.call("open", { url: site.url("a.test", "/pages/picker#settings/general") })).state, "ok");
    assert.equal(await route(), "route: #settings/general");
    assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`);
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
