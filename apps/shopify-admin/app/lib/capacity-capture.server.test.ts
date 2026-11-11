import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { capacityIncidents, offerConditions, offerRewards, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

let db: Db;
let close: () => Promise<void>;

vi.mock("@promo/db", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getDb: () => db }));

const { withCapacityModal } = await import("./capacity-capture.server.js");
const { finalizeCreatedOffer } = await import("./offer-publish-flow.server.js");

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("withCapacityModal", () => {
  it("adds the Shopify-limit payload when activating an offer is blocked by a capacity limit", async () => {
    const shopId = await seedShop(db, "limit-modal.myshopify.com");
    const offerId = await seedOffer(db, shopId, { internalName: "Huge gift list" });
    await db.insert(offerConditions).values({
      shopId, offerId, scope: "main", conditionType: "cart_value", operator: "gte",
      value: { thresholdCents: 1000, currencyCode: "USD" }, sortOrder: 0, isEnabled: true,
    });
    await db.insert(offerRewards).values({
      shopId, offerId, rewardType: "product_gift", discountType: "free", value: { amount: 100, currencyCode: "USD" },
      target: { variantIds: Array.from({ length: 400 }, (_, i) => `gid://shopify/ProductVariant/${1000 + i}`) },
      quantity: 1, sortOrder: 0,
    });
    const action = withCapacityModal(async () => {
      const error = await finalizeCreatedOffer(db, shopId, "limit-modal.myshopify.com", offerId, "active");
      return { error };
    });
    const result = await action();
    expect(result.error).toEqual(expect.any(String));
    expect(result.capacity).toMatchObject({
      code: "SLOT_FULL",
      offers: [{ id: offerId, name: "Huge gift list" }],
      discountsUrl: "https://limit-modal.myshopify.com/admin/discounts",
    });
    const [incident] = await db.select().from(capacityIncidents).where(eq(capacityIncidents.shopId, shopId));
    expect(incident).toMatchObject({ code: "SLOT_FULL", source: "admin", attended: true });
    expect(result.capacity?.incidentId).toBe(incident?.id);
  });

  it("leaves ordinary errors and successful results untouched", async () => {
    expect(await withCapacityModal(async () => ({ error: "Name is required" }))()).toEqual({ error: "Name is required" });
    expect(await withCapacityModal(async () => ({ success: true }))()).toEqual({ success: true });
  });
});
