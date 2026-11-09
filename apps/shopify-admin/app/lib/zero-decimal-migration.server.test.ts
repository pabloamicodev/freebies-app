import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appSettings, offerConditions, offerRewards, shops, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import { AMOUNTS_MARKER_KEY, MIGRATION_MARKER_KEY, migrateConditionValue, migrateReward, migrateZeroDecimalThresholds } from "./zero-decimal-migration.server.js";

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

describe("zero-decimal amounts phase (fixed discount values, fixed-amount overrides)", () => {
  const EARLIER_RUN = new Date("2026-11-03T00:00:00Z");
  let fresh = "";
  let marked = "";
  let usdAmounts = "";
  const reward = async (shopId: string, offerId: string, rewardType: "order_discount" | "product_discount" | "shipping_discount" | "product_gift", discountType: "fixed_amount" | "fixed_price" | "percentage", amount: number, updatedAt: Date, min: number | null = null) =>
    (await db.insert(offerRewards).values({ shopId, offerId, rewardType, discountType, value: { amount, currencyCode: "JPY" }, target: { scope: "cart" }, quantity: 1, trackMode: "variant", sortOrder: 0, minCartSubtotalCents: min, updatedAt }).returning({ id: offerRewards.id }))[0]!.id;
  const condition = async (shopId: string, offerId: string, value: Record<string, unknown>, updatedAt: Date) =>
    (await db.insert(offerConditions).values({ shopId, offerId, scope: "main", conditionType: "cart_value", operator: "gte", value, sortOrder: 0, isEnabled: true, updatedAt }).returning({ id: offerConditions.id }))[0]!.id;
  const rewardOf = async (id: string) => (await db.select().from(offerRewards).where(eq(offerRewards.id, id)))[0]!;
  const conditionOf = async (id: string) => (await db.select().from(offerConditions).where(eq(offerConditions.id, id)))[0]!;
  const markersOf = async (shopId: string) => (await db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.shopId, shopId))).map((row) => row.key).sort();
  const runFor = (domain: string, apply: boolean, extra: { allowRerun?: boolean } = {}) => migrateZeroDecimalThresholds(db, { before: BEFORE, apply, now: NOW, shopDomains: [domain], ...extra });

  const ids = {} as Record<string, string>;
  beforeAll(async () => {
    fresh = await seedShop(db, "amt-fresh.myshopify.com");
    marked = await seedShop(db, "amt-marked.myshopify.com");
    usdAmounts = await seedShop(db, "amt-usd.myshopify.com");
    for (const id of [fresh, marked]) await db.update(shops).set({ currencyCode: "JPY" }).where(eq(shops.id, id));

    const offer = await seedOffer(db, fresh, { internalName: "amt-fresh", publicTitle: "amt" });
    ids["orderFixed"] = await reward(fresh, offer, "order_discount", "fixed_amount", 50000, OLD);
    ids["productPrice"] = await reward(fresh, offer, "product_discount", "fixed_price", 120000, OLD);
    ids["shipping"] = await reward(fresh, offer, "shipping_discount", "fixed_amount", 5, OLD);
    ids["percent"] = await reward(fresh, offer, "product_discount", "percentage", 20, OLD);
    ids["odd"] = await reward(fresh, offer, "order_discount", "fixed_amount", 55050, OLD);
    ids["savedAfter"] = await reward(fresh, offer, "order_discount", "fixed_amount", 50000, NEW);
    ids["gift"] = await reward(fresh, offer, "product_gift", "fixed_amount", 30000, OLD, 1200000);
    ids["cart"] = await condition(fresh, offer, { thresholdCents: 500000, currencyCode: "JPY", fixedAmountOverrides: { JPY: 50000, USD: 525, KRW: 700000 } }, OLD);

    const earlier = await seedOffer(db, marked, { internalName: "amt-marked", publicTitle: "amt" });
    // What the thresholds-only run left: its rows stamped with its run time, thresholds already whole, amounts untouched.
    ids["markedStamped"] = await reward(marked, earlier, "order_discount", "fixed_amount", 50000, EARLIER_RUN);
    ids["markedGift"] = await reward(marked, earlier, "product_gift", "fixed_amount", 30000, EARLIER_RUN, 12000);
    ids["markedCart"] = await condition(marked, earlier, { thresholdCents: 5000, currencyCode: "JPY", fixedAmountOverrides: { JPY: 50000 } }, EARLIER_RUN);
    ids["markedOld"] = await reward(marked, earlier, "product_discount", "fixed_amount", 20000, OLD);
    ids["markedSavedAfter"] = await reward(marked, earlier, "order_discount", "fixed_amount", 50000, new Date("2026-11-04T00:00:00Z"));
    await db.insert(appSettings).values({ shopId: marked, key: MIGRATION_MARKER_KEY, value: JSON.stringify({ at: EARLIER_RUN.toISOString(), before: BEFORE.toISOString(), rows: 3 }) });
    await db.insert(appSettings).values({ shopId: marked, key: "widget.market_overrides." + earlier, value: JSON.stringify([{ marketId: "gid://shopify/Market/1", thresholdCents: 500000, widgetTitle: null, enabled: true }]), updatedAt: OLD });

    const usdOffer = await seedOffer(db, usdAmounts, { internalName: "amt-usd", publicTitle: "amt" });
    ids["usdFixed"] = await reward(usdAmounts, usdOffer, "order_discount", "fixed_amount", 50000, OLD);
    ids["usdCart"] = await condition(usdAmounts, usdOffer, { thresholdCents: 500000, currencyCode: "USD", fixedAmountOverrides: { JPY: 50000 } }, OLD);
  }, 60_000);

  it("dry-run lists each amount and writes nothing", async () => {
    const before = [await rewardOf(ids["orderFixed"]!), await conditionOf(ids["cart"]!)];
    const result = await runFor("amt-fresh.myshopify.com", false);
    expect(result.rowsWritten).toBe(0);
    const fields = result.changes.map((change) => `${change.id === ids["cart"] ? "cart" : "reward"}:${change.field}:${change.from}->${change.to}`);
    expect(fields).toEqual(expect.arrayContaining([
      "reward:amount:50000->500",
      "reward:amount:120000->1200",
      "reward:amount:30000->300",
      "cart:fixedAmountOverrides.JPY:50000->500",
      "cart:fixedAmountOverrides.KRW:700000->7000",
    ]));
    expect(await markersOf(fresh)).toEqual([]);
    expect([await rewardOf(ids["orderFixed"]!), await conditionOf(ids["cart"]!)]).toEqual(before);
  });

  it("apply divides fixed amounts and prices once, leaving shipping, percentages, odd values and later saves alone", async () => {
    const result = await runFor("amt-fresh.myshopify.com", true);
    expect(result.skipped.filter((skip) => skip.table === "offer_rewards").map((skip) => skip.id)).toEqual([ids["odd"]]);
    expect((await rewardOf(ids["orderFixed"]!)).value).toEqual({ amount: 500, currencyCode: "JPY" });
    expect((await rewardOf(ids["productPrice"]!)).value).toMatchObject({ amount: 1200 });
    expect((await rewardOf(ids["gift"]!)).value).toMatchObject({ amount: 300 });
    expect((await rewardOf(ids["gift"]!)).minCartSubtotalCents).toBe(12000);
    expect((await rewardOf(ids["shipping"]!)).value).toMatchObject({ amount: 5 });
    expect((await rewardOf(ids["percent"]!)).value).toMatchObject({ amount: 20 });
    expect((await rewardOf(ids["odd"]!)).value).toMatchObject({ amount: 55050 });
    expect((await rewardOf(ids["savedAfter"]!)).value).toMatchObject({ amount: 50000 });
    // One write per row: the thresholds and the fixed overrides of the same condition land together, USD stays x100.
    expect((await conditionOf(ids["cart"]!)).value).toEqual({ thresholdCents: 5000, currencyCode: "JPY", fixedAmountOverrides: { JPY: 500, USD: 525, KRW: 7000 } });
    expect(await markersOf(fresh)).toEqual([AMOUNTS_MARKER_KEY, MIGRATION_MARKER_KEY]);
  });

  it("a shop with both markers is refused, and nothing is divided twice", async () => {
    const before = await rewardOf(ids["orderFixed"]!);
    const again = await runFor("amt-fresh.myshopify.com", true);
    expect(again.alreadyMigrated).toEqual(["amt-fresh.myshopify.com"]);
    expect(again.changes).toEqual([]);
    expect(await rewardOf(ids["orderFixed"]!)).toEqual(before);
  });

  it("a shop marked by the thresholds-only version still gets the amounts, and only those", async () => {
    const dry = await runFor("amt-marked.myshopify.com", false);
    expect(dry.alreadyMigrated).toEqual([]);
    expect(dry.amountsOnly).toEqual(["amt-marked.myshopify.com"]);
    expect(await markersOf(marked)).not.toContain(AMOUNTS_MARKER_KEY);

    const result = await runFor("amt-marked.myshopify.com", true);
    expect(result.changes.every((change) => !/threshold|Subtotal|currencyCode/i.test(change.field))).toBe(true);
    expect((await rewardOf(ids["markedStamped"]!)).value).toMatchObject({ amount: 500 });
    expect((await rewardOf(ids["markedOld"]!)).value).toMatchObject({ amount: 200 });
    expect((await rewardOf(ids["markedGift"]!))).toMatchObject({ value: { amount: 300 }, minCartSubtotalCents: 12000 });
    expect((await conditionOf(ids["markedCart"]!)).value).toEqual({ thresholdCents: 5000, currencyCode: "JPY", fixedAmountOverrides: { JPY: 500 } });
    expect((await rewardOf(ids["markedSavedAfter"]!)).value).toMatchObject({ amount: 50000 });
    expect(await markersOf(marked)).toContain(AMOUNTS_MARKER_KEY);
    expect((await runFor("amt-marked.myshopify.com", true)).alreadyMigrated).toEqual(["amt-marked.myshopify.com"]);
  });

  it("reports the widget's per-market thresholds instead of guessing their currency", async () => {
    const result = await runFor("amt-marked.myshopify.com", false, { allowRerun: true });
    expect(result.skipped.some((skip) => skip.table === "app_settings" && /market currency is not stored/.test(skip.reason))).toBe(true);
    expect(result.rowsWritten).toBe(0);
  });

  it("never touches a two-decimal shop, even with the same numbers", async () => {
    const before = [await rewardOf(ids["usdFixed"]!), await conditionOf(ids["usdCart"]!)];
    const result = await migrateZeroDecimalThresholds(db, { before: BEFORE, apply: true, now: NOW });
    expect(result.changes.every((change) => change.shop !== "amt-usd.myshopify.com")).toBe(true);
    expect([await rewardOf(ids["usdFixed"]!), await conditionOf(ids["usdCart"]!)]).toEqual(before);
    expect(await markersOf(usdAmounts)).toEqual([]);
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
