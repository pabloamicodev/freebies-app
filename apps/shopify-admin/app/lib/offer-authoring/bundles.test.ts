import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { bundleDefinitions, bundleSteps, bundleTiers, offerRewards, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../test-support/pglite-db.js";
import {
  BUNDLE_OFFER_ID_PLACEHOLDER,
  bundleAfterInsert,
  bundleCombinationPolicy,
  bundleMainCondition,
  toStoredBundleRewards,
  type AuthoringBundleReward,
} from "./bundles.js";
import type { AuthoringDeps } from "./types.js";

let db: Db;
let close: () => Promise<void>;
let deps: AuthoringDeps;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const shopId = await seedShop(db);
  deps = { db, shopId, shopDomain: "test-shop.myshopify.com", shopCurrency: "USD", timezone: "UTC" };
}, 60_000);
afterAll(async () => {
  await close();
});

const P1 = "gid://shopify/Product/101";
const P2 = "gid://shopify/Product/102";
const V1 = "gid://shopify/ProductVariant/201";

async function create(input: AuthoringBundleReward) {
  const stored = await toStoredBundleRewards([input], deps);
  if (!stored.ok) throw new Error(stored.error);
  const offerId = await seedOffer(db, deps.shopId, { type: "bundle" });
  await db.transaction(async (tx) => {
    await tx.insert(offerRewards).values({ shopId: deps.shopId, offerId, ...stored.value[0]! } as never);
    await bundleAfterInsert([input], deps)(tx, offerId);
  });
  const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId));
  const [def] = await db.select().from(bundleDefinitions).where(eq(bundleDefinitions.offerId, offerId));
  const steps = await db.select().from(bundleSteps).where(eq(bundleSteps.bundleId, def!.id)).orderBy(asc(bundleSteps.sortOrder));
  const tiers = await db.select().from(bundleTiers).where(eq(bundleTiers.bundleId, def!.id)).orderBy(asc(bundleTiers.sortOrder));
  return { offerId, reward: reward!, def: def!, steps, tiers };
}

describe("classic bundle", () => {
  it("stores what the wizard stores (bundle.$template.tsx:333-350 reward, :353-365 definition, :380-393 step, :451-468 tiers)", async () => {
    const { offerId, reward, def, steps, tiers } = await create({
      kind: "bundle_discount",
      bundleType: "classic",
      title: "Buy 2 save",
      products: [P1, P2],
      tiers: [
        { minQuantity: 2, maxQuantity: 3, discountType: "percentage", value: 10, label: "Two" },
        { minQuantity: 4, discountType: "fixed_amount", value: 5, label: "Four" },
      ],
    });
    expect(reward.rewardType).toBe("bundle_discount");
    expect(reward.discountType).toBe("percentage");
    expect(reward.value).toEqual({
      amount: 0,
      currencyCode: "USD",
      tiers: [
        { minimumQuantity: 2, maximumQuantity: 3, discountType: "percentage", discountValue: 10, label: "Two" },
        { minimumQuantity: 4, discountType: "fixed_amount", discountValue: 5, label: "Four" },
      ],
    });
    expect(reward.target).toEqual({
      scopeMode: "tagged_offer",
      requiredOfferId: offerId,
      scope: "cart",
      productIds: [P1, P2],
      variantIds: [],
    });
    expect([reward.isAutoAdd, reward.isCustomerSelectable, reward.trackMode, reward.sortOrder]).toEqual([false, false, "product", 0]);
    expect(def).toMatchObject({ bundleType: "classic", title: "Buy 2 save", layoutMode: "all_steps_one_page", createBundleProduct: false, config: { productLevel: "product" } });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ title: "Step 1 — Select products", sourceType: "products", sourceConfig: { productGids: [P1, P2] }, minQuantity: 1, maxQuantity: null, searchEnabled: false });
    expect(tiers.map((t) => [t.minQuantity, t.maxQuantity, t.label, t.discountType, t.value])).toEqual([
      [2, 3, "Two", "percentage", { amount: 10, currencyCode: "USD" }],
      [4, null, "Four", "fixed_amount", { amount: 5, currencyCode: "USD" }],
    ]);
  });

  it("falls back to one tier from discountType/discountValue and reads numeric ids by product level", async () => {
    const { reward, tiers, def } = await create({
      kind: "bundle_discount",
      bundleType: "classic",
      title: "Variant bundle",
      productLevel: "variant",
      products: ["201"],
      discountValue: 15,
    });
    // wizard :243-253: single tier at max(1, step minQty) labelled with the public title
    expect(tiers.map((t) => [t.minQuantity, t.label, t.value])).toEqual([[1, "Variant bundle", { amount: 15, currencyCode: "USD" }]]);
    expect(reward.target).toMatchObject({ productIds: [], variantIds: [V1] });
    expect(reward.trackMode).toBe("variant");
    expect(def.config).toEqual({ productLevel: "variant" });
  });

  it("main condition is cart_quantity gte the smallest tier (wizard :308-320) and policy defaults match :367-376", async () => {
    const main = bundleMainCondition(
      [{ kind: "bundle_discount", bundleType: "classic", products: [P1], tiers: [{ minQuantity: 3, discountType: "percentage", value: 5 }, { minQuantity: 2, discountType: "percentage", value: 1 }] }],
      deps,
    );
    expect(main).toEqual({
      ok: true,
      value: { scope: "main", conditionType: "cart_quantity", operator: "gte", value: { minQuantity: 2, includeGiftValues: false }, sortOrder: 0, isEnabled: true },
    });
    expect(bundleCombinationPolicy({ combinesWithOrderDiscounts: false, combinesWithShippingDiscounts: false })).toEqual({
      combinesWithOrderDiscounts: false,
      combinesWithProductDiscounts: true,
      combinesWithShippingDiscounts: false,
      combinesWithOtherAppOffers: true,
      stopLowerPriority: false,
      giftValueCountsForOtherOffers: false,
    });
  });
});

describe("mix & match", () => {
  it("one step per mix item with Mix item N titles (wizard :394-412)", async () => {
    const { steps, def, reward, tiers } = await create({
      kind: "bundle_discount",
      bundleType: "mix_match",
      title: "Mix",
      steps: [{ products: [P1], minQuantity: 2 }, { products: [P2, V1], minQuantity: 1 }],
      discountType: "percentage",
      discountValue: 20,
    });
    expect(def.layoutMode).toBe("all_steps_one_page");
    expect(steps.map((s) => [s.title, s.sourceConfig, s.minQuantity, s.searchEnabled, s.sortOrder])).toEqual([
      ["Mix item 1", { productGids: [P1] }, 2, false, 0],
      ["Mix item 2", { productGids: [P2, V1] }, 1, false, 1],
    ]);
    expect(reward.target).toMatchObject({ productIds: [P1, P2], variantIds: [V1] });
    expect(tiers.map((t) => t.minQuantity)).toEqual([2]);
  });

  it("adds the placeholder step when no steps are given (wizard :414-429)", async () => {
    const { steps } = await create({ kind: "bundle_discount", bundleType: "mix_match", title: "Empty mix", discountValue: 5 });
    expect(steps.map((s) => [s.title, s.sourceConfig, s.minQuantity])).toEqual([["Mix item 1", { productGids: [] }, 1]]);
  });
});

describe("bundle page", () => {
  it("searchable Step N rows and layoutMode (wizard :361, :430-447)", async () => {
    const { steps, def } = await create({
      kind: "bundle_discount",
      bundleType: "bundle_page",
      title: "Page",
      layoutMode: "one_step_per_page",
      steps: [{ products: [P1], minQuantity: 1 }, { products: [P2], minQuantity: 3 }],
      discountValue: 10,
    });
    expect(def.layoutMode).toBe("one_step_per_page");
    expect(steps.map((s) => [s.title, s.minQuantity, s.searchEnabled])).toEqual([["Step 1", 1, true], ["Step 2", 3, true]]);
  });

  it("landing mode stores a landing target with price tiers and anchors and keeps no tagged offer id", async () => {
    const { reward } = await create({
      kind: "bundle_discount",
      bundleType: "bundle_page",
      title: "Landing",
      products: [P1],
      discountValue: 10,
      landing: {
        requiredLineAttributeValue: "spring",
        anchorVariantIds: [V1],
        anchorMinQuantity: 1,
        requiresAnchorSubscription: false,
        priceTiers: [{ quantity: 2, targetPricePerUnit: 24.5 }],
        requiredLineAttribute: { key: "__bundle_type", value: "mix" },
      },
    });
    expect(reward.target).toEqual({
      scopeMode: "landing",
      scope: "cart",
      productIds: [P1],
      variantIds: [],
      requiredLineAttributeKey: "__landing_source",
      requiredLineAttributeValue: "spring",
      requiredAnchorVariantIds: [V1],
      requiredAnchorMinQuantity: 1,
      requiresAnchorSubscription: false,
      priceTiers: [{ quantity: 2, targetPricePerUnit: 24.5 }],
      requiredLineAttribute: { key: "__bundle_type", value: "mix" },
    });
  });
});

describe("validation (wizard messages)", () => {
  const run = (input: AuthoringBundleReward) => toStoredBundleRewards([input], deps);
  it("rejects publish with no products or no positive discount", async () => {
    expect(await run({ kind: "bundle_discount", bundleType: "classic", forPublish: true, discountValue: 10 })).toMatchObject({ ok: false, error: "Select at least one bundle product before publishing." });
    expect(await run({ kind: "bundle_discount", bundleType: "classic", forPublish: true, products: [P1] })).toMatchObject({ ok: false, error: "Configure a positive bundle discount before publishing." });
    expect(await run({ kind: "bundle_discount", bundleType: "classic", forPublish: true, products: [P1], discountType: "fixed_price", discountValue: 0 })).toMatchObject({ ok: true });
  });
  it("rejects max < min, percentage > 100 and bad ids", async () => {
    expect(await run({ kind: "bundle_discount", bundleType: "classic", products: [P1], tiers: [{ minQuantity: 3, maxQuantity: 2, discountType: "percentage", value: 5 }] })).toMatchObject({ ok: false, error: "Every maximum bundle quantity must be greater than or equal to its minimum." });
    expect(await run({ kind: "bundle_discount", bundleType: "classic", products: [P1], tiers: [{ minQuantity: 1, discountType: "percentage", value: 120 }] })).toMatchObject({ ok: false });
    expect(await run({ kind: "bundle_discount", bundleType: "classic", products: ["my-handle"] })).toMatchObject({ ok: false, error: "Every bundle target must be a valid Shopify product or variant GID." });
  });
  it("rejects more than one bundle reward and uses the placeholder offer id before insert", async () => {
    const one: AuthoringBundleReward = { kind: "bundle_discount", bundleType: "classic", products: [P1], discountValue: 5 };
    expect(await toStoredBundleRewards([one, one], deps)).toMatchObject({ ok: false });
    const stored = await run(one);
    expect(stored.ok && stored.value[0]!.target).toMatchObject({ requiredOfferId: BUNDLE_OFFER_ID_PLACEHOLDER });
  });
});
