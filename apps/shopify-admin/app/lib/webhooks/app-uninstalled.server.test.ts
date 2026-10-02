import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appSettings, offers, shops, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../test-support/pglite-db.js";

const invalidateShopCache = vi.fn(async () => undefined);
const invalidateOfferDefinitions = vi.fn(async () => undefined);
vi.mock("../proxy-shop.server.js", () => ({ invalidateShopCache: (...args: unknown[]) => invalidateShopCache(...(args as [])) }));
vi.mock("../offer-definitions.server.js", () => ({
  invalidateOfferDefinitions: (...args: unknown[]) => invalidateOfferDefinitions(...(args as [])),
}));

const { handleAppUninstalled } = await import("./app-uninstalled.server.js");
const { getRestorableOffers, UNINSTALL_ARCHIVE_SETTING } = await import("../restore-archived-offers.server.js");

let db: Db;
let close: () => Promise<void>;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  invalidateShopCache.mockClear();
  invalidateOfferDefinitions.mockClear();
});

function fakeSessionStorage(sessions: Array<{ id: string }> = []) {
  return {
    findSessionsByShop: vi.fn().mockResolvedValue(sessions),
    deleteSessions: vi.fn().mockResolvedValue(true),
  };
}

async function newShop() {
  counter += 1;
  const domain = `uninstall-${counter}.myshopify.com`;
  const shopId = await seedShop(db, domain);
  await db
    .update(shops)
    .set({ discountId: "gid://shopify/DiscountAutomaticNode/1", deliveryDiscountId: "gid://shopify/DiscountAutomaticNode/2" })
    .where(eq(shops.id, shopId));
  return { shopId, domain };
}

const statusOf = async (offerId: string) =>
  (await db.select({ status: offers.status }).from(offers).where(eq(offers.id, offerId)))[0]!.status;
const setting = async (shopId: string, key: string) =>
  (await db.select().from(appSettings).where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, key))))[0];

describe("handleAppUninstalled", () => {
  it("archives the shop's active offers, purges sessions, and clears the shop's discount ids", async () => {
    const { shopId, domain } = await newShop();
    const active = await seedOffer(db, shopId, { status: "active" });
    const paused = await seedOffer(db, shopId, { status: "paused" });
    const sessionStorage = fakeSessionStorage([{ id: "sess-1" }, { id: "sess-2" }]);

    await handleAppUninstalled(db, sessionStorage, domain, null);

    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    expect(shop).toMatchObject({ isActive: false, discountId: null, deliveryDiscountId: null });
    expect(shop!.uninstalledAt).toBeInstanceOf(Date);
    expect(await statusOf(active)).toBe("archived");
    expect(await statusOf(paused)).toBe("paused");
    expect(sessionStorage.deleteSessions).toHaveBeenCalledWith(["sess-1", "sess-2"]);
  });

  it("remembers exactly the offers it archived so a reinstall can restore them", async () => {
    const { shopId, domain } = await newShop();
    const active = await seedOffer(db, shopId, { status: "active" });
    const merchantArchived = await seedOffer(db, shopId, { status: "archived" });

    await handleAppUninstalled(db, fakeSessionStorage(), domain, null);

    const stored = JSON.parse((await setting(shopId, UNINSTALL_ARCHIVE_SETTING))!.value) as { offerIds: string[] };
    expect(stored.offerIds).toEqual([active]);
    expect(stored.offerIds).not.toContain(merchantArchived);
    expect(await getRestorableOffers(db, shopId)).toEqual({ count: 1 });
  });

  it("keeps the restore list when Shopify retries the webhook after the offers are already archived", async () => {
    const { shopId, domain } = await newShop();
    await seedOffer(db, shopId, { status: "active" });

    await handleAppUninstalled(db, fakeSessionStorage(), domain, null);
    await handleAppUninstalled(db, fakeSessionStorage(), domain, null);

    expect(await getRestorableOffers(db, shopId)).toEqual({ count: 1 });
  });

  it("forgets the discount node ids and the publish manifest, which died with the app", async () => {
    const { shopId, domain } = await newShop();
    await db.insert(appSettings).values([
      { shopId, key: "code_discount_node.id", value: '"gid://shopify/DiscountAutomaticNode/9"' },
      { shopId, key: "coded_shipping_pool.ids", value: '["gid://shopify/DiscountAutomaticNode/8"]' },
      { shopId, key: "publish_manifest.v1", value: "{}" },
      { shopId, key: "code_backend_b.enabled", value: "true" },
    ]);

    await handleAppUninstalled(db, fakeSessionStorage(), domain, null);

    expect(await setting(shopId, "code_discount_node.id")).toBeUndefined();
    expect(await setting(shopId, "coded_shipping_pool.ids")).toBeUndefined();
    expect(await setting(shopId, "publish_manifest.v1")).toBeUndefined();
    // A merchant preference is not a Shopify id: it stays.
    expect(await setting(shopId, "code_backend_b.enabled")).toBeDefined();
  });

  it("drops the proxy's cached shop row and offer definitions", async () => {
    const { shopId, domain } = await newShop();
    await handleAppUninstalled(db, fakeSessionStorage(), domain, null);
    expect(invalidateShopCache).toHaveBeenCalledWith(domain);
    expect(invalidateOfferDefinitions).toHaveBeenCalledWith(shopId);
  });

  it("does not purge sessions when the shop has none", async () => {
    const { domain } = await newShop();
    const sessionStorage = fakeSessionStorage([]);
    await handleAppUninstalled(db, sessionStorage, domain, null);
    expect(sessionStorage.deleteSessions).not.toHaveBeenCalled();
  });

  // Shopify can deliver/retry APP_UNINSTALLED after a faster reinstall already bumped installedAt:
  // trust the reinstall over the stale uninstall.
  it("skips all processing when the shop was reinstalled after the webhook was triggered", async () => {
    const { shopId, domain } = await newShop();
    const offerId = await seedOffer(db, shopId, { status: "active" });
    await db.update(shops).set({ installedAt: new Date("2026-01-01T00:05:00.000Z") }).where(eq(shops.id, shopId));
    const sessionStorage = fakeSessionStorage([{ id: "sess-1" }]);

    await handleAppUninstalled(db, sessionStorage, domain, "2026-01-01T00:00:00.000Z");

    const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
    expect(shop).toMatchObject({ isActive: true, discountId: "gid://shopify/DiscountAutomaticNode/1" });
    expect(await statusOf(offerId)).toBe("active");
    expect(sessionStorage.findSessionsByShop).not.toHaveBeenCalled();
    expect(await getRestorableOffers(db, shopId)).toEqual({ count: 0 });
  });

  it("still processes when installedAt is before triggeredAt: no race", async () => {
    const { shopId, domain } = await newShop();
    const offerId = await seedOffer(db, shopId, { status: "active" });
    await db.update(shops).set({ installedAt: new Date("2026-01-01T00:00:00.000Z") }).where(eq(shops.id, shopId));

    await handleAppUninstalled(db, fakeSessionStorage(), domain, "2026-01-01T00:05:00.000Z");

    expect(await statusOf(offerId)).toBe("archived");
  });

  it("still processes (fail-open) when triggeredAt is an unparsable date", async () => {
    const { shopId, domain } = await newShop();
    const offerId = await seedOffer(db, shopId, { status: "active" });
    await handleAppUninstalled(db, fakeSessionStorage(), domain, "not-a-date");
    expect(await statusOf(offerId)).toBe("archived");
    expect((await db.select().from(shops).where(eq(shops.id, shopId)))[0]!.isActive).toBe(false);
  });

  it("touches nothing when no shop matches", async () => {
    const sessionStorage = fakeSessionStorage([]);
    await expect(handleAppUninstalled(db, sessionStorage, "nobody.myshopify.com", null)).resolves.toBeUndefined();
    expect(invalidateOfferDefinitions).not.toHaveBeenCalled();
  });
});
