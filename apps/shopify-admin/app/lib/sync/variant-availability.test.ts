import { describe, expect, it } from "vitest";
import { deriveWebhookAvailability, isStaleProductPayload } from "./variant-availability.js";

describe("deriveWebhookAvailability", () => {
  it("tracked with stock is available and tracked", () => {
    expect(deriveWebhookAvailability({ inventory_quantity: 3, inventory_policy: "deny", inventory_management: "shopify" }))
      .toEqual({ availableForSale: true, inventoryTracked: true });
  });

  it("tracked at zero or negative stock with deny is sold out", () => {
    for (const quantity of [0, -1]) {
      expect(deriveWebhookAvailability({ inventory_quantity: quantity, inventory_policy: "deny", inventory_management: "shopify" }))
        .toEqual({ availableForSale: false, inventoryTracked: true });
    }
  });

  it("explicitly untracked (null management) is available at zero stock", () => {
    expect(deriveWebhookAvailability({ inventory_quantity: 0, inventory_policy: "deny", inventory_management: null }))
      .toEqual({ availableForSale: true, inventoryTracked: false });
  });

  it("continue policy keeps a zero-stock variant sellable", () => {
    expect(deriveWebhookAvailability({ inventory_quantity: 0, inventory_policy: "continue", inventory_management: "shopify" }).availableForSale)
      .toBe(true);
    expect(deriveWebhookAvailability({ inventory_quantity: 0, inventory_policy: "CONTINUE" }).availableForSale).toBe(true);
  });

  it("a payload missing inventory_management is never read as untracked (the Ambrosia bug)", () => {
    expect(deriveWebhookAvailability({ inventory_quantity: 0, inventory_policy: "deny" }))
      .toEqual({ availableForSale: false, inventoryTracked: null });
    expect(deriveWebhookAvailability({ inventory_quantity: 2, inventory_policy: "deny" }).availableForSale).toBe(true);
  });

  it("a payload that does carry `available` wins", () => {
    expect(deriveWebhookAvailability({ inventory_quantity: 0, available: true }).availableForSale).toBe(true);
    expect(deriveWebhookAvailability({ inventory_quantity: 9, available: false }).availableForSale).toBe(false);
  });

  it("treats a null quantity as no stock", () => {
    expect(deriveWebhookAvailability({ inventory_quantity: null, inventory_policy: "deny" }).availableForSale).toBe(false);
  });
});

describe("isStaleProductPayload", () => {
  const synced = new Date("2026-10-01T10:00:00Z");

  it("flags a payload older than the cache's latest sync (would overwrite fresher inventory)", () => {
    expect(isStaleProductPayload("2026-10-01T09:59:59Z", synced)).toBe(true);
  });

  it("accepts a newer payload", () => {
    expect(isStaleProductPayload("2026-10-01T10:00:01Z", synced)).toBe(false);
  });

  it("never blocks when either timestamp is missing or unparseable", () => {
    expect(isStaleProductPayload(undefined, synced)).toBe(false);
    expect(isStaleProductPayload("2026-10-01T09:00:00Z", null)).toBe(false);
    expect(isStaleProductPayload("garbage", synced)).toBe(false);
  });
});
