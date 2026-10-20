import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { offerCombinationPolicies, offerConditions, offerRewards, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import { validateOffersPublishable } from "./offer-publish-flow.server.js";
import { setLimitsEnforced } from "./limits-enforced.server.js";

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
  it("while limits are not enforced, a colliding title does not block publishing", async () => {
    await publishable("Flag Off Title", "flag off twin", null);
    const id = await publishable("Flag Off Title", "flag off limited", 1);
    expect(await validateOffersPublishable(db, shopId, [id])).toEqual({ ok: true });
  });

  it("with limits enforced, blocks a limited automatic offer whose title collides", async () => {
    await setLimitsEnforced(db, shopId, true);
    await publishable("Same Title", "unlimited twin", null);
    const id = await publishable("Same Title", "limited one", 1);
    const res = await validateOffersPublishable(db, shopId, [id]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unique customer-facing title/);
    await setLimitsEnforced(db, shopId, false);
  });

  it("with limits enforced, a one_use_per_customer offer needs a unique title too", async () => {
    await setLimitsEnforced(db, shopId, true);
    await publishable("One Use Dup", "one use twin", null);
    const id = await publishable("One Use Dup", "one use limited", null);
    await db.insert(offerConditions).values({
      shopId, offerId: id, scope: "sub", conditionType: "one_use_per_customer", operator: "eq",
      value: {}, sortOrder: 1, isEnabled: true,
    });
    const res = await validateOffersPublishable(db, shopId, [id]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unique customer-facing title/);
    await setLimitsEnforced(db, shopId, false);
  });

  it("allows a limited offer with a unique title and an unlimited offer with a colliding one", async () => {
    await setLimitsEnforced(db, shopId, true);
    const unique = await publishable("Unique Title", "limited unique", 2);
    const u = await validateOffersPublishable(db, shopId, [unique]);
    expect(u).toEqual({ ok: true });
    const twin = await publishable("Unique Title", "unlimited dup", null);
    expect((await validateOffersPublishable(db, shopId, [twin])).ok).toBe(true);
    await setLimitsEnforced(db, shopId, false);
  });
});

describe("one_use_per_customer follows the limits.enforced flag", () => {
  it("is rejected while the flag is off and accepted once it is on", async () => {
    const id = await publishable("One Use Title", "one use offer", null);
    await db.insert(offerConditions).values({
      shopId, offerId: id, scope: "sub", conditionType: "one_use_per_customer", operator: "eq",
      value: {}, sortOrder: 1, isEnabled: true,
    });
    const off = await validateOffersPublishable(db, shopId, [id]);
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.error).toMatch(/one_use_per_customer is not enforced by Shopify Functions/);
    await setLimitsEnforced(db, shopId, true);
    expect(await validateOffersPublishable(db, shopId, [id])).toEqual({ ok: true });
    await setLimitsEnforced(db, shopId, false);
  });
});
