// SPDX-License-Identifier: AGPL-3.0-only
// /__testsite/: the test harness. Served only on localhost/testsite (see isHarnessHost), never on
// the `.test` hosts, so an agent browsing through Crossbar can't reconfigure the site it's tested on.
import type { Router } from "../app.ts";
import { json, send } from "../context.ts";
import { esc, page } from "../html.ts";
import { modeString, PROVIDERS, SCOPES, STYLES, resolveConfig, type GateOverrides } from "../gate.ts";
import { SCENARIOS } from "../scenarios.ts";

const KEYS = ["mode", "scope", "style", "provider", "clearance", "clearance_minutes", "status"] as const;

export function registerHarness(r: Router): void {
  r.add("*", "GET", "/__testsite/log", (ctx, app) => {
    const q = ctx.url.searchParams;
    json(ctx, 200, app.log.list({ host: q.get("host") ?? undefined, method: q.get("method") ?? undefined, pathPrefix: q.get("path") ?? undefined, since: q.has("since") ? Number(q.get("since")) : undefined }));
  });
  r.add("*", "POST", "/__testsite/reset", (ctx, app) => {
    if (ctx.url.searchParams.get("all") === "1") app.resetAll();
    else app.log.reset();
    json(ctx, 200, { ok: true, all: ctx.url.searchParams.get("all") === "1" });
  });
  r.add("*", "GET", "/__testsite/scenarios", (ctx) => json(ctx, 200, SCENARIOS));
  r.add("*", "GET", "/__testsite/gate", (ctx, app) => {
    const cfg = app.gateConfig(new URLSearchParams());
    json(ctx, 200, { env: app.envGate, admin: app.adminGate, effective: { ...cfg, mode: modeString(cfg.mode) } });
  });
  // Admin layer. Form or JSON; an empty value clears that key. Validated before it's stored.
  r.add("*", "POST", "/__testsite/gate", (ctx, app) => {
    const next: GateOverrides = { ...app.adminGate };
    for (const k of KEYS) {
      if (!(k in ctx.body)) continue;
      const v = ctx.body[k]?.trim();
      if (v) next[k] = v;
      else delete next[k];
    }
    try {
      resolveConfig({ env: app.envGate, admin: next });
    } catch (e) {
      return json(ctx, 400, { error: (e as Error).message });
    }
    app.adminGate = next;
    if (ctx.body.reset_counters === "1" || ctx.body.reset_counters === "true") app.gate.reset();
    if ((ctx.req.headers["content-type"] ?? "").includes("json")) return json(ctx, 200, { admin: app.adminGate });
    send(ctx, 303, "", { location: "/__testsite/" });
  });
  r.add("*", "GET", "/__testsite/", (ctx, app) => {
    const eff = app.gateConfig(new URLSearchParams());
    const field = (k: (typeof KEYS)[number], hint: string) =>
      `<label>${k} <input name="${k}" value="${esc(app.adminGate[k] ?? "")}" placeholder="${esc(hint)}"> <span class="note">env: ${esc(app.envGate[k] ?? "-")}</span></label>`;
    send(ctx, 200, page("Test-site harness", `
<p>Gate precedence: query parameter &gt; this admin setting &gt; env var (<code>TESTSITE_GATE_*</code>) &gt; default.</p>
<p>Effective (no query): <code>mode=${esc(modeString(eff.mode))} scope=${eff.scope} style=${eff.style} provider=${eff.provider} clearance=${eff.clearance ? "on" : "off"} clearance_minutes=${eff.clearanceMinutes} status=${eff.status}</code></p>
<form method="POST" action="/__testsite/gate" class="card">
${field("mode", "always | never | every:N | random:P | after:N")}
${field("scope", SCOPES.join(" | "))}
${field("style", STYLES.join(" | "))}
${field("provider", PROVIDERS.join(" | "))}
${field("clearance", "on | off")}
${field("clearance_minutes", "30")}
${field("status", "403 | 429 | 503")}
<label><input type="checkbox" name="reset_counters" value="1"> reset counters</label>
<button>Save</button></form>
<p>Captcha mode: <strong>${app.live ? "live (real widgets, test keys, needs internet)" : "offline (self-hosted fakes)"}</strong></p>
<ul><li><a href="/__testsite/log">/__testsite/log</a> (filters: host, method, path, since)</li>
<li><code>POST /__testsite/reset</code> clears the log; <code>?all=1</code> also clears sessions, counters, tokens and content</li>
<li><a href="/__testsite/scenarios">/__testsite/scenarios</a> (scenarios.json)</li>
<li><a href="/__testsite/gate">/__testsite/gate</a> (config as JSON)</li></ul>
<p class="note">Example: <a href="/gated/article?mode=every:3&amp;style=interstitial">/gated/article?mode=every:3&amp;style=interstitial</a></p>`));
  });
  r.add("*", "GET", "/__testsite", (ctx) => send(ctx, 301, "", { location: "/__testsite/" }));
}
