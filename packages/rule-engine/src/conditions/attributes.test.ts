import { describe, expect, it } from "vitest";
import type { NormalizedCart } from "@promo/shared-types";
import { evaluateCartAttribute, evaluateLineAttribute } from "./attributes.js";

const cart = {
  token: null, id: null, attributes: { source: "vip-landing" }, subtotalCents: 1000,
  discountCodes: [], currencyCode: "USD", totalQuantity: 2,
  lines: [{ key: "1", variantId: "v", productId: "p", quantity: 2, priceCents: 500, compareAtPriceCents: null, properties: { __bundle_type: "starter" }, requiresSellingPlan: false, sellingPlanId: null, productHandle: "p", productTitle: "P", variantTitle: null, vendor: "V", productType: "T", tags: [], collections: [], availableForSale: true, inventoryPolicy: "DENY", inventoryQuantity: 1 }],
} satisfies NormalizedCart;

describe("attribute conditions", () => {
  it("matches a registered line property and quantity", () => expect(evaluateLineAttribute(cart, { key: "__bundle_type", value: "starter", matchMode: "equals", minMatchingQuantity: 2 }).ok).toBe(true));
  it("supports negative line-property matches", () => expect(evaluateLineAttribute(cart, { key: "__bundle_type", value: "other", matchMode: "not_equals", minMatchingQuantity: 1 }).ok).toBe(true));
  it("matches a registered cart attribute", () => expect(evaluateCartAttribute(cart, { key: "source", value: "vip-landing", matchMode: "equals" }).ok).toBe(true));
  it("does not let gift-line properties satisfy a line attribute condition", () => {
    const paidLine = cart.lines[0]!;
    const giftOnly = {
      ...cart,
      lines: [{
        ...paidLine,
        properties: {
          ...paidLine.properties,
          _promo_engine_line_type: "gift",
          _promo_engine_offer_id: "offer-1",
          _promo_engine_reward_id: "reward-1",
          _promo_engine_offer_version: "1",
          _promo_engine_hash: "signed",
        },
      }],
    } satisfies NormalizedCart;

    expect(evaluateLineAttribute(giftOnly, {
      key: "__bundle_type",
      value: "starter",
      matchMode: "equals",
      minMatchingQuantity: 1,
    }).ok).toBe(false);
  });
});
