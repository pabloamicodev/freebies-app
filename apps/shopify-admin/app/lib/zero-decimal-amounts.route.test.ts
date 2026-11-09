import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { offerConditions, offerRewards, shops, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "", shop: "", currency: "USD" }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: ctx.currency,
    session: { shop: ctx.shop },
    admin: { graphql: async () => ({ json: async () => ({ data: { markets: { nodes: [] } } }) }) },
  }),
}));
vi.mock("../shopify.server.js", () => ({
  authenticate: { admin: async () => ({ session: { shop: ctx.shop } }) },
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

const multicurrencyRoute = await import("../routes/app.offers.$id.multicurrency.js");
const rewardsRoute = await import("../routes/app.offers.$id.rewards.js");

let db: Db;
let close: () => Promise<void>;
let usdShop = "";
let jpyShop = "";

const post = (fields: Array<[string, string]>) => new Request("http://localhost/x", { method: "POST", body: new URLSearchParams(fields) });
type Out = { error?: string | null; success?: boolean } | Response | undefined;
const run = (fn: unknown, request: Request, params: Record<string, string> = {}) =>
  (fn as (a: unknown) => Promise<Out>)({ request, params, context: {} }) as Promise<Exclude<Out, Response>>;
const useShop = (which: "usd" | "jpy") => {
  ctx.shopId = which === "usd" ? usdShop : jpyShop;
  ctx.shop = which === "usd" ? "amounts-usd.myshopify.com" : "amounts-jpy.myshopify.com";
  ctx.currency = which === "usd" ? "USD" : "JPY";
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  usdShop = await seedShop(db, "amounts-usd.myshopify.com");
  jpyShop = await seedShop(db, "amounts-jpy.myshopify.com");
  await db.update(shops).set({ currencyCode: "JPY" }).where(eq(shops.id, jpyShop));
}, 60_000);
afterAll(async () => {
  await close();
});

const cartValueOffer = async (shopId: string, name: string) => {
  const id = await seedOffer(db, shopId, { type: "gift", status: "draft", internalName: name, publicTitle: name });
  await db.insert(offerConditions).values({ shopId, offerId: id, scope: "main", conditionType: "cart_value", operator: "gte", value: { thresholdCents: 5000, currencyCode: "USD" }, sortOrder: 0, isEnabled: true });
  return id;
};
const conditionValue = async (offerId: string) => (await db.select().from(offerConditions).where(eq(offerConditions.offerId, offerId)))[0]!.value as Record<string, unknown>;

describe("multicurrency fixed-amount overrides", () => {
  const save = (rows: Array<{ currency: string; threshold?: string; fixed?: string }>) =>
    post(rows.flatMap((row): Array<[string, string]> => [["currency[]", row.currency], ["threshold_cents[]", row.threshold ?? ""], ["max_threshold_cents[]", ""], ["fixed_amount[]", row.fixed ?? ""]]));

  it("a JPY shop stores a JPY market's fixed amount in whole yen, and a USD market's in cents", async () => {
    useShop("jpy");
    const id = await cartValueOffer(jpyShop, "jpy-fixed");
    expect((await run(multicurrencyRoute.action, save([{ currency: "JPY", fixed: "500" }, { currency: "USD", fixed: "5.25" }]), { id }))?.success).toBe(true);
    expect((await conditionValue(id))["fixedAmountOverrides"]).toEqual({ JPY: 500, USD: 525 });
  });

  it("a USD shop keeps storing x100 for every market, JPY included", async () => {
    useShop("usd");
    const id = await cartValueOffer(usdShop, "usd-fixed");
    await run(multicurrencyRoute.action, save([{ currency: "JPY", threshold: "5000", fixed: "500" }, { currency: "EUR", fixed: "4.5" }]), { id });
    const value = await conditionValue(id);
    expect(value["fixedAmountOverrides"]).toEqual({ JPY: 50000, EUR: 450 });
    expect(value["currencyOverrides"]).toEqual({ JPY: 500000 });
  });
});

describe("fixed reward amounts take their unit from the shop currency", () => {
  const addReward = (fields: Record<string, string>) =>
    post(Object.entries({ intent: "add_reward", rewardType: "order_discount", discountType: "fixed_amount", discountValue: "500", ...fields }));
  const amountOf = async (offerId: string) => (await db.select().from(offerRewards).where(eq(offerRewards.offerId, offerId)))[0]!.value as { amount: number; currencyCode: string };

  it("a JPY shop stores whole yen even when the typed currency tag says USD", async () => {
    useShop("jpy");
    const id = await seedOffer(db, jpyShop, { type: "discount", status: "draft", internalName: "jpy-reward" });
    expect((await run(rewardsRoute.action, addReward({ currencyCode: "USD" }), { id }))?.error).toBeUndefined();
    expect(await amountOf(id)).toEqual({ amount: 500, currencyCode: "USD" });
  });

  it("a USD shop stores cents even when the typed tag says JPY, and the usual case is unchanged", async () => {
    useShop("usd");
    const tagged = await seedOffer(db, usdShop, { type: "discount", status: "draft", internalName: "usd-reward-jpy-tag" });
    await run(rewardsRoute.action, addReward({ currencyCode: "JPY" }), { id: tagged });
    expect(await amountOf(tagged)).toMatchObject({ amount: 50000 });
    const plain = await seedOffer(db, usdShop, { type: "discount", status: "draft", internalName: "usd-reward" });
    await run(rewardsRoute.action, addReward({ currencyCode: "USD", discountValue: "5.5" }), { id: plain });
    expect(await amountOf(plain)).toEqual({ amount: 550, currencyCode: "USD" });
  });
});
