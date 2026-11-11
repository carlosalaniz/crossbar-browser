// SPDX-License-Identifier: AGPL-3.0-only
// The local test site for `npm run dev`: article, infinite feed, virtualized list, login wall,
// block-signature fixtures and the Reddit fixture. No accounts anywhere.
import { startSite } from "../browser/test/site.ts";

const port = Number(process.env.PORT ?? 8090);
const site = await startSite({ host: process.env.HOST ?? "0.0.0.0", port });
const base = process.env.PUBLIC_BASE ?? `http://testsite.test:${port}`;
console.log(`test site on :${site.port}`);
let seen = 0;
setInterval(() => {
  for (const h of site.hits.slice(seen)) console.log(`HIT ${h.method} ${h.path}`);
  seen = site.hits.length;
}, 250);
console.log(["/pages/article", "/pages/infinite", "/pages/virtual", "/pages/login", "/pages/ads", "/fixture/adapters/reddit/old-reddit-listing.html", "/fixture/detect/cloudflare-interstitial.html"].map((p) => `  ${base}${p}`).join("\n"));
