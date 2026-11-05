import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { offerConditions, offerRewards, type Db } from "@promo/db";
import { validateActivation } from "./offer-publish-flow.server.js";
import { lifecycleToolError } from "./mcp/write-runner.server.js";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

let db: Db;
let close: () => Promise<void>;
let shopId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  shopId = await seedShop(db, "flow-capacity.myshopify.com");
}, 60_000);
afterAll(async () => {
  await close();
});

let seq = 0;
async function giftOffer(variants: number, name: string) {
  const offerId = await seedOffer(db, shopId, { internalName: name, status: "draft" });
  await db.insert(offerConditions).values({
    shopId, offerId, scope: "main", conditionType: "cart_value", operator: "gte",
    value: { thresholdCents: 1000, currencyCode: "USD" }, sortOrder: 0, isEnabled: true,
  });
  await db.insert(offerRewards).values({
    shopId, offerId, rewardType: "product_gift", discountType: "percentage", value: { amount: 100 },
    target: { variantIds: Array.from({ length: variants }, () => `gid://shopify/ProductVariant/${++seq}`) },
    quantity: 1, sortOrder: 0,
  });
  return offerId;
}

describe("validateActivation capacity", () => {
  it("carries the structured capacity error and passes it to the MCP error details", async () => {
    const small = await giftOffer(2, "small");
    expect(await validateActivation(db, shopId, [small])).toEqual({ ok: true });

    const huge = await giftOffer(400, "huge");
    const result = await validateActivation(db, shopId, [huge]);
    expect(result).toMatchObject({
      ok: false,
      scope: "shop",
      capacity: { code: "OFFER_TOO_LARGE", offerIds: [huge] },
    });
    expect(result.capacity?.numbers["slotBytes"]).toBe(9500);
    expect(result.error).toContain('"huge"');

    const toolError = lifecycleToolError({ ok: false, code: "validation", error: result.error!, scope: result.scope, capacity: result.capacity });
    expect(toolError.payload.details?.capacity).toMatchObject({ code: "OFFER_TOO_LARGE", offerIds: [huge] });
  });
});
