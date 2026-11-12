// SPDX-License-Identifier: AGPL-3.0-only
// Runs the shipped page scripts (page.ts) in the "crossbar" isolated world.
// Agents choose parameters; the code is always this bundle (ADR 0005).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { CdpConnection } from "../cdp.ts";
import { createIsolatedWorld } from "../isolated-world.ts";
import type { CollectParams, CollectedItem, ExtractParams, ExtractResult, ScrollState } from "./page.ts";

export type { CollectParams, CollectedItem, ExtractParams, ExtractResult, LinkItem, ScrollState } from "./page.ts";

let bundled: Promise<string> | undefined;

/** One IIFE. charset utf8 keeps astral-plane characters intact in the bundle (ADR 0002). */
export function pageBundle(): Promise<string> {
  bundled ??= build({
    entryPoints: [fileURLToPath(new URL("./page.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    charset: "utf8",
    minify: true,
    legalComments: "inline",
    logLevel: "silent",
  }).then((r) => r.outputFiles[0]!.text);
  return bundled;
}

type Fn = "extract" | "collectItems" | "scrollState" | "applyCosmetics" | "listLinks" | "locateRef" | "refAtPoint" | "domTokens" | "findByText" | "checkPoint" | "elementForRef" | "refForHref";

export class PageScripts {
  private readonly contexts = new Map<string, number>();
  private readonly cdp: CdpConnection;
  constructor(cdp: CdpConnection) {
    this.cdp = cdp;
  }

  private async install(sessionId: string): Promise<number> {
    const ctx = await createIsolatedWorld(this.cdp, sessionId);
    const r = await this.cdp.send("Runtime.evaluate", { expression: await pageBundle(), contextId: ctx, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`page script install failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    this.contexts.set(sessionId, ctx);
    return ctx;
  }

  /** The live element behind a ref, as a remote object id (release it with Runtime.releaseObject), or null. */
  async elementHandle(sessionId: string, ref: string): Promise<string | null> {
    return this.call<string | null>(sessionId, "elementForRef", { ref }, false);
  }

  async call<T>(sessionId: string, fn: Fn, params: unknown = {}, byValue = true): Promise<T> {
    return this.run<T>(sessionId, `globalThis.__crossbar.${fn}(${JSON.stringify(params)})`, byValue, fn);
  }

  /**
   * Evaluates a shipped expression (app code, never agent input) in the isolated world of this target.
   * Every DOM read Crossbar makes goes through here or `call`, never the page's own world, where page
   * scripts could hook getters and notice (audit S04).
   */
  inspect<T>(sessionId: string, expression: string): Promise<T> {
    return this.run<T>(sessionId, expression, true, "inspect");
  }

  private async run<T>(sessionId: string, expression: string, byValue: boolean, fn: string): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = this.contexts.get(sessionId) ?? (await this.install(sessionId));
      try {
        const r = await this.cdp.send("Runtime.evaluate", { expression, contextId: ctx, returnByValue: byValue, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) {
          const msg = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
          // A navigation replaced the document: the bundle isn't there any more.
          if (/__crossbar|context/i.test(msg) && attempt === 0) {
            this.contexts.delete(sessionId);
            continue;
          }
          throw new Error(`${fn} failed: ${msg}`);
        }
        if (!byValue) return (r.result.subtype === "null" || !r.result.objectId ? null : r.result.objectId) as T;
        return r.result.value as T;
      } catch (e) {
        // Stale context id after navigation.
        if (attempt === 0 && /context/i.test((e as Error).message)) {
          this.contexts.delete(sessionId);
          continue;
        }
        throw e;
      }
    }
    throw new Error(`${fn} failed after reinstall`);
  }

  forget(sessionId: string): void {
    this.contexts.delete(sessionId);
  }

  extract(sessionId: string, p: ExtractParams = {}): Promise<ExtractResult> {
    return this.call(sessionId, "extract", p);
  }
  collectItems(sessionId: string, p: CollectParams = {}): Promise<CollectedItem[]> {
    return this.call(sessionId, "collectItems", p);
  }
  scrollState(sessionId: string): Promise<ScrollState> {
    return this.call(sessionId, "scrollState");
  }
}
