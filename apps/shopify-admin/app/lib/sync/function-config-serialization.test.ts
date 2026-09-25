import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapAmbrosiaPresetToDev,
  type SeedOffer,
} from "../../../../../scripts/seed-ambrosia-e2e.js";
import { getLegacyStorePreset } from "../legacy-store-presets.server.js";
import { computeOfferVersion } from "../offer-version.server.js";
import { buildCartValidationConfig } from "../cart-validation.server.js";
import { buildAttributeQueryVariables } from "./attribute-query-variables.js";
import {
  compactCompiledOffer,
  compileOfferConfig,
  compileShippingOfferConfigs,
  serializeFunctionConfig,
  type CompiledFunctionConfig,
} from "./compile-config.js";

type CompileArgs = Parameters<typeof compileOfferConfig>;

const FIXTURE_DIR = resolve(__dirname, "../../../extensions/discount-function/src/fixtures");
const AMBROSIA_SHOP = "ambrosia-nutraceuticals.myshopify.com";
const DISABLED_AMBROSIA_RULES = new Set([
  "sitewide-free-shipping-mtt2zu2r",
  "landing-free-shipping-mtt5s7nx",
]);

const AMBROSIA_DEV_FIXTURES = {
  anchorProductId: "gid://shopify/Product/10000000000001",
  anchorVariantId: "gid://shopify/ProductVariant/50000000000001",
  frotherProductId: "gid://shopify/Product/10000000000002",
  otgProductId: "gid://shopify/Product/10000000000003",
  giftCardProductId: "gid://shopify/Product/10000000000004",
  thirdGiftProductId: "gid://shopify/Product/10000000000005",
  shirtVariantIds: [
    "gid://shopify/ProductVariant/50000000000011",
    "gid://shopify/ProductVariant/50000000000012",
    "gid://shopify/ProductVariant/50000000000013",
    "gid://shopify/ProductVariant/50000000000014",
  ],
  sellingPlanId: "gid://shopify/SellingPlan/7000000001",
};

const uuid = (group: number, index: number) =>
  `${String(group).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;

type PresetOffer = Pick<SeedOffer, "type" | "priority" | "conditions" | "rewards">;

function buildConfig(presetOffers: PresetOffer[]): CompiledFunctionConfig {
  const allConditions: CompileArgs[1] = [];
  const compiled = presetOffers.map((presetOffer, offerIndex) => {
    const offer = {
      id: uuid(1, offerIndex),
      type: presetOffer.type,
      priority: presetOffer.priority,
    } as CompileArgs[0];
    const conditions = presetOffer.conditions.map(
      (condition, index) =>
        ({
          ...condition,
          scope: "main",
          isEnabled: true,
          sortOrder: index,
        }) as unknown as CompileArgs[1][number],
    );
    allConditions.push(...conditions);
    const rewards = presetOffer.rewards.map(
      (reward, index) =>
        ({
          ...reward,
          id: uuid(2, offerIndex * 10 + index),
          quantity: reward.quantity ?? null,
          sortOrder: index,
        }) as unknown as CompileArgs[2][number],
    );
    const policy = {
      stopLowerPriority: false,
      combinesWithOrderDiscounts: true,
      combinesWithProductDiscounts: true,
      combinesWithShippingDiscounts: true,
    } as CompileArgs[3];
    return {
      offer: compileOfferConfig(
        offer,
        conditions,
        rewards,
        policy,
        computeOfferVersion(offer, conditions, rewards, policy),
      ),
      shippingOffers: compileShippingOfferConfigs(offer, conditions, rewards),
    };
  });
  return {
    offers: compiled.map((entry) => entry.offer),
    shippingOffers: compiled.flatMap((entry) => entry.shippingOffers),
    version: "1",
    compiledAt: "2026-09-25T12:00:00.000Z",
    ...buildAttributeQueryVariables(allConditions),
  };
}

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

function ambrosiaDevOffers(): SeedOffer[] {
  return mapAmbrosiaPresetToDev(getLegacyStorePreset(AMBROSIA_SHOP)!, AMBROSIA_DEV_FIXTURES);
}

// Exercises the defaults the Ambrosia rules never touch.
const COVERAGE_OFFERS: PresetOffer[] = [
  {
    type: "discount",
    priority: 200,
    conditions: [
      {
        conditionType: "customer_tags",
        operator: "all",
        value: { includeTags: ["vip"], excludeTags: [], treatGuestAsNoTags: false },
      },
      {
        conditionType: "specific_link",
        operator: "all",
        value: { requiredUrl: "https://example.com/pages/promo?ref=1" },
      },
    ],
    rewards: [
      {
        rewardType: "product_discount",
        discountType: "percentage",
        value: {
          amount: 15,
          currencyCode: "USD",
          tiers: [{ minimumQuantity: 2, discountType: "percentage", discountValue: 20 }],
        },
        target: {
          productIds: ["gid://shopify/Product/10000000000006"],
          selectionMode: "cheapest",
          countRule: "unique",
          discountPercentageOnGifts: 50,
        },
        label: "coverage",
      },
    ],
  },
  {
    type: "discount",
    priority: 201,
    conditions: [
      {
        conditionType: "customer_tags",
        operator: "all",
        value: { includeTags: [], excludeTags: ["wholesale"] },
      },
    ],
    rewards: [
      {
        rewardType: "order_discount" as never,
        discountType: "percentage",
        value: {
          amount: 10,
          currencyCode: "USD",
          tiers: [{ minimumSubtotalCents: 10000, discountType: "percentage", discountValue: 15 }],
        },
        target: {},
        label: "coverage",
      },
    ],
  },
];

function fixtureConfig(): CompiledFunctionConfig {
  return buildConfig([...ambrosiaDevOffers(), ...COVERAGE_OFFERS]);
}

describe("serializeFunctionConfig", () => {
  it("fits the Ambrosia dev fixture and production preset with headroom", () => {
    const dev = buildConfig(ambrosiaDevOffers().filter((offer) => offer.status === "active"));
    const production = buildConfig(
      getLegacyStorePreset(AMBROSIA_SHOP)!.offers.filter(
        (offer) => !DISABLED_AMBROSIA_RULES.has(offer.key),
      ),
    );
    const sizes = {
      devFull: bytes(JSON.stringify(dev)),
      devCompact: bytes(serializeFunctionConfig(dev)),
      productionFull: bytes(JSON.stringify(production)),
      productionCompact: bytes(serializeFunctionConfig(production)),
      productionValidation: bytes(JSON.stringify(buildCartValidationConfig(production.offers))),
    };
    console.info("Ambrosia function config bytes", sizes);

    expect(dev.offers).toHaveLength(9);
    expect(sizes.devCompact).toBeLessThan(7000);
    expect(sizes.productionCompact).toBeLessThan(7000);
    expect(sizes.productionValidation).toBeLessThan(9500);
  });

  it("only drops keys the Functions default or never read", () => {
    const config = fixtureConfig();
    const compact = JSON.parse(serializeFunctionConfig(config)) as Record<string, unknown>;
    const full = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;

    const isSubset = (partial: unknown, whole: unknown): boolean => {
      if (Array.isArray(partial))
        return (
          Array.isArray(whole) &&
          partial.length === whole.length &&
          partial.every((item, index) => isSubset(item, whole[index]))
        );
      if (partial && typeof partial === "object")
        return Object.entries(partial).every(([key, value]) =>
          isSubset(value, (whole as Record<string, unknown>)[key]),
        );
      return Object.is(partial, whole);
    };
    expect(isSubset(compact, full)).toBe(true);
    expect(compact).toMatchObject({ offers: expect.any(Array), version: "1" });
    for (const offer of config.offers) {
      expect(compactCompiledOffer(offer)).toMatchObject({
        id: offer.id,
        version: offer.version,
        offerType: offer.offerType,
        priority: offer.priority,
      });
    }
    const treatGuest = (compact["offers"] as Array<Record<string, unknown>>).map(
      (offer) => offer["treatGuestAsNoTags"],
    );
    expect(treatGuest).toContain(false);
    expect(treatGuest).not.toContain(true);
  });

  // The Rust suites deserialize both files and assert identical configs and
  // Function output, proving every omitted key matches its serde default.
  // Regenerate with UPDATE_FUNCTION_FIXTURES=1 after changing compile output.
  it("matches the cross-language fixtures", () => {
    const config = fixtureConfig();
    if (process.env["UPDATE_FUNCTION_FIXTURES"]) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(
        resolve(FIXTURE_DIR, "ambrosia-function-config.full.json"),
        `${JSON.stringify(config, null, 2)}
`,
      );
      writeFileSync(
        resolve(FIXTURE_DIR, "ambrosia-function-config.compact.json"),
        `${serializeFunctionConfig(config)}
`,
      );
    }
    const read = (name: string) =>
      JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), "utf8")) as unknown;
    expect(JSON.parse(JSON.stringify(config))).toEqual(read("ambrosia-function-config.full.json"));
    expect(JSON.parse(serializeFunctionConfig(config))).toEqual(
      read("ambrosia-function-config.compact.json"),
    );
  });
});
