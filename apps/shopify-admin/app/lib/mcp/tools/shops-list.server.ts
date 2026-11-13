import { z } from "zod";
import { and, count, eq } from "drizzle-orm";
import { offers, type Db } from "@promo/db";
import { buildResult, shopHandle, type ToolResult } from "../result.server.js";
import { fanOut } from "../multi-shop.server.js";
import { resolveWriteModes, selectShops, type VisibleShop, type WriteMode } from "../shops.server.js";

export const shopsListInput = {
  shops: z.array(z.string()).optional().describe("Shop domains, handles or ids; omitted = every visible shop."),
};

export type ShopsListRow = {
  shopDomain: string;
  shopHandle: string;
  name: string;
  currency: string;
  timezone: string;
  writeMode: WriteMode;
  planName: string | null;
  installedAt: string;
  activeOffers: number;
  publishPendingAt: string | null;
};

export async function shopsList(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[] },
  _env: NodeJS.ProcessEnv,
  now: () => Date = () => new Date(),
): Promise<ToolResult<{ shops: ShopsListRow[] }>> {
  const selected = selectShops(visible, args.shops);
  const modes = resolveWriteModes(selected);
  const { perShop, results } = await fanOut(
    selected,
    async (shop) => {
      const [row] = await db
        .select({ n: count() })
        .from(offers)
        .where(and(eq(offers.shopId, shop.id), eq(offers.status, "active")));
      return Number(row?.n ?? 0);
    },
    { cacheKey: "shops_list" },
  );
  const activeByShop = new Map(results.map((r) => [r.shop.id, r.value]));

  const rows: ShopsListRow[] = selected.map((shop) => ({
    shopDomain: shop.myshopifyDomain,
    shopHandle: shopHandle(shop.myshopifyDomain),
    name: shop.name,
    currency: shop.currencyCode,
    timezone: shop.timezone,
    writeMode: modes.get(shop.id) ?? "write",
    planName: shop.planName,
    installedAt: shop.installedAt.toISOString(),
    activeOffers: activeByShop.get(shop.id) ?? 0,
    publishPendingAt: shop.publishPendingAt ? shop.publishPendingAt.toISOString() : null,
  }));

  const summary = [
    `${rows.length} shop${rows.length === 1 ? "" : "s"} visible.`,
    ...rows.map((r) => `- ${r.shopDomain}: ${r.currency}, ${r.timezone}, ${r.activeOffers} active offers, ${r.writeMode}`),
    "Every listed shop accepts writes from any authenticated operator (full access): no per-shop write lock, no role tiers, dryRun is an optional preview.",
  ].join("\n");

  return buildResult(
    {
      summary,
      data: { shops: rows },
      perShop,
      links: rows.map((r) => ({ label: `${r.shopHandle} admin`, url: `https://admin.shopify.com/store/${r.shopHandle}` })),
      warnings: rows
        .filter((r) => r.publishPendingAt)
        .map((r) => ({
          code: "PUBLISH_PENDING",
          severity: "warn" as const,
          message: `${r.shopDomain} has a publish waiting to retry since ${r.publishPendingAt}.`,
        })),
      nextActions: [],
    },
    now,
  );
}
