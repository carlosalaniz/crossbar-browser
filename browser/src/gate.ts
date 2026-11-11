// SPDX-License-Identifier: AGPL-3.0-only
// Network gate (Access Model L5, authoritative for writes).
// Auto-attaches to every target, recursively, with waitForDebuggerOnStart so no target can send a
// request before Fetch is enabled on it. Every request pauses at the Request stage and goes through
// the policy: allow, hold (until released, failed, or the hold times out), or deny.
import type { Protocol } from "devtools-protocol";
import type { CdpConnection } from "./cdp.ts";

export type Verdict = "allow" | "hold" | "deny";

export interface GateRequest {
  requestId: string;
  sessionId: string;
  targetType: string;
  targetUrl: string;
  method: string;
  url: string;
  resourceType: Protocol.Network.ResourceType;
  frameId: string;
  hasPostData: boolean;
  /** Set when this pause is a redirect hop of an earlier request. */
  redirectedRequestId?: string;
}

export type GatePolicy = (r: GateRequest) => Verdict;

export interface HeldRequest {
  request: GateRequest;
  release(): Promise<void>;
  fail(): Promise<void>;
  /** Resolves with how the hold ended. */
  settled: Promise<"released" | "failed" | "timeout">;
}

export interface NetworkGateOptions {
  policy?: GatePolicy;
  /** Held requests fail after this long; the agent retries with the approval id. Default 20 s. */
  holdTimeoutMs?: number;
  onHeld?: (h: HeldRequest) => void;
  onRequest?: (r: GateRequest, v: Verdict) => void;
  /** Bypass service workers for page requests (Network.setBypassServiceWorker). */
  bypassServiceWorker?: boolean;
}

const ATTACH_STEP_TIMEOUT_MS = 3000;
/** Target types whose requests are paused on the parent's Fetch session (measured in the step 1 spike). */
const FETCH_FROM_PARENT = new Set(["worker"]);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

export const DEFAULT_HOLD_TIMEOUT_MS = 20_000;
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Default policy for the spike: reads pass, every other method is held. */
export const holdNonGet: GatePolicy = (r) => (SAFE_METHODS.has(r.method) ? "allow" : "hold");

export interface Attached {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
}

export class NetworkGate {
  readonly attached = new Map<string, Attached>();
  readonly attachErrors: Array<{ type: string; url: string; step: string; error: string }> = [];
  readonly seen: Array<{ request: GateRequest; verdict: Verdict }> = [];
  private readonly held = new Map<string, HeldRequest>();
  private readonly policy: GatePolicy;
  private readonly holdTimeoutMs: number;
  private readonly offs: Array<() => void> = [];

  private readonly cdp: CdpConnection;
  private readonly opts: NetworkGateOptions;

  constructor(cdp: CdpConnection, opts: NetworkGateOptions = {}) {
    this.cdp = cdp;
    this.opts = opts;
    this.policy = opts.policy ?? holdNonGet;
    this.holdTimeoutMs = opts.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    this.offs.push(
      this.cdp.on("Target.attachedToTarget", (p) => void this.onAttached(p)),
      this.cdp.on("Target.detachedFromTarget", (p) => {
        this.attached.delete(p.sessionId);
      }),
      this.cdp.on("Fetch.requestPaused", (p, sessionId) => void this.onPaused(p, sessionId!)),
    );
    // Browser-level auto-attach covers top-level targets: pages, service workers, shared workers.
    await this.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  stop(): void {
    for (const off of this.offs) off();
  }

  heldRequests(): HeldRequest[] {
    return [...this.held.values()];
  }

  private async onAttached(p: Protocol.Target.AttachedToTargetEvent): Promise<void> {
    const { sessionId, targetInfo } = p;
    const t: Attached = { sessionId, targetId: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url };
    this.attached.set(sessionId, t);
    // Every step has a deadline: a CDP call that never answers would leave the target paused forever
    // (seen in the spike: Network.enable on a service worker never returned).
    const step = async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await withTimeout(fn(), ATTACH_STEP_TIMEOUT_MS, name);
        return true;
      } catch (e) {
        this.attachErrors.push({ type: t.type, url: t.url, step: name, error: (e as Error).message });
        return false;
      }
    };
    // Order matters: Fetch first, then recurse into children, then let the target run.
    const fetchOn = await step("Fetch.enable", () => this.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId));
    // Dedicated workers have no Fetch domain; the spike showed their requests pause on the parent's session.
    if (!fetchOn && !FETCH_FROM_PARENT.has(t.type)) {
      // Fail closed: a target we can't gate never runs.
      await step("Target.closeTarget", () => this.cdp.send("Target.closeTarget", { targetId: t.targetId }));
      return;
    }
    await step("Target.setAutoAttach", () => this.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId));
    if (this.opts.bypassServiceWorker && t.type === "page") {
      await step("Network.setBypassServiceWorker", () => this.cdp.send("Network.setBypassServiceWorker", { bypass: true }, sessionId));
    }
    if (p.waitingForDebugger) await step("Runtime.runIfWaitingForDebugger", () => this.cdp.send("Runtime.runIfWaitingForDebugger", undefined, sessionId));
  }

  private async onPaused(p: Protocol.Fetch.RequestPausedEvent, sessionId: string): Promise<void> {
    const t = this.attached.get(sessionId);
    const r: GateRequest = {
      requestId: p.requestId,
      sessionId,
      targetType: t?.type ?? "unknown",
      targetUrl: t?.url ?? "",
      method: p.request.method,
      url: p.request.url,
      resourceType: p.resourceType,
      frameId: p.frameId,
      hasPostData: !!p.request.hasPostData,
      redirectedRequestId: p.redirectedRequestId,
    };
    let verdict: Verdict;
    try {
      verdict = this.policy(r);
    } catch {
      verdict = "deny"; // a policy bug fails closed
    }
    this.seen.push({ request: r, verdict });
    this.opts.onRequest?.(r, verdict);
    const cont = () => this.cdp.send("Fetch.continueRequest", { requestId: r.requestId }, sessionId).catch(() => {});
    const fail = () => this.cdp.send("Fetch.failRequest", { requestId: r.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
    if (verdict === "allow") return void (await cont());
    if (verdict === "deny") return void (await fail());

    const key = `${sessionId}:${r.requestId}`;
    let settle!: (s: "released" | "failed" | "timeout") => void;
    const settled = new Promise<"released" | "failed" | "timeout">((res) => (settle = res));
    let done = false;
    const finish = async (how: "released" | "failed" | "timeout") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.held.delete(key);
      await (how === "released" ? cont() : fail());
      settle(how);
    };
    const timer = setTimeout(() => void finish("timeout"), this.holdTimeoutMs);
    const h: HeldRequest = { request: r, release: () => finish("released"), fail: () => finish("failed"), settled };
    this.held.set(key, h);
    this.opts.onHeld?.(h);
  }
}
