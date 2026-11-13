/**
 * CSV export builders shared by the admin routes (api.offers.export, api.offers.$id.export) and the MCP
 * `offers_export_csv` tool, so both emit the same columns. The import page reads this same format back.
 */

import { and, eq, inArray } from "drizzle-orm";
import { offerConditions, offerRewards, offers, type Db, type Offer } from "@promo/db";
import { rowToCSV } from "./csv.js";

export const OFFER_CSV_HEADERS = [
  "offer_id", "internal_name", "public_title", "type", "status",
  "priority", "starts_at", "ends_at", "discount_tags", "requires_code", "code_redemption",
  "condition_type", "condition_value_threshold_cents",
  "reward_type", "discount_type", "reward_value",
  "gift_variant_gids", "gift_quantity", "is_auto_add", "track_mode",
  "gift_tier_mode", "gift_min_cart_subtotal_cents", "gift_fallback_variant_gids", "shop_currency_code",
  "created_at", "updated_at",
] as const;

export type OfferCsvExport = {
  csv: string;
  /** Offers that made it into the CSV. */
  offerCount: number;
  /** Data rows (an offer yields one row per reward, or one row when it has none). */
  rowCount: number;
  /** True when `maxBytes` stopped the export before every matching offer was written. */
  truncated: boolean;
  /** Offers matched by the filter, whether or not they fit. */
  matchedOffers: number;
};

export type OfferCsvExportOptions = {
  /** Only these offers (still scoped to the shop); omitted = every offer of the shop, every status. */
  offerIds?: string[];
  /** Stops at an offer boundary once the CSV would exceed this many characters. */
  maxBytes?: number;
};

export async function exportOffersCsv(
  db: Db,
  shop: { shopId: string; shopCurrency: string },
  options: OfferCsvExportOptions = {},
): Promise<OfferCsvExport> {
  const { shopId, shopCurrency } = shop;
  const { offerIds: wanted, maxBytes } = options;

  const offerRows: Offer[] =
    wanted === undefined
      ? await db.select().from(offers).where(eq(offers.shopId, shopId))
      : wanted.length === 0
        ? []
        : await db.select().from(offers).where(and(eq(offers.shopId, shopId), inArray(offers.id, wanted)));

  const offerIds = offerRows.map((offer) => offer.id);
  const [allConditions, allRewards] = offerIds.length
    ? await Promise.all([
        db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), inArray(offerConditions.offerId, offerIds))),
        db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), inArray(offerRewards.offerId, offerIds))),
      ])
    : [[], []];
  const rewardsByOfferId = new Map<string, typeof allRewards>();
  const mainConditionByOfferId = new Map<string, (typeof allConditions)[number]>();

  for (const condition of allConditions) {
    if (condition.scope === "main" && !mainConditionByOfferId.has(condition.offerId)) {
      mainConditionByOfferId.set(condition.offerId, condition);
    }
  }
  for (const reward of allRewards) {
    const group = rewardsByOfferId.get(reward.offerId);
    if (group) group.push(reward);
    else rewardsByOfferId.set(reward.offerId, [reward]);
  }

  const lines: string[] = [rowToCSV([...OFFER_CSV_HEADERS])];
  let size = lines[0]!.length;
  let rowCount = 0;
  let offerCount = 0;
  let truncated = false;

  for (const offer of offerRows) {
    const rewards = rewardsByOfferId.get(offer.id) ?? [];
    const mainCondition = mainConditionByOfferId.get(offer.id);
    const condValue = (mainCondition?.value ?? {}) as Record<string, unknown>;
    const offerLines: string[] = [];

    for (const reward of rewards.length > 0 ? rewards : [null]) {
      const rewardTarget = (reward?.target ?? {}) as Record<string, unknown>;
      const rewardValue = (reward?.value ?? {}) as Record<string, unknown>;
      const giftVariantIds = (rewardTarget["variantIds"] as string[]) ?? [];

      offerLines.push(rowToCSV([
        offer.id,
        offer.internalName,
        offer.publicTitle,
        offer.type,
        offer.status,
        offer.priority,
        offer.startsAt?.toISOString() ?? "",
        offer.endsAt?.toISOString() ?? "",
        (offer.discountTags ?? []).join("|"),
        offer.requiresCode || Boolean(offer.requiredDiscountCode),
        offer.codeRedemption,
        mainCondition?.conditionType ?? "",
        condValue["thresholdCents"] ?? "",
        reward?.rewardType ?? "",
        reward?.discountType ?? "",
        rewardValue["amount"] ?? rewardValue["percentage"] ?? "",
        giftVariantIds.join("|"),
        reward?.quantity ?? "",
        reward?.isAutoAdd ?? "",
        reward?.trackMode ?? "",
        reward?.minCartSubtotalCents != null ? (offer.tierMode ?? "cumulative") : "",
        reward?.minCartSubtotalCents ?? "",
        ((rewardTarget["fallbackVariantIds"] as string[] | undefined) ?? []).join("|"),
        shopCurrency,
        offer.createdAt.toISOString(),
        offer.updatedAt.toISOString(),
      ]));
    }

    const offerSize = offerLines.reduce((sum, line) => sum + line.length + 1, 0);
    if (maxBytes !== undefined && size + offerSize > maxBytes) {
      truncated = true;
      break;
    }
    lines.push(...offerLines);
    size += offerSize;
    rowCount += offerLines.length;
    offerCount += 1;
  }

  return { csv: lines.join("\n"), offerCount, rowCount, truncated, matchedOffers: offerRows.length };
}
