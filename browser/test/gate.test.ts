// SPDX-License-Identifier: AGPL-3.0-only
// Network gate security tests (Access Model L5). Real Chromium, local pages only.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, runCase, openPage, evaluate, collect, sleep, skipReason, WRITE_CASES, type Env } from "./harness.ts";
import { DEFAULT_HOLD_TIMEOUT_MS, holdNonGet, NetworkGate } from "../src/gate.ts";
import { securityArgs, supportsLoadExtension } from "../src/launch.ts";

describe("network gate", { skip: skipReason }, () => {
  let env: Env;
  before(async () => {
    env = await setup({
      holdTimeoutMs: 1000,
      onHeld: (h) => {
        if (h.request.url.includes("/r307") || h.request.url.includes("case=release-me")) void h.release();
        else if (h.request.url.includes("case=timeout")) {
          /* leave it held: the gate's timeout must fail it */
        } else void h.fail();
      },
    });
  });
  after(() => env?.close());

  for (const c of WRITE_CASES.filter((c) => c.kind !== "socket")) {
    test(`holds a non-GET sent by ${c.name} and it never reaches the server`, async () => {
      const r = await runCase(env, c);
      assert.ok(r.paused.length >= 1, `gate did not pause ${c.name}`);
      assert.equal(r.reached.length, 0, `${c.name} reached the server: ${JSON.stringify(r.reached)}`);
    });
  }

  test("every redirect hop of a non-GET is paused again", async () => {
    const s = await openPage(env, env.site.url("a.test", "/blank"));
    await evaluate(env, s, `fetch('/r307?case=redir',{method:'POST',body:'x'}).catch(()=>{}); 1`);
    await sleep(1000);
    const r = collect(env, "redir");
    const hop2 = r.paused.find((p) => p.url.includes("hop2"));
    assert.ok(hop2, "hop 2 was not paused");
    assert.ok(hop2.redirectedRequestId, "hop 2 is not marked as a redirect");
    assert.equal(r.reached.filter((h) => h.case?.endsWith("hop2")).length, 0);
  });

  test("a cross-site GET redirect hop is visible to the gate for re-checking", async () => {
    const s = await openPage(env, env.site.url("a.test", "/blank"));
    await evaluate(env, s, `location.href='/r302-cross'; 1`);
    await sleep(1000);
    const hop = env.gate.seen.find((x) => x.request.url.includes("get-redirect-hop2"));
    assert.ok(hop, "hop to b.test not seen");
    assert.match(hop.request.url, /^http:\/\/b\.test:/);
    assert.ok(hop.request.redirectedRequestId);
  });

  test("a released hold reaches the server", async () => {
    const s = await openPage(env, env.site.url("a.test", "/blank"));
    await evaluate(env, s, `fetch('/sink?case=release-me',{method:'POST',body:'x'}).then(r=>r.status)`);
    assert.equal(collect(env, "release-me").reached.length, 1);
  });

  test("held requests fail after the hold timeout", async () => {
    const s = await openPage(env, env.site.url("a.test", "/blank"));
    const started = Date.now();
    const outcome = await evaluate(env, s, `fetch('/sink?case=timeout',{method:'POST',body:'x'}).then(()=>'sent',()=>'failed')`);
    const elapsed = Date.now() - started;
    assert.equal(outcome, "failed");
    assert.ok(elapsed >= 900, `failed too early (${elapsed} ms)`);
    assert.equal(collect(env, "timeout").reached.length, 0);
  });

  test("the default hold timeout is 20 s", () => {
    assert.equal(DEFAULT_HOLD_TIMEOUT_MS, 20_000);
  });

  test("GET requests pass", async () => {
    const s = await openPage(env, env.site.url("a.test", "/blank"));
    const status = await evaluate(env, s, `fetch('/sink?case=plain-get').then(r=>r.status)`);
    assert.equal(status, 200);
  });

  test("gate attached to iframes, workers, shared workers and service workers", () => {
    const types = new Set([...env.gate.attached.values()].map((a) => a.type));
    for (const t of ["page", "iframe", "worker", "shared_worker", "service_worker"]) assert.ok(types.has(t), `never attached to ${t}`);
  });

  for (const c of WRITE_CASES.filter((c) => c.kind === "socket")) {
    test(`blocks WebSockets opened by ${c.name.replace("websocket-", "")}`, async (t) => {
      if (!supportsLoadExtension(env.browser.executablePath)) {
        assert.fail(`${env.browser.executablePath} ignores --load-extension, so WebSockets are NOT blocked. Run node scripts/ensure-browser.mjs.`);
      }
      const r = await runCase(env, c);
      t.diagnostic(`fetch paused=${r.paused.length}`);
      assert.equal(r.reached.length, 0, "WebSocket handshake reached the server");
    });
  }
});

describe("gate policy", () => {
  test("default policy holds every method except GET and HEAD", () => {
    const base = { requestId: "1", sessionId: "s", targetType: "page", targetUrl: "", url: "http://x/", resourceType: "Fetch" as const, frameId: "f", hasPostData: false };
    for (const m of ["GET", "HEAD"]) assert.equal(holdNonGet({ ...base, method: m }), "allow");
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND", "post"]) assert.equal(holdNonGet({ ...base, method: m }), "hold");
  });

  test("a policy that throws denies (fails closed)", async () => {
    const sent: string[] = [];
    const fake = {
      on: (ev: string, h: (p: unknown, s?: string) => void) => {
        if (ev === "Fetch.requestPaused") queueMicrotask(() => h({ requestId: "r1", request: { method: "POST", url: "http://x/" }, resourceType: "Fetch", frameId: "f" }, "s1"));
        return () => {};
      },
      send: async (m: string) => {
        sent.push(m);
        return {};
      },
    };
    const gate = new NetworkGate(fake as never, {
      policy: () => {
        throw new Error("bug");
      },
    });
    await gate.start();
    await sleep(10);
    assert.ok(sent.includes("Fetch.failRequest"));
    assert.ok(!sent.includes("Fetch.continueRequest"));
    assert.equal(gate.seen[0]?.verdict, "deny");
  });
});

describe("launch flags", () => {
  test("QUIC is off and WebRTC can't use UDP outside the proxy", () => {
    const args = securityArgs({ proxyServer: "http://proxy:3128" });
    assert.ok(args.includes("--disable-quic"));
    assert.ok(args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
    assert.ok(args.includes("--proxy-server=http://proxy:3128"));
    assert.ok(args.includes("--proxy-bypass-list=<-loopback>"));
  });
});
