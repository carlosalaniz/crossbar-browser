// SPDX-License-Identifier: AGPL-3.0-only
// The test site itself: request log, harness isolation, scenarios.json, hosts, accounts, Stripe config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { detect } from "@crossbar/detect";
import { DEV_TESTSITE_HOSTS } from "@crossbar/proxy/dev-allowlist";
import { HOSTS, parseHost } from "../src/context.ts";
import { SCENARIOS, OUTCOMES, loadScenarios } from "../src/scenarios.ts";
import { totpAt, verifyTotp } from "../src/accounts.ts";
import { parseDotEnv } from "../src/env.ts";
import { encodeParams, signWebhook, stripeConfigFromEnv, verifyWebhook } from "../src/stripe/client.ts";
import { LAN_TARGETS } from "../src/routes/sites.ts";
import type { LogEntry } from "../src/log.ts";
import { Client, factsFrom, startSite } from "./helpers.ts";

test("/__testsite/log records host, method, path, query keys, body keys and session; never values", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    await c.get("site-a.test", "/comments?page=2&expand=3");
    await c.post("site-a.test", "/comments", { text: "secret-value-123" });
    await c.req("exfil.test", "/save?d=FIXTURE-7781");
    const log = JSON.parse((await c.harness("/__testsite/log")).body) as LogEntry[];
    const post = log.find((e) => e.method === "POST" && e.path === "/comments")!;
    assert.deepEqual(post.bodyKeys, ["text"]);
    assert.equal(post.host, "site-a.test");
    assert.ok(post.session, "session recorded");
    const get = log.find((e) => e.path === "/comments" && e.method === "GET")!;
    assert.deepEqual(get.queryKeys, ["page", "expand"]);
    assert.ok(!JSON.stringify(log).includes("secret-value-123"), "no body values");
    assert.ok(!JSON.stringify(log).includes("FIXTURE-7781"), "no query values");
    const exfil = JSON.parse((await c.harness("/__testsite/log?host=exfil.test")).body) as LogEntry[];
    assert.equal(exfil.length, 1);
    assert.deepEqual(exfil[0]!.queryKeys, ["d"]);
    // The harness itself isn't logged.
    assert.ok(!log.some((e) => e.path.startsWith("/__testsite")));
    // since= filter and reset.
    const since = JSON.parse((await c.harness(`/__testsite/log?since=${post.seq}`)).body) as LogEntry[];
    assert.ok(since.every((e) => e.seq > post.seq));
    assert.equal((await c.harness("/__testsite/reset", { method: "POST" })).status, 200);
    assert.deepEqual(JSON.parse((await c.harness("/__testsite/log")).body), []);
  } finally {
    await site.close();
  }
});

test("a request that never arrived is absent from the log (the assertion Crossbar tests make)", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    await c.get("site-a.test", "/inbox");
    const log = JSON.parse((await c.harness("/__testsite/log?host=exfil.test")).body) as LogEntry[];
    assert.deepEqual(log, []);
  } finally {
    await site.close();
  }
});

test("the harness is not served on the .test hosts a browser under test uses", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    for (const h of HOSTS) {
      assert.equal((await c.get(h, "/__testsite/log")).status, 404, h);
      assert.equal((await c.req(h, "/__testsite/gate", { method: "POST", json: { mode: "never" } })).status, 404, h);
    }
    assert.equal((await c.harness("/__testsite/")).status, 200);
    assert.equal((await c.req(`site-a.test.localhost:${site.port}`, "/__testsite/")).status, 200);
  } finally {
    await site.close();
  }
});

test("scenarios.json: valid outcomes, unique ids, and every offline scenario answers", async () => {
  assert.ok(SCENARIOS.length >= 40);
  for (const s of SCENARIOS) assert.ok((OUTCOMES as readonly string[]).includes(s.outcome), s.id);
  assert.ok(!JSON.stringify(SCENARIOS).includes("needs_human"), "ADR 0001: the state is `blocked`, not needs_human");
  assert.ok(SCENARIOS.filter((s) => s.area.startsWith("Stripe")).every((s) => s.mode === "live"), "Stripe is live-only");
  const site = await startSite();
  try {
    const c = new Client(site.port);
    await c.post("site-a.test", "/login", { username: "alice", password: "correct-horse-battery-staple" });
    for (const s of SCENARIOS.filter((x) => x.mode === "offline")) {
      const r = await c.get(s.host, s.path);
      const expected5xx = s.path.includes("style=status") || s.path.includes("status=503");
      assert.ok((r.status < 500 || expected5xx) && r.status !== 404 && r.status !== 405, `${s.id}: ${s.host}${s.path} -> ${r.status}`);
    }
    const index = await c.get("site-a.test", "/");
    for (const s of SCENARIOS) assert.ok(index.body.includes(`data-scenario="${s.id}"`), `index lists ${s.id}`);
    assert.match(index.body, /disabled: STRIPE_PUBLISHABLE_KEY/, "Stripe shown disabled without keys");
  } finally {
    await site.close();
  }
});

test("loadScenarios rejects an unknown outcome", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const f = join(mkdtempSync(join(tmpdir(), "ts-")), "s.json");
  writeFileSync(f, JSON.stringify({ scenarios: [{ id: "x", area: "a", title: "t", host: "h", path: "/", outcome: "needs_human:captcha", mode: "offline" }] }));
  assert.throws(() => loadScenarios(new URL(`file://${f}`)), /unknown outcome/);
});

test("the proxy's dev allowlist and the site's hosts are the same list, and exclude LAN targets", () => {
  assert.deepEqual([...DEV_TESTSITE_HOSTS].sort(), [...HOSTS].sort());
  for (const t of LAN_TARGETS) assert.ok(!DEV_TESTSITE_HOSTS.includes(new URL(t.url).hostname), t.url);
});

test("parseHost maps .test, .test.localhost and unknown hosts", () => {
  assert.deepEqual(parseHost("site-b.test"), { host: "site-b.test", suffix: "", port: "" });
  assert.deepEqual(parseHost("exfil.test.localhost:8090"), { host: "exfil.test", suffix: ".localhost", port: "8090" });
  assert.equal(parseHost("evil.example").host, "site-a.test");
});

test("detect/ sees the login wall, consent wall, pacing 429 and status-only blocks", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    const wall = await c.get("site-a.test", "/members/article");
    assert.equal(wall.status, 302);
    const login = await c.get("site-a.test", wall.headers.location!.replace(/^https?:\/\/[^/]+/, ""));
    assert.equal(detect(factsFrom("http://site-a.test/login?next=%2Fmembers%2Farticle", login))?.kind, "login");
    assert.equal(detect(factsFrom("http://site-b.test/consent-wall", await c.get("site-b.test", "/consent-wall")))?.kind, "consent");
    for (let i = 0; i < 3; i++) await c.get("site-a.test", "/paced/feed?limit=3");
    const limited = await c.get("site-a.test", "/paced/feed?limit=3");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers["retry-after"]) > 0);
    assert.equal(detect(factsFrom("http://site-a.test/paced/feed", limited))?.kind, "soft_block");
    const bare = await c.get("site-a.test", "/gated/article?mode=always&style=status&status=403");
    assert.equal(detect(factsFrom("http://site-a.test/gated/article", bare))?.kind, "soft_block");
    // The 200 soft block behind an app gate (detect/ app-gate signature).
    assert.equal(detect(factsFrom("http://site-a.test/soft-block/post", await c.get("site-a.test", "/soft-block/post")))?.kind, "soft_block");
  } finally {
    await site.close();
  }
});

test("credential fields carry the attributes Crossbar refuses on", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    assert.match((await c.get("site-a.test", "/login")).body, /type="password" name="password" autocomplete="current-password"/);
    assert.match((await c.get("site-a.test", "/checkout")).body, /autocomplete="cc-number"/);
    await c.post("site-a.test", "/login", { username: "bob", password: "tr0ub4dor-and-3" });
    const totp = await c.get("site-a.test", "/login/totp");
    assert.match(totp.body, /autocomplete="one-time-code"/);
    const bad = await c.post("site-a.test", "/login/totp", { code: "000000" });
    assert.equal(bad.status, 401);
    const ok = await c.post("site-a.test", "/login/totp", { code: totpAt("JBSWY3DPEHPK3PXP", Date.now()) });
    assert.equal(ok.status, 303);
    assert.equal((await c.get("site-a.test", "/inbox")).status, 200);
  } finally {
    await site.close();
  }
});

test("TOTP matches the RFC 6238 SHA-1 test vector", () => {
  // Secret "12345678901234567890" (ASCII) in base32; T = 59 s -> 94287082 (8 digits).
  assert.equal(totpAt("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000, 30, 8), "94287082");
  assert.equal(verifyTotp("JBSWY3DPEHPK3PXP", "abc"), false);
});

test("inbox carries the injection variants pointing at exfil.test", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    await c.post("site-a.test", "/login", { username: "alice", password: "correct-horse-battery-staple" });
    const inbox = (await c.get("site-a.test", "/inbox")).body;
    assert.match(inbox, /exfil\.test\/save\?d=/);
    assert.match(inbox, /exfil\.test\/m\//);
    assert.match(inbox, /exfil\.test\/collect-form/);
    assert.match(inbox, /display:none/);
    for (const p of ["/message", "/chat", "/settings", "/billing"]) assert.equal((await new Client(site.port).get("site-a.test", p)).status, 302, `${p} needs login`);
  } finally {
    await site.close();
  }
});

test("WebSocket endpoint completes a handshake and logs it", async () => {
  const site = await startSite();
  try {
    const res = await new Promise<{ status: number | undefined }>((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const r = request({ host: "127.0.0.1", port: site.port, path: "/ws", headers: { host: "site-a.test", connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
        r.on("upgrade", (resp, socket) => {
          socket.destroy();
          resolve({ status: resp.statusCode });
        });
        r.on("error", reject);
        r.end();
      });
    });
    assert.equal(res.status, 101);
    assert.ok(site.app.log.list({ pathPrefix: "/ws" }).some((e) => e.upgrade === "websocket"));
  } finally {
    await site.close();
  }
});

test("Stripe config: missing keys disable it; non-test keys refuse to start", () => {
  assert.equal(stripeConfigFromEnv({}), null);
  assert.equal(stripeConfigFromEnv({ STRIPE_PUBLISHABLE_KEY: "pk_" + "test_abc" }), null);
  const pk = "pk_" + "test_abc";
  assert.ok(stripeConfigFromEnv({ STRIPE_PUBLISHABLE_KEY: pk, STRIPE_SECRET_KEY: "rk_" + "test_abc" }));
  assert.throws(() => stripeConfigFromEnv({ STRIPE_PUBLISHABLE_KEY: "pk_" + "live_abc", STRIPE_SECRET_KEY: "sk_" + "test_abc" }), /not a test-mode/);
  assert.throws(() => stripeConfigFromEnv({ STRIPE_PUBLISHABLE_KEY: pk, STRIPE_SECRET_KEY: "sk_" + "live_abc" }), /not a test-mode/);
  assert.throws(() => stripeConfigFromEnv({ STRIPE_PUBLISHABLE_KEY: pk, STRIPE_SECRET_KEY: "sk_" + "test_abc", STRIPE_WEBHOOK_SECRET: "nope" }), /malformed/);
});

test("Stripe form encoding and webhook signatures", () => {
  assert.deepEqual(encodeParams({ a: 1, m: { k: "v" }, items: [{ price: "p" }], keys: ["x"], skip: undefined }), ["a=1", "m%5Bk%5D=v", "items%5B0%5D%5Bprice%5D=p", "keys%5B0%5D=x"]);
  const body = JSON.stringify({ type: "payment_intent.succeeded" });
  const secret = "whsec_" + "fixture";
  const h = signWebhook(body, secret);
  assert.equal(verifyWebhook(Buffer.from(body), h, secret), true);
  assert.equal(verifyWebhook(Buffer.from(body + " "), h, secret), false, "tampered body");
  assert.equal(verifyWebhook(Buffer.from(body), h, "whsec_" + "other"), false, "wrong secret");
  assert.equal(verifyWebhook(Buffer.from(body), signWebhook(body, secret, 1000), secret), false, "stale timestamp");
  assert.equal(verifyWebhook(Buffer.from(body), undefined, secret), false);
});

test("parseDotEnv", () => {
  assert.deepEqual(parseDotEnv("# c\nA=1\nB = 'two'\nC=\"3\"\n\nbad line\n"), { A: "1", B: "two", C: "3" });
});

test("no Stripe key is committed anywhere in the repo", () => {
  const pattern = ["sk", "pk", "rk"].map((p) => `${p}_(test|live)_[A-Za-z0-9]{20,}`).join("|");
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-nE", pattern, "--", "."], { encoding: "utf8", cwd: new URL("../..", import.meta.url).pathname });
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e; // 1 = no matches
  }
  assert.equal(out, "", `Stripe keys found in tracked files:\n${out}`);
});

test("README scenario table matches scenarios.json (regenerate: node testsite/src/readme.ts)", async () => {
  const { readFileSync } = await import("node:fs");
  const { README, renderReadme } = await import("../src/readme.ts");
  const text = readFileSync(README, "utf8");
  assert.equal(text, renderReadme(text));
});
