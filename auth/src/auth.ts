// SPDX-License-Identifier: AGPL-3.0-only
// The app's own login (ADR 0008): setup code on first run, password, optional passkey or TOTP,
// recovery codes, sessions, and a fresh second-factor check for approvals that loosen access.
import type http from "node:http";
import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

type DB = DatabaseSync;

export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface HumanSession {
  userId: string;
  username: string;
  isOwner: boolean;
  twoFactor: boolean;
  fresh: boolean;
}

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: unknown;
  human: HumanSession | null;
}
type Handler = (c: Ctx) => Promise<unknown> | unknown;

export const SESSION_COOKIE = "cb_session";
export const SESSION_IDLE_MS = 30 * 24 * 3600 * 1000;
export const FRESH_MS = 5 * 60 * 1000;
const now = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------- passwords (scrypt) ----------

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptAsync(pw: string, salt: Buffer, len: number, o: typeof SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(pw.normalize("NFKC"), salt, len, o, (e, k) => (e ? reject(e) : resolve(k))));
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) {
    // Spend the same time on unknown users / bad hashes.
    await scryptAsync(pw, randomBytes(16), 32, SCRYPT);
    return false;
  }
  const expected = Buffer.from(key, "base64");
  const got = await scryptAsync(pw, Buffer.from(salt, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret: string, at = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1]! & 15;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

export function verifyTotp(secret: string, code: string, at = Date.now()): boolean {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  for (const drift of [-1, 0, 1]) {
    const expected = totpAt(secret, at + drift * 30_000);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}

// ---------- recovery codes ----------

export function makeRecoveryCodes(n = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () =>
    Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("")).join("-"),
  );
}

// ---------- the auth service ----------

export interface AuthOptions {
  appOrigin: string;
  /** Secure cookies (true behind HTTPS). */
  secureCookies?: boolean;
  log?: (msg: string) => void;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  is_owner: number;
  totp_secret: string | null;
}

export class Auth {
  private readonly db: DB;
  private readonly o: AuthOptions;
  private readonly rpID: string;
  private readonly challenges = new Map<string, { challenge: string; userId?: string; expires: number }>();
  private readonly pendingTotp = new Map<string, { secret: string; expires: number }>();
  private readonly attempts = new Map<string, number[]>();

  constructor(db: DB, o: AuthOptions) {
    this.db = db;
    this.o = o;
    this.rpID = new URL(o.appOrigin).hostname;
  }

  private meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }
  private setMeta(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    else this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  hasUsers(): boolean {
    return !!this.db.prepare("SELECT 1 FROM users LIMIT 1").get();
  }

  /** First run: a setup code is printed in the logs; the first account needs it. */
  ensureSetupCode(): string | null {
    if (this.hasUsers() && !this.meta("reset_owner_code")) return null;
    const code = randomBytes(9).toString("base64url");
    this.setMeta(this.hasUsers() ? "reset_owner_code" : "setup_code", sha(code));
    this.o.log?.(`\n  Crossbar ${this.hasUsers() ? "owner reset" : "setup"} code: ${code}\n  Open ${this.o.appOrigin} and enter it.\n`);
    return code;
  }

  /** `reset-owner`, run inside the container: the next setup with this code resets the owner's password and 2FA. */
  resetOwner(): string {
    const code = randomBytes(9).toString("base64url");
    this.setMeta("reset_owner_code", sha(code));
    return code;
  }

  // ---- sessions ----

  private cookie(id: string, maxAgeMs: number): string {
    return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${this.o.secureCookies ? "; Secure" : ""}`;
  }

  private startSession(res: http.ServerResponse, userId: string, fresh: boolean): void {
    const id = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO web_sessions (id_hash, user_id, created_at, last_seen, fresh_until) VALUES (?, ?, ?, ?, ?)").run(sha(id), userId, now(), now(), fresh ? new Date(Date.now() + FRESH_MS).toISOString() : null);
    res.setHeader("set-cookie", this.cookie(id, SESSION_IDLE_MS));
  }

  private sessionId(req: http.IncomingMessage): string | null {
    const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9_-]{20,})`).exec(req.headers.cookie ?? "");
    return m?.[1] ?? null;
  }

  session(req: http.IncomingMessage): HumanSession | null {
    const id = this.sessionId(req);
    if (!id) return null;
    const row = this.db
      .prepare("SELECT s.user_id, s.last_seen, s.fresh_until, u.username, u.is_owner, u.totp_secret FROM web_sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?")
      .get(sha(id)) as { user_id: string; last_seen: string; fresh_until: string | null; username: string; is_owner: number; totp_secret: string | null } | undefined;
    if (!row) return null;
    if (Date.now() - Date.parse(row.last_seen) > SESSION_IDLE_MS) {
      this.db.prepare("DELETE FROM web_sessions WHERE id_hash = ?").run(sha(id));
      return null;
    }
    if (Date.now() - Date.parse(row.last_seen) > 60_000) this.db.prepare("UPDATE web_sessions SET last_seen = ? WHERE id_hash = ?").run(now(), sha(id));
    return {
      userId: row.user_id,
      username: row.username,
      isOwner: !!row.is_owner,
      twoFactor: this.twoFactor(row.user_id),
      fresh: !!row.fresh_until && Date.parse(row.fresh_until) > Date.now(),
    };
  }

  private markFresh(req: http.IncomingMessage): void {
    const id = this.sessionId(req);
    if (id) this.db.prepare("UPDATE web_sessions SET fresh_until = ? WHERE id_hash = ?").run(new Date(Date.now() + FRESH_MS).toISOString(), sha(id));
  }

  twoFactor(userId: string): boolean {
    const u = this.db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(userId) as { totp_secret: string | null } | undefined;
    const pk = this.db.prepare("SELECT 1 FROM passkeys WHERE user_id = ? LIMIT 1").get(userId);
    return !!u?.totp_secret || !!pk;
  }

  // ---- rate limiting ----

  private throttle(key: string): void {
    const list = (this.attempts.get(key) ?? []).filter((t) => Date.now() - t < 15 * 60_000);
    if (list.length >= 10) throw new AuthError(429, "Too many attempts. Wait 15 minutes.");
    list.push(Date.now());
    this.attempts.set(key, list);
  }

  // ---- users ----

  async createUser(username: string, password: string, isOwner: boolean): Promise<string> {
    const id = randomBytes(9).toString("base64url");
    try {
      this.db.prepare("INSERT INTO users (id, username, password_hash, is_owner, created_at) VALUES (?, ?, ?, ?, ?)").run(id, username.trim().toLowerCase(), await hashPassword(password), isOwner ? 1 : 0, now());
    } catch {
      throw new AuthError(409, "That username is taken.");
    }
    return id;
  }

  private user(username: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE username = ?").get(username.trim().toLowerCase()) as UserRow | undefined;
  }

  private useRecoveryCode(userId: string, code: string): boolean {
    const h = sha(code.trim().toLowerCase());
    return this.db.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL").run(now(), userId, h).changes > 0;
  }

  private issueRecoveryCodes(userId: string): string[] {
    const codes = makeRecoveryCodes();
    this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
    const ins = this.db.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)");
    for (const c of codes) ins.run(userId, sha(c));
    return codes;
  }

  private takeChallenge(id: string | undefined): { challenge: string; userId?: string } {
    const c = id ? this.challenges.get(id) : undefined;
    if (id) this.challenges.delete(id);
    if (!c || c.expires < Date.now()) throw new AuthError(400, "Challenge expired. Try again.");
    return c;
  }
  private putChallenge(challenge: string, userId?: string): string {
    const id = randomBytes(12).toString("base64url");
    this.challenges.set(id, { challenge, userId, expires: Date.now() + 5 * 60_000 });
    if (this.challenges.size > 1000) for (const [k, v] of this.challenges) if (v.expires < Date.now()) this.challenges.delete(k);
    return id;
  }

  private async verifyPasskey(response: AuthenticationResponseJSON, challengeId: string, mustBeUser?: string): Promise<string> {
    const { challenge, userId } = this.takeChallenge(challengeId);
    const row = this.db.prepare("SELECT * FROM passkeys WHERE id = ?").get(response.id) as { id: string; user_id: string; public_key: Uint8Array; counter: number; transports: string | null } | undefined;
    if (!row) throw new AuthError(401, "Unknown passkey.");
    if (mustBeUser && row.user_id !== mustBeUser) throw new AuthError(401, "That passkey belongs to someone else.");
    if (userId && row.user_id !== userId) throw new AuthError(401, "Wrong passkey.");
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.o.appOrigin,
      expectedRPID: this.rpID,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: row.transports ? JSON.parse(row.transports) : undefined },
      requireUserVerification: true,
    }).catch(() => ({ verified: false, authenticationInfo: { newCounter: 0 } }));
    if (!v.verified) throw new AuthError(401, "Passkey check failed.");
    this.db.prepare("UPDATE passkeys SET counter = ? WHERE id = ?").run(v.authenticationInfo.newCounter, row.id);
    return row.user_id;
  }

  // ---- route handlers ----

  get handlers(): Record<string, Handler> {
    return {
      "GET /api/setup": () => ({ open: !this.hasUsers() || !!this.meta("reset_owner_code"), reset: this.hasUsers() && !!this.meta("reset_owner_code") }),
      "POST /api/setup": async (c) => {
        const b = c.body as { code: string; username: string; password: string };
        this.throttle(`setup:${c.req.socket.remoteAddress}`);
        const resetting = this.hasUsers();
        const stored = this.meta(resetting ? "reset_owner_code" : "setup_code");
        if (!stored || !timingSafeEqual(Buffer.from(stored), Buffer.from(sha(b.code.trim())))) throw new AuthError(403, "Wrong setup code. It's in the app's logs.");
        let userId: string;
        if (resetting) {
          const owner = this.db.prepare("SELECT id, username FROM users WHERE is_owner = 1 ORDER BY created_at LIMIT 1").get() as { id: string; username: string };
          userId = owner.id;
          this.db.prepare("UPDATE users SET password_hash = ?, totp_secret = NULL WHERE id = ?").run(await hashPassword(b.password), userId);
          this.db.prepare("DELETE FROM passkeys WHERE user_id = ?").run(userId);
          this.db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(userId);
          this.db.prepare("DELETE FROM web_sessions WHERE user_id = ?").run(userId);
          this.setMeta("reset_owner_code", null);
        } else {
          userId = await this.createUser(b.username, b.password, true);
          this.setMeta("setup_code", null);
        }
        this.startSession(c.res, userId, true);
        return { ok: true, reset: resetting };
      },
      "POST /api/login": async (c) => {
        const b = c.body as { username: string; password: string; totp?: string; recoveryCode?: string };
        this.throttle(`login:${b.username.toLowerCase()}:${c.req.socket.remoteAddress}`);
        const u = this.user(b.username);
        const ok = await verifyPassword(b.password, u?.password_hash ?? "");
        if (!u || !ok) throw new AuthError(401, "Wrong username or password.");
        if (this.twoFactor(u.id)) {
          if (b.totp && u.totp_secret && verifyTotp(u.totp_secret, b.totp)) {
            /* ok */
          } else if (b.recoveryCode && this.useRecoveryCode(u.id, b.recoveryCode)) {
            /* ok */
          } else {
            const hasTotp = !!u.totp_secret;
            throw new AuthError(401, hasTotp ? "second_factor_required" : "passkey_required");
          }
        }
        this.startSession(c.res, u.id, this.twoFactor(u.id));
        return { ok: true };
      },
      "POST /api/passkey/login/options": async () => {
        const opts = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: "required" });
        return { challengeId: this.putChallenge(opts.challenge), options: opts };
      },
      "POST /api/passkey/login/verify": async (c) => {
        const b = c.body as { challengeId: string; response: AuthenticationResponseJSON };
        this.throttle(`passkey:${c.req.socket.remoteAddress}`);
        const userId = await this.verifyPasskey(b.response, b.challengeId);
        this.startSession(c.res, userId, true);
        return { ok: true };
      },
      "POST /api/logout": (c) => {
        const id = this.sessionId(c.req);
        if (id) this.db.prepare("DELETE FROM web_sessions WHERE id_hash = ?").run(sha(id));
        c.res.setHeader("set-cookie", this.cookie("", 0));
        return { ok: true };
      },
      "GET /api/me": (c) => {
        const h = c.human!;
        const u = this.db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(h.userId) as { totp_secret: string | null };
        const passkeys = (this.db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?").get(h.userId) as { n: number }).n;
        const recovery = (this.db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").get(h.userId) as { n: number }).n;
        return { ...h, totp: !!u.totp_secret, passkeys, recoveryCodesLeft: recovery };
      },
      "POST /api/me/password": async (c) => {
        const b = c.body as { current: string; next: string };
        const u = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(c.human!.userId) as { password_hash: string };
        if (!(await verifyPassword(b.current, u.password_hash))) throw new AuthError(401, "Current password is wrong.");
        if (c.human!.twoFactor && !c.human!.fresh) throw new AuthError(401, "fresh_factor_required");
        this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(b.next), c.human!.userId);
        return { ok: true };
      },
      "POST /api/me/totp/begin": (c) => {
        const secret = base32Encode(randomBytes(20));
        this.pendingTotp.set(c.human!.userId, { secret, expires: Date.now() + 10 * 60_000 });
        const label = encodeURIComponent(`Crossbar:${c.human!.username}`);
        return { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=Crossbar&algorithm=SHA1&digits=6&period=30` };
      },
      "POST /api/me/totp/enable": (c) => {
        const b = c.body as { secret: string; code: string };
        const p = this.pendingTotp.get(c.human!.userId);
        if (!p || p.secret !== b.secret || p.expires < Date.now()) throw new AuthError(400, "Start TOTP setup again.");
        if (!verifyTotp(b.secret, b.code)) throw new AuthError(400, "That code doesn't match. Check your phone's clock.");
        if (c.human!.twoFactor && !c.human!.fresh) throw new AuthError(401, "fresh_factor_required");
        this.pendingTotp.delete(c.human!.userId);
        this.db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(b.secret, c.human!.userId);
        this.markFresh(c.req);
        return { ok: true, recoveryCodes: this.issueRecoveryCodes(c.human!.userId) };
      },
      "POST /api/me/passkey/options": async (c) => {
        const existing = this.db.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?").all(c.human!.userId) as Array<{ id: string; transports: string | null }>;
        const opts = await generateRegistrationOptions({
          rpName: "Crossbar",
          rpID: this.rpID,
          userName: c.human!.username,
          userID: new TextEncoder().encode(c.human!.userId),
          attestationType: "none",
          excludeCredentials: existing.map((e) => ({ id: e.id, transports: e.transports ? JSON.parse(e.transports) : undefined })),
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        });
        return { challengeId: this.putChallenge(opts.challenge, c.human!.userId), options: opts };
      },
      "POST /api/me/passkey/verify": async (c) => {
        const b = c.body as { challengeId: string; response: RegistrationResponseJSON };
        const { challenge, userId } = this.takeChallenge(b.challengeId);
        if (userId !== c.human!.userId) throw new AuthError(400, "Challenge mismatch.");
        if (c.human!.twoFactor && !c.human!.fresh) throw new AuthError(401, "fresh_factor_required");
        const v = await verifyRegistrationResponse({ response: b.response, expectedChallenge: challenge, expectedOrigin: this.o.appOrigin, expectedRPID: this.rpID, requireUserVerification: true }).catch((e: Error) => {
          throw new AuthError(400, `Passkey registration failed: ${e.message}`);
        });
        if (!v.verified || !v.registrationInfo) throw new AuthError(400, "Passkey registration failed.");
        const cred = v.registrationInfo.credential;
        this.db.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(cred.id, c.human!.userId, cred.publicKey, cred.counter, JSON.stringify(cred.transports ?? []), now());
        this.markFresh(c.req);
        const hasCodes = (this.db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").get(c.human!.userId) as { n: number }).n > 0;
        return { ok: true, recoveryCodes: hasCodes ? null : this.issueRecoveryCodes(c.human!.userId) };
      },
      "POST /api/me/reauth": (c) => {
        const b = (c.body ?? {}) as { totp?: string };
        this.throttle(`reauth:${c.human!.userId}`);
        const u = this.db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(c.human!.userId) as { totp_secret: string | null };
        if (!c.human!.twoFactor) {
          this.markFresh(c.req);
          return { ok: true };
        }
        if (!u.totp_secret || !b.totp || !verifyTotp(u.totp_secret, b.totp)) throw new AuthError(401, "Wrong code.");
        this.markFresh(c.req);
        return { ok: true };
      },
      "POST /api/me/reauth/passkey/options": async (c) => {
        const keys = this.db.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?").all(c.human!.userId) as Array<{ id: string; transports: string | null }>;
        if (keys.length === 0) throw new AuthError(400, "No passkey on this account.");
        const opts = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: "required", allowCredentials: keys.map((k) => ({ id: k.id, transports: k.transports ? JSON.parse(k.transports) : undefined })) });
        return { challengeId: this.putChallenge(opts.challenge, c.human!.userId), options: opts };
      },
      "POST /api/me/reauth/passkey/verify": async (c) => {
        const b = c.body as { challengeId: string; response: AuthenticationResponseJSON };
        await this.verifyPasskey(b.response, b.challengeId, c.human!.userId);
        this.markFresh(c.req);
        return { ok: true };
      },
      "GET /api/users": () => this.db.prepare("SELECT id, username, is_owner AS isOwner, created_at AS createdAt FROM users ORDER BY created_at").all(),
      "POST /api/users": async (c) => {
        const b = c.body as { username: string; password: string };
        return { id: await this.createUser(b.username, b.password, false), username: b.username.trim().toLowerCase() };
      },
    };
  }
}
