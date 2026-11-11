// SPDX-License-Identifier: AGPL-3.0-only
// The dev-only test-site allowlist: off unless CROSSBAR_DEV_TESTSITE=1, impossible in a production
// build, pinned to the test site's address, and never covering a LAN-block target.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawnSync, spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEgressProxy, type ProxyDecision } from "../src/proxy.ts";
import { allowlisted, devAllowlistFromEnv, isProductionBuild, DEV_TESTSITE_HOSTS } from "../src/dev-allowlist.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

test("allowlist is off unless CROSSBAR_DEV_TESTSITE=1", () => {
  assert.equal(devAllowlistFromEnv({}), null);
  assert.equal(devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "0" }), null);
  assert.equal(devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "" }), null);
  assert.throws(() => devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "true" }), /must be 1 or unset/);
  const a = devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "1" });
  assert.ok(a);
  assert.equal(a.target, "testsite");
});

test("allowlist cannot be turned on in a production build", () => {
  // The image marker wins over any environment.
  const dir = mkdtempSync(join(tmpdir(), "cb-prod-"));
  const marker = join(dir, "PRODUCTION_BUILD");
  writeFileSync(marker, "");
  assert.equal(isProductionBuild({}, marker), true);
  assert.throws(() => devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "1", CROSSBAR_BUILD: "dev", NODE_ENV: "development" }, marker), /production build/);
  assert.equal(isProductionBuild({}, join(dir, "absent")), false);
  assert.equal(isProductionBuild({ NODE_ENV: "production" }), true);
  assert.equal(isProductionBuild({ CROSSBAR_BUILD: "production" }), true);
  assert.throws(() => devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "1", NODE_ENV: "production" }), /production build/);
  assert.throws(() => devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "1", CROSSBAR_BUILD: "production" }), /production build/);
});

test("the proxy process refuses to start with the allowlist in a production build", () => {
  for (const prod of [{ NODE_ENV: "production" }, { CROSSBAR_BUILD: "production" }]) {
    const r = spawnSync(process.execPath, [MAIN], { env: { PATH: process.env.PATH, CROSSBAR_DEV_TESTSITE: "1", CROSSBAR_PROXY_PORT: "0", ...prod }, encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stderr: ${r.stderr}`);
    assert.match(r.stderr, /not allowed in a production build/);
  }
});

test("the proxy process logs a loud warning when the allowlist is on", async () => {
  const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH, CROSSBAR_DEV_TESTSITE: "1", CROSSBAR_PROXY_PORT: "0", CROSSBAR_PROXY_BIND: "127.0.0.1" } });
  let out = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`proxy never reported listening; output: ${out}`)), 10_000);
      const onData = (c: Buffer) => {
        out += c;
        if (/egress proxy on .*DEV ALLOWLIST ON/.test(out)) {
          clearTimeout(t);
          resolve();
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (code) => reject(new Error(`proxy exited ${code}; output: ${out}`)));
    });
  } finally {
    child.kill();
  }
  assert.match(out, /DEV-ONLY ALLOWLIST IS ON/);
});

test("allowlist matches exact test-site names only", () => {
  const a = devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "1" });
  assert.equal(allowlisted(a, "site-a.test"), true);
  assert.equal(allowlisted(a, "SITE-A.TEST."), true);
  assert.equal(allowlisted(a, "evil.site-a.test"), false);
  assert.equal(allowlisted(a, "loopback.test"), false);
  assert.equal(allowlisted(a, "10.0.0.1"), false);
  assert.equal(allowlisted(null, "site-a.test"), false);
  assert.ok(!DEV_TESTSITE_HOSTS.some((h) => h.includes("*")), "no wildcards");
});

// --- A real proxy with the allowlist on --------------------------------------------------------

const TESTSITE_IP = "172.20.0.5"; // a private compose address: refused without the allowlist
const zones: Record<string, string[]> = {
  testsite: [TESTSITE_IP],
  // A hostile DNS answer for an allowlisted name must be ignored: the name is pinned, not resolved.
  "site-a.test": ["169.254.169.254"],
  "loopback.test": ["127.0.0.1"],
  "public.example": ["93.184.216.34"],
};

let origin: http.Server;
let originPort: number;
const servers: http.Server[] = [];
const dialed: string[] = [];

function makeProxy(devAllowlist: ReturnType<typeof devAllowlistFromEnv>, decisions: ProxyDecision[]): Promise<number> {
  const p = createEgressProxy({
    resolve: async (h) => {
      const z = zones[h];
      if (!z) throw new Error("NXDOMAIN");
      return z;
    },
    connect: (ip) => {
      dialed.push(ip);
      assert.equal(ip, TESTSITE_IP, `proxy dialed ${ip}, which it should have refused`);
      return net.connect({ host: "127.0.0.1", port: originPort });
    },
    devAllowlist,
    onDecision: (d) => decisions.push(d),
  });
  servers.push(p);
  return new Promise((r) => p.listen(0, "127.0.0.1", () => r((p.address() as AddressInfo).port)));
}

function via(proxyPort: number, url: string): Promise<{ status: number; deny?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, path: url, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, deny: res.headers["x-crossbar-deny"] as string | undefined, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  origin = http.createServer((req, res) => res.end(`testsite saw ${req.headers.host}`));
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as AddressInfo).port;
});
after(() => {
  for (const s of servers) s.close();
  origin.close();
});

test("with the allowlist on, test-site names reach only the test site (pinned, not resolved)", async () => {
  const d: ProxyDecision[] = [];
  const port = await makeProxy(devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "1" }), d);
  for (const h of ["site-a.test", "site-b.test", "exfil.test", "accounts.idp.test"]) {
    const r = await via(port, `http://${h}/`);
    assert.equal(r.status, 200, `${h}: ${r.deny}`);
    assert.equal(r.body, `testsite saw ${h}`);
  }
  assert.ok(d.every((x) => x.dialed === undefined || x.dialed === TESTSITE_IP));
});

test("with the allowlist on, every LAN-block target is still refused after resolution", async () => {
  const d: ProxyDecision[] = [];
  const port = await makeProxy(devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "1" }), d);
  const targets = [
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://2852039166/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://100.100.100.100/",
    "http://0x7f000001/",
    "http://loopback.test/",
    "http://192.168.1.1/",
    `http://${TESTSITE_IP}/`, // the test site's own IP literal is not allowlisted either
  ];
  for (const t of targets) {
    const r = await via(port, t);
    assert.equal(r.status, 403, `${t} was not refused`);
    assert.ok(r.deny, `${t}: no deny reason`);
  }
});

test("with the allowlist on, other ports on test-site names are refused unless configured", async () => {
  const d: ProxyDecision[] = [];
  const off = await makeProxy(devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "1" }), d);
  assert.equal((await via(off, "http://site-a.test:8090/")).status, 403);
  const on = await makeProxy(devAllowlistFromEnv({ CROSSBAR_DEV_TESTSITE: "1", CROSSBAR_DEV_TESTSITE_PORT: "8090" }), d);
  assert.equal((await via(on, "http://site-a.test:8090/")).status, 200);
  assert.equal((await via(on, "http://public.example:8090/")).status, 403, "the extra port is for test-site names only");
});

test("without the allowlist, test-site names are refused like any private address", async () => {
  const d: ProxyDecision[] = [];
  const port = await makeProxy(null, d);
  const r = await via(port, "http://site-a.test/");
  assert.equal(r.status, 403);
  assert.match(r.deny ?? "", /link-local-metadata/);
});

test("the production proxy image is marked; only proxy-dev removes the marker", () => {
  const df = readFileSync(new URL("../../deploy/Dockerfile", import.meta.url), "utf8");
  const stage = (name: string) => df.split(/^FROM /m).find((s) => new RegExp(`AS ${name}\\s`).test(s.split("\n")[0] + "\n")) ?? "";
  assert.match(stage("proxy"), /PRODUCTION_BUILD/, "proxy stage writes the marker");
  assert.match(stage("proxy"), /CROSSBAR_BUILD=production/);
  assert.match(stage("proxy-dev"), /rm -f[^\n]*PRODUCTION_BUILD/, "proxy-dev removes it");
  assert.ok(!/devAllowPrivateHosts|CROSSBAR_DEV_ALLOW_PRIVATE_HOSTS/.test(df));
});
