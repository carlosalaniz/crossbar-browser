// SPDX-License-Identifier: AGPL-3.0-only
// The machine's address on the local network, so a phone on the same Wi-Fi can open the dev stack
// and notification links point somewhere the phone can reach. CROSSBAR_LAN_HOST overrides.
import { networkInterfaces } from "node:os";

const PRIVATE = [/^192\.168\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./];

/** First private, non-internal IPv4 address; any non-internal IPv4 if none is private. */
export function lanAddress(ifaces = networkInterfaces(), env = process.env) {
  if (env.CROSSBAR_LAN_HOST) return env.CROSSBAR_LAN_HOST;
  const v4 = Object.values(ifaces)
    .flat()
    .filter((a) => a && (a.family === "IPv4" || a.family === 4) && !a.internal)
    .map((a) => a.address);
  return v4.find((a) => PRIVATE.some((r) => r.test(a))) ?? v4[0] ?? null;
}

/** CROSSBAR_ORIGIN for dev: the LAN address first (used in links), localhost second. */
export function devOrigins(port, ifaces, env = process.env) {
  if (env.CROSSBAR_ORIGIN) return env.CROSSBAR_ORIGIN;
  const lan = lanAddress(ifaces, env);
  const local = `http://localhost:${port}`;
  return lan ? `http://${lan}:${port},${local}` : local;
}
