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
  conditions: Array<Omit<ConditionDefinition, "id" | "isEnabled">>;
  rewards: Array<Omit<RewardDefinition, "sortOrder"> & { sortOrder?: number }>;
}
interface Fixture {
  name: string;
  source: { offers: SourceOffer[] };
  config: { offers: ConfigOffer[] };
  cart: { currency: string; country: string | null; lines: FixtureLine[] };
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
  scopeMode?: string;
  requiredLineAttributeValue?: string;
  requiredAnchorVariantIds?: string[];
  requiredAnchorMinQuantity?: number;
  requiredOfferId?: string;
}
interface ConfigOffer {
  id: string;
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
    customer: null,
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
  return fixture.source.offers.map((offer) => ({
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
      maxApplicationsPerCart: null,
      maxApplicationsPerCustomer: null,
    },
    giftValueCountsForOtherOffers: false,
  }));
}

/** Units of each line the offer discounts, following the Function's targeting rules. */
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
  for (const reward of config.giftRewards ?? []) {
    const givenByProduct: Record<string, number> = {};
    // A picker (choose K of N) grants selectionCount x limit units across ALL its gifts; the lines
    // the shopper added first (cart order) get them.
    let remainingForReward = reward.selectable ? (reward.selectionCount ?? 1) * (reward.maxQuantity ?? 1) : Number.POSITIVE_INFINITY;
    for (const line of fixture.cart.lines) {
      if (line.lineType !== "gift") continue;
      const metadata = line.metadata ?? {};
      if (metadata["_promo_engine_offer_id"] !== offer.id || metadata["_promo_engine_reward_id"] !== reward.id) continue;
      const targets = reward.targetVariantIds ?? [];
      if (targets.length > 0 && !targets.includes(line.variantId)) continue;
      const given = givenByProduct[line.productId] ?? 0;
      const units = Math.min(line.quantity, (reward.maxQuantity ?? 1) - given, remainingForReward);
      if (units <= 0) continue;
      givenByProduct[line.productId] = given + units;
      remainingForReward -= units;
      result[line.id] = units;
    }
  }

  for (const reward of config.productRewards ?? []) {
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
    const limit = reward.maxQuantity ?? 1;
    const byVariant = (reward.targetVariantIds ?? []).length > 0;
    const given: Record<string, number> = {};
    let remainingTotal =
      reward.maxUnitsTotal ?? (setScoped ? Number.POSITIVE_INFINITY : (reward.maxQuantity ?? Number.POSITIVE_INFINITY));
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
    const result = await evaluate(toInput(fixture), { offers: toOffers(fixture), oneUseStates: [], now: NOW });
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
