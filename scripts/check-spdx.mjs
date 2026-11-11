// SPDX-License-Identifier: AGPL-3.0-only
// Fails if a source file lacks the SPDX line in its first three lines.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["shared", "server", "auth", "browser", "proxy", "detect", "adapters", "web", "scripts"];
const exts = [".ts", ".js", ".mjs"];
const skip = new Set(["node_modules", "pages", "fixtures"]);
const missing = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (exts.some((e) => p.endsWith(e))) {
      const head = readFileSync(p, "utf8").split("\n").slice(0, 3).join("\n");
      if (!head.includes("SPDX-License-Identifier: AGPL-3.0-only")) missing.push(p);
    }
  }
}
for (const r of roots) walk(r);
if (missing.length) {
  console.error("Missing SPDX header:\n  " + missing.join("\n  "));
  process.exit(1);
}
