// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAddress } from "../src/ip.ts";

const refused: Array<[string, string]> = [
  ["127.0.0.1", "loopback"],
  ["127.255.0.9", "loopback"],
  ["10.0.0.1", "private"],
  ["172.16.0.1", "private"],
  ["172.31.255.255", "private"],
  ["192.168.1.1", "private"],
  ["169.254.169.254", "link-local-metadata"],
  ["100.64.0.1", "cgnat-tailscale"],
  ["100.127.255.254", "cgnat-tailscale"],
  ["0.0.0.0", "this-network"],
  ["224.0.0.251", "multicast"],
  ["255.255.255.255", "reserved-broadcast"],
  ["::", "ipv6-not-global-unicast"],
  ["::1", "ipv6-not-global-unicast"],
  ["fe80::1", "ipv6-not-global-unicast"],
  ["fc00::1", "ipv6-not-global-unicast"],
  ["fd7a:115c:a1e0::1", "ipv6-not-global-unicast"],
  ["ff02::1", "ipv6-not-global-unicast"],
  ["::ffff:127.0.0.1", "ipv4-mapped"],
  ["::ffff:8.8.8.8", "ipv4-mapped"],
  ["64:ff9b::7f00:1", "nat64"],
  ["64:ff9b:1::a00:1", "nat64-local"],
  ["2002:7f00:1::", "6to4"],
  ["2001:0:4136:e378::1", "teredo"],
  ["not-an-ip", "not-an-ip"],
];

for (const [ip, reason] of refused) {
  test(`refuses ${ip} (${reason})`, () => {
    assert.deepEqual(checkAddress(ip), { allowed: false, reason });
  });
}

for (const ip of ["93.184.216.34", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::1"]) {
  test(`allows public ${ip}`, () => assert.deepEqual(checkAddress(ip), { allowed: true }));
}

test("refuses the configured home public IP", () => {
  assert.deepEqual(checkAddress("81.2.69.160", { extraBlocked: ["81.2.69.160"] }), { allowed: false, reason: "configured-block" });
  assert.deepEqual(checkAddress("81.2.69.161", { extraBlocked: ["81.2.69.160"] }), { allowed: true });
});
