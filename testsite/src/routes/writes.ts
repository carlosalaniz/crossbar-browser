// SPDX-License-Identifier: AGPL-3.0-only
// Writes and the network gate: comments, GraphQL, a state-changing GET, always-ask actions,
// background requests, and approval checks (overlay, late swap).
import { formCaptchaOk, runGate, widgetFor, type Router } from "../app.ts";
import { hostUrl, json, redirect, send } from "../context.ts";
import { esc, page } from "../html.ts";
import { requireLogin } from "./accounts.ts";

const PAGE_SIZE = 10;

export function registerWrites(r: Router): void {
  // --- Comments: reads never prompt, the POST asks -------------------------------------------
  r.add("site-a.test", "GET", "/comments", (ctx, app) => {
    const g = runGate(ctx, app);
    if (g.handled) return;
    const pageNo = Math.max(1, Number(ctx.url.searchParams.get("page") ?? 1) || 1);
    const expand = Number(ctx.url.searchParams.get("expand") ?? 0);
    const items = app.comments.slice(0, pageNo * PAGE_SIZE);
    const list = items
      .map((c) => {
        const long = c.text.length > 80 && c.id !== expand;
        return `<li class="comment" data-key="c${c.id}" id="c${c.id}"><strong>${esc(c.author)}</strong>: ${esc(long ? c.text.slice(0, 80) + "…" : c.text)}
${long ? ` <a href="/comments?page=${pageNo}&amp;expand=${c.id}#c${c.id}">expand</a>` : ""}
${c.replies.length && c.id === expand ? `<ul>${c.replies.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : c.replies.length ? ` <a href="/comments?page=${pageNo}&amp;expand=${c.id}#c${c.id}">${c.replies.length} replies</a>` : ""}</li>`;
      })
      .join("");
    const more = items.length < app.comments.length ? `<a id="load-more" href="/comments?page=${pageNo + 1}">Load more</a>` : `<p class="note">End of comments.</p>`;
    send(ctx, 200, page("Comments", `
<form method="GET" action="/comments/search"><label>Search <input name="q" type="search"></label><button>Search</button></form>
<ol>${list}</ol>${more}
<form method="POST" action="/comments" data-captcha class="card"><label>Add a comment <textarea name="text" rows="3"></textarea></label>
${g.widget ? widgetFor(ctx, app, g.widget) : ""}<button>Post comment</button></form>`, { host: ctx.host }));
  });
  r.add("site-a.test", "GET", "/comments/search", (ctx, app) => {
    const q = (ctx.url.searchParams.get("q") ?? "").toLowerCase();
    const hits = app.comments.filter((c) => c.text.toLowerCase().includes(q) || c.author.includes(q));
    send(ctx, 200, page("Search results", `<p>${hits.length} results for “${esc(q)}”.</p><ol>${hits.map((c) => `<li>${esc(c.author)}: ${esc(c.text.slice(0, 80))}</li>`).join("")}</ol>`, { host: ctx.host }));
  });
  r.add("site-a.test", "POST", "/comments", async (ctx, app) => {
    if (!(await formCaptchaOk(ctx, app, "/comments"))) return send(ctx, 403, page("Comments", "<p class=warn>Captcha missing or invalid.</p>", { host: ctx.host }));
    const text = (ctx.body.text ?? "").slice(0, 2000);
    if (text) app.comments.push({ id: app.comments.length + 1, author: ctx.session.user ?? "anonymous", text, replies: [] });
    redirect(ctx, `/comments?page=${Math.ceil(app.comments.length / PAGE_SIZE)}`, 303);
  });

  // --- Reddit-like GraphQL: read and write operationNames on one endpoint ---------------------
  const READ_OPS = new Set(["GetFeed", "GetPost", "SearchPosts"]);
  const WRITE_OPS = new Set(["CreatePost", "Vote", "DeletePost"]);
  r.add("site-a.test", "POST", "/graphql", (ctx, app) => {
    const op = ctx.body.operationName ?? "";
    let vars: Record<string, unknown> = {};
    try {
      vars = JSON.parse(ctx.body.variables ?? "{}") as Record<string, unknown>;
    } catch {
      /* keep empty */
    }
    const posts = app.graphqlStore.posts;
    if (!READ_OPS.has(op) && !WRITE_OPS.has(op)) return json(ctx, 400, { errors: [{ message: `unknown operation ${op}` }] });
    switch (op) {
      case "GetFeed":
        return json(ctx, 200, { data: { feed: posts } });
      case "GetPost":
        return json(ctx, 200, { data: { post: posts.find((p) => p.id === Number(vars.id)) ?? null } });
      case "SearchPosts":
        return json(ctx, 200, { data: { search: posts.filter((p) => p.title.toLowerCase().includes(String(vars.q ?? "").toLowerCase())) } });
      case "CreatePost": {
        const p = { id: posts.length + 1, title: String(vars.title ?? "untitled").slice(0, 200), votes: 0 };
        posts.push(p);
        return json(ctx, 200, { data: { createPost: p } });
      }
      case "Vote": {
        const p = posts.find((x) => x.id === Number(vars.id));
        if (p) p.votes += Number(vars.dir) === -1 ? -1 : 1;
        return json(ctx, 200, { data: { vote: p ?? null } });
      }
      case "DeletePost": {
        app.graphqlStore.posts = posts.filter((x) => x.id !== Number(vars.id));
        return json(ctx, 200, { data: { deletePost: true } });
      }
    }
  });
  r.add("site-a.test", "GET", "/graphql-demo", (ctx) => {
    const btn = (op: string, vars: string, label: string) => `<button data-op="${op}" data-vars='${esc(vars)}'>${esc(label)}</button>`;
    send(ctx, 200, page("GraphQL feed", `<p>One endpoint, <code>POST /graphql</code>. Reads: GetFeed, GetPost, SearchPosts. Writes: CreatePost, Vote, DeletePost.</p>
<p>${btn("GetFeed", "{}", "Refresh feed")} ${btn("GetPost", '{"id":1}', "Open post 1")} ${btn("SearchPosts", '{"q":"fixture"}', "Search")}</p>
<p>${btn("CreatePost", '{"title":"Hello"}', "Create post")} ${btn("Vote", '{"id":1,"dir":1}', "Upvote post 1")} ${btn("DeletePost", '{"id":1}', "Delete post 1")}</p>
<pre id="out"></pre>
<script>
document.querySelectorAll("button[data-op]").forEach((b) => b.addEventListener("click", async () => {
  const r = await fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationName: b.dataset.op, query: "query " + b.dataset.op + " { ... }", variables: b.dataset.vars }) });
  document.getElementById("out").textContent = r.status + " " + await r.text();
}));
fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationName: "GetFeed", query: "query GetFeed { feed { id title votes } }", variables: "{}" }) })
  .then((r) => r.text()).then((t) => { document.getElementById("out").textContent = "initial GetFeed: " + t; });
</script>`, { host: ctx.host }));
  });

  // --- State-changing GET: the Access Model's documented residual risk ------------------------
  const votes = new Map<number, number>();
  r.add("site-a.test", "GET", "/posts", (ctx) => {
    send(ctx, 200, page("Posts", [1, 2, 3].map((id) => `<p>Post ${id}: ${votes.get(id) ?? 0} votes. <a href="/vote?id=${id}">upvote</a></p>`).join(""), { host: ctx.host }));
  });
  r.add("site-a.test", "GET", "/vote", (ctx) => {
    const id = Number(ctx.url.searchParams.get("id"));
    votes.set(id, (votes.get(id) ?? 0) + 1);
    redirect(ctx, "/posts");
  });

  // --- Always-ask actions ---------------------------------------------------------------------
  r.add("site-a.test", "GET", "/checkout", (ctx) => {
    send(ctx, 200, page("Checkout", `<p>Order: 1 × fixture widget, $12.00</p>
<form method="POST" action="/checkout/pay">
<label>Name on card <input name="cc-name" autocomplete="cc-name"></label>
<label>Card number <input name="cc-number" autocomplete="cc-number" inputmode="numeric" placeholder="4242 4242 4242 4242"></label>
<label>Expiry <input name="cc-exp" autocomplete="cc-exp" placeholder="12/34"></label>
<label>CVC <input name="cc-csc" autocomplete="cc-csc" inputmode="numeric"></label>
<button>Pay $12.00</button></form><p class="note">Fake processor; use 4242 4242 4242 4242. Nothing is charged.</p>`, { host: ctx.host }));
  });
  r.add("site-a.test", "POST", "/checkout/pay", (ctx) => send(ctx, 200, page("Paid", `<p>Fixture order paid (card ending ${esc((ctx.body["cc-number"] ?? "").replace(/\s/g, "").slice(-4))}).</p>`, { host: ctx.host })));

  r.add("site-a.test", "GET", "/account/delete", (ctx) => {
    if (!requireLogin(ctx)) return;
    send(ctx, 200, page("Delete account", `<form method="POST" action="/account/delete"><p>This permanently deletes <strong>${esc(ctx.session.user)}</strong>.</p><button>Delete my account</button></form>`, { host: ctx.host }));
  });
  r.add("site-a.test", "POST", "/account/delete", (ctx, app) => {
    if (!requireLogin(ctx)) return;
    app.accounts.delete(ctx.session.user!);
    delete ctx.session.user;
    send(ctx, 200, page("Deleted", "<p>Account deleted (fixture).</p>", { host: ctx.host }));
  });
  r.add("site-a.test", "GET", "/account/email", (ctx) => {
    if (!requireLogin(ctx)) return;
    send(ctx, 200, page("Change email", `<form method="POST" action="/account/email"><label>New email <input type="email" name="email" autocomplete="email"></label><button>Change email</button></form>`, { host: ctx.host }));
  });
  r.add("site-a.test", "POST", "/account/email", (ctx, app) => {
    if (!requireLogin(ctx)) return;
    const a = app.accounts.get(ctx.session.user!);
    if (a && ctx.body.email) a.email = ctx.body.email;
    send(ctx, 200, page("Email changed", "<p>Email updated (fixture).</p>", { host: ctx.host }));
  });
  r.add("site-a.test", "GET", "/account/password", (ctx) => {
    if (!requireLogin(ctx)) return;
    send(ctx, 200, page("Change password", `<form method="POST" action="/account/password">
<label>Current password <input type="password" name="current" autocomplete="current-password"></label>
<label>New password <input type="password" name="new" autocomplete="new-password"></label><button>Change password</button></form>`, { host: ctx.host }));
  });
  r.add("site-a.test", "POST", "/account/password", (ctx, app) => {
    if (!requireLogin(ctx)) return;
    const a = app.accounts.get(ctx.session.user!);
    if (!a || a.password !== ctx.body.current) return send(ctx, 401, page("Change password", "<p class=warn>Current password is wrong.</p>", { host: ctx.host }));
    a.password = ctx.body.new ?? a.password;
    send(ctx, 200, page("Password changed", "<p>Password updated (fixture).</p>", { host: ctx.host }));
  });

  // --- Background requests: each must go through the gate or be denied -----------------------
  r.add("site-a.test", "GET", "/background", (ctx) => {
    const auto = ctx.url.searchParams.get("auto") === "1";
    send(ctx, 200, page("Background requests", `
<p>Each button fires a request the user never sees. With <code>?auto=1</code> they all fire on load.</p>
<p><button id="beacon">sendBeacon POST</button> <button id="keepalive">fetch keepalive POST</button> <button id="sw">Register service worker</button> <button id="ws">Open WebSocket</button>
<a id="ping" href="/posts" ping="/ping-target">link with ping</a></p>
<iframe id="xframe" src="${esc(hostUrl(ctx, "site-b.test", "/frame-poster" + (auto ? "?auto=1" : "")))}" title="cross-origin frame" width="420" height="90"></iframe>
<pre id="out"></pre>
<script>
const out = (m) => { document.getElementById("out").textContent += m + "\\n"; };
const run = {
  beacon: () => out("beacon queued: " + navigator.sendBeacon("/beacon", new Blob([JSON.stringify({ event: "view", t: Date.now() })], { type: "application/json" }))),
  keepalive: () => fetch("/beacon?via=keepalive", { method: "POST", keepalive: true, body: "k=1" }).then((r) => out("keepalive " + r.status), (e) => out("keepalive failed " + e)),
  sw: () => ("serviceWorker" in navigator ? navigator.serviceWorker.register("/sw.js").then(() => out("service worker registered"), (e) => out("service worker refused: " + e)) : out("no serviceWorker API")),
  ws: () => { try { const w = new WebSocket("ws://" + location.host + "/ws"); w.onmessage = (e) => out("ws message: " + e.data); w.onerror = () => out("ws error (blocked?)"); w.onclose = (e) => out("ws closed " + e.code); } catch (e) { out("ws threw " + e); } },
};
for (const k of Object.keys(run)) document.getElementById(k).addEventListener("click", run[k]);
${auto ? "for (const k of Object.keys(run)) run[k]();" : ""}
</script>`, { host: ctx.host }));
  });
  r.add("site-a.test", "POST", "/beacon", (ctx) => send(ctx, 204, ""));
  r.add("site-a.test", "POST", "/ping-target", (ctx) => send(ctx, 204, ""));
  r.add("site-a.test", "POST", "/sw-beacon", (ctx) => send(ctx, 204, ""));
  r.add("site-a.test", "GET", "/sw.js", (ctx) =>
    send(ctx, 200, `// test-site service worker: posts on install and on every fetch it sees.
self.addEventListener("install", () => { fetch("/sw-beacon?on=install", { method: "POST", body: "sw=1" }); self.skipWaiting(); });
self.addEventListener("fetch", (e) => { if (!e.request.url.includes("/sw-beacon")) fetch("/sw-beacon?on=fetch", { method: "POST", body: "u=" + encodeURIComponent(e.request.url) }); });
`, { "content-type": "text/javascript" }),
  );
  r.add("site-b.test", "GET", "/frame-poster", (ctx) => {
    const auto = ctx.url.searchParams.get("auto") === "1";
    send(ctx, 200, `<!doctype html><meta charset="utf-8"><body style="font:13px system-ui">site-b.test frame <button id="go">POST from this frame</button> <span id="s"></span>
<script>
const go = () => fetch("/api/track", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "frame", t: Date.now() }) }).then((r) => (document.getElementById("s").textContent = "status " + r.status), (e) => (document.getElementById("s").textContent = "failed " + e));
document.getElementById("go").addEventListener("click", go);
${auto ? "go();" : ""}
</script>`);
  });
  r.add("site-b.test", "POST", "/api/track", (ctx) => json(ctx, 200, { ok: true }));

  // --- Approval checks --------------------------------------------------------------------------
  r.add("site-a.test", "GET", "/approval/overlay", (ctx) => {
    send(ctx, 200, page("Overlay", `<p>The visible button says “Post”. A transparent element sits on top and catches the click.</p>
<div style="position:relative;display:inline-block">
  <form method="POST" action="/approval/overlay/post"><button id="post" style="font-size:20px;padding:8px 24px">Post</button></form>
  <form method="POST" action="/account/delete" id="trap" style="position:absolute;inset:0;margin:0"><button aria-label="Post" style="opacity:0;width:100%;height:100%;cursor:pointer">x</button></form>
</div>`, { host: ctx.host }));
  });
  r.add("site-a.test", "POST", "/approval/overlay/post", (ctx) => send(ctx, 200, page("Posted", "<p>Posted (the real button).</p>", { host: ctx.host })));
  r.add("site-a.test", "GET", "/approval/swap", (ctx) => {
    send(ctx, 200, page("Late swap", `<p>The button below changes its label and target two seconds after it renders.</p>
<form id="f" method="POST" action="/approval/swap/save"><button id="btn">Save draft</button></form>
<script>setTimeout(() => { const f = document.getElementById("f"); f.action = "/account/delete"; document.getElementById("btn").textContent = "Delete account"; }, 2000);</script>`, { host: ctx.host }));
  });
  r.add("site-a.test", "POST", "/approval/swap/save", (ctx) => send(ctx, 200, page("Saved", "<p>Draft saved.</p>", { host: ctx.host })));

}
