import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@promo/db";
import type * as PromoDb from "@promo/db";
import type * as DrizzleOrm from "drizzle-orm";
import { cleanupOldAnalyticsEvents, reconcileOrderAttribution } from "./analytics-reconcile.server.js";

function fakeDb(batches: Array<Array<{ id: string }>>) {
  const remaining = [...batches];
  const deleteCalls: string[][] = [];

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(remaining.shift() ?? []),
        }),
      }),
    }),
    delete: () => ({
      where: (idsCondition: unknown) => {
        // drizzle's inArray(...) builds an opaque SQL node — recover the ids
        // vitest passed in via the mock instead of parsing SQL.
        deleteCalls.push((idsCondition as { __ids: string[] }).__ids);
        return Promise.resolve(undefined);
      },
    }),
  };
  return { db: db as unknown as Db, deleteCalls };
}

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof DrizzleOrm>();
  return {
    ...actual,
    inArray: (_column: unknown, ids: string[]) => ({ __ids: ids }),
  };
});

const { insertCalls, getDbMock } = vi.hoisted(() => {
  const insertCalls: Array<{ values: Record<string, unknown> }> = [];
  return {
    insertCalls,
    getDbMock: () => ({
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoNothing: () => {
            insertCalls.push({ values });
            return Promise.resolve(undefined);
          },
        }),
      }),
    }),
  };
});

vi.mock("@promo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof PromoDb>();
  return {
    ...actual,
    getDb: getDbMock,
  };
});

describe("cleanupOldAnalyticsEvents", () => {
  it("deletes in batches of up to 5000 instead of one unbounded delete", async () => {
    const fullBatch = Array.from({ length: 5_000 }, (_, i) => ({ id: `id-${i}` }));
    const lastBatch = [{ id: "id-last" }];
    const { db, deleteCalls } = fakeDb([fullBatch, lastBatch]);

    const count = await cleanupOldAnalyticsEvents(90, db);

    expect(count).toBe(5_001);
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0]).toHaveLength(5_000);
    expect(deleteCalls[1]).toEqual(["id-last"]);
  });

  it("does nothing when there's nothing past the retention window", async () => {
    const { db, deleteCalls } = fakeDb([[]]);
    const count = await cleanupOldAnalyticsEvents(90, db);
    expect(count).toBe(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it("stops picking up new batches once maxRuntimeMs has elapsed, to resume on the next cron run", async () => {
    const fullBatch = Array.from({ length: 5_000 }, (_, i) => ({ id: `id-${i}` }));
    const { db, deleteCalls } = fakeDb([fullBatch, fullBatch, fullBatch]);

    const count = await cleanupOldAnalyticsEvents(90, db, 0);

    expect(count).toBe(0);
    expect(deleteCalls).toHaveLength(0);
  });
});

describe("reconcileOrderAttribution", () => {
  beforeEach(() => {
    insertCalls.length = 0;
  });

  const baseData = {
    shopId: "shop-1",
    orderId: "1001",
    orderGid: "gid://shopify/Order/1001",
    cartToken: "cart-tok",
    customerId: "cust-1",
    totalPriceCents: 4999,
    sessionId: "session-1",
  };

  it("does nothing when there are no attributed offers", async () => {
    await reconcileOrderAttribution({ ...baseData, offerIds: [] });
    expect(insertCalls).toHaveLength(0);
  });

  it("builds the dedup key from shop, order and offer id", async () => {
    const offerId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"; // 36 chars
    await reconcileOrderAttribution({ ...baseData, offerIds: [offerId] });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]!.values.deduplicationKey).toBe(
      `shopify:shop-1:order-paid:gid://shopify/Order/1001:${offerId}`,
    );
    expect(insertCalls[0]!.values.offerId).toBe(offerId);
  });

  it("silently drops a malformed (non-UUID-length) offerId instead of raising", async () => {
    const malformedOfferId = "not-a-real-uuid";
    await reconcileOrderAttribution({ ...baseData, offerIds: [malformedOfferId] });

    expect(insertCalls).toHaveLength(1);
    // The row is still inserted (dedup key still uses the raw id), but offerId
    // is silently nulled out because it fails the 36-char UUID length check —
    // no error, no log, the attribution just becomes unlinked from an offer.
    expect(insertCalls[0]!.values.offerId).toBeNull();
    expect(insertCalls[0]!.values.deduplicationKey).toContain(malformedOfferId);
  });

  it("produces one row per offer when an order is attributed to multiple offers", async () => {
    const offerA = "aaaaaaaa-1111-2222-3333-444444444444";
    const offerB = "bbbbbbbb-1111-2222-3333-444444444444";
    await reconcileOrderAttribution({ ...baseData, offerIds: [offerA, offerB] });

    expect(insertCalls).toHaveLength(2);
    expect(insertCalls.map((c) => c.values.offerId)).toEqual([offerA, offerB]);
    expect(insertCalls.map((c) => c.values.deduplicationKey)).toEqual([
      `shopify:shop-1:order-paid:gid://shopify/Order/1001:${offerA}`,
      `shopify:shop-1:order-paid:gid://shopify/Order/1001:${offerB}`,
    ]);
    // Both rows carry the full offer_ids list in properties, not just their own offer.
    expect((insertCalls[0]!.values.properties as { offer_ids: string[] }).offer_ids).toEqual([offerA, offerB]);
  });
});
