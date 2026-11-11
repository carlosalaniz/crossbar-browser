// SPDX-License-Identifier: AGPL-3.0-only
// The test site: one node:http server answering for several `.test` hosts (picked by the Host header).
import http from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { RequestLog } from "./log.ts";
import { Gate, overridesFromEnv, overridesFromQuery, resolveConfig, PROVIDERS, type GateConfig, type GateOverrides, type Provider } from "./gate.ts";
import { FakeTokens, PROVIDER_INFO, fakeFrameHtml, interstitialHtml, isLiveCapable, liveKeys, verifyLive, widgetHtml } from "./captcha.ts";
import { Accounts } from "./accounts.ts";
import { appendCookie, hostUrl, newId, parseBody, parseCookies, parseHost, send, type Ctx, type Host, type Session } from "./context.ts";
import { esc, page } from "./html.ts";
import { registerIndex } from "./routes/index-page.ts";
import { registerAccounts } from "./routes/accounts.ts";
import { registerWrites } from "./routes/writes.ts";
import { registerTaint } from "./routes/taint.ts";
import { registerSites } from "./routes/sites.ts";
import { registerHarness } from "./routes/harness.ts";
import { registerBrowserPages } from "./routes/browser-pages.ts";

export type Handler = (ctx: Ctx, app: App, m: RegExpExecArray) => void | Promise<void>;
interface Route {
  host: Host | "*";
  method: string;
  path: RegExp;
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  add(host: Host | "*", method: string, path: string | RegExp, handler: Handler): this {
    const re = typeof path === "string" ? new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) : path;
    this.routes.push({ host, method: method.toUpperCase(), path: re, handler });
    return this;
  }
  match(ctx: Ctx): { route: Route; m: RegExpExecArray } | { methodNotAllowed: true } | null {
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.host !== "*" && r.host !== ctx.host) continue;
      const m = r.path.exec(ctx.url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method === "*" || r.method === ctx.method || (r.method === "GET" && ctx.method === "HEAD")) return { route: r, m };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export interface TestsiteOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides TESTSITE_CAPTCHA. */
  captcha?: "offline" | "live";
  rng?: () => number;
  now?: () => number;
  /** Extra route modules (Stripe registers itself only when its keys are present). */
  modules?: Array<(r: Router, app: App) => void>;
}

export interface Comment {
  id: number;
  author: string;
  text: string;
  replies: string[];
}

export class App {
  readonly env: NodeJS.ProcessEnv;
  readonly live: boolean;
  readonly log = new RequestLog();
  readonly gate: Gate;
  readonly tokens: FakeTokens;
  readonly accounts = new Accounts();
  readonly sessions = new Map<string, Session & { passes: Set<string>; pendingCaptcha: Map<string, Provider> }>();
  readonly envGate: GateOverrides;
  adminGate: GateOverrides = {};
  readonly key = randomBytes(32);
  readonly now: () => number;
  readonly router = new Router();
  /** Per-host request times for the pacing scenario. */
  readonly rate = new Map<string, number[]>();
  comments: Comment[] = [];
  /** Feature flags shown on the index (Stripe adds itself). */
  readonly features = new Map<string, { enabled: boolean; why?: string }>();
  graphqlStore = { posts: [] as Array<{ id: number; title: string; votes: number }> };

  constructor(opts: TestsiteOptions = {}) {
    this.env = opts.env ?? process.env;
    this.live = (opts.captcha ?? this.env.TESTSITE_CAPTCHA ?? "offline") === "live";
    this.now = opts.now ?? Date.now;
    this.gate = new Gate(opts.rng);
    this.tokens = new FakeTokens(300_000, this.now);
    this.envGate = overridesFromEnv(this.env);
    resolveConfig({ env: this.envGate }); // fail fast on a bad env value
    this.features.set("live-captcha", { enabled: this.live, why: "set TESTSITE_CAPTCHA=live (needs internet)" });
    this.features.set("stripe", { enabled: false, why: "STRIPE_PUBLISHABLE_KEY and STRIPE_SECRET_KEY are not set in testsite/.env" });
    this.resetContent();
  }

  resetContent(): void {
    this.comments = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      author: ["alice", "bob", "carol", "dan"][i % 4]!,
      text: `Fixture comment ${i + 1}. ${i % 3 === 0 ? "A longer thought that gets truncated until you expand it. ".repeat(4) : "Short."}`,
      replies: i % 5 === 0 ? [`Reply to ${i + 1}`, `Another reply to ${i + 1}`] : [],
    }));
    this.graphqlStore.posts = [1, 2, 3].map((id) => ({ id, title: `GraphQL fixture post ${id}`, votes: 0 }));
  }

  /** Clears the request log, gate counters, fake tokens, sessions and content. */
  resetAll(): void {
    this.log.reset();
    this.gate.reset();
    this.tokens.reset();
    this.sessions.clear();
    this.rate.clear();
    this.adminGate = {};
    this.resetContent();
  }

  gateConfig(query: URLSearchParams): GateConfig {
    return resolveConfig({ env: this.envGate, admin: this.adminGate, query: overridesFromQuery(query) });
  }

  // --- clearance cookie: `<expiryMs>.<hmac(host|expiry)>` ------------------------------------
  clearanceValue(host: string, minutes: number): string {
    const exp = String(this.now() + minutes * 60_000);
    return `${exp}.${createHmac("sha256", this.key).update(`${host}|${exp}`).digest("base64url")}`;
  }
  clearanceValid(host: string, v: string | undefined): boolean {
    if (!v) return false;
    const [exp, mac] = v.split(".");
    if (!exp || !mac || Number(exp) < this.now()) return false;
    const want = createHmac("sha256", this.key).update(`${host}|${exp}`).digest();
    const got = Buffer.from(mac, "base64url");
    return got.length === want.length && timingSafeEqual(got, want);
  }
}

// ----------------------------------------------------------------------------------------------
// Gate helpers used by protected pages

export type GateResult = { handled: true } | { handled: false; widget?: Provider; cfg: GateConfig };

/**
 * Runs the challenge gate for this request. Sends the challenge itself for `interstitial` and
 * `status`; for `widget` it returns the provider so the page can embed the widget in its form.
 */
export function runGate(ctx: Ctx, app: App): GateResult {
  let cfg: GateConfig;
  try {
    cfg = app.gateConfig(ctx.url.searchParams);
  } catch (e) {
    send(ctx, 400, page("Bad gate parameter", `<p>${esc((e as Error).message)}</p>`));
    return { handled: true };
  }
  const s = app.sessions.get(ctx.session.id)!;
  if (s.passes.delete(ctx.url.pathname)) {
    ctx.res.setHeader("x-testsite-gate", "pass; reason=one-time-pass");
    return { handled: false, cfg };
  }
  const d = app.gate.decide(cfg, { session: ctx.session.id, ip: ctx.ip, path: ctx.url.pathname }, app.clearanceValid(ctx.host, ctx.cookies.ts_clearance));
  ctx.res.setHeader("x-testsite-gate", `${d.challenge ? "challenge" : "pass"}; count=${d.count}; reason=${d.reason}; mode=${ctx.url.searchParams.get("mode") ?? "(config)"}`);
  if (!d.challenge) return { handled: false, cfg };
  const returnTo = ctx.url.pathname + ctx.url.search;
  if (cfg.style === "status") {
    send(ctx, cfg.status, "", cfg.status === 429 ? { "retry-after": "30", "content-type": "text/plain" } : { "content-type": "text/plain" });
    return { handled: true };
  }
  if (cfg.style === "interstitial") {
    const info = PROVIDER_INFO[cfg.provider];
    const sitekey = app.live && isLiveCapable(cfg.provider) ? liveKeys(cfg.provider, ctx.url.searchParams).sitekey : undefined;
    const status = cfg.status === 429 ? 403 : cfg.status;
    send(ctx, status, interstitialHtml({ provider: cfg.provider, live: app.live, sitekey, frameUrl: fakeFrameUrl(ctx, cfg.provider), action: "/__captcha/clear", returnTo, host: ctx.host }), info.interstitialHeaders);
    return { handled: true };
  }
  s.pendingCaptcha.set(ctx.url.pathname, cfg.provider);
  return { handled: false, widget: cfg.provider, cfg };
}

export function fakeFrameUrl(ctx: Ctx, provider: Provider): string {
  return hostUrl(ctx, "captcha.test", PROVIDER_INFO[provider].framePath);
}

export function widgetFor(ctx: Ctx, app: App, provider: Provider): string {
  const sitekey = app.live && isLiveCapable(provider) ? liveKeys(provider, ctx.url.searchParams).sitekey : undefined;
  return widgetHtml({ provider, live: app.live, sitekey, frameUrl: fakeFrameUrl(ctx, provider) });
}

/** Verifies the widget token a form posted. Offline: the fake token store. Live: the provider's siteverify. */
export async function verifyFormCaptcha(ctx: Ctx, app: App, provider: Provider): Promise<boolean> {
  const token = ctx.body[PROVIDER_INFO[provider].responseField];
  if (app.live && isLiveCapable(provider)) {
    const secret = liveKeys(provider, new URLSearchParams(ctx.body.return_to?.split("?")[1] ?? ctx.url.search)).secret;
    return (await verifyLive(provider, secret, token)).ok;
  }
  return app.tokens.verify(provider, token).ok;
}

/** For form pages: true when the GET that rendered this form embedded a widget that hasn't been satisfied. */
export async function formCaptchaOk(ctx: Ctx, app: App, path: string): Promise<boolean> {
  const s = app.sessions.get(ctx.session.id)!;
  const p = s.pendingCaptcha.get(path);
  if (!p) return true;
  if (!(await verifyFormCaptcha(ctx, app, p))) return false;
  s.pendingCaptcha.delete(path);
  return true;
}

// ----------------------------------------------------------------------------------------------
// Server

/** Raw hosts allowed to reach /__testsite/ (the harness). The `.test` names a browser uses are not. */
function isHarnessHost(raw: string | undefined): boolean {
  const h = (raw ?? "").toLowerCase().replace(/:\d+$/, "");
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "testsite" || h.endsWith(".localhost");
}

export function createTestsite(opts: TestsiteOptions = {}): { server: http.Server; app: App } {
  const app = new App(opts);
  registerCore(app.router);
  for (const mod of opts.modules ?? []) mod(app.router, app);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 1_000_000) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(c as Buffer);
    }
    const rawBody = Buffer.concat(chunks);
    const ph = parseHost(req.headers.host);
    const url = new URL(req.url ?? "/", `http://${ph.host}`);
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies.ts_sid;
    if (!sid || !app.sessions.has(sid)) {
      sid = newId();
      app.sessions.set(sid, { id: sid, createdAt: app.now(), passes: new Set(), pendingCaptcha: new Map() });
      res.setHeader("set-cookie", [`ts_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`]);
    }
    const ctx: Ctx = {
      req,
      res,
      url,
      method: (req.method ?? "GET").toUpperCase(),
      host: ph.host,
      via: { suffix: ph.suffix, port: ph.port, scheme: "http" },
      cookies,
      body: parseBody(rawBody, req.headers["content-type"]),
      rawBody,
      ip: req.socket.remoteAddress ?? "",
      session: app.sessions.get(sid)!,
    };
    const isHarness = url.pathname === "/__testsite" || url.pathname.startsWith("/__testsite/");
    if (!isHarness) {
      app.log.add({
        host: ctx.host,
        method: ctx.method,
        path: url.pathname,
        queryKeys: [...new Set(url.searchParams.keys())],
        bodyKeys: Object.keys(ctx.body),
        bodyLength: rawBody.length,
        cookieKeys: Object.keys(cookies),
        session: cookies.ts_sid ?? null,
        ip: ctx.ip,
      });
    } else if (!isHarnessHost(req.headers.host)) {
      send(ctx, 404, page("Not found", "<p>The harness is only served on localhost, not on the .test hosts a browser under test uses.</p>"));
      return;
    }
    const hit = app.router.match(ctx);
    if (!hit) return send(ctx, 404, page("Not found", `<p>No page at <code>${esc(url.pathname)}</code> on ${esc(ctx.host)}.</p>`, { host: ctx.host }));
    if ("methodNotAllowed" in hit) return send(ctx, 405, page("Method not allowed", `<p>${esc(ctx.method)} is not allowed here.</p>`, { host: ctx.host }));
    await hit.route.handler(ctx, app, hit.m);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error("testsite error:", e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    });
  });

  // Upgraded (WebSocket) sockets aren't tracked by server.close(); destroy them so close() returns.
  const upgraded = new Set<Duplex>();
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const s of upgraded) s.destroy();
    return close(cb);
  }) as typeof server.close;

  // WebSocket endpoint for the background-requests scenario. Minimal RFC 6455 handshake, one text frame.
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex) => {
    const ph = parseHost(req.headers.host);
    const url = new URL(req.url ?? "/", `http://${ph.host}`);
    app.log.add({
      host: ph.host,
      method: req.method ?? "GET",
      path: url.pathname,
      queryKeys: [...new Set(url.searchParams.keys())],
      bodyKeys: [],
      bodyLength: 0,
      cookieKeys: Object.keys(parseCookies(req.headers.cookie)),
      session: parseCookies(req.headers.cookie).ts_sid ?? null,
      ip: req.socket.remoteAddress ?? "",
      upgrade: String(req.headers.upgrade ?? ""),
    });
    const key = req.headers["sec-websocket-key"];
    if (url.pathname !== "/ws" || typeof key !== "string") {
      socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const msg = Buffer.from("hello from site-a.test (if you can read this, the WebSocket was not blocked)");
    socket.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
    socket.on("error", () => {});
    socket.on("data", () => {}); // Ignore client frames; tests only care that the handshake did or didn't happen.
    socket.on("end", () => socket.end()); // upgraded sockets are half-open; close when the client does
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
  });

  return { server, app };
}

// ----------------------------------------------------------------------------------------------
// Core routes: harness, captcha frames, clearance, gated content.


function registerCore(r: Router): void {
  registerHarness(r);
  registerIndex(r);

  // Fake captcha frames on captcha.test. Any path that embeds a provider's URL shape serves that provider's frame.
  for (const p of PROVIDERS) {
    const base = PROVIDER_INFO[p].framePath.split(/[?#]/)[0]!;
    r.add("captcha.test", "GET", base, (ctx) => send(ctx, 200, fakeFrameHtml(p)));
  }
  r.add("captcha.test", "GET", "/", (ctx) => send(ctx, 200, page("captcha.test", "<p>Serves the fake captcha frames. Nothing here solves anything.</p>", { host: ctx.host })));
  r.add("captcha.test", "POST", "/__captcha/issue", (ctx, app) => {
    const p = ctx.body.provider as Provider;
    if (!(PROVIDERS as readonly string[]).includes(p)) return send(ctx, 400, "{}", { "content-type": "application/json" });
    send(ctx, 200, JSON.stringify({ token: app.tokens.issue(p) }), { "content-type": "application/json" });
  });
  // Mirrors a provider's siteverify: POST response=<token>&provider=<p>. Single use.
  r.add("captcha.test", "POST", "/__captcha/siteverify", (ctx, app) => {
    const p = ctx.body.provider as Provider;
    const v = (PROVIDERS as readonly string[]).includes(p) ? app.tokens.verify(p, ctx.body.response) : ({ ok: false, error: "invalid-input-response" } as const);
    send(ctx, 200, JSON.stringify(v.ok ? { success: true } : { success: false, "error-codes": [v.error] }), { "content-type": "application/json" });
  });

  // Interstitial and verify-page form target, on every host.
  r.add("*", "POST", "/__captcha/clear", async (ctx, app) => {
    const p = ctx.body.provider as Provider;
    const returnTo = ctx.body.return_to ?? "/";
    const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
    if (!(PROVIDERS as readonly string[]).includes(p) || !(await verifyFormCaptcha(ctx, app, p))) {
      return send(ctx, 403, page("Verification failed", `<p>The challenge token was missing, invalid or already used.</p><p><a href="${esc(safe)}">Try again</a></p>`, { host: ctx.host }));
    }
    let cfg: GateConfig;
    try {
      cfg = app.gateConfig(new URL(safe, "http://x").searchParams);
    } catch {
      cfg = app.gateConfig(new URLSearchParams());
    }
    if (cfg.clearance) appendCookie(ctx, `ts_clearance=${app.clearanceValue(ctx.host, cfg.clearanceMinutes)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${cfg.clearanceMinutes * 60}`);
    else app.sessions.get(ctx.session.id)!.passes.add(new URL(safe, "http://x").pathname);
    send(ctx, 303, "", { location: safe });
  });

  // Gated content: the plainest protected page. Any gate parameter works in its query string.
  r.add("*", "GET", "/gated/article", (ctx, app) => {
    const g = runGate(ctx, app);
    if (g.handled) return;
    if (g.widget) {
      return send(ctx, 200, page("Verify to continue", `<p>Complete the check to read this article.</p>
<form method="POST" action="/__captcha/clear" data-captcha><input type="hidden" name="provider" value="${g.widget}"><input type="hidden" name="return_to" value="${esc(ctx.url.pathname + ctx.url.search)}">
${widgetFor(ctx, app, g.widget)}<button>Continue</button></form>`, { host: ctx.host }));
    }
    send(ctx, 200, page("Gated article", `<article><h1>The protected article</h1>${"<p>Readable content behind the challenge gate. Fixture text, nothing real.</p>".repeat(6)}</article>
<p class="note">Gate: ${esc(String(ctx.res.getHeader("x-testsite-gate")))}</p>`, { host: ctx.host }));
  });

  registerAccounts(r);
  registerWrites(r);
  registerTaint(r);
  registerSites(r);
  registerBrowserPages(r);
}
