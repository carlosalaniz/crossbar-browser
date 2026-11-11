// SPDX-License-Identifier: AGPL-3.0-only
// Spike harness: drive a real Chromium through each way a page can send a write,
// and record whether the gate paused it and whether it reached the server anyway.
// Runtime.evaluate is used here only to *drive test pages*; agents never get eval (AGENTS.md "never" 6).
import { launchChrome, findChrome, type LaunchedBrowser } from "../src/launch.ts";
import { NetworkGate, holdNonGet, type GateRequest, type HeldRequest } from "../src/gate.ts";
import { startSite, type Hit } from "./site.ts";

export const chromeAvailable = !!findChrome();
/** In CI a missing browser is a failure, not a skip: these are security tests. */
export const skipReason = chromeAvailable ? false : process.env.CI ? false : "no Chromium found (set CHROME_PATH)";

export interface Env {
  browser: LaunchedBrowser;
  gate: NetworkGate;
  site: Awaited<ReturnType<typeof startSite>>;
  held: HeldRequest[];
  close(): Promise<void>;
}

export async function setup(opts: { holdTimeoutMs?: number; onHeld?: (h: HeldRequest) => void; bypassServiceWorker?: boolean } = {}): Promise<Env> {
  const site = await startSite();
  const browser = await launchChrome({
    hostResolverRules: "MAP *.test 127.0.0.1",
    headless: process.env.CROSSBAR_HEADFUL !== "1",
    extraArgs: process.env.CROSSBAR_TEST_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });
  const held: HeldRequest[] = [];
  const gate = new NetworkGate(browser.cdp, {
    policy: holdNonGet,
    holdTimeoutMs: opts.holdTimeoutMs ?? 1000,
    bypassServiceWorker: opts.bypassServiceWorker,
    onHeld: (h) => {
      held.push(h);
      if (opts.onHeld) opts.onHeld(h);
      else void h.fail();
    },
  });
  await gate.start();
  return {
    browser,
    gate,
    site,
    held,
    async close() {
      gate.stop();
      await browser.close();
      await site.close();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open a page in a new tab and return the gate's session for it. */
export async function openPage(env: Env, url: string): Promise<string> {
  const { targetId } = await env.browser.cdp.send("Target.createTarget", { url: "about:blank" });
  let session: string | undefined;
  for (let i = 0; i < 100 && !session; i++) {
    const infos = await env.browser.cdp.send("Target.getTargets");
    if (infos.targetInfos.some((t) => t.targetId === targetId && t.attached)) {
      session = [...env.gate.attached.values()].find((a) => a.targetId === targetId)?.sessionId;
    }
    if (!session) await sleep(20);
  }
  if (!session) throw new Error("gate never attached to the new page");
  await env.browser.cdp.send("Page.enable", undefined, session);
  const loaded = new Promise<void>((r) => {
    const off = env.browser.cdp.on("Page.loadEventFired", (_p, s) => {
      if (s === session) {
        off();
        r();
      }
    });
  });
  await env.browser.cdp.send("Page.navigate", { url }, session);
  await Promise.race([loaded, sleep(5000)]);
  return session;
}

export async function runCase(env: Env, c: WriteCase): Promise<CaseResult> {
  const session = await openPage(env, env.site.url(c.page[0], c.page[1]));
  await evaluate(env, session, c.trigger.replaceAll("PORT", String(env.site.port))).catch((e) => process.env.SPIKE_DEBUG && console.error(`[${c.name}] ${e.message}`));
  await sleep(c.wait ?? 800);
  return collect(env, c.name);
}

export async function evaluate(env: Env, session: string, expression: string): Promise<unknown> {
  const r = await Promise.race([
    env.browser.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session),
    sleep(5000).then(() => {
      throw new Error(`evaluate timed out: ${expression.slice(0, 60)}`);
    }),
  ]);
  if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

export interface CaseResult {
  name: string;
  /** Non-GET requests for this case that the gate paused. */
  paused: GateRequest[];
  /** Requests for this case that reached the server. */
  reached: Hit[];
  attachedTypes: string[];
}

export function collect(env: Env, name: string): CaseResult {
  const match = (url: string) => new URL(url).searchParams.get("case")?.startsWith(name) ?? false;
  return {
    name,
    paused: env.gate.seen.filter((s) => s.verdict !== "allow" && match(s.request.url)).map((s) => s.request),
    reached: env.site.hits.filter((h) => h.case?.startsWith(name)),
    attachedTypes: [...new Set([...env.gate.attached.values()].map((a) => a.type))],
  };
}

export interface WriteCase {
  name: string;
  /** Page to open (host, path). */
  page: [string, string];
  trigger: string;
  wait?: number;
  /** Measured but not a write the gate must hold (e.g. WebSockets are blocked outright, not held). */
  kind?: "write" | "socket";
}

export const WRITE_CASES: WriteCase[] = [
  { name: "fetch-post", page: ["a.test", "/blank"], trigger: `fetch('/sink?case=fetch-post',{method:'POST',body:'x'}).catch(()=>{})` },
  { name: "xhr-put", page: ["a.test", "/blank"], trigger: `(()=>{const x=new XMLHttpRequest();x.open('PUT','/sink?case=xhr-put');x.send('x')})()` },
  { name: "form-post", page: ["a.test", "/blank"], trigger: `(()=>{const f=document.createElement('form');f.method='post';f.action='/sink?case=form-post';document.body.append(f);f.submit()})()` },
  { name: "form-new-window", page: ["a.test", "/blank"], trigger: `(()=>{const f=document.createElement('form');f.method='post';f.target='_blank';f.action='/sink?case=form-new-window';document.body.append(f);f.submit()})()`, wait: 2000 },
  { name: "beacon", page: ["a.test", "/blank"], trigger: `navigator.sendBeacon('/sink?case=beacon','x')` },
  { name: "ping", page: ["a.test", "/blank"], trigger: `(()=>{const a=document.createElement('a');a.href='/blank?after-ping';a.ping='/sink?case=ping';document.body.append(a);a.click()})()` },
  { name: "keepalive-unload", page: ["a.test", "/blank"], trigger: `fetch('/sink?case=keepalive-unload',{method:'POST',body:'x',keepalive:true});location.href='/blank?gone'` },
  { name: "cors-put", page: ["a.test", "/blank"], trigger: `fetch('http://b.test:PORT/sink?case=cors-put',{method:'PUT',headers:{'x-custom':'1'},body:'x'}).catch(()=>{})` },
  { name: "websocket-page", kind: "socket", page: ["a.test", "/blank"], trigger: `new WebSocket('ws://a.test:PORT/ws?case=websocket-page')` },
  { name: "websocket-worker", kind: "socket", page: ["a.test", "/blank"], trigger: `new Worker(URL.createObjectURL(new Blob(["new WebSocket('ws://a.test:PORT/ws?case=websocket-worker')"],{type:'text/javascript'})))`, wait: 1500 },
  { name: "websocket-iframe", kind: "socket", page: ["a.test", "/iframe-host?ws=1"], trigger: `1`, wait: 1500 },
  { name: "oopif", page: ["a.test", "/iframe-host"], trigger: `1`, wait: 2000 },
  { name: "worker", page: ["a.test", "/blank"], trigger: `new Worker('/worker.js')`, wait: 1500 },
  { name: "shared-worker", page: ["a.test", "/blank"], trigger: `new SharedWorker('/shared.js').port.start()`, wait: 1500 },
  {
    name: "service-worker",
    page: ["localhost", "/sw-host"],
    trigger: `navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(r=>r.active.postMessage('go'))`,
    wait: 2000,
  },
  {
    name: "sw-passthrough",
    page: ["localhost", "/sw-host"],
    trigger: `navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>navigator.serviceWorker.controller?1:new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r))).then(()=>fetch('/sink?case=sw-passthrough',{method:'POST',body:'x'}).catch(()=>{})).then(()=>1)`,
    wait: 1500,
  },
];
