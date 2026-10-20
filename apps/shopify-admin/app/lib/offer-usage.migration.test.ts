import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { offerCustomerUsages, offerUsageSync, shops, offers, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "./test-support/pglite-db.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const usage = (shopId: string, offerId: string, orderGid: string, customerGid = "gid://shopify/Customer/1") => ({
  shopId, offerId, orderGid, customerGid, source: "title",
});

const upsert = (v: ReturnType<typeof usage>) =>
  db.insert(offerCustomerUsages).values(v).onConflictDoNothing().returning({ id: offerCustomerUsages.id });

describe("0026_offer_customer_usages", () => {
  it("applies with all migrations (tables exist and are empty)", async () => {
    expect(await db.select().from(offerCustomerUsages)).toEqual([]);
    expect(await db.select().from(offerUsageSync)).toEqual([]);
  });

  it("is idempotent per (shop, order, offer)", async () => {
    const shopId = await seedShop(db, "usage-idem.myshopify.com");
    const offerA = await seedOffer(db, shopId);
    const offerB = await seedOffer(db, shopId);
    expect(await upsert(usage(shopId, offerA, "gid://shopify/Order/1"))).toHaveLength(1);
    expect(await upsert(usage(shopId, offerA, "gid://shopify/Order/1"))).toHaveLength(0);
    expect(await upsert(usage(shopId, offerB, "gid://shopify/Order/1"))).toHaveLength(1);
    expect(await upsert(usage(shopId, offerA, "gid://shopify/Order/2"))).toHaveLength(1);
    const rows = await db.select().from(offerCustomerUsages).where(eq(offerCustomerUsages.shopId, shopId));
    expect(rows).toHaveLength(3);
  });

  it("isolates shops, including the same order and customer gids", async () => {
    const shopA = await seedShop(db, "usage-a.myshopify.com");
    const shopB = await seedShop(db, "usage-b.myshopify.com");
    const offerA = await seedOffer(db, shopA);
    const offerB = await seedOffer(db, shopB);
    expect(await upsert(usage(shopA, offerA, "gid://shopify/Order/9"))).toHaveLength(1);
    expect(await upsert(usage(shopB, offerB, "gid://shopify/Order/9"))).toHaveLength(1);
    const forB = await db.select().from(offerCustomerUsages).where(eq(offerCustomerUsages.shopId, shopB));
    expect(forB.map((r) => r.offerId)).toEqual([offerB]);
  });

  it("rejects a usage row that points at a missing shop", async () => {
    const shopId = await seedShop(db, "usage-fk.myshopify.com");
    const offerId = await seedOffer(db, shopId);
    await expect(
      db.insert(offerCustomerUsages).values(usage("00000000-0000-0000-0000-000000000000", offerId, "gid://shopify/Order/1")),
    ).rejects.toThrow();
  });

  it("cascades on shop delete and on offer delete", async () => {
    const shopId = await seedShop(db, "usage-cascade.myshopify.com");
    const keep = await seedOffer(db, shopId);
    const drop = await seedOffer(db, shopId);
    await upsert(usage(shopId, keep, "gid://shopify/Order/1"));
    await upsert(usage(shopId, drop, "gid://shopify/Order/2"));
    await db.insert(offerUsageSync).values({ shopId, customerGid: "gid://shopify/Customer/1", pendingSince: new Date() });

    await db.delete(offers).where(eq(offers.id, drop));
    expect((await db.select().from(offerCustomerUsages).where(eq(offerCustomerUsages.shopId, shopId))).map((r) => r.offerId)).toEqual([keep]);

    await db.delete(shops).where(eq(shops.id, shopId));
    expect(await db.select().from(offerCustomerUsages).where(eq(offerCustomerUsages.shopId, shopId))).toEqual([]);
    expect(await db.select().from(offerUsageSync).where(eq(offerUsageSync.shopId, shopId))).toEqual([]);
  });

  it("lets GDPR redact delete one customer's rows only", async () => {
    const shopId = await seedShop(db, "usage-gdpr.myshopify.com");
    const offerId = await seedOffer(db, shopId);
    const gone = "gid://shopify/Customer/10";
    const stays = "gid://shopify/Customer/11";
    await upsert(usage(shopId, offerId, "gid://shopify/Order/1", gone));
    await upsert(usage(shopId, offerId, "gid://shopify/Order/2", gone));
    await upsert(usage(shopId, offerId, "gid://shopify/Order/3", stays));
    await db.insert(offerUsageSync).values([{ shopId, customerGid: gone }, { shopId, customerGid: stays }]);

    await db.delete(offerCustomerUsages).where(and(eq(offerCustomerUsages.shopId, shopId), eq(offerCustomerUsages.customerGid, gone)));
    await db.delete(offerUsageSync).where(and(eq(offerUsageSync.shopId, shopId), eq(offerUsageSync.customerGid, gone)));

    const rows = await db.select().from(offerCustomerUsages).where(eq(offerCustomerUsages.shopId, shopId));
    expect(rows.map((r) => r.customerGid)).toEqual([stays]);
    expect((await db.select().from(offerUsageSync).where(eq(offerUsageSync.shopId, shopId))).map((r) => r.customerGid)).toEqual([stays]);
  });

  it("keeps one sync row per (shop, customer) with attempts defaulting to 0", async () => {
    const shopId = await seedShop(db, "usage-sync.myshopify.com");
    const customerGid = "gid://shopify/Customer/5";
    await db.insert(offerUsageSync).values({ shopId, customerGid });
    await expect(db.insert(offerUsageSync).values({ shopId, customerGid })).rejects.toThrow();
    const [row] = await db.select().from(offerUsageSync).where(eq(offerUsageSync.shopId, shopId));
    expect(row).toMatchObject({ attempts: 0, pendingSince: null, syncedAt: null });
  });
});
