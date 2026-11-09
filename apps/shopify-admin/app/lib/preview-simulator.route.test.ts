import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { offerConditions, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "" }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: "preview-shop.myshopify.com" },
  }),
}));

const previewRoute = await import("../routes/app.offers.$id.preview.js");

let db: Db;
let close: () => Promise<void>;
const VARIANT = "gid://shopify/ProductVariant/42";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  ctx.shopId = await seedShop(db, "preview-shop.myshopify.com");
}, 60_000);
afterAll(async () => {
  await close();
});

const simulate = async (id: string, fields: Record<string, string>) => {
  const request = new Request("http://localhost/x", { method: "POST", body: new URLSearchParams({ variantId: VARIANT, ...fields }) });
  const out = await (previewRoute.action as unknown as (a: unknown) => Promise<{ result?: { qualifiedOffers: Array<{ offerId: string }> } }>)({
    request,
    params: { id },
    context: {},
  });
  return out.result!.qualifiedOffers.some((offer) => offer.offerId === id);
};

describe("offer simulator with a zero or empty cart total", () => {
  it("still treats the simulated line as a paid unit for requirement conditions", async () => {
    const id = await seedOffer(db, ctx.shopId, { type: "discount", status: "active" });
    await db.insert(offerConditions).values({
      shopId: ctx.shopId,
      offerId: id,
      scope: "main",
      conditionType: "specific_product",
      operator: "all",
      value: { requirements: [{ productId: "gid://shopify/Product/10000000000000", variantId: VARIANT, trackMode: "variant", minQuantity: 1 }], multiplyByGroups: false },
    });
    expect(await simulate(id, { cartTotal: "", cartQty: "1" })).toBe(true);
    expect(await simulate(id, { cartTotal: "0", cartQty: "1" })).toBe(true);
    expect(await simulate(id, { cartTotal: "25", cartQty: "1" })).toBe(true);
  });
});
