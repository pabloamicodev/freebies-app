import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
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
});
