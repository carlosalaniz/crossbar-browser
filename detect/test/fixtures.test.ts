// SPDX-License-Identifier: AGPL-3.0-only
// Block signatures against saved fixtures, with page facts taken by a real browser tab.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPool, localLauncher, type Tab } from "../../browser/src/pool.ts";
import { startSite } from "../../browser/test/site.ts";
import { skipReason } from "../../browser/test/harness.ts";
import { detect } from "../src/index.ts";

describe("block signatures on fixtures", { skip: skipReason }, () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  let pool: LocalPool;
  let tab: Tab;
  let dir: string;
  before(async () => {
    site = await startSite();
    dir = mkdtempSync(join(tmpdir(), "crossbar-detect-"));
    pool = new LocalPool(localLauncher({ dataDir: dir, hostResolverRules: "MAP *.test 127.0.0.1", extraArgs: process.env.CROSSBAR_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : [] }));
    tab = await pool.openTab("u", "anon");
    tab.setPolicy({ decide: () => "allow" });
  });
  after(async () => {
    await pool?.close();
    await site?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<[string, string | null]> = [
    ["/fixture/detect/cloudflare-interstitial.html", "captcha"],
    ["/fixture/detect/consent-wall.html", "consent"],
    ["/fixture/detect/anti-adblock.html", "soft_block"],
    ["/pages/login", "login"],
    ["/status/429", "soft_block"],
    ["/pages/article", null],
    ["/fixture/adapters/reddit/old-reddit-listing.html", null],
  ];
  for (const [path, kind] of cases) {
    test(`${path} → ${kind ?? "no block"}`, async () => {
      await tab.navigate(site.url("a.test", path));
      const b = detect(await tab.facts());
      assert.equal(b?.kind ?? null, kind, JSON.stringify(b));
    });
  }
});
