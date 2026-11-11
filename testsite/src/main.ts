// SPDX-License-Identifier: AGPL-3.0-only
// `npm run testsite` (or the compose `testsite` service under the `dev` profile).
// Binds to 127.0.0.1 by default. In compose it binds inside the internal network, which has no
// published port and no route out; never expose it publicly.
import { createTestsite } from "./app.ts";
import { loadEnv } from "./env.ts";
import { registerStripe, stripeConfigFromEnv } from "./stripe/routes.ts";

const env = loadEnv();
const port = Number(env.TESTSITE_PORT ?? 8090);
const bind = env.TESTSITE_BIND ?? "127.0.0.1";

// In compose the test site sits on the internal network only, with no route out, so live mode
// (Stripe, real captcha widgets) can't work there. Those scenarios show as disabled, with the reason.
const noEgress = env.TESTSITE_NO_EGRESS === "1";
const NO_EGRESS_WHY = "this test site has no route out (compose internal network); run npm run testsite or npm run dev:local for live scenarios";
let stripe;
try {
  stripe = stripeConfigFromEnv(env);
} catch (e) {
  console.error(`testsite: refusing to start: ${(e as Error).message}`);
  process.exit(1);
}
if (noEgress) stripe = null;

const { server, app } = createTestsite({ env, captcha: noEgress ? "offline" : undefined, modules: stripe ? [(r, a) => registerStripe(r, a, stripe)] : [] });
if (noEgress) {
  app.features.set("stripe", { enabled: false, why: NO_EGRESS_WHY });
  app.features.set("stripe-webhooks", { enabled: false, why: NO_EGRESS_WHY });
  app.features.set("live-captcha", { enabled: false, why: NO_EGRESS_WHY });
}
server.listen(port, bind, () => {
  const where = bind === "127.0.0.1" ? `http://site-a.test.localhost:${port}/` : `http://site-a.test:${port}/ (inside the compose network)`;
  console.log(`testsite listening on ${bind}:${port}  ->  ${where}`);
  console.log(`  captcha mode: ${app.live ? "live (real widgets with test keys; needs internet; not for CI)" : "offline (self-hosted fakes)"}`);
  console.log(`  stripe: ${stripe ? "enabled (test mode)" : noEgress ? "disabled (no route out)" : "disabled (no keys in testsite/.env)"}`);
  console.log(`  harness: http://localhost:${port}/__testsite/`);
});
