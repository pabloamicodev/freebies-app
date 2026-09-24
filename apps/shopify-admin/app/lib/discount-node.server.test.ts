import { describe, expect, it } from "vitest";
import {
  CART_FUNCTION_TITLE,
  DELIVERY_FUNCTION_TITLE,
  selectFunctionId,
} from "./discount-node.server.js";

describe("selectFunctionId", () => {
  const functions = [
    { id: "gid://shopify/ShopifyFunction/cart", apiType: "discount", title: CART_FUNCTION_TITLE },
    { id: "gid://shopify/ShopifyFunction/delivery", apiType: "shipping_discounts", title: DELIVERY_FUNCTION_TITLE },
    { id: "gid://shopify/ShopifyFunction/other", apiType: "discount", title: "Another Function" },
  ];

  it("selects each Function by its exact stable title", () => {
    expect(selectFunctionId(functions, CART_FUNCTION_TITLE)).toBe(functions[0]!.id);
    expect(selectFunctionId(functions, DELIVERY_FUNCTION_TITLE)).toBe(functions[1]!.id);
  });

  it("never falls back to an unrelated discount Function", () => {
    expect(selectFunctionId(functions, "Missing Function")).toBeNull();
  });
});
