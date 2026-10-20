import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { offerCombinationPolicies, offerConditions, offerRewards, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import { validateOffersPublishable } from "./offer-publish-flow.server.js";

let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, "limits-publish.myshopify.com");
}, 60_000);
afterAll(async () => {
  await close();
});

async function publishable(title: string, internalName: string, limit: number | null) {
  const id = await seedOffer(db, shopId, { publicTitle: title, internalName });
  await db.insert(offerConditions).values({
    shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte",
    value: { thresholdCents: 100 }, sortOrder: 0, isEnabled: true,
  });
  await db.insert(offerRewards).values({
    shopId, offerId: id, rewardType: "order_discount", discountType: "percentage", value: { amount: 10, currencyCode: "USD" }, target: { scope: "cart" },
  });
  if (limit) await db.insert(offerCombinationPolicies).values({ shopId, offerId: id, maxApplicationsPerCustomer: limit });
  return id;
}

describe("publish validation of per-customer limits (DL4)", () => {
  it("blocks a limited automatic offer whose title collides", async () => {
    await publishable("Same Title", "unlimited twin", null);
    const id = await publishable("Same Title", "limited one", 1);
    const res = await validateOffersPublishable(db, shopId, [id]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unique customer-facing title/);
  });

  it("allows a limited offer with a unique title and an unlimited offer with a colliding one", async () => {
    const unique = await publishable("Unique Title", "limited unique", 2);
    const u = await validateOffersPublishable(db, shopId, [unique]);
    expect(u).toEqual({ ok: true });
    const twin = await publishable("Unique Title", "unlimited dup", null);
    expect((await validateOffersPublishable(db, shopId, [twin])).ok).toBe(true);
  });
});
