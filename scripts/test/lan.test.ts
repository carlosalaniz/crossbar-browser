// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { devOrigins, lanAddress } from "../lan.mjs";

const iface = (address: string, internal = false, family: "IPv4" | "IPv6" = "IPv4") => ({ address, internal, family, netmask: "", mac: "", cidr: null }) as NetworkInterfaceInfo;

test("picks the private LAN address, not loopback, IPv6 or a public one", () => {
  const ifaces = { lo0: [iface("127.0.0.1", true)], utun: [iface("fe80::1", false, "IPv6")], en5: [iface("203.0.113.4")], en0: [iface("192.168.1.23")] };
  assert.equal(lanAddress(ifaces, {}), "192.168.1.23");
});

test("CROSSBAR_LAN_HOST overrides, and no LAN falls back to localhost", () => {
  assert.equal(lanAddress({ en0: [iface("10.0.0.5")] }, { CROSSBAR_LAN_HOST: "box.lan" }), "box.lan");
  assert.equal(devOrigins(8080, { lo0: [iface("127.0.0.1", true)] }, {}), "http://localhost:8080");
});

test("dev origin lists the LAN address first, then localhost", () => {
  assert.equal(devOrigins(8081, { en0: [iface("10.1.2.3")] }, {}), "http://10.1.2.3:8081,http://localhost:8081");
  assert.equal(devOrigins(8081, {}, { CROSSBAR_ORIGIN: "https://x.example" }), "https://x.example");
});
