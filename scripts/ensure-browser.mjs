// SPDX-License-Identifier: AGPL-3.0-only
// Installs the pinned Chrome for Testing into .cache/browsers if it isn't there.
// Branded Google Chrome ignores --load-extension, which the WebSocket block needs (ADR 0010).
import { install, computeExecutablePath, detectBrowserPlatform, Browser } from "@puppeteer/browsers";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const CHROME_BUILD = "157.0.8103.50";
const cacheDir = resolve(import.meta.dirname, "..", ".cache", "browsers");
const platform = detectBrowserPlatform();
const exe = computeExecutablePath({ browser: Browser.CHROME, buildId: CHROME_BUILD, cacheDir, platform });
if (!existsSync(exe)) {
  console.error(`Installing Chrome for Testing ${CHROME_BUILD} into .cache/browsers ...`);
  await install({ browser: Browser.CHROME, buildId: CHROME_BUILD, cacheDir, platform });
}
console.log(exe);
