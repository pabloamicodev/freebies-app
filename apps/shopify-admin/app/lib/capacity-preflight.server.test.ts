import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { discountCodes, offerCombinationPolicies, offerConditions, offerRewards, offers, type Db } from "@promo/db";
import { preflightCapacity, readPreviousAssignment, type CapacityOptions } from "./capacity-preflight.server.js";
import { setFunctionShardsEnabled } from "./function-shards-flag.server.js";
import { getLegacyStorePreset, insertPresetOffer } from "./legacy-store-presets.server.js";
import { shippingConfigTooLargeMessage } from "./capacity-copy.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const budget = (maxCartSlots: number, others = 3) => ({ storeActive: others + 2, ours: 2, others, maxCartSlots });
const withBudget = (maxCartSlots: number, others?: number): CapacityOptions => ({
  shardsEnabled: true,
  loadBudget: async () => budget(maxCartSlots, others),
});

let variantSeq = 0;
async function giftOffer(shopId: string, variants: number, overrides: Parameters<typeof seedOffer>[2] = {}) {
  const offerId = await seedOffer(db, shopId, overrides);
  await db.insert(offerConditions).values({
    shopId, offerId, scope: "main", conditionType: "cart_value", operator: "gte",
    value: { thresholdCents: 1000, currencyCode: "USD" }, sortOrder: 0, isEnabled: true,
  });
  await db.insert(offerRewards).values({
    shopId, offerId, rewardType: "product_gift", discountType: "free", value: {},
    target: { variantIds: Array.from({ length: variants }, () => `gid://shopify/ProductVariant/${++variantSeq}`) },
    quantity: 1, sortOrder: 0,
  });
  return offerId;
}

describe("Ambrosia preset plus 12 heavy offers", () => {
  let shopId: string;
  const heavyNames: string[] = [];

  beforeAll(async () => {
    shopId = await seedShop(db, "ambrosia-nutraceuticals.myshopify.com");
    const preset = getLegacyStorePreset("ambrosia-nutraceuticals.myshopify.com")!;
    for (const presetOffer of preset.offers) await db.transaction((tx) => insertPresetOffer(tx, shopId, presetOffer));
    await db.update(offers).set({ status: "active" }).where(eq(offers.shopId, shopId));
    for (let i = 0; i < 12; i++) {
      const name = `heavy-${String(i).padStart(2, "0")}`;
      heavyNames.push(name);
      await giftOffer(shopId, 60, { internalName: name, priority: 100 + i });
    }
  }, 120_000);

  it("fits across several slots with the flag on", async () => {
    const result = await preflightCapacity(db, shopId, [], withBudget(11));
    expect(result.ok ? null : JSON.stringify(result)).toBeNull();
    if (!result.ok) return;
    expect(result.plan.slots).toBeGreaterThan(1);
    expect(result.plan.maxSlots).toBe(11);
    expect(result.plan.bytesPerSlot).toHaveLength(result.plan.slots);
    expect(Math.max(...result.plan.bytesPerSlot)).toBeLessThanOrEqual(9500);
    expect(result.plan.budget).toEqual({ storeActive: 5, ours: 2, others: 3 });
  });

  it("is SLOT_FULL naming the offers that do not fit with the flag off", async () => {
    const result = await preflightCapacity(db, shopId, [], { shardsEnabled: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SLOT_FULL");
    expect(result.offerIds.length).toBeGreaterThan(0);
    expect(result.offerNames.length).toBe(result.offerIds.length);
    expect(result.offerNames.some((name) => heavyNames.includes(name))).toBe(true);
    expect(result.message).toContain("over the 9500B limit");
    for (const name of result.offerNames) expect(result.message).toContain(`"${name}"`);
    expect(result.numbers["neededBytes"]).toBeGreaterThan(9500);
  });

  it("reads the per-shop flag from app_settings when no override is given", async () => {
    expect((await preflightCapacity(db, shopId, [], { loadBudget: async () => budget(11) })).ok).toBe(false);
    await setFunctionShardsEnabled(db, shopId, true);
    expect((await preflightCapacity(db, shopId, [], { loadBudget: async () => budget(11) })).ok).toBe(true);
    await setFunctionShardsEnabled(db, shopId, false);
  });
});

describe("limits", () => {
  it("is AUTOMATIC_DISCOUNT_LIMIT with numbers when 23 other automatic discounts leave one slot", async () => {
    const shopId = await seedShop(db, "budget.myshopify.com");
    for (let i = 0; i < 6; i++) await giftOffer(shopId, 60, { internalName: `b-${i}`, priority: i });
    const result = await preflightCapacity(db, shopId, [], {
      shardsEnabled: true,
      loadBudget: async () => ({ storeActive: 25, ours: 2, others: 23, maxCartSlots: 1 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("AUTOMATIC_DISCOUNT_LIMIT");
    expect(result.numbers["allowed"]).toBe(1);
    expect(result.numbers["needed"]).toBeGreaterThan(0);
    expect(result.numbers["storeActive"]).toBe(25);
    expect(result.numbers["others"]).toBe(23);
    expect(result.message).toBe(
      `Shopify allows 25 active automatic discounts per store. Your store has 25 active and Promo Engine needs ${result.numbers["needed"]} more. Deactivate or delete some automatic discounts in Shopify, or pause offers, then publish again.`,
    );
    expect(result.offerIds.length).toBeGreaterThan(0);
  });

  it("is SLOT0_GROUP_TOO_LARGE when a top-priority stop offer drags a big tail into slot 0", async () => {
    const shopId = await seedShop(db, "stop.myshopify.com");
    const stop = await giftOffer(shopId, 5, { internalName: "stopper", priority: 0 });
    await db.insert(offerCombinationPolicies).values({ shopId, offerId: stop, stopLowerPriority: true });
    for (let i = 0; i < 8; i++) await giftOffer(shopId, 60, { internalName: `tail-${i}`, priority: 10 + i });
    const result = await preflightCapacity(db, shopId, [], withBudget(11));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SLOT0_GROUP_TOO_LARGE");
    expect(result.offerNames).toContain("stopper");
    expect(result.message).toContain("must share one Shopify discount and don't fit. Pause or simplify some of them.");
    expect(result.numbers["groupBytes"]).toBeGreaterThan(9500);
  });

  it("is OFFER_TOO_LARGE naming a single offer bigger than a slot", async () => {
    const shopId = await seedShop(db, "huge.myshopify.com");
    const huge = await giftOffer(shopId, 400, { internalName: "huge-offer" });
    const result = await preflightCapacity(db, shopId, [], withBudget(11));
    expect(result).toMatchObject({ ok: false, code: "OFFER_TOO_LARGE", offerIds: [huge], offerNames: ["huge-offer"], reason: "bytes" });
    if (!result.ok) expect(result.message).toContain('"huge-offer" is too large for one Shopify discount');
  });

  it("keeps the 100-tag limit only when sharding is on", async () => {
    const shopId = await seedShop(db, "tags.myshopify.com");
    const offerId = await giftOffer(shopId, 2, { internalName: "taggy" });
    await db.insert(offerConditions).values({
      shopId, offerId, scope: "main", conditionType: "customer_tags", operator: "any",
      value: { includeTags: Array.from({ length: 101 }, (_, i) => `tag-${i}`), excludeTags: [] }, sortOrder: 1, isEnabled: true,
    });
    expect((await preflightCapacity(db, shopId, [], { shardsEnabled: false })).ok).toBe(true);
    const on = await preflightCapacity(db, shopId, [], withBudget(11));
    expect(on).toMatchObject({ ok: false, code: "OFFER_TOO_LARGE", reason: "tags", offerNames: ["taggy"] });
    if (!on.ok) expect(on.message).toBe('"taggy" references 101 customer tags. Shopify allows up to 100 per discount.');
  });

  it("uses a separate message and no placeholder numbers when the automatic discount count is unknown", async () => {
    const shopId = await seedShop(db, "unknown-budget.myshopify.com");
    for (let i = 0; i < 8; i++) await giftOffer(shopId, 60, { internalName: `u-${i}`, priority: i });
    const result = await preflightCapacity(db, shopId, [], { shardsEnabled: true, loadBudget: async () => null });
    expect(result).toMatchObject({ ok: false, code: "AUTOMATIC_DISCOUNT_LIMIT" });
    if (result.ok) return;
    expect(result.message).toBe(
      "Promo Engine couldn't read how many automatic discounts your store has. Try again in a minute; Shopify allows 25 active automatic discounts per store.",
    );
    expect(result.numbers).not.toHaveProperty("storeActive");
    expect(result.numbers).not.toHaveProperty("others");
  });

  it("with sharding off reports a too-large offer as SLOT_FULL with today's wording", async () => {
    const shopId = await seedShop(db, "huge-off.myshopify.com");
    const huge = await giftOffer(shopId, 400, { internalName: "huge-off" });
    const result = await preflightCapacity(db, shopId, [], { shardsEnabled: false });
    expect(result).toMatchObject({ ok: false, code: "SLOT_FULL", offerIds: [huge], offerNames: ["huge-off"] });
    if (!result.ok) expect(result.message).toBe(`The shared automatic config would be ${result.numbers["neededBytes"]}B, over the 9500B limit. Pause or simplify other automatic offers first. Offers that don't fit: "huge-off".`);
  });

  it("forceInclude counts a code-gated offer about to switch to automatic", async () => {
    const shopId = await seedShop(db, "force.myshopify.com");
    const coded = await giftOffer(shopId, 400, { internalName: "coded-huge", requiresCode: true });
    await db.insert(discountCodes).values({ shopId, offerId: coded, code: "FORCE-1" });
    expect((await preflightCapacity(db, shopId, [coded], { shardsEnabled: false })).ok).toBe(true);
    expect(await preflightCapacity(db, shopId, [coded], { shardsEnabled: false, forceInclude: true })).toMatchObject({ ok: false, code: "SLOT_FULL" });
  });

  it("is OFFER_TOO_LARGE for keys when one offer checks more than 3 cart attributes", async () => {
    const shopId = await seedShop(db, "keys-one.myshopify.com");
    const offerId = await giftOffer(shopId, 2, { internalName: "attr-heavy" });
    await db.insert(offerConditions).values(
      ["a", "b", "c", "d"].map((key, i) => ({
        shopId, offerId, scope: "main" as const, conditionType: "cart_attribute", operator: "eq" as const,
        value: { key, value: "x" }, sortOrder: i + 1, isEnabled: true,
      })),
    );
    const result = await preflightCapacity(db, shopId, [], withBudget(11));
    expect(result).toMatchObject({ ok: false, code: "OFFER_TOO_LARGE", reason: "keys", offerNames: ["attr-heavy"] });
    if (!result.ok) expect(result.message).toBe('"attr-heavy" checks 4 cart attributes. Shopify lets a discount read at most 3. Remove 1 cart attribute conditions.');
  });

  it("is CART_ATTRIBUTE_KEYS in single-slot mode when active offers use more than 3 keys in total", async () => {
    const shopId = await seedShop(db, "keys-many.myshopify.com");
    for (const key of ["a", "b", "c", "d"]) {
      const offerId = await giftOffer(shopId, 2, { internalName: `attr-${key}` });
      await db.insert(offerConditions).values({
        shopId, offerId, scope: "main", conditionType: "cart_attribute", operator: "eq",
        value: { key, value: "x" }, sortOrder: 1, isEnabled: true,
      });
    }
    const off = await preflightCapacity(db, shopId, [], { shardsEnabled: false });
    expect(off).toMatchObject({ ok: false, code: "CART_ATTRIBUTE_KEYS" });
    if (!off.ok) {
      expect(off.offerNames).toEqual(["attr-a", "attr-b", "attr-c", "attr-d"]);
      expect(off.message).toContain("Offers using them:");
    }
    expect((await preflightCapacity(db, shopId, [], withBudget(11))).ok).toBe(true);
  });

  it("is SHIPPING_CONFIG_TOO_LARGE for 150 shipping rewards, naming the offer", async () => {
    const shopId = await seedShop(db, "ship.myshopify.com");
    const offerId = await seedOffer(db, shopId, { internalName: "shipper" });
    await db.insert(offerRewards).values(
      Array.from({ length: 150 }, (_, i) => ({
        shopId, offerId, rewardType: "shipping_discount" as const, discountType: "free" as const, value: { amount: 100 },
        target: { deliveryGroupTypes: ["ONE_TIME_PURCHASE"] }, quantity: null, sortOrder: i,
      })),
    );
    const result = await preflightCapacity(db, shopId, [offerId], { shardsEnabled: false });
    expect(result).toMatchObject({ ok: false, code: "SHIPPING_CONFIG_TOO_LARGE", offerIds: [offerId], offerNames: ["shipper"] });
    if (!result.ok) expect(result.message).toBe(shippingConfigTooLargeMessage(result.numbers["bytes"]!));
  });

  it("is COMPILE_ERROR attributing the offer whose data cannot compile", async () => {
    const shopId = await seedShop(db, "compile.myshopify.com");
    const offerId = await giftOffer(shopId, 2, { internalName: "broken" });
    await db.update(offerConditions).set({ value: { thresholdCents: "nope" } }).where(and(eq(offerConditions.offerId, offerId), eq(offerConditions.shopId, shopId)));
    const result = await preflightCapacity(db, shopId, [], { shardsEnabled: false });
    if (result.ok) return;
    expect(result.code).toBe("COMPILE_ERROR");
    expect(result.offerIds).toEqual([offerId]);
  });

  it("is ok and empty for a shop with no active offers, and previous assignment starts empty", async () => {
    const shopId = await seedShop(db, "empty.myshopify.com");
    expect(await preflightCapacity(db, shopId, [], { shardsEnabled: false })).toEqual({
      ok: true,
      plan: { slots: 1, bytesPerSlot: [0], deliveryBytes: 0, maxSlots: 1, budget: null },
    });
    expect((await readPreviousAssignment(db, shopId)).size).toBe(0);
  });
});

describe("combination policy forcing a single shard", () => {
  const noProductCombine = (shopId: string, offerId: string) =>
    db.insert(offerCombinationPolicies).values({ shopId, offerId, combinesWithProductDiscounts: false });

  it("is COMBINATION_SINGLE_SHARD naming the offer when the flag is on and the single node overflows", async () => {
    const shopId = await seedShop(db, "combo-full.myshopify.com");
    const sitewide = await giftOffer(shopId, 1, { internalName: "sitewide-no-combine", priority: 1 });
    await noProductCombine(shopId, sitewide);
    for (let i = 0; i < 12; i++) await giftOffer(shopId, 60, { internalName: `c-${i}`, priority: 10 + i });
    const result = await preflightCapacity(db, shopId, [], withBudget(11));
    expect(result).toMatchObject({
      ok: false,
      code: "COMBINATION_SINGLE_SHARD",
      reason: "combination",
      offerIds: [sitewide],
      offerNames: ["sitewide-no-combine"],
    });
    if (result.ok) return;
    expect(result.numbers).toMatchObject({ slotBytes: 9500, offersBlocking: 1 });
    expect(result.numbers["bytes"]).toBeGreaterThan(9500);
    expect(result.message).toContain("1 active offers don't combine with other product discounts");
    expect(result.message).toContain('"sitewide-no-combine"');
  });

  it("stays SLOT_FULL with the flag off", async () => {
    const shopId = await seedShop(db, "combo-off.myshopify.com");
    const sitewide = await giftOffer(shopId, 1, { internalName: "off-no-combine", priority: 1 });
    await noProductCombine(shopId, sitewide);
    for (let i = 0; i < 12; i++) await giftOffer(shopId, 60, { internalName: `o-${i}`, priority: 10 + i });
    expect(await preflightCapacity(db, shopId, [], { shardsEnabled: false })).toMatchObject({ ok: false, code: "SLOT_FULL" });
  });

  it("is not a combination failure when the policy combines and only one slot is allowed", async () => {
    const shopId = await seedShop(db, "combo-one-slot.myshopify.com");
    for (let i = 0; i < 12; i++) await giftOffer(shopId, 60, { internalName: `s-${i}`, priority: i });
    expect(await preflightCapacity(db, shopId, [], withBudget(1))).toMatchObject({ ok: false, code: "AUTOMATIC_DISCOUNT_LIMIT" });
  });

  it("is ok and reports the cause and blockers when it fits on one node", async () => {
    const shopId = await seedShop(db, "combo-fits.myshopify.com");
    const a = await giftOffer(shopId, 1, { internalName: "A", priority: 1 });
    const b = await giftOffer(shopId, 1, { internalName: "B", priority: 2 });
    await giftOffer(shopId, 1, { internalName: "C", priority: 3 });
    await noProductCombine(shopId, a);
    await noProductCombine(shopId, b);
    const result = await preflightCapacity(db, shopId, [], withBudget(11));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.slots).toBe(1);
    expect(result.plan.singleShardReason).toBe("combination");
    expect(result.plan.combinationBlockers).toEqual([
      { offerId: a, name: "A" },
      { offerId: b, name: "B" },
    ]);
  });

  it("reports flag_off and budget causes", async () => {
    const shopId = await seedShop(db, "combo-causes.myshopify.com");
    await giftOffer(shopId, 1, { internalName: "X", priority: 1 });
    const off = await preflightCapacity(db, shopId, [], { shardsEnabled: false });
    expect(off.ok && off.plan.singleShardReason).toBe("flag_off");
    const tight = await preflightCapacity(db, shopId, [], withBudget(1));
    expect(tight.ok && tight.plan.singleShardReason).toBe("budget");
    const wide = await preflightCapacity(db, shopId, [], withBudget(11));
    expect(wide.ok && wide.plan.singleShardReason).toBeUndefined();
  });
});
