// SPDX-License-Identifier: AGPL-3.0-only
// MANUAL, never in CI (AGENTS.md rule 4): refresh adapter fixtures from the real site, keeping its
// structure and dropping its content. Text becomes placeholder words of the same length, ids and user
// names are replaced, scripts and styles go. Review the diff before committing.
//   node scripts/refresh-fixtures.ts reddit
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchChrome } from "../browser/src/launch.ts";

const TARGETS: Record<string, { url: string; out: string; keep: string[]; expect: string }> = {
  reddit: {
    url: "https://old.reddit.com/r/selfhosted/",
    out: "adapters/reddit/fixtures/old-reddit-listing.html",
    keep: ["class", "id", "data-fullname", "data-type", "rel", "role"],
    expect: "#siteTable .thing[data-fullname]",
  },
};

const which = process.argv[2] ?? "reddit";
const target = TARGETS[which];
if (!target) throw new Error(`unknown fixture ${which}; known: ${Object.keys(TARGETS).join(", ")}`);

// Headful by default: sites block headless browsers, and a person may need to clear a check.
const b = await launchChrome({ headless: process.env.HEADLESS === "1" });
try {
  const { targetId } = await b.cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await b.cdp.send("Page.enable", undefined, sessionId);
  const loaded = new Promise<void>((r) => b.cdp.on("Page.loadEventFired", (_p, s) => s === sessionId && r()));
  await b.cdp.send("Page.navigate", { url: target.url }, sessionId);
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 20000))]);
  // Runs in an isolated world: the page can't see or tamper with it.
  const { executionContextId } = await b.cdp.send("Page.createIsolatedWorld", { frameId: targetId, worldName: "fixtures" }, sessionId);
  const anonymise = `(${(keep: string[]) => {
    const words = ["lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do"];
    let ids = 0;
    const idMap = new Map<string, string>();
    const anonId = (v: string) => {
      if (!idMap.has(v)) idMap.set(v, `t3_fx${(++ids).toString(36).padStart(4, "0")}`);
      return idMap.get(v)!;
    };
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    root.querySelectorAll("script, style, link, iframe, noscript, img, svg, video, source").forEach((n) => n.remove());
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    let w = 0;
    while ((n = walker.nextNode())) {
      const t = n.textContent ?? "";
      if (!t.trim()) continue;
      n.textContent = t.replace(/\S+/g, (m) => {
        const word = words[w++ % words.length]!;
        return (word.repeat(Math.ceil(m.length / word.length))).slice(0, Math.max(1, Math.min(m.length, 12)));
      });
    }
    root.querySelectorAll("*").forEach((el) => {
      for (const a of [...el.attributes]) {
        if (a.name === "href") {
          // Keep the path shape, drop identifying segments.
          el.setAttribute("href", a.value.replace(/\/(comments|user|u)\/[^/?#]+/g, "/$1/x").replace(/[?#].*$/, ""));
        } else if (a.name === "data-fullname") el.setAttribute(a.name, anonId(a.value));
        else if (!keep.includes(a.name)) el.removeAttribute(a.name);
      }
    });
    return `<!doctype html>\n<!-- Refreshed by scripts/refresh-fixtures.ts on ${new Date().toISOString().slice(0, 10)}: structure kept, content anonymised. -->\n${root.outerHTML}`;
  }})(${JSON.stringify(target.keep)})`;
  const r = await b.cdp.send("Runtime.evaluate", { expression: anonymise, contextId: executionContextId, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  const html = String(r.result.value);
  const count = await b.cdp.send("Runtime.evaluate", { expression: `document.querySelectorAll(${JSON.stringify(target.expect)}).length`, contextId: executionContextId, returnByValue: true }, sessionId);
  if (!count.result.value) {
    throw new Error(`The page has no ${target.expect}: probably a block or login page. Run headful, clear it by hand, and try again. Nothing written.`);
  }
  const out = resolve(import.meta.dirname, "..", target.out.replace(/\.html$/, ".live.html"));
  writeFileSync(out, html);
  console.log(`wrote ${out} (${html.length} bytes). Compare with ${target.out}, check the adapter tests, then replace it if the structure changed.`);
} finally {
  await b.close();
}
