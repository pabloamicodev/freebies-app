import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import { eq } from "drizzle-orm";
import { discountCodes, offers, type Db } from "@promo/db";
import { evaluate, type EvaluatorContext, type OfferDefinition } from "@promo/rule-engine";
import type { EvaluationInput, NormalizedCart } from "@promo/shared-types";
import {
  MAX_ENTERED_CODES,
  MISSED_CODE_LIMIT,
  MISSED_CODE_WINDOW_MS,
  applyCodeGates,
  applyCodeGatesDetailed,
  normalizeEnteredCodes,
  resetShopCodeLocks,
} from "./code-gate.server.js";
vi.mock("@sentry/node", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
// Misses always hit a limiter now; the default one would need a real shared backend.
vi.mock("./rate-limit.server.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkRateLimit: vi.fn(async () => ({ ok: true as const })),
}));
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

let db: Db;
let close: () => Promise<void>;
let shopId: string;
const NOW = new Date("2026-06-01T12:00:00Z");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db);
}, 60_000);
afterAll(async () => {
  await close();
});

function giftOffer(id: string): OfferDefinition {
  return {
    id,
    version: 1,
    type: "gift",
    priority: 100,
    stopLowerPriority: false,
    startsAt: null,
    endsAt: null,
    conditions: [
      {
        id: `cond-${id}`,
        scope: "main",
        conditionType: "cart_value",
        operator: "gte",
        value: { thresholdCents: 0, currencyCode: "USD", includeGiftValues: false },
        isEnabled: true,
        sortOrder: 0,
      },
    ],
    rewards: [
      {
        id: `reward-${id}`,
        rewardType: "product_gift",
        discountType: "free",
        value: { percentage: 100 },
        target: { variantIds: [`gid://shopify/ProductVariant/gift-${id}`] },
        quantity: 1,
        isAutoAdd: true,
        isCustomerSelectable: false,
        trackMode: "variant" as const,
        sortOrder: 0,
        label: null,
      },
    ],
    combinationPolicy: {
      combinesWithOrderDiscounts: true,
      combinesWithProductDiscounts: true,
      combinesWithShippingDiscounts: true,
      stopLowerPriority: false,
      maxApplicationsPerCart: null,
      maxApplicationsPerCustomer: null,
    },
    giftValueCountsForOtherOffers: false,
  };
}

const line = (key: string, properties: Record<string, string> = {}, price = 5000) => ({
  key,
  variantId: `gid://shopify/ProductVariant/${key}`,
  productId: `gid://shopify/Product/${key}`,
  quantity: 1,
  priceCents: price,
  compareAtPriceCents: null,
  properties,
  requiresSellingPlan: false,
  sellingPlanId: null,
  productHandle: key,
  productTitle: key,
  variantTitle: null,
  vendor: "V",
  productType: "T",
  tags: [],
  collections: [],
  availableForSale: true,
  inventoryPolicy: "DENY" as const,
  inventoryQuantity: 10,
});

function cart(discountCodes: string[], withGiftLine = false): NormalizedCart {
  const lines = [line("shirt")];
  if (withGiftLine) {
    lines.push(
      line("gift-offer-code", {
        _promo_engine_line_type: "gift",
        _promo_engine_offer_id: "OFFER",
        _promo_engine_reward_id: "reward-OFFER",
        _promo_engine_offer_version: "1",
        _promo_engine_hash: "x",
      }, 0),
    );
  }
  return {
    token: "t",
    id: null,
    lines,
    subtotalCents: 5000,
    discountCodes,
    currencyCode: "USD",
    totalQuantity: lines.length,
  };
}

const input = (c: NormalizedCart): EvaluationInput => ({
  shopDomain: "test-shop.myshopify.com",
  cart: c,
  customer: null,
  market: null,
  locale: "en",
  salesChannel: "online_store",
  requestedUrl: null,
  sessionId: "s",
});

async function run(definition: OfferDefinition, c: NormalizedCart) {
  const gated = await applyCodeGates(shopId, db, [definition], c.discountCodes, NOW);
  const ctx: EvaluatorContext = { offers: gated, oneUseStates: [], now: NOW };
  return evaluate(input(c), ctx);
}

describe("applyCodeGates + evaluate: a gift on a code offer follows the applied code", () => {
  it("adds the gift only while one of the offer's codes is applied", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    await db.insert(discountCodes).values([
      { shopId, offerId, code: "SUMMER10" },
      { shopId, offerId, code: "SUMMER11" },
    ]);
    const offer = giftOffer(offerId);

    const without = await run(offer, cart([]));
    expect(without.qualifiedOffers).toHaveLength(0);
    expect(without.cartActions).toEqual([]);

    const withCode = await run(offer, cart(["summer11"]));
    expect(withCode.qualifiedOffers).toHaveLength(1);
    expect(withCode.cartActions[0]?.action).toBe("add_line");
  });

  it("removes the gift line again once the code is removed", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    await db.insert(discountCodes).values({ shopId, offerId, code: "REMOVEME" });
    const offer = giftOffer(offerId);
    const giftLine = (c: NormalizedCart) =>
      ({
        ...c,
        lines: c.lines.map((l) =>
          l.key === "gift-offer-code"
            ? { ...l, properties: { ...l.properties, _promo_engine_offer_id: offerId, _promo_engine_reward_id: `reward-${offerId}` } }
            : l,
        ),
      }) as NormalizedCart;

    expect((await run(offer, giftLine(cart(["REMOVEME"], true)))).qualifiedOffers).toHaveLength(1);

    const codeRemoved = await run(offer, giftLine(cart([], true)));
    expect(codeRemoved.qualifiedOffers).toHaveLength(0);
    expect(codeRemoved.cartActions.find((a) => a.action === "remove_line")).toMatchObject({ lineKey: "gift-offer-code" });
  });

  it("a code that belongs to another offer does not unlock this one", async () => {
    const offerA = await seedOffer(db, shopId, { requiresCode: true });
    const offerB = await seedOffer(db, shopId, { requiresCode: true });
    await db.insert(discountCodes).values([
      { shopId, offerId: offerA, code: "ONLYA" },
      { shopId, offerId: offerB, code: "ONLYB" },
    ]);

    const result = await run(giftOffer(offerA), cart(["ONLYB"]));
    expect(result.qualifiedOffers).toHaveLength(0);
  });

  it("does not unlock on a deactivated, expired, not-yet-started or used-up code", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    await db.insert(discountCodes).values([
      { shopId, offerId, code: "OFF1", status: "disabled" },
      { shopId, offerId, code: "EXP1", endsAt: new Date("2026-05-01") },
      { shopId, offerId, code: "SOON1", startsAt: new Date("2026-07-01") },
      { shopId, offerId, code: "FULL1", usageLimit: 1, usageCount: 1, status: "exhausted" },
    ]);
    for (const code of ["OFF1", "EXP1", "SOON1", "FULL1"]) {
      expect((await run(giftOffer(offerId), cart([code]))).qualifiedOffers).toHaveLength(0);
    }
    await db.update(discountCodes).set({ status: "active" }).where(eq(discountCodes.code, "OFF1"));
    expect((await run(giftOffer(offerId), cart(["OFF1"]))).qualifiedOffers).toHaveLength(1);
  });

  it("still gates an offer that only has a legacy required code, and leaves non-code offers alone", async () => {
    const legacyId = await seedOffer(db, shopId, { requiredDiscountCode: "LEGACYGATE" });
    const plainId = await seedOffer(db, shopId);

    expect((await run(giftOffer(legacyId), cart([]))).qualifiedOffers).toHaveLength(0);
    expect((await run(giftOffer(legacyId), cart(["legacygate"]))).qualifiedOffers).toHaveLength(1);

    const [plain] = await applyCodeGates(shopId, db, [giftOffer(plainId)], []);
    expect(plain!.conditions).toHaveLength(1);
    expect((await run(giftOffer(plainId), cart([]))).qualifiedOffers).toHaveLength(1);
  });

  it("does not gate an automatic offer, even one that keeps its codes and flag", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true, codeRedemption: "automatic" });
    await db.insert(discountCodes).values({ shopId, offerId, code: "PAUSEDGATE" });

    const result = await run(giftOffer(offerId), cart([]));
    expect(result.qualifiedOffers).toHaveLength(1);
    const [definition] = await applyCodeGates(shopId, db, [giftOffer(offerId)], []);
    expect(definition!.conditions).toHaveLength(1);
    expect(definition!.conditions[0]).not.toMatchObject({ id: "code-gate" });
    await db.update(offers).set({ codeRedemption: "checkout_code" }).where(eq(offers.id, offerId));
    expect((await run(giftOffer(offerId), cart([]))).qualifiedOffers).toHaveLength(0);
  });

  it("ignores codes belonging to another shop", async () => {
    const otherShop = await seedShop(db, "gate-other.myshopify.com");
    const otherOffer = await seedOffer(db, otherShop, { requiresCode: true });
    await db.insert(discountCodes).values({ shopId: otherShop, offerId: otherOffer, code: "FOREIGN1" });
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    await db.insert(discountCodes).values({ shopId, offerId, code: "HOME1" });

    expect((await run(giftOffer(offerId), cart(["FOREIGN1"]))).qualifiedOffers).toHaveLength(0);
  });
});

describe("the gate does not need to scan the codes table", () => {
  it("gates on offers.requires_code alone: an offer that has the flag stays inert with no codes", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    expect((await run(giftOffer(offerId), cart(["ANYTHING"]))).qualifiedOffers).toHaveLength(0);
  });
});

describe("code-guessing guards", () => {
  it("looks at no more than 5 distinct entered codes", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    await db.insert(discountCodes).values({ shopId, offerId, code: "SIXTH-CODE" });
    const six = ["A1", "A2", "A3", "A4", "A5", "SIXTH-CODE"];

    const result = await applyCodeGatesDetailed(shopId, db, [giftOffer(offerId)], six, NOW);
    expect(result.truncated).toBe(true);
    // The valid code was 6th, so it never got looked at: the offer stays gated shut.
    expect(result.definitions[0]!.conditions[0]).toMatchObject({ id: "code-gate", value: { code: "" } });

    const fifth = await applyCodeGatesDetailed(shopId, db, [giftOffer(offerId)], ["A1", "A2", "A3", "A4", "sixth-code"], NOW);
    expect(fifth.truncated).toBe(false);
    expect(fifth.definitions[0]!.conditions[0]).toMatchObject({ value: { code: "SIXTH-CODE" } });
  });

  it("normalizes, de-duplicates and caps entered codes", () => {
    expect(normalizeEnteredCodes([" a ", "A", "", "b"])).toEqual({ codes: ["A", "B"], truncated: false });
    expect(normalizeEnteredCodes(["1", "2", "3", "4", "5", "6", "7"])).toEqual({
      codes: ["1", "2", "3", "4", "5"],
      truncated: true,
    });
    expect(MAX_ENTERED_CODES).toBe(5);
  });

  it("counts codes that exist nowhere in the shop as misses against the visitor's limit", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    await db.insert(discountCodes).values({ shopId, offerId, code: "REALCODE1" });
    const seen: Array<{ key: string; limit: number; windowMs: number }> = [];
    const limiter = async (key: string, options: { limit: number; windowMs: number }) => {
      seen.push({ key, ...options });
      return { ok: true as const };
    };

    await applyCodeGatesDetailed(shopId, db, [giftOffer(offerId)], ["REALCODE1", "GUESS1", "GUESS2"], NOW, {
      rateLimitKey: "cart-abc",
      rateLimiter: limiter,
    });

    // Two misses, so two charges against the visitor and two against the shop; the real code is free.
    const visitor = seen.filter((call) => call.key.startsWith("code-miss:"));
    expect(visitor).toHaveLength(2);
    expect(visitor[0]).toEqual({
      key: `code-miss:${shopId}:cart-abc`,
      limit: MISSED_CODE_LIMIT,
      windowMs: MISSED_CODE_WINDOW_MS,
    });
    expect(seen.filter((call) => call.key === `code-miss-shop:${shopId}`)).toHaveLength(2);
  });

  it("does not charge a miss for a real code of this shop, even on another offer", async () => {
    const offerA = await seedOffer(db, shopId, { requiresCode: true });
    const offerB = await seedOffer(db, shopId, { requiresCode: true });
    await db.insert(discountCodes).values({ shopId, offerId: offerB, code: "OTHEROFFER1" });
    const limiter = vi.fn(async () => ({ ok: true as const }));

    await applyCodeGatesDetailed(shopId, db, [giftOffer(offerA)], ["OTHEROFFER1"], NOW, {
      rateLimitKey: "cart-x",
      rateLimiter: limiter,
    });
    expect(limiter).not.toHaveBeenCalled();
  });

  it("does not charge a miss for another offer's legacy checkout code", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    await seedOffer(db, shopId, { requiredDiscountCode: "LEGACYELSEWHERE" });
    const limiter = vi.fn(async () => ({ ok: true as const }));

    await applyCodeGatesDetailed(shopId, db, [giftOffer(offerId)], ["LEGACYELSEWHERE"], NOW, {
      rateLimitKey: "cart-y",
      rateLimiter: limiter,
    });
    expect(limiter).not.toHaveBeenCalled();
  });

  it("once the miss budget is spent, a call that includes misses matches nothing, even a valid code", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    await db.insert(discountCodes).values({ shopId, offerId, code: "VALID-WHILE-BLOCKED" });
    const exhausted = async (key: string) =>
      key.startsWith("code-miss-shop:") ? { ok: true as const } : { ok: false as const, retryAfterSeconds: 60 };

    const blocked = await applyCodeGatesDetailed(
      shopId,
      db,
      [giftOffer(offerId)],
      ["VALID-WHILE-BLOCKED", "GUESS"],
      NOW,
      { rateLimitKey: "cart-z", rateLimiter: exhausted },
    );
    expect(blocked.blocked).toBe(true);
    expect(blocked.definitions[0]!.conditions[0]).toMatchObject({ value: { code: "" } });

    // A call with no misses is never charged, so a customer with a real code is not locked out.
    const clean = await applyCodeGatesDetailed(shopId, db, [giftOffer(offerId)], ["VALID-WHILE-BLOCKED"], NOW, {
      rateLimitKey: "cart-z",
      rateLimiter: exhausted,
    });
    expect(clean.blocked).toBe(false);
    expect(clean.definitions[0]!.conditions[0]).toMatchObject({ value: { code: "VALID-WHILE-BLOCKED" } });
  });

  it("a missing visitor key falls into one shared anonymous bucket instead of skipping the limit", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    const keys: string[] = [];
    const limiter = async (key: string) => {
      keys.push(key);
      return key.startsWith("code-miss-shop:") ? { ok: true as const } : { ok: false as const, retryAfterSeconds: 1 };
    };
    const result = await applyCodeGatesDetailed(shopId, db, [giftOffer(offerId)], ["NOPE"], NOW, { rateLimiter: limiter });
    expect(keys).toContain(`code-miss:${shopId}:anon`);
    expect(result.blocked).toBe(true);
  });
});

describe("shop-wide missed-code budget", () => {
  beforeEach(() => resetShopCodeLocks());

  it("counts every miss against an always-on shop counter (memory fallback, fixed window), whatever the visitor key", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    const calls: Array<{ key: string; options: object }> = [];
    const limiter = async (key: string, options: object) => {
      calls.push({ key, options });
      return { ok: true as const };
    };
    await applyCodeGatesDetailed(shopId, db, [giftOffer(offerId)], ["G1"], NOW, { rateLimitKey: "fresh-token-per-request", rateLimiter: limiter });
    const shopCall = calls.find((call) => call.key === `code-miss-shop:${shopId}`);
    expect(shopCall?.options).toMatchObject({ limit: 500, windowMs: MISSED_CODE_WINDOW_MS, fixedWindow: true, onRedisUnavailable: "memory" });
  });

  it("once the shop budget is spent it locks code matching for everyone, valid codes included, and alerts once", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    await db.insert(discountCodes).values({ shopId, offerId, code: "VALID-LOCKED" });
    const spent = async (key: string) => (key.startsWith("code-miss-shop:") ? { ok: false as const, retryAfterSeconds: 60 } : { ok: true as const });
    const warn = vi.mocked(Sentry.captureMessage).mockClear();

    const tripped = await applyCodeGatesDetailed(shopId, db, [giftOffer(offerId)], ["GUESS"], NOW, { rateLimitKey: "t1", rateLimiter: spent });
    expect(tripped.blocked).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ level: "warning" });

    // A different visitor with a perfectly valid code and no misses: still nothing matches (no oracle).
    const valid = await applyCodeGatesDetailed(shopId, db, [giftOffer(offerId)], ["VALID-LOCKED"], NOW, { rateLimitKey: "t2" });
    expect(valid.blocked).toBe(true);
    expect(valid.definitions[0]!.conditions[0]).toMatchObject({ id: "code-gate", value: { code: "" } });

    await applyCodeGatesDetailed(shopId, db, [giftOffer(offerId)], ["GUESS2"], NOW, { rateLimitKey: "t3", rateLimiter: spent });
    expect(warn).toHaveBeenCalledTimes(1);

    // Requests without codes are unaffected.
    expect((await applyCodeGatesDetailed(shopId, db, [giftOffer(offerId)], [], NOW)).blocked).toBe(false);
  });
});
