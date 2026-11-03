import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { offerRewards, offers, productCache, variantCache, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import { deriveGiftBlock, planGiftRewards } from "./gift-rewards.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "" }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: "add-all.myshopify.com" },
  }),
}));
vi.mock("../shopify.server.js", () => ({
  authenticate: { admin: async () => ({ session: { shop: "add-all.myshopify.com" } }) },
}));
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => ctx.db,
}));
vi.mock("./offer-publish-flow.server.js", () => ({
  publishShopConfig: async () => null,
  republishIfActive: async () => null,
  finalizeCreatedOffer: async () => null,
  validateOffersPublishable: async () => ({ ok: true }),
  validateActivation: async () => ({ ok: true }),
}));
vi.mock("./gift-tier-campaigns.server.js", () => ({ createGiftTierCampaignOffers: async () => ({ error: "unused" }) }));
vi.mock("./audit-log.server.js", () => ({ insertAuditLog: async () => undefined }));

const wizard = await import("../routes/app.offers.new.gift.$template.js");
const offerPage = await import("../routes/app.offers.$id._index.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const A = V(8100000001);
const B = [V(8100000011), V(8100000012), V(8100000013)];
const C = V(8100000021);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  shopId = await seedShop(db, "add-all.myshopify.com");
  ctx.shopId = shopId;
  const products = [
    ["gid://shopify/Product/8100000001", [A]],
    ["gid://shopify/Product/8100000002", B],
    ["gid://shopify/Product/8100000003", [C]],
  ] as const;
  for (const [productGid, variants] of products) {
    await db.insert(productCache).values({ shopId, productGid, handle: productGid.slice(-4), title: productGid, status: "ACTIVE", raw: {} });
    await db.insert(variantCache).values(
      variants.map((variantGid, i) => ({
        shopId, productGid, variantGid, title: `V${i}`, price: "5.00", currencyCode: "USD",
        availableForSale: true, inventoryQuantity: 10, inventoryPolicy: "DENY", raw: {},
      })),
    );
  }
}, 60_000);
afterAll(async () => {
  await close();
});

const post = (url: string, fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of [v].flat()) body.append(k, item);
  return new Request(`http://localhost${url}`, { method: "POST", body });
};
const run = (fn: unknown, request: Request, params: Record<string, string> = {}) =>
  (fn as (a: unknown) => Promise<unknown>)({ request, params, context: {} });

const createViaWizard = async (name: string, rewardProducts: string[], isAutoAdd: boolean, giftCount = "1") => {
  const result = await run(
    wizard.action,
    post("/app/offers/new/gift/cart_value", {
      intent: "draft", internalName: name, publicTitle: name, conditionType: "cart_value", minAmount: "50",
      appliesTo: "any_product", discountType: "free", giftCount, rewardProducts: JSON.stringify(rewardProducts),
      isAutoAdd: String(isAutoAdd),
    }),
    { template: "cart_value" },
  );
  expect((result as { error?: string }).error).toBeUndefined();
  const [offer] = await db.select().from(offers).where(eq(offers.internalName, name));
  return offer!.id;
};
const rewardsOf = (offerId: string) =>
  db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)).orderBy(asc(offerRewards.sortOrder));
const variantsOf = (r: { target: unknown }) => (r.target as { variantIds: string[] }).variantIds;
const edit = (id: string, rewardId: string, fields: { auto: boolean; variants: string[]; quantity?: string; fallback?: string[] }) =>
  run(
    offerPage.action,
    post(`/app/offers/${id}`, {
      intent: "update_reward", rewardId, discountType: "free", discountValue: "100", quantity: fields.quantity ?? "1",
      ...(fields.auto ? { isAutoAdd: "on" } : {}),
      targetVariantIds: JSON.stringify(fields.variants),
      targetFallbackVariantIds: JSON.stringify(fields.fallback ?? []),
    }),
    { id },
  );

describe("wizard: automatically add all gifts", () => {
  it("2 one-variant gifts become 2 auto-add, non-selectable, single-variant rewards", async () => {
    const id = await createViaWizard("add-all-two-singles", [A, C], true);
    const rewards = await rewardsOf(id);
    expect(rewards).toHaveLength(2);
    expect(rewards.map(variantsOf)).toEqual([[A], [C]]);
    for (const r of rewards) {
      expect(r).toMatchObject({ isAutoAdd: true, isCustomerSelectable: false, quantity: 1, trackMode: "variant", rewardType: "product_gift" });
      expect(r.value).toMatchObject({ amount: 100 });
    }
    expect(rewards.map((r) => r.sortOrder)).toEqual([0, 1]);
  });

  it("a product with several picked variants becomes a picker reward beside the auto-added one", async () => {
    const id = await createViaWizard("add-all-mixed", [A, ...B], true);
    const [ra, rb] = await rewardsOf(id);
    expect(ra).toMatchObject({ isAutoAdd: true, isCustomerSelectable: false, quantity: 1 });
    expect(variantsOf(ra!)).toEqual([A]);
    expect(rb).toMatchObject({ isAutoAdd: false, isCustomerSelectable: true, quantity: 1 });
    expect(variantsOf(rb!)).toEqual(B);
  });

  it("customer-selects mode keeps ONE reward with N variants and quantity = gifts to pick", async () => {
    const id = await createViaWizard("select-two", [A, C], false, "2");
    const rewards = await rewardsOf(id);
    expect(rewards).toHaveLength(1);
    expect(variantsOf(rewards[0]!)).toEqual([A, C]);
    expect(rewards[0]).toMatchObject({ isAutoAdd: false, isCustomerSelectable: true, quantity: 2 });
  });

  it("a single gift stays one auto-add reward", async () => {
    const id = await createViaWizard("add-all-one", [A], true);
    const rewards = await rewardsOf(id);
    expect(rewards).toHaveLength(1);
    expect(rewards[0]).toMatchObject({ isAutoAdd: true, isCustomerSelectable: false });
  });
});

describe("editor: one Gifts block over all product_gift rewards", () => {
  it("add-all split, merge to select, and back, keeping reward ids stable", async () => {
    const id = await seedOffer(db, shopId, { status: "draft", internalName: "editor-roundtrip" });
    const [seed] = await db.insert(offerRewards).values({
      shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" },
      target: { scope: "cart", variantIds: [A] }, quantity: 1, isAutoAdd: true, isCustomerSelectable: false, trackMode: "variant", sortOrder: 0,
    }).returning();

    expect(((await edit(id, seed!.id, { auto: true, variants: [A, C] })) as { error?: string } | null)?.error).toBeUndefined();
    let rewards = await rewardsOf(id);
    expect(rewards.map(variantsOf)).toEqual([[A], [C]]);
    expect(rewards[0]!.id).toBe(seed!.id);
    expect(rewards.every((r) => r.isAutoAdd && !r.isCustomerSelectable && r.quantity === 1)).toBe(true);
    const cId = rewards[1]!.id;
    expect(deriveGiftBlock(rewards)).toMatchObject({ receivesAll: true, variantIds: [A, C] });

    await edit(id, seed!.id, { auto: true, variants: [A, C, ...B] });
    rewards = await rewardsOf(id);
    expect(rewards).toHaveLength(3);
    expect(rewards.map((r) => r.id).slice(0, 2)).toEqual([seed!.id, cId]);
    expect(rewards[2]).toMatchObject({ isAutoAdd: false, isCustomerSelectable: true });
    expect(variantsOf(rewards[2]!)).toEqual(B);

    await edit(id, seed!.id, { auto: false, variants: [A, C], quantity: "2" });
    rewards = await rewardsOf(id);
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.id).toBe(seed!.id);
    expect(variantsOf(rewards[0]!)).toEqual([A, C]);
    expect(rewards[0]).toMatchObject({ isAutoAdd: false, isCustomerSelectable: true, quantity: 2 });
    expect(deriveGiftBlock(rewards)).toMatchObject({ receivesAll: false, variantIds: [A, C] });

    await edit(id, seed!.id, { auto: true, variants: [A, C] });
    rewards = await rewardsOf(id);
    expect(rewards.map(variantsOf)).toEqual([[A], [C]]);
    expect(rewards[0]!.id).toBe(seed!.id);
    expect(rewards.every((r) => r.isAutoAdd && r.quantity === 1)).toBe(true);
  });

  it("splits a legacy auto-add reward with N variants, inheriting its id on the first gift", async () => {
    const id = await seedOffer(db, shopId, { status: "draft", internalName: "editor-legacy" });
    const [legacy] = await db.insert(offerRewards).values({
      shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" },
      target: { scope: "cart", variantIds: [A, C] }, quantity: 1, isAutoAdd: true, isCustomerSelectable: false, trackMode: "product", sortOrder: 0,
    }).returning();
    await edit(id, legacy!.id, { auto: true, variants: [A, C], fallback: [B[0]!] });
    const rewards = await rewardsOf(id);
    expect(rewards.map(variantsOf)).toEqual([[A], [C]]);
    expect(rewards[0]!.id).toBe(legacy!.id);
    expect(rewards.every((r) => (r.target as { fallbackVariantIds?: string[] }).fallbackVariantIds?.[0] === B[0])).toBe(true);
    expect(deriveGiftBlock(rewards).fallbackVariantIds).toEqual([B[0]]);
  });

  it("removing a gift deletes only its reward", async () => {
    const id = await createViaWizard("editor-remove", [A, C], true);
    const before = await rewardsOf(id);
    await edit(id, before[0]!.id, { auto: true, variants: [A] });
    const after = await rewardsOf(id);
    expect(after.map((r) => r.id)).toEqual([before[0]!.id]);
  });
});

const FA = V(8100000091);
const FB = V(8100000092);
const fallbackOf = (r: { target: unknown }) => (r.target as { fallbackVariantIds?: string[] }).fallbackVariantIds;
const editPerGift = (id: string, rewardId: string, variants: string[], byGift: Record<string, string[]>) =>
  run(
    offerPage.action,
    post(`/app/offers/${id}`, {
      intent: "update_reward", rewardId, discountType: "free", discountValue: "100", quantity: "1", isAutoAdd: "on",
      targetVariantIds: JSON.stringify(variants),
      targetFallbackVariantIds: JSON.stringify([]),
      targetFallbackByGift: JSON.stringify(byGift),
    }),
    { id },
  );

describe("per-gift fallbacks", () => {
  it("wizard stores each gift's own fallbacks, the same fallback may repeat", async () => {
    const result = await run(
      wizard.action,
      post("/app/offers/new/gift/cart_value", {
        intent: "draft", internalName: "per-gift-wizard", publicTitle: "x", conditionType: "cart_value", minAmount: "50",
        appliesTo: "any_product", discountType: "free", giftCount: "1", rewardProducts: JSON.stringify([A, C]),
        isAutoAdd: "true", fallbackProducts: JSON.stringify([FB]),
        fallbackByGift: JSON.stringify({ [A]: [FA, FB], [C]: [FA] }),
      }),
      { template: "cart_value" },
    );
    expect((result as { error?: string }).error).toBeUndefined();
    const [offer] = await db.select().from(offers).where(eq(offers.internalName, "per-gift-wizard"));
    const rewards = await rewardsOf(offer!.id);
    expect(rewards.map(variantsOf)).toEqual([[A], [C]]);
    expect(rewards.map(fallbackOf)).toEqual([[FA, FB], [FA]]);
  });

  it("wizard: a gift without a fallback gets none, and select mode keeps the shared list", async () => {
    const post1 = (name: string, auto: boolean) =>
      run(
        wizard.action,
        post("/app/offers/new/gift/cart_value", {
          intent: "draft", internalName: name, publicTitle: "x", conditionType: "cart_value", minAmount: "50",
          appliesTo: "any_product", discountType: "free", giftCount: "1", rewardProducts: JSON.stringify([A, C]),
          isAutoAdd: String(auto), fallbackProducts: JSON.stringify([FB]), fallbackByGift: JSON.stringify({ [A]: [FA] }),
        }),
        { template: "cart_value" },
      );
    await post1("per-gift-partial", true);
    const [o1] = await db.select().from(offers).where(eq(offers.internalName, "per-gift-partial"));
    expect((await rewardsOf(o1!.id)).map(fallbackOf)).toEqual([[FA], undefined]);
    await post1("per-gift-select", false);
    const [o2] = await db.select().from(offers).where(eq(offers.internalName, "per-gift-select"));
    const selectRewards = await rewardsOf(o2!.id);
    expect(selectRewards).toHaveLength(1);
    expect(fallbackOf(selectRewards[0]!)).toEqual([FB]);
  });

  it("editor round-trips per-gift fallbacks through deriveGiftBlock and keeps reward ids", async () => {
    const id = await createViaWizard("per-gift-editor", [A, C], true);
    const [ra] = await rewardsOf(id);
    expect(((await editPerGift(id, ra!.id, [A, C], { [A]: [FA], [C]: [FA, FB] })) as { error?: string } | null)?.error).toBeUndefined();
    let rewards = await rewardsOf(id);
    expect(rewards.map(fallbackOf)).toEqual([[FA], [FA, FB]]);
    expect(rewards[0]!.id).toBe(ra!.id);
    expect(deriveGiftBlock(rewards).fallbackByVariant).toEqual({ [A]: [FA], [C]: [FA, FB] });

    await editPerGift(id, ra!.id, [A, C], { [A]: [], [C]: [FB] });
    rewards = await rewardsOf(id);
    expect(rewards.map(fallbackOf)).toEqual([undefined, [FB]]);
  });

  it("editor: an offer saved with one shared list loads it on each gift and saves per-row lists", async () => {
    const id = await seedOffer(db, shopId, { status: "draft", internalName: "per-gift-legacy" });
    const [legacy] = await db.insert(offerRewards).values({
      shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" },
      target: { scope: "cart", variantIds: [A], fallbackVariantIds: [FA] }, quantity: 1, isAutoAdd: true, isCustomerSelectable: false, trackMode: "variant", sortOrder: 0,
    }).returning();
    await db.insert(offerRewards).values({
      shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" },
      target: { scope: "cart", variantIds: [C], fallbackVariantIds: [FA] }, quantity: 1, isAutoAdd: true, isCustomerSelectable: false, trackMode: "variant", sortOrder: 1,
    });
    const loaded = deriveGiftBlock(await rewardsOf(id));
    expect(loaded.fallbackByVariant).toEqual({ [A]: [FA], [C]: [FA] });
    expect(loaded.fallbackVariantIds).toEqual([FA]);
    await editPerGift(id, legacy!.id, [A, C], { ...loaded.fallbackByVariant, [C]: [] });
    expect((await rewardsOf(id)).map(fallbackOf)).toEqual([[FA], undefined]);
  });

  it("editor: an old client posting only the shared list still applies it to every gift", async () => {
    const id = await createViaWizard("per-gift-oldclient", [A, C], true);
    const [ra] = await rewardsOf(id);
    await edit(id, ra!.id, { auto: true, variants: [A, C], fallback: [FA] });
    expect((await rewardsOf(id)).map(fallbackOf)).toEqual([[FA], [FA]]);
  });
});

describe("planGiftRewards", () => {
  const base = { fallbackVariantIds: [], quantity: 1, discountType: "free" as const, value: { amount: 100 } };
  const productOf = new Map([[A, "pA"], [B[0]!, "pB"], [B[1]!, "pB"], [C, "pC"]]);

  it("per-gift fallbacks: own list per product, merged for a multi-variant product, capped at 5", () => {
    const many = Array.from({ length: 7 }, (_, i) => V(8200000000 + i));
    const plan = planGiftRewards({
      ...base, existing: [], variantIds: [A, B[0]!, B[1]!, C], productOf, autoAddAll: true,
      fallbackByVariant: { [A]: [FA], [B[0]!]: [FA], [B[1]!]: [FB], [C]: many },
    });
    expect(plan.insert.map(fallbackOf)).toEqual([[FA], [FA, FB], many.slice(0, 5)]);
  });

  it("a fallback that is also a gift is dropped; without byVariant the shared list is used", () => {
    const perGift = planGiftRewards({
      ...base, existing: [], variantIds: [A, C], productOf, autoAddAll: true, fallbackByVariant: { [A]: [C, FA] },
    });
    expect(perGift.insert.map(fallbackOf)).toEqual([[FA], undefined]);
    const shared = planGiftRewards({ ...base, fallbackVariantIds: [FA], existing: [], variantIds: [A, C], productOf, autoAddAll: true });
    expect(shared.insert.map(fallbackOf)).toEqual([[FA], [FA]]);
  });

  it("deriveGiftBlock: each gift shows its reward's fallbacks, a shared select list lands on every variant", () => {
    const block = deriveGiftBlock([
      { isAutoAdd: false, target: { variantIds: [A, C], fallbackVariantIds: [FA, A] } },
    ]);
    expect(block.fallbackByVariant).toEqual({ [A]: [FA], [C]: [FA] });
    expect(block.fallbackVariantIds).toEqual([FA]);
  });

  it("groups per product and never mixes products into one picker", () => {
    const productOf = new Map([[A, "pA"], [B[0]!, "pB"], [B[1]!, "pB"], [C, "pC"]]);
    const plan = planGiftRewards({ ...base, existing: [], variantIds: [A, B[0]!, C, B[1]!], productOf, autoAddAll: true });
    expect(plan.insert.map((v) => [(v.target as { variantIds: string[] }).variantIds, v.isAutoAdd])).toEqual([
      [[A], true], [[B[0], B[1]], false], [[C], true],
    ]);
  });
});
