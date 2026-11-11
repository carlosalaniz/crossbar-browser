// SPDX-License-Identifier: AGPL-3.0-only
// Address policy for the egress proxy (Access Model L1).
// IPv4 is deny-listed; IPv6 is allow-listed to global unicast (2000::/3) minus special ranges.
import { BlockList, isIP } from "node:net";

export type AddressVerdict = { allowed: true } | { allowed: false; reason: string };

const V4_BLOCKED: Array<[string, number, string]> = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "cgnat-tailscale"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local-metadata"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "ietf-special"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4-relay"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved-broadcast"],
];

const V6_BLOCKED: Array<[string, number, string]> = [
  ["::ffff:0:0", 96, "ipv4-mapped"],
  ["64:ff9b::", 96, "nat64"],
  ["64:ff9b:1::", 48, "nat64-local"],
  ["2001::", 32, "teredo"],
  ["2001:db8::", 32, "documentation"],
  ["2002::", 16, "6to4"],
];

function named(entries: Array<[string, number, string]>, type: "ipv4" | "ipv6") {
  return entries.map(([net, prefix, reason]) => {
    const list = new BlockList();
    list.addSubnet(net, prefix, type);
    return { list, reason };
  });
}
const v4Rules = named(V4_BLOCKED, "ipv4");
const v6Rules = named(V6_BLOCKED, "ipv6");
const v6GlobalUnicast = new BlockList();
v6GlobalUnicast.addSubnet("2000::", 3, "ipv6");

export interface AddressPolicyOptions {
  /** The home's public IPs, and anything else the owner adds. Exact addresses. */
  extraBlocked?: string[];
}

export function checkAddress(ip: string, opts: AddressPolicyOptions = {}): AddressVerdict {
  const family = isIP(ip);
  if (family === 0) return { allowed: false, reason: "not-an-ip" };
  const type = family === 4 ? "ipv4" : "ipv6";
  for (const extra of opts.extraBlocked ?? []) {
    const l = new BlockList();
    const ef = isIP(extra);
    if (ef === 0) continue;
    l.addAddress(extra, ef === 4 ? "ipv4" : "ipv6");
    if (ef === family && l.check(ip, type)) return { allowed: false, reason: "configured-block" };
  }
  if (type === "ipv4") {
    for (const r of v4Rules) if (r.list.check(ip, "ipv4")) return { allowed: false, reason: r.reason };
    return { allowed: true };
  }
  // Check special ranges before the global-unicast allow list, so the reason is specific.
  for (const r of v6Rules) if (r.list.check(ip, "ipv6")) return { allowed: false, reason: r.reason };
  if (!v6GlobalUnicast.check(ip, "ipv6")) return { allowed: false, reason: "ipv6-not-global-unicast" };
  return { allowed: true };
}
