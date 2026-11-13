import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { catalogSyncJobs, mcpOperators, productCache, variantCache, type Db } from "@promo/db";
import { createTestDb, seedShop } from "../../test-support/pglite-db.js";
import { resetMemoryRateLimits } from "../../rate-limit.server.js";
import type { Operator } from "../auth.server.js";
import type { McpContext } from "../server.server.js";
import { registerCatalogSearchTools } from "./register-catalog-search.server.js";

const sync = vi.hoisted(() => ({
  queueProductSync: vi.fn(),
  drainProductSyncQueue: vi.fn(),
  drainCatalogRefreshQueue: vi.fn(),
  syncMarketsForShop: vi.fn(),
  invalidateMarketsCache: vi.fn(),
  getMarketsForShop: vi.fn(),
}));
vi.mock("../../sync/product-sync.server.js", () => ({ queueProductSync: sync.queueProductSync, drainProductSyncQueue: sync.drainProductSyncQueue }));
vi.mock("../../sync/inventory-sync-queue.server.js", () => ({ drainCatalogRefreshQueue: sync.drainCatalogRefreshQueue }));
vi.mock("../../sync/market-sync.server.js", () => ({ syncMarketsForShop: sync.syncMarketsForShop, invalidateMarketsCache: sync.invalidateMarketsCache }));
vi.mock("../../markets.server.js", () => ({ getMarketsForShop: sync.getMarketsForShop }));
vi.mock("../../token-crypto.server.js", () => ({ decryptToken: async (t: string) => `dec:${t}` }));

const ONESOL = "onesolsupps.myshopify.com";
const EMPTY = "empty-shop.myshopify.com";
const PRODUCT_ID = 9208279269615;

type Body = {
  summary: string;
  data: Record<string, any>;
  warnings: { code: string }[];
  nextActions: { tool: string; args: Record<string, unknown> }[];
  meta: { page?: { hasMore: boolean; cursor?: string }; dryRun?: boolean };
};

let db: Db;
let close: () => Promise<void>;
let client: Client;
let shopId: string;
let clock = new Date("2026-11-13T12:00:00Z");
let operator: Operator;

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: Boolean(res.isError), body: res.structuredContent as unknown as Body, text: JSON.stringify(res.structuredContent) };
};

async function seedProduct(shop: string, gid: number, title: string, handle: string, legacy: number, variants: { id: number; sku: string; price: string; available: boolean; qty: number | null }[], collections: string[] = [], syncedAt = clock) {
  await db.insert(productCache).values({
    shopId: shop, productGid: `gid://shopify/Product/${gid}`, legacyProductId: legacy, handle, title, vendor: "OneSol", status: "ACTIVE", collections, raw: {}, syncedAt,
  });
  for (const v of variants) {
    await db.insert(variantCache).values({
      shopId: shop, productGid: `gid://shopify/Product/${gid}`, variantGid: `gid://shopify/ProductVariant/${v.id}`, legacyVariantId: v.id, sku: v.sku,
      title: `Variant ${v.id}`, price: v.price, currencyCode: "USD", availableForSale: v.available, inventoryQuantity: v.qty, raw: {}, syncedAt,
    });
  }
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [op] = await db.insert(mcpOperators).values({ email: "v@example.com", name: "v", role: "viewer", shopAllowList: ["*"] }).returning();
  operator = { id: op!.id, email: op!.email, name: op!.name, role: "viewer", shopAllowList: ["*"] };
  shopId = await seedShop(db, ONESOL);
  await seedShop(db, EMPTY);
  await seedProduct(shopId, PRODUCT_ID, "Protein & Creatine Bundle", "protein-creatine-bundle", PRODUCT_ID, [
    { id: 111, sku: "PCB-VAN", price: "59.9900", available: true, qty: 10 },
    { id: 112, sku: "PCB-CHO", price: "64.0000", available: false, qty: 0 },
  ], ["gid://shopify/Collection/700", "gid://shopify/Collection/701"]);
  await seedProduct(shopId, 5, "Plain Creatine", "plain-creatine", 5, [{ id: 222, sku: "CRE-1", price: "29.00", available: true, qty: null }], ["gid://shopify/Collection/700"]);
  await seedProduct(shopId, 6, "Shaker Bottle", "shaker", 6, [{ id: 333, sku: "SHK-1", price: "9.50", available: true, qty: 3 }]);
}, 60_000);
afterAll(async () => {
  await close();
});

beforeEach(async () => {
  resetMemoryRateLimits();
  Object.values(sync).forEach((m) => m.mockReset());
  clock = new Date("2026-11-13T12:00:00Z");
  const ctx: McpContext = { db, env: {} as NodeJS.ProcessEnv, operator, now: () => clock, rateLimit: async () => ({ ok: true as const }), publish: vi.fn(async () => null) };
  const server = new McpServer({ name: "t", version: "0" });
  registerCatalogSearchTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "vitest", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

describe("catalog_search", () => {
  it("finds the owner's product by name, with variants, prices and availability", async () => {
    const { isError, body } = await call("catalog_search", { shop: "onesolsupps", query: "protein & creatine" });
    expect(isError).toBe(false);
    expect(body.data["products"]).toHaveLength(1);
    const p = body.data["products"][0];
    expect(p).toMatchObject({
      gid: `gid://shopify/Product/${PRODUCT_ID}`, numericId: PRODUCT_ID, handle: "protein-creatine-bundle", title: "Protein & Creatine Bundle",
      status: "ACTIVE", price: { min: "59.99", max: "64.00", currency: "USD" }, availableForSale: true, inventoryQuantity: 10, variantCount: 2,
    });
    expect(p.variants.map((v: any) => [v.gid, v.sku, v.price, v.available])).toEqual([
      ["gid://shopify/ProductVariant/111", "PCB-VAN", "59.99", true],
      ["gid://shopify/ProductVariant/112", "PCB-CHO", "64.00", false],
    ]);
    expect(body.warnings.map((w) => w.code)).not.toContain("CATALOG_CACHE_STALE");
    expect(body.data["cache"].lastSyncedAt).toBe("2026-11-13T12:00:00.000Z");
  });

  it("matches handle, SKU, numeric id, product GID and variant GID", async () => {
    const titles = async (args: Record<string, unknown>) =>
      (await call("catalog_search", { shop: ONESOL, kind: "product", ...args })).body.data["products"].map((p: any) => p.title);
    expect(await titles({ query: "plain-creatine" })).toEqual(["Plain Creatine"]);
    expect(await titles({ query: "shk-1" })).toEqual(["Shaker Bottle"]);
    expect(await titles({ ids: [String(PRODUCT_ID)] })).toEqual(["Protein & Creatine Bundle"]);
    expect(await titles({ ids: [`gid://shopify/Product/${PRODUCT_ID}`] })).toEqual(["Protein & Creatine Bundle"]);
    expect(await titles({ ids: ["gid://shopify/ProductVariant/222"] })).toEqual(["Plain Creatine"]);
    expect(await titles({ ids: ["333"] })).toEqual(["Shaker Bottle"]);
    expect(await titles({ query: "nothing-like-this" })).toEqual([]);
  });

  it("omits variants when asked and paginates with a cursor", async () => {
    const first = await call("catalog_search", { shop: ONESOL, kind: "product", includeVariants: false, limit: 2 });
    expect(first.body.data["products"]).toHaveLength(2);
    expect(first.body.data["products"][0].variants).toBeUndefined();
    expect(first.body.meta.page?.hasMore).toBe(true);
    const second = await call("catalog_search", { shop: ONESOL, kind: "product", includeVariants: false, limit: 2, cursor: first.body.meta.page?.cursor });
    expect(second.body.data["products"]).toHaveLength(1);
    expect(second.body.meta.page?.hasMore).toBe(false);
  });

  it("lists collections by GID or numeric id with product counts", async () => {
    const byId = await call("catalog_search", { shop: ONESOL, kind: "collection", ids: ["700", "gid://shopify/Collection/701"] });
    expect(byId.body.data["products"]).toEqual([]);
    expect(byId.body.data["collections"]).toEqual([
      { gid: "gid://shopify/Collection/700", numericId: 700, handle: null, title: null, productCount: 2 },
      { gid: "gid://shopify/Collection/701", numericId: 701, handle: null, title: null, productCount: 1 },
    ]);
    const all = await call("catalog_search", { shop: ONESOL, kind: "collection" });
    expect(all.body.data["collections"]).toHaveLength(2);
    const text = await call("catalog_search", { shop: ONESOL, kind: "collection", query: "summer" });
    expect(text.body.data["collections"]).toEqual([]);
    expect(text.body.warnings.map((w) => w.code)).toContain("COLLECTION_TEXT_SEARCH_UNSUPPORTED");
  });

  it("warns and points to catalog_sync when the cache is stale or empty", async () => {
    clock = new Date("2026-11-16T12:00:00Z");
    const stale = await call("catalog_search", { shop: ONESOL, query: "shaker" });
    expect(stale.body.warnings.map((w) => w.code)).toContain("CATALOG_CACHE_STALE");
    expect(stale.body.nextActions[0]).toMatchObject({ tool: "catalog_sync", args: { what: "products" } });

    const empty = await call("catalog_search", { shop: EMPTY, query: "x" });
    expect(empty.body.warnings.map((w) => w.code)).toContain("CATALOG_CACHE_EMPTY");
    expect(empty.body.data["cache"].lastSyncedAt).toBeNull();
    expect(empty.body.nextActions[0]).toMatchObject({ tool: "catalog_sync" });
  });

  it("rejects a shop that is not visible", async () => {
    const { isError, text } = await call("catalog_search", { shop: "nope.myshopify.com" });
    expect(isError).toBe(true);
    expect(text).toContain("SHOP_NOT_FOUND");
  });
});

describe("markets_list", () => {
  it("returns the shop's markets from the markets service", async () => {
    sync.getMarketsForShop.mockResolvedValue([{ id: "gid://shopify/Market/1", name: "US", handle: "us", enabled: true, primary: true, currencyCode: "USD", countryCodes: ["US"], primaryLocale: "en" }]);
    const { isError, body } = await call("markets_list", { shop: "onesolsupps" });
    expect(isError).toBe(false);
    expect(sync.getMarketsForShop).toHaveBeenCalledWith(shopId);
    expect(body.data["markets"]).toHaveLength(1);
    expect(body.data["markets"][0].handle).toBe("us");
  });
});

describe("catalog_sync", () => {
  it("dryRun previews what would run and the last sync time without calling any sync function", async () => {
    await db.insert(catalogSyncJobs).values({ shopId, status: "completed", syncedProducts: 3 }).onConflictDoNothing();
    const { isError, body } = await call("catalog_sync", { shop: ONESOL, what: "products", dryRun: true });
    expect(isError).toBe(false);
    expect(body.meta.dryRun).toBe(true);
    expect(body.data["lastSyncedAt"]).toBe("2026-11-13T12:00:00.000Z");
    expect(body.data["currentJob"]).toMatchObject({ status: "completed", syncedProducts: 3 });
    expect(sync.queueProductSync).not.toHaveBeenCalled();
    expect(sync.drainProductSyncQueue).not.toHaveBeenCalled();
  });

  it("products and collections queue the import and drain it for this shop", async () => {
    sync.queueProductSync.mockResolvedValue({ status: "queued", syncedProducts: 0 });
    sync.drainProductSyncQueue.mockResolvedValue({ steps: 2, job: { status: "completed", syncedProducts: 42 } });
    for (const what of ["products", "collections"]) {
      const { isError, body } = await call("catalog_sync", { shop: ONESOL, what });
      expect(isError).toBe(false);
      expect(body.data).toMatchObject({ what, status: "completed", syncedProducts: 42, steps: 2 });
    }
    expect(sync.queueProductSync).toHaveBeenCalledWith(shopId);
    expect(sync.drainProductSyncQueue).toHaveBeenCalledWith({ shopId, maxSteps: 3, maxRuntimeMs: 25_000 });
  });

  it("an unfinished import suggests continuing", async () => {
    sync.queueProductSync.mockResolvedValue({ status: "queued", syncedProducts: 0 });
    sync.drainProductSyncQueue.mockResolvedValue({ steps: 3, job: { status: "running", syncedProducts: 750 } });
    const { body } = await call("catalog_sync", { shop: ONESOL, what: "products" });
    expect(body.data).toMatchObject({ status: "running", syncedProducts: 750 });
    expect(body.nextActions[0]).toMatchObject({ tool: "catalog_sync" });
  });

  it("markets uses the shop's decrypted offline token and invalidates the cache", async () => {
    sync.syncMarketsForShop.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    const { isError, body } = await call("catalog_sync", { shop: ONESOL, what: "markets" });
    expect(isError).toBe(false);
    expect(sync.invalidateMarketsCache).toHaveBeenCalledWith(shopId);
    expect(sync.syncMarketsForShop).toHaveBeenCalledWith(shopId, ONESOL, "dec:x");
    expect(body.data["markets"]).toBe(2);
  });

  it("inventory drains the refresh queue of this shop", async () => {
    sync.drainCatalogRefreshQueue.mockResolvedValue({ claimed: 5, completed: 4, failed: 1 });
    const { body } = await call("catalog_sync", { shop: ONESOL, what: "inventory" });
    expect(sync.drainCatalogRefreshQueue).toHaveBeenCalledWith({ shopId, maxRuntimeMs: 25_000 });
    expect(body.data).toMatchObject({ claimed: 5, completed: 4, failed: 1 });
  });

  it("a Shopify failure is an UPSTREAM_UNAVAILABLE tool error", async () => {
    sync.queueProductSync.mockResolvedValue({ status: "queued", syncedProducts: 0 });
    sync.drainProductSyncQueue.mockRejectedValue(new Error("Throttled"));
    const { isError, text } = await call("catalog_sync", { shop: ONESOL, what: "products" });
    expect(isError).toBe(true);
    expect(text).toContain("UPSTREAM_UNAVAILABLE");
  });
});
