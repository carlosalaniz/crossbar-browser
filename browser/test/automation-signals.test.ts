// SPDX-License-Identifier: AGPL-3.0-only
// Things a page can observe that mark the browser as automated (docs/automation-signal-audit.md).
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setup, openPage, evaluate, skipReason, type Env } from "./harness.ts";
import { PageScripts } from "../src/page-scripts/index.ts";

describe("automation signals", { skip: skipReason }, () => {
  let env: Env;
  let scripts: PageScripts;
  before(async () => {
    env = await setup();
    scripts = new PageScripts(env.browser.cdp);
  });
  after(() => env?.close());

  test("S01: navigator.webdriver is false (DevTools on an explicit port, never port 0)", async () => {
    assert.ok(env.browser.args.some((a) => /^--remote-debugging-port=[1-9]\d*$/.test(a)), env.browser.args.join(" "));
    assert.ok(!env.browser.args.includes("--remote-debugging-port=0"));
    const s = await openPage(env, env.site.url("a.test", "/blank"));
    assert.equal(await evaluate(env, s, "navigator.webdriver"), false);
  });

  test("headless: the screen is at least as big as the window (no 800x600 screen under a bigger window)", async () => {
    const s = await openPage(env, env.site.url("a.test", "/blank"));
    const v = JSON.parse(String(await evaluate(env, s, "JSON.stringify({ sw: screen.width, sh: screen.height, ow: outerWidth, oh: outerHeight })"))) as { sw: number; sh: number; ow: number; oh: number };
    assert.ok(v.sw >= v.ow && v.sh >= v.oh, JSON.stringify(v));
  });

  test("S02: reading, collecting, finding by text and a refused click write nothing into the page", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/article"));
    await evaluate(env, s, `window.__muts = []; new MutationObserver((l) => { for (const m of l) window.__muts.push(m.type + ':' + (m.attributeName || '')); }).observe(document, { subtree: true, childList: true, attributes: true }); 1`);
    const r = await scripts.extract(s, { includeLinks: true });
    await scripts.collectItems(s, {});
    const found = await scripts.call<Array<{ ref?: string }>>(s, "findControls", { query: "Reply", textFallback: true });
    assert.ok(found[0]?.ref);
    await scripts.call(s, "findControls", { query: "nothing like this" });
    await scripts.call(s, "checkPoint", { ref: r.links![0]!.ref, x: 1, y: 1 });
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(await evaluate(env, s, "window.__muts"), []);
    assert.equal(await evaluate(env, s, `document.querySelectorAll('[data-cb-ref], [data-cb-clickable]').length`), 0);
  });

  test("S04: Crossbar's DOM reads don't run through the page's own getters", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/article"));
    await evaluate(env, s, `window.__hits = 0; const d = Object.getOwnPropertyDescriptor(Document.prototype, 'title'); Object.defineProperty(Document.prototype, 'title', { get() { window.__hits++; return d.get.call(this); }, configurable: true }); 1`);
    assert.equal(await scripts.inspect(s, "document.title"), "Caddy reverse proxy notes");
    await scripts.extract(s);
    assert.equal(await evaluate(env, s, "window.__hits"), 0);
  });
});

test("S04: production browser code evaluates only in isolated worlds", () => {
  // Every Runtime.evaluate outside the two isolated-world helpers would run in the page's own world.
  const src = resolve(import.meta.dirname, "../src");
  const files = readdirSync(src, { recursive: true, withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith(".ts"));
  for (const f of files) {
    const path = join(f.parentPath, f.name);
    const rel = path.slice(src.length + 1);
    if (rel === "isolated-world.ts" || rel === join("page-scripts", "index.ts")) continue;
    assert.doesNotMatch(readFileSync(path, "utf8"), /["']Runtime\.evaluate["']/, `${rel} calls Runtime.evaluate outside an isolated world`);
  }
});
