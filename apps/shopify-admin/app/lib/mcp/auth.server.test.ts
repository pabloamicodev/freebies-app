import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mcpCredentials, mcpOperators, type Db } from "@promo/db";
import {
  PAT_PREFIX,
  authenticateBearer,
  canSeeShop,
  createOperatorWithPat,
  normalizeAllowList,
  generatePat,
  hashToken,
  requireRole,
  revokeOperatorCredentials,
  roleAtLeast,
} from "./auth.server.js";
import { ToolError } from "./result.server.js";
import { createTestDb } from "../test-support/pglite-db.js";

const env = { MCP_TOKEN_PEPPER: "test-pepper-0123456789" } as NodeJS.ProcessEnv;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("hashToken / generatePat", () => {
  it("hashes deterministically, depends on the pepper, and never equals the token", () => {
    const pat = generatePat();
    expect(pat.startsWith(PAT_PREFIX)).toBe(true);
    expect(hashToken(pat, env)).toBe(hashToken(pat, env));
    expect(hashToken(pat, env)).not.toBe(hashToken(pat, { MCP_TOKEN_PEPPER: "another-pepper-0123456" } as NodeJS.ProcessEnv));
    expect(hashToken(pat, env)).not.toContain(pat);
    expect(generatePat()).not.toBe(pat);
  });
  it("refuses to hash without a pepper", () => {
    expect(() => hashToken("x", {} as NodeJS.ProcessEnv)).toThrow(/MCP_TOKEN_PEPPER/);
  });
});

describe("roles", () => {
  const op = (role: "viewer" | "editor" | "admin") => ({ id: "1", email: "a@b.c", name: "n", role, shopAllowList: ["*"] });
  it("orders viewer < editor < admin", () => {
    expect(roleAtLeast("admin", "editor")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(roleAtLeast("editor", "editor")).toBe(true);
  });
  it("requireRole throws FORBIDDEN", () => {
    expect(() => requireRole(op("viewer"), "admin")).toThrow(ToolError);
    try {
      requireRole(op("viewer"), "admin");
    } catch (error) {
      expect((error as ToolError).payload.code).toBe("FORBIDDEN");
    }
    expect(() => requireRole(op("admin"), "editor")).not.toThrow();
  });
});

describe("allow list", () => {
  it("lowercases, trims and dedupes; accepts only myshopify domains or a lone '*'", () => {
    expect(normalizeAllowList([" HPN-Test-Store.myshopify.com ", "hpn-test-store.myshopify.com"])).toEqual(["hpn-test-store.myshopify.com"]);
    expect(normalizeAllowList(["*"])).toEqual(["*"]);
    expect(normalizeAllowList([])).toEqual([]);
    for (const bad of ["hpn", "evil.com", "x.myshopify.com.evil.com", "", "*,a.myshopify.com"]) {
      expect(() => normalizeAllowList([bad])).toThrow(/Invalid shop/);
    }
    expect(() => normalizeAllowList(["*", "a.myshopify.com"])).toThrow(/cannot be combined/);
  });
  it("empty means no shops, '*' means all", () => {
    expect(canSeeShop([], "a.myshopify.com")).toBe(false);
    expect(canSeeShop(["*"], "a.myshopify.com")).toBe(true);
    expect(canSeeShop(["a.myshopify.com"], "A.myshopify.com")).toBe(true);
    expect(canSeeShop(["a.myshopify.com"], "b.myshopify.com")).toBe(false);
  });
  it("createOperatorWithPat normalizes the list and rejects invalid entries or ttl", async () => {
    const ok = await createOperatorWithPat(db, { email: "norm@example.com", name: "N", role: "viewer", shopAllowList: [" A.myshopify.com "] }, env);
    const [row] = await db.select().from(mcpOperators).where(eq(mcpOperators.id, ok.operatorId));
    expect(row!.shopAllowList).toEqual(["a.myshopify.com"]);
    await expect(
      createOperatorWithPat(db, { email: "bad@example.com", name: "B", role: "viewer", shopAllowList: ["nope"] }, env),
    ).rejects.toThrow(/Invalid shop/);
    for (const ttlDays of [0, 91, 1.5, Number.NaN]) {
      await expect(
        createOperatorWithPat(db, { email: "ttl@example.com", name: "T", role: "viewer", shopAllowList: [], ttlDays }, env),
      ).rejects.toThrow(/ttlDays/);
    }
  });
});

describe("authenticateBearer", () => {
  const now = new Date("2026-11-03T12:00:00Z");

  it("accepts a valid PAT, stores only the hash and stamps last_used_at", async () => {
    const { pat, operatorId } = await createOperatorWithPat(db, { email: "Admin@Example.com", name: "Admin", role: "admin", shopAllowList: ["*"] }, env, now);
    const operator = await authenticateBearer(db, `Bearer ${pat}`, env, now);
    expect(operator).toMatchObject({ id: operatorId, email: "admin@example.com", role: "admin", shopAllowList: ["*"] });

    const [cred] = await db.select().from(mcpCredentials).where(eq(mcpCredentials.operatorId, operatorId));
    expect(cred!.tokenHash).toBe(hashToken(pat, env));
    expect(cred!.tokenHash).not.toContain(pat);
    expect(pat.startsWith(cred!.prefix)).toBe(true);
    expect(cred!.lastUsedAt?.toISOString()).toBe(now.toISOString());
  });

  it("writes last_used_at at most once a minute", async () => {
    const { pat, operatorId } = await createOperatorWithPat(db, { email: "thr@example.com", name: "T", role: "viewer", shopAllowList: [] }, env, now);
    const lastUsed = async () =>
      (await db.select().from(mcpCredentials).where(eq(mcpCredentials.operatorId, operatorId)))[0]!.lastUsedAt?.toISOString();
    await authenticateBearer(db, `Bearer ${pat}`, env, now);
    await authenticateBearer(db, `Bearer ${pat}`, env, new Date(now.getTime() + 30_000));
    expect(await lastUsed()).toBe(now.toISOString());
    const later = new Date(now.getTime() + 61_000);
    await authenticateBearer(db, `Bearer ${pat}`, env, later);
    expect(await lastUsed()).toBe(later.toISOString());
  });

  it("revoking again does not move revoked_at", async () => {
    const { operatorId } = await createOperatorWithPat(db, { email: "rv2@example.com", name: "R", role: "viewer", shopAllowList: [] }, env, now);
    await revokeOperatorCredentials(db, operatorId, now);
    await revokeOperatorCredentials(db, operatorId, new Date(now.getTime() + 5_000));
    const [cred] = await db.select().from(mcpCredentials).where(eq(mcpCredentials.operatorId, operatorId));
    expect(cred!.revokedAt?.toISOString()).toBe(now.toISOString());
  });

  it("rejects missing, malformed and unknown tokens with UNAUTHENTICATED", async () => {
    for (const header of [null, "", "Bearer ", "Basic abc", "Bearer nope", `Bearer ${generatePat()}`]) {
      await expect(authenticateBearer(db, header, env, now)).rejects.toMatchObject({ payload: { code: "UNAUTHENTICATED" } });
    }
  });

  it("rejects an expired PAT", async () => {
    const { pat } = await createOperatorWithPat(db, { email: "exp@example.com", name: "E", role: "viewer", shopAllowList: ["*"], ttlDays: 1 }, env, now);
    const later = new Date(now.getTime() + 2 * 86_400_000);
    await expect(authenticateBearer(db, `Bearer ${pat}`, env, later)).rejects.toMatchObject({ payload: { code: "UNAUTHENTICATED" } });
    await expect(authenticateBearer(db, `Bearer ${pat}`, env, now)).resolves.toMatchObject({ email: "exp@example.com" });
  });

  it("rejects a revoked PAT and a disabled operator", async () => {
    const revoked = await createOperatorWithPat(db, { email: "rev@example.com", name: "R", role: "editor", shopAllowList: ["*"] }, env, now);
    await revokeOperatorCredentials(db, revoked.operatorId, now);
    await expect(authenticateBearer(db, `Bearer ${revoked.pat}`, env, now)).rejects.toMatchObject({ payload: { code: "UNAUTHENTICATED" } });

    const disabled = await createOperatorWithPat(db, { email: "dis@example.com", name: "D", role: "editor", shopAllowList: ["*"] }, env, now);
    await db.update(mcpOperators).set({ disabledAt: now }).where(eq(mcpOperators.id, disabled.operatorId));
    await expect(authenticateBearer(db, `Bearer ${disabled.pat}`, env, now)).rejects.toMatchObject({ payload: { code: "UNAUTHENTICATED" } });
  });

  it("a PAT hashed with another pepper does not authenticate", async () => {
    const { pat } = await createOperatorWithPat(db, { email: "pep@example.com", name: "P", role: "viewer", shopAllowList: ["*"] }, env, now);
    await expect(
      authenticateBearer(db, `Bearer ${pat}`, { MCP_TOKEN_PEPPER: "different-pepper-0123456" } as NodeJS.ProcessEnv, now),
    ).rejects.toMatchObject({ payload: { code: "UNAUTHENTICATED" } });
  });
});
