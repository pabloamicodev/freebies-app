import { z } from "zod";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { discountCodeBatches, discountCodes, type Db } from "@promo/db";
import { buildResult, shopHandle, type ToolResult } from "../result.server.js";
import { fanOut } from "../multi-shop.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";
import {
  OFFER_STATUSES,
  adminLink,
  iso,
  loadOffers,
  maskCode,
  nextCursor,
  paginate,
  pageWindow,
  pagingInput,
  ref,
  resolvePromoRef,
  shopsInput,
  type Paging,
} from "./catalog-shared.server.js";

const CODE_STATUSES = ["active", "disabled", "exhausted"] as const;
const SAMPLE_SIZE = 3;

export const codesListInput = {
  shops: shopsInput,
  ref: z.string().optional().describe("promo:<shopHandle>:<offerId>; also lists that offer's individual codes (masked)."),
  status: z.enum(CODE_STATUSES).optional().describe("Filters the individual code rows (ref mode only)."),
  ...pagingInput,
};

export type CodeOfferRow = {
  promoRef: string;
  offerId: string;
  shopDomain: string;
  name: string;
  offerStatus: string;
  mode: "checkout_code" | "automatic";
  requiresCode: boolean;
  totals: { total: number; active: number; disabled: number; exhausted: number; redemptions: number };
  codesEndAt: { earliest: string | null; latest: string | null };
  offerEndsAt: string | null;
  batches: { batchId: string; prefix: string; count: number; createdAt: string }[];
  samplesMasked: string[];
};

export type CodeRow = {
  codeId: string;
  masked: string;
  status: string;
  redemptions: number;
  usageLimit: number | null;
  oncePerCustomer: boolean;
  startsAt: string | null;
  endsAt: string | null;
  batchId: string | null;
  syncedToShopify: boolean;
};

export async function codesList(
  db: Db,
  visible: VisibleShop[],
  args: { shops?: string[]; ref?: string; status?: (typeof CODE_STATUSES)[number] } & Paging,
  now: () => Date = () => new Date(),
): Promise<ToolResult<{ offers: CodeOfferRow[]; codes?: CodeRow[] }>> {
  const target = args.ref ? resolvePromoRef(visible, { ref: args.ref }) : null;
  const selected = target ? [target.shop] : selectShops(visible, args.shops);

  const { perShop, results } = await fanOut(selected, async (shop) => {
    const loaded = await loadOffers(db, shop, { statuses: OFFER_STATUSES, offerId: target?.offerId });
    if (loaded.length === 0) return [];
    const offerIds = loaded.map((l) => l.offer.id);
    const ranked = db
      .select({
        offerId: discountCodes.offerId,
        code: discountCodes.code,
        rn: sql<number>`row_number() over (partition by ${discountCodes.offerId} order by ${discountCodes.code})`.as("rn"),
      })
      .from(discountCodes)
      .where(and(eq(discountCodes.shopId, shop.id), inArray(discountCodes.offerId, offerIds)))
      .as("ranked");
    const [counts, batches, samples] = await Promise.all([
      db
        .select({
          offerId: discountCodes.offerId,
          status: discountCodes.status,
          n: sql<number>`count(*)::int`,
          used: sql<number>`coalesce(sum(${discountCodes.usageCount}), 0)::int`,
          firstEnd: sql<Date | null>`min(${discountCodes.endsAt})`,
          lastEnd: sql<Date | null>`max(${discountCodes.endsAt})`,
        })
        .from(discountCodes)
        .where(and(eq(discountCodes.shopId, shop.id), inArray(discountCodes.offerId, offerIds)))
        .groupBy(discountCodes.offerId, discountCodes.status),
      db
        .select()
        .from(discountCodeBatches)
        .where(and(eq(discountCodeBatches.shopId, shop.id), inArray(discountCodeBatches.offerId, offerIds)))
        .orderBy(desc(discountCodeBatches.createdAt)),
      db
        .select({ offerId: ranked.offerId, code: ranked.code })
        .from(ranked)
        .where(lte(ranked.rn, SAMPLE_SIZE))
        .orderBy(asc(ranked.offerId), asc(ranked.code)),
    ]);
    const toDate = (v: Date | string | null): Date | null => (v ? new Date(v) : null);
    return loaded
      .map((l): CodeOfferRow => {
        const mine = counts.filter((c) => c.offerId === l.offer.id);
        const n = (status: string) => mine.find((c) => c.status === status)?.n ?? 0;
        const ends = mine.flatMap((c) => [toDate(c.firstEnd), toDate(c.lastEnd)]).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());
        return {
          promoRef: ref(shop, l.offer.id),
          offerId: l.offer.id,
          shopDomain: shop.myshopifyDomain,
          name: l.offer.internalName,
          offerStatus: l.offer.status,
          mode: l.offer.codeRedemption,
          requiresCode: l.offer.requiresCode,
          totals: {
            total: mine.reduce((s, c) => s + c.n, 0),
            active: n("active"),
            disabled: n("disabled"),
            exhausted: n("exhausted"),
            redemptions: mine.reduce((s, c) => s + c.used, 0),
          },
          codesEndAt: { earliest: iso(ends[0]), latest: iso(ends[ends.length - 1]) },
          offerEndsAt: iso(l.offer.endsAt),
          batches: batches
            .filter((b) => b.offerId === l.offer.id)
            .map((b) => ({ batchId: b.id, prefix: b.prefix, count: b.count, createdAt: b.createdAt.toISOString() })),
          samplesMasked: samples.filter((s) => s.offerId === l.offer.id).slice(0, SAMPLE_SIZE).map((s) => maskCode(s.code)),
        };
      })
      .filter((row) => row.requiresCode || row.totals.total > 0);
  });

  const all = results.flatMap((r) => r.value);

  if (target) {
    const shop = target.shop;
    const { offset, limit } = pageWindow(args);
    const rows = await db
      .select()
      .from(discountCodes)
      .where(and(eq(discountCodes.shopId, shop.id), eq(discountCodes.offerId, target.offerId), args.status ? eq(discountCodes.status, args.status) : undefined))
      .orderBy(desc(discountCodes.createdAt), asc(discountCodes.code))
      .limit(limit + 1)
      .offset(offset);
    const hasMore = rows.length > limit;
    const codes = rows.slice(0, limit).map((c): CodeRow => ({
      codeId: c.id,
      masked: maskCode(c.code),
      status: c.status,
      redemptions: c.usageCount,
      usageLimit: c.usageLimit,
      oncePerCustomer: c.oncePerCustomer,
      startsAt: iso(c.startsAt),
      endsAt: iso(c.endsAt),
      batchId: c.batchId,
      syncedToShopify: c.shopifySyncedAt !== null,
    }));
    return buildResult(
      {
        summary: all[0] ? summaryFor(all) : "No code offer found for that ref.",
        data: { offers: all, codes },
        perShop,
        links: [adminLink(shopHandle(shop.myshopifyDomain))],
        meta: { page: { ...(hasMore ? { cursor: nextCursor(offset + limit) } : {}), hasMore } },
      },
      now,
    );
  }

  const { page, hasMore, cursor } = paginate(all, args);
  return buildResult(
    {
      summary: summaryFor(page),
      data: { offers: page },
      perShop,
      links: selected.map((s) => adminLink(shopHandle(s.myshopifyDomain))),
      warnings: page
        .filter((o) => o.offerStatus === "active" && o.requiresCode && o.totals.active === 0 && o.mode === "checkout_code")
        .map((o) => ({ code: "CODE_OFFER_INERT", severity: "warn" as const, message: `${o.name} (${o.shopDomain}) needs a code but has no active codes, so nothing can redeem it.` })),
      nextActions: page.slice(0, 3).map((o) => ({ mcp: "promo-engine" as const, tool: "codes_list", args: { ref: o.promoRef }, why: "List this offer's codes (masked).", risk: "read" as const })),
      meta: { page: { ...(cursor ? { cursor } : {}), hasMore } },
    },
    now,
  );
}

function summaryFor(rows: CodeOfferRow[]): string {
  return [
    `${rows.length} code offer${rows.length === 1 ? "" : "s"} (codes are always masked).`,
    ...rows.slice(0, 10).map((o) => `- ${o.name} (${o.mode}) on ${o.shopDomain}: ${o.totals.total} codes, ${o.totals.active} active, ${o.totals.redemptions} redemptions`),
  ].join("\n");
}
