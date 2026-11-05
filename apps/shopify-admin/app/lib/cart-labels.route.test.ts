import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { offerRewards, offers, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "" }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: "labels-shop.myshopify.com" },
  }),
}));
vi.mock("../shopify.server.js", () => ({
  authenticate: { admin: async () => ({ session: { shop: "labels-shop.myshopify.com" } }) },
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

const discountWizard = await import("../routes/app.offers.new.discount.$template.js");
const rewardsRoute = await import("../routes/app.offers.$id.rewards.js");
const offerPage = await import("../routes/app.offers.$id._index.js");

let db: Db;
let close: () => Promise<void>;

const post = (fields: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of [v].flat()) body.append(k, item);
  return new Request("http://localhost/x", { method: "POST", body });
};
const run = (fn: unknown, request: Request, params: Record<string, string> = {}) =>
  (fn as (a: unknown) => Promise<{ error?: string } | undefined>)({ request, params, context: {} });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  ctx.shopId = await seedShop(db, "labels-shop.myshopify.com");
}, 60_000);
afterAll(async () => {
  await close();
});

describe("cart labels", () => {
  it("the volume wizard stores offer labels and per-tier labels, and rejects more than 3", async () => {
    const fields = {
      intent: "draft",
      discountTemplate: "volume",
      internalName: "volume-labels",
      publicTitle: "Volume",
      applyTo: "any_product",
      cartLabels: JSON.stringify([" Spring ", "VIP"]),
      "tier_qty[]": ["1", "2"],
      "tier_max_qty[]": ["1", ""],
      "tier_label[]": ["Buy 1", "Buy 2+"],
      "tier_discount_type[]": ["percentage", "percentage"],
      "tier_discount_value[]": ["15", "20"],
      "tier_cart_labels[]": [JSON.stringify(["Starter"]), "[]"],
    };
    const result = await run(discountWizard.action, post(fields), { template: "volume" });
    expect(result?.error).toBeUndefined();
    const [offer] = await db.select().from(offers).where(eq(offers.internalName, "volume-labels"));
    expect(offer?.cartLabels).toEqual(["Spring", "VIP"]);
    const [reward] = await db.select().from(offerRewards).where(eq(offerRewards.offerId, offer!.id));
    const tiers = (reward!.value as { tiers: Array<Record<string, unknown>> }).tiers;
    expect(tiers[0]!["cartLabels"]).toEqual(["Starter"]);
    expect("cartLabels" in tiers[1]!).toBe(false);

    const tooMany = await run(
      discountWizard.action,
      post({ ...fields, internalName: "too-many", cartLabels: JSON.stringify(["a", "b", "c", "d"]) }),
      { template: "volume" },
    );
    expect(tooMany?.error).toMatch(/at most 3/);
    const tierTooLong = await run(
      discountWizard.action,
      post({ ...fields, internalName: "tier-long", "tier_cart_labels[]": [JSON.stringify(["x".repeat(41)]), "[]"] }),
      { template: "volume" },
    );
    expect(tierTooLong?.error).toMatch(/40 characters/);
  });

  it("the offer page saves labels, keeps them when a save carries none, and clears them", async () => {
    const id = await seedOffer(db, ctx.shopId, { type: "discount", status: "draft", internalName: "page-labels", publicTitle: "Page" });
    const update = (extra: Record<string, string>) =>
      run(offerPage.action, post({ intent: "update", internalName: "page-labels", publicTitle: "Page", ...extra }), { id });
    expect((await update({ cartLabels: JSON.stringify(["A", "B"]) }))?.error).toBeUndefined();
    const read = async () => (await db.select().from(offers).where(eq(offers.id, id)))[0]!.cartLabels;
    expect(await read()).toEqual(["A", "B"]);
    await update({});
    expect(await read()).toEqual(["A", "B"]);
    expect((await update({ cartLabels: JSON.stringify(["a", "b", "c", "d"]) }))?.error).toMatch(/at most 3/);
    expect(await read()).toEqual(["A", "B"]);
    await update({ cartLabels: "[]" });
    expect(await read()).toEqual([]);
  });

  it("editing a tiered product discount keeps its tiers on both edit paths", async () => {
    const id = await seedOffer(db, ctx.shopId, { type: "discount", status: "draft", internalName: "tiers-kept", publicTitle: "Tiers" });
    const tiers = [
      { minimumQuantity: 1, maximumQuantity: 1, discountType: "percentage", discountValue: 15, cartLabels: ["Starter"] },
      { minimumQuantity: 2, discountType: "percentage", discountValue: 20 },
    ];
    const [reward] = await db
      .insert(offerRewards)
      .values({
        shopId: ctx.shopId, offerId: id, rewardType: "product_discount", discountType: "percentage",
        value: { amount: 10, currencyCode: "USD", tiers }, target: { scopeMode: "sitewide", scope: "all_products" },
      })
      .returning({ id: offerRewards.id });
    const valueNow = async () =>
      (await db.select().from(offerRewards).where(and(eq(offerRewards.offerId, id), eq(offerRewards.id, reward!.id))))[0]!.value as Record<string, unknown>;

    const viaRewards = await run(
      rewardsRoute.action,
      post({ intent: "update_reward", rewardId: reward!.id, rewardType: "product_discount", discountType: "percentage", discountValue: "12", productScopeMode: "sitewide" }),
      { id },
    );
    expect(viaRewards?.error).toBeUndefined();
    expect(await valueNow()).toMatchObject({ amount: 12, tiers });

    const viaPage = await run(
      offerPage.action,
      post({ intent: "update_reward", rewardId: reward!.id, discountType: "percentage", discountValue: "14", quantity: "1" }),
      { id },
    );
    expect(viaPage?.error).toBeUndefined();
    expect(await valueNow()).toMatchObject({ amount: 14, tiers });
  });
});
