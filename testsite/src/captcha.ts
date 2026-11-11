// SPDX-License-Identifier: AGPL-3.0-only
// Captchas for the test site. NOTHING HERE SOLVES A CAPTCHA.
//
// offline (default): self-hosted fakes that reproduce the DOM and network signatures `detect/` looks
//   for (iframe src patterns, container classes, response headers, interstitial text). The fake frame
//   is served from captcha.test so it is cross-origin like the real ones. It issues a token only when a
//   trusted (physical) click lands on it; Crossbar's job is to make sure that click is a person's,
//   during takeover. The server verifies tokens: missing, unknown, wrong-provider, expired or reused fail.
// live (TESTSITE_CAPTCHA=live, manual only, needs internet): the real widgets with the providers'
//   published test keys, verified against the real siteverify endpoints. Arkose, DataDome and
//   PerimeterX publish no test keys, so they stay fakes in live mode.
import { randomBytes } from "node:crypto";
import { esc } from "./html.ts";
import type { Provider } from "./gate.ts";

export interface ProviderInfo {
  label: string;
  /** Container class/id real integrations use; detect/ and adapters may key on it. */
  container: string;
  /** Form field the widget fills with its token. */
  responseField: string;
  /** Path on captcha.test for the fake frame. The path embeds the real vendor's URL shape. */
  framePath: string;
  /** Extra response headers the vendor's interstitial carries. */
  interstitialHeaders: Record<string, string>;
  interstitialTitle: string;
  interstitialText: string;
}

export const PROVIDER_INFO: Record<Provider, ProviderInfo> = {
  turnstile: {
    label: "Cloudflare Turnstile",
    container: `class="cf-turnstile"`,
    responseField: "cf-turnstile-response",
    framePath: "/challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv/fake/normal",
    interstitialHeaders: { "cf-mitigated": "challenge", server: "cloudflare", "cf-ray": "0000000000000000-TST" },
    interstitialTitle: "Just a moment...",
    interstitialText: "Verify you are human by completing the action below. site-a.test needs to review the security of your connection before proceeding.",
  },
  recaptcha: {
    label: "Google reCAPTCHA v2",
    container: `class="g-recaptcha"`,
    responseField: "g-recaptcha-response",
    framePath: "/google.com/recaptcha/api2/anchor?ar=1&k=fake&co=fake&hl=en&v=fake&size=normal",
    interstitialHeaders: {},
    interstitialTitle: "One more step",
    interstitialText: "Please complete the security check to access this page.",
  },
  hcaptcha: {
    label: "hCaptcha",
    container: `class="h-captcha"`,
    responseField: "h-captcha-response",
    framePath: "/newassets.hcaptcha.com/captcha/v1/fake/static/hcaptcha.html#frame=checkbox",
    interstitialHeaders: {},
    interstitialTitle: "Security check",
    interstitialText: "Please complete the security check to access this page.",
  },
  arkose: {
    label: "Arkose Labs (FunCaptcha)",
    container: `id="arkose-enforcement" class="arkose-enforcement" data-arkose`,
    responseField: "fc-token",
    framePath: "/client-api.arkoselabs.com/fc/assets/ec-game-core/game-core/fake/standard/index.html",
    interstitialHeaders: {},
    interstitialTitle: "Verification required",
    interstitialText: "Solve the puzzle to continue.",
  },
  datadome: {
    label: "DataDome",
    container: `id="ddChallenge" class="datadome-captcha"`,
    responseField: "datadome-response",
    framePath: "/geo.captcha-delivery.com/captcha/?initialCid=fake&hash=fake&cid=fake&t=fe&referer=fake",
    interstitialHeaders: { "x-datadome": "protected", "x-dd-b": "1" },
    interstitialTitle: "site-a.test",
    interstitialText: "Please enable JS and disable any ad blocker",
  },
  perimeterx: {
    label: "HUMAN / PerimeterX",
    container: `id="px-captcha"`,
    responseField: "px-response",
    framePath: "/px-cdn.net/px-captcha/fake/captcha.html",
    interstitialHeaders: {},
    interstitialTitle: "Access to this page has been denied.",
    interstitialText: "Press & Hold to confirm you are a human (and not a bot).",
  },
};

// ---------------------------------------------------------------------------------------------
// Fake tokens

interface Issued {
  provider: Provider;
  issuedAt: number;
  used: boolean;
}

export type VerifyResult = { ok: true } | { ok: false; error: "missing-input-response" | "invalid-input-response" | "wrong-provider" | "timeout-or-duplicate" };

export class FakeTokens {
  private tokens = new Map<string, Issued>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(ttlMs = 300_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Called only by the fake frame's click handler (POST /__captcha/issue on captcha.test). */
  issue(provider: Provider): string {
    const token = `fake.${provider}.${randomBytes(18).toString("base64url")}`;
    this.tokens.set(token, { provider, issuedAt: this.now(), used: false });
    return token;
  }

  /** Single use, like the real siteverify endpoints. */
  verify(provider: Provider, token: string | undefined): VerifyResult {
    if (!token) return { ok: false, error: "missing-input-response" };
    const t = this.tokens.get(token);
    if (!t) return { ok: false, error: "invalid-input-response" };
    if (t.provider !== provider) return { ok: false, error: "wrong-provider" };
    if (t.used || this.now() - t.issuedAt > this.ttlMs) {
      t.used = true;
      return { ok: false, error: "timeout-or-duplicate" };
    }
    t.used = true;
    return { ok: true };
  }

  reset(): void {
    this.tokens.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Live mode: the providers' published test keys (sources in testsite/README.md).

export const LIVE_KEYS = {
  turnstile: {
    // https://developers.cloudflare.com/turnstile/troubleshooting/testing/
    sitekeys: {
      "1x00000000000000000000AA": "visible, always passes",
      "2x00000000000000000000AB": "visible, always blocks",
      "1x00000000000000000000BB": "invisible, always passes",
      "2x00000000000000000000BB": "invisible, always blocks",
      "3x00000000000000000000FF": "forces an interactive challenge",
    } as Record<string, string>,
    secrets: {
      "1x0000000000000000000000000000000AA": "always passes",
      "2x0000000000000000000000000000000AA": "always fails",
      "3x0000000000000000000000000000000AA": "token already spent",
    } as Record<string, string>,
    defaultSitekey: "1x00000000000000000000AA",
    defaultSecret: "1x0000000000000000000000000000000AA",
    script: "https://challenges.cloudflare.com/turnstile/v0/api.js",
    verify: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  },
  recaptcha: {
    // https://developers.google.com/recaptcha/docs/faq ; verify: https://developers.google.com/recaptcha/docs/verify
    sitekeys: { "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI": "v2 test key, always passes" } as Record<string, string>,
    secrets: { "6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe": "always passes" } as Record<string, string>,
    defaultSitekey: "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI",
    defaultSecret: "6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe",
    script: "https://www.google.com/recaptcha/api.js",
    verify: "https://www.google.com/recaptcha/api/siteverify",
  },
  hcaptcha: {
    // https://docs.hcaptcha.com/#integration-testing-test-keys
    sitekeys: {
      "10000000-ffff-ffff-ffff-000000000001": "publisher test key, never challenges, always passes",
      "20000000-ffff-ffff-ffff-000000000002": "enterprise safe end user",
      "30000000-ffff-ffff-ffff-000000000003": "enterprise bot detected",
    } as Record<string, string>,
    secrets: { "0x0000000000000000000000000000000000000000": "test secret for every test sitekey" } as Record<string, string>,
    defaultSitekey: "10000000-ffff-ffff-ffff-000000000001",
    defaultSecret: "0x0000000000000000000000000000000000000000",
    script: "https://js.hcaptcha.com/1/api.js",
    verify: "https://api.hcaptcha.com/siteverify",
  },
} as const;
type LiveProvider = keyof typeof LIVE_KEYS;

export function isLiveCapable(p: Provider): p is LiveProvider {
  return p in LIVE_KEYS;
}

/** Only the published test keys are accepted, so a query parameter can't point the site at a real key. */
export function liveKeys(p: LiveProvider, q: URLSearchParams): { sitekey: string; secret: string } {
  const k = LIVE_KEYS[p];
  const sk = q.get("sitekey");
  const sec = q.get("secret");
  return {
    sitekey: sk && sk in k.sitekeys ? sk : k.defaultSitekey,
    secret: sec && sec in k.secrets ? sec : k.defaultSecret,
  };
}

export async function verifyLive(p: LiveProvider, secret: string, token: string | undefined, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: unknown }> {
  if (!token) return { ok: false, detail: { "error-codes": ["missing-input-response"] } };
  const r = await fetchImpl(LIVE_KEYS[p].verify, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret, response: token }),
  });
  const detail = (await r.json()) as { success?: boolean };
  return { ok: detail.success === true, detail };
}

// ---------------------------------------------------------------------------------------------
// Rendering

export interface WidgetOpts {
  provider: Provider;
  live: boolean;
  /** Absolute URL of the fake frame on captcha.test (built per request so `.localhost` access works). */
  frameUrl: string;
  /** Live sitekey (ignored offline). */
  sitekey?: string;
  /** Submit the enclosing form as soon as a token arrives (interstitials). */
  autosubmit?: boolean;
}

/** The widget as it appears inside a form. Offline: container + cross-origin iframe + hidden response field. */
export function widgetHtml(o: WidgetOpts): string {
  const info = PROVIDER_INFO[o.provider];
  if (o.live && isLiveCapable(o.provider)) {
    const k = LIVE_KEYS[o.provider];
    return `<div ${info.container} data-sitekey="${esc(o.sitekey ?? k.defaultSitekey)}"${o.autosubmit ? ` data-callback="__tsSubmit"` : ""}></div>
<script src="${esc(k.script)}" async defer></script>
${o.autosubmit ? `<script>function __tsSubmit(){document.querySelector('form[data-captcha]').submit()}</script>` : ""}`;
  }
  return `<div ${info.container} data-sitekey="testsite-fake" data-testsite-fake="${o.provider}">
  <iframe src="${esc(o.frameUrl)}" title="${esc(info.label)} (test-site fake)" width="304" height="78" style="border:1px solid #bbb;border-radius:4px" sandbox="allow-scripts allow-same-origin"></iframe>
  <input type="hidden" name="${esc(info.responseField)}" value="">
</div>
<script>
addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.type !== "testsite-captcha" || d.provider !== ${JSON.stringify(o.provider)}) return;
  if (new URL(${JSON.stringify(o.frameUrl)}).origin !== e.origin) return;
  const f = document.querySelector('input[name=${JSON.stringify(info.responseField)}]');
  f.value = d.token;
  ${o.autosubmit ? `f.form.submit();` : ""}
});
</script>`;
}

/** The fake frame served on captcha.test. A person clicks it; a script calling .click() gets nothing. */
export function fakeFrameHtml(provider: Provider): string {
  const info = PROVIDER_INFO[provider];
  const holdy = provider === "perimeterx";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(info.label)}</title>
<style>body{margin:0;font:14px system-ui,sans-serif;background:#f9f9f9;color:#222}
.box{display:flex;align-items:center;gap:10px;height:74px;padding:0 12px;box-sizing:border-box}
button{width:28px;height:28px;border:2px solid #888;border-radius:3px;background:#fff;cursor:pointer}
.ok{border-color:#2a8;background:#2a8}.v{margin-left:auto;font-size:10px;color:#777;text-align:right}</style></head>
<body><div class="box" id="challenge-stage">
<button id="cb" aria-label="${holdy ? "Press and hold" : "I'm not a robot"}"></button>
<span id="label">${holdy ? "Press &amp; Hold" : "I'm not a robot"}</span>
<span class="v">${esc(info.label)}<br>test-site fake</span></div>
<script>
const cb = document.getElementById("cb");
let held = 0;
async function done(e) {
  if (!e.isTrusted) return;                 // synthetic clicks from page script never issue a token
  ${holdy ? `if (Date.now() - held < 1500) { document.getElementById("label").textContent = "Hold longer"; return; }` : ""}
  const r = await fetch("/__captcha/issue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: ${JSON.stringify(provider)} }) });
  const { token } = await r.json();
  cb.classList.add("ok");
  document.getElementById("label").textContent = "Verified (fake)";
  parent.postMessage({ type: "testsite-captcha", provider: ${JSON.stringify(provider)}, token }, "*");
}
${holdy ? `cb.addEventListener("pointerdown", (e) => { if (e.isTrusted) held = Date.now(); }); cb.addEventListener("pointerup", done);` : `cb.addEventListener("click", done);`}
</script></body></html>`;
}

/** A full-page challenge. Status and headers are set by the caller from PROVIDER_INFO. */
export function interstitialHtml(o: WidgetOpts & { action: string; returnTo: string; host: string }): string {
  const info = PROVIDER_INFO[o.provider];
  const text = info.interstitialText.replace("site-a.test", o.host);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(info.interstitialTitle.replace("site-a.test", o.host))}</title>
<style>body{font:16px system-ui,sans-serif;max-width:560px;margin:10vh auto;padding:16px}h1{font-size:28px}</style></head>
<body${o.provider === "turnstile" ? ` class="no-js"` : ""}>
<h1>${esc(o.host)}</h1>
<h2 id="challenge-title">${esc(info.interstitialTitle.replace("site-a.test", o.host))}</h2>
<p id="challenge-body-text">${esc(text)}</p>
<form method="POST" action="${esc(o.action)}" data-captcha id="challenge-form">
<input type="hidden" name="provider" value="${esc(o.provider)}">
<input type="hidden" name="return_to" value="${esc(o.returnTo)}">
${widgetHtml({ ...o, autosubmit: true })}
<noscript><button>Continue</button></noscript>
</form>
${o.provider === "turnstile" ? `<div class="footer">Performance &amp; security by Cloudflare (test-site fake)</div>` : ""}
</body></html>`;
}
