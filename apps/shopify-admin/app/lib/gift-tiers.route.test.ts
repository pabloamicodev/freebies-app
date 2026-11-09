import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { offerCombinationPolicies, offerConditions, offerRewards, offers, productCache, variantCache, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "", finalizeError: null as string | null }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: "tiers-gift.myshopify.com" },
  }),
}));
vi.mock("../shopify.server.js", () => ({
  authenticate: { admin: async () => ({ session: { shop: "tiers-gift.myshopify.com" } }) },
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
  finalizeCreatedOffer: async () => ctx.finalizeError,
  validateOffersPublishable: async () => ({ ok: true }),
  validateActivation: async () => ({ ok: true }),
}));
vi.mock("./audit-log.server.js", () => ({ insertAuditLog: async () => undefined }));

import { compileOfferConfig, serializeFunctionConfig } from "./sync/compile-config.js";
import { computeOfferVersion } from "./offer-version.server.js";
import { loadOfferDefinitions } from "./offer-definitions.server.js";
import { duplicateOffer } from "./offer-duplicate.server.js";
import { rewardSummary } from "./offer-summaries.js";

const wizard = await import("../routes/app.offers.new.gift.$template.js");
const rewardsRoute = await import("../routes/app.offers.$id.rewards.js");
const offerPage = await import("../routes/app.offers.$id._index.js");
const conditionsRoute = await import("../routes/app.offers.$id.conditions.js");

let db: Db;
let close: () => Promise<void>;

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const post = (fields: Record<string, string>) => new Request("http://localhost/x", { method: "POST", body: new URLSearchParams(fields) });
const run = (fn: unknown, request: Request, params: Record<string, string> = {}) =>
  (fn as (a: unknown) => Promise<{ error?: string } | Response | undefined>)({ request, params, context: {} }) as Promise<{ error?: string } | undefined>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  ctx.shopId = await seedShop(db, "tiers-gift.myshopify.com");
  for (const n of [1, 2, 3]) {
    await db.insert(productCache).values({ shopId: ctx.shopId, productGid: `gid://shopify/Product/${n}`, handle: `gift-${n}`, title: `Gift ${n}`, status: "ACTIVE", raw: {} });
    await db.insert(variantCache).values({
      shopId: ctx.shopId, productGid: `gid://shopify/Product/${n}`, variantGid: V(n), title: "Default", price: "20.00", currencyCode: "USD",
      availableForSale: true, inventoryQuantity: 10, inventoryPolicy: "DENY", raw: {},
    });
  }
}, 60_000);
afterAll(async () => {
  await close();
});

const tier = (id: string, minimumSubtotalCents: number, variantIds: string[], extra: Record<string, unknown> = {}) => ({
  id, minimumSubtotalCents, variantIds, quantity: 1, ...extra,
});
const campaign = (tiers: unknown[], stackingMode = "cumulative", name = "Spend and get") => ({ campaignId: "spend", name, stackingMode, tiers });
const create = (intent: string, body: unknown, extra: Record<string, string> = {}) =>
  run(wizard.action, post({ intent, campaign: JSON.stringify(body), ...extra }), { template: "tiered" });

const offerByName = async (name: string) => (await db.select().from(offers).where(eq(offers.internalName, name)))[0];
const rewardsOf = async (offerId: string) =>
  (await db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId))).sort((a, b) => a.sortOrder - b.sortOrder);

describe("create: one gift offer with several tiers", () => {
  it("saves one offer, one reward per tier by threshold, the main condition at the lowest tier, and publishes once", async () => {
    await create(
      "publish-tiered-offer",
      campaign([tier("big", 11000, [V(2)]), tier("small", 7000, [V(1)], { fallbackVariantIds: [V(9)] })], "highest_tier_only", "Kit and greens"),
    );
    const offer = await offerByName("Kit and greens");
    expect(offer).toMatchObject({ type: "gift", status: "active", tierMode: "highest", publicTitle: "Kit and greens" });
    const rewards = await rewardsOf(offer!.id);
    expect(rewards.map((r) => [r.minCartSubtotalCents, r.sortOrder, r.isAutoAdd, r.quantity])).toEqual([[7000, 0, true, 1], [11000, 1, true, 1]]);
    expect(rewards[0]!.target).toEqual({ scope: "cart", variantIds: [V(1)], fallbackVariantIds: [V(9)] });
    const main = await db.select().from(offerConditions).where(and(eq(offerConditions.offerId, offer!.id), eq(offerConditions.scope, "main")));
    expect(main).toHaveLength(1);
    expect(main[0]).toMatchObject({ conditionType: "cart_value", value: { thresholdCents: 7000, currencyCode: "USD", includeGiftValues: false } });
    expect(await db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, offer!.id))).toHaveLength(1);
  });

  it("saves a draft when asked to, and cumulative mode is stored explicitly", async () => {
    await create("create-tiered-offer", campaign([tier("a", 5000, [V(3)]), tier("b", 9000, [V(4), V(5)])], "cumulative", "Draft tiers"));
    const offer = await offerByName("Draft tiers");
    expect(offer).toMatchObject({ status: "draft", tierMode: "cumulative" });
    const rewards = await rewardsOf(offer!.id);
    expect(rewards[1]).toMatchObject({ isAutoAdd: false, isCustomerSelectable: true });
  });

  it("rejects duplicate and non-positive thresholds without creating anything", async () => {
    const before = (await db.select().from(offers)).length;
    expect((await create("create-tiered-offer", campaign([tier("a", 5000, [V(3)]), tier("b", 5000, [V(4)])], "cumulative", "Dup")))?.error).toMatch(/unique/i);
    expect((await create("create-tiered-offer", campaign([tier("a", 0, [V(3)])], "cumulative", "Zero")))?.error).toMatch(/greater than 0/);
    expect((await create("create-tiered-offer", campaign([tier("a", 5000, [])], "cumulative", "NoGift")))?.error).toBeTruthy();
    expect((await create("create-tiered-offer", campaign([], "cumulative", "Empty")))?.error).toBeTruthy();
    expect((await run(wizard.action, post({ intent: "create-tiered-offer", campaign: "{nope" }), { template: "tiered" }))?.error).toMatch(/JSON/);
    expect((await db.select().from(offers)).length).toBe(before);
  });

  it("a failed publish saves nothing, so retrying does not leave a suffixed duplicate", async () => {
    const body = campaign([tier("a", 5000, [V(3)])], "cumulative", "Publish retry");
    ctx.finalizeError = "Shopify said no.";
    try {
      expect((await create("publish-tiered-offer", body))?.error).toMatch(/Shopify said no\./);
    } finally {
      ctx.finalizeError = null;
    }
    expect((await db.select().from(offers)).filter((o) => o.internalName.startsWith("Publish retry"))).toHaveLength(0);
    await create("publish-tiered-offer", body);
    const rows = (await db.select().from(offers)).filter((o) => o.internalName.startsWith("Publish retry"));
    expect(rows.map((o) => o.internalName)).toEqual(["Publish retry"]);
  });

  it("a second offer with the same name gets a suffixed name instead of failing", async () => {
    await create("create-tiered-offer", campaign([tier("a", 5000, [V(3)])], "cumulative", "Same name"));
    await create("create-tiered-offer", campaign([tier("a", 5000, [V(3)])], "cumulative", "Same name"));
    const rows = (await db.select({ name: offers.internalName }).from(offers)).filter((r) => r.name.startsWith("Same name"));
    expect(rows).toHaveLength(2);
  });
});

async function seedTieredOffer(status: "draft" | "active", name: string, tierMode: "cumulative" | "highest" | null = null) {
  const id = await seedOffer(db, ctx.shopId, { type: "gift", status, internalName: name, publicTitle: name, tierMode });
  await db.insert(offerConditions).values({ shopId: ctx.shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 7000, currencyCode: "USD", includeGiftValues: false }, sortOrder: 0, isEnabled: true });
  const rewards = [];
  for (const [index, [min, variant]] of ([[7000, 1], [11000, 2]] as const).entries()) {
    const [row] = await db
      .insert(offerRewards)
      .values({
        shopId: ctx.shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" },
        target: { scope: "cart", variantIds: [V(variant)] }, quantity: 1, isAutoAdd: true, trackMode: "variant", sortOrder: index, minCartSubtotalCents: min,
      })
      .returning({ id: offerRewards.id });
    rewards.push(row!.id);
  }
  return { id, rewards };
}

const rewardForm = (fields: Record<string, string>) => ({
  intent: "update_reward", rewardType: "product_gift", discountType: "free", discountValue: "0", quantity: "1", isAutoAdd: "on",
  variantGids: V(1), ...fields,
});
const stored = async (rewardId: string) => (await db.select().from(offerRewards).where(eq(offerRewards.id, rewardId)))[0]!;

describe("edit: tiers on an existing gift offer", () => {
  it("changes a tier's threshold on an active offer, and the compiled config carries it", async () => {
    const { id, rewards } = await seedTieredOffer("active", "edit-threshold", "highest");
    const result = await run(rewardsRoute.action, post(rewardForm({ rewardId: rewards[1]!, minCartSubtotal: "125.50", variantGids: V(2) })), { id });
    expect(result?.error).toBeUndefined();
    expect((await stored(rewards[1]!)).minCartSubtotalCents).toBe(12550);
    const [offer] = await db.select().from(offers).where(eq(offers.id, id));
    expect(offer).toMatchObject({ status: "active", tierMode: "highest" });
    const compiled = compileOfferConfig(offer!, await db.select().from(offerConditions).where(eq(offerConditions.offerId, id)), await rewardsOf(id), null, 1);
    expect(compiled.giftRewards.map((r) => r.mcs)).toEqual([7000, 12550]);
    expect(compiled.tm).toBe("h");
  });

  it("adds a tier with its own gift, and removes one", async () => {
    const { id, rewards } = await seedTieredOffer("draft", "edit-add-remove");
    const added = await run(rewardsRoute.action, post(rewardForm({ intent: "add_reward", minCartSubtotal: "200", variantGids: V(3) })), { id });
    expect(added?.error).toBeUndefined();
    expect((await rewardsOf(id)).map((r) => r.minCartSubtotalCents)).toEqual([7000, 11000, 20000]);
    await run(rewardsRoute.action, post({ intent: "delete_reward", rewardId: rewards[0]! }), { id });
    expect((await rewardsOf(id)).map((r) => r.minCartSubtotalCents)).toEqual([11000, 20000]);
  });

  it("rejects a duplicate or non-positive threshold and keeps the stored one", async () => {
    const { id, rewards } = await seedTieredOffer("draft", "edit-validation");
    const dup = await run(rewardsRoute.action, post(rewardForm({ rewardId: rewards[1]!, minCartSubtotal: "70", variantGids: V(2) })), { id });
    expect(dup?.error).toMatch(/already unlocks/);
    for (const bad of ["0", "-5", "abc"]) {
      expect((await run(rewardsRoute.action, post(rewardForm({ rewardId: rewards[1]!, minCartSubtotal: bad, variantGids: V(2) })), { id }))?.error).toMatch(/greater than 0/);
    }
    expect((await stored(rewards[1]!)).minCartSubtotalCents).toBe(11000);
    const sameValue = await run(rewardsRoute.action, post(rewardForm({ rewardId: rewards[1]!, minCartSubtotal: "110", variantGids: V(2) })), { id });
    expect(sameValue?.error).toBeUndefined();
  });

  it("a save that does not post the field keeps the tier; a blank field clears it", async () => {
    const { id, rewards } = await seedTieredOffer("draft", "edit-keep-clear", "highest");
    await run(rewardsRoute.action, post(rewardForm({ rewardId: rewards[1]!, variantGids: V(2) })), { id });
    expect((await stored(rewards[1]!)).minCartSubtotalCents).toBe(11000);
    await run(rewardsRoute.action, post(rewardForm({ rewardId: rewards[1]!, minCartSubtotal: "", variantGids: V(2) })), { id });
    expect((await stored(rewards[1]!)).minCartSubtotalCents).toBeNull();
    expect((await db.select().from(offers).where(eq(offers.id, id)))[0]!.tierMode).toBe("highest");
  });

  it("lowering the lowest tier lowers a stricter main threshold so the tier stays reachable", async () => {
    const { id, rewards } = await seedTieredOffer("draft", "edit-main-threshold");
    await run(rewardsRoute.action, post(rewardForm({ rewardId: rewards[0]!, minCartSubtotal: "50" })), { id });
    const [main] = await db.select().from(offerConditions).where(and(eq(offerConditions.offerId, id), eq(offerConditions.scope, "main")));
    expect(main!.value).toMatchObject({ thresholdCents: 5000 });
    await run(rewardsRoute.action, post(rewardForm({ rewardId: rewards[0]!, minCartSubtotal: "90" })), { id });
    const [after] = await db.select().from(offerConditions).where(and(eq(offerConditions.offerId, id), eq(offerConditions.scope, "main")));
    expect(after!.value).toMatchObject({ thresholdCents: 5000 });
  });

  it("a save that did not change a tier leaves a raised main threshold and its overrides alone; a tier change lowers both", async () => {
    const { id, rewards } = await seedTieredOffer("draft", "edit-main-raised");
    await db.update(offerConditions).set({ value: { thresholdCents: 9000, currencyCode: "USD", includeGiftValues: false, currencyOverrides: { EUR: 9500 } } }).where(and(eq(offerConditions.offerId, id), eq(offerConditions.scope, "main")));
    const main = async () => (await db.select().from(offerConditions).where(and(eq(offerConditions.offerId, id), eq(offerConditions.scope, "main"))))[0]!.value;
    await run(rewardsRoute.action, post(rewardForm({ rewardId: rewards[0]!, minCartSubtotal: "70", quantity: "2" })), { id });
    expect(await main()).toMatchObject({ thresholdCents: 9000, currencyOverrides: { EUR: 9500 } });
    await run(rewardsRoute.action, post(rewardForm({ rewardId: rewards[0]!, minCartSubtotal: "65" })), { id });
    const lowered = (await main()) as Record<string, unknown>;
    expect(lowered["thresholdCents"]).toBe(6500);
    expect(lowered).not.toHaveProperty("currencyOverrides");
  });

  it("the conditions editor refuses a main cart value above the lowest gift tier", async () => {
    const { id } = await seedTieredOffer("draft", "edit-conditions");
    const [main] = await db.select().from(offerConditions).where(and(eq(offerConditions.offerId, id), eq(offerConditions.scope, "main")));
    const save = (amount: string) => run(conditionsRoute.action, post({ intent: "update_condition", conditionId: main!.id, conditionType: "cart_value", scope: "main", threshold: amount }), { id });
    expect((await save("90"))?.error).toMatch(/lowest gift tier/);
    expect((await db.select().from(offerConditions).where(eq(offerConditions.id, main!.id)))[0]!.value).toMatchObject({ thresholdCents: 7000 });
    expect((await save("60"))?.error).toBeUndefined();
    expect((await db.select().from(offerConditions).where(eq(offerConditions.id, main!.id)))[0]!.value).toMatchObject({ thresholdCents: 6000 });
  });

  it("the main editor's gifts block refuses to replan tiered gifts and leaves every tier as it was", async () => {
    const { id, rewards } = await seedTieredOffer("draft", "edit-main-editor", "highest");
    const before = await rewardsOf(id);
    const result = await run(offerPage.action, post({ intent: "update_reward", rewardId: rewards[1]!, discountType: "free", discountValue: "100", quantity: "1", isAutoAdd: "on", targetVariantIds: JSON.stringify([V(3)]) }), { id });
    expect(result?.error).toMatch(/gift tiers/);
    const after = await rewardsOf(id);
    expect(after.map((r) => [r.id, r.minCartSubtotalCents, r.target])).toEqual(before.map((r) => [r.id, r.minCartSubtotalCents, r.target]));
  });

  it("changes the tier mode, validates it, and leaves tiers alone", async () => {
    const { id, rewards } = await seedTieredOffer("active", "edit-mode");
    expect((await run(rewardsRoute.action, post({ intent: "set_tier_mode", tierMode: "highest" }), { id }))?.error).toBeUndefined();
    expect((await db.select().from(offers).where(eq(offers.id, id)))[0]!.tierMode).toBe("highest");
    expect((await run(rewardsRoute.action, post({ intent: "set_tier_mode", tierMode: "everything" }), { id }))?.error).toMatch(/Choose/);
    expect((await db.select().from(offers).where(eq(offers.id, id)))[0]!.tierMode).toBe("highest");
    expect((await stored(rewards[1]!)).minCartSubtotalCents).toBe(11000);
  });

  it("a reward that stops being a gift loses its tier", async () => {
    const { id, rewards } = await seedTieredOffer("draft", "edit-not-gift");
    await run(rewardsRoute.action, post({ intent: "update_reward", rewardId: rewards[0]!, rewardType: "order_discount", discountType: "percentage", discountValue: "10" }), { id });
    expect((await stored(rewards[0]!)).minCartSubtotalCents).toBeNull();
  });
});

describe("copy and read paths carry the tier fields", () => {
  it("duplicate keeps tierMode and every threshold, in the same shop and across shops", async () => {
    const { id } = await seedTieredOffer("active", "dup-source", "highest");
    const other = await seedShop(db, "tiers-gift-other.myshopify.com");
    for (const options of [{}, { targetShopId: other }]) {
      const copyId = await duplicateOffer(db, ctx.shopId, id, options);
      const [copy] = await db.select().from(offers).where(eq(offers.id, copyId!));
      expect(copy).toMatchObject({ tierMode: "highest", status: "draft" });
      expect((await rewardsOf(copyId!)).map((r) => r.minCartSubtotalCents)).toEqual([7000, 11000]);
    }
  });

  it("offer definitions (storefront /evaluate) carry the tier fields only when set", async () => {
    const tiered = await seedTieredOffer("active", "defs-tiered", "highest");
    const plain = await seedOffer(db, ctx.shopId, { type: "gift", status: "active", internalName: "defs-plain" });
    await db.insert(offerRewards).values({ shopId: ctx.shopId, offerId: plain, rewardType: "product_gift", discountType: "free", value: { amount: 100 }, target: { variantIds: [V(1)] } });
    const defs = await loadOfferDefinitions(ctx.shopId, db);
    const t = defs.find((d) => d.id === tiered.id)!;
    expect(t.tierMode).toBe("highest");
    expect(t.rewards.map((r) => r.minCartSubtotalCents)).toEqual([7000, 11000]);
    const p = defs.find((d) => d.id === plain)!;
    expect(p).not.toHaveProperty("tierMode");
    expect(p.rewards[0]).not.toHaveProperty("minCartSubtotalCents");
  });

  it("an untiered offer keeps its version hash, compiled bytes and summary exactly as before the columns existed", async () => {
    const id = await seedOffer(db, ctx.shopId, { type: "gift", status: "active", internalName: "compat" });
    await db.insert(offerConditions).values({ shopId: ctx.shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 5000, currencyCode: "USD", includeGiftValues: false }, sortOrder: 0, isEnabled: true });
    await db.insert(offerRewards).values({ shopId: ctx.shopId, offerId: id, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" }, target: { scope: "cart", variantIds: [V(1)] }, isAutoAdd: true });
    const [offer] = await db.select().from(offers).where(eq(offers.id, id));
    const conditions = await db.select().from(offerConditions).where(eq(offerConditions.offerId, id));
    const rewards = await rewardsOf(id);
    expect(offer!.tierMode).toBeNull();
    expect(rewards[0]!.minCartSubtotalCents).toBeNull();

    // The rows as they were before the columns: the keys do not exist at all.
    const { tierMode: _t, ...oldOffer } = offer!;
    const { minCartSubtotalCents: _m, ...oldReward } = rewards[0]!;
    expect(computeOfferVersion(offer!, conditions, rewards, null)).toBe(computeOfferVersion(oldOffer, conditions, [oldReward], null));

    const compiled = compileOfferConfig(offer!, conditions, rewards, null, 1);
    const compiledOld = compileOfferConfig(oldOffer as never, conditions, [oldReward] as never, null, 1);
    const bytes = (offerConfig: typeof compiled) => serializeFunctionConfig({ offers: [offerConfig], shippingOffers: [], customerTags: [], version: "v", compiledAt: "t" } as never);
    expect(bytes(compiled)).toBe(bytes(compiledOld));
    expect(bytes(compiled)).not.toMatch(/"tm"|"mcs"/);
    expect(rewardSummary(rewards[0]!)).toBe("Free gift");

    const [defs] = (await loadOfferDefinitions(ctx.shopId, db)).filter((d) => d.id === id);
    expect(defs!.version).toBe(computeOfferVersion(oldOffer, conditions, [oldReward], null));
  });

  it("a tiered reward's summary names its threshold", () => {
    expect(rewardSummary({ rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" }, minCartSubtotalCents: 7000 })).toBe("Free gift from USD 70.00");
  });
});
