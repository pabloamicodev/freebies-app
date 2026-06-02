/**
 * CSV export endpoint for a single offer or all offers.
 * GET /api/offers/:id/export → single offer CSV
 * GET /api/offers/export → all active offers CSV
 */

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server.js";
import { getDb } from "@promo/db";
import { offers, offerConditions, offerRewards } from "@promo/db";
import { eq, and } from "drizzle-orm";

function escapeCSV(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowToCSV(row: unknown[]): string {
  return row.map(escapeCSV).join(",");
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const db = getDb();
  const offerId = params["id"];

  const shopRows = await db
    .select({ id: (await import("@promo/db")).shops.id })
    .from((await import("@promo/db")).shops)
    .where(eq((await import("@promo/db")).shops.myshopifyDomain, session.shop))
    .limit(1);
  const shopId = shopRows[0]?.id ?? "";

  const offerRows = offerId
    ? await db.select().from(offers).where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)))
    : await db.select().from(offers).where(eq(offers.shopId, shopId));

  const allConditions = await db.select().from(offerConditions).where(eq(offerConditions.shopId, shopId));
  const allRewards = await db.select().from(offerRewards).where(eq(offerRewards.shopId, shopId));

  const headers = [
    "offer_id", "internal_name", "public_title", "type", "status",
    "priority", "starts_at", "ends_at", "discount_tags",
    "condition_type", "condition_value_threshold_cents",
    "reward_type", "discount_type", "reward_value",
    "gift_variant_gids", "gift_quantity", "is_auto_add", "track_mode",
    "created_at", "updated_at",
  ];

  const rows: string[] = [rowToCSV(headers)];

  for (const offer of offerRows) {
    const conditions = allConditions.filter((c) => c.offerId === offer.id);
    const rewards = allRewards.filter((r) => r.offerId === offer.id);

    const mainCondition = conditions.find((c) => c.scope === "main");
    const condValue = (mainCondition?.value ?? {}) as Record<string, unknown>;

    for (const reward of rewards.length > 0 ? rewards : [null]) {
      const rewardTarget = (reward?.target ?? {}) as Record<string, unknown>;
      const rewardValue = (reward?.value ?? {}) as Record<string, unknown>;
      const giftVariantIds = (rewardTarget["variantIds"] as string[]) ?? [];

      rows.push(rowToCSV([
        offer.id,
        offer.internalName,
        offer.publicTitle,
        offer.type,
        offer.status,
        offer.priority,
        offer.startsAt?.toISOString() ?? "",
        offer.endsAt?.toISOString() ?? "",
        (offer.discountTags ?? []).join("|"),
        mainCondition?.conditionType ?? "",
        condValue["thresholdCents"] ?? "",
        reward?.rewardType ?? "",
        reward?.discountType ?? "",
        rewardValue["amount"] ?? rewardValue["percentage"] ?? "",
        giftVariantIds.join("|"),
        reward?.quantity ?? "",
        reward?.isAutoAdd ?? "",
        reward?.trackMode ?? "",
        offer.createdAt.toISOString(),
        offer.updatedAt.toISOString(),
      ]));
    }
  }

  const csv = rows.join("\n");
  const filename = offerId ? `offer-${offerId.slice(0, 8)}.csv` : `all-offers-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
