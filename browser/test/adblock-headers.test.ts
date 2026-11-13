// SPDX-License-Identifier: AGPL-3.0-only
// uBO header= rules (ADR 0036): parsed from the lists as uBO writes them, matched by response headers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHeaderRule, parseHeaderRules, candidates, matchHeaders } from "../src/adblock-headers.ts";
import { AdBlocker } from "../src/adblock.ts";

// Copied from uBO's quick-fixes and filters lists (13 Nov 2026).
const UBO = [
  String.raw`/^https:\/\/(?:[a-z]{3,4}\.)?[0-9a-z-]{6,}\.(?:com|xyz)\/script\/(?:[-.0-9A-Za-z]+\.)?[-0-9A-Za-z]{2,30}\.js$/$script,3p,match-case,header=x-length`,
  String.raw`/^https:\/\/[a-z]{3,4}\.[a-z]{8,16}\.com\/loader\.min\.js$/$script,3p,match-case,header=etag:/^W\/"[0-9a-f]{32}-\d{13}"$/`,
  String.raw`/^https:\/\/[0-9a-z]{7,25}\.net\/(?:assets|build)?\/?[0-9_a-z]{6,16}$/$script,3p,match-case,to=~adatoolbar.com|~polldaddy.com,header=via:/, 1\.1 google$/`,
  String.raw`/^https:\/\/[a-z]{10,}\.[a-z]{3,4}\/(?:engine|track)-[a-f0-9]{8}\.js$/$script,3p,to=~edu|~gov,header=vary:/^referer\,accept-encoding/i`,
  String.raw`/^https:\/\/[a-z]{3,30}\.[a-z]{2,4}\/socket\.io\/socket\.io\.js$/$header=nel:/report_to":"cf-nel/,script,1p,strict1p,match-case,domain=ci|ge|eu|life`,
];
const page = "https://www.solsticeforum.com/threads/x/";

test("every header rule in uBO's lists parses, with commas inside a header regex", () => {
  const rules = parseHeaderRules(UBO.join("\n"));
  assert.equal(rules.length, UBO.length);
  assert.deepEqual(rules.map((r) => r.header), ["x-length", "etag", "via", "vary", "nel"]);
  assert.equal(String(rules[2]!.value), String.raw`/, 1\.1 google$/`);
  assert.equal(String(rules[3]!.value), "/^referer,accept-encoding/i");
  assert.deepEqual(rules[2]!.notTo, ["adatoolbar.com", "polldaddy.com"]);
});

test("Ad-Shield's per-site loader is a candidate; blocked only when its server sends the header (live: solsticeforum.com)", () => {
  const rules = parseHeaderRules(UBO.join("\n"));
  const req = { url: "https://stg.content-loader.com/script/www.solsticeforum.com.js", resourceType: "Script" };
  const c = candidates(rules, req, page);
  assert.equal(c.length, 1);
  assert.ok(matchHeaders(c, [{ name: "X-Length", value: "5120" }]));
  assert.equal(matchHeaders(c, [{ name: "content-length", value: "5120" }]), undefined);
  // The site's own scripts and other types never pause for a response check.
  assert.equal(candidates(rules, { url: "https://www.solsticeforum.com/js/xf/core-compiled.js", resourceType: "Script" }, page).length, 0);
  assert.equal(candidates(rules, { ...req, resourceType: "Image" }, page).length, 0);
});

test("party, domain= and to= limits apply before any response is paused", () => {
  const rules = parseHeaderRules(UBO.join("\n"));
  const io = { url: "https://example.life/socket.io/socket.io.js", resourceType: "Script" };
  assert.equal(candidates(rules, io, "https://example.life/").length, 1, "strict1p on a listed TLD");
  assert.equal(candidates(rules, io, "https://www.example.life/").length, 0, "strict1p: another host");
  assert.equal(candidates(rules, { url: "https://example.com/socket.io/socket.io.js", resourceType: "Script" }, "https://example.com/").length, 0, "domain= not listed");
  assert.equal(candidates(rules, { url: "https://abcdefghijkl.edu/track-0123abcd.js", resourceType: "Script" }, page).length, 0, "to=~edu");
  assert.equal(candidates(rules, { url: "https://abcdefghijkl.com/track-0123abcd.js", resourceType: "Script" }, page).length, 1);
});

test("rules this matcher can't apply exactly are skipped, never guessed", () => {
  assert.equal(parseHeaderRule(String.raw`||ads.example^$script,header=~x-length`), undefined);
  assert.equal(parseHeaderRule(String.raw`||ads.example^$script,removeparam=x,header=x-length`), undefined);
  assert.equal(parseHeaderRule(String.raw`@@||ads.example^$script,header=x-length`), undefined);
  assert.equal(parseHeaderRule(String.raw`||ads.example^$script,domain=example.*,header=x-length`), undefined);
  const plain = parseHeaderRule(String.raw`||ads.example^$script,header=server:nginx`)!;
  assert.ok(plain.url.test("https://cdn.ads.example/x.js"));
  assert.ok(matchHeaders([plain], [{ name: "Server", value: "NGINX" }]));
});

test("header rules survive the engine cache; an old cache (bare engine) still loads", () => {
  const b = AdBlocker.fromLists(["||ads.example^", UBO[0]!]);
  assert.equal(b.headerRules.length, 1);
  const back = AdBlocker.deserialize(b.serialize());
  assert.equal(back.headerRules.length, 1);
  assert.ok(back.check({ url: "https://ads.example/x.js", method: "GET", resourceType: "Script", targetType: "page" } as never, page).block);
  const old = AdBlocker.deserialize(b.engine.serialize());
  assert.equal(old.headerRules.length, 0);
  assert.ok(old.check({ url: "https://ads.example/x.js", method: "GET", resourceType: "Script", targetType: "page" } as never, page).block);
});
