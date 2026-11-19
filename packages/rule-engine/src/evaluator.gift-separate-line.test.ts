/**
 * A gift is always its own line: a paid line of the same variant (bundle builder component) never fulfils the
 * reward, the offer adds its tagged gift line next to it, and that line leaves with the offer's qualification.
 */
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluator.js";
import type { EvaluationInput, NormalizedCart, NormalizedCartLine } from "@promo/shared-types";
import type { OfferDefinition } from "./evaluator.js";

const GREENS = "gid://shopify/ProductVariant/greens";
const OTHER = "gid://shopify/ProductVariant/other";
const NOW = new Date("2026-11-19T12:00:00Z");

const line = (
  key: string,
  variantId: string,
  priceCents: number,
  properties: Record<string, string> = {},
): NormalizedCartLine => ({
  key,
  variantId,
  productId: `gid://shopify/Product/${variantId.split("/").pop()}`,
  quantity: 1,
  priceCents,
  compareAtPriceCents: null,
  properties,
  requiresSellingPlan: false,
  sellingPlanId: null,
  productHandle: key,
  productTitle: key,
  variantTitle: null,
  vendor: "v",
  productType: "t",
  tags: [],
  collections: [],
  availableForSale: true,
  inventoryPolicy: "DENY",
  inventoryQuantity: 10,
});

const cartOf = (lines: NormalizedCartLine[]): NormalizedCart => ({
  token: "t",
  id: null,
  lines,
  subtotalCents: lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0),
  discountCodes: [],
  currencyCode: "USD",
  totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
});

const input = (cart: NormalizedCart): EvaluationInput => ({
  shopDomain: "test-store.myshopify.com",
  cart,
  customer: null,
  market: null,
  locale: "en",
  salesChannel: "online_store",
  requestedUrl: null,
  sessionId: "s",
});

const offer: OfferDefinition = {
  id: "gifts",
  version: 1,
  type: "gift",
  priority: 100,
  stopLowerPriority: false,
  startsAt: null,
  endsAt: null,
  conditions: [
    {
      id: "c1",
      scope: "main",
      conditionType: "cart_value",
      operator: "gte",
      value: { thresholdCents: 11000, currencyCode: "USD", includeGiftValues: false },
      isEnabled: true,
      sortOrder: 0,
    },
  ],
  rewards: [
    {
      id: "r-greens",
      rewardType: "product_gift",
      discountType: "free",
      value: { percentage: 100 },
      target: { variantIds: [GREENS] },
      quantity: 1,
      isAutoAdd: true,
      isCustomerSelectable: false,
      trackMode: "variant" as const,
      sortOrder: 0,
      label: null,
    },
  ],
  combinationPolicy: {
    combinesWithOrderDiscounts: true,
    combinesWithProductDiscounts: true,
    combinesWithShippingDiscounts: true,
    stopLowerPriority: false,
    maxApplicationsPerCart: null,
    maxApplicationsPerCustomer: null,
  },
  giftValueCountsForOtherOffers: false,
};

const actionsFor = async (lines: NormalizedCartLine[]) =>
  (await evaluate(input(cartOf(lines)), { offers: [offer], usageStates: [], now: NOW })).cartActions;

const builderGreens = line("paid", GREENS, 4999, { _bundle_item: "true", _bundle_id: "bb-1" });
const giftGreens = line("gift", GREENS, 4999, {
  _promo_engine_line_type: "gift",
  _promo_engine_offer_id: "gifts",
  _promo_engine_offer_version: "1",
  _promo_engine_reward_id: "r-greens",
});

describe("gift next to a paid line of the same variant", () => {
  it("adds its own tagged gift line instead of taking the paid bundle line", async () => {
    const actions = await actionsFor([builderGreens, line("rest", OTHER, 7500)]);
    expect(actions).toMatchObject([
      { action: "add_line", variantId: GREENS, quantity: 1, properties: { _promo_engine_line_type: "gift", _promo_engine_reward_id: "r-greens" } },
    ]);
  });

  it("adds nothing more once its gift line sits next to the paid one (no double gift, no loop)", async () => {
    expect(await actionsFor([builderGreens, line("rest", OTHER, 7500), giftGreens])).toEqual([]);
  });

  it("removes only the gift line when the paid total drops below the threshold", async () => {
    const actions = await actionsFor([builderGreens, line("rest", OTHER, 5000), giftGreens]);
    expect(actions).toMatchObject([{ action: "remove_line", lineKey: "gift", reason: "offer_disqualified" }]);
  });
});
