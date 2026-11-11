// SPDX-License-Identifier: AGPL-3.0-only
// Egress proxy container entry point. Logs every decision as one JSON line.
// Environment: CROSSBAR_PROXY_PORT (3128), CROSSBAR_PROXY_BIND (0.0.0.0), CROSSBAR_BLOCK_IPS (the home's
// public IPs), CROSSBAR_ALLOWED_PORTS (80,443), and, dev only, CROSSBAR_DEV_TESTSITE=1 with
// CROSSBAR_DEV_TESTSITE_TARGET / CROSSBAR_DEV_TESTSITE_PORT (see dev-allowlist.ts).
import { createEgressProxy } from "./proxy.ts";
import { devAllowlistFromEnv, devAllowlistWarning } from "./dev-allowlist.ts";

const env = process.env;
let devAllowlist;
try {
  devAllowlist = devAllowlistFromEnv(env);
} catch (e) {
  console.error(`proxy: ${(e as Error).message}`);
  process.exit(1);
}
if (devAllowlist) console.warn(devAllowlistWarning(devAllowlist));

const extraBlocked = (env.CROSSBAR_BLOCK_IPS ?? "").split(/[\s,]+/).filter(Boolean);
const allowedPorts = (env.CROSSBAR_ALLOWED_PORTS ?? "80,443").split(",").map(Number).filter(Boolean);
const server = createEgressProxy({
  extraBlocked,
  allowedPorts,
  devAllowlist,
  onDecision: (d) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...d })),
});
const port = Number(env.CROSSBAR_PROXY_PORT ?? 3128);
const bind = env.CROSSBAR_PROXY_BIND ?? "0.0.0.0";
server.listen(port, bind, () =>
  console.log(`egress proxy on ${bind}:${port}; ports ${allowedPorts.join(",")}; ${extraBlocked.length} extra blocked IPs${devAllowlist ? "; DEV ALLOWLIST ON" : ""}`),
);
