import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { offerCustomerUsages, offerUsageSync, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

vi.mock("@sentry/node", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
const { applyBackfillUsages, buildBulkOrdersQuery, parseBulkOrdersJsonl } = await import("./offer-usage-backfill.server.js");

const OFFER_A = "11111111-1111-4111-8111-111111111111";
const OFFER_B = "22222222-2222-4222-8222-222222222222";
const OFFER_C = "33333333-3333-4333-8333-333333333333";
const OFFER_D = "44444444-4444-4444-8444-444444444444";
const row = (id: string, title: string, requiresCode = false) => ({
  id,
  publicTitle: title,
  internalName: title,
  requiresCode,
  requiredDiscountCode: null,
});
const offerRows = [row(OFFER_A, "Free Gift"), row(OFFER_B, "Code Offer", true), row(OFFER_C, "Line Offer")];
const codes = new Map([["WELCOME10", [OFFER_B]]]);
const j = (o: unknown) => JSON.stringify(o);
const order = (id: number, customer: number | null = 7) =>
  j({ id: `gid://shopify/Order/${id}`, customer: customer ? { id: `gid://shopify/Customer/${customer}` } : null });
const app = (id: number, a: object) => j({ __parentId: `gid://shopify/Order/${id}`, ...a });
const line = (id: number, offerId: string, amount: string) =>
  j({
    __parentId: `gid://shopify/Order/${id}`,
    id: `gid://shopify/LineItem/${id}`,
    customAttributes: [{ key: "_promo_engine_offer_id", value: offerId }],
    discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount } } }],
  });

describe("parseBulkOrdersJsonl", () => {
  it("attributes automatic by title, code by code and gift lines with a discount", () => {
    const lines = [
      order(1),
      app(1, { __typename: "AutomaticDiscountApplication", title: "Free Gift" }),
      order(2),
      app(2, { __typename: "DiscountCodeApplication", code: "welcome10" }),
      order(3),
      line(3, OFFER_C, "5.00"),
    ];
    const { rows, orders } = parseBulkOrdersJsonl(lines, offerRows, codes);
    expect(orders).toBe(3);
    expect(rows).toEqual([
      { offerId: OFFER_A, customerGid: "gid://shopify/Customer/7", orderGid: "gid://shopify/Order/1" },
      { offerId: OFFER_B, customerGid: "gid://shopify/Customer/7", orderGid: "gid://shopify/Order/2" },
      { offerId: OFFER_C, customerGid: "gid://shopify/Customer/7", orderGid: "gid://shopify/Order/3" },
    ]);
  });

  it("ignores undiscounted gift lines, guests, and offers outside the target set", () => {
    const lines = [
      order(1),
      line(1, OFFER_C, "0.00"),
      order(2, null),
      app(2, { __typename: "AutomaticDiscountApplication", title: "Free Gift" }),
      order(3),
      app(3, { __typename: "AutomaticDiscountApplication", title: "Free Gift" }),
      app(3, { __typename: "DiscountCodeApplication", code: "WELCOME10" }),
    ];
    const { rows } = parseBulkOrdersJsonl(lines, offerRows, codes, new Set([OFFER_B]));
    expect(rows.map((r) => r.offerId)).toEqual([OFFER_B]);
  });

  it("dedupes per (order, offer), counts a title collision against every match, and skips junk lines", () => {
    const lines = [
      order(1),
      app(1, { __typename: "AutomaticDiscountApplication", title: "Free Gift" }),
      app(1, { __typename: "AutomaticDiscountApplication", title: "Free Gift" }),
      line(1, OFFER_A, "2.00"),
      "not json",
      j({ __parentId: "gid://shopify/Order/999", __typename: "DiscountCodeApplication", code: "X" }),
    ];
    const { rows, skipped } = parseBulkOrdersJsonl(lines, [...offerRows, row(OFFER_D, "Free Gift")], codes);
    expect(rows.map((r) => r.offerId).sort()).toEqual([OFFER_A, OFFER_D].sort());
    expect(skipped).toBe(2);
  });

  it("builds a paid-only bulk query from the date", () => {
    expect(buildBulkOrdersQuery("2026-01-01")).toContain("created_at:>=2026-01-01");
  });
});

describe("applyBackfillUsages", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  }, 60_000);
  afterAll(async () => close());

  it("is idempotent, tags source backfill and marks only customers with new rows pending", async () => {
    const shopId = await seedShop(db, "backfill.myshopify.com");
    const offerId = await seedOffer(db, shopId);
    const rows = [
      { offerId, customerGid: "gid://shopify/Customer/1", orderGid: "gid://shopify/Order/1" },
      { offerId, customerGid: "gid://shopify/Customer/2", orderGid: "gid://shopify/Order/2" },
    ];
    expect(await applyBackfillUsages(db, shopId, rows, 1)).toEqual({ inserted: 2, customersMarked: 2 });
    await db.update(offerUsageSync).set({ pendingSince: null }).where(eq(offerUsageSync.shopId, shopId));
    const third = { offerId, customerGid: "gid://shopify/Customer/3", orderGid: "gid://shopify/Order/3" };
    expect(await applyBackfillUsages(db, shopId, [...rows, third])).toEqual({ inserted: 1, customersMarked: 1 });
    const stored = await db.select().from(offerCustomerUsages).where(eq(offerCustomerUsages.shopId, shopId));
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map((r) => r.source))).toEqual(new Set(["backfill"]));
    const sync = await db.select().from(offerUsageSync).where(eq(offerUsageSync.shopId, shopId));
    expect(sync.filter((p) => p.pendingSince).map((p) => p.customerGid)).toEqual(["gid://shopify/Customer/3"]);
  });
});
