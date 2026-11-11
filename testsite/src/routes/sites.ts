// SPDX-License-Identifier: AGPL-3.0-only
// Multiple sites (redirect chains, consent banner, tracker), LAN-block links, pacing and soft blocks.
import type { Router } from "../app.ts";
import { appendCookie, hostUrl, newId, redirect, send } from "../context.ts";
import { esc, page } from "../html.ts";

/**
 * LAN targets. Every one must be refused by the proxy *after* DNS resolution.
 * `loopback.test` resolves to 127.0.0.1 via the proxy's /etc/hosts in compose (extra_hosts); it is
 * deliberately NOT on the dev allowlist. Decimal/hex forms check the proxy's host normalisation.
 */
export const LAN_TARGETS: Array<{ id: string; url: string; why: string }> = [
  { id: "rfc1918", url: "http://10.0.0.1/", why: "10/8 private" },
  { id: "metadata", url: "http://169.254.169.254/latest/meta-data/", why: "169.254/16 link-local, cloud metadata" },
  { id: "metadata-decimal", url: "http://2852039166/latest/meta-data/", why: "169.254.169.254 written as a decimal integer" },
  { id: "ipv6-loopback", url: "http://[::1]/", why: "::1 loopback" },
  { id: "ipv4-mapped", url: "http://[::ffff:127.0.0.1]/", why: "IPv4-mapped loopback" },
  { id: "tailscale", url: "http://100.100.100.100/", why: "100.64/10 CGNAT (Tailscale)" },
  { id: "loopback-hex", url: "http://0x7f000001/", why: "127.0.0.1 written in hex" },
  { id: "dns-loopback", url: "http://loopback.test/", why: "a hostname whose DNS answer is 127.0.0.1" },
  { id: "router", url: "http://192.168.1.1/", why: "192.168/16 home router" },
];

const RATE_WINDOW_MS = 60_000;

export function registerSites(r: Router): void {
  // --- Redirect chains A -> B -> C -----------------------------------------------------------
  r.add("site-a.test", "GET", "/chain/start", (ctx) => redirect(ctx, hostUrl(ctx, "site-b.test", "/chain/hop?from=a")));
  r.add("site-b.test", "GET", "/chain/hop", (ctx) => redirect(ctx, hostUrl(ctx, "site-c.test", "/chain/end?from=b"), 301));
  r.add("site-c.test", "GET", "/chain/end", (ctx) => send(ctx, 200, page("End of chain", "<p>site-a.test → site-b.test (302) → site-c.test (301). Every hop is rechecked.</p>", { host: ctx.host })));
  // A POST that survives two 307 hops: the gate must hold it at the first hop, and recheck every hop.
  r.add("site-a.test", "GET", "/chain/post", (ctx) => send(ctx, 200, page("POST through redirects", `<form method="POST" action="/chain/post"><input name="note" value="hello"><button>Send through the chain</button></form>`, { host: ctx.host })));
  r.add("site-a.test", "POST", "/chain/post", (ctx) => redirect(ctx, hostUrl(ctx, "site-b.test", "/chain/post-hop"), 307));
  r.add("site-b.test", "POST", "/chain/post-hop", (ctx) => redirect(ctx, hostUrl(ctx, "site-c.test", "/chain/post-end"), 307));
  r.add("site-c.test", "POST", "/chain/post-end", (ctx) => send(ctx, 200, page("POST arrived", "<p>The POST reached site-c.test.</p>", { host: ctx.host })));
  // Redirect to a LAN target: the proxy must refuse the hop.
  r.add("site-a.test", "GET", "/lan/redirect", (ctx) => {
    const t = LAN_TARGETS.find((x) => x.id === ctx.url.searchParams.get("to")) ?? LAN_TARGETS[1]!;
    redirect(ctx, t.url);
  });
  r.add("site-a.test", "GET", "/lan", (ctx) => {
    send(ctx, 200, page("LAN block", `<p>Links and redirects to private and special addresses. The proxy must refuse every one after resolving DNS.</p>
<table><tr><th>Target</th><th>Why</th><th>Link</th><th>Redirect</th></tr>
${LAN_TARGETS.map((t) => `<tr><td><code>${esc(t.url)}</code></td><td>${esc(t.why)}</td><td><a href="${esc(t.url)}">open</a></td><td><a href="/lan/redirect?to=${t.id}">via 302</a></td></tr>`).join("")}</table>
<p>Subresources too: <img src="http://169.254.169.254/latest/meta-data/x.png" alt="metadata img" width="1" height="1"> <iframe src="http://10.0.0.1/" width="1" height="1" title="lan frame"></iframe></p>`, { host: ctx.host }));
  });

  // --- Consent banner -------------------------------------------------------------------------
  r.add("site-b.test", "GET", "/consent-demo", (ctx) => {
    const choice = ctx.cookies.ts_consent;
    // Enough article text that this is a banner over content, not a consent wall (detect's consent-wall needs a short page).
    send(ctx, 200, page("News on site-b", `<article><h1>Today's fixture news</h1>${"<p>Fixture news paragraph about nothing in particular, long enough to read as an article rather than a wall.</p>".repeat(14)}</article>
${choice ? `<p class="note">Consent stored: ${esc(choice)}</p>` : `<div id="consent-banner" role="dialog" aria-label="Cookie consent" style="position:fixed;inset:auto 0 0 0;background:#fff;color:#111;border-top:2px solid #333;padding:16px">
<p><strong>We value your privacy.</strong> We and our 812 partners use cookies to personalise ads.</p>
<button id="reject-all" onclick="fetch('/consent?choice=reject').then(()=>location.reload())">Reject all</button>
<form method="POST" action="/consent" style="display:inline"><button id="accept-all" name="choice" value="accept">Accept all</button></form></div>`}`, { host: ctx.host }));
  });
  // Reject is a GET (dismissal is reading); Accept is a POST (it shares data with 812 partners).
  r.add("site-b.test", "GET", "/consent", (ctx) => {
    appendCookie(ctx, `ts_consent=reject; Path=/; SameSite=Lax`);
    send(ctx, 204, "");
  });
  r.add("site-b.test", "POST", "/consent", (ctx) => {
    appendCookie(ctx, `ts_consent=accept; Path=/; SameSite=Lax`);
    redirect(ctx, "/consent-demo", 303);
  });
  // A consent *wall*: short page, nothing readable until you choose. Matches detect's consent-wall signature.
  r.add("site-b.test", "GET", "/consent-wall", (ctx) => {
    if (ctx.cookies.ts_consent) return send(ctx, 200, page("Article", "<p>Now you can read the article.</p>".repeat(3), { host: ctx.host }));
    send(ctx, 200, page("Before you continue", `<p>We value your privacy. Accept all cookies to continue, or reject non-essential ones.</p>
<button onclick="fetch('/consent?choice=reject').then(()=>location.reload())">Reject all</button>
<form method="POST" action="/consent" style="display:inline"><button name="choice" value="accept">Accept all</button></form>`, { host: ctx.host }));
  });

  // --- Tracker: third-party cookie attempts ---------------------------------------------------
  r.add("site-a.test", "GET", "/tracked", (ctx) => {
    send(ctx, 200, page("A page with trackers", `<p>Embeds a tracker.test pixel, script and frame. Each tries to set and read a third-party cookie.</p>
<img src="${esc(hostUrl(ctx, "tracker.test", "/pixel.gif?page=tracked"))}" width="1" height="1" alt="">
<script src="${esc(hostUrl(ctx, "tracker.test", "/t.js"))}"></script>
<iframe src="${esc(hostUrl(ctx, "tracker.test", "/frame"))}" width="300" height="60" title="tracker frame"></iframe>`, { host: ctx.host }));
  });
  const trackerCookies = (ctx: Parameters<Parameters<Router["add"]>[3]>[0]) => {
    if (!ctx.cookies.tid) appendCookie(ctx, `tid=${newId(8)}; Path=/; SameSite=None; Secure`);
    if (!ctx.cookies.tid_lax) appendCookie(ctx, `tid_lax=${newId(8)}; Path=/`);
  };
  r.add("tracker.test", "GET", "/pixel.gif", (ctx) => {
    trackerCookies(ctx);
    send(ctx, 200, Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"), { "content-type": "image/gif" });
  });
  r.add("tracker.test", "GET", "/t.js", (ctx) => {
    trackerCookies(ctx);
    send(ctx, 200, `navigator.sendBeacon && navigator.sendBeacon(${JSON.stringify(hostUrl(ctx, "tracker.test", "/collect"))}, JSON.stringify({ ref: location.href }));`, { "content-type": "text/javascript" });
  });
  r.add("tracker.test", "GET", "/frame", (ctx) => {
    trackerCookies(ctx);
    send(ctx, 200, `<!doctype html><body style="font:12px system-ui">tracker frame. cookies seen by the server: <b>${esc(Object.keys(ctx.cookies).join(", ") || "none")}</b>
<script>document.cookie = "tid_js=1; SameSite=None; Secure"; document.body.append(" | document.cookie: " + (document.cookie || "(empty)"));</script>`);
  });
  r.add("tracker.test", "POST", "/collect", (ctx) => send(ctx, 204, ""));

  // --- Pacing: 429 after N requests per minute per host ----------------------------------------
  r.add("*", "GET", "/paced/feed", (ctx, app) => {
    const limit = Math.max(1, Number(ctx.url.searchParams.get("limit") ?? app.env.TESTSITE_RATE_LIMIT ?? 10) || 10);
    const now = app.now();
    const times = (app.rate.get(ctx.host) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    times.push(now);
    app.rate.set(ctx.host, times);
    if (times.length > limit) {
      const retry = Math.ceil((RATE_WINDOW_MS - (now - times[times.length - limit - 1]!)) / 1000);
      return send(ctx, 429, page("Too many requests", "<p>Too many requests. Slow down.</p>", { host: ctx.host }), { "retry-after": String(Math.max(1, retry)) });
    }
    send(ctx, 200, page("Paced feed", `<p>Request ${times.length} of ${limit} this minute on ${esc(ctx.host)}.</p><ol>${Array.from({ length: 10 }, (_, i) => `<li>Feed item ${i + 1}</li>`).join("")}</ol><a href="/paced/feed">next page</a>`, { host: ctx.host }));
  });

  // --- Soft block: 200, truncated, "see more in the app" --------------------------------------
  r.add("site-a.test", "GET", "/soft-block/post", (ctx) => {
    send(ctx, 200, page("A long post", `<article><h1>Ten things about fixtures</h1>
<p>1. Fixtures are fake. 2. Fixtures are deterministic. 3. Fixtures…</p>
<div class="paywall-fade" style="height:60px;background:linear-gradient(transparent,var(--bg))"></div>
<div class="app-gate card"><strong>See more in the app.</strong> Continue reading this post and 4 more comments in the site-a app. <a href="#">Open app</a> <a href="#">Not now</a></div></article>`, { host: ctx.host }));
  });
}
