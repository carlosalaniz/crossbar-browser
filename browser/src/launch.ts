// SPDX-License-Identifier: AGPL-3.0-only
// Launches Chromium with the flags the Access Model requires.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { CdpConnection } from "./cdp.ts";

export interface LaunchOptions {
  executablePath?: string;
  /** Window size "W,H". The container sets it to fill its virtual screen (audit S32); tests keep the default. */
  windowSize?: string;
  /** UI and Accept-Language language, e.g. "en-US" (audit S33). Unset: the system's. */
  lang?: string;
  /** The egress proxy. Production always sets this; tests against local pages may not. */
  proxyServer?: string;
  headless?: boolean;
  userDataDir?: string;
  /** Test only: map hostnames to the local test server so we get distinct sites (and OOPIFs). */
  hostResolverRules?: string;
  extraArgs?: string[];
  /** Unpacked extensions to load. Defaults to the WebSocket block (ADR 0010). Needs Chromium or Chrome for Testing. */
  extensions?: string[];
}

/** Static DNR rule that blocks every WebSocket handshake. CDP Fetch can't see WebSockets. */
export const WS_BLOCK_EXTENSION = resolve(import.meta.dirname, "..", "extensions", "ws-block");

export interface LaunchedBrowser {
  process: ChildProcess;
  cdp: CdpConnection;
  /** DevTools WebSocket URL (for the browser host's relay). */
  wsUrl: string;
  executablePath: string;
  args: string[];
  close(): Promise<void>;
}

function pinnedChromeForTesting(): string | undefined {
  // .cache/browsers/chrome/<platform>-<build>/... installed by scripts/ensure-browser.mjs
  const root = resolve(import.meta.dirname, "..", "..", ".cache", "browsers", "chrome");
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    const mac = join(root, dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    const macX64 = join(root, dir, "chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
    const linux = join(root, dir, "chrome-linux64", "chrome");
    for (const p of [mac, macX64, linux]) if (existsSync(p)) return p;
  }
  return undefined;
}

/** Branded Google Chrome silently ignores --load-extension, so the WebSocket block doesn't load there. */
export function supportsLoadExtension(exe: string): boolean {
  return !/Google Chrome(\.app)?\/|google-chrome/.test(exe) || /for Testing/.test(exe);
}

const CANDIDATES = [
  process.env.CHROME_PATH,
  pinnedChromeForTesting(),
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
];

export function findChrome(): string | undefined {
  return CANDIDATES.find((p): p is string => !!p && existsSync(p));
}

/** Chrome features off: DNS-over-HTTPS (would bypass the proxy's DNS) and background phoning home. */
export const DISABLED_FEATURES = [
  "DnsOverHttps",
  "AsyncDns",
  "NetworkPrediction",
  "NetworkTimeServiceQuerying",
  "OptimizationHints",
  "OptimizationGuideModelDownloading",
  "MediaRouter",
  "Translate",
  "AutofillServerCommunication",
  "CertificateTransparencyComponentUpdater",
  "InterestFeedContentSuggestions",
  "PrivacySandboxSettings4",
  "SafeBrowsingRealTimeUrlLookup",
  "LensOverlay",
  "SearchPrefetchServicePrefetching",
  "Prerender2",
];

/**
 * Chrome keeps only the last --disable-features / --enable-features flag. Merge them, so extra
 * args can add features but never silently drop the security list.
 */
export function mergeFeatureFlags(args: string[]): string[] {
  const out: string[] = [];
  const merged: Record<string, string[]> = { "--disable-features": [], "--enable-features": [] };
  for (const a of args) {
    const m = /^(--(?:disable|enable)-features)=(.*)$/.exec(a);
    if (m) merged[m[1]!]!.push(...m[2]!.split(",").filter(Boolean));
    else out.push(a);
  }
  const disabled = [...new Set(merged["--disable-features"])];
  // A feature can't be re-enabled if security turned it off.
  const enabled = [...new Set(merged["--enable-features"])].filter((f) => !disabled.includes(f));
  if (disabled.length) out.push(`--disable-features=${disabled.join(",")}`);
  if (enabled.length) out.push(`--enable-features=${enabled.join(",")}`);
  return out;
}

/** Flags that are part of the security model. Exported so a test can pin them. */
export function securityArgs(opts: Pick<LaunchOptions, "proxyServer">): string[] {
  const args = [
    "--disable-quic", // QUIC (UDP) would skip an HTTP proxy
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", // WebRTC may not use UDP outside the proxy
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    `--disable-features=${DISABLED_FEATURES.join(",")}`,
    "--dns-prefetch-disable",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-component-extensions-with-background-pages",
    "--disable-search-engine-choice-screen",
    "--metrics-recording-only",
    "--no-service-autorun",
    "--no-pings",
  ];
  if (opts.proxyServer) {
    args.push(`--proxy-server=${opts.proxyServer}`, "--proxy-bypass-list=<-loopback>"); // also proxy loopback
  }
  return args;
}

function extensionArgs(paths: string[]): string[] {
  if (paths.length === 0) return [];
  const list = paths.join(",");
  return [`--load-extension=${list}`, `--disable-extensions-except=${list}`];
}

/** Every Chromium this process started. They die with it, whatever the reason it exits. */
const children = new Set<ChildProcess>();
let exitHook = false;
function track(proc: ChildProcess): void {
  children.add(proc);
  proc.once("exit", () => children.delete(proc));
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => {
    for (const p of children) {
      try {
        p.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
}

class PortTaken extends Error {}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function devtoolsUrl(proc: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${buf.slice(-500)}`)), 15000);
    proc.stderr!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      } else if (/Cannot start http server for devtools/i.test(buf)) {
        clearTimeout(timer);
        reject(new PortTaken("DevTools port taken"));
      }
    });
    proc.once("exit", (code) => reject(new Error(`Chrome exited (${code}): ${buf.slice(-500)}`)));
  });
}

export async function launchChrome(opts: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const exe = opts.executablePath ?? findChrome();
  if (!exe) throw new Error("No Chromium found. Set CHROME_PATH.");
  const ownDir = !opts.userDataDir;
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), "crossbar-profile-"));
  const args = [
    `--user-data-dir=${userDataDir}`,
    // The DevTools port is set per attempt below. Never 0: Chrome marks the browser as automated
    // (navigator.webdriver === true) when the port is 0, headful or not (audit S01, measured on CfT 157).
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    // A desktop window of a normal size; the viewport fits inside it.
    `--window-size=${opts.windowSize ?? "1280,800"}`,
    "--window-position=0,0",
    // Each agent session has its own window (ADR 0017). Under Xvfb a window covered by another reports
    // itself hidden and stops animation frames (measured); a page acted on while hidden is a bot signal.
    "--disable-backgrounding-occluded-windows",
    ...(opts.lang ? [`--lang=${opts.lang}`, `--accept-lang=${opts.lang},${opts.lang.split("-")[0]}`] : []),
    ...securityArgs(opts),
    ...(opts.headless ?? true ? ["--headless=new"] : []),
    ...(opts.hostResolverRules ? [`--host-resolver-rules=${opts.hostResolverRules}`] : []),
    ...extensionArgs(opts.extensions ?? [WS_BLOCK_EXTENSION]),
    ...(opts.extraArgs ?? []),
    "about:blank",
  ];
  let proc: ChildProcess | undefined;
  let wsUrl = "";
  let finalArgs: string[] = [];
  for (let attempt = 0; ; attempt++) {
    // A free loopback port, picked just before launch. If another process takes it first, Chrome
    // can't bind DevTools; that attempt is killed and retried on a new port.
    finalArgs = mergeFeatureFlags([`--remote-debugging-port=${await freeLoopbackPort()}`, ...args]);
    const p = spawn(exe, finalArgs, { stdio: ["ignore", "ignore", "pipe"] });
    track(p);
    try {
      wsUrl = await devtoolsUrl(p);
      proc = p;
      break;
    } catch (e) {
      if (p.exitCode === null) p.kill("SIGKILL");
      if (!(e instanceof PortTaken) || attempt >= 4) throw e;
    }
  }
  proc.stderr!.resume();
  const cdp = await CdpConnection.connect(wsUrl);
  return {
    process: proc,
    cdp,
    wsUrl,
    executablePath: exe,
    args: finalArgs,
    async close() {
      try {
        await cdp.send("Browser.close");
      } catch {
        /* already gone */
      }
      cdp.close();
      if (proc.exitCode === null) {
        await new Promise<void>((r) => {
          const t = setTimeout(() => {
            proc.kill("SIGKILL");
            r();
          }, 3000);
          proc.once("exit", () => {
            clearTimeout(t);
            r();
          });
        });
      }
      if (ownDir) rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
