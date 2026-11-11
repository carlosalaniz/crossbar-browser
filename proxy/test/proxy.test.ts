// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests: a real proxy with a fake resolver, dialing a local origin.
// The connector maps the *checked public IP* to the local origin, so we can assert the proxy
// dials exactly the address it checked without touching the internet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { createEgressProxy, type ProxyDecision } from "../src/proxy.ts";

const PUBLIC_IP = "93.184.216.34";
const zones: Record<string, string[]> = {
  "public.test": [PUBLIC_IP],
  "lan.test": ["192.168.1.10"],
  "rebind.test": [PUBLIC_IP, "10.0.0.1"],
  "metadata.test": ["169.254.169.254"],
  "mapped.test": ["::ffff:127.0.0.1"],
};

let origin: http.Server;
let originPort: number;
let proxy: http.Server;
let proxyPort: number;
const dialed: string[] = [];
const decisions: ProxyDecision[] = [];

before(async () => {
  origin = http.createServer((req, res) => res.end(`origin saw ${req.method} ${req.url} host=${req.headers.host}`));
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as AddressInfo).port;
  proxy = createEgressProxy({
    resolve: async (h) => {
      const z = zones[h];
      if (!z) throw new Error("NXDOMAIN");
      return z;
    },
    connect: (ip) => {
      dialed.push(ip);
      // Only the checked public IP is wired to the local origin; anything else would be a test failure.
      assert.equal(ip, PUBLIC_IP, "proxy dialed an address it should have refused");
      return net.connect({ host: "127.0.0.1", port: originPort });
    },
    onDecision: (d) => decisions.push(d),
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as AddressInfo).port;
});
after(() => {
  proxy.close();
  origin.close();
});

function viaProxy(url: string): Promise<{ status: number; body: string; deny?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, path: url, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, deny: res.headers["x-crossbar-deny"] as string | undefined }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connectVia(authority: string): Promise<{ status: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port: proxyPort }, () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    s.once("data", (d) => resolve({ status: d.toString().split("\r\n")[0]!, socket: s }));
    s.on("error", reject);
  });
}

test("plain HTTP to a public host is forwarded to the IP the proxy checked", async () => {
  dialed.length = 0;
  const r = await viaProxy("http://public.test/hello?x=1");
  assert.equal(r.status, 200);
  assert.match(r.body, /origin saw GET \/hello\?x=1 host=public.test/);
  assert.deepEqual(dialed, [PUBLIC_IP]);
});

test("10.0.0.1 is refused after DNS resolution (hostname resolving to private)", async () => {
  const r = await viaProxy("http://rebind.test/");
  assert.equal(r.status, 403);
  assert.match(r.deny ?? "", /private:10\.0\.0\.1/);
});

for (const [url, re] of [
  ["http://10.0.0.1/", /private/],
  ["http://lan.test/", /private/],
  ["http://metadata.test/latest/meta-data/", /link-local-metadata/],
  ["http://mapped.test/", /ipv4-mapped/],
  ["http://2130706433/", /loopback/], // decimal form of 127.0.0.1
  ["http://0x7f.1/", /loopback/],
  ["http://[::1]/", /ipv6-not-global-unicast/],
  ["http://[::ffff:7f00:1]/", /ipv4-mapped/],
  ["http://[64:ff9b::a00:1]/", /nat64/],
  ["http://public.test:22/", /port-22-not-allowed/],
] as const) {
  test(`refuses ${url}`, async () => {
    dialed.length = 0;
    const r = await viaProxy(url);
    assert.equal(r.status, 403);
    assert.match(r.deny ?? "", re);
    assert.deepEqual(dialed, []);
  });
}

test("refuses localhost via the real resolver", async () => {
  const p = createEgressProxy({ connect: () => assert.fail("must not dial") });
  await new Promise<void>((r) => p.listen(0, "127.0.0.1", r));
  const port = (p.address() as AddressInfo).port;
  const status = await new Promise<number>((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "http://localhost/" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
  });
  p.close();
  assert.equal(status, 403);
});

test("CONNECT to a public host tunnels to the checked IP", async () => {
  dialed.length = 0;
  const { status, socket } = await connectVia("public.test:443");
  assert.match(status, /200/);
  // Speak HTTP through the tunnel (the origin is plain HTTP; the tunnel doesn't care).
  socket.write("GET /tunnel HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n");
  const body = await new Promise<string>((r) => {
    let b = "";
    socket.on("data", (d) => (b += d));
    socket.on("end", () => r(b));
  });
  assert.match(body, /origin saw GET \/tunnel/);
  assert.deepEqual(dialed, [PUBLIC_IP]);
});

for (const authority of ["10.0.0.1:443", "lan.test:443", "[::1]:443", "rebind.test:443", "169.254.169.254:443"]) {
  test(`CONNECT refuses ${authority}`, async () => {
    dialed.length = 0;
    const { status, socket } = await connectVia(authority);
    socket.destroy();
    assert.match(status, /403/);
    assert.deepEqual(dialed, []);
  });
}

test("every decision is reported for request logging", () => {
  assert.ok(decisions.some((d) => !d.allowed && d.reason?.startsWith("private")));
  assert.ok(decisions.some((d) => d.allowed && d.dialed === PUBLIC_IP));
});

test("development allow-list is exact-host only", async () => {
  const seen: string[] = [];
  const p = createEgressProxy({
    resolve: async (h) => (h === "testsite" || h === "testsite.evil" ? ["172.20.0.5"] : []),
    connect: (ip) => {
      seen.push(ip);
      return net.connect({ host: "127.0.0.1", port: originPort });
    },
    devAllowPrivateHosts: ["testsite"],
  });
  await new Promise<void>((r) => p.listen(0, "127.0.0.1", r));
  const port = (p.address() as AddressInfo).port;
  const get = (path: string) => new Promise<number>((resolve) => http.get({ host: "127.0.0.1", port, path }, (res) => (res.resume(), resolve(res.statusCode ?? 0))));
  assert.equal(await get("http://testsite:8080/"), 200);
  assert.equal(await get("http://testsite.evil/"), 403);
  p.close();
  assert.deepEqual(seen, ["172.20.0.5"]);
});
