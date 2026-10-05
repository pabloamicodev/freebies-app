import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discountCodes, offerConditions, offerRewards, type Db } from "@promo/db";
import { estimateSharedConfigBytes } from "./shared-config-size.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, "size.myshopify.com");
}, 60_000);
afterAll(async () => {
  await close();
});

async function giftOffer(overrides: Parameters<typeof seedOffer>[2] = {}) {
  const offerId = await seedOffer(db, shopId, overrides);
  await db.insert(offerConditions).values({
    shopId, offerId, scope: "main", conditionType: "cart_value", operator: "gte",
    value: { thresholdCents: 1000, currencyCode: "USD" }, sortOrder: 0, isEnabled: true,
  });
  await db.insert(offerRewards).values({
    shopId, offerId, rewardType: "product_gift", discountType: "free", value: {},
    target: { variantIds: ["gid://shopify/ProductVariant/1"] }, quantity: 1, sortOrder: 0,
  });
  return offerId;
}

describe("estimateSharedConfigBytes", () => {
  it("counts active non-code offers, excludes checkout-code ones, and adds the offer about to switch", async () => {
    const empty = await estimateSharedConfigBytes(db, shopId, "USD", []);
    await giftOffer();
    const withRegular = await estimateSharedConfigBytes(db, shopId, "USD", []);
    expect(withRegular).toBeGreaterThan(empty);

    const coded = await giftOffer({ requiresCode: true });
    await db.insert(discountCodes).values({ shopId, offerId: coded, code: "SIZE-1" });
    expect(await estimateSharedConfigBytes(db, shopId, "USD", [])).toBe(withRegular);
    expect(await estimateSharedConfigBytes(db, shopId, "USD", [coded])).toBeGreaterThan(withRegular);
  });

  it("ignores an automatic offer's code rows: it is always in the shared config", async () => {
    const before = await estimateSharedConfigBytes(db, shopId, "USD", []);
    const auto = await giftOffer({ requiresCode: true, codeRedemption: "automatic" });
    await db.insert(discountCodes).values({ shopId, offerId: auto, code: "SIZE-AUTO" });
    expect(await estimateSharedConfigBytes(db, shopId, "USD", [])).toBeGreaterThan(before);
  });
});
