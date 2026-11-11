// SPDX-License-Identifier: AGPL-3.0-only
// Fixture accounts and RFC 6238 TOTP. All credentials here are fake and published in the README.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface Account {
  username: string;
  email: string;
  password: string;
  /** Base32 TOTP secret, or none. */
  totp?: string;
  displayName: string;
}

export const FIXTURE_ACCOUNTS: Account[] = [
  { username: "alice", email: "alice@site-a.test", password: "correct-horse-battery-staple", displayName: "Alice Example" },
  // The RFC 4226/6238 example secret "JBSWY3DPEHPK3PXP" ("Hello!\xde\xad\xbe\xef"), well known and fake.
  { username: "bob", email: "bob@site-a.test", password: "tr0ub4dor-and-3", totp: "JBSWY3DPEHPK3PXP", displayName: "Bob Example" },
];

function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new Error("bad base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret: string, timeMs: number, step = 30, digits = 6): string {
  const counter = Math.floor(timeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

/** Accepts the current step and one step either side. */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (const d of [-1, 0, 1]) {
    const want = Buffer.from(totpAt(secret, now + d * 30_000));
    if (timingSafeEqual(want, Buffer.from(code))) return true;
  }
  return false;
}

export class Accounts {
  private byName = new Map<string, Account>();
  constructor() {
    for (const a of FIXTURE_ACCOUNTS) this.byName.set(a.username, { ...a });
  }
  get(username: string): Account | undefined {
    return this.byName.get(username);
  }
  check(username: string, password: string): Account | undefined {
    const a = this.byName.get(username);
    return a && a.password === password ? a : undefined;
  }
  register(a: Account): boolean {
    if (this.byName.has(a.username)) return false;
    this.byName.set(a.username, a);
    return true;
  }
  delete(username: string): void {
    this.byName.delete(username);
  }
}
