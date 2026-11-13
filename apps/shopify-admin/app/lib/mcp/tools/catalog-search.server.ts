import { z } from "zod";
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { catalogSyncJobs, shops, variantCache, productCache, type Db } from "@promo/db";
import { sql } from "drizzle-orm";
import { searchCatalog, type CatalogSearchResult } from "../../catalog-search.server.js";
import { getMarketsForShop, type ShopifyMarket } from "../../markets.server.js";
import { decryptToken } from "../../token-crypto.server.js";
import { invalidateMarketsCache, syncMarketsForShop } from "../../sync/market-sync.server.js";
import { drainProductSyncQueue, queueProductSync } from "../../sync/product-sync.server.js";
import { drainCatalogRefreshQueue } from "../../sync/inventory-sync-queue.server.js";
import { ToolError, buildResult, shopHandle, type NextAction, type ToolResult, type Warning } from "../result.server.js";
import type { McpContext } from "../server.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import { runWrite, type CallInfo } from "../write-runner.server.js";
import { adminLink, nextCursor, pageWindow } from "./catalog-shared.server.js";

/** A cache older than this is flagged; the nightly reconcile + webhooks normally keep it well under a day. */
export const CATALOG_STALE_MS = 36 * 60 * 60 * 1000;

const shopField = z.string().max(200).describe("Shop domain or handle, e.g. onesolsupps or onesolsupps.myshopify.com.");

export const catalogSearchInput = {
  shop: shopField,
  query: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe("Free text matched (case-insensitive contains) against product title, handle, vendor and variant SKU. Collections cannot be searched by text: the cache has no collection titles, pass ids."),
  ids: z
    .array(z.string().trim().max(80))
    .max(100)
    .optional()
    .describe("Numeric ids (matched as product, variant and collection id) or GIDs: gid://shopify/Product/<id>, gid://shopify/ProductVariant/<id>, gid://shopify/Collection/<id>. A variant id returns its product."),
  kind: z
    .enum(["product", "variant", "collection", "any"])
    .optional()
    .describe("What to return. product (default behaviour of any), variant (products with the matching variants always included), collection (collection ids with product counts), any (products and collections)."),
  includeVariants: z.boolean().optional().describe("Include every variant (GID, title, SKU, price, availability) per product. Default true."),
  limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100 (default 25)."),
  cursor: z.string().optional().describe("Opaque cursor from the previous page's meta.page.cursor."),
};

export async function catalogSearch(
  db: Db,
  visible: VisibleShop[],
  args: { shop: string; query?: string; ids?: string[]; kind?: "product" | "variant" | "collection" | "any"; includeVariants?: boolean; limit?: number; cursor?: string },
  now: () => Date = () => new Date(),
): Promise<ToolResult<CatalogSearchResult & { shopDomain: string; shopHandle: string }>> {
  const [shop] = selectShops(visible, [args.shop]);
  const { offset, limit } = pageWindow({ limit: args.limit, cursor: args.cursor });
  const kind = args.kind ?? "any";
  const result = await searchCatalog(db, shop!, {
    query: args.query,
    ids: args.ids,
    kind,
    includeVariants: kind === "variant" ? true : (args.includeVariants ?? true),
    offset,
    limit,
  });

  const warnings: Warning[] = [];
  const nextActions: NextAction[] = [];
  const syncAction: NextAction = {
    mcp: "promo-engine",
    tool: "catalog_sync",
    args: { shop: shop!.myshopifyDomain, what: "products" },
    why: "Refresh the product and variant cache from Shopify.",
    risk: "write",
  };
  if (result.cache.products === 0) {
    warnings.push({ code: "CATALOG_CACHE_EMPTY", severity: "warn", message: "The product cache of this shop is empty; results cannot be trusted." });
    nextActions.push(syncAction);
  } else if (result.cache.lastSyncedAt && now().getTime() - new Date(result.cache.lastSyncedAt).getTime() > CATALOG_STALE_MS) {
    warnings.push({ code: "CATALOG_CACHE_STALE", severity: "warn", message: `The catalog cache was last synced ${result.cache.lastSyncedAt}; recent products or prices may be missing.` });
    nextActions.push(syncAction);
  }
  if (result.collections.length > 0) {
    warnings.push({ code: "COLLECTION_TITLES_NOT_CACHED", severity: "info", message: "Collections come from product membership: id and product count only, title and handle are not cached." });
  }
  if (args.query && kind === "collection") {
    warnings.push({ code: "COLLECTION_TEXT_SEARCH_UNSUPPORTED", severity: "warn", message: "Collections cannot be searched by text from the cache; pass ids." });
  }

  const found = result.products.length + result.collections.length;
  const first = result.products[0];
  return buildResult(
    {
      summary:
        found === 0
          ? `No catalog match in ${shop!.myshopifyDomain} (cache of ${result.cache.products} products, last synced ${result.cache.lastSyncedAt ?? "never"}).`
          : `${result.products.length} product(s) and ${result.collections.length} collection(s) in ${shop!.myshopifyDomain}${first ? `; first: "${first.title.replace(/\s+/g, " ").slice(0, 80)}" (${first.gid})` : ""}.`,
      data: { ...result, shopDomain: shop!.myshopifyDomain, shopHandle: shopHandle(shop!.myshopifyDomain) },
      links: [adminLink(shopHandle(shop!.myshopifyDomain))],
      warnings,
      nextActions,
      meta: {
        page: { hasMore: result.hasMore, ...(result.hasMore ? { cursor: nextCursor(offset + limit) } : {}) },
        ...(result.cache.lastSyncedAt ? { dataFreshness: result.cache.lastSyncedAt } : {}),
      },
    },
    now,
  );
}

export const marketsListInput = { shop: shopField };

export async function marketsList(
  visible: VisibleShop[],
  args: { shop: string },
  now: () => Date = () => new Date(),
): Promise<ToolResult<{ shopDomain: string; markets: ShopifyMarket[] }>> {
  const [shop] = selectShops(visible, [args.shop]);
  const markets = await getMarketsForShop(shop!.id);
  return buildResult(
    {
      summary: `${markets.length} market(s) in ${shop!.myshopifyDomain}.`,
      data: { shopDomain: shop!.myshopifyDomain, markets },
      links: [adminLink(shopHandle(shop!.myshopifyDomain))],
    },
    now,
  );
}

export const SYNC_KINDS = ["products", "collections", "markets", "inventory"] as const;
type SyncKind = (typeof SYNC_KINDS)[number];

export const catalogSyncInput = {
  shop: shopField,
  what: z
    .enum(SYNC_KINDS)
    .describe("products: queue a full resumable product + variant import (also refreshes collection membership and prices). collections: same import, collection membership is part of it. markets: refresh the Shopify Markets list. inventory: drain pending inventory and variant refreshes now."),
  dryRun: z.boolean().optional().describe("Default false. true previews what would run and the last sync time; nothing is queued."),
  idempotencyKey: z.string().min(8).max(128).optional().describe("Optional. Re-sending an executed call with the same key within 24 h returns the stored result."),
};

type SyncArgs = { shop: string; what: SyncKind; dryRun?: boolean; idempotencyKey?: string };

const WHAT_TEXT: Record<SyncKind, string> = {
  products: "queue a full product + variant catalog import and run up to 3 pages (25 s); the nightly cron resumes what is left",
  collections: "queue the catalog import that refreshes collection membership and run up to 3 pages (25 s); the cron resumes the rest",
  markets: "re-read the Shopify Markets list (one paginated Admin query) and refresh the markets cache",
  inventory: "process the pending inventory/variant refresh queue for this shop (25 s budget)",
};

async function lastSync(db: Db, shopId: string, what: SyncKind) {
  if (what === "markets") return null;
  const table = what === "inventory" ? variantCache : productCache;
  const [row] = await db.select({ last: sql<Date | string | null>`max(${table.syncedAt})` }).from(table).where(eq(table.shopId, shopId));
  return row?.last ? new Date(row.last).toISOString() : null;
}

/** Same functions as api.sync / api.products.sync / the catalog-sync cron; the shop's offline token is read from `shops`. */
export function catalogSyncTool(ctx: McpContext, call: CallInfo, args: SyncArgs, visible: VisibleShop[]): Promise<CallToolResult> {
  const [shop] = selectShops(visible, [args.shop]);
  return runWrite(ctx, call, {
    tool: "catalog_sync",
    args,
    dryRun: args.dryRun ?? false,
    idempotencyKey: args.idempotencyKey,
    shops: [shop!],
    preview: async () => {
      const last = await lastSync(ctx.db, shop!.id, args.what);
      const [job] = await ctx.db.select().from(catalogSyncJobs).where(eq(catalogSyncJobs.shopId, shop!.id)).limit(1);
      return {
        summary: `Would ${WHAT_TEXT[args.what]} for ${shop!.myshopifyDomain}. Last sync: ${last ?? "never"}.`,
        data: {
          shopDomain: shop!.myshopifyDomain,
          what: args.what,
          lastSyncedAt: last,
          currentJob: job ? { status: job.status, syncedProducts: job.syncedProducts, updatedAt: job.updatedAt.toISOString() } : null,
        },
        links: [adminLink(shopHandle(shop!.myshopifyDomain))],
        offerUpdatedAt: null,
      };
    },
    apply: async () => {
      const [row] = await ctx.db.select({ token: shops.accessTokenEncrypted }).from(shops).where(eq(shops.id, shop!.id)).limit(1);
      if (!row) throw new ToolError("SHOP_NOT_FOUND", `Shop "${args.shop}" does not exist.`);
      const links = [adminLink(shopHandle(shop!.myshopifyDomain))];
      try {
        if (args.what === "markets") {
          invalidateMarketsCache(shop!.id);
          const markets = await syncMarketsForShop(shop!.id, shop!.myshopifyDomain, await decryptToken(row.token));
          return { summary: `Refreshed ${markets.length} market(s) of ${shop!.myshopifyDomain}.`, data: { shopDomain: shop!.myshopifyDomain, what: args.what, markets: markets.length }, links };
        }
        if (args.what === "inventory") {
          const drained = await drainCatalogRefreshQueue({ shopId: shop!.id, maxRuntimeMs: 25_000 });
          return { summary: `Inventory refresh queue of ${shop!.myshopifyDomain}: ${drained.completed} done, ${drained.failed} failed (of ${drained.claimed} claimed).`, data: { shopDomain: shop!.myshopifyDomain, what: args.what, ...drained }, links };
        }
        const queued = await queueProductSync(shop!.id);
        const { steps, job } = await drainProductSyncQueue({ shopId: shop!.id, maxSteps: 3, maxRuntimeMs: 25_000 });
        const status = job?.status ?? queued?.status ?? "queued";
        const synced = job?.syncedProducts ?? queued?.syncedProducts ?? 0;
        const done = status === "completed";
        return {
          summary: `Catalog sync of ${shop!.myshopifyDomain}: ${done ? "completed" : `${status}, ${synced} products imported so far; the cron resumes it`} (${steps} step(s) run).`,
          data: { shopDomain: shop!.myshopifyDomain, what: args.what, status, syncedProducts: synced, steps },
          links,
          nextActions: done
            ? [{ mcp: "promo-engine" as const, tool: "catalog_search", args: { shop: shop!.myshopifyDomain }, why: "Check the refreshed catalog.", risk: "read" as const }]
            : [{ mcp: "promo-engine" as const, tool: "catalog_sync", args: { shop: shop!.myshopifyDomain, what: args.what }, why: "Continue the import now instead of waiting for the cron.", risk: "write" as const }],
        };
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError("UPSTREAM_UNAVAILABLE", `Shopify sync failed: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200)}`);
      }
    },
  });
}
