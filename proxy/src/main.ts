// SPDX-License-Identifier: AGPL-3.0-only
// Egress proxy container entry point. Logs every decision as one JSON line.
import { createEgressProxy } from "./proxy.ts";

const env = process.env;
const extraBlocked = (env.CROSSBAR_BLOCK_IPS ?? "").split(/[\s,]+/).filter(Boolean);
const allowedPorts = (env.CROSSBAR_ALLOWED_PORTS ?? "80,443").split(",").map(Number).filter(Boolean);
// Development only: hostnames allowed to resolve to private addresses (the local test site).
const devAllow = (env.CROSSBAR_DEV_ALLOW_PRIVATE_HOSTS ?? "").split(/[\s,]+/).filter(Boolean);
if (devAllow.length) console.warn(`WARNING: development mode. These hosts may reach private addresses: ${devAllow.join(", ")}. Never set this in production.`);

const server = createEgressProxy({
  extraBlocked,
  allowedPorts: devAllow.length ? undefined : allowedPorts,
  devAllowPrivateHosts: devAllow,
  onDecision: (d) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...d })),
});
const port = Number(env.CROSSBAR_PROXY_PORT ?? 3128);
server.listen(port, "0.0.0.0", () => console.log(`egress proxy on :${port}; ports ${allowedPorts.join(",")}; ${extraBlocked.length} extra blocked IPs`));
