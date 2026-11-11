// SPDX-License-Identifier: AGPL-3.0-only
// The fake captchas: their signatures match detect/, and their server-side token checks hold.
// No test here clicks a widget or calls the frame's /__captcha/issue endpoint. Tokens come straight
// from the token store, standing in for "a person clicked in the live view"; the tests check the
// server's verification, never that a captcha got solved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, SIGNATURES } from "@crossbar/detect";
import { FakeTokens, PROVIDER_INFO, LIVE_KEYS, liveKeys } from "../src/captcha.ts";
import { PROVIDERS } from "../src/gate.ts";
import { Client, factsFrom, startSite } from "./helpers.ts";

test("token store: valid once, then reuse, missing, unknown, wrong provider and expired all fail", () => {
  let now = 1_000_000;
  const t = new FakeTokens(300_000, () => now);
  const tok = t.issue("turnstile");
  assert.deepEqual(t.verify("turnstile", tok), { ok: true });
  assert.deepEqual(t.verify("turnstile", tok), { ok: false, error: "timeout-or-duplicate" });
  assert.deepEqual(t.verify("turnstile", undefined), { ok: false, error: "missing-input-response" });
  assert.deepEqual(t.verify("turnstile", ""), { ok: false, error: "missing-input-response" });
  assert.deepEqual(t.verify("turnstile", "fake.turnstile.made-up"), { ok: false, error: "invalid-input-response" });
  assert.deepEqual(t.verify("hcaptcha", t.issue("recaptcha")), { ok: false, error: "wrong-provider" });
  const old = t.issue("arkose");
  now += 300_001;
  assert.deepEqual(t.verify("arkose", old), { ok: false, error: "timeout-or-duplicate" });
});

test("HTTP siteverify on captcha.test: missing, bogus and reused tokens fail", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    const v = async (form: Record<string, string>) => JSON.parse((await c.post("captcha.test", "/__captcha/siteverify", form)).body);
    assert.deepEqual(await v({ provider: "turnstile" }), { success: false, "error-codes": ["missing-input-response"] });
    assert.deepEqual(await v({ provider: "turnstile", response: "nope" }), { success: false, "error-codes": ["invalid-input-response"] });
    const tok = site.app.tokens.issue("turnstile");
    assert.deepEqual(await v({ provider: "turnstile", response: tok }), { success: true });
    assert.deepEqual(await v({ provider: "turnstile", response: tok }), { success: false, "error-codes": ["timeout-or-duplicate"] });
  } finally {
    await site.close();
  }
});

test("interstitial: no token is refused; a verified token sets clearance; reuse is refused", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    const path = "/gated/article?mode=always&style=interstitial&clearance=on";
    assert.equal((await c.get("site-a.test", path)).status, 403);
    const field = PROVIDER_INFO.turnstile.responseField;
    const none = await c.post("site-a.test", "/__captcha/clear", { provider: "turnstile", return_to: path });
    assert.equal(none.status, 403, "missing token");
    const tok = site.app.tokens.issue("turnstile");
    const ok = await c.post("site-a.test", "/__captcha/clear", { provider: "turnstile", return_to: path, [field]: tok });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.location, path);
    assert.ok(c.jar.get("site-a.test")?.get("ts_clearance"), "clearance cookie set");
    assert.equal((await c.get("site-a.test", path)).status, 200, "clearance suppresses the challenge");
    const reuse = await new Client(site.port).post("site-a.test", "/__captcha/clear", { provider: "turnstile", return_to: path, [field]: tok });
    assert.equal(reuse.status, 403, "a spent token is refused");
    // A forged clearance cookie doesn't count.
    const forged = new Client(site.port);
    forged.jar.set("site-a.test", new Map([["ts_clearance", `${Date.now() + 1e9}.AAAA`]]));
    assert.equal((await forged.get("site-a.test", path)).status, 403);
  } finally {
    await site.close();
  }
});

test("clearance=off: a verified token lets one request through, then the challenge returns", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    const path = "/gated/article?mode=always&style=interstitial&clearance=off";
    await c.post("site-a.test", "/__captcha/clear", { provider: "turnstile", return_to: path, [PROVIDER_INFO.turnstile.responseField]: site.app.tokens.issue("turnstile") });
    assert.equal((await c.get("site-a.test", path)).status, 200);
    assert.equal((await c.get("site-a.test", path)).status, 403);
  } finally {
    await site.close();
  }
});

test("widget forms reject a missing captcha token (login with mode=always)", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    const page = await c.get("site-a.test", "/login?mode=always&provider=hcaptcha");
    assert.match(page.body, /class="h-captcha"/);
    const r = await c.post("site-a.test", "/login", { username: "alice", password: "correct-horse-battery-staple" });
    assert.equal(r.status, 403);
    assert.equal((await c.get("site-a.test", "/account")).status, 302, "still signed out");
  } finally {
    await site.close();
  }
});

test("every provider's fake is detected by detect/ as a captcha, as widget and as interstitial", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    for (const p of PROVIDERS) {
      for (const style of ["widget", "interstitial"]) {
        const path = `/gated/article?mode=always&style=${style}&provider=${p}`;
        const r = await c.get("site-a.test", path);
        const b = detect(factsFrom(`http://site-a.test${path}`, r));
        assert.equal(b?.kind, "captcha", `${p} ${style}: ${JSON.stringify(b)}`);
      }
      // The frame itself is served from captcha.test (cross-origin, like the real thing).
      const frame = PROVIDER_INFO[p].framePath;
      const fr = await c.get("captcha.test", frame);
      assert.equal(fr.status, 200, `${p} frame`);
      assert.match(fr.body, /isTrusted/, "the fake only reacts to trusted input");
    }
  } finally {
    await site.close();
  }
});

test("Cloudflare interstitial carries cf-mitigated: challenge; DataDome carries x-datadome", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    const cf = await c.get("site-a.test", "/gated/article?mode=always&style=interstitial&provider=turnstile&status=503");
    assert.equal(cf.status, 503);
    assert.equal(cf.headers["cf-mitigated"], "challenge");
    assert.match(cf.body, /<title>Just a moment\.\.\.<\/title>/);
    const dd = await c.get("site-a.test", "/gated/article?mode=always&style=interstitial&provider=datadome");
    assert.equal(dd.status, 403);
    assert.equal(dd.headers["x-datadome"], "protected");
    assert.ok(SIGNATURES.some((s) => s.id === "datadome"));
  } finally {
    await site.close();
  }
});

test("live mode accepts only the providers' published test keys", () => {
  const q = new URLSearchParams({ sitekey: "0x4AAAArealkey", secret: "real-secret" });
  assert.deepEqual(liveKeys("turnstile", q), { sitekey: LIVE_KEYS.turnstile.defaultSitekey, secret: LIVE_KEYS.turnstile.defaultSecret });
  const ok = new URLSearchParams({ sitekey: "3x00000000000000000000FF", secret: "2x0000000000000000000000000000000AA" });
  assert.deepEqual(liveKeys("turnstile", ok), { sitekey: "3x00000000000000000000FF", secret: "2x0000000000000000000000000000000AA" });
});
