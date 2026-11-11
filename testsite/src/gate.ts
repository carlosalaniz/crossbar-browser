// SPDX-License-Identifier: AGPL-3.0-only
// Challenge frequency control. Every protected page goes through one Gate.
// Precedence: query parameter > admin setting (/__testsite/) > environment variable > default.

export const PROVIDERS = ["turnstile", "recaptcha", "hcaptcha", "arkose", "datadome", "perimeterx"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const STYLES = ["widget", "interstitial", "status"] as const;
export type Style = (typeof STYLES)[number];
export const SCOPES = ["session", "ip", "path"] as const;
export type Scope = (typeof SCOPES)[number];

export type Mode =
  | { kind: "always" }
  | { kind: "never" }
  | { kind: "every"; n: number }
  | { kind: "random"; p: number }
  | { kind: "after"; n: number };

export interface GateConfig {
  mode: Mode;
  scope: Scope;
  style: Style;
  provider: Provider;
  clearance: boolean;
  clearanceMinutes: number;
  /** For style=status and the interstitial status. */
  status: 403 | 429 | 503;
}

export type GateOverrides = Partial<Record<"mode" | "scope" | "style" | "provider" | "clearance" | "clearance_minutes" | "status", string>>;

export const DEFAULT_CONFIG: GateConfig = {
  mode: { kind: "never" },
  scope: "session",
  style: "widget",
  provider: "turnstile",
  clearance: true,
  clearanceMinutes: 30,
  status: 403,
};

export function parseMode(s: string): Mode {
  const t = s.trim().toLowerCase();
  if (t === "always") return { kind: "always" };
  if (t === "never") return { kind: "never" };
  const m = /^(every|random|after):([0-9.]+)$/.exec(t);
  if (!m) throw new Error(`bad mode "${s}": use always | never | every:N | random:P | after:N`);
  const v = Number(m[2]);
  if (m[1] === "random") {
    if (!(v >= 0 && v <= 1)) throw new Error(`random:P needs 0 <= P <= 1, got ${m[2]}`);
    return { kind: "random", p: v };
  }
  if (!Number.isInteger(v) || (m[1] === "every" ? v < 1 : v < 0)) throw new Error(`${m[1]}:N needs a whole number${m[1] === "every" ? " >= 1" : " >= 0"}, got ${m[2]}`);
  return { kind: m[1] as "every" | "after", n: v };
}

export function modeString(m: Mode): string {
  switch (m.kind) {
    case "every":
    case "after":
      return `${m.kind}:${m.n}`;
    case "random":
      return `random:${m.p}`;
    default:
      return m.kind;
  }
}

function oneOf<T extends string>(list: readonly T[], v: string, name: string): T {
  if (!(list as readonly string[]).includes(v)) throw new Error(`bad ${name} "${v}": use ${list.join(" | ")}`);
  return v as T;
}

function apply(cfg: GateConfig, o: GateOverrides): GateConfig {
  const out = { ...cfg };
  if (o.mode) out.mode = parseMode(o.mode);
  if (o.scope) out.scope = oneOf(SCOPES, o.scope, "scope");
  if (o.style) out.style = oneOf(STYLES, o.style, "style");
  if (o.provider) out.provider = oneOf(PROVIDERS, o.provider, "provider");
  if (o.clearance) out.clearance = oneOf(["on", "off"] as const, o.clearance, "clearance") === "on";
  if (o.clearance_minutes) {
    const n = Number(o.clearance_minutes);
    if (!(n > 0)) throw new Error(`bad clearance_minutes "${o.clearance_minutes}"`);
    out.clearanceMinutes = n;
  }
  if (o.status) out.status = Number(oneOf(["403", "429", "503"] as const, o.status, "status")) as 403 | 429 | 503;
  return out;
}

export function overridesFromEnv(env: NodeJS.ProcessEnv): GateOverrides {
  const pick = (k: string) => (env[k] ? env[k] : undefined);
  return {
    mode: pick("TESTSITE_GATE_MODE"),
    scope: pick("TESTSITE_GATE_SCOPE"),
    style: pick("TESTSITE_GATE_STYLE"),
    provider: pick("TESTSITE_GATE_PROVIDER"),
    clearance: pick("TESTSITE_GATE_CLEARANCE"),
    clearance_minutes: pick("TESTSITE_GATE_CLEARANCE_MINUTES"),
    status: pick("TESTSITE_GATE_STATUS"),
  };
}

export function overridesFromQuery(q: URLSearchParams): GateOverrides {
  const o: GateOverrides = {};
  for (const k of ["mode", "scope", "style", "provider", "clearance", "clearance_minutes", "status"] as const) {
    const v = q.get(k);
    if (v) o[k] = v;
  }
  return o;
}

/** Env, then admin, then query: later layers win. Throws on a bad value so a typo never silently means "never". */
export function resolveConfig(layers: { env?: GateOverrides; admin?: GateOverrides; query?: GateOverrides }): GateConfig {
  return apply(apply(apply(DEFAULT_CONFIG, layers.env ?? {}), layers.admin ?? {}), layers.query ?? {});
}

export interface GateSubject {
  session: string;
  ip: string;
  path: string;
}

export interface GateDecision {
  challenge: boolean;
  /** The request's number within its scope bucket (1-based), or 0 when clearance skipped counting. */
  count: number;
  reason: "mode" | "clearance";
}

export class Gate {
  private counters = new Map<string, number>();
  private readonly rng: () => number;
  constructor(rng: () => number = Math.random) {
    this.rng = rng;
  }

  static bucket(scope: Scope, s: GateSubject): string {
    return `${scope}:${scope === "session" ? s.session : scope === "ip" ? s.ip : s.path}`;
  }

  /** Counts the request, then decides. A valid clearance cookie skips both. */
  decide(cfg: GateConfig, s: GateSubject, hasClearance = false): GateDecision {
    if (cfg.clearance && hasClearance) return { challenge: false, count: 0, reason: "clearance" };
    const key = Gate.bucket(cfg.scope, s);
    const count = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, count);
    const m = cfg.mode;
    let challenge: boolean;
    switch (m.kind) {
      case "always":
        challenge = true;
        break;
      case "never":
        challenge = false;
        break;
      case "every":
        challenge = count % m.n === 0;
        break;
      case "after":
        challenge = count > m.n;
        break;
      case "random":
        challenge = this.rng() < m.p;
        break;
    }
    return { challenge, count, reason: "mode" };
  }

  count(scope: Scope, s: GateSubject): number {
    return this.counters.get(Gate.bucket(scope, s)) ?? 0;
  }

  reset(): void {
    this.counters.clear();
  }
}
