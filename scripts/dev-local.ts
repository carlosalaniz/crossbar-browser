// SPDX-License-Identifier: AGPL-3.0-only
// `npm run dev:local`: the whole stack in one process, no Docker. Egress proxy, local test site,
// and the app with a local Chromium behind the proxy. The test site answers as http://site-a.test:<port> (all
// scenarios) and http://testsite.test:<port> (browser/ test pages); the port starts at 8090.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { lookup } from "node:dns/promises";
import { createEgressProxy } from "../proxy/src/proxy.ts";
import { devAllowlistFromEnv, devAllowlistWarning } from "../proxy/src/dev-allowlist.ts";
import { createConfiguredTestsite } from "../testsite/src/boot.ts";
import { loadEnv } from "../testsite/src/env.ts";
import { freePort } from "./free-port.mjs";
import { devOrigins } from "./lan.mjs";

// The test site (testsite/) on loopback, answering for every *.test scenario host and testsite.test.
const sitePort = await freePort(8090);
// Same setup as `npm run testsite`, so the live Stripe scenarios work here when testsite/.env has test keys.
const { server: siteServer } = createConfiguredTestsite(loadEnv());
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

// Dev data lives outside the repo, readable only by you (it holds the master key and your logins).
const dataDir = process.env.CROSSBAR_DATA ?? join(homedir(), ".crossbar", "dev");
const legacy = resolve(import.meta.dirname, "../data");
if (!process.env.CROSSBAR_DATA && existsSync(legacy) && !existsSync(dataDir)) {
  mkdirSync(join(homedir(), ".crossbar"), { recursive: true, mode: 0o700 });
  renameSync(legacy, dataDir);
  // The old master key sat in the repo folder; start with a fresh one.
  rmSync(join(dataDir, "master.key"), { force: true });
  console.log(`Moved dev data from ${legacy} to ${dataDir} and rotated its master key.`);
}
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);

const port = process.env.CROSSBAR_PORT ?? String(await freePort(8080));
if (port !== "8080" && !process.env.CROSSBAR_PORT) console.log(`Port 8080 is in use; using ${port}.`);
const app = spawn(process.execPath, [resolve(import.meta.dirname, "../server/src/main.ts")], {
  stdio: "inherit",
  env: {
    ...process.env,
    CROSSBAR_DATA: dataDir,
    CROSSBAR_PORT: port,
    // LAN address first, so notification links open on a phone on the same Wi-Fi.
    CROSSBAR_ORIGIN: devOrigins(port),
    CROSSBAR_PROXY: proxyUrl,
    // Chromium resolves nothing itself; the proxy does all DNS.
    CROSSBAR_HOST_RESOLVER_RULES: "MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    // A visible Chrome, like production (sites block headless browsers). CROSSBAR_HEADLESS=1 to hide it.
    CROSSBAR_HEADLESS: process.env.CROSSBAR_HEADLESS ?? "0",
    CROSSBAR_PACE_MS: process.env.CROSSBAR_PACE_MS ?? "1000",
    // The test site's sign-in provider (testsite/README.md). Only tightens.
    CROSSBAR_SIGNIN_PROVIDERS: process.env.CROSSBAR_SIGNIN_PROVIDERS ?? "accounts.idp.test",
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
