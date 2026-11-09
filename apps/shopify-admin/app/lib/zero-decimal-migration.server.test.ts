import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { offerConditions, offerRewards, shops, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import { migrateConditionValue, migrateReward, migrateZeroDecimalThresholds } from "./zero-decimal-migration.server.js";

let db: Db;
let close: () => Promise<void>;
let jpy = "";
let usd = "";

const BEFORE = new Date("2026-11-01T00:00:00Z");
const OLD = new Date("2026-10-01T00:00:00Z");
const NEW = new Date("2026-11-05T00:00:00Z");
const NOW = new Date("2026-11-10T00:00:00Z");
const V = "gid://shopify/ProductVariant/1";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  jpy = await seedShop(db, "mig-jpy.myshopify.com");
  await db.update(shops).set({ currencyCode: "JPY" }).where(eq(shops.id, jpy));
  usd = await seedShop(db, "mig-usd.myshopify.com");
}, 60_000);
afterAll(async () => {
  await close();
});

async function seed(shopId: string, name: string, updatedAt: Date, currency: string) {
  const offerId = await seedOffer(db, shopId, { internalName: name, publicTitle: name });
  const cond = async (conditionType: "cart_value" | "order_history_total_spent", value: Record<string, unknown>) =>
    (await db.insert(offerConditions).values({ shopId, offerId, scope: "main", conditionType, operator: "gte", value, sortOrder: 0, isEnabled: true, updatedAt }).returning({ id: offerConditions.id }))[0]!.id;
  const reward = async (rewardType: "product_gift" | "shipping_discount", discountType: "free" | "percentage", value: Record<string, unknown>, min: number | null) =>
    (await db.insert(offerRewards).values({ shopId, offerId, rewardType, discountType, value, target: { scope: "cart", variantIds: [V] }, quantity: 1, trackMode: "variant", sortOrder: 0, minCartSubtotalCents: min, updatedAt }).returning({ id: offerRewards.id }))[0]!.id;
  return {
    offerId,
    cartValue: await cond("cart_value", { thresholdCents: 500000, maxCents: 900000, currencyCode: "USD", includeGiftValues: false, currencyOverrides: { KRW: 5000000, EUR: 4500 }, maxCurrencyOverrides: { KRW: 9000000 } }),
    spend: await cond("order_history_total_spent", { type: "total_spent", operator: "gte", valueCents: 2000000 }),
    gift: await reward("product_gift", "free", { amount: 100, currencyCode: currency }, 1200000),
    shipping: await reward("shipping_discount", "percentage", { amount: 100, currencyCode: currency, tiers: [{ minimumSubtotalCents: 500000, maximumSubtotalCents: 900000, discountType: "percentage", discountValue: 100 }, { minimumSubtotalCents: 0, discountType: "percentage", discountValue: 10 }] }, null),
  };
}
const snapshot = async (shopId: string) => ({
  conditions: (await db.select({ id: offerConditions.id, value: offerConditions.value, updatedAt: offerConditions.updatedAt }).from(offerConditions).where(eq(offerConditions.shopId, shopId))).sort((a, b) => a.id.localeCompare(b.id)),
  rewards: (await db.select({ id: offerRewards.id, value: offerRewards.value, min: offerRewards.minCartSubtotalCents, updatedAt: offerRewards.updatedAt }).from(offerRewards).where(eq(offerRewards.shopId, shopId))).sort((a, b) => a.id.localeCompare(b.id)),
});
const run = (apply: boolean, extra: { before?: Date; shopDomains?: string[]; allowRerun?: boolean } = {}) => migrateZeroDecimalThresholds(db, { before: BEFORE, apply, now: NOW, ...extra });

describe("zero-decimal threshold migration", () => {
  it("dry-run reports every field and writes nothing", async () => {
    const rows = await seed(jpy, "dry", OLD, "JPY");
    const before = await snapshot(jpy);
    const result = await run(false, { shopDomains: ["mig-jpy.myshopify.com"] });
    expect(result.rowsWritten).toBe(0);
    expect(result.changes.filter((change) => change.offerId === rows.offerId).map((change) => `${change.field}:${change.from}->${change.to}`).sort()).toEqual([
      "currencyCode:USD->JPY",
      "currencyOverrides.KRW:5000000->50000",
      "maxCents:900000->9000",
      "maxCurrencyOverrides.KRW:9000000->90000",
      "minCartSubtotalCents:1200000->12000",
      "thresholdCents:500000->5000",
      "tiers[0].maximumSubtotalCents:900000->9000",
      "tiers[0].minimumSubtotalCents:500000->5000",
      "valueCents:2000000->20000",
    ]);
    expect(await snapshot(jpy)).toEqual(before);
  });

  it("apply divides once, keeps the rest of each value, and a second run does nothing", async () => {
    const result = await run(true, { shopDomains: ["mig-jpy.myshopify.com"] });
    expect(result.rowsWritten).toBeGreaterThan(0);
    const after = await snapshot(jpy);
    const cart = after.conditions.find((row) => (row.value as { thresholdCents?: number }).thresholdCents === 5000)!;
    expect(cart.value).toEqual({ thresholdCents: 5000, maxCents: 9000, currencyCode: "JPY", includeGiftValues: false, currencyOverrides: { KRW: 50000, EUR: 4500 }, maxCurrencyOverrides: { KRW: 90000 } });
    expect(cart.updatedAt.getTime()).toBe(NOW.getTime());
    expect(after.conditions.some((row) => (row.value as { valueCents?: number }).valueCents === 20000)).toBe(true);
    expect(after.rewards.map((row) => row.min).filter((min) => min !== null)).toEqual(expect.arrayContaining([12000]));
    const shipping = after.rewards.find((row) => (row.value as { tiers?: unknown }).tiers)!;
    expect(shipping.value).toMatchObject({ tiers: [{ minimumSubtotalCents: 5000, maximumSubtotalCents: 9000, discountValue: 100 }, { minimumSubtotalCents: 0, discountValue: 10 }] });
    const again = await run(true, { shopDomains: ["mig-jpy.myshopify.com"] });
    expect(again.changes).toEqual([]);
    expect(again.rowsWritten).toBe(0);
    expect(await snapshot(jpy)).toEqual(after);
  });

  it("leaves two-decimal shops untouched, even with the same numbers", async () => {
    await seed(usd, "usd-same", OLD, "USD");
    const before = await snapshot(usd);
    const result = await run(true);
    expect(result.changes.every((change) => change.shop === "mig-jpy.myshopify.com")).toBe(true);
    expect(await snapshot(usd)).toEqual(before);
  });

  it("skips rows saved at or after the cutoff and values that are not x100", async () => {
    await seed(jpy, "saved-after-fix", NEW, "JPY");
    const odd = await seed(jpy, "odd-values", OLD, "JPY");
    await db.update(offerConditions).set({ value: { thresholdCents: 5050, currencyCode: "JPY", includeGiftValues: false }, updatedAt: OLD }).where(eq(offerConditions.id, odd.cartValue));
    const result = await run(true, { allowRerun: true });
    expect(result.changes.some((change) => change.table === "offer_conditions" && change.id === odd.cartValue)).toBe(false);
    expect(result.skipped.some((skip) => skip.id === odd.cartValue && /not a multiple of 100/.test(skip.reason))).toBe(true);
    const rows = await snapshot(jpy);
    expect(rows.conditions.some((row) => (row.value as { thresholdCents?: number }).thresholdCents === 500000)).toBe(true);
    expect((rows.conditions.find((row) => (row.value as { thresholdCents?: number }).thresholdCents === 5050))!.value).toMatchObject({ thresholdCents: 5050 });
  });

  it("a later cutoff does not divide a migrated shop again unless asked to", async () => {
    const before = await snapshot(jpy);
    const later = new Date("2026-11-20T00:00:00Z");
    const refused = await migrateZeroDecimalThresholds(db, { before: later, apply: true, now: new Date("2026-11-21T00:00:00Z") });
    expect(refused.alreadyMigrated).toEqual(["mig-jpy.myshopify.com"]);
    expect(refused.changes).toEqual([]);
    expect(refused.rowsWritten).toBe(0);
    expect(await snapshot(jpy)).toEqual(before);
    const forced = await migrateZeroDecimalThresholds(db, { before: later, apply: false, now: new Date("2026-11-21T00:00:00Z"), allowRerun: true });
    expect(forced.alreadyMigrated).toEqual([]);
    expect(forced.changes.length).toBeGreaterThan(0);
  });

  it("a dry run does not mark a shop", async () => {
    const fresh = await seedShop(db, "mig-fresh.myshopify.com");
    await db.update(shops).set({ currencyCode: "KRW" }).where(eq(shops.id, fresh));
    await run(false, { shopDomains: ["mig-fresh.myshopify.com"] });
    const result = await run(true, { shopDomains: ["mig-fresh.myshopify.com"] });
    expect(result.alreadyMigrated).toEqual([]);
    expect((await run(true, { shopDomains: ["mig-fresh.myshopify.com"] })).alreadyMigrated).toEqual(["mig-fresh.myshopify.com"]);
  });

  it("refuses a cutoff in the future", async () => {
    await expect(migrateZeroDecimalThresholds(db, { before: new Date(NOW.getTime() + 1000), apply: true, now: NOW })).rejects.toThrow(/past ISO timestamp/);
  });
});

describe("migrate helpers", () => {
  it("retags an untagged zero-decimal condition and ignores other condition types", () => {
    expect(migrateConditionValue("cart_value", { thresholdCents: 500 }, "JPY")).toMatchObject({ value: { thresholdCents: 5, currencyCode: "JPY" } });
    expect(migrateConditionValue("cart_quantity", { minQuantity: 3 }, "JPY")).toBeNull();
    expect(migrateConditionValue("cart_value", { thresholdCents: 0 }, "JPY")).toBeNull();
  });
  it("leaves product discounts and untiered gifts alone", () => {
    expect(migrateReward({ rewardType: "product_discount", value: { amount: 10, tiers: [{ minimumQuantity: 2 }] }, minCartSubtotalCents: null })).toBeNull();
    expect(migrateReward({ rewardType: "product_gift", value: {}, minCartSubtotalCents: null })).toBeNull();
  });
});
