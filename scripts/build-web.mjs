// SPDX-License-Identifier: AGPL-3.0-only
// Builds web/ into web/dist: one JS bundle, CSS and the shell.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
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
cpSync(resolve(root, "index.html"), resolve(out, "index.html"));
cpSync(resolve(root, "public"), resolve(out, "assets"), { recursive: true });
console.log("web built into web/dist");
