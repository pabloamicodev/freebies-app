import { analyticsEvents, cartMutationLogs, offers, productCache, shops, variantCache, type Db } from "@promo/db";
import { and, count, eq, gte } from "drizzle-orm";
import type { IncidentRow } from "../components/CapacityIncidentsSection.js";
import { loadLimitsMeter } from "./capacity-meter.server.js";
import { listOpenIncidents, listRecentlyResolved, recentActions } from "./capacity-incidents.server.js";
import { loadOfferRows } from "./capacity-transforms.server.js";

async function loadCapacityIncidentRows(db: Db, shopId: string) {
  const [open, resolved, actions] = await Promise.all([listOpenIncidents(db, shopId), listRecentlyResolved(db, shopId), recentActions(db, shopId)]);
  const rows = await loadOfferRows(db, shopId, [...new Set([...open, ...resolved].flatMap((incident) => incident.offerIds))]);
  const toRow = (incident: (typeof open)[number]): IncidentRow => ({
    id: incident.id,
    code: incident.code,
    status: incident.status,
    resolution: incident.resolution,
    occurrences: incident.occurrences,
    source: incident.source,
    lastSeenAt: incident.lastSeenAt.toISOString(),
    offers: incident.offerIds.map((id) => rows.get(id)?.offer.internalName ?? id),
  });
  return { open: open.map(toRow), resolved: resolved.map(toRow), actions };
}

/** Everything the Diagnostics page shows for one shop: health counters, the Shopify limits meter and the capacity incidents. */
export async function loadDiagnostics(db: Db, shopDomain: string, deps: { loadBudget?: Parameters<typeof loadLimitsMeter>[2] } = {}) {
  const [shop] = await db.select().from(shops).where(eq(shops.myshopifyDomain, shopDomain)).limit(1);
  if (!shop) return { shop: null, diagnostics: null, limits: null, capacity: null };

  const since1h = new Date(Date.now() - 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [activeOfferCount, productCacheCount, variantCacheCount, recentErrors, recentMutations, errorMutations] = await Promise.all([
    db.select({ count: count() }).from(offers).where(and(eq(offers.shopId, shop.id), eq(offers.status, "active"))),
    db.select({ count: count() }).from(productCache).where(eq(productCache.shopId, shop.id)),
    db.select({ count: count() }).from(variantCache).where(eq(variantCache.shopId, shop.id)),
    db
      .select({ count: count() })
      .from(analyticsEvents)
      .where(and(eq(analyticsEvents.shopId, shop.id), eq(analyticsEvents.eventName, "promo_engine:cart_mutation_error"), gte(analyticsEvents.occurredAt, since1h))),
    db
      .select({ count: count() })
      .from(cartMutationLogs)
      .where(and(eq(cartMutationLogs.shopId, shop.id), gte(cartMutationLogs.createdAt, since24h))),
    db
      .select({ count: count() })
      .from(cartMutationLogs)
      .where(and(eq(cartMutationLogs.shopId, shop.id), eq(cartMutationLogs.status, "error"), gte(cartMutationLogs.createdAt, since24h))),
  ]);

  const limits = await loadLimitsMeter(db, shop.id, deps.loadBudget);
  const capacity = await loadCapacityIncidentRows(db, shop.id);
  const totalMutations = recentMutations[0]?.count ?? 0;
  const errorCount = errorMutations[0]?.count ?? 0;
  const errorRate = totalMutations > 0 ? ((errorCount / totalMutations) * 100).toFixed(1) : "0";

  return {
    shop: {
      domain: shop.shopDomain,
      isActive: shop.isActive,
      installedAt: shop.installedAt.toISOString(),
    },
    diagnostics: {
      activeOffers: activeOfferCount[0]?.count ?? 0,
      cachedProducts: productCacheCount[0]?.count ?? 0,
      cachedVariants: variantCacheCount[0]?.count ?? 0,
      errorsLastHour: recentErrors[0]?.count ?? 0,
      mutationsLast24h: totalMutations,
      errorMutationsLast24h: errorCount,
      errorRate,
    },
    limits,
    capacity,
  };
}
