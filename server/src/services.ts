// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { BrowserPool } from "@crossbar/browser/pool";
import type { AdBlocker } from "@crossbar/browser/adblock";
import { openDb } from "./db.ts";
import { Keys } from "./crypto.ts";
import { Sites } from "./sites.ts";
import { Grants } from "./grants.ts";
import { Tickets } from "./tickets.ts";
import { Activity } from "./activity.ts";
import { NtfyNotifier } from "./notify.ts";
import { Pacer } from "./pace.ts";
import { Tokens } from "./tokens.ts";
import type { Services } from "./agent.ts";

export interface BuildOptions {
  dataDir: string;
  pool: BrowserPool;
  appOrigin: string;
  adblock?: AdBlocker;
  selfHosts?: string[];
  /** Extra sign-in providers: blocked for agents by default, typing refused. Only tightens. */
  signInProviders?: string[];
  pace?: { minIntervalMs?: number; hourlyCap?: number };
  settleMs?: number;
  fetchImpl?: typeof fetch;
}

/** The master key lives in the app's data volume only; the browser container never sees it. */
export function loadMasterKey(dataDir: string): Buffer {
  const p = join(dataDir, "master.key");
  if (!existsSync(p)) writeFileSync(p, randomBytes(32), { mode: 0o600 });
  return readFileSync(p);
}

export function buildServices(o: BuildOptions): Services & { tokens: Tokens } {
  mkdirSync(o.dataDir, { recursive: true });
  const db = openDb(join(o.dataDir, "crossbar.db"));
  const keys = new Keys(loadMasterKey(o.dataDir));
  return {
    db,
    keys,
    sites: new Sites(db, o.selfHosts ?? [new URL(o.appOrigin).hostname], o.signInProviders ?? []),
    grants: new Grants(db),
    tickets: new Tickets(db),
    activity: new Activity(db, keys),
    pool: o.pool,
    notifier: new NtfyNotifier(db, keys, o.appOrigin, o.fetchImpl),
    pacer: new Pacer(o.pace),
    adblock: o.adblock,
    settleMs: o.settleMs ?? 1500,
    appOrigin: o.appOrigin,
    tokens: new Tokens(db),
  };
}
