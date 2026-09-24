import { describe, expect, it } from "vitest";
import { getLegacyStorePreset, validateLegacyStorePreset } from "./legacy-store-presets.server.js";

const expectedOfferCounts = new Map([
  ["hpn-supplements.myshopify.com", 3],
  ["onesolsupps.myshopify.com", 1],
  ["ambrosia-nutraceuticals.myshopify.com", 1],
  ["gettrusupps.myshopify.com", 8],
]);

describe("legacy store presets", () => {
  it("keeps the expected migration inventory for every supported store", () => {
    for (const [shopDomain, expectedCount] of expectedOfferCounts) {
      expect(getLegacyStorePreset(shopDomain)?.offers).toHaveLength(expectedCount);
    }
  });

  it("validates every condition and reward against the current shared contracts", () => {
    for (const shopDomain of expectedOfferCounts.keys()) {
      const preset = getLegacyStorePreset(shopDomain);
      expect(preset).not.toBeNull();
      expect(() => validateLegacyStorePreset(preset!)).not.toThrow();
    }
  });

  it("matches domains case-insensitively and rejects unknown shops", () => {
    expect(getLegacyStorePreset("HPN-SUPPLEMENTS.MYSHOPIFY.COM")?.sourceName).toBe("HPN Supplements");
    expect(getLegacyStorePreset("unknown.myshopify.com")).toBeNull();
  });

  it("includes the quiz-bundle free-shipping rule from the legacy HPN inventory", () => {
    const preset = getLegacyStorePreset("gettrusupps.myshopify.com");
    expect(preset?.offers.some((offer) => offer.key === "quiz-bundle-free-shipping")).toBe(true);
  });
});
