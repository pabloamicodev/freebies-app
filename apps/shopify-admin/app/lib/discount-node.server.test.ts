import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAutomaticDiscountCreateInput,
  buildAutomaticDiscountUpdateInput,
  buildCodeDiscountCreateInput,
  buildCodeDiscountUpdateInput,
  CART_DISCOUNT_CLASSES,
  CART_FUNCTION_TITLE,
  createOrFindCodeDiscount,
  DELIVERY_DISCOUNT_CLASSES,
  DELIVERY_FUNCTION_TITLE,
  formatDiscountUserErrors,
  selectFunctionId,
  updateCodeDiscountCombination,
} from "./discount-node.server.js";
import { shopifyGraphQL } from "./shopify-fetch.server.js";

vi.mock("./shopify-fetch.server.js", () => ({
  shopifyGraphQL: vi.fn(),
}));

const shopifyGraphQLMock = vi.mocked(shopifyGraphQL);

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

  it("uses Shopify's supported combination policy for a shipping-only automatic discount", () => {
    expect(buildAutomaticDiscountUpdateInput(combinesWith, DELIVERY_DISCOUNT_CLASSES)).toEqual({
      combinesWith: {
        orderDiscounts: true,
        productDiscounts: false,
        shippingDiscounts: false,
      },
      discountClasses: ["SHIPPING"],
    });
  });

  it("preserves same-class combination settings for the unified cart discount", () => {
    expect(buildAutomaticDiscountUpdateInput(combinesWith, CART_DISCOUNT_CLASSES)).toEqual({
      combinesWith,
      discountClasses: ["PRODUCT", "ORDER"],
    });
  });

  it("includes Shopify error codes and field paths in operational errors", () => {
    expect(
      formatDiscountUserErrors([
        {
          code: "INVALID_COMBINES_WITH_FOR_DISCOUNT_CLASS",
          field: ["automaticAppDiscount", "combinesWith", "shippingDiscounts"],
          message: "is not supported with these combines_with settings",
        },
      ]),
    ).toBe(
      "[INVALID_COMBINES_WITH_FOR_DISCOUNT_CLASS] automaticAppDiscount.combinesWith.shippingDiscounts: is not supported with these combines_with settings",
    );
  });
});

describe("code discount inputs", () => {
  it("carries the code and functionHandle into the create input", () => {
    const input = buildCodeDiscountCreateInput(
      "promo-engine-discount",
      "PRIMEDAY2026",
      "Prime Day",
      CART_DISCOUNT_CLASSES,
      "2026-09-24T12:00:00.000Z",
    );

    expect(input).toMatchObject({
      functionHandle: "promo-engine-discount",
      code: "PRIMEDAY2026",
      title: "Prime Day",
      startsAt: "2026-09-24T12:00:00.000Z",
      discountClasses: ["PRODUCT", "ORDER"],
      combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
    });
  });

  it("uses the same combination-policy normalization as the automatic update input", () => {
    const combinesWith = { orderDiscounts: true, productDiscounts: false, shippingDiscounts: true };
    expect(buildCodeDiscountUpdateInput(combinesWith, DELIVERY_DISCOUNT_CLASSES)).toEqual(
      buildAutomaticDiscountUpdateInput(combinesWith, DELIVERY_DISCOUNT_CLASSES),
    );
  });
});

const shopifyFunctionSummary = {
  id: "gid://shopify/ShopifyFunction/cart",
  apiType: "discount",
  handle: "promo-engine-discount",
  title: CART_FUNCTION_TITLE,
};

describe("createOrFindCodeDiscount", () => {
  beforeEach(() => {
    shopifyGraphQLMock.mockReset();
  });

  it("calls discountCodeAppCreate and reads the id from codeAppDiscount (not automaticAppDiscount)", async () => {
    shopifyGraphQLMock.mockResolvedValueOnce({
      discountCodeAppCreate: {
        codeAppDiscount: { discountId: "gid://shopify/DiscountCodeNode/1" },
        userErrors: [],
      },
    });

    const id = await createOrFindCodeDiscount(
      "shop.myshopify.com",
      "token",
      shopifyFunctionSummary,
      "PRIMEDAY2026",
      "Prime Day",
      CART_DISCOUNT_CLASSES,
    );

    expect(id).toBe("gid://shopify/DiscountCodeNode/1");
    expect(shopifyGraphQLMock).toHaveBeenCalledTimes(1);
    const call = shopifyGraphQLMock.mock.calls[0]![0];
    expect(call.query).toContain("discountCodeAppCreate");
    expect(call.variables).toEqual({
      discount: buildCodeDiscountCreateInput(
        shopifyFunctionSummary.handle,
        "PRIMEDAY2026",
        "Prime Day",
        CART_DISCOUNT_CLASSES,
        expect.any(String) as unknown as string,
      ),
    });
  });

  it("recovers the existing node's id when Shopify reports the code discount already exists", async () => {
    shopifyGraphQLMock
      .mockResolvedValueOnce({
        discountCodeAppCreate: {
          codeAppDiscount: null,
          userErrors: [{ field: null, message: "Code already exists" }],
        },
      })
      .mockResolvedValueOnce({
        discountNodes: {
          nodes: [
            {
              id: "gid://shopify/DiscountNode/existing",
              discount: {
                __typename: "DiscountCodeApp",
                appDiscountType: { functionId: shopifyFunctionSummary.id },
                codes: { nodes: [{ code: "PRIMEDAY2026" }] },
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

    const id = await createOrFindCodeDiscount(
      "shop.myshopify.com",
      "token",
      shopifyFunctionSummary,
      "PRIMEDAY2026",
      "Prime Day",
      CART_DISCOUNT_CLASSES,
    );

    expect(id).toBe("gid://shopify/DiscountNode/existing");
    expect(shopifyGraphQLMock).toHaveBeenCalledTimes(2);
  });

  it("throws when create fails without an 'already exists' style error", async () => {
    shopifyGraphQLMock.mockResolvedValueOnce({
      discountCodeAppCreate: {
        codeAppDiscount: null,
        userErrors: [{ field: ["code"], message: "Code is invalid" }],
      },
    });

    await expect(
      createOrFindCodeDiscount(
        "shop.myshopify.com",
        "token",
        shopifyFunctionSummary,
        "PRIMEDAY2026",
        "Prime Day",
        CART_DISCOUNT_CLASSES,
      ),
    ).rejects.toThrow(/discountCodeAppCreate failed/);
  });
});

describe("updateCodeDiscountCombination", () => {
  beforeEach(() => {
    shopifyGraphQLMock.mockReset();
  });

  it("calls discountCodeAppUpdate and reads the result from codeAppDiscount", async () => {
    shopifyGraphQLMock.mockResolvedValueOnce({
      discountCodeAppUpdate: {
        codeAppDiscount: { discountId: "gid://shopify/DiscountCodeNode/1" },
        userErrors: [],
      },
    });

    await updateCodeDiscountCombination(
      "shop.myshopify.com",
      "token",
      "gid://shopify/DiscountCodeNode/1",
      { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
      CART_DISCOUNT_CLASSES,
    );

    expect(shopifyGraphQLMock).toHaveBeenCalledTimes(1);
    const call = shopifyGraphQLMock.mock.calls[0]![0];
    expect(call.query).toContain("discountCodeAppUpdate");
    expect(call.variables).toMatchObject({ id: "gid://shopify/DiscountCodeNode/1" });
  });

  it("throws when Shopify returns user errors", async () => {
    shopifyGraphQLMock.mockResolvedValueOnce({
      discountCodeAppUpdate: {
        codeAppDiscount: null,
        userErrors: [{ field: null, message: "Something went wrong", code: "INVALID" }],
      },
    });

    await expect(
      updateCodeDiscountCombination(
        "shop.myshopify.com",
        "token",
        "gid://shopify/DiscountCodeNode/1",
        { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
        CART_DISCOUNT_CLASSES,
      ),
    ).rejects.toThrow(/discountCodeAppUpdate failed/);
  });
});
