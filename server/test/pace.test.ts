// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pacer } from "../src/pace.ts";

test("pacing books the slot when it decides, so parallel opens queue up (audit S09)", () => {
  const p = new Pacer({ minIntervalMs: 3000 });
  const t0 = 1_000_000;
  assert.equal(p.reserve("u", "x.com", t0).waitMs, 0);
  // A second session asking at the same moment waits a full interval, a third waits two.
  assert.equal(p.reserve("u", "x.com", t0).waitMs, 3000);
  assert.equal(p.reserve("u", "x.com", t0 + 10).waitMs, 5990);
  // Other sites and other users are separate.
  assert.equal(p.reserve("u", "y.com", t0).waitMs, 0);
  assert.equal(p.reserve("v", "x.com", t0).waitMs, 0);
});

test("the hourly cap refuses instead of waiting", () => {
  const p = new Pacer({ minIntervalMs: 1000, hourlyCap: 2 });
  p.reserve("u", "x.com", 0);
  p.reserve("u", "x.com", 5000);
  assert.match(p.reserve("u", "x.com", 10_000).refuse ?? "", /Hourly cap/);
});
