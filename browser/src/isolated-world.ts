// SPDX-License-Identifier: AGPL-3.0-only
// Page scripts run in a CDP isolated world (ADR 0005): same DOM, separate JS globals,
// so the page can't see or tamper with Crossbar's code. Only code shipped with the app runs here.
import type { CdpConnection } from "./cdp.ts";

export const WORLD_NAME = "crossbar";

export async function createIsolatedWorld(cdp: CdpConnection, sessionId: string): Promise<number> {
  const { frameTree } = await cdp.send("Page.getFrameTree", undefined, sessionId);
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD_NAME, grantUniveralAccess: false }, sessionId);
  return executionContextId;
}

/** Runs a shipped page script. `script` must be app code; agents can set parameters only. */
export async function runPageScript<T>(cdp: CdpConnection, sessionId: string, contextId: number, script: string, params: unknown): Promise<T> {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression: `(${script})(${JSON.stringify(params)})`, contextId, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.text}`);
  return r.result.value as T;
}
