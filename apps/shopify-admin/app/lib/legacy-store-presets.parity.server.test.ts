/* eslint-disable @typescript-eslint/no-explicit-any -- untyped live JSON fixtures */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getLegacyStorePreset,
  validateLegacyStorePreset,
  type LegacyOfferPreset,
} from "./legacy-store-presets.server.js";

// Rules of the live hpn_scripts.function_configuration metafield (snapshot 2026-10-01).
// Swell rules are legacy no-ops (see the GetTru preset notes) and have no offer.
const STORES = ["hpn-supplements", "gettrusupps", "onesolsupps", "ambrosia-nutraceuticals"];
const NO_OP_RULE_TYPES = new Set(["swell_free_product", "swell_cart_fixed_amount"]);

type Rule = Record<string, any>;
const load = (store: string): { shop: string; rules: Rule[] } =>
  JSON.parse(
    readFileSync(new URL(`./__fixtures__/legacy-live/${store}.json`, import.meta.url), "utf8"),
  );

const sorted = (values: unknown) => [...((values as string[] | undefined) ?? [])].sort();
const target = (offer: LegacyOfferPreset) => offer.rewards[0]!.target as Record<string, any>;
const hasCartSubscriptionCondition = (offer: LegacyOfferPreset) =>
  offer.conditions.some(
    (c) =>
      c.conditionType === "subscription_product_type" &&
      (c.value as { mode?: string }).mode === "subscription_only",
  );

function expectRuleParity(rule: Rule, offer: LegacyOfferPreset) {
  const reward = offer.rewards[0]!;
  const t = target(offer);
  expect(offer.publicTitle).toBe(rule.message);

  switch (rule.type) {
    case "pa7_cross_sell":
      expect(offer.conditions[0]!.value).toEqual({
        requirements: [{ productId: rule.triggerProductId, trackMode: "product", minQuantity: 1 }],
      });
      expect(reward.value.amount).toBe(rule.discountPercentage);
      expect(sorted(t.productIds)).toEqual(sorted(rule.targetProductIds));
      expect(t.lineQuantityEquals).toBe(rule.targetLineQuantityEquals);
      break;
    case "required_variants_free_variants":
    case "required_product_with_free_variants": {
      const reqs = (offer.conditions[0]!.value as { requirements: Rule[] }).requirements;
      const expected = [
        ...(rule.triggerProductId ? [rule.triggerProductId] : []),
        ...rule.requiredVariantIds,
      ];
      expect(reqs.map((r) => r.productId ?? r.variantId).sort()).toEqual(expected.sort());
      expect(sorted(t.variantIds)).toEqual(sorted(rule.freeVariantIds));
      expect(reward.value.amount).toBe(rule.discountPercentage);
      // planta: first line only (per variant); pouches: every line (per line)
      expect(
        rule.type === "required_variants_free_variants" ? t.maxUnitsPerVariant : t.maxUnitsPerLine,
      ).toBe(rule.freeQuantityPerLine);
      break;
    }
    case "one_time_purchase_discount":
      expect(reward.discountType).toBe("percentage");
      expect(reward.value.amount).toBe(rule.discountPercentage);
      expect(sorted(t.variantIds)).toEqual(sorted(rule.targetVariantIds));
      expect(t.maxUnitsPerLine).toBe(1);
      expect(t.subscriptionMode).toBe("one_time_only");
      break;
    case "landing_scoped_product_discount": {
      expect(reward.discountType).toBe("free");
      expect(reward.value.amount).toBe(rule.discountPercentage);
      expect(t.scopeMode).toBe("landing");
      expect(t.requiredLineAttributeKey).toBe(rule.requiredLineAttributeKey);
      expect(t.requiredLineAttributeValue).toBe(rule.requiredLineAttributeValue);
      expect(sorted(t.productIds)).toEqual(sorted(rule.targetProductIds));
      expect(sorted(t.requiredAnchorVariantIds)).toEqual(sorted(rule.requiredAnchorVariantIds));
      expect(t.requiredAnchorMinQuantity).toBe(rule.requiredAnchorMinQuantity ?? 1);
      expect(t.maxUnitsPerProduct).toBe(1);
      // cart-level subscription requirement -> main condition, never the anchor-line flag
      expect(hasCartSubscriptionCondition(offer)).toBe(
        rule.conditions?.requiresSubscriptionInCart === true,
      );
      expect(t.requiresAnchorSubscription).toBe(rule.requiresAnchorSubscription === true);
      break;
    }
    case "landing_quantity_tier_fixed_price":
      expect(reward.discountType).toBe("fixed_price");
      expect(t.scopeMode).toBe("landing");
      expect(t.requiredLineAttributeValue).toBe(rule.requiredLineAttributeValue);
      expect(sorted(t.variantIds)).toEqual(sorted(rule.targetVariantIds));
      expect(t.subscriptionMode).toBe(rule.requiresSubscription ? "subscription_only" : "one_time_only");
      expect(t.priceTiers).toEqual(rule.tiers);
      // no-anchor mode would exclude the tiered variants themselves, so they anchor themselves
      expect(sorted(t.requiredAnchorVariantIds)).toEqual(sorted(rule.targetVariantIds));
      expect(t.requiredAnchorMinQuantity).toBe(1);
      break;
    case "cart_subtotal_free_gift": {
      const [tier] = rule.tiers;
      expect(rule.tiers).toHaveLength(1);
      expect(offer.type).toBe("gift");
      expect(offer.conditions[0]!.value).toMatchObject({
        thresholdCents: Math.round(tier.minimumSubtotal * 100),
        includeGiftValues: false,
      });
      expect(sorted(t.variantIds)).toEqual(sorted(tier.giftVariantIds));
      expect(reward.quantity).toBe(tier.maxFreeUnits);
      expect(reward.value.amount).toBe(tier.discountPercentage);
      break;
    }
    case "quiz_bundle_price_match":
      expect(t.scopeMode).toBe("quiz_bundle");
      expect(t.discountPercentageOnGifts).toBe(rule.discountPercentageOnGifts);
      expect((t.productIds as string[]).length).toBeGreaterThan(0);
      break;
    case "landing_free_shipping":
    case "sitewide_free_shipping":
    case "quiz_bundle_free_shipping": {
      expect(reward.rewardType).toBe("shipping_discount");
      // absent targetDeliveryGroupTypes = every delivery group; the preset lists both
      expect(sorted(t.deliveryGroupTypes)).toEqual(
        sorted(rule.targetDeliveryGroupTypes ?? ["ONE_TIME_PURCHASE", "SUBSCRIPTION"]),
      );
      if (rule.shippingTiers) {
        expect(reward.value.tiers).toEqual(
          rule.shippingTiers.map((x: Rule) => ({
            minimumSubtotalCents: Math.round(x.minimumSubtotal * 100),
            discountType: "percentage",
            discountValue: x.discountPercentage,
            appliesWhen: x.appliesWhen,
          })),
        );
      } else {
        // deliveryDiscountType/Percentage default to a 100% percentage discount
        expect(rule.deliveryDiscountType ?? "percentage").toBe("percentage");
        expect(rule.deliveryDiscountPercentage ?? 100).toBe(100);
        expect(reward.discountType).toBe("free");
      }
      if (rule.type === "landing_free_shipping") {
        expect(t.scopeMode).toBe("landing");
        expect(t.requiredLineAttributeValue).toBe(rule.requiredLineAttributeValue);
        expect(sorted(t.requiredAnchorVariantIds)).toEqual(sorted(rule.requiredAnchorVariantIds));
        expect(t.requiredAnchorMinQuantity).toBe(rule.requiredAnchorMinQuantity ?? 1);
        // the legacy shipping Function ignores conditions.requiresSubscriptionInCart
        expect(t.requiresAnchorSubscription).toBe(rule.requiresAnchorSubscription === true);
      } else if (rule.type === "quiz_bundle_free_shipping") {
        expect(t.scopeMode).toBe("quiz_bundle");
      } else {
        expect(t.scopeMode).toBe("sitewide");
      }
      break;
    }
    default:
      throw new Error(`Unhandled live rule type ${rule.type} (${rule.id})`);
  }
}

describe.each(STORES)("legacy preset parity: %s", (store) => {
  const { shop, rules } = load(store);
  const preset = getLegacyStorePreset(shop)!;
  const relevant = rules.filter((rule) => !NO_OP_RULE_TYPES.has(rule.type));

  it("has a preset and passes validation", () => {
    expect(preset).toBeDefined();
    expect(() => validateLegacyStorePreset(preset)).not.toThrow();
  });

  it("has exactly one offer per live rule, in live order, and no extras", () => {
    expect(preset.offers.map((offer) => offer.key)).toEqual(relevant.map((rule) => rule.id));
  });

  it("imports disabled live rules as drafts that say so, enabled ones without that note", () => {
    for (const rule of relevant) {
      const offer = preset.offers.find((o) => o.key === rule.id)!;
      expect(/disabled in the/i.test(offer.description), rule.id).toBe(rule.enabled === false);
    }
  });

  for (const rule of relevant) {
    it(`matches ${rule.type} ${rule.id}`, () => {
      expectRuleParity(rule, preset.offers.find((o) => o.key === rule.id)!);
    });
  }
});
