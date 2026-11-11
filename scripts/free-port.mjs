// SPDX-License-Identifier: AGPL-3.0-only
// Finds a port that is free on loopback and wildcard addresses, IPv4 and IPv6, starting from `preferred`.
// (A port taken on ::1 only still breaks http://localhost; Docker publishes on 0.0.0.0 and ::.)
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
    let free = true;
    for (const host of ["127.0.0.1", "::1", "0.0.0.0", "::"]) if (!(await freeOn(p, host))) free = false;
    if (free) return p;
  }
  throw new Error(`no free port in ${preferred}..${preferred + tries - 1}`);
}
