// SPDX-License-Identifier: AGPL-3.0-only
// Launches Chromium with the flags the Access Model requires.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CdpConnection } from "./cdp.ts";

export interface LaunchOptions {
  executablePath?: string;
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
    "--disable-features=DnsOverHttps,AsyncDns",
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

export async function launchChrome(opts: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const exe = opts.executablePath ?? findChrome();
  if (!exe) throw new Error("No Chromium found. Set CHROME_PATH.");
  const ownDir = !opts.userDataDir;
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), "crossbar-profile-"));
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    ...securityArgs(opts),
    ...(opts.headless ?? true ? ["--headless=new"] : []),
    ...(opts.hostResolverRules ? [`--host-resolver-rules=${opts.hostResolverRules}`] : []),
    ...extensionArgs(opts.extensions ?? [WS_BLOCK_EXTENSION]),
    ...(opts.extraArgs ?? []),
    "about:blank",
  ];
  const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${buf.slice(-500)}`)), 15000);
    proc.stderr!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    proc.once("exit", (code) => reject(new Error(`Chrome exited (${code}): ${buf.slice(-500)}`)));
  });
  proc.stderr!.resume();
  const cdp = await CdpConnection.connect(wsUrl);
  return {
    process: proc,
    cdp,
    executablePath: exe,
    args,
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
