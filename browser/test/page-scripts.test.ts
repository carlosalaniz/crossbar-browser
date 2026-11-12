// SPDX-License-Identifier: AGPL-3.0-only
// Page scripts (ADRs 0002-0005) against local test pages in a real Chromium.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, openPage, evaluate, sleep, skipReason, type Env } from "./harness.ts";
import { PageScripts, pageBundle } from "../src/page-scripts/index.ts";
import { scrollAndExtract, clampCaps, SCROLL_CAP_CEILING } from "../src/page-scripts/scroll.ts";
import { AdBlocker } from "../src/adblock.ts";
import { holdNonGet } from "../src/gate.ts";

describe("page bundle", () => {
  test("bundles", async () => {
    assert.ok((await pageBundle()).length > 10_000);
  });
  test("scroll caps are clamped to the server ceiling", () => {
    assert.deepEqual(clampCaps({ maxScrolls: 10_000, maxSeconds: 5, maxTokens: 1e9 }), { maxScrolls: SCROLL_CAP_CEILING.maxScrolls, maxSeconds: 5, maxTokens: SCROLL_CAP_CEILING.maxTokens });
  });
});

describe("extraction", { skip: skipReason }, () => {
  let env: Env;
  let scripts: PageScripts;
  before(async () => {
    env = await setup();
    scripts = new PageScripts(env.browser.cdp);
  });
  after(() => env?.close());

  test("article extraction: markdown, refs, no hidden text, astral characters intact", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/article"));
    const r = await scripts.extract(s, { includeLinks: true });
    assert.equal(r.title, "Caddy reverse proxy notes");
    assert.match(r.content, /reverse\\?_proxy directive/);
    assert.match(r.content, /🦀 𝔘𝔫𝔦𝔠𝔬𝔡𝔢/);
    assert.doesNotMatch(r.content, /IGNORE PREVIOUS INSTRUCTIONS/);
    assert.match(r.content, /\[the Caddy docs \[e\d+\]\]\(https:\/\/caddyserver\.com\/docs\/\)/, "link ref did not survive conversion");
    const links = r.links!;
    const nav = links.find((l) => l.text === "About");
    assert.ok(nav && nav.region === "nav" && nav.href?.endsWith("/pages/about"));
    assert.ok(links.some((l) => l.kind === "input" && l.region === "form"));
    assert.ok(links.every((l) => !/IGNORE/.test(l.text)));
  });

  test("refs point at live elements and are stable across reads", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/article"));
    const a = await scripts.extract(s, { includeLinks: true });
    const b = await scripts.extract(s, { includeLinks: true });
    const ref = a.links!.find((l) => l.text === "Reply")!.ref;
    assert.equal(b.links!.find((l) => l.text === "Reply")!.ref, ref);
    // The ref resolves to the live element through the isolated world; the page's DOM carries no marker.
    const objectId = (await scripts.elementHandle(s, ref))!;
    const d = await env.browser.cdp.send("DOM.describeNode", { objectId }, s);
    assert.deepEqual(d.node.attributes?.filter((x, i) => i % 2 === 0 && x === "id"), ["id"]);
    assert.equal(d.node.attributes![d.node.attributes!.indexOf("id") + 1], "reply");
    assert.equal(await evaluate(env, s, `document.querySelectorAll('[data-cb-ref], [data-cb-clickable]').length`), 0);
  });

  test("the page can't see the extraction code", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/article"));
    await scripts.extract(s);
    assert.equal(await evaluate(env, s, `typeof globalThis.__crossbar`), "undefined");
  });

  test("whole-page fallback when the article extractor finds too little", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/ads"));
    const r = await scripts.extract(s, { minWords: 500 });
    assert.equal(r.usedFallback, true);
    assert.match(r.content, /Real content about homelabs/);
  });

  test("works again after a navigation (fresh isolated world)", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/article"));
    await scripts.extract(s);
    await env.browser.cdp.send("Page.navigate", { url: env.site.url("a.test", "/pages/ads") }, s);
    await sleep(500);
    const r = await scripts.extract(s, { minWords: 1 });
    assert.match(r.content, /homelabs/);
  });
});

describe("scroll and extract", { skip: skipReason }, () => {
  let env: Env;
  let scripts: PageScripts;
  before(async () => {
    env = await setup();
    scripts = new PageScripts(env.browser.cdp);
  });
  after(() => env?.close());

  test("infinite feed: stops at the item target", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/infinite"));
    const r = await scrollAndExtract(env.browser.cdp, s, scripts, { until: { items: 25 }, paceMs: 250, collect: { keyAttr: "data-post-id" } });
    assert.equal(r.stoppedBecause, "target");
    assert.equal(r.items.length, 25);
    assert.equal(new Set(r.items.map((i) => i.key)).size, 25);
  });

  test("infinite feed: reports end when the feed runs out", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/infinite"));
    const r = await scrollAndExtract(env.browser.cdp, s, scripts, { until: { end: true }, paceMs: 250, collect: { keyAttr: "data-post-id" } });
    assert.ok(r.stoppedBecause === "end" || r.stoppedBecause === "no_growth", r.stoppedBecause);
    assert.equal(r.items.length, 45);
  });

  test("virtualized list: collects items that left the DOM", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/virtual"));
    const r = await scrollAndExtract(env.browser.cdp, s, scripts, { until: { end: true }, paceMs: 200, collect: { keyAttr: "data-row-id" } });
    assert.equal(r.items.length, 80, `got ${r.items.length}, stopped: ${r.stoppedBecause}`);
    assert.ok((await scripts.collectItems(s, { keyAttr: "data-row-id" })).length < 30, "list wasn't virtualized");
  });

  test("caps stop the scroll", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/virtual"));
    const r = await scrollAndExtract(env.browser.cdp, s, scripts, { until: { end: true }, paceMs: 150, caps: { maxScrolls: 2 }, collect: { keyAttr: "data-row-id" } });
    assert.equal(r.stoppedBecause, "cap");
    assert.equal(r.scrolls, 2);
  });
});

describe("ad blocking", { skip: skipReason }, () => {
  const blocker = AdBlocker.fromLists(["||a.test^*/ads/", "/tracker/*", "##.ad-banner"]);
  let env: Env;
  let scripts: PageScripts;
  before(async () => {
    env = await setup();
    // Compose: ad block first, then the write policy.
    const pageUrls = new Map<string, string>();
    env.gate["policy" as never] = ((r: Parameters<typeof holdNonGet>[0]) => {
      if (r.resourceType === "Document" && r.targetType === "page") pageUrls.set(r.sessionId, r.url);
      if (blocker.shouldBlock(r, pageUrls.get(r.sessionId) ?? r.url)) return { verdict: "deny", rule: "blocked_ad" };
      return holdNonGet(r);
    }) as never;
    scripts = new PageScripts(env.browser.cdp);
  });
  after(() => env?.close());

  test("ad and tracker requests are blocked in the gate and logged as blocked_ad", async () => {
    await openPage(env, env.site.url("a.test", "/pages/ads"));
    await sleep(300);
    assert.equal(env.site.hits.filter((h) => h.case === "ad").length, 0);
    const blocked = env.gate.seen.filter((x) => x.rule === "blocked_ad");
    assert.ok(blocked.some((b) => b.request.url.includes("/ads/banner.png")));
    assert.ok(blocked.some((b) => b.request.url.includes("/tracker/pixel.js")));
  });

  test("cosmetic filtering hides ad elements, so extraction drops them", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/ads"));
    const css = blocker.cosmeticCss(env.site.url("a.test", "/pages/ads"), await scripts.call(s, "domTokens"));
    assert.match(css, /ad-banner/);
    const styles = await evaluate(env, s, "document.querySelectorAll('style').length");
    await scripts.call(s, "applyCosmetics", { css });
    const r = await scripts.extract(s, { minWords: 1 });
    assert.doesNotMatch(r.content, /BUY NOW/);
    // S03: no <style> node and no fixed id added to the page.
    assert.equal(await evaluate(env, s, "document.querySelectorAll('style').length"), styles);
    assert.equal(await evaluate(env, s, "document.getElementById('cb-cosmetic')"), null);
    assert.match(r.content, /Real content/);
  });
});
