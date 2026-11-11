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

  test("an agent can't type into a password field", async () => {
    const c = await t.mcpClient(t.token("alice", "act"));
    await c.call("open", { url: site.url("a.test", "/password-form") });
    await c.call("read", { mode: "content+links" });
    // Refs are assigned in order; the password field is the second input.
    const r = await c.call("type", { ref: "e2", text: "hunter2" });
    assert.equal(r.state, "denied");
  });

  test("scroll collects a virtualized list through MCP", async () => {
    const c = await t.mcpClient(t.token("alice"));
    await c.call("open", { url: site.url("a.test", "/pages/virtual") });
    const r = await c.call("scroll", { until: { items: 30 }, selector: "article" });
    const d = r.data as { items: unknown[]; stoppedBecause: string };
    assert.equal(d.stoppedBecause, "target");
    assert.equal(d.items.length, 30);
  });
});
