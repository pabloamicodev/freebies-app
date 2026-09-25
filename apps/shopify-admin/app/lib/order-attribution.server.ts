import { analyticsEvents, offers, type Db } from "@promo/db";
import { and, eq } from "drizzle-orm";

const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/\d+$/;

export interface OrderAttribution {
  offerId: string;
  offerName: string;
  offerType: string;
  savedCents: number;
  currencyCode: string;
  giftProductTitle?: string;
}

interface AttributionEvent {
  offerId: string | null;
  offerName: string;
  offerType: string;
  properties: unknown;
}

/** `customerId` must be Shopify-verified (proxy signature or session token `sub`). */
export async function getOrderAttributions(
  db: Db,
  shop: { id: string; currencyCode: string },
  orderGid: string | null,
  customerId: string | null,
): Promise<OrderAttribution[]> {
  if (!orderGid || !ORDER_GID_PATTERN.test(orderGid) || !customerId || !/^\d+$/.test(customerId)) return [];

  const events = await db
    .select({
      offerId: analyticsEvents.offerId,
      offerName: offers.internalName,
      offerType: offers.type,
      properties: analyticsEvents.properties,
    })
    .from(analyticsEvents)
    .innerJoin(offers, and(eq(offers.id, analyticsEvents.offerId), eq(offers.shopId, shop.id)))
    .where(and(
      eq(analyticsEvents.shopId, shop.id),
      eq(analyticsEvents.orderId, orderGid),
      eq(analyticsEvents.customerId, `gid://shopify/Customer/${customerId}`),
      eq(analyticsEvents.eventName, "order_placed_attributed"),
    ));

  return toOrderAttributions(events, shop.currencyCode);
}

export function toOrderAttributions(events: AttributionEvent[], currencyCode: string): OrderAttribution[] {
  const unique = new Map<string, OrderAttribution>();
  for (const event of events) {
    if (!event.offerId || unique.has(event.offerId)) continue;
    const properties = event.properties && typeof event.properties === "object" && !Array.isArray(event.properties)
      ? event.properties as Record<string, unknown>
      : {};
    const saved = Number(properties["savedCents"] ?? properties["saved_cents"] ?? 0);
    const giftProductTitle = typeof properties["giftProductTitle"] === "string"
      ? properties["giftProductTitle"]
      : undefined;
    unique.set(event.offerId, {
      offerId: event.offerId,
      offerName: event.offerName,
      offerType: event.offerType,
      savedCents: Number.isFinite(saved) && saved > 0 ? Math.round(saved) : 0,
      currencyCode,
      ...(giftProductTitle ? { giftProductTitle } : {}),
    });
  }
  return [...unique.values()];
}
