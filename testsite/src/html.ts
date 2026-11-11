// SPDX-License-Identifier: AGPL-3.0-only
// Tiny HTML helpers. Every page on the test site is server-rendered; there is no build step.

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CSS = `
:root{color-scheme:light dark;--fg:#1b1b1f;--bg:#fafafa;--muted:#666;--line:#ddd;--accent:#2457d6;--warn:#b25e00}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8ec;--bg:#151518;--muted:#9a9aa3;--line:#333;--accent:#7aa2ff;--warn:#ffb057}}
body{font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0 auto;max-width:880px;padding:16px}
header{display:flex;gap:12px;align-items:baseline;border-bottom:1px solid var(--line);margin-bottom:16px;padding-bottom:8px}
header .host{color:var(--muted);font-family:ui-monospace,monospace;font-size:13px}
a{color:var(--accent)} code{font-family:ui-monospace,monospace;font-size:13px}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top;font-size:14px}
.outcome{font-family:ui-monospace,monospace;font-size:12px;padding:1px 6px;border-radius:4px;border:1px solid var(--line);white-space:nowrap}
.note{color:var(--muted);font-size:13px} .warn{color:var(--warn)}
form{margin:12px 0} label{display:block;margin:6px 0} input,button,textarea,select{font:inherit}
.card{border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}
.disabled{opacity:.5}
`;

export function page(title: string, body: string, opts: { host?: string; head?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style>${opts.head ?? ""}</head>
<body><header><strong>${esc(title)}</strong>${opts.host ? `<span class="host">${esc(opts.host)}</span>` : ""}<span style="flex:1"></span><a href="/">index</a></header>
${body}</body></html>`;
}

export function outcomeTag(o: string): string {
  return `<span class="outcome" data-expected="${esc(o)}">${esc(o)}</span>`;
}
