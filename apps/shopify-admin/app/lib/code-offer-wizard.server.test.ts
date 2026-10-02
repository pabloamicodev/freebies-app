import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  discountCodes,
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  type Db,
} from "@promo/db";
import { insertCodeOffer, parseCodeOfferForm } from "./code-offer-wizard.server.js";
import { CODE_TAKEN_MESSAGE, createDiscountCode } from "./discount-codes.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let counter = 0;
const context = { timezone: "UTC", currencyCode: "USD" };

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  const defaults: Record<string, string | string[]> = {
    intent: "draft",
    internalName: `Code offer ${(counter += 1)}`,
    publicTitle: "Discount code",
    codeMode: "single",
    discountTarget: "order",
    discountType: "percentage",
    discountValue: "10",
    pageTypes: ["home", "collection", "product"],
    mixedCart: "only_matched",
    combinesProductDiscounts: "on",
  };
  for (const [key, value] of Object.entries({ ...defaults, ...fields })) {
    for (const entry of Array.isArray(value) ? value : [value]) data.append(key, entry);
  }
  return data;
}

async function create(fields: Record<string, string | string[]>, resolve?: (ids: string[]) => Promise<string[]>) {
  const parsed = parseCodeOfferForm(form(fields), context);
  if (!parsed.ok) return parsed;
  return insertCodeOffer(db, shopId, "UTC", parsed.data, resolve);
}

async function offerRows(offerId: string) {
  const [offer] = await db.select().from(offers).where(eq(offers.id, offerId));
  const [codes, conditions, rewards, policies] = await Promise.all([
    db.select().from(discountCodes).where(eq(discountCodes.offerId, offerId)),
    db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId)),
    db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)),
    db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offerId)),
  ]);
  return { offer: offer!, codes, conditions, rewards, policies };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db);
}, 60_000);
afterAll(async () => {
  await close();
});

describe("code offer wizard: single code", () => {
  it("creates a code-gated discount offer with its code, page rule, reward and policy in one go", async () => {
    const result = await create({ code: "summer10", usageLimit: "50", oncePerCustomer: "on" });
    if (!result.ok) throw new Error(result.error);
    expect(result.data.codesCreated).toBe(1);

    const { offer, codes, conditions, rewards, policies } = await offerRows(result.data.offerId);
    expect(offer).toMatchObject({ type: "discount", status: "draft", requiresCode: true });
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ code: "SUMMER10", usageLimit: 50, oncePerCustomer: true });
    expect(conditions).toEqual([
      expect.objectContaining({
        scope: "main",
        conditionType: "page_types",
        value: { pageTypes: ["home", "collection", "product"], onlyMatchedLines: true, rejectUnmatchedLines: false },
      }),
    ]);
    expect(rewards[0]).toMatchObject({
      rewardType: "order_discount",
      discountType: "percentage",
      value: { amount: 10, currencyCode: "USD" },
      target: { scope: "cart" },
    });
    expect(policies[0]).toMatchObject({
      combinesWithProductDiscounts: true,
      combinesWithOrderDiscounts: false,
      combinesWithShippingDiscounts: false,
    });
  });

  it("stores fixed amounts in cents and product targets as product ids", async () => {
    const result = await create({
      code: "FIVEOFF",
      discountTarget: "products",
      discountType: "fixed_amount",
      discountValue: "5.5",
      productIds: JSON.stringify(["gid://shopify/Product/1", "gid://shopify/ProductVariant/9"]),
    });
    if (!result.ok) throw new Error(result.error);
    const { rewards } = await offerRows(result.data.offerId);
    expect(rewards[0]).toMatchObject({
      rewardType: "product_discount",
      discountType: "fixed_amount",
      value: { amount: 550 },
      target: { scopeMode: "sitewide", productIds: ["gid://shopify/Product/1"] },
    });
  });

  it("expands collections into product ids at save time", async () => {
    const result = await create(
      {
        code: "COLLECT1",
        discountTarget: "products",
        productIds: JSON.stringify(["gid://shopify/Product/1"]),
        collectionIds: JSON.stringify(["gid://shopify/Collection/7"]),
      },
      async (ids) => (ids[0] === "gid://shopify/Collection/7" ? ["gid://shopify/Product/1", "gid://shopify/Product/2"] : []),
    );
    if (!result.ok) throw new Error(result.error);
    const { rewards } = await offerRows(result.data.offerId);
    expect((rewards[0]!.target as { productIds: string[] }).productIds).toEqual([
      "gid://shopify/Product/1",
      "gid://shopify/Product/2",
    ]);
  });

  it("free shipping gets no page or UTM rules, since the delivery Function can't check them", async () => {
    const result = await create({ code: "SHIPFREE", discountTarget: "shipping", utmEnabled: "on", utmSource: "x" });
    if (!result.ok) throw new Error(result.error);
    const { conditions, rewards } = await offerRows(result.data.offerId);
    expect(conditions).toEqual([]);
    expect(rewards[0]).toMatchObject({ rewardType: "shipping_discount", discountType: "free" });
  });
});

describe("code offer wizard: bulk and campaign", () => {
  it("generates the batch and writes UTM + mixed-cart flags onto every page-matching condition", async () => {
    const result = await create({
      codeMode: "bulk",
      batchCount: "40",
      batchPrefix: "vip-",
      batchLength: "6",
      batchCharset: "letters",
      usageLimit: "1",
      pageTypes: ["product"],
      utmEnabled: "on",
      utmSource: " newsletter ",
      utmScope: "visit",
      mixedCart: "reject",
      subconditions: JSON.stringify({
        link: { requiredUrl: "/pages/vip", paramName: "ref", paramValue: "" },
        customer_tags: { includeTags: ["vip"], excludeTags: [] },
        // Owned by the dedicated steps; a stray builder value must not win.
        page_types: { pageTypes: ["cart"] },
      }),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.data.codesCreated).toBe(40);

    const { codes, conditions } = await offerRows(result.data.offerId);
    expect(codes).toHaveLength(40);
    expect(codes.every((row) => /^VIP-[A-Z]{6}$/.test(row.code) && row.usageLimit === 1 && row.batchId)).toBe(true);

    const byType = Object.fromEntries(conditions.map((condition) => [condition.conditionType, condition]));
    const flags = { onlyMatchedLines: true, rejectUnmatchedLines: true };
    expect(byType["page_types"]).toMatchObject({ scope: "main", value: { pageTypes: ["product"], ...flags } });
    expect(byType["utm_parameters"]).toMatchObject({
      scope: "sub",
      value: { utmSource: "newsletter", scope: "visit", ...flags },
    });
    expect(byType["specific_link"]).toMatchObject({ scope: "sub", value: { requiredUrl: "/pages/vip", ...flags } });
    expect(byType["customer_tags"]!.value).not.toHaveProperty("rejectUnmatchedLines");
  });
});

describe("code offer wizard: collisions", () => {
  it("refuses a code another offer already uses and leaves nothing behind", async () => {
    const other = await seedOffer(db, shopId);
    await createDiscountCode(db, { shopId, offerId: other, code: "TAKEN1" });
    const before = await db.select({ id: offers.id }).from(offers).where(eq(offers.shopId, shopId));

    expect(await create({ code: "taken1", internalName: "Collides" })).toEqual({ ok: false, error: CODE_TAKEN_MESSAGE });

    const after = await db.select({ id: offers.id }).from(offers).where(eq(offers.shopId, shopId));
    expect(after).toHaveLength(before.length);
  });

  it("retries a taken offer name with a suffix instead of failing", async () => {
    const first = await create({ code: "NAME1", internalName: "Same name" });
    const second = await create({ code: "NAME2", internalName: "Same name" });
    if (!first.ok || !second.ok) throw new Error("setup");
    const { offer } = await offerRows(second.data.offerId);
    expect(offer.internalName).toMatch(/^Same name \(/);
  });
});

describe("code offer wizard: validation", () => {
  const error = (fields: Record<string, string | string[]>) => {
    const parsed = parseCodeOfferForm(form(fields), context);
    return parsed.ok ? null : parsed.error;
  };

  it("requires a code, a valid batch and a sane discount", () => {
    expect(error({ code: "" })).toMatch(/Enter the discount code/);
    expect(error({ codeMode: "bulk", batchCount: "" })).toMatch(/how many codes/);
    expect(error({ codeMode: "bulk", batchCount: "10", batchCharset: "emoji" })).toMatch(/character set/);
    expect(error({ code: "A1", discountValue: "0" })).toMatch(/greater than zero/);
    expect(error({ code: "A1", discountValue: "120" })).toMatch(/more than 100%/);
    expect(error({ code: "A1", usageLimit: "0" })).toMatch(/Usage limit/);
  });

  it("requires at least one page type and one UTM value when UTM validation is on", () => {
    expect(error({ code: "A1", pageTypes: [] })).toMatch(/at least one kind of page/);
    expect(error({ code: "A1", pageTypes: ["checkout"] })).toMatch(/at least one kind of page/);
    expect(error({ code: "A1", utmEnabled: "on", utmSource: " " })).toMatch(/at least one UTM/);
  });

  it("requires something to discount for product discounts, and names", () => {
    expect(error({ code: "A1", discountTarget: "products" })).toMatch(/product or collection/);
    expect(error({ code: "A1", internalName: " " })).toMatch(/Offer name/);
  });

  it("rejects a bad code at insert time with the friendly message", async () => {
    expect(await create({ code: "two words" })).toMatchObject({ ok: false, error: expect.stringMatching(/letters, numbers/) });
  });
});
