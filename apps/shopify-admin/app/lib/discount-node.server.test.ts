import { describe, expect, it } from "vitest";
import {
  buildAutomaticDiscountCreateInput,
  buildAutomaticDiscountUpdateInput,
  CART_DISCOUNT_CLASSES,
  CART_FUNCTION_TITLE,
  DELIVERY_DISCOUNT_CLASSES,
  DELIVERY_FUNCTION_TITLE,
  selectFunctionId,
} from "./discount-node.server.js";

describe("selectFunctionId", () => {
  const functions = [
    {
      id: "gid://shopify/ShopifyFunction/cart",
      apiType: "discount",
      handle: "promo-engine-discount",
      title: CART_FUNCTION_TITLE,
    },
    {
      id: "gid://shopify/ShopifyFunction/delivery",
      apiType: "discount",
      handle: "promo-engine-delivery-discount",
      title: DELIVERY_FUNCTION_TITLE,
    },
    {
      id: "gid://shopify/ShopifyFunction/other",
      apiType: "discount",
      handle: "other",
      title: "Another Function",
    },
  ];

  it("selects each Function by its exact stable title", () => {
    expect(selectFunctionId(functions, CART_FUNCTION_TITLE)).toBe(functions[0]!.id);
    expect(selectFunctionId(functions, DELIVERY_FUNCTION_TITLE)).toBe(functions[1]!.id);
  });

  it("never falls back to an unrelated discount Function", () => {
    expect(selectFunctionId(functions, "Missing Function")).toBeNull();
  });
});

describe("automatic discount inputs", () => {
  const combinesWith = {
    orderDiscounts: true,
    productDiscounts: false,
    shippingDiscounts: true,
  };

  it("declares every effect emitted by the unified cart discount Function", () => {
    const input = buildAutomaticDiscountCreateInput(
      "promo-engine-discount",
      "Promo Engine",
      CART_DISCOUNT_CLASSES,
      "2026-09-24T12:00:00.000Z",
    );

    expect(input).toMatchObject({
      functionHandle: "promo-engine-discount",
      title: "Promo Engine",
      startsAt: "2026-09-24T12:00:00.000Z",
      discountClasses: ["PRODUCT", "ORDER"],
    });
  });

  it("keeps the shipping node constrained to the shipping class", () => {
    expect(buildAutomaticDiscountUpdateInput(combinesWith, DELIVERY_DISCOUNT_CLASSES)).toEqual({
      combinesWith,
      discountClasses: ["SHIPPING"],
    });
  });
});
