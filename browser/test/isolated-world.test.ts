// SPDX-License-Identifier: AGPL-3.0-only
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createIsolatedWorld, runPageScript } from "../src/isolated-world.ts";
import { setup, openPage, evaluate, skipReason, type Env } from "./harness.ts";

describe("isolated world", { skip: skipReason }, () => {
  let env: Env;
  before(async () => (env = await setup()));
  after(() => env?.close());

  test("page scripts share the DOM but not the page's globals or tampered prototypes", async () => {
    const s = await openPage(env, env.site.url("a.test", "/blank"));
    await evaluate(env, s, `window.secret = 'page'; Array.prototype.map = () => ['tampered']; document.body.textContent = 'visible text'; 1`);
    const ctx = await createIsolatedWorld(env.browser.cdp, s);
    const out = await runPageScript<{ secret: string; mapped: number[]; text: string }>(
      env.browser.cdp,
      s,
      ctx,
      `(p) => ({ secret: typeof window.secret, mapped: [1, 2].map((x) => x * p.k), text: document.body.textContent })`,
      { k: 10 },
    );
    assert.deepEqual(out, { secret: "undefined", mapped: [10, 20], text: "visible text" });
    // And the page can't see anything the isolated world sets.
    await runPageScript(env.browser.cdp, s, ctx, `() => { window.crossbar = 1; }`, null);
    assert.equal(await evaluate(env, s, `typeof window.crossbar`), "undefined");
  });
});
