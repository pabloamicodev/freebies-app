import type * as RedisModule from "./redis.server.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { capacityIncidents, offerRewards, variantCache, type Db } from "@promo/db";
import { applyWorkaround } from "./capacity-apply.server.js";
import { preflightCapacity, compileSharedOffers, type CapacityOptions } from "./capacity-preflight.server.js";
import { recordCapacityIncident } from "./capacity-incidents.server.js";
import { proposeForIncident } from "./capacity-workarounds.server.js";
import { sliceTarget } from "./sync/slice-offer-definition.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

vi.mock("./redis.server.js", async (importOriginal) => ({ ...(await importOriginal<typeof RedisModule>()), redisDelete: vi.fn(async () => undefined) }));

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const cap = (maxCartSlots = 11): CapacityOptions => ({ shardsEnabled: true, loadBudget: async () => ({ storeActive: 5, ours: 2, others: 3, maxCartSlots }) });
let seq = 0;
const gid = (kind: string) => `gid://shopify/${kind}/${++seq + 60_000_000_000}`;
const publish = async () => null;

async function incidentFor(shopId: string, offerIds: string[], opts: CapacityOptions) {
  const result = await preflightCapacity(db, shopId, offerIds, opts);
  if (result.ok) throw new Error("expected a block");
  await recordCapacityIncident(db, { shopId, code: result.code, offerIds: result.offerIds, numbers: result.numbers, ...(result.splitRefusal ? { splitRefusal: result.splitRefusal } : {}) }, { source: "cron", attended: false });
  return (await db.select().from(capacityIncidents).where(eq(capacityIncidents.shopId, shopId)))[0]!;
}

describe("use_whole_products compiles to the same config except the targets", () => {
  it("keeps every other field of the product reward byte for byte", async () => {
    const shopId = await seedShop(db, "parity-whole.myshopify.com");
    const variants: string[] = [];
    for (let p = 0; p < 3; p++) {
      const product = gid("Product");
      for (let v = 0; v < 150; v++) {
        const variantGid = gid("ProductVariant");
        variants.push(variantGid);
        await db.insert(variantCache).values({ shopId, productGid: product, variantGid, title: "v", price: "10", currencyCode: "USD", raw: {} });
      }
    }
    const offerId = await seedOffer(db, shopId, { internalName: "sale", type: "discount", status: "paused" });
    await db.insert(offerRewards).values({
      shopId, offerId, rewardType: "product_discount", discountType: "percentage",
      value: { amount: 0, tiers: [{ minimumQuantity: 2, discountType: "percentage", discountValue: 5 }] },
      target: { scopeMode: "sitewide", variantIds: variants, maxUnitsTotal: 4 }, sortOrder: 0,
    });
    const before = (await compileSharedOffers(db, shopId, "USD", [offerId], false))!.compiled[0]!.offer.productRewards;
    const incident = await incidentFor(shopId, [offerId], cap());
    const p = (await proposeForIncident(db, incident, { capacity: cap(), env: {} })).proposals.find((x) => x.kind === "use_whole_products")!;
    const applied = await applyWorkaround(db, { id: shopId, domain: "parity-whole.myshopify.com" }, { incidentId: incident.id, kind: "use_whole_products", confirm: false, expectedVersions: p.offerVersions, performedBy: "t" }, { capacity: cap(), env: {}, publish });
    expect(applied.ok).toBe(true);
    const after = (await compileSharedOffers(db, shopId, "USD", [offerId], false))!.compiled[0]!.offer.productRewards;
    expect(before[0]!.targetVariantIds).toHaveLength(450);
    expect(after[0]!.targetVariantIds).toEqual([]);
    expect(after[0]!.targetProductIds).toHaveLength(3);
    const strip = (rewards: typeof before) => rewards.map(({ targetVariantIds: _v, targetProductIds: _p, ...rest }) => rest);
    expect(JSON.stringify(strip(after))).toBe(JSON.stringify(strip(before)));
  });
});

/** Seeded generator so a failing case reproduces. */
function lcg(seed: number) {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

describe("split_offer only ever tightens", () => {
  const tiers = [
    { min: 2, pct: 5 },
    { min: 3, pct: 10 },
    { min: 6, pct: 10 },
    { min: 8, pct: 25 },
  ];
  const pctFor = (quantity: number) => tiers.filter((tier) => tier.min <= quantity).reduce((best, tier) => Math.max(best, tier.pct), 0);
  /** Per-line discount of a tiered percentage reward whose target set is `items`: tiers count every targeted unit together. */
  const discounts = (cart: Array<{ item: string; qty: number; price: number }>, items: Set<string>) => {
    const targeted = cart.filter((line) => items.has(line.item));
    const pct = pctFor(targeted.reduce((sum, line) => sum + line.qty, 0));
    return new Map(targeted.map((line) => [line.item, (pct / 100) * line.price * line.qty]));
  };

  it("never discounts a line more than the whole offer does, for any slicing and any cart", () => {
    const universe = Array.from({ length: 24 }, (_, i) => `gid://shopify/ProductVariant/${i + 1}`);
    const random = lcg(7);
    for (let round = 0; round < 300; round++) {
      const parts = 2 + Math.floor(random() * 5);
      const slices = sliceTarget({ variantIds: universe }, parts).map((slice) => new Set(slice["variantIds"] as string[]));
      const cart = universe
        .filter(() => random() < 0.5)
        .map((item) => ({ item, qty: 1 + Math.floor(random() * 4), price: 5 + Math.floor(random() * 40) }));
      const whole = discounts(cart, new Set(universe));
      const seen = new Set<string>();
      for (const slice of slices) {
        for (const [item, amount] of discounts(cart, slice)) {
          expect(seen.has(item)).toBe(false);
          seen.add(item);
          expect(amount).toBeLessThanOrEqual(whole.get(item)! + 1e-9);
        }
      }
    }
  });
});
