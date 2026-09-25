import { describe, it, expect } from "vitest";
import { customerIdFromSub, shopDomainFromDest } from "./extension-auth.server.js";
import { getOrderAttributions, toOrderAttributions } from "./order-attribution.server.js";
import type { Db } from "@promo/db";

describe("shopDomainFromDest", () => {
  it("accepts bare and https-prefixed myshopify domains", () => {
    expect(shopDomainFromDest("test-shop.myshopify.com")).toBe("test-shop.myshopify.com");
    expect(shopDomainFromDest("https://test-shop.myshopify.com")).toBe("test-shop.myshopify.com");
    expect(shopDomainFromDest("https://test-shop.myshopify.com/")).toBe("test-shop.myshopify.com");
  });

  it.each([undefined, "", "evil.com", "https://test.myshopify.com.evil.com", "http://test.myshopify.com"])(
    "rejects %s with 401",
    (dest) => {
      try {
        shopDomainFromDest(dest);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }
    },
  );
});

describe("customerIdFromSub", () => {
  it("extracts the numeric id from a customer GID", () => {
    expect(customerIdFromSub("gid://shopify/Customer/123")).toBe("123");
  });

  it.each([undefined, null, "", "123", "gid://shopify/Order/123", "gid://shopify/Customer/abc"])(
    "returns null for %s",
    (sub) => {
      expect(customerIdFromSub(sub)).toBeNull();
    },
  );
});

describe("getOrderAttributions", () => {
  const db = {} as Db;
  const shop = { id: "s1", currencyCode: "USD" };

  it.each([
    [null, "1"],
    ["123", "1"],
    ["gid://shopify/Order/1", null],
    ["gid://shopify/Order/1", "gid://shopify/Customer/1"],
  ])("returns no attributions without querying for order=%s customer=%s", async (orderGid, customerId) => {
    await expect(getOrderAttributions(db, shop, orderGid, customerId)).resolves.toEqual([]);
  });
});

describe("toOrderAttributions", () => {
  it("dedupes by offer and normalizes savings", () => {
    const result = toOrderAttributions([
      { offerId: "o1", offerName: "Gift", offerType: "gift", properties: { savedCents: 1234.4, giftProductTitle: "Mug" } },
      { offerId: "o1", offerName: "Gift", offerType: "gift", properties: { savedCents: 999 } },
      { offerId: "o2", offerName: "Bundle", offerType: "bundle", properties: { saved_cents: "500" } },
      { offerId: "o3", offerName: "Bad", offerType: "discount", properties: { savedCents: -5 } },
      { offerId: "o4", offerName: "Array", offerType: "discount", properties: [1, 2] },
      { offerId: null, offerName: "Orphan", offerType: "gift", properties: {} },
    ], "EUR");

    expect(result).toEqual([
      { offerId: "o1", offerName: "Gift", offerType: "gift", savedCents: 1234, currencyCode: "EUR", giftProductTitle: "Mug" },
      { offerId: "o2", offerName: "Bundle", offerType: "bundle", savedCents: 500, currencyCode: "EUR" },
      { offerId: "o3", offerName: "Bad", offerType: "discount", savedCents: 0, currencyCode: "EUR" },
      { offerId: "o4", offerName: "Array", offerType: "discount", savedCents: 0, currencyCode: "EUR" },
    ]);
  });
});
