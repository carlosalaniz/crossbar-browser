// SPDX-License-Identifier: AGPL-3.0-only
// Browser host: runs in the browser container (internal network only). Launches Chromium per
// (user, profile) with the egress proxy, and relays CDP to the app. It holds no tokens, keys or database.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { launchChrome, type LaunchedBrowser } from "./launch.ts";
import { seedPreferences } from "./pool.ts";

const env = process.env;
const secret = env.CROSSBAR_BROWSER_SECRET ?? "";
if (secret.length < 16) {
  console.error("CROSSBAR_BROWSER_SECRET must be set (16+ characters).");
  process.exit(1);
}
const profilesDir = env.CROSSBAR_PROFILES ?? "/profiles";
const proxy = env.CROSSBAR_PROXY;
if (!proxy && env.CROSSBAR_ALLOW_NO_PROXY !== "1") {
  console.error("CROSSBAR_PROXY must be set: the egress proxy is the browser's only way out.");
  process.exit(1);
}
const headless = env.CROSSBAR_HEADLESS === "1";

interface Running {
  b: LaunchedBrowser;
  wsUrl: string;
}
const running = new Map<string, Promise<Running>>();

function ok(given: string | undefined): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function launch(userId: string, profile: string): Promise<Running> {
  const dir = join(profilesDir, userId.replace(/[^\w-]/g, "_"), profile === "personal" ? "personal" : "anon");
  mkdirSync(dir, { recursive: true });
  seedPreferences(dir);
  const b = await launchChrome({
    userDataDir: dir,
    proxyServer: proxy,
    headless,
    extraArgs: [...(env.CROSSBAR_CHROME_ARGS ? env.CROSSBAR_CHROME_ARGS.split(" ") : []), "--disable-dev-shm-usage"],
  });
  const v = (await b.cdp.send("Browser.getVersion")) as { product: string };
  console.log(`launched ${v.product} for ${userId}/${profile}`);
  // The relay opens its own socket per client; the launcher's connection stays for lifecycle only.
  return { b, wsUrl: b.wsUrl };
}

const server = http.createServer(async (req, res) => {
  if (!ok(req.headers["x-crossbar-secret"] as string | undefined)) return void res.writeHead(401).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  try {
    if (req.method === "POST" && req.url === "/launch") {
      const id = `${body.userId}:${body.profile}`;
      let r = running.get(id);
      if (!r) {
        r = launch(String(body.userId), String(body.profile));
        r.catch(() => running.delete(id));
        running.set(id, r);
        r.then((x) => x.b.process.once("exit", () => running.delete(id))).catch(() => {});
      }
      await r;
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id }));
    }
    if (req.method === "POST" && req.url === "/close") {
      const r = running.get(String(body.id));
      running.delete(String(body.id));
      if (r) await (await r).b.close();
      return void res.writeHead(200).end("{}");
    }
    if (req.method === "GET" && req.url === "/healthz") return void res.writeHead(200).end("ok");
    res.writeHead(404).end();
  } catch (e) {
    res.writeHead(500).end((e as Error).message);
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
server.on("upgrade", async (req, socket, head) => {
  const u = new URL(req.url ?? "/", "http://x");
  const m = /^\/cdp\/(.+)$/.exec(u.pathname);
  if (!m || !ok(u.searchParams.get("secret") ?? undefined)) return socket.destroy();
  const r = running.get(decodeURIComponent(m[1]!));
  if (!r) return socket.destroy();
  const { wsUrl } = await r;
  const upstream = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  upstream.once("open", () =>
    wss.handleUpgrade(req, socket, head, (client) => {
      client.on("message", (d, isBinary) => upstream.send(d, { binary: isBinary }));
      upstream.on("message", (d, isBinary) => client.send(d, { binary: isBinary }));
      client.on("close", () => upstream.close());
      upstream.on("close", () => client.close());
    }),
  );
  upstream.once("error", () => socket.destroy());
});

const port = Number(env.CROSSBAR_BROWSER_PORT ?? 9300);
server.listen(port, "0.0.0.0", () => console.log(`browser host on :${port} (proxy ${proxy ?? "none"}, headless ${headless})`));
