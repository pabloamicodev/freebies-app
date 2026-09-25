import { describe, expect, it } from "vitest";

import { buildShopifyOAuthUrl, isStorefrontPasswordUrl } from "./e2e-bootstrap.js";

describe("buildShopifyOAuthUrl", () => {
  it("starts OAuth for the configured shop instead of opening the unauthenticated app root", () => {
    expect(
      buildShopifyOAuthUrl(
        "https://freebies-app-shopify-admin.vercel.app/",
        "https://hpn-test-store.myshopify.com",
      ),
    ).toBe(
      "https://freebies-app-shopify-admin.vercel.app/auth/login?shop=hpn-test-store.myshopify.com",
    );
  });

  it("rejects a store URL outside Shopify's myshopify.com domain", () => {
    expect(() =>
      buildShopifyOAuthUrl(
        "https://freebies-app-shopify-admin.vercel.app",
        "https://attacker.example.com",
      ),
    ).toThrow(/myshopify\.com/i);
  });
});

describe("isStorefrontPasswordUrl", () => {
  it("detects a password redirect on the configured store", () => {
    expect(
      isStorefrontPasswordUrl(
        "https://hpn-test-store.myshopify.com/password",
        "https://hpn-test-store.myshopify.com",
      ),
    ).toBe(true);
  });

  it("does not trust a password path on another origin", () => {
    expect(
      isStorefrontPasswordUrl(
        "https://attacker.example.com/password",
        "https://hpn-test-store.myshopify.com",
      ),
    ).toBe(false);
  });
});
