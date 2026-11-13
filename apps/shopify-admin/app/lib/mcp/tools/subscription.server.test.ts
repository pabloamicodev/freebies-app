import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appSettings, auditLogs, mcpCallLog, mcpOperators, type Db } from "@promo/db";
import { createTestDb, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import { SKIO_API_KEY_SETTING } from "../../skio-credentials.server.js";
import { registerSubscriptionTools } from "./register-subscription.server.js";

const store = vi.hoisted(() => ({ plans: new Map<string, Record<string, any>>(), seq: 0, tiers: null as unknown, skioKey: "" }));

vi.mock("../../token-crypto.server.js", () => ({
  encryptToken: async (v: string) => `enc:${v}`,
  decryptToken: async (v: string) => v.replace(/^enc:/, ""),
}));
vi.mock("../../subscription-cycle-pricing.server.js", () => {
  const own = (id: string) => store.plans.get(id);
  return {
    listCyclePricingPlans: async () => [...store.plans.values()].filter((p) => p.owned),
    getCyclePricingPlan: async (_c: unknown, id: string) => {
      const p = own(id);
      return p?.owned ? p : null;
    },
    createCyclePricingPlan: async (_c: unknown, input: Record<string, unknown>) => {
      const id = `gid://shopify/SellingPlanGroup/${++store.seq}`;
      store.plans.set(id, { ...input, id, sellingPlanId: `gid://shopify/SellingPlan/${store.seq}`, productTitlesById: {}, owned: true });
      return { id, userErrors: [] };
    },
    updateCyclePricingPlan: async (_c: unknown, existing: { id: string }, input: Record<string, unknown>) => {
      store.plans.set(existing.id, { ...store.plans.get(existing.id), ...input });
      return { userErrors: [] };
    },
    deleteCyclePricingPlan: async (_c: unknown, id: string) => {
      store.plans.delete(id);
      return { userErrors: [] };
    },
  };
});
vi.mock("../../skio-shipping-config.server.js", async (importActual) => {
  const actual = await importActual<typeof import("../../skio-shipping-config.server.js")>();
  return {
    ...actual,
    loadSkioShippingConfig: async () => ({ config: (store.tiers as { tiers: unknown[] } | null) ?? { tiers: [] }, configValid: true, configError: null, importedFromLegacy: false }),
    saveSkioShippingConfig: async (_c: unknown, config: unknown) => {
      store.tiers = config;
      return { userErrors: [] };
    },
  };
});
vi.mock("../../skio-api.server.js", () => ({
  validateSkioApiKey: async (key: string) => (key.startsWith("skio_") ? { ok: true } : { ok: false, error: "Skio rejected the API key." }),
  makeSkioGraphQLProxy: (key: string) => {
    store.skioKey = key;
    return {};
  },
}));
vi.mock("../../skio-shipping-runner.server.js", () => ({
  runSkioShippingSync: async () => [
    { subscriptionId: "s1", matchedTierId: "t", targetCycle: 1, overrideAmount: 0, applied: true },
    { subscriptionId: "s2", matchedTierId: null, targetCycle: 1, overrideAmount: null, applied: false },
  ],
}));

const SHOP = "onesol.myshopify.com";
const SECRET = "skio_super-secret-key-123456";
const PLAN = {
  name: "Monthly",
  intervalUnit: "MONTH",
  intervalCount: 1,
  totalCycles: 12,
  firstCycleDiscount: { type: "percentage", value: 20 },
  recurringDiscount: { type: "fixed_amount", value: 2 },
  productIds: ["gid://shopify/Product/1"],
};
const TIER = { id: "free-first", name: "Free first box", subscriptionDurationMonths: 1, minSubtotal: 0, maxSubtotal: null, productVariantIds: null, cycleOverrides: [{ cycle: 2, override: { amount: 1.99 } }], defaultOverride: { amount: 0 } };

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let client: Client;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, SHOP);
  const [op] = await db.insert(mcpOperators).values({ email: "viewer@example.com", name: "viewer", role: "viewer", shopAllowList: ["*"] }).returning();
  const operator: Operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
  const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(), rateLimit: async () => ({ ok: true as const }), publish: vi.fn<ShopPublishFn>(async () => null) };
  const server = new McpServer({ name: "t", version: "1" });
  registerSubscriptionTools(server, ctx);
  client = new Client({ name: "vitest", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  stop = async () => {
    await client.close();
    await server.close();
  };
}, 60_000);
afterAll(async () => {
  await stop();
  await close();
});
beforeEach(() => {
  store.plans.clear();
  store.tiers = null;
  resetMemoryRateLimits();
});

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: { shop: SHOP, ...args } });
  return { res, body: res.structuredContent as { summary: string; data: Record<string, any>; code?: string; message?: string; meta?: { dryRun?: boolean } } };
};

describe("subscription pricing", () => {
  it("set (create) -> list -> get -> set (update) -> delete round trip, viewer can write", async () => {
    const created = await call("subscription_pricing_set", { plan: PLAN });
    expect(created.res.isError, JSON.stringify(created.body)).toBeFalsy();
    const planId = created.body.data["planId"] as string;
    expect(planId).toMatch(/^gid:\/\/shopify\/SellingPlanGroup\//);
    expect(created.body.data["created"]).toBe(true);

    const listed = await call("subscription_pricing_list", {});
    expect(listed.body.data["plans"]).toHaveLength(1);

    const got = await call("subscription_pricing_get", { planId });
    expect(got.body.data).toMatchObject({ planId, name: "Monthly", totalCycles: 12, firstCycleDiscount: { type: "percentage", value: 20 } });

    const updated = await call("subscription_pricing_set", { planId, plan: { ...PLAN, name: "Monthly v2", totalCycles: 6 } });
    expect(updated.body.data["created"]).toBe(false);
    expect((await call("subscription_pricing_get", { planId })).body.data).toMatchObject({ name: "Monthly v2", totalCycles: 6 });

    expect((await call("subscription_pricing_delete", { planId })).res.isError).toBeFalsy();
    expect((await call("subscription_pricing_list", {})).body.data["plans"]).toEqual([]);
    const audited = await db.select().from(auditLogs).where(eq(auditLogs.shopId, shopId));
    expect(audited.map((r) => r.action)).toEqual(expect.arrayContaining(["subscription_plan_created", "subscription_plan_updated", "subscription_plan_deleted"]));
  });

  it("dryRun previews without creating; invalid plans and foreign plans are refused", async () => {
    const dry = await call("subscription_pricing_set", { plan: PLAN, dryRun: true });
    expect(dry.body.meta?.dryRun).toBe(true);
    expect(store.plans.size).toBe(0);

    const bad = await call("subscription_pricing_set", { plan: { ...PLAN, productIds: ["not-a-gid"] } });
    expect(bad.res.isError).toBe(true);
    expect(bad.body.code).toBe("VALIDATION");

    store.plans.set("gid://shopify/SellingPlanGroup/999", { id: "gid://shopify/SellingPlanGroup/999", owned: false });
    const foreign = await call("subscription_pricing_delete", { planId: "gid://shopify/SellingPlanGroup/999" });
    expect(foreign.res.isError).toBe(true);
    expect(store.plans.has("gid://shopify/SellingPlanGroup/999")).toBe(true);
  });

  it("subscription_offer_create cycle-pricing creates a plan; skio-shipping adds a tier and refuses a duplicate id", async () => {
    expect((await call("subscription_offer_create", { template: "cycle-pricing", plan: PLAN })).res.isError).toBeFalsy();
    expect(store.plans.size).toBe(1);
    expect((await call("subscription_offer_create", { template: "cycle-pricing" })).res.isError).toBe(true);

    expect((await call("subscription_offer_create", { template: "skio-shipping", tier: TIER })).res.isError).toBeFalsy();
    const again = await call("subscription_offer_create", { template: "skio-shipping", tier: TIER });
    expect(again.res.isError).toBe(true);
    expect(again.body.message).toMatch(/already exists/);
    expect((store.tiers as { tiers: unknown[] }).tiers).toHaveLength(1);
  });
});

describe("skio shipping", () => {
  it("connect stores the key encrypted and never echoes it (result, status, call log, audit)", async () => {
    const dry = await call("skio_shipping_connect", { apiKey: SECRET, dryRun: true });
    expect(JSON.stringify(dry.res)).not.toContain(SECRET);
    expect(await db.select().from(appSettings).where(eq(appSettings.key, SKIO_API_KEY_SETTING))).toHaveLength(0);

    const connected = await call("skio_shipping_connect", { apiKey: SECRET });
    expect(connected.res.isError, JSON.stringify(connected.body)).toBeFalsy();
    expect(JSON.stringify(connected.res)).not.toContain(SECRET);

    const status = await call("skio_shipping_status", {});
    expect(status.body.data["apiKeyConnected"]).toBe(true);
    expect(JSON.stringify(status.res)).not.toContain(SECRET);

    const [stored] = await db.select().from(appSettings).where(eq(appSettings.key, SKIO_API_KEY_SETTING));
    expect(stored!.value).toBe(`enc:${SECRET}`);
    expect(JSON.stringify(await db.select().from(mcpCallLog))).not.toContain(SECRET);
    expect(JSON.stringify(await db.select().from(auditLogs))).not.toContain(SECRET);

    const rejected = await call("skio_shipping_connect", { apiKey: "nope" });
    expect(rejected.res.isError).toBe(true);
    expect(rejected.body.message).toContain("Skio rejected the API key.");
  });

  it("tier set/delete, sync needs a connection, then syncs and counts; disconnect removes the key", async () => {
    await call("skio_shipping_tier_set", { tier: TIER });
    expect((store.tiers as { tiers: { id: string }[] }).tiers.map((t) => t.id)).toEqual(["free-first"]);
    expect((await call("skio_shipping_status", {})).body.data["tiers"]).toHaveLength(1);

    await call("skio_shipping_disconnect", {});
    const noKey = await call("skio_shipping_sync", {});
    expect(noKey.res.isError).toBe(true);
    expect(noKey.body.message).toContain("Connect Skio before running a sync.");

    await call("skio_shipping_connect", { apiKey: SECRET });
    const synced = await call("skio_shipping_sync", {});
    expect(synced.body.data).toMatchObject({ evaluated: 2, updated: 1 });
    expect(store.skioKey).toBe(SECRET);
    expect(JSON.stringify(synced.res)).not.toContain(SECRET);

    await call("skio_shipping_tier_delete", { tierId: "free-first" });
    expect((store.tiers as { tiers: unknown[] }).tiers).toHaveLength(0);

    await call("skio_shipping_disconnect", {});
    expect((await call("skio_shipping_status", {})).body.data["apiKeyConnected"]).toBe(false);
  });
});
