import type { LoaderFunctionArgs } from "react-router";
import { analyticsEvents, offers } from "@promo/db";
import { and, eq } from "drizzle-orm";
import { getSignedShop } from "../lib/app-proxy-auth.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  const { id: shopId, currencyCode, db, loggedInCustomerId } = await getSignedShop(request);
  const url = new URL(request.url);
  const orderGid = url.searchParams.get("order_gid");
  if (!orderGid || !/^gid:\/\/shopify\/Order\/\d+$/.test(orderGid) || !loggedInCustomerId) {
    return Response.json({ attributions: [] });
  }

  const events = await db
    .select({
      offerId: analyticsEvents.offerId,
      offerName: offers.internalName,
      offerType: offers.type,
      properties: analyticsEvents.properties,
    })
    .from(analyticsEvents)
    .innerJoin(offers, and(eq(offers.id, analyticsEvents.offerId), eq(offers.shopId, shopId)))
    .where(and(
      eq(analyticsEvents.shopId, shopId),
      eq(analyticsEvents.orderId, orderGid),
      eq(analyticsEvents.customerId, loggedInCustomerId),
      eq(analyticsEvents.eventName, "order_placed_attributed"),
    ));

  const unique = new Map<string, {
    offerId: string;
    offerName: string;
    offerType: string;
    savedCents: number;
    currencyCode: string;
    giftProductTitle?: string;
  }>();
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

  return Response.json({ attributions: [...unique.values()] });
}
