import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { offerConditions, offerRewards, type Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import type * as Publisher from "./sync/offer-publisher.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

/** Editor sub-routes and offers-list bulk actions carry the Shopify-limit payload next to their error. */
const SHOP = "limit-routes.myshopify.com";
const ctx = vi.hoisted(() => ({ db: null as unknown, shopId: "" }));

vi.mock("./shop-context.server.js", () => ({
  getShopContext: async () => ({
    db: ctx.db,
    shopId: ctx.shopId,
    timezone: "UTC",
    currencyCode: "USD",
    session: { shop: SHOP, accessToken: "tok" },
  }),
}));
vi.mock("../shopify.server.js", () => ({ authenticate: { admin: async () => ({ session: { shop: SHOP } }) } }));
vi.mock("@promo/db", async (importOriginal) => ({ ...(await importOriginal<typeof PromoDb>()), getDb: () => ctx.db }));
vi.mock("./sync/offer-publisher.server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Publisher>()),
  publishOffersForShop: async () => "ok",
}));
vi.mock("./offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("./publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));

const priority = await import("../routes/app.offers.$id.priority.js");
const list = await import("../routes/app.offers._index.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ctx.db = db;
  shopId = await seedShop(db, SHOP);
  ctx.shopId = shopId;
}, 60_000);
afterAll(async () => {
  await close();
});

async function hugeGift(name: string, status: string) {
  const offerId = await seedOffer(db, shopId, { internalName: name, status });
  await db.insert(offerConditions).values({
    shopId, offerId, scope: "main", conditionType: "cart_value", operator: "gte",
    value: { thresholdCents: 1000, currencyCode: "USD" }, sortOrder: 0, isEnabled: true,
  });
  await db.insert(offerRewards).values({
    shopId, offerId, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" },
    target: { variantIds: Array.from({ length: 400 }, (_, i) => `gid://shopify/ProductVariant/${5000 + i}`) },
    quantity: 1, sortOrder: 0,
  });
  return offerId;
}

const post = (action: unknown, url: string, body: Record<string, string>, params: Record<string, string> = {}) =>
  (action as (a: unknown) => Promise<{ error?: string; capacity?: { code: string; offers: { id: string; name: string }[] } }>)({
    request: new Request(url, { method: "POST", body: new URLSearchParams(body) }),
    params,
    context: {},
  });

describe("Shopify-limit payload on editor sub-routes and bulk actions", { timeout: 30_000 }, () => {
  it("priority save on an active oversized offer returns the capacity payload", async () => {
    const id = await hugeGift("Priority too big", "active");
    const result = await post(priority.action, `http://localhost/app/offers/${id}/priority`, { priority: "5" }, { id });
    expect(result.error).toEqual(expect.any(String));
    expect(result.capacity?.code).toBe("SLOT_FULL");
    expect(result.capacity?.offers).toContainEqual({ id, name: "Priority too big" });
  });

  it("bulk activate of an oversized offer returns the capacity payload", async () => {
    const id = await hugeGift("Bulk too big", "paused");
    const fd = new URLSearchParams();
    fd.append("intent", "bulk_activate");
    fd.append("offerIds[]", id);
    const result = await post(list.action, "http://localhost/app/offers", Object.fromEntries(fd));
    expect(result.error).toEqual(expect.any(String));
    expect(result.capacity?.code).toBe("SLOT_FULL");
    expect(result.capacity?.offers.map((offer) => offer.id)).toContain(id);
  });
});
