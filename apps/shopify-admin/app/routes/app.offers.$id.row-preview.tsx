/**
 * Lightweight resource route backing the offers-list row preview: conditions,
 * rewards (with resolved product images), and any URLs the offer depends on.
 * Deliberately kept out of the list loader (app.offers._index.tsx) so paging/
 * sorting/filtering the list never pays for this — it's only fetched when a
 * row is hovered or expanded.
 */
import { and, eq, inArray, count } from "drizzle-orm";
import { offerConditions, offerRewards, offerCombinationPolicies, productCache, variantCache, widgets, analyticsEvents } from "@promo/db";
import { getShopContext } from "../lib/shop-context.server.js";
import { loadOwnedOffer } from "../lib/owned-offer.server.js";
import { conditionSummary, targetSummaryParts, collectGids, urlsFromCondition, rewardHeadline } from "../lib/offer-summaries.js";
import type { LoaderFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const MAX_PRODUCTS_PER_REWARD = 4;

const WIDGET_TYPE_LABEL: Record<string, string> = {
  gift_slider: "Gift slider",
  gift_popup: "Gift popup",
  cart_message: "Cart message",
  today_offer_widget: "Today offer widget",
  today_offer_block: "Today offer block",
  progress_bar: "Progress bar",
  gift_icon: "Gift icon",
  gift_thumbnail: "Gift thumbnail",
  classic_bundle: "Classic bundle",
  mix_match_bundle: "Mix & match bundle",
  bundle_page: "Bundle page",
  checkout_upsell: "Checkout upsell",
  fbt: "Frequently bought together",
  thank_you_upsell: "Thank-you page upsell",
  volume_discount: "Volume discount",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shopId, db } = await getShopContext(request);
  const offerId = params["id"]!;
  const offer = await loadOwnedOffer(db, shopId, offerId);

  const [conditionRows, rewardRows, policyRows, widgetRows, redemptionRows] = await Promise.all([
    db.select().from(offerConditions).where(and(eq(offerConditions.shopId, shopId), eq(offerConditions.offerId, offerId))),
    db.select().from(offerRewards).where(and(eq(offerRewards.shopId, shopId), eq(offerRewards.offerId, offerId))),
    db.select().from(offerCombinationPolicies).where(and(eq(offerCombinationPolicies.shopId, shopId), eq(offerCombinationPolicies.offerId, offerId))).limit(1),
    db.select({ type: widgets.type, isEnabled: widgets.isEnabled }).from(widgets).where(and(eq(widgets.shopId, shopId), eq(widgets.offerId, offerId))),
    // Redemption count only — `properties.total_price_cents` is the whole
    // order's total, not the amount this offer discounted, so it's not
    // meaningful to sum here (see analytics-reconcile.server.ts).
    db.select({ total: count() }).from(analyticsEvents).where(and(
      eq(analyticsEvents.shopId, shopId),
      eq(analyticsEvents.offerId, offerId),
      eq(analyticsEvents.eventName, "order_placed_attributed"),
    )),
  ]);
  const redemptionCount = redemptionRows[0]?.total ?? 0;

  // Resolve every variant/product GID any reward targets into a title + image,
  // in two round trips total regardless of how many rewards reference them.
  const allGids = [...new Set(rewardRows.flatMap((r) => collectGids(r.target)))];
  const variantRows = allGids.length > 0
    ? await db.select({ variantGid: variantCache.variantGid, productGid: variantCache.productGid })
        .from(variantCache)
        .where(and(eq(variantCache.shopId, shopId), inArray(variantCache.variantGid, allGids)))
    : [];
  const productGidByVariantGid = new Map(variantRows.map((v) => [v.variantGid, v.productGid]));
  const directProductGids = allGids.filter((gid) => gid.includes("/Product/"));
  const productGids = [...new Set([...directProductGids, ...variantRows.map((v) => v.productGid)])];
  const productRows = productGids.length > 0
    ? await db.select({ productGid: productCache.productGid, title: productCache.title, imageUrl: productCache.imageUrl })
        .from(productCache)
        .where(and(eq(productCache.shopId, shopId), inArray(productCache.productGid, productGids)))
    : [];
  const productByGid = new Map(productRows.map((p) => [p.productGid, p]));

  const conditions = conditionRows
    .sort((a, b) => (a.scope === b.scope ? a.sortOrder - b.sortOrder : a.scope === "main" ? -1 : 1))
    .map((c) => ({
      id: c.id,
      scope: c.scope,
      conditionType: c.conditionType,
      isEnabled: c.isEnabled,
      summary: conditionSummary(c.conditionType, c.value),
    }));

  const urls = [...new Set(conditionRows.flatMap((c) => urlsFromCondition(c.conditionType, c.value)))];

  const rewards = rewardRows
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => {
      const gids = collectGids(r.target);
      const productGidsForReward = [...new Set(
        gids.map((gid) => (gid.includes("/Product/") ? gid : productGidByVariantGid.get(gid))).filter((gid): gid is string => Boolean(gid)),
      )];
      const products = productGidsForReward
        .slice(0, MAX_PRODUCTS_PER_REWARD)
        .map((gid) => productByGid.get(gid))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .map((p) => ({ title: p.title, imageUrl: p.imageUrl }));
      return {
        id: r.id,
        rewardType: r.rewardType,
        discountType: r.discountType,
        label: r.label,
        summary: targetSummaryParts(r.target).join(" · "),
        productCount: productGidsForReward.length,
        products,
      };
    });

  const widgetSummaries = [...new Map(widgetRows.map((w) => [w.type, w])).values()]
    .map((w) => ({ type: w.type, label: WIDGET_TYPE_LABEL[w.type] ?? w.type, isEnabled: w.isEnabled }));

  return {
    offer: {
      id: offer.id,
      internalName: offer.internalName,
      publicTitle: offer.publicTitle,
      type: offer.type,
      priority: offer.priority,
      startsAt: offer.startsAt?.toISOString() ?? null,
      endsAt: offer.endsAt?.toISOString() ?? null,
    },
    headline: rewardRows[0] ? rewardHeadline(rewardRows[0]) : null,
    conditions,
    rewards,
    urls,
    widgets: widgetSummaries,
    redemptionCount,
    combinationPolicy: policyRows[0]
      ? {
          combinesWithOrderDiscounts: policyRows[0].combinesWithOrderDiscounts,
          combinesWithProductDiscounts: policyRows[0].combinesWithProductDiscounts,
          combinesWithShippingDiscounts: policyRows[0].combinesWithShippingDiscounts,
        }
      : null,
  };
};
