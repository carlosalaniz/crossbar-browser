// SPDX-License-Identifier: AGPL-3.0-only
// Google adapter (Gmail first). Only the domain group for now: Google pages load their fonts, images and
// scripts from these hosts, so after a signed-in read they count as the page's own site.
import type { SiteAdapter } from "../src/index.ts";

export const google: SiteAdapter = {
  id: "google",
  // Seen live (Gmail, 12 Nov 2026): fonts and theme images from gstatic.com, avatars from googleusercontent.com.
  domains: ["google.com", "gstatic.com", "googleusercontent.com", "ggpht.com"],
};
