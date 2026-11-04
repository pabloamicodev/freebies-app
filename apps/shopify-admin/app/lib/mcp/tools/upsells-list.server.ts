import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { productCache, variantCache, widgetPlacements, widgets, type Db } from "@promo/db";
import { buildResult, shopHandle, type ToolResult } from "../result.server.js";
import { fanOut } from "../multi-shop.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import {
  OFFER_STATUSES,
  adminLink,
  conditionLines,
  iso,
  loadOffers,
  paginate,
  pagingInput,
  ref,
  rewardLines,
  shopsInput,
  type Paging,
} from "./catalog-shared.server.js";

export const upsellsListInput = {
  shops: shopsInput,
  status: z.array(z.enum(OFFER_STATUSES)).optional().describe("Default: every non-archived status."),
  ...pagingInput,
};

export type UpsellRow = {
  promoRef: string;
  offerId: string;
  shopDomain: string;
  name: string;
  type: "upsell" | "booster";
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  trigger: string[];
  offered: { variantCount: number; productTitles: string[] };
  discounts: string[];
  widgets: { type: string; enabled: boolean; placements: { placementType: string; enabled: boolean }[] }[];
};

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function upsellsList(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[]; status?: string[] } & Paging,
  now: () => Date = () => new Date(),
): Promise<ToolResult<{ upsells: UpsellRow[] }>> {
  const selected = selectShops(visible, args.shops);
  const statuses = args.status?.length ? args.status : [...OFFER_STATUSES];
  const { perShop, results } = await fanOut(selected, async (shop) => {
    const loaded = await loadOffers(db, shop, { types: ["upsell", "booster"], statuses });
    if (loaded.length === 0) return [];
    const offerIds = loaded.map((l) => l.offer.id);
    const targetVariants = (l: (typeof loaded)[number]) =>
      l.rewards.flatMap((r) => {
        const t = (r.target ?? {}) as Record<string, unknown>;
        return ids(t["variantIds"]).concat(typeof t["variantId"] === "string" ? [t["variantId"]] : []);
      });
    const variantIds = [...new Set(loaded.flatMap(targetVariants))];
    const [widgetRows, variants] = await Promise.all([
      db.select().from(widgets).where(and(eq(widgets.shopId, shop.id), inArray(widgets.offerId, offerIds))),
      variantIds.length
        ? db
            .select({ variantGid: variantCache.variantGid, productTitle: productCache.title })
            .from(variantCache)
            .leftJoin(productCache, and(eq(productCache.shopId, variantCache.shopId), eq(productCache.productGid, variantCache.productGid)))
            .where(and(eq(variantCache.shopId, shop.id), inArray(variantCache.variantGid, variantIds)))
        : Promise.resolve([] as { variantGid: string; productTitle: string | null }[]),
    ]);
    const placements = widgetRows.length
      ? await db.select().from(widgetPlacements).where(and(eq(widgetPlacements.shopId, shop.id), inArray(widgetPlacements.widgetId, widgetRows.map((w) => w.id))))
      : [];
    const titleOf = new Map(variants.map((v) => [v.variantGid, v.productTitle]));
    return loaded.map((l): UpsellRow => {
      const targets = [...new Set(targetVariants(l))];
      return {
        promoRef: ref(shop, l.offer.id),
        offerId: l.offer.id,
        shopDomain: shop.myshopifyDomain,
        name: l.offer.internalName,
        type: l.offer.type as "upsell" | "booster",
        status: l.offer.status,
        startsAt: iso(l.offer.startsAt),
        endsAt: iso(l.offer.endsAt),
        trigger: conditionLines(l.conditions),
        offered: {
          variantCount: targets.length,
          productTitles: [...new Set(targets.map((id) => titleOf.get(id)).filter((t): t is string => !!t))],
        },
        discounts: rewardLines(l.rewards),
        widgets: widgetRows
          .filter((w) => w.offerId === l.offer.id)
          .map((w) => ({
            type: w.type,
            enabled: w.isEnabled,
            placements: placements.filter((p) => p.widgetId === w.id).map((p) => ({ placementType: p.placementType, enabled: p.isEnabled })),
          })),
      };
    });
  });

  const all = results.flatMap((r) => r.value);
  const { page, hasMore, cursor } = paginate(all, args);
  const summary = [
    `${all.length} upsell/booster offer${all.length === 1 ? "" : "s"}.`,
    ...page.slice(0, 10).map((u) => `- ${u.name} (${u.type}, ${u.status}) on ${u.shopDomain}: ${u.discounts.join("; ") || "no discount"}, ${u.widgets.length} widget(s)`),
  ].join("\n");

  return buildResult(
    {
      summary,
      data: { upsells: page },
      perShop,
      links: selected.map((s) => adminLink(shopHandle(s.myshopifyDomain))),
      warnings: page
        .filter((u) => u.status === "active" && u.widgets.length === 0)
        .map((u) => ({ code: "UPSELL_WITHOUT_WIDGET", severity: "info" as const, message: `${u.name} (${u.shopDomain}) is active but has no widget.` })),
      nextActions: page.slice(0, 3).map((u) => ({ mcp: "promo-engine" as const, tool: "promo_detail", args: { ref: u.promoRef }, why: "Full definition of this offer.", risk: "read" as const })),
      meta: { page: { ...(cursor ? { cursor } : {}), hasMore } },
    },
    now,
  );
}
