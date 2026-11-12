// SPDX-License-Identifier: AGPL-3.0-only
// The web app, driven in a real browser against the real server, auth and agent browser.
// Covers: admin login and password change, connect, an agent's held comment approved from the approval page, and a login
// wall resolved through takeover with the verifier.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { LocalPool, localLauncher } from "@crossbar/browser/pool";
import { launchChrome, type LaunchedBrowser } from "@crossbar/browser/launch";
import { Auth } from "@crossbar/auth/auth";
import { startSite } from "../../browser/test/site.ts";
import { skipReason } from "../../browser/test/harness.ts";
import { buildServices } from "../src/services.ts";
import { createApp } from "../src/http.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noSandbox = process.env.CROSSBAR_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];

describe("web app flow", { skip: skipReason }, () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  let dir: string;
  let pool: LocalPool;
  let app: ReturnType<typeof createApp>;
  let ui: LaunchedBrowser;
  let origin: string;
  let s = "";
  before(async () => {
    execFileSync(process.execPath, [resolve(import.meta.dirname, "../../scripts/build-web.mjs")]);
    site = await startSite();
    dir = mkdtempSync(join(tmpdir(), "crossbar-ui-"));
    pool = new LocalPool(localLauncher({ dataDir: dir, hostResolverRules: "MAP *.test 127.0.0.1", headless: true, extraArgs: noSandbox }));
    // Port first, so the origin (used for CSRF and passkeys) is known.
    const probe = (await import("node:net")).createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    probe.close();
    origin = `http://localhost:${port}`;
    const services = buildServices({ dataDir: dir, pool, appOrigin: origin, pace: { minIntervalMs: 1000 }, settleMs: 1500 });
    const auth = new Auth(services.db, { appOrigin: origin });
    await auth.ensureDefaultOwner();
    app = createApp({ services, tokens: services.tokens, auth, version: "test", appOrigin: origin, webRoot: resolve(import.meta.dirname, "../../web/dist") });
    await new Promise<void>((r) => app.server.listen(port, "127.0.0.1", r));
    ui = await launchChrome({ extensions: [], extraArgs: noSandbox });
    const { targetId } = await ui.cdp.send("Target.createTarget", { url: "about:blank" });
    s = (await ui.cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await ui.cdp.send("Page.enable", undefined, s);
    await ui.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  });
  after(async () => {
    await ui?.close();
    app?.server.closeAllConnections();
    app?.server.close();
    for (const a of app?.registry.sessions.values() ?? []) await a.close();
    await pool?.close();
    await site?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ev = async (expr: string) => {
    const r = await ui.cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, s);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr: string, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ev(expr).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${expr}; page: ${await ev("document.body.innerText.slice(0, 300)")}`);
  };
  const setVal = (sel: string, v: string) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; return true; })()`);
  const clickText = (t: string) => ev(`(() => { const b = [...document.querySelectorAll('button,a')].find(x => x.textContent.trim() === ${JSON.stringify(t)} && !x.disabled); if (!b) throw new Error('no clickable ' + ${JSON.stringify(t)}); b.click(); return true; })()`);
  const hasText = (t: string) => `document.body.innerText.includes(${JSON.stringify(t)})`;

  let token = "";
  test("log in as admin/admin, change the password, then connect an agent", async () => {
    await ui.cdp.send("Page.navigate", { url: `${origin}/` }, s);
    await until(hasText("Log in as admin"));
    await setVal('input[placeholder="Username"]', "admin");
    await setVal("input[type=password]", "admin");
    await clickText("Log in");
    await until(hasText("Nothing needs you"));
    await until(hasText("default password"));
    await ev(`location.hash = '#/settings'`);
    await until(hasText("Change password"));
    await setVal('input[placeholder="Current password"]', "admin");
    await setVal('input[placeholder="New password"]', "a long password here");
    await clickText("Change password");
    await until(hasText("Password changed"));
    await ev(`location.hash = '#/'`);
    await until(hasText("Nothing needs you"));
    assert.doesNotMatch(String(await ev("document.body.innerText")), /default password/);
    await ev(`location.hash = '#/connect'`);
    await until(hasText("Create token"));
    await setVal('input[placeholder^="Agent name"]', "claude-code");
    await ev(`document.querySelector('input[value=act]').click()`);
    await clickText("Create token");
    await until(hasText("shown once"));
    token = (await ev(`[...document.querySelectorAll('pre')].map(p => p.textContent).find(t => t.startsWith('cb_'))`)) as string;
    assert.match(token, /^cb_act_/);
    assert.match(String(await ev(`document.body.innerText`)), /claude mcp add --transport http crossbar/);
  });

  async function mcp() {
    let sid = "";
    const rpc = async (method: string, params: unknown) => {
      const r = await fetch(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      sid ||= r.headers.get("mcp-session-id") ?? "";
      return (await r.json()) as { result: { structuredContent: Record<string, never> } };
    };
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (name: string, args: unknown = {}): Promise<any> => (await rpc("tools/call", { name, arguments: args })).result.structuredContent;
  }

  let call: Awaited<ReturnType<typeof mcp>>;
  test("an agent's comment waits in the inbox and goes out after approval", async () => {
    call = await mcp();
    await call("open", { url: site.url("a.test", "/pages/article") });
    const read = (await call("read", { mode: "content+links" })) as { data: { links: Array<{ ref: string; kind: string; text: string }> } };
    await call("type", { ref: read.data.links.find((l) => l.kind === "input")!.ref, text: "Try reverse_proxy" });
    const clicked = (await call("click", { ref: read.data.links.find((l) => l.text === "Post")!.ref })) as { state: string; ticket: { id: string } };
    assert.equal(clicked.state, "pending_approval");
    await ev(`location.hash = '#/'`);
    await until(hasText("claude-code wants to send data"));
    await ev(`location.hash = '#/tickets/${clicked.ticket.id}'`);
    await until(hasText("typed by claude-code"));
    assert.match(String(await ev("document.body.innerText")), /Right after claude-code clicked “Post”/);
    assert.equal(site.hits.filter((h) => h.method === "POST").length, 0);
    await sleep(1100); // buttons are disabled for 1 s
    await clickText("Allow for this task");
    await until(hasText("This request is approved"));
    for (let i = 0; i < 40 && site.hits.filter((h) => h.method === "POST").length === 0; i++) await sleep(50);
    assert.equal(site.hits.filter((h) => h.method === "POST").length, 1);
  });

  test("a login wall is resolved through takeover, and the verifier decides", async () => {
    const r = (await call("open", { url: site.url("a.test", "/pages/login") })) as { state: string; ticket: { id: string } };
    assert.equal(r.state, "blocked");
    await ev(`location.hash = '#/tickets/${r.ticket.id}'`);
    await until(hasText("needs you to log in"));
    await clickText("Take control");
    await until(`(document.querySelector('.screen')?.src ?? '').startsWith('data:image/jpeg')`);
    // The agent is paused while a person has control.
    assert.equal((await call("read")).state, "blocked");
    // Saying "done" on the login page itself is refused by the verifier.
    await clickText("I'm done");
    await until(hasText("still looks like a login page"));
    await clickText("Take control again");
    await until(`(document.querySelector('.screen')?.src ?? '').startsWith('data:image/jpeg')`);
    for (const step of ["Tab", "carlos", "Tab", "hunter2", "Enter"]) {
      if (["Tab", "Enter"].includes(step)) await clickText(step);
      else {
        await setVal('input[placeholder="Type here, then Send"]', step);
        await clickText("Send");
      }
      await sleep(250);
    }
    await sleep(800);
    await clickText("I'm done");
    await until(`location.hash === '#/'`);
    const w = (await call("wait_for_ticket", { ticket: r.ticket.id, timeoutSeconds: 2 })) as { data: { state: string } };
    assert.equal(w.data.state, "resolved");
    const after = (await call("read")) as { data: { profile: string } };
    assert.equal(after.data.profile, "signed_in");
  });

  test("log out, then back in with the new password", async () => {
    await ev(`location.hash = '#/settings'`);
    await until(hasText("Log out"));
    await clickText("Log out");
    await until(hasText("Log in as admin"));
    await setVal('input[placeholder="Username"]', "admin");
    await setVal("input[type=password]", "a long password here");
    await clickText("Log in");
    await until(hasText("Nothing needs you"));
  });
});
