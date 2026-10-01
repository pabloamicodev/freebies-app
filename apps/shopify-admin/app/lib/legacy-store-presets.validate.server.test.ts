import { describe, expect, it } from "vitest";
import {
  getLegacyStorePreset,
  validateLegacyStorePreset,
} from "./legacy-store-presets.server.js";

const SHOPS = [
  "hpn-supplements.myshopify.com",
  "onesolsupps.myshopify.com",
  "ambrosia-nutraceuticals.myshopify.com",
  "gettrusupps.myshopify.com",
];

describe("validateLegacyStorePreset", () => {
  it.each(SHOPS)("accepts every offer of %s", (shop) => {
    const preset = getLegacyStorePreset(shop);
    expect(preset).not.toBeNull();
    expect(() => validateLegacyStorePreset(preset!)).not.toThrow();
  });

  it("uses unique keys and internal names within a store", () => {
    for (const shop of SHOPS) {
      const { offers } = getLegacyStorePreset(shop)!;
      expect(new Set(offers.map((o) => o.key)).size).toBe(offers.length);
      expect(new Set(offers.map((o) => o.internalName)).size).toBe(offers.length);
    }
  });
});
