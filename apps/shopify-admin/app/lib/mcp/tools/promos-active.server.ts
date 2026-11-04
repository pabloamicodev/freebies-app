import { z } from "zod";
import type { Db } from "@promo/db";
import { buildResult, shopHandle, type ToolResult } from "../result.server.js";
import { fanOut } from "../multi-shop.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import {
  OFFER_STATUSES,
  OFFER_TYPES,
  adminLink,
  combinesWith,
  conditionLines,
  getOfferPublishErrors,
  iso,
  loadOffers,
  paginate,
  pagingInput,
  ref,
  rewardLines,
  shopsInput,
  subtypeOf,
  type Paging,
} from "./catalog-shared.server.js";

export const promosActiveInput = {
  shops: shopsInput,
  types: z.array(z.enum(OFFER_TYPES)).optional().describe("Offer types to include; omitted = all."),
  status: z.array(z.enum(OFFER_STATUSES)).optional().describe("Default: active and scheduled."),
  q: z.string().max(100).optional().describe("Substring of the offer name or public title."),
  ...pagingInput,
};

export type PromoRow = {
  promoRef: string;
  offerId: string;
  shopDomain: string;
  name: string;
  publicTitle: string;
  type: string;
  subtype: string | null;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  shopTimezone: string;
  priority: number;
  requiresCode: boolean;
  rewardsSummary: string[];
  conditionsSummary: string[];
  combinesWith: ReturnType<typeof combinesWith>;
  publishErrors: string[];
};

export async function promosActive(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[]; types?: string[]; status?: string[]; q?: string } & Paging,
  now: () => Date = () => new Date(),
): Promise<ToolResult<{ promos: PromoRow[] }>> {
  const selected = selectShops(visible, args.shops);
  const statuses = args.status?.length ? args.status : ["active", "scheduled"];
  const { perShop, results } = await fanOut(selected, async (shop) => {
    const [loaded, errors] = await Promise.all([
      loadOffers(db, shop, { types: args.types, statuses, q: args.q }),
      getOfferPublishErrors(shop.id, db),
    ]);
    return loaded.map((l): PromoRow => ({
      promoRef: ref(shop, l.offer.id),
      offerId: l.offer.id,
      shopDomain: shop.myshopifyDomain,
      name: l.offer.internalName,
      publicTitle: l.offer.publicTitle,
      type: l.offer.type,
      subtype: subtypeOf(l),
      status: l.offer.status,
      startsAt: iso(l.offer.startsAt),
      endsAt: iso(l.offer.endsAt),
      shopTimezone: l.offer.timezone ?? shop.timezone,
      priority: l.offer.priority,
      requiresCode: l.offer.requiresCode,
      rewardsSummary: rewardLines(l.rewards),
      conditionsSummary: conditionLines(l.conditions),
      combinesWith: combinesWith(l.policy),
      publishErrors: errors[l.offer.id] ? [errors[l.offer.id]!] : [],
    }));
  });

  const all = results.flatMap((r) => r.value);
  const { page, hasMore, cursor } = paginate(all, args);
  const byStatus = new Map<string, number>();
  for (const row of all) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);

  const summary = [
    `${all.length} offer${all.length === 1 ? "" : "s"} across ${selected.length} shop${selected.length === 1 ? "" : "s"} (${[...byStatus].map(([s, n]) => `${n} ${s}`).join(", ") || "none"}).`,
    ...page.slice(0, 10).map((r) => `- ${r.name} (${r.type}, ${r.status}) on ${r.shopDomain}: ${r.rewardsSummary.join("; ") || "no rewards"}`),
    hasMore ? "More results: pass meta.page.cursor." : "",
  ].filter(Boolean).join("\n");

  return buildResult(
    {
      summary,
      data: { promos: page },
      perShop,
      links: selected.map((s) => adminLink(shopHandle(s.myshopifyDomain))),
      warnings: page
        .filter((r) => r.publishErrors.length)
        .map((r) => ({ code: "PUBLISH_ERROR", severity: "warn" as const, message: `${r.name} (${r.shopDomain}) has a publish error; see promo_detail ${r.promoRef}.` })),
      nextActions: page.slice(0, 3).map((r) => ({
        mcp: "promo-engine" as const, tool: "promo_detail", args: { ref: r.promoRef }, why: "Full definition of this offer.", risk: "read" as const,
      })),
      meta: { page: { ...(cursor ? { cursor } : {}), hasMore } },
    },
    now,
  );
}
