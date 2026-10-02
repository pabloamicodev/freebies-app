import { beforeEach, describe, expect, it, vi } from "vitest";
import { shopifyGraphQL } from "./shopify-fetch.server.js";
import type * as ShopifyFetch from "./shopify-fetch.server.js";
import { buildCartValidationConfig, syncCartValidation } from "./cart-validation.server.js";

vi.mock("./shopify-fetch.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ShopifyFetch>()),
  shopifyGraphQL: vi.fn(),
}));

beforeEach(() => vi.mocked(shopifyGraphQL).mockReset());

describe("syncCartValidation", () => {
  it("updates an existing app metafield with its resolved namespace, as required by Shopify", async () => {
    vi.mocked(shopifyGraphQL).mockResolvedValueOnce({
      validations: { nodes: [{
        id: "gid://shopify/Validation/1",
        shopifyFunction: { handle: "promo-engine-cart-validation" },
        metafield: { id: "gid://shopify/Metafield/1", namespace: "promo_engine" },
        appMetafield: { id: "gid://shopify/Metafield/2", namespace: "app--123--promo_engine" },
      }] },
    }).mockImplementationOnce(async ({ variables }) => {
      const validation = variables!.validation as { metafields: Array<{ id?: string; namespace: string }> };
      // Shopify's validationUpdate rejects the $app alias when an existing
      // metafield ID is supplied, with this error at the app field's index.
      if (validation.metafields.some((field) => field.id && field.namespace.startsWith("$app:"))) {
        return { validationUpdate: { validation: null, userErrors: [{ field: ["validation", "metafields", "1"], message: "The request couldn't be completed because one or more inputs are invalid." }] } };
      }
      return { validationUpdate: { validation: { id: "gid://shopify/Validation/1" }, userErrors: [] } };
    });

    const config = buildCartValidationConfig([]);
    await expect(syncCartValidation("test.myshopify.com", "test-token", config)).resolves.toBe("gid://shopify/Validation/1");
    expect(vi.mocked(shopifyGraphQL).mock.calls[1]?.[0].variables).toEqual({
      id: "gid://shopify/Validation/1",
      validation: {
        title: "Promo Engine Cart Protection", enable: true, blockOnFailure: false,
        metafields: [
          { id: "gid://shopify/Metafield/1", namespace: "promo_engine", key: "validation_config", type: "json", value: JSON.stringify(config) },
          { id: "gid://shopify/Metafield/2", namespace: "app--123--promo_engine", key: "validation_config", type: "json", value: JSON.stringify(config) },
        ],
      },
    });
  });

  it("keeps the app namespace alias when creating a missing app metafield", async () => {
    vi.mocked(shopifyGraphQL).mockResolvedValueOnce({
      validations: { nodes: [{
        id: "gid://shopify/Validation/1",
        shopifyFunction: { handle: "promo-engine-cart-validation" },
        metafield: { id: "gid://shopify/Metafield/1", namespace: "promo_engine" },
        appMetafield: null,
      }] },
    }).mockResolvedValueOnce({ validationUpdate: { validation: { id: "gid://shopify/Validation/1" }, userErrors: [] } });

    await syncCartValidation("test.myshopify.com", "test-token", buildCartValidationConfig([]));
    expect(vi.mocked(shopifyGraphQL).mock.calls[1]?.[0].variables).toMatchObject({
      validation: { metafields: [
        { id: "gid://shopify/Metafield/1", namespace: "promo_engine" },
        { namespace: "$app:promo_engine", key: "validation_config", type: "json" },
      ] },
    });
    const fields = (vi.mocked(shopifyGraphQL).mock.calls[1]?.[0].variables?.validation as { metafields: unknown[] }).metafields;
    expect(fields[1]).not.toHaveProperty("id");
  });
});
