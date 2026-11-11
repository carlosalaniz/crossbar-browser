// SPDX-License-Identifier: AGPL-3.0-only
// Egress proxy: the browser's only way out (Access Model L1, ADR 0008).
// It resolves DNS itself, checks every resolved address, and connects to the address it checked,
// so a DNS answer that changes between check and connect (rebinding) can't reach a private range.
import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { checkAddress, type AddressPolicyOptions } from "./ip.ts";

export type Resolver = (host: string) => Promise<string[]>;
export type Connector = (ip: string, port: number) => net.Socket;

export interface ProxyDecision {
  kind: "connect" | "http";
  host: string;
  port: number;
  addresses: string[];
  dialed?: string;
  allowed: boolean;
  reason?: string;
}

export interface EgressProxyOptions extends AddressPolicyOptions {
  resolve?: Resolver;
  connect?: Connector;
  allowedPorts?: number[];
  onDecision?: (d: ProxyDecision) => void;
}

const defaultResolve: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
const defaultConnect: Connector = (ip, port) => net.connect({ host: ip, port });

/** Normalises a host the way a URL parser would (decimal/hex IPv4, brackets on IPv6). */
export function normaliseHost(host: string): string | null {
  try {
    const h = new URL(`http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}/`).hostname;
    return h.startsWith("[") ? h.slice(1, -1) : h;
  } catch {
    return null;
  }
}

type Target = { ok: true; ip: string; addresses: string[] } | { ok: false; reason: string; addresses: string[] };

export function createEgressProxy(opts: EgressProxyOptions = {}): http.Server {
  const resolve = opts.resolve ?? defaultResolve;
  const connect = opts.connect ?? defaultConnect;
  const ports = new Set(opts.allowedPorts ?? [80, 443]);

  async function decide(rawHost: string, port: number): Promise<Target> {
    const host = normaliseHost(rawHost);
    if (!host) return { ok: false, reason: "bad-host", addresses: [] };
    if (!ports.has(port)) return { ok: false, reason: `port-${port}-not-allowed`, addresses: [] };
    let addresses: string[];
    if (net.isIP(host)) addresses = [host];
    else {
      try {
        addresses = await resolve(host);
      } catch {
        return { ok: false, reason: "dns-failed", addresses: [] };
      }
    }
    if (addresses.length === 0) return { ok: false, reason: "dns-empty", addresses };
    // Every answer must pass; a mixed answer is treated as an attack.
    for (const a of addresses) {
      const v = checkAddress(a, opts);
      if (!v.allowed) return { ok: false, reason: `${v.reason}:${a}`, addresses };
    }
    return { ok: true, ip: addresses[0]!, addresses };
  }

  const server = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("absolute-form URL required");
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(403, { "x-crossbar-deny": "scheme" }).end();
      return;
    }
    const port = Number(url.port || 80);
    const t = await decide(url.hostname, port);
    opts.onDecision?.({ kind: "http", host: url.hostname, port, addresses: t.addresses, dialed: t.ok ? t.ip : undefined, allowed: t.ok, reason: t.ok ? undefined : t.reason });
    if (!t.ok) {
      res.writeHead(403, { "x-crossbar-deny": t.reason }).end(`crossbar: refused (${t.reason})`);
      return;
    }
    // RFC 9112 §3.2.2: the absolute-form authority wins over any Host header.
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: url.host };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request({
      method: req.method,
      path: url.pathname + url.search,
      headers,
      createConnection: () => connect(t.ip, port),
    });
    upstream.on("response", (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const authority = req.url ?? "";
    const idx = authority.lastIndexOf(":");
    const rawHost = idx > 0 ? authority.slice(0, idx) : authority;
    const port = Number(idx > 0 ? authority.slice(idx + 1) : NaN);
    const t = Number.isInteger(port) ? await decide(rawHost, port) : ({ ok: false, reason: "bad-port", addresses: [] } as Target);
    opts.onDecision?.({ kind: "connect", host: rawHost, port, addresses: t.addresses, dialed: t.ok ? t.ip : undefined, allowed: t.ok, reason: t.ok ? undefined : t.reason });
    client.on("error", () => {});
    if (!t.ok) {
      client.end(`HTTP/1.1 403 Forbidden\r\nx-crossbar-deny: ${t.reason}\r\ncontent-length: 0\r\n\r\n`);
      return;
    }
    const upstream = connect(t.ip, port);
    upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n"));
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });

  return server;
}
