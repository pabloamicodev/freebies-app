/**
 * Queries behind the per-offer debug page (compiled config, recent evaluation errors, 7-day event stats) and
 * its "clear logs" action. The route and the MCP tools (`promo_debug`, `promo_debug_clear_logs`) share them.
 */
import { analyticsEvents, cartMutationLogs, offers, type Db } from "@promo/db";
import { and, count, desc, eq, gte } from "drizzle-orm";

const CART_MUTATION_ERROR_EVENT = "promo_engine:cart_mutation_error";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OfferDebugData {
  offer: {
    id: string;
    internalName: string;
    status: string;
    functionMetafieldGid: string | null;
    hasCompiledConfig: boolean;
    configSize: number;
    compiledConfigJson: string | null;
    metafieldStatus: "synced" | "pending" | "error";
    lastSyncTime: string | null;
  };
  recentErrors: { occurred: string; eventName: string; sessionId: string; properties: string }[];
  mutationErrors: { created: string; type: string; error: string; source: string }[];
  eventStats: { widgetViewed: number; giftAutoAdded: number; errors: number };
}

/** Null when the offer does not belong to the shop. */
export async function loadOfferDebug(
  db: Db,
  shopId: string,
  offerId: string,
  now: () => Date = () => new Date(),
): Promise<OfferDebugData | null> {
  const [offer] = await db
    .select()
    .from(offers)
    .where(and(eq(offers.shopId, shopId), eq(offers.id, offerId)))
    .limit(1);
  if (!offer) return null;

  const sevenDaysAgo = new Date(now().getTime() - 7 * DAY_MS);

  const [recentErrors, mutationErrors, statsViewed, statsAdded, statsErrors] = await Promise.all([
    db.select().from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, shopId),
        eq(analyticsEvents.offerId, offerId),
        eq(analyticsEvents.eventName, CART_MUTATION_ERROR_EVENT),
      ))
      .orderBy(desc(analyticsEvents.occurredAt))
      .limit(10),
    db.select().from(cartMutationLogs)
      .where(and(
        eq(cartMutationLogs.shopId, shopId),
        eq(cartMutationLogs.offerId, offerId),
        eq(cartMutationLogs.status, "error"),
      ))
      .orderBy(desc(cartMutationLogs.createdAt))
      .limit(10),
    db.select({ value: count() }).from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, shopId),
        eq(analyticsEvents.offerId, offerId),
        eq(analyticsEvents.eventName, "widget_viewed"),
        gte(analyticsEvents.occurredAt, sevenDaysAgo),
      )),
    db.select({ value: count() }).from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, shopId),
        eq(analyticsEvents.offerId, offerId),
        eq(analyticsEvents.eventName, "gift_auto_added"),
        gte(analyticsEvents.occurredAt, sevenDaysAgo),
      )),
    db.select({ value: count() }).from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.shopId, shopId),
        eq(analyticsEvents.offerId, offerId),
        eq(analyticsEvents.eventName, CART_MUTATION_ERROR_EVENT),
        gte(analyticsEvents.occurredAt, sevenDaysAgo),
      )),
  ]);

  const compiledConfig = offer.compiledConfig;
  const hasCompiledConfig = !!compiledConfig;
  const configSize = compiledConfig ? JSON.stringify(compiledConfig).length : 0;

  const metafieldStatus = offer.functionMetafieldGid
    ? (hasCompiledConfig ? "synced" : "pending")
    : "error";

  return {
    offer: {
      id: offer.id,
      internalName: offer.internalName,
      status: offer.status,
      functionMetafieldGid: offer.functionMetafieldGid,
      hasCompiledConfig,
      configSize,
      compiledConfigJson: hasCompiledConfig ? JSON.stringify(compiledConfig, null, 2) : null,
      metafieldStatus,
      lastSyncTime: offer.updatedAt ? new Date(offer.updatedAt).toISOString() : null,
    },
    recentErrors: recentErrors.map((e) => ({
      occurred: e.occurredAt.toISOString(),
      eventName: e.eventName,
      sessionId: e.sessionId ?? "—",
      properties: JSON.stringify(e.properties).slice(0, 120),
    })),
    mutationErrors: mutationErrors.map((e) => ({
      created: e.createdAt.toISOString(),
      type: e.mutationType,
      error: e.errorMessage ?? "—",
      source: e.source,
    })),
    eventStats: {
      widgetViewed: statsViewed[0]?.value ?? 0,
      giftAutoAdded: statsAdded[0]?.value ?? 0,
      errors: statsErrors[0]?.value ?? 0,
    },
  };
}

const errorLogsWhere = (shopId: string, offerId: string) => ({
  mutations: and(
    eq(cartMutationLogs.shopId, shopId),
    eq(cartMutationLogs.offerId, offerId),
    eq(cartMutationLogs.status, "error"),
  ),
  events: and(
    eq(analyticsEvents.shopId, shopId),
    eq(analyticsEvents.offerId, offerId),
    eq(analyticsEvents.eventName, CART_MUTATION_ERROR_EVENT),
  ),
});

/** How many rows `clearOfferDebugLogs` would delete (for a dry run). */
export async function countOfferDebugLogs(db: Db, shopId: string, offerId: string) {
  const where = errorLogsWhere(shopId, offerId);
  const [[mutations], [events]] = await Promise.all([
    db.select({ value: count() }).from(cartMutationLogs).where(where.mutations),
    db.select({ value: count() }).from(analyticsEvents).where(where.events),
  ]);
  return { cartMutationErrors: mutations?.value ?? 0, errorEvents: events?.value ?? 0 };
}

/** Deletes the offer's error rows (cart mutation errors and their analytics events); the page's "Clear logs". */
export async function clearOfferDebugLogs(db: Db, shopId: string, offerId: string) {
  const where = errorLogsWhere(shopId, offerId);
  const [mutations, events] = await Promise.all([
    db.delete(cartMutationLogs).where(where.mutations).returning({ id: cartMutationLogs.id }),
    db.delete(analyticsEvents).where(where.events).returning({ id: analyticsEvents.id }),
  ]);
  return { cartMutationErrors: mutations.length, errorEvents: events.length };
}
