// SPDX-License-Identifier: AGPL-3.0-only
// Local test site. Chrome maps *.test to 127.0.0.1 (host-resolver-rules), so a.test and b.test are
// different sites (cross-site iframes become out-of-process). localhost is used where a secure
// context is required (service workers).
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Hit {
  method: string;
  path: string;
  host: string;
  case: string | null;
}

const html = (body: string) => `<!doctype html><meta charset=utf-8><body>${body}</body>`;

export async function startSite(): Promise<{ port: number; hits: Hit[]; close(): Promise<void>; url(host: string, path: string): string }> {
  const hits: Hit[] = [];
  const record = (req: http.IncomingMessage) => {
    const u = new URL(req.url ?? "/", "http://x");
    hits.push({ method: req.method ?? "", path: u.pathname + u.search, host: req.headers.host ?? "", case: u.searchParams.get("case") });
  };
  let port = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: string, type = "text/html", extra: Record<string, string> = {}) =>
      res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*", ...extra }).end(body);
    req.resume();
    switch (u.pathname) {
      case "/sink":
        record(req);
        return send(200, "ok", "text/plain");
      case "/blank":
        return send(200, html("blank"));
      case "/r307":
        record(req);
        return send(307, "", "text/plain", { location: `/sink?case=${u.searchParams.get("case")}-hop2` });
      case "/r302-cross":
        record(req);
        return send(302, "", "text/plain", { location: `http://b.test:${port}/sink?case=get-redirect-hop2` });
      case "/iframe-host":
        return send(200, html(`<iframe src="http://b.test:${port}/iframe-child${u.search}"></iframe>`));
      case "/iframe-child":
        return u.searchParams.has("ws")
          ? send(200, html(`<script>new WebSocket('ws://b.test:${port}/ws?case=websocket-iframe')</script>`))
          : send(200, html(`<script>fetch('/sink?case=oopif', {method:'POST', body:'x'}).catch(()=>{})</script>`));
      case "/worker.js":
        return send(200, `fetch('/sink?case=worker', {method:'POST', body:'x'}).catch(()=>{})`, "text/javascript");
      case "/shared.js":
        return send(200, `onconnect = () => fetch('/sink?case=shared-worker', {method:'POST', body:'x'}).catch(()=>{})`, "text/javascript");
      case "/sw.js":
        return send(
          200,
          `self.addEventListener('install', () => self.skipWaiting());
           self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
           self.addEventListener('message', () => fetch('/sink?case=service-worker', {method:'POST', body:'x'}).catch(()=>{}));
           self.addEventListener('fetch', (e) => { if (e.request.url.includes('case=sw-passthrough')) e.respondWith(fetch(e.request)); });`,
          "text/javascript",
        );
      case "/sw-host":
        return send(200, html("sw host"));
      case "/password-form":
        return send(
          200,
          html(`<input id=name type=text><input id=pw type=password><input id=cc autocomplete="cc-number"><input id=otp autocomplete="one-time-code">
                <input id=ccname autocomplete="billing cc-name"><input id=sneaky type=text><textarea id=notes></textarea>`),
        );
      default:
        return send(404, "not found", "text/plain");
    }
  });
  server.on("upgrade", (req, socket) => {
    record(req);
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    url: (host, path) => `http://${host}:${port}${path}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
