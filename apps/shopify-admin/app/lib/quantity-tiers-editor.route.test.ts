import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { offerConditions, offerRewards, offers, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "" }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: "tiers-shop.myshopify.com" },
  }),
}));
vi.mock("../shopify.server.js", () => ({
  authenticate: { admin: async () => ({ session: { shop: "tiers-shop.myshopify.com" } }) },
}));
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => ctx.db,
}));
vi.mock("./offer-publish-flow.server.js", () => ({
  publishShopConfig: async () => null,
  tryPublishShop: async () => null,
  getPublishWarnings: async () => [] as string[],
  republishIfActive: async () => null,
  finalizeCreatedOffer: async () => null,
  validateOffersPublishable: async () => ({ ok: true }),
  validateActivation: async () => ({ ok: true }),
}));
vi.mock("./audit-log.server.js", () => ({ insertAuditLog: async () => undefined }));

import { compileOfferConfig } from "./sync/compile-config.js";

const rewardsRoute = await import("../routes/app.offers.$id.rewards.js");

let db: Db;
let close: () => Promise<void>;

const post = (fields: Record<string, string>) => new Request("http://localhost/x", { method: "POST", body: new URLSearchParams(fields) });
const run = (fn: unknown, request: Request, params: Record<string, string> = {}) =>
  (fn as (a: unknown) => Promise<{ error?: string } | undefined>)({ request, params, context: {} });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  ctx.shopId = await seedShop(db, "tiers-shop.myshopify.com");
}, 60_000);
afterAll(async () => {
  await close();
});

async function seedTiered(status: "active" | "draft", name: string, value: Record<string, unknown>) {
  const id = await seedOffer(db, ctx.shopId, { type: "discount", status, internalName: name, publicTitle: "Volume" });
  const [reward] = await db
    .insert(offerRewards)
    .values({
      shopId: ctx.shopId, offerId: id, rewardType: "product_discount", discountType: "percentage",
      value, target: { scopeMode: "sitewide", scope: "all_products" },
    })
    .returning({ id: offerRewards.id });
  return { id, rewardId: reward!.id };
}

const tiers = (extra: Array<Record<string, unknown>> = []) => [
  { minimumQuantity: 1, maximumQuantity: 1, discountType: "percentage", discountValue: 15, cartLabels: ["Starter"] },
  { minimumQuantity: 2, discountType: "percentage", discountValue: 20 },
  ...extra,
];

const update = (id: string, rewardId: string, productTiers: unknown, extra: Record<string, string> = {}) =>
  run(
    rewardsRoute.action,
    post({
      intent: "update_reward", rewardId, rewardType: "product_discount", discountType: "percentage", discountValue: "0",
      productScopeMode: "sitewide", ...(productTiers === undefined ? {} : { productTiers: JSON.stringify(productTiers) }), ...extra,
    }),
    { id },
  );

const storedValue = async (rewardId: string) =>
  (await db.select().from(offerRewards).where(eq(offerRewards.id, rewardId)))[0]!.value as { amount: number; tiers?: Array<Record<string, unknown>> };

describe("quantity tiers editor on existing offers", () => {
  it("edits tiers and cart labels on an active offer; the compiled config carries cartMessage per tier", async () => {
    const { id, rewardId } = await seedTiered("active", "active-tiers", { amount: 0, currencyCode: "USD", tiers: tiers() });
    const result = await update(id, rewardId, [
      { minimumQuantity: 1, maximumQuantity: 2, discountType: "percentage", discountValue: 10, label: "Pair", cartLabels: [" Spring ", "VIP"] },
      { minimumQuantity: 3, discountType: "fixed_amount", discountValue: 5 },
    ]);
    expect(result?.error).toBeUndefined();
    const value = await storedValue(rewardId);
    expect(value.amount).toBe(0);
    expect(value.tiers).toEqual([
      { minimumQuantity: 1, maximumQuantity: 2, discountType: "percentage", discountValue: 10, label: "Pair", cartLabels: ["Spring", "VIP"] },
      { minimumQuantity: 3, discountType: "fixed_amount", discountValue: 5 },
    ]);
    const [offer] = await db.select().from(offers).where(eq(offers.id, id));
    expect(offer!.status).toBe("active");
    const rewards = await db.select().from(offerRewards).where(eq(offerRewards.offerId, id));
    const conditions = await db.select().from(offerConditions).where(eq(offerConditions.offerId, id));
    const compiled = compileOfferConfig(offer!, conditions, rewards, null, 1);
    const compiledTiers = compiled.productRewards[0]!.quantityTiers;
    expect(compiledTiers[0]!.cartMessage).toBe("Spring · VIP");
    expect("cartMessage" in compiledTiers[1]!).toBe(false);
  });

  it("keeps a draft a draft", async () => {
    const { id, rewardId } = await seedTiered("draft", "draft-tiers", { amount: 0, currencyCode: "USD", tiers: tiers() });
    const bounded = [{ ...tiers()[0]! }, { ...tiers()[1]!, maximumQuantity: 4 }, { minimumQuantity: 5, discountType: "percentage", discountValue: 30 }];
    expect((await update(id, rewardId, bounded))?.error).toBeUndefined();
    expect((await storedValue(rewardId)).tiers).toHaveLength(3);
    expect((await db.select().from(offers).where(eq(offers.id, id)))[0]!.status).toBe("draft");
  });

  it("turns a plain product discount into a tiered one, and back", async () => {
    const { id, rewardId } = await seedTiered("draft", "plain-to-tiered", { amount: 10, currencyCode: "USD" });
    expect((await update(id, rewardId, tiers()))?.error).toBeUndefined();
    expect(await storedValue(rewardId)).toMatchObject({ amount: 0, tiers: tiers() });
    expect((await update(id, rewardId, [], { discountValue: "12" }))?.error).toBeUndefined();
    expect(await storedValue(rewardId)).toEqual({ amount: 12, currencyCode: "USD" });
  });

  it("leaves the tiers alone when the form carries none", async () => {
    const { id, rewardId } = await seedTiered("draft", "no-field", { amount: 0, currencyCode: "USD", tiers: tiers() });
    expect((await update(id, rewardId, undefined, { discountValue: "9" }))?.error).toBeUndefined();
    expect((await storedValue(rewardId)).tiers).toEqual(tiers());
  });

  it("rejects overlapping, unordered, open-ended-then-more, and malformed tiers without saving", async () => {
    const original = tiers();
    const { id, rewardId } = await seedTiered("draft", "invalid-tiers", { amount: 0, currencyCode: "USD", tiers: original });
    const cases: Array<[unknown, RegExp]> = [
      [[{ minimumQuantity: 1, maximumQuantity: 3, discountType: "percentage", discountValue: 10 }, { minimumQuantity: 3, discountType: "percentage", discountValue: 20 }], /overlaps/],
      [[{ minimumQuantity: 4, discountType: "percentage", discountValue: 10 }, { minimumQuantity: 2, discountType: "percentage", discountValue: 20 }], /overlaps/],
      [[{ minimumQuantity: 1, discountType: "percentage", discountValue: 10 }, { minimumQuantity: 2, discountType: "percentage", discountValue: 20 }], /overlaps/],
      [[{ minimumQuantity: 0, discountType: "percentage", discountValue: 10 }], /minimum quantity/],
      [[{ minimumQuantity: 2, maximumQuantity: 1, discountType: "percentage", discountValue: 10 }], /maximum quantity/],
      [[{ minimumQuantity: 1, discountType: "percentage", discountValue: -1 }], /0 or more/],
      [[{ minimumQuantity: 1, discountType: "percentage", discountValue: 101 }], /100%/],
      [[{ minimumQuantity: 1, discountType: "percentage", discountValue: 10, cartLabels: ["a", "b", "c", "d"] }], /at most 3/],
      [[{ minimumQuantity: 1, discountType: "percentage", discountValue: 10, cartLabels: ["x".repeat(41)] }], /40 characters/],
    ];
    for (const [payload, message] of cases) {
      expect((await update(id, rewardId, payload))?.error, JSON.stringify(payload)).toMatch(message);
    }
    expect((await storedValue(rewardId)).tiers).toEqual(original);
  });
});
