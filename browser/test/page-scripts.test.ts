// SPDX-License-Identifier: AGPL-3.0-only
// Page scripts (ADRs 0002-0005) against local test pages in a real Chromium.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, openPage, evaluate, sleep, skipReason, type Env } from "./harness.ts";
import { PageScripts, pageBundle } from "../src/page-scripts/index.ts";
import { scrollAndExtract, clampCaps, SCROLL_CAP_CEILING } from "../src/page-scripts/scroll.ts";
import { AdBlocker, EXTRA_FILTERS } from "../src/adblock.ts";
import { holdNonGet } from "../src/gate.ts";

describe("page bundle", () => {
  test("bundles", async () => {
    assert.ok((await pageBundle()).length > 10_000);
  });
  test("a site's hide rules apply on its www host (registrable domain; live: none of Amazon's applied)", () => {
    const b = AdBlocker.fromLists(["example.com##.promo-strip", "example.com##.deal:has-text(Sponsored)"]);
    assert.match(b.cosmeticCss("https://www.example.com/s?k=usb"), /promo-strip/);
    assert.equal(b.extendedSelectors("https://www.example.com/s?k=usb").length, 1);
    assert.doesNotMatch(b.cosmeticCss("https://www.other.com/"), /promo-strip/);
  });

  test("Ad-Shield isn't blocked by Crossbar's own rules: blocking or stubbing its loader breaks the page (live: solsticeforum.com)", () => {
    const b = AdBlocker.fromLists([EXTRA_FILTERS]);
    const blocked = (url: string) => b.check({ url, method: "GET", resourceType: "Script", targetType: "page" } as never, "https://www.solsticeforum.com/threads/x/").block;
    for (const host of ["html-load.com", "stg.content-loader.com", "fb.html-load.com"]) assert.equal(blocked(`https://${host}/loader.min.js`), false, host);
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

  test("a page under Trusted Types still reads as markdown, not raw HTML (live: Gmail, 13 Nov 2026)", async () => {
    const s = await openPage(env, env.site.url("a.test", "/tt-article"));
    // The page really refuses string-to-DOM parsing, also from the isolated world.
    assert.match(String(await scripts.inspect(s, `(() => { try { new DOMParser().parseFromString('<p>x</p>', 'text/html'); return 'parsed'; } catch (e) { return String(e); } })()`)), /TrustedHTML/);
    const r = await scripts.extract(s, { includeLinks: true });
    assert.doesNotMatch(r.content, /Partial conversion|<\/?(div|p|article)\b/);
    assert.match(r.content, /Running Caddy as a reverse proxy/);
    assert.match(r.content, /\[the Caddy docs \[e\d+\]\]\(https:\/\/caddyserver\.com\/docs\/\)/);
  });

  test("a dashboard of web components: tiles keep their names, bare refs say what they are (live: Chase, 12 Nov 2026)", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/accounts"));
    const r = await scripts.extract(s, { mode: "auto" });
    // Each balance comes with its card's name, which lives only in the tile's aria-label.
    for (const [card, balance] of [["Orbit Rewards Visa (...4410)", "$1,203.17"], ["Harbor Cash Mastercard (...9921)", "$58.40"], ["Meadow Travel Card (...0077)", "$0.00"]] as const) {
      const at = r.content.indexOf(card);
      assert.ok(at >= 0, `${card} missing:\n${r.content}`);
      assert.ok(r.content.indexOf(balance, at) > at && r.content.indexOf(balance, at) - at < 200, `${balance} not right after ${card}:\n${r.content}`);
    }
    // The icon-only chevron: its name and state, not a bare ref.
    assert.match(r.content, /\[e\d+: Collapse credit cards \(expanded\)\]/);
    // Buttons inside the shadow roots get refs too.
    assert.equal((r.content.match(/Pay card \[e\d+\]/g) ?? []).length, 3, r.content);
    // Outline: sections and every control with its name and state, no body text.
    const o = await scripts.extract(s, { mode: "outline" });
    assert.match(o.content, /## Page outline\n- Good evening\n  - Credit cards/);
    assert.match(o.content, /\[e\d+\] button "Collapse credit cards" \(expanded\)/);
    assert.doesNotMatch(o.content, /\$1,203\.17/);
    // Repeated names say which tile they're in.
    assert.match(o.content, /button "Pay card" in "Harbor Cash Mastercard \(\.\.\.9921\)"/);
  });

  test("callout markers made of class names are dropped", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/accounts"));
    const r = await scripts.extract(s, { mode: "content" });
    assert.doesNotMatch(r.content, /\[!-/);
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
  const blocker = AdBlocker.fromLists(["||a.test^*/ads/", "/tracker/*", "##.ad-banner", "a.test##.r1:has-text(Sponsored)", "||b.test^$script,third-party,redirect=noopjs"]);
  let env: Env;
  let scripts: PageScripts;
  before(async () => {
    env = await setup();
    // Compose: ad block first, then the write policy.
    const pageUrls = new Map<string, string>();
    env.gate["policy" as never] = ((r: Parameters<typeof holdNonGet>[0]) => {
      if (r.resourceType === "Document" && r.targetType === "page") pageUrls.set(r.sessionId, r.url);
      const ad = blocker.check(r, pageUrls.get(r.sessionId) ?? r.url);
      if (ad.block) return { verdict: "deny", rule: "blocked_ad", ...(ad.respond ? { respond: ad.respond } : {}) };
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

  test("a redirect= rule answers with a stand-in: the page sees its loader load, the real one never runs (live: Ad-Shield)", async () => {
    const s = await openPage(env, env.site.url("a.test", "/pages/adshield"));
    await sleep(500);
    assert.equal(await evaluate(env, s, "document.getElementById('log').textContent"), "loaded a stand-in");
    assert.equal(env.site.hits.filter((h) => h.path.startsWith("/loader.min.js")).length, 0, "the real loader was fetched");
  });

  test("extended rules (uBO :has-text) leave sponsored results out of what the agent reads; the live page is untouched (ADR 0034)", async () => {
    const url = env.site.url("a.test", "/pages/ads");
    const s = await openPage(env, url);
    const dom = await scripts.call<{ classes: string[] }>(s, "domTokens");
    const extended = blocker.extendedSelectors(url, dom);
    assert.equal(extended.length, 1);
    await scripts.call(s, "applyCosmetics", { css: blocker.cosmeticCss(url, dom), extended });
    const r = await scripts.extract(s, { minWords: 1 });
    assert.doesNotMatch(r.content, /Cheap widgets/);
    assert.match(r.content, /Homelab guide/);
    // Evaluated in the isolated world only: the page's own elements and styles are as they were.
    assert.equal(await evaluate(env, s, "getComputedStyle(document.querySelector('.r1')).display"), "block");
    assert.equal(await evaluate(env, s, "document.querySelector('.r1').getAttribute('style')"), null);
  });
});
