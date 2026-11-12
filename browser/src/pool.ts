// SPDX-License-Identifier: AGPL-3.0-only
// The pool and tab interface: the only way the rest of Crossbar reaches a browser (AGENTS.md rule 10).
// One Chromium per (user, profile). One gate per Chromium; requests are routed to the tab they belong to.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { CdpConnection } from "./cdp.ts";
import { NetworkGate, type Decision, type GateRequest, type HeldRequest, type Verdict, type Attached } from "./gate.ts";
import { launchChrome, type LaunchOptions } from "./launch.ts";
import { PageScripts, type ControlMatch, type ControlRole, type ExtractParams, type ExtractResult } from "./page-scripts/index.ts";
export type { ControlMatch, ControlRole } from "./page-scripts/index.ts";
import { scrollAndExtract, type ScrollOptions, type ScrollResult } from "./page-scripts/scroll.ts";
import { typeInto, SIGN_IN_PROVIDERS } from "./input-guard.ts";

export type Profile = "anon" | "personal";
export type DeviceKind = "narrow" | "desktop" | "mobile";

/**
 * The narrow window (ADR 0028): as narrow as Chrome lets a person drag a window (measured: 500 px), and tall
 * enough that the page has a phone's shape (390x844 is 0.46 wide per tall): 500x1170 on a 1920x1200 screen.
 */
export const NARROW_WINDOW = { width: 500, height: 1170 };

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
  /** Captcha widgets inside a form with other fields to fill: they gate sending the form, not reading the page. */
  formCaptchas: string[];
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
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel" | "keyDown" | "keyUp" | "char" | "insertText" | "touchStart" | "touchMove" | "touchEnd" | "touchCancel";
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  button?: "left" | "right" | "middle" | "none";
  buttons?: number;
  clickCount?: number;
  modifiers?: number;
  touchPoints?: Array<{ x: number; y: number; id: number }>;
  key?: string;
  code?: string;
  text?: string;
}

/** What has focus in the page after a person's input, so the phone can open the right keyboard. */
export type FocusKind = "text" | "password" | "otp" | "frame" | "none";
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/**
 * What the take-control window needs to keep typing in view (takeover only): the focused field and the
 * form around it, and the text fields on screen, so a tap on one can open the phone keyboard at once.
 * Field kinds only, never values or page text. Page CSS pixels.
 */
export interface ViewState {
  focus: (Box & { kind: Exclude<FocusKind, "none">; area: Box | null }) | null;
  fields: Array<Box & { kind: Exclude<FocusKind, "none" | "frame"> }>;
}

/** Keys without text need their virtual key code, or Chrome doesn't run the default action (delete, move, submit). */
const KEY_CODES: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };

export interface Tab {
  readonly id: string;
  readonly profile: Profile;
  /** Chrome's main frame id for this tab (equals its target id). */
  readonly mainFrameId: string;
  setPolicy(p: TabPolicy): void;
  navigate(url: string): Promise<NavResult>;
  /** If this page has a visible link to `url` that opens in this tab, click it like a person and wait for the page; else null. */
  followLink(url: string): Promise<NavResult | null>;
  back(): Promise<NavResult>;
  currentUrl(): Promise<string>;
  extract(p?: ExtractParams): Promise<ExtractResult>;
  /** The visible element whose text matches (exact first, then partial), given a ref; null if none. */
  findByText(text: string, nth?: number): Promise<{ ref: string; text: string } | null>;
  /** Controls whose name matches, best first, with whether a click can reach them (see page.ts findControls). */
  findControls(query: string, opts?: { role?: ControlRole | "any"; limit?: number; textFallback?: boolean }): Promise<ControlMatch[]>;
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
  /** Focused field, its form and the fields on screen (takeover only). */
  viewState(): Promise<ViewState>;
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
const rand = (a: number, b: number) => a + Math.random() * (b - a);
interface Located {
  x: number;
  y: number;
  w: number;
  h: number;
  inView: boolean;
  vw: number;
  vh: number;
  tag: string;
  text: string;
}
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
  /** Called whenever a tab goes away (closed by us or by the page), for idle tracking. */
  onTabGone?: () => void;

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
        this.onTabGone?.();
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
    if (tab?.policy) {
      const d = tab.policy.decide(r);
      // Remember each tab's page origin, so its service and shared workers can be matched to it.
      if (r.resourceType === "Document" && r.sessionId === r.rootSessionId && verdictOf(d) === "allow") tab.pageOrigin = originOf(r.url);
      return d;
    }
    // No owning tab (service worker, shared worker, a page we're closing): reads pass.
    if (r.method === "GET" || r.method === "HEAD") return { verdict: "allow", rule: "no_tab_read" };
    // A worker's write is judged by every open tab of its origin, and passes only if all of them would
    // let it through: a shared worker serves tabs with different taint, so it gets the strictest (audit S21).
    // A hold becomes a deny: no single tab owns the request to show it on.
    const origin = /worker/.test(r.targetType) ? originOf(r.targetUrl) : "";
    const owners = origin ? [...this.tabsBySession.values()].filter((t) => t.policy && t.pageOrigin === origin) : [];
    if (owners.length === 0) return { verdict: "deny", rule: "no_tab" };
    let rule = "";
    for (const o of owners) {
      const d = o.policy!.decide(r);
      if (verdictOf(d) !== "allow") return { verdict: "deny", rule: `worker:${typeof d === "string" ? d : (d.rule ?? d.verdict)}` };
      rule ||= typeof d === "string" ? d : (d.rule ?? "allow");
    }
    return { verdict: "allow", rule: `worker:${rule}` };
  }

  /** Bounds of the browser's first window; new windows copy them so every window looks the same. */
  private windowBounds?: { left?: number; top?: number; width?: number; height?: number };
  firstWindowBounds(): { left?: number; top?: number; width?: number; height?: number } | undefined {
    return this.windowBounds;
  }

  async newTab(profile: Profile): Promise<CdpTab> {
    // A window of its own, not a background tab in a shared window: two sessions (or a session and a person
    // taking control) never push each other's page into the background (ADR 0017).
    if (!this.windowBounds) {
      const first = (await this.cdp.send("Target.getTargets").catch(() => null))?.targetInfos.find((t) => t.type === "page");
      const w = first ? await this.cdp.send("Browser.getWindowForTarget", { targetId: first.targetId }).catch(() => null) : null;
      this.windowBounds = w?.bounds ?? {};
    }
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
    const win = await this.cdp.send("Browser.getWindowForTarget", { targetId }).catch(() => null);
    const { left, top, width, height } = this.windowBounds;
    if (win && width && height) await this.cdp.send("Browser.setWindowBounds", { windowId: win.windowId, bounds: { left, top, width, height } }).catch(() => {});
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

const verdictOf = (d: Verdict | Decision): Verdict => (typeof d === "string" ? d : d.verdict);
function originOf(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

class CdpTab implements Tab {
  readonly id = randomUUID();
  policy?: TabPolicy;
  /** Origin of the page this tab last loaded. */
  pageOrigin = "";
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
    const title = (await this.b.scripts.inspect<string>(this.session, "document.title").catch(() => null)) ?? "";
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

  async followLink(url: string): Promise<NavResult | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    const ref = await this.b.scripts.call<string | null>(this.session, "refForHref", { href: url }).catch(() => null);
    if (!ref) return null;
    this.lastDoc = { status: null, headers: {} };
    const loaded = this.waitLoad(15000);
    try {
      await this.click(ref);
    } catch {
      return null; // covered or gone: the caller opens the address instead
    }
    // A full page load (also after a redirect), or a single-page app changing the address without one.
    const same = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
    const arrived = (async () => {
      for (let i = 0; i < 100; i++) {
        await sleep(150);
        if (same(await this.currentUrl().catch(() => "")) !== same(url)) continue;
        if ((await this.b.scripts.inspect<string>(this.session, "document.readyState").catch(() => "")) === "complete") return;
      }
    })();
    await Promise.race([loaded, arrived]);
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

  /** Last pointer position, so the next click starts its movement from where the pointer is. */
  private pointer: { x: number; y: number } | null = null;

  private async locate(ref: string): Promise<Located> {
    type L = Located | null;
    let at = await this.b.scripts.call<L>(this.session, "locateRef", { ref });
    if (!at) throw new Error(`No visible element with ref ${ref}. Call read again; refs change when the page changes.`);
    // Off screen: scroll toward it with the wheel, like a person, in a few steps (audit S06).
    for (let i = 0; i < 8 && !at.inView; i++) {
      const dy = Math.max(-at.vh * 0.8, Math.min(at.vh * 0.8, at.y - at.vh / 2));
      const dx = at.x < 0 || at.x > at.vw ? Math.max(-at.vw * 0.8, Math.min(at.vw * 0.8, at.x - at.vw / 2)) : 0;
      if (Math.abs(dy) < 2 && Math.abs(dx) < 2) break;
      const from = this.pointer ?? { x: at.vw / 2, y: at.vh / 2 };
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: from.x, y: from.y, deltaX: dx, deltaY: dy }, this.session);
      await sleep(rand(90, 180));
      const next = await this.b.scripts.call<L>(this.session, "locateRef", { ref });
      if (!next) throw new Error(`${ref} disappeared while scrolling to it. Call read again.`);
      const stuck = Math.abs(next.y - at.y) < 1 && Math.abs(next.x - at.x) < 1;
      at = next;
      if (stuck) break; // a nested scroller the wheel at this point doesn't move
    }
    if (!at.inView) at = (await this.b.scripts.call<L>(this.session, "locateRef", { ref, reveal: true })) ?? at;
    return at;
  }

  /** Moves the pointer to (x, y) along a short curved path with easing, as a hand would. */
  private async moveTo(x: number, y: number): Promise<void> {
    const from = this.pointer ?? { x: x + rand(-120, 120), y: y + rand(60, 200) };
    const dist = Math.hypot(x - from.x, y - from.y);
    const steps = Math.max(3, Math.min(18, Math.round(dist / 40)));
    // A control point off the straight line bends the path.
    const cx = (from.x + x) / 2 + rand(-0.2, 0.2) * dist;
    const cy = (from.y + y) / 2 + rand(-0.2, 0.2) * dist;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const px = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * cx + e * e * x;
      const py = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * cy + e * e * y;
      await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py, button: "none", buttons: 0 }, this.session);
      await sleep(rand(8, 22));
    }
    this.pointer = { x, y };
  }

  async click(ref: string): Promise<{ tag: string; text: string }> {
    const at = await this.locate(ref);
    // A point inside the element, not its exact center every time (audit S05).
    const x = at.x + rand(-0.25, 0.25) * Math.min(at.w, 200);
    const y = at.y + rand(-0.2, 0.2) * Math.min(at.h, 60);
    // Access Model L4: the element under the click point must be the one the agent chose (no overlay).
    const verify = () => this.b.scripts.call<{ ok: true } | { ok: false; covering: { ref: string; tag: string; text: string } | null }>(this.session, "checkPoint", { ref, x, y });
    let check = await verify();
    if (check.ok) {
      await this.moveTo(x, y);
      await sleep(rand(40, 120));
      // Hovering can open menus or move things: check the final point again right before pressing.
      check = await verify();
    }
    if (!check.ok) {
      const c = check.covering;
      throw new Error(
        c
          ? `Something else is on top of ${ref}: ${c.tag}${c.text ? ` "${c.text}"` : ""} [${c.ref}]. Not clicking. If it's a banner or dialog, close it first (click ${c.ref} or its close button), then try again.`
          : `${ref} isn't on the page any more. Call read again.`,
      );
    }
    const base = { x, y, button: "left" as const, clickCount: 1 };
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1 }, this.session);
    await sleep(rand(45, 110));
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 }, this.session);
    return { tag: at.tag, text: at.text };
  }

  /** Click by text: the nth control called that which a click can reach (visible or just offscreen). */
  async findByText(text: string, nth = 0): Promise<{ ref: string; text: string } | null> {
    const m = (await this.findControls(text, { limit: 20, textFallback: true })).filter((x) => x.ref && (x.state === "visible" || x.state === "offscreen"))[nth];
    return m ? { ref: m.ref!, text: m.name } : null;
  }

  findControls(query: string, opts: { role?: ControlRole | "any"; limit?: number; textFallback?: boolean } = {}): Promise<ControlMatch[]> {
    return this.b.scripts.call(this.session, "findControls", { query, ...opts });
  }

  async type(ref: string, text: string, submit: boolean): Promise<void> {
    // By handle from the isolated world: the page's elements carry no ref attribute to select on (S02).
    const objectId = await this.b.scripts.elementHandle(this.session, ref);
    if (!objectId) throw new Error(`No element with ref ${ref}. Read the page again for fresh refs.`);
    try {
      // Click into the field first, as a person would; if something covers it, focus it directly.
      await this.click(ref).catch(() => {});
      await typeInto(this.cdp, this.session, { objectId }, text, { keys: true });
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId }, this.session).catch(() => {});
    }
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
      const out = { pw: [], otp: false, containers: [], inForm: [] };
      const sel = ${JSON.stringify(CAPTCHA_CONTAINERS)};
      // A widget inside a form that also has fields a person fills (title, text...) only matters when that
      // form is sent: it's a form captcha, not a wall over the page.
      const fieldsBesides = (form, widget) => [...form.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea, select')]
        .filter((x) => !widget.contains(x) && x.offsetParent !== null).length;
      const scan = (doc) => {
        for (const p of doc.querySelectorAll('input[type=password]')) out.pw.push(p.form && p.form.action ? new URL(p.form.action, doc.location.href).origin : doc.location.origin);
        if (doc.querySelector('input[autocomplete~="one-time-code"]')) out.otp = true;
        for (const s of sel) {
          const el = doc.querySelector(s);
          if (!el) continue;
          const form = el.closest('form');
          if (form && fieldsBesides(form, el) > 0) out.inForm.push(s); else out.containers.push(s);
        }
        for (const f of doc.querySelectorAll('iframe, frame')) { try { if (f.contentDocument) scan(f.contentDocument); } catch (e) {} }
      };
      scan(document);
      return out;
    })()`;
    type Probe = { pw: string[]; otp: boolean; containers: string[]; inForm: string[] };
    const run = async (session: string): Promise<Probe | null> => (await this.b.scripts.inspect<Probe>(session, probe).catch(() => null)) ?? null;
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
    const v = ((await this.b.scripts.inspect(this.session, `({ title: document.title, text: (document.body?.innerText ?? '').slice(0, 4000), len: (document.body?.innerText ?? '').length })`).catch(() => null)) ?? {}) as {
      title: string;
      text: string;
      len: number;
    };
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
      formCaptchas: [...new Set(probes.flatMap((p) => p.inForm))],
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

  private emulated: DeviceKind | null = null;

  private windowShape: "narrow" | "full" | null = null;

  /** Size this tab's own window (ADR 0017: one window per tab): narrow and phone-shaped, or the full first window. */
  private async shapeWindow(shape: "narrow" | "full"): Promise<void> {
    if (this.windowShape === shape) return;
    const win = await this.cdp.send("Browser.getWindowForTarget", { targetId: this.targetId }).catch(() => null);
    const full = this.b.firstWindowBounds();
    if (!win || !full?.width || !full.height) return;
    const bounds = shape === "narrow" ? { left: full.left ?? 0, top: full.top ?? 0, width: NARROW_WINDOW.width, height: Math.min(NARROW_WINDOW.height, full.height) } : full;
    await this.cdp.send("Browser.setWindowBounds", { windowId: win.windowId, bounds: { windowState: "normal" } }).catch(() => {});
    await this.cdp.send("Browser.setWindowBounds", { windowId: win.windowId, bounds }).catch(() => {});
    this.windowShape = shape;
  }

  async emulate(device: DeviceKind): Promise<void> {
    const major = this.b.version.split("/")[1]?.split(".")[0] ?? "157";
    await this.shapeWindow(device === "desktop" ? "full" : "narrow");
    if (device === "mobile") {
      await this.cdp.send("Emulation.setDeviceMetricsOverride", MOBILE, this.session);
      await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, this.session);
      // A complete, consistent mobile profile: UA string and client hints agree.
      await this.cdp.send(
        "Emulation.setUserAgentOverride",
        {
          userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
          platform: "Linux armv8l",
          userAgentMetadata: { brands: [{ brand: "Chromium", version: major }, { brand: "Not A;Brand", version: "99" }], platform: "Android", platformVersion: "14.0.0", architecture: "armv8l", model: "Pixel 8", mobile: true },
        },
        this.session,
      );
      this.emulated = "mobile";
      return;
    }
    // Desktop: the browser as it is. The window size comes from the launch flags, not from emulation,
    // so the page's measurements agree with each other (viewport inside window, as in any browser).
    await this.cdp.send("Emulation.clearDeviceMetricsOverride", undefined, this.session).catch(() => {});
    await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }, this.session).catch(() => {});
    const real = (await this.cdp.send("Browser.getVersion")).userAgent;
    if (/HeadlessChrome/.test(real)) {
      // Headless announces itself in the UA. Replace it together with matching client hints:
      // overriding the UA alone wipes navigator.userAgentData and the Sec-CH-UA headers.
      const platform = /Macintosh/.test(real) ? "macOS" : /Windows/.test(real) ? "Windows" : "Linux";
      const full = (/Chrome\/([\d.]+)/.exec(real)?.[1] ?? `${major}.0.0.0`);
      const arch = platform === "macOS" ? "arm64" : platform === "Windows" ? "x86_64" : "x86_64";
      await this.cdp.send(
        "Emulation.setUserAgentOverride",
        {
          userAgent: real.replace("HeadlessChrome", "Chrome"),
          userAgentMetadata: {
            brands: [{ brand: "Chromium", version: major }, { brand: "Not A;Brand", version: "99" }],
            fullVersionList: [{ brand: "Chromium", version: full }, { brand: "Not A;Brand", version: "99.0.0.0" }],
            platform,
            platformVersion: platform === "macOS" ? "15.0.0" : platform === "Windows" ? "11.0" : "6.8.0",
            architecture: arch,
            model: "",
            mobile: false,
          },
        },
        this.session,
      );
    } else if (this.emulated === "mobile") {
      // Back from mobile: an empty override restores the browser's own UA and client hints.
      await this.cdp.send("Emulation.setUserAgentOverride", { userAgent: "" }, this.session);
    }
    this.emulated = device;
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
      case "char": {
        const vk = ev.key ? KEY_CODES[ev.key] : undefined;
        const text = ev.type === "keyUp" ? undefined : ev.text || undefined;
        await this.cdp.send(
          "Input.dispatchKeyEvent",
          { type: ev.type === "keyDown" && !text ? "rawKeyDown" : ev.type, key: ev.key, code: ev.code, text, unmodifiedText: text, modifiers: ev.modifiers ?? 0, ...(vk ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}) },
          this.session,
        );
        return;
      }
      case "mouseWheel":
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x ?? 0, y: ev.y ?? 0, deltaX: ev.deltaX ?? 0, deltaY: ev.deltaY ?? 0, modifiers: ev.modifiers ?? 0 }, this.session);
        return;
      case "touchStart":
      case "touchMove":
      case "touchEnd":
      case "touchCancel":
        // Real touch sequences for sites in the mobile profile (ADR 0015).
        await this.cdp.send("Input.dispatchTouchEvent", { type: ev.type, touchPoints: (ev.touchPoints ?? []).map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 8, radiusY: 8, force: 1 })), modifiers: ev.modifiers ?? 0 }, this.session);
        return;
      default:
        await this.cdp.send(
          "Input.dispatchMouseEvent",
          {
            type: ev.type,
            x: ev.x ?? 0,
            y: ev.y ?? 0,
            button: ev.type === "mouseMoved" ? (ev.buttons ? "left" : "none") : (ev.button ?? "left"),
            buttons: ev.buttons ?? (ev.type === "mousePressed" ? 1 : 0),
            clickCount: ev.type === "mouseMoved" ? 0 : (ev.clickCount ?? 1),
            modifiers: ev.modifiers ?? 0,
          },
          this.session,
        );
    }
  }

  async viewState(): Promise<ViewState> {
    const empty: ViewState = { focus: null, fields: [] };
    return (
      (await this.b.scripts
        .inspect<ViewState>(
          this.session,
          `(() => {
            const kindOf = (a) => {
              if (a.isContentEditable || a.tagName === 'TEXTAREA') return 'text';
              if (a.tagName !== 'INPUT') return 'none';
              if (a.disabled || a.readOnly) return 'none';
              if (a.type === 'password') return 'password';
              if ((a.autocomplete || '').includes('one-time-code')) return 'otp';
              return ['text', 'email', 'search', 'tel', 'url', 'number', ''].includes(a.type) ? 'text' : 'none';
            };
            const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
            const onScreen = (b) => b.w > 0 && b.h > 0 && b.x < innerWidth && b.y < innerHeight && b.x + b.w > 0 && b.y + b.h > 0;
            const fields = [];
            for (const el of document.querySelectorAll('input, textarea, [contenteditable]')) {
              const k = kindOf(el);
              const b = box(el);
              if (k !== 'none' && onScreen(b)) fields.push({ ...b, kind: k });
              if (fields.length >= 60) break;
            }
            let a = document.activeElement;
            while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
            let focus = null;
            if (a && a !== document.body) {
              const k = a.tagName === 'IFRAME' ? 'frame' : kindOf(a);
              if (k !== 'none') {
                // The area to zoom to: the visible controls of the field's form (a <form> element is often
                // as wide as the page), or of the nearest container that holds a few of them.
                let scope = a.closest && a.closest('form');
                if (!scope) for (let p = a.parentElement, i = 0; p && i < 6 && !scope; p = p.parentElement, i++) if (p.querySelectorAll('input, button, select, textarea').length >= 2) scope = p;
                let area = null;
                for (const c of scope ? scope.querySelectorAll('input:not([type=hidden]), textarea, select, button, [role=button], label') : [a]) {
                  const b = box(c);
                  if (!onScreen(b)) continue;
                  area = area ? { x: Math.min(area.x, b.x), y: Math.min(area.y, b.y), w: Math.max(area.x + area.w, b.x + b.w) - Math.min(area.x, b.x), h: Math.max(area.y + area.h, b.y + b.h) - Math.min(area.y, b.y) } : b;
                }
                if (area) area = { x: area.x - 16, y: area.y - 16, w: area.w + 32, h: area.h + 32 };
                if (area && (area.w * area.h > innerWidth * innerHeight * 0.8 || area.h > innerHeight)) area = null;
                focus = { ...box(a), kind: k, area };
              }
            }
            return { focus, fields };
          })()`,
        )
        .catch(() => empty)) ?? empty
    );
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
    this.b.onTabGone?.();
  }
}

export interface PoolOptions {
  /** More sign-in providers to refuse agent typing on. Only tightens. */
  extraSignInProviders?: string[];
  /**
   * Stop a browser this long after its last tab closed (no agent work, no takeover, no held request: those
   * all live in tabs). Its profile stays on disk, so the next use relaunches it signed in. Unset: never.
   */
  idleStopMs?: number;
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

  private readonly idle = new Map<string, NodeJS.Timeout>();

  async openTab(userId: string, profile: Profile): Promise<Tab> {
    const key = `${userId}:${profile}`;
    clearTimeout(this.idle.get(key));
    this.idle.delete(key);
    const m = await this.browser(userId, profile);
    m.onTabGone ??= () => this.maybeIdle(key, m);
    return m.newTab(profile);
  }

  /** Browsers running now (each is a Chromium process). */
  running(): number {
    return this.browsers.size;
  }

  private maybeIdle(key: string, m: ManagedBrowser): void {
    const ms = this.opts.idleStopMs;
    if (!ms || m.tabsBySession.size > 0) return;
    clearTimeout(this.idle.get(key));
    const timer = setTimeout(async () => {
      this.idle.delete(key);
      if (m.tabsBySession.size > 0 || (await this.browsers.get(key)?.catch(() => null)) !== m) return;
      this.browsers.delete(key);
      m.gate.stop();
      await m.closeFn().catch(() => {});
    }, ms);
    timer.unref();
    this.idle.set(key, timer);
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
