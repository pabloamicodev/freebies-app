import { beforeEach, describe, expect, it, vi } from "vitest";
import { discountCodes, offerConditions, offerRewards, offers, type Db } from "@promo/db";

const publishOffersForShop = vi.fn();
vi.mock("./sync/offer-publisher.server.js", () => ({ publishOffersForShop: (...args: unknown[]) => publishOffersForShop(...args) }));
const invalidateOfferDefinitions = vi.fn(async () => undefined);
vi.mock("./offer-definitions.server.js", () => ({
  invalidateOfferDefinitions: (...args: unknown[]) => invalidateOfferDefinitions(...(args as [])),
}));

const { MIXED_ONCE_PER_CUSTOMER_MESSAGE, finalizeCreatedOffer, publishShopConfig, republishIfActive, validateOffersPublishable } =
  await import("./offer-publish-flow.server.js");

const updates: Array<Record<string, unknown>> = [];

const validGiftReward = {
  id: "r1",
  offerId: "o1",
  rewardType: "product_gift",
  discountType: "percentage",
  value: { amount: 10 },
  target: { productId: "gid://shopify/Product/1" },
  quantity: 1,
  isAutoAdd: false,
  isCustomerSelectable: false,
  sortOrder: 0,
  label: null,
};

function fakeDb(rows: {
  offerRows?: Array<{ id: string; internalName: string; requiredDiscountCode: string | null; requiresCode: boolean }>;
  conditionRows?: unknown[];
  rewardRows?: unknown[];
  codeRows?: unknown[];
} = {}): Db {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === offers) return Promise.resolve(rows.offerRows ?? []);
          if (table === offerConditions) return Promise.resolve(rows.conditionRows ?? []);
          if (table === offerRewards) return Promise.resolve(rows.rewardRows ?? []);
          if (table === discountCodes) return Promise.resolve(rows.codeRows ?? []);
          return Promise.resolve([]);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          return Promise.resolve();
        },
      }),
    }),
  };
  return db as unknown as Db;
}

beforeEach(() => {
  publishOffersForShop.mockReset();
  invalidateOfferDefinitions.mockClear();
  updates.length = 0;
});

describe("publishShopConfig", () => {
  it("reports success and drops the cached offer definitions", async () => {
    publishOffersForShop.mockResolvedValue("published");
    expect(await publishShopConfig("shop", "s.myshopify.com")).toBeNull();
    expect(invalidateOfferDefinitions).toHaveBeenCalledWith("shop");
  });

  it("treats a publish parked on the shop lock as success: it is pending, not an error", async () => {
    publishOffersForShop.mockResolvedValue("pending");
    expect(await publishShopConfig("shop", "s.myshopify.com")).toBeNull();
  });

  it("returns the message of a real failure", async () => {
    publishOffersForShop.mockRejectedValue(new Error("Function config is 12000B"));
    expect(await publishShopConfig("shop", "s.myshopify.com")).toBe("Function config is 12000B");
    expect(invalidateOfferDefinitions).not.toHaveBeenCalled();
  });
});

describe("a lock timeout never pauses an offer", () => {
  it("republishIfActive leaves an active offer active when its publish is parked as pending", async () => {
    publishOffersForShop.mockResolvedValue("pending");
    const db = fakeDb({
      offerRows: [{ id: "o1", internalName: "Offer", requiredDiscountCode: null, requiresCode: false }],
      conditionRows: [
        { id: "c", offerId: "o1", scope: "main", isEnabled: true, conditionType: "cart_value", operator: "gte", value: { thresholdCents: 100, currencyCode: "USD", includeGiftValues: false } },
      ],
      rewardRows: [
        validGiftReward,
      ],
    });

    expect(await republishIfActive(db, "shop", "s.myshopify.com", "o1", true)).toBeNull();
    expect(updates).toEqual([]);
  });

  it("republishIfActive still pauses the offer when the publish genuinely fails", async () => {
    publishOffersForShop.mockRejectedValue(new Error("Shopify rejected the config"));
    const db = fakeDb({
      offerRows: [{ id: "o1", internalName: "Offer", requiredDiscountCode: null, requiresCode: false }],
      conditionRows: [
        { id: "c", offerId: "o1", scope: "main", isEnabled: true, conditionType: "cart_value", operator: "gte", value: { thresholdCents: 100, currencyCode: "USD", includeGiftValues: false } },
      ],
      rewardRows: [
        validGiftReward,
      ],
    });

    const message = await republishIfActive(db, "shop", "s.myshopify.com", "o1", true);

    expect(message).toContain("Shopify rejected the config");
    expect(message).toContain("paused");
    expect(updates).toEqual([expect.objectContaining({ status: "paused" })]);
  });

  it("finalizeCreatedOffer keeps a new offer active when its publish is parked as pending", async () => {
    publishOffersForShop.mockResolvedValue("pending");
    const db = fakeDb({
      offerRows: [{ id: "o1", internalName: "Offer", requiredDiscountCode: null, requiresCode: false }],
      conditionRows: [
        { id: "c", offerId: "o1", scope: "main", isEnabled: true, conditionType: "cart_value", operator: "gte", value: { thresholdCents: 100, currencyCode: "USD", includeGiftValues: false } },
      ],
      rewardRows: [
        validGiftReward,
      ],
    });

    expect(await finalizeCreatedOffer(db, "shop", "s.myshopify.com", "o1", "active")).toBeNull();
    expect(updates).toEqual([]);
  });
});

describe("validateOffersPublishable: once-per-customer cannot be mixed in one code node", () => {
  const code = (overrides: Record<string, unknown>) => ({
    offerId: "o1",
    status: "active",
    startsAt: null,
    endsAt: null,
    usageLimit: null,
    usageCount: 0,
    oncePerCustomer: false,
    ...overrides,
  });
  const base = {
    offerRows: [{ id: "o1", internalName: "Codes offer", requiredDiscountCode: null, requiresCode: true }],
    rewardRows: [
      validGiftReward,
    ],
  };

  it("blocks an offer whose active codes disagree", async () => {
    const result = await validateOffersPublishable(
      fakeDb({ ...base, codeRows: [code({ oncePerCustomer: true }), code({ oncePerCustomer: false })] }),
      "shop",
      ["o1"],
    );
    expect(result).toEqual({ ok: false, error: MIXED_ONCE_PER_CUSTOMER_MESSAGE("Codes offer") });
  });

  it("accepts all once-per-customer, or none", async () => {
    for (const flag of [true, false]) {
      const result = await validateOffersPublishable(
        fakeDb({ ...base, codeRows: [code({ oncePerCustomer: flag }), code({ oncePerCustomer: flag })] }),
        "shop",
        ["o1"],
      );
      expect(result).toEqual({ ok: true });
    }
  });

  it("ignores codes that are not live: disabled, expired or used up", async () => {
    const result = await validateOffersPublishable(
      fakeDb({
        ...base,
        codeRows: [
          code({ oncePerCustomer: true }),
          code({ oncePerCustomer: false, status: "disabled" }),
          code({ oncePerCustomer: false, endsAt: new Date(Date.now() - 1000) }),
          code({ oncePerCustomer: false, usageLimit: 1, usageCount: 1 }),
        ],
      }),
      "shop",
      ["o1"],
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("validateOffersPublishable: shipping with page conditions", () => {
  const shipping = {
    offerRows: [{ id: "o1", internalName: "Ship", requiredDiscountCode: null, requiresCode: false }],
    rewardRows: [
      { id: "r", offerId: "o1", rewardType: "shipping_discount", discountType: "free", value: {}, target: {}, quantity: null },
    ],
  };
  const condition = (conditionType: string, value: unknown) => ({
    id: conditionType,
    offerId: "o1",
    scope: "main",
    isEnabled: true,
    conditionType,
    operator: "eq",
    value,
  });

  it("still rejects a non page condition on a shipping offer", async () => {
    const result = await validateOffersPublishable(
      fakeDb({ ...shipping, conditionRows: [condition("cart_value", { thresholdCents: 1, currencyCode: "USD", includeGiftValues: false }), condition("customer_tags", { tags: ["vip"], matchMode: "any" })] }),
      "shop",
      ["o1"],
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("do not yet support the customer_tags condition") as unknown as string });
  });

  it("no longer rejects a page condition on a shipping offer", async () => {
    const result = await validateOffersPublishable(
      fakeDb({
        ...shipping,
        conditionRows: [condition("page_url", { patterns: ["/collections/sale"], matchMode: "contains", caseSensitive: false })],
      }),
      "shop",
      ["o1"],
    );
    if (!result.ok) expect(result.error).not.toContain("do not yet support");
  });
});
