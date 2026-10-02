import type * as PromoDb from "@promo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { catalogSyncJobs, productCache, shops, type Db } from "@promo/db";
import { createTestDb, seedShop } from "../test-support/pglite-db.js";
import type { ShopifyQueryCost } from "../shopify-fetch.server.js";

let currentDb: Db | null = null;
vi.mock("@promo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof PromoDb>()),
  getDb: () => currentDb,
}));
const shopifyGraphQLMock = vi.fn();
vi.mock("../shopify-fetch.server.js", () => ({ shopifyGraphQL: (...args: unknown[]) => shopifyGraphQLMock(...args) }));
vi.mock("../token-crypto.server.js", () => ({ decryptToken: async () => "token" }));
const captureMessage = vi.fn();
vi.mock("@sentry/node", () => ({ captureMessage: (...args: unknown[]) => captureMessage(...args), captureException: vi.fn() }));

const { QUERY_COST_WARNING, processProductSyncStep, queueProductSync, runNightlyCatalogReconcile, trackQueryCost } =
  await import("./product-sync.server.js");

let db: Db;
let close: () => Promise<void>;
let counter = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  currentDb = db;
}, 60_000);
afterAll(async () => {
  await close();
});
beforeEach(() => {
  shopifyGraphQLMock.mockReset();
  captureMessage.mockClear();
});

const cost = (requested: number): ShopifyQueryCost => ({ requestedQueryCost: requested, actualQueryCost: 10 });

describe("trackQueryCost", () => {
  it("only logs a query that is comfortably under Shopify's limit", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    trackQueryCost("product-sync", "s.myshopify.com")(cost(QUERY_COST_WARNING - 1));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("requested cost 799, actual 10"));
    expect(captureMessage).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("raises a Sentry warning when the requested cost nears the 1000-point ceiling", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    trackQueryCost("product-sync", "s.myshopify.com")(cost(QUERY_COST_WARNING));
    expect(captureMessage).toHaveBeenCalledWith(
      "product-sync query cost is near Shopify's limit",
      expect.objectContaining({ level: "warning", extra: expect.objectContaining({ requestedQueryCost: 800 }) }),
    );
    info.mockRestore();
  });
});

describe("the product import reads and reports the real query cost", () => {
  it("passes an onCost hook to the products query", async () => {
    const shopId = await seedShop(db, `cost-${(counter += 1)}.myshopify.com`);
    await queueProductSync(shopId);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    shopifyGraphQLMock.mockImplementation(async (args: { query: string; onCost?: (c: ShopifyQueryCost) => void }) => {
      args.onCost?.(cost(950));
      return { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };
    });

    await processProductSyncStep(shopId);

    expect(shopifyGraphQLMock.mock.calls[0]![0]).toMatchObject({ onCost: expect.any(Function) as unknown as () => void });
    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining("near Shopify's limit"), expect.anything());
    info.mockRestore();
  });
});

describe("runNightlyCatalogReconcile", () => {
  const emptyCatalog = { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } };

  it("restarts a finished import for every active shop and runs it", async () => {
    const one = await seedShop(db, `night-a-${(counter += 1)}.myshopify.com`);
    const two = await seedShop(db, `night-b-${counter}.myshopify.com`);
    for (const shopId of [one, two]) {
      await queueProductSync(shopId);
      await db
        .update(catalogSyncJobs)
        .set({ status: "completed", completedAt: new Date(Date.now() - 86_400_000), syncStartedAt: new Date(Date.now() - 90_000_000) })
        .where(eq(catalogSyncJobs.shopId, shopId));
      // A stale row the previous import would have archived is only archived by a COMPLETE run.
      await db.insert(productCache).values({
        shopId,
        productGid: `gid://shopify/Product/${shopId.slice(0, 4)}`,
        handle: "stale",
        title: "Stale",
        raw: {},
        syncedAt: new Date(Date.now() - 86_400_000),
      });
    }
    shopifyGraphQLMock.mockResolvedValue(emptyCatalog);

    const result = await runNightlyCatalogReconcile({ maxSteps: 50, maxRuntimeMs: 20_000 });

    expect(result.shops).toBeGreaterThanOrEqual(2);
    expect(result.queued).toBeGreaterThanOrEqual(2);
    for (const shopId of [one, two]) {
      const [job] = await db.select().from(catalogSyncJobs).where(eq(catalogSyncJobs.shopId, shopId));
      expect(job!.status).toBe("completed");
      const [stale] = await db.select().from(productCache).where(eq(productCache.shopId, shopId));
      expect(stale!.status).toBe("ARCHIVED");
    }
  });

  it("does not restart an import that is still running, or touch an inactive shop", async () => {
    const running = await seedShop(db, `night-run-${(counter += 1)}.myshopify.com`);
    const gone = await seedShop(db, `night-gone-${counter}.myshopify.com`);
    await queueProductSync(running);
    await db
      .update(catalogSyncJobs)
      .set({ status: "running", cursor: "mid-way", leaseUntil: new Date(Date.now() + 600_000) })
      .where(eq(catalogSyncJobs.shopId, running));
    await db.update(shops).set({ isActive: false }).where(eq(shops.id, gone));
    shopifyGraphQLMock.mockResolvedValue(emptyCatalog);

    await runNightlyCatalogReconcile({ maxSteps: 0 });

    const [job] = await db.select().from(catalogSyncJobs).where(eq(catalogSyncJobs.shopId, running));
    expect(job).toMatchObject({ status: "running", cursor: "mid-way" });
    expect(await db.select().from(catalogSyncJobs).where(eq(catalogSyncJobs.shopId, gone))).toEqual([]);
  });
});
