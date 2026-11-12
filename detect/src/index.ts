// SPDX-License-Identifier: AGPL-3.0-only
// Block detection (ADR 0001): page facts -> BlockState. Signatures are data; no side effects.
// v1 uses known signatures only; an LLM or vision fallback comes after v1.

export type BlockKind = "captcha" | "verification" | "login" | "consent" | "soft_block";

export interface BlockState {
  kind: BlockKind;
  vendor: string;
  origin: string;
  evidence: string[];
}

/** What the browser observed. Built by browser/ (Tab.facts), never by an agent. */
export interface PageFactsLike {
  url: string;
  title: string;
  status: number | null;
  headers: Record<string, string>;
  frameUrls: string[];
  hasPasswordField: boolean;
  hasOtpField: boolean;
  /** Known captcha container selectors present on the page (any frame), outside a fillable form. */
  captchaContainers?: string[];
  /** Captcha widgets inside a form with other fields to fill (a submit form): not a wall over the page. */
  formCaptchas?: string[];
  textLength: number;
  textSample: string;
}

export interface Signature {
  id: string;
  kind: BlockKind;
  vendor: string;
  /** Any of these frame URL patterns present. */
  frames?: RegExp[];
  /** Any of these container selectors present (as reported by the browser). */
  containers?: string[];
  /** Frame and container evidence counts on any page, not only short ones (a 3-D Secure frame on a long checkout). */
  anyPage?: boolean;
  /**
   * If any frame's full URL matches this, the vendor's widget is the invisible kind (it only becomes a
   * challenge when it shows itself): its frame evidence is ignored. A visible container still counts.
   */
  invisibleMarker?: RegExp;
  /** Response header name -> value pattern. */
  headers?: Record<string, RegExp>;
  status?: number[];
  /** Page text or title pattern. */
  text?: RegExp[];
  url?: RegExp[];
  /** Only match when the page has little visible text (an interstitial, not an article mentioning it). */
  maxTextLength?: number;
}

export const SIGNATURES: Signature[] = [
  { id: "cloudflare-challenge-header", kind: "captcha", vendor: "cloudflare", headers: { "cf-mitigated": /challenge/i } },
  { id: "cloudflare-turnstile", kind: "captcha", vendor: "cloudflare", frames: [/challenges\.cloudflare\.com\//i, /\/cdn-cgi\/challenge-platform\//i], containers: [".cf-turnstile", "[data-sitekey].cf-turnstile"] },
  { id: "cloudflare-interstitial", kind: "captcha", vendor: "cloudflare", text: [/Verify you are human|Checking (if the site connection is secure|your browser)|Just a moment\.\.\./i], maxTextLength: 2000 },
  {
    id: "recaptcha",
    kind: "captcha",
    vendor: "recaptcha",
    frames: [/\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/i, /recaptcha\.net\/recaptcha\//i],
    invisibleMarker: /\/recaptcha\/(api2|enterprise)\/anchor\?[^#]*\bsize=invisible\b/i,
    containers: [".g-recaptcha:not([data-size=invisible])", "#g-recaptcha:not([data-size=invisible])"],
  },
  {
    id: "hcaptcha",
    kind: "captcha",
    vendor: "hcaptcha",
    frames: [/hcaptcha\.com\/captcha/i, /newassets\.hcaptcha\.com/i, /\/captcha\/v1\/[^/]+\/static\/hcaptcha\.html/i],
    // Stripe's Payment Element loads an invisible hCaptcha on every checkout.
    invisibleMarker: /[#&]frame=checkbox-invisible\b|HCaptchaInvisible|hcaptcha-invisible/i,
    containers: [".h-captcha:not([data-size=invisible])"],
  },
  { id: "arkose", kind: "captcha", vendor: "arkose", frames: [/arkoselabs\.com|funcaptcha\.com|\/fc\/gc\//i], containers: ["#FunCaptcha", "[data-pkey]"] },
  { id: "datadome", kind: "captcha", vendor: "datadome", frames: [/captcha-delivery\.com|geo\.captcha-delivery\.com/i], headers: { "x-datadome": /.+/ }, containers: ["[class*=datadome]", "#ddv1-captcha-container"] },
  { id: "perimeterx", kind: "captcha", vendor: "perimeterx", text: [/Press & Hold to confirm you are a human/i], frames: [/px-cdn\.net|perimeterx\.net|px-captcha/i], containers: ["#px-captcha", "[id^=px-captcha]"] },
  { id: "aws-waf", kind: "captcha", vendor: "aws-waf", frames: [/awswaf\.com/i], headers: { "x-amzn-waf-action": /captcha|challenge/i } },
  // 3-D Secure and other step-up checks by a card issuer (ADR 0011). Matched by frame shape, not one provider's URLs.
  { id: "three-d-secure-frame", kind: "verification", vendor: "3ds", anyPage: true, frames: [/three[-_]?d[-_]?s|3d[-_]?secure|\/acs(\/|$)|(^|[./-])acs[.-]/i] },
  { id: "rate-limited", kind: "soft_block", vendor: "generic", status: [429] },
  { id: "forbidden-short", kind: "soft_block", vendor: "generic", status: [403, 503], maxTextLength: 1500 },
  { id: "reddit-humanity", kind: "captcha", vendor: "reddit", text: [/Prove your humanity/i], maxTextLength: 3000 },
  { id: "reddit-blocked", kind: "soft_block", vendor: "reddit", text: [/You've been blocked by network security|whoa there, pardner/i], maxTextLength: 3000 },
  { id: "login-url", kind: "login", vendor: "generic", url: [/\/(login|signin|sign-in|log-in|auth\/login|accounts\/login)(\/|\?|$)/i] },
  // Truncated content behind an app gate. Limited to shortish pages: a full page with an "Open in app"
  // banner isn't a soft block.
  {
    id: "app-gate",
    kind: "soft_block",
    vendor: "app-gate",
    text: [/\b(see|read|view) (more|the (full|rest)( \w+)?) in the app\b|continue (reading|in the app)[^.]{0,60}\bapp\b|(open|use) the app to (see|read|view|continue)|to keep reading,? (open|get|download) the app/i],
    maxTextLength: 4000,
  },
  { id: "anti-adblock", kind: "soft_block", vendor: "anti-adblock", text: [/(disable|turn off|pause) (your )?ad ?block(er)?|whitelist (this|our) site/i], maxTextLength: 3000 },
  { id: "consent-wall", kind: "consent", vendor: "generic", text: [/we value your privacy|accept all cookies|consent to (the use of )?cookies/i], maxTextLength: 1200 },
];

function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.replace(/[?#].*$/, "");
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** A widget on a long page without a login form is part of the page (a comment form), not a wall. */
export const WIDGET_PAGE_TEXT_LIMIT = 6000;

function matches(sig: Signature, f: PageFactsLike): string[] | null {
  const ev: string[] = [];
  // A form captcha (the widget sits in a form with other fields, e.g. Reddit's submit form) gates sending
  // that form, not reading the page; its frames don't make a wall either. Login forms still do.
  const onlyFormWidgets = !!f.formCaptchas?.length && !f.captchaContainers?.length && !f.hasPasswordField;
  const widgetCounts = (sig.anyPage || f.textLength <= WIDGET_PAGE_TEXT_LIMIT || f.hasPasswordField) && (sig.anyPage || !onlyFormWidgets);
  if (sig.maxTextLength !== undefined && f.textLength > sig.maxTextLength) return null;
  let any = false;
  if (sig.headers) {
    for (const [h, re] of Object.entries(sig.headers)) {
      const v = f.headers[h.toLowerCase()];
      if (v !== undefined && re.test(v)) {
        any = true;
        ev.push(`header ${h}: ${v.slice(0, 60)}`);
      }
    }
  }
  if (sig.frames && widgetCounts) {
    // Matched on host and path only: a query or fragment (?case=3ds, #url=…) is page data, not a frame's identity.
    // The top-level page counts too (a 3-D Secure redirect is the page itself).
    const children = [...new Set([f.url, ...f.frameUrls])];
    const invisible = sig.invisibleMarker && children.some((u) => sig.invisibleMarker!.test(u));
    const hit = invisible ? undefined : children.find((u) => sig.frames!.some((re) => re.test(hostPath(u))));
    if (hit) {
      any = true;
      ev.push(`frame ${hit.slice(0, 120)}`);
    }
  }
  if (sig.containers && widgetCounts && f.captchaContainers?.length) {
    const hit = sig.containers.find((c) => f.captchaContainers!.includes(c));
    if (hit) {
      any = true;
      ev.push(`container ${hit}`);
    }
  }
  if (sig.status && f.status !== null && sig.status.includes(f.status)) {
    any = true;
    ev.push(`status ${f.status}`);
  }
  if (sig.text) {
    const hay = `${f.title}\n${f.textSample}`;
    const re = sig.text.find((r) => r.test(hay));
    if (re) {
      any = true;
      ev.push(`text ${hay.match(re)![0].slice(0, 60)}`);
    }
  }
  if (sig.url && sig.url.some((re) => re.test(f.url))) {
    any = true;
    ev.push(`url ${f.url.slice(0, 120)}`);
  }
  return any ? ev : null;
}

const PRIORITY: Record<BlockKind, number> = { captcha: 0, verification: 1, login: 2, soft_block: 3, consent: 4 };

/** The most important block on the page, or null. */
export function detect(f: PageFactsLike, signatures: Signature[] = SIGNATURES): BlockState | null {
  const hits: Array<{ sig: Signature; ev: string[] }> = [];
  for (const sig of signatures) {
    const ev = matches(sig, f);
    if (ev) hits.push({ sig, ev });
  }
  // A login wall: a password field on a short page, with no captcha.
  if (f.hasPasswordField && f.textLength < 4000) hits.push({ sig: { id: "password-field", kind: "login", vendor: "generic" }, ev: ["password field on a short page"] });
  if (f.hasOtpField) hits.push({ sig: { id: "otp-field", kind: "login", vendor: "generic" }, ev: ["one-time-code field"] });
  if (hits.length === 0) return null;
  hits.sort((a, b) => PRIORITY[a.sig.kind] - PRIORITY[b.sig.kind]);
  const top = hits[0]!;
  const evidence = hits.filter((h) => h.sig.kind === top.sig.kind).flatMap((h) => [`${h.sig.id}: ${h.ev.join("; ")}`]);
  return { kind: top.sig.kind, vendor: top.sig.vendor, origin: originOf(f.url), evidence };
}
