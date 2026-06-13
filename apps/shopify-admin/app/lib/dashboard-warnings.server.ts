/**
 * Dashboard warnings — detect configuration issues that need merchant attention.
 * Shown prominently in the admin dashboard.
 */

import { getDb, offers, offerRewards, productCache, appSettings, variantCache } from "@promo/db";
import { eq, and, count, inArray } from "drizzle-orm";

export interface DashboardWarning {
  code: string;
  severity: "error" | "warning" | "info";
  title: string;
  message: string;
  action?: { label: string; url: string };
}

export async function getDashboardWarnings(shopId: string, _shopDomain: string): Promise<DashboardWarning[]> {
  const db = getDb();
  const warnings: DashboardWarning[] = [];

  // ── 1. Scripts sunset warning (always show until June 30, 2026) ──────────────
  const now = new Date();
  const scriptsDeadline = new Date("2026-06-30T23:59:59Z");
  if (now < scriptsDeadline) {
    const daysLeft = Math.ceil((scriptsDeadline.getTime() - now.getTime()) / 86400000);
    warnings.push({
      code: "scripts_sunset",
      severity: daysLeft < 30 ? "error" : "warning",
      title: `Shopify Scripts sunset in ${daysLeft} days`,
      message: `Scripts stop executing on June 30, 2026. If BOGOS used Scripts, they must be migrated to Discount Functions before cutover.`,
      action: { label: "View Migration Guide", url: "/app/migration" },
    });
  }

  // ── 2. App embed disabled check ───────────────────────────────────────────────
  const [embedSetting] = await db.select({ value: appSettings.value })
    .from(appSettings)
    .where(and(eq(appSettings.shopId, shopId), eq(appSettings.key, "app.embed_verified")))
    .limit(1);

  if (!embedSetting) {
    warnings.push({
      code: "app_embed_not_verified",
      severity: "warning",
      title: "App embed status unknown",
      message: "The promo engine app embed may not be enabled in your theme. Gifts and widgets won't display until it's enabled.",
      action: { label: "Go to Installation", url: "/app/settings/installation" },
    });
  }

  // ── 3. Active offers with OOS gifts ──────────────────────────────────────────
  const activeOffers = await db.select({ id: offers.id, internalName: offers.internalName })
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.status, "active")));
  const activeOfferById = new Map(activeOffers.map((offer) => [offer.id, offer]));

  if (activeOffers.length > 0) {
    const rewards = await db.select().from(offerRewards)
      .where(eq(offerRewards.shopId, shopId));

    const giftVariantChecks = rewards.flatMap((reward) => {
      if (reward.rewardType !== "product_gift") return [];
      const target = reward.target as Record<string, unknown>;
      const variantIds = (target["variantIds"] as string[]) ?? [];
      return variantIds.slice(0, 5).map((variantId) => ({ reward, variantId }));
    });
    const giftVariantIds = [...new Set(giftVariantChecks.map(({ variantId }) => variantId))];
    const giftVariants = giftVariantIds.length > 0
      ? await db.select({
        variantGid: variantCache.variantGid,
        availableForSale: variantCache.availableForSale,
        inventoryQuantity: variantCache.inventoryQuantity,
        inventoryPolicy: variantCache.inventoryPolicy,
      })
        .from(variantCache)
        .where(and(
          eq(variantCache.shopId, shopId),
          inArray(variantCache.variantGid, giftVariantIds),
        ))
      : [];
    const giftVariantById = new Map(giftVariants.map((variant) => [variant.variantGid, variant]));
    const warnedOfferIds = new Set<string>();

    for (const { reward, variantId } of giftVariantChecks) {
      if (warnedOfferIds.has(reward.offerId)) continue;
      const variant = giftVariantById.get(variantId);
      if (variant && !variant.availableForSale &&
        variant.inventoryPolicy !== "CONTINUE" &&
        (variant.inventoryQuantity ?? 0) <= 0) {
        const offer = activeOfferById.get(reward.offerId);
        warnings.push({
          code: `gift_oos_${reward.id}`,
          severity: "warning",
          title: "Gift product is out of stock",
          message: `Offer "${offer?.internalName ?? reward.offerId.slice(0, 8)}" has a gift product with 0 inventory. Buyers won't receive the gift.`,
          action: { label: "Edit Offer", url: `/app/offers/${reward.offerId}` },
        });
        warnedOfferIds.add(reward.offerId);
      }
    }
  }

  // ── 4. Missing market publication ────────────────────────────────────────────
  // Check if any gift products are not published to the store's markets
  // (simplified check — full check would require Admin API calls)

  // ── 5. Function config stale ──────────────────────────────────────────────────
  // TODO: check if compiledConfig matches current conditions/rewards

  // ── 6. No active offers warning ───────────────────────────────────────────────
  if (activeOffers.length === 0) {
    warnings.push({
      code: "no_active_offers",
      severity: "info",
      title: "No active offers",
      message: "You have no active promotions. Create and publish an offer to start showing gifts and discounts to customers.",
      action: { label: "Create Offer", url: "/app/offers/new" },
    });
  }

  // ── 7. Product cache empty ────────────────────────────────────────────────────
  const [cacheCount] = await db.select({ count: count() })
    .from(productCache)
    .where(eq(productCache.shopId, shopId));

  if ((cacheCount?.count ?? 0) === 0) {
    warnings.push({
      code: "product_cache_empty",
      severity: "error",
      title: "Product catalog not synced",
      message: "The product catalog is empty. Gift and bundle offer product selections won't work until a sync completes.",
      action: { label: "Trigger Sync", url: "/app/diagnostics" },
    });
  }

  return warnings;
}
