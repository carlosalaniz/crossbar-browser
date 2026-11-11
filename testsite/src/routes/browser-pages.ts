// SPDX-License-Identifier: AGPL-3.0-only
// testsite.test: the browser/ test pages (article, infinite feed, virtual list, login, inbox, ws/lan
// probes, ads, saved fixtures), used by scripts/stack-smoke.ts and scripts/agent-smoke.ts. They live in
// browser/test/site.ts; this forwards to an in-process instance of it, so one container and one proxy
// allowlist serve both. Its requests are logged like any other host's.
import http from "node:http";
import type { Router } from "../app.ts";
import { send } from "../context.ts";

let upstream: Promise<number> | undefined;

async function upstreamPort(): Promise<number> {
  upstream ??= (async () => {
    const { startSite } = await import("../../../browser/test/site.ts");
    return (await startSite({ host: "127.0.0.1", port: 0 })).port;
  })();
  return upstream;
}

export function registerBrowserPages(r: Router): void {
  r.add("testsite.test", "*", /^\/.*/, async (ctx) => {
    const port = await upstreamPort();
    await new Promise<void>((resolve) => {
      const up = http.request(
        { host: "127.0.0.1", port, method: ctx.method, path: ctx.url.pathname + ctx.url.search, headers: { ...ctx.req.headers } },
        (res) => {
          ctx.res.writeHead(res.statusCode ?? 502, res.headers);
          res.pipe(ctx.res);
          res.on("end", resolve);
        },
      );
      up.on("error", () => {
        send(ctx, 502, "browser test pages unavailable", { "content-type": "text/plain" });
        resolve();
      });
      up.end(ctx.rawBody);
    });
  });
}
