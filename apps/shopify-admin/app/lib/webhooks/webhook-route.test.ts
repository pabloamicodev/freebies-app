import type * as PromoDb from "@promo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { catalogRefreshQueue, discountCodes, productCache, shops, variantCache, type Db } from "@promo/db";
import { createTestDb, seedOffer, seedShop } from "../test-support/pglite-db.js";

let currentDb: Db | null = null;
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => currentDb,
}));

let incoming: { topic: string; shop: string; payload: unknown } = { topic: "", shop: "", payload: {} };
vi.mock("../../shopify.server.js", () => ({
  authenticate: { webhook: async () => incoming },
  sessionStorage: { findSessionsByShop: async () => [], deleteSessions: async () => true },
}));

const deferred: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({ waitUntil: (promise: Promise<unknown>) => void deferred.push(promise) }));

const shopifyGraphQLMock = vi.fn();
vi.mock("../shopify-fetch.server.js", () => ({ shopifyGraphQL: (...args: unknown[]) => shopifyGraphQLMock(...args) }));
vi.mock("../token-crypto.server.js", () => ({ decryptToken: async () => "token", encryptToken: async (v: string) => v }));
const refreshProduct = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
vi.mock("../sync/gift-stock-reconcile.server.js", () => ({
  refreshProductVariantsFromAdmin: (...args: unknown[]) => refreshProduct(...args),
}));
const publishShopConfig = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null);
vi.mock("../offer-publish-flow.server.js", () => ({ publishShopConfig: (...args: unknown[]) => publishShopConfig(...args) }));
vi.mock("../sync/offer-publisher.server.js", () => ({ publishOffersForShop: vi.fn(async () => "published") }));
vi.mock("../offer-definitions.server.js", () => ({ invalidateOfferDefinitions: async () => undefined }));
vi.mock("../proxy-shop.server.js", () => ({ invalidateShopCache: async () => undefined }));
vi.mock("../publish-pending.server.js", () => ({ markPublishPending: async () => undefined }));
vi.mock("@sentry/node", () => ({ captureException: vi.fn(), captureMessage: vi.fn(), flush: async () => true }));

const { action } = await import("../../routes/webhooks.$.js");

let db: Db;
let close: () => Promise<void>;
let counter = 0;
let shopId: string;
let domain: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  currentDb = db;
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  counter += 1;
  domain = `route-${counter}.myshopify.com`;
  shopId = await seedShop(db, domain);
  deferred.length = 0;
  shopifyGraphQLMock.mockReset();
  refreshProduct.mockClear();
  publishShopConfig.mockClear();
});

async function deliver(topic: string, payload: unknown): Promise<Response> {
  incoming = { topic, shop: domain, payload };
  return action({
    request: new Request("https://app.example/webhooks", {
      method: "POST",
      headers: { "x-shopify-webhook-id": `wh-${counter}-${Math.random()}` },
    }),
    params: {},
    context: {},
  } as never);
}
const settleDeferred = async () => {
  await Promise.all(deferred.splice(0));
};
const queued = () => db.select().from(catalogRefreshQueue).where(eq(catalogRefreshQueue.shopId, shopId));

async function seedVariant(n: number) {
  await db.insert(variantCache).values({
    shopId,
    productGid: `gid://shopify/Product/${n}`,
    variantGid: `gid://shopify/ProductVariant/${n}`,
    title: "v",
    price: "10",
    currencyCode: "USD",
    inventoryQuantity: 1,
    availableForSale: true,
    raw: {},
  });
}

describe("inventory_levels/update stays inside Shopify's 5 second window", () => {
  it("answers 200 without calling Shopify, and queues the item", async () => {
    const response = await deliver("INVENTORY_LEVELS_UPDATE", { inventory_item_id: 111, location_id: 1, available: 4 });

    expect(response.status).toBe(200);
    expect(shopifyGraphQLMock).not.toHaveBeenCalled();
    expect((await queued()).map((row) => [row.kind, row.ref])).toEqual([["inventory_item", "gid://shopify/InventoryItem/111"]]);
    await settleDeferred();
  });

  it("refreshes the variant afterwards, in one batched read asking for at most 5 variants", async () => {
    await seedVariant(7);
    shopifyGraphQLMock.mockResolvedValue({
      nodes: [
        {
          id: "gid://shopify/InventoryItem/111",
          tracked: true,
          variants: { nodes: [{ id: "gid://shopify/ProductVariant/7", inventoryQuantity: 0, inventoryPolicy: "DENY", availableForSale: false }] },
        },
      ],
    });

    await deliver("INVENTORY_LEVELS_UPDATE", { inventory_item_id: 111, location_id: 1, available: 0 });
    await settleDeferred();

    expect(shopifyGraphQLMock).toHaveBeenCalledTimes(1);
    expect((shopifyGraphQLMock.mock.calls[0]![0] as { query: string }).query).toContain("variants(first: 5)");
    const [row] = await db.select().from(variantCache).where(eq(variantCache.shopId, shopId));
    expect(row).toMatchObject({ inventoryQuantity: 0, availableForSale: false });
    expect(await queued()).toEqual([]);
  });

  it("coalesces a burst of events for the same item into one Shopify read", async () => {
    await seedVariant(7);
    shopifyGraphQLMock.mockResolvedValue({ nodes: [] });

    for (let i = 0; i < 5; i += 1) {
      expect((await deliver("INVENTORY_LEVELS_UPDATE", { inventory_item_id: 111, location_id: 1, available: i })).status).toBe(200);
    }
    expect(await queued()).toHaveLength(1);
    await settleDeferred();

    expect(shopifyGraphQLMock).toHaveBeenCalledTimes(1);
  });

  it("acknowledges an event for a shop it doesn't know", async () => {
    domain = "unknown.myshopify.com";
    expect((await deliver("INVENTORY_LEVELS_UPDATE", { inventory_item_id: 1, location_id: 1, available: 1 })).status).toBe(200);
    expect(deferred).toHaveLength(0);
  });
});

describe("products/update stays inside the window too", () => {
  const product = {
    id: 42,
    title: "Mug",
    handle: "mug",
    vendor: "V",
    product_type: "T",
    tags: "a, b",
    status: "active",
    admin_graphql_api_id: "gid://shopify/Product/42",
    variants: [
      {
        id: 420,
        admin_graphql_api_id: "gid://shopify/ProductVariant/420",
        sku: "S",
        title: "Default",
        price: "9.00",
        compare_at_price: null,
        inventory_quantity: 5,
        inventory_policy: "deny",
      },
    ],
  };

  it("writes the cache from the payload, queues the Admin API refresh, and does not call Shopify inline", async () => {
    const response = await deliver("PRODUCTS_UPDATE", product);

    expect(response.status).toBe(200);
    expect(shopifyGraphQLMock).not.toHaveBeenCalled();
    expect(refreshProduct).not.toHaveBeenCalled();
    expect(await db.select().from(productCache).where(eq(productCache.shopId, shopId))).toHaveLength(1);
    expect(await db.select().from(variantCache).where(eq(variantCache.shopId, shopId))).toHaveLength(1);
    expect((await queued()).map((row) => [row.kind, row.ref])).toEqual([["product", "gid://shopify/Product/42"]]);

    await settleDeferred();
    expect(refreshProduct).toHaveBeenCalledWith(shopId, domain, "token", "gid://shopify/Product/42");
    expect(await queued()).toEqual([]);
  });

  it("coalesces repeated edits of one product into one refresh", async () => {
    await deliver("PRODUCTS_UPDATE", product);
    await deliver("PRODUCTS_UPDATE", { ...product, title: "Mug 2" });
    await deliver("PRODUCTS_UPDATE", { ...product, title: "Mug 3" });
    await settleDeferred();
    expect(refreshProduct).toHaveBeenCalledTimes(1);
  });
});

describe("customers/update is gone", () => {
  it("is acknowledged and ignored, like any unsubscribed topic", async () => {
    const response = await deliver("CUSTOMERS_UPDATE", { id: 1 });
    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(0);
  });
});

describe("orders/paid", () => {
  it("records the redemption in the response and republishes after it", async () => {
    const offerId = await seedOffer(db, shopId, { requiresCode: true });
    await db.insert(discountCodes).values({ shopId, offerId, code: "ROUTE-ONCE", usageLimit: 1, shopifySyncedAt: new Date() });

    const response = await deliver("ORDERS_PAID", {
      id: 9001,
      admin_graphql_api_id: "gid://shopify/Order/9001",
      cart_token: null,
      line_items: [],
      note_attributes: [],
      discount_codes: [{ code: "route-once" }],
    });

    expect(response.status).toBe(200);
    const [code] = await db.select().from(discountCodes).where(eq(discountCodes.shopId, shopId));
    expect(code).toMatchObject({ usageCount: 1, status: "exhausted" });
    await settleDeferred();
    expect(publishShopConfig).toHaveBeenCalledWith(shopId, domain);
  });
});

describe("shop/redact", () => {
  it("leaves an active (reinstalled) shop alone", async () => {
    const offerId = await seedOffer(db, shopId);
    const response = await deliver("SHOP_REDACT", {});

    expect(response.status).toBe(200);
    expect(await db.select().from(shops).where(eq(shops.id, shopId))).toHaveLength(1);
    expect(offerId).toBeTruthy();
  });

  it("redacts a shop that is still uninstalled", async () => {
    await db
      .update(shops)
      .set({ isActive: false, uninstalledAt: new Date("2026-01-01T00:00:00Z"), installedAt: new Date("2025-12-01T00:00:00Z") })
      .where(eq(shops.id, shopId));
    await deliver("SHOP_REDACT", {});
    expect(await db.select().from(shops).where(eq(shops.id, shopId))).toEqual([]);
  });
});
