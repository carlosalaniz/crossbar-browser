// SPDX-License-Identifier: AGPL-3.0-only
// Scroll and extract (ADR 0004): real wheel events at a steady pace, extracting during the scroll
// and de-duplicating by stable key, because virtualized feeds drop items that leave the viewport.
import type { CdpConnection } from "../cdp.ts";
import type { CollectParams, CollectedItem, PageScripts } from "./index.ts";

export type Until = { items: number } | { end: true } | { tokens: number };
export type StopReason = "target" | "end" | "no_growth" | "cap";

export interface ScrollCaps {
  maxScrolls: number;
  maxSeconds: number;
  maxTokens: number;
}

/** Server-side ceilings. Agent-supplied caps are clamped to these. */
export const SCROLL_CAP_CEILING: ScrollCaps = { maxScrolls: 60, maxSeconds: 90, maxTokens: 20_000 };

export interface ScrollOptions {
  until: Until;
  caps?: Partial<ScrollCaps>;
  /** Pause between wheel events (pacing). */
  paceMs?: number;
  /** Scrolls without new items before stopping with no_growth. */
  noGrowthLimit?: number;
  collect?: CollectParams;
}

export interface ScrollResult {
  items: CollectedItem[];
  stoppedBecause: StopReason;
  scrolls: number;
  tokens: number;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function clampCaps(c: Partial<ScrollCaps> = {}): ScrollCaps {
  return {
    maxScrolls: Math.min(c.maxScrolls ?? SCROLL_CAP_CEILING.maxScrolls, SCROLL_CAP_CEILING.maxScrolls),
    maxSeconds: Math.min(c.maxSeconds ?? SCROLL_CAP_CEILING.maxSeconds, SCROLL_CAP_CEILING.maxSeconds),
    maxTokens: Math.min(c.maxTokens ?? SCROLL_CAP_CEILING.maxTokens, SCROLL_CAP_CEILING.maxTokens),
  };
}

export async function scrollAndExtract(cdp: CdpConnection, sessionId: string, scripts: PageScripts, opts: ScrollOptions): Promise<ScrollResult> {
  const caps = clampCaps(opts.caps);
  const pace = Math.max(opts.paceMs ?? 500, 150);
  const noGrowthLimit = opts.noGrowthLimit ?? 3;
  const started = Date.now();
  const seen = new Map<string, CollectedItem>();
  let tokens = 0;
  let scrolls = 0;
  let noGrowth = 0;

  const take = async () => {
    let added = 0;
    for (const it of await scripts.collectItems(sessionId, opts.collect)) {
      if (seen.has(it.key)) continue;
      seen.set(it.key, it);
      tokens += estimateTokens(it.text);
      added++;
    }
    return added;
  };
  const reached = (): boolean => {
    const u = opts.until;
    if ("items" in u) return seen.size >= u.items;
    if ("tokens" in u) return tokens >= u.tokens;
    return false;
  };
  const result = (stoppedBecause: StopReason): ScrollResult => {
    let items = [...seen.values()];
    if ("items" in opts.until) items = items.slice(0, opts.until.items);
    return { items, stoppedBecause, scrolls, tokens };
  };

  await take();
  for (;;) {
    if (reached()) return result("target");
    if (scrolls >= caps.maxScrolls || tokens >= caps.maxTokens || Date.now() - started >= caps.maxSeconds * 1000) return result("cap");
    const before = await scripts.scrollState(sessionId);
    const { layoutViewport } = await cdp.send("Page.getLayoutMetrics", undefined, sessionId);
    const x = Math.round(layoutViewport.clientWidth / 2);
    const y = Math.round(layoutViewport.clientHeight / 2);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: Math.round(before.viewportHeight * 0.8) }, sessionId);
    scrolls++;
    await sleep(pace);
    const added = await take();
    const after = await scripts.scrollState(sessionId);
    if (after.atEnd && added === 0) {
      // One more pause for infinite feeds that load at the bottom.
      await sleep(pace);
      if ((await take()) === 0 && (await scripts.scrollState(sessionId)).atEnd) return result(reached() ? "target" : "end");
    }
    // Progress is new items or new scroll distance; only a stall with neither counts as no growth.
    const moved = after.scrollY > before.scrollY + 1 || after.scrollHeight > before.scrollHeight;
    noGrowth = added === 0 && !moved ? noGrowth + 1 : 0;
    if (noGrowth >= noGrowthLimit) return result(reached() ? "target" : "no_growth");
  }
}
