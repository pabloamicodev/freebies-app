import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { mcpOperators, type Db } from "@promo/db";
import { decryptToken, encryptToken } from "../token-crypto.server.js";

/** RFC 6238 with SHA-1, 6 digits and a 30 s step: what every authenticator app defaults to. */
export const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, "").toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** The matching time step within +-1 of now and strictly after `lastStep`, or null. */
export function verifyTotp(secretBase32: string, code: string, now: Date, lastStep: number | null): number | null {
  const given = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const current = totpStep(now);
  let match: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    const same = timingSafeEqual(Buffer.from(totpCode(secretBase32, step)), Buffer.from(given));
    if (same && (lastStep === null || step > lastStep)) match = step;
  }
  return match;
}

export function otpauthUri(secretBase32: string, email: string, issuer = "Promo Engine MCP"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/** Stores a fresh secret (replacing any previous one) and returns the otpauth URI, shown once by the CLI. */
export async function enableTotp(db: Db, email: string): Promise<{ uri: string }> {
  const normalized = email.trim().toLowerCase();
  const secret = generateTotpSecret();
  const updated = await db
    .update(mcpOperators)
    .set({ totpSecret: await encryptToken(secret), totpLastStep: null })
    .where(eq(mcpOperators.email, normalized))
    .returning({ id: mcpOperators.id });
  if (!updated.length) throw new Error("no such operator");
  return { uri: otpauthUri(secret, normalized) };
}

export async function disableTotp(db: Db, email: string): Promise<void> {
  const updated = await db
    .update(mcpOperators)
    .set({ totpSecret: null, totpLastStep: null })
    .where(eq(mcpOperators.email, email.trim().toLowerCase()))
    .returning({ id: mcpOperators.id });
  if (!updated.length) throw new Error("no such operator");
}

/**
 * True when the operator has no TOTP, or the code is valid. The step is claimed with a conditional update so a
 * code cannot be used twice even by concurrent requests.
 */
export async function checkOperatorTotp(db: Db, operatorId: string, code: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ secret: mcpOperators.totpSecret, lastStep: mcpOperators.totpLastStep })
    .from(mcpOperators)
    .where(eq(mcpOperators.id, operatorId))
    .limit(1);
  if (!row?.secret) return true;
  const step = verifyTotp(await decryptToken(row.secret), code, now, row.lastStep);
  if (step === null) return false;
  const claimed = await db
    .update(mcpOperators)
    .set({ totpLastStep: step })
    .where(and(eq(mcpOperators.id, operatorId), or(isNull(mcpOperators.totpLastStep), lt(mcpOperators.totpLastStep, step))))
    .returning({ id: mcpOperators.id });
  return claimed.length === 1;
}
