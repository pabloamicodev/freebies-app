import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { offerCombinationPolicies, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "", republish: vi.fn(async (..._args: unknown[]) => null) }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: "combo-shop.myshopify.com", scope: "read_products" },
  }),
}));
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => ctx.db,
}));
vi.mock("./offer-publish-flow.server.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  republishIfActive: ctx.republish,
}));

const route = await import("../routes/app.offers.$id._index.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  shopId = await seedShop(db, "combo-shop.myshopify.com");
  ctx.shopId = shopId;
}, 60_000);
afterAll(async () => {
  await close();
});

const post = (id: string, fields: Record<string, string>) =>
  (route.action as unknown as (a: unknown) => Promise<unknown>)({
    request: new Request("http://localhost/", { method: "POST", body: new URLSearchParams({ intent: "set_combination", ...fields }) }),
    params: { id },
    context: {},
  });
const policy = async (id: string) =>
  (await db.select().from(offerCombinationPolicies).where(eq(offerCombinationPolicies.offerId, id)))[0];

describe("editor combination toggles", () => {
  it.each([
    ["order_discounts", "combinesWithOrderDiscounts"],
    ["product_discounts", "combinesWithProductDiscounts"],
    ["shipping_discounts", "combinesWithShippingDiscounts"],
    ["can_stack_gift_offers", "canStackWithGiftOffers"],
  ] as const)("toggling %s persists and republishes", async (field, column) => {
    const id = await seedOffer(db, shopId, { status: "active", publicTitle: `toggle ${field}` });
    ctx.republish.mockClear();
    await post(id, { [field]: "on" });
    expect((await policy(id))?.[column]).toBe(true);
    expect(ctx.republish).toHaveBeenCalledWith(db, shopId, "combo-shop.myshopify.com", id, true);
    await post(id, {});
    expect((await policy(id))?.[column]).toBe(false);
  });

  it("leaves limits and priority settings untouched", async () => {
    const id = await seedOffer(db, shopId, { publicTitle: "keeps limits" });
    await db.insert(offerCombinationPolicies).values({ shopId, offerId: id, maxApplicationsPerCart: 4, stopLowerPriority: true });
    await post(id, { order_discounts: "on" });
    expect(await policy(id)).toMatchObject({ combinesWithOrderDiscounts: true, maxApplicationsPerCart: 4, stopLowerPriority: true });
  });
});
