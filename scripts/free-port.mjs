// SPDX-License-Identifier: AGPL-3.0-only
// Finds a port that is free on both 127.0.0.1 and ::1, starting from `preferred`.
// (A port taken on ::1 only still breaks http://localhost, which tries IPv6 first.)
import net from "node:net";

function freeOn(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (e) => resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT"));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

export async function freePort(preferred, tries = 50) {
  for (let p = preferred; p < preferred + tries; p++) {
    if ((await freeOn(p, "127.0.0.1")) && (await freeOn(p, "::1"))) return p;
  }
  throw new Error(`no free port in ${preferred}..${preferred + tries - 1}`);
}
