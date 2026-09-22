import { beforeEach, describe, expect, it, vi } from "vitest";

const { shopifyGraphQLMock } = vi.hoisted(() => ({
  shopifyGraphQLMock: vi.fn(),
}));

vi.mock("./shopify-fetch.server.js", () => ({
  shopifyGraphQL: shopifyGraphQLMock,
}));

import {
  createCyclePricingPlan,
  deleteCyclePricingPlan,
  parseCyclePricingFormData,
  updateCyclePricingPlan,
} from "./subscription-cycle-pricing.server.js";
import type { SubscriptionCyclePricingPlan, SubscriptionCyclePricingPlanInput } from "./subscription-cycle-pricing.js";

const client = { shopDomain: "example.myshopify.com", accessToken: "token" };
const input: SubscriptionCyclePricingPlanInput = {
  name: "Three shipments",
  intervalUnit: "MONTH",
  intervalCount: 1,
  totalCycles: 3,
  firstCycleDiscount: { type: "percentage", value: 0 },
  recurringDiscount: { type: "fixed_amount", value: 2 },
  productIds: ["gid://shopify/Product/1"],
};

const existing: SubscriptionCyclePricingPlan = {
  ...input,
  id: "gid://shopify/SellingPlanGroup/1",
  sellingPlanId: "gid://shopify/SellingPlan/1",
  productTitlesById: { "gid://shopify/Product/1": "Product one" },
};

describe("subscription cycle pricing server", () => {
  beforeEach(() => shopifyGraphQLMock.mockReset());

  it("creates a subscription plan with fixed first-cycle and recurring policies", async () => {
    shopifyGraphQLMock.mockResolvedValue({
      sellingPlanGroupCreate: {
        sellingPlanGroup: { id: "gid://shopify/SellingPlanGroup/1" },
        userErrors: [],
      },
    });

    const result = await createCyclePricingPlan(client, { ...input, productIds: [...input.productIds, ...input.productIds] });
    expect(result.id).toBe("gid://shopify/SellingPlanGroup/1");
    const call = shopifyGraphQLMock.mock.calls[0]?.[0] as { variables: Record<string, unknown> };
    const variables = call.variables as {
      input: { sellingPlansToCreate: Array<Record<string, unknown>> };
      resources: { productIds: string[] };
    };
    expect(variables.resources.productIds).toEqual(["gid://shopify/Product/1"]);
    expect(variables.input.sellingPlansToCreate[0]).toMatchObject({
      category: "SUBSCRIPTION",
      billingPolicy: { recurring: { interval: "MONTH", intervalCount: 1, maxCycles: 3 } },
      pricingPolicies: [
        { fixed: { adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: 0 } } },
        { recurring: { afterCycle: 1, adjustmentType: "FIXED_AMOUNT", adjustmentValue: { fixedValue: 2 } } },
      ],
    });
  });

  it("fails closed when Shopify returns a null create or delete payload", async () => {
    shopifyGraphQLMock.mockResolvedValueOnce({ sellingPlanGroupCreate: null });
    const created = await createCyclePricingPlan(client, input);
    expect(created.userErrors[0]?.message).toContain("no result");

    shopifyGraphQLMock.mockResolvedValueOnce({ sellingPlanGroupDelete: null });
    const deleted = await deleteCyclePricingPlan(client, existing.id);
    expect(deleted.userErrors[0]?.message).toContain("no result");
  });

  it("updates the plan before reconciling product associations", async () => {
    shopifyGraphQLMock
      .mockResolvedValueOnce({
        sellingPlanGroup: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "gid://shopify/Product/1", title: "Product one" }],
          },
        },
      })
      .mockResolvedValueOnce({ sellingPlanGroupUpdate: { sellingPlanGroup: { id: existing.id }, userErrors: [] } })
      .mockResolvedValueOnce({ sellingPlanGroupAddProducts: { userErrors: [] } })
      .mockResolvedValueOnce({ sellingPlanGroupRemoveProducts: { userErrors: [] } });

    const result = await updateCyclePricingPlan(client, existing, {
      ...input,
      productIds: ["gid://shopify/Product/2"],
    });
    expect(result.userErrors).toEqual([]);
    expect(shopifyGraphQLMock).toHaveBeenCalledTimes(4);
    expect(shopifyGraphQLMock.mock.calls[2]?.[0]).toMatchObject({ variables: { productIds: ["gid://shopify/Product/2"] } });
    expect(shopifyGraphQLMock.mock.calls[3]?.[0]).toMatchObject({ variables: { productIds: ["gid://shopify/Product/1"] } });
  });

  it("paginates every existing product before removing associations", async () => {
    shopifyGraphQLMock
      .mockResolvedValueOnce({
        sellingPlanGroup: {
          products: {
            pageInfo: { hasNextPage: true, endCursor: "page-2" },
            nodes: [{ id: "gid://shopify/Product/1", title: "Product one" }],
          },
        },
      })
      .mockResolvedValueOnce({
        sellingPlanGroup: {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "gid://shopify/Product/101", title: "Product 101" }],
          },
        },
      })
      .mockResolvedValueOnce({ sellingPlanGroupUpdate: { sellingPlanGroup: { id: existing.id }, userErrors: [] } })
      .mockResolvedValueOnce({ sellingPlanGroupRemoveProducts: { userErrors: [] } });

    const result = await updateCyclePricingPlan(client, existing, input);
    expect(result.userErrors).toEqual([]);
    expect(shopifyGraphQLMock.mock.calls[1]?.[0]).toMatchObject({
      variables: { id: existing.id, first: 100, after: "page-2" },
    });
    expect(shopifyGraphQLMock.mock.calls[3]?.[0]).toMatchObject({
      variables: { productIds: ["gid://shopify/Product/101"] },
    });
  });

  it("does not mutate the plan when the complete product set cannot be loaded", async () => {
    shopifyGraphQLMock.mockResolvedValueOnce({ sellingPlanGroup: null });
    const result = await updateCyclePricingPlan(client, existing, input);
    expect(result.userErrors[0]?.message).toContain("no result");
    expect(shopifyGraphQLMock).toHaveBeenCalledTimes(1);
  });

  it("validates form input before any Admin API request", () => {
    const formData = new FormData();
    formData.set("name", "Plan");
    formData.set("intervalUnit", "MONTH");
    formData.set("intervalCount", "1");
    formData.set("totalCycles", "1");
    formData.set("firstCycleDiscountType", "percentage");
    formData.set("firstCycleDiscountValue", "101");
    formData.set("recurringDiscountType", "fixed_amount");
    formData.set("recurringDiscountValue", "2");
    formData.set("productIds", JSON.stringify(["not-a-product-gid"]));
    expect(parseCyclePricingFormData(formData).success).toBe(false);
  });
});
