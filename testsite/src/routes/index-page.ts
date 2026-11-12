// SPDX-License-Identifier: AGPL-3.0-only
// `/` on site-a.test lists every scenario with its expected outcome. Other hosts get a small landing page.
import type { Router } from "../app.ts";
import { hostUrl, send } from "../context.ts";
import { esc, outcomeTag, page } from "../html.ts";
import { SCENARIOS } from "../scenarios.ts";

export function registerIndex(r: Router): void {
  r.add("site-a.test", "GET", "/", (ctx, app) => {
    const areas = [...new Set(SCENARIOS.map((s) => s.area))];
    const sections = areas
      .map((area) => {
        const rows = SCENARIOS.filter((s) => s.area === area)
          .map((s) => {
            const feature = s.requires ? app.features.get(s.requires) : undefined;
            const off = !!s.requires && !feature?.enabled;
            const href = hostUrl(ctx, s.host, s.path);
            const checks = (s.checks ?? []).map((c) => `<div>${esc(c.on)}: ${outcomeTag(c.outcome)}</div>`).join("");
            return `<tr class="${off ? "disabled" : ""}" data-scenario="${esc(s.id)}">
<td>${off ? esc(s.title) : `<a href="${esc(href)}">${esc(s.title)}</a>`}${s.mode === "live" ? ` <span class="warn">live-only</span>` : ""}${off ? `<div class="note">disabled: ${esc(feature?.why ?? `${s.requires} is not configured`)}</div>` : ""}</td>
<td><code>${esc(s.host)}${esc(s.path)}</code></td>
<td>${outcomeTag(s.outcome)}${checks ? `<div class="note">${checks}</div>` : ""}</td>
<td class="note">${esc(s.notes ?? "")}</td></tr>`;
          })
          .join("");
        return `<h2>${esc(area)}</h2><table><thead><tr><th>Scenario</th><th>Path</th><th>Expected</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
      })
      .join("");
    send(ctx, 200, page("Crossbar test site", `
<p>Every page here is a fixture for Crossbar. Credentials, cards and messages are fake. Captcha mode: <strong>${app.live ? "live" : "offline"}</strong>.
Expected outcomes use the Access Model's classes (<code>read</code>, <code>asks</code>, <code>always_asks</code>, <code>never</code>, <code>blocked</code>, <code>blocked:&lt;kind&gt;</code>, <code>opens_anonymous</code>).</p>
<p class="note">Fixture logins: <code>alice</code> / <code>correct-horse-battery-staple</code>; <code>bob</code> / <code>tr0ub4dor-and-3</code> with TOTP secret <code>JBSWY3DPEHPK3PXP</code>.</p>
${sections}`, { host: ctx.host }));
  });

  const blurb: Record<string, string> = {
    "site-b.test": "Second registrable domain: redirect hops, the consent banner, a cross-origin frame and the wrong-origin login.",
    "site-c.test": "Third registrable domain: end of the redirect chain.",
    "exfil.test": "Logs everything it receives. Tests assert nothing arrived here.",
    "tracker.test": "Third-party pixel, frame and cookie attempts.",
    "accounts.idp.test": "A sign-in provider.",
  };
  for (const [host, text] of Object.entries(blurb)) {
    r.add(host as never, "GET", "/", (ctx) => send(ctx, 200, page(host, `<p>${esc(text)}</p><p><a href="${esc(hostUrl(ctx, "site-a.test", "/"))}">Scenario index on site-a.test</a></p>`, { host })));
  }
}
