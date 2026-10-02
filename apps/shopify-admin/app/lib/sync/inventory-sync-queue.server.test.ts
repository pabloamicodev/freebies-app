import type * as PromoDb from "@promo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { catalogRefreshQueue, shops, variantCache, type Db } from "@promo/db";
import { createTestDb, seedShop } from "../test-support/pglite-db.js";

let currentDb: Db | null = null;
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => currentDb,
}));
const shopifyGraphQLMock = vi.fn();
vi.mock("../shopify-fetch.server.js", () => ({ shopifyGraphQL: (...args: unknown[]) => shopifyGraphQLMock(...args) }));
vi.mock("../token-crypto.server.js", () => ({ decryptToken: async () => "token" }));
const refreshProduct = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
vi.mock("./gift-stock-reconcile.server.js", () => ({
  refreshProductVariantsFromAdmin: (...args: unknown[]) => refreshProduct(...args),
}));
const captureException = vi.fn();
vi.mock("@sentry/node", () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

const {
  REFRESH_LEASE_MS,
  REFRESH_MAX_ATTEMPTS,
  claimCatalogRefreshBatch,
  coalescedDrain,
  drainCatalogRefreshQueue,
  enqueueCatalogRefresh,
  loadInventoryItemsBatch,
} = await import("./inventory-sync-queue.server.js");

let db: Db;
let close: () => Promise<void>;
let shopId: string;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  currentDb = db;
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  counter += 1;
  shopId = await seedShop(db, `queue-${counter}.myshopify.com`);
  shopifyGraphQLMock.mockReset();
  refreshProduct.mockClear();
  captureException.mockClear();
});

const item = (n: number) => `gid://shopify/InventoryItem/${n}`;
const variant = (n: number) => `gid://shopify/ProductVariant/${shopId.slice(0, 4)}-${n}`;
const queueRows = () => db.select().from(catalogRefreshQueue).where(eq(catalogRefreshQueue.shopId, shopId));

async function seedVariant(n: number, quantity = 1) {
  await db.insert(variantCache).values({
    shopId,
    productGid: `gid://shopify/Product/${n}`,
    variantGid: variant(n),
    title: `v${n}`,
    price: "10",
    currencyCode: "USD",
    inventoryQuantity: quantity,
    availableForSale: true,
    raw: {},
  });
}

const nodesFor = (ids: number[], quantity = 7) => ({
  nodes: ids.map((n) => ({
    id: item(n),
    tracked: true,
    variants: {
      nodes: [{ id: variant(n), inventoryQuantity: quantity, inventoryPolicy: "DENY", availableForSale: quantity > 0 }],
    },
  })),
});

describe("enqueueCatalogRefresh", () => {
  it("coalesces a burst for the same item into one row and bumps its request time", async () => {
    for (let i = 0; i < 5; i += 1) await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }], db);
    const rows = await queueRows();
    expect(rows).toHaveLength(1);

    const first = rows[0]!.requestedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }], db);
    expect((await queueRows())[0]!.requestedAt.getTime()).toBeGreaterThan(first.getTime());
  });

  it("keeps items of different kinds and refs apart, and does nothing for an empty list", async () => {
    await enqueueCatalogRefresh(shopId, [], db);
    await enqueueCatalogRefresh(shopId, [
      { kind: "inventory_item", ref: item(1) },
      { kind: "inventory_item", ref: item(2) },
      { kind: "product", ref: "gid://shopify/Product/1" },
    ], db);
    expect(await queueRows()).toHaveLength(3);
  });
});

describe("claimCatalogRefreshBatch", () => {
  it("leases what it takes, so a concurrent drain doesn't take the same rows", async () => {
    await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }, { kind: "inventory_item", ref: item(2) }], db);

    const first = await claimCatalogRefreshBatch({ shopId }, db);
    const second = await claimCatalogRefreshBatch({ shopId }, db);

    expect(first.rows).toHaveLength(2);
    expect(first.rows.every((row) => row.attempts === 1)).toBe(true);
    expect(second.rows).toHaveLength(0);
  });

  it("hands a row out again once its lease has passed (crashed worker)", async () => {
    await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }], db);
    const { claimedAt } = await claimCatalogRefreshBatch({ shopId }, db);

    const later = new Date(claimedAt.getTime() + REFRESH_LEASE_MS + 1);
    const again = await claimCatalogRefreshBatch({ shopId, now: later }, db);
    expect(again.rows).toHaveLength(1);
    expect(again.rows[0]!.attempts).toBe(2);
  });

  it("respects the limit and the shop filter", async () => {
    const other = await seedShop(db, `queue-other-${counter}.myshopify.com`);
    await enqueueCatalogRefresh(shopId, [1, 2, 3].map((n) => ({ kind: "inventory_item" as const, ref: item(n) })), db);
    await enqueueCatalogRefresh(other, [{ kind: "inventory_item", ref: item(9) }], db);

    const batch = await claimCatalogRefreshBatch({ shopId, limit: 2 }, db);
    expect(batch.rows).toHaveLength(2);
    expect(batch.rows.every((row) => row.shopId === shopId)).toBe(true);
  });
});

describe("drainCatalogRefreshQueue", () => {
  it("refreshes many inventory items with ONE batched read, asking for at most 5 variants each", async () => {
    for (const n of [1, 2, 3]) await seedVariant(n, 1);
    await enqueueCatalogRefresh(shopId, [1, 2, 3].map((n) => ({ kind: "inventory_item" as const, ref: item(n) })), db);
    shopifyGraphQLMock.mockResolvedValue(nodesFor([1, 2, 3], 42));

    const result = await drainCatalogRefreshQueue({ shopId }, db);

    expect(result).toEqual({ claimed: 3, completed: 3, failed: 0 });
    expect(shopifyGraphQLMock).toHaveBeenCalledTimes(1);
    const sent = shopifyGraphQLMock.mock.calls[0]![0] as { query: string; variables: { ids: string[] } };
    expect(sent.query).toContain("variants(first: 5)");
    expect(sent.query).not.toContain("250");
    expect(sent.variables.ids).toEqual([item(1), item(2), item(3)]);
    const rows = await db.select().from(variantCache).where(eq(variantCache.shopId, shopId));
    expect(rows.every((row) => row.inventoryQuantity === 42 && row.inventoryTracked === true)).toBe(true);
    expect(await queueRows()).toEqual([]);
  });

  it("uses the variant's total quantity from Shopify and marks a sold-out variant unavailable", async () => {
    await seedVariant(1, 10);
    await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }], db);
    shopifyGraphQLMock.mockResolvedValue(nodesFor([1], 0));

    await drainCatalogRefreshQueue({ shopId }, db);

    const [row] = await db.select().from(variantCache).where(eq(variantCache.variantGid, variant(1)));
    expect(row).toMatchObject({ inventoryQuantity: 0, availableForSale: false });
  });

  it("splits a big queue into batches of 50 items", async () => {
    await enqueueCatalogRefresh(
      shopId,
      Array.from({ length: 120 }, (_, i) => ({ kind: "inventory_item" as const, ref: item(i + 1) })),
      db,
    );
    shopifyGraphQLMock.mockResolvedValue({ nodes: [] });

    const result = await drainCatalogRefreshQueue({ shopId, limit: 200 }, db);

    expect(result.completed).toBe(120);
    expect(shopifyGraphQLMock.mock.calls.map(([args]) => (args as { variables: { ids: string[] } }).variables.ids.length)).toEqual([50, 50, 20]);
  });

  it("does not delete a row that was re-requested while it was being processed", async () => {
    await seedVariant(1);
    await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }], db);
    shopifyGraphQLMock.mockImplementation(async () => {
      // A newer inventory event for the same item arrives mid-read.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }], db);
      return nodesFor([1], 3);
    });

    await drainCatalogRefreshQueue({ shopId, maxRuntimeMs: 1 }, db);

    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ leasedUntil: null, attempts: 0 });
  });

  it("keeps a failed row, leases it out with backoff, and records the error", async () => {
    await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }], db);
    shopifyGraphQLMock.mockRejectedValue(new Error("Shopify 503"));

    const result = await drainCatalogRefreshQueue({ shopId }, db);

    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1 });
    const [row] = await queueRows();
    expect(row).toMatchObject({ attempts: 1, lastError: "Shopify 503" });
    expect(row!.leasedUntil!.getTime()).toBeGreaterThan(Date.now() + 20_000);
    // Backed off: an immediate second drain leaves it alone.
    expect((await drainCatalogRefreshQueue({ shopId }, db)).claimed).toBe(0);
  });

  it("gives up after the maximum number of attempts and tells Sentry", async () => {
    await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }], db);
    await db
      .update(catalogRefreshQueue)
      .set({ attempts: REFRESH_MAX_ATTEMPTS - 1 })
      .where(eq(catalogRefreshQueue.shopId, shopId));
    shopifyGraphQLMock.mockRejectedValue(new Error("still down"));

    await drainCatalogRefreshQueue({ shopId }, db);

    expect(await queueRows()).toEqual([]);
    expect(captureException).toHaveBeenCalled();
  });

  it("refreshes a product through the product reconcile, one at a time", async () => {
    await enqueueCatalogRefresh(shopId, [
      { kind: "product", ref: "gid://shopify/Product/10" },
      { kind: "product", ref: "gid://shopify/Product/11" },
    ], db);

    const result = await drainCatalogRefreshQueue({ shopId }, db);

    expect(result.completed).toBe(2);
    expect(refreshProduct).toHaveBeenCalledTimes(2);
    expect(refreshProduct).toHaveBeenCalledWith(shopId, expect.stringContaining("myshopify.com"), "token", "gid://shopify/Product/10");
    expect(shopifyGraphQLMock).not.toHaveBeenCalled();
  });

  it("a failing product does not stop the inventory items next to it", async () => {
    await seedVariant(1);
    await enqueueCatalogRefresh(shopId, [
      { kind: "product", ref: "gid://shopify/Product/10" },
      { kind: "inventory_item", ref: item(1) },
    ], db);
    refreshProduct.mockRejectedValueOnce(new Error("product gone wrong"));
    shopifyGraphQLMock.mockResolvedValue(nodesFor([1], 5));

    const result = await drainCatalogRefreshQueue({ shopId }, db);

    expect(result).toMatchObject({ completed: 1, failed: 1 });
    const [row] = await db.select().from(variantCache).where(eq(variantCache.variantGid, variant(1)));
    expect(row!.inventoryQuantity).toBe(5);
  });

  it("drops the rows of a shop that is no longer active without calling Shopify", async () => {
    await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }], db);
    await db.update(shops).set({ isActive: false }).where(eq(shops.id, shopId));

    await drainCatalogRefreshQueue({ shopId }, db);

    expect(shopifyGraphQLMock).not.toHaveBeenCalled();
    expect(await queueRows()).toEqual([]);
  });

  it("returns immediately on an empty queue", async () => {
    expect(await drainCatalogRefreshQueue({ shopId }, db)).toEqual({ claimed: 0, completed: 0, failed: 0 });
  });
});

describe("loadInventoryItemsBatch", () => {
  it("ignores ids Shopify returns null for", async () => {
    const graphQL = vi.fn().mockResolvedValue({ nodes: [null, nodesFor([2]).nodes[0]] });
    const items = await loadInventoryItemsBatch("s.myshopify.com", "t", [item(1), item(2)], graphQL as never);
    expect(items.map((i) => i.id)).toEqual([item(2)]);
  });
});

describe("coalescedDrain", () => {
  it("waits for the coalescing window, then drains the shop in one read", async () => {
    await seedVariant(1);
    await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }]);
    shopifyGraphQLMock.mockResolvedValue(nodesFor([1], 9));

    const started = Date.now();
    const pending = coalescedDrain(shopId, 40);
    // A second event for the same item inside the window must not cause a second read.
    await enqueueCatalogRefresh(shopId, [{ kind: "inventory_item", ref: item(1) }]);
    const result = await pending;

    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(result.completed).toBe(1);
    expect(shopifyGraphQLMock).toHaveBeenCalledTimes(1);
  });
});
