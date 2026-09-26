import { afterEach, describe, expect, it, vi } from "vitest";
import { AjaxCartAdapter, type CartData } from "./cart-adapter.js";

afterEach(() => vi.unstubAllGlobals());

describe("AjaxCartAdapter legacy metadata migration", () => {
  it("packs legacy promo properties when an existing cart is loaded", async () => {
    const legacyCart: CartData = {
      token: "cart-token",
      id: null,
      items: [{
        key: "line-key",
        variant_id: 1,
        product_id: 1,
        quantity: 1,
        price: 1000,
        properties: { _promo_engine_offer_id: "offer-1", custom: "keep" },
        handle: "item",
        title: "Item",
        variant_title: null,
        vendor: "Vendor",
        product_type: "Type",
        tags: "",
        requires_selling_plan: false,
        selling_plan_allocation: null,
        available: true,
        inventory_quantity: 10,
        inventory_policy: "deny",
      }],
      total_price: 1000,
      currency: "USD",
      item_count: 1,
    };
    const migratedCart = structuredClone(legacyCart);
    migratedCart.items[0]!.properties!._promo_engine_metadata = JSON.stringify({
      _promo_engine_offer_id: "offer-1",
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(legacyCart), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(migratedCart), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { Shopify: { routes: { root: "/" } } });

    const result = await AjaxCartAdapter.getCart();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const mutation = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(mutation.id).toBe("line-key");
    expect(mutation.properties.custom).toBe("keep");
    expect(JSON.parse(mutation.properties._promo_engine_metadata)).toEqual({
      _promo_engine_offer_id: "offer-1",
      custom: "keep",
    });
    expect(result.items[0]!.properties!._promo_engine_metadata).toBeDefined();
  });

  it("migrates a given line key at most once per session", async () => {
    const legacyItem = {
      key: "line-key",
      variant_id: 1,
      product_id: 1,
      quantity: 1,
      price: 1000,
      properties: { _promo_engine_offer_id: "offer-1" },
      handle: "item",
      title: "Item",
      variant_title: null,
      vendor: "Vendor",
      product_type: "Type",
      tags: "",
      requires_selling_plan: false,
      selling_plan_allocation: null,
      available: true,
      inventory_quantity: 10,
      inventory_policy: "deny",
    };
    const legacyCart: CartData = {
      token: "cart-token",
      id: null,
      items: [legacyItem],
      total_price: 1000,
      currency: "USD",
      item_count: 1,
    };
    const migratedCart = structuredClone(legacyCart);
    migratedCart.items[0]!.properties!._promo_engine_metadata = JSON.stringify({
      _promo_engine_offer_id: "offer-1",
    });

    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal("window", { Shopify: { routes: { root: "/" } } });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(legacyCart), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(migratedCart), { status: 200 }))
      // Second getCart() — same still-legacy-looking line, should NOT trigger a second migration write.
      .mockResolvedValueOnce(new Response(JSON.stringify(legacyCart), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await AjaxCartAdapter.getCart();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await AjaxCartAdapter.getCart();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
