import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditLogs,
  bundleDefinitions,
  bundleSteps,
  bundleTiers,
  discountCodeBatches,
  discountCodes,
  discountShards,
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offerVersions,
  offers,
  productCache,
  shops,
  variantCache,
  widgetPlacements,
  widgets,
  type Db,
} from "@promo/db";
import { createOperatorWithPat, type Operator } from "../auth.server.js";
import { handleMcpRequest } from "../handler.server.js";
import { clearFanOutCache } from "../multi-shop.server.js";
import { ToolError } from "../result.server.js";
import { visibleShops, type VisibleShop } from "../shops.server.js";
import { eq } from "drizzle-orm";
import { createTestDb, seedOffer } from "../../test-support/pglite-db.js";
import { configHash } from "../../publish-manifest.server.js";
import { setOfferPublishErrors } from "../../offer-publish-errors.server.js";
import { promosActive } from "./promos-active.server.js";
import { promoDetail } from "./promo-detail.server.js";
import { giftsRules } from "./gifts-rules.server.js";
import { bundlesList } from "./bundles-list.server.js";
import { upsellsList } from "./upsells-list.server.js";
import { codesList } from "./codes-list.server.js";
import { pageConditionsExplain } from "./page-conditions-explain.server.js";
import { discountCapacity } from "./discount-capacity.server.js";

const ALPHA = "alpha.myshopify.com";
const BETA = "beta.myshopify.com";
const GONE = "gone.myshopify.com";
const HIDDEN = "hidden.myshopify.com";
const SECRET_TOKEN = "enc-token-do-not-leak";
const REAL_CODES = ["SUMMER-AAAA-1234", "SUMMER-BBBB-5678", "VIP10"];
const V1 = "gid://shopify/ProductVariant/1";
const V2 = "gid://shopify/ProductVariant/2";

let db: Db;
let close: () => Promise<void>;
const ids: Record<string, string> = {};
const offerIds: Record<string, string> = {};
let visible: VisibleShop[];
const everything: unknown[] = [];

const operator = (allow: string[]): Operator => ({ id: "op-1", email: "op@example.com", name: "Op", role: "viewer", shopAllowList: allow });
const track = <T,>(result: T): T => {
  everything.push(result);
  return result;
};
async function expectToolError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ToolError);
  expect((error as ToolError).payload.code).toBe(code);
}

async function insertShop(domain: string, extra: Partial<typeof shops.$inferInsert> = {}) {
  const [row] = await db
    .insert(shops)
    .values({ shopDomain: domain, myshopifyDomain: domain, accessTokenEncrypted: SECRET_TOKEN, isActive: true, currencyCode: "USD", timezone: "UTC", ...extra })
    .returning({ id: shops.id });
  return row!.id;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ids["alpha"] = await insertShop(ALPHA, { discountId: "gid://shopify/DiscountAutomaticNode/1", deliveryDiscountId: "gid://shopify/DiscountAutomaticNode/2" });
  ids["beta"] = await insertShop(BETA, { currencyCode: "EUR", timezone: "Europe/Madrid" });
  ids["gone"] = await insertShop(GONE, { uninstalledAt: new Date() });
  ids["hidden"] = await insertShop(HIDDEN);
  const a = ids["alpha"]!;
  const b = ids["beta"]!;

  // alpha: gift (picker, cart value, one sold-out variant)
  offerIds["gift"] = await seedOffer(db, a, { type: "gift", status: "active", internalName: "Free mug over 50", publicTitle: "Free mug", priority: 10, requiresCode: false });
  await db.insert(offerConditions).values({ shopId: a, offerId: offerIds["gift"]!, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 5000, currencyCode: "USD" } });
  await db.insert(offerRewards).values({ shopId: a, offerId: offerIds["gift"]!, rewardType: "product_gift", discountType: "free", value: {}, target: { variantIds: [V1, V2], maxUnitsTotal: 3 }, quantity: 1, isCustomerSelectable: true });
  await db.insert(offerCombinationPolicies).values({ shopId: a, offerId: offerIds["gift"]!, maxApplicationsPerCart: 1, maxApplicationsPerCustomer: 2 });
  await db.insert(productCache).values({ shopId: a, productGid: "gid://shopify/Product/1", handle: "mug", title: "Mug", status: "ACTIVE", raw: {} });
  await db.insert(variantCache).values([
    { shopId: a, productGid: "gid://shopify/Product/1", variantGid: V1, title: "Red", price: "5", currencyCode: "USD", availableForSale: false, raw: {} },
    { shopId: a, productGid: "gid://shopify/Product/1", variantGid: V2, title: "Blue", price: "5", currencyCode: "USD", availableForSale: true, raw: {} },
  ]);

  // alpha: page-gated discount with a test group, publish error, audit rows, versions
  offerIds["page"] = await seedOffer(db, a, { type: "discount", status: "active", internalName: "Product page 10 off", publicTitle: "10 off", priority: 20, startsAt: new Date("2026-01-01T10:00:00Z"), endsAt: new Date("2026-12-31T23:00:00Z"), timezone: "America/New_York" });
  await db.insert(offerConditions).values([
    { shopId: a, offerId: offerIds["page"]!, scope: "main", conditionType: "page_types", operator: "eq", value: { pageTypes: ["product"], excludeUrls: ["/products/hidden"] } },
    { shopId: a, offerId: offerIds["page"]!, scope: "main", conditionType: "experiment", operator: "eq", value: { experimentId: "abcdefgh1234", experimentName: "Hero test", variantKeys: ["b"], scope: "page" } },
  ]);
  await db.insert(offerRewards).values({ shopId: a, offerId: offerIds["page"]!, rewardType: "order_discount", discountType: "percentage", value: { amount: 10 }, target: { scope: "cart" } });
  await db.insert(offerVersions).values([
    { shopId: a, offerId: offerIds["page"]!, versionNumber: 1, snapshot: {} },
    { shopId: a, offerId: offerIds["page"]!, versionNumber: 2, snapshot: {} },
  ]);
  await db.insert(auditLogs).values([
    { shopId: a, entityType: "offer", entityId: offerIds["page"]!, action: "update", performedBy: "someone@merchant.com", before: { email: "x@y.com" } },
    { shopId: a, entityType: "offer", entityId: offerIds["page"]!, action: "pause", performedBy: "mcp:op-1" },
  ]);
  await setOfferPublishErrors(a, { [offerIds["page"]!]: "Coded shipping could not be pushed" }, db);

  // alpha: bundle
  offerIds["bundle"] = await seedOffer(db, a, { type: "bundle", status: "scheduled", internalName: "Mix and match 3", publicTitle: "Mix" });
  await db.insert(offerRewards).values({ shopId: a, offerId: offerIds["bundle"]!, rewardType: "bundle_discount", discountType: "percentage", value: { amount: 15 }, target: {} });
  const [def] = await db.insert(bundleDefinitions).values({ shopId: a, offerId: offerIds["bundle"]!, bundleType: "mix_match", title: "Pick 3" }).returning({ id: bundleDefinitions.id });
  await db.insert(bundleSteps).values({ shopId: a, bundleId: def!.id, title: "Choose", sourceType: "collection", sourceConfig: {}, minQuantity: 3, maxQuantity: 3 });
  await db.insert(bundleTiers).values({ shopId: a, bundleId: def!.id, minQuantity: 3, label: "Buy 3", discountType: "percentage", value: { default: 15 } });

  // alpha: upsell (draft) with a widget
  offerIds["upsell"] = await seedOffer(db, a, { type: "upsell", status: "draft", internalName: "Checkout add-on", publicTitle: "Add" });
  await db.insert(offerConditions).values({ shopId: a, offerId: offerIds["upsell"]!, scope: "main", conditionType: "discount_code", operator: "eq", value: { code: "SECRETCODE99" } });
  await db.insert(offerRewards).values({ shopId: a, offerId: offerIds["upsell"]!, rewardType: "upsell_discount", discountType: "percentage", value: { amount: 5 }, target: { variantIds: [V2] } });
  const [widget] = await db.insert(widgets).values({ shopId: a, offerId: offerIds["upsell"]!, type: "checkout_upsell", internalName: "w1" }).returning({ id: widgets.id });
  await db.insert(widgetPlacements).values({ shopId: a, widgetId: widget!.id, placementType: "checkout_extension" });

  // alpha: code offer
  offerIds["code"] = await seedOffer(db, a, { type: "discount", status: "active", internalName: "Summer codes", publicTitle: "Summer", requiresCode: true, requiredDiscountCode: "LEGACYCODE" });
  await db.insert(offerRewards).values({ shopId: a, offerId: offerIds["code"]!, rewardType: "order_discount", discountType: "percentage", value: { amount: 20 }, target: { scope: "cart" } });
  const [batch] = await db.insert(discountCodeBatches).values({ shopId: a, offerId: offerIds["code"]!, prefix: "SUMMER", length: 8, charset: "A", count: 2 }).returning({ id: discountCodeBatches.id });
  await db.insert(discountCodes).values([
    { shopId: a, offerId: offerIds["code"]!, batchId: batch!.id, code: REAL_CODES[0]!, usageCount: 3, endsAt: new Date("2026-09-01T00:00:00Z") },
    { shopId: a, offerId: offerIds["code"]!, batchId: batch!.id, code: REAL_CODES[1]!, usageCount: 1, status: "disabled" },
    { shopId: a, offerId: offerIds["code"]!, code: REAL_CODES[2]!, status: "exhausted", usageCount: 5 },
  ]);

  // beta, gone, hidden
  offerIds["betaActive"] = await seedOffer(db, b, { type: "discount", status: "active", internalName: "Beta 5 off", publicTitle: "Beta" });
  await db.insert(offerRewards).values({ shopId: b, offerId: offerIds["betaActive"]!, rewardType: "order_discount", discountType: "fixed_amount", value: { amount: 500, currencyCode: "EUR" }, target: { scope: "cart" } });
  offerIds["betaPaused"] = await seedOffer(db, b, { type: "gift", status: "paused", internalName: "Beta paused gift", publicTitle: "BG" });
  offerIds["gone"] = await seedOffer(db, ids["gone"]!, { status: "active", internalName: "Gone offer" });
  offerIds["hidden"] = await seedOffer(db, ids["hidden"]!, { status: "active", internalName: "Hidden offer" });

  visible = await visibleShops(db, operator([ALPHA, BETA, GONE]));
}, 120_000);

afterAll(async () => {
  await close();
});
beforeEach(() => clearFanOutCache());

describe("shop visibility", () => {
  it("never includes uninstalled or non-allowed shops", async () => {
    const result = track(await promosActive(db, visible, { status: ["active", "scheduled", "paused", "draft"] }));
    const names = result.data.promos.map((p) => p.name);
    expect(names).not.toContain("Gone offer");
    expect(names).not.toContain("Hidden offer");
    expect(result.perShop!.map((p) => p.shopDomain)).toEqual([ALPHA, BETA]);
  });

  it("naming a shop outside the allow list is SHOP_NOT_FOUND, uninstalled included", async () => {
    await expectToolError(promosActive(db, visible, { shops: [HIDDEN] }), "SHOP_NOT_FOUND");
    await expectToolError(promosActive(db, visible, { shops: [GONE] }), "SHOP_NOT_FOUND");
    await expectToolError(promoDetail(db, visible, { ref: `promo:hidden:${offerIds["hidden"]}` }), "SHOP_NOT_FOUND");
    await expectToolError(codesList(db, visible, { shops: [HIDDEN] }), "SHOP_NOT_FOUND");
    await expectToolError(giftsRules(db, visible, { shops: [HIDDEN] }), "SHOP_NOT_FOUND");
    await expectToolError(discountCapacity(db, visible, { shops: [HIDDEN] }), "SHOP_NOT_FOUND");
  });

  it("an allow list of one shop hides the other shop's offers everywhere", async () => {
    const onlyBeta = await visibleShops(db, operator([BETA]));
    const result = track(await promosActive(db, onlyBeta, { status: ["active", "paused"] }));
    expect(result.data.promos.every((p) => p.shopDomain === BETA)).toBe(true);
    await expectToolError(promoDetail(db, onlyBeta, { ref: `promo:alpha:${offerIds["gift"]}` }), "SHOP_NOT_FOUND");
    expect((await giftsRules(db, onlyBeta, {})).data.gifts.map((g) => g.shopDomain)).toEqual([BETA]);
  });

  it("an empty allow list sees nothing", async () => {
    const none = await visibleShops(db, operator([]));
    expect((await promosActive(db, none, {})).data.promos).toEqual([]);
  });
});

describe("promos_active", () => {
  it("defaults to active and scheduled, across shops, with UTC dates and shop timezone", async () => {
    const result = track(await promosActive(db, visible, {}));
    const byName = new Map(result.data.promos.map((p) => [p.name, p]));
    expect([...byName.keys()].sort()).toEqual(["Beta 5 off", "Free mug over 50", "Mix and match 3", "Product page 10 off", "Summer codes"]);
    const page = byName.get("Product page 10 off")!;
    expect(page.startsAt).toBe("2026-01-01T10:00:00.000Z");
    expect(page.shopTimezone).toBe("America/New_York");
    expect(page.promoRef).toBe(`promo:alpha:${offerIds["page"]}`);
    expect(page.publishErrors).toEqual(["Coded shipping could not be pushed"]);
    expect(page.conditionsSummary.join(" ")).toContain("added from");
    expect(byName.get("Mix and match 3")!.subtype).toBe("mix_match");
    expect(byName.get("Beta 5 off")!.shopTimezone).toBe("Europe/Madrid");
    expect(result.perShop).toHaveLength(2);
    expect(result.warnings.some((w) => w.code === "PUBLISH_ERROR")).toBe(true);
  });

  it("masks discount-code conditions in summaries", async () => {
    const result = track(await promosActive(db, visible, { q: "add-on", status: ["draft"] }));
    expect(result.data.promos).toHaveLength(1);
    expect(result.data.promos[0]!.conditionsSummary.join(" ")).toContain("code: SE••••99");
    expect(JSON.stringify(result)).not.toContain("SECRETCODE99");
  });

  it("filters by type, status and name", async () => {
    expect((await promosActive(db, visible, { types: ["gift"], status: ["paused"] })).data.promos.map((p) => p.name)).toEqual(["Beta paused gift"]);
    expect((await promosActive(db, visible, { q: "100%" })).data.promos).toEqual([]);
  });

  it("paginates with an opaque cursor", async () => {
    const first = await promosActive(db, visible, { limit: 2 });
    expect(first.data.promos).toHaveLength(2);
    expect(first.meta.page).toMatchObject({ hasMore: true });
    const seen = [...first.data.promos];
    let cursor = first.meta.page!.cursor;
    while (cursor) {
      const next = await promosActive(db, visible, { limit: 2, cursor });
      seen.push(...next.data.promos);
      cursor = next.meta.page!.cursor;
    }
    expect(new Set(seen.map((p) => p.offerId)).size).toBe(5);
    expect((await promosActive(db, visible, { limit: 500 })).data.promos.length).toBeLessThanOrEqual(100);
    await expectToolError(promosActive(db, visible, { cursor: "not-a-cursor" }), "VALIDATION");
  });

  it("one failing shop is reported without breaking the other", async () => {
    const fake = [{ ...visible[0]!, id: "not-a-uuid" }, visible[1]!];
    const result = await promosActive(db, fake, {});
    expect(result.perShop!.map((p) => p.status)).toEqual(["error", "ok"]);
    expect(result.data.promos.every((p) => p.shopDomain === BETA)).toBe(true);
  });
});

describe("promo_detail", () => {
  it("exposes offer cart labels and reward tiers with their labels", async () => {
    const a = ids["alpha"]!;
    const id = await seedOffer(db, a, { type: "discount", status: "draft", internalName: "Volume", publicTitle: "Volume", cartLabels: ["Spring", "VIP"] });
    await db.insert(offerRewards).values({
      shopId: a, offerId: id, rewardType: "product_discount", discountType: "percentage", target: { scopeMode: "sitewide" },
      value: { amount: 0, currencyCode: "USD", tiers: [
        { minimumQuantity: 1, maximumQuantity: 1, discountType: "percentage", discountValue: 15, label: "Buy 1", cartLabels: ["Starter"] },
        { minimumQuantity: 2, discountType: "percentage", discountValue: 20 },
      ] },
    });
    try {
      const d = track(await promoDetail(db, visible, { ref: `promo:alpha:${id}` })).data as Record<string, any>;
      expect(d.cartLabels).toEqual(["Spring", "VIP"]);
      expect(d.rewards[0].summary).toContain("Tiers: 1→15%, 2+→20%");
      expect(d.rewards[0].tiers).toEqual([
        { minQuantity: 1, maxQuantity: 1, discountType: "percentage", discountValue: 15, label: "Buy 1", cartLabels: ["Starter"] },
        { minQuantity: 2, maxQuantity: null, discountType: "percentage", discountValue: 20, label: null, cartLabels: [] },
      ]);
    } finally {
      await db.delete(offers).where(eq(offers.id, id));
    }
  });

  it("shows gift tiers: tier mode, each gift's threshold, and a threshold in the summary", async () => {
    const a = ids["alpha"]!;
    const id = await seedOffer(db, a, { type: "gift", status: "draft", internalName: "Tiered gifts", publicTitle: "Tiered gifts", tierMode: "highest" });
    for (const [sortOrder, min] of [7000, 11000].entries()) {
      await db.insert(offerRewards).values({ shopId: a, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" }, target: { variantIds: [`gid://shopify/ProductVariant/${sortOrder + 1}`] }, sortOrder, minCartSubtotalCents: min });
    }
    try {
      const d = track(await promoDetail(db, visible, { ref: `promo:alpha:${id}` })).data as Record<string, any>;
      expect(d.giftTierMode).toBe("highest");
      expect(d.rewards.map((r: { unlocksAtCartSubtotalCents: number }) => r.unlocksAtCartSubtotalCents)).toEqual([7000, 11000]);
      expect(d.rewards[0].summary).toBe("Free gift from USD 70.00");
    } finally {
      await db.delete(offers).where(eq(offers.id, id));
    }
  });

  it("returns the full definition with page conditions, test group, versions and coarse audit events", async () => {
    const result = track(await promoDetail(db, visible, { ref: `promo:alpha:${offerIds["page"]}` }));
    const d = result.data as Record<string, any>;
    expect(d.schedule).toMatchObject({ startsAt: "2026-01-01T10:00:00.000Z", timezone: "America/New_York", shopTimezone: "UTC" });
    expect(d.pageConditions.pageTypes).toEqual(["product"]);
    expect(d.pageConditions.excludeUrls).toEqual(["/products/hidden"]);
    expect(d.experimentBindings).toEqual([{ experimentId: "abcdefgh1234", experimentName: "Hero test", variantKeys: ["b"] }]);
    expect(d.rewards[0].summary).toContain("10% off");
    expect(d.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
    expect(d.recentEvents.map((e: { actor: string }) => e.actor).sort()).toEqual(["mcp:op-1", "merchant"]);
    expect(d.publishErrors).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("someone@merchant.com");
    expect(JSON.stringify(result)).not.toContain("x@y.com");
  });

  it("accepts a bare offerId with shop, masks the required code and the discount_code condition", async () => {
    const code = track(await promoDetail(db, visible, { ref: offerIds["code"], shop: ALPHA }));
    expect((code.data as any).codes).toEqual({ requiresCode: true, redemption: "checkout_code", requiredCodeMasked: "LE••••DE" });
    const upsell = track(await promoDetail(db, visible, { ref: `promo:alpha:${offerIds["upsell"]}` }));
    expect(JSON.stringify(upsell)).not.toContain("SECRETCODE99");
    expect(JSON.stringify(upsell)).toContain("SE••••99");
    const gift = track(await promoDetail(db, visible, { ref: `promo:alpha:${offerIds["gift"]}` }));
    expect((gift.data as any).limits).toMatchObject({ maxApplicationsPerCart: 1, maxApplicationsPerCustomer: 2 });
  });

  it("is OFFER-scoped by shop: another shop's offer id is NOT_FOUND, malformed refs are VALIDATION", async () => {
    await expectToolError(promoDetail(db, visible, { ref: `promo:beta:${offerIds["gift"]}` }), "NOT_FOUND");
    await expectToolError(promoDetail(db, visible, { ref: "nonsense" }), "VALIDATION");
    await expectToolError(promoDetail(db, visible, {}), "VALIDATION");
  });
});

describe("gifts_rules", () => {
  it("reports trigger, picker, limit semantics and stock", async () => {
    const result = track(await giftsRules(db, visible, { status: ["active"] }));
    expect(result.data.gifts).toHaveLength(1);
    const gift = result.data.gifts[0]!;
    expect(gift.threshold).toEqual({ amount: "50.00", currency: "USD" });
    expect(gift.isPicker).toBe(true);
    expect(gift.giftVariants).toBe(2);
    expect(gift.stock).toMatchObject({ known: 2, soldOut: 1 });
    expect(gift.limit).toMatchObject({ setGrantsPerCart: 1, setGrantsPerCustomer: 2, maxUnitsTotal: 3 });
    expect(gift.limit.semantics).toContain("gift SET");
    expect(result.warnings.map((w) => w.code)).toContain("GIFT_SOLD_OUT");
  });

  it("covers every non-archived status by default and can target one ref", async () => {
    expect((await giftsRules(db, visible, {})).data.gifts.map((g) => g.name).sort()).toEqual(["Beta paused gift", "Free mug over 50"]);
    const one = await giftsRules(db, visible, { ref: `promo:alpha:${offerIds["gift"]}` });
    expect(one.data.gifts.map((g) => g.name)).toEqual(["Free mug over 50"]);
    expect(one.perShop).toHaveLength(1);
  });
});

describe("bundles_list and upsells_list", () => {
  it("lists bundles with steps and tiers", async () => {
    const result = track(await bundlesList(db, visible, {}));
    expect(result.data.bundles).toHaveLength(1);
    expect(result.data.bundles[0]).toMatchObject({ bundleType: "mix_match", status: "scheduled", title: "Pick 3" });
    expect(result.data.bundles[0]!.steps).toEqual([{ title: "Choose", sourceType: "collection", minQuantity: 3, maxQuantity: 3 }]);
    expect(result.data.bundles[0]!.tiers[0]).toMatchObject({ label: "Buy 3", minQuantity: 3 });
    expect(result.data.bundles[0]!.discounts[0]).toContain("15% off");
  });

  it("lists upsells with offered product and widget placement", async () => {
    const result = track(await upsellsList(db, visible, { status: ["draft"] }));
    expect(result.data.upsells).toHaveLength(1);
    const upsell = result.data.upsells[0]!;
    expect(upsell.offered).toEqual({ variantCount: 1, productTitles: ["Mug"] });
    expect(upsell.widgets).toEqual([{ type: "checkout_upsell", enabled: true, placements: [{ placementType: "checkout_extension", enabled: true }] }]);
  });

  it("other shops' bundles and upsells do not leak in via the allow list", async () => {
    const onlyBeta = await visibleShops(db, operator([BETA]));
    expect((await bundlesList(db, onlyBeta, {})).data.bundles).toEqual([]);
    expect((await upsellsList(db, onlyBeta, { status: ["draft"] })).data.upsells).toEqual([]);
  });
});

describe("codes_list", () => {
  it("returns aggregates and masked samples, never a real code", async () => {
    const result = track(await codesList(db, visible, {}));
    expect(result.data.offers).toHaveLength(1);
    const row = result.data.offers[0]!;
    expect(row.totals).toEqual({ total: 3, active: 1, disabled: 1, exhausted: 1, redemptions: 9 });
    expect(row.mode).toBe("checkout_code");
    expect(row.codesEndAt.earliest).toBe("2026-09-01T00:00:00.000Z");
    expect(row.batches).toHaveLength(1);
    expect(row.samplesMasked).toContain("SU••••34");
    expect(row.samplesMasked).toContain("V••••");
    const text = JSON.stringify(result);
    for (const code of REAL_CODES) expect(text).not.toContain(code);
    expect(text).not.toContain("LEGACYCODE");
  });

  it("with a ref pages through individual masked codes and filters by status", async () => {
    const ref = `promo:alpha:${offerIds["code"]}`;
    const first = track(await codesList(db, visible, { ref, limit: 2 }));
    expect(first.data.codes).toHaveLength(2);
    expect(first.meta.page?.hasMore).toBe(true);
    const second = await codesList(db, visible, { ref, limit: 2, cursor: first.meta.page!.cursor });
    expect(second.data.codes).toHaveLength(1);
    expect(second.meta.page?.hasMore).toBe(false);
    const exhausted = await codesList(db, visible, { ref, status: "exhausted" });
    expect(exhausted.data.codes!.map((c) => c.masked)).toEqual(["V••••"]);
    expect(JSON.stringify([first, second, exhausted])).not.toMatch(/SUMMER-AAAA|VIP10/);
  });
});

describe("page_conditions_explain", () => {
  const ref = () => `promo:alpha:${offerIds["page"]}`;
  const inGroup = { experiments: ["abcdefgh1234:b"] };

  it("applies on a matching product page in the test group", async () => {
    const result = track(await pageConditionsExplain(db, visible, { ref: ref(), pageUrl: "/products/mug?utm_source=x", ctx: inGroup }));
    expect(result.data["verdict"]).toBe("applies");
    expect((result.data["evaluated"] as any).normalizedPath).toBe("/products/mug");
    expect(result.data["decidingConditions"]).toEqual([]);
  });

  it("explains an excluded path and what to change", async () => {
    const result = track(await pageConditionsExplain(db, visible, { ref: ref(), pageUrl: "https://shop.com/products/hidden/", ctx: inGroup }));
    expect(result.data["verdict"]).toBe("does_not_apply");
    expect(result.data["decidingConditions"]).toEqual(["page_types"]);
    expect((result.data["whatToChange"] as string[])[0]).toContain("excludeUrls");
  });

  it("explains a wrong page type and a missing test group", async () => {
    const cart = await pageConditionsExplain(db, visible, { ref: ref(), pageType: "cart", ctx: inGroup });
    expect(cart.data["verdict"]).toBe("does_not_apply");
    expect((cart.data["whatToChange"] as string[])[0]).toContain("add cart to Store pages");
    const noGroup = await pageConditionsExplain(db, visible, { ref: ref(), pageUrl: "/products/mug" });
    expect(noGroup.data["decidingConditions"]).toEqual(["experiment"]);
  });

  it("an offer without page conditions is not gated; missing url is VALIDATION; other shop's offer is NOT_FOUND", async () => {
    const free = await pageConditionsExplain(db, visible, { ref: `promo:alpha:${offerIds["gift"]}`, pageUrl: "/cart" });
    expect(free.data["verdict"]).toBe("not_gated");
    await expectToolError(pageConditionsExplain(db, visible, { ref: ref() }), "VALIDATION");
    await expectToolError(pageConditionsExplain(db, visible, { ref: `promo:beta:${offerIds["page"]}`, pageUrl: "/" }), "NOT_FOUND");
    await expectToolError(pageConditionsExplain(db, visible, { ref: `promo:hidden:${offerIds["hidden"]}`, pageUrl: "/" }), "SHOP_NOT_FOUND");
  });
});

describe("discount_capacity", () => {
  it("reports bytes against the 9500 limit with the heaviest offers, per shop", async () => {
    const result = track(await discountCapacity(db, visible, {}));
    expect(result.perShop!.map((p) => p.status)).toEqual(["ok", "ok"]);
    const alpha = result.data.shops.find((s) => s.shopDomain === ALPHA)!;
    const beta = result.data.shops.find((s) => s.shopDomain === BETA)!;
    expect(alpha.limit).toBe(9500);
    expect(alpha.bytesUsed).toBeGreaterThan(0);
    expect(alpha.headroom).toBe(9500 - alpha.bytesUsed);
    expect(alpha.nodeCount).toBe(2);
    expect(alpha.offerCount).toBeGreaterThanOrEqual(2);
    expect(alpha.perOffer[0]!.bytes).toBeGreaterThanOrEqual(alpha.perOffer[alpha.perOffer.length - 1]!.bytes);
    expect(alpha.live).toBeUndefined();
    expect(beta.nodeCount).toBe(0);
    expect(beta.bytesUsed).toBeGreaterThan(0);
    expect(beta.bytesUsed).toBeLessThan(alpha.bytesUsed);
    expect(alpha).toMatchObject({ plannedSlots: 1, maxCartSlots: 1, budget: null, blockedBy: null });
    expect(alpha.deliveryBytes).toBeGreaterThanOrEqual(0);
  });

  it("reports the planned slots and live budget when sharding is on", async () => {
    const budget = { storeActive: 9, ours: 3, others: 6, maxCartSlots: 7 };
    const result = await discountCapacity(db, visible, { shops: [ALPHA] }, undefined, {
      capacity: { shardsEnabled: true, loadBudget: async () => budget },
    });
    expect(result.data.shops[0]).toMatchObject({ plannedSlots: 1, maxCartSlots: 7, budget: { storeActive: 9, ours: 3, others: 6 } });
  });

  it("explains a single node forced by offers that do not combine with product discounts", async () => {
    const domain = "combo.myshopify.com";
    const shopId = await insertShop(domain);
    const names = ["No combine A", "No combine B"];
    for (const [i, name] of names.entries()) {
      const offerId = await seedOffer(db, shopId, { type: "gift", status: "active", internalName: name, priority: i, requiresCode: false });
      await db.insert(offerRewards).values({ shopId, offerId, rewardType: "product_gift", discountType: "free", value: {}, target: { variantIds: [V1] }, quantity: 1 });
      await db.insert(offerCombinationPolicies).values({ shopId, offerId, combinesWithProductDiscounts: false });
    }
    const only = await visibleShops(db, operator([domain]));
    const budget = { storeActive: 9, ours: 3, others: 6, maxCartSlots: 11 };
    const result = await discountCapacity(db, only, {}, undefined, { capacity: { shardsEnabled: true, domainsEnabled: false, loadBudget: async () => budget } });
    const row = result.data.shops[0]!;
    expect(row).toMatchObject({ plannedSlots: 1, maxCartSlots: 11, singleShardReason: "combination" });
    expect(row.combinationBlockers.map((b) => b.name)).toEqual(names);
    expect(result.summary).toContain("slots 1/11 (single node: 2 offers don't combine with product discounts: No combine A, No combine B)");
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "CAPACITY_SINGLE_SHARD", severity: "warn" }));

    const off = await discountCapacity(db, only, {}, undefined, { capacity: { shardsEnabled: false } });
    expect(off.data.shops[0]!.singleShardReason).toBe("flag_off");
    expect(off.warnings.some((w) => w.code === "CAPACITY_SINGLE_SHARD")).toBe(false);
  });

  it("reports a sharded shop per slot, reads every shard node live and flags drift only on the node that changed", async () => {
    const domain = "sharded.myshopify.com";
    const shopId = await insertShop(domain, { discountId: "gid://shopify/DiscountAutomaticNode/10", deliveryDiscountId: "gid://shopify/DiscountAutomaticNode/11" });
    let variant = 1000;
    for (let i = 0; i < 8; i++) {
      const offerId = await seedOffer(db, shopId, { type: "gift", status: "active", internalName: `Heavy ${i}`, priority: i, requiresCode: false });
      await db.insert(offerConditions).values({ shopId, offerId, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 1000, currencyCode: "USD" } });
      await db.insert(offerRewards).values({
        shopId, offerId, rewardType: "product_gift", discountType: "free", value: {},
        target: { variantIds: Array.from({ length: 60 }, () => `gid://shopify/ProductVariant/${++variant}`) }, quantity: 1,
      });
    }
    const only = await visibleShops(db, operator([domain]));
    const capacity = { shardsEnabled: true, loadBudget: async () => ({ storeActive: 9, ours: 3, others: 6, maxCartSlots: 11 }) };
    const result = await discountCapacity(db, only, {}, undefined, { capacity });
    const row = result.data.shops[0]!;
    const n = row.plannedSlots!;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(row.slots).toHaveLength(n);
    expect(row.slots!.map((s) => s.index)).toEqual([...Array(n).keys()]);
    expect(row.slots!.every((s) => s.bytes <= 9500 && s.offerCount > 0)).toBe(true);
    expect(row.bytesUsed).toBe(Math.max(...row.slots!.map((s) => s.bytes)));
    expect(row.headroom).toBe(11 * 9500 - row.slots!.reduce((sum, s) => sum + s.bytes, 0));
    expect(row.risk).toBe("ok");
    expect(result.warnings.map((w) => w.code)).not.toContain("CAPACITY_EXCEEDED");
    expect(result.summary).toContain("per slot: #0");

    const value = (slot: number) => JSON.stringify({ offers: [], slot });
    const nodeId = (slot: number) => (slot === 0 ? "gid://shopify/DiscountAutomaticNode/10" : `gid://shopify/DiscountAutomaticNode/${100 + slot}`);
    await db.insert(discountShards).values(
      Array.from({ length: n }, (_, slot) => ({ shopId, kind: "cart" as const, slot, discountNodeId: nodeId(slot), unitKeys: [], configBytes: value(slot).length, configHash: configHash(value(slot)) })),
    );
    let live: Record<string, string> = Object.fromEntries(Array.from({ length: n }, (_, slot) => [nodeId(slot), value(slot)]));
    const graphQL = vi.fn(async (options: unknown) => {
      const ids = (options as { variables: { ids: string[] } }).variables.ids;
      return { nodes: ids.map((id) => (live[id] ? { id, metafield: { value: live[id]! } } : { id, metafield: null })) };
    });
    const deps = { capacity, graphQL: graphQL as never, decrypt: async () => "t" };

    const clean = await discountCapacity(db, only, { live: true }, undefined, deps);
    const cleanRow = clean.data.shops[0]!;
    expect(cleanRow.nodeCount).toBe(n + 1);
    expect(cleanRow.live!.nodes.filter((node) => node.role === "cart")).toHaveLength(n);
    expect(cleanRow.live!.nodes.some((node) => node.drifted)).toBe(false);
    expect(cleanRow.live!.driftBytes).toBe(0);
    expect(clean.warnings.map((w) => w.code)).not.toContain("LIVE_DRIFT");

    live = { ...live, [nodeId(1)]: JSON.stringify({ offers: [], slot: 1, changed: true }) };
    const drifted = await discountCapacity(db, only, { live: true }, undefined, deps);
    expect(drifted.data.shops[0]!.live!.nodes.filter((node) => node.drifted).map((node) => node.slot)).toEqual([1]);
    expect(drifted.warnings.map((w) => w.code)).toContain("LIVE_DRIFT");
  });

  it("live:true reads the metafield through the injected Admin client and reports drift; no token reaches the output", async () => {
    const graphQL = vi.fn(async (_options: unknown) => ({ nodes: [{ id: "n1", metafield: { value: "x".repeat(1234) } }, { id: "n2", metafield: null }] }));
    const decrypt = vi.fn(async (stored: string) => `plain:${stored}`);
    const result = track(await discountCapacity(db, visible, { shops: [ALPHA], live: true }, undefined, { graphQL: graphQL as never, decrypt }));
    const alpha = result.data.shops[0]!;
    expect(graphQL).toHaveBeenCalledTimes(1);
    const call = graphQL.mock.calls[0]![0] as { accessToken: string; shopDomain: string };
    expect(call).toMatchObject({ accessToken: `plain:${SECRET_TOKEN}`, shopDomain: ALPHA });
    expect(alpha.live).toMatchObject({ checked: true, nodes: [{ role: "cart", found: true, bytes: 1234 }, { role: "delivery", found: false, bytes: null }] });
    expect(alpha.live!.driftBytes).toBe(1234 - alpha.bytesUsed);
    expect(JSON.stringify(result)).not.toContain("plain:");
  });

  it("live check failures degrade to a warning and keep the computed numbers", async () => {
    const graphQL = vi.fn(async () => {
      throw new Error("boom token=abc");
    });
    const result = track(await discountCapacity(db, visible, { shops: [ALPHA], live: true }, undefined, { graphQL: graphQL as never, decrypt: async () => "t" }));
    const alpha = result.data.shops[0]!;
    expect(alpha.bytesUsed).toBeGreaterThan(0);
    expect(alpha.live).toMatchObject({ checked: false });
    expect(JSON.stringify(result)).not.toContain("token=abc");
    expect(result.warnings.map((w) => w.code)).toContain("LIVE_CHECK_FAILED");
  });

  it("a shop without discount nodes reports checked:false on live without calling Shopify", async () => {
    const graphQL = vi.fn();
    const result = await discountCapacity(db, visible, { shops: [BETA], live: true }, undefined, { graphQL: graphQL as never, decrypt: async () => "t" });
    expect(graphQL).not.toHaveBeenCalled();
    expect(result.data.shops[0]!.live).toMatchObject({ checked: false });
  });
});

describe("output contract", () => {
  it("no tool output contains PII keys, tokens or store secrets", () => {
    expect(everything.length).toBeGreaterThan(10);
    const text = JSON.stringify(everything);
    for (const forbidden of ["customerId", "customer_id", "sessionId", "session_id", "cartToken", "cart_token", "orderId", "order_id", "accessToken", "access_token", SECRET_TOKEN, "@merchant.com", "x@y.com"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/"(email|ip|ipAddress)"\s*:/);
  });

  it("every result has the ToolResult shape", () => {
    for (const result of everything as Array<Record<string, unknown>>) {
      expect(typeof result["summary"]).toBe("string");
      expect(result["data"]).toBeDefined();
      expect(Array.isArray(result["links"])).toBe(true);
      expect(Array.isArray(result["warnings"])).toBe(true);
      expect(Array.isArray(result["nextActions"])).toBe(true);
      expect(typeof (result["meta"] as { generatedAt: string }).generatedAt).toBe("string");
    }
  });
});

describe("registered over the MCP route", () => {
  const env = { MCP_ENABLED: "true", MCP_TOKEN_PEPPER: "test-pepper-0123456789" } as NodeJS.ProcessEnv;
  const rpc = async (pat: string, body: unknown) => {
    const res = await handleMcpRequest(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${pat}` },
        body: JSON.stringify(body),
      }),
      { db, env, rateLimit: async () => ({ ok: true }) },
    );
    return res.json();
  };

  it("exposes the eight catalog tools as read-only and honours the operator allow list end to end", async () => {
    const { pat } = await createOperatorWithPat(db, { email: "v@example.com", name: "V", role: "viewer", shopAllowList: [BETA] }, env);
    const list = await rpc(pat, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = list.result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    for (const name of ["promos_active", "promo_detail", "gifts_rules", "bundles_list", "upsells_list", "codes_list", "page_conditions_explain", "discount_capacity"]) {
      expect(tools.find((t) => t.name === name)?.annotations.readOnlyHint, name).toBe(true);
    }
    const call = await rpc(pat, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "promos_active", arguments: {} } });
    expect(call.result.isError).toBeFalsy();
    const domains = (call.result.structuredContent.data.promos as Array<{ shopDomain: string }>).map((p) => p.shopDomain);
    expect(domains.length).toBeGreaterThan(0);
    expect(new Set(domains)).toEqual(new Set([BETA]));

    const denied = await rpc(pat, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "promo_detail", arguments: { ref: `promo:alpha:${offerIds["gift"]}` } } });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.structuredContent.code).toBe("SHOP_NOT_FOUND");
    const invalid = await rpc(pat, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "promos_active", arguments: { limit: 1000 } } });
    expect(invalid.result.isError).toBe(true);
  });
});
