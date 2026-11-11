// SPDX-License-Identifier: AGPL-3.0-only
// Stripe scenarios (live-only: they reach api.stripe.com and Stripe's hosted pages; never in CI).
// Registered only when test keys are present in testsite/.env.
import type { App, Router } from "../app.ts";
import { hostUrl, json, newId, redirect, send, type Ctx } from "../context.ts";
import { esc, page } from "../html.ts";
import { requireLogin } from "../routes/accounts.ts";
import { Stripe, StripeError, TAG, verifyWebhook, type Obj, type StripeConfig } from "./client.ts";
import { advanceClock, seed, TEST_PM, type Seeded } from "./seed.ts";

export { stripeConfigFromEnv } from "./client.ts";

/**
 * Cards a person types into the Payment Element (agents are refused there). Numbers from
 * https://docs.stripe.com/testing; any future expiry, any CVC.
 */
export const ELEMENT_CASES: Record<string, { card: string; expect: string }> = {
  success: { card: "4242 4242 4242 4242", expect: "Succeeds" },
  decline: { card: "4000 0000 0000 0002", expect: "card_declined / generic_decline" },
  insufficient: { card: "4000 0000 0000 9995", expect: "card_declined / insufficient_funds" },
  expired: { card: "4000 0000 0000 0069", expect: "expired_card" },
  cvc: { card: "4000 0000 0000 0127", expect: "incorrect_cvc" },
  "3ds": { card: "4000 0027 6000 3184", expect: "the bank asks for authentication (3DS2) in an iframe; a person completes it" },
};

interface Order {
  id: string;
  kind: string;
  amount: number;
  status: "pending" | "paid" | "failed";
  paymentIntent?: string;
  checkoutSession?: string;
  events: string[];
}

const orders = new Map<string, Order>();
const dunning: Array<{ invoice: string; url: string; at: string }> = [];

function newOrder(kind: string, amount: number): Order {
  const o: Order = { id: `ord_${newId(6)}`, kind, amount, status: "pending", events: [] };
  orders.set(o.id, o);
  return o;
}

function fail(ctx: Ctx, e: unknown): void {
  const msg = e instanceof StripeError ? `${e.message}${e.code ? ` (${e.code})` : ""}` : (e as Error).message;
  send(ctx, 502, page("Stripe error", `<p class="warn">${esc(msg)}</p><p class="note">Did you run <code>npm run testsite:stripe:seed</code>?</p>`, { host: ctx.host }));
}

export function registerStripe(r: Router, app: App, cfg: StripeConfig): void {
  const s = new Stripe(cfg.secretKey);
  app.features.set("stripe", { enabled: true });
  app.features.set("stripe-webhooks", cfg.webhookSecret ? { enabled: true } : { enabled: false, why: "set STRIPE_WEBHOOK_SECRET from `stripe listen` in testsite/.env" });
  let seeded: Seeded | undefined;
  // Read-only lookup of the seeded objects; repeated until everything the pages need is there.
  const complete = (k?: Seeded) => !!(k?.widgetPrice && k.basicPrice && k.proPrice && k.alice && k.aliceCard && k.clock && k.clockCustomer && k.dunningCustomer && k.paymentLink && k.portalConfig);
  const ids = async (): Promise<Seeded> => (complete(seeded) ? seeded! : (seeded = await seed(s, { create: false })));
  const pk = esc(cfg.publishableKey);
  const stripeJs = `<script src="https://js.stripe.com/v3/"></script>`;
  const H = (ctx: Ctx) => ({ host: ctx.host });

  const guard =
    (h: (ctx: Ctx, app: App, m: RegExpExecArray) => Promise<void>) =>
    async (ctx: Ctx, a: App, m: RegExpExecArray): Promise<void> => {
      try {
        await h(ctx, a, m);
      } catch (e) {
        if (e instanceof StripeError && e.status === 404) seeded = undefined; // reset + re-seed changed the ids
        fail(ctx, e);
      }
    };

  // --- Hub --------------------------------------------------------------------------------------
  r.add("site-a.test", "GET", "/checkout/stripe", (ctx) => {
    send(ctx, 200, page("Stripe checkout (test mode)", `<p>Stripe test mode. Nothing is charged. A person types card numbers; agents are refused in Stripe's card iframes.</p>
<h2>Payment Element on this page</h2><ul>${Object.entries(ELEMENT_CASES).map(([k, v]) => `<li><a href="/checkout/stripe/element?case=${k}">${esc(k)}</a>: card <code>${esc(v.card)}</code> → ${esc(v.expect)}</li>`).join("")}</ul>
<h2>Elsewhere</h2><ul>
<li><a href="/checkout/stripe/hosted">Hosted Checkout</a> (redirect to checkout.stripe.com)</li>
<li><a href="/checkout/stripe/link">Payment Link</a></li>
<li><a href="/checkout/stripe/wallets">Link and wallet buttons</a></li>
<li><a href="/stripe/subscription">Subscription</a> (sign in as alice)</li>
<li><a href="/stripe/clock">Test clock: renewal and dunning</a></li>
<li><a href="/billing/portal">Customer Portal</a> (sign in as alice)</li>
<li><a href="/stripe/saved-card">Saved card, one-click re-purchase</a> (sign in as alice)</li>
<li><a href="/merchant">Merchant admin: refunds and disputes</a> (sign in as alice)</li></ul>`, H(ctx)));
  });

  // --- 1. Payment Element ----------------------------------------------------------------------
  r.add("site-a.test", "GET", "/checkout/stripe/element", guard(async (ctx) => {
    const kase = ctx.url.searchParams.get("case") ?? "success";
    const c = ELEMENT_CASES[kase] ?? ELEMENT_CASES.success!;
    const o = newOrder(`element:${kase}`, 1200);
    const pi = await s.post<Obj & { client_secret: string }>("/payment_intents", { amount: 1200, currency: "usd", automatic_payment_methods: { enabled: true }, metadata: { ...TAG, order_id: o.id, case: kase } });
    o.paymentIntent = pi.id;
    const ret = hostUrl(ctx, "site-a.test", `/orders/${o.id}`);
    send(ctx, 200, page(`Pay $12.00 (${kase})`, `<p>Type the test card <code>${esc(c.card)}</code>, any future expiry, any CVC. Expected: ${esc(c.expect)}.</p>
<form id="pay-form" class="card"><div id="payment-element"></div><button id="pay" style="margin-top:12px">Pay $12.00</button><p id="err" class="warn" role="alert"></p></form>
<p class="note">Order <a href="/orders/${o.id}">${o.id}</a>. The card fields are inside js.stripe.com iframes.</p>
<script>
const stripe = Stripe("${pk}");
const elements = stripe.elements({ clientSecret: ${JSON.stringify(pi.client_secret)} });
elements.create("payment").mount("#payment-element");
document.getElementById("pay-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await stripe.confirmPayment({ elements, confirmParams: { return_url: ${JSON.stringify(ret)} } });
  if (error) document.getElementById("err").textContent = error.code + (error.decline_code ? " / " + error.decline_code : "") + ": " + error.message;
});
</script>`, { host: ctx.host, head: stripeJs }));
  }));

  // --- 8. Link and wallets (Express Checkout Element) ------------------------------------------
  r.add("site-a.test", "GET", "/checkout/stripe/wallets", (ctx) => {
    send(ctx, 200, page("Link and wallets", `<p>Express Checkout Element in test mode. Apple Pay and Google Pay need HTTPS and a registered domain, so on <code>http://${esc(ctx.host)}</code> they are not expected to render. Link may.</p>
<div id="express" class="card"></div><pre id="out"></pre>
<script>
const stripe = Stripe("${pk}");
const elements = stripe.elements({ mode: "payment", amount: 1200, currency: "usd" });
const ece = elements.create("expressCheckout");
ece.on("ready", (e) => { document.getElementById("out").textContent = "available: " + JSON.stringify(e.availablePaymentMethods); });
ece.mount("#express");
</script>`, { host: ctx.host, head: stripeJs }));
  });

  // --- 2. Hosted Checkout --------------------------------------------------------------------
  r.add("site-a.test", "GET", "/checkout/stripe/hosted", (ctx) => {
    const btn = (kind: string, label: string) => `<form method="POST" action="/checkout/stripe/hosted"><input type="hidden" name="kind" value="${kind}"><button>${esc(label)}</button></form>`;
    send(ctx, 200, page("Hosted Checkout", `<p>Each button posts here, and the server redirects to Stripe's own domain.</p>
${btn("payment", "Buy the widget ($12)")}${btn("subscription", "Subscribe (Basic, $5/month)")}${btn("promo", "Buy with a promotion code (try CROSSBARTEST20)")}
<p class="note">Cancel on Stripe's page returns to <code>/checkout/stripe/cancelled</code>.</p>`, H(ctx)));
  });
  r.add("site-a.test", "POST", "/checkout/stripe/hosted", guard(async (ctx) => {
    const k = await ids();
    const kind = ctx.body.kind ?? "payment";
    const o = newOrder(`hosted:${kind}`, kind === "subscription" ? 500 : 1200);
    const sub = kind === "subscription";
    const price = sub ? k.basicPrice : k.widgetPrice;
    if (!price) throw new Error("prices not seeded");
    const sess = await s.post<Obj & { url: string }>("/checkout/sessions", {
      mode: sub ? "subscription" : "payment",
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: kind === "promo" ? true : undefined,
      client_reference_id: o.id,
      success_url: hostUrl(ctx, "site-a.test", `/orders/${o.id}?session_id={CHECKOUT_SESSION_ID}`),
      cancel_url: hostUrl(ctx, "site-a.test", "/checkout/stripe/cancelled"),
      metadata: { ...TAG, order_id: o.id },
      payment_intent_data: sub ? undefined : { metadata: { ...TAG, order_id: o.id } },
    });
    o.checkoutSession = sess.id;
    redirect(ctx, sess.url, 303);
  }));
  r.add("site-a.test", "GET", "/checkout/stripe/cancelled", (ctx) => send(ctx, 200, page("Checkout cancelled", "<p>You cancelled on Stripe's page. Nothing was charged.</p>", H(ctx))));

  // --- 3. Payment Link -------------------------------------------------------------------------
  r.add("site-a.test", "GET", "/checkout/stripe/link", guard(async (ctx) => {
    const k = await ids();
    if (!k.paymentLink) throw new Error("payment link not seeded");
    send(ctx, 200, page("Payment Link", `<p>Open the Payment Link directly: <a id="plink" href="${esc(k.paymentLink.url)}">${esc(k.paymentLink.url)}</a></p>`, H(ctx)));
  }));

  // --- 9. Orders and the webhook ---------------------------------------------------------------
  r.add("site-a.test", "GET", /^\/orders\/(ord_[\w-]+)(\.json)?$/, (ctx, _a, m) => {
    const o = orders.get(m[1]!);
    if (!o) return send(ctx, 404, page("No such order", "<p>Unknown order (orders live in memory; a restart clears them).</p>", H(ctx)));
    if (m[2]) return json(ctx, 200, o);
    send(ctx, 200, page(`Order ${o.id}`, `<p>Status: <strong id="order-status" data-status="${o.status}">${o.status}</strong></p>
<p class="note">“paid” appears only after Stripe's webhook arrives (<code>stripe listen --forward-to</code>). Redirect status from Stripe: ${esc(ctx.url.searchParams.get("redirect_status") ?? "-")}.</p>
<ul>${o.events.map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul><p><a href="/orders/${o.id}">Reload</a></p>`, H(ctx)));
  });
  r.add("site-a.test", "POST", "/stripe/webhook", (ctx) => {
    if (!cfg.webhookSecret) return json(ctx, 400, { error: "STRIPE_WEBHOOK_SECRET not set; refusing unsigned events" });
    if (!verifyWebhook(ctx.rawBody, ctx.req.headers["stripe-signature"] as string | undefined, cfg.webhookSecret)) return json(ctx, 400, { error: "bad signature" });
    const ev = JSON.parse(ctx.rawBody.toString("utf8")) as { type: string; data: { object: Record<string, unknown> & { metadata?: Record<string, string> } } };
    const obj = ev.data.object;
    const orderId = (obj.client_reference_id as string | undefined) ?? obj.metadata?.order_id;
    const o = orderId ? orders.get(orderId) : undefined;
    if (o) {
      o.events.push(ev.type);
      if (ev.type === "payment_intent.succeeded" || (ev.type === "checkout.session.completed" && obj.payment_status === "paid")) o.status = "paid";
      if (ev.type === "payment_intent.payment_failed") o.status = "failed";
    }
    if (ev.type === "invoice.payment_failed" && typeof obj.hosted_invoice_url === "string") dunning.push({ invoice: String(obj.id), url: obj.hosted_invoice_url, at: new Date().toISOString() });
    json(ctx, 200, { received: true });
  });

  // --- 4. Subscriptions ------------------------------------------------------------------------
  const aliceOnly = (ctx: Ctx): boolean => {
    if (!requireLogin(ctx)) return false;
    if (ctx.session.user !== "alice") {
      send(ctx, 403, page("Sign in as alice", "<p>The seeded Stripe customer belongs to the fixture user alice.</p>", H(ctx)));
      return false;
    }
    return true;
  };
  const currentSub = async (customer: string) => {
    const subs = await s.get<{ data: Array<Obj & { status: string; items: { data: Array<{ id: string; price: { id: string; unit_amount: number } }> } }> }>("/subscriptions", { customer, status: "all", limit: 10 });
    return subs.data.find((x) => !["canceled", "incomplete_expired"].includes(x.status));
  };
  r.add("site-a.test", "GET", "/stripe/subscription", guard(async (ctx) => {
    if (!aliceOnly(ctx)) return;
    const k = await ids();
    const sub = await currentSub(k.alice!);
    const item = sub?.items.data[0];
    const form = (action: string, label: string) => `<form method="POST" action="/stripe/subscription/${action}" style="display:inline"><button>${esc(label)}</button></form> `;
    send(ctx, 200, page("Your subscription", sub
      ? `<p>Status <strong>${esc(sub.status)}</strong>, plan ${item?.price.id === k.proPrice ? "Pro ($15/month)" : "Basic ($5/month)"}.</p>${item?.price.id === k.proPrice ? form("downgrade", "Downgrade to Basic") : form("upgrade", "Upgrade to Pro")}${form("cancel", "Cancel subscription")}`
      : `<p>No subscription.</p>${form("start", "Start Basic ($5/month) with the card on file")}`, H(ctx)));
  }));
  r.add("site-a.test", "POST", /^\/stripe\/subscription\/(start|upgrade|downgrade|cancel)$/, guard(async (ctx, _a, m) => {
    if (!aliceOnly(ctx)) return;
    const k = await ids();
    const sub = await currentSub(k.alice!);
    const action = m[1]!;
    if (action === "start" && !sub) await s.post("/subscriptions", { customer: k.alice!, items: [{ price: k.basicPrice! }], metadata: TAG });
    else if ((action === "upgrade" || action === "downgrade") && sub) await s.post(`/subscriptions/${sub.id}`, { items: [{ id: sub.items.data[0]!.id, price: action === "upgrade" ? k.proPrice! : k.basicPrice! }], proration_behavior: "create_prorations" });
    else if (action === "cancel" && sub) await s.del(`/subscriptions/${sub.id}`);
    redirect(ctx, "/stripe/subscription", 303);
  }));

  // Test clock view, and the harness action that advances it.
  r.add("site-a.test", "GET", "/stripe/clock", guard(async (ctx) => {
    const k = await ids();
    if (!k.clock) throw new Error("test clock not seeded");
    const clock = await s.get<Obj & { frozen_time: number; status: string }>(`/test_helpers/test_clocks/${k.clock}`);
    const rows: string[] = [];
    for (const [label, cust] of [["renewal", k.clockCustomer], ["failed renewal", k.dunningCustomer]] as const) {
      if (!cust) continue;
      const inv = await s.get<{ data: Array<Obj & { status: string; amount_due: number; attempt_count: number; hosted_invoice_url: string | null }> }>("/invoices", { customer: cust, limit: 5 });
      rows.push(`<h3>${label}</h3><ul>${inv.data.map((i) => `<li>${esc(i.id)}: ${esc(i.status)}, $${(i.amount_due / 100).toFixed(2)}, attempts ${i.attempt_count}${i.hosted_invoice_url ? ` <a href="${esc(i.hosted_invoice_url)}">hosted invoice</a>` : ""}</li>`).join("")}</ul>`);
    }
    const failing = k.dunningCustomer ? await s.get<{ data: Array<Obj & { status: string; hosted_invoice_url: string | null }> }>("/invoices", { customer: k.dunningCustomer, status: "open", limit: 1 }) : { data: [] };
    const dunningLink = dunning[dunning.length - 1]?.url ?? failing.data[0]?.hosted_invoice_url;
    send(ctx, 200, page("Test clock", `<p>Clock frozen at ${new Date(clock.frozen_time * 1000).toISOString()} (${esc(clock.status)}). Advance it from the harness: <code>POST /__testsite/stripe/clock/advance</code> on localhost.</p>${rows.join("")}
<div class="card"><h3>Fixture dunning email</h3>${dunningLink ? `<p>From: billing@site-a.test<br>Subject: Your payment failed</p><p>We couldn't charge your card. <a id="dunning-link" href="${esc(dunningLink)}">Update your payment details</a>.</p>` : `<p class="note">No failed renewal yet. Advance the clock once.</p>`}</div>`, H(ctx)));
  }));
  r.add("*", "POST", "/__testsite/stripe/clock/advance", guard(async (ctx) => {
    const k = await ids();
    if (!k.clock) throw new Error("test clock not seeded");
    json(ctx, 200, await advanceClock(s, k.clock, Number(ctx.body.days ?? 32) || 32));
  }));

  // --- 5. Customer Portal ----------------------------------------------------------------------
  r.add("site-a.test", "GET", "/billing/portal", (ctx) => {
    if (!aliceOnly(ctx)) return;
    send(ctx, 200, page("Manage billing", `<form method="POST" action="/billing/portal"><button>Open the billing portal</button></form><p class="note">Opens billing.stripe.com: update card, cancel the plan, download invoices.</p>`, H(ctx)));
  });
  r.add("site-a.test", "POST", "/billing/portal", guard(async (ctx) => {
    if (!aliceOnly(ctx)) return;
    const k = await ids();
    const sess = await s.post<Obj & { url: string }>("/billing_portal/sessions", { customer: k.alice!, configuration: k.portalConfig, return_url: hostUrl(ctx, "site-a.test", "/billing") });
    redirect(ctx, sess.url, 303);
  }));

  // --- 6. Saved card, one-click re-purchase ----------------------------------------------------
  r.add("site-a.test", "GET", "/stripe/saved-card", guard(async (ctx) => {
    if (!aliceOnly(ctx)) return;
    const k = await ids();
    const pm = k.aliceCard ? await s.get<Obj & { card?: { brand: string; last4: string } }>(`/payment_methods/${k.aliceCard}`) : undefined;
    send(ctx, 200, page("Buy again", `<p>Card on file: ${pm?.card ? `${esc(pm.card.brand)} ending ${esc(pm.card.last4)}` : "none"}.</p>
<form method="POST" action="/stripe/saved-card/buy"><button id="buy-again">Buy again: $12.00</button></form><p class="note">No typing at all. This is still a payment.</p>`, H(ctx)));
  }));
  r.add("site-a.test", "POST", "/stripe/saved-card/buy", guard(async (ctx) => {
    if (!aliceOnly(ctx)) return;
    const k = await ids();
    const o = newOrder("saved-card", 1200);
    const pi = await s.post<Obj & { status: string }>("/payment_intents", {
      amount: 1200, currency: "usd", customer: k.alice!, payment_method: k.aliceCard!, confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { ...TAG, order_id: o.id },
    }, `buy-${o.id}`);
    o.paymentIntent = pi.id;
    o.events.push(`confirmed: ${pi.status}`);
    redirect(ctx, `/orders/${o.id}`, 303);
  }));

  // --- 7. Merchant admin: refunds and disputes -------------------------------------------------
  r.add("site-a.test", "GET", "/merchant", guard(async (ctx) => {
    if (!aliceOnly(ctx)) return;
    const pis = (await s.get<{ data: Array<Obj & { amount: number; status: string; metadata: Record<string, string>; latest_charge: string | null }> }>("/payment_intents", { limit: 20 })).data.filter((p) => p.metadata.crossbar_testsite === "1");
    const disputes = (await s.get<{ data: Array<Obj & { status: string; reason: string; payment_intent: string | null }> }>("/disputes", { limit: 20 })).data.filter((d) => pis.some((p) => p.id === d.payment_intent));
    send(ctx, 200, page("Merchant admin (fixture)", `<h2>Recent payments</h2><table><tr><th>Payment</th><th>Status</th><th></th></tr>
${pis.map((p) => `<tr><td><code>${esc(p.id)}</code> $${(p.amount / 100).toFixed(2)}</td><td>${esc(p.status)}</td><td>${p.status === "succeeded" ? `<form method="POST" action="/merchant/refund"><input type="hidden" name="pi" value="${esc(p.id)}"><button>Refund</button></form>` : ""}</td></tr>`).join("")}</table>
<form method="POST" action="/merchant/dispute-demo"><button>Create a payment that will be disputed</button></form>
<h2>Disputes</h2><table>${disputes.map((d) => `<tr><td><code>${esc(d.id)}</code></td><td>${esc(d.status)} (${esc(d.reason)})</td><td>${d.status.startsWith("needs_response") || d.status === "warning_needs_response" ? `<form method="POST" action="/merchant/dispute/close"><input type="hidden" name="id" value="${esc(d.id)}"><button>Accept dispute (close)</button></form>` : ""}</td></tr>`).join("") || "<tr><td>None yet. Disputes appear a few seconds after the dispute payment.</td></tr>"}</table>`, H(ctx)));
  }));
  r.add("site-a.test", "POST", "/merchant/refund", guard(async (ctx) => {
    if (!aliceOnly(ctx)) return;
    await s.post("/refunds", { payment_intent: ctx.body.pi ?? "", metadata: TAG });
    redirect(ctx, "/merchant", 303);
  }));
  r.add("site-a.test", "POST", "/merchant/dispute-demo", guard(async (ctx) => {
    if (!aliceOnly(ctx)) return;
    await s.post("/payment_intents", { amount: 1200, currency: "usd", payment_method: TEST_PM.createDispute, confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { ...TAG, case: "dispute" } });
    redirect(ctx, "/merchant", 303);
  }));
  r.add("site-a.test", "POST", "/merchant/dispute/close", guard(async (ctx) => {
    if (!aliceOnly(ctx)) return;
    await s.post(`/disputes/${ctx.body.id ?? ""}/close`);
    redirect(ctx, "/merchant", 303);
  }));
}
