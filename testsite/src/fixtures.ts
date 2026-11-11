// SPDX-License-Identifier: AGPL-3.0-only
// `npm run testsite:fixtures`: saves every challenge page the test site serves (offline mode) into
// detect/fixtures/testsite/ as HTML plus a minimal HAR, with an index of the expected BlockState kind.
// Output is deterministic (no cookies, no dates), so re-running it produces no diff.
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createTestsite } from "./app.ts";
import { PROVIDERS } from "./gate.ts";

export interface FixtureSpec {
  name: string;
  host: string;
  path: string;
  /** Expected detect() kind, or null for "no block". */
  expect: "captcha" | "login" | "consent" | "soft_block" | null;
  note?: string;
}

export function fixtureSpecs(): FixtureSpec[] {
  const specs: FixtureSpec[] = [];
  for (const p of PROVIDERS) {
    specs.push({ name: `${p}-widget`, host: "site-a.test", path: `/gated/article?mode=always&style=widget&provider=${p}`, expect: "captcha" });
    specs.push({ name: `${p}-interstitial`, host: "site-a.test", path: `/gated/article?mode=always&style=interstitial&provider=${p}`, expect: "captcha" });
  }
  specs.push(
    { name: "turnstile-interstitial-503", host: "site-a.test", path: "/gated/article?mode=always&style=interstitial&provider=turnstile&status=503", expect: "captcha" },
    { name: "status-403", host: "site-a.test", path: "/gated/article?mode=always&style=status&status=403", expect: "soft_block" },
    { name: "status-429", host: "site-a.test", path: "/gated/article?mode=always&style=status&status=429", expect: "soft_block" },
    { name: "status-503", host: "site-a.test", path: "/gated/article?mode=always&style=status&status=503", expect: "soft_block" },
    { name: "login", host: "site-a.test", path: "/login?next=%2Fmembers%2Farticle", expect: "login" },
    { name: "login-captcha", host: "site-a.test", path: "/login?mode=always&provider=recaptcha", expect: "captcha", note: "captcha outranks login" },
    { name: "register", host: "site-a.test", path: "/register", expect: "captcha" },
    { name: "wrong-origin-login", host: "site-b.test", path: "/embedded-login?for=site-a.test", expect: "login" },
    { name: "consent-wall", host: "site-b.test", path: "/consent-wall", expect: "consent" },
    { name: "soft-block-200", host: "site-a.test", path: "/soft-block/post", expect: null, note: "GAP: a 200 soft block; no signature matches it today" },
    { name: "gated-article-pass", host: "site-a.test", path: "/gated/article?mode=never", expect: null },
  );
  return specs;
}

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function get(port: number, host: string, path: string): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (k !== "set-cookie" && k !== "date" && k !== "x-testsite-gate" && typeof v === "string") headers[k] = v;
        resolve({ status: res.statusCode ?? 0, headers, body });
      });
    });
    r.on("error", reject);
    r.end();
  });
}

function har(url: string, c: Captured): unknown {
  return {
    log: {
      version: "1.2",
      creator: { name: "crossbar-testsite", version: "1" },
      entries: [
        {
          request: { method: "GET", url, httpVersion: "HTTP/1.1", headers: [], queryString: [...new URL(url).searchParams].map(([name, value]) => ({ name, value })), cookies: [], headersSize: -1, bodySize: 0 },
          response: {
            status: c.status,
            statusText: http.STATUS_CODES[c.status] ?? "",
            httpVersion: "HTTP/1.1",
            headers: Object.entries(c.headers).map(([name, value]) => ({ name, value })),
            cookies: [],
            content: { size: Buffer.byteLength(c.body), mimeType: c.headers["content-type"] ?? "", text: c.body },
            redirectURL: c.headers.location ?? "",
            headersSize: -1,
            bodySize: Buffer.byteLength(c.body),
          },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
        },
      ],
    },
  };
}

export async function writeFixtures(outDir: URL): Promise<number> {
  const { server } = createTestsite({ env: {}, captcha: "offline" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  mkdirSync(outDir, { recursive: true });
  const index: Array<FixtureSpec & { url: string; status: number; html: string; har: string }> = [];
  try {
    for (const s of fixtureSpecs()) {
      const c = await get(port, s.host, s.path);
      const url = `http://${s.host}${s.path}`;
      writeFileSync(new URL(`${s.name}.html`, outDir), c.body);
      writeFileSync(new URL(`${s.name}.har`, outDir), JSON.stringify(har(url, c), null, 2) + "\n");
      index.push({ ...s, url, status: c.status, html: `${s.name}.html`, har: `${s.name}.har` });
    }
  } finally {
    server.close();
  }
  writeFileSync(new URL("index.json", outDir), JSON.stringify({ $comment: "Generated by npm run testsite:fixtures. Do not edit by hand.", fixtures: index }, null, 2) + "\n");
  return index.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL("../../detect/fixtures/testsite/", import.meta.url);
  const n = await writeFixtures(out);
  console.log(`wrote ${n} fixtures to ${out.pathname}`);
}
