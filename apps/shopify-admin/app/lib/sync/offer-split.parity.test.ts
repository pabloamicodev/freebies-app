/**
 * Golden fixture for the Rust split-parity test (extensions/discount-function/src/parity_tests.rs).
 *
 * Each scenario carries the same offer twice: unsplit, and as the parts `splitOffer` produces. The Function must
 * discount the same lines by the same units for both, for every cart. The Rust test is not bound by Shopify's
 * 10 kB metafield limit, so the unsplit config can be as big as the offer really is.
 *
 * This test regenerates the fixture and fails when the file on disk differs.
 * Refresh with: UPDATE_SPLIT_FIXTURES=1 pnpm exec vitest run apps/shopify-admin/app/lib/sync/offer-split.parity.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serializeFunctionConfig, type CompiledOffer } from "./compile-config.js";
import { splitOffer } from "./offer-split.js";

const FILE = fileURLToPath(new URL("../../../extensions/discount-function/src/fixtures/split-parity.json", import.meta.url));
const OFFER_ID = "aaaaaaaa-0000-4000-8000-0000000000a1";
const V = (n: number) => `gid://shopify/ProductVariant/${40000000000 + n}`;
const P = (n: number) => `gid://shopify/Product/${70000000000 + n}`;
const range = (count: number, make: (n: number) => string) => Array.from({ length: count }, (_, n) => make(n));
const SOURCE = "kinetic";

function baseOffer(overrides: Partial<CompiledOffer>): CompiledOffer {
  return {
    id: OFFER_ID,
    version: 1,
    offerType: "discount",
    title: "Kinetic landing",
    priority: 5,
    stopLowerPriority: false,
    requiredProductIds: [],
    requiredVariantIds: [],
    anyRequiredProductIds: [],
    anyRequiredVariantIds: [],
    excludedProductIds: [],
    giftVariantIds: [],
    giftProductIds: [],
    discountType: "free",
    discountValue: 100,
    currencyCode: "USD",
    combinesWithOrderDiscounts: true,
    combinesWithShippingDiscounts: true,
    combinesWithProductDiscounts: true,
    requirements: [],
    giftRewards: [],
    productRewards: [],
    orderRewards: [],
    ...overrides,
  };
}

const anchorOffer = baseOffer({
  productRewards: [
    {
      id: "reward-landing",
      targetProductIds: [P(1), P(2)],
      targetVariantIds: [],
      discountType: "free",
      discountValue: 100,
      subscriptionMode: "any",
      scopeMode: "landing",
      requiredLineAttributeValue: SOURCE,
      requiredAnchorVariantIds: range(600, V),
      requiredAnchorMinQuantity: 1,
      requiresAnchorSubscription: false,
      priceTiers: [],
      quantityTiers: [],
      selectionMode: "all",
      countRule: "all",
      discountPercentageOnGifts: 100,
    },
  ],
});

const giftOffer = baseOffer({
  offerType: "gift",
  giftProductIds: range(600, (n) => P(1000 + n)),
  giftRewards: [
    {
      id: "reward-gift",
      targetProductIds: range(600, (n) => P(1000 + n)),
      targetVariantIds: [],
      discountType: "free",
      discountValue: 100,
      maxQuantity: 2,
    },
  ],
});

const config = (offers: CompiledOffer[]) =>
  JSON.parse(serializeFunctionConfig({ offers, shippingOffers: [], version: "parity", compiledAt: "2026-01-01T00:00:00.000Z" })) as unknown;

function split(offer: CompiledOffer): CompiledOffer[] {
  const result = splitOffer(offer, 9000);
  if (!result.ok) throw new Error(`split refused: ${result.reason}`);
  return result.parts.map((part) => part.offer);
}

const landingLine = (id: string, variant: number, product: number, quantity = 1) => ({
  id: `gid://shopify/CartLine/${id}`,
  variantId: V(variant),
  productId: P(product),
  quantity,
  unitPrice: "20.00",
  lineType: null,
  metadata: { _promo_page_url: "/pages/launch", __landing_source: SOURCE },
});

const giftLine = (id: string, product: number, quantity: number) => ({
  id: `gid://shopify/CartLine/${id}`,
  variantId: V(80000 + product),
  productId: P(product),
  quantity,
  unitPrice: "9.00",
  lineType: "gift" as const,
  metadata: { _promo_engine_offer_id: OFFER_ID, _promo_engine_reward_id: "reward-gift" },
});

const cart = (lines: unknown[]) => ({ currency: "USD", presentmentCurrencyRate: 1, country: "US", customerTags: [] as string[], enteredCodes: [] as string[], lines });

function build() {
  const anchorParts = split(anchorOffer);
  const giftParts = split(giftOffer);
  const anchorSlices = anchorParts.map((part) => part.productRewards[0]!.requiredAnchorVariantIds);
  const inSlice = (slice: number) => Number(anchorSlices[slice]![0]!.slice(V(0).length - 11)) - 40000000000;
  const target = landingLine("target", 7001, 1, 3);
  const second = landingLine("target2", 7002, 2, 2);
  const anchorScenario = (name: string, anchors: number[], discounts: boolean) => ({
    name,
    family: "anchor",
    discounts,
    cart: cart([...anchors.map((variant, index) => landingLine(`anchor${index}`, variant, 500 + index)), target, second]),
  });
  const giftScenario = (name: string, products: number[], discounts: boolean) => ({
    name,
    family: "gift",
    discounts,
    cart: cart([...products.map((product) => giftLine(`gift${product}`, 1000 + product, 5))]),
  });
  return {
    note: "Generated by app/lib/sync/offer-split.parity.test.ts. Do not edit.",
    parts: { anchor: anchorParts.length, gift: giftParts.length },
    families: {
      anchor: { unsplit: config([anchorOffer]), split: config(anchorParts) },
      gift: { unsplit: config([giftOffer]), split: config(giftParts) },
    },
    scenarios: [
      anchorScenario("anchor from the first slice", [inSlice(0)], true),
      anchorScenario("anchors from the first and last slice", [inSlice(0), inSlice(anchorParts.length - 1)], true),
      anchorScenario("anchors from every slice", anchorParts.map((_, slice) => inSlice(slice)), true),
      anchorScenario("a variant that is no anchor", [999999], false),
      anchorScenario("no anchor in the cart", [], false),
      giftScenario("one gift per slice, quantity above the limit", [0, 300, 599], true),
      giftScenario("a product that is no gift", [700], false),
    ],
  };
}

const serialize = () => `${JSON.stringify(build(), null, 2)}\n`;

describe("split parity fixture for the Rust Function", () => {
  it("splits the 600-anchor offer three ways and the 600-gift-product offer likewise", () => {
    const fixture = build();
    expect(fixture.parts.anchor).toBe(3);
    expect(fixture.parts.gift).toBeGreaterThanOrEqual(3);
  });

  if (process.env["UPDATE_SPLIT_FIXTURES"] === "1") {
    it("writes the fixture", () => {
      writeFileSync(FILE, serialize());
    });
  } else {
    it("is in sync with the splitter output", () => {
      expect(existsSync(FILE), "missing split-parity.json, run with UPDATE_SPLIT_FIXTURES=1").toBe(true);
      expect(readFileSync(FILE, "utf8")).toBe(serialize());
    });
  }
});
