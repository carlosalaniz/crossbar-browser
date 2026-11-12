// SPDX-License-Identifier: AGPL-3.0-only
// The pool and tab interface: the only way the rest of Crossbar reaches a browser (AGENTS.md rule 10).
// One Chromium per (user, profile). One gate per Chromium; requests are routed to the tab they belong to.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { CdpConnection } from "./cdp.ts";
import { NetworkGate, type Decision, type GateRequest, type HeldRequest, type Verdict, type Attached } from "./gate.ts";
import { launchChrome, type LaunchOptions } from "./launch.ts";
import { PageScripts, type ExtractParams, type ExtractResult } from "./page-scripts/index.ts";
import { scrollAndExtract, type ScrollOptions, type ScrollResult } from "./page-scripts/scroll.ts";
import { typeInto, SIGN_IN_PROVIDERS } from "./input-guard.ts";

export type Profile = "anon" | "personal";
export type DeviceKind = "desktop" | "mobile";

export interface TabPolicy {
  decide(r: GateRequest): Verdict | Decision;
  onHeld?(h: HeldRequest): void;
  onRequest?(r: GateRequest, verdict: Verdict, rule?: string): void;
}

/** Container elements captcha widgets render into (present even before the widget's iframe loads). */
export const CAPTCHA_CONTAINERS = [".cf-turnstile", "[data-sitekey].cf-turnstile", ".g-recaptcha:not([data-size=invisible])", "#g-recaptcha:not([data-size=invisible])", ".h-captcha:not([data-size=invisible])", "#FunCaptcha", "[data-pkey]", "#px-captcha", "[id^=px-captcha]", ".geetest_holder", "#captcha-container", "[class*=datadome]", "#ddv1-captcha-container"];

export interface PageFacts {
  url: string;
  title: string;
  status: number | null;
  headers: Record<string, string>;
  frameUrls: string[];
  hasPasswordField: boolean;
  passwordFieldOrigins: string[];
  hasOtpField: boolean;
  captchaContainers: string[];
  textLength: number;
  textSample: string;
}

export interface NavResult {
  url: string;
  title: string;
  status: number | null;
}

/** CSS-pixel size of the page the frame shows, so taps can be mapped back. */
export interface FrameMeta {
  width: number;
  height: number;
}

export interface InputEvent {
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel" | "keyDown" | "keyUp" | "char" | "insertText";
  x?: number;
  y?: number;
  deltaY?: number;
  button?: "left" | "right" | "none";
  key?: string;
  code?: string;
  text?: string;
}

export interface Tab {
  readonly id: string;
  readonly profile: Profile;
  /** Chrome's main frame id for this tab (equals its target id). */
  readonly mainFrameId: string;
  setPolicy(p: TabPolicy): void;
  navigate(url: string): Promise<NavResult>;
  back(): Promise<NavResult>;
  currentUrl(): Promise<string>;
  extract(p?: ExtractParams): Promise<ExtractResult>;
  /** Clicks the element; returns what was under the click (for approval cards). */
  click(ref: string): Promise<{ tag: string; text: string } | void>;
  type(ref: string, text: string, submit: boolean): Promise<void>;
  scroll(opts: ScrollOptions): Promise<ScrollResult>;
  facts(): Promise<PageFacts>;
  domTokens(): Promise<{ classes: string[]; ids: string[]; hrefs: string[] }>;
  applyCosmetics(css: string): Promise<void>;
  emulate(device: DeviceKind): Promise<void>;
  startScreencast(onFrame: (jpegBase64: string, meta: FrameMeta) => void, opts?: { maxWidth?: number; maxHeight?: number; fps?: number }): Promise<void>;
  stopScreencast(): Promise<void>;
  /** Popups this tab opens become tabs too (takeover only: e.g. a "Sign in with…" window). Off by default. */
  allowPopups(on: boolean): void;
  onPopup(cb: (popup: Tab) => void): () => void;
  onClose(cb: () => void): () => void;
  /** Takeover input, from a person. Not an agent tool. */
  input(ev: InputEvent): Promise<void>;
  screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserPool {
  openTab(userId: string, profile: Profile): Promise<Tab>;
  closeUser(userId: string): Promise<void>;
  close(): Promise<void>;
}

/** How a pool gets a CDP connection to a Chromium for (user, profile). Local launch or the browser container. */
export type Launcher = (userId: string, profile: Profile) => Promise<{ cdp: CdpConnection; close(): Promise<void> }>;

export function localLauncher(opts: { dataDir: string } & Omit<LaunchOptions, "userDataDir">): Launcher {
  return async (userId, profile) => {
    const dir = join(opts.dataDir, "profiles", userId.replace(/[^\w-]/g, "_"), profile);
    seedPreferences(dir);
    return launchChrome({ ...opts, userDataDir: dir });
  };
}

/** Third-party cookies blocked in both profiles (Access Model L2); Chrome's own password saving off. */
export function seedPreferences(userDataDir: string): void {
  const def = join(userDataDir, "Default");
  mkdirSync(def, { recursive: true });
  const prefs = join(def, "Preferences");
  if (existsSync(prefs)) return;
  writeFileSync(
    prefs,
    JSON.stringify({
      profile: { cookie_controls_mode: 1, block_third_party_cookies: true, password_manager_enabled: false, default_content_setting_values: { notifications: 2, geolocation: 2, media_stream_camera: 2, media_stream_mic: 2 } },
      credentials_enable_service: false,
      download: { prompt_for_download: false, default_directory: "/dev/null" },
      safebrowsing: { enabled: false },
      // No default search engine (nothing to preconnect to) and no network prediction.
      default_search_provider: { enabled: false },
      net: { network_prediction_options: 2 },
      search: { suggest_enabled: false },
      alternate_error_pages: { enabled: false },
      translate: { enabled: false },
      spellcheck: { use_spelling_service: false },
    }),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
export const MOBILE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };

class ManagedBrowser {
  signInProviders: string[] = SIGN_IN_PROVIDERS;
  readonly tabsBySession = new Map<string, CdpTab>();
  readonly expected = new Set<string>();
  gate!: NetworkGate;
  scripts!: PageScripts;
  cdp!: CdpConnection;
  closeFn!: () => Promise<void>;
  version = "";

  async start(launcher: Launcher, userId: string, profile: Profile): Promise<void> {
    const b = await launcher(userId, profile);
    this.cdp = b.cdp;
    this.closeFn = b.close;
    this.scripts = new PageScripts(this.cdp);
    this.version = (await this.cdp.send("Browser.getVersion")).product;
    this.gate = new NetworkGate(this.cdp, {
      policy: (r) => this.route(r),
      onHeld: (h) => this.tabsBySession.get(h.request.rootSessionId)?.policy?.onHeld?.(h),
      onRequest: (r, v, rule) => this.tabsBySession.get(r.rootSessionId)?.policy?.onRequest?.(r, v, rule),
      onAttach: (t) => this.onAttach(t),
    });
    await this.gate.start();
    this.cdp.on("Target.detachedFromTarget", (p) => {
      const tab = this.tabsBySession.get(p.sessionId);
      if (tab) {
        this.tabsBySession.delete(p.sessionId);
        tab.emitClose();
      }
    });
    // Block third-party cookies.
    await this.cdp.send("Storage.setCookieControls" as never, { enableThirdPartyCookieRestriction: true } as never).catch(() => {});
  }

  private onAttach(t: Attached): void {
    if (t.type !== "page" || t.parentSessionId || this.expected.has(t.targetId)) return;
    // A popup from a tab that allows them (takeover) is adopted with its opener's policy, before its
    // first request runs (the gate attaches with the target paused).
    const opener = t.openerId ? [...this.tabsBySession.values()].find((x) => x.mainFrameId === t.openerId) : undefined;
    if (opener?.popupsAllowed) {
      const popup = new CdpTab(this, t.sessionId, t.targetId, opener.profile);
      popup.policy = opener.policy;
      this.tabsBySession.set(t.sessionId, popup);
      void popup.init().then(() => opener.emitPopup(popup)).catch(() => {});
      return;
    }
    // Other pages we didn't create are closed: no tab owns them, so no policy fits.
    if (t.url !== "about:blank" && t.url !== "") void this.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
  }

  private route(r: GateRequest): Verdict | Decision {
    const tab = this.tabsBySession.get(r.rootSessionId);
    if (tab?.policy) return tab.policy.decide(r);
    // No owning tab (service worker, shared worker, a page we're closing): reads only.
    if (r.method === "GET" || r.method === "HEAD") return { verdict: "allow", rule: "no_tab_read" };
    return { verdict: "deny", rule: "no_tab" };
  }

  async newTab(profile: Profile): Promise<CdpTab> {
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
    this.expected.add(targetId);
    let session: string | undefined;
    for (let i = 0; i < 200 && !session; i++) {
      session = [...this.gate.attached.values()].find((a) => a.targetId === targetId)?.sessionId;
      if (!session) await sleep(10);
    }
    if (!session) throw new Error("gate never attached to the new tab");
    const tab = new CdpTab(this, session, targetId, profile);
    this.tabsBySession.set(session, tab);
    await tab.init();
    return tab;
  }
}

class CdpTab implements Tab {
  readonly id = randomUUID();
  policy?: TabPolicy;
  popupsAllowed = false;
  private readonly popupCbs = new Set<(t: Tab) => void>();
  private readonly closeCbs = new Set<() => void>();
  private lastDoc: { status: number | null; headers: Record<string, string> } = { status: null, headers: {} };
  private frameHandler?: () => void;
  private readonly offs: Array<() => void> = [];
  private readonly b: ManagedBrowser;
  readonly session: string;
  private readonly targetId: string;
  readonly profile: Profile;

  constructor(b: ManagedBrowser, session: string, targetId: string, profile: Profile) {
    this.b = b;
    this.session = session;
    this.targetId = targetId;
    this.profile = profile;
  }

  private get cdp() {
    return this.b.cdp;
  }

  get mainFrameId(): string {
    return this.targetId;
  }

  async init(): Promise<void> {
    await this.cdp.send("Page.enable", undefined, this.session);
    await this.cdp.send("Network.enable", {}, this.session);
    await this.cdp.send("DOM.enable", undefined, this.session);
    await this.cdp.send("Page.setDownloadBehavior" as never, { behavior: "deny" } as never, this.session).catch(() => {});
    await this.emulate("desktop");
    this.offs.push(
      this.cdp.on("Network.responseReceived", (p, s) => {
        if (s === this.session && p.type === "Document") {
          void this.cdp
            .send("Page.getFrameTree", undefined, this.session)
            .then(({ frameTree }) => {
              if (p.frameId === frameTree.frame.id) {
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(p.response.headers)) headers[k.toLowerCase()] = String(v);
                this.lastDoc = { status: p.response.status, headers };
              }
            })
            .catch(() => {});
        }
      }),
    );
  }

  setPolicy(p: TabPolicy): void {
    this.policy = p;
  }

  allowPopups(on: boolean): void {
    this.popupsAllowed = on;
  }
  onPopup(cb: (t: Tab) => void): () => void {
    this.popupCbs.add(cb);
    return () => this.popupCbs.delete(cb);
  }
  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }
  emitPopup(t: Tab): void {
    for (const cb of this.popupCbs) cb(t);
  }
  emitClose(): void {
    for (const cb of this.closeCbs) cb();
  }

  private async waitLoad(timeoutMs = 15000): Promise<void> {
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, timeoutMs);
      const off = this.cdp.on("Page.loadEventFired", (_p, s) => s === this.session && done());
      function done() {
        clearTimeout(t);
        off();
        resolve();
      }
    });
  }

  private async nav(): Promise<NavResult> {
    const url = await this.currentUrl();
    const title = (await this.cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, this.session).catch(() => null))?.result.value ?? "";
    return { url, title: String(title), status: this.lastDoc.status };
  }

  async navigate(url: string): Promise<NavResult> {
    if (!/^https?:\/\//i.test(url)) throw new Error("Only http and https URLs can be opened.");
    this.lastDoc = { status: null, headers: {} };
    const loaded = this.waitLoad();
    const r = await this.cdp.send("Page.navigate", { url }, this.session);
    if (r.errorText) {
      return { url, title: "", status: null, ...(r.errorText ? { error: r.errorText } : {}) } as NavResult;
    }
    await loaded;
    this.b.scripts.forget(this.session);
    return this.nav();
  }

  async back(): Promise<NavResult> {
    const { currentIndex, entries } = await this.cdp.send("Page.getNavigationHistory", undefined, this.session);
    if (currentIndex <= 0) return this.nav();
    const loaded = this.waitLoad(10000);
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1]!.id }, this.session);
    await loaded;
    this.b.scripts.forget(this.session);
    return this.nav();
  }

  async currentUrl(): Promise<string> {
    const { frameTree } = await this.cdp.send("Page.getFrameTree", undefined, this.session);
    return frameTree.frame.url + (frameTree.frame.urlFragment ?? "");
  }

  extract(p?: ExtractParams): Promise<ExtractResult> {
    return this.b.scripts.extract(this.session, p);
  }

  async click(ref: string): Promise<{ tag: string; text: string }> {
    const at = await this.b.scripts.call<{ x: number; y: number; tag: string; text: string } | null>(this.session, "locateRef", { ref });
    if (!at) throw new Error(`No visible element with ref ${ref}. Call read again; refs change when the page changes.`);
    await sleep(50);
    // Access Model L4: the element under the click point must be the one the agent chose (no overlay).
    const under = await this.b.scripts.call<string | null>(this.session, "refAtPoint", { x: at.x, y: at.y });
    if (under !== ref) throw new Error(`Something else is on top of ${ref} (${under ?? "no ref"}). Not clicking.`);
    const base = { x: at.x, y: at.y, button: "left" as const, clickCount: 1 };
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, this.session);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base }, this.session);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base }, this.session);
    return { tag: at.tag, text: at.text };
  }

  async type(ref: string, text: string, submit: boolean): Promise<void> {
    await typeInto(this.cdp, this.session, `[data-cb-ref="${ref.replace(/[^\w]/g, "")}"]`, text, { providers: this.b.signInProviders });
    if (submit) {
      const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" }, this.session);
      await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, this.session);
    }
  }

  scroll(opts: ScrollOptions): Promise<ScrollResult> {
    return scrollAndExtract(this.cdp, this.session, this.b.scripts, opts);
  }

  async facts(): Promise<PageFacts> {
    const { frameTree } = await this.cdp.send("Page.getFrameTree", undefined, this.session);
    const frameUrls: string[] = [];
    const walk = (t: typeof frameTree) => {
      frameUrls.push(t.frame.url);
      for (const c of t.childFrames ?? []) walk(c);
    };
    walk(frameTree);
    // Probe every frame we can reach: password/OTP fields with their origin, known captcha containers.
    const probe = `(() => {
      const out = { pw: [], otp: false, containers: [] };
      const sel = ${JSON.stringify(CAPTCHA_CONTAINERS)};
      const scan = (doc) => {
        for (const p of doc.querySelectorAll('input[type=password]')) out.pw.push(p.form && p.form.action ? new URL(p.form.action, doc.location.href).origin : doc.location.origin);
        if (doc.querySelector('input[autocomplete~="one-time-code"]')) out.otp = true;
        for (const s of sel) if (doc.querySelector(s)) out.containers.push(s);
        for (const f of doc.querySelectorAll('iframe, frame')) { try { if (f.contentDocument) scan(f.contentDocument); } catch (e) {} }
      };
      scan(document);
      return out;
    })()`;
    type Probe = { pw: string[]; otp: boolean; containers: string[] };
    const run = async (session: string): Promise<Probe | null> =>
      ((await this.cdp.send("Runtime.evaluate", { expression: probe, returnByValue: true }, session).catch(() => null))?.result.value as Probe | undefined) ?? null;
    const probes: Probe[] = [];
    const main = await run(this.session);
    if (main) probes.push(main);
    // Out-of-process (cross-origin) iframes: their own sessions. The URL recorded at attach is usually
    // blank (the target starts paused), so ask for the current one.
    for (const a of [...this.b.gate.attached.values()]) {
      if (a.type !== "iframe" || this.b.gate.rootOf(a.sessionId) !== this.session) continue;
      const info = await this.cdp.send("Target.getTargetInfo", { targetId: a.targetId }).catch(() => null);
      const url = info?.targetInfo.url || a.url;
      if (url) frameUrls.push(url);
      const sub = await this.cdp.send("Page.getFrameTree", undefined, a.sessionId).catch(() => null);
      if (sub) walk(sub.frameTree);
      const p = await run(a.sessionId);
      if (p) probes.push(p);
    }
    const r = await this.cdp.send(
      "Runtime.evaluate",
      { expression: `({ title: document.title, text: (document.body?.innerText ?? '').slice(0, 4000), len: (document.body?.innerText ?? '').length })`, returnByValue: true },
      this.session,
    );
    const v = (r.result.value ?? {}) as { title: string; text: string; len: number };
    const pwOrigins = probes.flatMap((p) => p.pw);
    return {
      url: frameTree.frame.url,
      title: v.title ?? "",
      status: this.lastDoc.status,
      headers: this.lastDoc.headers,
      frameUrls: [...new Set(frameUrls.filter((u) => u && u !== "about:blank"))],
      hasPasswordField: pwOrigins.length > 0,
      passwordFieldOrigins: [...new Set(pwOrigins)],
      hasOtpField: probes.some((p) => p.otp),
      captchaContainers: [...new Set(probes.flatMap((p) => p.containers))],
      textLength: v.len ?? 0,
      textSample: v.text ?? "",
    };
  }

  domTokens() {
    return this.b.scripts.call<{ classes: string[]; ids: string[]; hrefs: string[] }>(this.session, "domTokens");
  }

  async applyCosmetics(css: string): Promise<void> {
    await this.b.scripts.call(this.session, "applyCosmetics", { css });
  }

  async emulate(device: DeviceKind): Promise<void> {
    const m = device === "mobile" ? MOBILE : DESKTOP;
    await this.cdp.send("Emulation.setDeviceMetricsOverride", m, this.session);
    await this.cdp.send("Emulation.setTouchEmulationEnabled", device === "mobile" ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }, this.session);
    const major = this.b.version.split("/")[1]?.split(".")[0] ?? "157";
    if (device === "mobile") {
      // A complete, consistent mobile profile (ADR 0006): UA string and client hints agree.
      await this.cdp.send(
        "Emulation.setUserAgentOverride",
        {
          userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
          platform: "Linux armv8l",
          userAgentMetadata: { brands: [{ brand: "Chromium", version: major }, { brand: "Not_A Brand", version: "24" }], platform: "Android", platformVersion: "14.0.0", architecture: "", model: "Pixel 8", mobile: true },
        },
        this.session,
      );
    } else {
      const ua = (await this.cdp.send("Browser.getVersion")).userAgent.replace("HeadlessChrome", "Chrome");
      await this.cdp.send("Emulation.setUserAgentOverride", { userAgent: ua }, this.session);
    }
  }

  async startScreencast(onFrame: (jpeg: string, meta: FrameMeta) => void, opts: { maxWidth?: number; maxHeight?: number; fps?: number } = {}): Promise<void> {
    await this.stopScreencast();
    const minGap = 1000 / Math.min(opts.fps ?? 15, 15);
    let last = 0;
    this.frameHandler = this.cdp.on("Page.screencastFrame", (p, s) => {
      if (s !== this.session) return;
      void this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, this.session).catch(() => {});
      const now = Date.now();
      if (now - last < minGap) return;
      last = now;
      onFrame(p.data, { width: p.metadata.deviceWidth, height: p.metadata.deviceHeight });
    });
    // Chrome doesn't paint background tabs; without this, no frames arrive.
    await this.cdp.send("Page.bringToFront", undefined, this.session).catch(() => {});
    // First frame right away, so a viewer never waits on an idle page.
    const { cssLayoutViewport } = await this.cdp.send("Page.getLayoutMetrics", undefined, this.session);
    const first = await this.screenshot().catch(() => null);
    if (first) onFrame(first, { width: cssLayoutViewport.clientWidth, height: cssLayoutViewport.clientHeight });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: opts.maxWidth ?? 1280, maxHeight: opts.maxHeight ?? 1280, everyNthFrame: 1 }, this.session);
  }

  async stopScreencast(): Promise<void> {
    if (!this.frameHandler) return;
    this.frameHandler();
    this.frameHandler = undefined;
    await this.cdp.send("Page.stopScreencast", undefined, this.session).catch(() => {});
  }

  async input(ev: InputEvent): Promise<void> {
    switch (ev.type) {
      case "insertText":
        // Takeover only: the person types (or their password manager fills) through a native field.
        await this.cdp.send("Input.insertText", { text: ev.text ?? "" }, this.session);
        return;
      case "keyDown":
      case "keyUp":
      case "char":
        await this.cdp.send("Input.dispatchKeyEvent", { type: ev.type, key: ev.key, code: ev.code, text: ev.type === "keyUp" ? undefined : ev.text }, this.session);
        return;
      case "mouseWheel":
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x ?? 0, y: ev.y ?? 0, deltaX: 0, deltaY: ev.deltaY ?? 0 }, this.session);
        return;
      default:
        await this.cdp.send("Input.dispatchMouseEvent", { type: ev.type, x: ev.x ?? 0, y: ev.y ?? 0, button: ev.button ?? "left", clickCount: ev.type === "mouseMoved" ? 0 : 1 }, this.session);
    }
  }

  async screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<string> {
    const r = await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, this.session);
    return r.data;
  }

  async close(): Promise<void> {
    await this.stopScreencast();
    for (const off of this.offs) off();
    this.b.tabsBySession.delete(this.session);
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
  }
}

export interface PoolOptions {
  /** More sign-in providers to refuse agent typing on. Only tightens. */
  extraSignInProviders?: string[];
}

export class LocalPool implements BrowserPool {
  private readonly browsers = new Map<string, Promise<ManagedBrowser>>();
  private readonly launcher: Launcher;
  private readonly opts: PoolOptions;
  constructor(launcher: Launcher, opts: PoolOptions = {}) {
    this.launcher = launcher;
    this.opts = opts;
  }

  private browser(userId: string, profile: Profile): Promise<ManagedBrowser> {
    const key = `${userId}:${profile}`;
    let b = this.browsers.get(key);
    if (!b) {
      b = (async () => {
        const m = new ManagedBrowser();
        m.signInProviders = [...SIGN_IN_PROVIDERS, ...(this.opts.extraSignInProviders ?? []).map((h) => h.toLowerCase())];
        await m.start(this.launcher, userId, profile);
        return m;
      })();
      b.catch(() => this.browsers.delete(key));
      this.browsers.set(key, b);
    }
    return b;
  }

  async openTab(userId: string, profile: Profile): Promise<Tab> {
    return (await this.browser(userId, profile)).newTab(profile);
  }

  async closeUser(userId: string): Promise<void> {
    for (const [key, b] of this.browsers) {
      if (!key.startsWith(`${userId}:`)) continue;
      this.browsers.delete(key);
      const m = await b.catch(() => null);
      m?.gate.stop();
      await m?.closeFn();
    }
  }

  async close(): Promise<void> {
    for (const key of [...this.browsers.keys()]) await this.closeUser(key.split(":")[0]!);
  }
}
