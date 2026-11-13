// SPDX-License-Identifier: AGPL-3.0-only
// Builds web/ into web/dist: one JS bundle, CSS and the shell.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "web");
const out = resolve(root, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, "assets"), { recursive: true });
await build({
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  format: "esm",
  target: ["safari16", "chrome120", "firefox120"],
  minify: true,
  sourcemap: true,
  charset: "utf8",
  outfile: resolve(out, "assets/app.js"),
  logLevel: "warning",
});
cpSync(resolve(root, "public"), resolve(out, "assets"), { recursive: true });
// Each asset link carries a hash of its content, so a new build is fetched at once even where the old file
// is cached (assets are cached for an hour; index.html isn't cached).
const html = readFileSync(resolve(root, "index.html"), "utf8").replace(/"\/assets\/([\w.-]+)"/g, (m, name) => {
  const hash = createHash("sha256").update(readFileSync(resolve(out, "assets", name))).digest("hex").slice(0, 10);
  return `"/assets/${name}?v=${hash}"`;
});
writeFileSync(resolve(out, "index.html"), html);
console.log("web built into web/dist");
