// SPDX-License-Identifier: AGPL-3.0-only
// The egress proxy in front of a real Chromium, configured as in the browser container:
// every request goes through the proxy (loopback included), and Chromium resolves no hostnames itself.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createEgressProxy, type ProxyDecision } from "@crossbar/proxy/proxy";
import { launchChrome, type LaunchedBrowser } from "../src/launch.ts";
import { startSite } from "./site.ts";
import { skipReason, sleep } from "./harness.ts";

const PUBLIC_IP = "93.184.216.34";

describe("egress proxy with a real Chromium", { skip: skipReason }, () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  let proxy: http.Server;
  let browser: LaunchedBrowser;
  const decisions: ProxyDecision[] = [];
  const resolved: string[] = [];
  let s = "";
  before(async () => {
    site = await startSite();
    proxy = createEgressProxy({
      allowedPorts: [80, 443, site.port],
      resolve: async (h) => {
        resolved.push(h);
        if (h === "public.test") return [PUBLIC_IP];
        if (h === "rebind.test") return ["10.0.0.7"];
        throw new Error("NXDOMAIN");
      },
      connect: (ip, port) => net.connect({ host: "127.0.0.1", port: ip === PUBLIC_IP ? port : 1 }),
      onDecision: (d) => decisions.push(d),
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const pport = (proxy.address() as AddressInfo).port;
    browser = await launchChrome({
      proxyServer: `http://127.0.0.1:${pport}`,
      hostResolverRules: "MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      extraArgs: process.env.CROSSBAR_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
    });
    const { targetId } = await browser.cdp.send("Target.createTarget", { url: "about:blank" });
    s = (await browser.cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    await browser.cdp.send("Page.enable", undefined, s);
  });
  after(async () => {
    await browser?.close();
    proxy?.close();
    await site?.close();
  });

  async function load(url: string): Promise<string> {
    const loaded = new Promise<void>((r) => {
      const off = browser.cdp.on("Page.loadEventFired", (_p, sid) => sid === s && (off(), r()));
      setTimeout(() => (off(), r()), 5000);
    });
    await browser.cdp.send("Page.navigate", { url }, s);
    await loaded;
    await sleep(100);
    const r = await browser.cdp.send("Runtime.evaluate", { expression: "document.body?.innerText ?? ''", returnByValue: true }, s);
    return String(r.result.value);
  }

  test("a public host is reached through the proxy, which did the DNS lookup", async () => {
    const text = await load(`http://public.test:${site.port}/pages/article`);
    assert.match(text, /Running Caddy/);
    assert.ok(resolved.includes("public.test"));
    assert.ok(decisions.some((d) => d.host === "public.test" && d.allowed && d.dialed === PUBLIC_IP));
  });

  test("a hostname that resolves to a private range is refused after resolution", async () => {
    const text = await load(`http://rebind.test:${site.port}/pages/article`);
    assert.doesNotMatch(text, /Running Caddy/);
    assert.ok(decisions.some((d) => d.host === "rebind.test" && !d.allowed && /private/.test(d.reason ?? "")));
  });

  test("loopback goes through the proxy too, and is refused", async () => {
    const before = site.hits.length;
    await load(`http://127.0.0.1:${site.port}/pages/article`);
    assert.equal(site.hits.length, before, "Chromium reached loopback directly");
    assert.ok(decisions.some((d) => d.host === "127.0.0.1" && !d.allowed));
  });

  test("Chromium resolves no hostnames itself", async () => {
    // With MAP * ~NOTFOUND, any lookup Chromium tried on its own would fail; the page still loads,
    // so the only lookup was the proxy's.
    resolved.length = 0;
    const text = await load(`http://public.test:${site.port}/blank`);
    assert.match(text, /blank/);
    await sleep(1500);
    // Known exception: Chrome's AI Mode eligibility check (www.google.com/async/folae) ignores every
    // flag we tried. It carries no page data and still goes through the proxy; the browser container
    // turns it off with managed policy (deploy/browser/policies.json).
    const background = decisions
      .filter((d) => !["public.test", "rebind.test", "127.0.0.1"].includes(d.host) && !(d.kind === "connect" && d.host === "www.google.com"))
      .map((d) => `${d.kind} ${d.host}:${d.port}`);
    assert.deepEqual(background, [], "Chromium made requests no tab asked for");
    assert.deepEqual([...new Set(resolved)].filter((h) => h !== "www.google.com"), ["public.test"]);
  });
});
