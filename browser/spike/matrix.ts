// SPDX-License-Identifier: AGPL-3.0-only
// Step 1 spike: prints what CDP Fetch did and didn't catch. Run: node browser/spike/matrix.ts
import { setup, runCase, collect, openPage, evaluate, sleep, WRITE_CASES, type Env } from "../test/harness.ts";

function row(name: string, paused: number, reached: number, note = "") {
  const verdict = paused > 0 && reached === 0 ? "CAUGHT" : paused > 0 ? "PAUSED-BUT-LEAKED" : reached > 0 ? "MISSED" : "NOT-SENT";
  console.log(`${name.padEnd(22)} ${verdict.padEnd(18)} paused=${paused} reached=${reached} ${note}`);
}

const env: Env = await setup({
  onHeld: (h) => {
    // Release the first hop of the redirect case so we can see whether hop 2 is paused too.
    if (h.request.url.includes("/r307")) void h.release();
    else if (h.request.method === "OPTIONS" && h.request.url.includes("cors-put-released")) void h.release();
    else void h.fail();
  },
});
try {
  for (const c of WRITE_CASES) {
    const r = await runCase(env, c);
    row(c.name, r.paused.length, r.reached.length, r.paused.map((p) => `${p.targetType}:${p.method}`).join(","));
  }

  // Redirect: POST /r307 (released) -> 307 -> POST /sink?case=redirect-307-hop2 (should pause again).
  const s = await openPage(env, env.site.url("a.test", "/blank"));
  await evaluate(env, s, `fetch('/r307?case=redirect-307',{method:'POST',body:'x'}).catch(()=>{})`);
  await sleep(1000);
  const red = collect(env, "redirect-307");
  const hop2 = red.paused.find((p) => p.url.includes("hop2"));
  row("redirect-307 hop2", hop2 ? 1 : 0, red.reached.filter((h) => h.case?.endsWith("hop2")).length, hop2 ? `redirectedRequestId=${hop2.redirectedRequestId ?? "none"}` : "");

  // GET redirect across sites: every hop must be visible to the gate for re-checking.
  const s2 = await openPage(env, env.site.url("a.test", "/blank"));
  await evaluate(env, s2, `location.href='/r302-cross'`);
  await sleep(1000);
  const hops = env.gate.seen.filter((x) => x.request.url.includes("r302-cross") || x.request.url.includes("get-redirect-hop2"));
  console.log(`get-redirect hops seen: ${hops.map((h) => `${new URL(h.request.url).host}${new URL(h.request.url).pathname} redirectedFrom=${h.request.redirectedRequestId ?? "-"}`).join(" | ")}`);

  // CORS: release the preflight, then see whether the PUT itself is paused.
  const s4 = await openPage(env, env.site.url("a.test", "/blank"));
  await evaluate(env, s4, `fetch('http://b.test:${env.site.port}/sink?case=cors-put-released',{method:'PUT',headers:{'x-custom':'1'},body:'x'}).catch(()=>{})`);
  await sleep(1000);
  const cors = collect(env, "cors-put-released");
  row("cors-put after OPTIONS", cors.paused.filter((p) => p.method === "PUT").length, cors.reached.filter((h) => h.method === "PUT").length, cors.paused.map((p) => p.method).join(","));

  console.log(`attached target types: ${[...new Set([...env.gate.attached.values()].map((a) => a.type))].join(", ")}`);
  console.log(`attach errors: ${JSON.stringify(env.gate.attachErrors)}`);
} finally {
  await env.close();
}
