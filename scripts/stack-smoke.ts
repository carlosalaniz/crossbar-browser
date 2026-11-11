// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test against a running stack (npm run dev). Usage: node scripts/stack-smoke.ts <setup-code> [origin]
const code = process.argv[2];
const ORIGIN = process.argv[3] ?? "http://localhost:8080";
const T = "http://testsite.test:8090";
let cookie = "";
async function human(method: string, path: string, body?: unknown) {
  const r = await fetch(ORIGIN + path, { method, headers: { "content-type": "application/json", "x-crossbar": "1", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0]!;
  return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> };
}
const setup = await human("POST", "/api/setup", { code, username: "smoke", password: "a long password here" });
if (setup.status !== 200) await human("POST", "/api/login", { username: "smoke", password: "a long password here" });
const tok = (await human("POST", "/api/tokens", { agentName: "stack-smoke", kind: "act" })).json.secret as string;
let sid = "";
async function call(name: string, args: unknown = {}) {
  const rpc = async (method: string, params: unknown) => {
    const r = await fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    sid ||= r.headers.get("mcp-session-id") ?? "";
    return (await r.json()) as { result: { structuredContent: Record<string, unknown> } };
  };
  if (!sid) await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s", version: "0" } });
  return (await rpc("tools/call", { name, arguments: args })).result.structuredContent;
}
const show = (label: string, r: Record<string, unknown>) => console.log(`${label}: ${JSON.stringify(r).slice(0, 220)}`);
show("open article", await call("open", { url: `${T}/pages/article` }));
const read = (await call("read", { mode: "content+links" })) as { data: { content: string; links: Array<{ ref: string; kind: string; text: string }> } };
console.log(`read: ${read.data.content.slice(0, 80).replace(/\n/g, " ")}… (${read.data.links.length} links)`);
await call("type", { ref: read.data.links.find((l) => l.kind === "input")!.ref, text: "hello from docker" });
show("click Post", await call("click", { ref: read.data.links.find((l) => l.text === "Post")!.ref }));
show("open ws probe", await call("open", { url: `${T}/pages/ws` }));
show("open lan probe", await call("open", { url: `${T}/pages/lan` }));
show("open 192.168.1.1", await call("open", { url: "http://192.168.1.1/" }));
show("open app itself", await call("open", { url: "http://app:8080/" }));
show("open public site", await call("open", { url: "https://example.com/" }));
const ex = (await call("read")) as { data?: { content?: string } };
console.log(`example.com content: ${ex.data?.content?.slice(0, 60)}`);
await new Promise((r) => setTimeout(r, 1500));
const acts = (await human("GET", "/api/activity?limit=100")).json as unknown as Array<{ method: string; host: string; path: string; outcome: string; rule: string }>;
for (const a of acts.reverse()) console.log(`  ${a.outcome.padEnd(9)} ${a.method} ${a.host}${a.path} [${a.rule}]`);
