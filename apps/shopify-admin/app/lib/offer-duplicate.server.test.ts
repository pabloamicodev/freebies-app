import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bundleDefinitions, bundleSteps, offerConditions, offerRewards, offers, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import { duplicateOffer } from "./offer-duplicate.server.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

async function seedFull(shopId: string) {
  const id = await seedOffer(db, shopId, { internalName: "src", functionMetafieldGid: "gid://shopify/Metafield/1", codeDiscountId: "gid://shopify/DiscountCodeNode/1" });
  await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "cart_total", operator: "gte", value: { amount: 10 } });
  await db.insert(offerRewards).values({ shopId, offerId: id, rewardType: "order_discount", discountType: "percentage", value: { percent: 10 }, target: {} });
  const [bundle] = await db.insert(bundleDefinitions).values({ shopId, offerId: id, bundleType: "classic", title: "b", bundleProductGid: "gid://shopify/Product/9" }).returning({ id: bundleDefinitions.id });
  await db.insert(bundleSteps).values({ shopId, bundleId: bundle!.id, title: "s", sourceType: "products", sourceConfig: {} });
  return id;
}

describe("duplicateOffer", () => {
  it("into another shop: children follow the target shop and shop-scoped GIDs are nulled", async () => {
    const source = await seedShop(db, "dup-src.myshopify.com");
    const target = await seedShop(db, "dup-dst.myshopify.com");
    const id = await seedFull(source);
    const newId = await duplicateOffer(db, source, id, { targetShopId: target });
    expect(newId).toBeTruthy();
    const [copy] = await db.select().from(offers).where(eq(offers.id, newId!));
    expect(copy).toMatchObject({ shopId: target, status: "draft", functionMetafieldGid: null, codeDiscountId: null });
    for (const table of [offerConditions, offerRewards]) {
      const rows = await db.select().from(table).where(eq(table.offerId, newId!));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.shopId).toBe(target);
    }
    const [bundle] = await db.select().from(bundleDefinitions).where(eq(bundleDefinitions.offerId, newId!));
    expect(bundle).toMatchObject({ shopId: target, bundleProductGid: null });
    const steps = await db.select().from(bundleSteps).where(eq(bundleSteps.bundleId, bundle!.id));
    expect(steps.map((s) => s.shopId)).toEqual([target]);
    const [original] = await db.select().from(offers).where(eq(offers.id, id));
    expect(original!.functionMetafieldGid).toBe("gid://shopify/Metafield/1");
  });

  it("same shop keeps the shop and stays a draft copy", async () => {
    const shop = await seedShop(db, "dup-same.myshopify.com");
    const id = await seedFull(shop);
    const newId = await duplicateOffer(db, shop, id);
    const [copy] = await db.select().from(offers).where(eq(offers.id, newId!));
    expect(copy).toMatchObject({ shopId: shop, internalName: "src-copy", status: "draft", codeDiscountId: null });
  });
});
