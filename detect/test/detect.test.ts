// SPDX-License-Identifier: AGPL-3.0-only
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { detect, type PageFactsLike } from "../src/index.ts";

const base: PageFactsLike = { url: "https://example.com/post/1", title: "A post", status: 200, headers: {}, frameUrls: [], hasPasswordField: false, hasOtpField: false, textLength: 5000, textSample: "An ordinary article about homelabs." };

test("ordinary page: no block", () => assert.equal(detect(base), null));
test("cloudflare challenge header", () => assert.equal(detect({ ...base, status: 403, headers: { "cf-mitigated": "challenge" }, textLength: 200 })?.kind, "captcha"));
test("turnstile frame", () => {
  const b = detect({ ...base, frameUrls: ["https://example.com/", "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc"] });
  assert.deepEqual([b?.kind, b?.vendor], ["captcha", "cloudflare"]);
});
test("recaptcha and hcaptcha frames", () => {
  assert.equal(detect({ ...base, frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"] })?.vendor, "recaptcha");
  assert.equal(detect({ ...base, frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html"] })?.vendor, "hcaptcha");
});
test("an article that mentions 'Just a moment...' is not a block", () => assert.equal(detect({ ...base, textSample: "Just a moment... said the narrator", textLength: 9000 }), null));
test("cloudflare interstitial text on a short page", () => assert.equal(detect({ ...base, title: "Just a moment...", textLength: 300 })?.kind, "captcha"));
test("login wall: password field on a short page", () => {
  const b = detect({ ...base, url: "https://www.reddit.com/login/", hasPasswordField: true, textLength: 400 });
  assert.equal(b?.kind, "login");
  assert.equal(b?.origin, "https://www.reddit.com");
});
test("429 is a soft block", () => assert.equal(detect({ ...base, status: 429, textLength: 100 })?.kind, "soft_block"));
test("captcha outranks login", () => assert.equal(detect({ ...base, hasPasswordField: true, textLength: 300, frameUrls: ["https://www.google.com/recaptcha/api2/bframe"] })?.kind, "captcha"));

test("a widget's container counts on a short page or with a login form", () => {
  assert.equal(detect({ ...base, textLength: 800, captchaContainers: [".cf-turnstile"] })?.vendor, "cloudflare");
  assert.equal(detect({ ...base, textLength: 20000, hasPasswordField: true, captchaContainers: [".g-recaptcha:not([data-size=invisible])"] })?.kind, "captcha");
});
test("a reCAPTCHA in a long article's comment form is not a wall", () => {
  assert.equal(detect({ ...base, textLength: 20000, captchaContainers: [".g-recaptcha:not([data-size=invisible])"], frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"] }), null);
});
test("widget frames are recognised by path, not only by vendor host", () => {
  assert.equal(detect({ ...base, frameUrls: ["http://captcha.test/recaptcha/api2/anchor?k=x"] })?.vendor, "recaptcha");
  assert.equal(detect({ ...base, frameUrls: ["http://captcha.test/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2"] })?.vendor, "cloudflare");
});

test("app gate: truncated content behind 'see more in the app' is a soft block", () => {
  const b = detect({ ...base, textLength: 900, textSample: "First lines of the post… See more in the app. Continue reading this post and 4 more comments in the site-a app. Open app Not now" });
  assert.equal(b?.kind, "soft_block");
  assert.equal(b?.vendor, "app-gate");
  assert.equal(detect({ ...base, textLength: 900, textSample: "To keep reading, open the app." })?.kind, "soft_block");
});
test("a full page with an 'Open in app' banner is not a soft block", () => {
  assert.equal(detect({ ...base, textLength: 12000, textSample: "Open in app. See more in the app. A long thread with many comments…" }), null);
  assert.equal(detect({ ...base, textLength: 900, textSample: "Get the app for notifications. A short post with everything visible." }), null);
});

test("3-D Secure is a verification, by frame shape or text (ADR 0011)", () => {
  for (const u of ["https://hooks.stripe.com/3d_secure_2/hosted?x=1", "https://js.stripe.com/v3/three-ds-2-challenge-abc.html", "https://acs.examplebank.com/challenge", "https://secure.bank.example/acs?tx=1"]) {
    assert.equal(detect({ ...base, frameUrls: ["https://shop.example/checkout", u] })?.kind, "verification", u);
  }
  assert.equal(detect({ ...base, frameUrls: ["https://cdn.example/accessories.png", "https://example.com/access"] }), null);
  // A long checkout with the bank frame still counts; a long article about 3-D Secure doesn't.
  assert.equal(detect({ ...base, textLength: 9000, frameUrls: ["https://acs.examplebank.com/challenge"] })?.kind, "verification");
  assert.equal(detect({ ...base, textLength: 9000, textSample: "How 3-D Secure works, explained" }), null);
});

describe("frame precision (findings from a live Stripe run)", () => {
  const top = "http://site-a.test:8090/checkout/stripe/element?case=3ds";
  const stripePage = { ...base, url: top, textLength: 900 };
  const invisibleHcaptcha = [
    "https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html#frame=checkbox-invisible",
    "https://newassets.hcaptcha.com/captcha/v1/abc123/static/hcaptcha.html#frame=challenge&id=x&host=b.stripecdn.com",
    "https://b.stripecdn.com/stripethirdparty-srv/assets/v37.1/HCaptchaInvisible.html",
    "https://js.stripe.com/v3/hcaptcha-invisible-1a2b3c.html",
  ];
  const telemetry = ["https://js.stripe.com/v3/m-outer-abc.html#url=http%3A%2F%2Fsite-a.test%2Fcheckout%3Fcase%3D3ds&title=Pay%20(3ds)", "https://m.stripe.network/inner.html#url=case%3D3ds"];
  test("a Stripe checkout before Pay is not a wall (invisible hCaptcha, '3ds' only in URLs' data)", () => {
    assert.equal(detect({ ...stripePage, frameUrls: [top, ...invisibleHcaptcha, ...telemetry, "https://js.stripe.com/v3/elements-inner-accessory-target-9f8e.html"] }), null);
  });
  test("after Pay, the real 3-D Secure frames are a verification", () => {
    const after = [top, ...invisibleHcaptcha, "https://js.stripe.com/v3/three-ds-2-challenge-77aa.html#intentId=pi_1&hosted=false", "https://testmode-acs.stripe.com/3d_secure_2_test/acct_1/tds2_1/x"];
    assert.equal(detect({ ...stripePage, frameUrls: after })?.kind, "verification");
    assert.equal(detect({ ...stripePage, frameUrls: [top, "https://hooks.stripe.com/3d_secure_2/hosted?merchant=x&payment_intent=pi_1"] })?.kind, "verification");
  });
  test("a 3-D Secure redirect is the page itself", () => {
    assert.equal(detect({ ...base, url: "https://hooks.stripe.com/3d_secure_2/hosted?merchant=x&payment_intent=pi_1", frameUrls: ["https://hooks.stripe.com/3d_secure_2/hosted?merchant=x&payment_intent=pi_1"] })?.kind, "verification");
  });
  test("a short page that only mentions 3-D Secure isn't a bank check", () => {
    assert.equal(detect({ ...base, textLength: 600, textSample: "FAQ: what is 3-D Secure? Verify this payment with your bank when asked." }), null);
  });
  test("'3ds' in the page's own URL or a path segment isn't a bank check", () => {
    assert.equal(detect({ ...base, url: "https://www.nintendo.com/3ds/", frameUrls: ["https://www.nintendo.com/3ds/"] }), null);
    assert.equal(detect({ ...base, url: "https://shop.example/search?q=3ds", frameUrls: ["https://shop.example/search?q=3ds", "https://cdn.example/embed?q=3ds"] }), null);
  });
  test("invisible reCAPTCHA isn't a wall; a visible container still is", () => {
    const frames = ["https://www.google.com/recaptcha/api2/anchor?ar=1&k=x&size=invisible&cb=1", "https://www.google.com/recaptcha/api2/bframe?hl=en&v=1&k=x"];
    assert.equal(detect({ ...base, textLength: 900, frameUrls: frames }), null);
    assert.equal(detect({ ...base, textLength: 900, frameUrls: frames, captchaContainers: [".g-recaptcha:not([data-size=invisible])"] })?.kind, "captcha");
  });
});

test("Reddit's own walls (seen live, 11 Nov 2026)", () => {
  assert.deepEqual([detect({ ...base, url: "https://www.reddit.com/r/selfhosted/", title: "Reddit - Prove your humanity", textLength: 300 })?.kind, "captcha"], ["captcha", "captcha"]);
  assert.equal(detect({ ...base, url: "https://www.reddit.com/r/selfhosted/", title: "", textSample: "You've been blocked by network security. If you think you've been blocked by mistake, file a ticket below", textLength: 200 })?.kind, "soft_block");
});

test("a captcha inside a submit form is not a wall (Reddit's submit page, seen live)", () => {
  const submit = { ...base, url: "https://old.reddit.com/r/AI_Agents/submit?selftext=true", textLength: 1800, formCaptchas: [".g-recaptcha:not([data-size=invisible])"], frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"] };
  assert.equal(detect(submit), null);
  // A login form with a captcha is still a wall, and so is a bare challenge page.
  assert.equal(detect({ ...submit, hasPasswordField: true })?.kind, "captcha");
  assert.equal(detect({ ...base, url: "https://www.google.com/sorry/index", textLength: 400, captchaContainers: [".g-recaptcha:not([data-size=invisible])"] })?.kind, "captcha");
});
