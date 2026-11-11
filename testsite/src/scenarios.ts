// SPDX-License-Identifier: AGPL-3.0-only
// scenarios.json is the single source of expected Crossbar outcomes for integration tests.
import { readFileSync } from "node:fs";

/**
 * Outcome vocabulary, in the Access Model's terms (docs/threat-model.md "What asks", ADR 0001):
 * - read             Reading: never asks
 * - opens_anonymous  Taint: a plain GET to a new domain opens in the anonymous profile, no prompt
 * - asks             Consequential: asks unless granted
 * - always_asks      Irreversible or private: always asks
 * - never            Not possible: the tool refuses (credential fields, sign-in providers, downloads)
 * - blocked          The site ladder or the proxy refuses it; no ticket (LAN, private ranges)
 * - blocked:<kind>   The agent gets {state:"blocked", reason, ticket}; kind is BlockState.kind.
 *                    ADR 0001 renamed `needs_human` to `blocked`; kinds are captcha | verification | login | consent |
 *                    soft_block (verification: ADR 0011).
 */
export const OUTCOMES = [
  "read",
  "opens_anonymous",
  "asks",
  "always_asks",
  "never",
  "blocked",
  "blocked:captcha",
  "blocked:verification",
  "blocked:login",
  "blocked:consent",
  "blocked:soft_block",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface Check {
  /** What the agent does on the page. */
  on: string;
  outcome: Outcome;
}

export interface Scenario {
  id: string;
  area: string;
  title: string;
  host: string;
  path: string;
  /** The headline outcome, shown on `/`. */
  outcome: Outcome;
  /** Step-by-step expectations when a page has more than one. */
  checks?: Check[];
  /** offline scenarios run in CI; live ones need internet and are manual only. */
  mode: "offline" | "live";
  /** Optional feature this scenario needs (e.g. "stripe"); shown disabled on `/` when it's off. */
  requires?: string;
  /** What the scenario documents, including known gaps in Crossbar today. */
  notes?: string;
}

export function loadScenarios(path = new URL("../scenarios.json", import.meta.url)): Scenario[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { scenarios: Scenario[] };
  const ids = new Set<string>();
  for (const s of raw.scenarios) {
    if (ids.has(s.id)) throw new Error(`duplicate scenario id ${s.id}`);
    ids.add(s.id);
    for (const o of [s.outcome, ...(s.checks ?? []).map((c) => c.outcome)]) {
      if (!(OUTCOMES as readonly string[]).includes(o)) throw new Error(`scenario ${s.id}: unknown outcome "${o}"`);
    }
    if (s.mode !== "offline" && s.mode !== "live") throw new Error(`scenario ${s.id}: mode must be offline or live`);
  }
  return raw.scenarios;
}

export const SCENARIOS = loadScenarios();
