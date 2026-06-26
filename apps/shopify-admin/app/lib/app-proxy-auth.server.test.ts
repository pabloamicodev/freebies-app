/**
 * Unit tests for app-proxy-auth.server.ts
 * Tests the HMAC signature verification logic without a DB.
 * getSignedShop (DB path) is covered by the mock in the integration suite.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { verifyAppProxySignature } from "./app-proxy-auth.server.js";

const SECRET = "test_api_secret_abc123";

function makeSignedUrl(params: Record<string, string>, secret = SECRET, timestampOverride?: number): string {
  const timestamp = (timestampOverride ?? Math.floor(Date.now() / 1000)).toString();
  const allParams = { ...params, timestamp };

  // Build the signed message (Shopify spec)
  const signedMessage = Object.entries(allParams)
    .filter(([k]) => k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");

  const signature = createHmac("sha256", secret).update(signedMessage).digest("hex");

  const url = new URL("https://store.myshopify.com/apps/promo-engine/evaluate");
  for (const [k, v] of Object.entries(allParams)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);
  return url.toString();
}

function req(url: string): Request {
  return new Request(url);
}

beforeEach(() => {
  process.env["SHOPIFY_API_SECRET"] = SECRET;
});

afterEach(() => {
  delete process.env["SHOPIFY_API_SECRET"];
});

describe("verifyAppProxySignature", () => {
  it("returns shop domain for a valid signature", () => {
    const url = makeSignedUrl({ shop: "test.myshopify.com", logged_in_customer_id: "42" });
    const shop = verifyAppProxySignature(req(url));
    expect(shop).toBe("test.myshopify.com");
  });

  it("throws 401 when signature is missing", () => {
    const url = new URL("https://store.myshopify.com/apps/promo");
    url.searchParams.set("shop", "test.myshopify.com");
    url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
    expect(() => verifyAppProxySignature(req(url.toString()))).toThrow();
  });

  it("throws 401 when shop is missing", () => {
    const url = makeSignedUrl({ logged_in_customer_id: "1" });
    // Manually remove shop
    const parsed = new URL(url);
    parsed.searchParams.delete("shop");
    expect(() => verifyAppProxySignature(req(parsed.toString()))).toThrow();
  });

  it("throws 401 when timestamp is expired (> 10 min ago)", () => {
    const stale = Math.floor(Date.now() / 1000) - 700; // 11+ minutes ago
    const url = makeSignedUrl({ shop: "test.myshopify.com" }, SECRET, stale);
    expect(() => verifyAppProxySignature(req(url))).toThrow();
  });

  it("throws 401 when timestamp is in the far future (clock skew attack)", () => {
    const future = Math.floor(Date.now() / 1000) + 700;
    const url = makeSignedUrl({ shop: "test.myshopify.com" }, SECRET, future);
    expect(() => verifyAppProxySignature(req(url))).toThrow();
  });

  it("accepts a timestamp within the TTL window (9 min old)", () => {
    const recent = Math.floor(Date.now() / 1000) - 540; // 9 min
    const url = makeSignedUrl({ shop: "test.myshopify.com" }, SECRET, recent);
    expect(() => verifyAppProxySignature(req(url))).not.toThrow();
  });

  it("throws 401 for a tampered signature", () => {
    const url = makeSignedUrl({ shop: "test.myshopify.com" });
    const parsed = new URL(url);
    const orig = parsed.searchParams.get("signature")!;
    parsed.searchParams.set("signature", orig.replace(/.$/, orig.slice(-1) === "a" ? "b" : "a"));
    expect(() => verifyAppProxySignature(req(parsed.toString()))).toThrow();
  });

  it("throws 401 when signed with wrong secret", () => {
    const url = makeSignedUrl({ shop: "test.myshopify.com" }, "wrong_secret");
    expect(() => verifyAppProxySignature(req(url))).toThrow();
  });

  it("throws 500 when SHOPIFY_API_SECRET env var is missing", () => {
    delete process.env["SHOPIFY_API_SECRET"];
    const url = makeSignedUrl({ shop: "test.myshopify.com" });
    expect(() => verifyAppProxySignature(req(url))).toThrow();
  });

  it("handles multi-value params per Shopify spec", () => {
    // Shopify can send array params as key[]=val1&key[]=val2
    // Our implementation joins them as "key=val1,val2"
    const url = makeSignedUrl({ shop: "test.myshopify.com", "ids[]": "1,2,3" });
    expect(() => verifyAppProxySignature(req(url))).not.toThrow();
  });
});
