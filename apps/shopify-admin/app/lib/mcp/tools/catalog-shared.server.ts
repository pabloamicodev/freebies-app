import { z } from "zod";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import {
  bundleDefinitions,
  offerCombinationPolicies,
  offerConditions,
  offerRewards,
  offers,
  type Db,
  type Offer,
  type OfferCombinationPolicy,
  type OfferCondition,
  type OfferReward,
} from "@promo/db";
import { conditionSummary, conditionTypeLabel, rewardSummary } from "../../offer-summaries.js";
import { getOfferPublishErrors } from "../../offer-publish-errors.server.js";
import { ToolError, parsePromoRef, promoRef, shopHandle } from "../result.server.js";
import type { ShopRef } from "../multi-shop.server.js";
import { selectShops, type VisibleShop } from "../shops.server.js";

export const OFFER_STATUSES = ["active", "scheduled", "paused", "draft"] as const;
export type OfferStatusFilter = (typeof OFFER_STATUSES)[number];
export const OFFER_TYPES = ["gift", "bundle", "upsell", "discount", "booster"] as const;

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export const shopsInput = z.array(z.string()).optional().describe("Shop domains, handles or ids; omitted = every visible shop.");
export const pagingInput = {
  cursor: z.string().optional().describe("Opaque cursor from the previous page's meta.page.cursor."),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Page size, 1-100 (default 25)."),
};

export type Paging = { cursor?: string; limit?: number };

export function pageWindow(paging: Paging): { offset: number; limit: number } {
  const limit = Math.min(Math.max(paging.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  let offset = 0;
  if (paging.cursor) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(paging.cursor, "base64url").toString("utf8"));
      const value = (parsed as { o?: unknown } | null)?.o;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("bad");
      offset = value;
    } catch {
      throw new ToolError("VALIDATION", "Invalid cursor: use meta.page.cursor from the previous response.");
    }
  }
  return { offset, limit };
}

export function nextCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

export function paginate<T>(rows: T[], paging: Paging): { page: T[]; hasMore: boolean; cursor?: string } {
  const { offset, limit } = pageWindow(paging);
  const page = rows.slice(offset, offset + limit);
  const hasMore = offset + limit < rows.length;
  return { page, hasMore, ...(hasMore ? { cursor: nextCursor(offset + limit) } : {}) };
}

export function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** `AB••••12`: the real value never leaves the server (admin-only reveal is intentionally not offered). */
export function maskCode(code: string): string {
  const value = code.trim();
  if (value.length >= 6) return `${value.slice(0, 2)}••••${value.slice(-2)}`;
  if (value.length >= 3) return `${value.slice(0, 1)}••••`;
  return "••••";
}

export function adminLink(handle: string, label = `${handle} admin`) {
  return { label, url: `https://admin.shopify.com/store/${handle}` };
}

export function likePattern(q: string): string {
  return `%${q.trim().replace(/[\\%_]/g, "\\$&")}%`;
}

export type LoadedOffer = {
  offer: Offer;
  conditions: OfferCondition[];
  rewards: OfferReward[];
  policy: OfferCombinationPolicy | null;
  bundleType: string | null;
};

export type OfferFilter = {
  types?: readonly string[];
  statuses?: readonly string[];
  q?: string;
  offerId?: string;
};

/** Offers of one shop with their conditions, rewards, policy and bundle type; always scoped by shop id. */
export async function loadOffers(db: Db, shop: ShopRef, filter: OfferFilter): Promise<LoadedOffer[]> {
  const where = [eq(offers.shopId, shop.id)];
  if (filter.offerId) where.push(eq(offers.id, filter.offerId));
  if (filter.types?.length) where.push(inArray(offers.type, filter.types as (typeof OFFER_TYPES)[number][]));
  if (filter.statuses?.length) where.push(inArray(offers.status, filter.statuses as OfferStatusFilter[]));
  if (filter.q?.trim()) {
    const pattern = likePattern(filter.q);
    where.push(or(ilike(offers.internalName, pattern), ilike(offers.publicTitle, pattern))!);
  }
  const rows = await db.select().from(offers).where(and(...where)).orderBy(asc(offers.priority), asc(offers.internalName));
  if (rows.length === 0) return [];
  const ids = rows.map((o) => o.id);
  const [conditions, rewards, policies, bundles] = await Promise.all([
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shop.id), inArray(offerConditions.offerId, ids))).orderBy(asc(offerConditions.sortOrder)),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shop.id), inArray(offerRewards.offerId, ids))).orderBy(asc(offerRewards.sortOrder)),
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shop.id), inArray(offerCombinationPolicies.offerId, ids))),
    db.select({ offerId: bundleDefinitions.offerId, bundleType: bundleDefinitions.bundleType }).from(bundleDefinitions).where(and(eq(bundleDefinitions.shopId, shop.id), inArray(bundleDefinitions.offerId, ids))),
  ]);
  return rows.map((offer) => ({
    offer,
    conditions: conditions.filter((c) => c.offerId === offer.id),
    rewards: rewards.filter((r) => r.offerId === offer.id),
    policy: policies.find((p) => p.offerId === offer.id) ?? null,
    bundleType: bundles.find((b) => b.offerId === offer.id)?.bundleType ?? null,
  }));
}

export { getOfferPublishErrors };

/** The shared summary line for a condition; discount codes are masked, never printed. */
export function safeConditionSummary(c: Pick<OfferCondition, "conditionType" | "value" | "operator">): string {
  if (c.conditionType === "discount_code") {
    const code = (c.value as { code?: unknown } | null)?.code;
    return `code: ${typeof code === "string" && code ? maskCode(code) : "?"}`;
  }
  return conditionSummary(c.conditionType, c.value, c.operator);
}

export function conditionLines(conditions: OfferCondition[]): string[] {
  return conditions
    .filter((c) => c.isEnabled)
    .map((c) => `${conditionTypeLabel(c.conditionType)}: ${safeConditionSummary(c)}`);
}

export function rewardLines(rewards: OfferReward[]): string[] {
  return rewards.map((r) => rewardSummary(r));
}

export function combinesWith(policy: OfferCombinationPolicy | null) {
  return {
    orderDiscounts: policy?.combinesWithOrderDiscounts ?? true,
    productDiscounts: policy?.combinesWithProductDiscounts ?? true,
    shippingDiscounts: policy?.combinesWithShippingDiscounts ?? true,
    otherAppOffers: policy?.combinesWithOtherAppOffers ?? true,
    stopLowerPriority: policy?.stopLowerPriority ?? false,
  };
}

export function subtypeOf(l: LoadedOffer): string | null {
  return l.bundleType ?? l.rewards[0]?.rewardType ?? null;
}

export function resolvePromoRef(
  visible: VisibleShop[],
  args: { ref?: string; offerId?: string; shop?: string },
): { shop: VisibleShop; offerId: string } {
  const UUID = /^[0-9a-f-]{36}$/i;
  if (args.ref) {
    const parsed = parsePromoRef(args.ref);
    if (parsed) {
      const [shop] = selectShops(visible, [parsed.shopHandle]);
      return { shop: shop!, offerId: parsed.offerId };
    }
    if (UUID.test(args.ref) && args.shop) {
      const [shop] = selectShops(visible, [args.shop]);
      return { shop: shop!, offerId: args.ref };
    }
    throw new ToolError("VALIDATION", "ref must be promo:<shopHandle>:<offerId>, or an offerId together with shop.");
  }
  if (args.offerId && args.shop && UUID.test(args.offerId)) {
    const [shop] = selectShops(visible, [args.shop]);
    return { shop: shop!, offerId: args.offerId };
  }
  throw new ToolError("VALIDATION", "Pass ref (promo:<shopHandle>:<offerId>), or offerId together with shop.");
}

export function ref(shop: ShopRef, offerId: string): string {
  return promoRef(shop.myshopifyDomain, offerId);
}

export { shopHandle };
