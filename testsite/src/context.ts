// SPDX-License-Identifier: AGPL-3.0-only
// Per-request context: logical host, cookies, parsed body, session, and link building.
import type http from "node:http";
import { randomBytes } from "node:crypto";

/** The hostnames the site answers for. Each is its own registrable domain (`.test` is reserved, RFC 2606). */
export const HOSTS = [
  "site-a.test",
  "site-b.test",
  "site-c.test",
  "exfil.test",
  "tracker.test",
  "accounts.idp.test",
  "captcha.test",
  // The browser/ test pages (browser/test/site.ts), forwarded in-process. Used by the stack smoke scripts.
  "testsite.test",
] as const;
export type Host = (typeof HOSTS)[number];

export interface Session {
  id: string;
  user?: string;
  /** Username that passed the password step but still owes a TOTP code. */
  pendingTotp?: string;
  createdAt: number;
}

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  method: string;
  /** Logical host, e.g. `site-a.test`, whatever suffix or port the request arrived with. */
  host: Host;
  /** How the request reached us: the suffix after the logical host (".localhost" or "") and the port. */
  via: { suffix: string; port: string; scheme: string };
  cookies: Record<string, string>;
  body: Record<string, string>;
  rawBody: Buffer;
  ip: string;
  session: Session;
}

/**
 * Maps a Host header to a logical host. Accepts `site-a.test`, `site-a.test:8090`, and
 * `site-a.test.localhost:8090` (browsers resolve `*.localhost` to loopback, so a person can open
 * every host locally without editing /etc/hosts). Anything else falls back to `site-a.test`.
 */
export function parseHost(header: string | undefined): { host: Host; suffix: string; port: string } {
  const raw = (header ?? "").toLowerCase();
  const m = /^(.*?)(?::(\d+))?$/.exec(raw.startsWith("[") ? "" : raw)!;
  let name = m[1] ?? "";
  const port = m[2] ?? "";
  let suffix = "";
  if (name.endsWith(".localhost")) {
    suffix = ".localhost";
    name = name.slice(0, -".localhost".length);
  }
  if ((HOSTS as readonly string[]).includes(name)) return { host: name as Host, suffix, port };
  return { host: "site-a.test", suffix: "", port };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function parseBody(raw: Buffer, contentType: string | undefined): Record<string, string> {
  if (!raw.length) return {};
  const ct = (contentType ?? "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const v = JSON.parse(raw.toString("utf8")) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(v)) out[k] = typeof val === "string" ? val : JSON.stringify(val);
        return out;
      }
      return {};
    }
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("text/plain") || !ct) {
      return Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
    }
    if (ct.includes("multipart/form-data")) {
      // Field names only; the log records keys, never values.
      const out: Record<string, string> = {};
      for (const m of raw.toString("latin1").matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)/g)) out[m[1]!] = m[2]!;
      return out;
    }
  } catch {
    /* malformed bodies are logged with no keys */
  }
  return {};
}

export function newId(bytes = 12): string {
  return randomBytes(bytes).toString("base64url");
}

/** Absolute URL to `path` on another logical host, reached the same way this request arrived. */
export function hostUrl(ctx: Pick<Ctx, "via">, host: Host | string, path = "/"): string {
  const port = ctx.via.port ? `:${ctx.via.port}` : "";
  return `${ctx.via.scheme}://${host}${ctx.via.suffix}${port}${path}`;
}

export function send(ctx: Ctx, status: number, body: string | Buffer, headers: Record<string, string | string[]> = {}): void {
  if (ctx.res.headersSent) return;
  ctx.res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  ctx.res.end(body);
}

export function json(ctx: Ctx, status: number, value: unknown, headers: Record<string, string> = {}): void {
  send(ctx, status, JSON.stringify(value, null, 2), { "content-type": "application/json", ...headers });
}

export function redirect(ctx: Ctx, location: string, status = 302, headers: Record<string, string | string[]> = {}): void {
  send(ctx, status, "", { location, ...headers });
}

export function appendCookie(ctx: Ctx, cookie: string): void {
  const prev = ctx.res.getHeader("set-cookie");
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  ctx.res.setHeader("set-cookie", [...list, cookie]);
}
