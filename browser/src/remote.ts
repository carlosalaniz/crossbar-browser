// SPDX-License-Identifier: AGPL-3.0-only
// Launcher for the three-container deployment: the browser container runs host.ts; the app asks it
// to start a Chromium per (user, profile) and talks CDP through its relay. Same pool code either way.
import { CdpConnection } from "./cdp.ts";
import type { Launcher } from "./pool.ts";

export function remoteLauncher(baseUrl: string, secret: string): Launcher {
  const base = baseUrl.replace(/\/$/, "");
  const launch: Launcher = async (userId, profile) => {
    const r = await fetch(`${base}/launch`, { method: "POST", headers: { "content-type": "application/json", "x-crossbar-secret": secret }, body: JSON.stringify({ userId, profile }) });
    if (!r.ok) throw new Error(`browser host refused launch: ${r.status} ${await r.text()}`);
    const { id } = (await r.json()) as { id: string };
    const ws = `${base.replace(/^http/, "ws")}/cdp/${encodeURIComponent(id)}?secret=${encodeURIComponent(secret)}`;
    const cdp = await CdpConnection.connect(ws);
    return {
      cdp,
      async close() {
        cdp.close();
        await fetch(`${base}/close`, { method: "POST", headers: { "content-type": "application/json", "x-crossbar-secret": secret }, body: JSON.stringify({ id }) }).catch(() => {});
      },
    };
  };
  launch.wipe = async (userId, profile) => {
    const r = await fetch(`${base}/wipe`, { method: "POST", headers: { "content-type": "application/json", "x-crossbar-secret": secret }, body: JSON.stringify({ userId, profile }) });
    if (!r.ok) throw new Error(`browser host couldn't clear ${profile}: ${r.status} ${await r.text()}`);
  };
  return launch;
}
