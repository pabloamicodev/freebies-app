import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { offerConditions, offerRewards, offers, productCache, shops, variantCache, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "", shop: "", currency: "USD" }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: ctx.currency,
    session: { shop: ctx.shop },
  }),
}));
vi.mock("../shopify.server.js", () => ({
  authenticate: { admin: async () => ({ session: { shop: ctx.shop } }) },
}));
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => ctx.db,
}));
vi.mock("./offer-publish-flow.server.js", () => ({
  publishShopConfig: async () => null,
  tryPublishShop: async () => null,
  getPublishWarnings: async () => [] as string[],
  republishIfActive: async () => null,
  finalizeCreatedOffer: async () => null,
  validateOffersPublishable: async () => ({ ok: true }),
  validateActivation: async () => ({ ok: true }),
}));
vi.mock("./audit-log.server.js", () => ({ insertAuditLog: async () => undefined }));

import { buildTieredGiftOffer } from "./gift-tier-campaigns.js";
import { parseCSV } from "./csv.js";

const wizard = await import("../routes/app.offers.new.gift.$template.js");
const rewardsRoute = await import("../routes/app.offers.$id.rewards.js");
const conditionsRoute = await import("../routes/app.offers.$id.conditions.js");
const exportRoute = await import("../routes/api.offers.$id.export.js");
const importRoute = await import("../routes/app.offers.import.js");

let db: Db;
let close: () => Promise<void>;
let usdShop = "";
let jpyShop = "";

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const post = (fields: Record<string, string>) => new Request("http://localhost/x", { method: "POST", body: new URLSearchParams(fields) });
type Out = { error?: string | null; created?: string[]; errors?: Array<{ row: number; message: string }> } | Response | undefined;
const run = (fn: unknown, request: Request, params: Record<string, string> = {}) =>
  (fn as (a: unknown) => Promise<Out>)({ request, params, context: {} }) as Promise<Exclude<Out, Response>>;
const useShop = (which: "usd" | "jpy") => {
  ctx.shopId = which === "usd" ? usdShop : jpyShop;
  ctx.shop = which === "usd" ? "followup-usd.myshopify.com" : "followup-jpy.myshopify.com";
  ctx.currency = which === "usd" ? "USD" : "JPY";
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  usdShop = await seedShop(db, "followup-usd.myshopify.com");
  jpyShop = await seedShop(db, "followup-jpy.myshopify.com");
  await db.update(shops).set({ currencyCode: "JPY" }).where(eq(shops.id, jpyShop));
  for (const shopId of [usdShop, jpyShop]) {
    for (const n of [1, 2, 3]) {
      await db.insert(productCache).values({ shopId, productGid: `gid://shopify/Product/${n}`, handle: `gift-${n}`, title: `Gift ${n}`, status: "ACTIVE", raw: {} });
      await db.insert(variantCache).values({
        shopId, productGid: `gid://shopify/Product/${n}`, variantGid: V(n), title: "Default", price: "20.00", currencyCode: "USD",
        availableForSale: true, inventoryQuantity: 10, inventoryPolicy: "DENY", raw: {},
      });
    }
  }
}, 60_000);
afterAll(async () => {
  await close();
});

async function seedGift(shopId: string, name: string, tierMode: "cumulative" | "highest" | null, tiers: Array<[number, string[], string[]?]>, currency = "USD") {
  const id = await seedOffer(db, shopId, { type: "gift", status: "draft", internalName: name, publicTitle: name, tierMode });
  await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: Math.min(...tiers.map((t) => t[0])), currencyCode: currency, includeGiftValues: false }, sortOrder: 0, isEnabled: true });
  for (const [index, [min, variants, fallbacks]] of tiers.entries()) {
    await db.insert(offerRewards).values({
      shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: currency },
      target: { scope: "cart", variantIds: variants, ...(fallbacks ? { fallbackVariantIds: fallbacks } : {}) },
      quantity: variants.length > 1 ? 2 : 1, isAutoAdd: variants.length === 1, isCustomerSelectable: variants.length > 1, trackMode: "variant", sortOrder: index, minCartSubtotalCents: min,
    });
  }
  return id;
}
const rewardsOf = async (offerId: string) => (await db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId))).sort((a, b) => a.sortOrder - b.sortOrder);
const offerNamed = async (name: string) => (await db.select().from(offers).where(eq(offers.internalName, name)))[0];
const exportCsv = async (id: string) => (await (exportRoute.loader as (a: unknown) => Promise<Response>)({ request: new Request("http://localhost/x"), params: { id }, context: {} })).text();
const importCsv = (csvContent: string) => run(importRoute.action, post({ csvContent }));

describe("zero-decimal currencies: thresholds are stored in the currency's own minor unit", () => {
  const rewardForm = (fields: Record<string, string>) => ({
    intent: "add_reward", rewardType: "product_gift", discountType: "free", discountValue: "0", quantity: "1", isAutoAdd: "on", variantGids: V(1), ...fields,
  });

  it("a gift tier on a JPY shop is stored as whole yen and read back as the same yen", async () => {
    useShop("jpy");
    const id = await seedGift(jpyShop, "jpy-tier", "cumulative", [[5000, [V(1)]]], "JPY");
    expect((await run(rewardsRoute.action, post(rewardForm({ minCartSubtotal: "12000", variantGids: V(2) })), { id }))?.error).toBeUndefined();
    expect((await rewardsOf(id)).map((r) => r.minCartSubtotalCents)).toEqual([5000, 12000]);
    const page = (await (rewardsRoute.loader as (a: unknown) => Promise<{ shopCurrencyCode: string }>)({ request: new Request("http://localhost/x"), params: { id }, context: {} }));
    expect(page.shopCurrencyCode).toBe("JPY");
  });

  it("the same form on a USD shop still stores cents", async () => {
    useShop("usd");
    const id = await seedGift(usdShop, "usd-tier", "cumulative", [[5000, [V(1)]]]);
    await run(rewardsRoute.action, post(rewardForm({ minCartSubtotal: "125.50", variantGids: V(2) })), { id });
    expect((await rewardsOf(id)).map((r) => r.minCartSubtotalCents)).toEqual([5000, 12550]);
  });

  it("the conditions editor stores a JPY cart value in yen, and the USD one in cents", async () => {
    useShop("jpy");
    const jpyOffer = await seedOffer(db, jpyShop, { type: "gift", status: "draft", internalName: "jpy-cond" });
    await run(conditionsRoute.action, post({ intent: "add_condition", conditionType: "cart_value", scope: "main", threshold: "3000" }), { id: jpyOffer });
    const [jpy] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, jpyOffer));
    expect(jpy!.value).toMatchObject({ thresholdCents: 3000, currencyCode: "JPY" });

    useShop("usd");
    const usdOffer = await seedOffer(db, usdShop, { type: "gift", status: "draft", internalName: "usd-cond" });
    await run(conditionsRoute.action, post({ intent: "add_condition", conditionType: "cart_value", scope: "main", threshold: "30", currencyCode: "USD" }), { id: usdOffer });
    const [usd] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, usdOffer));
    expect(usd!.value).toMatchObject({ thresholdCents: 3000, currencyCode: "USD" });
    // A new condition is tagged with the shop currency, whichever it is; the stored amount is unchanged for two-decimal shops.
    useShop("usd");
    ctx.currency = "EUR";
    const eurOffer = await seedOffer(db, usdShop, { type: "gift", status: "draft", internalName: "eur-cond" });
    await run(conditionsRoute.action, post({ intent: "add_condition", conditionType: "cart_value", scope: "main", threshold: "30" }), { id: eurOffer });
    const [eur] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, eurOffer));
    expect(eur!.value).toMatchObject({ thresholdCents: 3000, currencyCode: "EUR" });
  });

  it("the unit comes from the shop currency, never from the typed currency tag", async () => {
    useShop("usd");
    const usdOffer = await seedOffer(db, usdShop, { type: "gift", status: "draft", internalName: "tag-jpy-on-usd" });
    await run(conditionsRoute.action, post({ intent: "add_condition", conditionType: "cart_value", scope: "main", threshold: "50", currencyCode: "JPY" }), { id: usdOffer });
    const [stored] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, usdOffer));
    expect(stored!.value).toMatchObject({ thresholdCents: 5000, currencyCode: "JPY" });
    useShop("jpy");
    const jpyOffer = await seedOffer(db, jpyShop, { type: "gift", status: "draft", internalName: "tag-usd-on-jpy" });
    await run(conditionsRoute.action, post({ intent: "add_condition", conditionType: "cart_value", scope: "main", threshold: "5000", currencyCode: "USD" }), { id: jpyOffer });
    const [other] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, jpyOffer));
    expect(other!.value).toMatchObject({ thresholdCents: 5000 });
  });

  it("customer-spend amounts are whole yen on a JPY shop and cents on a USD shop", async () => {
    useShop("jpy");
    const jpyOffer = await seedOffer(db, jpyShop, { type: "gift", status: "draft", internalName: "spend-jpy" });
    await run(conditionsRoute.action, post({ intent: "add_condition", conditionType: "order_history_total_spent", scope: "sub", orderValue: "20000", operator: "gte" }), { id: jpyOffer });
    expect((await db.select().from(offerConditions).where(eq(offerConditions.offerId, jpyOffer)))[0]!.value).toMatchObject({ valueCents: 20000 });
    useShop("usd");
    const usdOffer = await seedOffer(db, usdShop, { type: "gift", status: "draft", internalName: "spend-usd" });
    await run(conditionsRoute.action, post({ intent: "add_condition", conditionType: "order_history_total_spent", scope: "sub", orderValue: "200", operator: "gte" }), { id: usdOffer });
    expect((await db.select().from(offerConditions).where(eq(offerConditions.offerId, usdOffer)))[0]!.value).toMatchObject({ valueCents: 20000 });
  });

  it("the gift wizard stores its cart-value threshold in the shop currency's unit", async () => {
    const form = (minAmount: string) => ({
      intent: "draft", internalName: `wizard-${minAmount}-${ctx.currency}`, conditionType: "cart_value", minAmount, maxAmount: "0",
      discountType: "free", rewardProducts: JSON.stringify([V(1)]), isAutoAdd: "true", giftCount: "1",
    });
    useShop("jpy");
    const jpy = await run(wizard.action, post(form("5000")), { template: "spend" });
    expect(jpy?.error).toBeUndefined();
    const [jpyCondition] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, (await offerNamed("wizard-5000-JPY"))!.id));
    expect(jpyCondition!.value).toMatchObject({ thresholdCents: 5000 });
    useShop("usd");
    expect((await run(wizard.action, post(form("50")), { template: "spend" }))?.error).toBeUndefined();
    const [usdCondition] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, (await offerNamed("wizard-50-USD"))!.id));
    expect(usdCondition!.value).toMatchObject({ thresholdCents: 5000 });
  });

  it("tier labels name the threshold in the currency's units", () => {
    const campaign = { campaignId: "x", name: "N", stackingMode: "cumulative" as const, tiers: [{ id: "a", minimumSubtotalCents: 5000, variantIds: [V(1)], quantity: 1 }] };
    expect(buildTieredGiftOffer(campaign, "JPY").rewards[0]!.label).toBe("Gift at 5000");
    expect(buildTieredGiftOffer(campaign, "USD").rewards[0]!.label).toBe("Gift at 50.00");
  });
});

describe("CSV round trip keeps gift tiers and tier mode", () => {
  it("export then import recreates the same tiers, fallbacks, quantities and mode", async () => {
    useShop("usd");
    const id = await seedGift(usdShop, "rt-src", "highest", [[7000, [V(1)], [V(3)]], [11000, [V(2), V(3)]]]);
    const csv = (await exportCsv(id)).replaceAll("rt-src", "rt-copy");
    const result = await importCsv(csv);
    expect(result?.errors).toEqual([]);
    expect(result?.created).toHaveLength(1);
    const copy = (await offerNamed("rt-copy"))!;
    expect(copy).toMatchObject({ type: "gift", status: "draft", tierMode: "highest" });
    const rewards = await rewardsOf(copy.id);
    expect(rewards.map((r) => [r.minCartSubtotalCents, r.sortOrder, r.quantity, r.isAutoAdd, r.isCustomerSelectable])).toEqual([[7000, 0, 1, true, false], [11000, 1, 2, false, true]]);
    expect(rewards.map((r) => r.target)).toEqual([
      { scope: "cart", variantIds: [V(1)], fallbackVariantIds: [V(3)] },
      { scope: "cart", variantIds: [V(2), V(3)] },
    ]);
    const [main] = await db.select().from(offerConditions).where(and(eq(offerConditions.offerId, copy.id), eq(offerConditions.scope, "main")));
    expect(main).toMatchObject({ conditionType: "cart_value", value: { thresholdCents: 7000, currencyCode: "USD" } });
  });

  it("a cumulative offer round-trips as cumulative", async () => {
    useShop("usd");
    const id = await seedGift(usdShop, "rt-cum", "cumulative", [[4000, [V(1)]], [9000, [V(2)]]]);
    await importCsv((await exportCsv(id)).replaceAll("rt-cum", "rt-cum-copy"));
    expect((await offerNamed("rt-cum-copy"))).toMatchObject({ tierMode: "cumulative" });
  });

  it("a JPY shop's thresholds round-trip as the same yen", async () => {
    useShop("jpy");
    const id = await seedGift(jpyShop, "rt-jpy", "cumulative", [[5000, [V(1)]], [12000, [V(2)]]], "JPY");
    await importCsv((await exportCsv(id)).replaceAll("rt-jpy", "rt-jpy-copy"));
    const copy = (await offerNamed("rt-jpy-copy"))!;
    expect((await rewardsOf(copy.id)).map((r) => r.minCartSubtotalCents)).toEqual([5000, 12000]);
    expect((await db.select().from(offerConditions).where(eq(offerConditions.offerId, copy.id)))[0]!.value).toMatchObject({ thresholdCents: 5000, currencyCode: "JPY" });
  });

  const header = "offer_id,internal_name,public_title,type,gift_variant_gids,gift_quantity,gift_tier_mode,gift_min_cart_subtotal_cents";
  it.each([
    ["duplicate thresholds", `${header}\nA,bad-dup,t,gift,${V(1)},1,cumulative,5000\nA,bad-dup,t,gift,${V(2)},1,cumulative,5000`, /unique/],
    ["a zero threshold", `${header}\nA,bad-zero,t,gift,${V(1)},1,cumulative,0`, /gift_min_cart_subtotal_cents/],
    ["a fractional threshold", `${header}\nA,bad-frac,t,gift,${V(1)},1,cumulative,50.5`, /gift_min_cart_subtotal_cents/],
    ["an unknown mode", `${header}\nA,bad-mode,t,gift,${V(1)},1,sometimes,5000`, /gift_tier_mode/],
    ["mixed modes", `${header}\nA,bad-mixed,t,gift,${V(1)},1,cumulative,5000\nA,bad-mixed,t,gift,${V(2)},1,highest,9000`, /same on every row/],
    ["a bad variant gid", `${header}\nA,bad-gid,t,gift,not-a-gid,1,cumulative,5000`, /gift_variant_gids/],
  ])("rejects %s and creates nothing", async (_label, csv, message) => {
    useShop("usd");
    const result = await importCsv(csv);
    expect(result?.created).toEqual([]);
    expect(result?.errors?.[0]?.message).toMatch(message);
    expect(await db.select({ id: offers.id }).from(offers).where(eq(offers.internalName, csv.split("\n")[1]!.split(",")[1]!))).toHaveLength(0);
  });

  it("a file without the tier columns imports exactly as before: one untiered offer per row", async () => {
    useShop("usd");
    const csv = [
      "internal_name,public_title,type,priority,condition_type,condition_value_threshold_cents,reward_type,discount_type,reward_value,gift_variant_gids,gift_quantity,is_auto_add,track_mode",
      `legacy-a,A,gift,100,cart_value,5000,product_gift,free,100,${V(1)},1,true,product`,
      `legacy-b,B,gift,100,cart_value,9000,product_gift,free,100,${V(2)},1,true,product`,
    ].join("\n");
    const result = await importCsv(csv);
    expect(result?.errors).toEqual([]);
    expect(result?.created).toHaveLength(2);
    for (const [name, cents, variant] of [["legacy-a", 5000, 1], ["legacy-b", 9000, 2]] as const) {
      const offer = (await offerNamed(name))!;
      expect(offer.tierMode).toBeNull();
      const [reward] = await rewardsOf(offer.id);
      expect(reward).toMatchObject({ minCartSubtotalCents: null, isCustomerSelectable: false, target: { variantIds: [V(variant)] } });
      const [condition] = await db.select().from(offerConditions).where(eq(offerConditions.offerId, offer.id));
      expect(condition!.value).toEqual({ thresholdCents: cents, currencyCode: "USD", includeGiftValues: false });
    }
  });

  it("a gift without a threshold stays in its tiered offer instead of becoming another one", async () => {
    useShop("usd");
    const id = await seedGift(usdShop, "c1-src", "cumulative", [[5000, [V(1)]]]);
    await db.insert(offerRewards).values({ shopId: usdShop, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" }, target: { scope: "cart", variantIds: [V(3)] }, quantity: 1, isAutoAdd: true, trackMode: "variant", sortOrder: 1, minCartSubtotalCents: null });
    const before = (await db.select({ id: offers.id }).from(offers)).length;
    const result = await importCsv((await exportCsv(id)).replaceAll("c1-src", "c1-copy"));
    expect(result?.errors).toEqual([]);
    expect(result?.created).toHaveLength(1);
    expect((await db.select({ id: offers.id }).from(offers)).length).toBe(before + 1);
    const rewards = await rewardsOf((await offerNamed("c1-copy"))!.id);
    expect(rewards.map((r) => r.minCartSubtotalCents)).toEqual([5000, null]);
  });

  it("keeps each tier's discount type, value, auto-add and track mode", async () => {
    useShop("usd");
    const id = await seedGift(usdShop, "c2-src", "cumulative", [[5000, [V(1)]], [9000, [V(2)]]]);
    const [first, second] = await rewardsOf(id);
    await db.update(offerRewards).set({ discountType: "percentage", value: { amount: 50, currencyCode: "USD" }, trackMode: "product" }).where(eq(offerRewards.id, first!.id));
    await db.update(offerRewards).set({ discountType: "fixed_amount", value: { amount: 1000, currencyCode: "USD" }, isAutoAdd: false }).where(eq(offerRewards.id, second!.id));
    await importCsv((await exportCsv(id)).replaceAll("c2-src", "c2-copy"));
    const rewards = await rewardsOf((await offerNamed("c2-copy"))!.id);
    expect(rewards.map((r) => [r.discountType, r.value, r.isAutoAdd, r.trackMode])).toEqual([
      ["percentage", { amount: 50, currencyCode: "USD" }, true, "product"],
      ["fixed_amount", { amount: 1000, currencyCode: "USD" }, false, "variant"],
    ]);
  });

  it("a row with extra columns invalidates its whole offer", async () => {
    useShop("usd");
    const csv = `${header}\nW,wide-offer,t,gift,${V(1)},1,cumulative,5000\nW,wide-offer,t,gift,${V(2)},1,cumulative,9000,extra`;
    const result = await importCsv(csv);
    expect(result?.created).toEqual([]);
    expect(result?.errors?.[0]).toMatchObject({ row: 3, message: expect.stringMatching(/more columns/) });
    expect(await offerNamed("wide-offer")).toBeUndefined();
  });

  it("reports the row that actually failed", async () => {
    useShop("usd");
    const result = await importCsv(`${header}\nR,row-report,t,gift,${V(1)},1,cumulative,5000\nR,row-report,t,gift,${V(2)},1,cumulative,9000\nR,row-report,t,gift,${V(3)},1,cumulative,9000`);
    expect(result?.errors?.[0]).toMatchObject({ row: 4, message: expect.stringMatching(/unique/) });
  });

  it("refuses a variant that is not in this shop's catalog, and a file exported from another currency", async () => {
    useShop("usd");
    const unknown = await importCsv(`${header}\nU,unknown-variant,t,gift,${V(999)},1,cumulative,5000`);
    expect(unknown?.created).toEqual([]);
    expect(unknown?.errors?.[0]?.message).toMatch(/not in this shop's catalog/);
    expect(await offerNamed("unknown-variant")).toBeUndefined();
    const foreign = await importCsv(`${header},shop_currency_code\nF,foreign-currency,t,gift,${V(1)},1,cumulative,5000,JPY`);
    expect(foreign?.created).toEqual([]);
    expect(foreign?.errors?.[0]?.message).toMatch(/differs from this shop's currency/);
    const same = await importCsv(`${header},shop_currency_code\nS,same-currency,t,gift,${V(1)},1,cumulative,5000,usd`);
    expect(same?.errors).toEqual([]);
  });

  it("an export of an untiered offer has empty tier columns and the new fallback column", async () => {
    useShop("usd");
    const id = await seedOffer(db, usdShop, { type: "gift", status: "draft", internalName: "plain-export" });
    await db.insert(offerRewards).values({ shopId: usdShop, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" }, target: { scope: "cart", variantIds: [V(1)] }, quantity: 1, isAutoAdd: true, trackMode: "variant", sortOrder: 0 });
    const [headers, row] = parseCSV(await exportCsv(id));
    const cell = (name: string) => row![headers!.indexOf(name)];
    expect([cell("gift_tier_mode"), cell("gift_min_cart_subtotal_cents"), cell("gift_fallback_variant_gids")]).toEqual(["", "", ""]);
  });
});
