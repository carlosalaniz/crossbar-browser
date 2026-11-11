// SPDX-License-Identifier: AGPL-3.0-only
// Drives a running dev stack (npm run dev) through MCP and compares what Crossbar does on opening each
// test-site scenario with scenarios.json. Only scenarios whose headline outcome shows on open
// (read, blocked, blocked:<kind>) are checked; the rest need an action (typing, posting) to observe.
// Usage: node scripts/testsite-smoke.ts <setup-code-or-password> [origin]
import { SCENARIOS, type Outcome } from "../testsite/src/scenarios.ts";

const secret = process.argv[2];
const ORIGIN = process.argv[3] ?? "http://localhost:8080";
if (!secret) {
  console.error("usage: node scripts/testsite-smoke.ts <setup-code> [origin]");
  process.exit(2);
}
let cookie = "";
async function human(method: string, path: string, body?: unknown) {
  const r = await fetch(ORIGIN + path, { method, headers: { "content-type": "application/json", "x-crossbar": "1", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0]!;
  return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> };
}
// Same account as scripts/stack-smoke.ts, so either script can run first on a fresh stack.
const user = { username: process.env.SMOKE_USER ?? "smoke", password: process.env.SMOKE_PASSWORD ?? "a long password here" };
const setup = await human("POST", "/api/setup", { code: secret, ...user });
if (setup.status !== 200) await human("POST", "/api/login", user);
const tok = (await human("POST", "/api/tokens", { agentName: "testsite-smoke", kind: "read" })).json.secret as string;

let sid = "";
async function call(name: string, args: unknown = {}): Promise<Record<string, unknown>> {
  const rpc = async (method: string, params: unknown) => {
    const r = await fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    sid ||= r.headers.get("mcp-session-id") ?? "";
    return (await r.json()) as { result?: { structuredContent: Record<string, unknown> }; error?: unknown };
  };
  if (!sid) await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "testsite-smoke", version: "0" } });
  const res = await rpc("tools/call", { name, arguments: args });
  return res.result?.structuredContent ?? { state: "rpc-error", error: res.error };
}

/** Maps Crossbar's answer to the scenario vocabulary. The BlockState kind lives in the ticket's facts. */
async function observed(r: Record<string, unknown>): Promise<string> {
  if (r.state === "ok") return "read";
  if (r.state === "denied") return "blocked";
  if (r.state === "error" && /ERR_BLOCKED_BY_CLIENT/.test(String(r.message))) return "blocked"; // a hop refused by the gate
  if (r.state === "blocked") {
    const id = (r.ticket as { id?: string } | undefined)?.id;
    const tickets = (await human("GET", "/api/tickets")).json as unknown as Array<{ id: string; facts?: { kind?: string } }>;
    return `blocked:${tickets.find((t) => t.id === id)?.facts?.kind ?? "?"}`;
  }
  return String(r.state);
}

const port = process.env.TESTSITE_PORT ?? "8090";
const onOpen: Outcome[] = ["read", "blocked", "blocked:captcha", "blocked:login", "blocked:consent", "blocked:soft_block"];
// Scenarios whose headline needs several requests (counters) aren't decided by one open.
const single = (s: (typeof SCENARIOS)[number]) => !(s.checks ?? []).some((c) => /request/.test(c.on));
let diffs = 0;
for (const s of SCENARIOS.filter((x) => x.mode === "offline" && onOpen.includes(x.outcome) && single(x))) {
  sid = ""; // a fresh MCP session per scenario: Crossbar keeps one open challenge ticket per session
  const r = await call("open", { url: `http://${s.host}:${port}${s.path}` });
  const got = await observed(r);
  const gap = /GAP/.test(s.notes ?? "");
  const tag = got === s.outcome ? "ok  " : gap ? "GAP " : "DIFF";
  if (tag === "DIFF") diffs++;
  console.log(`${tag} ${s.id.padEnd(26)} expected ${s.outcome.padEnd(18)} got ${got}`);
}
console.log(`\n${diffs} unexpected difference(s) (GAP rows are documented gaps)`);
process.exitCode = diffs ? 1 : 0;
