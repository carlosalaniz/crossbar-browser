// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const randomId = (bytes = 16) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Keys held by the app container only (the browser container never sees them). */
export class Keys {
  readonly hmacKey: Buffer;
  readonly sealKey: Buffer;
  constructor(master: Buffer) {
    this.hmacKey = createHmac("sha256", master).update("crossbar:hmac").digest();
    this.sealKey = createHmac("sha256", master).update("crossbar:seal").digest();
  }
  /** Keyed hash of a value: lets you see the same secret went two places without storing it. */
  keyedHash(v: string): string {
    return createHmac("sha256", this.hmacKey).update(v).digest("hex").slice(0, 16);
  }
  sign(v: string): string {
    return createHmac("sha256", this.hmacKey).update(`sig:${v}`).digest("base64url");
  }
  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.sealKey, iv);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }
  unseal(sealed: string): string {
    const buf = Buffer.from(sealed, "base64");
    const d = createDecipheriv("aes-256-gcm", this.sealKey, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  }
}
