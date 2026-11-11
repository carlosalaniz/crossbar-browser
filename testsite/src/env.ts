// SPDX-License-Identifier: AGPL-3.0-only
// Reads testsite/.env (gitignored) without a dependency. Real environment variables win over the file.
import { existsSync, readFileSync } from "node:fs";

export const ENV_PATH = new URL("../.env", import.meta.url);

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function loadEnv(base: NodeJS.ProcessEnv = process.env, path: URL | string = ENV_PATH): NodeJS.ProcessEnv {
  const file = existsSync(path) ? parseDotEnv(readFileSync(path, "utf8")) : {};
  return { ...file, ...Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined && v !== "")) };
}
