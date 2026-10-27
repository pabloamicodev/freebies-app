import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  bundleDefinitions,
  bundleSteps,
  bundleTiers,
  discountCodes,
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  productCache,
  variantCache,
  type Db,
} from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "" }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: "gift-shop.myshopify.com" },
  }),
}));
vi.mock("../shopify.server.js", () => ({
  authenticate: { admin: async () => ({ session: { shop: "gift-shop.myshopify.com" } }) },
}));
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => ctx.db,
}));
vi.mock("./offer-publish-flow.server.js", () => ({
  publishShopConfig: async () => null,
  republishIfActive: async () => null,
  finalizeCreatedOffer: async () => null,
  validateOffersPublishable: async () => ({ ok: true }),
  validateActivation: async () => ({ ok: true }),
}));
vi.mock("./gift-tier-campaigns.server.js", () => ({ createGiftTierCampaignOffers: async () => ({ error: "unused" }) }));
vi.mock("./audit-log.server.js", () => ({ insertAuditLog: async () => undefined }));

const wizard = await import("../routes/app.offers.new.gift.$template.js");
const rewardsRoute = await import("../routes/app.offers.$id.rewards.js");
const list = await import("../routes/app.offers._index.js");
const offerPage = await import("../routes/app.offers.$id._index.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;

const PRODUCT = "gid://shopify/Product/9000000000001";
const VARIANTS = [42872167202901, 42872167235669, 42872167268437, 42872167301205].map(
  (n) => `gid://shopify/ProductVariant/${n}`,
);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  shopId = await seedShop(db, "gift-shop.myshopify.com");
  ctx.shopId = shopId;
  await db.insert(productCache).values({
    shopId, productGid: PRODUCT, handle: "ambrosia-tee", title: "Ambrosia T-Shirt", status: "ACTIVE", raw: {},
  });
  await db.insert(variantCache).values(
    VARIANTS.map((variantGid, i) => ({
      shopId, productGid: PRODUCT, variantGid, title: `Size ${i}`, price: "20.00", currencyCode: "USD",
      availableForSale: true, inventoryQuantity: 10, inventoryPolicy: "DENY", raw: {},
    })),
  );
}, 60_000);
afterAll(async () => {
  await close();
});

const post = (url: string, fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of [v].flat()) body.append(k, item);
  return new Request(`http://localhost${url}`, { method: "POST", body });
};
const run = (fn: unknown, request: Request, params: Record<string, string> = {}) =>
  (fn as (a: unknown) => Promise<unknown>)({ request, params, context: {} });

describe("free gift creation (cart subtotal >= $85, 4 variants, customer selectable, quoted title)", () => {
  it("gift wizard saves offer + condition + reward + policy for the production payload", async () => {
    const result = await run(
      wizard.action,
      post("/app/offers/new/gift/cart_value", {
        intent: "draft",
        internalName: "cart-subtotal-free-gift-shirt-wizard",
        publicTitle: 'FREE GIFT "Ambrosia" T-Shirt',
        conditionType: "cart_value",
        minAmount: "85",
        appliesTo: "any_product",
        discountType: "free",
        giftCount: "1",
        rewardProducts: JSON.stringify(VARIANTS),
        isAutoAdd: "false",
      }),
      { template: "cart_value" },
    );
    expect((result as { error?: string }).error).toBeUndefined();
    const [offer] = await db.select().from(offers).where(eq(offers.internalName, "cart-subtotal-free-gift-shirt-wizard"));
    expect(offer?.publicTitle).toBe('FREE GIFT "Ambrosia" T-Shirt');
    const rewards = await db.select().from(offerRewards).where(eq(offerRewards.offerId, offer!.id));
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.isCustomerSelectable).toBe(true);
    expect((rewards[0]!.target as { variantIds: string[] }).variantIds).toEqual(VARIANTS);
    const conditions = await db.select().from(offerConditions).where(eq(offerConditions.offerId, offer!.id));
    expect(conditions[0]!.value).toMatchObject({ thresholdCents: 8500 });
  });

  it("rewards page saves a customer-selectable gift from one multi-variant product", async () => {
    const id = await seedOffer(db, shopId, { status: "draft", internalName: "rewards-page-gift" });
    const result = await run(
      rewardsRoute.action,
      post(`/app/offers/${id}/rewards`, {
        intent: "add_reward",
        rewardType: "product_gift",
        discountType: "free",
        quantity: "1",
        variantGids: PRODUCT,
      }),
      { id },
    );
    expect((result as { error?: string } | null)?.error).toBeUndefined();
    const rewards = await db.select().from(offerRewards).where(eq(offerRewards.offerId, id));
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.isCustomerSelectable).toBe(true);
    expect((rewards[0]!.target as { variantIds: string[] }).variantIds).toEqual(VARIANTS);
  });

  it("rewards page accepts the preset's 4 variant GIDs when they are all variants of one cached product", async () => {
    const id = await seedOffer(db, shopId, { status: "draft", internalName: "rewards-page-gift-variants" });
    const result = await run(
      rewardsRoute.action,
      post(`/app/offers/${id}/rewards`, {
        intent: "add_reward",
        rewardType: "product_gift",
        discountType: "free",
        quantity: "1",
        variantGids: VARIANTS.join("\n"),
      }),
      { id },
    );
    expect((result as { error?: string } | null)?.error).toBeUndefined();
    const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, id));
    expect(reward!.isCustomerSelectable).toBe(true);
    expect((reward!.target as { variantIds: string[]; productId: string })).toMatchObject({ productId: PRODUCT, variantIds: VARIANTS });
  });

  it("rewards page saves a strict subset of variants as the customer-selectable pool", async () => {
    const id = await seedOffer(db, shopId, { status: "draft", internalName: "rewards-page-gift-subset" });
    await run(
      rewardsRoute.action,
      post(`/app/offers/${id}/rewards`, {
        intent: "add_reward", rewardType: "product_gift", discountType: "free", quantity: "1",
        variantGids: VARIANTS.slice(0, 2).join("\n"),
      }),
      { id },
    );
    const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, id));
    expect((reward!.target as { variantIds: string[] }).variantIds).toEqual(VARIANTS.slice(0, 2));
    expect(reward!.isCustomerSelectable).toBe(true);
  });

  it("rewards page keeps sold-out variants in the gift and drops subscription-only ones", async () => {
    const product = "gid://shopify/Product/9000000000002";
    const [inStock, soldOut, subscription] = [1, 2, 3].map((n) => `gid://shopify/ProductVariant/9100000000${n}`);
    await db.insert(productCache).values({
      shopId, productGid: product, handle: "sold-out-mix", title: "Sold out mix", status: "ACTIVE", raw: {},
    });
    await db.insert(variantCache).values([
      { variantGid: inStock!, availableForSale: true, requiresSellingPlan: false },
      { variantGid: soldOut!, availableForSale: false, requiresSellingPlan: false },
      { variantGid: subscription!, availableForSale: true, requiresSellingPlan: true },
    ].map((v, i) => ({
      shopId, productGid: product, title: `V${i}`, price: "5.00", currencyCode: "USD",
      inventoryQuantity: v.availableForSale ? 5 : 0, inventoryPolicy: "DENY", raw: {}, ...v,
    })));
    const id = await seedOffer(db, shopId, { status: "draft", internalName: "gift-sold-out-variants" });
    const result = await run(
      rewardsRoute.action,
      post(`/app/offers/${id}/rewards`, {
        intent: "add_reward", rewardType: "product_gift", discountType: "free", quantity: "1",
        variantGids: [inStock!, soldOut!, subscription!].join("\n"),
      }),
      { id },
    );
    expect((result as { error?: string } | null)?.error).toBeUndefined();
    const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, id));
    expect((reward!.target as { variantIds: string[] }).variantIds.slice().sort()).toEqual([inStock, soldOut]);
    expect(reward!.isCustomerSelectable).toBe(true);
    expect(reward!.isAutoAdd).toBe(false);

    const onlySoldOut = await seedOffer(db, shopId, { status: "draft", internalName: "gift-only-sold-out" });
    const single = await run(
      rewardsRoute.action,
      post(`/app/offers/${onlySoldOut}/rewards`, {
        intent: "add_reward", rewardType: "product_gift", discountType: "free", quantity: "1", variantGids: soldOut!,
      }),
      { id: onlySoldOut },
    );
    expect((single as { error?: string } | null)?.error).toBeUndefined();
    const [soloReward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, onlySoldOut));
    expect((soloReward!.target as { variantIds: string[] }).variantIds).toEqual([soldOut]);
  });

  it("rewards page rejects a gift whose product only has subscription variants", async () => {
    const product = "gid://shopify/Product/9000000000003";
    const variant = "gid://shopify/ProductVariant/92000000001";
    await db.insert(productCache).values({
      shopId, productGid: product, handle: "sub-only", title: "Sub only", status: "ACTIVE", raw: {},
    });
    await db.insert(variantCache).values({
      shopId, productGid: product, variantGid: variant, title: "Sub", price: "5.00", currencyCode: "USD",
      availableForSale: true, requiresSellingPlan: true, inventoryQuantity: 5, inventoryPolicy: "DENY", raw: {},
    });
    const id = await seedOffer(db, shopId, { status: "draft", internalName: "gift-sub-only" });
    const result = await run(
      rewardsRoute.action,
      post(`/app/offers/${id}/rewards`, {
        intent: "add_reward", rewardType: "product_gift", discountType: "free", quantity: "1", variantGids: variant,
      }),
      { id },
    );
    expect((result as { error?: string }).error).toMatch(/no one-time-purchase variants/);
  });

  it("rewards page rejects variants that are not in the catalog", async () => {
    const id = await seedOffer(db, shopId, { status: "draft", internalName: "rewards-page-gift-unknown" });
    const result = await run(
      rewardsRoute.action,
      post(`/app/offers/${id}/rewards`, {
        intent: "add_reward", rewardType: "product_gift", discountType: "free", quantity: "1",
        variantGids: "gid://shopify/ProductVariant/1",
      }),
      { id },
    );
    expect((result as { error?: string }).error).toMatch(/not found in the catalog/);
  });

  it("offer page creates the first reward when the offer has none", async () => {
    const id = await seedOffer(db, shopId, { status: "draft", internalName: "first-reward" });
    const result = await run(
      offerPage.action,
      post(`/app/offers/${id}`, {
        intent: "add_first_reward", rewardType: "product_gift", discountType: "free", discountValue: "100",
        quantity: "1", variantGids: VARIANTS.join("\n"),
      }),
      { id },
    );
    expect((result as { error?: string }).error).toBeUndefined();
    const rewards = await db.select().from(offerRewards).where(eq(offerRewards.offerId, id));
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.isCustomerSelectable).toBe(true);
    expect((rewards[0]!.target as { variantIds: string[] }).variantIds).toEqual(VARIANTS);

    const again = await run(
      offerPage.action,
      post(`/app/offers/${id}`, {
        intent: "add_first_reward", rewardType: "product_gift", discountType: "free", quantity: "1", variantGids: PRODUCT,
      }),
      { id },
    );
    expect((again as { error?: string }).error).toMatch(/already has a reward/);
  });

  it("publishing a gift offer without a reward says to add a gift reward", async () => {
    const id = await seedOffer(db, shopId, { status: "draft", internalName: "no-reward-publish" });
    await db.insert(offerConditions).values({
      shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte",
      value: { thresholdCents: 8500, appliesTo: "any_product" }, sortOrder: 0, isEnabled: true,
    });
    const result = await run(offerPage.action, post(`/app/offers/${id}`, { intent: "publish" }), { id });
    expect((result as { error?: string }).error).toBe("Cannot publish: Add a gift reward before publishing.");
  });

  it("duplicating a gift offer copies its conditions, rewards and combination policy", async () => {
    const source = await seedOffer(db, shopId, {
      status: "active",
      internalName: "dup-source",
      startsAt: new Date("2026-09-29T00:00:00Z"),
    });
    await db.insert(offerConditions).values({
      shopId, offerId: source, scope: "main", conditionType: "cart_value", operator: "gte",
      value: { thresholdCents: 8500, appliesTo: "any_product" }, sortOrder: 0, isEnabled: true,
    });
    await db.insert(offerRewards).values({
      shopId, offerId: source, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" },
      target: { scope: "cart", variantIds: VARIANTS }, quantity: 1, isAutoAdd: false, isCustomerSelectable: true,
      trackMode: "product", sortOrder: 0,
    });
    await db.insert(offerCombinationPolicies).values({
      shopId, offerId: source, combinesWithOrderDiscounts: true, combinesWithProductDiscounts: true,
      combinesWithShippingDiscounts: true, combinesWithOtherAppOffers: true, stopLowerPriority: false,
      giftValueCountsForOtherOffers: false,
    });

    const [bundle] = await db.insert(bundleDefinitions).values({
      shopId, offerId: source, bundleType: "classic", title: "B", bundleProductGid: "gid://shopify/Product/1",
    }).returning({ id: bundleDefinitions.id });
    await db.insert(bundleSteps).values({ shopId, bundleId: bundle!.id, title: "S", sourceType: "products", sourceConfig: {} });
    await db.insert(bundleTiers).values({ shopId, bundleId: bundle!.id, minQuantity: 2, label: "T", discountType: "percentage", value: { default: 10 } });
    await db.insert(discountCodes).values({ shopId, offerId: source, code: "DUP-SRC-1" } as typeof discountCodes.$inferInsert);

    await run(list.action, post("/app/offers", { intent: "duplicate", offerId: source }));

    const [copy] = await db.select().from(offers).where(eq(offers.internalName, "dup-source-copy"));
    expect(copy).toBeDefined();
    expect(copy!.status).toBe("draft");
    expect(copy!.requiresCode).toBe(true);
    expect(await db.select().from(discountCodes).where(eq(discountCodes.offerId, copy!.id))).toHaveLength(0);
    const [copyBundle] = await db.select().from(bundleDefinitions).where(eq(bundleDefinitions.offerId, copy!.id));
    expect(copyBundle?.bundleProductGid).toBeNull();
    expect(await db.select().from(bundleSteps).where(eq(bundleSteps.bundleId, copyBundle!.id))).toHaveLength(1);
    expect(await db.select().from(bundleTiers).where(eq(bundleTiers.bundleId, copyBundle!.id))).toHaveLength(1);
    expect(await db.select().from(offerConditions).where(eq(offerConditions.offerId, copy!.id))).toHaveLength(1);
    expect(await db.select().from(offerRewards).where(eq(offerRewards.offerId, copy!.id))).toHaveLength(1);
    expect(await db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, copy!.id))).toHaveLength(1);
  });
});
