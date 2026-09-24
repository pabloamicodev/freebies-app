import { afterEach, describe, expect, it, vi } from "vitest";
import { StorefrontApiAdapter, type StorefrontCart } from "./storefront-api-adapter.js";

function cart(): StorefrontCart {
  return {
    id: "gid://shopify/Cart/test",
    checkoutUrl: "https://store.example/checkouts/test",
    lines: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    cost: {
      subtotalAmount: { amount: "0.0", currencyCode: "USD" },
      totalAmount: { amount: "0.0", currencyCode: "USD" },
    },
    discountCodes: [],
    buyerIdentity: { countryCode: null, customer: null },
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("StorefrontApiAdapter", () => {
  it("migrates legacy attributes on a stored cart before returning it", async () => {
    const existing = cart();
    existing.lines.nodes = [{
      id: "gid://shopify/CartLine/1",
      quantity: 1,
      merchandise: { id: "gid://shopify/ProductVariant/1" },
      attributes: [
        { key: "_promo_engine_offer_id", value: "offer-1" },
        { key: "custom", value: "keep" },
      ],
      cost: {
        amountPerQuantity: { amount: "10.0", currencyCode: "USD" },
        subtotalAmount: { amount: "10.0", currencyCode: "USD" },
      },
    }];
    const migrated = structuredClone(existing);
    migrated.lines.nodes[0]!.attributes.push({
      key: "_promo_engine_metadata",
      value: JSON.stringify({ _promo_engine_offer_id: "offer-1" }),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ cart: existing }))
      .mockResolvedValueOnce(jsonResponse({
        cartLinesUpdate: { cart: migrated, userErrors: [] },
      }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => existing.id),
      setItem: vi.fn(),
    });

    const adapter = new StorefrontApiAdapter("store.myshopify.com", "public-token");
    const result = await adapter.getOrCreateCart();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const mutation = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      variables: { lines: Array<{ attributes: Array<{ key: string; value: string }> }> };
    };
    expect(mutation.variables.lines[0]!.attributes).toEqual(expect.arrayContaining([
      { key: "custom", value: "keep" },
      expect.objectContaining({ key: "_promo_engine_metadata" }),
    ]));
    expect(result.lines.nodes[0]!.attributes.some(({ key }) => key === "_promo_engine_metadata")).toBe(true);
  });

  it("uses 2026-07 and packs promo metadata into Storefront attributes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ cartCreate: { cart: cart(), userErrors: [] } }))
      .mockResolvedValueOnce(jsonResponse({ cartLinesAdd: { cart: cart(), userErrors: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new StorefrontApiAdapter("store.myshopify.com", "public-token");
    await adapter.createCart();
    await adapter.addLines([{
      merchandiseId: "gid://shopify/ProductVariant/1",
      quantity: 1,
      attributes: { _promo_engine_offer_id: "offer-1" },
    }]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://store.myshopify.com/api/2026-07/graphql.json");
    const request = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      variables: { lines: Array<{ attributes: Array<{ key: string; value: string }> }> };
    };
    const packed = request.variables.lines[0]!.attributes.find(({ key }) => key === "_promo_engine_metadata");
    expect(packed).toBeDefined();
    expect(JSON.parse(packed!.value)).toEqual({ _promo_engine_offer_id: "offer-1" });
  });

  it("surfaces CartUserError responses instead of returning a partial cart", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      cartCreate: {
        cart: null,
        userErrors: [{ field: ["input"], message: "Invalid cart input", code: "INVALID" }],
      },
    })));

    const adapter = new StorefrontApiAdapter("store.myshopify.com", "public-token");
    await expect(adapter.createCart()).rejects.toThrow("cartCreate: Invalid cart input");
  });
});
