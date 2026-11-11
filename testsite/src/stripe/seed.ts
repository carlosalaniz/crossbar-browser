// SPDX-License-Identifier: AGPL-3.0-only
// Idempotent seed and reset for the test site's Stripe sandbox.
//   npm run testsite:stripe:seed    creates or reactivates what the scenarios need (twice = same state)
//   npm run testsite:stripe:reset   deletes or archives only objects tagged metadata.crossbar_testsite=1
// Test clocks have no metadata, so they are tagged by name prefix `crossbar_testsite`.
import { Stripe, StripeError, TAG, stripeConfigFromEnv, type Obj } from "./client.ts";

export const KEYS = {
  widgetProduct: "crossbar_ts_widget",
  basicProduct: "crossbar_ts_plan_basic",
  proProduct: "crossbar_ts_plan_pro",
  widgetPrice: "crossbar_ts_widget_usd",
  basicPrice: "crossbar_ts_basic_monthly",
  proPrice: "crossbar_ts_pro_monthly",
  coupon: "CROSSBAR_TS_20OFF",
  promoCode: "CROSSBARTEST20",
  clockName: "crossbar_testsite",
  aliceEmail: "alice@site-a.test",
  clockEmail: "clock@site-a.test",
  dunningEmail: "dunning@site-a.test",
} as const;

/**
 * Test PaymentMethod tokens from https://docs.stripe.com/testing (checked by the seed actually
 * using them: Stripe rejects unknown tokens).
 */
export const TEST_PM = {
  visa: "pm_card_visa",
  chargeCustomerFail: "pm_card_chargeCustomerFail",
  createDispute: "pm_card_createDispute",
} as const;

export interface Seeded {
  widgetPrice?: string;
  basicPrice?: string;
  proPrice?: string;
  basicProduct?: string;
  proProduct?: string;
  coupon?: string;
  promotionCode?: string;
  alice?: string;
  aliceCard?: string;
  clock?: string;
  clockCustomer?: string;
  clockSubscription?: string;
  dunningCustomer?: string;
  dunningSubscription?: string;
  paymentLink?: { id: string; url: string };
  portalConfig?: string;
}

const tagged = (o: { metadata?: Record<string, string> }) => o.metadata?.crossbar_testsite === "1";
const notFound = (e: unknown) => e instanceof StripeError && e.status === 404;

async function ensureProduct(s: Stripe, id: string, name: string, create: boolean): Promise<string | undefined> {
  try {
    const p = await s.get<Obj & { active: boolean }>(`/products/${id}`);
    if (!p.active && create) await s.post(`/products/${id}`, { active: true });
    return p.id;
  } catch (e) {
    if (!notFound(e)) throw e;
    if (!create) return undefined;
    return (await s.post("/products", { id, name, metadata: TAG })).id;
  }
}

async function ensurePrice(s: Stripe, lookupKey: string, product: string, amount: number, interval: "month" | null, create: boolean): Promise<string | undefined> {
  const found = await s.get<{ data: Array<Obj & { active: boolean; product: string; unit_amount: number }> }>("/prices", { lookup_keys: [lookupKey], limit: 1 });
  const p = found.data[0];
  if (p && p.product === product && p.unit_amount === amount) {
    if (!p.active && create) await s.post(`/prices/${p.id}`, { active: true });
    return p.id;
  }
  if (!create) return undefined;
  return (
    await s.post("/prices", {
      product,
      currency: "usd",
      unit_amount: amount,
      lookup_key: lookupKey,
      transfer_lookup_key: true,
      recurring: interval ? { interval } : undefined,
      metadata: TAG,
    })
  ).id;
}

async function ensureCustomer(s: Stripe, email: string, name: string, extra: Record<string, string>, create: boolean, testClock?: string): Promise<string | undefined> {
  const list = await s.get<{ data: Array<Obj & { metadata: Record<string, string> }> }>("/customers", { email, limit: 10, test_clock: testClock });
  const c = list.data.find(tagged);
  if (c) return c.id;
  if (!create) return undefined;
  return (await s.post("/customers", { email, name, metadata: { ...TAG, ...extra }, test_clock: testClock })).id;
}

/** Attaches a test card and makes it the default, unless the customer already has a default. */
async function ensureDefaultCard(s: Stripe, customer: string, token: string, create: boolean): Promise<string | undefined> {
  const c = await s.get<Obj & { invoice_settings: { default_payment_method: string | null } }>(`/customers/${customer}`);
  if (c.invoice_settings.default_payment_method) return c.invoice_settings.default_payment_method;
  if (!create) return undefined;
  const pm = await s.post(`/payment_methods/${token}/attach`, { customer });
  await s.post(`/customers/${customer}`, { invoice_settings: { default_payment_method: pm.id } });
  return pm.id;
}

async function ensureSubscription(s: Stripe, customer: string, price: string, create: boolean): Promise<string | undefined> {
  const subs = await s.get<{ data: Array<Obj & { status: string }> }>("/subscriptions", { customer, status: "all", limit: 10 });
  const live = subs.data.find((x) => !["canceled", "incomplete_expired"].includes(x.status));
  if (live) return live.id;
  if (!create) return undefined;
  return (await s.post("/subscriptions", { customer, items: [{ price }], metadata: TAG })).id;
}

export async function seed(s: Stripe, opts: { create: boolean } = { create: true }): Promise<Seeded> {
  const c = opts.create;
  const out: Seeded = {};
  const widget = await ensureProduct(s, KEYS.widgetProduct, "Crossbar test-site widget (fixture)", c);
  // Basic and Pro are separate products: the portal allows one price per billing interval per product.
  out.basicProduct = await ensureProduct(s, KEYS.basicProduct, "Crossbar test-site Basic plan (fixture)", c);
  out.proProduct = await ensureProduct(s, KEYS.proProduct, "Crossbar test-site Pro plan (fixture)", c);
  if (widget) out.widgetPrice = await ensurePrice(s, KEYS.widgetPrice, widget, 1200, null, c);
  if (out.basicProduct) out.basicPrice = await ensurePrice(s, KEYS.basicPrice, out.basicProduct, 500, "month", c);
  if (out.proProduct) out.proPrice = await ensurePrice(s, KEYS.proPrice, out.proProduct, 1500, "month", c);

  try {
    out.coupon = (await s.get(`/coupons/${KEYS.coupon}`)).id;
  } catch (e) {
    if (!notFound(e)) throw e;
    if (c) out.coupon = (await s.post("/coupons", { id: KEYS.coupon, percent_off: 20, duration: "once", name: "20% off (fixture)", metadata: TAG })).id;
  }
  if (out.coupon) {
    const codes = await s.get<{ data: Obj[] }>("/promotion_codes", { code: KEYS.promoCode, active: true, limit: 1 });
    out.promotionCode = codes.data[0]?.id ?? (c ? (await s.post("/promotion_codes", { coupon: out.coupon, code: KEYS.promoCode, metadata: TAG })).id : undefined);
  }

  out.alice = await ensureCustomer(s, KEYS.aliceEmail, "Alice Example (fixture)", { crossbar_ts_user: "alice" }, c);
  if (out.alice) out.aliceCard = await ensureDefaultCard(s, out.alice, TEST_PM.visa, c);

  const clocks = await s.all<Obj & { name: string | null; status: string }>("/test_helpers/test_clocks");
  out.clock = clocks.find((k) => k.name === KEYS.clockName)?.id;
  if (!out.clock && c) out.clock = (await s.post("/test_helpers/test_clocks", { frozen_time: Math.floor(Date.now() / 1000), name: KEYS.clockName })).id;
  if (out.clock && out.basicPrice) {
    out.clockCustomer = await ensureCustomer(s, KEYS.clockEmail, "Clock Customer (fixture)", { crossbar_ts_user: "clock" }, c, out.clock);
    if (out.clockCustomer) {
      await ensureDefaultCard(s, out.clockCustomer, TEST_PM.visa, c);
      out.clockSubscription = await ensureSubscription(s, out.clockCustomer, out.basicPrice, c);
    }
    // Dunning: subscribe with a good card, then switch the default to one that fails on later charges.
    out.dunningCustomer = await ensureCustomer(s, KEYS.dunningEmail, "Dunning Customer (fixture)", { crossbar_ts_user: "dunning" }, c, out.clock);
    if (out.dunningCustomer) {
      await ensureDefaultCard(s, out.dunningCustomer, TEST_PM.visa, c);
      out.dunningSubscription = await ensureSubscription(s, out.dunningCustomer, out.basicPrice, c);
      const cust = await s.get<Obj & { metadata: Record<string, string> }>(`/customers/${out.dunningCustomer}`);
      if (c && out.dunningSubscription && cust.metadata.crossbar_ts_failing !== "1") {
        const bad = await s.post(`/payment_methods/${TEST_PM.chargeCustomerFail}/attach`, { customer: out.dunningCustomer });
        await s.post(`/customers/${out.dunningCustomer}`, { invoice_settings: { default_payment_method: bad.id }, metadata: { crossbar_ts_failing: "1" } });
        await s.post(`/subscriptions/${out.dunningSubscription}`, { default_payment_method: bad.id });
      }
    }
  }

  if (out.widgetPrice) {
    const links = await s.all<Obj & { active: boolean; url: string; metadata: Record<string, string> }>("/payment_links");
    let link = links.find((l) => tagged(l) && l.metadata.crossbar_ts_key === "widget");
    if (link && !link.active && c) link = await s.post(`/payment_links/${link.id}`, { active: true });
    if (!link && c) link = await s.post("/payment_links", { line_items: [{ price: out.widgetPrice, quantity: 1 }], metadata: { ...TAG, crossbar_ts_key: "widget" } });
    if (link) out.paymentLink = { id: link.id, url: link.url };
  }

  if (out.basicProduct && out.proProduct && out.basicPrice && out.proPrice) {
    const confs = await s.all<Obj & { active: boolean; metadata: Record<string, string> | null }>("/billing_portal/configurations");
    const conf = confs.find((x) => x.metadata?.crossbar_testsite === "1");
    if (conf) {
      if (!conf.active && c) await s.post(`/billing_portal/configurations/${conf.id}`, { active: true });
      out.portalConfig = conf.id;
    } else if (c) {
      out.portalConfig = (
        await s.post("/billing_portal/configurations", {
          business_profile: { headline: "Crossbar test site (fixture merchant)" },
          features: {
            invoice_history: { enabled: true },
            payment_method_update: { enabled: true },
            subscription_cancel: { enabled: true, mode: "at_period_end" },
            subscription_update: { enabled: true, default_allowed_updates: ["price"], products: [
              { product: out.basicProduct, prices: [out.basicPrice] },
              { product: out.proProduct, prices: [out.proPrice] },
            ] },
          },
          metadata: TAG,
        })
      ).id;
    }
  }
  return out;
}

/** Deletes or archives only tagged objects. */
export async function reset(s: Stripe): Promise<Record<string, number>> {
  const n: Record<string, number> = {};
  const bump = (k: string) => (n[k] = (n[k] ?? 0) + 1);
  for (const k of await s.all<Obj & { name: string | null }>("/test_helpers/test_clocks")) {
    if (k.name?.startsWith(KEYS.clockName)) {
      await s.del(`/test_helpers/test_clocks/${k.id}`);
      bump("test_clocks_deleted");
    }
  }
  for (const l of await s.all<Obj & { active: boolean; metadata: Record<string, string> }>("/payment_links", { active: true })) {
    if (tagged(l)) {
      await s.post(`/payment_links/${l.id}`, { active: false });
      bump("payment_links_archived");
    }
  }
  for (const pc of await s.all<Obj & { metadata: Record<string, string> }>("/promotion_codes", { active: true })) {
    if (tagged(pc)) {
      await s.post(`/promotion_codes/${pc.id}`, { active: false });
      bump("promotion_codes_archived");
    }
  }
  for (const cp of await s.all<Obj & { metadata: Record<string, string> }>("/coupons")) {
    if (tagged(cp)) {
      await s.del(`/coupons/${cp.id}`);
      bump("coupons_deleted");
    }
  }
  for (const cu of await s.all<Obj & { metadata: Record<string, string> }>("/customers")) {
    if (tagged(cu)) {
      await s.del(`/customers/${cu.id}`);
      bump("customers_deleted");
    }
  }
  for (const conf of await s.all<Obj & { active: boolean; is_default: boolean; metadata: Record<string, string> | null }>("/billing_portal/configurations", { active: true })) {
    if (conf.metadata?.crossbar_testsite === "1" && !conf.is_default) {
      await s.post(`/billing_portal/configurations/${conf.id}`, { active: false });
      bump("portal_configurations_archived");
    }
  }
  for (const p of await s.all<Obj & { metadata: Record<string, string> }>("/prices", { active: true })) {
    if (tagged(p)) {
      await s.post(`/prices/${p.id}`, { active: false });
      bump("prices_archived");
    }
  }
  for (const p of await s.all<Obj & { metadata: Record<string, string> }>("/products", { active: true })) {
    if (tagged(p)) {
      await s.post(`/products/${p.id}`, { active: false });
      bump("products_archived");
    }
  }
  return n;
}

/** Moves the test clock forward by one billing period (about 32 days), the maximum Stripe allows for a monthly price is two. */
export async function advanceClock(s: Stripe, clock: string, days = 32): Promise<{ frozen_time: number; status: string }> {
  const k = await s.get<Obj & { frozen_time: number; status: string }>(`/test_helpers/test_clocks/${clock}`);
  return s.post(`/test_helpers/test_clocks/${clock}/advance`, { frozen_time: k.frozen_time + days * 86400 });
}

// CLI: node testsite/src/stripe/seed.ts seed|reset
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import("../env.ts");
  const cfg = stripeConfigFromEnv(loadEnv());
  if (!cfg) {
    console.error("STRIPE_PUBLISHABLE_KEY and STRIPE_SECRET_KEY must be set in testsite/.env (test keys only).");
    process.exit(1);
  }
  const s = new Stripe(cfg.secretKey);
  const cmd = process.argv[2] ?? "seed";
  if (cmd === "reset") console.log(JSON.stringify(await reset(s), null, 2));
  else console.log(JSON.stringify(await seed(s), null, 2));
}
