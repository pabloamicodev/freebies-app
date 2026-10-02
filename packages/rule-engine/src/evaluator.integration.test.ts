/**
 * Integration tests for the cart evaluator — full evaluation pipeline.
 * Tests cover: gift auto-add, gift removal on disqualification, priority,
 * stop-lower-priority, multiplier, customer targeting.
 */

import { describe, it, expect } from "vitest";
import { evaluate } from "./evaluator.js";
import type { EvaluationInput, NormalizedCart } from "@promo/shared-types";
import type { OfferDefinition, EvaluatorContext } from "./evaluator.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCart(
  subtotalCents: number,
  extra?: Partial<NormalizedCart>,
): NormalizedCart {
  return {
    token: "test-cart",
    id: null,
    lines: [
      {
        key: "line-1",
        variantId: "gid://shopify/ProductVariant/100",
        productId: "gid://shopify/Product/1",
        quantity: 1,
        priceCents: subtotalCents,
        compareAtPriceCents: null,
        properties: {},
        requiresSellingPlan: false,
        sellingPlanId: null,
        productHandle: "test-product",
        productTitle: "Test Product",
        variantTitle: null,
        vendor: "Test Vendor",
        productType: "apparel",
        tags: [],
        collections: [],
        availableForSale: true,
        inventoryPolicy: "DENY",
        inventoryQuantity: 10,
      },
    ],
    subtotalCents,
    discountCodes: [],
    currencyCode: "USD",
    totalQuantity: 1,
    ...extra,
  };
}

function makeInput(cart: NormalizedCart, overrides?: Partial<EvaluationInput>): EvaluationInput {
  return {
    shopDomain: "test-store.myshopify.com",
    cart,
    customer: null,
    market: null,
    locale: "en",
    salesChannel: "online_store",
    requestedUrl: null,
    sessionId: "test-session",
    ...overrides,
  };
}

function makeGiftOffer(id: string, thresholdCents: number, priority = 100, extra?: Partial<OfferDefinition>): OfferDefinition {
  return {
    id,
    version: 1,
    type: "gift",
    priority,
    stopLowerPriority: false,
    startsAt: null,
    endsAt: null,
    conditions: [
      {
        id: `cond-${id}`,
        scope: "main",
        conditionType: "cart_value",
        operator: "gte",
        value: { thresholdCents, currencyCode: "USD", includeGiftValues: false },
        isEnabled: true,
        sortOrder: 0,
      },
    ],
    rewards: [
      {
        id: `reward-${id}`,
        rewardType: "product_gift",
        discountType: "free",
        value: { percentage: 100 },
        target: { variantIds: [`gid://shopify/ProductVariant/gift-${id}`] },
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
    ...extra,
  };
}

const NOW = new Date("2026-06-01T12:00:00Z");

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("evaluate — cart value condition", () => {
  it("qualifies gift offer when cart meets threshold", async () => {
    const ctx: EvaluatorContext = {
      offers: [makeGiftOffer("offer-1", 5000)],
      oneUseStates: [],
      now: NOW,
    };
    const result = await evaluate(makeInput(makeCart(5000)), ctx);
    expect(result.qualifiedOffers).toHaveLength(1);
    expect(result.qualifiedOffers[0]?.offerId).toBe("offer-1");
  });

  it("disqualifies when cart is below threshold", async () => {
    const ctx: EvaluatorContext = {
      offers: [makeGiftOffer("offer-1", 5000)],
      oneUseStates: [],
      now: NOW,
    };
    const result = await evaluate(makeInput(makeCart(4999)), ctx);
    expect(result.qualifiedOffers).toHaveLength(0);
    expect(result.disqualifiedOffers).toHaveLength(1);
  });

  it("generates add_line action for auto-add gift", async () => {
    const ctx: EvaluatorContext = {
      offers: [makeGiftOffer("offer-1", 5000)],
      oneUseStates: [],
      now: NOW,
    };
    const result = await evaluate(makeInput(makeCart(6000)), ctx);
    expect(result.cartActions).toHaveLength(1);
    expect(result.cartActions[0]?.action).toBe("add_line");
    if (result.cartActions[0]?.action === "add_line") {
      expect(result.cartActions[0].variantId).toBe("gid://shopify/ProductVariant/gift-offer-1");
    }
  });

  it("does not auto-add a gift reward the customer explicitly declined", async () => {
    const ctx: EvaluatorContext = {
      offers: [makeGiftOffer("offer-1", 5000)],
      oneUseStates: [],
      now: NOW,
    };
    const result = await evaluate(
      makeInput(makeCart(6000), { declinedGiftRewards: ["offer-1:reward-offer-1"] }),
      ctx,
    );
    expect(result.qualifiedOffers).toHaveLength(1);
    expect(result.cartActions).toEqual([]);
  });

  it("still auto-adds a gift reward declined for a different offer", async () => {
    const ctx: EvaluatorContext = {
      offers: [makeGiftOffer("offer-1", 5000)],
      oneUseStates: [],
      now: NOW,
    };
    const result = await evaluate(
      makeInput(makeCart(6000), { declinedGiftRewards: ["offer-2:reward-offer-2"] }),
      ctx,
    );
    expect(result.cartActions).toHaveLength(1);
    expect(result.cartActions[0]?.action).toBe("add_line");
  });

  it("treats a merchant-configured fallback already in the cart as the fulfilled gift", async () => {
    const offer = makeGiftOffer("offer-1", 5000);
    offer.rewards[0] = {
      ...offer.rewards[0]!,
      target: {
        variantIds: ["gid://shopify/ProductVariant/gift-offer-1"],
        fallbackVariantIds: ["gid://shopify/ProductVariant/backup"],
      },
    };
    const base = makeCart(6000);
    const cart = makeCart(6000, {
      lines: [
        ...base.lines,
        {
          ...base.lines[0]!,
          key: "gift-line",
          variantId: "gid://shopify/ProductVariant/backup",
          priceCents: 0,
          properties: {
            _promo_engine_line_type: "gift",
            _promo_engine_offer_id: "offer-1",
            _promo_engine_reward_id: "reward-offer-1",
            _promo_engine_offer_version: "1",
          },
        },
      ],
    });
    const result = await evaluate(makeInput(cart), { offers: [offer], oneUseStates: [], now: NOW });
    // Neither removed as a tampered gift nor topped up with the sold-out primary.
    expect(result.cartActions).toEqual([]);
  });

  it("uses the slider for multi-variant gifts even if a legacy config says auto-add", async () => {
    const offer = makeGiftOffer("offer-1", 5000);
    offer.rewards[0] = {
      ...offer.rewards[0]!,
      target: {
        variantIds: [
          "gid://shopify/ProductVariant/201",
          "gid://shopify/ProductVariant/202",
        ],
      },
      isAutoAdd: true,
      isCustomerSelectable: false,
      quantity: 1,
    };
    const result = await evaluate(makeInput(makeCart(6000)), {
      offers: [offer],
      oneUseStates: [],
      now: NOW,
    });

    expect(result.cartActions.filter((action) => action.action === "add_line")).toHaveLength(0);
    expect(result.giftSlider?.selectableGifts).toHaveLength(2);
    expect(result.giftSlider?.selectableGifts[0]).toMatchObject({
      rewardId: "reward-offer-1",
      offerVersion: 1,
      rewardMaxQuantity: 1,
    });
  });

  it("lists merchant fallbacks as isFallback slider options after the primaries", async () => {
    const offer = makeGiftOffer("offer-1", 5000);
    offer.rewards[0] = {
      ...offer.rewards[0]!,
      target: {
        variantIds: ["gid://shopify/ProductVariant/201", "gid://shopify/ProductVariant/202"],
        // A fallback duplicating a primary is ignored.
        fallbackVariantIds: ["gid://shopify/ProductVariant/301", "gid://shopify/ProductVariant/202"],
      },
      isAutoAdd: false,
      isCustomerSelectable: true,
    };
    const result = await evaluate(makeInput(makeCart(6000)), { offers: [offer], oneUseStates: [], now: NOW });
    expect(result.giftSlider?.selectableGifts.map((g) => [g.variantId, !!g.isFallback])).toEqual([
      ["gid://shopify/ProductVariant/201", false],
      ["gid://shopify/ProductVariant/202", false],
      ["gid://shopify/ProductVariant/301", true],
    ]);
  });

  it("builds a picker per qualifying gift offer, each with its own fallback", async () => {
    const offers = ["offer-1", "offer-2"].map((id, i) => {
      const offer = makeGiftOffer(id, 5000);
      offer.rewards[0] = {
        ...offer.rewards[0]!,
        target: {
          variantIds: [`gid://shopify/ProductVariant/${i}01`, `gid://shopify/ProductVariant/${i}02`],
          fallbackVariantIds: [`gid://shopify/ProductVariant/${i}99`],
        },
        isAutoAdd: false,
        isCustomerSelectable: true,
      };
      return offer;
    });
    const result = await evaluate(makeInput(makeCart(6000)), { offers: offers, oneUseStates: [], now: NOW });
    expect([result.giftSlider, ...(result.additionalGiftSliders ?? [])].map((s) => s?.offerId)).toEqual(["offer-1", "offer-2"]);
    expect(result.additionalGiftSliders?.[0]?.selectableGifts.at(-1)).toMatchObject({
      variantId: "gid://shopify/ProductVariant/199",
      isFallback: true,
    });
    expect(result.giftSlider?.offerId).toBe("offer-1");
  });

  it("never builds a picker (primary or additional) for a code-gated offer whose code is absent", async () => {
    const gated = (id: string, code: string) => {
      const offer = makeGiftOffer(id, 5000);
      offer.rewards[0] = {
        ...offer.rewards[0]!,
        target: { variantIds: [`gid://shopify/ProductVariant/${id}-a`, `gid://shopify/ProductVariant/${id}-b`] },
        isAutoAdd: false,
        isCustomerSelectable: true,
      };
      offer.conditions.unshift({
        id: "code-gate",
        scope: "main",
        conditionType: "discount_code",
        operator: "eq",
        value: { code },
        isEnabled: true,
        sortOrder: -1,
      } as OfferDefinition["conditions"][number]);
      return offer;
    };
    const offers = [gated("offer-1", ""), gated("offer-2", "WELCOME")];
    const cart = makeCart(6000);
    const closed = await evaluate(makeInput(cart), { offers, oneUseStates: [], now: NOW });
    expect(closed.giftSlider).toBeNull();
    expect(closed.additionalGiftSliders ?? []).toEqual([]);
    expect(closed.qualifiedOffers).toEqual([]);

    const open = await evaluate(makeInput(cart, { cart: { ...cart, discountCodes: ["welcome"] } }), {
      offers,
      oneUseStates: [],
      now: NOW,
    });
    expect([open.giftSlider, ...(open.additionalGiftSliders ?? [])].map((s) => s?.offerId)).toEqual(["offer-2"]);
  });

  it("passes fallback variants on an auto-add so the runtime can retry a live sold-out add", async () => {
    const offer = makeGiftOffer("offer-1", 5000);
    offer.rewards[0] = {
      ...offer.rewards[0]!,
      target: {
        variantIds: ["gid://shopify/ProductVariant/gift-offer-1"],
        fallbackVariantIds: ["gid://shopify/ProductVariant/backup"],
      },
    };
    const result = await evaluate(makeInput(makeCart(6000)), { offers: [offer], oneUseStates: [], now: NOW });
    expect(result.cartActions[0]).toMatchObject({
      action: "add_line",
      variantId: "gid://shopify/ProductVariant/gift-offer-1",
      fallbackVariantIds: ["gid://shopify/ProductVariant/backup"],
    });
  });

  const giftLineWith = (overrides: Record<string, unknown>) => {
    const cart = makeCart(6000);
    cart.lines.push({
      ...cart.lines[0]!,
      key: "existing-gift",
      variantId: "gid://shopify/ProductVariant/gift-offer-1",
      productId: "gid://shopify/Product/999",
      priceCents: 2000,
      lineSubtotalCents: 2000,
      properties: {
        _promo_engine_line_type: "gift",
        _promo_engine_offer_id: "offer-1",
        _promo_engine_reward_id: "reward-offer-1",
        _promo_engine_offer_version: "1",
      },
      ...overrides,
    });
    return cart;
  };

  it("keeps a gift stamped with an older offer version (an offer edit must not churn gifts)", async () => {
    const cart = giftLineWith({
      properties: {
        _promo_engine_line_type: "gift",
        _promo_engine_offer_id: "offer-1",
        _promo_engine_reward_id: "reward-offer-1",
        _promo_engine_offer_version: "0",
      },
    });
    const result = await evaluate(makeInput(cart), { offers: [makeGiftOffer("offer-1", 5000)], oneUseStates: [], now: NOW });
    expect(result.cartActions.filter((action) => action.action === "remove_line" || action.action === "add_line")).toEqual([]);
  });

  it("removes a gift whose variant is no longer on the reward's allow-list", async () => {
    const cart = giftLineWith({ variantId: "gid://shopify/ProductVariant/not-allowed" });
    const result = await evaluate(makeInput(cart), { offers: [makeGiftOffer("offer-1", 5000)], oneUseStates: [], now: NOW });
    expect(result.cartActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "remove_line", lineKey: "existing-gift", reason: "stale_or_invalid_gift" }),
      expect.objectContaining({ action: "add_line", variantId: "gid://shopify/ProductVariant/gift-offer-1" }),
    ]));
  });

  it("generates remove_line when qualifying item is removed and gift is in cart", async () => {
    const giftLine = {
      key: "gift-key",
      variantId: "gid://shopify/ProductVariant/gift-offer-1",
      productId: "gift-product",
      quantity: 1,
      priceCents: 0,
      compareAtPriceCents: null,
      properties: {
        _promo_engine_line_type: "gift",
        _promo_engine_offer_id: "offer-1",
        _promo_engine_reward_id: "reward-offer-1",
        _promo_engine_offer_version: "1",
        _promo_engine_hash: "abc",
      },
      requiresSellingPlan: false,
      sellingPlanId: null,
      productHandle: "gift",
      productTitle: "Gift",
      variantTitle: null,
      vendor: "V",
      productType: "T",
      tags: [],
      collections: [],
      availableForSale: true,
      inventoryPolicy: "DENY" as const,
      inventoryQuantity: 5,
    };

    // Cart with only the gift line — no qualifying product
    const cartWithGiftOnly = makeCart(0, {
      lines: [giftLine],
      subtotalCents: 0,
    });

    const ctx: EvaluatorContext = {
      offers: [makeGiftOffer("offer-1", 5000)],
      oneUseStates: [],
      now: NOW,
    };

    const result = await evaluate(makeInput(cartWithGiftOnly), ctx);
    expect(result.qualifiedOffers).toHaveLength(0);
    const removeAction = result.cartActions.find((a) => a.action === "remove_line");
    expect(removeAction).toBeDefined();
  });

  it("fails closed when an offer contains an unsupported condition type", async () => {
    const offer = makeGiftOffer("offer-unsupported", 1000);
    offer.conditions.push({
      id: "cond-unsupported",
      scope: "sub",
      conditionType: "future_condition",
      operator: "eq",
      value: {},
      isEnabled: true,
      sortOrder: 1,
    });
    const ctx: EvaluatorContext = { offers: [offer], oneUseStates: [], now: NOW };

    const result = await evaluate(makeInput(makeCart(2000)), ctx);

    expect(result.qualifiedOffers).toHaveLength(0);
    expect(result.disqualifiedOffers).toHaveLength(1);
    expect(result.disqualifiedOffers[0]?.reasons).toContainEqual(
      expect.objectContaining({
        conditionType: "future_condition",
        passed: false,
      }),
    );
  });
});

describe("evaluate — schedule", () => {
  it("disqualifies expired offer", async () => {
    const expiredOffer = makeGiftOffer("offer-expired", 5000);
    expiredOffer.endsAt = new Date("2026-01-01T00:00:00Z"); // before NOW
    const ctx: EvaluatorContext = { offers: [expiredOffer], oneUseStates: [], now: NOW };
    const result = await evaluate(makeInput(makeCart(10000)), ctx);
    expect(result.qualifiedOffers).toHaveLength(0);
    const reason = result.disqualifiedOffers[0]?.reasons.find((r) => r.conditionType === "schedule");
    expect(reason?.passed).toBe(false);
  });

  it("disqualifies not-yet-started offer", async () => {
    const futureOffer = makeGiftOffer("offer-future", 5000);
    futureOffer.startsAt = new Date("2027-01-01T00:00:00Z"); // after NOW
    const ctx: EvaluatorContext = { offers: [futureOffer], oneUseStates: [], now: NOW };
    const result = await evaluate(makeInput(makeCart(10000)), ctx);
    expect(result.qualifiedOffers).toHaveLength(0);
  });
});

describe("evaluate — priority and stop-lower-priority", () => {
  it("applies both offers when no stop-lower-priority", async () => {
    const ctx: EvaluatorContext = {
      offers: [
        makeGiftOffer("offer-a", 5000, 10),
        makeGiftOffer("offer-b", 3000, 20),
      ],
      oneUseStates: [],
      now: NOW,
    };
    const result = await evaluate(makeInput(makeCart(6000)), ctx);
    expect(result.qualifiedOffers).toHaveLength(2);
  });

  it("blocks lower priority offer when higher has stop-lower-priority", async () => {
    const ctx: EvaluatorContext = {
      offers: [
        makeGiftOffer("offer-a", 5000, 10, { stopLowerPriority: true }),
        makeGiftOffer("offer-b", 3000, 20),
      ],
      oneUseStates: [],
      now: NOW,
    };
    const result = await evaluate(makeInput(makeCart(6000)), ctx);
    expect(result.qualifiedOffers).toHaveLength(1);
    expect(result.qualifiedOffers[0]?.offerId).toBe("offer-a");
  });
});

describe("evaluate — customer tag sub-condition", () => {
  it("qualifies when customer has required tag", async () => {
    const offer = makeGiftOffer("offer-vip", 1000, 100);
    offer.conditions.push({
      id: "cond-tags",
      scope: "sub",
      conditionType: "customer_tags",
      operator: "in",
      value: { includeTags: ["vip"], treatGuestAsNoTags: true },
      isEnabled: true,
      sortOrder: 1,
    });
    const ctx: EvaluatorContext = { offers: [offer], oneUseStates: [], now: NOW };
    const result = await evaluate(
      makeInput(makeCart(2000), {
        customer: {
          id: "c1", email: null, tags: ["vip"],
          totalSpentCents: 0, totalOrders: 1, lastOrderSpentCents: null,
          countryCode: null, isFirstTimeCustomer: false,
        },
      }),
      ctx,
    );
    expect(result.qualifiedOffers).toHaveLength(1);
  });

  it("disqualifies guest when tag is required", async () => {
    const offer = makeGiftOffer("offer-vip", 1000, 100);
    offer.conditions.push({
      id: "cond-tags",
      scope: "sub",
      conditionType: "customer_tags",
      operator: "in",
      value: { includeTags: ["vip"], treatGuestAsNoTags: true },
      isEnabled: true,
      sortOrder: 1,
    });
    const ctx: EvaluatorContext = { offers: [offer], oneUseStates: [], now: NOW };
    const result = await evaluate(makeInput(makeCart(2000)), ctx); // no customer
    expect(result.qualifiedOffers).toHaveLength(0);
  });
});

describe("evaluate — one-use-per-customer", () => {
  it("qualifies first-time user (usedCount: 0)", async () => {
    const offer = makeGiftOffer("offer-1use", 1000, 100);
    offer.conditions.push({
      id: "cond-1use",
      scope: "sub",
      conditionType: "one_use_per_customer",
      operator: "eq",
      value: {},
      isEnabled: true,
      sortOrder: 1,
    });
    const ctx: EvaluatorContext = {
      offers: [offer],
      oneUseStates: [{ offerId: "offer-1use", usedCount: 0 }],
      now: NOW,
    };
    const result = await evaluate(
      makeInput(makeCart(2000), {
        customer: {
          id: "c1", email: null, tags: [],
          totalSpentCents: 0, totalOrders: 1, lastOrderSpentCents: null,
          countryCode: null, isFirstTimeCustomer: false,
        },
      }),
      ctx,
    );
    expect(result.qualifiedOffers).toHaveLength(1);
  });

  it("disqualifies repeat user (usedCount: 1)", async () => {
    const offer = makeGiftOffer("offer-1use", 1000, 100);
    offer.conditions.push({
      id: "cond-1use",
      scope: "sub",
      conditionType: "one_use_per_customer",
      operator: "eq",
      value: {},
      isEnabled: true,
      sortOrder: 1,
    });
    const ctx: EvaluatorContext = {
      offers: [offer],
      oneUseStates: [{ offerId: "offer-1use", usedCount: 1 }],
      now: NOW,
    };
    const result = await evaluate(
      makeInput(makeCart(2000), {
        customer: {
          id: "c1", email: null, tags: [],
          totalSpentCents: 0, totalOrders: 2, lastOrderSpentCents: null,
          countryCode: null, isFirstTimeCustomer: false,
        },
      }),
      ctx,
    );
    expect(result.qualifiedOffers).toHaveLength(0);
  });
});

describe("evaluate — page_url matches the page lines were added from", () => {
  const offer = () => {
    const base = makeGiftOffer("landing", 1000);
    base.conditions.push({
      id: "cond-page",
      scope: "sub",
      conditionType: "page_url",
      operator: "eq",
      value: { patterns: ["/pages/landing"], matchMode: "contains", caseSensitive: false },
      isEnabled: true,
      sortOrder: 1,
    });
    return base;
  };
  const cartFrom = (page: string | null) => {
    const cart = makeCart(5000);
    if (page) cart.lines[0]!.properties = { _promo_page_url: page };
    return cart;
  };
  const ctx = (): EvaluatorContext => ({ offers: [offer()], oneUseStates: [], now: NOW });

  it("qualifies when a line was added from the landing, even after browsing away", async () => {
    const result = await evaluate(
      makeInput(cartFrom("https://shop.test/pages/landing"), { requestedUrl: "https://shop.test/cart" }),
      ctx(),
    );
    expect(result.qualifiedOffers).toHaveLength(1);
  });

  it("does not qualify just because the shopper is on the landing now", async () => {
    const result = await evaluate(
      makeInput(cartFrom(null), { requestedUrl: "https://shop.test/pages/landing" }),
      ctx(),
    );
    expect(result.qualifiedOffers).toHaveLength(0);
  });
});

describe("evaluate — page_types / utm_parameters scope / rejectUnmatchedLines", () => {
  const offerWith = (conditionType: string, value: Record<string, unknown>) => {
    const base = makeGiftOffer("page-ctx", 1000);
    base.conditions.push({
      id: "cond-page-ctx",
      scope: "sub",
      conditionType,
      operator: "eq",
      value,
      isEnabled: true,
      sortOrder: 1,
    });
    return base;
  };
  const cartWith = (...lineProperties: Array<Record<string, string>>) => {
    const cart = makeCart(5000);
    const template = cart.lines[0]!;
    cart.lines = lineProperties.map((properties, index) => ({
      ...template,
      key: `line-${index + 1}`,
      properties,
    }));
    return cart;
  };
  const qualifies = async (offer: OfferDefinition, cart: NormalizedCart) =>
    (await evaluate(makeInput(cart), { offers: [offer], oneUseStates: [], now: NOW })).qualifiedOffers
      .length === 1;

  it("page_types qualifies when any line was added from a selected page type", async () => {
    const offer = offerWith("page_types", { pageTypes: ["product"] });
    expect(await qualifies(offer, cartWith({ _promo_page_url: "/" }, { _promo_page_url: "/en/products/x" }))).toBe(true);
    expect(await qualifies(offer, cartWith({ _promo_page_url: "/" }))).toBe(false);
    expect(await qualifies(offer, cartWith({}))).toBe(false);
  });

  it("rejectUnmatchedLines requires every non-gift line to match", async () => {
    const offer = offerWith("page_types", { pageTypes: ["product"], rejectUnmatchedLines: true });
    expect(await qualifies(offer, cartWith({ _promo_page_url: "/" }, { _promo_page_url: "/products/x" }))).toBe(false);
    expect(await qualifies(offer, cartWith({ _promo_page_url: "/products/y" }, { _promo_page_url: "/products/x" }))).toBe(true);
    expect(await qualifies(offer, cartWith({ _promo_page_url: "/products/y" }, {}))).toBe(false);
  });

  it("utm_parameters reads the add page by default and the visit landing with scope visit", async () => {
    const landing = { _promo_page_url: "/products/x", _promo_landing_url: "/pages/lp?utm_source=amazon" };
    expect(await qualifies(offerWith("utm_parameters", { utmSource: "amazon" }), cartWith(landing))).toBe(false);
    expect(
      await qualifies(offerWith("utm_parameters", { utmSource: "amazon", scope: "visit" }), cartWith(landing)),
    ).toBe(true);
    expect(
      await qualifies(
        offerWith("utm_parameters", { utmSource: "amazon", scope: "visit" }),
        cartWith({ _promo_page_url: "/products/x?utm_source=amazon" }),
      ),
    ).toBe(false);
    expect(
      await qualifies(
        offerWith("utm_parameters", { utmSource: "amazon" }),
        cartWith({ _promo_page_url: "/products/x?utm_source=amazon" }),
      ),
    ).toBe(true);
  });
});

describe("evaluate — discount code condition (gate an automatic offer behind a real Shopify code)", () => {
  function offerWithDiscountCode(code: string): OfferDefinition {
    return makeGiftOffer("offer-1", 0, 100, {
      conditions: [
        {
          id: "cond-cart-value",
          scope: "main",
          conditionType: "cart_value",
          operator: "gte",
          value: { thresholdCents: 0, currencyCode: "USD", includeGiftValues: false },
          isEnabled: true,
          sortOrder: 0,
        },
        {
          id: "cond-discount-code",
          scope: "sub",
          conditionType: "discount_code",
          operator: "eq",
          value: { code },
          isEnabled: true,
          sortOrder: 1,
        },
      ],
    });
  }

  it("qualifies once the customer enters the configured code (case-insensitive)", async () => {
    const ctx: EvaluatorContext = { offers: [offerWithDiscountCode("PRIME2026")], oneUseStates: [], now: NOW };
    const cart = makeCart(1000, { discountCodes: ["prime2026"] });
    const result = await evaluate(makeInput(cart), ctx);
    expect(result.qualifiedOffers).toHaveLength(1);
  });

  it("does not qualify without the code, even if every other condition passes", async () => {
    const ctx: EvaluatorContext = { offers: [offerWithDiscountCode("PRIME2026")], oneUseStates: [], now: NOW };
    const result = await evaluate(makeInput(makeCart(1000)), ctx);
    expect(result.qualifiedOffers).toHaveLength(0);
  });

  it("does not qualify for an unrelated code — copying it onto another offer/page doesn't help", async () => {
    const ctx: EvaluatorContext = { offers: [offerWithDiscountCode("PRIME2026")], oneUseStates: [], now: NOW };
    const cart = makeCart(1000, { discountCodes: ["SUMMER2026"] });
    const result = await evaluate(makeInput(cart), ctx);
    expect(result.qualifiedOffers).toHaveLength(0);
  });
});

describe("evaluate � decisions D1/priority/location", () => {
  const countryOffer = () =>
    makeGiftOffer("loc", 1000, 100, {
      conditions: [
        ...makeGiftOffer("loc", 1000).conditions,
        { id: "c-loc", scope: "sub", conditionType: "customer_location", operator: "eq", value: { includeCountryCodes: ["US"] }, isEnabled: true, sortOrder: 1 },
      ],
    });
  const customer = (countryCode: string) => ({
    id: "c1", email: null, tags: [], totalSpentCents: 0, totalOrders: 0, lastOrderSpentCents: null, countryCode, isFirstTimeCustomer: true,
  });
  const market = (countryCode: string) => ({ id: "gid://shopify/Market/1", handle: "m", currencyCode: "USD", countryCode, primaryLocale: "en" });
  const run = async (input: EvaluationInput) =>
    (await evaluate(input, { offers: [countryOffer()], oneUseStates: [], now: NOW })).qualifiedOffers.length;

  it("customer_location uses the cart's market country over the customer's own", async () => {
    expect(await run(makeInput(makeCart(2000), { market: market("US"), customer: customer("CA") }))).toBe(1);
    expect(await run(makeInput(makeCart(2000), { market: market("CA"), customer: customer("US") }))).toBe(0);
    expect(await run(makeInput(makeCart(2000), { market: null, customer: customer("US") }))).toBe(1);
  });

  it("a stop-lower-priority offer blocks only strictly lower priority offers", async () => {
    const result = await evaluate(makeInput(makeCart(6000)), {
      offers: [
        makeGiftOffer("a", 1000, 10, { stopLowerPriority: true }),
        makeGiftOffer("b", 1000, 10),
        makeGiftOffer("c", 1000, 20),
      ],
      oneUseStates: [],
      now: NOW,
    });
    expect(result.qualifiedOffers.map((offer) => offer.offerId).sort()).toEqual(["a", "b"]);
  });

  it("page conditions are one gate: a single line must satisfy all of them", async () => {
    const offer = makeGiftOffer("combo", 0);
    offer.conditions = [
      { id: "p1", scope: "sub", conditionType: "page_types", operator: "eq", value: { pageTypes: ["product"] }, isEnabled: true, sortOrder: 0 },
      { id: "p2", scope: "sub", conditionType: "utm_parameters", operator: "eq", value: { utmSource: "amazon" }, isEnabled: true, sortOrder: 1 },
    ];
    const cartOf = (...pages: string[]) => {
      const cart = makeCart(5000);
      cart.lines = pages.map((url, index) => ({ ...cart.lines[0]!, key: `l${index}`, properties: { _promo_page_url: url } }));
      return cart;
    };
    const qualifies = async (cart: NormalizedCart) =>
      (await evaluate(makeInput(cart), { offers: [offer], oneUseStates: [], now: NOW })).qualifiedOffers.length === 1;
    expect(await qualifies(cartOf("/products/a", "/?utm_source=amazon"))).toBe(false);
    expect(await qualifies(cartOf("/products/a?utm_source=amazon"))).toBe(true);
  });
});

describe("evaluate — picker gift quantity reset", () => {
  const V1 = "gid://shopify/ProductVariant/pick-1";
  const V2 = "gid://shopify/ProductVariant/pick-2";
  const picker = (quantity: number) => {
    const offer = makeGiftOffer("pick", 1000);
    offer.rewards = [
      { ...offer.rewards[0]!, id: "reward-pick", target: { variantIds: [V1, V2] }, quantity, isAutoAdd: false, isCustomerSelectable: true },
    ];
    return offer;
  };
  const cartWith = (...gifts: Array<[string, string, number]>) => {
    const cart = makeCart(6000);
    for (const [key, variantId, quantity] of gifts) {
      cart.lines.push({
        ...cart.lines[0]!,
        key,
        variantId,
        quantity,
        properties: {
          _promo_engine_line_type: "gift",
          _promo_engine_offer_id: "pick",
          _promo_engine_reward_id: "reward-pick",
          _promo_engine_offer_version: "1",
        },
      });
    }
    return cart;
  };
  const actions = async (offer: OfferDefinition, cart: NormalizedCart) =>
    (await evaluate(makeInput(cart), { offers: [offer], oneUseStates: [], now: NOW })).cartActions.filter(
      (action) => action.action === "update_line" || action.action === "remove_line",
    );

  it("shrinks a picked gift raised above the limit and never removes it", async () => {
    expect(await actions(picker(1), cartWith(["g1", V1, 5]))).toEqual([
      expect.objectContaining({ action: "update_line", lineKey: "g1", quantity: 1 }),
    ]);
  });

  it("caps the picker's total at limit across its gifts, shrinking the later line only", async () => {
    expect(await actions(picker(3), cartWith(["g1", V1, 2], ["g2", V2, 3]))).toEqual([
      expect.objectContaining({ action: "update_line", lineKey: "g2", quantity: 1 }),
    ]);
  });

  it("leaves a valid pick within the limit alone", async () => {
    expect(await actions(picker(2), cartWith(["g1", V1, 2]))).toEqual([]);
    expect(await actions(picker(1), cartWith(["g1", V1, 1]))).toEqual([]);
  });
});
