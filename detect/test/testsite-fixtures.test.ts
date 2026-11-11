// SPDX-License-Identifier: AGPL-3.0-only
// Runs detect() over the pages saved by `npm run testsite:fixtures` (detect/fixtures/testsite/).
// Facts are approximated from the saved HTML and HAR headers, the way browser/ would observe them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detect, type PageFactsLike } from "../src/index.ts";

const dir = new URL("../fixtures/testsite/", import.meta.url);
const index = JSON.parse(readFileSync(new URL("index.json", dir), "utf8")) as {
  fixtures: Array<{ name: string; url: string; status: number; html: string; har: string; expect: string | null }>;
};

function facts(url: string, status: number, html: string, headers: Record<string, string>): PageFactsLike {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    url,
    title: /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "",
    status,
    headers,
    frameUrls: [url, ...[...html.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"))],
    hasPasswordField: /type="password"/i.test(html),
    hasOtpField: /autocomplete="one-time-code"/i.test(html),
    textLength: text.length,
    textSample: text.slice(0, 2000),
  };
}

for (const f of index.fixtures) {
  test(`testsite fixture ${f.name}: ${f.expect ?? "no block"}`, () => {
    const html = readFileSync(new URL(f.html, dir), "utf8");
    const har = JSON.parse(readFileSync(new URL(f.har, dir), "utf8")) as { log: { entries: Array<{ response: { headers: Array<{ name: string; value: string }> } }> } };
    const headers = Object.fromEntries(har.log.entries[0]!.response.headers.map((h) => [h.name.toLowerCase(), h.value]));
    assert.equal(detect(facts(f.url, f.status, html, headers))?.kind ?? null, f.expect);
  });
}
