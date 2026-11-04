import { z } from "zod";
import { and, asc, eq, inArray } from "drizzle-orm";
import { bundleDefinitions, bundleSteps, bundleTiers, type Db } from "@promo/db";
import { buildResult, shopHandle, type ToolResult } from "../result.server.js";
import { fanOut } from "../multi-shop.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import {
  OFFER_STATUSES,
  adminLink,
  iso,
  loadOffers,
  paginate,
  pagingInput,
  ref,
  rewardLines,
  shopsInput,
  type Paging,
} from "./catalog-shared.server.js";

export const bundlesListInput = {
  shops: shopsInput,
  status: z.array(z.enum(OFFER_STATUSES)).optional().describe("Default: every non-archived status."),
  ...pagingInput,
};

export type BundleRow = {
  promoRef: string;
  offerId: string;
  bundleId: string | null;
  shopDomain: string;
  name: string;
  status: string;
  bundleType: string | null;
  title: string | null;
  layoutMode: string | null;
  pageHeading: string | null;
  createsBundleProduct: boolean;
  startsAt: string | null;
  endsAt: string | null;
  discounts: string[];
  steps: { title: string; sourceType: string; minQuantity: number | null; maxQuantity: number | null }[];
  tiers: { label: string; minQuantity: number; maxQuantity: number | null; discountType: string; value: unknown }[];
};

export async function bundlesList(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[]; status?: string[] } & Paging,
  now: () => Date = () => new Date(),
): Promise<ToolResult<{ bundles: BundleRow[] }>> {
  const selected = selectShops(visible, args.shops);
  const statuses = args.status?.length ? args.status : [...OFFER_STATUSES];
  const { perShop, results } = await fanOut(selected, async (shop) => {
    const loaded = await loadOffers(db, shop, { types: ["bundle"], statuses });
    if (loaded.length === 0) return [];
    const defs = await db
      .select()
      .from(bundleDefinitions)
      .where(and(eq(bundleDefinitions.shopId, shop.id), inArray(bundleDefinitions.offerId, loaded.map((l) => l.offer.id))));
    const defIds = defs.map((d) => d.id);
    const [steps, tiers] = defIds.length
      ? await Promise.all([
          db.select().from(bundleSteps).where(and(eq(bundleSteps.shopId, shop.id), inArray(bundleSteps.bundleId, defIds))).orderBy(asc(bundleSteps.sortOrder)),
          db.select().from(bundleTiers).where(and(eq(bundleTiers.shopId, shop.id), inArray(bundleTiers.bundleId, defIds))).orderBy(asc(bundleTiers.sortOrder), asc(bundleTiers.minQuantity)),
        ])
      : [[], []];
    return loaded.map((l): BundleRow => {
      const def = defs.find((d) => d.offerId === l.offer.id);
      return {
        promoRef: ref(shop, l.offer.id),
        offerId: l.offer.id,
        bundleId: def?.id ?? null,
        shopDomain: shop.myshopifyDomain,
        name: l.offer.internalName,
        status: l.offer.status,
        bundleType: def?.bundleType ?? null,
        title: def?.title ?? null,
        layoutMode: def?.layoutMode ?? null,
        pageHeading: def?.pageHeading ?? null,
        createsBundleProduct: def?.createBundleProduct ?? false,
        startsAt: iso(l.offer.startsAt),
        endsAt: iso(l.offer.endsAt),
        discounts: rewardLines(l.rewards),
        steps: steps
          .filter((s) => s.bundleId === def?.id)
          .map((s) => ({ title: s.title, sourceType: s.sourceType, minQuantity: s.minQuantity, maxQuantity: s.maxQuantity })),
        tiers: tiers
          .filter((t) => t.bundleId === def?.id)
          .map((t) => ({ label: t.label, minQuantity: t.minQuantity, maxQuantity: t.maxQuantity, discountType: t.discountType, value: t.value })),
      };
    });
  });

  const all = results.flatMap((r) => r.value);
  const { page, hasMore, cursor } = paginate(all, args);
  const summary = [
    `${all.length} bundle${all.length === 1 ? "" : "s"}.`,
    ...page.slice(0, 10).map((b) => `- ${b.name} (${b.bundleType ?? "no definition"}, ${b.status}) on ${b.shopDomain}: ${b.steps.length} step(s), ${b.tiers.length} tier(s)`),
  ].join("\n");

  return buildResult(
    {
      summary,
      data: { bundles: page },
      perShop,
      links: selected.map((s) => adminLink(shopHandle(s.myshopifyDomain))),
      warnings: page
        .filter((b) => b.status === "active" && b.bundleId === null)
        .map((b) => ({ code: "BUNDLE_WITHOUT_DEFINITION", severity: "warn" as const, message: `${b.name} (${b.shopDomain}) is active but has no bundle definition.` })),
      nextActions: page.slice(0, 3).map((b) => ({ mcp: "promo-engine" as const, tool: "promo_detail", args: { ref: b.promoRef }, why: "Full definition of this bundle offer.", risk: "read" as const })),
      meta: { page: { ...(cursor ? { cursor } : {}), hasMore } },
    },
    now,
  );
}
