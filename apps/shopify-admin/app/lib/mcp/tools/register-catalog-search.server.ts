import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpContext } from "../server.server.js";
import { runTool, toErrorCallToolResult } from "../server.server.js";
import { visibleShops } from "../shops.server.js";
import type { CallInfo } from "../write-runner.server.js";
import {
  catalogSearch,
  catalogSearchInput,
  catalogSyncInput,
  catalogSyncTool,
  marketsList,
  marketsListInput,
} from "./catalog-search.server.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** Catalog tools: cache-only search (0 Admin API cost), cache refresh, markets. */
export function registerCatalogSearchTools(server: McpServer, ctx: McpContext): void {
  const call = (extra: { requestId?: string | number }): CallInfo => ({
    client: server.server.getClientVersion()?.name,
    requestId: extra.requestId !== undefined ? String(extra.requestId) : randomUUID(),
  });

  server.registerTool(
    "catalog_search",
    {
      title: "Search the product catalog",
      description:
        'Finds products, variants and collections of one shop from the synced cache (no Shopify call). Match by name/title, handle, SKU, numeric id or GID. Returns per product: GID, numeric id, handle, title, status, min/max price (shop currency), availability, inventory and (default) every variant with GID, SKU, price and availability; collections give id and product count only. Warns when the cache is stale or empty and points to catalog_sync. Example: {"shop":"onesolsupps","query":"Protein & Creatine Bundle"} finds product 9208279269615; {"shop":"onesolsupps","ids":["9208279269615"]} or {"ids":["gid://shopify/ProductVariant/123"]} resolve ids. Use the returned GIDs or numeric ids as targets when creating offers.',
      inputSchema: catalogSearchInput,
      annotations: READ_ONLY,
    },
    (args) => runTool(async () => catalogSearch(ctx.db, await visibleShops(ctx.db, ctx.operator), args, ctx.now)),
  );

  server.registerTool(
    "markets_list",
    {
      title: "List shop markets",
      description:
        'Lists the Shopify Markets of a shop (id, name, handle, enabled, primary, currency, country codes, primary locale) as the admin widget editor sees them: cached for 1 hour, one Admin query on a miss. Use the market ids in market conditions. Example: {"shop":"onesolsupps"}.',
      inputSchema: marketsListInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => runTool(async () => marketsList(await visibleShops(ctx.db, ctx.operator), args, ctx.now)),
  );

  server.registerTool(
    "catalog_sync",
    {
      title: "Sync catalog from Shopify",
      description:
        'Refreshes a shop\'s cache from Shopify with the same functions as the admin sync endpoints and the catalog-sync cron. what: products (full resumable product + variant import, runs up to 25 s and the cron resumes the rest), collections (membership is part of the same import), markets, inventory (drain pending inventory refreshes). dryRun:true shows what would run and the last sync time. Shopify limit: the import is paged with query cost under 1000 points. Example: {"shop":"onesolsupps","what":"products"}.',
      inputSchema: catalogSyncInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        return await catalogSyncTool(ctx, call(extra), args, await visibleShops(ctx.db, ctx.operator));
      } catch (error) {
        return toErrorCallToolResult(error);
      }
    },
  );
}
