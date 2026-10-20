import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, offerConditions, offerCombinationPolicies, offerCustomerUsages, offers, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({
  db: null as unknown,
  shopId: "",
  publishError: null as string | null,
  published: 0,
}));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    shopDomain: "limits-flag.myshopify.com",
    session: { id: "offline_x", shop: "limits-flag.myshopify.com", onlineAccessInfo: null },
  }),
}));
vi.mock("@promo/db", async (importOriginal) => ({ ...(await importOriginal<typeof PromoDb>()), getDb: () => ctx.db }));
vi.mock("./offer-publish-flow.server.js", () => ({
  publishShopConfig: async () => {
    ctx.published += 1;
    return ctx.publishError;
  },
}));
vi.mock("./redis.server.js", () => ({ redisGetString: async () => null, redisSetString: async () => undefined, redisDelete: async () => undefined }));
vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));

const flag = await import("./limits-enforced.server.js");
const { loadOfferDefinitions } = await import("./offer-definitions.server.js");
const { getUsageStates } = await import("./usage-states.server.js");
const route = await import("../routes/app.settings.limits.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  vi.stubEnv("LIMITS_TOGGLE_SHOPS", "Limits-Flag.myshopify.com, other.myshopify.com");
  ({ db, close } = await createTestDb());
  ctx.db = db;
  shopId = await seedShop(db, "limits-flag.myshopify.com");
  ctx.shopId = shopId;
}, 60_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});

const call = (fn: unknown, request: Request) => (fn as (a: unknown) => Promise<Record<string, unknown>>)({ request, params: {}, context: {} });
const post = (fields: Record<string, string>) => call(route.action, new Request("http://localhost/", { method: "POST", body: new URLSearchParams(fields) }));

describe("limits.enforced flag", () => {
  it("is off by default and per shop", async () => {
    const other = await seedShop(db, "limits-flag-other.myshopify.com");
    expect(await flag.isLimitsEnforced(db, shopId)).toBe(false);
    await flag.setLimitsEnforced(db, other, true);
    expect(await flag.isLimitsEnforced(db, other)).toBe(true);
    expect(await flag.isLimitsEnforced(db, shopId)).toBe(false);
  });

  it("only shops in LIMITS_TOGGLE_SHOPS may toggle, and nobody when it is unset", () => {
    expect(flag.canToggleLimits("limits-flag.myshopify.com")).toBe(true);
    expect(flag.canToggleLimits("OTHER.myshopify.com")).toBe(true);
    expect(flag.canToggleLimits("stranger.myshopify.com")).toBe(false);
    vi.stubEnv("LIMITS_TOGGLE_SHOPS", "");
    expect(flag.canToggleLimits("limits-flag.myshopify.com")).toBe(false);
    vi.stubEnv("LIMITS_TOGGLE_SHOPS", "Limits-Flag.myshopify.com, other.myshopify.com");
  });
});

describe("settings route", () => {
  it("an allow-listed shop turns it on: saved, audited and republished", async () => {
    ctx.published = 0;
    expect(await post({ limits_enforced: "on" })).toEqual({ success: true });
    expect(await flag.isLimitsEnforced(db, shopId)).toBe(true);
    expect(ctx.published).toBe(1);
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.action, "limits_enforced_changed")));
    expect(audit).toMatchObject({ entityId: "limits.enforced", before: false, after: true, performedBy: "offline_x" });
    expect(await call(route.loader, new Request("http://localhost/"))).toEqual({ enforced: true, canToggle: true });
  });

  it("turns it off by leaving the box unchecked", async () => {
    await post({});
    expect(await flag.isLimitsEnforced(db, shopId)).toBe(false);
  });

  it("a shop outside the allow-list cannot change it", async () => {
    vi.stubEnv("LIMITS_TOGGLE_SHOPS", "someone-else.myshopify.com");
    ctx.published = 0;
    const res = await post({ limits_enforced: "on" });
    expect(res["error"]).toMatch(/not available/);
    expect(await flag.isLimitsEnforced(db, shopId)).toBe(false);
    expect(ctx.published).toBe(0);
    vi.stubEnv("LIMITS_TOGGLE_SHOPS", "Limits-Flag.myshopify.com, other.myshopify.com");
  });

  it("a failed republish reverts the flag, audits the revert and reports the error", async () => {
    ctx.publishError = "boom";
    const res = await post({ limits_enforced: "on" });
    expect(res["error"]).toMatch(/reverted.*boom/);
    expect(await flag.isLimitsEnforced(db, shopId)).toBe(false);
    const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.shopId, shopId), eq(auditLogs.action, "limits_enforced_changed")));
    expect(rows.slice(-2).map((r) => r.after)).toEqual([true, false]);
    ctx.publishError = null;
  });

  it("refuses to turn it on while limited automatic offers share a discount title", async () => {
    const a = await seedOffer(db, shopId, { publicTitle: "Clash  Title", internalName: "clash a" });
    await seedOffer(db, shopId, { publicTitle: "clash title", internalName: "clash b" });
    await db.insert(offerCombinationPolicies).values({ shopId, offerId: a, maxApplicationsPerCustomer: 1 });
    ctx.published = 0;
    const res = await post({ limits_enforced: "on" });
    expect(res["error"]).toMatch(/share a discount title.*clash a, clash b/);
    expect(await flag.isLimitsEnforced(db, shopId)).toBe(false);
    expect(ctx.published).toBe(0);
    await db.delete(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, a));
    await db.update(offers).set({ status: "archived" }).where(eq(offers.shopId, shopId));
  });
});

describe("evaluator offer definitions follow the flag", () => {
  it("carry the policy limits only while limits.enforced is on", async () => {
    const offerId = await seedOffer(db, shopId, { publicTitle: "Limited" });
    await db.insert(offerCombinationPolicies).values({
      shopId,
      offerId,
      maxApplicationsPerCart: 2,
      maxApplicationsPerCustomer: 3,
      requireIdentifiedCustomer: true,
    });
    const limits = async () => {
      const def = (await loadOfferDefinitions(shopId, db)).find((d) => d.id === offerId)!;
      return [def.combinationPolicy.maxApplicationsPerCart, def.combinationPolicy.maxApplicationsPerCustomer, def.combinationPolicy.requireIdentifiedCustomer];
    };
    expect(await limits()).toEqual([null, null, false]);
    await flag.setLimitsEnforced(db, shopId, true);
    expect(await limits()).toEqual([2, 3, true]);
    await flag.setLimitsEnforced(db, shopId, false);
  });
});

describe("one_use_per_customer reaches the evaluator only while the flag is on", () => {
  it("is dropped from the definitions when off and kept when on", async () => {
    const offerId = await seedOffer(db, shopId, { publicTitle: "OneUse" });
    await db.insert(offerConditions).values({
      shopId, offerId, scope: "sub", conditionType: "one_use_per_customer", operator: "eq", value: {}, sortOrder: 0, isEnabled: true,
    });
    const types = async () => (await loadOfferDefinitions(shopId, db)).find((d) => d.id === offerId)!.conditions.map((c) => c.conditionType);
    expect(await types()).toEqual([]);
    await flag.setLimitsEnforced(db, shopId, true);
    expect(await types()).toEqual(["one_use_per_customer"]);
    await flag.setLimitsEnforced(db, shopId, false);
  });
});

describe("getUsageStates", () => {
  it("counts paid-order rows per offer for the customer, scoped to the shop", async () => {
    const a = await seedOffer(db, shopId, { publicTitle: "UA" });
    const b = await seedOffer(db, shopId, { publicTitle: "UB" });
    const other = await seedShop(db, "limits-flag-usage.myshopify.com");
    const otherOffer = await seedOffer(db, other, { publicTitle: "UO" });
    const row = (s: string, offerId: string, order: string, customer = "gid://shopify/Customer/1") => ({
      shopId: s, offerId, customerGid: customer, orderGid: order, source: "title",
    });
    await db.insert(offerCustomerUsages).values([
      row(shopId, a, "o1"), row(shopId, a, "o2"), row(shopId, b, "o1"),
      row(shopId, a, "o3", "gid://shopify/Customer/2"), row(other, otherOffer, "o1"),
    ]);
    const states = await getUsageStates(shopId, db, "gid://shopify/Customer/1", [a, b, otherOffer]);
    expect(Object.fromEntries(states.map((s) => [s.offerId, Number(s.usedCount)]))).toEqual({ [a]: 2, [b]: 1 });
    expect(await getUsageStates(shopId, db, null, [a])).toEqual([]);
    expect(await getUsageStates(shopId, db, "gid://shopify/Customer/9", [a])).toEqual([]);
  });
});
