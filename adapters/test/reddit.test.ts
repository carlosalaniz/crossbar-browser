// SPDX-License-Identifier: AGPL-3.0-only
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { adapterFor, matchReadOperation } from "../src/index.ts";
import { reddit } from "../reddit/site.ts";
import { setup, openPage, skipReason, type Env } from "../../browser/test/harness.ts";
import { PageScripts } from "../../browser/src/page-scripts/index.ts";
import { scrollAndExtract } from "../../browser/src/page-scripts/scroll.ts";

describe("reddit adapter (declarative)", () => {
  test("domain group", () => {
    for (const u of ["https://www.reddit.com/r/x", "https://old.reddit.com/", "https://i.redd.it/a.png", "https://www.redditstatic.com/x.js"]) assert.equal(adapterFor(u)?.id, "reddit", u);
    assert.equal(adapterFor("https://notreddit.com/"), undefined);
    assert.equal(adapterFor("https://reddit.com.evil.example/"), undefined);
  });
  test("read operations pass the gate, writes don't", () => {
    assert.ok(matchReadOperation("https://www.reddit.com/svc/shreddit/graphql", "POST", "CommentsPageQuery"));
    assert.ok(matchReadOperation("https://www.reddit.com/api/morechildren", "POST", null));
    assert.ok(!matchReadOperation("https://www.reddit.com/svc/shreddit/graphql", "POST", "CreateComment"));
    assert.ok(!matchReadOperation("https://www.reddit.com/api/comment", "POST", null));
    assert.ok(!matchReadOperation("https://example.com/api/morechildren", "POST", null));
  });
  test("sensitive paths", () => {
    for (const p of ["/message/inbox", "/chat", "/settings/privacy", "/prefs/"]) assert.ok(reddit.sensitivePaths!.some((re) => re.test(p)), p);
    assert.ok(!reddit.sensitivePaths!.some((re) => re.test("/r/selfhosted/")));
  });
  test("old.reddit.com only when signed in; www for anonymous reads (ADR 0012)", () => {
    assert.deepEqual(reddit.readHosts, { signedIn: "old.reddit.com", anonymous: "www.reddit.com" });
  });
});

describe("reddit adapter against its saved fixture", { skip: skipReason }, () => {
  let env: Env;
  before(async () => (env = await setup()));
  after(() => env?.close());
  test("items are keyed by data-fullname and the next link is a read", async () => {
    const s = await openPage(env, env.site.url("a.test", "/fixture/adapters/reddit/old-reddit-listing.html"));
    const scripts = new PageScripts(env.browser.cdp);
    const r = await scrollAndExtract(env.browser.cdp, s, scripts, { until: { items: 30 }, paceMs: 150, collect: { selector: reddit.items!.selector, keyAttr: reddit.items!.keyAttr } });
    assert.equal(r.items.length, 30);
    assert.equal(r.items[0]!.key, "t3_ab001");
    assert.match(r.items[0]!.text, /Self-hosting question number 1/);
    const page = await scripts.extract(s, { includeLinks: true });
    assert.ok(page.links!.some((l) => l.text.startsWith("next") && l.href?.includes("after=t3_ab030")));
  });
});
