import { beforeEach, describe, expect, it, vi } from "vitest";

const publisher = vi.hoisted(() => ({ publishOffersForShop: vi.fn() }));
vi.mock("./sync/offer-publisher.server.js", () => ({ publishOffersForShop: publisher.publishOffersForShop }));
vi.mock("./offer-definitions.server.js", () => ({ invalidateOfferDefinitions: vi.fn(async () => undefined) }));
vi.mock("@sentry/node", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const { tryPublishShop, tryPublishShopOutcome } = await import("./offer-publish-flow.server.js");

beforeEach(() => publisher.publishOffersForShop.mockReset());

describe("tryPublishShopOutcome", () => {
  it("reports parked from this publish's own result, not from any shop-wide flag", async () => {
    publisher.publishOffersForShop.mockResolvedValueOnce("pending");
    expect(await tryPublishShopOutcome("s", "s.myshopify.com")).toEqual({ failure: null, parked: true });
    publisher.publishOffersForShop.mockResolvedValueOnce("published");
    expect(await tryPublishShopOutcome("s", "s.myshopify.com")).toEqual({ failure: null, parked: false });
  });

  it("a failure is never parked, and tryPublishShop still returns just the failure", async () => {
    publisher.publishOffersForShop.mockRejectedValue(new Error("Shopify exploded"));
    expect(await tryPublishShopOutcome("s", "s.myshopify.com")).toMatchObject({ parked: false, failure: { message: "Shopify exploded", scope: "shop" } });
    expect(await tryPublishShop("s", "s.myshopify.com")).toMatchObject({ message: "Shopify exploded" });
    publisher.publishOffersForShop.mockResolvedValue("pending");
    expect(await tryPublishShop("s", "s.myshopify.com")).toBeNull();
  });
});
