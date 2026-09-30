import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import type { OrderWebhookPayload } from "./order-paid.server.js";

// reconcileOrderAttribution (called internally by handleOrderPaid) reaches for
// getDb() itself rather than taking a db param — mock the module so it resolves
// to the same fakeDb the test passes into handleOrderPaid explicitly.
let currentDb: Db | null = null;
vi.mock("@promo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof PromoDb>();
  return {
    ...actual,
    getDb: () => currentDb,
  };
});

const dispatchIntegrationEvents = vi.fn().mockResolvedValue(undefined);
vi.mock("../integration-dispatcher.server.js", () => ({
  dispatchIntegrationEvents: (...args: unknown[]) => dispatchIntegrationEvents(...args),
  PermanentIntegrationError: class PermanentIntegrationError extends Error {},
}));

const { handleOrderPaid } = await import("./order-paid.server.js");

function fakeDb(offerRows: Array<{ id: string }>) {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(offerRows),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => {
          inserted.push(values);
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
  return { db: db as unknown as Db, inserted };
}

function makeOrder(overrides: Partial<OrderWebhookPayload> = {}): OrderWebhookPayload {
  return {
    id: 555,
    admin_graphql_api_id: "gid://shopify/Order/555",
    cart_token: "cart-token-1",
    total_price: "10.00",
    line_items: [],
    note_attributes: [],
    ...overrides,
  };
}

const OFFER_A = "11111111-1111-4111-8111-111111111111";
const OFFER_B = "22222222-2222-4222-8222-222222222222";
const FOREIGN_OFFER = "33333333-3333-4333-8333-333333333333";

describe("handleOrderPaid", () => {
  beforeEach(() => {
    dispatchIntegrationEvents.mockClear();
    currentDb = null;
  });

  it("does nothing when shopId is null (shop not found)", async () => {
    const { db, inserted } = fakeDb([]);
    currentDb = db;
    await handleOrderPaid(db, null, "shop.myshopify.com", makeOrder());
    expect(inserted).toHaveLength(0);
    expect(dispatchIntegrationEvents).not.toHaveBeenCalled();
  });

  it("attributes revenue to a claimed, shop-owned offer and builds the expected dedup key", async () => {
    const { db, inserted } = fakeDb([{ id: OFFER_A }]);
    currentDb = db;
    const order = makeOrder({
      total_price_set: { shop_money: { amount: "19.99" } },
      line_items: [
        { id: 1, variant_id: 1, product_id: 1, properties: [{ name: "_promo_engine_offer_id", value: OFFER_A }] },
      ],
    });

    await handleOrderPaid(db, "shop-1", "shop.myshopify.com", order);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      shopId: "shop-1",
      offerId: OFFER_A,
      orderId: "gid://shopify/Order/555",
      deduplicationKey: `shopify:shop-1:order-paid:gid://shopify/Order/555:${OFFER_A}`,
    });
    expect((inserted[0]!["properties"] as Record<string, unknown>)["total_price_cents"]).toBe(1999);
    expect(dispatchIntegrationEvents).toHaveBeenCalledWith(
      "shop-1",
      db,
      expect.objectContaining({ event: "order_paid", offerIds: [OFFER_A], totalPriceCents: 1999 }),
    );
  });

  it("filters out malformed ids and ids for offers that don't belong to this shop", async () => {
    // The db query (simulating the shop-scoped lookup) returns no rows at all,
    // as it would for an offer id claimed by a different shop.
    const { db, inserted } = fakeDb([]);
    currentDb = db;
    const order = makeOrder({
      line_items: [
        { id: 1, variant_id: 1, product_id: 1, properties: [{ name: "_promo_engine_offer_id", value: "not-a-uuid" }] },
        { id: 2, variant_id: 2, product_id: 2, properties: [{ name: "_promo_engine_offer_id", value: FOREIGN_OFFER }] },
      ],
    });

    await handleOrderPaid(db, "shop-1", "shop.myshopify.com", order);

    expect(inserted).toHaveLength(0);
    expect(dispatchIntegrationEvents).toHaveBeenCalledWith(
      "shop-1",
      db,
      expect.objectContaining({ offerIds: [] }),
    );
  });

  it("fans out one analytics event row per claimed offer id when multiple offers are on the order", async () => {
    const { db, inserted } = fakeDb([{ id: OFFER_A }, { id: OFFER_B }]);
    currentDb = db;
    const order = makeOrder({
      line_items: [
        { id: 1, variant_id: 1, product_id: 1, properties: [{ name: "_promo_engine_offer_id", value: OFFER_A }] },
        { id: 2, variant_id: 2, product_id: 2, properties: [{ name: "_promo_engine_offer_id", value: OFFER_B }] },
      ],
    });

    await handleOrderPaid(db, "shop-1", "shop.myshopify.com", order);

    expect(inserted).toHaveLength(2);
    expect(inserted.map((row) => row["offerId"])).toEqual([OFFER_A, OFFER_B]);
    const dedupKeys = inserted.map((row) => row["deduplicationKey"]);
    expect(new Set(dedupKeys).size).toBe(2);
    expect(dispatchIntegrationEvents).toHaveBeenCalledWith(
      "shop-1",
      db,
      expect.objectContaining({ offerIds: [OFFER_A, OFFER_B] }),
    );
  });
});
