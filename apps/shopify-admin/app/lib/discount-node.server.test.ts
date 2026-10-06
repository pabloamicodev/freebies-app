import type * as ShopifyFetch from "./shopify-fetch.server.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addRedeemCodes,
  buildAutomaticDiscountCreateInput,
  purchaseTypeFlags,
  buildAutomaticDiscountUpdateInput,
  buildCodeDiscountCreateInput,
  buildCodeDiscountUpdateInput,
  CART_DISCOUNT_CLASSES,
  CART_FUNCTION_TITLE,
  codeSearchTerm,
  createOrFindAutomaticDiscount,
  createOrFindCodeDiscount,
  DELIVERY_DISCOUNT_CLASSES,
  DELIVERY_FUNCTION_TITLE,
  formatDiscountUserErrors,
  removeRedeemCodes,
  selectFunctionId,
  updateCodeDiscountCombination,
  syncDiscountCombinationPolicy,
} from "./discount-node.server.js";
import { ShopifyOutcomeUnknownError, shopifyGraphQL } from "./shopify-fetch.server.js";

vi.mock("./shopify-fetch.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ShopifyFetch>()),
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
      appliesOnSubscription: true,
      appliesOnOneTimePurchase: true,
    });
  });

  it("preserves same-class combination settings for the unified cart discount", () => {
    expect(buildAutomaticDiscountUpdateInput(combinesWith, CART_DISCOUNT_CLASSES)).toEqual({
      combinesWith,
      discountClasses: ["PRODUCT", "ORDER"],
      appliesOnSubscription: true,
      appliesOnOneTimePurchase: true,
    });
  });

  it("always sends both purchase-type flags on create and update (pre-2026-07 nodes defaulted to no subscriptions)", () => {
    expect(buildAutomaticDiscountCreateInput("h", "t", CART_DISCOUNT_CLASSES)).toMatchObject({
      appliesOnSubscription: true,
      appliesOnOneTimePurchase: true,
    });
    expect(buildCodeDiscountCreateInput("h", "C", "t", CART_DISCOUNT_CLASSES)).toMatchObject({
      appliesOnSubscription: true,
      appliesOnOneTimePurchase: true,
    });
    expect(buildCodeDiscountUpdateInput(combinesWith, CART_DISCOUNT_CLASSES)).toMatchObject({
      appliesOnSubscription: true,
      appliesOnOneTimePurchase: true,
    });
    expect(
      buildCodeDiscountUpdateInput(combinesWith, CART_DISCOUNT_CLASSES, {
        purchaseTypes: { appliesOnSubscription: false, appliesOnOneTimePurchase: true },
      }),
    ).toMatchObject({ appliesOnSubscription: false, appliesOnOneTimePurchase: true });
  });

  it("derives node flags from reward purchase modes", () => {
    expect(purchaseTypeFlags([])).toEqual({ appliesOnSubscription: true, appliesOnOneTimePurchase: true });
    expect(purchaseTypeFlags(["any"])).toEqual({ appliesOnSubscription: true, appliesOnOneTimePurchase: true });
    expect(purchaseTypeFlags(["one_time_only"])).toEqual({ appliesOnSubscription: false, appliesOnOneTimePurchase: true });
    expect(purchaseTypeFlags(["subscription_only"])).toEqual({ appliesOnSubscription: true, appliesOnOneTimePurchase: false });
    expect(purchaseTypeFlags(["one_time_only", "subscription_only"])).toEqual({ appliesOnSubscription: true, appliesOnOneTimePurchase: true });
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
        codeDiscountNodeByCode: {
          id: "gid://shopify/DiscountNode/existing",
          codeDiscount: {
            __typename: "DiscountCodeApp",
            appDiscountType: { functionId: shopifyFunctionSummary.id },
          },
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
    // An exact lookup by code, not a scan of every discount in the shop.
    expect(shopifyGraphQLMock.mock.calls[1]![0].variables).toEqual({ code: "PRIMEDAY2026" });
  });

  it("refuses to adopt a code held by someone else's discount", async () => {
    shopifyGraphQLMock
      .mockResolvedValueOnce({
        discountCodeAppCreate: {
          codeAppDiscount: null,
          userErrors: [{ field: null, message: "Code already exists", code: "TAKEN" }],
        },
      })
      .mockResolvedValueOnce({
        codeDiscountNodeByCode: {
          id: "gid://shopify/DiscountNode/theirs",
          codeDiscount: { __typename: "DiscountCodeBasic" },
        },
      });

    await expect(
      createOrFindCodeDiscount(
        "shop.myshopify.com",
        "token",
        shopifyFunctionSummary,
        "PRIME",
        "Prime",
        CART_DISCOUNT_CLASSES,
      ),
    ).rejects.toThrow(/already used by a Shopify discount this app doesn't manage/);
  });

  describe("a create whose outcome is unknown (timeout, network, 5xx)", () => {
    const mutationCalls = () =>
      shopifyGraphQLMock.mock.calls.filter(([args]) => /^\s*mutation/.test(args.query));

    it("looks the node up before resending, and does not create a second one when it exists", async () => {
      shopifyGraphQLMock
        .mockRejectedValueOnce(new ShopifyOutcomeUnknownError("timeout"))
        .mockResolvedValueOnce({
          codeDiscountNodeByCode: {
            id: "gid://shopify/DiscountNode/landed",
            codeDiscount: {
              __typename: "DiscountCodeApp",
              appDiscountType: { functionId: shopifyFunctionSummary.id },
            },
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

      expect(id).toBe("gid://shopify/DiscountNode/landed");
      expect(mutationCalls()).toHaveLength(1);
    });

    it("sends the create once more only after the lookup proved it did not land", async () => {
      shopifyGraphQLMock
        .mockRejectedValueOnce(new ShopifyOutcomeUnknownError("timeout"))
        .mockResolvedValueOnce({ codeDiscountNodeByCode: null })
        .mockResolvedValueOnce({
          discountCodeAppCreate: {
            codeAppDiscount: { discountId: "gid://shopify/DiscountNode/fresh" },
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

      expect(id).toBe("gid://shopify/DiscountNode/fresh");
      expect(shopifyGraphQLMock).toHaveBeenCalledTimes(3);
    });

    it("does not swallow a plain error", async () => {
      shopifyGraphQLMock.mockRejectedValueOnce(new Error("Shopify API error: 403 Forbidden"));
      await expect(
        createOrFindCodeDiscount(
          "shop.myshopify.com",
          "token",
          shopifyFunctionSummary,
          "A",
          "A",
          CART_DISCOUNT_CLASSES,
        ),
      ).rejects.toThrow("403");
      expect(shopifyGraphQLMock).toHaveBeenCalledTimes(1);
    });

    it("an automatic node create is looked up (by title, filtered) before it is repeated", async () => {
      const page = (nodes: unknown[]) => ({
        discountNodes: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
      });
      shopifyGraphQLMock
        .mockResolvedValueOnce(page([])) // filtered scan
        .mockResolvedValueOnce(page([])) // unfiltered fallback scan
        .mockRejectedValueOnce(new ShopifyOutcomeUnknownError("socket hang up"))
        .mockResolvedValueOnce(
          page([
            {
              id: "gid://shopify/DiscountAutomaticNode/landed",
              discount: {
                __typename: "DiscountAutomaticApp",
                title: "Promo Engine",
                appDiscountType: { functionId: shopifyFunctionSummary.id },
              },
            },
          ]),
        );

      const id = await createOrFindAutomaticDiscount(
        "shop.myshopify.com",
        "token",
        shopifyFunctionSummary,
        "Promo Engine",
        CART_DISCOUNT_CLASSES,
      );

      expect(id).toBe("gid://shopify/DiscountAutomaticNode/landed");
      expect(shopifyGraphQLMock.mock.calls[0]![0].variables).toMatchObject({ query: "method:automatic" });
      expect(shopifyGraphQLMock.mock.calls[1]![0].variables).toMatchObject({ query: null });
      expect(mutationCalls()).toHaveLength(1);
    });

    it("an exact-title lookup never mistakes the shared shipping node for a coded-shipping pool node", async () => {
      const node = (id: string, title: string) => ({
        id,
        discount: {
          __typename: "DiscountAutomaticApp",
          title,
          appDiscountType: { functionId: shopifyFunctionSummary.id },
        },
      });
      shopifyGraphQLMock.mockResolvedValueOnce({
        discountNodes: {
          nodes: [node("pool-1", "Promo Engine Coded Shipping 1"), node("shared", "Promo Engine Shipping")],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

      const id = await createOrFindAutomaticDiscount(
        "shop.myshopify.com",
        "token",
        shopifyFunctionSummary,
        "Promo Engine Shipping",
        DELIVERY_DISCOUNT_CLASSES,
      );
      expect(id).toBe("shared");
    });
  });

  it("an add whose outcome is unknown resends only the codes that are not on the node yet", async () => {
    vi.useFakeTimers();
    const NODE = "gid://shopify/DiscountCodeNode/1";
    shopifyGraphQLMock.mockImplementation((async ({
      query,
      variables,
    }: {
      query: string;
      variables?: Record<string, unknown>;
    }) => {
      if (query.includes("AddPromoEngineRedeemCodes")) {
        const sent = (variables!.codes as Array<{ code: string }>).map((c) => c.code);
        if (sent.length === 3) throw new ShopifyOutcomeUnknownError("timeout");
        expect(sent).toEqual(["C"]);
        return { discountRedeemCodeBulkAdd: { bulkCreation: { id: "bulk", done: false }, userErrors: [] } };
      }
      if (query.includes("PromoEngineCodeOwners")) {
        // A and B landed before the connection dropped; C did not.
        return { c0: { id: NODE }, c1: { id: NODE }, c2: null };
      }
      if (query.includes("PromoEngineRedeemCodeBulkCreation")) {
        return { discountRedeemCodeBulkCreation: { done: true, codes: { nodes: [{ code: "C", errors: [] }] } } };
      }
      throw new Error(`unexpected ${query.slice(0, 40)}`);
    }) as never);

    const pending = addRedeemCodes("shop.myshopify.com", "token", NODE, ["A", "B", "C"]);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual([]);
    vi.useRealTimers();
  });

  it("an add that finds a code taken by another discount reports it as failed", async () => {
    vi.useFakeTimers();
    const NODE = "gid://shopify/DiscountCodeNode/1";
    shopifyGraphQLMock.mockImplementation((async ({ query }: { query: string }) => {
      if (query.includes("AddPromoEngineRedeemCodes")) throw new ShopifyOutcomeUnknownError("timeout");
      if (query.includes("PromoEngineCodeOwners")) return { c0: { id: "gid://shopify/DiscountCodeNode/other" } };
      throw new Error("unexpected");
    }) as never);

    const pending = addRedeemCodes("shop.myshopify.com", "token", NODE, ["A"]);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual([
      { code: "A", message: expect.stringContaining("another discount") as unknown as string },
    ]);
    vi.useRealTimers();
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
    expect(call.variables!["discount"]).toMatchObject({ appliesOnSubscription: true, appliesOnOneTimePurchase: true });
  });

  it("re-sends the purchase-type flags when updating the shared automatic nodes", async () => {
    shopifyGraphQLMock.mockResolvedValueOnce({
      discountAutomaticAppUpdate: { automaticAppDiscount: { discountId: "gid://shopify/DiscountAutomaticNode/1" }, userErrors: [] },
    });
    await syncDiscountCombinationPolicy(
      "shop.myshopify.com",
      "token",
      "gid://shopify/DiscountAutomaticNode/1",
      { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
      CART_DISCOUNT_CLASSES,
    );
    expect(shopifyGraphQLMock.mock.calls[0]![0].variables?.["discount"]).toMatchObject({
      appliesOnSubscription: true,
      appliesOnOneTimePurchase: true,
    });
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

describe("removeRedeemCodes", () => {
  const NODE = "gid://shopify/DiscountCodeNode/1";

  it("quotes every search term so a dash, colon or quote in a code can't change the query", () => {
    expect(codeSearchTerm("SUMMER-10")).toBe('code:"SUMMER-10"');
    expect(codeSearchTerm('A"B')).toBe('code:"A\\"B"');
    expect(codeSearchTerm("A:B OR code:C")).toBe('code:"A:B OR code:C"');
  });

  function fakeShopify(opts: { onNode: string[]; searchHides?: string[]; stubborn?: string[] }) {
    const onNode = new Set(opts.onNode);
    const queries: Array<{ name: string; variables: Record<string, unknown> }> = [];
    shopifyGraphQLMock.mockImplementation((async ({
      query,
      variables,
    }: {
      query: string;
      variables?: Record<string, unknown>;
    }) => {
      queries.push({ name: /(?:query|mutation) (\w+)/.exec(query)![1]!, variables: variables ?? {} });
      if (query.includes("FindPromoEngineRedeemCodes")) {
        return {
          codeDiscountNode: {
            codeDiscount: {
              codes: {
                nodes: [...onNode]
                  .filter((code) => !opts.searchHides?.includes(code))
                  .map((code) => ({ id: `rc:${code}`, code })),
              },
            },
          },
        };
      }
      if (query.includes("RemovePromoEngineRedeemCodes")) {
        for (const id of variables!.ids as string[]) {
          const code = id.slice(3);
          if (!opts.stubborn?.includes(code)) onNode.delete(code);
        }
        return { discountCodeRedeemCodeBulkDelete: { job: { id: "job" }, userErrors: [] } };
      }
      if (query.includes("PromoEngineJob")) return { job: { done: true } };
      if (query.includes("PromoEngineCodeOwners")) {
        const result: Record<string, unknown> = {};
        for (const [name, code] of Object.entries(variables!)) {
          result[`c${name.slice(1)}`] = onNode.has(code as string) ? { id: NODE } : null;
        }
        return result;
      }
      throw new Error(`unexpected ${query.slice(0, 50)}`);
    }) as never);
    return queries;
  }

  it("sends quoted search terms and reports confirmed removals", async () => {
    const queries = fakeShopify({ onNode: ["A-1", "B-2"] });
    const result = await removeRedeemCodes("shop.myshopify.com", "token", NODE, ["A-1", "B-2"]);
    expect(result).toEqual({ removed: ["A-1", "B-2"], absent: [], unconfirmed: [] });
    expect(queries.find((q) => q.name === "FindPromoEngineRedeemCodes")!.variables["query"]).toBe(
      'code:"A-1" OR code:"B-2"',
    );
  });

  it("reports codes Shopify no longer has as absent, not removed", async () => {
    fakeShopify({ onNode: ["A"] });
    const result = await removeRedeemCodes("shop.myshopify.com", "token", NODE, ["A", "GONE"]);
    expect(result).toEqual({ removed: ["A"], absent: ["GONE"], unconfirmed: [] });
  });

  it("flags a code the search could not find but that is still on the node as unconfirmed", async () => {
    fakeShopify({ onNode: ["A", "HIDDEN"], searchHides: ["HIDDEN"] });
    const result = await removeRedeemCodes("shop.myshopify.com", "token", NODE, ["A", "HIDDEN"]);
    expect(result.unconfirmed).toEqual(["HIDDEN"]);
    expect(result.removed).toEqual(["A"]);
  });

  it("flags a code whose delete did not take effect as unconfirmed", async () => {
    fakeShopify({ onNode: ["A", "STUCK"], stubborn: ["STUCK"] });
    const result = await removeRedeemCodes("shop.myshopify.com", "token", NODE, ["A", "STUCK"]);
    expect(result).toEqual({ removed: ["A"], absent: [], unconfirmed: ["STUCK"] });
  });
});
