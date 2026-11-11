// SPDX-License-Identifier: AGPL-3.0-only
// The test site as `npm run testsite`, compose and `npm run dev:local` run it: .env loaded, Stripe
// registered when its test keys are present, live scenarios disabled when there's no route out.
import { createTestsite } from "./app.ts";
import { registerStripe, stripeConfigFromEnv } from "./stripe/routes.ts";
import type { StripeConfig } from "./stripe/client.ts";

const NO_EGRESS_WHY = "this test site has no route out (compose internal network); run npm run testsite or npm run dev:local for live scenarios";

/** Throws when a Stripe key is present but isn't a test-mode key. */
export function createConfiguredTestsite(env: NodeJS.ProcessEnv) {
  const noEgress = env.TESTSITE_NO_EGRESS === "1";
  let stripe: StripeConfig | null = stripeConfigFromEnv(env);
  if (noEgress) stripe = null;
  const site = createTestsite({ env, captcha: noEgress ? "offline" : undefined, modules: stripe ? [(r, a) => registerStripe(r, a, stripe!)] : [] });
  if (noEgress) {
    site.app.features.set("stripe", { enabled: false, why: NO_EGRESS_WHY });
    site.app.features.set("stripe-webhooks", { enabled: false, why: NO_EGRESS_WHY });
    site.app.features.set("live-captcha", { enabled: false, why: NO_EGRESS_WHY });
  }
  return { ...site, stripe, noEgress };
}
