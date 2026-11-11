// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
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
  assert.equal(detect({ ...base, textLength: 20000, hasPasswordField: true, captchaContainers: [".g-recaptcha"] })?.kind, "captcha");
});
test("a reCAPTCHA in a long article's comment form is not a wall", () => {
  assert.equal(detect({ ...base, textLength: 20000, captchaContainers: [".g-recaptcha"], frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"] }), null);
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
  assert.equal(detect({ ...base, textLength: 600, textSample: "Verify this payment with your bank" })?.kind, "verification");
  assert.equal(detect({ ...base, frameUrls: ["https://cdn.example/accessories.png", "https://example.com/access"] }), null);
  // A long checkout with the bank frame still counts; a long article about 3-D Secure doesn't.
  assert.equal(detect({ ...base, textLength: 9000, frameUrls: ["https://acs.examplebank.com/challenge"] })?.kind, "verification");
  assert.equal(detect({ ...base, textLength: 9000, textSample: "How 3-D Secure works, explained" }), null);
});
