// SPDX-License-Identifier: AGPL-3.0-only
// Fake browser for server tests (AGENTS.md: node --test with a fake browser for server/).
// Fake tabs run the server's real gate policy on simulated requests.
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserPool, Tab, TabPolicy, Profile, PageFacts, NavResult, InputEvent, DeviceKind } from "@crossbar/browser/pool";
import type { GateRequest, HeldRequest, Verdict } from "@crossbar/browser/gate";
import type { ExtractResult } from "@crossbar/browser/page-scripts/index";
import type { ScrollResult } from "@crossbar/browser/page-scripts/scroll";
import { buildServices } from "../src/services.ts";
import { createApp, type HumanAuth, type HumanSession } from "../src/http.ts";

export interface FakePage {
  title?: string;
  content?: string;
  facts?: Partial<PageFacts>;
  /** A redirect hop the navigation takes. */
  redirectTo?: string;
  /** Request the page sends when this ref is clicked. */
  onClick?: Record<string, Partial<GateRequest>>;
}

let reqSeq = 0;

export class FakeTab implements Tab {
  readonly id = `tab-${Math.random().toString(36).slice(2)}`;
  readonly mainFrameId = `frame-${this.id}`;
  policy?: TabPolicy;
  url = "about:blank";
  history: string[] = [];
  device: DeviceKind = "desktop";
  typed: Array<{ ref: string; text: string }> = [];
  inputs: InputEvent[] = [];
  readonly results: Array<{ req: GateRequest; verdict: Verdict; rule?: string; held?: HeldRequest; outcome?: string }> = [];
  readonly profile: Profile;
  private readonly pages: Map<string, FakePage>;
  constructor(profile: Profile, pages: Map<string, FakePage>) {
    this.profile = profile;
    this.pages = pages;
  }
  setPolicy(p: TabPolicy) {
    this.policy = p;
  }

  /** Run a request through the policy like the gate would. */
  simulate(partial: Partial<GateRequest>) {
    const req: GateRequest = {
      requestId: `r${++reqSeq}`,
      sessionId: "s1",
      rootSessionId: "s1",
      targetType: "page",
      targetUrl: this.url,
      method: "GET",
      url: this.url,
      resourceType: "Fetch",
      frameId: this.mainFrameId,
      hasPostData: false,
      ...partial,
    };
    const d = this.policy!.decide(req);
    const verdict = typeof d === "string" ? d : d.verdict;
    const rule = typeof d === "string" ? undefined : d.rule;
    const entry: (typeof this.results)[number] = { req, verdict, rule };
    this.results.push(entry);
    this.policy!.onRequest?.(req, verdict, rule);
    if (verdict === "hold") {
      let settle!: (s: "released" | "failed" | "timeout") => void;
      const settled = new Promise<"released" | "failed" | "timeout">((r) => (settle = r));
      const h: HeldRequest = {
        request: req,
        rule,
        settled,
        release: async () => {
          entry.outcome = "released";
          settle("released");
        },
        fail: async () => {
          entry.outcome = "failed";
          settle("failed");
        },
      };
      entry.held = h;
      this.policy!.onHeld?.(h);
    }
    return entry;
  }

  async navigate(url: string): Promise<NavResult> {
    const e = this.simulate({ url, method: "GET", resourceType: "Document" });
    if (e.verdict !== "allow") return { url: this.url, title: "", status: null, error: `net::ERR_BLOCKED_BY_CLIENT (${e.rule})` } as NavResult;
    const hop = this.pages.get(url)?.redirectTo;
    if (hop) {
      const h = this.simulate({ url: hop, method: "GET", resourceType: "Document", redirectedRequestId: e.req.requestId });
      if (h.verdict !== "allow") return { url: this.url, title: "", status: null, error: "net::ERR_BLOCKED_BY_CLIENT" } as NavResult;
      this.history.push(this.url);
      this.url = hop;
      return { url: hop, title: this.pages.get(hop)?.title ?? "", status: 200 };
    }
    this.history.push(this.url);
    this.url = url;
    return { url, title: this.pages.get(url)?.title ?? "", status: 200 };
  }
  async back() {
    this.url = this.history.pop() ?? this.url;
    return { url: this.url, title: "", status: 200 };
  }
  async currentUrl() {
    return this.url;
  }
  async extract(): Promise<ExtractResult> {
    const p = this.pages.get(this.url);
    return { url: this.url, title: p?.title ?? "", content: p?.content ?? "", wordCount: 0, usedFallback: false, links: [] };
  }
  async click(ref: string) {
    const r = this.pages.get(this.url)?.onClick?.[ref];
    if (r) setTimeout(() => this.simulate(r), 10);
  }
  async type(ref: string, text: string) {
    this.typed.push({ ref, text });
  }
  async scroll(): Promise<ScrollResult> {
    return { items: [{ key: "a", ref: "e1", text: this.pages.get(this.url)?.content ?? "" }], stoppedBecause: "end", scrolls: 1, tokens: 1 };
  }
  async facts(): Promise<PageFacts> {
    const p = this.pages.get(this.url);
    return { url: this.url, title: p?.title ?? "", status: 200, headers: {}, frameUrls: [], hasPasswordField: false, passwordFieldOrigins: [], hasOtpField: false, captchaContainers: [], formCaptchas: [], textLength: 5000, textSample: p?.content ?? "", ...p?.facts };
  }
  async domTokens() {
    return { classes: [], ids: [], hrefs: [] };
  }
  async applyCosmetics() {}
  async emulate(d: DeviceKind) {
    this.device = d;
  }
  async startScreencast(onFrame: (f: string, meta: { width: number; height: number }) => void) {
    onFrame("ZmFrZQ==", { width: 390, height: 844 });
  }
  async stopScreencast() {}
  async focusKind() {
    return "none" as const;
  }
  async input(ev: InputEvent) {
    this.inputs.push(ev);
  }
  async screenshot() {
    return "ZmFrZQ==";
  }
  async findByText() {
    return null;
  }
  allowPopups() {}
  onPopup() {
    return () => {};
  }
  onClose() {
    return () => {};
  }
  async close() {}
}

export class FakePool implements BrowserPool {
  readonly pages = new Map<string, FakePage>();
  readonly tabs: FakeTab[] = [];
  async openTab(_userId: string, profile: Profile): Promise<Tab> {
    const t = new FakeTab(profile, this.pages);
    this.tabs.push(t);
    return t;
  }
  async closeUser() {}
  async close() {}
}

/** Test login: the header x-test-user names the user. Real login is auth/ (step 4). */
export function fakeAuth(users: Record<string, Partial<HumanSession>>): HumanAuth {
  return {
    session(req: http.IncomingMessage) {
      const u = req.headers["x-test-user"];
      if (typeof u !== "string" || !users[u]) return null;
      return { userId: u, username: u, isOwner: false, twoFactor: false, fresh: false, ...users[u] };
    },
    handlers: {},
  };
}

export async function startTestApp(opts: { pool?: BrowserPool; users?: Record<string, Partial<HumanSession>>; settleMs?: number; auth?: HumanAuth; authFactory?: (db: ReturnType<typeof buildServices>["db"]) => HumanAuth; extraOrigins?: string[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "crossbar-test-"));
  const pool = opts.pool ?? new FakePool();
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const services = buildServices({
    dataDir,
    pool,
    appOrigin: "http://crossbar.test",
    pace: { minIntervalMs: 1000, hourlyCap: 1000 },
    settleMs: opts.settleMs ?? 200,
    fetchImpl: (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response("ok");
    }) as unknown as typeof fetch,
  });
  for (const u of Object.keys(opts.users ?? { alice: {} })) {
    services.db.prepare("INSERT INTO users (id, username, password_hash, is_owner, created_at) VALUES (?, ?, 'x', 0, ?)").run(u, u, new Date().toISOString());
  }
  // Tests don't wait for human pacing.
  services.pacer.check = () => ({ waitMs: 0 });
  const auth = opts.authFactory?.(services.db) ?? opts.auth ?? fakeAuth(opts.users ?? { alice: {} });
  const app = createApp({ services, tokens: services.tokens, auth, version: "test", appOrigin: "http://crossbar.test", extraOrigins: opts.extraOrigins });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function api(method: string, path: string, opts2: { user?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", ...opts2.headers };
    if (opts2.user) {
      headers["x-test-user"] = opts2.user;
      headers["x-crossbar"] = "1";
    }
    if (opts2.token) headers.authorization = `Bearer ${opts2.token}`;
    const r = await fetch(base + path, { method, headers, body: opts2.body === undefined ? undefined : JSON.stringify(opts2.body) });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, json: json as Record<string, unknown> & Array<Record<string, unknown>>, headers: r.headers };
  }

  /** A minimal MCP client. */
  async function mcpClient(token: string) {
    let sid = "";
    let id = 0;
    const rpc = async (method: string, params?: unknown) => {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
      if (sid) headers["mcp-session-id"] = sid;
      const r = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      if (r.headers.get("mcp-session-id")) sid = r.headers.get("mcp-session-id")!;
      return (await r.json()) as { result?: Record<string, unknown>; error?: { message: string } };
    };
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    return {
      rpc,
      get sessionId() {
        return sid;
      },
      async call(name: string, args: unknown = {}) {
        const r = await rpc("tools/call", { name, arguments: args });
        if (r.error) throw new Error(r.error.message);
        return r.result!.structuredContent as Record<string, unknown> & { state: string; data?: Record<string, unknown>; ticket?: { id: string }; reason?: string };
      },
    };
  }

  return {
    services,
    app,
    auth,
    pool,
    base,
    api,
    mcpClient,
    sent,
    token: (user: string, kind: "read" | "act" = "read", agentName = "test-agent") => services.tokens.create(user, agentName, kind).secret,
    async close() {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      for (const a of app.registry.sessions.values()) await a.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
