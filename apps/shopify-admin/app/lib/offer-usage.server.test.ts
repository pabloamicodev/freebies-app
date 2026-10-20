import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { discountCodes, offerCustomerUsages, offerUsageSync, offers, shops, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";
import type { PushUsage } from "./offer-usage.server.js";

vi.mock("@sentry/node", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("./token-crypto.server.js", () => ({ decryptToken: async () => "token" }));
vi.mock("./sync/analytics-reconcile.server.js", () => ({ reconcileOrderAttribution: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./integration-dispatcher.server.js", () => ({ dispatchIntegrationEvents: vi.fn().mockResolvedValue(undefined) }));

const Sentry = await import("@sentry/node");
const usage = await import("./offer-usage.server.js");
const { handleOrderPaid } = await import("./webhooks/order-paid.server.js");
const { handleCustomersRedact } = await import("./webhooks/gdpr.server.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let n = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => close());
beforeEach(async () => {
  shopId = await seedShop(db, `shop-${++n}.myshopify.com`);
  usage.resetUsageScopeWarnings();
  vi.mocked(Sentry.captureMessage).mockClear();
  vi.mocked(Sentry.captureException).mockClear();
  await db.delete(offerUsageSync);
});

const CUSTOMER = 4242;
const CUSTOMER_GID = `gid://shopify/Customer/${CUSTOMER}`;

function order(over: Record<string, unknown> = {}) {
  n += 1;
  return {
    id: n,
    admin_graphql_api_id: `gid://shopify/Order/${n}`,
    cart_token: null,
    customer: { id: CUSTOMER },
    discount_applications: [],
    discount_codes: [],
    line_items: [],
    note_attributes: [],
    ...over,
  } as never;
}
const auto = (title: string) => ({ type: "automatic", title });
const usageRows = (forShop = shopId) => db.select().from(offerCustomerUsages).where(eq(offerCustomerUsages.shopId, forShop));
const syncRow = async () =>
  (await db.select().from(offerUsageSync).where(and(eq(offerUsageSync.shopId, shopId), eq(offerUsageSync.customerGid, CUSTOMER_GID))))[0];

describe("recordOfferUsages attribution", () => {
  it("matches an automatic application to the offer by exact public title, keyed by customer GID", async () => {
    const a = await seedOffer(db, shopId, { publicTitle: "Free Mug" });
    await seedOffer(db, shopId, { publicTitle: "Other" });
    const result = await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("Free Mug")] }));
    expect(result).toMatchObject({ customerGid: CUSTOMER_GID, inserted: 1 });
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ offerId: a, customerGid: CUSTOMER_GID, source: "title" });
  });

  it("does not match a title that differs in case, nor archived offers", async () => {
    await seedOffer(db, shopId, { publicTitle: "Free Mug" });
    await seedOffer(db, shopId, { publicTitle: "Old Deal", status: "archived" });
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("free mug"), auto("Old Deal")] }));
    expect(await usageRows()).toHaveLength(0);
  });

  it("matches a code application by code only, never by title, and ignores other shops' codes", async () => {
    const coded = await seedOffer(db, shopId, { publicTitle: "Coded", requiresCode: true });
    await db.insert(discountCodes).values({ shopId, offerId: coded, code: "SAVE10" } as never);
    const otherShop = await seedShop(db, `other-${++n}.myshopify.com`);
    const foreign = await seedOffer(db, otherShop, { requiresCode: true });
    await db.insert(discountCodes).values({ shopId: otherShop, offerId: foreign, code: "THEIRS" } as never);

    await usage.recordOfferUsages(
      db,
      shopId,
      order({
        discount_applications: [{ type: "discount_code", code: "save10" }, { type: "discount_code", code: "THEIRS" }, auto("Coded")],
        discount_codes: [{ code: "save10" }],
      }),
    );
    const rows = await usageRows();
    expect(rows.map((r) => [r.offerId, r.source])).toEqual([[coded, "code"]]);
    expect(await usageRows(otherShop)).toHaveLength(0);
  });

  it("counts a gift line that carries the offer property and got a discount, not one without an allocation", async () => {
    const gift = await seedOffer(db, shopId);
    const free = await seedOffer(db, shopId);
    const line = (offerId: string, amount: string) => ({
      properties: [{ name: "_promo_engine_offer_id", value: offerId }],
      discount_allocations: [{ amount }],
    });
    await usage.recordOfferUsages(db, shopId, order({ line_items: [line(gift, "10.00"), line(free, "0.00")] }));
    const rows = await usageRows();
    expect(rows.map((r) => [r.offerId, r.source])).toEqual([[gift, "line"]]);
  });

  it("counts a title collision against every matching offer and warns", async () => {
    const a = await seedOffer(db, shopId, { publicTitle: "Same" });
    const b = await seedOffer(db, shopId, { publicTitle: "Same" });
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("Same")] }));
    expect((await usageRows()).map((r) => r.offerId).sort()).toEqual([a, b].sort());
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining("share a discount title"), expect.anything());
  });

  it("records a guest checkout that has a customer record, and nothing when the order has no customer", async () => {
    await seedOffer(db, shopId, { publicTitle: "Deal" });
    expect(await usage.recordOfferUsages(db, shopId, order({ customer: null, discount_applications: [auto("Deal")] }))).toBeNull();
    expect(await usageRows()).toHaveLength(0);
    await usage.recordOfferUsages(db, shopId, order({ customer: { id: 77 }, discount_applications: [auto("Deal")] }));
    expect((await usageRows())[0]!.customerGid).toBe("gid://shopify/Customer/77");
  });

  it("rejects a malformed payload at the boundary without writing", async () => {
    await seedOffer(db, shopId, { publicTitle: "Deal" });
    const bad = order({ discount_applications: "nope" });
    expect(await usage.recordOfferUsages(db, shopId, bad)).toBeNull();
    expect(await usageRows()).toHaveLength(0);
  });

  it("ignores a duplicate delivery: one row, no second pending mark", async () => {
    await seedOffer(db, shopId, { publicTitle: "Deal" });
    const o = order({ discount_applications: [auto("Deal")] });
    expect(await usage.recordOfferUsages(db, shopId, o)).toMatchObject({ inserted: 1 });
    await db.update(offerUsageSync).set({ pendingSince: null }).where(eq(offerUsageSync.shopId, shopId));
    expect(await usage.recordOfferUsages(db, shopId, o)).toMatchObject({ inserted: 0 });
    expect(await usageRows()).toHaveLength(1);
    expect((await syncRow())!.pendingSince).toBeNull();
  });
});

describe("metafield push", () => {
  const push = () => vi.fn<PushUsage>().mockResolvedValue(undefined);

  it("pushes compact per-offer counts recomputed from the table, then clears pending", async () => {
    const a = await seedOffer(db, shopId, { publicTitle: "A" });
    const b = await seedOffer(db, shopId, { publicTitle: "B" });
    await seedOffer(db, shopId, { publicTitle: "Gone", status: "archived" });
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("A"), auto("B")] }));
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("A"), auto("Gone")] }));
    const p = push();
    expect(await usage.syncCustomerUsageMetafield(db, shopId, CUSTOMER_GID, p)).toBe("synced");
    const call = p.mock.calls[0]![0];
    expect(call.customerGid).toBe(CUSTOMER_GID);
    expect(JSON.parse(call.value)).toEqual({ v: 1, u: { [a]: 2, [b]: 1 } });
    expect(call.value).not.toContain(" ");
    const row = (await syncRow())!;
    expect(row.pendingSince).toBeNull();
    expect(row.syncedAt).not.toBeNull();
    expect(await usage.syncCustomerUsageMetafield(db, shopId, CUSTOMER_GID, p)).toBe("skipped");
  });

  it("targets the app-owned customer metafield", async () => {
    await seedOffer(db, shopId, { publicTitle: "A" });
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("A")] }));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { metafieldsSet: { userErrors: [] } } }), headers: new Headers() });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await usage.pushUsageMetafield({ shopDomain: "s.myshopify.com", accessToken: "t", customerGid: CUSTOMER_GID, value: '{"v":1,"u":{}}' });
    } finally {
      vi.unstubAllGlobals();
    }
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.variables.metafields[0]).toEqual({
      ownerId: CUSTOMER_GID,
      namespace: "$app:promo_engine",
      key: "usage",
      type: "json",
      value: '{"v":1,"u":{}}',
    });
  });

  it("stays pending and counts an attempt when the push fails, then clears on retry", async () => {
    await seedOffer(db, shopId, { publicTitle: "A" });
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("A")] }));
    const failing = vi.fn<PushUsage>().mockRejectedValue(new Error("boom"));
    expect(await usage.syncCustomerUsageMetafield(db, shopId, CUSTOMER_GID, failing)).toBe("failed");
    expect(await syncRow()).toMatchObject({ attempts: 1 });
    expect((await syncRow())!.pendingSince).not.toBeNull();

    const drained = await usage.drainUsageSync(db, push());
    expect(drained).toMatchObject({ synced: 1, failed: 0 });
    expect((await syncRow())!.pendingSince).toBeNull();
  });

  it("does not clear pending when an order lands during the push", async () => {
    await seedOffer(db, shopId, { publicTitle: "A" });
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("A")] }));
    const racing = vi.fn<PushUsage>().mockImplementation(async () => {
      await db.update(offerUsageSync).set({ pendingSince: new Date(Date.now() + 5_000) }).where(eq(offerUsageSync.shopId, shopId));
    });
    await usage.syncCustomerUsageMetafield(db, shopId, CUSTOMER_GID, racing);
    expect((await syncRow())!.pendingSince).not.toBeNull();
  });

  it("stops retrying after the attempt bound and batches the drain", async () => {
    await seedOffer(db, shopId, { publicTitle: "A" });
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("A")] }));
    await db.update(offerUsageSync).set({ attempts: usage.USAGE_SYNC_MAX_ATTEMPTS }).where(eq(offerUsageSync.shopId, shopId));
    const p = push();
    expect(await usage.drainUsageSync(db, p)).toMatchObject({ synced: 0 });
    expect(p).not.toHaveBeenCalled();
  });

  it("degrades without the write_customers scope: rows kept, still pending, one warning per shop", async () => {
    await seedOffer(db, shopId, { publicTitle: "A" });
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("A")] }));
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("A")] }));
    const denied = vi.fn<PushUsage>().mockRejectedValue(new Error("Shopify GraphQL errors: Access denied for metafieldsSet field."));
    expect(await usage.syncCustomerUsageMetafield(db, shopId, CUSTOMER_GID, denied)).toBe("missing-scope");
    expect(await usage.syncCustomerUsageMetafield(db, shopId, CUSTOMER_GID, denied)).toBe("missing-scope");
    expect(await usageRows()).toHaveLength(2);
    expect(await syncRow()).toMatchObject({ attempts: 0 });
    expect((await syncRow())!.pendingSince).not.toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("skips the rest of a shop's customers in a drain once its scope is missing", async () => {
    await seedOffer(db, shopId, { publicTitle: "A" });
    for (const id of [1, 2, 3]) {
      await usage.recordOfferUsages(db, shopId, order({ customer: { id }, discount_applications: [auto("A")] }));
    }
    const denied = vi.fn<PushUsage>().mockRejectedValue(new Error("Access denied"));
    expect(await usage.drainUsageSync(db, denied)).toMatchObject({ synced: 0, blockedShops: 1 });
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("encodeUsageValue stays under the Function metafield size cap", () => {
    const counts = new Map(Array.from({ length: 400 }, (_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, i + 1]));
    const value = usage.encodeUsageValue(counts);
    expect(value.length).toBeLessThanOrEqual(9_000);
    expect(JSON.parse(value).u["00000000-0000-4000-8000-000000000399"]).toBe(400);
  });
});

describe("handleOrderPaid", () => {
  it("records usage synchronously and defers the metafield push", async () => {
    await seedOffer(db, shopId, { publicTitle: "Deal" });
    const deferred: Array<Promise<void>> = [];
    const p = vi.fn<PushUsage>().mockResolvedValue(undefined);
    await handleOrderPaid(db, shopId, "s.myshopify.com", order({ discount_applications: [auto("Deal")] }), {
      defer: (w) => deferred.push(w),
      push: p,
    });
    expect(await usageRows()).toHaveLength(1);
    expect(p).not.toHaveBeenCalled();
    await Promise.all(deferred);
    expect(p).toHaveBeenCalledTimes(1);
    expect((await syncRow())!.pendingSince).toBeNull();
  });

  it("does not defer anything for a duplicate delivery or a guest order", async () => {
    await seedOffer(db, shopId, { publicTitle: "Deal" });
    const o = order({ discount_applications: [auto("Deal")] });
    const deferred: Array<Promise<void>> = [];
    const deps = { defer: (w: Promise<void>) => deferred.push(w), push: vi.fn<PushUsage>().mockResolvedValue(undefined) };
    await handleOrderPaid(db, shopId, "s.myshopify.com", o, deps);
    await handleOrderPaid(db, shopId, "s.myshopify.com", o, deps);
    await handleOrderPaid(db, shopId, "s.myshopify.com", order({ customer: null, discount_applications: [auto("Deal")] }), deps);
    expect(deferred).toHaveLength(1);
    expect(await usageRows()).toHaveLength(1);
  });
});

describe("GDPR", () => {
  it("customers/redact deletes that customer's usage and sync rows only", async () => {
    await seedOffer(db, shopId, { publicTitle: "Deal" });
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("Deal")] }));
    await usage.recordOfferUsages(db, shopId, order({ customer: { id: 99 }, discount_applications: [auto("Deal")] }));
    await handleCustomersRedact(db, shopId, "s.myshopify.com", { customer: { id: CUSTOMER } });
    expect((await usageRows()).map((r) => r.customerGid)).toEqual(["gid://shopify/Customer/99"]);
    expect(await syncRow()).toBeUndefined();
    expect(await db.select().from(offerUsageSync).where(eq(offerUsageSync.shopId, shopId))).toHaveLength(1);
  });

  it("shop deletion cascades to usage and sync rows", async () => {
    const offerId = await seedOffer(db, shopId, { publicTitle: "Deal" });
    await usage.recordOfferUsages(db, shopId, order({ discount_applications: [auto("Deal")] }));
    await db.delete(shops).where(eq(shops.id, shopId));
    expect(await usageRows()).toHaveLength(0);
    expect(await db.select().from(offerUsageSync).where(eq(offerUsageSync.shopId, shopId))).toHaveLength(0);
    expect(await db.select().from(offers).where(eq(offers.id, offerId))).toHaveLength(0);
  });
});
