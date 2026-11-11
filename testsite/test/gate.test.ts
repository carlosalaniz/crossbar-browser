// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate, parseMode, resolveConfig, overridesFromEnv, overridesFromQuery, modeString, type GateConfig } from "../src/gate.ts";
import { Client, startSite } from "./helpers.ts";

const S = { session: "s1", ip: "10.1.1.1", path: "/gated/article" };
const cfg = (q: string): GateConfig => resolveConfig({ query: overridesFromQuery(new URLSearchParams(q)) });
const run = (g: Gate, c: GateConfig, n: number, subj = S) => Array.from({ length: n }, () => g.decide(c, subj).challenge);

test("parseMode accepts the five forms and rejects nonsense", () => {
  assert.deepEqual(parseMode("always"), { kind: "always" });
  assert.deepEqual(parseMode("never"), { kind: "never" });
  assert.deepEqual(parseMode("every:3"), { kind: "every", n: 3 });
  assert.deepEqual(parseMode("random:0.25"), { kind: "random", p: 0.25 });
  assert.deepEqual(parseMode("after:0"), { kind: "after", n: 0 });
  for (const bad of ["sometimes", "every:0", "every:1.5", "random:2", "after:-1", "every:"]) assert.throws(() => parseMode(bad), /bad mode|needs/, bad);
  assert.equal(modeString(parseMode("every:4")), "every:4");
});

test("always and never", () => {
  const g = new Gate();
  assert.deepEqual(run(g, cfg("mode=always"), 3), [true, true, true]);
  assert.deepEqual(run(new Gate(), cfg("mode=never"), 3), [false, false, false]);
});

test("every:N challenges requests N, 2N, 3N", () => {
  assert.deepEqual(run(new Gate(), cfg("mode=every:3"), 7), [false, false, true, false, false, true, false]);
  assert.deepEqual(run(new Gate(), cfg("mode=every:1"), 3), [true, true, true]);
});

test("after:N lets the first N through, challenges the rest", () => {
  assert.deepEqual(run(new Gate(), cfg("mode=after:2"), 5), [false, false, true, true, true]);
  assert.deepEqual(run(new Gate(), cfg("mode=after:0"), 2), [true, true]);
});

test("random:P uses the injected rng", () => {
  const seq = [0.1, 0.6, 0.49, 0.5];
  let i = 0;
  const g = new Gate(() => seq[i++]!);
  assert.deepEqual(run(g, cfg("mode=random:0.5"), 4), [true, false, true, false]);
  assert.deepEqual(run(new Gate(() => 0), cfg("mode=random:0"), 3), [false, false, false]);
});

test("scope decides what N counts", () => {
  const other = { session: "s2", ip: S.ip, path: "/other" };
  // session: each session has its own count
  let g = new Gate();
  const bySession = cfg("mode=after:1&scope=session");
  assert.deepEqual([g.decide(bySession, S).challenge, g.decide(bySession, other).challenge, g.decide(bySession, S).challenge], [false, false, true]);
  // ip: both sessions share the count (same IP)
  g = new Gate();
  const byIp = cfg("mode=after:1&scope=ip");
  assert.deepEqual([g.decide(byIp, S).challenge, g.decide(byIp, other).challenge], [false, true]);
  // path: different paths count separately, whatever the session
  g = new Gate();
  const byPath = cfg("mode=after:1&scope=path");
  assert.deepEqual([g.decide(byPath, S).challenge, g.decide(byPath, other).challenge, g.decide(byPath, { ...other, path: S.path }).challenge], [false, false, true]);
});

test("clearance skips the challenge and doesn't count", () => {
  const g = new Gate();
  const c = cfg("mode=always&clearance=on");
  assert.deepEqual(g.decide(c, S, true), { challenge: false, count: 0, reason: "clearance" });
  assert.equal(g.count("session", S), 0);
  const off = cfg("mode=always&clearance=off");
  assert.equal(g.decide(off, S, true).challenge, true, "clearance=off ignores the cookie");
});

test("precedence: query over admin over env", () => {
  const env = overridesFromEnv({ TESTSITE_GATE_MODE: "always", TESTSITE_GATE_PROVIDER: "hcaptcha", TESTSITE_GATE_STYLE: "status" });
  const admin = { mode: "every:2", provider: "datadome" };
  const query = overridesFromQuery(new URLSearchParams("mode=never"));
  const c = resolveConfig({ env, admin, query });
  assert.equal(modeString(c.mode), "never");
  assert.equal(c.provider, "datadome");
  assert.equal(c.style, "status");
  assert.equal(modeString(resolveConfig({ env }).mode), "always");
  assert.throws(() => resolveConfig({ query: { provider: "nope" } }), /bad provider/);
});

test("HTTP: every:3 interstitial on the real server, counted per session", async () => {
  const site = await startSite();
  try {
    const a = new Client(site.port);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await a.get("site-a.test", "/gated/article?mode=every:3&style=interstitial")).status);
    assert.deepEqual(statuses, [200, 200, 403, 200, 200, 403]);
    const b = new Client(site.port); // new session, new count
    assert.equal((await b.get("site-a.test", "/gated/article?mode=every:3&style=interstitial")).status, 200);
  } finally {
    await site.close();
  }
});

test("HTTP: admin setting applies, query overrides it, env is the floor", async () => {
  const site = await startSite({ env: { TESTSITE_GATE_MODE: "always", TESTSITE_GATE_STYLE: "status" } });
  try {
    const c = new Client(site.port);
    assert.equal((await c.get("site-a.test", "/gated/article")).status, 403, "env: always + status");
    const set = await c.harness("/__testsite/gate", { json: { mode: "never" }, method: "POST" });
    assert.equal(set.status, 200);
    assert.equal((await c.get("site-a.test", "/gated/article")).status, 200, "admin: never");
    assert.equal((await c.get("site-a.test", "/gated/article?mode=always&style=status&status=503")).status, 503, "query wins");
    const bad = await c.harness("/__testsite/gate", { json: { mode: "often" }, method: "POST" });
    assert.equal(bad.status, 400);
    assert.equal((await c.get("site-a.test", "/gated/article?mode=wat")).status, 400);
  } finally {
    await site.close();
  }
});

test("HTTP: status style returns a bare status, 429 with Retry-After", async () => {
  const site = await startSite();
  try {
    const c = new Client(site.port);
    const r = await c.get("site-a.test", "/gated/article?mode=always&style=status&status=429");
    assert.equal(r.status, 429);
    assert.equal(r.body, "");
    assert.equal(r.headers["retry-after"], "30");
  } finally {
    await site.close();
  }
});
