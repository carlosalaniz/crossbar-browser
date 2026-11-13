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
  /** Request body when Chrome includes it (small bodies). Used for approval facts and data shapes. */
  postData?: string;
  /** Session of the top-level page this request belongs to (iframes and dedicated workers roll up to it). */
  rootSessionId: string;
  /** Set when this pause is a redirect hop of an earlier request. */
  redirectedRequestId?: string;
}

export interface Decision {
  verdict: Verdict;
  /** Which rule decided, for the activity log (e.g. "read_list", "blocked_ad", "taint"). */
  rule?: string;
  /** With deny: answer with this stand-in instead of failing the request (an ad blocker's redirect=). */
  respond?: { contentType: string; bodyBase64: string };
  /**
   * With allow: pause again when the response arrives and ask `responsePolicy` (an ad blocker's header=
   * rules, ADR 0036). The page gets nothing until it answers.
   */
  inspectResponse?: boolean;
}
export type GatePolicy = (r: GateRequest) => Verdict | Decision;

export interface HeldRequest {
  request: GateRequest;
  /** The rule that decided to hold it (the action class, for the server's policy). */
  rule?: string;
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
  onRequest?: (r: GateRequest, v: Verdict, rule?: string) => void;
  onAttach?: (t: Attached) => void;
  /** A server or proxy asked for HTTP sign-in; the gate cancelled it (no one is there to answer Chrome's box). */
  onAuth?: (rootSessionId: string, url: string) => void;
  /** Decides a response paused because its request's decision set inspectResponse. Allow when unset or on error. */
  responsePolicy?: (r: GateRequest, status: number, headers: Array<{ name: string; value: string }>) => Verdict | Decision;
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
  parentSessionId?: string;
  openerId?: string;
  targetId: string;
  type: string;
  url: string;
}

export class NetworkGate {
  readonly attached = new Map<string, Attached>();
  readonly attachErrors: Array<{ type: string; url: string; step: string; error: string }> = [];
  readonly seen: Array<{ request: GateRequest; verdict: Verdict; rule?: string }> = [];
  private readonly held = new Map<string, HeldRequest>();
  /** Requests whose response will pause for responsePolicy, by session and request id. */
  private readonly inspecting = new Map<string, GateRequest>();
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
      this.cdp.on("Target.attachedToTarget", (p, parent) => void this.onAttached(p, parent)),
      this.cdp.on("Target.detachedFromTarget", (p) => {
        this.attached.delete(p.sessionId);
      }),
      this.cdp.on("Fetch.requestPaused", (p, sessionId) => void this.onPaused(p, sessionId!)),
      // HTTP sign-in (401/407): Chrome's own login box would wait for a person forever. Cancel it; the page
      // gets the site's error page and the agent is told.
      this.cdp.on("Fetch.authRequired", (p, sessionId) => {
        void this.cdp.send("Fetch.continueWithAuth", { requestId: p.requestId, authChallengeResponse: { response: "CancelAuth" } }, sessionId).catch(() => {});
        this.opts.onAuth?.(this.rootOf(sessionId!), p.request.url);
      }),
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

  /** The top-level page session above this one (itself if it is a page or has no parent). */
  rootOf(sessionId: string): string {
    let cur = sessionId;
    for (let i = 0; i < 20; i++) {
      const a = this.attached.get(cur);
      if (!a?.parentSessionId) return cur;
      cur = a.parentSessionId;
    }
    return cur;
  }

  private async onAttached(p: Protocol.Target.AttachedToTargetEvent, parentSessionId?: string): Promise<void> {
    const { sessionId, targetInfo } = p;
    const t: Attached = { sessionId, parentSessionId, openerId: targetInfo.openerId, targetId: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url };
    this.attached.set(sessionId, t);
    this.opts.onAttach?.(t);
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
    const fetchOn = await step("Fetch.enable", () => this.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }], handleAuthRequests: true }, sessionId));
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
    // Response stage: only requests whose decision asked for it (Fetch patterns are request-stage only).
    if (p.responseStatusCode !== undefined || p.responseErrorReason !== undefined) return this.onResponse(p, sessionId);
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
      postData: p.request.postData ?? p.request.postDataEntries?.map((e) => (e.bytes ? Buffer.from(e.bytes, "base64").toString("utf8") : "")).join(""),
      rootSessionId: this.rootOf(sessionId),
      redirectedRequestId: p.redirectedRequestId,
    };
    let verdict: Verdict;
    let rule: string | undefined;
    let respond: Decision["respond"];
    let inspect = false;
    try {
      const d = this.policy(r);
      if (typeof d === "string") verdict = d;
      else {
        ({ verdict, rule, respond } = d);
        inspect = !!d.inspectResponse;
      }
    } catch {
      verdict = "deny"; // a policy bug fails closed
      rule = "policy_error";
    }
    this.seen.push({ request: r, verdict, rule });
    if (this.seen.length > 5000) this.seen.splice(0, 1000);
    this.opts.onRequest?.(r, verdict, rule);
    const cont = () => this.cdp.send("Fetch.continueRequest", { requestId: r.requestId }, sessionId).catch(() => {});
    const fail = () => this.cdp.send("Fetch.failRequest", { requestId: r.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
    if (verdict === "allow" && inspect && this.opts.responsePolicy) {
      const key = `${sessionId}:${r.requestId}`;
      this.inspecting.set(key, r);
      // A request that never reaches its response (cancelled, redirected) mustn't stay in the map.
      setTimeout(() => this.inspecting.delete(key), 120_000).unref?.();
      return void (await this.cdp.send("Fetch.continueRequest", { requestId: r.requestId, interceptResponse: true }, sessionId).catch(() => this.inspecting.delete(key)));
    }
    if (verdict === "allow") return void (await cont());
    if (verdict === "deny" && respond) {
      await this.cdp
        .send("Fetch.fulfillRequest", { requestId: r.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: respond.contentType }, { name: "Access-Control-Allow-Origin", value: "*" }, { name: "Cache-Control", value: "no-store" }], body: respond.bodyBase64 }, sessionId)
        .catch(() => fail());
      return;
    }
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
    const h: HeldRequest = { request: r, rule, release: () => finish("released"), fail: () => finish("failed"), settled };
    this.held.set(key, h);
    this.opts.onHeld?.(h);
  }

  private async onResponse(p: Protocol.Fetch.RequestPausedEvent, sessionId: string): Promise<void> {
    const key = `${sessionId}:${p.requestId}`;
    const r = this.inspecting.get(key);
    this.inspecting.delete(key);
    let verdict: Verdict = "allow";
    let rule: string | undefined;
    if (r && p.responseStatusCode !== undefined && this.opts.responsePolicy) {
      try {
        const d = this.opts.responsePolicy(r, p.responseStatusCode, p.responseHeaders ?? []);
        if (typeof d === "string") verdict = d;
        else ({ verdict, rule } = d);
      } catch {
        verdict = "allow"; // only ad blocking asks here: a bug in it must not break pages
      }
    }
    // Only allow or deny: a response is never held for a person.
    if (verdict === "allow" || verdict === "hold") return void (await this.cdp.send("Fetch.continueResponse", { requestId: p.requestId }, sessionId).catch(() => {}));
    if (r) this.opts.onRequest?.(r, verdict, rule);
    await this.cdp.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
  }
}
