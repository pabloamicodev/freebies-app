import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { offerConditions, offerRewards, offers, type Db } from "@promo/db";
import { republishIfActive, validateActivation } from "./offer-publish-flow.server.js";
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
      capacity: { code: "SLOT_FULL", offerIds: [huge] },
    });
    expect(result.error).toContain("The shared automatic config would be");
    expect(result.error).toContain("over the 9500B limit. Pause or simplify other automatic offers first.");
    expect(result.error).toContain('"huge"');

    const toolError = lifecycleToolError({ ok: false, code: "validation", error: result.error!, scope: result.scope, capacity: result.capacity });
    expect(toolError.payload.details?.capacity).toMatchObject({ code: "SLOT_FULL", offerIds: [huge] });
  });

  it("republishIfActive reuses an earlier preflight instead of running a second one", async () => {
    const [row] = await db.select({ id: offers.id }).from(offers).where(eq(offers.internalName, "huge"));
    const id = row!.id;
    const publish = vi.fn(async () => null);
    const earlier = { ok: true as const, plan: { slots: 1, bytesPerSlot: [0], deliveryBytes: 0, maxSlots: 1, budget: null } };
    expect(await republishIfActive(db, shopId, "s.myshopify.com", id, true, publish, earlier)).toBeNull();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await db.select({ status: offers.status }).from(offers).where(eq(offers.id, id))).toEqual([{ status: "draft" }]);
  });
});
