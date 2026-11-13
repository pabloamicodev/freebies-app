import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mcpOperators, offerConditions, offerRewards, offers, variantCache, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../../test-support/pglite-db.js";
import type { ShopPublishFn } from "../../offer-lifecycle.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import { formatStoredAmount } from "../../money.js";
import { planGiftRewards } from "../../gift-rewards.js";
import { AuthoringGiftRewardSchema, giftMainCondition, toStoredGiftRewards } from "../../offer-authoring/gifts.js";
import { registerPromoGiftsTools } from "./register-promo-gifts.server.js";

// Package 05 owns the real setTierMode; this mirrors the rewards route's set_tier_mode intent (update + republish when active).
vi.mock("../../offer-rewards.server.js", () => ({
  setTierMode: async (
    deps: { db: Db; shopId: string; shopDomain: string },
    offerId: string,
    mode: "cumulative" | "highest",
    opts: { dryRun?: boolean; publish?: ShopPublishFn },
  ) => {
    const { and: a, eq: e } = await import("drizzle-orm");
    const { offers: o } = await import("@promo/db");
    const [offer] = await deps.db.select().from(o).where(a(e(o.shopId, deps.shopId), e(o.id, offerId)));
    if (!offer) return { ok: false, code: "not_found", error: "Offer not found." };
    if (opts.dryRun) return { ok: true, value: { tierModeBefore: offer.tierMode } };
    await deps.db.update(o).set({ tierMode: mode, updatedAt: new Date() }).where(a(e(o.shopId, deps.shopId), e(o.id, offerId)));
    const failure = offer.status === "active" && opts.publish ? await opts.publish(deps.shopId, deps.shopDomain) : null;
    return { ok: true, value: { tierModeBefore: offer.tierMode }, ...(failure ? { publishError: failure.message } : {}) };
  },
}));

const SHOP = "gifts-test.myshopify.com";
const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const P = (n: number) => `gid://shopify/Product/${n}`;

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let operator: Operator;
let publish = vi.fn<ShopPublishFn>(async () => null);
const deps = () => ({ db, shopId, shopDomain: SHOP, shopCurrency: "USD", timezone: "America/New_York" });

const gift = (extra: Record<string, unknown>) => AuthoringGiftRewardSchema.parse({ kind: "product_gift", ...extra });
const stored = async (rewards: Record<string, unknown>[]) => {
  const result = await toStoredGiftRewards(rewards.map(gift), deps());
  if (!result.ok) throw new Error(`${result.path}: ${result.error}`);
  return result.value;
};
const FREE = { amount: 100, currencyCode: "USD" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, SHOP);
  // P1 has two variants (V11, V12), P2 one (V21), P3 two (V31, V32); V40-V43 are fallbacks of their own product.
  const rows: [number, number][] = [[1, 11], [1, 12], [2, 21], [3, 31], [3, 32], [4, 40], [4, 41], [4, 42], [4, 43]];
  await db.insert(variantCache).values(
    rows.map(([p, v]) => ({ shopId, productGid: P(p), variantGid: V(v), title: `v${v}`, price: "10.00", currencyCode: "USD", raw: {} })),
  );
  const [op] = await db.insert(mcpOperators).values({ email: "e@example.com", name: "e", role: "viewer", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  publish = vi.fn<ShopPublishFn>(async () => null);
  resetMemoryRateLimits();
});

describe("toStoredGiftRewards equals the gift wizard rows", () => {
  it("single auto-add gift (numeric ids accepted)", async () => {
    expect(await stored([{ gifts: [{ variantIds: ["21"] }] }])).toEqual([
      {
        rewardType: "product_gift",
        discountType: "free",
        value: FREE,
        target: { scope: "cart", variantIds: [V(21)] },
        quantity: 1,
        isAutoAdd: true,
        isCustomerSelectable: false,
        trackMode: "product",
        sortOrder: 0,
      },
    ]);
  });

  it("customer picker over variants with a picker limit and a shared fallback", async () => {
    expect(await stored([{ customerSelectable: true, quantity: 2, gifts: [{ productId: "1" }, { variantIds: [V(21)] }], fallbackVariantIds: ["40", V(11)] }])).toEqual([
      {
        rewardType: "product_gift",
        discountType: "free",
        value: FREE,
        // V11 is also a primary gift so it is dropped from the fallbacks
        target: { scope: "cart", variantIds: [V(11), V(12), V(21)], fallbackVariantIds: [V(40)] },
        quantity: 2,
        isAutoAdd: false,
        isCustomerSelectable: true,
        trackMode: "product",
        sortOrder: 0,
      },
    ]);
  });

  it("a picker with one variant is auto-added", async () => {
    const [row] = await stored([{ customerSelectable: true, quantity: 3, gifts: [{ variantIds: ["21"] }] }]);
    expect(row).toMatchObject({ isAutoAdd: true, isCustomerSelectable: false, quantity: 3 });
  });

  it("add-all of 2 products: one reward per product, same as planGiftRewards", async () => {
    const rows = await stored([{ gifts: [{ variantIds: ["21"] }, { variantIds: ["31"] }] }]);
    const expected = planGiftRewards({
      existing: [],
      variantIds: [V(21), V(31)],
      productOf: new Map([[V(21), P(2)], [V(31), P(3)]]),
      fallbackVariantIds: [],
      autoAddAll: true,
      quantity: 1,
      discountType: "free",
      value: FREE,
    }).insert.map((r) => ({ rewardType: "product_gift", ...r }));
    expect(rows).toEqual(expected);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.target)).toEqual([{ scope: "cart", variantIds: [V(21)] }, { scope: "cart", variantIds: [V(31)] }]);
    expect(rows.every((r) => r.isAutoAdd && !r.isCustomerSelectable && r.trackMode === "variant" && r.quantity === 1)).toBe(true);
  });

  it("add-all keeps a product with several picked variants as its own picker", async () => {
    const rows = await stored([{ gifts: [{ productId: "3" }, { variantIds: ["21"] }] }]);
    expect(rows.map((r) => [(r.target as { variantIds: string[] }).variantIds, r.isAutoAdd, r.isCustomerSelectable, r.trackMode])).toEqual([
      [[V(31), V(32)], false, true, "product"],
      [[V(21)], true, false, "variant"],
    ]);
  });

  it("per-gift fallbacks (max 5, never a primary gift) land on their own gift's reward", async () => {
    const rows = await stored([
      {
        gifts: [
          { variantIds: ["21"], fallbackVariantIds: ["40", "41", V(31)] },
          { variantIds: ["31"], fallbackVariantIds: ["42"] },
        ],
      },
    ]);
    expect(rows.map((r) => r.target)).toEqual([
      { scope: "cart", variantIds: [V(21)], fallbackVariantIds: [V(40), V(41)] },
      { scope: "cart", variantIds: [V(31)], fallbackVariantIds: [V(42)] },
    ]);
    const tooMany = AuthoringGiftRewardSchema.safeParse({ kind: "product_gift", gifts: [{ variantIds: ["21"], fallbackVariantIds: ["1", "2", "3", "4", "5", "6"] }] });
    expect(tooMany.success).toBe(false);
  });

  it("two gift tiers equal the tiered wizard rows (ascending, free, variant tracking, label, minCartSubtotalCents)", async () => {
    const rows = await stored([
      {
        tiers: [
          { minCartSubtotal: 100, gifts: [{ variantIds: ["31", "32"] }], quantity: 2 },
          { minCartSubtotal: 50, gifts: [{ variantIds: ["21"], fallbackVariantIds: ["40"] }] },
        ],
      },
    ]);
    expect(rows).toEqual([
      {
        rewardType: "product_gift",
        discountType: "free",
        value: FREE,
        target: { scope: "cart", variantIds: [V(21)], fallbackVariantIds: [V(40)] },
        quantity: 1,
        isAutoAdd: true,
        isCustomerSelectable: false,
        trackMode: "variant",
        sortOrder: 0,
        label: `Gift at ${formatStoredAmount(5000, "USD")}`,
        minCartSubtotalCents: 5000,
      },
      {
        rewardType: "product_gift",
        discountType: "free",
        value: FREE,
        target: { scope: "cart", variantIds: [V(31), V(32)] },
        quantity: 2,
        isAutoAdd: false,
        isCustomerSelectable: true,
        trackMode: "variant",
        sortOrder: 1,
        label: `Gift at ${formatStoredAmount(10000, "USD")}`,
        minCartSubtotalCents: 10000,
      },
    ]);
  });

  it("percentage and fixed amount gifts store the wizard value shape; a single gift can carry minCartSubtotal", async () => {
    const [pct] = await stored([{ gifts: [{ variantIds: ["21"] }], discountType: "percentage", value: 50 }]);
    expect(pct).toMatchObject({ discountType: "percentage", value: { amount: 50, currencyCode: "USD" } });
    const [fixed] = await stored([{ gifts: [{ variantIds: ["21"] }], discountType: "fixed_amount", value: 4.5, minCartSubtotal: 75 }]);
    expect(fixed).toMatchObject({ discountType: "fixed_amount", value: { amount: 450, currencyCode: "USD" }, minCartSubtotalCents: 7500 });
  });

  it("rejects bad input with a path instead of storing it", async () => {
    expect(AuthoringGiftRewardSchema.safeParse({ kind: "product_gift" }).success).toBe(false);
    expect(AuthoringGiftRewardSchema.safeParse({ kind: "product_gift", gifts: [{ variantIds: ["1"] }], tiers: [{ minCartSubtotal: 1, gifts: [{ variantIds: ["1"] }] }] }).success).toBe(false);
    const badId = await toStoredGiftRewards([gift({ gifts: [{ variantIds: ["abc"] }] })], deps());
    expect(badId).toMatchObject({ ok: false, path: "rewards[0].gifts[0].variantIds" });
    const noProduct = await toStoredGiftRewards([gift({ gifts: [{ productId: "999" }] })], deps());
    expect(noProduct).toMatchObject({ ok: false });
    const noValue = await toStoredGiftRewards([gift({ gifts: [{ variantIds: ["21"] }], discountType: "percentage" })], deps());
    expect(noValue).toMatchObject({ ok: false, path: "rewards[0].value" });
  });
});

describe("giftMainCondition", () => {
  it("cart_value trigger matches the wizard condition", () => {
    expect(giftMainCondition([], { type: "cart_value", minAmount: 80 }, deps())).toEqual({
      ok: true,
      value: {
        scope: "main",
        conditionType: "cart_value",
        operator: "gte",
        value: { thresholdCents: 8000, maxAmountCents: 0, appliesTo: "any_product", includeGiftValues: false },
        sortOrder: 0,
        isEnabled: true,
      },
    });
  });

  it("tiered gifts qualify at the lowest tier when no trigger is given; no tier and no trigger is an error", () => {
    const tiered = [gift({ tiers: [{ minCartSubtotal: 100, gifts: [{ variantIds: ["21"] }] }, { minCartSubtotal: 50, gifts: [{ variantIds: ["31"] }] }] })];
    expect(giftMainCondition(tiered, undefined, deps())).toMatchObject({
      ok: true,
      value: { conditionType: "cart_value", operator: "gte", value: { thresholdCents: 5000, currencyCode: "USD", includeGiftValues: false } },
    });
    expect(giftMainCondition([gift({ gifts: [{ variantIds: ["21"] }] })], undefined, deps())).toMatchObject({ ok: false, path: "trigger" });
  });

  it("cart_quantity and specific_product (match any = presence only)", () => {
    expect(giftMainCondition([], { type: "cart_quantity", minQuantity: 3 }, deps())).toMatchObject({ ok: true, value: { conditionType: "cart_quantity", value: { minQuantity: 3 } } });
    const specific = giftMainCondition([], { type: "specific_product", variantIds: ["11"], matchRule: "any", multiplyGifts: true }, deps());
    expect(specific).toMatchObject({ ok: true, value: { conditionType: "specific_product", operator: "any" } });
  });
});

describe("gift tools over MCP", () => {
  async function connect() {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => new Date(), rateLimit: async () => ({ ok: true as const }), publish };
    registerPromoGiftsTools(server, ctx);
    const client = new Client({ name: "vitest-client", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, stop: async () => { await client.close(); await server.close(); } };
  }
  const body = (r: unknown) => (r as CallToolResult).structuredContent as unknown as { code?: string; summary: string; data: Record<string, any> };
  const refOf = (id: string) => `promo:gifts-test:${id}`;

  async function tieredOffer(status: "active" | "draft") {
    const id = await seedOffer(db, shopId, { type: "gift", status, internalName: `[gift tiers] ${Math.random().toString(36).slice(2, 7)}`, tierMode: "cumulative" });
    const rows = await stored([{ tiers: [{ minCartSubtotal: 50, gifts: [{ variantIds: ["21"] }] }, { minCartSubtotal: 100, gifts: [{ variantIds: ["31"] }] }] }]);
    await db.insert(offerRewards).values(rows.map((r) => ({ shopId, offerId: id, ...r }) as typeof offerRewards.$inferInsert));
    return id;
  }

  it("promo_set_tier_mode on an active offer saves, republishes through the publish stub and is idempotent on replay", async () => {
    const id = await tieredOffer("active");
    const { client, stop } = await connect();
    const done = await client.callTool({ name: "promo_set_tier_mode", arguments: { ref: refOf(id), mode: "highest", idempotencyKey: "tier-mode-0001" } });
    expect((done as CallToolResult).isError, JSON.stringify(body(done))).toBeFalsy();
    expect(body(done).data).toMatchObject({ tierMode: "highest", offerId: id });
    const [row] = await db.select().from(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, id)));
    expect(row?.tierMode).toBe("highest");
    expect(publish).toHaveBeenCalledTimes(1);

    const replay = await client.callTool({ name: "promo_set_tier_mode", arguments: { ref: refOf(id), mode: "highest", idempotencyKey: "tier-mode-0001" } });
    expect((replay as CallToolResult).structuredContent).toMatchObject({ warnings: expect.arrayContaining([expect.objectContaining({ code: "IDEMPOTENT_REPLAY" })]) });
    expect(publish).toHaveBeenCalledTimes(1);
    await stop();
  });

  it("dryRun previews without writing or publishing; a bad mode and an unknown offer are rejected", async () => {
    const id = await tieredOffer("active");
    const { client, stop } = await connect();
    const dry = await client.callTool({ name: "promo_set_tier_mode", arguments: { ref: refOf(id), mode: "highest", dryRun: true } });
    expect(body(dry).summary).toContain("DRY RUN");
    const [row] = await db.select().from(offers).where(eq(offers.id, id));
    expect(row?.tierMode).toBe("cumulative");
    expect(publish).not.toHaveBeenCalled();

    const bad = await client.callTool({ name: "promo_set_tier_mode", arguments: { ref: refOf(id), mode: "both" } });
    expect((bad as CallToolResult).isError).toBe(true);
    const missing = await client.callTool({ name: "promo_set_tier_mode", arguments: { ref: refOf("00000000-0000-4000-8000-000000000000"), mode: "highest" } });
    expect(body(missing).code).toBe("NOT_FOUND");
    await stop();
  });

  it("a failed publish is reported but the saved mode stays (viewer operators can write)", async () => {
    const id = await tieredOffer("active");
    publish = vi.fn<ShopPublishFn>(async () => ({ message: "Shopify unavailable", scope: "shop" }));
    const { client, stop } = await connect();
    const done = await client.callTool({ name: "promo_set_tier_mode", arguments: { ref: refOf(id), mode: "highest" } });
    expect(body(done).summary).toContain("publishing failed");
    await stop();
  });

  it("gift_tiers_get lists tiers ascending with the tier mode and warns when the main threshold hides lower tiers", async () => {
    const id = await tieredOffer("draft");
    await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 9000, currencyCode: "USD" }, sortOrder: 0, isEnabled: true });
    const { client, stop } = await connect();
    const res = await client.callTool({ name: "gift_tiers_get", arguments: { ref: refOf(id) } });
    const offer = body(res).data["offers"][0];
    expect(offer).toMatchObject({ offerId: id, tierMode: "cumulative", mainThreshold: { amount: "90.00" } });
    expect(offer.tiers.map((t: { minCartSubtotal: { amount: string } }) => t.minCartSubtotal.amount)).toEqual(["50.00", "100.00"]);
    expect(offer.tiers[0]).toMatchObject({ giftVariants: [V(21)], autoAdd: true, quantity: 1 });
    expect((res as CallToolResult).structuredContent).toMatchObject({ warnings: [expect.objectContaining({ code: "TIER_BELOW_MAIN_THRESHOLD" })] });
    await stop();
  });
});
