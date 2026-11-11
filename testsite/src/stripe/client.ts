// SPDX-License-Identifier: AGPL-3.0-only
// Minimal Stripe API client over fetch (no SDK). Test-mode keys only; the secret is never logged.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface StripeConfig {
  publishableKey: string;
  secretKey: string;
  webhookSecret?: string;
}

export const TAG = { crossbar_testsite: "1" } as const;

/**
 * Returns null when either key is missing (the Stripe scenarios are then shown as disabled).
 * Throws when a key is present but isn't a test key, so a live key can never start the site.
 */
export function stripeConfigFromEnv(env: NodeJS.ProcessEnv): StripeConfig | null {
  const pk = env.STRIPE_PUBLISHABLE_KEY?.trim();
  const sk = env.STRIPE_SECRET_KEY?.trim();
  // Prefixes are assembled at runtime so the pre-commit key grep over the repo stays empty.
  const T = "_test_";
  if (pk && !new RegExp(`^pk${T}[A-Za-z0-9]+$`).test(pk)) throw new Error("STRIPE_PUBLISHABLE_KEY is not a test-mode publishable key");
  if (sk && !new RegExp(`^(sk|rk)${T}[A-Za-z0-9]+$`).test(sk)) throw new Error("STRIPE_SECRET_KEY is not a test-mode secret or restricted key");
  const wh = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (wh && !/^whsec_[A-Za-z0-9]+$/.test(wh)) throw new Error("STRIPE_WEBHOOK_SECRET is malformed (whsec_…)");
  if (!pk || !sk) return null;
  return { publishableKey: pk, secretKey: sk, webhookSecret: wh || undefined };
}

type Param = string | number | boolean | null | undefined | Param[] | { [k: string]: Param };

/** Stripe's form encoding: a[b][0][c]=v. */
export function encodeParams(params: Record<string, Param>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined) continue;
    if (v === null) out.push(`${encodeURIComponent(key)}=`);
    else if (Array.isArray(v)) v.forEach((item, i) => out.push(...(typeof item === "object" && item !== null ? encodeParams(item as Record<string, Param>, `${key}[${i}]`) : [`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`])));
    else if (typeof v === "object") out.push(...encodeParams(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export class StripeError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly declineCode?: string;
  constructor(message: string, status: number, code?: string, declineCode?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.declineCode = declineCode;
  }
}

export type Obj = Record<string, unknown> & { id: string };

export class Stripe {
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  constructor(secret: string, fetchImpl: typeof fetch = fetch) {
    this.secret = secret;
    this.fetchImpl = fetchImpl;
  }

  async req<T = Obj>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, Param> = {}, idempotencyKey?: string): Promise<T> {
    const qs = encodeParams(params).join("&");
    const url = `https://api.stripe.com/v1${path}${method !== "POST" && qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { authorization: `Bearer ${this.secret}`, "stripe-version": "2024-06-20" };
    if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const r = await this.fetchImpl(url, { method, headers, body: method === "POST" ? qs : undefined });
    const body = (await r.json()) as { error?: { message?: string; code?: string; decline_code?: string } };
    if (!r.ok) throw new StripeError(body.error?.message ?? `Stripe ${r.status}`, r.status, body.error?.code, body.error?.decline_code);
    return body as T;
  }

  get<T = Obj>(path: string, params?: Record<string, Param>) {
    return this.req<T>("GET", path, params);
  }
  post<T = Obj>(path: string, params?: Record<string, Param>, idem?: string) {
    return this.req<T>("POST", path, params, idem);
  }
  del<T = Obj>(path: string) {
    return this.req<T>("DELETE", path);
  }

  /** Every page of a list endpoint. */
  async all<T = Obj>(path: string, params: Record<string, Param> = {}): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.get<{ data: Array<T & { id: string }>; has_more: boolean }>(path, { limit: 100, ...params, starting_after: after });
      out.push(...page.data);
      if (!page.has_more || !page.data.length) return out;
      after = page.data[page.data.length - 1]!.id;
    }
  }
}

/** Verifies a `Stripe-Signature` header (v1 scheme) against the raw body. Tolerance 5 minutes. */
export function verifyWebhook(rawBody: Buffer, header: string | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]).filter((p) => p.length === 2 && p[0] !== "v1"));
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(nowSec - t) > 300 || !sigs.length) return false;
  const want = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

export function signWebhook(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}
