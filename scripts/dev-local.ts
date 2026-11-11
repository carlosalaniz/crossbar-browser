// SPDX-License-Identifier: AGPL-3.0-only
// `npm run dev:local`: the whole stack in one process, no Docker. Egress proxy, local test site,
// and the app with a local Chromium behind the proxy. The test site answers as http://site-a.test:<port> (all
// scenarios) and http://testsite.test:<port> (browser/ test pages); the port starts at 8090.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { lookup } from "node:dns/promises";
import { createEgressProxy } from "../proxy/src/proxy.ts";
import { devAllowlistFromEnv, devAllowlistWarning } from "../proxy/src/dev-allowlist.ts";
import { createTestsite } from "../testsite/src/app.ts";
import { loadEnv } from "../testsite/src/env.ts";
import { freePort } from "./free-port.mjs";

// The test site (testsite/) on loopback, answering for every *.test scenario host and testsite.test.
const sitePort = await freePort(8090);
const { server: siteServer } = createTestsite({ env: loadEnv() });
await new Promise<void>((r) => siteServer.listen(sitePort, "127.0.0.1", r));
const site = { port: sitePort, close: () => new Promise<void>((r) => siteServer.close(() => r())) };
// Dev-only allowlist: the test-site names are pinned to 127.0.0.1:<sitePort>; everything else is checked as usual.
const devAllowlist = devAllowlistFromEnv({ ...process.env, CROSSBAR_DEV_TESTSITE: "1", CROSSBAR_DEV_TESTSITE_TARGET: "127.0.0.1", CROSSBAR_DEV_TESTSITE_PORT: String(sitePort) });
console.warn(devAllowlistWarning(devAllowlist!));
const proxy = createEgressProxy({
  resolve: async (h) => (await lookup(h, { all: true, verbatim: true })).map((a) => a.address),
  devAllowlist,
  onDecision: (d) => !d.allowed && console.log(`proxy refused ${d.kind} ${d.host}:${d.port} (${d.reason})`),
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
console.log(`egress proxy ${proxyUrl}; test site http://site-a.test:${site.port}/ and http://testsite.test:${site.port}/pages/article`);

const port = process.env.CROSSBAR_PORT ?? String(await freePort(8080));
if (port !== "8080" && !process.env.CROSSBAR_PORT) console.log(`Port 8080 is in use; using ${port}.`);
const app = spawn(process.execPath, [resolve(import.meta.dirname, "../server/src/main.ts")], {
  stdio: "inherit",
  env: {
    ...process.env,
    CROSSBAR_DATA: process.env.CROSSBAR_DATA ?? resolve(import.meta.dirname, "../data"),
    CROSSBAR_PORT: port,
    CROSSBAR_ORIGIN: process.env.CROSSBAR_ORIGIN ?? `http://localhost:${port}`,
    CROSSBAR_PROXY: proxyUrl,
    // Chromium resolves nothing itself; the proxy does all DNS.
    CROSSBAR_HOST_RESOLVER_RULES: "MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    CROSSBAR_HEADLESS: process.env.CROSSBAR_HEADLESS ?? "1",
    CROSSBAR_PACE_MS: process.env.CROSSBAR_PACE_MS ?? "1000",
  },
});
const stop = () => {
  app.kill();
  proxy.close();
  void site.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
app.on("exit", (code) => {
  proxy.close();
  void site.close();
  process.exit(code ?? 0);
});
