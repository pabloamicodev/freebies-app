import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mcpOperators, type Db } from "@promo/db";
import { createOperatorWithPat } from "./auth.server.js";
import { enforceOperatorRate, rateLimitFor, RATE_LIMITS } from "./call-log.server.js";
import { handleAuthorize, handleRegister, type OAuthDeps } from "./oauth-http.server.js";
import { ToolError } from "./result.server.js";
import {
  base32Decode,
  base32Encode,
  checkOperatorTotp,
  disableTotp,
  enableTotp,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from "./totp.server.js";
import { isEncryptedToken } from "../token-crypto.server.js";
import { createTestDb } from "../test-support/pglite-db.js";

const ORIGIN = "https://promo.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const env = { MCP_ENABLED: "true", MCP_TOKEN_PEPPER: "test-pepper-0123456789" } as NodeJS.ProcessEnv;
let db: Db;
let close: () => Promise<void>;
let clock = new Date("2026-11-04T12:00:00Z");
const ok = async () => ({ ok: true as const });
const deps = (): OAuthDeps => ({ db, env, now: () => clock, rateLimit: ok });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890", 8 digits there; the last 6 match ours.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP primitives", () => {
  it("matches the RFC 6238 SHA-1 test vectors", () => {
    expect(totpCode(RFC_SECRET, 59 / 30 >> 0)).toBe("287082");
    expect(totpCode(RFC_SECRET, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpCode(RFC_SECRET, Math.floor(20000000000 / 30))).toBe("353130");
  });

  it("round-trips base32", () => {
    const bytes = Buffer.from("hello totp world");
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it("accepts +-1 step, rejects 2 steps away, bad shapes and replays", () => {
    const now = new Date("2026-11-04T12:00:10Z");
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, ` ${totpCode(RFC_SECRET, step).slice(0, 3)} ${totpCode(RFC_SECRET, step).slice(3)}`, now, step - 1)).toBe(step);
  });

  it("builds an otpauth URI", () => {
    const uri = otpauthUri("ABC234", "a@b.com");
    expect(uri.startsWith("otpauth://totp/Promo%20Engine%20MCP%3Aa%40b.com?secret=ABC234")).toBe(true);
    expect(uri).toContain("period=30");
  });
});

describe("operator TOTP", () => {
  it("is off by default, stored encrypted, and enforces replay prevention", async () => {
    const { operatorId } = await createOperatorWithPat(db, { email: "totp1@example.com", name: "T", role: "admin", shopAllowList: ["*"] }, env, clock);
    expect(await checkOperatorTotp(db, operatorId, "", clock)).toBe(true);

    process.env["TOKEN_ENCRYPTION_KEY"] = "ab".repeat(32);
    const { uri } = await enableTotp(db, "TOTP1@example.com");
    const secret = new URL(uri).searchParams.get("secret")!;
    const [row] = await db.select().from(mcpOperators).where(eq(mcpOperators.id, operatorId));
    expect(isEncryptedToken(row!.totpSecret!)).toBe(true);
    expect(row!.totpSecret).not.toContain(secret);

    expect(await checkOperatorTotp(db, operatorId, "", clock)).toBe(false);
    expect(await checkOperatorTotp(db, operatorId, "000000", clock)).toBe(false);
    const code = totpCode(secret, totpStep(clock));
    expect(await checkOperatorTotp(db, operatorId, code, clock)).toBe(true);
    expect(await checkOperatorTotp(db, operatorId, code, clock)).toBe(false);
    expect(await checkOperatorTotp(db, operatorId, totpCode(secret, totpStep(clock) - 1), clock)).toBe(false);

    await disableTotp(db, "totp1@example.com");
    expect(await checkOperatorTotp(db, operatorId, "", clock)).toBe(true);
    await expect(enableTotp(db, "nobody@example.com")).rejects.toThrow("no such operator");
    delete process.env["TOKEN_ENCRYPTION_KEY"];
  });
});

describe("authorize with TOTP", () => {
  const form = (fields: Record<string, string>, headers: Record<string, string>) =>
    new Request(`${ORIGIN}/mcp/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    });

  it("requires a valid, unused code at the review step", async () => {
    const reg = await handleRegister(
      new Request(`${ORIGIN}/api/mcp/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }) }),
      deps(),
    );
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const { pat } = await createOperatorWithPat(db, { email: "totp2@example.com", name: "T2", role: "viewer", shopAllowList: ["*"] }, env, clock);
    const secret = new URL((await enableTotp(db, "totp2@example.com")).uri).searchParams.get("secret")!;
    const params = { client_id: clientId, redirect_uri: REDIRECT, state: "s", code_challenge: "A".repeat(43), code_challenge_method: "S256", response_type: "code" };
    const get = await handleAuthorize(new Request(`${ORIGIN}/mcp/authorize?${new URLSearchParams(params)}`), deps());
    const cookie = get.headers.get("set-cookie")!.split(";")[0]!;
    const csrf = cookie.split("=")[1]!;
    const review = (code?: string) =>
      handleAuthorize(form({ ...params, csrf, pat, intent: "review", ...(code === undefined ? {} : { code }) }, { cookie, origin: ORIGIN }), deps());

    expect((await review()).status).toBe(401);
    expect((await review("123456")).status).toBe(401);
    const good = totpCode(secret, totpStep(clock));
    const accepted = await review(good);
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain("Allow");
    expect((await review(good)).status).toBe(401);
  });
});

describe("rate limits", () => {
  it("defaults to 60/10/3 and reads bounded env overrides", () => {
    expect(RATE_LIMITS).toEqual({ read: 60, write: 10, critical: 3 });
    expect(rateLimitFor("read", {})).toBe(60);
    expect(rateLimitFor("write", { MCP_RATE_WRITES: "25" })).toBe(25);
    expect(rateLimitFor("critical", { MCP_RATE_CRITICAL: "1" })).toBe(1);
    for (const bad of ["0", "-3", "601", "abc", "1.5", ""]) expect(rateLimitFor("read", { MCP_RATE_READS: bad })).toBe(60);
  });

  it("passes the configured limit to the limiter and reports retryAfterSeconds", async () => {
    const seen: Array<[string, number]> = [];
    const ctx = {
      operator: { id: "op-1" } as never,
      rateLimit: async (key: string, limit: number) => {
        seen.push([key, limit]);
        return { ok: false as const, retryAfterSeconds: 17 };
      },
    };
    process.env["MCP_RATE_CRITICAL"] = "5";
    try {
      const error = await enforceOperatorRate(ctx, "critical").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).payload).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 17 });
    } finally {
      delete process.env["MCP_RATE_CRITICAL"];
    }
    expect(seen).toEqual([["mcp:critical:op-1", 5]]);
  });
});
