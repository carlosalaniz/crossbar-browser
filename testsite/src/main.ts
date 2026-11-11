// SPDX-License-Identifier: AGPL-3.0-only
// `npm run testsite` (or the compose `testsite` service under the `dev` profile).
// Binds to 127.0.0.1 by default. In compose it binds inside the internal network, which has no
// published port and no route out; never expose it publicly.
import { loadEnv } from "./env.ts";
import { createConfiguredTestsite } from "./boot.ts";

const env = loadEnv();
const port = Number(env.TESTSITE_PORT ?? 8090);
const bind = env.TESTSITE_BIND ?? "127.0.0.1";

let site;
try {
  site = createConfiguredTestsite(env);
} catch (e) {
  console.error(`testsite: refusing to start: ${(e as Error).message}`);
  process.exit(1);
}
const { server, app, stripe, noEgress } = site;
server.listen(port, bind, () => {
  const where = bind === "127.0.0.1" ? `http://site-a.test.localhost:${port}/` : `http://site-a.test:${port}/ (inside the compose network)`;
  console.log(`testsite listening on ${bind}:${port}  ->  ${where}`);
  console.log(`  captcha mode: ${app.live ? "live (real widgets with test keys; needs internet; not for CI)" : "offline (self-hosted fakes)"}`);
  console.log(`  stripe: ${stripe ? "enabled (test mode)" : noEgress ? "disabled (no route out)" : "disabled (no keys in testsite/.env)"}`);
  console.log(`  harness: http://localhost:${port}/__testsite/`);
});
