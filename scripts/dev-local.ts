// SPDX-License-Identifier: AGPL-3.0-only
// `npm run dev:local`: the whole stack in one process, no Docker. Egress proxy, local test site,
// and the app with a local Chromium behind the proxy. The test site is reachable as http://testsite.test:8090.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { lookup } from "node:dns/promises";
import { createEgressProxy } from "../proxy/src/proxy.ts";
import { startSite } from "../browser/test/site.ts";

const site = await startSite({ port: 8090 });
const proxy = createEgressProxy({
  // The test site lives on loopback; only the exact name "testsite.test" may reach it.
  resolve: async (h) => (h === "testsite.test" ? ["127.0.0.1"] : (await lookup(h, { all: true, verbatim: true })).map((a) => a.address)),
  devAllowPrivateHosts: ["testsite.test"],
  onDecision: (d) => !d.allowed && console.log(`proxy refused ${d.kind} ${d.host}:${d.port} (${d.reason})`),
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
console.log(`egress proxy ${proxyUrl}; test site http://testsite.test:${site.port}/pages/article`);

const port = process.env.CROSSBAR_PORT ?? "8080";
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
