import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discountShards, offerCombinationPolicies, offerRewards, offers, type Db } from "@promo/db";
import { eq } from "drizzle-orm";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import { loadCombinationGroups } from "./capacity-meter.server.js";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("loadCombinationGroups", () => {
  it("is null when every active automatic offer combines", async () => {
    const shopId = await seedShop(db, "combo-none.myshopify.com");
    await seedOffer(db, shopId, { codeRedemption: "automatic", internalName: "plain" });
    expect(await loadCombinationGroups(db, shopId)).toBeNull();
  });

  it("names the offers that don't combine, the node count and the offers stuck with them", async () => {
    const shopId = await seedShop(db, "combo-split.myshopify.com");
    const make = (name: string, priority: number) => seedOffer(db, shopId, { codeRedemption: "automatic", internalName: name, priority });
    const [closed, order, free, paused] = [await make("closed", 100), await make("order", 110), await make("free", 120), await make("paused", 130)];
    await db.update(offers).set({ status: "paused" }).where(eq(offers.id, paused));
    await db.insert(offerCombinationPolicies).values([
      { shopId, offerId: closed, combinesWithProductDiscounts: false },
      { shopId, offerId: paused, combinesWithProductDiscounts: false },
    ]);
    await db.insert(offerRewards).values({
      shopId,
      offerId: order,
      rewardType: "order_discount",
      discountType: "percentage",
      value: { amount: 5, currencyCode: "USD" },
      target: { scope: "cart" },
    });
    await db.insert(discountShards).values([
      { shopId, kind: "cart", slot: 0, unitKeys: [closed, order] },
      { shopId, kind: "cart", slot: 1, unitKeys: [`${free}#0`] },
    ]);

    const view = (await loadCombinationGroups(db, shopId))!;

    expect(view.nonCombining).toEqual([{ id: closed, name: "closed" }]);
    expect(view.nodes).toBe(2);
    expect(view.nonCombiningNodes).toBe(1);
    expect(view.combining).toBe(2);
    expect(view.forced).toEqual([{ id: order, name: "order", reason: "order_reward" }]);
  });
});
