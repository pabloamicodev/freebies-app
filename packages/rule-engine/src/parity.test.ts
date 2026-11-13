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
import { giftTierState } from "./gift-tiers.js";
import { propertiesOf, referenceDiscounts, type ReferenceConfigOffer, type ReferenceLine } from "./reference-discounts.js";

const DIR = fileURLToPath(new URL("../test-fixtures/parity/", import.meta.url));

interface FixtureLine extends ReferenceLine {
  volumeDiscountTiers?: Array<{ qty: number; percent: number }>;
}
interface SourceOffer {
  id: string;
  version: number;
  type: string;
  priority: number;
  stopLowerPriority: boolean;
  canStackWithGiftOffers?: boolean;
  tierMode?: "cumulative" | "highest";
  conditions: Array<Omit<ConditionDefinition, "id" | "isEnabled">>;
  rewards: Array<Omit<RewardDefinition, "sortOrder"> & { sortOrder?: number }>;
}
interface Fixture {
  name: string;
  source: { offers: SourceOffer[] };
  config: { offers: ConfigOffer[] };
  /** The shop currency when it differs from the cart currency (the cart's presentmentCurrencyRate is the exchange rate). */
  shopCurrency?: string;
  /** `customer`: absent or null is a guest; an object is an identified customer, `usage` its per-offer use counts. */
  cart: { currency: string; presentmentCurrencyRate?: number; country: string | null; lines: FixtureLine[]; customer?: { usage?: Record<string, number> } | null };
  expected: {
    qualifiedOfferIds: string[];
    discountedLineIds: Record<string, string[]>;
    discountedQuantities?: Record<string, Record<string, number>>;
  };
}
type ConfigOffer = ReferenceConfigOffer;

const fixtures: Fixture[] = readdirSync(DIR)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(`${DIR}${file}`, "utf8")) as Fixture);

const NOW = new Date("2026-06-01T12:00:00Z");

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
    ...(line.volumeDiscountTiers ? { volumeDiscountTiers: line.volumeDiscountTiers } : {}),
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
          ...(fixture.cart.presentmentCurrencyRate && fixture.cart.presentmentCurrencyRate !== 1 ? { exchangeRate: fixture.cart.presentmentCurrencyRate } : {}),
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
    ...(offer.tierMode ? { tierMode: offer.tierMode } : {}),
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

describe("golden parity fixtures", () => {
  it("has at least 15 fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(15);
  });

  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))("%s", async (_name, fixture) => {
    const result = await evaluate(toInput(fixture), { offers: toOffers(fixture), usageStates: usageStatesOf(fixture), now: NOW, ...(fixture.shopCurrency ? { shopCurrencyCode: fixture.shopCurrency } : {}) });
    expect(result.qualifiedOffers.map((offer) => offer.offerId).sort()).toEqual([...fixture.expected.qualifiedOfferIds].sort());

    const discountedLineIds: Record<string, string[]> = {};
    const discountedQuantities: Record<string, Record<string, number>> = {};
    for (const offerId of result.qualifiedOffers.map((offer) => offer.offerId)) {
      const source = fixture.source.offers.find((offer) => offer.id === offerId)!;
      // The Function skips gift rewards whose tier is not reached: take the locked set from the TS evaluator's own tier state.
      const tiers = giftTierState(
        toOffers(fixture).find((offer) => offer.id === offerId)!,
        toCart(fixture),
        { activeCurrencyCode: fixture.cart.currency, shopCurrencyCode: fixture.shopCurrency ?? fixture.cart.currency, exchangeRate: fixture.cart.presentmentCurrencyRate },
        new Set(fixture.config.offers.find((offer) => offer.id === offerId)?.excludedProductIds ?? []),
      );
      const units = referenceDiscounts(fixture.cart.lines, source, fixture.config.offers.find((offer) => offer.id === offerId)!, tiers?.unmetRewardIds);
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
