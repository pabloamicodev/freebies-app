/**
 * Runs every golden fixture in test-fixtures/parity through the TS side:
 *  - `qualifiedOfferIds` come from the real evaluator (fed the fixture's `source` offers);
 *  - `discountedLineIds` / `discountedQuantities` come from a small reference model of the
 *    Function's reward targeting, driven by the fixture's compiled `config` and the shared
 *    page matcher. The Rust side (WS-A1) runs the same files against the real Function.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EvaluationInput, NormalizedCart, NormalizedCartLine } from "@promo/shared-types";
import { evaluate, type ConditionDefinition, type OfferDefinition, type RewardDefinition } from "./evaluator.js";
import { lineMatchesPageConditions } from "./page-match.js";

const DIR = fileURLToPath(new URL("../test-fixtures/parity/", import.meta.url));

interface FixtureLine {
  id: string;
  variantId: string;
  productId: string;
  quantity: number;
  unitPrice: string;
  lineType: "gift" | "upsell" | null;
  metadata: Record<string, string> | null;
}
interface SourceOffer {
  id: string;
  version: number;
  type: string;
  priority: number;
  stopLowerPriority: boolean;
  canStackWithGiftOffers?: boolean;
  conditions: Array<Omit<ConditionDefinition, "id" | "isEnabled">>;
  rewards: Array<Omit<RewardDefinition, "sortOrder"> & { sortOrder?: number }>;
}
interface Fixture {
  name: string;
  source: { offers: SourceOffer[] };
  config: { offers: ConfigOffer[] };
  /** `customer`: absent or null is a guest; an object is an identified customer, `usage` its per-offer use counts. */
  cart: { currency: string; country: string | null; lines: FixtureLine[]; customer?: { usage?: Record<string, number> } | null };
  expected: {
    qualifiedOfferIds: string[];
    discountedLineIds: Record<string, string[]>;
    discountedQuantities?: Record<string, Record<string, number>>;
  };
}
interface ConfigReward {
  id: string;
  targetProductIds?: string[];
  targetVariantIds?: string[];
  maxQuantity?: number;
  selectable?: boolean;
  selectionCount?: number;
  maxUnitsTotal?: number;
  discountType?: string;
  discountValue?: number;
  quantityTiers?: Array<{ minimumQuantity: number; maximumQuantity?: number; discountedQuantity?: number }>;
  priceTiers?: Array<{ quantity: number }>;
  scopeMode?: string;
  requiredLineAttributeValue?: string;
  requiredAnchorVariantIds?: string[];
  requiredAnchorMinQuantity?: number;
  requiredOfferId?: string;
}
interface ConfigOffer {
  id: string;
  mpc?: number;
  mpu?: number;
  ri?: true;
  requirements?: Array<{ productId?: string; variantId?: string; trackMode: string; minQuantity: number }>;
  excludedProductIds?: string[];
  restrictToMatchedLines?: boolean;
  giftRewards?: ConfigReward[];
  productRewards?: ConfigReward[];
}

const fixtures: Fixture[] = readdirSync(DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(`${DIR}${file}`, "utf8")) as Fixture);

const NOW = new Date("2026-06-01T12:00:00Z");

function propertiesOf(line: FixtureLine): Record<string, string> {
  return { ...(line.metadata ?? {}), ...(line.lineType ? { _promo_engine_line_type: line.lineType } : {}) };
}

function toCart(fixture: Fixture): NormalizedCart {
  const lines: NormalizedCartLine[] = fixture.cart.lines.map((line) => ({
    key: line.id,
    variantId: line.variantId,
    productId: line.productId,
    quantity: line.quantity,
    priceCents: Math.round(Number(line.unitPrice) * 100),
    compareAtPriceCents: null,
    properties: propertiesOf(line),
    requiresSellingPlan: false,
    sellingPlanId: null,
    productHandle: "p",
    productTitle: "P",
    variantTitle: null,
    vendor: "v",
    productType: "t",
    tags: [],
    collections: [],
    availableForSale: true,
    inventoryPolicy: "DENY",
    inventoryQuantity: null,
  }));
  return {
    token: "t",
    id: null,
    lines,
    subtotalCents: lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0),
    discountCodes: [],
    currencyCode: fixture.cart.currency,
    totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}

function toInput(fixture: Fixture): EvaluationInput {
  return {
    shopDomain: "parity.myshopify.com",
    cart: toCart(fixture),
    customer: fixture.cart.customer
      ? {
          id: "gid://shopify/Customer/1",
          email: null,
          tags: [],
          totalSpentCents: 0,
          totalOrders: 0,
          lastOrderSpentCents: null,
          countryCode: null,
          isFirstTimeCustomer: false,
        }
      : null,
    market: fixture.cart.country
      ? {
          id: "gid://shopify/Market/1",
          handle: "m",
          currencyCode: fixture.cart.currency,
          countryCode: fixture.cart.country,
          primaryLocale: "en",
        }
      : null,
    locale: "en",
    salesChannel: "online_store",
    requestedUrl: null,
    sessionId: "parity",
  };
}

function toOffers(fixture: Fixture): OfferDefinition[] {
  return fixture.source.offers.map((offer) => {
    const limits = fixture.config.offers.find((candidate) => candidate.id === offer.id);
    return {
    id: offer.id,
    version: offer.version,
    type: offer.type,
    priority: offer.priority,
    stopLowerPriority: offer.stopLowerPriority,
    startsAt: null,
    endsAt: null,
    conditions: offer.conditions.map((condition, index) => ({ ...condition, id: `${offer.id}-c${index}`, isEnabled: true })),
    rewards: offer.rewards.map((reward, index) => ({ sortOrder: index, ...reward })),
    combinationPolicy: {
      combinesWithOrderDiscounts: true,
      combinesWithProductDiscounts: true,
      combinesWithShippingDiscounts: true,
      stopLowerPriority: offer.stopLowerPriority,
      canStackWithGiftOffers: offer.canStackWithGiftOffers ?? true,
      maxApplicationsPerCart: limits?.mpc ?? null,
      maxApplicationsPerCustomer: limits?.mpu ?? null,
      requireIdentifiedCustomer: limits?.ri === true,
    },
    giftValueCountsForOtherOffers: false,
    };
  });
}

const usageStatesOf = (fixture: Fixture) =>
  Object.entries(fixture.cart.customer?.usage ?? {}).map(([offerId, usedCount]) => ({ offerId, usedCount }));

const capByCart = (config: ConfigOffer, limit: number) => (config.mpc === undefined ? limit : Math.min(limit, config.mpc));

/** Units of each line the offer discounts, following the Function's targeting rules. */
/** Quiz bundles: complete groups in bundle-id order, at most mpc of them, every paid line of a group discounted. */
function quizBundles(fixture: Fixture, config: ConfigOffer, reward: ConfigReward, result: Record<string, number>): void {
  const groups = new Map<string, FixtureLine[]>();
  for (const line of fixture.cart.lines) {
    const id = line.metadata?.["_quiz_bundle_id"];
    if (id) groups.set(id, [...(groups.get(id) ?? []), line]);
  }
  let bundles = 0;
  for (const id of [...groups.keys()].sort()) {
    const paid = groups.get(id)!.filter((line) => line.metadata?.["_quiz_free_gift"] !== "true");
    const expected = Number(paid[0]?.metadata?.["_quiz_expected_paid_count"]);
    if (!(paid.length >= expected)) continue;
    if (config.mpc !== undefined && bundles >= config.mpc) break;
    bundles += 1;
    const current = paid.reduce((sum, line) => sum + Number(line.unitPrice) * line.quantity, 0);
    if (current - (reward.discountValue ?? 0) <= 0) continue;
    for (const line of paid) result[line.id] = line.quantity;
  }
}

function referenceDiscounts(fixture: Fixture, offer: SourceOffer): Record<string, number> {
  const config = fixture.config.offers.find((candidate) => candidate.id === offer.id)!;
  const excluded = new Set(config.excludedProductIds ?? []);
  const restrict = config.restrictToMatchedLines === true;
  const pageConditions = offer.conditions;
  const matches = (line: FixtureLine) => lineMatchesPageConditions(propertiesOf(line), pageConditions);
  const result: Record<string, number> = {};
  const nonGift = fixture.cart.lines.filter((line) => line.lineType !== "gift");

  // Every limit is the number of times a reward's gift SET is granted: each target product (each
  // target variant, for variant-targeted landing/tagged rewards) gets at most `limit` free units,
  // however high the shopper raises a quantity or however many anchors are present.
  const giftRewards = config.giftRewards ?? [];
  const givenByProduct: Record<string, Record<string, number>> = {};
  const remainingForReward: Record<string, number> = {};
  for (const reward of giftRewards) {
    givenByProduct[reward.id] = {};
    // A picker (choose K of N) grants selectionCount x limit units across ALL its gifts; the lines
    // the shopper added first (cart order) get them.
    remainingForReward[reward.id] = reward.selectable
      ? (reward.selectionCount ?? 1) * capByCart(config, reward.maxQuantity ?? 1)
      : Number.POSITIVE_INFINITY;
  }
  const grant = (line: FixtureLine, reward: ConfigReward, quantity: number): boolean => {
    const given = givenByProduct[reward.id]![line.productId] ?? 0;
    const units = Math.min(quantity, capByCart(config, reward.maxQuantity ?? 1) - given, remainingForReward[reward.id]!);
    if (units <= 0) return false;
    givenByProduct[reward.id]![line.productId] = given + units;
    remainingForReward[reward.id]! -= units;
    result[line.id] = units;
    return true;
  };
  const targetsVariant = (reward: ConfigReward, line: FixtureLine) =>
    (reward.targetVariantIds ?? []).length === 0 || reward.targetVariantIds!.includes(line.variantId);
  // Tagged lines claim the quota first, then untagged lines (a theme adding the gift itself) fill it.
  // Units that qualify the offer (anchor) never count, and an untagged line serves one reward only.
  for (const reward of giftRewards) {
    for (const line of fixture.cart.lines) {
      if (line.lineType !== "gift") continue;
      const metadata = line.metadata ?? {};
      if (metadata["_promo_engine_offer_id"] !== offer.id || metadata["_promo_engine_reward_id"] !== reward.id) continue;
      if (targetsVariant(reward, line)) grant(line, reward, line.quantity);
    }
  }
  for (const line of nonGift.filter((candidate) => !candidate.metadata?.["_promo_engine_offer_id"])) {
    const reserved = Math.max(
      0,
      ...(config.requirements ?? [])
        .filter((requirement) => (requirement.trackMode === "variant" ? requirement.variantId === line.variantId : requirement.productId === line.productId))
        .map((requirement) => requirement.minQuantity),
    );
    for (const reward of giftRewards) {
      if ((reward.targetVariantIds ?? []).includes(line.variantId) && grant(line, reward, line.quantity - reserved)) break;
    }
  }

  for (const reward of config.productRewards ?? []) {
    if (reward.scopeMode === "quiz_bundle") {
      quizBundles(fixture, config, reward, result);
      continue;
    }
    const landing = reward.scopeMode === "landing";
    const setScoped = landing || reward.scopeMode === "tagged_offer";
    if (landing) {
      const anchorQuantity = nonGift
        .filter((line) => line.metadata?.["__landing_source"] === reward.requiredLineAttributeValue)
        .filter((line) => (reward.requiredAnchorVariantIds ?? []).includes(line.variantId))
        .reduce((sum, line) => sum + line.quantity, 0);
      if (anchorQuantity < (reward.requiredAnchorMinQuantity ?? 1)) continue;
    }
    const eligible = nonGift
      .filter((line) => !excluded.has(line.productId))
      .filter((line) => !restrict || matches(line))
      .filter((line) => !landing || line.metadata?.["__landing_source"] === reward.requiredLineAttributeValue)
      .filter((line) => reward.scopeMode !== "tagged_offer" || line.metadata?.["_promo_engine_offer_id"] === reward.requiredOfferId)
      .filter((line) => {
        const products = reward.targetProductIds ?? [];
        const variants = reward.targetVariantIds ?? [];
        return (products.length === 0 && variants.length === 0) || products.includes(line.productId) || variants.includes(line.variantId);
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const total = eligible.reduce((sum, line) => sum + line.quantity, 0);
    const quantityTier = (reward.quantityTiers ?? [])
      .filter((tier) => total >= tier.minimumQuantity && (tier.maximumQuantity === undefined || total <= tier.maximumQuantity))
      .sort((a, b) => b.minimumQuantity - a.minimumQuantity)[0];
    const priceTier = (reward.priceTiers ?? []).filter((tier) => total >= tier.quantity).sort((a, b) => b.quantity - a.quantity)[0];
    if ((reward.quantityTiers ?? []).length > 0 && !quantityTier) continue;
    if ((reward.priceTiers ?? []).length > 0 && !priceTier) continue;
    const limit = capByCart(config, reward.maxQuantity ?? 1);
    const byVariant = (reward.targetVariantIds ?? []).length > 0;
    const given: Record<string, number> = {};
    let remainingTotal =
      quantityTier?.discountedQuantity ??
      reward.maxUnitsTotal ??
      (setScoped ? Number.POSITIVE_INFINITY : (reward.maxQuantity ?? Number.POSITIVE_INFINITY));
    // Per cart: one application is a unit, or one pack of the matched tier; set-scoped limits were capped above.
    if (config.mpc !== undefined && !setScoped) {
      const pack = quantityTier ? (quantityTier.discountedQuantity ?? quantityTier.minimumQuantity) : (priceTier?.quantity ?? 1);
      remainingTotal = Math.min(remainingTotal, config.mpc * pack);
    }
    for (const line of eligible) {
      const key = byVariant ? line.variantId : line.productId;
      let units = Math.min(line.quantity, remainingTotal);
      if (setScoped) units = Math.min(units, limit - (given[key] ?? 0));
      if (units <= 0) continue;
      given[key] = (given[key] ?? 0) + units;
      remainingTotal -= units;
      result[line.id] = (result[line.id] ?? 0) + units;
    }
  }
  return result;
}

describe("golden parity fixtures", () => {
  it("has at least 15 fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
  });

  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))("%s", async (_name, fixture) => {
    const result = await evaluate(toInput(fixture), { offers: toOffers(fixture), usageStates: usageStatesOf(fixture), now: NOW });
    expect(result.qualifiedOffers.map((offer) => offer.offerId).sort()).toEqual([...fixture.expected.qualifiedOfferIds].sort());

    const discountedLineIds: Record<string, string[]> = {};
    const discountedQuantities: Record<string, Record<string, number>> = {};
    for (const offerId of result.qualifiedOffers.map((offer) => offer.offerId)) {
      const units = referenceDiscounts(fixture, fixture.source.offers.find((offer) => offer.id === offerId)!);
      const lineIds = Object.keys(units).sort();
      if (lineIds.length > 0) discountedLineIds[offerId] = lineIds;
      discountedQuantities[offerId] = units;
    }
    expect(discountedLineIds).toEqual(
      Object.fromEntries(Object.entries(fixture.expected.discountedLineIds).map(([id, lines]) => [id, [...lines].sort()])),
    );
    for (const [offerId, quantities] of Object.entries(fixture.expected.discountedQuantities ?? {})) {
      expect(discountedQuantities[offerId]).toEqual(quantities);
    }
  });
});

/** Reference of the delivery Function's offer selection (delivery_discount_logic::run): blocked offers drop out, the best priority wins. */
function pickShippingOffer(
  offers: Array<{ id: string; priority: number; mpu?: number; ri?: true }>,
  usage: Record<string, number>,
  identified: boolean,
): string | undefined {
  return offers
    // Compiled shipping ids are `offerId:rewardId`; usage is keyed by the bare offer id.
    .filter((offer) => !(offer.ri && !identified) && !(offer.mpu !== undefined && (usage[offer.id.split(":")[0]!] ?? 0) >= offer.mpu))
    .sort((a, b) => a.priority - b.priority)[0]?.id;
}

describe("shipping usage limits (mirrors delivery_discount_logic tests)", () => {
  const offers = [
    { id: "limited:reward-1", priority: 1, mpu: 2 },
    { id: "fallback:reward-2", priority: 2 },
  ];
  it("an exhausted mpu falls through to the next-priority offer", () => {
    expect(pickShippingOffer(offers, { limited: 1 }, true)).toBe("limited:reward-1");
    expect(pickShippingOffer(offers, { limited: 2 }, true)).toBe("fallback:reward-2");
    expect(pickShippingOffer(offers, { limited: 5 }, true)).toBe("fallback:reward-2");
  });
  it("a guest and a missing key count as 0 uses; ri blocks a guest only", () => {
    expect(pickShippingOffer(offers, {}, false)).toBe("limited:reward-1");
    expect(pickShippingOffer([{ id: "vip", priority: 1, ri: true }], {}, false)).toBeUndefined();
    expect(pickShippingOffer([{ id: "vip", priority: 1, ri: true }], {}, true)).toBe("vip");
  });
});
