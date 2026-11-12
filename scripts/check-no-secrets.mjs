// SPDX-License-Identifier: AGPL-3.0-only
// Fails if runtime data or secrets are tracked: databases, master keys, .env files, browser profiles.
import { execFileSync } from "node:child_process";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const bad = tracked.filter((f) => /(^|\/)(data|profiles)\/|\.db(-wal|-shm)?$|(^|\/)master\.key$|(^|\/)\.env$|\.pem$/.test(f) && !/\.env\.example$/.test(f));
if (bad.length) {
  console.error("Runtime data or secrets are tracked by git:\n  " + bad.join("\n  ") + "\nRemove them with git rm --cached and keep them in .gitignore.");
  process.exit(1);
}
