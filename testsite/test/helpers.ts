// SPDX-License-Identifier: AGPL-3.0-only
// Test client for the test site: sets the Host header (fetch can't), keeps a cookie jar per client.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createTestsite, type TestsiteOptions, type App } from "../src/app.ts";
import type { PageFactsLike } from "@crossbar/detect";

export interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export async function startSite(opts: TestsiteOptions = {}): Promise<{ app: App; port: number; close: () => Promise<void> }> {
  const { server, app } = createTestsite({ env: {}, ...opts });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { app, port, close: () => new Promise((r) => server.close(() => r())) };
}

export class Client {
  jar = new Map<string, Map<string, string>>(); // host -> cookies
  readonly port: number;
  constructor(port: number) {
    this.port = port;
  }

  async req(host: string, path: string, opts: { method?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
    const cookies = this.jar.get(host) ?? new Map();
    const body = opts.form ? new URLSearchParams(opts.form).toString() : opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
    const headers: Record<string, string> = { host, ...(opts.headers ?? {}) };
    if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (opts.form) headers["content-type"] = "application/x-www-form-urlencoded";
    if (opts.json !== undefined) headers["content-type"] = "application/json";
    return new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port: this.port, path, method: opts.method ?? (body ? "POST" : "GET"), headers }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          for (const c of [res.headers["set-cookie"] ?? []].flat()) {
            const [kv] = c.split(";");
            const i = kv!.indexOf("=");
            cookies.set(kv!.slice(0, i), kv!.slice(i + 1));
          }
          this.jar.set(host, cookies);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data });
        });
      });
      r.on("error", reject);
      r.end(body);
    });
  }

  get(host: string, path: string) {
    return this.req(host, path);
  }
  post(host: string, path: string, form: Record<string, string> = {}) {
    return this.req(host, path, { form, method: "POST" });
  }
  /** The harness answers on localhost only. */
  harness(path: string, opts: Parameters<Client["req"]>[2] = {}) {
    return this.req(`localhost:${this.port}`, path, opts);
  }
}

/** What browser/ would observe, approximated from the HTML (for detect/ checks without a browser). */
export function factsFrom(url: string, r: Res): PageFactsLike {
  const html = r.body;
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) if (typeof v === "string") headers[k] = v;
  return {
    url,
    title,
    status: r.status,
    headers,
    frameUrls: [url, ...[...html.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"))],
    hasPasswordField: /type="password"/i.test(html),
    hasOtpField: /autocomplete="one-time-code"/i.test(html),
    textLength: text.length,
    textSample: text.slice(0, 2000),
  };
}
